# Changelog

What changed in each version of the package, newest first. Releases are tagged `vX.Y`
on the main branch.

## [3.1] - 2026-09-20

- **Manage Cluster:** the **Run** button is now enabled for the pre-selected default
  operation (Cluster status). The dashboard only enables an add-on form's submit button
  after the form has changed, unless the form sets `submitUnchanged: true`, which it now
  does (management add-on v1.8).
- No storage or install-flow changes.

## [3.0] - 2026-09-18

- **Native dashboard mounts.** Every region's storage layer is flagged as a storage
  cluster in node-group data (`cluster.enabled` plus `cluster.settings.replicatedPath` /
  `replicatedVolume`, the exact condition the dashboard checks). *Volumes > Data Container*
  now lists it as *Storage Containers* and offers **Gluster Native (FUSE)**, with nothing
  installed on client environments.
- Done by the new `addons/native-fuse.jps`. The region environments keep `cluster: false`,
  so the platform's own per-environment GlusterFS clustering never runs and the stretched
  volume is unchanged.
- Older deployments upgrade by importing that add-on onto each region environment.
- Verified on a live platform: the region is listed with Gluster Native (FUSE), the mount
  works, and `auth.allow` stays `*`.

## [2.6] - 2026-09-18

- New `addons/client.jps`: a Gluster-native FUSE mount of the volume into any app
  environment, by region, with the region master as volfile server and the other region
  nodes as `backup-volfile-servers`. Added because the Volumes dialog only offered FUSE for
  `cluster: true` storage, which is incompatible with the cross-region volume.

## [2.5] - 2026-09-18

- Volume access opened for FUSE clients: `auth.allow` stays `*`. Access is governed by the
  platform's network isolation and the storage firewall.
- The "Re-tighten auth.allow" operation was removed.

## [2.4] - 2026-09-17

- Internal-only networking: the public-WAN option was removed, and all replication runs
  over GRE.
- Backup re-added in a region-targeted form: a backup-storage node is deployed inside a
  chosen cluster region, and backups run from one secondary node in that region.

## [2.3] - 2026-09-14

- The backup add-on and the "deploy backup server" install option were removed.

## 2.2 - 2026-06-01

- Optional `deployBackupServer` install flag and an integrated restic backup add-on,
  backing up from the primary environment's master.

## 2.0 - 2026-05-31

- Synchronous stretched cluster only: write to any node in any region.
- The asynchronous geo-replication code was removed.

## 1.x - 2026-05-31

- Two models: synchronous, or asynchronous geo-replication with a master/secondary
  topology, geo-replication sessions and promoteRegion failover. Deprecated.
- Clusters deployed by 1.x in asynchronous mode still work, but the 2.x day-2 add-ons do
  not manage them because they assume the synchronous model. Redeploy with 2.x or later.

[3.1]: https://github.com/stackharbor-devops/glusterfs-multi-region/releases/tag/v3.1
[3.0]: https://github.com/stackharbor-devops/glusterfs-multi-region/releases/tag/v3.0
[2.6]: https://github.com/stackharbor-devops/glusterfs-multi-region/releases/tag/v2.6
[2.5]: https://github.com/stackharbor-devops/glusterfs-multi-region/releases/tag/v2.5
[2.4]: https://github.com/stackharbor-devops/glusterfs-multi-region/releases/tag/v2.4
[2.3]: https://github.com/stackharbor-devops/glusterfs-multi-region/releases/tag/v2.3
