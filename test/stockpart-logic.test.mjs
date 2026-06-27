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

test('codePickerFilter finds by length / dimension digits', () => {
  const { T } = boot();
  const cache = {
    s1: { master_code: 'BK1DN1-946000', uploaded_at: 1 },
    s2: { master_code: 'SD0SUP-040030', uploaded_at: 1 },
    s3: { master_code: 'FN3BLA-060946', uploaded_at: 1 },
  };
  const hit = T.codePickerFilter(cache, '946');
  assert.equal(hit.length, 2);                       // matches width 946 AND height 946
  const codes = hit.map(m => m.master_code).sort();
  assert.deepEqual(codes, ['BK1DN1-946000', 'FN3BLA-060946']);
  assert.equal(T.codePickerFilter(cache, '040').length, 1); // SD0SUP width 040
});

test('_parseLen extracts the length number from worker remarks', () => {
  const { T } = boot();
  assert.equal(T._parseLen('ยาว 946'), 946);
  assert.equal(T._parseLen('946 mm'), 946);
  assert.equal(T._parseLen('ยาว 946 กว้าง 50'), 946); // largest = length
  assert.equal(T._parseLen('no number'), null);
  assert.equal(T._parseLen(''), null);
});

test('_rowPhotos returns the photo list (photos[] | [photo_data] | [])', () => {
  const { T } = boot();
  assert.deepEqual(T._rowPhotos({ photos: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(T._rowPhotos({ photo_data: 'a' }), ['a']);              // old single-photo row
  assert.deepEqual(T._rowPhotos({ photos: [], photo_data: 'a' }), ['a']);  // empty array → fall back
  assert.deepEqual(T._rowPhotos({}), []);
  assert.deepEqual(T._rowPhotos(null), []);
});

test('_buildThumbEdges adds a dark edge line per mesh and KEEPS the fill (solid + edges, #4)', () => {
  const { T } = boot();
  const THREE = {
    EdgesGeometry: function (g, a) { this.g = g; this.a = a; },
    LineBasicMaterial: function (o) { Object.assign(this, o); },
    LineSegments: function (g, m) { this.geometry = g; this.material = m; this.isLineSegments = true; },
  };
  const world = { name: 'world', parent: null };
  const mkMesh = (parent) => ({ isMesh: true, geometry: { attributes: { position: {} } }, material: { colorWrite: true }, children: [], add(c) { this.children.push(c); }, parent: parent });
  const m1 = mkMesh(world), m2 = mkMesh(world);
  const ground = mkMesh({ name: 'GroundPlane', parent: null });   // model-viewer shadow/ground — must be skipped
  const scene = { traverse(fn) { [m1, m2, ground, { isMesh: false }].forEach(fn); } };
  const n = T._buildThumbEdges(THREE, scene);
  assert.equal(n, 2);                                  // only the 2 meshes under 'world'
  assert.ok(m1.children[0].isLineSegments);
  assert.equal(m1.material.colorWrite, true);          // FILL KEPT (the #4 distinction vs edges-only)
  assert.equal(ground.children.length, 0);             // ground/shadow plane NOT edged → no "floor frame" lines
  assert.equal(T._buildThumbEdges(THREE, scene), 0);   // idempotent
});

test('_buildThumbEdges no-ops without THREE or scene', () => {
  const { T } = boot();
  assert.equal(T._buildThumbEdges(null, { traverse() {} }), 0);
  assert.equal(T._buildThumbEdges({}, null), 0);
});

test('_parseLen honors the dimension vocabulary (ยาว / W / L = length)', () => {
  const { T } = boot();
  assert.equal(T._parseLen('W946'), 946);            // W label
  assert.equal(T._parseLen('L 946'), 946);           // L label
  assert.equal(T._parseLen('ยาว 946 หนา 1'), 946);   // ยาว wins; thickness 1 not picked
  assert.equal(T._parseLen('L50 W946'), 946);        // a W/L label is used, not a stray small number
  assert.equal(T._parseLen('946 mm'), 946);          // no label → fall back to largest
  assert.equal(T._parseLen('wall'), null);           // letters only, no digits → null
});

test('_codesByLength finds codes within ±tol mm of L (width or height)', () => {
  const { T } = boot();
  const cache = {
    a: { master_code: 'TS1BHH-095000', uploaded_at: 1 }, // W 95cm = 950mm -> 4mm off 946
    b: { master_code: 'FN2BNX-094800', uploaded_at: 1 }, // W 94cm = 940mm -> 6mm off (excluded at 5)
    c: { master_code: 'BK1DN1-060946', uploaded_at: 1 }, // raw H 946 -> 0mm off 946
    d: { master_code: 'SD0SUP-040030', uploaded_at: 1 }, // far
  };
  const hits = T._codesByLength(cache, 946, 5);
  assert.equal(hits.length, 2);                          // 950mm + raw-946; 940mm excluded
  assert.equal(hits[0].master_code, 'BK1DN1-060946');    // nearest (0mm) first
  assert.equal(T._codesByLength(cache, 946, 1).length, 1); // only exact within 1mm
});

test('codePickerFilter: typing a mm length finds cm-encoded codes (±5mm)', () => {
  const { T } = boot();
  const cache = {
    s1: { master_code: 'FN2BNX-095000', uploaded_at: 1 }, // W 95cm = 950mm -> 4mm off 946
    s2: { master_code: 'SD0SUP-040030', uploaded_at: 1 }, // far
  };
  const hit = T.codePickerFilter(cache, '946');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].master_code, 'FN2BNX-095000');
});

test('catalogNotInStock returns query matches minus codes already in stock; empty query → []', () => {
  const { T } = boot();
  const cache = {
    s1: { master_code: 'FN3BLA-060000', uploaded_at: 1, thickness_mm: 1, material: 'ALPF' },
    s2: { master_code: 'FN3BLA-090000', uploaded_at: 1 },
    s3: { master_code: 'SD0SUP-040030', uploaded_at: 1 },
  };
  // query 'FN3' matches both FN3 codes; one is already in stock → only the other returned
  const stockObj = { 'FN3BLA-060000': { code: 'FN3BLA-060000' } };  // accepts the confirmedByCode() map
  const hit = T.catalogNotInStock(cache, 'FN3', stockObj);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].master_code, 'FN3BLA-090000');
  // accepts an array of codes too — both in stock → nothing left
  assert.equal(T.catalogNotInStock(cache, 'FN3', ['FN3BLA-060000', 'FN3BLA-090000']).length, 0);
  // a blank query must NOT dump the whole catalog
  assert.deepEqual(T.catalogNotInStock(cache, '', stockObj), []);
  assert.deepEqual(T.catalogNotInStock(cache, '   ', stockObj), []);
  // no stock arg → all query matches pass through
  assert.equal(T.catalogNotInStock(cache, 'FN3').length, 2);
});

