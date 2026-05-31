# Multi-Region GlusterFS Cluster (JPS)

A standalone Jelastic/Virtuozzo JPS package that deploys an independent GlusterFS
storage cluster in each of several regions and connects them with native
**GlusterFS geo-replication**. It is a *service-only* package — no app/web/DB
layers — modelled on `jelastic-jps/galera-multiregion` but for storage.

## What it deploys

```
 Region 1 (PRIMARY)            Region 2                     Region N
 ┌───────────────────┐        ┌───────────────────┐        ┌───────────────────┐
 │ storage cluster   │  geo   │ storage cluster   │  geo   │ storage cluster   │
 │ (Certified Storage│ ─────▶ │ (Certified Storage│ ─────▶ │ (Certified Storage│
 │  nodes, glusterd) │  rep   │  nodes, glusterd) │  rep   │  nodes, glusterd) │
 │ volume: data      │        │ volume: data      │        │ volume: data      │
 └───────────────────┘        └───────────────────┘        └───────────────────┘
        envName-1                    envName-2                    envName-N
```

- One environment per region (`envName-1 … envName-N`), all in one env-group.
- **Region 1 is the geo-replication master**; it pushes the volume to every other
  region (one-directional **star** topology, asynchronous).
- Cross-region transport is selectable: **internal** (platform GRE routing, no
  public IPs — default) or **public** (WAN, one public IP per node). See
  *Networking* below.

## Replication models

Chosen at deploy via **Replication model**:

- **Async geo-replication (default)** — an independent GlusterFS cluster per
  region; the **primary** region pushes the volume to every secondary via native
  geo-replication. One-directional (write primary, read secondaries),
  asynchronous, efficient over WAN. Best for read-heavy / DR / high-latency.
- **Synchronous stretched cluster** — **all regions form one volume** with
  `replica = number of regions` (one brick per region per replica set). **Write to
  any node in any region and it replicates to every region**, synchronously
  (multi-master). Requires an **odd region count** (3, 5, …) for split-brain
  quorum. Slicing still applies: more nodes per region ⇒ more replica sets ⇒
  distributed-replicated capacity. **Tradeoff:** writes wait for all regions, so
  write latency ≈ cross-region round-trip.

> GlusterFS geo-replication is one-directional by design, so true write-anywhere
> requires the synchronous model — there is no async multi-master option for files.

## Volume model (async model — single / cluster / slicing)

The install dialog expresses the volume as two dimensions:

| Field | Meaning |
|-------|---------|
| **Per-region topology** | `single` = 1 node/region; `cluster` = multi-node/region |
| **Replica count** | copies per file within a region (redundancy): 2 or 3 |
| **Replica sets** | number of replica sets = capacity "slices" (distribution width) |

`nodesPerRegion = replicaCount × replicaSets`.

| Choice | Resulting GlusterFS volume | Use |
|--------|----------------------------|-----|
| topology `single` | single-brick volume, geo-replicated | **Option 1**: single node per region |
| `cluster`, sets = 1 | `replica N` (pure mirror) | **Option 2**: cluster per region, redundancy only |
| `cluster`, sets > 1 | **distributed-replicated** (`replica N`, bricks = N×sets) | **Advanced**: scale capacity *and* keep redundancy |

Example: replica 3 × 2 sets = 6 nodes/region → ~2× usable capacity vs a single
node, every file still stored 3×. Add another set (3 more nodes) → ~3× capacity.

## File layout

```
manifest.jps                     # orchestrator (install): region picker → per-region envs → geo-rep
scripts/
  getClusterEnvs.js              # discover sibling regional envs by name prefix
  storage-region.jps             # per-region Certified-Storage env (install)
  cluster-logic.jps              # in-region volume lifecycle + elastic scaling (update, permanent)
  geoReplicationManager.jps      # async model: cross-region geo-rep orchestrator (runs in primary)
  geoReplication.jps             # async model: per-env geo-rep worker
  syncClusterManager.jps         # sync model: forms one stretched volume across all regions
addons/
  management.jps                 # operational buttons (status/heal/rebalance), auto-installed on primary
  addRegion.jps                  # day-2: add a new region
  forgetRegion.jps               # day-2: remove a region (heal by forgetting)
  switchNetworkMode.jps          # day-2: switch internal (GRE) <-> public (WAN)
success/success.md               # post-install summary
```

## On-disk / mount conventions

- **Brick:** `/glustervolume` (one per node).
- **FUSE mount:** the volume is mounted on every storage node at the chosen mount
  point (default `/data`) via `mount.glusterfs localhost:/<volume>`, with a
  systemd-automount fstab entry.
- **NFS re-export:** `/data` is re-exported (`/etc/exports`, unique `fsid`) so app
  nodes in the same region can mount it.
- **glusterd is preinstalled** on Certified Storage — there is no package install.

## Scaling

### Scaling out (add capacity) — supported automatically
Scale a region's `storage` layer **in multiples of the replica count**. Each group
of `replicaCount` new nodes becomes a new replica set; `cluster-logic.jps`
peer-probes them, runs `add-brick … replica N`, then `rebalance start` +
`heal full`. Adding a number of nodes that is *not* a multiple of the replica
count leaves them peered but idle (logged as a warning) to avoid an invalid
brick/replica ratio.

