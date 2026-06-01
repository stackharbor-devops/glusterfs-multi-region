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
- **Networking:** internal (platform GRE, no public IPs) or public (each storage
  node gets a public IPv4 for cross-region WAN).
- **Security:** `auth.allow` is set to the cluster's peer IPs only — no
  unauthorised mounts even with port access. Firewall rules applied at install.

---

## Quickstart (turnkey)

In your Jelastic dashboard:

1. **Import** → URL:
   ```
   https://raw.githubusercontent.com/stackharbor-devops/glusterfs-multi-region/main/manifest.jps
   ```
2. In the install dialog:
   | Field | Pick |
   |---|---|
   | Regions | 3 (or 5 or 7) of your active regions |
   | Cross-region networking | Internal (GRE) — the cheap default |
   | Per-region topology | Single node per region — for trying it out |
   | Volume name | `data` |
   | Mount point | `/data` |
   | Environment | (auto-generated; rename if you like) |
3. **Install**. The package will create one Certified-Storage environment per
   region, peer them all into one trusted pool, build the stretched volume,
   mount it at `/data` on every node, harden `auth.allow`, and install the
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

Picked at install via **Cross-region networking**, applied automatically:

### Internal (GRE) — default

- Regions communicate over Jelastic's platform GRE routes.
- **No public IPs allocated.** Cheapest and simplest. GRE bandwidth is shared
  among tenants — fine for most workloads, may saturate under heavy traffic.
- Best for: dev/staging, modest-traffic production.

### Public WAN

- Each storage node gets a public IPv4 (`binder.SetExtIpCount … ipv4 1`).
- Cross-region traffic flows over the public Internet.
- Highest cross-region bandwidth; predictable performance.
- Best for: high-throughput production where GRE saturates.

### Firewall

Set by the JPS at install via `environment.security.AddRule`:
- **Outbound:** ALLOW all — so nodes can always reach peers.
- **Inbound:** ALLOW TCP `22`, `24007–24008`, `49152–49251` (GlusterFS + SSH).

The same rules apply in both networking modes. No-op if the env firewall feature
is disabled (nothing is filtered then anyway).

### auth.allow hardening

At install, the volume is created with `auth.allow '*'` so peer probes can
complete. **The cluster manager then tightens `auth.allow` to the list of peer
storage-node IPs (plus 127.0.0.1)** via the `hardenAuth` action. Inspect on any
node:

```
gluster volume info data | grep auth.allow
```

Day-2 ops (addRegion, forgetRegion, addCapacitySlice) all re-run `hardenAuth` at
the end, so the allow list stays current.

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
6. **hardenAuth** — set `auth.allow` to peer IPs.
7. **persistGlobals** — save the deployment params on the primary env's
   storage node-group so day-2 addons can recover them.

For day-2 ops, the same script dispatches on `settings.action`:
- `addRegion` — peer + add-brick, replica N→N+1.
- `removeRegion` — remove-brick + peer detach, replica N→N-1.
- `addCapacitySlice` — peer new nodes (1 per region), add-brick as a new replica
  set, then rebalance + heal.
- `hardenAuth` — re-tighten `auth.allow` to current peer IPs.

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
| Re-tighten auth.allow | Recomputes peer IPs and applies to the volume |
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

### Backup (separate addon)

A backup addon is in development; see `addons/backup.jps`. It schedules restic
backups of the volume to S3 / SFTP, with rotation.

---

## Sizing & performance

### Writes
Writes are **synchronous** — they return when the slowest region acknowledges.
Plan around your worst-case cross-region RTT:
- 3 regions in the same continent (~50ms RTT): writes ~50ms.
- 3 regions across continents (~150ms RTT): writes ~150ms+.
- Heavy small-file workloads (e.g. node_modules) feel WAN latency a lot.
- Bulk transfers are bottlenecked by GRE bandwidth (internal mode) or your
  WAN link (public mode).

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
| Tighten security after topology change | Use Manage Cluster → "Re-tighten auth.allow" |
| Switch internal ↔ public networking | Manual: scale-down then re-deploy. (The dedicated addon was removed in v2.0 — net-new sync version is a future feature.) |

---

## Troubleshooting

### "auth.allow shows `*`, not peer IPs"
Click **Manage Cluster** → **Re-tighten auth.allow**. (`hardenAuth` runs at
install and after every day-2 op; if you see `*`, something interrupted the
flow.)

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
                                    (install / addRegion / removeRegion / addCapacitySlice / hardenAuth)
addons/
  management.jps                   single-button "Manage Cluster" with popup operations
  addRegion.jps                    day-2: add a new region (replica +1)
  forgetRegion.jps                 day-2: remove a region (replica -1)
  addCapacitySlice.jps             day-2: grow capacity (sets +1; replica unchanged)
success/success.md                 post-install summary shown to the user
```

---

## Versioning

- **v2.0** (current): synchronous stretched cluster only. Write-anywhere from
  any node in any region. Async geo-replication code removed.
- **v1.x**: dual-model (sync OR async geo-replication). Async master/secondary
  topology, geo-rep sessions, promoteRegion failover. Deprecated.

Clusters deployed by v1.x in async mode still work but the v2.x day-2 addons
won't manage them (they assume sync). Redeploy with v2.x for the new feature set.

---

## License & contribution

MIT. PRs welcome. File issues at
<https://github.com/stackharbor-devops/glusterfs-multi-region/issues>.
