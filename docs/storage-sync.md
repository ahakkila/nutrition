# Storage sync and weight history: implementation spec

> **Follow-up:** [storage-sync-v2.md](storage-sync-v2.md) replaces the pull and push steps
> below with the change feed and batch writes.

This is the brief for adding two features to Rooted:

1. **Sync** of the saved weight and profile across the user's devices, through
   the self-hosted storage API at `https://storage.hakkila.fi`.
2. **Weight history:** one entry per day, kept locally and synced.

Decisions already made by the owner:

- A device gets its token from a **QR code** that opens the app with the token
  in the URL fragment. There is no token entry form.
- **No client-side encryption.** Values are stored as plain JSON.
- **Weight history is in scope.**
- The app stays **local-first**: everything works offline and without a token,
  exactly as it does today. Sync is an optional layer on top.

Keep the project's style: no dependencies, no build step, plain browser JS.

## The storage service

The server is the `datastorage` repo (`../datastorage`). Its README is the API
reference; the parts that matter here are:

- Base URL: `https://storage.hakkila.fi/v1`.
- Every request sends `Authorization: Bearer <token>`. Tokens look like
  `dst_` followed by 43 base64url characters.
- A token belongs to one app (`nutrition`) and one user. The server scopes all
  data to that pair, so the client never sends an app or user name.
- The server accepts browser requests only from registered origins. Production
  is `https://nutrition.hakkila.fi`.
- Records live in collections:
  - `GET    /collections/{c}/records/{key}`: one record, or 404.
  - `PUT    /collections/{c}/records/{key}`: body is any JSON value, with
    `Content-Type: application/json`. Returns 201 on create, 200 on replace.
  - `DELETE /collections/{c}/records/{key}`: returns 204.
  - `GET    /collections/{c}/records?after=&limit=200`: lists in key order.
    The response is `{"records": [...], "next": "<key>"}`. `next` is present
    only when there is another page; pass it as `after` to get that page.
- A record is
  `{"key", "value", "version", "createdAt", "updatedAt"}`. `version` is also
  the `ETag` header, for example `"3"`.
- Optimistic concurrency:
  - `If-Match: "<version>"` on PUT or DELETE fails with **412** if the record
    has changed since that version.
  - `If-None-Match: *` on PUT creates the record only if it does not exist yet,
    and fails with 412 otherwise.
- Errors are `{"error": "..."}`: 401 bad or revoked token, 403 origin not
  allowed, 412 version conflict, 413 value too large, 429 rate limited,
  507 record limit reached.
- Limits: 64 KiB per value, and a per-user record limit that the operator sets
  (it will be raised to 5000, roughly 13 years of daily entries).

The server's `updatedAt` is the time it received the write. Do **not** use it
to decide which edit is newer, because an offline edit can reach the server
hours after it was made. Every value carries its own client-side `updatedAt`
for that purpose (see the data model below).

## 1. Token intake (new file `storage.js`)

Load `storage.js` before `script.js` in `index.html`, and add it to
`APP_SHELL` in `sw.js`.

At startup, before anything else reads storage:

1. Parse `location.hash` as URL parameters. If it contains `storage-token`
   with a value matching `^dst_[A-Za-z0-9_-]{43}$`:
   - save it in localStorage as `rooted-storage-token`;
   - clear any per-token sync state from a previous token (versions, dirty
     flags);
   - remove the fragment with
     `history.replaceState(null, '', location.pathname + location.search)`,
     so the token does not stay in the address bar, history or shared links.
2. If the fragment holds a malformed token, remove the fragment anyway and
   show a short "This sync link is not valid" message.

The QR code encodes `https://nutrition.hakkila.fi/#storage-token=dst_…`.
Opening it in the installed PWA or the browser both work, since they share
the origin's localStorage.

Token handling rules:

- Never log the token, put it in a URL query string, or show it in the UI.
- On **401**, the token was revoked: delete `rooted-storage-token`, stop
  syncing, and show sync as off. Keep all local data.
- Add a **"Disconnect sync"** action in the sync status area. It removes the
  token and sync state and keeps local data.

## 2. Data model

