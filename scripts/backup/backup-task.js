//@auth
// GFSB_TASK_API=2
/*
 * GlusterFS Backup/Restore - platform task script.
 *
 * addons/backup.jps creates one copy of this file per environment as the
 * platform script "<envName>-gfs-backup" (jelastic.dev.scripting.CreateScript)
 * and runs it:
 *   - from the platform scheduler (jelastic.utils.scheduler.CreateEnvTask) with
 *     params {task: 1, job: "backup", envName, ...} - the scheduled backups;
 *   - from the add-on's buttons through jelastic.dev.scripting.Eval with
 *     params {job, envName, ...}.
 *
 * The body is static: the configuration is read from the storage node group's
 * data key "gfsBackup" (written by manage.js on Install/Configure), or taken
 * from the "config" param while Install/Configure validate a new one.
 *
 * A run uses the backup node Configure pinned (the lowest-id running secondary
 * storage node, else the master), makes sure the backup storage is mounted
 * there, and issues ONE ExecCmdById running the node-side runner
 * (scripts/backup/glusterfs-backup.sh). That command is the run's entry in the
 * Tasks log ("Executing command in the ... node"), and its output holds the
 * details. The runner version is pinned too: Configure records its sha256,
 * and the node keeps every version it has had, so a run always executes
 * exactly the version its configuration names.
 */

var MOUNT_NAME = "GlusterFSBackupStorage";
var LEGACY_MOUNT_PATH = "/opt/backup";
var LEGACY_MOUNT_NAME = "GlusterFSBackup";
var GROUP = "storage";
var RUNNER = "/usr/local/sbin/glusterfs-backup";
var RUNNER_STORE = "/usr/local/lib/glusterfs-backup";
var V2_JOBS = ["backup", "verify", "restore", "purge"];
var LEGACY_CLEANUP =
    "(crontab -l 2>/dev/null | grep -v -e 'glusterfs-backup-locked.sh' -e '/root/glusterfs-backup-' | crontab - ) 2>/dev/null; " +
    "rm -f /root/glusterfs-backup-run.sh /root/glusterfs-backup-locked.sh /root/glusterfs-backup-restore-by-id.sh " +
    "/root/glusterfs-backup-restore-by-files.sh /root/glusterfs-backup-restore.sh /root/glusterfs-backup-list.sh " +
    "/root/glusterfs-backup-verify.sh /root/.restore-snap /root/.restore-path; true";
var PROBE = ": glusterfs-backup probe\nif [ -x " + RUNNER + " ]; then " + RUNNER + " busy; else echo GFSB_JOB=; fi; true";

function param(name, dflt) {
    var v = getParam(name, dflt === undefined ? "" : dflt);
    return (v === null || v === undefined) ? "" : String(v);
}

var P = {
    job: param("job", "backup"),
    envName: param("envName"),
    isTask: !!param("task"),
    snapshotId: param("snapshotId"),
    restorePath: param("restorePath"),
    waitSeconds: param("waitSeconds", "600"),
    config: param("config"),
    prevNode: param("prevNode"),
    // custom schedules: set on each scheduler task
    utcOffset: param("utcOffset"),
    offsets: param("offsets"),
    tz: param("tz"),
    backupTime: param("backupTime"),
    days: param("days")
};

// ---- responses --------------------------------------------------------------

function ok(msg, extra) {
    var r = { result: 0, message: msg || "" }, k;
    for (k in (extra || {})) r[k] = extra[k];
    return r;
}
function info(msg) { return { result: "info", message: msg }; }
function warning(msg) { return { result: "warning", message: msg }; }
function fail(msg, extra) {
    var r = { result: 99, error: msg, message: msg, type: "error" }, k;
    for (k in (extra || {})) r[k] = extra[k];
    return r;
}

// ---- helpers ----------------------------------------------------------------

function q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function parseJSON(s) {
    try { return JSON.parse(String(s)); } catch (e) { return null; }
}

function tail(s, n) {
    s = String(s || "").replace(/\s+$/, "");
    return s.length > n ? "..." + s.substring(s.length - n) : s;
}

function clampInt(v, lo, hi, dflt) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
}

function nodeGroupData() {
    var r = jelastic.env.control.GetNodeGroups(P.envName, session), groups, i;
    if (!r || r.result != 0) return null;
    groups = r.object || [];
    for (i = 0; i < groups.length; i++) if (String(groups[i].name) == GROUP) return groups[i];
    return null;
}

function loadConfig() {
    var g = nodeGroupData(), raw, cfg;
    if (!g) return null;
    raw = g.gfsBackup;
    if (raw === null || raw === undefined || String(raw) === "") return null;
    cfg = parseJSON(raw);
    if (!cfg || typeof cfg !== "object") cfg = parseJSON(toJSON(raw));
    return (cfg && typeof cfg === "object") ? cfg : null;
}

