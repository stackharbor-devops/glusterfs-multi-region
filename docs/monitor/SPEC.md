> **Status (2026-10-13): design only, nothing built.** Work in progress, kept on branch `wip/monitor-spec`.
> - Written 2026-09-26 by a design workflow (three designs, judged and merged). The file was lost from a temporary folder and recovered from the session transcript. The lab fixtures it cites under `lab/` are lost too.
> - Defaults chosen afterwards, overriding §9: checks every **30 minutes** plus a full sweep every **3 hours**, instead of 15 minutes and hourly. That gives about 72 Tasks-log entries a day for 3 regions instead of about 168. The other recommended defaults stand: install by default on new clusters, a weekly summary e-mail on Monday at 07:00 UTC, and no test write into the volume.
> - §21's out-of-scope findings (Migrate deleting the volume, the brick port range, the ping-timeout reset) are fixed in PR #3 (`fix-cluster-logic`, v3.1.1). §7 should test brick ports against 49152-50999, not 49152-49251.
> - Do not start building without the owner asking: on 2026-09-27 the owner said the work had grown more complicated than requested.

# GlusterFS Monitor add-on: implementation spec

Package **v3.3** · add-on `glusterfs-monitor` **v1.0** · roadmap item 1: *"Monitoring and alerts: heal backlog, split-brain, brick disk usage and replication latency, surfaced in the dashboard and by e-mail."*

Why it matters: a replication layer fails quietly, and people only find out when they need the data. This add-on makes the cluster, and the monitor itself, report problems.

Companion material next to this file:
- `lab/fixtures/`: GlusterFS 11.1 outputs captured for this spec, including the collector prototypes and the lock-collision test.
- `lab/*.sh`: the lab scripts used.
- `lab/spec-check.sh` and `lab/spec-sweep.sh`: the **final** collector texts of §5, extracted from this file. They pass `bash -n` and shellcheck, and were run on 11.1 healthy, with a brick down and from a minority node. Their outputs are `lab/fixtures/spec-*.txt`.

---

## 0. Decisions at a glance

| Question | Decision |
|---|---|
| Surface | One card, **GlusterFS Monitor** (`id: glusterfs-monitor`), on the **storage** layer of `<prefix>-1`. It is installed with `nodeGroup: storage`, with top-level `buttons`/`menu` and no `permanent`, so the dashboard offers Uninstall. One monitor per cluster, enforced. |
| Engine | A static platform script `<homeEnv>-gfs-monitor` (`scripts/monitor/monitor-task.js`), deployed and sha-pinned at Configure with the backup add-on's `deployTaskScript`. |
| Schedule | Platform scheduler (`jelastic.utils.scheduler.CreateEnvTask`, Quartz, UTC). **Primary** trigger on the home env every **15 min**, with a minute offset hashed from the prefix. **Standby** trigger on a second region env that acts only when the primary has gone silent. |
| Node side | **Nothing is installed on nodes.** The pinned task script sends short inline read-only collector commands via ExecCmd. There is no runner file, no GitHub download at run time and no `redeploy.conf` edit. |
| Gluster commands | **Lock-free only**: `pool list --xml`, `volume info --xml`, `volume heal <v> info summary --xml`, `volume heal <v> info split-brain`, `volume get`. **Never** `volume status [detail]` or `volume heal … statistics`: the lab shows they take the cluster lock and make concurrent day-2 commands fail (§2.1). |
| Every run | **One** `ExecCmdById` "check" on one vantage storage node gives the cluster-wide view: peers, bricks reachable, heal backlog, split-brain, quorum, config, GRE round-trip time (RTT) to every region. That is 1 Tasks entry. |
| Hourly and on suspicion | **One** `ExecCmdByGroup` "sweep" per region env gives per-node facts: brick disk and inodes, brick and self-heal processes, glusterd, the `/data` mount and its FUSE links to every brick, clock, version, a mesh RTT, and backup runner state. That is 1 Tasks entry per region. |
| State | Node-group keys `gfsMonitor` (config, user-owned) and `gfsMonitorState` (runtime, written only by scheduled runs). Never `globals`. |
| Alerting | A platform-side state machine: confirmation counts, hysteresis, *unknown never resolves*, root-cause grouping, severity from the remaining region-failure tolerance, and a flap guard. |
| Channels | E-mail to the environment owner (`jelastic.message.email.Send`). A red **`gfs-monitor alert`** Tasks entry on every mail-worthy event, even when e-mail is paused or off. **Check Now** and **Status** popups. A weekly summary. |
| Dead-man | Standby trigger, STALE banner in Status, gap notice, weekly summary with checks run vs expected, `unknown:<check>` alerts, and an optional external heartbeat URL. |
| Install and removal | On by default from `manifest.jps` (non-strict); Import for existing clusters (strict). Uninstall is inline and best-effort: it removes tasks, keys and the script. Gluster, nodes, client envs and backup are never touched. |

---

## 1. How this spec was chosen

### 1.1 Scores (1 = poor, 5 = strong)

| Criterion | D1 Minimal-risk reuse | D2 Operator experience | D3 Failure-mode coverage |
|---|---|---|---|
| Value to the operator | 3: raw-ish report, 1 vantage, no per-node view | **5**: root cause, impact and "Do" lines, heal ETA, weekly report, heartbeat | **5**: region classification, tolerance, backup dead-man |
| Correctness against platform facts | **2**: runs `volume status`, `status detail` and `heal-count` every run, which **take the cluster lock** (lab, §2.1); day-2 add-ons and Manage Cluster have no retry | 3: xattrop index used as the heal count (lab: pending also lives in `dirty`/`entry-changes`); canary writes into tenant data; extra recipients unverified | 3: flags `data/metadata/entry-self-heal off` as drift, but these are **off by default** in 11.1 and would alert on every cluster; relies on add-ons self-installing onto sibling envs (unproven) |
| Failure-mode coverage | 3: no per-node facts, blind to partial mesh and stale clients | 4 | **5** |
| Noise (Tasks log and e-mail) | **5**: 96 entries/day | 2: 288–672 entries/day plus a red verdict every run while firing | 4: about 216/day |
| Implementation risk | **4**: copies proven backup code | 3: rules.js, assembly, canary, standby | 2: N instances, leader election, heartbeats, tombstones, Configure propagation, edits to syncClusterManager and addRegion |
| Fit with backup add-on patterns | **5** | 4 | 3 |
| **Total (of 30)** | **22** | **21** | **22** |

### 1.2 Base: D1's skeleton

D1 and D3 tie on points. D1 is the base because its flaw is local: swap the command set. D3's flaws are structural: N cards and leader election.

Kept from D1:
- One card, one static platform script, one config key.
- A platform-side state machine with the runner stateless.
- Vantage failover across envs with a majority rule.
- Backup-code reuse (`deployTaskScript`, `replaceTasks`, config I/O, `evalTask`, `opTransfer`, `visibleFailure`).
- Strict and non-strict install, duplicate guard, inline uninstall.
- Check Now read-only (no state write, no e-mail).
- Pause stored in the user-owned config key.
- Send Test E-mail, daily mail cap, at-least-once mail.
- `unknown:<check>` after 3 runs.
- `configCleared` short-circuit.
- Backup max-age from the backup schedule.

### 1.3 Grafts

From D3:
- The lock-free command set (now proven, §2.1).
- The **check/sweep split**: cheap cluster view every run, per-region per-node sweep hourly and on suspicion.
- Region classification with two signal families (down / unreachable / isolated).
- Tolerance math and tolerance-based severity.
- `peer_rejected`, volume stopped, clock and version skew via the sweep.
- `/data` top-mount check, quorum log lines, `backup_schedule` missing.
- Status reads state only.

From D2:
- The **standby trigger** on a second env, instead of D3's N instances.
- Root-cause grouping, and per-alert *Impact* and *Do* runbook text.
- RESOLVED notice with heal drain rate and ETA.
- Weekly summary with checks run vs expected, and the gap notice.
- Optional heartbeat URL.
- Prefix-hashed trigger offset, flap guard, rev-checked commit.

New, from the lab (§2.1):
- No node runner: inline collectors, UUID-keyed XML parsing.
- Heal backlog taken as the **max per replica set**.
- Heal thresholds set well above `cluster.heal-timeout` (600 s).
- The **FUSE-link check** (`.meta` `connected = 0` on a storage node's own mount).
- Brick reachability through glfsheal as the primary health signal. Peer state and TCP connects are secondary, because a frozen node keeps both "OK".

### 1.4 Cut or deferred (details in §19)

- Canary write probe (D2, D3): it writes into tenant data. It is a product decision (§20) and deferred.
- D3's N instances, leader election and tombstones: replaced by the standby trigger.
- D3's `gfsMaintenance` key and the edits to `syncClusterManager.jps` and `addRegion.jps`: unnecessary once the monitor holds no locks.
- D3's `data/metadata/entry-self-heal` drift rule: wrong, as noted in the scores.
- D2's xattrop-as-backlog: wrong for alerting; kept only as an approximate fallback.
- D2's extra recipients: `Send` to non-owner addresses is unverified.
- D2's per-alert acknowledgement.
- D1's sha-pinned node runner: not needed, since collectors are inline.

### 1.5 Contradictions resolved

| Topic | D1 | D2 | D3 | Resolution |
|---|---|---|---|---|
| Lock-taking CLI | uses it | avoids it | avoids it | **Avoid.** The lab proved the collisions. |
| Where checks run | 1 vantage per run | every node per run | 1 vantage per run plus sweeps | **1 vantage per run plus hourly/suspicion sweeps** |
| Monitor placement | 1 card | 1 card plus standby trigger | N cards plus election | **1 card plus standby trigger** |
| Check Now | read-only | stateful, e-mails | stateful | **Read-only.** There is one state writer and no race; scheduled runs notify. |
| Interval | 15 min | 15 min | 10 min | **15 min** |
| Critical reminder | 24 h | 4 h | 6 h | **6 h critical, 24 h warning, 7 d structural** |
| Summary cadence | weekly | weekly | daily | **Weekly by default, daily optional** (product decision §20) |
| Heal alert | 60 min continuous | 2 h and not falling | >1000 / 6 h / growing | **60 min continuous and not draining; CRIT at 24 h; relaxed windows after outages and layout changes** |
| RTT threshold | 250 ms absolute | 150 ms absolute | baseline-relative plus 250 ms | **250 ms absolute plus 3× the learned baseline (and at least +50 ms)** |
| Install from the manifest | always, no field | checkbox, default on | checkbox, default on | **Always, no dialog field**, removable (product decision §20) |

---

## 2. Facts this design stands on

### 2.1 Verified in the lab on GlusterFS 11.1

Setup: `gl11-v28`, three nodes, a replica-3 volume built exactly like `createStretchedVolume`, and the FUSE mount like `mountAllNodes`.

1. **Lock behaviour** (`lab/fixtures/locktest-cross.txt`). A reader looped for 15 s on node 2 while `volume set` looped on node 1.

   | Reader command | `volume set` failures | Reader failures |
   |---|---|---|
   | `peer status`, `pool list`, `volume info`, `volume get <v> all`, `volume get all <opt>` | **0** | 0 |
   | `volume heal <v> info summary --xml`, `volume heal <v> info split-brain` | **0** | 0 |
   | `volume status <v> --xml` | 6 of 389 ("Another transaction is in progress", "Locking failed") | 95 % |
   | `volume status <v> detail --xml` | 10 of 403 | 95 % |
   | `volume heal <v> statistics heal-count` | 8 of 389 | 97 % |

2. **Brick process killed.** The peer stays `Connected`.
   - In the text summary, the brick shows `Status: Transport endpoint is not connected` and the counts show `-`.
   - In the **XML**, the brick shows `hostUuid="-"` and `<status>Failed to process entries completely. (Transport endpoint is not connected)totalNumberOfEntries0</status>`, with **no count elements**.
   - The surviving bricks report **the same** pending count (28 and 28), so the backlog of a set is the **max**, not the sum. See `check-brick2-down-pending.txt`.
3. **glusterd stopped** while the brick process still runs. The peer shows `Disconnected`, and the heal summary shows that brick as not connected, because a new client needs that node's glusterd portmap. The summary took **10 s**.
4. **Partition** (node isolated):
   - The majority side still listed the node `Connected` for about 5–7 s. TCP connects to 24007 timed out at once, and the heal summary showed its brick not connected.
   - On the minority side, every peer showed `connected=0`.
   - glusterd logged `C [MSGID: 106002] ... Server quorum lost for volume data. Stopping local bricks.` and later `106003 ... Server quorum regained ... Starting local bricks.`
   - The heal summary failed with **rc 251**, `data: Not able to fetch volfile from glusterd`.
5. **Stale FUSE client after the partition healed.** The brick restarted on a new port. The existing FUSE mount on node 1 stayed disconnected from that brick for **14+ minutes**, while glfsheal and all peers reported everything `Connected`.
   - The state was visible in `/data/.meta/graphs/active/data-client-2/private` as `connected = 0`.
   - A later second brick failure then made that mount fail with `ENOTCONN` ("Client-quorum is not met"), although 2 of 3 bricks were up.
   - A remount fixed it. See `sweep-stale-fuse-client-gmon1.txt`.
6. After reconnection, heal pending stayed at 21 with all bricks connected, then drained later: `cluster.heal-timeout` is 600 s by default.
7. **Frozen node** (`docker pause`). `pool list` kept showing it `Connected` for 80+ s, because glusterd-to-glusterd `ping-timeout` is 0 in `glusterd.vol`. TCP connect to 24007 **still succeeded**, because the kernel accepts connections. **Only** the heal summary showed its brick unreachable. See `check-node3-hung.txt`.
8. A bare TCP connect and close to 24007 writes **nothing** to glusterd's log. LAN connect time measured in the child process with `$EPOCHREALTIME` was about 0.8–1.3 ms.
9. `volume info --xml` gives:
   - `replicaCount`;
   - `distCount`, the number of replica sets (1 for 1×3, 2 for 2×3);
   - `brickCount`, and each brick's `<name>` and `<hostUuid>`;
   - option `name`/`value` pairs.

   `pool list --xml` gives `uuid`, `hostname` (repeated under `hostnames`), `connected` 0/1 and `stateStr`. The node itself is listed as `hostname` `localhost`. The node that ran the probes appears under a **DNS name** in other peers' views, so everything is keyed by **UUID**.
10. Defaults in 11.1:
    - `cluster.data-self-heal`, `metadata-self-heal` and `entry-self-heal` are **off**; these are client-side and expected.
    - `cluster.self-heal-daemon` is on.
    - `cluster.server-quorum-ratio` is `51 (DEFAULT)` and `cluster.op-version` is 110000.
11. `glusterd.vol` sets `max-port 60999`. Brick ports seen were 52405, 56689, 59526 and 59551, all outside the storage firewall range 49152–49251 (§21).
12. Compact XML sizes: heal summary about 380 B per brick, volume info about 360 B per brick, pool list about 240 B per peer. Even 7 regions × 9 nodes stays under 60 KB of output per check.

### 2.2 Repository facts relied on

| Fact | Where |
|---|---|
| `ExecCmdById(env, session, nodeId, toJSON([{command}]), true, "root")`, `ExecCmdByGroup(env, session, "storage", …, true, false, "root")`, `responses[i].{nodeId,out,errOut}` | `scripts/backup/backup-task.js` `exec`, `execGroup`, `jobLegacy` |
| `GetEnvInfo`: `env.status`, `env.hostGroup.displayName`, `nodes[].{id,address,ismaster,status,nodeGroup}` | `addons/management.jps` `op_listNodes`, `syncClusterManager.jps` `gatherNodes` |
| Node-group keys are properties of `GetNodeGroups().object[i]`; `ApplyNodeGroupData` works per key, first as a JSON string and then in object form | `loadClusterGlobals.js`, `native-fuse.jps`, backup `writeConfigValue` |
| Bricks are `<internal ip>:/glustervolume`, interleaved with one per region per replica set. The volume has quorum-type auto, server-quorum-type server, ping-timeout 30, choose-local on and `auth.allow *` | `syncClusterManager.jps` |
| FUSE mount `localhost:/<vol>` at `<mount>` with fstab `noauto,x-systemd.automount`, so the **top** mount is checked after a timed `stat` | `syncClusterManager.jps` `mountAllNodes`; memory note on automounts |
| Backup config key `gfsBackup`: `envName`, `nodeId`, `scheduleType`, `cron`, `crons` (UTC), `days`, `notify`, `updated` (ISO-rand) | `scripts/backup/manage.js` `buildConfig` |
| Backup runner state: `/var/lib/glusterfs-backup/{last-backup,current,runs/<YYYYmmddTHHMMSSZ>-<job>-<pid>.result}` with `status=` ok, warning, failed or skipped; `finished=` (ISO Z); `mode=` auto or manual; `message=`. Only the newest 60 results are kept | `glusterfs-backup.sh` `worker_exit`, `prune_runs`, `cmd_start` |
| Backup task `<env>-gfs-backup` returns silently, with **no Tasks entry**, while its env is stopped | `backup-task.js` `main()` |
| Scheduler: `CreateEnvTask({appid, envName, session, script, trigger:"cron:<quartz>", description, params})`; `GetTasks` under `[appid, envAppid]`; `RemoveTask`, then `DeleteTasks` | backup `manage.js` |
| Custom responses `{result:"info"\|"warning", type, message}`; errors `{result:99, type:"error"}`. A Configure that returns 0 shows only the static successText | `backup-task.js`, backup `manage.js` `opApply` |
| Manage Cluster's status op runs the lock-taking `gluster volume status`. Day-2 mutating commands have no retry | `management.jps` `op_status`, `syncClusterManager.jps` |
| Manage Cluster's Custom CLI regex blocks `\| ; & < > $` backticks and backslashes, so `<gfid:…>` split-brain entries cannot be resolved through it | `management.jps` |

---

## 3. Architecture

### 3.1 Placement

```
            platform core: scheduler + scripting engine + mail (outside every region)
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │ trigger P  cron:S m1,m2,m3,m4 * * * ? *   bound to <prefix>-1 ─┐                       │
 │ trigger S  same minutes + I/2              bound to <prefix>-2 ─┴─► script <prefix>-1-gfs-monitor
 │   1  GetNodeGroups: gfsMonitor, gfsMonitorState                                         │
 │   2  GetEnvs + GetEnvInfo(each <prefix>-N)          platform facts: env/node status     │
 │   3  CHECK  ExecCmdById(vantage)  ───────────────┐  1 Tasks entry                       │
 │   4  SWEEP  ExecCmdByGroup(region env, storage) ─┼─ 1 entry per region, hourly/suspect  │
 │   5  evaluate + state machine (pure JS)          │                                      │
 │   6  ApplyNodeGroupData(gfsMonitorState)         │                                      │
 │   7  alert entry ExecCmdById + message.email.Send│  only on mail-worthy events          │
 └──────────────────────────────────────────────────┼──────────────────────────────────────┘
                                                    ▼
   region A <prefix>-1        region B <prefix>-2        region C <prefix>-3
   [master] vantage #1        [master] vantage #2        [master] vantage #3
        gluster CLI (lock-free) ── glusterd/brick RPC over private GRE ──► every peer and brick
```

The evaluator runs in the platform's scripting engine, not in a region. A region outage, including the home region's, is therefore *observed* rather than silencing the monitor. The one assumption here, whether the scheduler fires a task bound to a stopped env, is covered by the standby trigger (§3.4).

### 3.2 One scheduled run (`job=check`, `task=1`)

Time budget: `t0` is taken at start. No new vantage attempt starts after `t0 + 150 s`, and no new sweep after `t0 + 180 s`; whatever is skipped is marked *unknown*.

1. `cfg = loadConfig(home)`.
   - If it is empty and `configCleared()`, return `{result:0}` quietly (uninstall in progress).
   - If it is unreadable, run `visibleFailure` (§13.4).
2. For `role == "standby"`, apply the §3.4 gate first.
3. Load the state: `state = newest(gfsMonitorState@home, gfsMonitorState@standby)` by `rev`. Start a fresh `{v:1}` when there is none or `v` is unknown.
4. **Discovery.**
   - `GetEnvs` finds the siblings `^<prefix>-(\d+)$` (the getClusterEnvs rule, inlined).
   - `GetEnvInfo` on each gives the env status, region name (`env.hostGroup.displayName`) and storage nodes.
5. **CHECK.** Run the vantage loop (§3.3) with the collector of §5.2.
6. **SWEEP** the envs that are due. That means every running brick-holding env when `now − state.sweep.at ≥ sweepMin − 3 min`, or on the first run after Configure. It also means every env marked *suspect* by the check (§7.3), at most once per run. In the same hourly pass:
   - `GetNodeGroups` on every sibling, to find `gfsBackup`;
   - `listTasks` for the backup task and for the monitor's own two triggers.
7. **Evaluate** (pure JS, §6–§7). This gives observations, the unknown checks, info notes and facts.
8. **Transitions** (§8), which produce the events.
9. **Plan notifications** (§8.4): at most one mail and one alert entry per run.
10. **Commit.**
    - Re-read the state `rev`. If another run committed since step 3, abort: nothing is written and nothing is sent.
    - Otherwise write `gfsMonitorState` on home with `rev+1`. If the write fails (for example, home is stopped), write it on the standby env instead.
    - If `configCleared()` is now true, stop.
11. **Send.** Write the alert Tasks entry and call `Send` (§8.5). On success, clear `mail.pending` with a second small write.
12. If `heartbeatUrl` is set, send a GET to it (§14.2).
13. Return `{result:0}`. The scheduler ignores the result; everything visible was already written.

### 3.3 Vantage selection

- **Candidates, in order:** the home env master; the other home storage nodes by id; then, for each other brick-holding env by index, its master and then the rest.
- **Skip:** envs with `env.status != 1` and nodes with `status` defined and not 1 (`isRunning` from backup-task.js).
- **Deprioritise:** nodes whose ExecCmd failed in the last 30 min (the unreachable cache in state) go last.
- **Attempts:** at most 3 per run. After a failure, the next attempt must be in a different env.
- A candidate **answered** when the output contains `GFSM_END=1`, `GFSM_POOL_RC=0` and `GFSM_INFO_RC=0`.
- It has the **majority** when `connected × 100 > total × 51`, or `connected ≥ ceil(ratio × total / 100)` when `server-quorum-ratio` was set explicitly, **and** `GFSM_HEAL_RC != 251`.
- The first answered candidate that has the majority becomes this run's **vantage**. An answered candidate in the minority is kept as *minority evidence* (it is exactly the isolated region's view) and the loop continues.
- If nobody has the majority, use the answered candidate with the most connected peers and add the observation `partition`.
- If nobody answered, add `monitor:novantage`. No gluster-level alert resolves in that run.