### Remote

| Collection | Key | Value |
|---|---|---|
| `settings` | `current` | `{ "weight": 72, "profile": "balanced", "updatedAt": "2026-10-02T08:15:00.000Z" }` |
| `weights` | `YYYY-MM-DD` | `{ "weight": 72, "updatedAt": "2026-10-02T08:15:00.000Z" }` |

- `weight` is the validated whole number in kg, or `null` in `settings` if
  only a profile has been chosen.
- `profile` is a key of `profiles` in `script.js`.
- History keys use the device's **local** calendar date, formatted from
  `getFullYear()`, `getMonth()` and `getDate()`, not `toISOString()`, which is
  UTC. Date keys sort chronologically on the server.
- `updatedAt` is the client's ISO timestamp of the edit.

On reading, ignore remote values that fail validation (weight outside the
existing 30–250 whole-number rule, or an unknown profile) instead of applying
them.

### Local

Keep the existing keys, `rooted-weight` and `rooted-profile`, so current users
keep their data. Add:

- `rooted-settings-updated-at`: the ISO time of the last local settings edit.
- `rooted-weight-history`: a JSON object mapping date keys to
  `{ weight, updatedAt }`.
- Sync state, used only while a token is present:
  - `rooted-sync-versions`: a JSON object mapping `settings/current` and
    `weights/<date>` to the last known server `version`;
  - `rooted-sync-dirty`: a JSON array of those same names that still need
    uploading.

Keep the existing try/catch around storage access: localStorage can be
unavailable, and the app must keep working without it.

## 3. When data changes

Hook into the existing save points in `script.js`: `calculate()` with
`persist: true`, and the profile-only branch of the profile `change` handler.

- **Settings:** write `rooted-weight`, `rooted-profile` and
  `rooted-settings-updated-at` locally, then mark `settings/current` dirty.
- **History:** when a valid weight is saved, set today's entry in
  `rooted-weight-history` **only if the weight differs** from today's existing
  entry. Profile changes re-run `calculate()` with the same weight and must
  not touch history. Then mark `weights/<today>` dirty.
- If a token is present, start a sync (debounced by about one second).

## 4. Sync algorithm

Run a sync:

- on startup, if a token is present;
- after a local change (debounced);
- on the `online` event;
- when `visibilitychange` makes the page visible. A listener already exists
  for update checks; add to it.

Only one sync may run at a time. If another is requested while one runs, run
one more afterwards.

### Pull

1. `GET settings/current`.
   - If the remote `value.updatedAt` is newer than the local
     `rooted-settings-updated-at`: apply it locally, update the form and
     results with `calculate({ persist: false })`, and drop
     `settings/current` from the dirty list.
   - Always store the record's `version`.
   - A 404 means nothing is stored yet: mark `settings/current` dirty if there
     is local data.
2. List `weights` page by page (`limit=200`, following `next`). For each
   record, store its `version`. If the remote `value.updatedAt` is newer than
   the local entry's, or there is no local entry, take the remote entry and
   drop that key from the dirty list.
3. Mark every local history entry that has no remote record as dirty. This
   uploads history recorded before the device was linked.

### Push

For each dirty name:

- If a version is known, `PUT` with `If-Match: "<version>"`. Otherwise `PUT`
  with `If-None-Match: *`.
- On 200 or 201, store the returned `version` (from the body or `ETag`) and
  remove the name from the dirty list.
- On **412**, `GET` the record. If its `value.updatedAt` is newer, apply it
  locally and clear the dirty flag. Otherwise retry the `PUT` once with the
  new version.

### Errors

- **Network error or 5xx:** keep the dirty flags, show "Sync pending", and
  retry on the next trigger. Don't retry in a tight loop.
- **401:** see token handling above.
- **403:** the origin isn't registered. Show "Sync unavailable on this
  address", keep the token, and stop the current sync.
- **429:** stop the current sync and retry on the next trigger.
- **507:** the record limit has been reached. Show "Sync storage full" and
  keep local data.

## 5. Service worker (`sw.js`)

At the top of the fetch handler, after `requestUrl` is set, add:

