/*
 * onBeforeInit of the backup add-on's Restore form (addons/backup.jps,
 * settings.restore). The form object is in scope as `settings` and is
 * returned itself.
 *
 * Snapshots are listed by the platform task script (job "list"): it mounts the
 * backup storage if needed and reads the repository without taking a restic
 * lock, so the list is also available while a backup is running.
 */
var envName = "${env.envName}";
var fields = [], values = [], resp, r, snaps, i, s, tags, mode, partial, j, when, src = "/data", msg = "";

// The task script's own answer is Eval's `response`; the outer result 0 only
// means that the script ran. Unwrapped like manage.js evalTask, so an answer
// without a usable result is reported as a failure, never as "no snapshots".
function taskAnswer(resp) {
    var x;
    if (!resp || typeof resp !== "object") return { error: "the backup task script returned no result" };
    // 1702: no such script (SCRIPT_NOT_FOUND in manage.js)
    if (resp.result == 1702) return { error: "the backup task script " + envName + "-gfs-backup is missing - open Configure and click Save to re-create it" };
    x = resp.response;
    // an answer delivered as JSON text (JS or Java string) is parsed
    if (x !== null && x !== undefined && x.result === undefined) { try { x = JSON.parse(String(x)); } catch (e) { x = null; } }
    if (x && typeof x === "object" && x.result !== undefined) return { answer: x };
    if (resp.result != 0) return { error: resp.error ? String(resp.error) : "the backup task script failed (result " + resp.result + ")" };
    return { error: "the backup task script returned no result - open Configure and click Save to re-create it" };
}

try {
    resp = taskAnswer(jelastic.dev.scripting.Eval(appid, session, envName + "-gfs-backup", { job: "list", envName: envName }));
    r = resp.answer;
    if (!r) {
        msg = resp.error;
    } else if (r.result == 0) {
        snaps = r.snapshots || [];
        if (r.sourcePath) src = String(r.sourcePath);
        for (i = 0; i < snaps.length; i++) {
            s = snaps[i];
            tags = s.tags || [];
            mode = "v1";
            partial = false;
            for (j = 0; j < tags.length; j++) {
                if (String(tags[j]) == "mode=auto") mode = "scheduled";
                if (String(tags[j]) == "mode=manual") mode = "manual";
                if (String(tags[j]) == "partial") partial = true;
            }
            when = String(s.time || "").replace("T", " ").substring(0, 19);
            values.push({ value: String(s.id), caption: when + " UTC   " + String(s.short_id) + "   " + mode +
                (partial ? "   INCOMPLETE (some items could not be read)" : "") });
        }
    } else {
        msg = (r.message || r.error) ? String(r.message || r.error) : "the backup task script failed (result " + r.result + ")";
    }
} catch (e) {
    msg = String(e);
}

if (msg) {
    fields.push({ type: "displayfield", cls: "warning", hideLabel: true, height: 70,
        markup: "Could not list the snapshots: " + msg });
} else if (!values.length) {
    fields.push({ type: "displayfield", cls: "warning", hideLabel: true, height: 50,
        markup: "There are no snapshots yet. Run Backup Now first." });
} else {
    fields.push({ type: "list", name: "snapshotId", caption: "Snapshot (newest first)", required: true,
        editable: false, forceSelection: true, values: values });
    fields.push({ type: "string", name: "restorePath", caption: "Restore into", "default": src, required: true,
        regex: "^/[A-Za-z0-9._/-]*$",
        regexText: "An absolute path: " + src + " itself, or a directory inside it." });
    fields.push({ type: "displayfield", cls: "warning", hideLabel: true, height: 90,
        markup: "Restoring into " + src + " overwrites those files with the snapshot's versions on the live volume, and the change replicates to every region. Files created after the snapshot are kept. To inspect first, restore into a sub-directory such as " + src + "/restore-check. Stop write workloads before an in-place restore. An INCOMPLETE snapshot lacks the items that could not be read; those are left as they are." });
}

settings.fields = fields;
return settings;