### 3.4 Primary and standby triggers

- **Standby env:** at Configure, the lowest-index running `<prefix>-N` other than home that holds bricks. With none (a single region), there is no standby and Status says so.
- The standby trigger uses the same script and minutes shifted by `floor(I/2)`. Its params are `{task:1, job:"check", envName:<home>, role:"standby"}`, and its `description` contains `standby`.
- **Standby gate:** the standby acts only if `GetEnvInfo(home).env.status != 1`, **or** `now − newest(lastRun.at) > 2×I + 10 min`. Otherwise it returns after at most 3 read calls, with no exec and no write, so no Tasks entry.
- When it acts:
  - It does a normal run with `by:"standby"`.
  - The first acting run queues the notice *"The primary schedule on <home> has not run since <t> (env status <s>); checks now run from the standby schedule on <standby>."*
  - When a primary run follows a standby run, it queues *"The primary schedule is back."*
- **Self-repair,** hourly: when `listTasks` shows a trigger missing, the run tries `CreateEnvTask` for it once every 6 h. If that fails, it raises `monitor:standby` (or `monitor:primary`) WARN with "Configure → Save". The usual cause is Forget Region deleting the standby env.

### 3.5 Ownership and concurrency

| Key | Written by | Never written by |
|---|---|---|
| `gfsMonitor` (config) | Install/Configure (`manage.js op apply`), Pause (`op pause`), Uninstall (clear) | scheduled runs, Check Now, Status |
| `gfsMonitorState` | scheduled runs (primary or acting standby), install (fresh `{v:1}`), uninstall (clear) | Check Now, Status, Configure (keeps it, so alert continuity survives) |

Concurrent writers are rare (a standby acting at the moment the primary resumes). The `rev` check at commit makes the loser abort before sending mail. There is no atomic compare-and-set, so a duplicate mail is possible but bounded (§18).

---

## 4. Files

| Path | Status | Content | Est. lines |
|---|---|---|---|
| `addons/monitor.jps` | new | The card (§11). `type: update`, `jpsVersion: 6.1.1`, `targetNodes: {nodeGroup: storage, nodeType: [storage]}`, `globals.base_path: ${baseUrl}`, forms, buttons/menu, `onInstall`, **inline** `onUninstall` and `onBeforeDelete`, `onAfterConfirmTransfer`. | ~260 |
| `scripts/monitor/manage.js` | new | Ops `apply`, `run`, `pause` and `transfer`. **Copied** from `scripts/backup/manage.js` (about 300 lines): the param loop with unresolved-placeholder handling; `ok`/`fail`/`unwrap`/`trim`/`parseJSON`/`bool`/`sha256`; `loadConfig`/`writeConfigValue`/`saveConfig` (key parametrised); `getTaskScript`/`scriptCode`/`deleteTaskScript`/`createTaskScript`/`deployTaskScript` (marker `GFSM_TASK_API=1`); `evalTask`; `listTasks` with `TASKS_UNREAD`; `removeTaskList`; `taskId`; `replaceTasks` (extended to per-trigger `envName` and description); `undoFreshInstall`; `opTransfer`. Every copied function carries `// copied from scripts/backup/manage.js @<commit> - keep in sync`. | ~520 |
| `scripts/monitor/monitor-task.js` | new | The platform script body. It starts with `//@auth` and then `// GFSM_TASK_API=1`. Jobs: `check`, `prepare`, `status`, `testmail`. **Copied** from backup-task.js: `param`, `ok`/`info`/`warning`/`fail` (with an explicit `type`), `q`, `parseJSON`, `tail`, `nodeGroupData`, `configCleared`, `isRunning`, `exec`, `execGroup`, `notifyFailure`→`sendMail`, `visibleFailure`, `contract` (extended for repeated keys). It contains a `// ---- PURE BEGIN` … `// ---- PURE END` block with no `jelastic`/`java` references: parsers, model, rules, state machine, cron simulation and text rendering, which node tests extract and eval. | ~1100 |
| `scripts/monitor/settings-form.js` | new | `onBeforeInit` for the Import dialog and Configure, with the backup settings-form's dual return shape. It pre-fills from `gfsMonitor`, shows a warning field when the config cannot be read, and on Import shows the detected cluster (prefix, regions, volume, mount). | ~90 |
| `manifest.jps` | changed | `version: 3.3`; `globals.monitorLine: ""`; `onInstall` adds `installMonitor` and `monitorSummary` after the backup block (§15.1). | +35 |
| `success/success.md` | changed | A "Monitoring" section with `${globals.monitorLine}`. | +12 |
| `README.md` | changed | A feature bullet; the "Monitoring and alerts" section (what is checked, the card, e-mails, noise and cost, Pause before day-2 work, how to tell it is alive); Troubleshooting entries (§15.8); file layout; v3.3 versioning; a scaling-decision-tree row. | +120 |
| `tests/monitor/` | new, not fetched by the platform | `fixtures/` (from `lab/fixtures` and more, §17), `unit/*.test.js` (node), `nashorn/` (harness, mocks, `run.sh`), `lab/` (docker scripts). | – |

**Unchanged:** `addons/management.jps`, every backup file, `scripts/syncClusterManager.jps`, `scripts/cluster-logic.jps`, `scripts/storage-region.jps`, the day-2 add-ons, `native-fuse.jps` and `client.jps`. New regions are picked up by discovery on every run.

**Hard rule for every monitor file:** no `${` except real JPS placeholders in `.jps`, `manage.js` and `settings-form.js`. Shell snippets use `$VAR` only; this is the JPS-interpolation gotcha, and a static test enforces it.

---

## 5. Node collectors (exact commands)

### 5.1 Common rules

- The builders are pure functions in `monitor-task.js`: `checkCmd(cfg, vantage, targets, full)`, `sweepCmd(cfg, env, targets, backupFlag)`, `echoCmd(kind, text, exitCode)`.
- **Validated inputs**, rejected before any command is built:
  - volume `^[A-Za-z0-9_.-]+$`;
  - mount path `^/[A-Za-z0-9._/-]*[A-Za-z0-9_-]$`;
  - brick path fixed at `/glustervolume`;
  - IPs `^\d{1,3}(\.\d{1,3}){3}$`.

  Every value is single-quoted with backup's `q()`.
- The first line is `: gfs-monitor <kind> <prefix> …`, so the Tasks entry can be recognised, the same convention as `: glusterfs-backup`. Bash **parses** that line: every token in it is reduced to `[A-Za-z0-9._:-]`, so parentheses, quotes, `<`, `>`, `|`, `;` and `&` never appear. Found by `bash -n` on this spec's first draft.
- Collectors **always exit 0**. They report and do not judge. Red entries come from the alert entry (§13.1), because it is unverified whether ExecCmd returns stdout on a non-zero exit (§18), and the evaluator must never go blind during problems.
- Every external command is wrapped in `timeout`. There is never a bare `df` (a hung FUSE mount would hang it), and `stat` of the mount always goes through `timeout -k`.
- **Allowed gluster invocations** (a static test greps and allows only these):
  - `gluster --mode=script pool list --xml`
  - `gluster --mode=script volume info <v> --xml`
  - `gluster --mode=script volume heal <v> info summary [--xml]`
  - `gluster --mode=script volume heal <v> info split-brain`
  - `gluster --mode=script volume get <v>|all <option>`
  - `glusterfs --version`
- **Writes on nodes: none.** No files, no mounts, no service changes. Triggering the automount with `stat` is a read.

### 5.2 CHECK collector (every run, one vantage, via `ExecCmdById`)

Parameters:
- `V`: the volume.
- `TGT`: one IP per *other* brick-holding env (its running master, else its lowest-id running node).
- `HM=120`: the heal timeout in seconds.
- `FULL`: 1 on sweep runs and on Check Now, else 0.

The text matches the lab prototype `lab/fixtures/collector-check.prototype.sh`, which was run against 11.1.

