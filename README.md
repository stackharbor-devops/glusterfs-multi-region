# Multi-Region GlusterFS Cluster — Write-Anywhere

A turnkey [Jelastic/Virtuozzo JPS](https://docs.jelastic.com/marketplace) package
that deploys a **synchronous stretched GlusterFS volume** spanning multiple
regions. Write to any node in any region — the change replicates synchronously
to every other region. Repository: <https://github.com/stackharbor-devops/glusterfs-multi-region>.

---

## What you get in one install

```
   ┌─────────────── Region A ────────────────┐  ┌─────────── Region B ─────────┐  ┌─── Region C ───┐
   │  env-XXXX-1                             │  │  env-XXXX-2                  │  │  env-XXXX-3    │
   │   ┌─────────┐ ┌─────────┐ ┌─────────┐   │  │   ┌─────────┐ ...            │  │   ┌─────────┐  │
   │   │ storage │ │ storage │ │ storage │   │  │   │ storage │                │  │   │ storage │  │
   │   │  node 1 │ │  node 2 │ │  node 3 │   │  │   │  node 1 │                │  │   │  node 1 │  │
   │   └─────────┘ └─────────┘ └─────────┘   │  │   └─────────┘                │  │   └─────────┘  │
   │       │           │           │         │  │       │                      │  │       │        │
   │   brick A1     brick A2    brick A3     │  │   brick B1                   │  │   brick C1     │
   └─────────────────────────────────────────┘  └──────────────────────────────┘  └────────────────┘
                            │                                    │                          │
                            └──────────── one trusted pool ──────┴──────────────────────────┘
                                  one GlusterFS volume "data": replica = N regions
                                  bricks = regions × nodes-per-region
                                  Write anywhere → reads from local brick, writes to all
```

- **One volume** across all regions, FUSE-mounted at `/data` on every node.
- **Replica = number of regions** (one brick per region per replica set).
- **Capacity slices** = nodes per region. More nodes per region → distributed-
  replicated layout with more usable space, redundancy preserved.
- **Odd region count required** (3, 5, 7) for split-brain quorum.
- **Networking:** cross-region replication runs over the platform's internal GRE
  routing — no public IPs are allocated.
- **Access:** the volume stays open at the Gluster layer (`auth.allow '*'`) so any
  GlusterFS-native (FUSE) client on the platform's private network can mount it.
  Access is governed by Jelastic network isolation + the storage firewall.
- **Native dashboard mounts:** each region's storage layer shows up in other
  environments' *Volumes → Data Container* dialog as **Storage Containers × N**
  with the **Gluster Native (FUSE)** client type — mount by region, with nothing
  installed on the client environment.
- **Optional backup:** at install you can deploy a backup-storage node inside one
  of the cluster regions; scheduled restic backups then run from a single
  secondary node in that same region.

---

## Hosting in your JCA marketplace (operators)

If you operate a Jelastic / Virtuozzo Application Platform (e.g. via JCA),
register this package as a marketplace tile so your tenants can install it
with one click:

1. **JCA → Cluster Admin → Marketplace → Applications** (path varies by
   platform version).
2. **Add Application → URL**, paste:
   ```
   https://raw.githubusercontent.com/stackharbor-devops/glusterfs-multi-region/main/manifest.jps
   ```
3. Pick a category (`apps/clusters` already declared by the manifest) and
   approve. The tile shows up in the tenant marketplace with the logo +
   description.

**Updating the marketplace entry.** JCA caches the manifest at registration.
Two flavors of update:
- **Script/addon-level changes** (any file under `scripts/` or `addons/`,
  the management addon, etc.) propagate **automatically** to the next
  install — every reference in the manifest uses
  `${baseUrl}/<path>?_r=${fn.random}`, so the platform pulls the freshest
  GitHub content each time. No JCA action needed.
- **Manifest-level changes** (install-dialog fields, the orchestrator's
  `onInstall` sequence, the package's `version:`, `logo:`, `description:`)
  require a JCA refresh: edit the marketplace entry → **Refresh from URL**
  (or remove + re-add). Bumping `version:` in the manifest makes this
  unambiguous in change logs.

For stricter version pinning, replace `main` in the manifest URL with a
tag — e.g. `…/v2.2/manifest.jps`. Tag the GitHub repo each release, and
register the marketplace entry against the tag URL. Tenants then get a
stable version regardless of `main` branch movement.

## Quickstart (turnkey)

In your Jelastic dashboard:

1. **Import** → URL (or click the marketplace tile if you've registered it
   per the previous section):
   ```
   https://raw.githubusercontent.com/stackharbor-devops/glusterfs-multi-region/main/manifest.jps
   ```
2. In the install dialog:
   | Field | Pick |
   |---|---|
   | Regions | 3 (or 5 or 7) of your active regions |
   | Per-region topology | Single node per region — for trying it out |
   | Volume name | `data` |
   | Mount point | `/data` |
   | Deploy a backup server | (optional) tick to add backup storage in one region |
   | Environment | (auto-generated; rename if you like) |
3. **Install**. The package will create one Certified-Storage environment per
   region, peer them all into one trusted pool, build the stretched volume,
   mount it at `/data` on every node, and install the
   **GlusterFS Cluster** management addon onto each region's storage node-group.

You're done. Write a file on any node in any region and `ls /data` on any
other node — it's there.

---

## Deployment models

The install dialog gives you a single binary choice for per-region topology:

### Single node per region (default)

- 1 storage node × N regions.
- Each file has exactly N copies (one per region).
- Cheapest write-anywhere setup; loses zero data on any single-region failure.
- Scale up later: deploy the **Add Capacity Slice** addon after you scale each
  region's storage layer.

### Cluster per region (3–9 nodes per region)

- N regions × K nodes per region = N×K bricks total.
- Volume is **distributed-replicated**: `replica N` × `K` sets.
- Each file is still stored in every region (replica = N), but more nodes per
  region = more usable capacity AND in-region failure tolerance.
- Pick `K` (3 to 9) at install via the slider; scale to more later.

| Example | Regions | Nodes/region | Bricks | Replica | Sets | Behaviour |
|---|---|---|---|---|---|---|
| Minimal write-anywhere | 3 | 1 | 3 | 3 | 1 | 3 file copies, one per region |
| Small cluster | 3 | 3 | 9 | 3 | 3 | 3 file copies, ~3× capacity |
| Bigger cluster | 5 | 3 | 15 | 5 | 3 | 5 file copies, ~3× capacity, stronger quorum |
| Wide cluster | 3 | 9 | 27 | 3 | 9 | 3 file copies, ~9× capacity |

---

## Networking

Cross-region replication runs over **Jelastic's platform GRE routing** — regions
communicate over internal routes and **no public IPs are allocated** to storage
nodes. GRE bandwidth is shared among tenants; fine for most workloads, and it may
saturate under very heavy cross-region traffic. There is no public-WAN option:
the package is internal-only by design (simpler, cheaper, no exposed IPs).

### Firewall

Set by the JPS at install via `environment.security.AddRule`, on the storage
node group:
- **Outbound:** ALLOW all — so nodes can always reach peers.
- **Inbound:** ALLOW TCP `22`, `24007–24008`, `49152–49251` (GlusterFS + SSH).

No-op if the env firewall feature is disabled (nothing is filtered then anyway).

### Access control

The volume is created with — and deliberately left at — `auth.allow '*'`. Gluster
itself does not maintain an allow-list; any GlusterFS-native (FUSE) client that
can reach the storage nodes over the platform's private network may mount it.
Access is governed by **Jelastic network isolation** (private IPs aren't reachable
by non-client environments) plus the **storage node-group firewall**. To restrict
who can mount, tighten the firewall's inbound rules for TCP `24007` and
`49152–49251` — don't rely on `auth.allow`. Inspect on any node:

```
gluster volume info data | grep auth.allow     # expected: auth.allow: *
```

### Mounting the volume from other environments (FUSE)

Because it is **one stretched volume**, you mount by *region*, not by node, and
any region serves the entire dataset.

**Natively, from the dashboard (v3.0+).** On the app environment open the
layer's *Volumes → Add → Data Container* (custom containers) or *Config → Mount
Points → Mount* (certified containers) — both use the same mount dialog:

| Field | Value |
|---|---|
| Data Container | the region env nearest that app → **Storage Containers × N** |
| Client Type | **Gluster Native (FUSE)** (pre-selected) |
| Remote path | the volume, `data` |
| Local path | where to mount inside the app containers |

Nothing is installed on the app environment, and you pick a *region*, not a node.

**How that works.** The dashboard hides the *Client Type* selector unless the
chosen source is a "storage cluster", which it decides purely from the storage
layer's node-group data: `cluster.enabled` must be true **and**
`cluster.settings.replicatedPath` / `replicatedVolume` must name the mount path
and gluster volume. The platform normally writes that when it auto-clusters a
storage layer itself (`cluster: true` — what the OEM "GlusterFS Replicated
Volume" package uses). This package cannot use that: the built-in package builds
a separate gluster pool **per environment**, and a node can belong to only one
pool, so it is mutually exclusive with a cross-region stretched volume. So the
region envs are still created with `cluster: false`, the volume is still owned by
this package, and `addons/native-fuse.jps` — installed automatically on every
region — writes just that node-group data. It is metadata only and never touches
gluster; uninstalling the **GlusterFS Native FUSE Mounts** add-on removes the
flag again.

**Regions deployed by an older version** can be upgraded in place — no redeploy.
Import this onto **each region's storage env**:

```
Import → URL: https://raw.githubusercontent.com/stackharbor-devops/glusterfs-multi-region/main/addons/native-fuse.jps
```

When imported by hand it runs strict: if the platform does not persist the flag,
the install fails and reports what it read back.

**Alternative — the client addon.** `addons/client.jps` performs the same native
FUSE mount from the client side, for platforms where the dialog route is not
available. It explicitly passes the region's other nodes as
`backup-volfile-servers`:

```
Import → URL: https://raw.githubusercontent.com/stackharbor-devops/glusterfs-multi-region/main/addons/client.jps
```

Import it **onto the app environment** (not the storage env). The dialog asks:

| Field | Value |
|---|---|
| GlusterFS region | the region env nearest that app — same-region choices listed first |
| Volume name | `data` |
| Mount path | where to mount inside the app containers (default `/mnt/gluster`) |
| Mount on node group | e.g. `cp` |

It installs the gluster FUSE client on that node group, pre-checks that it can
reach the region's glusterd port (failing fast with a clear message if network
isolation or firewall blocks it), then mounts with the region **master as
volfile server and the region's other nodes as `backup-volfile-servers`** — so
the mount is resilient both at mount time and at runtime (post-mount, the FUSE
client talks to every brick in every region directly). It persists via fstab +
systemd automount, re-applies after redeploy / scale-out / start, and removes
itself on uninstall. A **GlusterFS Client** card on that node group gives you
**Status / Remount / Unmount**.

**Alternative — NFS via the dialog.** The storage nodes re-export the volume over
NFS, so *Data Container → Server = the region's storage node → NFS* works with
zero extra setup. Trade-offs: it's a single-node dependency on that storage
node, and NFS rather than gluster-native semantics.

---

## How sync stretched works (under the hood)

Conceptually it's just **one GlusterFS volume** with `replica = N regions`,
where the brick layout is **interleaved** so each replica set has one brick per
region.

The implementation lives in `scripts/syncClusterManager.jps`. At install it
runs `action: install`:
1. **getClusterEnvs** — discover all regional envs via the `<envName>-N`
   naming convention.
2. **gatherNodes** — `env.control.GetEnvInfo` on each env, build the interleaved
   brick list and the all-nodes list.
3. **peerProbeAll** — from the primary master, `gluster peer probe <ip>` every
   other node across all regions, retry until success.
4. **createStretchedVolume** — `gluster volume create data replica N transport
   tcp <brick-list>` with quorum tuning:
   - `cluster.quorum-type auto`
   - `cluster.server-quorum-type server`
   - `network.ping-timeout 30` (WAN-friendly)
   - `cluster.choose-local on` (read from local brick)
5. **mountAllNodes** — `mount.glusterfs localhost:/data /data` on every node,
   fstab entry with systemd automount.
6. **persistGlobals** — save the deployment params on the primary env's
   storage node-group so day-2 addons can recover them.

For day-2 ops, the same script dispatches on `settings.action`:
- `addRegion` — peer + add-brick, replica N→N+1.
- `removeRegion` — remove-brick + peer detach, replica N→N-1.
- `addCapacitySlice` — peer new nodes (1 per region), add-brick as a new replica
  set, then rebalance + heal.

---

## Day-2 operations

### Management dashboard (already installed)

Each region's env has a **GlusterFS Cluster** addon in the storage node-group's
Add-Ons panel, with a single **Manage Cluster** button that opens a popup
modal:

| Operation | What it does |
|---|---|
| Cluster status | Peer status / volume info / volume status / auth.allow, fanned out to every region in parallel |
| Heal volume — full | `gluster volume heal data full` on every region |
| Rebalance volume | `gluster volume rebalance data start` on every region |
| List storage nodes + IPs | Inventory table across regions |
| Custom CLI command | Run an arbitrary `gluster …` command on every region's master (regex-guarded for safety) |

Output lands in the env's Tasks log. All operations work from **any** region —
they rediscover the cluster via `getClusterEnvs` at click time.

### Add a region

```
Import → URL: https://raw.githubusercontent.com/stackharbor-devops/glusterfs-multi-region/main/addons/addRegion.jps
```
Run against the **primary env** (the one with `-1` suffix). Pick a new region in
the dialog. The addon:
1. Creates a new regional env at `<prefix>-<next-index>` with `nodesPerRegion`
   nodes, pinned to the chosen region.
2. Runs `syncClusterManager` with `action=addRegion` — peer-probes the new node(s),
   `add-brick replica N+1`, mounts the volume locally, re-hardens `auth.allow`.

**Note:** keep your region count odd (3, 5, 7) for split-brain protection.
Adding a single region temporarily makes it even — fine if transitional.

### Remove a region ("forget")

```
Import → URL: https://raw.githubusercontent.com/stackharbor-devops/glusterfs-multi-region/main/addons/forgetRegion.jps
```
Run against the **primary env**. Pick the region to remove; optionally check
"Also delete the environment". The addon runs `syncClusterManager` with
`action=removeRegion` — `remove-brick replica N-1 force`, peer-detach, optional
env delete.

Combine forget + add to migrate the cluster off a bad region.

### Add capacity (slicing)

Two steps:
1. **Scale each region by the same count** via the Jelastic topology panel.
   E.g., go from 1 node/region to 2 nodes/region in every region.
2. **Import** → URL:
   ```
   https://raw.githubusercontent.com/stackharbor-devops/glusterfs-multi-region/main/addons/addCapacitySlice.jps
   ```
   Run against the primary env. It auto-detects the new nodes (those not yet in
   the volume), peer-probes them, `add-brick` (replica unchanged), then
   `rebalance start` + `heal full`. **Aborts cleanly if the new-node count isn't
   a multiple of the replica count** — that would leave a partial replica set.

### Backup / restore

Optional, opt-in at install. Tick **Deploy a backup server** and pick a **backup
region** — which must be one of your selected cluster regions. The orchestrator
then:

1. Deploys a Jelastic **backup-storage** env (`<envName>-bkp`) inside that region.
2. Installs the **GlusterFS Backup/Restore** addon onto that region's cluster env.
3. The addon picks **one secondary storage node** in that region (the lowest-id
   non-master node; it falls back to the region master only if the region has a
   single node) and configures scheduled `restic` backups there.

Only that one node backs up. Because the volume is synchronously replicated, one
node holds the whole dataset — so a single in-region backup captures everything,
while leaving the region master unburdened and keeping the NFS write path
intra-region. Example: 3 regions × 3 nodes = 9 nodes holding identical data; if
the backup storage is in region B, exactly one secondary node in region B runs
the backup.

After install you'll see a **GlusterFS Backup/Restore** card on that env's
storage node-group with four buttons:

| Button | What it does |
|---|---|
| Backup | Runs the restic backup once, now (on the backup node). |
| Config | Schedule (every 1 min ⚠ / 5 / 10 min / 1 / 2 / 3 / 6 / 12 / 24 h, or custom day+time, or raw cron), backup-storage env, source path (default `/data`), retention count, always-unmount toggle. |
| Restore | Lists snapshots; pick one + a restore target. Restores in place; since the volume is sync-replicated, the restore propagates to every region. |
| Verify | `restic check` on the repo. |

**Backend:** restic over an NFS mount to the backup-storage env. Repo path
`/data/<envName>/`, password = the env name (so the storage server's
`getBackups.sh <envName>` lists them). Sub-hourly schedules use `flock` to
prevent overlapping runs. This does **not** replace Jelastic VAP's node-level
snapshots — it preserves the GlusterFS volume's *data* state specifically.

You can also add it later by importing `addons/backup.jps` onto the cluster env
in the region where your backup-storage env lives.

---

## Sizing & performance

### Writes
Writes are **synchronous** — they return when the slowest region acknowledges.
Plan around your worst-case cross-region RTT:
- 3 regions in the same continent (~50ms RTT): writes ~50ms.
- 3 regions across continents (~150ms RTT): writes ~150ms+.
- Heavy small-file workloads (e.g. node_modules) feel cross-region latency a lot.
- Bulk transfers are bottlenecked by shared GRE bandwidth.

### Reads
Reads come from the **local** brick (`cluster.choose-local on`). Same speed as
local storage; no WAN cost.

### Capacity
- Single node per region: usable capacity ≈ one node's storage / 1 (replica = N
  copies, but only one slice).
- K nodes per region: usable capacity ≈ K × one node's storage.
- Always cap at the smallest region's quota (capacity is bound by the smallest
  replica set).