// Uninstall clears the configuration before it cleans the nodes: a scheduled
// run that loaded it earlier must not re-mount or re-install behind that
// cleanup. A failed read does not count as cleared.
function configCleared() {
    var g;
    try { g = nodeGroupData(); } catch (e) { return false; }
    return !!g && String(g.gfsBackup === undefined || g.gfsBackup === null ? "" : g.gfsBackup) === "";
}

function storageNodes(envInfo) {
    var out = [], i, n;
    for (i = 0; i < (envInfo.nodes || []).length; i++) {
        n = envInfo.nodes[i];
        if (String(n.nodeGroup) == GROUP) out.push(n);
    }
    out.sort(function (a, b) { return a.id - b.id; });
    return out;
}

function isRunning(n) { return n.status === undefined || n.status === null || n.status == 1; }

function roleOf(n, nodes) {
    if (!n.ismaster) return "secondary";
    return nodes.length > 1 ? "master" : "master (single-node region)";
}

// The preferred backup node: the lowest-id running SECONDARY storage node
// (keeps the region master unburdened), else the running master.
function preferredNode(nodes) {
    var i, master = null;
    for (i = 0; i < nodes.length; i++) {
        if (!isRunning(nodes[i])) continue;
        if (!nodes[i].ismaster) return { node: nodes[i], role: "secondary" };
        if (!master) master = nodes[i];
    }
    return master ? { node: master, role: roleOf(master, nodes) } : null;
}

// The node a run uses: the one Configure pinned. While it exists but is
// stopped, runs fail loudly instead of moving silently to another node (its
// lock, queue and history live on the pinned node). Only when it no longer
// exists (scaled in) does the preferred node take over.
function runNode(nodes, cfg) {
    var i, p;
    if (cfg && cfg.nodeId) {
        for (i = 0; i < nodes.length; i++) {
            if (String(nodes[i].id) != String(cfg.nodeId)) continue;
            if (isRunning(nodes[i])) return { node: nodes[i], role: roleOf(nodes[i], nodes), pinned: true };
            return { down: String(nodes[i].id) };
        }
    }
    p = preferredNode(nodes);
    if (p) p.pinned = false;
    return p;
}

function nodeDownMessage(id) {
    return "The backup node " + id + " of " + P.envName + " is not running, so nothing was done. Start it, or open Configure and click Save to move backups to another running storage node.";
}

function storageMaster(storageEnv) {
    var name = String(storageEnv || "").split(".")[0], r, i, n, first = null;
    if (!name) return { result: 1, message: "No backup storage environment is configured - open Configure and pick one." };
    try { r = jelastic.env.control.GetEnvInfo(name, session); } catch (e) { r = { result: -1, error: String(e) }; }
    if (!r || r.result != 0) {
        return { result: 1, message: "Backup storage environment '" + name + "' is not available (" + (r && r.error ? r.error : "result " + (r ? r.result : "?")) + "). If it was deleted or rebuilt, pick the new one in Configure." };
    }
    if (r.env.status != 1) return { result: 1, message: "Backup storage environment '" + name + "' is not running.", stopped: true };
    for (i = 0; i < (r.nodes || []).length; i++) {
        n = r.nodes[i];
        if (String(n.nodeGroup) != "storage") continue;
        if (n.ismaster) return { result: 0, id: n.id, name: name };
        if (!first) first = n;
    }
    if (first) return { result: 0, id: first.id, name: name };
    return { result: 1, message: "Backup storage environment '" + name + "' has no storage node." };
}

function mountsOn(nodeId) {
    var r;
    try { r = jelastic.env.file.GetMountPoints(P.envName, session, nodeId); } catch (e) { return []; }
    return (r && r.result == 0 && r.array) ? r.array : [];
}

function findMount(nodeId, path, name) {
    var all = mountsOn(nodeId), i, m;
    for (i = 0; i < all.length; i++) {
        m = all[i];
        if (String(m.path) != path || String(m.type) != "INTERNAL") continue;
        if (name && m.name && String(m.name) != name) continue;
        return m;
    }
    return null;
}

function removeMount(nodeId, path, name) {
    var m = findMount(nodeId, path, name);
    if (!m) return false;
    try { jelastic.env.file.RemoveMountPointById(P.envName, session, nodeId, path); } catch (e) { /* best effort */ }
    return true;
}

