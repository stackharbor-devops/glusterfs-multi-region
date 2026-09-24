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
  secondary node in that same region, visible in the Tasks log. The backup
  add-on can be uninstalled and reinstalled without touching the cluster.

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

**Alternative — NFS via the same dialog.** Once a region is flagged, the dialog
lists it only as *Storage Containers × N* — its individual nodes are no longer
offered. To mount over NFS instead, switch **Client Type** to **NFS** on that
same entry. Trade-offs: NFS is served by a single storage node rather than by
every brick, and you get NFS rather than gluster-native semantics.

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
2. Installs the **GlusterFS Backup/Restore** add-on on the storage layer of that
   region's cluster env, scheduled hourly, keeping 24 snapshots.

Backups run from **one secondary storage node** of that region (the lowest-id
non-master node; the master only if the region has a single node). Because the
volume is synchronously replicated, one node holds the whole dataset — so a
single in-region backup captures everything, while leaving the region master
unburdened and keeping the NFS write path intra-region. Example: 3 regions × 3
nodes = 9 nodes holding identical data; if the backup storage is in region B,
exactly one secondary node in region B runs the backup. The node is chosen
afresh on every run, so scaling or redeploying never leaves the schedule behind.

**The card** (storage layer → Add-Ons → **GlusterFS Backup/Restore**):

| | What it does |
|---|---|
| **Backup Now** | Takes a snapshot now. If a backup is already running, this one is **queued** and starts as soon as it finishes. |
| **Configure** | Schedule (pre-defined, custom days + time in a time zone, or raw cron — the platform scheduler runs in UTC), backup storage env, volume mount path (`/data`), snapshots to keep, e-mail on failure. Checks the node and the backup storage before saving. |
| **Restore** | Pick a snapshot and a target: the volume mount itself (in-place, replicates to every region) or a directory inside it (e.g. `/data/restore-check`) to inspect first. A restore is **never queued**: if another job is running it is not started, so it can never overwrite newer data unattended later. |
| **Verify** | `restic check`, reading back 5% of the stored data. |
| ⋯ → **Backup Status** | What is running or queued, the last result of each job, snapshot count, restic version. |
| ⋯ → **Delete All Backups** | Deletes every snapshot of this cluster from the backup storage (type the env name to confirm). The cluster is not touched. |
| ⋯ → **Uninstall** | Removes the schedule, the runner and the mount. The cluster **and the backup repository** are kept — install the add-on again and backups continue in the same repository. Refused while a restore is running (it would leave the volume half-restored). |

**How it runs.** Backups are started by the **platform scheduler** — a per-env
platform script `<env>-gfs-backup` — so every run shows in the **Tasks log** as
*Executing command in the … (nodeXXXX) node*; expand it for the snapshot
details. The work itself runs in a detached job on the node under one lock:

- A scheduled backup that finds another job running is **skipped** with a
  message (never queued, never overlapping).
- Once a job has held the lock for 24 h, a scheduled backup checks whether it
  still reads or writes data: a job that made no progress since the previous
  check (or a process that is not a backup job at all) makes the run **fail**
  (red entry, e-mail) instead of skipping, so a hung job cannot silently stop
  the schedule. A long first backup that is still working is left alone.
- A manual backup or verify **queues** behind the running one (one queued job
  at most). Restore and Delete All Backups are never queued.
- A job that runs longer than the platform lets a command run (about 50 min
  for scheduled runs, 10 min for buttons) continues **in the background**; its
  result is reported by the next run and by Backup Status. A failure in the
  background turns the next run's Tasks entry red and sends the failure
  e-mail — failures are never silent.
- Runs happen on the backup node picked at Install/Configure. If that node is
  stopped, runs fail loudly; **Configure → Save** moves backups to another
  running storage node.
- A custom schedule (days + time in a time zone) gets one trigger per UTC
  offset of the zone (standard and daylight time); only the trigger nearest to
  the configured local time runs, so there is exactly one backup per selected
  day, also on DST switch days.

**Safety rules built into the runner:** it refuses to back up when the GlusterFS
FUSE mount is down (an empty `/data` would otherwise rotate every good snapshot
out of retention), and refuses to write when the backup storage is not
NFS-mounted (both mounts are automounts on Jelastic; the runner triggers them
and checks the mount on top). Restores only into the volume mount or a
directory inside it. A snapshot where some files could not be read is kept but
marked *warning* and re-tagged `partial`; partial snapshots are rotated only
among themselves, so they never push a complete snapshot out, and three partial
backups in a row turn the run red. Restores need restic ≥ 0.17, which replaces
symlinks it meets in the target instead of writing through them, and the
target is resolved to make sure it stays inside the volume. Known limit: a
client that swaps a directory for a symlink *while* a restore runs could still
redirect it, so stop write workloads before a restore (the Restore dialog says
so). Verify re-reads every index and tree from the backup storage.

