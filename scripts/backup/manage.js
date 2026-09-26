/*
 * GlusterFS Backup/Restore add-on - management logic.
 *
 * Run by addons/backup.jps as a Cloud Scripting `script:` action (context:
 * appid, session, getParam). Operations (param "op"):
 *
 *   apply     Install and Configure. Validate the settings, (re)create the
 *             per-environment platform task script, let it pick and check the
 *             backup node and mount the backup storage, save the
 *             configuration, replace the scheduler tasks - and only then
 *             remove the v1 add-on, so a failed install never leaves the
 *             cluster without backups. A failed Configure keeps the previous
 *             configuration and schedule in force.
 *   run       A button: backup | verify | restore | purge | status, executed
 *             by the platform task script (the same code path the schedule
 *             uses).
 *   transfer  Ownership transfer: re-create the task script and tasks under
 *             the new owner from the saved configuration.
 *
 * Uninstall and environment deletion run inline in backup.jps (they must work
 * even when this file cannot be downloaded).
 *
 * The configuration lives in the storage node group's data under the key
 * "gfsBackup" (a JSON string). It must never be written to the "globals" key:
 * that key holds the cluster parameters the day-2 add-ons read back.
 */

var NAMES = ["op", "phase", "envName", "envAppid", "basePath", "job", "snapshotId", "restorePath", "confirm",
             "scheduleType", "cronTime", "backupTime", "tz", "sun", "mon", "tue", "wed", "thu", "fri", "sat",
             "storageName", "sourcePath", "backupCount", "notifyOnFailure",
             "cluster_id", "primary_region_name", "backup_region_name", "volume_name"];
var P = {}, _i, _v;
for (_i = 0; _i < NAMES.length; _i++) {
    _v = getParam(NAMES[_i], "");
    _v = (_v === null || _v === undefined) ? "" : String(_v);
    // An unresolved JPS placeholder means "not provided".
    P[NAMES[_i]] = /^\$\{.*\}$/.test(_v) ? "" : _v;
}

var GROUP = "storage";
var CONFIG_KEY = "gfsBackup";
var TASK_NAME = P.envName + "-gfs-backup";
var MOUNT_PATH = "/opt/gfs-backup";
var LEGACY_IDS = ["glusterfs-backup-addon", "glusterfs-backup"];
var SCRIPT_NOT_FOUND = 1702;

function ok(extra) { var r = { result: 0 }, k; for (k in (extra || {})) r[k] = extra[k]; return r; }
function fail(msg) { return { result: 99, error: msg, message: msg, type: "error" }; }
function unwrap(r) { return (r && r.response && typeof r.response === "object" && r.response.result !== undefined) ? r.response : r; }
function trim(s) { return String(s || "").replace(/^\s+|\s+$/g, ""); }
function parseJSON(s) { try { return JSON.parse(String(s)); } catch (e) { return null; } }
function bool(v, dflt) {
    v = String(v === undefined || v === null ? "" : v);
    if (v === "true") return true;
    if (v === "false") return false;
    return dflt;
}
function sha256(text) {
    var d = java.security.MessageDigest.getInstance("SHA-256").digest(new java.lang.String(String(text)).getBytes("UTF-8")), h = "", i, b;
    for (i = 0; i < d.length; i++) { b = (d[i] & 0xff).toString(16); h += (b.length < 2 ? "0" : "") + b; }
    return h;
}

// ---- configuration --------------------------------------------------------------