---

## Scaling decision tree

| You want… | Do this |
|---|---|
| More regions (geographic coverage) | Use `addRegion`. Keep region count odd. |
| More capacity in existing regions | Scale each region by the same N nodes, run `addCapacitySlice`. |
| Remove a region (decommission, failure) | Use `forgetRegion`. Add a fresh region after if you want to keep N odd. |
| Restrict who can mount the volume | Tighten the storage firewall's inbound rules (TCP `24007`, `49152–49251`) — the volume itself stays `auth.allow '*'` |
| Add scheduled backups after deploy | Import `addons/backup.jps` onto the cluster env in the region where a backup-storage env lives (or redeploy with "Deploy a backup server" ticked). |

---

## Troubleshooting

### The Data Container dialog doesn't offer Gluster Native (FUSE)
The region's storage layer isn't flagged as a storage cluster. Check that the
**GlusterFS Native FUSE Mounts** add-on is installed on that region env (storage
layer → Add-Ons) and look for its `[native-fuse]` line in the Cloud Scripting
console log — during a deployment it runs non-strict, so a platform that refused
the flag is logged there rather than failing the install. Re-importing
`addons/native-fuse.jps` by hand runs strict and shows the reason. Reload the
dashboard after installing it; it caches environment data.

### A FUSE mount from another environment fails
The volume is intentionally open (`auth.allow '*'`), so gluster itself won't
refuse the client. Check reachability instead: the client env must be able to
reach the storage nodes' private IPs (Jelastic network isolation), and the
storage firewall must allow TCP `24007` and `49152–49251` from it — for the
nodes of **every** region, since a FUSE client talks to all bricks. Quick test
from the client node: `nc -zv <storage-node-ip> 24007`.