**Backend:** restic ≥ 0.16 over an NFS mount of the backup-storage env's `/data`
at `/opt/gfs-backup` (the platform mounts it on demand through autofs). Repository `/data/<region-env-name>/` on the storage,
password = that env name (the Jelastic backup-storage convention, so the
storage's `getBackups.sh <env>` lists them). One stable restic host per
cluster; retention `forget --keep-last N` over all snapshots; `prune` at most
once a day. The node-side runner (`scripts/backup/glusterfs-backup.sh`) is
installed by Install/**Configure**, which records its checksum; runs only
execute exactly that version (the node keeps the versions it has had), so a
later change in this repository reaches a cluster when you click **Configure →
Save**, and a failed Configure never leaves the schedule on a different version. This does **not** replace Jelastic VAP's node-level snapshots —
it preserves the GlusterFS volume's *data* state.

**Add it later, reinstall it, or move to a new backup storage** — none of this
touches the cluster:

1. If you need a backup storage, install **Backup Storage** from the
   Marketplace in the same region as one of your cluster envs.
2. Import `https://raw.githubusercontent.com/stackharbor-devops/glusterfs-multi-region/main/addons/backup.jps`
   and pick that region's cluster env and its **storage** layer.
3. To switch storage later, use **Configure**. To start from an empty
   repository, use **Delete All Backups** (or delete the storage env and
   create a new one, then pick it in Configure).

**Upgrading from the previous version** (a card without **Uninstall**, backups
from the node's crontab, invisible in Tasks): import the new `addons/backup.jps`
on the same env's storage layer as above. It removes the old version — the card,
its crontab entry, scripts and `/opt/backup` mount — and continues in the same
repository, so existing snapshots stay restorable. If the old card could not be
removed automatically, the install message says so; it no longer runs anything,
so just avoid its buttons.

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
| Add scheduled backups after deploy, or reinstall them | Import `addons/backup.jps` on the **storage** layer of the cluster env in the region where a backup-storage env lives. The cluster is not touched. |

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

### A backup shows as skipped, queued or "still running in the background"
Only one backup job runs at a time. A scheduled backup that finds another job
running is skipped. **Backup Now** and **Verify** queue behind it (one queued
job at most). **Restore** and **Delete All Backups** are not started; run them
again when **Backup Status** shows no running job. **Backup Status** (card menu)
shows what is running (with its run id), since when, and the last result of
each job. A running job's live log is
`/var/lib/glusterfs-backup/runs/<run id>.log` on the backup node; each finished
run is appended to `/var/log/glusterfs-backup.log`.

### A scheduled backup's Tasks entry is red
Expand the entry: the output ends with `GFSB_MESSAGE=` and the reason (storage
not mounted, GlusterFS mount down, restic error, or an earlier background run
that failed). With **E-mail me when a scheduled backup fails** on, the same text
is e-mailed to the environment owner.

### Add Region / Forget Region / Add Capacity Slice complained about "persisted GlusterFS globals"
The previous version of the backup add-on overwrote the cluster parameters
stored on the primary env when the backup storage was in the first region.
These add-ons now rebuild them from the live cluster automatically; the error
only remains if they are run against an env other than the primary (`-1`).

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
  loadClusterGlobals.js            day-2 add-ons: load (or rebuild) the persisted cluster parameters
  backup/manage.js                 backup add-on: install / Configure / uninstall logic
  backup/backup-task.js            backup add-on: per-env platform script run by the scheduler + buttons
  backup/glusterfs-backup.sh       backup add-on: node-side runner (restic, locking, background jobs)
  backup/settings-form.js          backup add-on: install + Configure form
  backup/restore-form.js           backup add-on: Restore form (snapshot list)
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
                                    (uninstallable card on the storage layer)
  client.jps                       fallback, import onto an APP env: Gluster-native FUSE
                                    mount of the volume by region (backup-volfile-servers)
success/success.md                 post-install summary shown to the user
```

---

## Versioning

- **v3.2** (current): backup add-on rebuilt (v2.0).
  - **Uninstallable and reinstallable**: the add-on is now the card on the
    storage layer (the old one was a permanent inner card). Uninstall keeps the
    cluster and the backup repository; reinstalling continues in it. New
    **Delete All Backups** clears the repository.
  - **Scheduled by the platform**, so every run is in the Tasks log (the old
    node crontab was invisible); failures turn the entry red and can e-mail.
  - **Backup Now no longer fails** when a scheduled backup is running: jobs run
    detached under one lock; manual backups queue, scheduled ones skip with a
    message (and fail loudly if a job hangs for 24 h), restores are never
    queued, long jobs continue in the background and report later. Uninstall
    refuses while a restore is running.
  - Restores land in the right place (`restic restore <id>:/data`), require
    restic ≥ 0.17 and a target that resolves inside the volume. The runner is
    pinned by checksum at Configure, so repository changes never reach a
    cluster's restore code without a Configure → Save.
  - Fixed: a failed `restic backup` was reported as success (pipe without
    pipefail); an unmounted GlusterFS volume would have been backed up as an
    empty directory and rotated good snapshots out; restores into `/data`
    landed in `/data/data/...`; retention leaked per hostname; `prune` ran every
    hour; Verify collided with running backups.
  - Fixed: the old add-on overwrote the cluster parameters on the primary env
    when the backup storage was in the first region, breaking Add Region /
    Forget Region / Add Capacity Slice. It no longer writes them, and those
    add-ons rebuild damaged parameters from the live cluster
    (`scripts/loadClusterGlobals.js`).
  - The orchestrator installs the add-on on the `storage` layer. Existing
    clusters upgrade by importing the new `addons/backup.jps` (it removes the old
    version and keeps the snapshots).
  - Remove Region / Forget Region: a refused `remove-brick` was reported as
    success, and Forget Region could then delete an environment whose bricks
    were still in the volume. The step now fails, and the environment is only
    deleted when none of its nodes holds a brick. Add Region sizes a new region
    from the volume's live bricks per region.
- **v3.1**: *Manage Cluster* — the **Run** button is now enabled for
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
  add-on onto each region env. Verified on a live platform: the region is listed
  with Gluster Native (FUSE), the mount works, and `auth.allow` stays `*`.
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