```bash
: gfs-monitor check gfs vantage 12345 env gfs-1 run 20260926T1004Z-3f2a
V='data'; TGT='10.1.2.3 10.1.3.4'; HM=120; FULL=0
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
c() { tr -d '\n\r' | sed -e 's/>[[:space:]]*</></g'; }
f() { grep -oE "$1" | tr '\n' '|'; }
us() { if [ -n "$EPOCHREALTIME" ]; then echo "$EPOCHREALTIME" | tr -d .; else echo $(( $(date +%s%N) / 1000 )); fi; }
echo "GFSM_T0=$(date +%s%3N)"
command -v gluster >/dev/null 2>&1 || { echo 'GFSM_ERR=gluster CLI not found'; echo GFSM_END=1; exit 0; }
if systemctl is-active --quiet glusterd 2>/dev/null || pgrep -x glusterd >/dev/null; then echo GFSM_GLUSTERD=active; else echo GFSM_GLUSTERD=inactive; fi
X=$(timeout 20 gluster --mode=script pool list --xml 2>&1); echo "GFSM_POOL_RC=$?"
PC=$(printf '%s' "$X" | c); echo "GFSM_POOL=$(printf '%s' "$PC" | f '<(uuid|hostname|connected|stateStr|opErrstr)>[^<]*')"
X=$(timeout 20 gluster --mode=script volume info "$V" --xml 2>&1); echo "GFSM_INFO_RC=$?"
echo "GFSM_INFO=$(printf '%s' "$X" | c | f '<(opErrstr|statusStr|brickCount|distCount|replicaCount|typeStr|name|hostUuid|value)>[^<]*')"
s=$(us); X=$(timeout -k 5 "$HM" gluster --mode=script volume heal "$V" info summary --xml 2>&1); rc=$?
echo "GFSM_HEAL_RC=$rc"; echo "GFSM_HEAL_MS=$(( ($(us) - s) / 1000 ))"
HC=$(printf '%s' "$X" | c)
echo "GFSM_HEAL=$(printf '%s' "$HC" | f '(hostUuid="[^"]*"|<(name|status|numberOfEntriesInHealPending|numberOfEntriesInSplitBrain|numberOfEntriesPossiblyHealing|opErrstr)>[^<]*)')"
if [ "$rc" -ne 0 ]; then
  echo "GFSM_HEAL_ERR=$(printf '%s' "$HC" | sed 's/<[^>]*>/ /g' | tr -s ' ' | cut -c1-240)"
  if printf '%s' "$X" | grep -qiE 'usage|unrecognized|invalid'; then
    echo "GFSM_HEALTXT=$(timeout -k 5 "$HM" gluster --mode=script volume heal "$V" info summary 2>&1 | grep -E '^(Brick |Status:|Number of entries in (heal pending|split-brain):)' | tr '\n' '|')"
  fi
fi
SB=$(printf '%s' "$HC" | grep -oE '<numberOfEntriesInSplitBrain>[0-9]+' | cut -d'>' -f2 | awk '{s+=$1} END {print s+0}')
if [ "$SB" -gt 0 ]; then
  timeout -k 5 60 gluster --mode=script volume heal "$V" info split-brain 2>/dev/null | grep -E '^(Brick |/|<gfid:)' | head -n 60 | cut -c1-200 | sed 's/^/GFSM_SB=/'
fi
if [ "$FULL" = 1 ]; then
  for o in cluster.op-version cluster.max-op-version cluster.server-quorum-ratio; do
    echo "GFSM_OPT=$o|$(timeout 20 gluster --mode=script volume get all "$o" 2>/dev/null | awk -v o="$o" '$1==o {sub(/^[^ ]+ +/, ""); print; exit}')"; done
  for o in cluster.quorum-type cluster.server-quorum-type cluster.self-heal-daemon network.ping-timeout auth.allow; do
    echo "GFSM_OPT=$o|$(timeout 20 gluster --mode=script volume get "$V" "$o" 2>/dev/null | awk -v o="$o" '$1==o {sub(/^[^ ]+ +/, ""); print; exit}')"; done
fi
for ip in $TGT; do
  ( r=""; for k in 1 2 3; do
      o=$(timeout 3 bash -c 'n() { if [ -n "$EPOCHREALTIME" ]; then echo "$EPOCHREALTIME" | tr -d .; else echo $(( $(date +%s%N) / 1000 )); fi; }; s=$(n); exec 3<>"/dev/tcp/$1/24007" && echo $(( $(n) - s ))' _ "$ip" 2>/dev/null) || o=x
      [ -n "$r" ] && r="$r,"; r="$r$o"; done; echo "GFSM_RTT=$ip|$r" ) &
done; wait
echo "summary: peers connected $(printf '%s' "$PC" | grep -o '<connected>1' | wc -l)/$(printf '%s' "$PC" | grep -o '<uuid>' | wc -l), bricks reachable $(printf '%s' "$HC" | grep -o '<status>Connected<' | wc -l)/$(printf '%s' "$HC" | grep -o '<name>[^<]*:/' | wc -l), split-brain $SB, heal query $rc"
echo "GFSM_END=1"
```

RTT values are microseconds; `x` means a failed or timed-out connect. The collector is typically done in under 5 s. Its worst case is 20 + 20 + 120 + 60 + 9 s, about 230 s, which is inside the ExecCmd hour.

### 5.3 SWEEP collector (hourly and on suspicion, every storage node of one region, via `ExecCmdByGroup`)

Parameters:
- `V`: the volume.
- `M`: the mount path.
- `BR=/glustervolume`.
- `TGT`: one IP per *other* brick-holding env, which gives the mesh RTT.
- `BK`: 1 only for the env that holds `gfsBackup`.

Prototype: `lab/fixtures/collector-sweep.prototype.sh`.

```bash
: gfs-monitor sweep gfs region gfs-2 run 20260926T1004Z-3f2a
V='data'; M='/data'; BR='/glustervolume'; TGT='10.1.1.2 10.1.3.4'; BK='0'
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
echo "GFSM_T=$(date +%s%3N)"
echo "GFSM_IPS=$(hostname -I 2>/dev/null | tr ' ' ',')"
if systemctl is-active --quiet glusterd 2>/dev/null || pgrep -x glusterd >/dev/null; then echo GFSM_GLUSTERD=active; else echo GFSM_GLUSTERD=inactive; fi
echo "GFSM_GVER=$(glusterfs --version 2>/dev/null | awk 'NR==1{print $2}')"
echo "GFSM_UPTIME=$(cut -d. -f1 /proc/uptime)"
B=$(pgrep -f "glusterfsd .*--brick-name $BR( |$)" | head -n 1); echo "GFSM_BRICKPROC=$B"
if [ -n "$B" ] && command -v ss >/dev/null; then echo "GFSM_BRICKPORT=$(ss -ltnpH 2>/dev/null | awk -v p="pid=$B," 'index($0,p){n=split($4,a,":"); print a[n]; exit}')"; fi
echo "GFSM_SHD=$(pgrep -f 'glustershd' | head -n 1)"
echo "GFSM_POOLV=$(timeout 20 gluster --mode=script pool list --xml 2>/dev/null | grep -oE '<connected>[01]' | awk -F'>' '{t++; c+=$2} END {print c+0 "/" t+0}')"
echo "GFSM_DF=$(timeout 10 df -Pk "$BR" 2>/dev/null | awk 'NR==2{print $2"|"$3"|"$4"|"$6}')"
echo "GFSM_DFI=$(timeout 10 df -Pi "$BR" 2>/dev/null | awk 'NR==2{print $2"|"$3"|"$4}')"
echo "GFSM_DFGD=$(timeout 10 df -Pk /var/lib/glusterd 2>/dev/null | awk 'NR==2{print $2"|"$3"|"$4"|"$6}')"
e=$(timeout -k 2 10 stat -c %i "$M/." 2>&1 >/dev/null) && e=ok
FT=$(findmnt -rn -o FSTYPE --mountpoint "$M" 2>/dev/null | tail -n 1)
echo "GFSM_MOUNT=$FT|$(printf '%s' "$e" | tr '|\n' '  ' | cut -c1-120)"
if [ "$e" = ok ] && [ "$FT" = fuse.glusterfs ]; then
  echo "GFSM_FUSE=$(timeout -k 2 10 sh -c 'for d in "$1"/.meta/graphs/active/"$2"-client-*; do [ -f "$d/private" ] || continue; c=$(sed -n "s/^connected *= *//p" "$d/private" | head -n 1); h=$(head -n 1 "$d/options/remote-host" 2>/dev/null); printf "%s:%s:%s," "$(basename "$d")" "$c" "$h"; done' _ "$M" "$V")"
fi
echo "GFSM_IDX=$(timeout 20 sh -c 'for d in xattrop dirty entry-changes; do ls -f "$1/.glusterfs/indices/$d" 2>/dev/null | head -n 1000003 | grep -vc -e "^\.\.\?$" -e "^xattrop-" -e "^dirty-"; done' _ "$BR" | awk '{s+=$1} END {print s+0}')"
L=/var/log/glusterfs/glusterd.log
if [ -f "$L" ]; then echo "GFSM_QLOG=$(tail -n 20000 "$L" | grep -E 'Server quorum (lost|regained)' | tail -n 1 | cut -c1-200)"; fi
for ip in $TGT; do
  ( r=""; for k in 1 2 3; do
      o=$(timeout 3 bash -c 'n() { if [ -n "$EPOCHREALTIME" ]; then echo "$EPOCHREALTIME" | tr -d .; else echo $(( $(date +%s%N) / 1000 )); fi; }; s=$(n); exec 3<>"/dev/tcp/$1/24007" && echo $(( $(n) - s ))' _ "$ip" 2>/dev/null) || o=x
      [ -n "$r" ] && r="$r,"; r="$r$o"; done; echo "GFSM_RTT=$ip|$r" ) &
done; wait
S=/var/lib/glusterfs-backup
if [ "$BK" = 1 ] && [ -d "$S" ]; then
  echo "GFSM_BK_LAST=$(sed -n 's/^\(status\|finished\|mode\)=/\1=/p' "$S/last-backup" 2>/dev/null | tr '\n' '|')msg=$(sed -n 's/^message=//p' "$S/last-backup" 2>/dev/null | head -n 1 | tr '|' '/' | cut -c1-160)"
  last=""; for r in $(ls -1 "$S"/runs/*-backup-*.result 2>/dev/null | sort -r); do
    case $(sed -n 's/^status=//p' "$r" | head -n 1) in ok|warning) last=$(sed -n 's/^finished=//p' "$r" | head -n 1); break ;; esac; done
  echo "GFSM_BK_LASTOK=$last"
  if [ -f "$S/current" ]; then echo "GFSM_BK_RUNNING=$(sed -n 's/^\(job\|started\|pid\)=/\1=/p' "$S/current" | tr '\n' '|')"; fi
fi
bs=down; [ -n "$B" ] && bs=up; gs=inactive; pgrep -x glusterd >/dev/null && gs=active
echo "summary: glusterd $gs, brick $bs, disk $(timeout 10 df -Pk "$BR" 2>/dev/null | awk 'NR==2{print $5}'), mount $FT"
echo "GFSM_END=1"
```

- Run ids sort by name (`YYYYmmddTHHMMSSZ-…`), so `sort -r` gives newest first; mtime is not relied on.
- The pinned backup node is authoritative for the `GFSM_BK_*` lines.
- A node whose `/data` is not a FUSE mount emits no `GFSM_FUSE` line (that is the `mount:` alert instead).
- If `ExecCmdByGroup` returns no `responses` at all, for example because the platform rejects the call when one group node is stopped (§18), the run falls back to `ExecCmdById` on each running node of that env.

### 5.4 Echo commands

These give Tasks-log visibility for texts computed in JS, using the base64 pattern from the memory note.

```bash
: gfs-monitor alert gfs CRITICAL run 20260926T1004Z-3f2a
echo 'R2x1c3RlckZTIGNsdXN0ZXIgImdmcyIgLi4uCg==' | base64 -d
exit 1
```

The echoed text is the base64 of the report (UTF-8, at most 6 KB before encoding), and the exit code is 1 when any alert is firing after this run, else 0. The same shape serves `: gfs-monitor status <prefix>` (exit 0), `: gfs-monitor check-now <prefix>` (exit 1 when something would alert) and `: gfs-monitor error <prefix>` (message to stderr, exit 1). The echo runs on the first running storage node of the **home** env, so it lands in that env's Tasks view. If none is running, it runs on the vantage.

### 5.5 Output contract

- Lines are `^GFSM_([A-Z_0-9]+)=(.*)$`. The last occurrence wins, except `GFSM_RTT`, `GFSM_SB` and `GFSM_OPT`, which are repeated and collected into arrays.
- Output without `GFSM_END=1` makes **that collector's checks unknown**. It is never read as healthy and never as broken.
- `contract()` from backup-task.js is extended to keep the repeated keys.

---

## 6. Parsing and the cluster model (pure JS)

- **Tokens.** `GFSM_POOL`, `GFSM_INFO` and `GFSM_HEAL` split on `|` into tokens of the form `<tag>value` (or `hostUuid="…"`).
- **Pool.**
  - `<uuid>` starts a peer; the first `<hostname>` after it is the host.
  - `<connected>` is 0/1; `<stateStr>` is the state (absent for the node itself).
  - The node itself is the entry whose host is `localhost`.
  - `opErrstr`, or `POOL_RC != 0`, makes the `pool` check unknown.
- **Info.**
  - The first `<name>` is the volume. Then come `statusStr`, `brickCount`, `distCount`, `replicaCount` and `typeStr`.
  - `<name>` containing `:/` followed by `<hostUuid>` is a brick, in volume order.
  - `<name>` followed by `<value>` is a reconfigured option.
  - An `opErrstr` containing "does not exist" means the volume is missing.
  - **R** = `replicaCount` (1 when missing). **D** = `distCount`, and must equal `brickCount / R`; if not, use `brickCount / R` and add an info note.
  - Set *k* = bricks `[kR … kR+R−1]`.
- **Heal.**
  - `hostUuid="…"` starts a brick record. Match it by `<name>`, not by uuid, because the uuid is `"-"` when the brick is down.
  - `<status>` **exactly** `Connected` means reachable. Any other text means not reachable, and the text is kept (trimmed at `totalNumberOfEntries`).
  - A non-numeric or missing count means null.
  - `GFSM_HEALTXT` (the pre-XML fallback) is parsed from the text form with the same fields.
- **Brick → peer.** Use `hostUuid` from the info output, looked up in the pool by uuid. **Brick → platform node:** the brick host IP equals a `nodes[].address` from `GetEnvInfo`. That gives the env, node id, region name and platform status.
- A **member env** is a `<prefix>-N` env with at least one brick host among its nodes. Non-member envs only produce info notes.
- **Per set:**
  - `up_k` = bricks reachable from the majority vantage.
  - `pend_k` = max heal-pending over reachable bricks; `sb_k` = max split-brain.
  - The cluster backlog is `Σ pend_k` and the split-brain count is `Σ sb_k`. "Possibly healing" entries are excluded.
- **Tolerance** (client quorum `auto`), for set *k*:
  - Odd R: `need = floor(R/2)+1`.
  - Even R: `need = R/2` when the set's first brick is up, else `R/2+1`.
  - R = 1: `need = 1`.
  - `tol_k = up_k − need`. The cluster's region-failure tolerance is `min_k tol_k`. It is valid because each region holds exactly one brick per set.
