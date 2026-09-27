#!/bin/bash
# =============================================================================
# glusterfs-backup - node-side runner of the GlusterFS Backup/Restore add-on
# =============================================================================
# Installed as /usr/local/sbin/glusterfs-backup on the storage node that runs
# backups, by the add-on's platform task script (scripts/backup/backup-task.js).
# Install/Configure download it and record its sha256; later runs only
# re-download it when the installed copy is missing, and only accept that
# exact version. The last line of this file is an end marker that the
# installer checks, so a truncated download is never installed.
#
# Design
#   - Every job that touches the repository (backup, verify, restore, purge)
#     runs in a DETACHED worker holding one host-wide lock - the same lock
#     file the v1 add-on used, so a still-running v1 job is respected too.
#   - The caller ("start") waits a bounded time for the worker, then reports.
#     Long jobs keep running and are reported by the next call. Detached,
#     because one platform command (ExecCmd) is killed after about an hour
#     and a dashboard button gives up after about 19 minutes, while the first
#     full backup of a large volume can take hours.
#   - Scheduled backups never queue: if a job is running they are SKIPPED -
#     unless that job has run for GFSB_STALL_HOURS and made no progress (no
#     I/O, no CPU) over the last 30+ minutes (or its progress cannot be
#     sampled), or the lock is held that long by a process that is not a job
#     of this runner; then they FAIL, so a hung job cannot stop the schedule
#     silently. Progress is sampled by a heartbeat next to every job, so the
#     verdict does not depend on how often the schedule runs. Manual backups
#     and verifies queue behind the running job (one queued job at most).
#     Restores and purges are never queued: they must not run unattended
#     later.
#   - A backup storage that stops answering while its (soft) NFS mount is
#     still listed is reported as unreachable - never as "no repository",
#     "no snapshots" or "deleted".
#   - A job that failed in the background turns the next run's result into
#     "failed" (red Tasks entry, failure e-mail) exactly once.
#   - restic >= 0.16 is required (--retry-lock, <snapshot>:<path>); restores
#     require >= 0.17, which replaces symlinks in the target instead of
#     writing through them.
#
# Output contract with backup-task.js - the last lines of every command:
#   GFSB_ACTIVE=<1 while a job still holds or waits for the lock, else 0>
#   GFSB_RESULT=<ok|warning|skipped|queued|background|failed>
#   GFSB_MESSAGE=<one line>
# "list" also prints GFSB_JSON=<restic snapshots JSON on one line>.
# The exit status is non-zero only for "failed", so the platform Tasks log
# shows a red entry exactly when something needs attention.
#
# Configuration comes from environment variables set by backup-task.js:
#   GFSB_ENV      region env name; restic repo dir AND password (the Jelastic
#                 backup-storage convention, so the storage's getBackups.sh
#                 <envName> lists these snapshots)
#   GFSB_MOUNT    where the backup storage's /data is NFS-mounted (/opt/gfs-backup)
#   GFSB_SRC      the GlusterFS FUSE mount to back up (/data)
#   GFSB_KEEP     snapshots to keep
#   GFSB_HOST     stable restic --host for this cluster (retention/parent
#                 selection must not depend on which node happens to run)
#   GFSB_CLUSTER, GFSB_REGION, GFSB_VOLUME, GFSB_NODE_ID  - snapshot tags
#   GFSB_PRUNE_HOURS (24), GFSB_CHECK_SUBSET (5%), GFSB_QUEUE_MAX (21600 s),
#   GFSB_RETRY_LOCK (30m), GFSB_STALL_HOURS (24), GFSB_PARTIAL_MAX (3),
#   GFSB_PROGRESS_EVERY (300 s), GFSB_PROGRESS_WINDOW (1800 s), GFSB_PROGRESS_CPU (10 s)
# =============================================================================
GFSB_RUNNER_API=2
GFSB_RUNNER_VERSION=2.3.0

set -u -o pipefail
umask 022
export LC_ALL=C
# Platform commands may run without HOME or /usr/local/sbin on PATH.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}
export RESTIC_CACHE_DIR=${RESTIC_CACHE_DIR:-/var/cache/restic}

SELF=$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")

ENV_NAME=${GFSB_ENV:-}
MOUNT=${GFSB_MOUNT:-/opt/gfs-backup}
SRC=${GFSB_SRC:-/data}
KEEP=${GFSB_KEEP:-24}
HOST_ID=${GFSB_HOST:-}
CLUSTER=${GFSB_CLUSTER:-}
REGION=${GFSB_REGION:-}
VOLUME=${GFSB_VOLUME:-}
NODE_ID=${GFSB_NODE_ID:-}
PRUNE_HOURS=${GFSB_PRUNE_HOURS:-24}
CHECK_SUBSET=${GFSB_CHECK_SUBSET:-5%}
QUEUE_MAX=${GFSB_QUEUE_MAX:-21600}
RETRY_LOCK=${GFSB_RETRY_LOCK:-30m}
STALL_HOURS=${GFSB_STALL_HOURS:-24}
PARTIAL_MAX=${GFSB_PARTIAL_MAX:-3}
# Stall detection: the heartbeat samples a job's I/O and CPU every
# PROGRESS_EVERY s; a job that moved less than 1 MiB and used less than
# PROGRESS_CPU s of CPU over at least PROGRESS_WINDOW s made no progress.
PROGRESS_EVERY=${GFSB_PROGRESS_EVERY:-300}
PROGRESS_WINDOW=${GFSB_PROGRESS_WINDOW:-1800}
PROGRESS_CPU=${GFSB_PROGRESS_CPU:-10}
case $PROGRESS_EVERY in ''|*[!0-9]*|0) PROGRESS_EVERY=300 ;; esac
case $PROGRESS_WINDOW in ''|*[!0-9]*|0) PROGRESS_WINDOW=1800 ;; esac
case $PROGRESS_CPU in ''|*[!0-9]*) PROGRESS_CPU=10 ;; esac

STATE=/var/lib/glusterfs-backup
RUNS=$STATE/runs
LOCK=/var/lock/glusterfs-backup.lock
QLOCK=/var/lock/glusterfs-backup.queue.lock
LOG=/var/log/glusterfs-backup.log
REPO=$MOUNT/$ENV_NAME
RL=(--retry-lock "$RETRY_LOCK")
CACHE_ARGS=()

export RESTIC_REPOSITORY=$REPO
export RESTIC_PASSWORD=$ENV_NAME
export GOGC=${GOGC:-20}

# v1 add-on artefacts.
LEGACY_FILES="/root/glusterfs-backup-run.sh /root/glusterfs-backup-locked.sh
/root/glusterfs-backup-restore-by-id.sh /root/glusterfs-backup-restore-by-files.sh
/root/glusterfs-backup-restore.sh /root/glusterfs-backup-list.sh
/root/glusterfs-backup-verify.sh /root/.restore-snap /root/.restore-path"

# ---- helpers ----------------------------------------------------------------

ts()      { date -u +%Y-%m-%dT%H:%M:%SZ; }
say()     { printf '%s\n' "$*"; }
log()     { printf '[%s] %s\n' "$(ts)" "$*"; }
# oneline [TEXT] - TEXT (or stdin when called without arguments) on one line.
oneline() {
    if [ $# -gt 0 ]; then printf '%s' "$*"; else cat; fi \
        | tr '\r\n\t' '   ' | sed 's/  */ /g; s/^ //; s/ $//' | cut -c1-1500
}
upper()   { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }

# getf FILE KEY - read one key from a key=value state file.
getf() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n 1; }

# write_kv FILE key=value... - write a state file atomically. A failed write
# (full disk) leaves no file behind: mktemp still succeeds on a full
# filesystem, and an empty result file would read as "no status".
write_kv() {
    local f=$1 tmp kv
    shift
    tmp=$(mktemp "$f.XXXXXX") || return 1
    for kv in "$@"; do
        printf '%s\n' "$(oneline "$kv")" >> "$tmp" || { rm -f "$tmp"; return 1; }
    done
    mv -f "$tmp" "$f" || { rm -f "$tmp"; return 1; }
}

# disk_hint - free space where the runner keeps its state (for messages).
disk_hint() {
    df -Pk "$STATE" 2>/dev/null | awk 'NR == 2 { printf "%d MiB free on %s", $4 / 1024, $6 }'
}

pid_alive() {
    case ${1:-} in ''|*[!0-9]*) return 1 ;; esac
    kill -0 "$1" 2>/dev/null
}

# proc_running PID - the process exists and is not a zombie (for a child of
# this shell, whose PID cannot be reused before it is reaped).
proc_running() {
    local st
    st=$(sed -n 's/^State:[[:space:]]*//p' "/proc/${1:-x}/status" 2>/dev/null)
    case $st in ''|Z*|X*) return 1 ;; esac
    return 0
}

# worker_alive PID RUN_ID - PID is still this runner's worker for RUN_ID (a
# stale file, or a PID reused after a node restart, does not count).
worker_alive() {
    pid_alive "${1:-}" || return 1
    [ -n "${2:-}" ] || return 1
    tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -q -- " worker .*$2"
}

# job_pid FILE - the PID recorded in a state file, printed only if that process
# is still this runner's worker for the recorded run.
job_pid() {
    local pid
    pid=$(getf "$1" pid)
    worker_alive "$pid" "$(getf "$1" run_id)" || return 1
    printf '%s' "$pid"
}

# rm_if_mine NAME - remove $STATE/NAME only if it names this process.
rm_if_mine() {
    if [ "$(getf "$STATE/$1" pid)" = "$$" ]; then rm -f "$STATE/$1"; fi
}

# A shared probe: fails only while a job holds the lock (exclusively), and two
# probes never block each other.
lock_free() { flock -n -s "$LOCK" true 2>/dev/null; }

