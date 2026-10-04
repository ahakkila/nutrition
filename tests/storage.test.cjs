const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('storage.js', 'utf8');
const TOKEN = `dst_${'a'.repeat(43)}`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const time = (hour) => `2026-10-02T${String(hour).padStart(2, '0')}:00:00.000Z`;

function server() {
  const records = new Map();
  const calls = [];
  let seq = 0;
  const api = { records, calls, error: 0, beforePut: null, pageSize: 200, beforeChanges: null, resultStatus: null };
  api.put = (name, value) => {
    const [collection, key] = name.split('/');
    records.set(name, { collection, key, value: clone(value), version: (records.get(name)?.version || 0) + 1, seq: ++seq });
  };
  const respond = (value, status = 200) => new Response(JSON.stringify(value), { status });
  api.fetch = async (url, init) => {
    calls.push({ url, ...init });
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(new URL(url).searchParams.has('storage-token'), false);
    if (api.error) return respond({ error: 'failure' }, api.error);
    const parsed = new URL(url);
    if (parsed.pathname === '/v1/changes') {
      if (api.beforeChanges) await api.beforeChanges(parsed);
      const since = Number(parsed.searchParams.get('since'));
      const entries = [...records.values()].filter((entry) => entry.seq > since).sort((a, b) => a.seq - b.seq);
      const page = entries.slice(0, Math.min(Number(parsed.searchParams.get('limit')), api.pageSize));
      return respond({ changes: page, cursor: page.at(-1)?.seq ?? since, more: entries.length > page.length });
    }
    assert.equal(parsed.pathname, '/v1/batch');
    assert.equal(init.method, 'POST');
    const writes = JSON.parse(init.body).writes;
    assert.ok(writes.length > 0 && writes.length <= 100);
    const results = [];
    for (const write of writes) {
      const name = `${write.collection}/${write.key}`;
      if (api.beforePut) await api.beforePut(name, write);
      const current = records.get(name);
      const forcedStatus = api.resultStatus?.(write);
      if (forcedStatus) results.push({ collection: write.collection, key: write.key, status: forcedStatus, error: 'rejected' });
      else if ((write.ifNoneMatch === '*' && current) || (write.ifMatch !== undefined && write.ifMatch !== current?.version)) {
        results.push({ collection: write.collection, key: write.key, status: 412 });
      } else {
        api.put(name, write.value);
        const record = records.get(name);
        results.push({ collection: write.collection, key: write.key, status: current ? 200 : 201, version: record.version, seq: record.seq });
      }
    }
    return respond({ results });
  };
  return api;
}

function device(api, { stored = {}, hash = '', blocked = false, hour = 10, failWrite = () => false } = {}) {
  const data = new Map(Object.entries(stored));
  const statuses = [];
  const renders = [];
  const timers = new Map();
  let timerId = 0;
  let clock = Date.parse(time(hour));
  const events = {};
  const context = {
    URLSearchParams, AbortController, Map, Set, console,
    location: { hostname: 'localhost', pathname: '/', search: '?view=guide', hash },
    history: { replaceState(_state, _title, url) { context.cleanURL = url; } },
    localStorage: {
      getItem(key) { if (blocked) throw Error('blocked'); return data.get(key) ?? null; },
      setItem(key, value) { if (blocked || failWrite(key)) throw Error('blocked'); data.set(key, value); },
      removeItem(key) { if (blocked) throw Error('blocked'); data.delete(key); },
    },
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    fetch: api.fetch,
    addEventListener(name, fn) { events[name] = fn; },
  };
  context.window = context;
  vm.runInNewContext(source, context);
  context.RootedStorage.init({ profiles: { balanced: {}, performance: {} },
    onData(value) { renders.push(clone(value)); },
    onHistory(value) { context.lastHistory = clone(value); },
    onStatus(value) { statuses.push(clone(value)); },
  });
  return { ...context.RootedStorage, data, statuses, renders, context, timers, events,
    clock(hour) { clock = Date.parse(time(hour)); },
    get settings() { return { weight: data.get('rooted-weight'), profile: data.get('rooted-profile') }; },
    get history() { return JSON.parse(data.get('rooted-weight-history') || '{}'); },
    get dirty() { return JSON.parse(data.get('rooted-sync-dirty') || '[]'); },
    get status() { return statuses.at(-1).message; },
  };
}
const linked = (api, options = {}) => device(api, { hash: `#storage-token=${TOKEN}`, ...options });

