/* Local-first storage and optional bearer-token sync. No token is exposed to UI. */
(() => {
  'use strict';
  const API = ['localhost', '127.0.0.1'].includes(location.hostname)
    ? 'http://127.0.0.1:8091/v1' : 'https://storage.hakkila.fi/v1';
  const keys = {
    token: 'rooted-storage-token', weight: 'rooted-weight', profile: 'rooted-profile',
    updated: 'rooted-settings-updated-at', history: 'rooted-weight-history',
    versions: 'rooted-sync-versions', dirty: 'rooted-sync-dirty',
    lastSync: 'rooted-sync-last-success', cursor: 'rooted-sync-cursor',
    bootstrap: 'rooted-sync-bootstrap-pending',
  };
  const tokenPattern = /^dst_[A-Za-z0-9_-]{43}$/;
  const memory = new Map();
  let storageUnavailable = false;
  function storageFailed() { storageUnavailable = true; }
  function read(key) {
    if (memory.has(key)) return memory.get(key);
    try { return localStorage.getItem(key); } catch { storageFailed(); return memory.get(key) ?? null; }
  }
  function write(key, value) {
    memory.set(key, value);
    try { localStorage.setItem(key, value); return true; } catch { storageFailed(); return false; }
  }
  function remove(key) {
    memory.set(key, null);
    try { localStorage.removeItem(key); return true; } catch { storageFailed(); return false; }
  }
  function json(key, fallback) {
    try { return JSON.parse(read(key)) ?? fallback; } catch { return fallback; }
  }
  function clearSyncState() { remove(keys.versions); remove(keys.dirty); remove(keys.lastSync); remove(keys.cursor); remove(keys.bootstrap); }
  let intakeMessage = '';
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has('storage-token')) {
    const incoming = fragment.get('storage-token');
    if (tokenPattern.test(incoming)) {
      write(keys.token, incoming);
      clearSyncState();
    } else intakeMessage = 'This sync link is not valid';
    history.replaceState(null, '', location.pathname + location.search);
  }
  let token = read(keys.token);
  if (!tokenPattern.test(token)) { token = null; remove(keys.token); }
  let settings = null;
  let weights = {};
  let versions = {};
  let dirty = new Set();
  let cursor = 0;
  let bootstrapPending = null;
  let options;
  let timer;
  let running = false;
  let requested = false;
  let session = 0;
  let sessionController = new AbortController();
  const validTime = (value) => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const validWeight = (value) => Number.isInteger(value) && value >= 30 && value <= 250;
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  function validValue(name, value) {
    if (!value || !validTime(value.updatedAt)) return false;
    if (name === 'settings/current') {
      return (value.weight === null || validWeight(value.weight))
        && Object.hasOwn(options.profiles, value.profile);
    }
    return name.startsWith('weights/') && validDate(name.slice(8)) && validWeight(value.weight);
  }
  const validName = (name) => name === 'settings/current'
    || (typeof name === 'string' && name.startsWith('weights/') && validDate(name.slice(8)));
  const validVersion = (version) => /^[1-9][0-9]*$/.test(String(version)) && Number.isSafeInteger(Number(version));
  const validCursor = (value) => Number.isSafeInteger(value) && value >= 0;
  const newer = (a, b) => Date.parse(a.updatedAt) > Date.parse(b.updatedAt);
  const localValue = (name) => name === 'settings/current' ? settings : weights[name.slice(8)];
  function persistSync() {
    if (!token) return true;
    const results = [write(keys.versions, JSON.stringify(versions)), write(keys.dirty, JSON.stringify([...dirty]))];
    return results.every(Boolean);
  }
  function persistData() {
    const results = [];
    if (settings) {
      const weightSaved = settings.weight === null ? remove(keys.weight) : write(keys.weight, String(settings.weight));
      const profileSaved = write(keys.profile, settings.profile);
      results.push(weightSaved, profileSaved);
      // Do not give partially saved settings the timestamp of the complete edit.
      results.push(weightSaved && profileSaved && write(keys.updated, settings.updatedAt));
    }
    results.push(write(keys.history, JSON.stringify(weights)));
    return results.every(Boolean);
  }
  function checkpoint() {
    // Data and dirty/version state must be durable before bootstrap state, then cursor.
    // A crash between these writes can replay a page, but cannot skip unsaved data.
    const dataSaved = persistData();
    const syncSaved = persistSync();
    if (dataSaved && syncSaved && write(keys.bootstrap, JSON.stringify(bootstrapPending === null ? null : [...bootstrapPending]))) {
      write(keys.cursor, String(cursor));
    }
  }
  function notifyData() { options.onData({ settings, history: { ...weights } }); }
  function status(message) {
    const lastSynced = token ? read(keys.lastSync) : null;
    options?.onStatus({ connected: Boolean(token), message, lastSynced: validTime(lastSynced) ? lastSynced : null,
      storageWarning: storageUnavailable ? 'Local saving unavailable. Changes may be lost when you close the app.' : '' });
  }
  function mark(name) { if (token) dirty.add(name); }
  function today(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function timestamp() {
    // Keep successive edits ordered even when the clock moves backwards slightly.
    const last = Math.max(Date.parse(settings?.updatedAt) || 0,
      Date.parse(weights[today()]?.updatedAt) || 0);
    return new Date(Math.max(Date.now(), last + 1)).toISOString();
  }
  function save(weight, profile, { recordHistory = true } = {}) {
    if (!(weight === null || validWeight(weight)) || !Object.hasOwn(options.profiles, profile)) return;
    const settingsChanged = !settings || settings.weight !== weight || settings.profile !== profile;
    const date = today();
    const historyChanged = recordHistory && weight !== null && weights[date]?.weight !== weight;
    if (!settingsChanged && !historyChanged) return;
    const updatedAt = timestamp();
    if (settingsChanged) {
      settings = { weight, profile, updatedAt };
      mark('settings/current');
    }
    if (historyChanged) {
      weights[date] = { weight, updatedAt };
      mark(`weights/${date}`);
    }
    // History deletion is deliberately unsupported: offline deletes need tombstones.
    persistData();
    persistSync();
    options.onHistory({ ...weights });
    status(token ? 'Sync pending' : 'Sync off');
    if (token) schedule();
  }
  function disconnect() {
    token = null;
    session++;
    sessionController.abort();
    sessionController = new AbortController();
    requested = false;
    clearTimeout(timer);
    remove(keys.token);
    clearSyncState();
    versions = {};
    dirty.clear();
    cursor = 0;
    bootstrapPending = null;
    status('Sync off');
  }
  function guard(id) {
    if (id !== session || !token) throw Object.assign(new Error('Sync cancelled'), { cancelled: true });
  }
  async function request(method, path, id, value) {
    guard(id);
    const controller = new AbortController();
    const parent = sessionController.signal;
    const cancel = () => controller.abort();
    parent.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, 15000);
    const headers = { Authorization: `Bearer ${token}` };
    if (value !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const response = await fetch(`${API}${path}`, {
        method, headers, cache: 'no-store', signal: controller.signal,
        body: value === undefined ? undefined : JSON.stringify(value),
      });
      guard(id);
      if (!response.ok) throw Object.assign(new Error('Sync request failed'), { status: response.status });
      const data = await response.json();
      guard(id);
      return data;
    } finally {
      clearTimeout(timeout);
      parent.removeEventListener('abort', cancel);
    }
  }
  function merge(name, record) {
    if (!validVersion(record?.version)) throw new Error('Invalid record version');
    versions[name] = record.version;
    if (!validValue(name, record.value)) return;
    const remote = name === 'settings/current'
      ? { weight: record.value.weight, profile: record.value.profile, updatedAt: record.value.updatedAt }
      : { weight: record.value.weight, updatedAt: record.value.updatedAt };
    const local = localValue(name);
    if (!local || newer(remote, local)) {
      if (name === 'settings/current') settings = remote;
      else weights[name.slice(8)] = remote;
      dirty.delete(name);
      persistData();
      if (name === 'settings/current') notifyData();
      else options.onHistory({ ...weights });
    } else if (newer(local, remote)) mark(name);
    persistSync();
  }
  async function pull(id) {
    do {
      const page = await request('GET', `/changes?since=${cursor}&limit=200`, id);
      if (!page || !Array.isArray(page.changes) || !validCursor(page.cursor)
        || page.cursor < cursor || typeof page.more !== 'boolean'
        || (page.more && page.cursor === cursor)) throw new Error('Invalid change feed');
      // Validate the whole page before applying anything or advancing its cursor.
      for (const record of page.changes) {
        if (!record || typeof record.collection !== 'string' || typeof record.key !== 'string') throw new Error('Invalid change record');
        const name = `${record.collection}/${record.key}`;
        if (validName(name) && !validVersion(record.version)) throw new Error('Invalid record version');
      }
      for (const record of page.changes) {
        const name = `${record.collection}/${record.key}`;
        if (!validName(name)) continue;
        merge(name, record);
        bootstrapPending?.delete(name);
      }
      cursor = page.cursor;
      if (!page.more && bootstrapPending !== null) {
        // This set survives paging and restarts. Unseen bootstrap data still needs uploading.
        for (const name of bootstrapPending) {
          if (localValue(name)) { delete versions[name]; mark(name); }
        }
        bootstrapPending = null;
      }
      checkpoint();
      if (!page.more) return;
    } while (true);
  }
  async function pushDirty(id) {
    const names = [...dirty];
    let conflict = false;
    let storageFull = false;
    for (let offset = 0; offset < names.length; offset += 100) {
      const writes = [];
      const snapshots = [];
      for (const name of names.slice(offset, offset + 100)) {
        const value = localValue(name);
        if (!value) { dirty.delete(name); continue; }
        const [collection, key] = name.split('/');
        const snapshot = JSON.stringify(value);
        writes.push({ collection, key, value: JSON.parse(snapshot),
          ...(versions[name] === undefined ? { ifNoneMatch: '*' } : { ifMatch: Number(versions[name]) }) });
        snapshots.push(snapshot);
      }
      if (!writes.length) { persistSync(); continue; }
      const response = await request('POST', '/batch', id, { writes });
      if (!response || !Array.isArray(response.results) || response.results.length !== writes.length) throw new Error('Invalid batch response');
      for (let i = 0; i < writes.length; i++) {
        const result = response.results[i];
        if (!result || result.collection !== writes[i].collection || result.key !== writes[i].key
          || !Number.isInteger(result.status)
          || ([200, 201].includes(result.status) && !validVersion(result.version))) throw new Error('Invalid batch result');
      }
      let failure;
      for (let i = 0; i < writes.length; i++) {
        const result = response.results[i];
        const name = `${result.collection}/${result.key}`;
        if (result.status === 200 || result.status === 201) {
          versions[name] = result.version;
          if (JSON.stringify(localValue(name)) === snapshots[i]) dirty.delete(name);
          else requested = true;
        } else if (result.status === 412) conflict = true;
        else if (result.status === 507) storageFull = true;
        else if (result.status === 400 || result.status === 413) {
          // Do not echo server error text: it could contain credentials or user data.
          console.warn('Sync write rejected with status', result.status);
        } else failure = Object.assign(new Error('Sync write failed'), { status: result.status });
      }
      persistSync();
      if (failure) throw failure;
    }
    return { conflict, storageFull };
  }
  async function sync() {
    clearTimeout(timer);
    if (!token || !options) return;
    if (running) { requested = true; return; }
    running = true;
    const id = session;
    requested = false;
    status('Syncing…');
    try {
      await pull(id);
      let result = await pushDirty(id);
      if (result.conflict) {
        await pull(id);
        result = await pushDirty(id);
      }
      guard(id);
      if (!dirty.size) write(keys.lastSync, new Date().toISOString());
      status(result.storageFull ? 'Sync storage full' : dirty.size ? 'Sync pending' : 'Synced');
    } catch (error) {
      if (id === session && !error.cancelled) {
        if (error.status === 401) disconnect();
        else status(error.status === 403 ? 'Sync unavailable on this address'
          : error.status === 507 ? 'Sync storage full' : 'Sync pending');
      }
    } finally {
      running = false;
      if (requested && token) { requested = false; schedule(); }
    }
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(sync, 1000); }
  function init(callbacks) {
    options = callbacks;
    const profile = read(keys.profile);
    const weightText = read(keys.weight);
    const weight = /^[1-9][0-9]*$/.test(weightText) && validWeight(Number(weightText)) ? Number(weightText) : null;
    if (weight !== null || Object.hasOwn(options.profiles, profile)) {
      // Legacy data has no edit time. A dated remote edit wins on first linking.
      settings = { weight, profile: Object.hasOwn(options.profiles, profile) ? profile : 'balanced',
        updatedAt: validTime(read(keys.updated)) ? read(keys.updated) : '1970-01-01T00:00:00.000Z' };
    }
    const savedHistory = json(keys.history, {});
    for (const [date, entry] of Object.entries(savedHistory)) {
      if (validValue(`weights/${date}`, entry)) weights[date] = { weight: entry.weight, updatedAt: entry.updatedAt };
    }
    if (token) {
      for (const [name, version] of Object.entries(json(keys.versions, {}))) {
        if (validName(name) && validVersion(version)) versions[name] = version;
      }
      const savedDirty = json(keys.dirty, []);
      if (Array.isArray(savedDirty)) dirty = new Set(savedDirty.filter(validName));
      const savedCursor = read(keys.cursor);
      const pending = json(keys.bootstrap, null);
      if (savedCursor !== null && /^\d+$/.test(savedCursor) && validCursor(Number(savedCursor)) && !storageUnavailable) {
        cursor = Number(savedCursor);
        if (Array.isArray(pending)) bootstrapPending = new Set(pending.filter(validName));
      } else {
        cursor = 0;
        bootstrapPending = new Set(Object.keys(weights).map((date) => `weights/${date}`));
        if (settings) bootstrapPending.add('settings/current');
      }
    } else clearSyncState();
    notifyData();
    status(intakeMessage || (token ? 'Sync pending' : 'Sync off'));
    if (token) schedule();
    window.addEventListener('online', sync);
  }
  window.RootedStorage = { init, save, sync, disconnect };
})();
