# Security policy

## Reporting a vulnerability

Please do not report security problems in public issues.

Report them privately through GitHub:
[Security > Report a vulnerability](https://github.com/stackharbor-devops/glusterfs-multi-region/security/advisories/new).
Include what an attacker could do, the affected version or commit, and steps to reproduce.
You should get a reply within a few working days.

## Scope

In scope: this package's JPS manifests, scripts and add-ons, for example a way to reach
the volume from outside the platform's network isolation, a command injection through
an add-on form, or backup data exposed to another environment.

Out of scope: vulnerabilities in GlusterFS, restic or the Virtuozzo Application Platform
itself. Report those to their maintainers.

## Security model, in short

The volume is reachable only over the platform's private network. Replication between
regions runs over GRE tunnels. GlusterFS `auth.allow` is left open on purpose: who may
mount is controlled by the platform's network isolation and the storage firewall. See
the Networking section of the README.