// Make sure the backup storage's /data is mounted at cfg.mountPath on the node.
// Re-points the mount only when it is known to target another node (backup
// storage rebuilt); never touches a mount it cannot identify.
function ensureMount(cfg, nodeId, storageNodeId) {
    var m = findMount(nodeId, cfg.mountPath), r, rm, chk;
    if (m) {
        if (!m.sourceNodeId || String(m.sourceNodeId) == String(storageNodeId)) return { result: 0, added: false };
        try { rm = jelastic.env.file.RemoveMountPointById(P.envName, session, nodeId, cfg.mountPath); } catch (e) { rm = { result: -1, error: String(e) }; }
        if (!rm || rm.result != 0) {
            return { result: 1, message: "Could not move the backup storage mount at " + cfg.mountPath + " on node " + nodeId +
                " from storage node " + m.sourceNodeId + " to " + storageNodeId + ": " + (rm && rm.error ? rm.error : "result " + (rm ? rm.result : "?")) };
        }
    }
    try {
        r = jelastic.env.file.AddMountPointById(P.envName, session, nodeId, cfg.mountPath, "nfs4", null, "/data/", storageNodeId, MOUNT_NAME, false);
    } catch (e2) { r = { result: -1, error: String(e2) }; }
    if (!r || r.result != 0) {
        if (r && r.result == 2030) {
            chk = findMount(nodeId, cfg.mountPath);
            if (chk && (!chk.sourceNodeId || String(chk.sourceNodeId) == String(storageNodeId))) return { result: 0, added: false };
        }
        return { result: 1, message: "Could not mount the backup storage on node " + nodeId + " at " + cfg.mountPath + ": " + (r && r.error ? r.error : "result " + (r ? r.result : "?")) };
    }
    return { result: 0, added: true };
}

function exec(nodeId, command) {
    var r, x, o;
    try {
        r = jelastic.env.control.ExecCmdById(P.envName, session, nodeId, toJSON([{ command: command }]), true, "root");
    } catch (e) {
        r = { result: -1, error: String(e) };
    }
    x = { api: r ? r.result : -1, error: (r && r.error) ? String(r.error) : "", out: "", err: "" };
    if (r && r.responses && r.responses.length) {
        o = r.responses[0];
        x.out = String(o.out || "");
        x.err = String(o.errOut || "");
    }
    return x;
}

function execGroup(command) {
    try {
        return jelastic.env.control.ExecCmdByGroup(P.envName, session, GROUP, toJSON([{ command: command }]), true, false, "root");
    } catch (e) { return { result: -1, error: String(e) }; }
}

// GFSB_* lines printed by the runner (last occurrence wins).
function contract(text) {
    var c = {}, lines = String(text || "").split("\n"), i, m;
    for (i = 0; i < lines.length; i++) {
        m = /^GFSB_([A-Z_0-9]+)=(.*)$/.exec(lines[i]);
        if (m) c[m[1].toLowerCase()] = m[2];
    }
    return c;
}

function humanOut(text) {
    var lines = String(text || "").split("\n"), out = [], i;
    for (i = 0; i < lines.length; i++) if (!/^GFSB_[A-Z_0-9]+=/.test(lines[i])) out.push(lines[i]);
    return out.join("\n").replace(/\s+$/, "");
}

// probeNode - what runs on a node: {job: "" | backup | verify | restore |
// purge | other} or {job: undefined} when the node could not be asked.
function probeNode(nodeId) {
    var x = exec(nodeId, PROBE), c = contract(x.out);
    return { job: c.job, active: c.active };
}

function runnerEnv(cfg, nodeId) {
    return [
        "GFSB_ENV=" + q(P.envName),
        "GFSB_MOUNT=" + q(cfg.mountPath),
        "GFSB_SRC=" + q(cfg.sourcePath),
        "GFSB_KEEP=" + q(cfg.keep),
        "GFSB_HOST=" + q(cfg.hostId || ("glusterfs-" + P.envName)),
        "GFSB_CLUSTER=" + q(cfg.clusterId || ""),
        "GFSB_REGION=" + q(cfg.backupRegion || ""),
        "GFSB_VOLUME=" + q(cfg.volumeName || ""),
        "GFSB_NODE_ID=" + q(nodeId),
        "GFSB_PRUNE_HOURS=" + q(cfg.pruneHours || 24),
        "GFSB_CHECK_SUBSET=" + q(cfg.checkSubset || "5%")
    ].join(" ");
}

function fetchCmd(url) {
    return "{ timeout 25 wget -q -T 10 -t 1 -O \"$T\" " + q(url) + " || timeout 25 curl -fsS --connect-timeout 10 -m 20 -o \"$T\" " + q(url) + "; } 2>/dev/null";
}