// null = no configuration saved. An unreadable node group is NOT "no
// configuration": it throws, so nothing is ever treated as a fresh install on a
// failed read (saveConfig's read-back catches it and retries).
function loadConfig() {
    var r = jelastic.env.control.GetNodeGroups(P.envName, session), groups, raw, cfg, i;
    if (!r || r.result != 0) {
        throw "could not read the current backup configuration of " + P.envName + " (" + (r && r.error ? r.error : "result " + (r ? r.result : "?")) +
              "), so nothing was changed - try again";
    }
    groups = r.object || [];
    for (i = 0; i < groups.length; i++) {
        if (String(groups[i].name) != GROUP) continue;
        raw = groups[i][CONFIG_KEY];
        if (raw === null || raw === undefined || String(raw) === "") return null;
        cfg = parseJSON(raw);
        if (!cfg || typeof cfg !== "object") cfg = parseJSON(toJSON(raw));
        return (cfg && typeof cfg === "object") ? cfg : null;
    }
    return null;
}

// Writes only the CONFIG_KEY entry of the node group's data (a per-key
// add/replace).
function writeConfigValue(value) {
    var data = {}, forms, f, r;
    data[CONFIG_KEY] = value;
    forms = [toJSON(data), data];
    for (f = 0; f < forms.length; f++) {
        try { r = jelastic.env.control.ApplyNodeGroupData(P.envName, session, GROUP, forms[f]); } catch (e) { r = { result: 99, error: String(e) }; }
        if (r && r.result == 0) return r;
    }
    return r;
}

// Saved = read back identical (a failed read-back is retried, not taken as a
// failed write).
function saveConfig(cfg) {
    var r = writeConfigValue(toJSON(cfg)), back, i;
    for (i = 0; i < 3; i++) {
        try { back = loadConfig(); } catch (e) { back = null; }
        if (back && back.updated == cfg.updated) return ok();
        java.lang.Thread.sleep(1000);
    }
    return fail("Could not save the backup configuration on the storage node group (" + (r && r.error ? r.error : "read-back mismatch") + ").");
}

// ---- schedule --------------------------------------------------------------------

var CRON_FIELDS = [
    { name: "minute", min: 0, max: 59 },
    { name: "hour", min: 0, max: 23 },
    { name: "day of month", min: 1, max: 31 },
    { name: "month", min: 1, max: 12, names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], base: 1 },
    { name: "day of week", min: 0, max: 7, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"], base: 0 }
];

// Range/step check of one cron field; throws a readable message.
function checkCronField(value, idx) {
    var spec = CRON_FIELDS[idx], items = value.split(","), i, m, a, b, step;
    function num(t) {
        var n = spec.names ? spec.names.indexOf(String(t).toUpperCase()) : -1;
        if (n >= 0) return n + spec.base;
        if (!/^\d{1,2}$/.test(t)) throw spec.name + " value '" + t + "' is not valid";
        n = parseInt(t, 10);
        if (n < spec.min || n > spec.max) throw spec.name + " value " + n + " is outside " + spec.min + "-" + spec.max;
        return n;
    }
    for (i = 0; i < items.length; i++) {
        m = /^(\*|[0-9A-Za-z]+)(?:-([0-9A-Za-z]+))?(?:\/(\d+))?$/.exec(items[i]);
        if (!m) throw spec.name + " item '" + items[i] + "' is not valid";
        if (m[1] != "*") a = num(m[1]);
        if (m[2] !== undefined && m[2] !== "") {
            if (m[1] == "*") throw spec.name + " item '" + items[i] + "' is not valid";
            b = num(m[2]);
            if (b < a) throw spec.name + " range '" + items[i] + "' is reversed";
        }
        if (m[3] !== undefined && m[3] !== "") {
            step = parseInt(m[3], 10);
            if (step < 1 || step > spec.max) throw spec.name + " step '" + m[3] + "' is not valid";
        }
    }
}

// Month names -> numbers: Quartz ignores a step after a name range
// ("jan-jun/2") and cannot parse mixed ranges ("1-mar"). checkCronField has
// already validated every name.
function monthToQuartz(mon) {
    var names = CRON_FIELDS[3].names;
    return mon.replace(/[A-Za-z]+/g, function (t) { return String(names.indexOf(t.toUpperCase()) + 1); });
}

