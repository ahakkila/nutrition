# VPS migration plan

## Existing deployment paradigms

Inspected on 2026-10-02:

| Projects | Deployment | Runtime |
| --- | --- | --- |
| doganatomy, booking, vibe-strategy | Project scripts and shared deploy-tools, SSH/rsync, nginx and Certbot | Node processes behind nginx |
| poll-scheduler, datastorage | Make targets, external `~/.config/vps-deploy/*.env`, separate admin/deploy SSH accounts | Go binaries, systemd, nginx reverse proxy |
| nutrition | Branch-based GitHub Pages documented; no Actions workflow | Static HTML/CSS/JS, installable offline PWA |

Live inspection confirmed the shared VPS has nginx, Certbot, an active renewal
timer and the `nodejs` deployment account. The admin login requires a sudo
password. Datastorage's local configuration exists, but its nginx site and app
directory were absent from the inspected server; local configuration alone is
not evidence of deployment.

## Chosen design

Use nginx static serving, following the external configuration and Make targets
used by the recent Go projects. A Node runtime or container would add maintenance
without providing functionality. The generic deploy-tools bootstrap targets
process-based apps; this project's small provisioner handles static releases.

The proposed hostname is `nutrition.hakkila.fi`, with `/var/www/nutrition`
owned by the existing `nodejs` account. Hosts and email are set locally rather
than embedded in deployment scripts. Admin SSH is needed only for provisioning;
ordinary deploys and rollback require no sudo or nginx reload.

Only HTML, CSS, browser JS, the manifest, icons and version metadata are uploaded.
Files go into `releases/<timestamp>-<commit>-<random>/`. A locked atomic rename
switches `current`; `previous` records the prior target. Failed uploads never
change `current`. Public version verification follows activation; a verification
failure reports an error and leaves the release available for inspection and
explicit rollback. The commit label may include uncommitted working-tree content:
deployment publishes the current files, so check `git diff` before release.

Nginx returns 404 for missing files instead of substituting HTML for missing JS.
Assets revalidate, version metadata uses `no-store`, and each release gets a new
service-worker cache name. The PWA's relative paths already support hosting at
the domain root. No application code change is required for the new origin.

References: [nginx static serving](https://docs.nginx.com/nginx/admin-guide/web-server/serving-static-content/)
and [Certbot webroot and renewal hooks](https://eff-certbot.readthedocs.io/en/stable/using.html).

## Cutover

1. Create an A record for the chosen hostname using the current VPS address.
   Add AAAA only if IPv6 reaches this VPS. Live inspection found no DNS record
   for `nutrition.hakkila.fi`; the VPS hostname resolved to `38.143.19.216`.
2. Copy `deploy.conf.example` to `~/.config/vps-deploy/nutrition.env` and fill
   in `ADMIN_HOST`, `DEPLOY_HOST`, `DEPLOY_DIR`, `DOMAIN`, and `CERT_EMAIL`.
   Use `hakkila.fi`, `nodejs@hakkila.fi`, and `/var/www/nutrition` to follow
   the existing accounts/layout. Supply the certificate contact email.
3. Run `make check`, then `make provision` from an interactive terminal.
   The provisioner creates only this app's directories and nginx site, checks
   nginx before reload, obtains a dedicated certificate using webroot, and
   enables the existing Certbot renewal timer. Ensure TCP 80/443 are reachable.
4. Run `make deploy` and `make verify`. Check the calculator, fonts, icons,
   manifest, version footer, installation and offline use on the new URL.
   Test `make rollback` after a second deployment. From the server run
   `sudo certbot renew --cert-name <domain> --dry-run` to validate renewal.
5. Keep GitHub Pages available during verification. After the VPS works,
   update bookmarks and shared links and disable Pages under repository
   Settings → Pages. Existing installed apps and offline caches may continue
   to open the old URL; reinstall at the new origin and re-enter weight/profile.
   Disabling Pages does not delete installed service workers or browser data.

## Operations

`make deploy` publishes local files; a Git push alone does not deploy. This
matches the neighboring projects' manual workflow and needs no GitHub SSH
secrets. CI deployment can be added separately if desired.

`make rollback` swaps the current and previous releases, so a second rollback
switches back again. Releases are not automatically deleted; monitor disk usage
and remove only inactive releases, preserving the targets of both symlinks.
Do not modify active releases in place. Optional synced user data lives in datastorage,
which takes daily database snapshots; see [its backup operations](../../datastorage/README.md#administration)
for fetching and restoring backups. Nginx's standard access/error logs and
`make verify` cover basic checks.

If nginx rejects a generated config, the prior site file is restored. If
certificate issuance fails on first setup, the HTTP challenge site remains for
a retry; other nginx sites are untouched. Provisioning assumes the same Debian/
Ubuntu nginx layout and installed tools as the inspected VPS.

## Execution status

Provisioning and deployment were completed by the operator on 2026-10-02.
Public verification confirmed `https://nutrition.hakkila.fi/` is reachable with
a valid HTTPS certificate and serves version `0.3.7`, timestamp `20261002194822`.
HTTP redirects to HTTPS, version metadata uses `no-store`, the service worker
uses `no-cache`, and missing assets return 404.

Phone installation/offline checks and a certificate renewal dry run remain
operator checks before retiring the old site. GitHub Pages has not been disabled
by this migration tooling.

Version `0.4.0` adds optional datastorage sync and local daily weight history.
Run `make check test` before deploying it; the deployment allowlist and offline
app shell now include `storage.js`. The storage operator must register the
production origin and issue per-device QR token links as described in
[storage-sync.md](storage-sync.md). This release does not change datastorage's
app registration or issue credentials; use datastorage's
`./admin token create ... --qr` operator command for device links.

Automated tests cover local-only use, QR-fragment intake, offline convergence,
conditional-write conflicts, pagination, revocation, disconnect during requests,
storage failures, status errors, local calendar dates, form integration, history
expansion, and excluding API calls from the service worker. Actual two-browser
and phone installation/offline checks remain manual verification; no browser
surface was available during implementation. The operator subsequently confirmed
version `0.4.0` was installed on a phone with an active token and successful sync.

Version `0.4.1` improves sync without requiring changes to datastorage: unchanged
saves do not advance edit timestamps or enqueue uploads, settings reads use
`If-None-Match`, and history checks use `values=false` metadata after bootstrapping.
Only entries with a new version or missing local value are fetched individually.
Version checks cover corrections to old dates, not just entries with later date
keys. A history change cursor is not supported by the API, so metadata pages
are still read at each sync. The footer also shows the last successful sync and
reports local storage failures separately from connection status. Run
`make check test` before future deployments.

The operator deployed `0.4.1` on 2026-10-02. Public verification confirmed
version `0.4.1`, build timestamp `20261002225847`, with the conditional-read
and unchanged-save logic in `storage.js` and the new footer elements in HTML.
This verifies deployment assets; authenticated phone sync behavior was not
tested by the public checks.

Version `0.5.0` uses change-feed pulls and batch uploads.
No server code changes are needed beyond the v2 endpoints already implemented
in datastorage, but that server release must be deployed before this client.
See [storage-sync-v2.md](storage-sync-v2.md) for the API and client safeguards.
First sync after upgrading bootstraps a cursor; subsequent unchanged syncs
make one request. Do not deploy the new client against the older storage API.

The operator deployed `0.5.0` on 2026-10-02. Public verification confirmed
version `0.5.0`, build timestamp `20261002231512`, and the v2 sync code in the
served assets. Authenticated device sync has not been independently verified
for this release. See [session-state.md](session-state.md) for the complete
handoff, workspace state and remaining manual checks.