Also confirm the volume is still open — `gluster volume get data auth.allow`
should print `*`. If mounting through the dashboard ever leaves a list of client
IPs there instead, reset it (*Manage Cluster → Custom CLI command*):
`gluster volume set data auth.allow '*'`. One volume spans every region, so a
per-environment allow-list would lock out clients that mounted via another
region.

### Writes hang / time out
- Check `Cluster Status` → look at `Network ping-timeout`. WAN latency higher
  than the ping timeout will cause stalls.
- Increase it: `Manage Cluster` → Custom CLI command:
  ```
  gluster volume set data network.ping-timeout 60
  ```

### Geo-rep error in the logs
The package no longer uses geo-replication (sync mode only since v2.0). If you
see geo-rep references in logs, you're on an env deployed by an older manifest
— redeploy.

### "Not a multiple of replica" when adding capacity
You scaled an unequal number of nodes across regions. Make every region the
same node count, then re-run `addCapacitySlice`.

### Split-brain warnings
You're running with an **even** number of regions. Add one to get to the next
odd number, or accept the reduced fault tolerance for the transitional period.

---

## File layout

```
manifest.jps                       install orchestrator (regionlist + topology + volume params)
scripts/
  getClusterEnvs.js                discover sibling regional envs by name prefix
  storage-region.jps               per-region Certified-Storage env (install)
  cluster-logic.jps                in-region node prep (firewall, glusterd, dirs) — permanent addon
  syncClusterManager.jps           cross-region stretched-volume manager — action-dispatch
                                    (install / addRegion / removeRegion / addCapacitySlice)
addons/
  native-fuse.jps                  flags a region's storage layer as a storage cluster so the
                                    dashboard offers Gluster Native (FUSE) mounts (auto-installed)
  management.jps                   single-button "Manage Cluster" with popup operations
  addRegion.jps                    day-2: add a new region (replica +1)
  forgetRegion.jps                 day-2: remove a region (replica -1)
  addCapacitySlice.jps             day-2: grow capacity (sets +1; replica unchanged)
  backup.jps                       optional: scheduled restic backups from one
                                    secondary node in the backup-storage region
  client.jps                       fallback, import onto an APP env: Gluster-native FUSE
                                    mount of the volume by region (backup-volfile-servers)
success/success.md                 post-install summary shown to the user
```