```js
if (requestUrl.origin !== self.location.origin) return;
```

Today the worker answers cross-origin requests too, and when offline it falls
back to `caches.match()`, which has nothing for API calls. API responses must
never be cached. Google Fonts requests are not cached today either, so
skipping all cross-origin requests changes nothing for them.

Also add `./storage.js` to `APP_SHELL`.

## 6. UI

Keep it small and in the existing visual style.

- **Sync status:** shown in the footer, near the version.
  - With no token, show nothing, or a muted "Sync off".
  - With a token, show one of "Synced", "Syncing…", "Sync pending" or an error
    from the list above, followed by "Disconnect sync".
- **Weight history section:** below the results.
  - List date and weight, newest first. Show the last 30 entries, with a
    "Show all" toggle.
  - Optionally add a small inline SVG line chart of the shown range. No
    chart library.
  - Correcting a weight on the same day replaces that day's entry.
  - Deleting entries is **out of scope** for this version. Offline deletes
    would need tombstones; leave a note in the code.
- All new UI must be accessible: real buttons, labels, and `aria-live` for
  the sync status.

## 7. Local development

Run datastorage locally from `../datastorage`:

```bash
make run    # serves on http://127.0.0.1:8091 with ./dev.db
DATABASE_PATH=dev.db go run ./cmd/datastorage app add --name nutrition --origin http://localhost:5500
DATABASE_PATH=dev.db go run ./cmd/datastorage token create --app nutrition --user me
```

Serve nutrition on `http://localhost:5500` with any static server. Choose the
API base in `storage.js` by hostname: on `localhost` or `127.0.0.1` use
`http://127.0.0.1:8091/v1`, and otherwise the production URL. Link a device by
opening `http://localhost:5500/#storage-token=<token>`.

Use two browser profiles to test sync between two devices.

## 8. Acceptance checklist

- [ ] With no token, behaviour is unchanged, apart from the new history section.
- [ ] Opening the app with `#storage-token=…` stores the token and leaves a
      clean URL.
- [ ] A change on device A appears on device B after B regains focus.
- [ ] Editing on both devices while offline and then reconnecting gives the
      newer edit (by client `updatedAt`) on both, and loses no history entries.
- [ ] History recorded before linking is uploaded on the first sync.
- [ ] Revoking the token (`token revoke` on the server) turns sync off with
      data kept.
- [ ] Offline app start still works, and there are no console errors from API
      calls.
- [ ] The token never appears in console output, the URL after load, or the
      DOM.

## 9. Docs and release

### Implemented refinements in 0.4.1

The owner's subsequent request to reduce unnecessary syncing adds these changes:

- Saving identical settings does not advance `updatedAt` or mark settings dirty.
  A saved weight on a new day still creates that day's history entry even when
  settings are unchanged. Profile-only changes still leave history alone.
- GET settings uses `If-None-Match` when a local value and known version exist;
  a 304 means no settings value needs downloading or applying.
- First history sync uses bulk values. Once versions are known, history pages
  use `values=false`; unchanged entries are skipped and new or changed entries
  are read individually. This also detects corrections to earlier dates.
  There is no API cursor for updates, so every metadata page is still checked.
- `rooted-sync-last-success` stores the time of the last completed sync with no
  remaining dirty records. It is shown separately from current sync status and
  cleared when disconnecting or linking a token.
- Failed localStorage access shows a separate warning while the app continues
  in memory. A successful remote sync does not hide this persistence warning.

### Original 0.4.0 release instructions

- README: add a "Sync across devices" section. It should say that a token QR
  code comes from the storage operator (`./admin token create ... --qr` in datastorage), how to
  open it, and how to disconnect.
- `docs/deployment.md`: replace "There is no server-side user data to back
  up" with a pointer to datastorage, which backs the data up daily.
- Bump the version to `0.4.0` and run `node revision.js` before committing.

## Operator steps outside this repo (done in datastorage)

```bash
./admin app add --name nutrition --origin https://nutrition.hakkila.fi --max-records 5000
./admin token create --app nutrition --user aki --label 'pixel phone' --qr   # prints the QR code
```