- **`GFSM_OPT`** values are `option|value`. Trim the value (the CLI pads it with spaces) and strip a trailing ` (DEFAULT)`. For example, `on (DEFAULT)` becomes `on` and `51 (DEFAULT)` becomes 51 with `explicit=false`.
- **RTT.** Each sample is the median of the successful connects, in ms (microseconds / 1000). Loss is the number of `x` out of 3. The vantage-to-region pair is `rtt:<A>-<B>` (sorted env names). A sweep adds `<node env>→<target env>`.
- **Clock skew** = `GFSM_T − tMid`, where `tMid` is the platform time at the midpoint of the ExecCmd call. The uncertainty is half the call duration.
- **Disk.**
  - `pct = round(100 × used / (used + avail))`, which is df's own capacity formula.
  - Inodes: `pct = round(100 × iused / itotal)`, skipped when `itotal` is 0.
  - `GFSM_DFGD` is used only when its mount point differs from the brick's.
- **Layout hash** = a JS string hash of `R + "|" + bricks.join(",")`. A change means Add Region, Forget Region or Add Capacity Slice happened (§7.5).

---

## 7. Checks, thresholds, defaults

### 7.1 Severity

- **CRIT:** data at risk or service impaired now.
- **WARN:** degraded, or one step from impaired.
- **INFO:** shown only in Status and the summary. It is never e-mailed and never red.

Region, node and brick alerts take their severity from **tolerance**, computed with the affected bricks counted as down:
- `min tol ≤ 0` gives **CRIT** (the next failure makes a set read-only, or it already is).
- `≥ 1` gives **WARN** (5 or 7 regions with one out).

In a 3-region cluster, any lost brick is therefore CRIT, which is correct for a replication layer.

### 7.2 Catalog

*Confirm* is the number of consecutive scheduled samples needed to fire (runs, or sweeps where noted). *Clear* is the number of clean samples needed to resolve. *Rem.* is the reminder cadence.

| Key | Source | Condition (default) | Sev | Confirm | Clear | Rem. |
|---|---|---|---|---|---|---|
| `volume` | check INFO | the volume does not exist, or `statusStr ≠ Started` | CRIT | 1 | 2 | 6 h |
| `quorum` | check HEAL + model | any set with `tol_k < 0` (writes to it fail: read-only or ENOTCONN) | CRIT | 1 | 2 | 6 h |
| `partition` | vantage loop | no answering vantage holds server quorum | CRIT | 1 | 2 | 6 h |
| `region:<env>` | platform, check, sweep | every brick node of the env is down, by the cause table §7.3 (stopped / unreachable / isolated) | tolerance | 1 with two signal families, else 2 | 2 | 6 h / 24 h |
| `node:<id>` | platform, check, sweep | node stopped, unreachable, glusterd down, or isolated (§7.3) | tolerance; glusterd down while its brick process still serves: WARN | 1 / 2 | 2 | 6 h / 24 h |
| `brick:<ip:/path>` | check HEAL + sweep | brick not reachable from the majority vantage (cause from §7.3) | tolerance | 1 when the sweep confirms the process is gone, else 2 | 2 | 6 h / 24 h |
| `peer_rejected:<uuid>` | check POOL | `stateStr` contains `Rejected` | CRIT | 1 | 2 | 6 h |
| `splitbrain` | check HEAL | `Σ sb_k > 0` | CRIT | 1 | 2 (count 0) | 6 h; a growth of at least 1 re-notifies, at most hourly |
| `heal` | check HEAL series | §7.5 | WARN → CRIT | rule | 2 zero samples | 24 h / 6 h |
| `shd:<id>` | sweep | R ≥ 2, glusterd active, no `glustershd` process on a brick node | WARN | 2 sweeps | 2 sweeps | 24 h |
| `fuse:<id>` | sweep | the node's own `<mount>` FUSE client reports `connected = 0` to a brick that the majority vantage reaches (lab fact 5) | WARN | 2 sweeps | 1 sweep | 24 h |
| `mount:<id>` | sweep | the top fstype at `<mount>` ≠ `fuse.glusterfs`, or `stat` failed or timed out | WARN | 2 sweeps | 1 sweep | 24 h |
| `disk:<brickIp>` | sweep | brick fs used ≥ **80 %** WARN, ≥ **90 %** CRIT (`diskWarn`/`diskCrit`) | per value | 1 sweep | 2 sweeps below `diskWarn − 3` | 24 h / 6 h |
| `inode:<brickIp>` | sweep | inodes used ≥ 80 / 90 % (same fields) | per value | 1 sweep | 2 sweeps below −3 | 24 h / 6 h |
| `rtt:<A>-<B>` | check + sweeps | median of the last 3 samples > **250 ms** (`rttWarnMs`), **or** > 3 × baseline and > baseline + 50 ms. The baseline is the median over the first 24 h after Configure, then fixed. | WARN | 3 samples | 3 samples | 24 h |
| `loss:<A>-<B>` | check + sweeps | at least 2 of 3 connects failed in 2 consecutive samples, while the target's peer is `Connected` and its env is not down | WARN | 2 | 3 | 24 h |
| `clock:<id>` | sweep | abs(skew) − uncertainty > **120 s** | WARN | 2 sweeps | 1 | 24 h |
| `auth` | check INFO / OPT | `auth.allow` present and ≠ `*` (it would refuse clients mounting through other regions; README Troubleshooting) | WARN | 1 | 1 | 24 h |
| `config:<opt>` | check OPT (sweep runs) | effective `cluster.quorum-type ≠ auto`; `cluster.server-quorum-type ≠ server`; `cluster.self-heal-daemon` not on/enable | WARN | 1 | 1 | 24 h |
| `even_replica` | check INFO | R even and R ≥ 2, **persisting 24 h** (Add Region from 3 to 4 is transitional) | WARN | 24 h | 1 | 7 d |
| `version_skew` | sweeps | more than one glusterfs `major.minor` among the answering nodes | WARN | 1 complete sweep | 1 | 7 d |
| `backup_stale` | backup env sweep | §7.6 | WARN | 1 (hourly) | 1 | 24 h |
| `backup_unknown` | backup env sweep | `gfsBackup` is set but the pinned node is gone or stopped, or answered no sweep 3 times in a row | WARN | 3 | 1 | 24 h |
| `backup_schedule` | `listTasks` (hourly) | `gfsBackup` is set, the scheduler is readable, and no task has script `<bkEnv>-gfs-backup` | WARN | 2 | 1 | 24 h |
| `monitor:novantage` | vantage loop | no candidate answered | CRIT | 2 | 1 | 6 h |
| `monitor:vantage` | vantage loop | the home master failed as vantage 4 runs in a row while another node answered, and no region or node alert explains it | WARN | 4 | 2 | 24 h |
| `monitor:primary` / `monitor:standby` | `listTasks` (hourly) | the trigger is missing and could not be re-created (§3.4) | WARN | 1 | 1 | 24 h |
| `unknown:<check>` | all | check (`pool`, `info`, `heal`, `sweep:<env>`, `backup`) unknown on 3 consecutive samples, and no region or node alert explains it | WARN | 3 | 1 known | 24 h |
| `monitor:error` | run | exception or state-write failure (each run also leaves a red `error` entry) | WARN | 2 | 1 | 24 h |

**One-shot notices** go into the next mail or summary; they are not alerts:
- a gap ("no check recorded between X and Y", when `now − lastRun.at > max(3×I, 45 min)`);
- the standby took over, or the primary is back;
- a layout change was detected;
- a resolved-while-paused count.

**INFO only** (Status and summary):
- op-version below max-op-version;
- the effective `network.ping-timeout` (30 at install; cluster-logic sets 10 after a redeploy);
- storage nodes that hold no brick (*"not stitched: Add Capacity Slice"*);
- `<prefix>-N` envs without bricks;
- brick ports outside 49152–49251 (§21);
- glusterfs versions;
- "no backup add-on";
- the standby env.

### 7.3 Cause classification for bricks, nodes and regions

Signals per brick-holding node *n* (host of brick *b*). The four families are the platform, exec, the gluster peer view and brick reachability, plus the sweep's local facts:
- **P:** the `GetEnvInfo` env status and node status.
- **X:** whether ExecCmd reached *n* this run (check attempt or sweep): yes, no, or not tried.
- **G:** the peer `connected` flag for *n*'s uuid, from the majority vantage.
- **B:** *b* is reachable in the majority vantage's heal summary.
- **S:** sweep facts: glusterd, brick process, self-heal daemon, own pool view `POOLV`.

A node or brick is **suspect** when B = no, or G = 0, or its env was unreachable last run. The same run then sweeps the suspect's env, so classification normally needs no extra run.

| # | Condition | Alert and cause text | Confirm |
|---|---|---|---|
| 1 | env status ≠ 1 | `region:<env>` "environment stopped (status s)". All its node and brick alerts are children. | 1 (platform is authoritative); transitional statuses: 2 |
| 2 | node status ≠ 1 | `node:<id>` "stopped in the dashboard" | 1 |
| 3 | X = no **and** B = no | `node:<id>` "unreachable: the platform cannot run commands on it and its brick does not answer". If every brick node of the env matches, it becomes `region:<env>` "unreachable". | 1 (two families) |
| 4 | X = yes, S.glusterd inactive | `node:<id>` "glusterd is not running". WARN if S.brickproc is present (existing clients are still served, new mounts and heals fail), else tolerance. | 1 |
| 5 | X = yes, glusterd active, `POOLV` minority, and G = 0 from the majority | `node:<id>` "isolated: it answers the platform but cannot reach the other regions". If the whole env matches, it becomes `region:<env>` "isolated (private GRE path between regions)". | 1 (two views) |
| 6 | X = yes, S.brickproc absent | `brick:<b>` "brick process is not running" | 1 |
| 7 | X = yes, brickproc present, glusterd active, B = no, G = 1 | `brick:<b>` "the brick runs but is not reachable from <vantage env> (data path; brick port p)" | 2 |
| 8 | B = no, no sweep data (X not tried or failed, P running) | `brick:<b>` "not reachable from <vantage env>", pending. The suspicion sweep normally resolves this to rows 3–7. | 2 |
| 9 | G = 0, B = yes | `node:<id>` "management link to glusterd lost; brick still reachable" | 2 |
| 10 | brick IP in no member env | `brick:<b>` "its node no longer exists (deleted without Forget Region?)" | 2 |

A frozen node (lab fact 7) keeps G = 1 and TCP connects working, but gives B = no and usually X = no or a timeout. It lands on row 3 or row 8. That is why B, not G, drives the classification.

### 7.4 Root-cause grouping

A child is tracked but never notifies on its own. It is listed under its parent as *Also affected*. If it outlives its parent, it becomes independent and is notified as NEW ("still open after <parent> recovered").

- `volume` ⊃ everything on the data path.
- `quorum` ⊃ `region:*`, `node:*`, `brick:*`, `heal`.
- `partition` ⊃ `region:*` (isolated), `loss:*`, `rtt:*`.
- `region:<e>` ⊃ its `node:*`, `brick:*`, `shd:*`, `fuse:*`, `mount:*`, `clock:*`, `disk:*`/`inode:*` unknown-freezes, `rtt:*`/`loss:*` involving *e*, `heal`, `backup_*` when the backup env is *e*, and `fuse:*` elsewhere that points at *e*'s bricks.
- `node:<n>` ⊃ its `brick:*`, `shd:*`, `mount:*`, `fuse:*`, `heal`, and `fuse:*` elsewhere pointing at *n*'s brick.
- `brick:<b>` ⊃ `heal`, and `fuse:*` pointing at *b*.
- `splitbrain`, `peer_rejected` and `auth` are **never** children.

### 7.5 Heal backlog rules

- The series is `state.heal.series`: one `[t, backlog]` per run, the last 25 samples (6 h). `nonZeroSince` resets on a *known* zero sample; unknown samples neither reset nor extend it.
- `draining(Δ)` holds when `backlog_now ≤ 0.95 × backlog(t−Δ)`.
- **Normal:** WARN when `now − nonZeroSince ≥ healWarnMin` (**60 min**) and `!draining(60 min)`. CRIT when `now − nonZeroSince ≥ 24 h`.
- **Relaxed window:** for 24 h after a layout-hash change, and for 6 h after any `region`/`node`/`brick`/`quorum` alert resolves, WARN needs `≥ 6 h` and `!draining(6 h)`. CRIT still applies at 24 h, except inside a layout window.
- **Child:** while any parent from §7.4 is firing, `heal` is a child. The parent's text carries "N entries queued for healing".
- **Unknown:**
  - The heal query failed on the majority vantage, or timed out at 120 s.
  - If sweeps supply `GFSM_IDX`, Status shows "about N entries (index count, approximate)". Alerts are never fired from index counts.
  - 3 unknown samples raise `unknown:heal`.
- Thresholds above 10 min are required: the lab saw a healthy cluster hold a backlog for most of `cluster.heal-timeout` (600 s) after a brick restart.
- **ETA** for texts: `rate = (backlog(t−60) − now) / 60 min`. If `rate > 0`, `eta = now / rate`.

### 7.6 Backup freshness (read-only)

- **Discovery**, hourly: the sibling env whose storage node group has a non-empty `gfsBackup` (parsed like backup `loadConfig`). With none, there are no backup checks and Status shows the INFO line "no backup add-on".
- **Expected period P:** simulate `gfsBackup.crons` (or `[gfsBackup.cron]`) as UTC 5-field cron lines over the next 8 days, minute by minute. Standard semantics apply: lists, ranges, steps, names, DOW 0/7 = Sunday, and DOM OR DOW when both are restricted. P is the largest gap between consecutive fires, and at least 5 min.
- **Max age** = `backupMaxAgeHours` when it is greater than 0, else `max(3 h, 2P + 1 h)`. That is 3 h for hourly, 49 h for daily and about 14 d for weekly. A custom schedule's DST twin triggers only make P smaller, which is safe.
- **Last OK** = `GFSM_BK_LASTOK` from the pinned node. If it is empty, measure from `gfsBackup.updated` (its ISO prefix before the last `-`).
- **`backup_stale`:** fires when `now − lastOk > maxAge`, **unless** `GFSM_BK_RUNNING` shows `job=backup` started less than 24 h ago. That allows a long first backup; the backup runner itself fails loudly after a 24 h stall. The text includes `GFSM_BK_LAST` (status, finished and a trimmed message).
- The monitor alerts only on **staleness**. The backup add-on already e-mails each failed run, so no failure is e-mailed twice.

---

## 8. Alert state machine and notifications

### 8.1 Record

```js
alerts[key] = { sev, st: "pending"|"firing", check, first, last, seen, clear, unk,
                firedAt, notifiedSev, notifiedAt, fires: [t...], flap, parent, msg, impact, doText }
```

### 8.2 Per-run update

```
for each observation o (key, sev, check, msg, impact, doText, parent):
    a = alerts[o.key] || {st:"pending", first: now, seen: 0}
    a.seen++; a.clear = 0; a.last = now; copy fields from o
    if a.st == "pending" and confirmed(a): a.st = "firing"; a.firedAt = now; a.fires.push(now)
for each alert a not observed this run:
    if a.check is unknown this run: a.unk++                               // frozen: never resolves while blind
    else if a.st == "pending": delete                                    // unconfirmed blip: silent
    else: a.clear++; if a.clear >= clearFor(a) (flap: 60 min clean): resolved.push(a); delete
flap: when a.fires has >= 3 entries within 2 h: a.flap = true (one FLAPPING notice)
unknown streaks: state.unknown[check] = known ? 0 : +1, which produces unknown:<check> observations
caps: at most 60 alert keys (the rest fold into "more:<prefix>" with a count); msg at most 240 chars
```