// Runs the node runner. Every version the node has had is kept in
// RUNNER_STORE under its sha256 (the newest 5), so a configuration can always
// go back to the exact version it names - also after a Configure that failed
// half-way, or after the package moved on.
//   refresh=true (Install/Configure): install the current runner from the
//   package if the download is complete (end marker) and parses.
//   refresh=false: run exactly cfg.runnerSha256 - from the installed copy, the
//   store, or a download, in that order.
function runnerCmd(cfg, nodeId, args, refresh) {
    var url = String(cfg.runnerUrl), want = refresh ? "" : String(cfg.runnerSha256 || ""),
        valid = "head -n 1 \"$T\" | grep -q '^#!/bin/bash' && grep -q '^GFSB_RUNNER_API=2$' \"$T\"" +
                " && tail -n 1 \"$T\" | grep -qx '# GFSB_EOF' && bash -n \"$T\"",
        lines = [": glusterfs-backup " + args, "R=" + RUNNER, "S=" + RUNNER_STORE, "T=$(mktemp)",
                 "if [ -f \"$R\" ]; then H=$(sha256sum \"$R\" | cut -c1-64); if [ ! -f \"$S/$H\" ]; then mkdir -p \"$S\" && install -m 0755 \"$R\" \"$S/$H\"; " +
                 "ls -1t \"$S\" | tail -n +6 | while read -r o; do rm -f \"$S/$o\"; done; fi; fi"];
    if (!want) {
        lines.push("if " + fetchCmd(url) + " && " + valid + "; then install -m 0755 \"$T\" \"$R\"; else echo " +
                   q("note: could not download the backup runner from " + url + "; using the installed copy") + " >&2; echo GFSB_RUNNER_REFRESH=failed; fi");
    } else {
        lines.push("W=" + q(want));
        lines.push("if [ \"$(sha256sum \"$R\" 2>/dev/null | cut -c1-64)\" != \"$W\" ]; then" +
                   " if [ \"$(sha256sum \"$S/$W\" 2>/dev/null | cut -c1-64)\" = \"$W\" ]; then install -m 0755 \"$S/$W\" \"$R\";" +
                   " elif " + fetchCmd(url) + " && [ \"$(sha256sum \"$T\" | cut -c1-64)\" = \"$W\" ]; then install -m 0755 \"$T\" \"$R\"; fi; fi");
        lines.push("if [ \"$(sha256sum \"$R\" 2>/dev/null | cut -c1-64)\" != \"$W\" ]; then rm -f \"$T\"; echo 'GFSB_RESULT=failed'; echo " +
                   q("GFSB_MESSAGE=The backup runner version that Configure installed is missing on node " + nodeId + " and no longer available at " +
                     url + " - open the add-on's Configure and click Save to install the current version.") + "; exit 1; fi");
    }
    lines.push("rm -f \"$T\"");
    lines.push("if [ ! -x \"$R\" ]; then echo 'GFSB_RESULT=failed'; echo " +
               q("GFSB_MESSAGE=the backup runner is not installed on node " + nodeId + " and could not be downloaded from " + url) + "; exit 1; fi");
    lines.push("echo \"GFSB_RUNNER_SHA=$(sha256sum \"$R\" | cut -c1-64)\"");
    lines.push(runnerEnv(cfg, nodeId) + " \"$R\" " + args);
    return lines.join("\n");
}

function notifyFailure(cfg, subject, body) {
    if (cfg && String(cfg.notify) == "false") return;
    try {
        jelastic.message.email.Send(appid, (typeof signature !== "undefined") ? signature : session, null,
            user.email, user.email, subject, body);
    } catch (e) { /* e-mail is best effort */ }
}

// A scheduled run that cannot even reach the runner still leaves a red Tasks
// entry (and an e-mail), instead of failing invisibly inside the scheduler.
function visibleFailure(cfg, nodeId, msg) {
    var cmd = ": glusterfs-backup scheduled run\necho " + q("ERROR: " + msg) + " >&2\nexit 1";
    if (P.isTask) {
        if (nodeId) exec(nodeId, cmd); else execGroup(cmd);
        notifyFailure(cfg, "GlusterFS backup failed: " + P.envName, msg);
    }
    return fail(msg);
}

