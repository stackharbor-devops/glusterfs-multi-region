/*
 * onBeforeInit of the backup add-on's settings form (addons/backup.jps), used
 * in two places:
 *   - the top-level onBeforeInit (Import / install dialog): must return
 *     { result: 0, settings: jps.settings };
 *   - settings.main.onBeforeInit (the Configure button): the form object is
 *     in scope as `settings` and is returned itself.
 * It fills the Backup Storage list and the time-zone list, and on Configure
 * pre-selects the values currently in force (read from the storage node
 * group's "gfsBackup" data, which is what the schedule actually uses).
 */
var formCtx = (typeof settings !== "undefined") && settings && settings.fields;
var form = formCtx ? settings : jps.settings.main;
var envName = "${env.envName:}";

function walk(fields, fn) {
    var i, k, f;
    for (i = 0; fields && i < fields.length; i++) {
        f = fields[i];
        fn(f);
        if (f.showIf) for (k in f.showIf) walk(f.showIf[k], fn);
        if (f.items) walk(f.items, fn);
    }
}
function byName(name) {
    var out = [];
    walk(form.fields, function (f) { if (f.name == name) out.push(f); });
    return out;
}
var cfgError = "";
function currentConfig() {
    var r, g, i, raw;
    if (!envName) return null;
    try {
        r = jelastic.env.control.GetNodeGroups(envName, session);
        if (!r || r.result != 0) { cfgError = (r && r.error) ? String(r.error) : "result " + (r ? r.result : "empty"); return null; }
        g = r.object || [];
        for (i = 0; i < g.length; i++) {
            if (String(g[i].name) != "storage") continue;
            raw = g[i].gfsBackup;
            if (raw === null || raw === undefined || String(raw) === "") return null;
            try { return JSON.parse(String(raw)); } catch (x) { return JSON.parse(toJSON(raw)); }
        }
    } catch (e) { cfgError = String(e); }
    return null;
}
function hasGroup(info, name) {
    var groups = info.envGroups || [], i, g;
    for (i = 0; i < groups.length; i++) {
        g = groups[i];
        g = (typeof g === "object" && g !== null && g.name) ? g.name : g;
        if (String(g).indexOf(name) === 0) return true;
    }
    return false;
}

var cfg = currentConfig();

// ---- Backup Storage list -------------------------------------------------------
// Running storages first; the configured one is kept visible even when it is
// stopped or gone, so Configure never silently switches to another storage.
var current = cfg ? String(cfg.storageEnv || "") : "";
var running = [], stopped = [], listed = false, resp, i, info, e, name, isBackup, scope, entry;
try {
    resp = jelastic.environment.control.GetEnvs(appid, session);
    for (i = 0; resp && resp.result == 0 && i < resp.infos.length; i++) {
        info = resp.infos[i];
        e = info && info.env;
        if (!e) continue;
        name = String(e.envName);
        if (name == envName) continue;
        scope = "";
        try { scope = e.properties && e.properties.projectScope ? String(e.properties.projectScope) : ""; } catch (x) { scope = ""; }
        isBackup = hasGroup(info, "Backup storage") || scope == "backup";
        if (!isBackup && name != current) continue;
        entry = {
            value: name,
            caption: (e.displayName ? String(e.displayName) + " (" + name + ")" : name) + (e.status != 1 ? " - not running" : "")
        };
        if (name == current) listed = true;
        (e.status == 1 ? running : stopped).push(entry);
    }
} catch (ex) { /* the list stays empty */ }
var envs = running.concat(stopped);
if (current && !listed) envs.unshift({ value: current, caption: current + " - deleted or not accessible, pick another" });
var storageField = byName("storageName")[0];
if (storageField) {
    storageField.values = envs;
    storageField["default"] = current || (running.length ? running[0].value : "");
    if (!envs.length) {
        // No selectable dummy entry: the required field stays empty, so
        // Install/Save stay disabled until a Backup Storage exists.
        storageField.placeholder = "No Backup Storage found - install \"Backup Storage\" from the Marketplace first";
    }
}

// ---- time zones ------------------------------------------------------------------
var zones = [], ids = java.util.TimeZone.getAvailableIDs(), now = new Date().getTime(), off, sign, hh, mm;
for (i = 0; i < ids.length; i++) {
    off = java.util.TimeZone.getTimeZone(ids[i]).getOffset(now) / 60000;
    sign = off < 0 ? "-" : "+";
    off = Math.abs(off);
    hh = Math.floor(off / 60); mm = off % 60;
    zones.push({ value: String(ids[i]), caption: String(ids[i]) + " (UTC" + sign + (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm + ")" });
}
var tzField = byName("tz")[0];
if (tzField) {
    tzField.values = zones;
    tzField["default"] = (cfg && cfg.tz) ? String(cfg.tz) : "UTC";
}

// ---- current values (Configure) ------------------------------------------------------
if (cfg) {
    var st = byName("scheduleType")[0], f, d, dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    if (st) st["default"] = String(cfg.scheduleType || "1");
    var crons = byName("cronTime");
    for (i = 0; i < crons.length; i++) {
        f = crons[i];
        if (f.type == "list") {
            for (d = 0; d < (f.values || []).length; d++) {
                if (String(f.values[d].value) == String(cfg.cronTime)) f["default"] = String(cfg.cronTime);
            }
        } else if (cfg.scheduleType == "3") {
            f["default"] = String(cfg.cronTime);
        }
    }
    f = byName("backupTime")[0];
    if (f && cfg.backupTime) f["default"] = String(cfg.backupTime);
    for (d = 0; d < 7; d++) {
        f = byName(dayNames[d])[0];
        if (f && cfg.days && cfg.days.length == 7) f.value = !!cfg.days[d];
    }
    f = byName("sourcePath")[0];
    if (f && cfg.sourcePath) f["default"] = String(cfg.sourcePath);
    f = byName("backupCount")[0];
    if (f && cfg.keep) f["default"] = parseInt(cfg.keep, 10);
    f = byName("notifyOnFailure")[0];
    if (f) f.value = String(cfg.notify) != "false";
}

// Never let the form look like the current configuration when it is not.
if (cfgError && form.fields) {
    form.fields.unshift({ type: "displayfield", cls: "warning", hideLabel: true, height: 50,
        markup: "The current backup configuration could not be read (" + cfgError + "). The form shows defaults - check every value before saving." });
}

if (formCtx) return settings;
return { result: 0, settings: jps.settings };