### Scaling in — gated (manual)
Auto scale-in is blocked (`onBeforeScaleIn` stopEvent) because removing bricks
from a distributed-replicated volume without migrating data first loses it. To
remove a replica set safely, from the region's storage master:

```bash
gluster volume remove-brick <vol> <brick1> <brick2> <brick3> start
gluster volume remove-brick <vol> <brick1> <brick2> <brick3> status   # wait: "completed"
gluster volume remove-brick <vol> <brick1> <brick2> <brick3> commit
gluster peer detach <host>                                            # for each removed node
```

## Networking (internal GRE vs public WAN)

Chosen at deploy via **Cross-region networking**, and switchable later with the
`switchNetworkMode` add-on:

- **Internal (default)** — regions talk over Jelastic's built-in **GRE routing**
  between regions. **No public IPs**, nothing to expose. Geo-replication targets
  each region's *internal* storage IP. Simplest and cheapest; note inter-region
  GRE paths are shared and can saturate under heavy replication.
- **Public** — the package attaches a **public IPv4 to every storage node**
  (`binder.SetExtIpCount … ipv4 1`) and geo-replication targets those public IPs
  over the WAN. Use when you want dedicated cross-region bandwidth / to avoid GRE.

### Firewall (handled in the JPS)

At cluster creation, `cluster-logic.jps` sets firewall rules on the `storage`
group via the platform API (`environment.security.AddRule`):
- **Outbound:** ALLOW all (so nodes can always reach peers).
- **Inbound:** ALLOW TCP **22, 24007–24008, 49152–49251** (GlusterFS + SSH).

These are real platform firewall rules (persistent, not in-container iptables),
and are a no-op when the env firewall feature is disabled (nothing is filtered
then). The same rules serve both networking modes. *Hardening note:* inbound
`src` is `ALL`; in public mode you may want to restrict it to the peer regions'
IPs — actual volume access is still gated by `auth.allow` and geo-rep by SSH keys.

**Geo-rep account:** sessions connect as the `jelastic` user via the GlusterFS
mountbroker (upstream `jelastic-jps/wordpress-multiregions` recipe). If a session
fails to start, check `gluster volume geo-replication <vol> status` and the
mountbroker on the slave (`/var/mountbroker-root`, `geogroup`, user `jelastic`).

## Hosting / `baseUrl`

All scripts are fetched at install time from `baseUrl` (currently
`https://raw.githubusercontent.com/stackharbor-devops/glusterfs-multi-region/main`).
**Set `baseUrl` in every `*.jps` to wherever you host this repo**, or installs
will fail to fetch `scripts/*`. Import `manifest.jps` via the Jelastic dashboard
("Import" → URL or local file).

## Day-2 operations

All day-2 add-ons run **against the primary environment** (`envName-1`), where the
deployment parameters are persisted. The **management** buttons work in both
models; **addRegion / forgetRegion / switchNetworkMode** currently target the
**async (geo-replication)** model — adding/removing a region from a *synchronous
stretched* cluster (which changes the replica count) is a planned follow-up.

- **Management buttons** (`addons/management.jps`, auto-installed on the primary —
  shown in the env's Add-ons panel):
  - *Cluster Status* — peer/volume/status on every region's master.
  - *Geo-Replication Status* — `geo-replication … status` on the primary.
  - *Heal Volumes* — `heal … full` on every region.
  - *Rebalance Volumes* — `rebalance … start` on every region.
- **Add a region** (`addons/addRegion.jps`): pick a new region; it creates the
  regional cluster and extends geo-replication to it (same cluster, new slice of
  geography).
- **Forget a region** (`addons/forgetRegion.jps`): "heal by forgetting" — stops and
  deletes the geo-replication session to a region that is down or being
  decommissioned (optionally deletes its environment). Combine forget + add to
  move a cluster off a bad region onto a new one.
- **Switch network mode** (`addons/switchNetworkMode.jps`): flip the whole
  deployment between internal (GRE) and public (WAN) — adds/removes public IPs and
  re-establishes geo-replication in the new mode.

## Scaling

- **Scale out (add capacity):** use the native topology UI to add `storage` nodes
  **in multiples of the replica count**. `cluster-logic.jps` automatically
  peer-probes them, runs `add-brick … replica N`, and `rebalance` + `heal`. Each
  group of `replicaCount` nodes is a new capacity slice.
- **Scale in (remove capacity):** automatic scale-in is gated (`onBeforeScaleIn`
  stopEvent) because removing bricks from a distributed-replicated volume without
  migrating data first loses it. Remove a full replica set safely with the
  controlled `remove-brick start → status → commit` procedure (see *Scaling in*
  above), then detach the peers and scale the layer down. A guided scale-in
  add-on is a planned follow-up (deferred because safe data migration is async
  and doesn't fit a blocking event handler).

## Status / known gaps

- **Async model:** geo-replication is one-directional (primary → secondaries);
  **master promotion / failover is not automated** — if the primary region is
  lost, recover manually with *Forget a region* + *Add a region*.
- **Sync model:** day-2 region add/remove (changes the replica count) and online
  capacity scaling (add one node per region as a new replica set) are planned
  follow-ups; v1 sets the stretched topology at deploy time. Remember writes are
  synchronous — size regions/latency accordingly.
- **Guided scale-in add-on** (async) is pending (see *Scaling*).
- Cannot be validated off-platform; the items under *Networking* and the geo-rep
  mountbroker are the most likely to need tuning on a real Virtuozzo platform.