// Custom schedules get one scheduler trigger per UTC offset of their time
// zone (standard/daylight time); each trigger carries its offset. A trigger
// works out from its OWN offset which local date it fired for (so a fire up to
// 12 h late, or a scheduler that does not run in UTC, still counts for the
// right day) and does the backup unless the zone uses another offset on that
// date that has a trigger of its own. That gives exactly one backup per
// selected day, also on DST switch days - never zero, never two.
function dueCustom() {
    var m = /^(\d{1,2}):(\d{2})$/.exec(P.backupTime), offs = [], own = parseInt(P.utcOffset, 10), i, parts,
        zone, now, lt, tmin, wall, delta, date, target, off, pick, k, cand, dow, days = String(P.days), any = false, late, note = "";
    if (!m) return { due: true };
    parts = String(P.offsets).split(",");
    for (i = 0; i < parts.length; i++) if (parts[i] !== "" && !isNaN(parseInt(parts[i], 10))) offs.push(parseInt(parts[i], 10));
    zone = java.util.TimeZone.getTimeZone(P.tz || "UTC").toZoneId();
    now = Number(java.lang.System.currentTimeMillis());
    lt = java.time.LocalTime.of(parseInt(m[1], 10), parseInt(m[2], 10));
    tmin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    if (isNaN(own)) {
        // A task without its offset (saved before offsets were stored): only
        // the distance to the local time can tell its triggers apart.
        for (k = -1; k <= 1; k++) {
            cand = java.time.ZonedDateTime.of(java.time.LocalDate.now(zone).plusDays(k), lt, zone);
            if (!target || Math.abs(Number(cand.toInstant().toEpochMilli()) - now) < Math.abs(Number(target.toInstant().toEpochMilli()) - now)) target = cand;
        }
        if (Math.abs(Number(target.toInstant().toEpochMilli()) - now) > 10 * 60000) return { due: false };
        own = Math.round(Number(target.getOffset().getTotalSeconds()) / 60);
    }
    wall = Math.floor(now / 60000) + own;                  // local wall-clock minutes, by this trigger's offset
    delta = ((wall - tmin) % 1440 + 1440) % 1440;
    if (delta > 720) delta -= 1440;                        // minutes past the configured time (-12 h .. +12 h)
    date = java.time.LocalDate.ofEpochDay(Math.floor((wall - delta) / 1440));
    target = java.time.ZonedDateTime.of(date, lt, zone);   // a time in a DST gap moves past it; an overlap takes the first
    off = Math.round(Number(target.getOffset().getTotalSeconds()) / 60);
    if (off != own) {
        if (offs.indexOf(off) >= 0) return { due: false };           // that offset's own trigger does this date
        pick = own;                                                    // offset without a trigger (zone rules changed):
        for (i = 0; i < offs.length; i++) {                            // the trigger with the nearest offset does it
            if (Math.abs(offs[i] - off) < Math.abs(pick - off) || (Math.abs(offs[i] - off) == Math.abs(pick - off) && offs[i] < pick)) pick = offs[i];
        }
        if (pick != own) return { due: false };
        note = "Note: " + P.tz + " now uses UTC offset " + off + " min, which this schedule was not built for - open the add-on's Configure and click Save.";
    }
    if (days.length == 7) {
        for (i = 0; i < 7; i++) if (days.charAt(i) == "1") any = true;
        dow = date.getDayOfWeek().getValue() % 7;           // 0 = Sunday
        if (any && days.charAt(dow) != "1") return { due: false };
    }
    late = Math.round((now - Number(target.toInstant().toEpochMilli())) / 60000);
    if (!note && late > 20) note = "Note: the platform scheduler started this backup " + late + " min after " + P.backupTime + " " + P.tz + ".";
    return { due: true, note: note };
}

function toUtc(t) {
    try { return String(java.time.OffsetDateTime.parse(String(t)).toInstant()); } catch (e) { return String(t || ""); }
}

// ---- jobs ---------------------------------------------------------------------

function jobRun(cfg, nodes, dueNote) {
    var bn = runNode(nodes, cfg), st, m, wait, args, x, c, status, msg, mode;
    if (!bn) return visibleFailure(cfg, null, "No storage node of " + P.envName + " is running.");
    if (bn.down) return visibleFailure(cfg, null, nodeDownMessage(bn.down));
    st = storageMaster(cfg.storageEnv);
    if (st.result != 0) return visibleFailure(cfg, bn.node.id, st.message);
    if (P.isTask && configCleared()) return ok("The backup add-on is being uninstalled - nothing was done.");
    m = ensureMount(cfg, bn.node.id, st.id);
    if (m.result != 0) return visibleFailure(cfg, bn.node.id, m.message);
    if (P.isTask && configCleared()) {
        if (m.added) removeMount(bn.node.id, cfg.mountPath);
        return ok("The backup add-on is being uninstalled - nothing was done.");
    }

    mode = P.isTask ? "auto" : "manual";
    wait = P.isTask ? 3000 : clampInt(P.waitSeconds, 30, 900, 600);
    args = "start " + P.job + " " + mode + " " + wait;
    if (P.job == "restore") args += " " + q(P.snapshotId) + " " + q(P.restorePath);

    x = exec(bn.node.id, runnerCmd(cfg, bn.node.id, args, false));
    c = contract(x.out);
    if (!c.result) {
        msg = (x.api == 0)
            ? "The backup runner on node " + bn.node.id + " exited without reporting a result, so this " + P.job +
              " is NOT confirmed - the runner may be damaged; open Configure and click Save to reinstall it."
            : "Could not run the backup runner on node " + bn.node.id + ": " + (tail(x.err || x.error || x.out, 600) || "result " + x.api);
        return visibleFailure(cfg, x.api == 0 ? bn.node.id : null, msg);
    }
    status = c.result;
    msg = (c.message || tail(x.err || x.error || x.out, 600) || ("command result " + x.api)) + (dueNote ? " " + dueNote : "");

    if (P.isTask && status == "failed") notifyFailure(cfg, "GlusterFS backup failed: " + P.envName, msg);

    if (status == "ok") return ok(msg);
    if (status == "warning") return warning(msg);
    if (status == "failed") return fail(msg);
    return info(msg);          // skipped | queued | background
}