queued_alive() { [ -n "$(job_pid "$STATE/queued")" ]; }

# emit STATUS MESSAGE - print the contract lines and exit. GFSB_ACTIVE=1 while
# a job still holds or waits for the lock.
emit() {
    local active=0
    if [ -d "$STATE" ]; then
        if ! lock_free || queued_alive; then active=1; fi
    fi
    printf 'GFSB_ACTIVE=%s\nGFSB_RESULT=%s\nGFSB_MESSAGE=%s\n' "$active" "$1" "$(oneline "$2")"
    if [ "$1" = failed ]; then exit 1; fi
    exit 0
}

# holder_desc - human description of whatever holds the lock.
holder_desc() {
    local pid kind
    if pid=$(job_pid "$STATE/current"); then
        kind=manual
        [ "$(getf "$STATE/current" mode)" = auto ] && kind=scheduled
        printf 'a %s %s (run %s, started %s, PID %s)' "$kind" \
            "$(getf "$STATE/current" job)" "$(getf "$STATE/current" run_id)" \
            "$(getf "$STATE/current" started)" "$pid"
    else
        printf 'another backup process (possibly one started by the previous version of this add-on)'
    fi
}

# holder_age - seconds since the recorded running job started (empty when no
# live job of this runner is recorded, e.g. a v1 process holds the lock).
holder_age() {
    local s
    job_pid "$STATE/current" > /dev/null || return 0
    s=$(date -u -d "$(getf "$STATE/current" started)" +%s 2>/dev/null) || return 0
    printf '%s' $(( $(date +%s) - s ))
}

# job_sample PGID - "IO CPU" of the processes in that process group (the
# worker is a session leader; restic runs in its group): bytes read + written
# (rchar + wchar) and CPU time in clock ticks. Both include the children the
# group has already reaped (the kernel adds a reaped child's I/O and CPU time
# to its parent), so the totals do not drop when one restic call ends and the
# next begins. Builtins only: the heartbeat runs this every few minutes.
job_sample() {
    local g=$1 p st io=0 cpu=0 k v
    for p in /proc/[0-9]*; do
        { read -r st < "$p/stat"; } 2>/dev/null || continue
        st=${st##*) }
        set -- $st
        [ "${3:-}" = "$g" ] || continue
        # utime stime cutime cstime (fields 14-17 of /proc/PID/stat)
        case "${12:-}.${13:-}.${14:-}.${15:-}" in *[!0-9.]*|*..*|.*|*.) continue ;; esac
        cpu=$((cpu + ${12} + ${13} + ${14} + ${15}))
        { while read -r k v; do
            case $k in rchar:|wchar:) case $v in ''|*[!0-9]*) ;; *) io=$((io + v)) ;; esac ;; esac
        done < "$p/io"; } 2>/dev/null
    done
    printf '%s %s' "$io" "$cpu"
}

# file_holders FILE - "PID COMMAND" of every other process that has FILE open.
file_holders() {
    local lk f p
    lk=$(readlink -f "$1" 2>/dev/null) || return 0
    find /proc/[0-9]*/fd -maxdepth 1 -lname "$lk" 2>/dev/null | while read -r f; do
        p=${f#/proc/}; p=${p%%/*}
        [ "$p" = "$$" ] && continue
        printf '%s %s\n' "$p" "$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | cut -c1-200)"
    done | sort -u -k1,1n
}

# lock_holders - "PID COMMAND" of every other process that has the lock file
# open: a v1 job, or restic/helpers left over from a worker that died.
lock_holders() { file_holders "$LOCK"; }

# restore_holder - a "restic restore" has the lock file open (e.g. a restore
# whose worker died, still writing into the volume). Only the subcommand
# counts: a backup's argv carries user-chosen names (--host glusterfs-<cluster>,
# runner-env=, cluster=, volume=) that may themselves contain "restore". The
# restic binary is argv[0], or argv[1] when restic is a script run by an
# interpreter ("/bin/bash /usr/local/bin/restic restore ...").
restore_holder() {
    lock_holders | awk '{ for (i = 2; i <= 3; i++) { n = $i; sub(/.*\//, "", n); if (n ~ /^restic/ && $(i + 1) == "restore") f = 1 } }
        END { exit !f }'
}

# heartbeat_start PID RUN_ID - sample that job's progress in the background.
# Own session (its reads of /proc are not the job's progress) and no lock fds
# (it must never keep the job lock alive).
heartbeat_start() {
    setsid "$SELF" heartbeat "$1" "$2" > /dev/null 2>&1 < /dev/null 7>&- 8>&- 9>&- &
}

# heartbeat_age PID RUN_ID - seconds the oldest heartbeat of that run has been
# running ("" when none runs).
heartbeat_age() {
    local p a age=""
    for p in $(pgrep -f -- " heartbeat $1 $2( |\$)" 2>/dev/null); do
        a=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' ')
        case $a in ''|*[!0-9]*) continue ;; esac
        if [ -z "$age" ] || [ "$a" -gt "$age" ]; then age=$a; fi
    done
    printf '%s' "$age"
}

# heartbeat_ensure PID RUN_ID - when the newest sample of that run is missing or
# stale: restart its heartbeat (a job started by an older runner, or a
# heartbeat that was killed), or return 1 when a heartbeat has been running
# for a while and still recorded nothing - it cannot write its samples (full
# disk, read-only filesystem), so no verdict would ever come.
heartbeat_ensure() {
    local last="" hba
    if [ "$(getf "$STATE/progress" run_id)" = "$2" ]; then
        last=$(sed -n 's/^s=\([0-9]*\) .*/\1/p' "$STATE/progress" 2>/dev/null | tail -n 1)
    fi
    case $last in ''|*[!0-9]*) last=0 ;; esac
    [ $(( $(date +%s) - last )) -gt $((3 * PROGRESS_EVERY)) ] || return 0
    # A heartbeat writes its first sample at most 60 s after it starts (it may
    # wait that long for the previous job's heartbeat to end).
    hba=$(heartbeat_age "$1" "$2")
    if [ -n "$hba" ]; then
        [ "$hba" -lt 90 ] || return 1
        return 0
    fi
    heartbeat_start "$1" "$2"
}

# stall_check - verdict on whatever holds the lock, once it has held it for
# about GFSB_STALL_HOURS (15 min early, so that a daily trigger that fires a
# few seconds before the 24 h mark does not report one day late); nothing
# below that. Printed as "VERDICT HOURS [MINUTES IO_BYTES CPU_SECONDS]":
#   running H M IO CPU - the job moved IO bytes / used CPU s in the last M min
#   stuck H M IO CPU   - under 1 MiB and PROGRESS_CPU s in the last M (>= 30) min
#   measuring H        - no heartbeat sample old enough to compare with yet
#   unmeasured H       - its heartbeat cannot record samples (full disk?):
#                        "measuring" would last forever, so this is a failure
#   held H             - the holder is not a job of this runner
# The comparison uses the heartbeat's samples, so the first check past the
# limit already has a verdict, and every later check repeats a real one.
stall_check() {
    local pid rid age lim now io=0 cpu=0 at a b sat="" sio=0 scpu=0 d dc tck qp p since pend=measuring
    # (hours are rounded: a job 23 h 50 min old reads as 24 h)
    [ "$STALL_HOURS" -gt 0 ] || return 0
    lim=$((STALL_HOURS * 3600 - 900))
    now=$(date +%s)
    if pid=$(job_pid "$STATE/current"); then
        rm -f "$STATE/busy-since"
        age=$(holder_age)
        [ -n "$age" ] && [ "$age" -ge "$lim" ] || return 0
        rid=$(getf "$STATE/current" run_id)
        heartbeat_ensure "$pid" "$rid" || pend=unmeasured
        # (< <(...), not <<<: before bash 5.1 a here-string is a temp file,
        # which cannot be created on the full disk this may have to report)
        read -r io cpu < <(job_sample "$pid")
        if [ "$(getf "$STATE/progress" run_id)" = "$rid" ]; then
            # the newest sample that is at least PROGRESS_WINDOW old
            while read -r at a b; do
                case "$at.$a.$b" in *[!0-9.]*|*..*|.*|*.) continue ;; esac
                [ $((now - at)) -ge "$PROGRESS_WINDOW" ] && { sat=$at; sio=$a; scpu=$b; }
            done < <(sed -n 's/^s=//p' "$STATE/progress" 2>/dev/null)
        fi
        if [ -z "$sat" ]; then printf '%s %s' "$pend" $(((age + 1800) / 3600)); return 0; fi
        tck=$(getconf CLK_TCK 2>/dev/null); case $tck in ''|*[!0-9]*|0) tck=100 ;; esac
        d=$((io - sio)); dc=$((cpu - scpu))
        if [ "$d" -lt 0 ] || [ "$dc" -lt 0 ]; then
            # a process left the group unreaped between samples: no verdict
            printf '%s %s' "$pend" $(((age + 1800) / 3600))
        elif [ "$d" -lt 1048576 ] && [ "$dc" -lt $((PROGRESS_CPU * tck)) ]; then
            printf 'stuck %s %s %s %s' $(((age + 1800) / 3600)) $(((now - sat) / 60)) "$d" $((dc / tck))
        elif [ $((now - sat)) -gt $((PROGRESS_WINDOW + 3 * PROGRESS_EVERY)) ]; then
            # the heartbeat was missing for a while: that progress may be old
            printf '%s %s' "$pend" $(((age + 1800) / 3600))
        else
            printf 'running %s %s %s %s' $(((age + 1800) / 3600)) $(((now - sat) / 60)) "$d" $((dc / tck))
        fi
        return 0
    fi
    # Not a job of this runner (a v1 job, or restic left behind by a worker
    # that died): its age is that of the oldest process holding the lock file
    # (not counting our queued worker, which only waits for it). busy-since,
    # when this runner first found the lock busy, is the fallback.
    qp=$(job_pid "$STATE/queued")
    age=""
    for p in $(lock_holders | awk '{ print $1 }'); do
        [ "$p" = "$qp" ] && continue
        a=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' ')
        case $a in ''|*[!0-9]*) continue ;; esac
        if [ -z "$age" ] || [ "$a" -gt "$age" ]; then age=$a; fi
    done
    if [ -z "$age" ]; then
        since=$(cat "$STATE/busy-since" 2>/dev/null)
        case $since in ''|*[!0-9]*) printf '%s\n' "$now" > "$STATE/busy-since"; return 0 ;; esac
        age=$((now - since))
    fi
    [ "$age" -ge "$lim" ] && printf 'held %s' $(((age + 1800) / 3600))
    return 0
}