// Linux cron (Sunday = 0 or 7) -> Quartz day of week (Sunday = 1).
function dowToQuartz(dow) {
    var items = dow.split(","), out = [], i, m, lo, hi, st, k, r;
    function map(n) { n = parseInt(n, 10); if (n == 7) n = 0; return n + 1; }
    function add(x) { x = String(x); if (out.indexOf(x) < 0) out.push(x); }
    for (i = 0; i < items.length; i++) {
        m = /^([^\/]+)(?:\/(\d+))?$/.exec(items[i]);
        if (m[1] == "*") { add("*" + (m[2] ? "/" + m[2] : "")); continue; }
        if (/^[A-Za-z]{3}(-[A-Za-z]{3})?$/.test(m[1]) && !m[2]) { add(m[1].toUpperCase()); continue; }
        r = /^(\d)(?:-(\d))?$/.exec(m[1]);
        if (!r) throw "day of week item '" + items[i] + "' is not supported";
        lo = parseInt(r[1], 10); hi = (r[2] !== undefined && r[2] !== "") ? parseInt(r[2], 10) : (m[2] ? 7 : lo);
        st = m[2] ? parseInt(m[2], 10) : 1;
        for (k = lo; k <= hi; k += st) add(map(k));
    }
    return out.join(",");
}

// Cron (5 fields, UTC) -> Quartz triggers (7 fields: sec min hour DOM month
// DOW year, exactly one of DOM/DOW "?"). Cron ORs day-of-month and day-of-week
// when both are restricted - two triggers. When one of them starts with "*"
// (e.g. "*/2"), cron ANDs them, which Quartz cannot express: rejected.
function cronToQuartz(cron) {
    var f = trim(cron).split(/\s+/), dom, dow, domSet, dowSet, i;
    if (f.length != 5) throw "a cron expression has 5 fields (minute hour day-of-month month day-of-week)";
    for (i = 0; i < 5; i++) {
        if (!/^[0-9A-Za-z*\/,\-]+$/.test(f[i])) throw "field " + (i + 1) + " ('" + f[i] + "') has invalid characters";
        checkCronField(f[i], i);
    }
    dom = f[2]; dow = f[4]; f[3] = monthToQuartz(f[3]);
    domSet = dom != "*";
    dowSet = dow != "*";
    if (domSet && dowSet) {
        if (dom.charAt(0) == "*" || dow.charAt(0) == "*") {
            throw "restricting both day of month ('" + dom + "') and day of week ('" + dow + "') with a '*' step is not supported by the platform scheduler";
        }
        return ["0 " + f[0] + " " + f[1] + " " + dom + " " + f[3] + " ? *",
                "0 " + f[0] + " " + f[1] + " ? " + f[3] + " " + dowToQuartz(dow) + " *"];
    }
    if (dowSet) return ["0 " + f[0] + " " + f[1] + " ? " + f[3] + " " + dowToQuartz(dow) + " *"];
    return ["0 " + f[0] + " " + f[1] + " " + dom + " " + f[3] + " ? *"];
}

// Custom schedule: local time + weekdays in a time zone -> one UTC cron line
// for every UTC offset the zone uses in the coming year (standard, daylight,
// and short periods such as Morocco's Ramadan time). Each trigger carries its
// offset; at run time the task script lets only the trigger nearest to the
// configured local time do the backup (dueCustom in backup-task.js).
function customSchedule(time, tz, days) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(trim(time)), zone, now, offsets = [], crons = [], o, k, local, utc, shift, sel, i, d;
    if (!m) return null;
    local = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    if (local >= 1440) return null;
    zone = java.util.TimeZone.getTimeZone(tz || "UTC");
    now = new Date().getTime();
    for (k = 0; k <= 366; k++) {
        o = Math.round(zone.getOffset(now + k * 86400000) / 60000);
        if (offsets.indexOf(o) < 0) offsets.push(o);
    }
    for (k = 0; k < offsets.length; k++) {
        utc = local - offsets[k]; shift = 0;
        if (utc < 0) { utc += 1440; shift = -1; }
        if (utc >= 1440) { utc -= 1440; shift = 1; }
        sel = [];
        for (i = 0; i < 7; i++) {
            if (days[i]) { d = (i + shift + 7) % 7; if (sel.indexOf(d) < 0) sel.push(d); }
        }
        sel.sort();
        crons.push((utc % 60) + " " + Math.floor(utc / 60) + " * * " + ((sel.length == 0 || sel.length == 7) ? "*" : sel.join(",")));
    }
    return { crons: crons, offsets: offsets };
}