function jobList(cfg, nodes) {
    var bn = runNode(nodes, cfg), st, m, x, c, arr, i, s, snaps = [];
    if (!bn) return fail("No storage node of " + P.envName + " is running.");
    if (bn.down) return fail(nodeDownMessage(bn.down));
    st = storageMaster(cfg.storageEnv);
    if (st.result != 0) return fail(st.message);
    m = ensureMount(cfg, bn.node.id, st.id);
    if (m.result != 0) return fail(m.message);
    x = exec(bn.node.id, runnerCmd(cfg, bn.node.id, "list", false));
    c = contract(x.out);
    if (c.result != "ok") {
        return fail("Could not read the backup repository on node " + bn.node.id + ": " +
                    (c.message || tail(x.err || x.error || x.out, 600) || ("result " + x.api)));
    }
    arr = parseJSON(c.json || "[]");
    if (!arr || typeof arr.length !== "number") return fail("The snapshot list from node " + bn.node.id + " could not be read.");
    for (i = 0; i < arr.length; i++) {
        s = arr[i];
        snaps.push({ id: String(s.id), short_id: String(s.short_id || String(s.id).substring(0, 8)),
            time: toUtc(s.time), tags: s.tags || [], hostname: String(s.hostname || ""), paths: s.paths || [] });
    }
    snaps.sort(function (a, b) { return a.time < b.time ? 1 : (a.time > b.time ? -1 : 0); });
    return ok("", { snapshots: snaps, node: bn.node.id, sourcePath: cfg.sourcePath });
}

function jobStatus(cfg, nodes) {
    var bn = runNode(nodes, cfg), x, c, text;
    if (!bn) return fail("No storage node of " + P.envName + " is running.");
    if (bn.down) return fail(nodeDownMessage(bn.down));
    x = exec(bn.node.id, runnerCmd(cfg, bn.node.id, "status", false));
    c = contract(x.out);
    text = humanOut(x.out) || tail(x.err || x.error, 600);
    text = "Backup node: " + bn.node.id + " (" + bn.role + (bn.pinned ? "" : ", the configured node " + (cfg.nodeId || "?") + " no longer exists") + ")\n" +
           "Backup storage: " + cfg.storageEnv + ", mounted at " + cfg.mountPath + "\n" +
           "Schedule: " + (cfg.scheduleText || cfg.cron || "?") + "; keep " + cfg.keep + " snapshots\n" + text;
    if (c.result != "ok") return fail(c.message ? text + "\n" + c.message : text);
    return info(text.replace(/\n/g, "  \n"));
}