test('_aiSuggestHtml: ok+ranked renders code/%/reason + a use button per pick', () => {
  const { T } = boot();
  const sug = { status: 'ok', ranked: [
    { code: 'FN2BNX-095000', confidence: 0.8, reason: 'long floor rail' },
    { code: 'FN2BLA-060000', confidence: 0.4, reason: 'similar width' },
  ] };
  const html = T._aiSuggestHtml(sug);
  assert.match(html, /kdsp-ai-has/);
  assert.match(html, /FN2BNX-095000/);
  assert.match(html, /80%/);
  assert.match(html, /long floor rail/);
  assert.equal((html.match(/kdsp-ai-use/g) || []).length, 2);  // one use button per pick
  assert.match(html, /kdsp-ai-top/);                            // first pick flagged
});

test('_aiSuggestHtml: error/absent/empty falls back to the coming-soon placeholder', () => {
  const { T } = boot();
  const placeholder = /AI image-match — coming soon/;
  assert.match(T._aiSuggestHtml(undefined), placeholder);
  assert.match(T._aiSuggestHtml({ status: 'error', error: 'x' }), placeholder);
  assert.match(T._aiSuggestHtml({ status: 'ok', ranked: [] }), placeholder);
});

test('_aiSuggestHtml: escapes code and reason (inert against injection)', () => {
  const { T } = boot();
  const html = T._aiSuggestHtml({ status: 'ok', ranked: [{ code: '<img src=x>', confidence: 1, reason: '<script>z</script>' }] });
  assert.ok(html.indexOf('<img src=x>') === -1, 'raw code tag must be escaped');
  assert.ok(html.indexOf('<script>z</script>') === -1, 'raw reason tag must be escaped');
});

test('_fireAiMatch POSTs {id,photo,remarks} to the endpoint and swallows rejection', async () => {
  const { T, window } = boot();
  const calls = [];
  window.fetch = (url, opts) => { calls.push({ url, opts }); return Promise.reject(new Error('network')); };
  // must not throw even though fetch rejects
  T._fireAiMatch('ID1', ['B1', 'B2'], 'ยาว 946', 'https://x.onrender.com/api/stock-match');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://x.onrender.com/api/stock-match');
  assert.equal(calls[0].opts.method, 'POST');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body, { id: 'ID1', photos: ['B1', 'B2'], photo: 'B1', remarks: 'ยาว 946' });
});

test('_fireAiMatch no-ops without id or photo (endpoint param falls back to the configured const)', () => {
  const { T, window } = boot();
  let n = 0; window.fetch = () => { n++; return Promise.resolve(); };
  T._fireAiMatch('', 'B64', 'r', 'https://x/api');     // no id  → no-op
  T._fireAiMatch('ID', '', 'r', 'https://x/api');       // no photo → no-op
  assert.equal(n, 0);
  // a falsy endpoint param falls back to KDSP_AI_ENDPOINT; with id+photo present that DOES fire
  T._fireAiMatch('ID', 'B64', 'r', 'https://y/api');    // explicit endpoint → fires
  assert.equal(n, 1);
});
