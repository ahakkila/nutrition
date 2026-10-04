# Rooted

A tiny, dependency-free nutrition calculator. Enter a weight in kilograms to see a simple daily baseline for calories, protein, fat, carbohydrates, and water.

For ongoing development, read [the session handoff](docs/session-state.md)
for the deployed release, implementation details and workspace state.

## Run locally

Open `index.html` in a browser. No installation or build step is required.

## Publish to the VPS

Rooted runs directly on the shared nginx VPS, with no Node server, container,
database, or systemd app service. See [the migration plan](docs/deployment.md)
for the comparison with neighboring projects and the cutover checklist.

Copy `deploy.conf.example` to `~/.config/vps-deploy/nutrition.env`, set the
hosts, deploy directory, domain and certificate email, and create the domain's
DNS record pointing to the VPS. Settings are literal `KEY=value` lines, without
quotes or shell expansion. Then run from a terminal:

```bash
make provision  # requires the admin account's sudo password
make deploy     # uses the unprivileged deploy account
make verify
make rollback   # switches back to the previous release if needed
```

Deployments upload only public assets into a new release directory and switch
the `current` symlink atomically. HTTPS is managed by Certbot. Each deployment
stamps its own version and service-worker cache; the source tree stays untouched.
Old releases are kept for rollback. Use `DEPLOY_CONFIG=/path/to/settings.env`
to override the settings file.

The current app version is shown in the footer as a semantic version and `YYYYMMDDhhmmss` build timestamp. Bump the version when a meaningful feature or behavior change is released; update the timestamp for each deployed build.

To create a timestamped revision, run the helper before committing:

```bash
node revision.js
git add .
git commit -m "Update app"
git push
```

The current revision can be checked directly in `version.json`.

## Sync across devices

Sync is optional: your weight, calculation profile and daily weight history
work locally and offline without an account link. Save a weight to record it
for today; correcting it replaces today's entry. History shows the latest 30
days with entries, with a "Show all" button for older entries.

Ask the storage operator for a token QR code (`./admin token create ... --qr`
in datastorage). Open the QR link on each device to
connect it. The link token is saved on the device and removed from the address
bar. Linked devices sync when you save, come online, or return to the app.
The newer edit wins if two devices change the same day's weight or settings.
Saving unchanged values causes no upload. Sync uses the storage service's
change feed to download only new or changed records, including corrections to
older dates. An unchanged sync is one request; downloads are paged in groups
of 200 and uploads are batched in groups of 100. Interrupted downloads resume
from saved progress. Local data and sync state are saved before the cursor,
so a local saving failure cannot skip downloaded records on the next launch.

Version `0.5.0` requires datastorage's `/v1/changes` and `/v1/batch` endpoints.
Deploy datastorage before deploying this version of Rooted. The first sync
after upgrading reads the existing remote records once to establish a cursor.

The footer shows the last successful sync time. If local saving is unavailable,
a separate warning explains that changes may be lost when the app closes.

"Disconnect sync" removes the device's token and sync state while keeping
its local data. It does not revoke the token or erase server records; ask the
operator to revoke a lost device's token. Synced values are plain JSON on the
self-hosted storage service at `storage.hakkila.fi`, which has daily backups.

For local sync development, follow [docs/storage-sync.md](docs/storage-sync.md)
to run datastorage on port 8091 and serve this app on localhost port 5500.
Run `make check test` for syntax checks and the dependency-free storage and UI
regression tests (Node.js 18 or newer).

## Install on a phone

Open the VPS site on your phone over its `https://` URL. On iPhone, use **Share → Add to Home Screen**. On Android, use the browser menu and choose **Install app** or **Add to Home screen**. The app includes offline support after the first visit. When moving from GitHub Pages, re-enter your saved weight and profile and reinstall the home-screen app: browser storage and service workers belong to the old origin.