// Install / Configure: pick and check the backup node, (re)point the backup
// storage mount, check the repository. Never moves the backup away from a
// node, or touches a mount, while a job of this add-on is using it.
function jobPrepare(cfg, nodes) {
    var bn = preferredNode(nodes), pb, pre, c, st, tries, m, rep, rc, i, nd, notes = [], sha, pinned, stale, busyV2;
    if (!bn) return fail("No storage node of " + P.envName + " is running.");

    // Jobs are not always on the node this Configure picks (the previous
    // backup node, or a restore that is still running elsewhere): look at
    // every other running storage node first.
    for (i = 0; i < nodes.length; i++) {
        nd = nodes[i];
        if (String(nd.id) == String(bn.node.id) || !isRunning(nd)) continue;
        pb = probeNode(nd.id);
        if (pb.job && V2_JOBS.indexOf(pb.job) >= 0) {
            return fail("Not changed: a " + pb.job + " is running on storage node " + nd.id + ". Save again once it has finished (see Backup Status).");
        }
        if (pb.job === undefined && P.prevNode && String(P.prevNode) == String(nd.id)) {
            return fail("Not changed: could not check whether a job is running on the current backup node " + nd.id + " - try again.");
        }
    }

    pre = exec(bn.node.id, runnerCmd(cfg, bn.node.id, "doctor pre", true));
    c = contract(pre.out);
    if (c.result != "ok") {
        return fail("Node " + bn.node.id + " is not ready for backups: " + (c.message || tail(pre.err || pre.error || pre.out, 600)));
    }
    sha = c.runner_sha || "";
    stale = c.runner_refresh == "failed"
        ? " Note: the backup runner could not be updated from " + cfg.runnerUrl + "; the version already on node " + bn.node.id + " is used. Save again later to update it."
        : "";
    busyV2 = V2_JOBS.indexOf(String(c.job || "")) >= 0;

    for (tries = 0; tries < 12; tries++) {
        st = storageMaster(cfg.storageEnv);
        if (st.result == 0 || !st.stopped) break;
        java.lang.Thread.sleep(10000);   // a just-created backup storage may still be starting
    }
    if (st.result != 0) return fail(st.message);

    // Only re-pointing an existing mount can disturb a running job; adding one
    // cannot (a job of the previous add-on version uses its own mount).
    m = findMount(bn.node.id, cfg.mountPath);
    if (busyV2 && m && m.sourceNodeId && String(m.sourceNodeId) != String(st.id)) {
        return fail("Not changed: " + (c.holder || "a backup job") + " is using the current backup storage. Save again once it has finished (see Backup Status).");
    }
    m = ensureMount(cfg, bn.node.id, st.id);
    if (m.result != 0) return fail(m.message);

    pinned = JSON.parse(JSON.stringify(cfg));
    pinned.runnerSha256 = sha;
    rep = exec(bn.node.id, runnerCmd(pinned, bn.node.id, "doctor repo", !sha));
    rc = contract(rep.out);
    if (rc.result != "ok") {
        if (m.added) removeMount(bn.node.id, cfg.mountPath);
        return fail("Backup storage check failed: " + (rc.message || tail(rep.err || rep.error || rep.out, 600)));
    }

    // The backup storage mount belongs on the backup node only; remove it from
    // any other node that confirms, right now, that no job of this add-on runs.
    for (i = 0; i < nodes.length; i++) {
        nd = nodes[i];
        if (String(nd.id) == String(bn.node.id) || !findMount(nd.id, cfg.mountPath)) continue;
        if (isRunning(nd)) {
            pb = probeNode(nd.id);
            if (pb.job === undefined || V2_JOBS.indexOf(String(pb.job)) >= 0 || pb.active == "1") {
                notes.push("left it on node " + nd.id + " (a job may still be using it)");
                continue;
            }
        }
        if (removeMount(nd.id, cfg.mountPath)) notes.push("removed it from node " + nd.id);
    }

    return ok("Backups run on node " + bn.node.id + " (" + bn.role + ") into " + cfg.storageEnv + ". " + (rc.message || "") +
              (notes.length ? " Backup storage mount: " + notes.join("; ") + "." : "") + stale,
              { node: String(bn.node.id), role: bn.role, runnerSha256: rc.runner_sha || sha, mountAdded: m.added ? "1" : "" });
}

// A first install that failed after "prepare": take back the backup storage
// mount it added. The previous add-on version is left alone.
function jobUnprepare(cfg, nodes) {
    var i, pb, removed = [];
    for (i = 0; i < nodes.length; i++) {
        if (!findMount(nodes[i].id, (cfg && cfg.mountPath) || "/opt/gfs-backup")) continue;
        if (isRunning(nodes[i])) {
            pb = probeNode(nodes[i].id);
            if (pb.job === undefined || V2_JOBS.indexOf(String(pb.job)) >= 0) continue;
        }
        if (removeMount(nodes[i].id, (cfg && cfg.mountPath) || "/opt/gfs-backup")) removed.push(nodes[i].id);
    }
    return ok(removed.length ? "Removed the backup storage mount from node(s) " + removed.join(", ") + "." : "");
}

// After the new schedule is in place: remove the v1 add-on's leftovers from
// every storage node (crontab entry, /root scripts, /opt/backup mount).
function jobLegacy(nodes) {
    var i, removed = [];
    execGroup(": glusterfs-backup v1 cleanup\n" + LEGACY_CLEANUP);
    for (i = 0; i < nodes.length; i++) {
        if (removeMount(nodes[i].id, LEGACY_MOUNT_PATH, LEGACY_MOUNT_NAME)) removed.push(nodes[i].id);
    }
    return ok(removed.length ? "Removed the v1 mount " + LEGACY_MOUNT_PATH + " from node(s) " + removed.join(", ") + "." : "");
}