# stall_text VERDICT... - the stall_check verdict as a sentence ("" for none).
stall_text() {
    case ${1:-} in
        stuck)     printf 'WARNING: it has been running for %s h and read or wrote less than 1 MiB and used less than %s s of CPU in the last %s min - it may be stuck (for example on a hung backup storage mount). To stop it, run %s on node %s.' \
                       "$2" "$PROGRESS_CPU" "$3" "'$SELF stop'" "${NODE_ID:-?}" ;;
        held)      printf 'WARNING: the backup lock has been held for %s h by a process that is not a job of this runner: %s. To stop it, run %s on node %s.' \
                       "$2" "$(lock_holders | head -n 3 | oneline)" "'$SELF stop'" "${NODE_ID:-?}" ;;
        unmeasured) printf 'WARNING: it has been running for %s h, and its progress cannot be checked: the progress samples are not being written to %s (%s) - is the disk of node %s full?' \
                       "$2" "$STATE" "$(disk_hint)" "${NODE_ID:-?}" ;;
        running)   printf 'Progress: it has been running for %s h; in the last %s min it read/wrote %s and used %s s of CPU.' "$2" "$3" "$(human "$4")" "$5" ;;
        measuring) printf 'It has been running for %s h; its progress is being checked.' "$2" ;;
    esac
}

human() {
    awk -v b="${1:-0}" 'BEGIN { split("B KiB MiB GiB TiB", u, " "); i = 1;
        while (b >= 1024 && i < 5) { b /= 1024; i++ } printf (i == 1 ? "%d %s" : "%.1f %s"), b, u[i] }'
}

# json_field JSONLINE KEY - naive extractor for flat string/number fields.
json_field() {
    printf '%s' "$1" | sed -n "s/.*\"$2\":\"\{0,1\}\([^,\"}]*\).*/\1/p" | head -n 1
}

rc_text() {
    case $1 in
        1)   printf 'fatal error' ;;
        3)   printf 'some source files could not be read' ;;
        10)  printf 'the repository does not exist' ;;
        11)  printf 'the repository stayed locked by another process for %s' "$RETRY_LOCK" ;;
        12)  printf 'wrong repository password - this repository was created for a different environment name' ;;
        130) printf 'interrupted' ;;
        137) printf 'restic was killed by SIGKILL - out of memory?' ;;
        *)   printf 'exit code %s' "$1" ;;
    esac
}

# json_msg JSONLINE - the "message" string of a restic JSON line, unescaped.
json_msg() {
    printf '%s' "$1" | sed -n 's/.*"message":"\(\([^"\\]\|\\.\)*\)".*/\1/p' | head -n 1 \
        | sed 's/\\\\/\x01/g; s/\\n/ /g; s/\\t/ /g; s/\\r//g; s/\\"/"/g; s/\\u003c/</g; s/\\u003e/>/g; s/\\u0026/\&/g; s/\x01/\\/g'
}

# restic_reason FILE - the most useful line of a restic stderr file.
restic_reason() {
    local r
    r=$(json_msg "$(grep '"message_type":"exit_error"' "$1" 2>/dev/null | tail -n 1)" | oneline)
    # Plain text (restic < 0.18, or a command run without --json): a lock
    # conflict takes 4 lines and only the first names the holder (PID, host) -
    # start there instead of taking the last 3 lines.
    [ -n "$r" ] || r=$(grep -v '"message_type":"error"' "$1" 2>/dev/null | grep -v '^$' \
        | awk '/repository is already locked/ { b = "" } b != "" || /repository is already locked/ { b = b $0 "\n" } END { printf "%s", b }' \
        | oneline)
    [ -n "$r" ] || r=$(grep -v '"message_type":"error"' "$1" 2>/dev/null | grep -v '^$' | tail -n 3 | oneline)
    printf '%s' "$r"
}

trim_log() {
    local size
    size=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
    if [ "$size" -gt 20971520 ]; then
        tail -c 10485760 "$LOG" > "$LOG.tmp" && mv -f "$LOG.tmp" "$LOG"
    fi
}