Monitor alerts follow the same rules. `monitor:novantage` freezes every gluster check.

### 8.3 Events

- **NEW:** firing, no `notifiedSev`, and `parent` null.
- **ESCALATED:** firing and `rank(sev) > rank(notifiedSev)`. It goes out immediately. A de-escalation is not mailed; it shows in the next mail as "now WARNING".
- **GREW:** split-brain count ≥ the notified count + 1, and at least 1 h since the last GREW.
- **RESOLVED:** resolved this run and `notifiedSev` set. An alert that was never mailed resolves silently. It is also silent for a flapping key until stable for 2 h.
- **REMINDER:** firing and `now − notifiedAt ≥ remind(sev, key)` (critical 6 h, warning 24 h, structural 7 d). When any reminder is due, the mail lists **all** open alerts and resets every `notifiedAt`, which aligns the cadences.
- **NOTICE:** the one-shots of §7.2.

### 8.4 Mail plan (at most one mail per run)

- **Order:** NEW/ESCALATED/GREW critical, then NEW/ESCALATED warning, then RESOLVED, then REMINDER, then notices.
- **Subject** from the highest item (§12.1).
- **Daily cap:** 12 non-critical mails per UTC day. Beyond that, events are folded, counted and listed in the next allowed mail or the summary. NEW/ESCALATED critical is always sent.
- **Pause** (`cfg.pauseUntil > now`):
  - No PROBLEM, RESOLVED or REMINDER mail. The alert Tasks entries and state continue.
  - After expiry, the first run sends **"E-mails resumed"**. It lists every open alert, including those that fired during the pause (which are then marked notified), and the number resolved while paused.
  - The summary is still sent while paused.
- **`notify = false`:** no mail except Send Test E-mail. Tasks entries, Status and state continue.
- **Summary:** due when the slot has passed (weekly, Monday 07:00 UTC; or daily at 07:00 UTC) and `mail.summaryAt < slot`.
  - The **first scheduled run after a fresh install** sends "Monitoring is active" (because `summaryAt` is 0). This proves the mail path.
  - It merges with an alert mail when both are due.

### 8.5 Delivery: at least once

1. The commit (§3.2 step 10) stores `mail.pending = {id, subject, body, events}` and marks the events as notified (`notifiedSev`/`notifiedAt`), in the same write.
2. Write the **alert Tasks entry** (§5.4) for the events, **even when paused, off or capped**. The dashboard channel does not depend on e-mail.
3. `Send(appid, signature || session, null, user.email, user.email, subject, body)`, the call from backup `notifyFailure`.
4. On `result 0`: a second small write sets `mail.pending = null`, `mail.lastAt = now`, `sentToday++`.
5. On failure: set `mail.lastError`. The next run sends `mail.pending` first, merged with its own events.
6. Mails older than 24 h in `pending` are dropped with a note in Status.

---

## 9. Scheduling, cost and noise

- **Check interval** `intervalMin` ∈ {5, 10, **15**, 30, 60}.
- **Sweep interval** `sweepMin` ∈ {30, **60**, 180, 360}. Sweeps happen inside check runs, so there is no second trigger.
- **Offset:**
  - `h = 0; for each char: h = (h × 31 + charCode) % 1000003` over the prefix.
  - `offsetMin = 1 + h % (I − 1)` for I ≥ 2 (0 for I = 1); this avoids :00, where hourly backups start.
  - `offsetSec = floor(h / 7) % 60`.
- **Primary trigger:** `cron:<offsetSec> <m1,m2,…> * * * ? *` with minutes `offsetMin + k×I < 60`.
- **Standby trigger:** the same with every minute `+ floor(I/2)` mod 60.
- **Description:** `GlusterFS monitor of <prefix> (primary|standby, every I min)`.
- Triggers are replaced "new first, then remove old", with backup's `replaceTasks`.
- Weekly and daily summaries, backup checks and trigger self-repair run inside check runs.

**Tasks-log entries per day** at the defaults, steady state:

| Regions | Check | Sweeps | Total | At 30 min / 180 min |
|---|---|---|---|---|
| 3 | 96 | 72 | **168** | 48 + 24 = 72 |
| 5 | 96 | 120 | 216 | 48 + 40 = 88 |
| 7 | 96 | 168 | 264 | 48 + 56 = 104 |

During an incident, add up to one suspicion sweep per run for each affected region, plus one alert entry per mail-worthy event.

**API calls per run:**
- GetNodeGroups: 1 (2 with a standby copy).
- GetEnvs: 1.
- GetEnvInfo: one per sibling.
- ExecCmdById: 1 to 3.
- ApplyNodeGroupData: 1, plus 1 after a mail.
- Hourly: plus one GetNodeGroups per sibling, GetTasks for 2 or 3 appids, and one ExecCmdByGroup per region.
- A standby that stays idle costs 2 or 3 read calls.

**State writes:** every run by default, because the standby gate needs a fresh `lastRun.at`. If the live test shows that `ApplyNodeGroupData` creates Tasks entries, switch the constant `STATE_WRITE = "change+hourly"`. The standby threshold then becomes `75 min + 2×I` (§18).

**Gluster and node load:**
- **Zero cluster-lock transactions.**
- One short-lived gfapi client (glfsheal) per run, which connects to every brick (the same as `heal info` from a shell).
- `pool list`/`volume info` are local reads.
- 3 TCP connects per other region per run.
- A sweep costs a few `df`/`pgrep`/`stat`/`sed`, bounded `ls` of three index directories, and the `.meta` reads.

**E-mail:** zero while healthy, except the weekly summary. One mail per incident transition, plus 6 h critical reminders, plus RESOLVED.

---

## 10. Data (storage node group of the home env; per-key JSON strings)

### 10.1 `gfsMonitor` (config)

```json
{"v":1,"envName":"gfs-1","prefix":"gfs","standbyEnv":"gfs-2",
 "volume":"data","mountPath":"/data","brickPath":"/glustervolume",
 "intervalMin":15,"sweepMin":60,"offsetMin":7,"offsetSec":41,
 "notify":true,"summary":"weekly","reminderCritH":6,"reminderWarnH":24,
 "diskWarn":80,"diskCrit":90,"healWarnMin":60,"rttWarnMs":250,"backupMaxAgeHours":0,
 "heartbeatUrl":"","pauseUntil":0,"pauseBy":"",
 "basePath":"https://raw.githubusercontent.com/stackharbor-devops/glusterfs-multi-region/main",
 "taskScriptSha":"<64 hex>","createdAt":"2026-09-26T10:00:00Z","updated":"2026-09-26T10:00:00.000Z-123456"}
```

**Volume and mount resolution** at Install and Configure is read-only, in this order:
1. the install settings (`volumeName`, `mountPath` passed by the manifest);
2. the parsed `globals` of `<prefix>-1` (`volumeName`, `replicatedPath`);
3. the native-fuse `cluster.settings.replicatedVolume`/`replicatedPath` on any sibling;
4. live detection in the `prepare` job (`gluster volume list` plus `findmnt`, the loadClusterGlobals logic **without its write-back** to `globals`).

### 10.2 `gfsMonitorState` (runtime; target at most 16 KB, hard cap 32 KB)

```json
{"v":1,"rev":1841,"savedAt":0,"by":"primary",
 "lastRun":{"at":0,"ms":8200,"runId":"20260926T1004Z-3f2a","result":"ok|problem|blind",
            "vantage":{"env":"gfs-1","node":"12345","region":"Amsterdam"},"tried":1},
 "stats":{"weekStart":0,"done":0,"gaps":[[0,0]],"fired":{"region":1}},
 "alerts":{"region:gfs-3":{"sev":"crit","st":"firing","check":"region","first":0,"last":0,"seen":3,"clear":0,"unk":0,
            "firedAt":0,"notifiedSev":"crit","notifiedAt":0,"fires":[0],"flap":false,"parent":null,
            "msg":"...","impact":"...","doText":"..."}},
 "unknown":{"heal":0,"sweep:gfs-2":0},
 "sweep":{"at":0,"envs":{"gfs-2":{"at":0,"ok":true}}},
 "unreach":{"67890":0},
 "heal":{"series":[[0,0]],"nonZeroSince":0,"notifiedSb":0,"grewAt":0},
 "rtt":{"learnUntil":0,"base":{"gfs-1-gfs-2":18},"recent":{"gfs-1-gfs-2":[18,19,21]}},
 "disk":{"10.1.2.5":{"pct":41,"kb":0,"at":0,"wk":[0,0]}},
 "topo":{"layout":"<hash>","replica":3,"sets":1,"changedAt":0,"recoveryUntil":0},
 "backup":{"env":"gfs-2","node":"456","lastOk":0,"checkedAt":0,"tasksAt":0},
 "triggers":{"checkedAt":0,"repairAt":0},
 "mail":{"pending":null,"lastAt":0,"summaryAt":0,"day":"2026-09-26","sentToday":0,"folded":0,
         "lastError":"","errorMailAt":0,"pausedResolved":0},
 "notes":[[0,"vantage failover gfs-1 -> gfs-2"]],
 "setup":{"summary":"","error":""}}
```

**Size control:** at most 60 alerts, 25 heal samples, 20 notes and 20 gaps. `disk` holds one entry per brick, with `wk` the snapshot at the last weekly summary (for the 7-day growth line).

**Keys read, never written:**
- `globals` (volume hint);
- `cluster` (native-fuse hint);
- `gfsBackup` on any sibling.

**Keys written:** only `gfsMonitor` and `gfsMonitorState`, the latter on home and, as a fallback, on the standby env.

---

## 11. Card UI (`addons/monitor.jps`)

```yaml
type: update
jpsVersion: 6.1.1
version: 1.0
id: glusterfs-monitor
name: GlusterFS Monitor
targetEditions: any
baseUrl: https://raw.githubusercontent.com/stackharbor-devops/glusterfs-multi-region/main
description:
  short: Health checks and e-mail alerts for the multi-region GlusterFS cluster.
  text: |
    Checks every region of the cluster on the platform schedule: peers, bricks, heal backlog,
    split-brain, write quorum, brick disk and inodes, GRE latency between regions, and backup
    freshness. Every check appears in the Tasks log; problems are e-mailed to the environment
    owner, with a reminder while they last and a notice when they clear. Read-only: it installs
    nothing on the nodes and never changes the volume. Uninstalling leaves the cluster untouched.
targetNodes: {nodeGroup: storage, nodeType: [storage]}
globals:
  base_path: ${baseUrl}
  monitorReport: ""
  strict: ${settings.strict:true}
onBeforeInit: scripts/monitor/settings-form.js
settings:
  main:
    submitUnchanged: true            # Save re-deploys script + triggers even when nothing changed
    onBeforeInit: scripts/monitor/settings-form.js
    fields:
      - {type: displayfield, hideLabel: true, cls: info, height: 50,
         markup: "Checks run on the platform schedule (UTC) from one storage node, plus an hourly pass over every region. Every check is an entry in the Tasks log; problems are e-mailed to the environment owner."}
      - {type: list, name: intervalMin, caption: Check every, editable: false, default: "15",
         values: [{value: "5", caption: 5 minutes}, {value: "10", caption: 10 minutes}, {value: "15", caption: 15 minutes},
                  {value: "30", caption: 30 minutes}, {value: "60", caption: 1 hour}]}
      - {type: toggle, name: notify, caption: E-mail alerts to the environment owner, value: true}
      - {type: list, name: summary, caption: Summary e-mail, editable: false, default: weekly,
         values: [{value: weekly, caption: "Weekly (Monday 07:00 UTC)"}, {value: daily, caption: "Daily (07:00 UTC)"}, {value: "off", caption: "Off"}]}
      - type: checkbox
        name: advanced
        caption: Advanced settings
        value: false
        showIf:
          "true":
            - {type: list, name: sweepMin, caption: Check every node every, editable: false, default: "60",
               values: [{value: "30", caption: 30 minutes}, {value: "60", caption: 1 hour}, {value: "180", caption: 3 hours}, {value: "360", caption: 6 hours}]}
            - {type: spinner, name: diskWarn, caption: "Disk/inode warning, %", min: 50, max: 98, default: 80}
            - {type: spinner, name: diskCrit, caption: "Disk/inode critical, %", min: 55, max: 99, default: 90}
            - {type: spinner, name: healWarnMin, caption: "Heal backlog alert after, min", min: 15, max: 1440, default: 60}
            - {type: spinner, name: rttWarnMs, caption: "Inter-region RTT warning, ms", min: 20, max: 5000, default: 250}
            - {type: spinner, name: backupMaxAgeHours, caption: "Backup max age, h (0 = from its schedule)", min: 0, max: 720, default: 0}
            - {type: list, name: reminderCritH, caption: Repeat critical alerts every, editable: false, default: "6",
               values: [{value: "1", caption: 1 hour}, {value: "2", caption: 2 hours}, {value: "6", caption: 6 hours}, {value: "12", caption: 12 hours}, {value: "24", caption: 24 hours}]}
            - {type: list, name: reminderWarnH, caption: Repeat warnings every, editable: false, default: "24",
               values: [{value: "24", caption: 24 hours}, {value: "72", caption: 3 days}, {value: "168", caption: 7 days}, {value: "0", caption: Never}]}
            - {type: string, name: heartbeatUrl, caption: Heartbeat URL (optional), default: "",
               regex: "^(https?://[^\\s'\"<>]+)?$", regexText: "An http(s) URL, or empty.",
               tooltip: "Called after every completed check, for an external dead-man service (e.g. healthchecks.io). {status} becomes up or down."}
  pause:
    submitUnchanged: true            # the pre-selected default must be submittable
    onBeforeInit: |                  # inline; shows the current state
      var r = jelastic.env.control.GetNodeGroups("${env.envName}", session), c = null, i, t = "E-mails are not paused.";
      for (i = 0; r && r.result == 0 && i < r.object.length; i++) if (String(r.object[i].name) == "storage" && r.object[i].gfsMonitor) { try { c = JSON.parse(String(r.object[i].gfsMonitor)); } catch (e) {} }
      if (c && c.pauseUntil > new Date().getTime()) t = "E-mails are paused until " + new Date(c.pauseUntil).toISOString().replace("T", " ").substring(0, 16) + " UTC.";
      settings.fields.unshift({ type: "displayfield", hideLabel: true, cls: "info", height: 30, markup: t + " Checks and Tasks entries always continue." });
      return settings;
    fields:
      - {type: list, name: pauseHours, caption: Pause e-mails for, editable: false, default: "4",
         values: [{value: "1", caption: 1 hour}, {value: "4", caption: 4 hours}, {value: "24", caption: 24 hours},
                  {value: "72", caption: 3 days}, {value: "168", caption: 7 days}, {value: "0", caption: Resume now}]}
buttons:
  - {caption: Check Now, action: checkNow, loadingText: Checking every region...,
     confirmText: "Check the whole cluster now? This only reads: no e-mail is sent and no alert changes.",
     successText: "Check finished. The report is in the Tasks log."}
  - {caption: Configure, action: configure, settings: main, submitButtonText: Save,
     loadingText: Checking every region and saving...,
     successText: Monitoring settings saved and the schedule updated.}
menu:
  - {caption: Status, action: status, confirmText: Show the monitoring status of this cluster?, loadingText: Reading...}
  - {caption: Pause E-mails, action: pause, settings: pause, title: Pause E-mails, submitButtonText: Apply,
     successText: "Done. Checks and Tasks entries continue; only e-mails are affected."}
  - {caption: Test E-mail, action: testMail, confirmText: Send a test e-mail to the environment owner?,
     successText: Test e-mail sent to the environment owner.}
onInstall: [{manage: {op: apply, phase: install}}]
onUninstall: <inline script, §15.5>
onBeforeDelete: <inline script, §15.6>
onAfterConfirmTransfer: [{manage: {op: transfer}}]
actions:
  manage:
    - script: ${globals.base_path}/scripts/monitor/manage.js?_r=${fn.random}
      params:
        op: ${this.op}
        phase: ${this.phase}
        job: ${this.job}
        envName: ${env.envName}
        envAppid: ${env.appid}
        basePath: ${globals.base_path}
        strict: ${globals.strict}
        volumeName: ${settings.volumeName}
        mountPath: ${settings.mountPath}
        intervalMin: ${settings.intervalMin}
        notify: ${settings.notify}
        summary: ${settings.summary}
        advanced: ${settings.advanced}
        sweepMin: ${settings.sweepMin}
        diskWarn: ${settings.diskWarn}
        diskCrit: ${settings.diskCrit}
        healWarnMin: ${settings.healWarnMin}
        rttWarnMs: ${settings.rttWarnMs}
        backupMaxAgeHours: ${settings.backupMaxAgeHours}
        reminderCritH: ${settings.reminderCritH}
        reminderWarnH: ${settings.reminderWarnH}
        heartbeatUrl: ${settings.heartbeatUrl}
        pauseHours: ${settings.pauseHours}
  configure: [{manage: {op: apply, phase: configure}}]
  checkNow:  [{manage: {op: run, job: check}}]
  status:    [{manage: {op: run, job: status}}]
  testMail:  [{manage: {op: run, job: testmail}}]
  pause:     [{manage: {op: pause}}]
success: |
  **GlusterFS monitoring is on.**

  ${globals.monitorReport}

  The card on the storage layer has **Check Now** and **Configure**; its menu has **Status**, **Pause E-mails**, **Test E-mail** and **Uninstall**.
```

