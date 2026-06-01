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
synchronously to every other region. Each storage node also re-exports the
volume over NFS for clients in the same region:

```
mount -t glusterfs <local-region-storage-master-ip>:/${globals.volumeName} /your/mount/point
```

## Day-2 management

Open the **GlusterFS Cluster** add-on (storage node-group → Add-Ons) on **any**
region's env. Click **Manage Cluster** for a popup with:

- **Cluster status** — peer status, volume info, and current `auth.allow` across
  every region (parallel fan-out).
- **Heal volume — full** — runs `gluster volume heal ${globals.volumeName} full`.
- **Rebalance volume** — runs `gluster volume rebalance ${globals.volumeName} start`.
- **Re-tighten auth.allow** — recomputes the peer IP list and applies it.
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