// Uninstall pre-check: is a restore writing into the volume on any node?
function jobProbe() {
    var r = execGroup(PROBE), i, c, running = [];
    for (i = 0; r && r.responses && i < r.responses.length; i++) {
        c = contract(String(r.responses[i].out || ""));
        if (c.job == "restore") running.push(r.responses[i].nodeId);
    }
    if (running.length) {
        return ok("A restore is writing into the GlusterFS volume on node " + running.join(", ") +
                  ". Uninstalling now would stop it and leave the volume partly restored - uninstall again once it has finished (see Backup Status). " +
                  "If that restore is stuck, stop it on the node with '" + RUNNER + " stop'.",
                  { restoreRunning: true });
    }
    return ok("", { restoreRunning: false });
}

// Uninstall: stop jobs and remove the runner, the backup storage mount and v1
// leftovers from every storage node. A node where a restore is running (it
// started after the pre-check) keeps its runner and mount so the restore can
// finish. The backup repository is kept.
function jobRemove(cfg, nodes) {
    var i, x, mp = (cfg && cfg.mountPath) || "/opt/gfs-backup", kept = [],
        cmd = ": glusterfs-backup uninstall\nif [ -x " + RUNNER + " ]; then " + RUNNER + " remove; fi\n" + LEGACY_CLEANUP;
    for (i = 0; i < nodes.length; i++) {
        x = exec(nodes[i].id, cmd);
        if (/GFSB_RESTORE_RUNNING=1/.test(x.out)) { kept.push(nodes[i].id); continue; }
        removeMount(nodes[i].id, mp);
        removeMount(nodes[i].id, LEGACY_MOUNT_PATH, LEGACY_MOUNT_NAME);
    }
    return ok(kept.length
        ? "A restore is still running on node " + kept.join(", ") + "; its runner and backup storage mount were left there so it can finish."
        : "Backup runner, mounts and v1 leftovers removed from the storage nodes; the backup repository was kept.",
        { restoreRunning: kept.length > 0 });
}

var CFG = null;

function main() {
    var cfg, envInfo, nodes, early, due = null;
    if (!P.envName) return fail("The envName parameter is missing.");

    // A custom schedule's other-offset trigger stays silent - even when
    // something is broken, or every failure would be reported twice a day.
    if (P.isTask && P.job == "backup" && P.backupTime) {
        due = dueCustom();
        if (!due.due) return ok("not due at this UTC offset");
    }

    cfg = CFG = P.config ? parseJSON(P.config) : loadConfig();

    envInfo = jelastic.env.control.GetEnvInfo(P.envName, session);
    if (!envInfo || envInfo.result != 0) {
        early = "Cannot read environment " + P.envName + ": " + (envInfo && envInfo.error ? envInfo.error : "result " + (envInfo ? envInfo.result : "?"));
        return P.isTask ? visibleFailure(cfg, null, early) : fail(early);
    }
    if (envInfo.env.status != 1) return fail("Environment " + P.envName + " is not running, so nothing was done.");
    nodes = storageNodes(envInfo);
    if (!nodes.length) return P.isTask ? visibleFailure(cfg, null, "Environment " + P.envName + " has no '" + GROUP + "' nodes.") : fail("Environment " + P.envName + " has no '" + GROUP + "' nodes.");

    if (P.job == "probe") return jobProbe();
    if (P.job == "remove") return jobRemove(cfg, nodes);
    if (P.job == "legacy") return jobLegacy(nodes);
    if (P.job == "unprepare") return jobUnprepare(cfg, nodes);

    if (!cfg) {
        if (P.isTask && configCleared()) return ok("The backup add-on is being uninstalled - nothing was done.");
        early = "Environment " + P.envName + " has no GlusterFS backup configuration - open the add-on's Configure and click Save.";
        return P.isTask ? visibleFailure(null, null, early) : fail(early);
    }
    switch (P.job) {
        case "backup":
        case "verify":
        case "restore":
        case "purge":   return jobRun(cfg, nodes, due && due.note ? due.note : "");
        case "list":    return jobList(cfg, nodes);
        case "status":  return jobStatus(cfg, nodes);
        case "prepare": return jobPrepare(cfg, nodes);
    }
    return fail("Unknown job '" + P.job + "'.");
}

var __result;
try {
    __result = main();
} catch (ex) {
    try {
        __result = P.isTask ? visibleFailure(CFG, null, "GlusterFS backup task error: " + ex) : fail("GlusterFS backup task error: " + ex);
    } catch (ex2) {
        __result = fail("GlusterFS backup task error: " + ex);
    }
}
jelastic.local.ReturnResult(__result);