test('local-only saves keep daily corrections, profile changes preserve history', async () => {
  const api = server();
  const d = device(api);
  d.save(70, 'balanced');
  const date = Object.keys(d.history)[0];
  const stamp = d.history[date].updatedAt;
  d.clock(11);
  d.save(70, 'performance', { recordHistory: false });
  assert.equal(d.history[date].updatedAt, stamp);
  d.save(71, 'performance');
  assert.equal(Object.keys(d.history).length, 1);
  assert.equal(d.history[date].weight, 71);
  await d.sync();
  assert.equal(api.calls.length, 0);
  assert.equal(d.status, 'Sync off');
});

test('token intake strips fragment and clears stale versions; malformed links show an error', () => {
  const d = linked(server(), { stored: { 'rooted-sync-versions': '{"settings/current":99}', 'rooted-sync-dirty': '["settings/current"]' } });
  assert.equal(d.data.get('rooted-storage-token'), TOKEN);
  assert.equal(d.context.cleanURL, '/?view=guide');
  assert.equal(d.data.has('rooted-sync-versions'), false);
  assert.equal(d.status.includes(TOKEN), false);
  const bad = device(server(), { hash: '#storage-token=bad' });
  assert.equal(bad.context.cleanURL, '/?view=guide');
  assert.equal(bad.status, 'This sync link is not valid');
});

test('first linking uploads local history and profile-only settings', async () => {
  const api = server();
  const d = linked(api, { stored: { 'rooted-profile': 'performance', 'rooted-weight-history': JSON.stringify({ '2026-09-30': { weight: 72, updatedAt: time(9) } }) } });
  await d.sync();
  assert.equal(api.records.get('settings/current').value.weight, null);
  assert.equal(api.records.get('weights/2026-09-30').value.weight, 72);
  assert.equal(d.status, 'Synced');
});

test('two devices converge by client edit time and preserve separate history entries', async () => {
  const api = server();
  const a = linked(api, { hour: 10 });
  const b = linked(api, { hour: 11 });
  a.save(70, 'balanced'); b.save(75, 'performance');
  await b.sync(); await a.sync(); await b.sync();
  assert.deepEqual(a.settings, b.settings);
  assert.equal(a.settings.weight, '75');
  assert.equal(api.records.get('settings/current').value.weight, 75);
  api.put('weights/2026-09-29', { weight: 74, updatedAt: time(9) });
  await a.sync();
  assert.equal(Object.keys(a.history).length, 2);
});

test('pagination pulls all pages and ignores invalid remote values', async () => {
  const api = server(); api.pageSize = 1;
  api.put('settings/current', { weight: 999, profile: 'unknown', updatedAt: time(12) });
  for (const day of ['2026-09-28', '2026-09-29']) api.put(`weights/${day}`, { weight: 73, updatedAt: time(10) });
  api.put('weights/2026-09-30', { weight: 20, updatedAt: time(12) });
  const d = linked(api);
  await d.sync();
  assert.equal(Object.keys(d.history).length, 2);
  assert.equal(d.settings.weight, undefined);
  assert.equal(d.status, 'Synced');
  assert.equal(api.calls.filter((call) => call.url.includes('/changes')).length, 4);
});

test('412 newer remote edit wins without overwriting it', async () => {
  const api = server();
  const d = linked(api); d.save(70, 'balanced');
  let injected = false;
  api.beforePut = (name) => {
    if (name === 'settings/current' && !injected) { injected = true; api.put(name, { weight: 80, profile: 'performance', updatedAt: time(12) }); }
  };
  await d.sync();
  assert.equal(d.settings.weight, '80');
  assert.equal(api.records.get('settings/current').value.weight, 80);
  assert.equal(d.dirty.length, 0);
});

test('412 older remote edit retries once with the current version', async () => {
  const api = server();
  const d = linked(api); d.save(70, 'balanced');
  let injected = false;
  api.beforePut = (name) => {
    if (name === 'settings/current' && !injected) { injected = true; api.put(name, { weight: 60, profile: 'balanced', updatedAt: time(9) }); }
  };
  await d.sync();
  assert.equal(api.records.get('settings/current').value.weight, 70);
  const writes = api.calls.filter((call) => call.method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[1].body).writes.find((write) => write.key === 'current').ifMatch, 1);
});

