# Multi-Region GlusterFS Cluster — Deployed

Your **write-anywhere** synchronous GlusterFS volume is running across
**${globals.regionsCount} regions**.

## Layout

- **Volume name:** `${globals.volumeName}`
- **Mount point (on every storage node):** `${globals.replicatedPath}`
- **Topology:** ${globals.topologyDescription}

${globals.modelDescription}

## Using the volume

Every storage node already has the volume FUSE-mounted at `${globals.replicatedPath}`.
Write to that path on **any node in any region** and the change replicates
synchronously to every other region.

**Mounting it into another environment** — the volume is open to any
GlusterFS-native client on the platform's private network (access is governed
by Jelastic network isolation + the storage firewall, not a gluster allow-list).
In your app layer's **Volumes → Add → Data Container** dialog pick:

- **Server:** the GlusterFS *region* env nearest that app (e.g. `env-XXXX-2`) — you
  select the region, not a node; it's one stretched volume, so any region serves
  the whole dataset.
- **Client Type:** Gluster Native (FUSE)
- **Volume:** `${globals.volumeName}` → **Local Path:** wherever you want it.

Once mounted, the FUSE client talks to every brick in every region directly, so
a node failing in that region does not break the mount. The only single-node
dependency is fetching the volfile at mount time; to remove it, mount manually
with fallback servers listed:

```
mount -t glusterfs <region-node-ip>:/${globals.volumeName} /your/mount/point \
  -o backup-volfile-servers=<other-node-ips-in-that-region,colon-separated>
```

## Day-2 management

Open the **GlusterFS Cluster** add-on (storage node-group → Add-Ons) on **any**
region's env. Click **Manage Cluster** for a popup with:

- **Cluster status** — peer status, volume info, and current `auth.allow` across
  every region (parallel fan-out).
- **Heal volume — full** — runs `gluster volume heal ${globals.volumeName} full`.
- **Rebalance volume** — runs `gluster volume rebalance ${globals.volumeName} start`.
- **List storage nodes + IPs** — inventory table across regions.
- **Custom CLI command** — run an arbitrary `gluster …` command (advanced).

For topology changes (add region / remove region / add capacity slice), import
the dedicated add-on against this env: see the package
[README](https://github.com/stackharbor-devops/glusterfs-multi-region).

## Scaling capacity

To grow usable capacity, scale **each region's** `storage` layer up by the same
count (e.g. all 3 regions go from 1 → 2 nodes), then run the **Add Capacity
Slice** add-on against this env — it peer-probes the new nodes, adds them as a
new replica set, then triggers rebalance + heal.

## Backups (if enabled)

If you ticked **Deploy a backup server**, a `-bkp` backup-storage env was created
in your chosen region, and a **GlusterFS Backup/Restore** card is on the storage
node-group of the cluster env in that same region. Backups run from a single
secondary node there (the whole volume is sync-replicated, so one node captures
everything). Use the card's **Config** button to change the schedule, **Backup**
to run one now, and **Restore** to roll back to a snapshot.