**Form notes.** Each follows a memory note:
- `submitUnchanged` goes on the forms.
- List values use the array form.
- `markup` is plain text.
- Actions use `${globals.base_path}`.
- Fields hidden by showIf are **not submitted**. `manage.js` therefore treats an empty or unresolved `${settings.x}` as "keep the current value" (`P.x || existing.x || default`), the backup pattern. `settings-form.js` pre-fills the advanced fields from `gfsMonitor`, so opening them shows the values in force.
- Server-side validation: `diskWarn < diskCrit`, and every value within its list or range. Otherwise `fail("…")`, and nothing changes.

**Button responses** are custom responses from the task script, passed through by `manage.js`:

| Button | Returns |
|---|---|
| **Check Now** | `{result:"info", type:"info", message}` when nothing would alert, else `{result:"warning", type:"warning", message}`. Also writes a `check-now` echo entry (exit 1 when something would alert). `{result:99, type:"error"}` only when no node could be checked. It performs the check, sweeps every region (`FULL=1`), evaluates against a **copy** of the state, and never writes state or mails. |
| **Configure** | On warnings, a `warning` popup, because on result 0 the dashboard shows only the static successText. A failure leaves the previous config and triggers in force, and says so. |
| **Status** | An `info` popup (§13.3). The same text is also echoed to the Tasks log, because info popups are unverified (§18). No exec except that echo. |
| **Pause E-mails** | Writes `pauseUntil`/`pauseBy` into `gfsMonitor` with read-back, then returns `info`, e.g. "E-mails paused until 14:05 UTC". |
| **Test E-mail** | Calls `Send`. Returns `info` with the address and Send result, or an error with the API error. The recipient is `user.email`; if `user` is undefined in Eval context, it falls back to `jelastic.users.account.GetUserInfo(appid, session).email` (§18). |

Popup texts use `"  \n"` line breaks, as in backup's `jobStatus`.

---

## 12. E-mail

Plain text, with lines of at most 78 characters, UTC times and no emoji. It is sent with `jelastic.message.email.Send(appid, signature || session, null, user.email, user.email, subject, body)`. If the live test shows line breaks collapsed, set `MAIL_HTML = true`, which wraps the body in `<pre>` (§18).

### 12.1 Subjects (prefix `[GlusterFS <prefix>]`)

| Event | Subject |
|---|---|
| New or escalated | `CRITICAL: region gfs-3 (Warsaw) unreachable (+1 more)`, `WARNING: brick disk 83% on 10.1.2.5 (gfs-2)` |
| Resolved | `RESOLVED: all problems cleared (region gfs-3 back after 1 h 12 min)` or `RESOLVED 1, still open 1: brick disk 83% on 10.1.2.5` |
| Reminder | `STILL CRITICAL (6 h): region gfs-3 (Warsaw) unreachable` |
| Summary | `Weekly summary: healthy, 672/672 checks` or `Weekly summary: 1 open problem, 668/672 checks` |
| First run | `Monitoring is active` |
| Pause ended | `E-mails resumed: 1 open problem` or `E-mails resumed: all clear` |
| Monitor | `Monitor problem: checks are not running correctly` (at most one per 24 h) |
| Test | `Test e-mail` |

### 12.2 Body skeleton

```
GlusterFS cluster "gfs" - volume data (1 x 3), regions gfs-1 (Amsterdam), gfs-2 (Frankfurt), gfs-3 (Warsaw)
Checked 2026-09-26 10:04 UTC from node 12345 in gfs-1.

NEW
  [CRITICAL] Region gfs-3 (Warsaw) is unreachable - since 09:49 UTC
    The platform cannot run commands on its node 67890 and its brick
    10.1.3.4:/glustervolume does not answer from gfs-1.
    Impact: writes continue on 2 of 3 regions. ONE more region failure makes
    the volume read-only. 1,284 changes are queued for gfs-3 and heal
    automatically when it is back.
    Also affected: brick 10.1.3.4:/glustervolume; heal backlog 1,284.
    Do: check gfs-3 and the region's status in the dashboard / with your
    hoster. If the region is lost for good: Forget Region, then Add Region
    to return to an odd number of regions (README).
STILL OPEN
  [WARNING] Brick disk 83% on 10.1.2.5 (gfs-2) - since Sep 25 09:30
RESOLVED
  (none)

Cluster now
  Region      Env    Nodes Bricks Disk max Inodes RTT from gfs-1
  Amsterdam   gfs-1  1/1   1/1    41%      3%     -
  Frankfurt   gfs-2  1/1   1/1    83%      5%     21 ms
  Warsaw      gfs-3  0/1   0/1    -        -      timeout
  Heal: 1,284 pending, 0 split-brain. Backups: last OK 10:00 UTC (max age 3 h).

Next reminder 16:04 UTC while this stays critical; you get a RESOLVED e-mail
when it clears. Pause e-mails: gfs-1 -> storage -> Add-Ons -> GlusterFS
Monitor -> menu -> Pause E-mails. Details: Tasks log, "gfs-monitor" entries.
--
gfs-monitor: cluster=gfs home=gfs-1 state=CRITICAL open=2 run=20260926T1004Z-3f2a
A weekly summary arrives every Monday; if it stops arriving, monitoring has stopped.
```

A **RESOLVED** entry adds a heal outlook, for example: *"Region gfs-3 is back after 1 h 12 min. 45,120 entries are healing at about 1,200/min, done in about 38 min at this rate. You will hear again only if healing stalls."*

**Split-brain** lists up to 10 entries, with this text:

*Resolve per file with `gluster volume heal data split-brain latest-mtime <path>` (or `bigger-file <path>`, or `source-brick <ip>:/glustervolume <path>`). This discards the other copy; take a backup first (GlusterFS Backup/Restore). Paths can be run from Manage Cluster → Custom CLI command. `<gfid:…>` entries contain `<` and `>`, which that form blocks, so use Web SSH on a storage node. Do not use latest-mtime while a clock alert is open.*

### 12.3 *Impact* and *Do* runbook

These are built into the pure block and unit-tested.

| Alert / cause | Do |
|---|---|
| `region` stopped | Start `<env>` in the dashboard. If the region is lost: Forget Region, then Add Region. |
| `region` unreachable | Check the region with the hoster. The monitor keeps checking; healing starts on its own when it returns. |
| `region` isolated | The platform reaches it but the other regions do not. Check the private GRE path and the storage firewalls (inbound TCP 24007–24008 and 49152–49251 in **every** region). Apps mounting through it get errors; other regions continue. |
| `node` stopped / unreachable | Start or restart the node. Cluster-logic's redeploy hook restarts glusterd and remounts. |
| `node` glusterd down | Restart the node, or Web SSH: `systemctl start glusterd`. |
| `brick` process not running, `shd` | Manage Cluster → Custom CLI command: `gluster volume start data force`. It starts only what is down. |
| `brick` runs but unreachable | Data path from `<vantage env>` to port p. Check the storage firewall and the GRE path. The brick port p is shown, with a note when it is outside 49152–49251 (§21). |
| `brick` node gone | The volume still lists a brick of a deleted node. See README "Add Region stopped …": `gluster volume remove-brick data replica <R-1> <ip>:/glustervolume force`, then Add Region. |
| `quorum` | Restore the missing regions or bricks (see the other alerts). Do not disable quorum. |
| `heal` | First check the other alerts; a missing brick keeps the backlog growing. If every brick is up: Manage Cluster → Heal volume - full. After Add Region or Add Capacity Slice, this is expected while data copies. |
| `fuse` | On that node (Web SSH): `umount -l /data; ls /data`. The automount remounts. App environments that mounted through this region may hold the same stale link, so remount them too (restart the app node, or re-mount in Volumes). |
| `mount` | Same remount, or restart the node. Only this node's local writers and backups (if it is the backup node) are affected. |
| `disk` / `inode` | Free space, or grow **every** region equally (larger storage disk, or scale every region by one node and run Add Capacity Slice). When a brick of a set is full, writes to that set fail in every region. `/var/log/glusterfs` shares the disk. |
| `rtt` / `loss` | GRE path load or a firewall change. Every write waits for the slowest region; `network.ping-timeout` is 30 s. |
| `clock` | Check time sync on the node (restart it, or ask the hoster). |
| `auth` | Manage Cluster → Custom: `gluster volume set data auth.allow '*'` (README Troubleshooting). |
| `config:*` | Manage Cluster → Custom: `gluster volume set data cluster.quorum-type auto` / `cluster.server-quorum-type server` / `cluster.self-heal-daemon on`. |
| `peer_rejected` | The node's `/var/lib/glusterd` no longer matches the pool (for example after a migration). Follow GlusterFS "Resolving Peer Rejected" on that node; do not remove its brick. |
| `even_replica` | Add Region or Forget Region to return to an odd number of regions. |
| `version_skew` | Redeploy every storage layer to the same image tag. |
| `backup_*` | GlusterFS Backup/Restore card → Backup Status. Configure → Save moves backups to a running node or re-creates the schedule. |
| `monitor:*`, `unknown:*` | Monitor card → Status. Configure → Save re-creates the script and triggers. |

### 12.4 Weekly summary (also sent daily if chosen)

The weekly summary contains:
- the period;
- **checks recorded vs expected**, and the gaps with times;
- open alerts;
- alerts fired this period, by type, with total open time;
- a per-region table: nodes, bricks, disk % now and 7-day change, inode %, median and max RTT to other regions;
- the maximum heal backlog and split-brain count in the period;
- backups: last OK and max age;
- glusterfs versions and op-version;
- INFO items (unstitched nodes, envs without bricks, brick ports);
- the configuration (interval, sweep, e-mail, paused, standby env, heartbeat configured yes/no).

---

## 13. Dashboard surfacing

### 13.1 Tasks log

| When | Entry (API) | Colour |
|---|---|---|
| Every run | `Executing command in <vantage env> (node…)`, which expands to `: gfs-monitor check …`, the `summary:` line and the GFSM lines | green (collectors exit 0) |
| Hourly, plus suspicion sweeps | one per region env, `: gfs-monitor sweep …`, with a `summary:` line per node | green |
| Every mail-worthy event (NEW, ESCALATED, GREW, RESOLVED, REMINDER), also when paused, off or capped | `: gfs-monitor alert …` holding the full report of §12.2 | **red** while anything is firing; green when all is clear |
| Check Now | `: gfs-monitor check-now …` holding the evaluated report | red if something would alert |
| Status | `: gfs-monitor status …` | green |
| A run that failed | `: gfs-monitor error …` (visibleFailure) | red |

### 13.2 Why the per-run check entry stays green

It is not yet known whether ExecCmd returns stdout on a non-zero exit (§18). If the live test confirms it does, flip the constant `CHECK_EXIT_ON_PROBLEM = true`. The check collector then exits 1 whenever it sees a raw problem: a peer with `connected=0`, a brick not `Connected`, split-brain greater than 0, the volume not Started, or the heal query failing. That turns every check red while a problem is visible, and the evaluator is unchanged.

### 13.3 Status text (example)

```
GlusterFS gfs - volume data 1 x 3 - 3 regions - WARNING (1 open)
Last check 10:04 UTC (6 min ago) from node 12345 (gfs-1, Amsterdam); next about 10:22 UTC
Schedule: every 15 min at :07/:22/:37/:52 +41 s UTC (primary on gfs-1, standby on gfs-2 - both present)
Open:    WARNING brick disk 83% on 10.1.2.5 (gfs-2) - since Sep 25 09:30, e-mailed Sep 26 09:30
Pending: rtt gfs-1-gfs-3 312 ms (1 of 3 samples)
Regions: Amsterdam gfs-1 1/1 nodes, 1/1 bricks, disk 41%, inodes 3%
         Frankfurt gfs-2 1/1 nodes, 1/1 bricks, disk 83%, inodes 5%, RTT 21 ms
         Warsaw    gfs-3 1/1 nodes, 1/1 bricks, disk 44%, inodes 4%, RTT 55 ms
Heal: 0 pending, 0 split-brain. Quorum: tolerates 1 more region failure.
Backups: gfs-2 node 456, last OK 10:00 UTC, max age 3 h (hourly).
E-mail: on (owner); summary weekly (last Mon 07:04); paused: no; last error: none
Info: glusterfs 11.1 on every node; op-version 110000/110000; ping-timeout 30
This week: 312/312 checks recorded, 0 gaps.
Monitor: task script sha 1a2b3c4d... (Configure -> Save installs the current version)
```

**STALE banner.** Status leads with `MONITOR NOT RUNNING: last recorded check 2 h 14 min ago` when `now − lastRun.at > 2×I + 10 min`. When `listTasks` shows no primary trigger or `GetScript` finds no script, it says "… - Configure -> Save".

**Setup failed.** After a failed non-strict setup, Status says `Monitoring is NOT active: <setup.error> - Configure -> Save`.

### 13.4 visibleFailure

Copied from backup. It handles an exception, an unreadable config, or a failed state write:
1. A red `: gfs-monitor error` entry via `ExecCmdById` on the first running home storage node, else on any member env.
2. A "Monitor problem" mail at most once per 24 h.
3. The run returns.

---

## 14. Multi-region placement, failures and the dead-man

### 14.1 Which instance reports what