test('an edit during upload stays dirty and a follow-up sync publishes it', async () => {
  const api = server();
  const d = linked(api); d.save(70, 'balanced');
  let edited = false;
  api.beforePut = (name) => {
    if (name === 'settings/current' && !edited) { edited = true; d.clock(11); d.save(71, 'balanced'); }
  };
  await d.sync();
  assert.ok(d.dirty.includes('settings/current'));
  await d.sync();
  assert.equal(api.records.get('settings/current').value.weight, 71);
  assert.equal(d.dirty.length, 0);
});

for (const [code, status] of [[403, 'Sync unavailable on this address'], [429, 'Sync pending'], [500, 'Sync pending'], [507, 'Sync storage full']]) {
  test(`${code} keeps local data and dirty flags without a retry loop`, async () => {
    const api = server(); const d = linked(api); d.save(70, 'balanced'); api.error = code;
    await d.sync();
    assert.equal(d.status, status);
    assert.equal(d.settings.weight, '70');
    assert.ok(d.dirty.includes('settings/current'));
    assert.equal(api.calls.length, 1);
  });
}

test('401 revokes only local sync credentials, preserving saved data', async () => {
  const api = server(); const d = linked(api); d.save(70, 'balanced'); api.error = 401;
  await d.sync();
  assert.equal(d.status, 'Sync off');
  assert.equal(d.data.has('rooted-storage-token'), false);
  assert.equal(d.data.has('rooted-sync-dirty'), false);
  assert.equal(d.settings.weight, '70');
  assert.equal(Object.keys(d.history).length, 1);
});

test('disconnect while a request is pending prevents stale response application', async () => {
  const api = server();
  let respond;
  api.fetch = () => new Promise((resolve) => { respond = resolve; });
  const d = linked(api); d.save(70, 'balanced');
  const sync = d.sync(); d.disconnect();
  respond(new Response(JSON.stringify({ version: 1, value: { weight: 80, profile: 'balanced', updatedAt: time(12) } })));
  await sync;
  assert.equal(d.settings.weight, '70');
  assert.equal(d.status, 'Sync off');
  assert.equal(d.data.has('rooted-sync-versions'), false);
});

test('network errors preserve dirty state; next online trigger retries', async () => {
  const api = server(); const original = api.fetch;
  api.fetch = async () => { throw Error('offline'); };
  const d = linked(api); d.save(70, 'balanced');
  await d.sync(); assert.equal(d.status, 'Sync pending');
  api.fetch = original; d.context.fetch = original;
  await d.events.online();
  assert.equal(d.status, 'Synced');
});

test('storage unavailable still supports local edits and linked sync in memory', async () => {
  const d = linked(server(), { blocked: true });
  d.save(70, 'balanced');
  await d.sync();
  assert.equal(d.status, 'Synced');
  assert.equal(Object.values(d.context.lastHistory)[0].weight, 70);
});

test('repeated conflicts leave the edit pending after one retry', async () => {
  const api = server();
  const d = linked(api); d.save(70, 'balanced');
  api.beforePut = (name) => {
    if (name === 'settings/current') api.put(name, { weight: 60, profile: 'balanced', updatedAt: time(9) });
  };
  await d.sync();
  assert.equal(api.calls.filter((call) => call.method === 'POST').length, 2);
  assert.equal(d.status, 'Sync pending');
  assert.ok(d.dirty.includes('settings/current'));
});

test('sync triggers while a request is running queue a single follow-up', async () => {
  const api = server();
  const original = api.fetch;
  let release;
  let first = true;
  api.fetch = async (...args) => {
    if (first) { first = false; await new Promise((resolve) => { release = resolve; }); }
    return original(...args);
  };
  const d = linked(api); d.save(70, 'balanced');
  const pending = d.sync();
  await d.sync(); await d.sync();
  assert.equal(api.calls.length, 0);
  release(); await pending;
  assert.equal(d.timers.size, 1);
  const followUp = [...d.timers.values()][0];
  await followUp();
  assert.equal(d.status, 'Synced');
});

