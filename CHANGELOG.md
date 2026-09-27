# Changelog

What changed in each version of the package, newest first. Releases are tagged `vX.Y`
on the main branch.

## 3.2 - Unreleased

Backup add-on rebuilt (add-on version 2.0), plus fixes to the region add-ons.

- **Removable and reinstallable.** The backup add-on is now a normal card on the
  storage layer with **Uninstall**. Uninstalling keeps the cluster and the backup
  repository, and reinstalling continues in it. New **Delete All Backups** clears the
  repository after a typed confirmation.
- **Scheduled by the platform,** so every run appears in the Tasks log. The old node
  crontab was invisible. Failures turn the entry red and can send an e-mail.
- **Backup Now no longer fails** while a scheduled backup runs. Jobs run detached under
  one lock: manual backups queue, scheduled ones skip with a message, and a job that
  hangs is reported loudly. Restores are never queued. Long jobs continue in the
  background and report later. Uninstall refuses while a restore is running.
- **Restores land in the right place** (`restic restore <id>:/data`). They need restic
  0.17 or later and a target inside the volume, and a failed restore says the target may
  be partly restored. The runner is pinned by checksum at Configure, so repository
  changes only reach a cluster's restore code through Configure > Save.
- **New actions:** Backup Status, and Restore with a snapshot picker. Snapshots that
  could not read every file are marked INCOMPLETE and rotated separately.
- **Fixed in the old add-on's behaviour:** a failed `restic backup` was reported as
  success; an unmounted volume could be backed up as an empty directory and rotate good
  snapshots out; restores into `/data` landed in `/data/data/...`; retention leaked per
  hostname; `prune` ran every hour; Verify collided with running backups.
- **Cluster parameters repaired.** The old add-on overwrote the cluster parameters when
  the backup storage was in the first region, which broke Add Region, Forget Region and
  Add Capacity Slice. It no longer writes them, and those add-ons rebuild damaged
  parameters from the live cluster (`scripts/loadClusterGlobals.js`).
- **Remove Region / Forget Region:** a refused `remove-brick` was reported as success,
  and Forget Region could then delete an environment whose bricks were still in the
  volume. The step now fails, and an environment is only deleted when the volume's brick
  list could be read and none of its nodes holds a brick. Add Region sizes a new region
  from the volume's live bricks per region, also on a volume reduced to one region
  (replica 1), and stops before creating anything when the region environments do not
  match the volume's regions.
- **Backup storage outages are reported, not hidden.** If the backup storage stops
  answering while still mounted, Restore, Backup Status and Delete All Backups say it is
  unreachable instead of "no snapshots" or "deleted". A dead GlusterFS client mount is
  refused. A stuck backup job is detected by a heartbeat and reported within about a day,
  whatever the schedule.
- **Safer Uninstall and Configure.** Configure shows its warnings. Uninstall never
  unmounts the backup storage from a node it could not confirm is idle. The pinned
  runner survives container redeploys. After updating, open Configure and click Save so
  the cluster pins the new runner (2.3.0).
- **Upgrade:** new clusters get the add-on on the `storage` layer. Existing clusters
  import the new `addons/backup.jps` onto the storage layer of the environment that has
  the old Backup card. It removes the old version and keeps the snapshots.

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