prune_runs() {
    local f
    ls -1t "$RUNS"/*.result 2>/dev/null | tail -n +61 | while read -r f; do
        rm -f "$f" "${f%.result}.log" "${f%.result}.pid"
    done
}

strip_legacy_cron() {
    local cur
    command -v crontab > /dev/null 2>&1 || return 0
    cur=$(crontab -l 2>/dev/null) || return 0
    if printf '%s\n' "$cur" | grep -q -e 'glusterfs-backup-locked\.sh' -e '/root/glusterfs-backup-'; then
        { printf '%s\n' "$cur" | grep -v -e 'glusterfs-backup-locked\.sh' -e '/root/glusterfs-backup-' || true; } | crontab - \
            && say "Removed the v1 add-on's crontab entry - backups are now scheduled by the platform."
    fi
}

cleanup_legacy() {
    local f
    strip_legacy_cron
    for f in $LEGACY_FILES; do rm -f "$f"; done
}

# The restic cache shares its filesystem with the GlusterFS brick, which must
# never fill up: below 10% (at least 2 GiB) free, run without a cache. Only a
# job that holds the lock passes "wipe" to also delete the cache: list and
# status run lock-free beside a job whose restic is still using the cache.
set_cache_args() {
    local size avail floor wipe=${1:-}
    CACHE_ARGS=()
    mkdir -p "$RESTIC_CACHE_DIR" 2>/dev/null
    set -- $(df -Pk "$RESTIC_CACHE_DIR" 2>/dev/null | awk 'NR == 2 { print $2, $4 }')
    size=${1:-}; avail=${2:-}
    case $size in ''|*[!0-9]*) return 0 ;; esac
    case $avail in ''|*[!0-9]*) return 0 ;; esac
    floor=$((size / 10))
    [ "$floor" -lt 2097152 ] && floor=2097152
    if [ "$avail" -lt "$floor" ]; then
        CACHE_ARGS=(--no-cache)
        [ "$wipe" = wipe ] && rm -rf -- "${RESTIC_CACHE_DIR:?}"/* 2>/dev/null
        log "note: less than $((floor / 1048576)) GiB free on the filesystem of $RESTIC_CACHE_DIR (it also holds the GlusterFS brick) - running without a restic cache"
    fi
}

ERR=""

check_config() {
    if ! printf '%s' "$ENV_NAME" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$'; then
        ERR="invalid or missing GFSB_ENV '$ENV_NAME'"; return 1
    fi
    if ! printf '%s' "$MOUNT" | grep -Eq '^/[A-Za-z0-9._/-]*[A-Za-z0-9_-]$'; then
        ERR="invalid backup storage mount path '$MOUNT'"; return 1
    fi
    if ! printf '%s' "$SRC" | grep -Eq '^/[A-Za-z0-9._/-]*[A-Za-z0-9_-]$'; then
        ERR="invalid source path '$SRC'"; return 1
    fi
    case $KEEP in ''|*[!0-9]*|0) ERR="invalid retention '$KEEP'"; return 1 ;; esac
    case $PRUNE_HOURS in ''|*[!0-9]*) PRUNE_HOURS=24 ;; esac
    case $QUEUE_MAX in ''|*[!0-9]*) QUEUE_MAX=21600 ;; esac
    case $STALL_HOURS in ''|*[!0-9]*) STALL_HOURS=24 ;; esac
    case $PARTIAL_MAX in ''|*[!0-9]*|0) PARTIAL_MAX=3 ;; esac
    [ -n "$HOST_ID" ] || HOST_ID="glusterfs-$ENV_NAME"
    return 0
}

# Restore arguments: a hex snapshot id and a target that is the volume mount
# or a directory inside it (never the node's own disk). The target is also
# canonicalised in do_restore, where symlinks are resolved.
validate_restore_args() {
    local snap=${1:-} target=${2:-}
    if ! printf '%s' "$snap" | grep -Eq '^[0-9a-f]{8,64}$'; then
        ERR="invalid snapshot id '$snap'"; return 1
    fi
    if ! printf '%s' "$target" | grep -Eq '^/[A-Za-z0-9._/-]*$' \
        || printf '%s' "$target" | grep -Eq '(^|/)\.\.(/|$)'; then
        ERR="invalid restore target '$target'"; return 1
    fi
    target=${target%/}
    if [ "$target" != "$SRC" ] && [ "${target#"$SRC"/}" = "$target" ]; then
        ERR="restore target must be $SRC or a directory inside it (got '$target')"; return 1
    fi
    return 0
}

# within_src PATH - PATH, with every symlink resolved, is the volume mount or
# lies inside it.
within_src() {
    local real_src real
    real_src=$(readlink -f "$SRC") || return 1
    real=$(readlink -m "$1") || return 1
    case $real in "$real_src"|"$real_src"/*) return 0 ;; esac
    return 1
}

restic_version() { restic version 2>/dev/null | awk 'NR == 1 { print $2 }'; }

version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]; }

# ensure_restic [MIN] - make sure restic >= MIN (default 0.16.0) is installed;
# installs/updates it with the Jelastic backup-storage helper (the same one the
# v1 add-on used) if needed.
ensure_restic() {
    local v min=${1:-0.16.0} helper dir out why rc
    v=$(restic_version)
    if [ -n "$v" ] && version_ge "$v" "$min"; then return 0; fi
    log "restic ${v:-is not installed} - installing a current release"
    why="the installer could not be downloaded - check that this node can reach github.com"
    helper=$(mktemp /usr/sbin/.installUpdateRestic.XXXXXX 2>/dev/null) || { helper=""; why="cannot write to /usr/sbin"; }
    if [ -n "$helper" ] \
        && timeout 60 wget -q -T 20 -t 2 -O "$helper" \
            https://raw.githubusercontent.com/jelastic-jps/backup-storage/main/scripts/installUpdateRestic \
        && [ "$(head -c 2 "$helper")" = '#!' ] \
        && chmod 0755 "$helper" && mv -f "$helper" /usr/sbin/installUpdateRestic; then
        # The helper downloads and unpacks restic.bz2 in its working directory:
        # give it a scratch one (a leftover "restic" there makes every retry
        # fail), and keep its output - the download is not the only step that
        # can fail (bzip2 or strip missing, GitHub API rate limit, full disk).
        if dir=$(mktemp -d 2>/dev/null); then
            out=$(cd "$dir" && timeout 600 /usr/sbin/installUpdateRestic 2>&1); rc=$?
            rm -rf -- "$dir"
        else
            out="cannot create a temporary directory"; rc=1
        fi
        out=$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -n 3 | oneline)
        case $rc in
            0)   why="/usr/sbin/installUpdateRestic ran, but restic is still missing or too old: ${out:-no output}" ;;
            124) why="/usr/sbin/installUpdateRestic did not finish within 10 min: ${out:-no output}" ;;
            *)   why="/usr/sbin/installUpdateRestic failed: ${out:-exit code $rc}" ;;
        esac
    fi
    [ -z "$helper" ] || rm -f "$helper"
    v=$(restic_version)
    if [ -n "$v" ] && version_ge "$v" "$min"; then
        log "restic $v installed"
        return 0
    fi
    ERR="restic $min or newer is required (found: ${v:-none}) and could not be installed: $why"
    return 1
}

# io_reason TEXT - the error at the end of a failed command's message
# ("stat: cannot statx '/x': Input/output error" -> "Input/output error");
# no text means the command was killed by its timeout.
io_reason() {
    local r
    r=$(oneline "${1:-}")
    r=${r##*: }
    printf '%s' "${r:-no answer within 60 s}"
}

# mount_probe DIR - MOUNT_FS = filesystem type of the TOP mount at DIR ("" if
# none), MOUNT_ERR = why DIR could not be read ("" when it could). On Jelastic
# both mounts sit on an automount trigger: the backup storage is an autofs
# direct map (AddMountPointById), the volume uses x-systemd.automount.
# Touching DIR triggers the real mount; the last line is the one on top. The
# answer of that touch is kept: a soft NFS mount whose server stopped
# answering, or a FUSE mount whose client died, stays listed as mounted while
# every access fails. Runs in the caller's shell, not in $(...), so both
# variables reach it.
MOUNT_FS=""
MOUNT_ERR=""
mount_probe() {
    local e
    if e=$(timeout -k 5 60 stat -c %i "$1/." 2>&1 > /dev/null); then
        MOUNT_ERR=""
    else
        MOUNT_ERR=$(io_reason "$e")
    fi
    MOUNT_FS=$(findmnt -rn -o FSTYPE --mountpoint "$1" 2>/dev/null | tail -n 1)
}

check_source() {
    mount_probe "$SRC"
    case $MOUNT_FS in
        fuse.glusterfs|glusterfs)
            [ -z "$MOUNT_ERR" ] && return 0
            ERR="the GlusterFS volume at $SRC does not respond ($MOUNT_ERR) - its FUSE client on this node died, hangs or reaches no brick; remount it on this node (umount -l $SRC, then ls $SRC) or restart the node"
            return 1 ;;
        ''|autofs) ERR="the GlusterFS volume is not mounted at $SRC on this node - refusing to back up an empty directory, which would rotate good snapshots out of retention"; return 1 ;;
        *) ERR="$SRC is mounted as '$MOUNT_FS', not as the GlusterFS volume - is this add-on installed on a GlusterFS region environment?"; return 1 ;;
    esac
}

# storage_unreachable REASON - ERR for a backup storage that does not answer.
storage_unreachable() {
    ERR="the backup storage mounted at $MOUNT does not answer ($1) - is the Backup Storage node running and reachable from this node?"
}

check_repo_mount() {
    mount_probe "$MOUNT"
    case $MOUNT_FS in
        nfs*)
            [ -z "$MOUNT_ERR" ] && return 0
            storage_unreachable "$MOUNT_ERR"; return 1 ;;
        ''|autofs) ERR="the backup storage is not mounted at $MOUNT on this node (is the Backup Storage environment running?)"; return 1 ;;
        *) ERR="$MOUNT is mounted as '$MOUNT_FS', expected an NFS mount of the backup storage"; return 1 ;;
    esac
}

# path_state PATH - PATH_STATE = yes | no | error. Only "No such file or
# directory" / "Not a directory" mean "no": [ -e ] and friends are also false
# on EIO/ESTALE, or when a soft NFS mount gives up. PATH_ERR says why for
# "error". LC_ALL=C keeps stat's messages in English.
PATH_STATE=""
PATH_ERR=""
path_state() {
    local e
    PATH_ERR=""
    if e=$(timeout -k 5 60 stat -c %F -- "$1" 2>&1 > /dev/null); then PATH_STATE=yes; return 0; fi
    case $e in
        *'No such file or directory'*|*'Not a directory'*) PATH_STATE=no ;;
        *) PATH_STATE=error; PATH_ERR=$(io_reason "$e") ;;
    esac
}

# repo_state - REPO_STATE = ready | foreign | new | error. "error" (the
# storage does not answer; ERR says so) is never reported as "new": that would
# list no snapshots, and let Delete All Backups report a deletion that did not
# happen.
REPO_STATE=""
repo_state() {
    local l
    REPO_STATE=error
    path_state "$REPO/config"
    case $PATH_STATE in
        error) storage_unreachable "$PATH_ERR"; return 0 ;;
        yes) if [ -f "$REPO/config" ]; then REPO_STATE=ready; return 0; fi ;;
    esac
    path_state "$REPO"
    case $PATH_STATE in
        error) storage_unreachable "$PATH_ERR"; return 0 ;;
        no) REPO_STATE=new; return 0 ;;
    esac
    if [ ! -d "$REPO" ]; then REPO_STATE=foreign; return 0; fi
    if ! l=$(timeout -k 5 60 ls -A "$REPO" 2>&1); then
        storage_unreachable "$(io_reason "$l")"; return 0
    fi
    if [ -n "$l" ]; then REPO_STATE=foreign; else REPO_STATE=new; fi
}

# repo_opens - the repository can actually be opened (password, keys, NFS).
repo_opens() {
    local e rc
    e=$(mktemp)
    restic cat config --no-lock "${CACHE_ARGS[@]}" > /dev/null 2> "$e"
    rc=$?
    if [ "$rc" != 0 ]; then
        ERR="the repository at $REPO cannot be opened ($(rc_text "$rc")): $(restic_reason "$e")"
        rm -f "$e"
        return 1
    fi
    rm -f "$e"
    return 0
}

# snapshots_rc RC ERRFILE - the exit status of a "restic snapshots" run, made
# non-zero when restic could not list the snapshot files at all: it then
# prints "could not load snapshots: ..." and "[]" but still exits 0.
snapshots_rc() {
    if [ "$1" = 0 ] && grep -q '^could not load snapshots' "$2" 2>/dev/null; then printf '1'; else printf '%s' "$1"; fi
}

# damaged_snaps FILE - short ids of the snapshot files a "restic snapshots" run
# skipped because it could not load them ('Ignoring "<id>": ...'; restic still
# exits 0 then, and every backup fails while such a file is there).
damaged_snaps() {
    sed -n 's/^Ignoring "\([0-9a-f]\{8\}\)[0-9a-f]*".*/\1/p' "$1" 2>/dev/null | sort -u | tr '\n' ' ' | sed 's/ $//'
}

# snapshot_count - SNAP_N = number of snapshots, SNAP_BAD = damaged snapshot
# files (not counted); returns 1 with ERR set when the repository cannot be
# read, so an error is never shown as "0 snapshots".
SNAP_N=""
SNAP_BAD=""
snapshot_count() {
    local out e rc
    SNAP_N=""; SNAP_BAD=""
    e=$(mktemp)
    out=$(restic snapshots --json --no-lock "${CACHE_ARGS[@]}" 2> "$e")
    rc=$(snapshots_rc $? "$e")
    if [ "$rc" != 0 ]; then
        ERR="restic cannot read the snapshots in $REPO ($(rc_text "$rc")): $(restic_reason "$e")"
        rm -f "$e"
        return 1
    fi
    SNAP_BAD=$(damaged_snaps "$e")
    rm -f "$e"
    SNAP_N=$(printf '%s' "$out" | grep -o '"short_id"' | wc -l | tr -d ' ')
    # (grep finds nothing in an empty repository - not an error)
    return 0
}

# damaged_text - warning about SNAP_BAD ("" when there is none).
damaged_text() {
    [ -n "$SNAP_BAD" ] || return 0
    printf 'WARNING: snapshot file(s) %s in %s could not be loaded (damaged?) - they are not counted or offered for restore, and backups fail while they are there; run Verify.' "$SNAP_BAD" "$REPO"
}

# ---- worker jobs --------------------------------------------------------------
# Each sets W_STATUS / W_MSG (and W_SNAP for backups).

