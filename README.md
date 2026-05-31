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
- Cross-region transport is **public IP + firewall** (see *Networking* below).

## Volume model (the two options + slicing)

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
  geoReplicationManager.jps      # cross-region geo-rep orchestrator (update, runs in primary)
  geoReplication.jps             # per-env geo-rep worker (update)
addons/
  addRegion.jps                  # day-2: add a new region
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

## Networking & firewall (verify on first deploy)

Cross-region geo-replication uses each storage node's **public IPv4**
(`extip: true`). The package opens, via `iptables`, ports **22**,
**24007–24008**, and **49152–49251** from the other regions' storage IPs.

Two platform-specific things to confirm on your installation:
1. **Platform firewall.** Jelastic's own firewall layer may also need matching
   inbound rules for those ports (Environment → Firewall, or the firewall API).
   The in-container `iptables` rules alone may be insufficient or non-persistent.
2. **Root vs `jelastic` SSH.** Geo-replication connects as the `jelastic` user via
   the GlusterFS mountbroker; the recipe follows the upstream
   `jelastic-jps/wordpress-multiregions` pattern. If sessions fail to start,
   check `gluster volume geo-replication <vol> status` and the mountbroker setup
   on the slave (`/var/mountbroker-root`, `geogroup`, user `jelastic`).

## Hosting / `baseUrl`

All scripts are fetched at install time from `baseUrl` (currently
`https://raw.githubusercontent.com/stackharbor-devops/glusterfs-multi-region/main`).
**Set `baseUrl` in every `*.jps` to wherever you host this repo**, or installs
will fail to fetch `scripts/*`. Import `manifest.jps` via the Jelastic dashboard
("Import" → URL or local file).

## Day-2: add a region

Import `addons/addRegion.jps` **against the primary environment** (`envName-1`),
pick the new region, and it will create the new regional cluster and extend
geo-replication to it.

## Status / known gaps

- Geo-replication is **asynchronous and one-directional** (primary → secondaries).
- **Failover / master promotion is not implemented** (no automatic re-pointing of
  geo-rep if the primary region is lost) — a planned follow-up.
- Cannot be validated off-platform; the items under *Networking & firewall* are
  the most likely to need tuning on a real Virtuozzo Application Platform.