test('history dates use the local calendar even near a UTC day boundary', () => {
  const d = device(server(), { hour: 23 });
  d.save(70, 'balanced');
  const local = new Date(time(23));
  const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  assert.equal(Object.keys(d.history)[0], expected);
});

test('invalid calendar dates and corrupt local JSON are ignored', async () => {
  const api = server();
  api.put('weights/2026-02-30', { weight: 70, updatedAt: time(9) });
  const d = linked(api, { stored: { 'rooted-weight-history': '{broken', 'rooted-weight': '070', 'rooted-profile': 'invalid' } });
  await d.sync();
  assert.equal(d.renders[0].settings, null);
  assert.equal(Object.keys(d.renders[0].history).length, 0);
  assert.equal(d.status, 'Synced');
});

test('service worker ignores all cross-origin requests and caches the storage script', () => {
  const listeners = {};
  vm.runInNewContext(fs.readFileSync('sw.js', 'utf8'), {
    URL, self: { location: { origin: 'https://nutrition.hakkila.fi' }, addEventListener(name, fn) { listeners[name] = fn; } },
  });
  let intercepted = false;
  listeners.fetch({ request: { method: 'GET', url: 'https://storage.hakkila.fi/v1/collections/weights/records' }, respondWith() { intercepted = true; } });
  assert.equal(intercepted, false);
  assert.match(fs.readFileSync('sw.js', 'utf8'), /'\.\/storage\.js'/);
});

test('unchanged saves keep edit timestamps and cause no writes or sync requests', async () => {
  const api = server(); const d = linked(api);
  d.save(70, 'balanced'); await d.sync();
  const stamp = d.data.get('rooted-settings-updated-at');
  const history = JSON.stringify(d.history);
  const calls = api.calls.length;
  d.clock(11); d.save(70, 'balanced');
  assert.equal(d.data.get('rooted-settings-updated-at'), stamp);
  assert.equal(JSON.stringify(d.history), history);
  assert.equal(d.dirty.length, 0);
  assert.equal(d.status, 'Synced');
  assert.equal(api.calls.length, calls);
  await d.sync();
  const checks = api.calls.slice(calls);
  assert.equal(checks.length, 1);
  assert.ok(checks[0].url.includes('/changes?since='));
  assert.ok(checks.every((call) => call.method === 'GET'));
});

test('change feed includes old-date corrections without individual record requests', async () => {
  const api = server();
  api.put('settings/current', { weight: 70, profile: 'balanced', updatedAt: time(9) });
  api.put('weights/2026-09-01', { weight: 70, updatedAt: time(9) });
  api.put('weights/2026-10-01', { weight: 71, updatedAt: time(9) });
  const d = linked(api); await d.sync();
  api.calls.length = 0;
  api.put('weights/2026-09-01', { weight: 72, updatedAt: time(11) });
  await d.sync();
  assert.equal(d.history['2026-09-01'].weight, 72);
  assert.equal(api.calls.length, 1);
  assert.ok(api.calls[0].url.includes('/changes'));
  assert.equal(api.calls.filter((call) => call.url.endsWith('/2026-10-01')).length, 0);
  assert.equal(api.calls.filter((call) => call.method === 'POST').length, 0);
});

test('a new day records the same weight without rewriting unchanged settings', async () => {
  const api = server(); const d = linked(api);
  d.save(70, 'balanced'); await d.sync();
  const currentDate = Object.keys(d.history)[0];
  const nativeDate = d.context.Date;
  const nextDay = Date.parse(time(10)) + 86400000;
  d.context.Date = class extends nativeDate {
    constructor(...args) { super(...(args.length ? args : [nextDay])); }
    static now() { return nextDay; }
  };
  d.save(70, 'balanced');
  assert.equal(Object.keys(d.history).length, 2);
  assert.equal(d.dirty.includes('settings/current'), false);
  assert.equal(d.history[currentDate].weight, 70);
  assert.equal(d.dirty.length, 1);
});