---

## Versioning

- **v3.1** (current): *Manage Cluster* — the **Run** button is now enabled for
  the pre-selected default operation (Cluster status). The dashboard only enables
  an add-on form's submit button once the form has been changed, unless the form
  sets `submitUnchanged: true`; it now does (management add-on v1.8). No storage
  or install-flow changes.
- **v3.0**: native dashboard mounts. Every region's storage layer is
  flagged as a storage cluster in node-group data (`cluster.enabled` +
  `cluster.settings.replicatedPath` / `replicatedVolume` — the exact condition
  the dashboard checks, taken from its source), so *Volumes → Data Container*
  lists it as *Storage Containers × N* and offers **Gluster Native (FUSE)**, with
  nothing installed on client environments. Done by the new
  `addons/native-fuse.jps`; the region envs keep `cluster: false`, so the
  platform's built-in per-environment gluster clustering never runs and the
  stretched volume is unchanged. Older deployments upgrade by importing that
  add-on onto each region env.
- **v2.6**: new `addons/client.jps` — Gluster-native FUSE mount of the
  volume into any app environment, by region, with the region master as volfile
  server and the other region nodes as `backup-volfile-servers`. Added because
  Jelastic's Volumes dialog only offers FUSE for `cluster: true` storage (which
  is incompatible with the cross-region stretched volume) and exposes NFS only
  for this package.
- **v2.5**: volume access opened for FUSE clients — `auth.allow` is
  left at `*` (no peer-IP hardening; access governed by Jelastic network
  isolation + the storage firewall). "Re-tighten auth.allow" operation removed.
- **v2.4**: internal-only networking (public-WAN option removed — all
  replication over GRE). Backup re-added in a region-targeted form: deploy a
  backup-storage node inside a chosen cluster region and back up from one
  secondary node in that region.
- **v2.3**: backup addon + "deploy backup server" install option removed.
- **v2.2**: optional `deployBackupServer` install flag + integrated restic
  backup addon (backed up from the primary env's master).
- **v2.0**: synchronous stretched cluster only. Write-anywhere from
  any node in any region. Async geo-replication code removed.
- **v1.x**: dual-model (sync OR async geo-replication). Async master/secondary
  topology, geo-rep sessions, promoteRegion failover. Deprecated.

Clusters deployed by v1.x in async mode still work but the v2.x day-2 addons
won't manage them (they assume sync). Redeploy with v2.x for the new feature set.

---

## License & contribution

MIT. PRs welcome. File issues at
<https://github.com/stackharbor-devops/glusterfs-multi-region/issues>.
