/**
 * loadClusterGlobals.js
 *
 * Loads the cluster parameters that syncClusterManager persists in the primary
 * environment's storage node-group data (key "globals") and hands them to the
 * calling day-2 add-on as globals.
 *
 * Self-healing: v1 of the backup add-on wrote its own settings over that same
 * key whenever the backup storage sat in the first region (env -1), which
 * broke Add Region / Forget Region / Add Capacity Slice. When the persisted
 * parameters are missing or incomplete, they are rebuilt from the live
 * cluster (sibling environments, storage nodes, `gluster volume info`),
 * written back, and returned.
 *
 * Invoke with:  - script: ${baseUrl}/scripts/loadClusterGlobals.js
 *                 envName: ${env.name}
 *                 nodeGroup: storage
 */
var group = (typeof nodeGroup !== "undefined" && nodeGroup) ? String(nodeGroup) : "storage";
var REQUIRED = ["master_env_name", "envNamePrefix", "volumeName", "replicatedPath", "nodesPerRegion", "regionsCount"];

function get(o, k) {
    if (!o) return undefined;
    if (typeof o.containsKey === "function") return o.containsKey(k) ? o.get(k) : undefined;
    return o[k];
}

function complete(o) {
    for (var i = 0; i < REQUIRED.length; i++) {
        var v = get(o, REQUIRED[i]);
        if (v === undefined || v === null || String(v) === "" || /^\$\{/.test(String(v))) return false;
    }
    return true;
}

function parseGlobals(raw) {
    if (raw === undefined || raw === null || String(raw) === "") return null;
    try { return JSON.parse(String(raw)); } catch (e) { /* not JSON */ }
    try { return new org.yaml.snakeyaml.Yaml().load(String(raw)); } catch (e2) { return null; }
}

var resp = api.env.control.GetNodeGroups(envName, session);
if (resp.result != 0) return resp;
var groups = resp.object || [], ng = null, i;
for (i = 0; i < groups.length; i++) if (String(groups[i].name) == group) ng = groups[i];

var persisted = ng ? parseGlobals(ng.globals) : null;
if (complete(persisted)) return { result: 0, onAfterReturn: { setGlobals: persisted } };

// ---- rebuild from the live cluster ------------------------------------------------
var m = /^(.*)-(\d+)$/.exec(String(envName));
if (!m) return { result: 1, error: "No persisted GlusterFS globals found, and '" + envName + "' is not named <prefix>-<N>. Run this add-on against the primary environment." };
if (m[2] !== "1") return { result: 1, error: "No persisted GlusterFS globals found on this env. Run this add-on against the primary environment (" + m[1] + "-1)." };
var prefix = m[1];

var info = api.env.control.GetEnvInfo(envName, session);
if (info.result != 0) return info;
var nodes = [], master = null;
for (i = 0; i < (info.nodes || []).length; i++) {
    if (String(info.nodes[i].nodeGroup) != group) continue;
    nodes.push(info.nodes[i]);
    if (info.nodes[i].ismaster && !master) master = info.nodes[i];
}
if (!nodes.length) return { result: 1, error: "No '" + group + "' nodes in " + envName + "." };
master = master || nodes[0];

// Hints: the native-FUSE flag (v3.0+) and v1 backup settings name the volume
// and mount path; the live node is authoritative.
var hintVolume = "", hintPath = "", c = ng ? ng.cluster : null;
if (c && typeof c === "string") { try { c = JSON.parse(c); } catch (e3) { c = null; } }
if (c && c.settings) { hintVolume = String(c.settings.replicatedVolume || ""); hintPath = String(c.settings.replicatedPath || ""); }
if (!hintVolume && get(persisted, "volume_name")) hintVolume = String(get(persisted, "volume_name"));
if (!hintPath && get(persisted, "sourcePath")) hintPath = String(get(persisted, "sourcePath"));

var cmd = "gluster volume list 2>/dev/null; echo '@@'; " +
          "findmnt -rn -t fuse.glusterfs -o SOURCE,TARGET 2>/dev/null; findmnt --fstab -rn -t glusterfs -o SOURCE,TARGET 2>/dev/null; echo '@@'; " +
          "gluster volume info 2>/dev/null | grep -E '^(Volume Name|Number of Bricks):'; echo '@@END'";
var ex = null, exErr = "";
try { ex = api.env.control.ExecCmdById(envName, session, master.id, toJSON([{ command: cmd }]), true, "root"); } catch (e5) { exErr = String(e5); }
var out = (ex && ex.responses && ex.responses.length) ? String(ex.responses[0].out || "") : "";
if (out.indexOf("@@END") < 0) {
    return { result: 1, error: "Could not query GlusterFS on node " + master.id + " of " + envName + " to rebuild the cluster parameters: " +
        (exErr || (ex && ex.error) || (ex ? "result " + ex.result : "no response")) };
}
var parts = out.split("@@");
function lines(s) { var a = String(s || "").split("\n"), r = []; for (var j = 0; j < a.length; j++) if (a[j].replace(/\s/g, "")) r.push(a[j].replace(/^\s+|\s+$/g, "")); return r; }
if (/Connection failed|daemon is operational/i.test(parts[0])) {
    return { result: 1, error: "glusterd is not running on node " + master.id + " of " + envName + " - start it (or the node) and run the add-on again." };
}
var vols = lines(parts[0]).filter(function (v) { return /^[A-Za-z0-9_.-]+$/.test(v); }), mountLines = lines(parts[1]), vinfo = lines(parts[2]);

var volume = "";
if (hintVolume && vols.indexOf(hintVolume) >= 0) volume = hintVolume;
else if (vols.length == 1) volume = vols[0];
else if (vols.indexOf("data") >= 0) volume = "data";
if (!volume) return { result: 1, error: "Could not determine the GlusterFS volume on " + envName + " (volumes found: " + (vols.join(", ") || "none") + ")." };

// Live FUSE mounts plus fstab entries (the cluster mounts with
// x-systemd.automount, so an untriggered mount only shows in fstab), kept
// only when their SOURCE is <host>:/<this volume>.
var mounts = [];
for (i = 0; i < mountLines.length; i++) {
    var mt = /^(\S+)\s+(\S+)$/.exec(mountLines[i]);
    if (!mt) continue;
    if (!new RegExp(":/?" + volume.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&") + "$").test(mt[1])) continue;
    if (mounts.indexOf(mt[2]) < 0) mounts.push(mt[2]);
}
var path = "";
if (hintPath && mounts.indexOf(hintPath) >= 0) path = hintPath;
else if (mounts.length == 1) path = mounts[0];
else if (mounts.indexOf("/data") >= 0) path = "/data";
if (!path) return { result: 1, error: "Could not determine where volume " + volume + " is mounted on " + envName + " (candidates: " + (mounts.join(", ") || "none") + ")." };

// "Number of Bricks: 2 x 3 = 6" -> 2 bricks per region (capacity slices),
// replica 3 (one brick per region).
var replica = 0, perRegion = 0, cur = "";
for (i = 0; i < vinfo.length; i++) {
    var vn = /^Volume Name:\s*(\S+)/.exec(vinfo[i]);
    if (vn) { cur = vn[1]; continue; }
    var nb = /^Number of Bricks:\s*(\d+)\s*x\s*(\d+)\s*=/.exec(vinfo[i]);
    if (nb && cur == volume) { perRegion = parseInt(nb[1], 10); replica = parseInt(nb[2], 10); }
}

var siblings = 0, envs = jelastic.environment.control.GetEnvs(appid, session);
if (envs && envs.result == 0) {
    var re = new RegExp("^" + prefix.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&") + "-(\\d+)$");
    for (i = 0; i < envs.infos.length; i++) if (re.test(String(envs.infos[i].env.envName))) siblings++;
}
var regions = replica || siblings;
if (!regions) return { result: 1, error: "Could not determine the number of regions of " + prefix + "." };

var rebuilt = {
    master_env_name: prefix + "-1",
    envNamePrefix: prefix,
    volumeName: volume,
    replicatedPath: path,
    nodesPerRegion: String(perRegion || nodes.length),
    regionsCount: String(regions),
    replicaCount: String(regions),
    replicationModel: "sync"
};

// Persist, so the dashboard and later runs see a complete copy again.
// syncClusterManager's persistGlobals rewrites it fully after the day-2 run.
try { api.env.control.ApplyNodeGroupData(envName, session, group, toJSON({ globals: toJSON(rebuilt) })); } catch (e4) { /* setGlobals below is what this run needs */ }

return { result: 0, repaired: true, onAfterReturn: { setGlobals: rebuilt } };
