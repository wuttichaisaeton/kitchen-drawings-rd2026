import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SRC = readFileSync(new URL('../stockpart.js', import.meta.url), 'utf8');

export function boot() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><main id="root"></main></body></html>', { url: 'http://localhost/' });
  const { window } = dom;
  const store = {};
  // jsdom's window.localStorage is a getter-only property; supply an in-memory
  // shim passed as the IIFE's `localStorage` free var instead of reassigning it.
  const localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  window.ROOT = window.document.getElementById('root');
  window.isAdmin = () => false;
  window.getRole = () => 'laser';
  window.escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  window._kdToast = () => {};
  window._kdOpen3D = () => {};
  window._backgroundRender = () => {};
  window.dxfsForMasterCode = () => [];
  window._uploadedDxfsCache = {};
  new window.Function(
    'window', 'document', 'localStorage', 'ROOT', 'isAdmin', 'getRole', 'escapeHtml', '_kdToast', '_kdOpen3D', '_backgroundRender', 'dxfsForMasterCode', '_uploadedDxfsCache',
    SRC + '\nwindow.__kdsp = window.kdStockPart;'
  )(window, window.document, localStorage, window.ROOT, window.isAdmin, window.getRole, window.escapeHtml, window._kdToast, window._kdOpen3D, window._backgroundRender, window.dxfsForMasterCode, window._uploadedDxfsCache);
  return { window, T: window.kdStockPart._test, KSP: window.kdStockPart };
}

test('module exposes the public API', () => {
  const { KSP } = boot();
  assert.equal(typeof KSP.renderHome, 'function');
  assert.equal(typeof KSP.init, 'function');
  assert.equal(typeof KSP.stockQtyByCode, 'function');
  assert.equal(typeof KSP.confirmedByCode, 'function');
});

test('_aggregateConfirmed sums only confirmed rows by code', () => {
  const { T } = boot();
  const rows = {
    a: { status: 'confirmed', code: 'FN3BLA-060000', qty: 3 },
    b: { status: 'confirmed', code: 'FN3BLA-060000', qty: 2 },
    c: { status: 'confirmed', code: 'SD0SUP-040030', qty: 5 },
    d: { status: 'pending', code: '', qty: 9 },
    e: { status: 'awaiting_worker_confirm', code: 'FN3BLA-060000', qty: 9 },
    f: { status: 'rejected', code: 'SD0SUP-040030', qty: 9 },
  };
  const agg = T._aggregateConfirmed(rows);
  assert.equal(agg['FN3BLA-060000'], 5);   // 3+2 only; awaiting excluded
  assert.equal(agg['SD0SUP-040030'], 5);   // rejected excluded
  assert.equal(Object.keys(agg).length, 2);
});

test('codePickerFilter dedupes by master_code (newest), filters case-insensitively', () => {
  const { T } = boot();
  const cache = {
    s1: { master_code: 'FN3BLA-060000', uploaded_at: 100, thickness_mm: 1 },
    s2: { master_code: 'FN3BLA-060000', uploaded_at: 200, thickness_mm: 2 },  // newer wins
    s3: { master_code: 'SD0SUP-040030', uploaded_at: 50 },
    s4: { foo: 'no master_code' },
  };
  const all = T.codePickerFilter(cache, '');
  assert.equal(all.length, 2);
  assert.equal(all[0].master_code, 'FN3BLA-060000'); // A→Z
  assert.equal(all[0].thickness_mm, 2);              // newest record
  const hit = T.codePickerFilter(cache, 'sd0');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].master_code, 'SD0SUP-040030');
});

test('relativeTime formats minutes/hours/date', () => {
  const { T } = boot();
  const now = 1_000_000_000_000;
  assert.equal(T.relativeTime(now, now - 30_000), 'just now');
  assert.equal(T.relativeTime(now, now - 5 * 60_000), '5m');
  assert.equal(T.relativeTime(now, now - 3 * 3_600_000), '3h');
  assert.match(T.relativeTime(now, now - 48 * 3_600_000), /^\d{4}-\d{2}-\d{2}$/);
});

test('b64Bytes approximates decoded size; _scaleFor caps the longest edge', () => {
  const { T } = boot();
  assert.equal(T.b64Bytes('AAAA'), 3);                 // 4 b64 chars -> 3 bytes
  assert.deepEqual(T._scaleFor(2000, 1000, 1000), { w: 1000, h: 500 });
  assert.deepEqual(T._scaleFor(400, 800, 1000), { w: 400, h: 800 }); // no upscale
});

test('_compressLadder is finite and ends at the smallest attempt', () => {
  const { T } = boot();
  const ladder = T._compressLadder();
  assert.ok(ladder.length >= 3);
  const last = ladder[ladder.length - 1];
  assert.ok(last.maxEdge <= 640 && last.q <= 0.4);
});
