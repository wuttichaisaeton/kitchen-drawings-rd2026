import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SRC = readFileSync(new URL('../stockpart.js', import.meta.url), 'utf8');

// Minimal in-memory firebaseDB compat mock (push/set/update/remove/on/once).
function makeDB() {
  const data = {}; let auto = 0; const listeners = [];
  function fire() { listeners.forEach(cb => cb({ val: () => JSON.parse(JSON.stringify(data.stock_parts || null)) })); }
  function ref(path) {
    return {
      push() { const key = 'k' + (++auto); return ref('stock_parts/' + key)._withKey(key); },
      _withKey(key) { this.key = key; return this; },
      async set(v) { _set(path, v); fire(); },
      async update(patch) { Object.assign(_ensure(path), patch); fire(); },
      async remove() { _rm(path); fire(); },
      once() { return Promise.resolve({ val: () => JSON.parse(JSON.stringify(data.stock_parts || null)) }); },
      on(_evt, cb) { listeners.push(cb); cb({ val: () => JSON.parse(JSON.stringify(data.stock_parts || null)) }); },
    };
  }
  function _seg(path) { return path.split('/'); }
  function _ensure(path) { let o = data; for (const s of _seg(path)) { o[s] = o[s] || {}; o = o[s]; } return o; }
  function _set(path, v) { const segs = _seg(path); let o = data; for (let i = 0; i < segs.length - 1; i++) { o[segs[i]] = o[segs[i]] || {}; o = o[segs[i]]; } o[segs[segs.length - 1]] = v; }
  function _rm(path) { const segs = _seg(path); let o = data; for (let i = 0; i < segs.length - 1; i++) { o = o[segs[i]] || {}; } delete o[segs[segs.length - 1]]; }
  return { ref, _data: data };
}

function boot() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><main id="root"></main></body></html>', { url: 'http://localhost/' });
  const { window } = dom;
  const store = {};
  // jsdom's window.localStorage is a getter-only property; supply an in-memory
  // shim passed as the IIFE's `localStorage` free var instead of reassigning it.
  const localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  window.ROOT = window.document.getElementById('root');
  window.isAdmin = () => true;
  window.getRole = () => 'admin';
  window.escapeHtml = s => String(s == null ? '' : s);
  window._kdToast = () => {}; window._kdOpen3D = () => {}; window._backgroundRender = () => {};
  window.dxfsForMasterCode = () => []; window._uploadedDxfsCache = {};
  window.firebaseDB = makeDB();
  new window.Function(
    'window', 'document', 'localStorage', 'ROOT', 'isAdmin', 'getRole', 'escapeHtml', '_kdToast', '_kdOpen3D', '_backgroundRender', 'dxfsForMasterCode', '_uploadedDxfsCache',
    SRC
  )(window, window.document, localStorage, window.ROOT, window.isAdmin, window.getRole, window.escapeHtml, window._kdToast, window._kdOpen3D, window._backgroundRender, window.dxfsForMasterCode, window._uploadedDxfsCache);
  return { window, KSP: window.kdStockPart, T: window.kdStockPart._test, store };
}

test('lifecycle: intake -> assign -> worker confirm -> stock', async () => {
  const { KSP, T } = boot();
  KSP.init();
  const id = await T.saveIntake({ status: 'pending', code: '', qty: 3, note: '', photo_data: 'AAAA', created_at: 1, created_by_role: 'laser' });
  assert.equal(T._snapshot()[id].status, 'pending');
  await T.assignCode(id, 'FN3BLA-060000', { thickness_mm: 1, material: 'ALPF', grain: 'H' });
  assert.equal(T._snapshot()[id].status, 'awaiting_worker_confirm');
  assert.equal(T._snapshot()[id].code, 'FN3BLA-060000');
  assert.equal(KSP.stockQtyByCode('FN3BLA-060000'), 0); // not counted until worker confirms
  await T.workerConfirmGlb(id);
  assert.equal(T._snapshot()[id].status, 'confirmed');
  assert.equal(KSP.stockQtyByCode('FN3BLA-060000'), 3);
});

test('lifecycle: worker reject bounces back to pending flagged', async () => {
  const { KSP, T } = boot();
  KSP.init();
  const id = await T.saveIntake({ status: 'pending', code: '', qty: 2, photo_data: 'AAAA', created_at: 1, created_by_role: 'laser' });
  await T.assignCode(id, 'SD0SUP-040030', {});
  await T.workerRejectGlb(id);
  const row = T._snapshot()[id];
  assert.equal(row.status, 'pending');
  assert.equal(row.code, '');
  assert.equal(row.bounced_from, 'SD0SUP-040030');
  assert.equal(KSP.stockQtyByCode('SD0SUP-040030'), 0);
});

test('localStorage mirror excludes photo_data', async () => {
  const { KSP, T, store } = boot();
  KSP.init();   // registers the live listener that mirrors metadata (no photos) to localStorage
  await T.saveIntake({ status: 'pending', code: '', qty: 1, photo_data: 'BIGBASE64', created_at: 1, created_by_role: 'laser' });
  const mirror = JSON.parse(store['kd_stock_parts_v1']);
  const only = Object.values(mirror)[0];
  assert.ok(!('photo_data' in only), 'photo_data must be stripped from the LS mirror');
  assert.equal(only.qty, 1);
});