| Case | Gluster view | Monitor behaviour | Reported by, detection time |
|---|---|---|---|
| One region's hardware down (3 regions) | its peers disconnected, bricks unreachable; sets keep quorum | exec fails (X = no) and B = no, so `region` unreachable, CRIT (tol 0), in **1 run** | the single evaluator (platform), with the vantage in a surviving region; ≤ 15 min |
| Region env stopped by a user or billing | as above | platform status, so `region` stopped in 1 run | ≤ 15 min |
| The home region down (`<prefix>-1`) | as above | the vantage fails over to `-2`/`-3`. If the scheduler still fires the primary: ≤ 15 min. If not, the standby acts after 2×I + 10 min. | primary, or standby with a notice; ≤ 15 or ≤ 55 min |
| A region cut off over GRE (control path fine) | minority side loses server quorum and stops its bricks | majority vantage, plus the suspicion sweep of the isolated env (`POOLV` minority, quorum log): `region` isolated | 1 run |
| Partial mesh (B↔C cut, A sees both) | vantage A: all Connected | sweep mesh RTT/loss B→C: `loss:gfs-2-gfs-3`; heal backlog may grow | ≤ 1 h (next sweep) |
| Two of three regions down | every set below quorum | `quorum` CRIT in 1 run, parent of both regions | ≤ 15 min |
| Every region isolated from the others | no vantage has quorum | `partition` CRIT | ≤ 15 min |
| A node frozen or hung | peer still "Connected", TCP OK (lab) | B = no, and X = no or a timeout, so `node` unreachable | 1–2 runs |
| Brick process crashed | peer Connected | B = no, and the sweep shows no process, so `brick` process not running | 1 run |
| Stale client link after a brick restart | all "Connected" to new clients | sweep `.meta connected=0`, so `fuse:<id>`; heal backlog if writes go through it | ≤ 2 sweeps |
| Platform cannot exec in a region, gluster fine | – | `unknown:sweep:<env>` / `monitor:vantage`; the gluster view is still correct | 3 samples |
| Platform core or scheduler down | – | nothing runs | missing weekly summary, external heartbeat, STALE Status |

### 14.2 Dead-man layers (how anyone notices the monitor stopped)

1. **Standby trigger** (§3.4) covers a primary that stops firing: env `-1` stopped or hibernated, its task deleted, account-level scheduling of that env broken.
2. **Trigger self-check**, hourly: `monitor:primary` or `monitor:standby` when a trigger vanished and could not be re-created.
3. **Gap notice** on resume: *"no check recorded between X and Y"*, also recorded in the weekly gaps.
4. **Weekly summary** (default): its absence on a Monday is the alarm, and every alert mail's footer says so. It shows checks recorded vs expected.
5. **STALE banner** in Status, which reads state only and so works when nothing runs. The `gfs-monitor` Tasks entries also stop.
6. **Optional heartbeat URL:** `new com.hivext.api.core.utils.Transport().get(url)` after every completed scheduled run. `{status}` is replaced by `up`, or `down` when a CRIT alert is firing. A failed GET is noted in Status and never alerts, which would be circular. This is the only layer that pages when the whole platform is down.
7. **The monitor watches the backups** (`backup_stale`, `backup_unknown`, `backup_schedule`): it is the backup add-on's dead-man. The reverse is deliberately not coupled.

---

## 15. Lifecycle

### 15.1 New clusters (`manifest.jps`)

```yaml
globals:
  monitorLine: ""
onInstall:
  - initGlobals
  - ...                      # unchanged
  - installManagement
  - if ('${settings.deployBackupServer}' == 'true'):
      - assertBackupRegionInCluster
      - createBackupServer
      - installBackupAddon
  - installMonitor           # new
  - monitorSummary           # new
actions:
  installMonitor:
    - script: |
        return { result: 0, onAfterReturn: { 'marketplace.jps.install': [{
          jps: "${baseUrl}/addons/monitor.jps?_r=${fn.random}",
          envName: "${settings.envName}-1",
          nodeGroup: "storage",
          settings: { strict: "false", volumeName: "${settings.volumeName}", mountPath: "${settings.mountPoint}" }
        }] } };
  monitorSummary:
    - script: |
        var env = "${settings.envName}-1", r, i, g = null, c = null, s = null, line;
        try { r = jelastic.env.control.GetNodeGroups(env, session); } catch (e) { r = null; }
        for (i = 0; r && r.result == 0 && i < r.object.length; i++) if (String(r.object[i].name) == "storage") g = r.object[i];
        try { c = g && g.gfsMonitor ? JSON.parse(String(g.gfsMonitor)) : null; } catch (e) {}
        try { s = g && g.gfsMonitorState ? JSON.parse(String(g.gfsMonitorState)) : null; } catch (e) {}
        line = c ? "Monitoring: every " + c.intervalMin + " min, alerts e-mailed to the environment owner. " + ((s && s.setup && s.setup.summary) || "")
                 : "Monitoring is NOT active" + (s && s.setup && s.setup.error ? ": " + s.setup.error : "") + " - open GlusterFS Monitor on " + env + " (storage layer) -> Configure -> Save.";
        return { result: 0, onAfterReturn: { setGlobals: { monitorLine: line } } };
```

- There is no install-dialog field: the monitor is on by default and removable (product decision §20). Because the manifest changes, a JCA "Refresh from URL" is needed, as README already explains.
- The step runs last, after the backup block, so its first check already sees `gfsBackup`.
- **Non-strict:** a failure inside the monitor's own setup never fails the cluster deploy (§15.3). `success.md` gets a "Monitoring" section with `${globals.monitorLine}`, one sentence about the card, and "use ⋯ → Test E-mail to check delivery".

### 15.2 Existing clusters (Import)

- **Import** `…/main/addons/monitor.jps`, and pick `<prefix>-1` (any region env works; it becomes the home env) and its **storage** layer.
- The dialog is the Configure form with defaults; `settings-form.js` shows the detected cluster.
- `strict` defaults to `true`, so a failure aborts and undoes the install.

### 15.3 `manage.js op apply` (Install and Configure; order copied from backup `opApply`)

1. `P.envName` must match `^(.*)-(\d+)$`; the prefix comes from it. Load `existing = loadConfig()`; an unreadable node group throws, and is never treated as "fresh". `fresh = !existing && phase == "install"`.
2. **Duplicate guard:** `GetNodeGroups` on every sibling. A non-empty `gfsMonitor` on another env gives "This cluster is already monitored from `<env>` - uninstall it there first." In strict mode this fails; in non-strict mode it records it as the setup error and returns 0.
3. `buildConfig(existing)`: validation, volume and mount resolution (§10.1), offsets (§9), standby env (§3.4), `updated`.
4. `deployTaskScript(basePath + "/scripts/monitor/monitor-task.js")` requires `//@auth` and `GFSM_TASK_API=1`. It replaces the script only when the body changed, and keeps the old script on failure.
5. `evalTask({job:"prepare", envName, config})`:
   - It discovers the envs, runs the check with vantage selection (`FULL=1`), and sweeps **every** region.
   - It checks tools on every node (`timeout`, `findmnt`, `pgrep`, `df`, `sed`, `awk`, bash `/dev/tcp`). A missing tool is a warning naming the node and the checks affected.
   - It **fails** when no vantage answered, or when the volume does not exist.
   - It **warns** when the volume is not Started, a region could not be swept, or no standby env exists.
   - It returns `{summary, warn, facts:{glusterVersion, opVersion, replica, sets, bricks, envs, standbyEnv}}`.
6. `saveConfig(cfg)` with read-back. On a fresh install it also writes `gfsMonitorState = {v:1, rev:0, setup:{summary}}`. On Configure the state is kept, only `rtt.learnUntil = now + 24 h` is reset, and `state.sweep.at = 0` forces a sweep on the next run.
7. `replaceTasks` for `[primary on home, standby on standbyEnv]`, new first and old removed after. If the standby is rejected, that is a warning: the primary stays, and Status and the weekly summary say "no standby".
8. **Install** returns `setGlobals.monitorReport`: the first check's verdict, what will be e-mailed, and the Tasks-entry hint. **Configure** returns a `warning` popup when there are warnings (§11).

**Failure handling:**
- **Fresh install, strict:** run `undoFreshInstall` (clear both keys, delete the script, remove created tasks) and fail.
- **Fresh install, non-strict:** undo in the same way, then write `gfsMonitorState = {v:1, setup:{error}}` and return 0 with the report "Monitoring could not be set up: `<reason>` - open the card → Configure → Save". The card stays installed, so Configure → Save can finish the job.
- **Configure failure:** the previous config and triggers stay in force, and the message says so.

### 15.4 `op run`, `op pause`, `op transfer`

- `run`, job `check` / `status` / `testmail`: `evalTask({job, envName, waitSeconds})`, passing through the custom response.
- `pause`: `pauseUntil = pauseHours > 0 ? now + h×3600000 : 0`, then `saveConfig` with read-back.
- `transfer`: copied `opTransfer` re-deploys the script and both triggers from the saved config under the new owner. Mail then follows the new owner.

### 15.5 Uninstall (inline in `monitor.jps`, best effort, always `{result:0}`)

1. Read `gfsMonitor` to learn `standbyEnv`. Get the standby env's appid with `GetEnvInfo(standbyEnv).env.appid`.
2. Remove every scheduler task whose `script == <env>-gfs-monitor` under the appids `[appid, ${env.appid}, standbyAppid]`: `GetTasks`, then `RemoveTask`, then `DeleteTasks`. This is the copied loop from backup.jps.
3. Clear `gfsMonitor` and `gfsMonitorState` on home, and `gfsMonitorState` on the standby env: write `""` in string form, then object form. A run already in flight sees `configCleared()` and neither writes nor mails.
4. `DeleteScript(<env>-gfs-monitor)` if `GetScript` finds it.

Nothing is on the nodes, and gluster, the volume, peers, the firewall, the backup add-on and client envs are never touched. No step can make the card impossible to remove.

### 15.6 Other events

- **`onBeforeDelete`** (home env deleted): delete the platform script, remove the standby task on the other env, and clear the standby copy of the state. The home env's own tasks go with the env.
- **Standby env deleted** (for example by Forget Region): its task goes with it. The hourly self-repair re-creates it on the next eligible env, or raises `monitor:standby` (§3.4).
- **`onAfterConfirmTransfer`:** §15.4. A cluster split across owners breaks prefix discovery and shows up as unreachable regions; README documents this.

### 15.7 Upgrades

- **Task-script fixes** reach a cluster only through **Configure → Save** (sha-pinned; the backup model). A push to `main` never changes running monitors.
- **Card or UI changes** (monitor.jps) need Uninstall, then Import. That resets the state, so open alerts are e-mailed once more; README says so.
- **Schema:** `v` in both keys. `buildConfig` merges defaults for new fields. A state whose `v` is newer or unknown is reset, with a note in Status, and never raises an alert.
- **Topology changes** need no action; discovery runs every run.
  - **Add Region:** the new env holds no bricks while it is created (INFO). Then the layout hash changes, which starts the relaxed heal window. R 3→4 raises `even_replica` only after 24 h.
  - **Forget Region:** the forgotten env's alerts close silently as "no longer monitored". If it was the standby env, self-repair runs.
  - **Add Capacity Slice:** scaled nodes are INFO "not stitched" until stitched; after that, a layout change.
  - The monitor holds no gluster lock, so it **cannot** make a day-2 operation fail with "Another transaction is in progress" (lab-proven).
- README recommends **Pause E-mails 4 h** before planned day-2 work.

### 15.8 README additions

- **"Monitoring and alerts":** what is checked; defaults; the card; e-mail examples; Tasks entries; Pause; dead-man; the noise and interval guidance table from §9.
- **Troubleshooting entries:**
  - "No alert e-mails arrive" (Test E-mail; Status → last e-mail error).
  - "MONITOR NOT RUNNING in Status" (Configure → Save).
  - "A red `gfs-monitor alert` entry" (expand it).
  - "The monitor says a node's FUSE mount is not connected to a brick" (remount).
  - "Heal backlog alert after Add Region" (expected; ETA in the mail).
- **Versioning** v3.3 and **File layout** updates.

---

## 16. Relation to Manage Cluster and the backup add-on

- **Manage Cluster** is unchanged. It stays the raw operator console and the home of the mutating operations, and every *Do* line points back to it.
  - The monitor does **not** reuse its `status` op, because that op runs the lock-taking `gluster volume status` and prints raw text.
  - A later management v1.9 could add a "Health report" operation that calls `dev.scripting.Eval(<home>-gfs-monitor, {job:"status"})` (deferred). Card changes there would need a reinstall on every region.
- **Backup add-on:** coupling is read-only.
  - The monitor reads the `gfsBackup` key, the runner's state files (only through the sweep's `sed` reads) and the existence of its scheduler task.
  - It never Evals `<env>-gfs-backup`, never takes `/var/lock/glusterfs-backup.lock`, never mounts anything, and never writes backup keys.
  - A test pins the state-file contract (§17.2).

---

## 17. Test plan

### 17.1 Static (every commit)

- `yaml.safe_load` of every `.jps`.
- Extract every JS block, plus `scripts/monitor/*.js`; replace `${…}` with `0`, wrap it in a function, and run `node --check`.
- A regex scan for **any** `${` in `monitor-task.js`, and in the collector strings, and for non-placeholder `${` in `manage.js`, `settings-form.js` and `monitor.jps`.
- Extract the collector templates (a test helper builds them with sample params) into `.sh` files; run `bash -n` and `shellcheck -s bash` (`koalaman/shellcheck:stable`). Allow SC2016 (intentional single quotes) and SC2034.
- An allow-list grep: every `gluster` invocation matches §5.1. `ApplyNodeGroupData` never uses the key `globals`. The markers `//@auth` (first line) and `GFSM_TASK_API=1` are present.

### 17.2 Pure-JS unit tests (node; `tests/monitor/unit`)

The `PURE BEGIN/END` block is extracted and evaluated.

**Parsers** use fixtures captured with the collectors of §5 on real 11.1 (start from `lab/fixtures/`), covering:
- healthy;
- brick down (XML `hostUuid="-"` with garbled status);
- glusterd down;
- frozen node;
- majority view during a partition, and minority view (rc 251);
- pending heals;
- the 2×3 layout (`distCount` 2);
- replica 1 (`Number of Bricks: N`);
- `heal info summary` text fallback;
- split-brain entries;
- a heal timeout (rc 124);
- `volume does not exist`;
- a pool list with DNS hostnames.

**Model:** tolerance for R = 1, 2, 3, 4 (even rule), 5 and 7; per-set max backlog.

**Classification** table §7.3, every row.

**State machine scenarios** (fake clock; assert the mails and alert entries):
- A single-run blip sends nothing. Confirm, then CRIT; 1 clean run keeps it open, 2 clean runs resolve it.
- warn → crit escalation mail; a silent de-escalation.
- A region down for 3 h: exactly **one** NEW mail, with the brick, node and heal children under it; reminders at +6 h; RESOLVED with ETA.
- Unknown freezes, then `unknown:heal` after 3 runs.
- Flapping: 3 cycles in 2 h give one FLAPPING notice and no RESOLVED spam.
- Pause: then resumed with a count. `notify=false`. The daily cap of 12 with folding, where critical always goes out.
- A Send failure leaves `pending`, which the next run sends. A `rev` conflict makes the loser send nothing.
- Weekly summary; "Monitoring is active" on the first run; the gap notice.
- Standby gate: primary fresh, primary stale, home stopped. Standby takes over, then the primary is back.
- Layout change: relaxed heal; `even_replica` only after 24 h.
- Recovery window after a region returns.
- Disk hysteresis 79 → 81 → 91 → 88 → 77.
- RTT baseline learning; loss while the peer is connected.
- `fuse` pointing at a down brick is a child; pointing at an up brick it is independent.
- A 7 × 9 cluster: state stays within 16 KB, and the mail table stays readable.