W_STATUS=failed
W_MSG="the job did not complete"
W_SNAP=""
TMP_OUT=""
TMP_ERR=""

wfail() { W_STATUS=failed; W_MSG=$1; log "ERROR: $1"; }

new_tmp() {
    TMP_OUT=$(mktemp "$STATE/out.XXXXXX")
    TMP_ERR=$(mktemp "$STATE/err.XXXXXX")
}

repo_init_if_needed() {
    local e
    repo_state
    case $REPO_STATE in
        ready) return 0 ;;
        error) wfail "$ERR"; return 1 ;;
        foreign)
            wfail "$REPO exists but holds no restic repository (no config file) - refusing to initialise over it; move that directory aside on the backup storage first"
            return 1 ;;
    esac
    if ! e=$(mkdir -p "$REPO" 2>&1); then wfail "cannot create $REPO on the backup storage: $(io_reason "$e")"; return 1; fi
    if restic init -q > "$TMP_OUT" 2> "$TMP_ERR"; then
        log "Initialised a new restic repository at $REPO (password: the environment name, per the Jelastic backup-storage convention)"
        return 0
    fi
    tail -n 20 "$TMP_ERR" | sed 's/^/    /'
    wfail "restic init failed at $REPO: $(restic_reason "$TMP_ERR")"
    return 1
}

# Remove stale locks only (dead PID on this host, or not refreshed for 30 min).
# Safe while other restic processes run - live locks are kept.
restic_unlock() {
    restic unlock "${CACHE_ARGS[@]}" > /dev/null 2> "$TMP_ERR" || log "note: restic unlock: $(restic_reason "$TMP_ERR")"
}

prune_due() {
    local last now
    last=$(cat "$STATE/last-prune" 2>/dev/null)
    case $last in ''|*[!0-9]*) return 0 ;; esac
    now=$(date +%s)
    [ $((now - last)) -ge $((PRUNE_HOURS * 3600)) ]
}

do_backup() {
    local rc summary nerr new changed unmod added dur tags note="" sel streak=0 frc old_snap
    if ! check_repo_mount || ! check_source || ! ensure_restic; then wfail "$ERR"; return 1; fi
    set_cache_args wipe
    repo_init_if_needed || return 1
    restic_unlock

    tags=(--tag glusterfs-multiregion --tag "mode=$MODE")
    [ -n "$CLUSTER" ] && tags+=(--tag "cluster=$CLUSTER")
    [ -n "$ENV_NAME" ] && tags+=(--tag "runner-env=$ENV_NAME")
    [ -n "$NODE_ID" ] && tags+=(--tag "runner-node=$NODE_ID")
    [ -n "$REGION" ] && tags+=(--tag "backup-region=$REGION")
    [ -n "$VOLUME" ] && tags+=(--tag "volume=$VOLUME")

    log "restic backup $SRC -> $REPO (host $HOST_ID)"
    # --group-by paths: pick the parent snapshot by path only, so snapshots
    # taken by another node / the v1 add-on still serve as the parent.
    restic backup "$SRC" --host "$HOST_ID" --group-by paths "${tags[@]}" \
        --json -q "${CACHE_ARGS[@]}" "${RL[@]}" > "$TMP_OUT" 2> "$TMP_ERR"
    rc=$?

    summary=$(grep '"message_type":"summary"' "$TMP_OUT" | tail -n 1)
    nerr=$(grep -c '"message_type":"error"' "$TMP_ERR")
    if [ "$nerr" -gt 0 ]; then
        log "restic could not read $nerr item(s); first ones:"
        grep '"message_type":"error"' "$TMP_ERR" | head -n 20 | sed 's/^/    /'
    fi
    grep -v '"message_type":"error"' "$TMP_ERR" | tail -n 20 | sed 's/^/    /'

    if [ "$rc" != 0 ] && [ "$rc" != 3 ]; then
        wfail "restic backup failed ($(rc_text "$rc")): $(restic_reason "$TMP_ERR")"
        return 1
    fi

    W_SNAP=$(json_field "$summary" snapshot_id)
    new=$(json_field "$summary" files_new)
    changed=$(json_field "$summary" files_changed)
    unmod=$(json_field "$summary" files_unmodified)
    added=$(json_field "$summary" data_added)
    dur=$(json_field "$summary" total_duration)
    dur=${dur%%.*}
    W_STATUS=ok
    W_MSG="Snapshot ${W_SNAP:0:8} saved: ${new:-?} new, ${changed:-?} changed, ${unmod:-?} unchanged files; $(human "${added:-0}") added in ${dur:-?}s."

    # Retention. An incomplete snapshot (restic exit 3: some items could not be
    # read) is re-tagged from "glusterfs-multiregion" to "partial". Complete runs
    # rotate only --tag glusterfs-multiregion and partial runs only --tag
    # partial, so partial snapshots never push complete ones out (not even when
    # the incident ends), and a file that stays unreadable cannot stop retention.
    sel=(--tag glusterfs-multiregion)
    if [ "$rc" = 3 ]; then
        streak=$(cat "$STATE/partial-streak" 2>/dev/null)
        case $streak in ''|*[!0-9]*) streak=0 ;; esac
        streak=$((streak + 1))
        printf '%s\n' "$streak" > "$STATE/partial-streak"
        W_STATUS=warning
        W_MSG="$W_MSG WARNING: $nerr item(s) could not be read, so this snapshot is incomplete (tagged 'partial'; the items are listed in the run log)."
        if [ -n "$W_SNAP" ] && restic tag --add partial --remove glusterfs-multiregion "$W_SNAP" \
                "${CACHE_ARGS[@]}" "${RL[@]}" > "$TMP_OUT" 2> "$TMP_ERR"; then
            sel=(--tag partial)
            # tagging rewrites the snapshot, which gives it a new id
            old_snap=$W_SNAP
            W_SNAP=$(restic snapshots --json --no-lock --latest 1 --tag partial --host "$HOST_ID" "${CACHE_ARGS[@]}" 2>/dev/null \
                | sed -n 's/.*"id":"\([0-9a-f]*\)".*/\1/p' | head -n 1)
            W_MSG=${W_MSG/"Snapshot ${old_snap:0:8} "/"Snapshot ${W_SNAP:0:8}${W_SNAP:+ }"}
        else
            sel=()
            log "note: could not tag the snapshot as partial - retention skipped this time: $(restic_reason "$TMP_ERR")"
        fi
        if [ "$streak" -ge "$PARTIAL_MAX" ]; then
            W_STATUS=failed
            W_MSG="$W_MSG This is the $streak. backup in a row that could not read everything - check the GlusterFS volume (e.g. split-brain files: gluster volume heal <volume> info)."
        fi
    else
        rm -f "$STATE/partial-streak"
    fi

    if [ ${#sel[@]} -eq 0 ]; then
        note="Retention skipped."
    elif restic forget "${sel[@]}" --group-by '' --keep-last "$KEEP" -q "${CACHE_ARGS[@]}" "${RL[@]}" \
            > "$TMP_OUT" 2> "$TMP_ERR"; then
        note="Kept the newest $KEEP$([ "$rc" = 3 ] && printf ' partial') snapshots."
    else
        frc=$?
        tail -n 20 "$TMP_ERR" | sed 's/^/    /'
        [ "$W_STATUS" = ok ] && W_STATUS=warning
        note="WARNING: retention (restic forget) failed ($(rc_text "$frc")): $(restic_reason "$TMP_ERR")"
        log "$note"
        sel=()
    fi

    if [ ${#sel[@]} -gt 0 ] && prune_due; then
        log "restic prune (at most once every ${PRUNE_HOURS}h)"
        if restic prune -q "${CACHE_ARGS[@]}" "${RL[@]}" > "$TMP_OUT" 2> "$TMP_ERR"; then
            date +%s > "$STATE/last-prune"
            note="$note Pruned unreferenced data."
        else
            frc=$?
            tail -n 20 "$TMP_ERR" | sed 's/^/    /'
            [ "$W_STATUS" = ok ] && W_STATUS=warning
            note="$note WARNING: restic prune failed ($(rc_text "$frc")): $(restic_reason "$TMP_ERR")"
            log "$note"
        fi
    fi
    W_MSG="$W_MSG $note"
    [ "$W_STATUS" = failed ] && log "ERROR: $W_MSG"
    return 0
}

do_verify() {
    local rc n
    if ! check_repo_mount || ! ensure_restic; then wfail "$ERR"; return 1; fi
    repo_state
    case $REPO_STATE in
        ready) ;;
        error) wfail "$ERR"; return 1 ;;
        *) wfail "there is no backup repository at $REPO yet - run a backup first"; return 1 ;;
    esac
    set_cache_args wipe
    restic_unlock
    # --no-cache: re-read every index and tree from the backup storage (a cache
    # would serve them from this node and hide damage on the storage), and
    # write nothing to this node's disk, which holds the GlusterFS brick.
    log "restic check --no-cache --read-data-subset=$CHECK_SUBSET"
    restic check --no-cache --read-data-subset="$CHECK_SUBSET" "${RL[@]}" > "$TMP_OUT" 2>&1
    rc=$?
    tail -n 40 "$TMP_OUT" | sed 's/^/    /'
    if [ "$rc" = 0 ]; then
        W_STATUS=ok
        if snapshot_count; then n="$SNAP_N snapshot(s)"; else n="snapshot count unavailable ($ERR)"; fi
        W_MSG="Repository check passed: structure verified and $CHECK_SUBSET of the stored data read back and checked; $n."
        if [ -n "$SNAP_BAD" ]; then W_STATUS=warning; W_MSG="$W_MSG $(damaged_text)"; fi
        return 0
    fi
    wfail "repository check FAILED ($(rc_text "$rc")): $(restic_reason "$TMP_OUT")"
    return 1
}

