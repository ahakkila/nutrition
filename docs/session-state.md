# Session handoff — 2026-10-04

Read this file first when resuming work on Rooted. The latest user request was
to record unfinished topics for the next session; there is no outstanding implementation
request or permission to issue production credentials.

## Current release

- Production: https://nutrition.hakkila.fi/ on the shared hakkila.fi VPS.
- Operator reported deployment of `0.5.0`. Public verification confirmed
  `version.json` version `0.5.0`, build timestamp `20261002231512`, and the
  change-feed, batch-write and bootstrap checkpoint code in `storage.js`.
- Local `version.json` has timestamp `20261002231353`. This difference is
  expected: deployment stamps a copy of the public assets, not the source tree.
- The operator previously confirmed `0.4.0` installed on a phone, with an
  active token and successful sync. Authenticated device sync on `0.5.0` has
  not been independently verified. Public asset checks do not prove API sync.

## Architecture and implemented behavior

- Dependency-free static HTML/CSS/JS; no build step, app server or container.
- `storage.js` loads before `script.js`. It consumes QR-link
  `#storage-token=…`, stores a validated bearer token locally, clears the URL
  fragment, and implements optional local-first sync. Never print real tokens.
- API: `https://storage.hakkila.fi/v1`; on localhost/127.0.0.1 it uses
  `http://127.0.0.1:8091/v1`. Server source/reference: `../datastorage`.
- Settings retain the existing weight/profile localStorage keys. Daily history
  is keyed by the local calendar date; same-day corrections replace that entry.
  Profile-only changes leave history alone. No-op saves do not upload or change
  edit timestamps. History shows 30 entries with a Show all toggle. Deletes
  remain out of scope because offline deletion requires tombstones.
- `0.5.0` replaces the `0.4.1` metadata checks and individual writes with
  `/changes?since=<cursor>&limit=200` and `/batch` (up to 100 writes).
  Unchanged sync uses one request. Server versions provide conditional writes;
  client value timestamps decide which edit is newer. One conflict retry round
  uses another change-feed pull and batch push. Edits during an upload stay dirty.
- `rooted-sync-bootstrap-pending` persists local names not yet seen during
  initial paging; after the final page, missing names are queued for upload.
  This survives an interrupted first sync and reload.
- Checkpoints persist data, versions/dirty flags, bootstrap progress, then the
  cursor. A failed prerequisite prevents a durable cursor advance. Settings
  timestamps are saved only when both weight and profile writes succeed.
- Disconnect/revocation keep local data and clear token-specific sync state.
  Session guards prevent stale in-flight responses from applying after disconnect.
- Footer shows sync status, last successful sync and a separate local saving
  warning. Offline/5xx/429 show Sync pending; 403 shows origin unavailable;
  507 shows storage full; 401 disconnects. Sync triggers on startup, changed
  saves (debounced), online and visible-page events. No tight error retry loop.
- The service worker excludes cross-origin requests; API responses are never
  cached. `storage.js` is in the offline shell and deployment allowlist.

## Deployment

- `make provision`, `make deploy`, `make verify`, `make rollback`.
- Machine-specific config: `~/.config/vps-deploy/nutrition.env`, copied from
  `deploy.conf.example`; do not commit the actual settings or credentials.
- Existing layout uses admin SSH `hakkila.fi`, deploy SSH
  `nodejs@hakkila.fi`, `/var/www/nutrition`, nginx and Certbot. Provisioning
  needs interactive sudo; ordinary deploys use rsync and an atomic release
  symlink switch without sudo. Only explicit public assets are uploaded.
- datastorage must have its v2 endpoints deployed before this client; no server
  code was modified by this nutrition task. Production server endpoint behavior
  has not been tested with an authenticated token by the agent.
- datastorage operator command: `./admin token create ... --qr`.
  Daily database backup operations belong to datastorage, not the static host.
- GitHub Pages was not disabled by the agent; its current setting is unverified.

## Validation and workspace state

- Phone check reported by the user (2026-10-04): otherwise working so far
  after the installation/version/appearance checklist. Multiple-entry history
  could not be checked because there are not yet multiple entries. Offline
  operation and persistence across closing/reopening have not been tested.
  This report does not verify linked-device sync.

- Last `make check test` (2026-10-04): syntax checks passed; all 49 tests
  passed (45 storage tests, 4 UI integration tests). `git diff --check` passed.
- Tests use an in-memory API implementing sequences, pagination, conditional
  batch writes and per-write statuses. They cover large backlogs, mixed conflicts,
  interrupted bootstrap across reload, each checkpoint write failure, partial
  settings saves, malformed responses, revocation, offline convergence and UI.
- Browser automation was unavailable: discovery returned no browsers and both
  Chrome and in-app tab creation failed. The user's phone report above is the
  available manual evidence; no need to repeat automated checks absent changes.
- Release implementation, deployment tooling, tests and docs were committed
  and pushed to `origin/main` on 2026-10-04: `27e9e37` ("Add local-first weight
  history sync and VPS deployment"). The worktree was clean after pushing.
  This handoff update is a subsequent documentation change; check git status
  before assuming it has been committed. A Git push does not deploy to the VPS.
- Repository documentation review (2026-10-04): historical sync specs are now
  explicitly labeled, implemented v2 test criteria are checked, and revision
  stamping/local serving instructions match the tooling. No runtime changes
  were needed. Deployment observations retain their original dates; this review
  did not recheck live hosting or GitHub Pages settings.
- A temporary local port-5500 server used during implementation was stopped.
- Sandbox network/DNS attempts fail here. Important network checks should be
  retried using normal tool escalation, not reported as a production outage.

## References / next steps

Start a new session by reading this handoff and checking `git status` and the
latest commit. Recap the current release and the open items below; do not treat
historical deployment checklists or unchecked v2 spec boxes as unfinished code.

### Open topics

- Phone offline operation and persistence across closing/reopening have not
  been tested. The user has received a checklist; await their results or a
  request to continue verification.
- Multiple-entry history display has not been manually checked because the
  user does not yet have multiple entries. Check naturally once entries exist;
  automated history rendering tests already pass.
- GitHub Pages status and whether to retire the old site remain unresolved.
  Do not disable it without a user request. VPS hosting is already live.
- Certificate renewal dry run and an actual rollback exercise are listed in
  the deployment runbook, but completion has not been recorded. These are
  operator verification topics, not reported failures.
- No new feature implementation is requested. Daily history deletion remains
  outside the implemented scope; it would require offline deletion tombstones.

- User preference (2026-10-03): linked-device verification is deferred to the
  backlog. Do not suggest it in routine recaps or next-step plans; mention it
  only when the user specifically asks for missing features.

- Original spec: [storage-sync.md](storage-sync.md).
- v2 spec and implemented safeguards: [storage-sync-v2.md](storage-sync-v2.md).
- Deployment history/runbook: [deployment.md](deployment.md).
- Linked-device verification backlog: real two-device/offline behavior and
  authenticated v2 API access remain unverified. Preserve existing phone tokens
  and user data; do not issue or revoke tokens or mutate production records just
  for testing. Apply the user preference above when suggesting future work.
- Otherwise wait for the next user task. The requested implementation and
  deployment handoff are complete.