**Cron simulation:** `*/15 * * * *`, `0 * * * *`, `0 */6 * * *`, `0 2 * * *`, `0 0 * * 0`, a custom Mon–Fri schedule with DST twins, and DOM OR DOW.

**Texts:** every subject and runbook line; no line longer than 78 characters; ASCII only.

### 17.3 Nashorn harness (`eclipse-temurin:11-jdk`, `jjs`; `tests/monitor/nashorn`)

This is the backup-v2 approach.
- Run the **whole** `monitor-task.js` and `manage.js` under `jjs` with mocks: `getParam`, `toJSON`, `jelastic.env.control.{GetEnvInfo,GetNodeGroups,ApplyNodeGroupData,ExecCmdById,ExecCmdByGroup}`, `jelastic.environment.control.GetEnvs`, `jelastic.utils.scheduler.*`, `jelastic.dev.scripting.*`, `jelastic.message.email.Send`, `jelastic.local.ReturnResult`, `com.hivext.api.core.utils.Transport`, `user`, `signature`.
- The ExecCmd mocks replay fixtures chosen by scenario, and record every command so tests can assert the command text (params quoted, no `${`).
- Scenarios: install (strict and non-strict failure), Configure (unchanged Save; failed deploy keeps the old script; standby rejected), Check Now (no state write, no mail), Status (STALE), uninstall (tasks removed under all appids; keys cleared), transfer, and a scheduled run for each §17.2 scenario end-to-end.
- It also proves **ES5 and Java interop compatibility**: `java.util.Base64`, `MessageDigest`, `Thread.sleep`, and no `let`/`const`/arrow functions.

### 17.4 Docker lab with real GlusterFS 11.1 (`tests/monitor/lab`)

**Images:**
- `gl11-v28`: glusterd as PID 1; fast 3- and 5-node clusters; used in this spec.
- `r3e-node`: systemd, with FUSE mounts via fstab `noauto,x-systemd.automount` exactly like production; used for mount and automount cases.
- `r3e-nfs`: backup storage for the backup-freshness case.

**Topology:**
- A private network per test, with names `gmon-*` (other workflows' containers must never be touched).
- Volumes built like `createStretchedVolume`, as 1×3, 2×3 and 1×5.
- Docker exec stands in for ExecCmd. The collectors are fed with `bash -s` using the exact strings the builders produce (captured from the Nashorn harness), so the tested command is byte-identical to what the platform would run.

**Cases**, each saving the collector output as a new fixture and asserting the evaluated result through the node model:

| Case | Injection | Expected |
|---|---|---|
| Lock regression | Collectors in a 2 s loop while `volume set` loops and `add-brick`/`remove-brick` cycle | **0** "Another transaction" failures on the writer. A control run with `volume status` in the loop must show failures, proving the test is sensitive. |
| Brick killed | `pkill -f glusterfsd` on one node | `brick` "process not running", 1 run |
| glusterd stopped | `systemctl stop glusterd` (r3e-node) | `node` glusterd down: WARN while the brick runs |
| Partition | `docker network disconnect` of one node | majority: `region` isolated (with its sweep); minority fixture rc 251 |
| Two of three down | Disconnect 2 nodes | `quorum` CRIT |
| Frozen node | `docker pause` | `node` unreachable; the collector finishes within its timeouts (about 10 s heal) |
| Stale FUSE client | Partition, then reconnect, then observe `.meta` | `fuse:<id>` after 2 sweeps; resolves after `umount -l; ls` (reproduces lab fact 5) |
| Heal drain | Kill a brick, write 1,000 files, restart it | backlog then drain; **no** `heal` alert inside 60 min; ETA text |
| Split-brain | Lab-only `cluster.quorum-type none` plus a partition with divergent writes | `splitbrain` CRIT and entry listing |
| Disk / inodes | Brick on a loop-mounted small ext4 (`mkfs.ext4 -N 2000`), `fallocate` to 85 % / 92 %, many `touch` | `disk`/`inode` WARN/CRIT and hysteresis |
| Mount | `umount -l /data`, leaving the automount (r3e-node); and a stopped FUSE process (hang) | `mount:<id>`; the collector never writes to the root fs |
| Backup freshness | The real `glusterfs-backup.sh` on r3e-node against `r3e-nfs`: successful, failed and running jobs | `GFSM_BK_*` parsed; stale, running-suppression and never-ran cases. This also pins the backup state-file contract. |
| Config drift | `volume set data auth.allow 10.0.0.1`; `cluster.self-heal-daemon off` | `auth`, `config:self-heal-daemon` |
| No noise | 3 regions healthy for 24 h of simulated runs (fixtures replayed) | 0 mails except "Monitoring is active" |
| Log noise | Collectors in a loop | `glusterd.log` gains no lines (lab fact 8) |

RTT and clock thresholds are fixture-driven: the images have no `tc`, and containers share the host clock.

**Teardown:** `docker rm -f gmon-*`, then remove the network and volumes.

### 17.5 Live test

Run on the user's platform, on the branch `monitor-v1`, with a TEST-ONLY baseUrl commit (memory: baseUrl → main coupling), against a disposable 3-region cluster. It follows this order because items 1–5 decide the fallbacks of §18.

1. Import on the storage layer of `-1`. Card buttons: Check Now, Configure; menu: Status, Pause E-mails, Test E-mail, Uninstall.
2. **Test E-mail** arrives; the plain-text layout survives (else set `MAIL_HTML`). `user` exists in Eval context (else the GetUserInfo fallback).
3. **Check Now** and **Status** popups render (`info`/`warning`).
4. Tasks log:
   - check entries every 15 min; sweeps hourly, one per region;
   - whether `GetNodeGroups`, `GetEnvInfo` or `ApplyNodeGroupData` create entries (decides `STATE_WRITE`);
   - whether the entry shows the command text;
   - whether an `exit 1` echo entry is red **and** a non-zero exit still returns stdout (decides `CHECK_EXIT_ON_PROBLEM`).
5. **Stop env `-1`** for 1 h:
   - Does the primary trigger still fire? Answer in the next notes.
   - Does the standby take over within 2×I + 10 min?
   - Can state be written to a stopped env's node group?
6. Stop region 3's node: CRIT mail after 1–2 runs, then start it: RESOLVED with ETA.
7. `systemctl stop glusterd` on one node (with the user's OK on the test cluster).
8. `fallocate` a file on a storage node's root fs above 80 % (outside `/glustervolume` and `/data`), then remove it: `disk` alert, then resolved.
9. `gluster volume set data auth.allow 10.0.0.1`, then reset to `'*'`.
10. Run Add Capacity Slice or Rebalance while Check Now is clicked repeatedly: **no** "Another transaction is in progress".
11. With the backup add-on installed: remove its scheduler task through the API gives `backup_schedule`; Configure → Save on the backup card clears it.
12. Pause E-mails 1 h, then resume.
13. Uninstall: no `*-gfs-monitor` script or tasks, and both keys cleared (including the standby copy). `gluster volume info` is identical before and after; the backup card is unaffected. Re-import works; an import on `-2` is refused (duplicate guard) while `-1` is monitored.
14. A fresh deploy from the branch manifest has the monitor on `-1`, and success.md shows `monitorLine`. A broken monitor URL (a branch experiment) still gives a successful cluster deploy with "Monitoring is NOT active".

Record each answer in the memory notes, as was done for the backup add-on.

---

## 18. Platform unknowns and their fallbacks

| Unknown | Design impact | Fallback already specified |
|---|---|---|
| The scheduler fires a `CreateEnvTask` whose env is stopped, or whose region is unreachable | primary silent while `-1` is down | Standby trigger (§3.4); gap notice |
| `ApplyNodeGroupData` on a stopped env | state of an acting standby | Write the state copy on the standby env; loaders take the newest `rev` |
| Read/metadata API calls create Tasks entries | noise | `STATE_WRITE="change+hourly"`, standby threshold 75 min + 2×I |
| ExecCmd returns stdout on a non-zero exit | red check entries | Collectors always exit 0; the red channel is the alert entry; `CHECK_EXIT_ON_PROBLEM` flips it later |
| `ExecCmdByGroup` with a stopped node in the group (whole-call error vs per-node) | sweeps | Fall back to `ExecCmdById` per running node |
| ExecCmd blocking time against a dead or frozen node | run duration | 3 vantage attempts, unreachable cache, deadlines, `rev`-guarded commit |
| Max ExecCmd output returned and displayed | large clusters | Compacted XML (about 60 KB at 7 × 9); if truncated, split `GFSM_HEAL` into per-set lines (implementation detail) |
| `{result:"info"\|"warning"}` popups render from buttons and menu | Check Now, Status | Echo entries in the Tasks log |
| `Send` from scheduler **and** Eval context; plain-text rendering; `user` defined in Eval | e-mail | Test E-mail; `mail.lastError` in Status; retry via `pending`; `MAIL_HTML`; GetUserInfo fallback |
| Quartz minute lists (`0 7,22,37,52 * * * ? *`) accepted | schedule | Proven only to the same degree as backup's generated lists. If rejected: `offsetMin/I` form (`7/15`), then plain `*/I` |
| `CreateEnvTask` callable from a scheduled platform script | standby self-repair | On failure: `monitor:standby`, fixed by Configure → Save |
| `GetTasks` appid partitioning (scripting appid vs env appids) | trigger listing and uninstall | Look under `[appid, homeAppid, standbyAppid]` |
| Platform-script execution time limit for scheduled and Eval runs | long runs | Budget of about 4 min total per run |
| `Transport().get` to arbitrary external URLs | heartbeat | Optional and blank by default; failure only noted |
| Node-group value size limit | state | Target 16 KB, hard cap 32 KB |
| GlusterFS version on the Certified Storage image | XML tags, `heal info summary --xml`, brick port range | Text fallback (`GFSM_HEALTXT`); fixtures from the live cluster via Manage Cluster → Custom CLI (`gluster --version`, `gluster pool list --xml`, `gluster volume info data --xml`, `gluster volume heal data info summary --xml`, `grep max-port /etc/glusterfs/glusterd.vol`) |
| Tools on the storage image: `pgrep`, `findmnt`, `ss`, bash `/dev/tcp`, `$EPOCHREALTIME` (bash 5) vs `date +%N` | collectors | Tool check at Configure; the affected checks degrade to unknown, with warnings |
| `df` of `/glustervolume` inside a Virtuozzo container reports the node's disk limit | disk alerts | Live test step 8 |

---

## 19. Deferred

| Item | Why not v1 | When |
|---|---|---|
| Canary write probe (end-to-end write latency, direct write-quorum proof) | Writes into tenant data; hung-write handling; quorum is already derived exactly from brick reachability | v1.1, opt-in toggle, if the user wants it (§20) |
| Disk-full forecast (`full in < 72 h`) | Needs more history in state; spikes cause false alarms | v1.1; the weekly summary already shows the 7-day growth |
| Extra e-mail recipients / operator copy | `Send` to non-owner addresses unverified | After the live Send test |
| Per-alert acknowledgement | UI and state complexity; global Pause covers maintenance | Later |
| `gfsMaintenance` key from the day-2 add-ons | Unnecessary once lock-free; Pause covers mail noise | Only if day-2 noise shows up live |
| Manage Cluster "Health report" operation | Changing management.jps needs a re-import on every region | management v1.9 |
| Shared helper library for backup and monitor | Both must be proven live first | After both live tests |
| Brick-port vs firewall enforcement check | Depends on the platform's default inbound policy; the live cluster works | See §21; add once the image version is known |
| Monitoring client-environment FUSE mounts | Forbidden by design (nothing in client envs) | Never; storage nodes' own `fuse:` links are the proxy |
| Rebalance status | Lock-taking | Manage Cluster |

---

## 20. Genuine product decisions (recommended defaults)

1. **Install on every new cluster by default, with no install-dialog field.** Recommended: **yes**. It lands on `<prefix>-1`, is removable from the card, and needs one JCA refresh for the manifest change.
2. **Summary e-mail cadence**, which is the human dead-man. Recommended: **weekly (Monday 07:00 UTC)**, with daily selectable. Daily detects a dead monitor within a day, but becomes mail people filter away.
3. **Write probe inside the tenant volume** (a hidden `/data/.gfs-monitor/…` file per region). Recommended: **not in v1**. Replication latency is measured as GRE RTT per region pair (every run and hourly mesh), and write-quorum loss is computed exactly from brick reachability.
4. **Check cadence vs Tasks-log noise.** Recommended: **every 15 min plus an hourly per-region sweep**, which is 168 entries/day for 3 regions. 30 min plus 3 h cuts that to 72.

Everything else has a default in §7–§11 and needs no decision.

---

## 21. Out-of-scope findings (noticed while designing; not part of this add-on)

1. **Brick ports vs the storage firewall.**
   - GlusterFS 11.1 (`glusterd.vol` `max-port 60999`) placed bricks on ports 52405–59551 in the lab.
   - `cluster-logic.jps` opens inbound TCP **49152–49251** only.
   - If the Certified Storage image runs GlusterFS ≥ 10 and the env firewall denies other inbound traffic, cross-region brick connections and FUSE clients could be blocked. The live cluster works, so the image version or the default inbound policy is different. Worth checking with `gluster volume status data` (brick ports) and `grep port /etc/glusterfs/glusterd.vol` on a live node.
   - The monitor surfaces the port in `brick` "unreachable" texts and in Status.
2. **`cluster-logic.jps` `onBeforeMigrate`** runs `umount -l <mount>`, then `rm -rf <mount>`. If stopping the automount unit fails, the `rm` traverses the automount, which mounts the volume, and **deletes replicated data in every region**. Guard the `rm` with `findmnt -rn --mountpoint <mount> | tail -n 1` showing no `fuse.glusterfs` (or use `rmdir`).
3. `cluster-logic.jps` `onAfterRedeployContainer` sets `network.ping-timeout 10`, while install sets 30 and README says 30. The monitor shows the effective value as INFO.
4. Manage Cluster's "Cluster status" uses the lock-taking `gluster volume status`, so it can itself collide with a running day-2 operation. README could say "re-run on 'Another transaction is in progress'".

---

## 22. Implementation order and branch

1. The PURE block (parsers, model, rules, state machine, texts, cron simulation), with the node unit tests on `lab/fixtures`.
2. The collector builders, plus Docker lab cases (§17.4) that capture the remaining fixtures.
3. `monitor-task.js` jobs and the Nashorn harness.
4. `manage.js` (copied helpers), `monitor.jps`, `settings-form.js`.
5. `manifest.jps`, `success.md`, README.
6. Static checks, then push to branch **`monitor-v1`** with a TEST-ONLY baseUrl commit. The branch is created from `backup-v2` after the backup work is committed, because `manage.js` copies its helpers and README builds on v3.2 text. Verify via the commit-SHA raw path.
7. Live test (§17.5). Fix from its feedback, with no extra review rounds (the user's standing preference).
8. Merge order: `backup-v2` → `main` first (dropping its TEST-ONLY commit), then `monitor-v1` (dropping its own). Tag v3.3. **Ask before each push and tag.**
