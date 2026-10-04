# Storage sync v2: change feed and batch writes

This is a follow-up to [storage-sync.md](storage-sync.md). Sync already works.
This change makes it cheaper, using two new datastorage endpoints. Behaviour
for the user stays the same.

## Why

`storage.js` today:

- **`pull()`:**
  - `GET`s `settings/current`;
  - pages through the whole `weights` collection, values or metadata only;
  - then `GET`s every record whose version changed, one request each.
- **`push()`:** one `PUT` per dirty record.

So a first sync, or a device that was offline for a while, makes one request
per record. That grows with history, and nginx allows each client address a
burst of 60 requests and then 120 a minute. A large backlog gets `429`s and
stays at "Sync pending".

With this change:

- a sync that finds nothing new costs **one request**;
- a pull costs **one request per 200 changed records**;
- a push costs **one request per 100 dirty records**.

## The new endpoints

The full reference is in `../datastorage/README.md`, under Syncing.
**Deploy datastorage first:** the live server needs these endpoints before
this client ships.

### `GET /v1/changes?since=<cursor>&limit=200`

```json
{"changes": [{"collection": "weights", "key": "2026-10-02", "value": {"weight": 72, "updatedAt": "..."},
              "version": 1, "seq": 41, "createdAt": "...", "updatedAt": "..."}],
 "cursor": 41, "more": false}
```

- Returns this user's records written after `since`, oldest write first,
  across all collections. Start with `since=0`.
- Keep the returned `cursor` and send it as `since` next time. While `more`
  is true, request again straight away with the new cursor.
- A record updated again shows up again, with its latest value.
- Deletions do not appear. Rooted never deletes, so this doesn't matter yet.
- The cursor is an opaque non-negative integer. Don't do arithmetic on it.

### `POST /v1/batch`

The request needs `Content-Type: application/json`:

```json
{"writes": [
  {"collection": "weights", "key": "2026-10-02", "value": {...}, "ifNoneMatch": "*"},
  {"collection": "settings", "key": "current", "value": {...}, "ifMatch": 3}
]}
```

- A batch holds at most **100 writes** and **1 MiB**.
- `ifMatch` (a version number) and `ifNoneMatch: "*"` mean the same as the
  headers `push()` sends today.
- The response is 200 with one result per write, in the same order. Each
  result carries the status a single `PUT` would have returned:

```json
{"results": [
  {"collection": "weights", "key": "2026-10-02", "status": 201, "version": 1, "seq": 42, "updatedAt": "..."},
  {"collection": "settings", "key": "current", "status": 412, "error": "..."}
]}
```

- One write failing does not stop the others.
- The whole request fails only with 400 (malformed body, empty batch or over
  100 writes) or 413 (over 1 MiB). It can also fail with the usual 401, 403,
  429 and 5xx.

## Changes to `storage.js`

### New local state

- `rooted-sync-cursor`: the last `cursor` from `/changes`, as a string.
  - Add it to `keys`.
  - `clearSyncState()` must remove it. A new token or a disconnect starts
    over from `since=0`.
- Keep `rooted-sync-versions`, which `ifMatch` still needs, and
  `rooted-sync-dirty`.

### `request()`

`request()` currently builds collection paths from `name`. Let it take a
path instead:

- `pull` uses `/changes?since=…&limit=200`;
- `push` uses `/batch`;
- the single-record helpers are no longer needed.

Keep everything else it does: the session guard, the abort controller, the
15-second timeout, `cache: 'no-store'`, and never putting the token anywhere
but the `Authorization` header.

### `pull(id)`: replace with a change-feed loop

```text
cursor = read(rooted-sync-cursor) or 0
bootstrap = (no cursor stored)
seen = new Set()
loop:
    page = GET /changes?since=cursor&limit=200
    validate page:
        changes is an array
        cursor is a non-negative integer >= the cursor sent
        more is a boolean
    for each change:
        name = collection + "/" + key
        skip unless name is "settings/current"
            or (collection is "weights" and validDate(key))
        seen.add(name)
        merge(name, change)       // the existing merge(), unchanged
    cursor = page.cursor
    write rooted-sync-cursor = cursor, after each page so progress survives a cut
    until page.more is false
if bootstrap:
    for each local history date and for settings (if set):
        if name not in seen: delete versions[name]; mark(name)
persistSync()
```

- `merge()` already compares the client `updatedAt` values and marks the
  local side dirty when it is newer. Keep it as it is.
- The `settings/current` 404 and 304 handling goes away: a record that does
  not exist simply never appears in the feed.
- The bootstrap step replaces today's "local entry has no remote record, so
  mark it dirty". It must run only when the pull started from `since=0`. On
  an incremental pull, "not seen" just means "not changed".
- A device upgrading from v1 has no cursor, so its first sync is a bootstrap.
  That is correct and needs no migration code.

### `push(name, id)`: replace with a batch push

