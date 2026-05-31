# Multi-Region GlusterFS Cluster — Deployed

Your distributed GlusterFS storage is now running across **${globals.regionsCount} regions**.

## Topology

- **Primary region (geo-replication source):** `${settings.envName}-1`
- **Volume name:** `${globals.volumeName}`
- **Mount point (on every storage node):** `${globals.replicatedPath}`
- **Layout:** `${globals.topologyDescription}`

${globals.modelDescription}

## Mounting from your application nodes

Each storage node also re-exports the volume over NFS. From an app node in the
same region, mount the regional cluster's master:

```
mount -t glusterfs <region-storage-master-ip>:/${globals.volumeName} /your/mount/point
```

## Day-2 management

Run these from the **primary** environment (`${settings.envName}-1`) via the
GlusterFS Manager add-on actions:

- **Check status** — peer status, volume info/status, and geo-replication status across regions.
- **Heal volume** — `gluster volume heal ${globals.volumeName} full` (after a node recovers).
- **Rebalance** — `gluster volume rebalance ${globals.volumeName} start` (after adding capacity).

## Scaling capacity (slicing)

To grow usable capacity in a region, scale its `storage` layer out **in multiples
of the replica count (${globals.replicaCount})** — each group of ${globals.replicaCount}
nodes becomes a new replica set (a capacity "slice"), after which the volume is
rebalanced automatically. See the README for the controlled scale-in procedure.