do_restore() {
    local snap=$1 target=${2%/} js path when rc why
    if ! check_repo_mount || ! ensure_restic 0.17.0; then wfail "$ERR"; return 1; fi
    repo_state
    case $REPO_STATE in
        ready) ;;
        error) wfail "$ERR - nothing was restored"; return 1 ;;
        *) wfail "there is no backup repository at $REPO"; return 1 ;;
    esac
    if ! check_source; then wfail "$ERR - refusing to restore onto the node's own disk"; return 1; fi
    if ! within_src "$target"; then
        wfail "the restore target $target resolves to $(readlink -m "$target"), outside the volume $SRC (a symlink inside the volume?) - refusing"; return 1
    fi
    set_cache_args wipe
    if ! js=$(restic snapshots --json --no-lock "${CACHE_ARGS[@]}" "$snap" 2> "$TMP_ERR") || [ "$js" = "[]" ] || [ -z "$js" ]; then
        wfail "snapshot $snap was not found in $REPO: $(restic_reason "$TMP_ERR")"; return 1
    fi
    path=$(printf '%s' "$js" | sed -n 's/.*"paths":\["\([^"]*\)".*/\1/p' | head -n 1)
    when=$(json_field "$js" time)
    if [ -z "$path" ]; then wfail "cannot read the source path of snapshot $snap"; return 1; fi
    mkdir -p "$target" || { wfail "cannot create $target"; return 1; }
    if ! within_src "$target"; then
        wfail "the restore target $target changed to point outside the volume $SRC - refusing"; return 1
    fi
    # <snapshot>:<path> restores the CONTENTS of the backed-up directory into
    # the target. A plain "restore <id> --target /data" would recreate the
    # absolute path underneath and land the files in /data/data/...
    log "restic restore $snap:$path -> $target"
    restic restore "$snap:$path" --target "$target" "${CACHE_ARGS[@]}" "${RL[@]}" > "$TMP_OUT" 2> "$TMP_ERR"
    rc=$?
    tail -n 15 "$TMP_OUT" | sed 's/^/    /'
    tail -n 15 "$TMP_ERR" | sed 's/^/    /'
    if [ "$rc" = 0 ]; then
        W_STATUS=ok
        W_MSG="Restored snapshot ${snap:0:8} (taken ${when%%.*}, path $path) into $target. Files there were overwritten with the snapshot's versions; files that are not in the snapshot were left in place. The change replicates to every region."
        return 0
    fi
    why=$(restic_reason "$TMP_ERR")
    case $rc in
        # restic fails with these while opening/locking the repository, before it writes anything.
        10|11|12) wfail "restore FAILED ($(rc_text "$rc"))${why:+: $why} - nothing was restored" ;;
        *) wfail "restore FAILED ($(rc_text "$rc"))${why:+: $why} - $target may now be only PARTLY restored (files restic reached were overwritten, the last ones possibly half-written, and that replicates to every region); run the same restore again to complete it" ;;
    esac
    return 1
}

do_purge() {
    local trash d e st=ok msg="Deleted every snapshot of $ENV_NAME from the backup storage ($REPO removed). The next backup starts a new repository."
    if ! check_repo_mount; then wfail "$ERR - nothing was deleted"; return 1; fi
    # Only "No such file or directory" means there is nothing to delete: on
    # the soft NFS mount of a storage that stopped answering, [ -e ] is false
    # too, and that must never be reported as a deletion.
    path_state "$REPO"
    case $PATH_STATE in
        error) storage_unreachable "$PATH_ERR"; wfail "$ERR - nothing was deleted"; return 1 ;;
        yes)
            # Move aside first so a half-deleted repository never sits at the
            # live path. '@' cannot occur in env names, so this only ever
            # matches this environment's leftovers.
            trash="$MOUNT/.gfsb-deleted@$ENV_NAME@$(date -u +%Y%m%dT%H%M%SZ)"
            if ! e=$(mv "$REPO" "$trash" 2>&1); then wfail "could not move $REPO aside ($(io_reason "$e")) - nothing was deleted"; return 1; fi
            log "Deleting $trash"
            if ! rm -rf "$trash"; then
                st=warning
                msg="The repository was moved aside to $trash but could not be fully deleted; remove it on the backup storage. The next backup starts a new repository."
            fi ;;
    esac
    for d in "$MOUNT/.gfsb-deleted@$ENV_NAME@"*; do
        [ -d "$d" ] && rm -rf "$d"
    done
    # The local cache belonged to the deleted repository.
    rm -rf -- "${RESTIC_CACHE_DIR:?}"
    rm -f "$STATE/last-prune" "$STATE/partial-streak"
    # Confirm on the storage itself before reporting a deletion.
    path_state "$REPO"
    case $PATH_STATE in
        no) ;;
        error) storage_unreachable "$PATH_ERR"; wfail "could not confirm that $REPO is gone: $ERR Run Delete All Backups again once the storage answers."; return 1 ;;
        *) wfail "$REPO still exists on the backup storage after the deletion (was it created again meanwhile?)"; return 1 ;;
    esac
    W_STATUS=$st
    W_MSG=$msg
    return 0
}

# ---- commands -------------------------------------------------------------------

PREV_NOTE=""
PREV_FAILED=0

# Report runs that finished in the background after their caller stopped
# waiting. "start" reports each exactly once (and escalates a failure);
# "peek" (Backup Status) shows them without consuming them.
report_unreported() {
    local mode=${1:-consume} f=$STATE/unreported id res st msg job keep=""
    [ -s "$f" ] || return 0
    while read -r id; do
        [ -n "$id" ] || continue
        res=$RUNS/$id.result
        if [ -f "$res" ]; then
            st=$(getf "$res" status); msg=$(getf "$res" message); job=$(getf "$res" job)
            if [ -z "$st" ]; then
                # an empty or cut-off result file: the worker could not write it
                st=failed
                [ -n "$job" ] || { job=${id#*-}; job=${job%-*}; }
                msg="its result could not be read - is the disk of node ${NODE_ID:-?} full? ($(disk_hint))"
            fi
            say "Earlier $job run $id finished in the background: $(upper "$st") - $msg"
            PREV_NOTE="$PREV_NOTE [Earlier $job run $id: $st - $msg]"
            [ "$st" = failed ] && PREV_FAILED=1
            [ "$mode" = peek ] && keep="$keep$id
"
        elif run_alive "$id"; then
            keep="$keep$id
"
        else
            say "Earlier run $id ended without recording a result (node restart, or a full disk? $(disk_hint))."
            PREV_NOTE="$PREV_NOTE [Earlier run $id ended without a result - node restarted, or disk full?]"
            PREV_FAILED=1
            [ "$mode" = peek ] && keep="$keep$id
"
        fi
    done < "$f"
    # Replace the list only when the new one could be written in full: on a
    # full disk a plain "> file" would truncate it and lose the runs that are
    # still running (reporting one twice is the lesser evil).
    if ! { printf '%s' "$keep" > "$f.new" && mv -f "$f.new" "$f"; } 2>/dev/null; then
        rm -f "$f.new"
    fi
}

# run_alive RUN_ID - the worker of that run is still running. Its pid file can
# be empty when the disk was full as it started: then look for the process.
run_alive() {
    worker_alive "$(cat "$RUNS/$1.pid" 2>/dev/null)" "$1" && return 0
    pgrep -f -- " worker [a-z]+ [a-z]+ $1( |\$)" > /dev/null 2>&1
}

# finish_start STATUS MESSAGE - an earlier background run that failed turns any
# result of this run into "failed" (red Tasks entry, failure e-mail), so the
# failure surfaces exactly once; the message says what this run did.
finish_start() {
    local st=$1 msg=$2
    if [ "$PREV_FAILED" = 1 ] && [ "$st" != failed ]; then
        msg="An earlier background run failed:$PREV_NOTE This run ($st): $msg"
        st=failed
    elif [ -n "$PREV_NOTE" ]; then
        msg="$msg $PREV_NOTE"
    fi
    emit "$st" "$msg"
}

cmd_start() {
    local job=${1:-} mode=${2:-manual} wait=${3:-600} id waited=0 queued=0 h res started st wpid alive
    local sv="" sh sm sio scpu note=""
    if [ $# -ge 3 ]; then shift 3; else shift $#; fi
    case $job in backup|verify|restore|purge) ;; *) emit failed "unknown job '$job'" ;; esac
    case $mode in auto|manual) ;; *) emit failed "unknown mode '$mode'" ;; esac
    case $wait in ''|*[!0-9]*) wait=600 ;; esac
    if [ "$mode" = auto ] && [ "$job" != backup ]; then emit failed "only backups run on a schedule"; fi
    check_config || emit failed "$ERR"
    if [ "$job" = restore ]; then validate_restore_args "$@" || emit failed "$ERR"; fi

    mkdir -p "$RUNS"
    trim_log
    prune_runs
    strip_legacy_cron
    report_unreported

    if lock_free; then
        rm -f "$STATE/busy-since"
    else
        h=$(holder_desc)
        # Past GFSB_STALL_HOURS a scheduled run fails loudly (red entry,
        # e-mail) when the holder made no progress over the last 30+ min, or
        # is not a job of this runner, instead of skipping silently forever; a
        # long job that still reads, writes or computes is left alone. Every
        # run repeats a measured verdict (from the heartbeat's samples).
        read -r sv sh sm sio scpu < <(stall_check)
        if [ "$mode" = auto ]; then
            case $sv in
                stuck) finish_start failed "Scheduled backup NOT taken: $h has been running for $sh h and read or wrote less than 1 MiB and used less than $PROGRESS_CPU s of CPU in the last $sm min - it may be stuck (for example on a hung backup storage mount). No new backups are taken until it ends; see Backup Status. To stop it, run '$SELF stop' on node ${NODE_ID:-?}." ;;
                held)  finish_start failed "Scheduled backup NOT taken: the backup lock has been held for $sh h by a process that is not a job of this runner: $(lock_holders | head -n 3 | oneline). To stop it, run '$SELF stop' on node ${NODE_ID:-?}." ;;
                unmeasured) finish_start failed "Scheduled backup NOT taken: $h has been running for $sh h, and whether it still makes progress cannot be checked: its progress samples are not being written to $STATE ($(disk_hint)) - is the disk of node ${NODE_ID:-?} full? No new backups are taken until it ends; see Backup Status. To stop it, run '$SELF stop' on node ${NODE_ID:-?}." ;;
                running) finish_start skipped "Scheduled backup skipped: $h is still running (for $sh h; in the last $sm min it read/wrote $(human "$sio") and used $scpu s of CPU)." ;;
                measuring) finish_start skipped "Scheduled backup skipped: $h is still running (for $sh h); its progress is being checked - if it makes none for $((PROGRESS_WINDOW / 60)) min, scheduled backups fail." ;;
            esac
            finish_start skipped "Scheduled backup skipped: $h is still running."
        fi
        case $sv in stuck|held|unmeasured) note=" $(stall_text "$sv" "$sh" "$sm")" ;; esac
        case $job in restore|purge)
            finish_start skipped "Not started - nothing was changed: $h is running.$note A $job is never queued, so it cannot run unattended later; start it again when Backup Status shows no running job." ;;
        esac
        if queued_alive; then
            finish_start skipped "Not started: $h is running and a $(getf "$STATE/queued" job) is already queued behind it.$note"
        fi
        queued=1
        # A queued job's result is reported later; do not keep the caller waiting.
        [ "$wait" -gt 20 ] && wait=20
        say "Waiting: $h is running; this $job starts as soon as it finishes.$note"
    fi

    id="$(date -u +%Y%m%dT%H%M%SZ)-$job-$$"
    # New session: the worker survives the platform command that started it,
    # and "stop" can signal its whole process group (worker + restic).
    setsid nohup "$SELF" worker "$job" "$mode" "$id" "$@" > "$RUNS/$id.log" 2>&1 < /dev/null &
    wpid=$!

    res=$RUNS/$id.result
    while [ ! -f "$res" ] && [ "$waited" -lt "$wait" ] && proc_running "$wpid"; do
        sleep 5
        waited=$((waited + 5))
    done
    # Liveness first: a worker that is gone by now can no longer write a result.
    alive=1
    proc_running "$wpid" || alive=0
    if [ -f "$res" ]; then
        tail -n 150 "$RUNS/$id.log"
        st=$(getf "$res" status)
        [ -n "$st" ] || finish_start failed "The $job (run $id) ended, but its result could not be read - is the disk of node ${NODE_ID:-?} full? ($(disk_hint))"
        finish_start "$st" "$(getf "$res" message)"
    fi
    if [ "$alive" = 0 ]; then
        tail -n 30 "$RUNS/$id.log" 2>/dev/null
        finish_start failed "The $job (run $id) ended without recording a result ($(disk_hint)): $(tail -n 3 "$RUNS/$id.log" 2>/dev/null | oneline)"
    fi

    # The run must be recorded, or its result would never be reported.
    if ! printf '%s\n' "$id" 2>/dev/null >> "$STATE/unreported"; then
        finish_start failed "The $job (run $id) continues in the background on node ${NODE_ID:-?}, but it could not be recorded for reporting - is the disk of that node full? ($(disk_hint)). Its result will NOT be reported automatically; see Backup Status.$note"
    fi
    tail -n 30 "$RUNS/$id.log" 2>/dev/null
    if [ "$(getf "$STATE/current" run_id)" = "$id" ]; then
        started=$(getf "$STATE/current" started)
        finish_start background "The $job is still running in the background on node ${NODE_ID:-?} (run $id, started $started). Its result will be reported by the next backup run and shown in Backup Status; live log: $RUNS/$id.log."
    fi
    if [ "$queued" = 1 ]; then
        finish_start queued "The $job is queued behind $h and starts as soon as that finishes (run $id). Its result will be reported by the next backup run and shown in Backup Status.$note"
    fi
    finish_start background "The $job was started in the background (run $id). Its result will be reported by the next backup run and shown in Backup Status; live log: $RUNS/$id.log."
}