test('a successful check persists last-sync time and failures retain it', async () => {
  const api = server(); const d = linked(api);
  d.save(70, 'balanced'); await d.sync();
  assert.equal(d.statuses.at(-1).lastSynced, time(10));
  d.clock(11); api.error = 500; await d.sync();
  assert.equal(d.statuses.at(-1).lastSynced, time(10));
  api.error = 0; await d.sync();
  assert.equal(d.statuses.at(-1).lastSynced, time(11));
  d.disconnect();
  assert.equal(d.data.has('rooted-sync-last-success'), false);
});

test('storage failures are visible even without a sync token', () => {
  const d = device(server(), { blocked: true });
  d.save(70, 'balanced');
  assert.match(d.statuses.at(-1).storageWarning, /Changes may be lost/);
  assert.equal(d.status, 'Sync off');
});

function historyEntries(count, start = '2020-01-01') {
  const entries = {};
  for (let i = 0; i < count; i++) {
    const date = new Date(Date.parse(`${start}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
    entries[date] = { weight: 70, updatedAt: time(9) };
  }
  return entries;
}

test('250 remote entries bootstrap in two change-feed requests', async () => {
  const api = server();
  for (const [date, value] of Object.entries(historyEntries(250))) api.put(`weights/${date}`, value);
  const d = linked(api); await d.sync();
  assert.equal(Object.keys(d.history).length, 250);
  assert.equal(api.calls.length, 2);
  assert.ok(api.calls.every((call) => call.url.includes('/changes')));
});

test('150 pre-link local entries upload in two batches', async () => {
  const api = server();
  const d = linked(api, { stored: { 'rooted-weight-history': JSON.stringify(historyEntries(150)) } });
  await d.sync();
  const batches = api.calls.filter((call) => call.method === 'POST');
  assert.deepEqual(batches.map((call) => JSON.parse(call.body).writes.length), [100, 50]);
  assert.equal(api.records.size, 150);
  assert.equal(d.dirty.length, 0);
});

test('partial 412 preserves successful writes in the batch and resolves the conflict through the feed', async () => {
  const api = server(); const d = linked(api); d.save(70, 'balanced');
  let injected = false;
  api.beforePut = (name) => {
    if (!injected && name === 'settings/current') {
      injected = true;
      api.put(name, { weight: 65, profile: 'balanced', updatedAt: time(9) });
    }
  };
  await d.sync();
  const batches = api.calls.filter((call) => call.method === 'POST');
  assert.equal(JSON.parse(batches[0].body).writes.length, 2);
  assert.equal(JSON.parse(batches[1].body).writes.length, 1);
  assert.equal(api.records.get('settings/current').value.weight, 70);
  assert.equal(d.dirty.length, 0);
});

test('507 in a batch leaves only the rejected write dirty and shows storage full', async () => {
  const api = server(); const d = linked(api); d.save(70, 'balanced');
  api.resultStatus = (write) => write.collection === 'settings' ? 507 : 0;
  await d.sync();
  assert.equal(d.status, 'Sync storage full');
  assert.deepEqual(d.dirty, ['settings/current']);
  assert.equal(api.records.size, 1);
});

test('new token and disconnect clear cursor and bootstrap progress', async () => {
  const api = server(); const d = linked(api); d.save(70, 'balanced'); await d.sync();
  assert.ok(d.data.has('rooted-sync-cursor'));
  const relink = linked(api, { stored: Object.fromEntries(d.data) });
  assert.equal(relink.data.has('rooted-sync-cursor'), false);
  await relink.sync();
  assert.ok(api.calls.at(-1).url.includes('since=0'));
  relink.disconnect();
  assert.equal(relink.data.has('rooted-sync-cursor'), false);
  assert.equal(relink.data.has('rooted-sync-bootstrap-pending'), false);
});

test('an interrupted bootstrap resumes after reload and still uploads local-only history', async () => {
  const api = server();
  for (const [date, value] of Object.entries(historyEntries(250))) api.put(`weights/${date}`, value);
  api.beforeChanges = (url) => { if (Number(url.searchParams.get('since')) > 0) throw Error('connection cut'); };
  const d = linked(api, { stored: { 'rooted-weight-history': JSON.stringify({ '2025-01-01': { weight: 75, updatedAt: time(10) } }) } });
  await d.sync();
  assert.equal(d.status, 'Sync pending');
  assert.equal(d.data.get('rooted-sync-cursor'), '200');
  assert.deepEqual(JSON.parse(d.data.get('rooted-sync-bootstrap-pending')), ['weights/2025-01-01']);
  api.beforeChanges = null; api.calls.length = 0;
  const resumed = device(api, { stored: Object.fromEntries(d.data) });
  await resumed.sync();
  assert.ok(api.calls[0].url.includes('since=200'));
  assert.equal(Object.keys(resumed.history).length, 251);
  assert.equal(api.records.get('weights/2025-01-01').value.weight, 75);
  assert.equal(resumed.dirty.length, 0);
  assert.equal(resumed.data.get('rooted-sync-bootstrap-pending'), 'null');
});

for (const failKey of ['rooted-weight-history', 'rooted-sync-versions', 'rooted-sync-dirty', 'rooted-sync-bootstrap-pending', 'rooted-sync-cursor']) {
  test(`failed ${failKey} persistence cannot durably skip a downloaded page`, async () => {
    const api = server();
    api.put('weights/2026-09-30', { weight: 75, updatedAt: time(10) });
    const d = linked(api, { failWrite: (key) => key === failKey });
    await d.sync();
    assert.equal(d.data.has('rooted-sync-cursor'), false);
    const resumed = device(api, { stored: Object.fromEntries(d.data) });
    api.calls.length = 0; await resumed.sync();
    assert.ok(api.calls[0].url.includes('since=0'));
    assert.equal(resumed.history['2026-09-30'].weight, 75);
  });
}

test('partial settings saves do not stamp incomplete data as the newer remote edit', async () => {
  const api = server();
  api.put('settings/current', { weight: 80, profile: 'performance', updatedAt: time(10) });
  const d = linked(api, { stored: { 'rooted-weight': '70', 'rooted-profile': 'balanced', 'rooted-settings-updated-at': time(9) },
    failWrite: (key) => key === 'rooted-weight' });
  await d.sync();
  assert.equal(d.data.get('rooted-settings-updated-at'), time(9));
  assert.equal(d.data.has('rooted-sync-cursor'), false);
  const resumed = device(api, { stored: Object.fromEntries(d.data) }); await resumed.sync();
  assert.equal(resumed.settings.weight, '80');
  assert.equal(resumed.settings.profile, 'performance');
  assert.equal(api.records.get('settings/current').value.weight, 80);
});

for (const bad of [
  { changes: [], cursor: -1, more: false },
  { cursor: 0, more: false },
  { changes: [], cursor: 0, more: true },
  { changes: [], cursor: 0, more: 'yes' },
  { changes: [{ collection: 'weights', key: '2026-09-30', version: 'bad', value: { weight: 75, updatedAt: time(11) } }], cursor: 1, more: false },
]) {
  test(`invalid feed is rejected: ${JSON.stringify(bad)}`, async () => {
    const api = server(); api.fetch = async () => new Response(JSON.stringify(bad));
    const d = linked(api); d.save(70, 'balanced'); const before = JSON.stringify(d.history);
    await d.sync();
    assert.equal(d.status, 'Sync pending');
    assert.equal(JSON.stringify(d.history), before);
    assert.equal(d.data.has('rooted-sync-cursor'), false);
  });
}

test('a cursor below the previously committed cursor is rejected before applying records', async () => {
  const api = server(); api.put('weights/2026-09-30', { weight: 70, updatedAt: time(9) });
  const d = linked(api); await d.sync();
  d.context.fetch = async () => new Response(JSON.stringify({ changes: [
    { collection: 'weights', key: '2026-09-30', value: { weight: 80, updatedAt: time(11) }, version: 2 },
  ], cursor: 0, more: false }));
  await d.sync();
  assert.equal(d.history['2026-09-30'].weight, 70);
  assert.equal(d.data.get('rooted-sync-cursor'), '1');
  assert.equal(d.status, 'Sync pending');
});

test('malformed batch results cannot clear any dirty flags', async () => {
  const api = server(); const original = api.fetch;
  api.fetch = async (url, init) => url.endsWith('/batch') ? new Response(JSON.stringify({ results: [] })) : original(url, init);
  const d = linked(api); d.save(70, 'balanced'); await d.sync();
  assert.equal(d.status, 'Sync pending');
  assert.equal(d.dirty.length, 2);
});