// The scheduler triggers of a configuration: [{quartz, params}].
function triggersFor(cfg) {
    var out = [], i, j, q, params, daysStr = "", offs = cfg.offsets || [];
    if (String(cfg.scheduleType) == "2") {
        for (i = 0; i < 7; i++) daysStr += (cfg.days && cfg.days[i]) ? "1" : "0";
        for (i = 0; i < cfg.crons.length; i++) {
            q = cronToQuartz(cfg.crons[i]);
            for (j = 0; j < q.length; j++) {
                params = { task: 1, job: "backup", envName: P.envName, utcOffset: String(offs[i]), offsets: offs.join(","),
                           tz: String(cfg.tz), backupTime: String(cfg.backupTime), days: daysStr };
                out.push({ quartz: q[j], params: params });
            }
        }
        return out;
    }
    q = cronToQuartz(cfg.cron);
    for (j = 0; j < q.length; j++) out.push({ quartz: q[j], params: { task: 1, job: "backup", envName: P.envName } });
    return out;
}

function buildConfig(existing) {
    var e = existing || {}, type, crons, offsets = [], cs, days, i, storage, src, keep, clusterId, triggers, dayNames, tz, time, cfg, dflt, text, names, sel;
    type = P.scheduleType || e.scheduleType || "1";
    tz = P.tz || e.tz || "UTC";
    time = P.backupTime || e.backupTime || "02:00";
    dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    days = [];
    for (i = 0; i < 7; i++) {
        dflt = (e.days && e.days.length == 7) ? !!e.days[i] : (i >= 1 && i <= 5);
        days.push(bool(P[dayNames[i]], dflt));
    }
    if (type == "2") {
        cs = customSchedule(time, tz, days);
        if (!cs) return fail("The backup time must look like HH:MM (24-hour).");
        crons = cs.crons; offsets = cs.offsets;
        names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]; sel = [];
        for (i = 0; i < 7; i++) if (days[i]) sel.push(names[i]);
        text = (sel.length && sel.length < 7 ? sel.join(",") : "every day") + " at " + time + " " + tz;
    } else {
        crons = [trim(P.cronTime || e.cronTime || "0 * * * *")];
        text = "cron " + crons[0] + " (UTC)";
    }

    storage = trim(String(P.storageName || e.storageEnv || "").split(".")[0]);
    if (!storage) return fail("Pick a Backup Storage environment. If there is none, install \"Backup Storage\" from the Marketplace first.");
    if (storage == P.envName) return fail("The backup storage must be a separate environment, not " + P.envName + " itself.");

    src = trim(P.sourcePath || e.sourcePath || "/data");
    if (!/^\/[A-Za-z0-9._\/-]*[A-Za-z0-9_-]$/.test(src)) return fail("The volume mount path must be an absolute path such as /data.");

    keep = parseInt(P.backupCount || e.keep || "24", 10);
    if (isNaN(keep) || keep < 1 || keep > 1000) return fail("The number of snapshots to keep must be between 1 and 1000.");

    clusterId = P.cluster_id || e.clusterId || P.envName.replace(/-\d+$/, "");

    cfg = {
        v: 2,
        envName: P.envName,
        storageEnv: storage,
        mountPath: MOUNT_PATH,
        sourcePath: src,
        keep: String(keep),
        scheduleType: type,
        cronTime: type == "2" ? "" : crons[0],
        backupTime: time,
        tz: tz,
        days: days,
        cron: crons[0],
        crons: crons,
        offsets: offsets,
        scheduleText: text,
        notify: bool(P.notifyOnFailure, !(e.notify === false || String(e.notify) == "false")) ? "true" : "false",
        clusterId: clusterId,
        primaryRegion: P.primary_region_name || e.primaryRegion || "",
        backupRegion: P.backup_region_name || e.backupRegion || "",
        volumeName: P.volume_name || e.volumeName || "data",
        hostId: "glusterfs-" + clusterId,
        runnerUrl: (P.basePath || e.basePath) + "/scripts/backup/glusterfs-backup.sh",
        basePath: P.basePath || e.basePath,
        pruneHours: 24,
        checkSubset: "5%",
        taskScriptSha: e.taskScriptSha || "",
        updated: new Date().toISOString() + "-" + Math.floor(Math.random() * 1e6)
    };
    // Every trigger is validated before anything is changed.
    try { triggers = triggersFor(cfg); } catch (ex) { return fail("Invalid backup schedule '" + crons.join("' / '") + "': " + ex); }
    return ok({ cfg: cfg, triggers: triggers });
}