```text
pushDirty(id):
    names = [...dirty], in chunks of 100
    for each chunk:
        writes = names with a local value
            (a name with no local value: drop it from dirty, as today)
        each write:
            versions[name] known → ifMatch: versions[name]
            otherwise            → ifNoneMatch: "*"
        snapshot each value (JSON.stringify), as today
        response = POST /batch { writes }
        check results.length === writes.length,
            and each result's collection/key match its write
        for each result:
            200 or 201: versions[name] = result.version
                        if the local value still equals its snapshot: dirty.delete(name)
                        else: requested = true     // edited during upload
            412: conflict = true
            507: storageFull = true                // the name stays dirty
            400 or 413: a client bug; the name stays dirty
                        console.warn the status and error, never the token
        persistSync()
    return { conflict, storageFull }
```

### `sync()`: pull, push, then settle conflicts with one more pull

```text
await pull(id)
let result = await pushDirty(id)
if result.conflict:
    await pull(id)          // the feed now holds the newer remote write;
                            // merge() takes it or keeps the local edit dirty
    result = await pushDirty(id)   // second and last round
guard(id)
status:
    result.storageFull → "Sync storage full"
    dirty.size > 0     → "Sync pending"
    otherwise          → "Synced"
```

- There is no per-record `GET` after a 412. The next pull brings the
  conflicting record, because its `seq` is past our cursor.
- Our own successful writes also come back in the next pull. `merge()` sees
  equal `updatedAt` values and changes nothing except the stored version,
  which is fine.
- Error handling for the whole request (401 disconnects; 403, 429, 5xx and
  network errors show their existing messages) stays as it is.

### Unchanged

- token intake, the fragment, `disconnect()` and the UI;
- the data model and value validation;
- the debounce and triggers: startup, edits, `online`, `visibilitychange`;
- the service worker. `/v1/batch` is a cross-origin `POST`, which `sw.js`
  already ignores. The browser now sends a CORS preflight for `POST`, and the
  server allows it.

## Tests (`tests/storage.test.cjs`)

Update the fake server to serve `/changes` and `/batch` with the semantics
above:

- a global `seq` counter bumped on every write;
- `/changes` returns records with `seq > since`, ordered by `seq`, paged by
  `limit`;
- `/batch` returns per-write statuses.

Cover these cases:

- [ ] A first sync with 250 remote history entries uses two `/changes`
      requests, not 250 `GET`s.
- [ ] A first sync with 150 local-only history entries uploads them in two
      `/batch` requests and leaves no dirty names.
- [ ] A sync with nothing new makes exactly one request, `/changes`, and no
      `/batch`.
- [ ] A 412 on one write in a batch:
  - other writes in the batch are still applied;
  - a second pull and push resolves it;
  - a newer remote value wins, and a newer local value is re-uploaded with
    the new version.
- [ ] A local edit made while a batch is in flight stays dirty and is sent on
      the next run.
- [ ] A result with 507 shows "Sync storage full" and keeps the name dirty.
- [ ] Disconnecting or a new token clears `rooted-sync-cursor`, so the next
      sync starts from 0.
- [ ] Cut the connection between `/changes` pages. The cursor already stored
      is valid, and the next sync continues from it without losing changes.
- [ ] Malformed responses are rejected without changing local data: a
      `cursor` lower than `since`, a missing `changes` array, or a results
      array of the wrong length.

## Release

### Client implementation safeguards

Two review issues are resolved in the client without changes to the server:

- `rooted-sync-bootstrap-pending` stores local record names not yet seen during
  the initial pull. It is saved with every page before the cursor, so an
  interrupted bootstrap resumes with this set intact. After the final page,
  remaining names are marked dirty before bootstrap is recorded as complete.
  `null` means complete; an array (including an empty one) means in progress.
  Token replacement and disconnect clear both cursor and bootstrap state.
- Checkpoint writes are ordered: local data, versions and dirty flags,
  bootstrap state, then cursor. A failure in any prerequisite prevents saving
  the cursor. The app can continue in memory, with its existing local saving
  warning; a reload replays from the last durable cursor. Settings timestamps
  are saved only when both weight and profile writes succeed, preventing an
  incomplete settings save from claiming the newer edit's timestamp.

Feed page metadata and relevant record versions are validated before applying
the page. A `more: true` response must advance its cursor. Every batch result
is validated before any successful result clears dirty state. Cursors and
versions must fit JavaScript's safe integer range. Server error text is not
logged, to avoid accidentally exposing credentials or stored values.

The release is prepared as `0.5.0`. Automated tests include reloads after a
cut between bootstrap pages, failed writes to every checkpoint component,
partial settings persistence, large history/backlog request counts, mixed batch
results and malformed responses. Actual authenticated production sync is a
separate device check after deployment.

- Bump the version to `0.5.0` (or the next minor) and run `node revision.js`.
- The order matters:
  1. `make deploy` in datastorage, so the database migrates and the endpoints
     go live.
  2. `make deploy` in nutrition.

  An old client keeps working against the new server, because the old
  endpoints are unchanged. A new client against the old server would get 404s
  and show "Sync pending".
