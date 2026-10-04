const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function app() {
  const elements = new Map();
  function element() {
    return { value: '', textContent: '', hidden: false, checked: false, children: [], attributes: {}, events: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, fn) { this.events[name] = fn; },
      replaceChildren() { this.children = []; },
      append(...items) { this.children.push(...items); },
      blur() { this.blurCount = (this.blurCount || 0) + 1; },
    };
  }
  for (const id of fs.readFileSync('index.html', 'utf8').matchAll(/id="([^"]+)"/g)) elements.set(`#${id[1]}`, element());
  const profiles = ['balanced', 'performance'].map((value) => ({ ...element(), value }));
  profiles[0].checked = true;
  const saves = [];
  let callbacks;
  let syncCount = 0;
  let disconnected = false;
  const document = {
    hidden: false, events: {},
    querySelector(selector) {
      if (selector === 'input[name="profile"]:checked') return profiles.find((p) => p.checked);
      if (selector.startsWith('input[name="profile"][value=')) {
        const value = selector.match(/value="([^"]+)"/)[1];
        profiles.forEach((p) => { p.checked = false; });
        return profiles.find((p) => p.value === value);
      }
      assert.ok(elements.has(selector), `Missing element ${selector}`);
      return elements.get(selector);
    },
    querySelectorAll() { return profiles; },
    createElement: element,
    addEventListener(name, fn) { this.events[name] = fn; },
  };
  const context = {
    document, navigator: {}, console,
    setInterval() {}, location: { reload() {} },
    fetch: async () => ({ json: async () => ({ version: '0.4.0', timestamp: '20261002120000' }) }),
    RootedStorage: {
      init(value) { callbacks = value; value.onData({ settings: null, history: {} }); value.onStatus({ connected: false, message: 'Sync off' }); },
      save(...args) { saves.push(args); },
      sync() { syncCount++; }, disconnect() { disconnected = true; },
    },
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync('script.js', 'utf8'), context);
  return { elements, profiles, saves, document, callbacks,
    get syncCount() { return syncCount; }, get disconnected() { return disconnected; } };
}

test('valid calculations persist, invalid input does not; profile-only edits do not add history', () => {
  const a = app();
  a.elements.get('#weight').value = '70';
  a.elements.get('#nutrition-form').events.submit({ preventDefault() {} });
  assert.equal(a.elements.get('#calories').textContent, (70 * 22).toLocaleString());
  assert.equal(a.saves[0][0], 70);
  a.profiles[0].checked = false; a.profiles[1].checked = true;
  a.profiles[1].events.change();
  assert.equal(a.saves.at(-1)[2].recordHistory, false);
  a.elements.get('#weight').value = '070';
  a.elements.get('#nutrition-form').events.submit({ preventDefault() {} });
  assert.equal(a.saves.length, 2);
  assert.equal(a.elements.get('#calories').textContent, '—');
  a.elements.get('#weight').value = '';
  a.profiles[1].events.change();
  assert.equal(a.saves.at(-1)[0], null);
});

test('remote settings update results without blurring or saving; profile-only values clear results', () => {
  const a = app();
  a.callbacks.onData({ settings: { weight: 80, profile: 'performance' }, history: {} });
  assert.equal(a.elements.get('#weight').value, '80');
  assert.equal(a.elements.get('#calories').textContent, (80 * 26).toLocaleString());
  assert.equal(a.saves.length, 0);
  assert.equal(a.elements.get('#weight').blurCount, undefined);
  a.callbacks.onData({ settings: { weight: null, profile: 'balanced' }, history: {} });
  assert.equal(a.elements.get('#weight').value, '');
  assert.equal(a.elements.get('#calories').textContent, '—');
});

test('history renders latest 30 then all, newest first; sync controls and focus trigger work', () => {
  const a = app();
  const history = {};
  for (let day = 1; day <= 31; day++) history[`2026-01-${String(day).padStart(2, '0')}`] = { weight: 70 };
  a.callbacks.onHistory(history);
  const list = a.elements.get('#weight-history-list');
  assert.equal(list.children.length, 30);
  assert.equal(list.children[0].children[0].dateTime, '2026-01-31');
  a.elements.get('#history-toggle').events.click();
  assert.equal(list.children.length, 31);
  assert.equal(a.elements.get('#history-toggle').attributes['aria-expanded'], 'true');
  a.callbacks.onStatus({ connected: true, message: 'Synced' });
  assert.equal(a.elements.get('#disconnect-sync').hidden, false);
  a.elements.get('#disconnect-sync').events.click();
  assert.equal(a.disconnected, true);
  a.document.events.visibilitychange();
  assert.equal(a.syncCount, 1);
});

test('last sync and local saving warning are visible independently of sync status', () => {
  const a = app();
  a.callbacks.onStatus({ connected: true, message: 'Sync pending', lastSynced: '2026-10-02T10:00:00.000Z',
    storageWarning: 'Local saving unavailable. Changes may be lost when you close the app.' });
  assert.match(a.elements.get('#last-synced').textContent, /Last synced/);
  assert.equal(a.elements.get('#last-synced').hidden, false);
  assert.equal(a.elements.get('#storage-warning').hidden, false);
  a.callbacks.onStatus({ connected: false, message: 'Sync off', storageWarning: 'Local saving unavailable.' });
  assert.equal(a.elements.get('#last-synced').hidden, true);
  assert.equal(a.elements.get('#storage-warning').hidden, false);
});