// ---- platform task script and scheduler ---------------------------------------

function getTaskScript() {
    try {
        var r = jelastic.dev.scripting.GetScript(appid, session, TASK_NAME);
        return (r && r.result == 0) ? r : null;
    } catch (e) { return null; }
}

function scriptCode(r) {
    var c = r && ((r.script && r.script.code) || r.code || (r.object && r.object.code));
    return (c === undefined || c === null) ? null : String(c);
}

function deleteTaskScript() {
    try { if (getTaskScript()) jelastic.dev.scripting.DeleteScript(appid, session, TASK_NAME); } catch (e) { /* best effort */ }
}

function createTaskScript(body) {
    var r;
    try { r = jelastic.dev.scripting.CreateScript(appid, session, TASK_NAME, "js", body); } catch (e) { r = { result: 99, error: String(e) }; }
    return r || { result: 99, error: "no response" };
}

// Replace the task script only when its body changed. The body is static (the
// configuration is read at run time), so on any failure the previous script
// keeps the existing schedule working.
function deployTaskScript(basePath, prevSha) {
    var url = basePath + "/scripts/backup/backup-task.js?_r=" + Math.random(), body, cur, oldCode, sha, r, tries;
    cur = getTaskScript();
    try {
        body = String(new com.hivext.api.core.utils.Transport().get(url));
    } catch (e) {
        return cur ? ok({ note: "kept the existing task script (download failed: " + e + ")", sha: prevSha || "" })
                   : fail("Could not download the backup task script from " + url + ": " + e);
    }
    if (body.indexOf("//@auth") !== 0 || body.indexOf("GFSB_TASK_API=2") < 0) {
        return cur ? ok({ note: "kept the existing task script (the download was not valid)", sha: prevSha || "" })
                   : fail("The backup task script downloaded from " + url + " is not valid.");
    }
    sha = sha256(body);
    oldCode = scriptCode(cur);
    if (cur && (oldCode !== null ? oldCode == body : (prevSha && prevSha == sha))) return ok({ sha: sha });

    for (tries = 0; tries < 3; tries++) {
        deleteTaskScript();
        r = createTaskScript(body);
        if (r.result == 0) break;
        java.lang.Thread.sleep(2000);
    }
    if (r.result != 0) {
        if (oldCode !== null && !getTaskScript() && createTaskScript(oldCode).result == 0) {
            return fail("Could not update the platform script " + TASK_NAME + " (" + (r.error || "result " + r.result) + "); the previous version was put back and the schedule is unchanged.");
        }
        if (getTaskScript()) return fail("Could not update the platform script " + TASK_NAME + " (" + (r.error || "result " + r.result) + ").");
        return fail("Could not create the platform script " + TASK_NAME + " (" + (r.error || "result " + r.result) +
                    "). Scheduled backups cannot run until Configure succeeds - open Configure and click Save.");
    }
    java.lang.Thread.sleep(1000);
    try { jelastic.dev.scripting.Build(appid, session, TASK_NAME); } catch (e3) { /* build only refreshes the cache */ }
    return ok({ sha: sha });
}

