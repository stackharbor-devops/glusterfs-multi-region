# Contributing

Thanks for helping. Bug reports, testing on your own platform, ideas and pull requests
are all welcome. This file explains how the package fits together and how to test a
change safely.

## Ways to help

- **Test it.** Deploy a cluster, add and remove regions, fail a region, restore a backup,
  and tell us what happened. Real-world runs on different hosters are the most useful
  contribution right now.
- **Report bugs** with the *Bug report* issue form. The Tasks log output of the failing
  step is the single most useful thing to include.
- **Suggest features** or roadmap priorities with the *Feature request* form.
- **Send a pull request.** For anything larger than a small fix, open an issue first so
  we can agree on the approach.

## How the package is put together

- `manifest.jps` is the installer. It creates one environment per region and then runs
  `scripts/syncClusterManager.jps`, which builds the volume across all regions.
- `addons/*.jps` are the cards that appear on the storage layer after install: Manage
  Cluster, Add Region, Forget Region, Add Capacity Slice, Backup/Restore, native FUSE.
- `scripts/` holds the shared logic the manifests call.
- The README describes the behaviour; `CHANGELOG.md` lists what changed per version.

## Testing a change on a platform

Every `.jps` file has a `baseUrl` that points at the **main** branch, and the platform
loads every other file from that URL. So a manifest imported from your branch would
still run the scripts from main. To test a branch:

1. Push your branch (to your fork or to this repository).
2. In the branch only, change every `baseUrl` from `.../glusterfs-multi-region/main` to
   your branch (and your fork's owner, if you use a fork). Commit that as a separate
   commit named "TEST BRANCH ONLY".
3. Import `https://raw.githubusercontent.com/<owner>/glusterfs-multi-region/<branch>/manifest.jps`
   (or the single add-on you changed) on a test account.
4. Before the pull request is merged, drop the "TEST BRANCH ONLY" commit. The automatic
   check warns while a `baseUrl` does not point at main.

`raw.githubusercontent.com` caches files for about five minutes. To be sure the platform
gets your latest push, use the commit id instead of the branch name in the URL.

## Before you open a pull request

Run the same check that runs automatically on every pull request:

```bash
pip install pyyaml
python3 .github/scripts/check.py
```

It needs Python 3, Node.js and bash. It checks that every `.jps` is valid YAML, that the
JavaScript in `script:` blocks and `scripts/**/*.js` parses, that shell scripts parse,
and the rules below.

## Rules that have bitten us before

- **No shell `${VAR}` inside `cmd` bodies of `.jps` files.** The platform treats `${...}`
  as its own placeholder and replaces it. Write `$VAR`. Only real placeholders such as
  `${globals.x}`, `${settings.x}`, `${env.x}` and `${nodes.x}` may use braces. This also
  applies to comments inside `script:` blocks.
- **Forms that launch an action need `submitUnchanged: true`**, or the Run button stays
  disabled until the user changes something.
- **Dialog `markup:` is plain text.** HTML is shown literally.
- **Only one `regionlist` field per form.** A second one silently breaks the dialog.
- **Never write the `globals` node-group data key from an add-on.** It holds the
  cluster's parameters, which the day-2 add-ons depend on. Use a key of your own.
- **Long node work must run detached.** A dashboard button gives up after about 19
  minutes, and a single command on a node is stopped after about an hour.
- **Replication stays on the private network.** Traffic between regions goes over GRE.
  Please do not add public routing or `auth.allow` restrictions. Access is controlled by
  the platform's network isolation and the storage firewall.

## Versions and the changelog

- Bump `version:` in `manifest.jps`, and in each add-on `.jps` you changed.
- Add an entry at the top of `CHANGELOG.md`: what changed, and why a user would care.
- Releases are tagged `vX.Y` on main.

## License

By contributing you agree that your contribution is licensed under the MIT License in
`LICENSE`.