cmd_worker() {
    JOB=$1 MODE=$2 RUN_ID=$3
    shift 3
    RESULT=$RUNS/$RUN_ID.result
    STARTED=$(ts)
    W_TARGET=${2:-}
    printf '%s\n' "$$" > "$RUNS/$RUN_ID.pid"
    check_config || { W_MSG=$ERR; worker_exit; exit 1; }
    new_tmp
    trap worker_exit EXIT
    W_QUEUED=0
    trap 'if [ "$W_QUEUED" = 1 ]; then W_STATUS=skipped; W_MSG="the queued $JOB was cancelled before it started - nothing was done"; exit 0; fi
          W_STATUS=failed
          if [ "$JOB" = restore ]; then W_MSG="the restore was interrupted (signal): $W_TARGET is only partly restored - run the same restore again to complete it"
          else W_MSG="the $JOB was stopped (signal) - restic discards unfinished work"; fi
          exit 130' TERM INT

    exec 9>> "$LOCK"
    case $MODE:$JOB in
        auto:*|*:restore|*:purge)
            # -w 1: ride out another runner's momentary lock probe.
            if ! flock -w 1 9; then
                W_STATUS=skipped; W_MSG="another job started first - nothing was done"; exit 0
            fi ;;
        *)
            if ! flock -w 1 9; then
                # One queued job at most: the queue slot is a second lock, held
                # only while waiting, so two simultaneous starts cannot both queue.
                exec 8>> "$QLOCK"
                if ! flock -n 8; then
                    W_STATUS=skipped; W_MSG="not started: another backup or verify is already queued - nothing was done"; exit 0
                fi
                W_QUEUED=1
                write_kv "$STATE/queued" "pid=$$" "job=$JOB" "mode=$MODE" "run_id=$RUN_ID" "since=$(ts)"
                if ! flock -w "$QUEUE_MAX" 9; then
                    W_QUEUED=0
                    rm_if_mine queued
                    wfail "gave up after waiting $((QUEUE_MAX / 60)) min for the running job to finish"
                    exit 1
                fi
                W_QUEUED=0
                rm_if_mine queued
                exec 8>&-
            fi ;;
    esac
    write_kv "$STATE/current" "pid=$$" "job=$JOB" "mode=$MODE" "run_id=$RUN_ID" "started=$(ts)"
    heartbeat_start "$$" "$RUN_ID"
    log "== $JOB ($MODE) run $RUN_ID - runner $GFSB_RUNNER_VERSION, node ${NODE_ID:-?} ($(hostname)) =="

    case $JOB in
        backup)  do_backup ;;
        verify)  do_verify ;;
        restore) do_restore "$@" ;;
        purge)   do_purge ;;
    esac
}

worker_exit() {
    trap - EXIT TERM INT
    set +e
    log "== result: $(upper "$W_STATUS") - $W_MSG =="
    rm_if_mine current
    rm_if_mine queued
    [ "$(getf "$STATE/progress" run_id)" = "$RUN_ID" ] && rm -f "$STATE/progress"
    rm -f "$TMP_OUT" "$TMP_ERR"
    cat "$RUNS/$RUN_ID.log" >> "$LOG" 2>/dev/null
    write_kv "$RESULT" "run_id=$RUN_ID" "job=$JOB" "mode=$MODE" "status=$W_STATUS" \
        "message=$W_MSG" "snapshot=$W_SNAP" "started=$STARTED" "finished=$(ts)" "node=$NODE_ID"
    cp -f "$RESULT" "$STATE/last-$JOB"
}

# list - GFSB_JSON=<the repository's snapshots as restic JSON>. Failures are
# reported as failures, never as an empty list. Lock-free, so it works while a
# backup or prune is running.
cmd_list() {
    local out errf rc
    check_config || emit failed "$ERR"
    mkdir -p "$STATE"
    check_repo_mount || emit failed "$ERR"
    repo_state
    case $REPO_STATE in
        new)     say 'GFSB_JSON=[]'; emit ok "no repository at $REPO yet - the first backup creates it" ;;
        foreign) emit failed "$REPO exists on the backup storage but is not a restic repository" ;;
        error)   emit failed "$ERR" ;;
    esac
    ensure_restic > /dev/null 2>&1 || emit failed "$ERR"
    set_cache_args > /dev/null
    errf=$(mktemp)
    out=$(restic snapshots --json --no-lock "${CACHE_ARGS[@]}" 2> "$errf")
    rc=$(snapshots_rc $? "$errf")
    if [ "$rc" = 0 ]; then
        SNAP_BAD=$(damaged_snaps "$errf")
        rm -f "$errf"
        say "GFSB_JSON=$(printf '%s' "$out" | tr -d '\n')"
        # Stays "ok": a failed list would hide every snapshot that can be restored.
        emit ok "snapshots listed$([ -n "$SNAP_BAD" ] && printf '. %s' "$(damaged_text)")"
    fi
    ERR="restic cannot read the repository at $REPO ($(rc_text "$rc")): $(restic_reason "$errf")"
    rm -f "$errf"
    emit failed "$ERR"
}