// Eval the task script. Its own answer is in the response; an outer result 0
// only means that the script ran.
function evalTask(params) {
    var r, x;
    try {
        r = jelastic.dev.scripting.Eval(appid, session, TASK_NAME, params);
    } catch (e) {
        return fail("Could not run the backup task script " + TASK_NAME + ": " + e);
    }
    if (!r || typeof r !== "object") return fail("The backup task script " + TASK_NAME + " returned no result.");
    if (r.result == SCRIPT_NOT_FOUND) {
        return fail("The backup task script " + TASK_NAME + " is missing - open Configure and click Save to re-create it.");
    }
    x = r.response;
    if (typeof x === "string") x = parseJSON(x);
    if (x && typeof x === "object" && x.result !== undefined) return x;
    if (r.result != 0) return r.error ? fail(String(r.error)) : fail("The backup task script " + TASK_NAME + " failed (result " + r.result + ").");
    return fail("The backup task script " + TASK_NAME + " returned no result, so nothing is confirmed - open Configure and click Save to re-create it.");
}

// The tasks of this environment's task script, or null when the scheduler
// could not be read at all. Tasks are created under the scripting appid with
// envName (the official backup add-ons' pattern) and looked up under both that
// appid and the environment's.
function listTasks() {
    var appids = [appid, P.envAppid], seen = {}, ids = {}, out = [], listed = 0, a, r, tasks, i, j;
    for (i = 0; i < appids.length; i++) {
        a = appids[i];
        if (!a || seen[a]) continue;
        seen[a] = true;
        try { r = jelastic.utils.scheduler.GetTasks(a, session); } catch (e) { continue; }
        if (!r || r.result != 0) continue;
        listed++;
        tasks = r.objects || r.array || [];
        for (j = 0; j < tasks.length; j++) {
            if (String(tasks[j].script) != TASK_NAME || ids[String(tasks[j].id)]) continue;
            ids[String(tasks[j].id)] = true;
            out.push({ appid: a, id: tasks[j].id });
        }
    }
    return listed ? out : null;
}

// Removes the given tasks; returns the ones that could not be removed.
function removeTaskList(list) {
    var i, d, left = [];
    for (i = 0; list && i < list.length; i++) {
        try { d = jelastic.utils.scheduler.RemoveTask(list[i].appid, session, list[i].id); } catch (e) { d = null; }
        if (!d || d.result != 0) {
            try { d = jelastic.utils.scheduler.DeleteTasks({ appid: list[i].appid, session: session, ids: String(list[i].id) }); } catch (e2) { d = null; }
            if (!d || d.result != 0) left.push(list[i]);
        }
    }
    return left;
}

function taskId(r) {
    var o = r && (r.object || r.response);
    if (r && r.id !== undefined && r.id !== null) return String(r.id);
    if (o && o.id !== undefined && o.id !== null) return String(o.id);
    return null;
}

// Create the new triggers first and remove the old ones only when all were
// created, so a rejected trigger never leaves the environment unscheduled.
function replaceTasks(cfg, triggers) {
    var old = listTasks(), oldIds = {}, created = [], unknown = false, i, j, r, now, left, rollback;
    if (old === null) return fail("Could not read the platform scheduler, so the schedule was not changed - try again.");
    for (i = 0; i < old.length; i++) oldIds[String(old[i].id)] = true;
    for (i = 0; i < triggers.length; i++) {
        try {
            r = jelastic.utils.scheduler.CreateEnvTask({
                appid: appid,
                envName: P.envName,
                session: session,
                script: TASK_NAME,
                trigger: "cron:" + triggers[i].quartz,
                description: "GlusterFS backup of " + P.envName + " (" + (cfg.scheduleText || cfg.cron) + ")",
                params: triggers[i].params
            });
        } catch (e) { r = { result: 99, error: String(e) }; }
        if (!r || r.result != 0) {
            rollback = [];
            now = listTasks();
            if (now) { for (j = 0; j < now.length; j++) if (!oldIds[String(now[j].id)]) rollback.push(now[j]); }
            else { for (j = 0; j < created.length; j++) rollback.push({ appid: appid, id: created[j] }); unknown = true; }
            left = removeTaskList(rollback);
            return fail("The platform scheduler rejected the trigger '" + triggers[i].quartz + "' (" + (r && r.error ? r.error : "result " + (r ? r.result : "?")) + ")." +
                        ((left.length || unknown) ? " Some of the new triggers may still exist - open Configure and click Save again." : ""));
        }
        if (taskId(r)) created.push(taskId(r));
    }
    left = removeTaskList(old);
    if (left.length) {
        return ok({ note: "Warning: " + left.length + " old schedule trigger(s) could not be removed; save again to retry." });
    }
    return ok();
}

// ---- v1 add-on -------------------------------------------------------------------

// The v1 add-on registered an env-level app ("glusterfs-backup") and a
// permanent card ("glusterfs-backup-addon") that the dashboard offers no
// Uninstall for. Remove both through the API.
function migrateLegacy() {
    var notes = [], r, apps, i, a, u, removed = 0, failed = [];
    try {
        r = unwrap(jelastic.marketplace.app.GetAddonList({ search: {}, envName: P.envName, session: session }));
    } catch (e) {
        return "Could not look for the previous version of this add-on (" + e + "); if its card is still listed, avoid its buttons.";
    }
    if (!r || r.result != 0) {
        return "Could not look for the previous version of this add-on (" + (r && r.error ? r.error : "result " + (r ? r.result : "?")) +
               "); if its card is still listed, avoid its buttons.";
    }
    apps = r.apps || [];
    for (i = 0; i < apps.length; i++) {
        a = apps[i];
        if (!a || !a.isInstalled || LEGACY_IDS.indexOf(String(a.app_id)) < 0 || !a.uniqueName) continue;
        u = null;
        try {
            u = unwrap(jelastic.marketplace.installation.Uninstall({ appid: appid, targetAppid: P.envAppid, session: session,
                appUniqueName: String(a.uniqueName), force: true }));
        } catch (e2) { u = null; }
        if (!u || u.result != 0) {
            try { u = unwrap(jelastic.marketplace.jps.Uninstall(appid, session, String(a.uniqueName), true)); } catch (e3) { u = { result: 99, error: String(e3) }; }
        }
        if (u && u.result == 0) removed++;
        else failed.push(String(a.app_id) + " (" + (u && u.error ? u.error : "result " + (u ? u.result : "?")) + ")");
    }
    if (removed) notes.push("Removed the previous version of this add-on (" + removed + " installation" + (removed > 1 ? "s" : "") + ").");
    if (failed.length) notes.push("The previous version's card could not be removed automatically: " + failed.join(", ") +
        ". Its schedule and scripts were removed, so it no longer runs; avoid its buttons.");
    return notes.join(" ");
}

// ---- operations -------------------------------------------------------------------

// A first install that failed after its task script and node setup were made:
// take them back (configuration, backup storage mount, task script). The
// previous add-on version is left alone - it keeps running until an install
// succeeds.
function undoFreshInstall(cfg) {
    try { writeConfigValue(""); } catch (e) { /* best effort */ }
    try { evalTask({ job: "unprepare", envName: P.envName, config: toJSON(cfg) }); } catch (e2) { /* best effort */ }
    deleteTaskScript();
}