cmd_status() {
    local f v last hold sv
    check_config || emit failed "$ERR"
    mkdir -p "$RUNS"
    say "Runner $GFSB_RUNNER_VERSION on node ${NODE_ID:-?} ($(hostname))"
    if lock_free; then
        say "Running now: nothing"
    else
        say "Running now: $(holder_desc)"
        if ! job_pid "$STATE/current" > /dev/null; then
            hold=$(lock_holders | head -n 3 | oneline)
            [ -n "$hold" ] && say "Lock held by: $hold"
        fi
        # Past GFSB_STALL_HOURS: is it still making progress?
        sv=$(stall_check)
        [ -n "$sv" ] && say "$(stall_text $sv)"
    fi
    if queued_alive; then
        say "Queued: $(getf "$STATE/queued" job) (run $(getf "$STATE/queued" run_id), waiting since $(getf "$STATE/queued" since))"
    fi
    for job in backup verify restore purge; do
        f=$STATE/last-$job
        [ -f "$f" ] || continue
        say "Last $job: $(upper "$(getf "$f" status)") at $(getf "$f" finished) ($(getf "$f" mode)) - $(getf "$f" message)"
    done
    v=$(restic_version)
    say "restic: ${v:-not installed}"
    if check_repo_mount; then
        set_cache_args
        repo_state
        case $REPO_STATE in
            ready)
                if snapshot_count; then
                    last=$(restic snapshots --json --no-lock --latest 1 "${CACHE_ARGS[@]}" 2>/dev/null | sed -n 's/.*"time":"\([^".]*\).*/\1/p' | tail -n 1)
                    say "Repository: $REPO - $SNAP_N snapshot(s), newest ${last:-none yet}"
                    [ -n "$SNAP_BAD" ] && say "$(damaged_text)"
                else
                    say "Repository: $REPO - UNREADABLE: $ERR"
                fi ;;
            foreign) say "Repository: $REPO exists but is not a restic repository" ;;
            new)     say "Repository: $REPO - not created yet (the first backup creates it)" ;;
            error)   say "Repository: $REPO - UNREADABLE: $ERR" ;;
        esac
    else
        say "Repository: $ERR"
    fi
    last=$(cat "$STATE/last-prune" 2>/dev/null)
    case $last in ''|*[!0-9]*) say "Last prune: never on this node" ;;
        *) say "Last prune: $(date -u -d "@$last" +%Y-%m-%dT%H:%M:%SZ)" ;; esac
    report_unreported peek
    emit ok "status read"
}

# doctor pre|repo - installation/configuration checks; they change nothing
# except installing restic.
#   pre : config, GlusterFS source mount, restic, busy state
#   repo: backup storage mount + repository state (it must open)
cmd_doctor() {
    local phase=${1:-pre} busy=0 holder=""
    check_config || emit failed "$ERR"
    mkdir -p "$RUNS"
    if [ "$phase" = pre ]; then
        if ! lock_free || queued_alive; then busy=1; holder=$(holder_desc); fi
        printf 'GFSB_BUSY=%s\nGFSB_HOLDER=%s\nGFSB_JOB=%s\n' "$busy" "$(oneline "$holder")" "$(busy_job)"
        check_source || emit failed "$ERR"
        ensure_restic || emit failed "$ERR"
        say "GlusterFS volume mounted at $SRC; restic $(restic_version)."
        emit ok "node ready"
    fi
    check_repo_mount || emit failed "$ERR"
    ensure_restic || emit failed "$ERR"
    # The no-cache guard also applies here: a full brick filesystem must not
    # make restic fail to write its cache and read as an unreadable repository.
    set_cache_args > /dev/null
    repo_state
    case $REPO_STATE in
        ready)
            if ! repo_opens; then
                # Warn, do not fail: only an installed add-on offers Delete All
                # Backups to clear a repository nobody can read any more.
                say "GFSB_REPO=unreadable"
                emit ok "WARNING: $ERR. Every backup will fail until this is fixed; if these backups are not needed, use Delete All Backups (card menu)."
            fi
            say "GFSB_REPO=ready"
            if snapshot_count; then
                emit ok "Existing repository at $REPO with $SNAP_N snapshot(s) - backups continue in it.$([ -n "$SNAP_BAD" ] && printf ' %s' "$(damaged_text)")"
            fi
            emit ok "Existing repository at $REPO - backups continue in it (WARNING: $ERR)." ;;
        new)
            say "GFSB_REPO=new"
            emit ok "No repository at $REPO yet - the first backup creates it." ;;
        foreign)
            emit failed "$REPO exists on the backup storage but is not a restic repository - move it aside first" ;;
        error)
            emit failed "$ERR" ;;
    esac
}

# busy_job - the job running on this node: backup|verify|restore|purge, "other"
# when something else holds the lock, "" when nothing runs.
busy_job() {
    if job_pid "$STATE/current" > /dev/null; then
        getf "$STATE/current" job
    elif ! lock_free; then
        if restore_holder; then printf 'restore'; else printf 'other'; fi
    fi
}

# heartbeat PID RUN_ID - internal (see heartbeat_start): every
# PROGRESS_EVERY s, record an "<epoch> <io> <cpu>" sample of that job's process
# group in $STATE/progress (as many as cover PROGRESS_WINDOW plus a margin:
# 10 with the defaults), until the job ends.
cmd_heartbeat() {
    local pid=${1:-} rid=${2:-} f=$STATE/progress step=15 n i
    local nkeep=$((PROGRESS_WINDOW / PROGRESS_EVERY + 3))
    local -a keep
    worker_alive "$pid" "$rid" || exit 0
    # One heartbeat at a time: a new job's heartbeat waits until the previous
    # one has noticed that its job ended; a duplicate one gives up.
    exec 7>> "$STATE/heartbeat.lock" || exit 0
    flock -w 60 7 || exit 0
    [ "$PROGRESS_EVERY" -lt "$step" ] && step=$PROGRESS_EVERY
    n=$((PROGRESS_EVERY / step))
    while worker_alive "$pid" "$rid"; do
        keep=()
        if [ "$(getf "$f" run_id)" = "$rid" ]; then
            mapfile -t keep < <(grep '^s=' "$f" 2>/dev/null | tail -n "$nkeep")
        fi
        write_kv "$f" "run_id=$rid" "${keep[@]}" "s=$(date +%s) $(job_sample "$pid")"
        for i in $(seq 1 "$n"); do
            sleep "$step"
            worker_alive "$pid" "$rid" || break 2
        done
    done
    exit 0
}

# busy - GFSB_JOB=<busy_job>.
cmd_busy() {
    say "GFSB_JOB=$(busy_job)"
    emit ok "probe"
}

# stop - stop the running and the queued job, and clear stale state files.
cmd_stop() {
    local f pid n=0 i
    for f in "$STATE/queued" "$STATE/current"; do
        if pid=$(job_pid "$f"); then
            kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
            n=$((n + 1))
        fi
    done
    for i in $(seq 1 30); do
        job_pid "$STATE/current" > /dev/null || job_pid "$STATE/queued" > /dev/null || break
        sleep 2
    done
    for f in "$STATE/queued" "$STATE/current"; do
        if pid=$(job_pid "$f"); then kill -KILL -- "-$pid" 2>/dev/null; fi
        job_pid "$f" > /dev/null || rm -f "$f"
    done
    # Anything still holding the lock: a v1 job, or restic left behind by a
    # worker that died.
    for pid in $(lock_holders | awk '{ print $1 }'); do
        kill -TERM "$pid" 2>/dev/null && n=$((n + 1))
    done
    for i in $(seq 1 15); do
        [ -z "$(lock_holders)" ] && break
        sleep 2
    done
    for pid in $(lock_holders | awk '{ print $1 }'); do kill -KILL "$pid" 2>/dev/null; done
    # Heartbeats (they all keep heartbeat.lock open) would end on their own
    # within seconds; "remove" must not race with their writes into $STATE.
    for pid in $(file_holders "$STATE/heartbeat.lock" | awk '{ print $1 }'); do kill -TERM "$pid" 2>/dev/null; done
    emit ok "stopped $n process(es)"
}

# remove - uninstall from this node. Never interrupts a running restore (that
# would leave the live volume partly restored): the queued job is cancelled
# and nothing else is removed.
cmd_remove() {
    local qp
    if { [ "$(getf "$STATE/current" job)" = restore ] && job_pid "$STATE/current" > /dev/null; } \
        || restore_holder; then
        if qp=$(job_pid "$STATE/queued"); then kill -TERM -- "-$qp" 2>/dev/null; fi
        say "GFSB_RESTORE_RUNNING=1"
        emit failed "$(holder_desc) is writing into the GlusterFS volume - stopping it would leave the volume partly restored, so nothing was removed. Uninstall again once it has finished (see Backup Status)."
    fi
    (cmd_stop) > /dev/null
    cleanup_legacy
    # (a second try: a heartbeat that was just starting may still write once)
    rm -rf -- "$STATE" 2>/dev/null || { sleep 2; rm -rf -- "$STATE"; }
    rm -rf -- "${RESTIC_CACHE_DIR:?}"
    rm -rf /usr/local/sbin/glusterfs-backup /usr/local/lib/glusterfs-backup
    emit ok "backup runner removed from this node (restic and $LOG were kept)"
}

case ${1:-} in
    start)          shift; cmd_start "$@" ;;
    worker)         shift; cmd_worker "$@" ;;
    heartbeat)      shift; cmd_heartbeat "$@" ;;
    list)           cmd_list ;;
    status)         cmd_status ;;
    doctor)         shift; cmd_doctor "$@" ;;
    busy)           cmd_busy ;;
    stop)           cmd_stop ;;
    remove)         cmd_remove ;;
    cleanup-legacy) cleanup_legacy; emit ok "v1 add-on artefacts removed" ;;
    version)        say "$GFSB_RUNNER_VERSION" ;;
    *)
        say "usage: $0 start <backup|verify|restore|purge> <auto|manual> <wait-seconds> [snapshot target]"
        say "       $0 list | status | doctor <pre|repo> | busy | stop | remove | cleanup-legacy | version"
        exit 2 ;;
esac
# GFSB_EOF