function opApply() {
    var existing = loadConfig(), fresh, b, cfg, d, prep, s, t, legacy, lg, notes = [];
    // Only the install event may take its own work back; Configure never tears
    // down an install, whatever loadConfig answered.
    fresh = !existing && P.phase == "install";
    b = buildConfig(existing);
    if (b.result != 0) return b;
    cfg = b.cfg;
    if (!cfg.basePath) return fail("The add-on's base URL is unknown - reinstall the add-on.");

    d = deployTaskScript(cfg.basePath, existing ? existing.taskScriptSha : "");
    if (d.result != 0) return d;
    if (d.note) notes.push("Note: " + d.note + ".");
    cfg.taskScriptSha = d.sha || cfg.taskScriptSha;

    prep = evalTask({ job: "prepare", envName: P.envName, config: toJSON(cfg), prevNode: existing && existing.nodeId ? String(existing.nodeId) : "" });
    if (prep.result !== 0) {
        if (fresh) undoFreshInstall(cfg);
        return (typeof prep.result === "number") ? prep : fail(String(prep.message || prep.error || "The node check failed."));
    }
    if (!prep.node || !prep.runnerSha256) {
        if (fresh) undoFreshInstall(cfg);
        return fail("The node check did not report the backup node and runner version, so nothing was saved - open Configure and click Save to try again.");
    }
    cfg.nodeId = String(prep.node);
    cfg.runnerSha256 = String(prep.runnerSha256);

    s = saveConfig(cfg);
    if (s.result != 0) {
        if (existing) saveConfig(existing); else if (fresh) undoFreshInstall(cfg);
        return fail(s.message + (existing ? " The previous configuration is still in force." : ""));
    }

    t = replaceTasks(cfg, b.triggers);
    if (t.result != 0) {
        if (existing) {
            saveConfig(existing);
            return fail(t.message + " The previous configuration and schedule are still in force.");
        }
        if (fresh) { undoFreshInstall(cfg); return fail(t.message + " Nothing was installed."); }
        return fail(t.message);
    }
    if (t.note) notes.push(t.note);

    // Only now that the new schedule is in place: retire the v1 add-on.
    legacy = migrateLegacy();
    if (legacy) notes.push(legacy);
    lg = evalTask({ job: "legacy", envName: P.envName });
    if (lg && lg.result === 0 && lg.message) notes.push(String(lg.message));

    return ok({ onAfterReturn: { setGlobals: {
        backupReport: "Schedule: " + cfg.scheduleText + ", keeping the newest " + cfg.keep + " snapshots. " +
            String(prep.message || "") + (notes.length ? " " + notes.join(" ") : "")
    } } });
}

function opRun() {
    var job = P.job;
    if (["backup", "verify", "restore", "purge", "status"].indexOf(job) < 0) return fail("Unknown operation '" + job + "'.");
    if (job == "purge" && P.confirm !== P.envName) {
        return fail("Nothing was deleted: type the environment name (" + P.envName + ") exactly to confirm.");
    }
    if (job == "restore" && (!P.snapshotId || !P.restorePath)) return fail("Pick a snapshot and a restore target.");
    return evalTask({ job: job, envName: P.envName, snapshotId: P.snapshotId, restorePath: P.restorePath, waitSeconds: "600" });
}

function opTransfer() {
    var cfg = loadConfig(), d, t;
    if (!cfg) return ok();
    d = deployTaskScript(cfg.basePath, cfg.taskScriptSha);
    if (d.result != 0) return d;
    try { t = triggersFor(cfg); } catch (ex) { return fail("The saved schedule is not valid: " + ex); }
    return replaceTasks(cfg, t);
}

var __r;
try {
    if (!P.envName) __r = fail("The envName parameter is missing.");
    else if (P.op == "apply") __r = opApply();
    else if (P.op == "run") __r = opRun();
    else if (P.op == "transfer") __r = opTransfer();
    else __r = fail("Unknown op '" + P.op + "'.");
} catch (ex) {
    __r = fail("GlusterFS backup add-on error: " + ex);
}
return __r;
