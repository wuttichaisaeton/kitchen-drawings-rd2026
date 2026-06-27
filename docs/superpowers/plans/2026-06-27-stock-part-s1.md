# Stock Part S1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Stock Part" tab to drawings-ui where a worker photographs a leftover (already-cut/bent) part + enters a quantity, เอ๋ (admin) assigns the 13-char code, the worker confirms the GLB matches the real part, and confirmed parts appear in a shared stock list — so a future nest can avoid re-cutting them (the nest hookup itself is S2).

**Architecture:** A self-contained browser-IIFE module `stockpart.js` exposing `window.kdStockPart` (mirrors `window.kdNest`), loaded by the existing cache-busting loader before `app.js`. State lives in RTDB `stock_parts/<pushId>` (one row per intake; compressed base64 photo; anonymous writes — same open pattern as `nest_remnants`). A live `.on('value')` listener mirrors metadata (no photo blobs) to `localStorage` and repaints via the app's `_backgroundRender()`. Four-state lifecycle: `pending` → (เอ๋ assigns code) `awaiting_worker_confirm` → (worker ✓) `confirmed` / (worker ✗) back to `pending`. Reuses `app.js` helpers `isAdmin`/`getRole`/`escapeHtml`/`_kdToast`/`_kdOpen3D`/`dxfsForMasterCode`/`_uploadedDxfsCache`/`ROOT`/`_backgroundRender`.

**Tech Stack:** Vanilla ES5-ish JS (no bundler), Firebase Realtime DB compat SDK, `<model-viewer>` (via the existing `_kdOpen3D`), `node --test` + `jsdom` for unit tests.

**Spec:** `docs/superpowers/specs/2026-06-27-stock-part-design.md` (read it first).

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `stockpart.js` | Create | The whole feature: pure helpers, RTDB store + listener, the 4 render screens, `renderHome` router, `init`, `window.kdStockPart` + `_test`. |
| `index.html` | Modify | Add `'stockpart.js'` to the loader `names` array (line 231, before `'app.js'`); add the `#tab-stockpart` button (≈line 117). |
| `app.js` | Modify | `_TAB_IDS` (line 202); `_visibleTabsForRole()` (188-200); `render()` dispatch (8148-8166); boot `init()` call (≈15931). |
| `style.css` | Modify | Append a `/* Stock Part (S1) */` section with `.kdsp-*` rules + `.kdsp-th` Thai font; add per-theme opaque overrides in the sketch/chalk theme blocks. |
| `test/stockpart-logic.test.mjs` | Create | Tier-1 pure-logic tests (aggregation, code filter, relative time, compress sizing) via `window.kdStockPart._test`. |
| `test/stockpart-lifecycle.test.mjs` | Create | Tier-2 store/lifecycle tests with an in-memory `firebaseDB` mock. |

**Naming (do not collide with the existing Remnants modal):** CSS `.kdsp-*` (NOT `.kdstock-*`), RTDB `stock_parts` (NOT `nest_remnants`), module `window.kdStockPart` (NOT `kdNest`), localStorage `kd_stock_parts_v1` / `kd_sp_submit_times`.

---

## Task 0: Scaffold the module + wire the tab

**Files:**
- Create: `stockpart.js`
- Modify: `index.html:231` (loader array), `index.html` `.tabs` (≈117)
- Modify: `app.js:202` (`_TAB_IDS`), `app.js:188-200` (`_visibleTabsForRole`), `app.js:8148-8166` (`render`), `app.js` ≈15931 (boot)
- Test: `test/stockpart-logic.test.mjs`

- [ ] **Step 1: Create the module skeleton** — `stockpart.js`

```javascript
;(function () {
  'use strict';

  // ── constants ───────────────────────────────────────────────
  var RTDB_PATH = 'stock_parts';
  var LS_CACHE  = 'kd_stock_parts_v1';     // metadata-only mirror (no photos)
  var LS_SUBMIT = 'kd_sp_submit_times';    // per-device intake rate cap
  var QTY_MIN = 1, QTY_MAX = 99;
  var TARGET_BYTES = 700000;               // compress target (RTDB-friendly)
  var MAX_BYTES = 1500000;                 // hard reject ceiling
  var CAP_WARN = 10, CAP_BLOCK = 20;       // intakes / 24h / device
  var THAI = '"Flux Architect","IBM Plex Sans Thai","Noto Sans Thai","Leelawadee UI","Sukhumvit Set","Thonburi",Tahoma,-apple-system,sans-serif';

  // ── state ───────────────────────────────────────────────────
  var _stockCache = {};   // pushId -> row
  var _undoLast = null;   // pushId of this session's last intake (undo-last)
  var _pickQuery = {};    // per-pending-row code-search text (review screen)

  // ── (helpers, store, render added in later tasks) ───────────

  function renderHome() {
    if (typeof ROOT === 'undefined' || !ROOT) return;
    ROOT.innerHTML = '<div class="kdsp-home"><p class="kdsp-empty">Stock Part — coming up.</p></div>';
  }

  function init() { /* listener wired in Task 2 */ }

  window.kdStockPart = {
    renderHome: renderHome,
    init: init,
    stockQtyByCode: function () { return 0; },   // real impl Task 1
    confirmedByCode: function () { return {}; }, // real impl Task 1
    _test: {}
  };
})();
```

- [ ] **Step 2: Register the script in the loader array** — `index.html:231`

Change:
```javascript
      var names = ['nest.js', 'simbend-sim.js', 'simbend-3d.js', 'dxfFlat.js', 'simbend-3d-ai.js', 'tooling-catalog.js', 'tool-art.js', 'app.js', 'diff-geom.js', 'diff-tools.js', 'antigravity-inject.js'];
```
to (insert `'stockpart.js'` immediately before `'app.js'`):
```javascript
      var names = ['nest.js', 'simbend-sim.js', 'simbend-3d.js', 'dxfFlat.js', 'simbend-3d-ai.js', 'tooling-catalog.js', 'tool-art.js', 'stockpart.js', 'app.js', 'diff-geom.js', 'diff-tools.js', 'antigravity-inject.js'];
```

- [ ] **Step 3: Add the tab button** — `index.html` inside `.tabs` (after the `tab-simbend` button, ≈line 117)

```html
          <button id="tab-stockpart" class="tab" data-view="stockpart"><svg class="nest-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5"/><line x1="12" y1="12" x2="12" y2="21"/></svg>Stock Part</button>
```

- [ ] **Step 4: Register the tab id** — `app.js:202`

Change:
```javascript
const _TAB_IDS = { projects: 'tab-projects', library: 'tab-library', drawing: 'tab-drawing', nest: 'tab-nest', simbend: 'tab-simbend' };
```
to:
```javascript
const _TAB_IDS = { projects: 'tab-projects', library: 'tab-library', drawing: 'tab-drawing', nest: 'tab-nest', simbend: 'tab-simbend', stockpart: 'tab-stockpart' };
```

- [ ] **Step 5: Make the tab visible to every role** — `app.js:188-200` (`_visibleTabsForRole`)

Add `stockpart: true` to the admin return AND each switch branch:
```javascript
function _visibleTabsForRole() {
  if (isAdmin()) return { projects: true, library: true, drawing: true, nest: true, simbend: true, stockpart: true };
  switch (getRole()) {
    case 'laser':    return { projects: true, library: false, drawing: false, nest: true,  simbend: false, stockpart: true };
    case 'bend':     return { projects: true, library: false, drawing: false, nest: false, simbend: true,  stockpart: true };
    case 'assemble': return { projects: true, library: false, drawing: true,  nest: false, simbend: false, stockpart: true };
    default:         return { projects: true, library: false, drawing: true,  nest: false, simbend: false, stockpart: true };
  }
}
```

- [ ] **Step 6: Dispatch the view** — `app.js:8148-8166` (`render`), inside the `stack.length === 0` block

Add the `stockpart` line alongside the other home views:
```javascript
  if (stack.length === 0) {
    if (view === 'projects') return renderProjectsHome();
    if (view === 'nest')     return renderNestHome();
    if (view === 'simbend')  return renderSimBendHome();
    if (view === 'drawing')  return renderDrawingGallery();
    if (view === 'stockpart') return window.kdStockPart.renderHome();
    return renderLibraryHome();
  }
```

- [ ] **Step 7: Call init() at boot** — `app.js` near line 15931 (after `initUploadedDxfsSync();`)

```javascript
  initUploadedDxfsSync();
  if (window.kdStockPart) window.kdStockPart.init();
```

- [ ] **Step 8: Syntax check both JS files**

Run: `node --check stockpart.js && node --check app.js`
Expected: no output (exit 0).

- [ ] **Step 9: Write a smoke test that the module boots and exposes its API** — `test/stockpart-logic.test.mjs`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SRC = readFileSync(new URL('../stockpart.js', import.meta.url), 'utf8');

export function boot() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><main id="root"></main></body></html>', { url: 'http://localhost/' });
  const { window } = dom;
  const store = {};
  window.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
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
  )(window, window.document, window.localStorage, window.ROOT, window.isAdmin, window.getRole, window.escapeHtml, window._kdToast, window._kdOpen3D, window._backgroundRender, window.dxfsForMasterCode, window._uploadedDxfsCache);
  return { window, T: window.kdStockPart._test, KSP: window.kdStockPart };
}

test('module exposes the public API', () => {
  const { KSP } = boot();
  assert.equal(typeof KSP.renderHome, 'function');
  assert.equal(typeof KSP.init, 'function');
  assert.equal(typeof KSP.stockQtyByCode, 'function');
  assert.equal(typeof KSP.confirmedByCode, 'function');
});
```

> Note: the IIFE references the app globals as free variables resolved against `window` (e.g. `ROOT`, `isAdmin`). Passing them as `Function` params (above) puts them in scope for the boot. In the real app they are real `app.js` globals, available because `app.js` loads before any tab click.

- [ ] **Step 10: Run the smoke test (expect PASS)**

Run: `node --test test/stockpart-logic.test.mjs`
Expected: `pass 1`.

- [ ] **Step 11: Commit**

```bash
git add stockpart.js index.html app.js test/stockpart-logic.test.mjs
git commit -m "feat(stock-part): scaffold stockpart.js module + Stock Part tab wiring"
```

---

## Task 1: Pure helpers (aggregation, code filter, relative time, compress sizing)

**Files:**
- Modify: `stockpart.js` (add helpers + expose on `_test`)
- Test: `test/stockpart-logic.test.mjs`

- [ ] **Step 1: Write the failing tests** — append to `test/stockpart-logic.test.mjs`

```javascript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/stockpart-logic.test.mjs`
Expected: FAIL — `T._aggregateConfirmed is not a function` (and similar).

- [ ] **Step 3: Implement the helpers** — in `stockpart.js`, replace the `// ── (helpers...) ──` placeholder with:

```javascript
  // ── pure helpers ────────────────────────────────────────────
  function _aggregateConfirmed(rows) {
    var out = {};
    for (var id in rows) {
      var r = rows[id];
      if (r && r.status === 'confirmed' && r.code) out[r.code] = (out[r.code] || 0) + (r.qty || 0);
    }
    return out;
  }
  function stockQtyByCode(code) { return _aggregateConfirmed(_stockCache)[code] || 0; }
  function confirmedByCode() {
    var out = {};
    for (var id in _stockCache) {
      var r = _stockCache[id];
      if (!r || r.status !== 'confirmed' || !r.code) continue;
      if (!out[r.code]) out[r.code] = { code: r.code, qty: 0, rows: [], thickness_mm: r.thickness_mm, material: r.material };
      out[r.code].qty += (r.qty || 0);
      out[r.code].rows.push(Object.assign({ id: id }, r));
    }
    return out;
  }
  function codePickerFilter(dxfCache, query) {
    var byCode = {};
    for (var stem in dxfCache) {
      var m = dxfCache[stem];
      if (!m || !m.master_code) continue;
      var prev = byCode[m.master_code];
      if (!prev || (m.uploaded_at || 0) > (prev.uploaded_at || 0)) byCode[m.master_code] = Object.assign({ master_code: m.master_code }, m);
    }
    var q = String(query || '').trim().toLowerCase();
    var list = Object.keys(byCode).map(function (k) { return byCode[k]; });
    if (q) list = list.filter(function (m) { return m.master_code.toLowerCase().indexOf(q) !== -1; });
    list.sort(function (a, b) { return a.master_code.localeCompare(b.master_code); });
    return list;
  }
  function relativeTime(now, ts) {
    if (!ts) return '';
    var m = Math.floor(Math.max(0, now - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h';
    var dt = new Date(ts);
    return dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) + '-' + ('0' + dt.getDate()).slice(-2);
  }
  function b64Bytes(s) { return Math.floor((String(s || '').length * 3) / 4); }
  function _scaleFor(w, h, maxEdge) {
    var longest = Math.max(w, h);
    if (longest <= maxEdge) return { w: w, h: h };
    var k = maxEdge / longest;
    return { w: Math.round(w * k), h: Math.round(h * k) };
  }
  function _compressLadder() {
    var ladder = [];
    var edges = [1000, 800, 640];
    var qs = [0.7, 0.6, 0.5, 0.4];
    for (var i = 0; i < edges.length; i++) for (var j = 0; j < qs.length; j++) ladder.push({ maxEdge: edges[i], q: qs[j] });
    return ladder;
  }
```

Then add these to `window.kdStockPart`:
- replace the two stub functions: `stockQtyByCode: stockQtyByCode, confirmedByCode: confirmedByCode,`
- set `_test` to:
```javascript
    _test: {
      _aggregateConfirmed: _aggregateConfirmed,
      confirmedByCode: confirmedByCode,
      codePickerFilter: codePickerFilter,
      relativeTime: relativeTime,
      b64Bytes: b64Bytes,
      _scaleFor: _scaleFor,
      _compressLadder: _compressLadder,
      _setCache: function (c) { _stockCache = c || {}; }
    }
```

- [ ] **Step 4: Run the tests (expect PASS)**

Run: `node --test test/stockpart-logic.test.mjs`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add stockpart.js test/stockpart-logic.test.mjs
git commit -m "feat(stock-part): pure helpers (aggregate, code filter, relative time, compress sizing) + tests"
```

---

## Task 2: RTDB store + live listener + localStorage mirror (lifecycle)

**Files:**
- Modify: `stockpart.js`
- Test: `test/stockpart-lifecycle.test.mjs`

- [ ] **Step 1: Write the failing lifecycle test** — `test/stockpart-lifecycle.test.mjs`

```javascript
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
  window.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
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
  )(window, window.document, window.localStorage, window.ROOT, window.isAdmin, window.getRole, window.escapeHtml, window._kdToast, window._kdOpen3D, window._backgroundRender, window.dxfsForMasterCode, window._uploadedDxfsCache);
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
  const { T, store } = boot();
  window.kdStockPart; // noop
  await T.saveIntake({ status: 'pending', code: '', qty: 1, photo_data: 'BIGBASE64', created_at: 1, created_by_role: 'laser' });
  const mirror = JSON.parse(store['kd_stock_parts_v1']);
  const only = Object.values(mirror)[0];
  assert.ok(!('photo_data' in only), 'photo_data must be stripped from the LS mirror');
  assert.equal(only.qty, 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/stockpart-lifecycle.test.mjs`
Expected: FAIL — `T.saveIntake is not a function`.

- [ ] **Step 3: Implement the store + listener** — add to `stockpart.js` (after the pure helpers)

```javascript
  // ── store (RTDB stock_parts) ────────────────────────────────
  function _ref(id) { return window.firebaseDB.ref(RTDB_PATH + (id ? '/' + id : '')); }
  async function saveIntake(obj) {
    if (!window.firebaseDB) throw new Error('No database connection');
    var r = _ref().push();
    await r.set(obj);
    return r.key;
  }
  async function _updateStock(id, patch) { if (window.firebaseDB && id) await _ref(id).update(patch); }
  async function _deleteStock(id) { if (window.firebaseDB && id) await _ref(id).remove(); }
  async function assignCode(id, code, meta) {
    meta = meta || {};
    await _updateStock(id, { status: 'awaiting_worker_confirm', code: code, thickness_mm: (meta.thickness_mm == null ? null : meta.thickness_mm), material: meta.material || '', grain: meta.grain || '', reviewed_at: Date.now(), reviewed_by_role: 'admin' });
  }
  async function rejectIntake(id) { await _updateStock(id, { status: 'rejected', reviewed_at: Date.now(), reviewed_by_role: 'admin' }); }
  async function workerConfirmGlb(id) { await _updateStock(id, { status: 'confirmed', worker_confirmed_at: Date.now() }); }
  async function workerRejectGlb(id) {
    var r = _stockCache[id] || {};
    await _updateStock(id, { status: 'pending', bounced_from: r.code || '', bounced_at: Date.now(), code: '' });
  }

  // ── listener + localStorage mirror (metadata only) ──────────
  function _stripPhotos(rows) {
    var out = {};
    for (var id in rows) { var c = Object.assign({}, rows[id]); delete c.photo_data; out[id] = c; }
    return out;
  }
  function _loadLS() { try { return JSON.parse(localStorage.getItem(LS_CACHE)) || {}; } catch (e) { return {}; } }
  function _saveLS(rows) { try { localStorage.setItem(LS_CACHE, JSON.stringify(_stripPhotos(rows))); } catch (e) {} }
  function init() {
    _stockCache = _loadLS();   // instant paint (no photos yet)
    if (!window.firebaseDB) return;
    try {
      _ref().on('value', function (snap) {
        _stockCache = snap.val() || {};
        _saveLS(_stockCache);
        if (typeof _backgroundRender === 'function') _backgroundRender();
      }, function (err) { console.warn('[kdStockPart] listener error:', err); });
    } catch (e) { console.warn('[kdStockPart] init failed:', e); }
  }
```

Replace the Task-0 `init` stub with this one. Add these to `window.kdStockPart._test`:
```javascript
      saveIntake: saveIntake, assignCode: assignCode, rejectIntake: rejectIntake,
      workerConfirmGlb: workerConfirmGlb, workerRejectGlb: workerRejectGlb,
      _updateStock: _updateStock, _deleteStock: _deleteStock,
      _snapshot: function () { return _stockCache; },
```

- [ ] **Step 4: Run the tests (expect PASS)**

Run: `node --test test/stockpart-lifecycle.test.mjs`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add stockpart.js test/stockpart-lifecycle.test.mjs
git commit -m "feat(stock-part): RTDB store + 4-state lifecycle + live listener + LS mirror (no photos)"
```

---

## Task 3: Photo compression (canvas)

**Files:** Modify `stockpart.js`. (Canvas isn't unit-tested in jsdom; the sizing math `_scaleFor`/`_compressLadder`/`b64Bytes` is already covered in Task 1. `compressImage` is verified live in Task 9.)

- [ ] **Step 1: Implement `compressImage`** — add to `stockpart.js`

```javascript
  // ── photo compression: returns a base64 jpeg (no data: prefix) or throws ──
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) { reject(new Error('not-image')); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var ladder = _compressLadder(), best = null;
          for (var i = 0; i < ladder.length; i++) {
            var dim = _scaleFor(img.naturalWidth || img.width, img.naturalHeight || img.height, ladder[i].maxEdge);
            var cv = document.createElement('canvas');
            cv.width = dim.w; cv.height = dim.h;
            cv.getContext('2d').drawImage(img, 0, 0, dim.w, dim.h);
            var b64 = cv.toDataURL('image/jpeg', ladder[i].q).split(',')[1] || '';
            best = b64;
            if (b64Bytes(b64) <= TARGET_BYTES) break;
          }
          URL.revokeObjectURL(url);
          if (!best || b64Bytes(best) > MAX_BYTES) { reject(new Error('too-large')); return; }
          resolve(best);
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode-failed')); };
      img.src = url;
    });
  }
```

- [ ] **Step 2: Syntax check**

Run: `node --check stockpart.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add stockpart.js
git commit -m "feat(stock-part): client-side JPEG compression (ladder, target 700KB, reject >1.5MB)"
```

---

## Task 4: Worker capture screen (Thai)

**Files:** Modify `stockpart.js`.

- [ ] **Step 1: Implement capture + rate cap + undo-last** — add to `stockpart.js`

```javascript
  // ── per-device intake rate cap ──────────────────────────────
  function _submitTimes() { try { return JSON.parse(localStorage.getItem(LS_SUBMIT)) || []; } catch (e) { return []; } }
  function _recordSubmit() {
    var now = Date.now(), arr = _submitTimes().filter(function (t) { return now - t < 86400000; });
    arr.push(now);
    try { localStorage.setItem(LS_SUBMIT, JSON.stringify(arr)); } catch (e) {}
    return arr.length;
  }
  function _submitCount24h() { var now = Date.now(); return _submitTimes().filter(function (t) { return now - t < 86400000; }).length; }

  // ── capture screen (worker, Thai) ───────────────────────────
  function _buildCapture() {
    var el = document.createElement('section');
    el.className = 'kdsp-card kdsp-th';
    el.innerHTML =
      '<h3 class="kdsp-h">เพิ่มของเข้าคลัง</h3>' +
      '<label class="kdsp-photo" id="kdsp-photo-label"><input type="file" accept="image/*" capture="environment" id="kdsp-photo" hidden>' +
      '<span class="kdsp-photo-hint">ถ่ายรูป part</span></label>' +
      '<img class="kdsp-preview" id="kdsp-preview" alt="" hidden>' +
      '<div class="kdsp-row"><span>จำนวน</span><div class="kdsp-qty">' +
        '<button type="button" id="kdsp-qminus">−</button><b id="kdsp-qval">1</b><button type="button" id="kdsp-qplus">+</button>' +
      '</div></div>' +
      '<input type="text" id="kdsp-note" class="kdsp-input" placeholder="หมายเหตุ (ไม่บังคับ)">' +
      '<button type="button" id="kdsp-submit" class="kdsp-btn kdsp-btn-primary" disabled>ส่งเข้าคิวตรวจ</button>';

    var qty = 1, photoB64 = null;
    var qval = el.querySelector('#kdsp-qval'), submit = el.querySelector('#kdsp-submit');
    function setQty(n) { qty = Math.min(QTY_MAX, Math.max(QTY_MIN, n)); qval.textContent = String(qty); }
    el.querySelector('#kdsp-qminus').onclick = function () { setQty(qty - 1); };
    el.querySelector('#kdsp-qplus').onclick = function () { setQty(qty + 1); };
    el.querySelector('#kdsp-photo').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      submit.disabled = true; el.querySelector('.kdsp-photo-hint').textContent = 'กำลังย่อรูป…';
      compressImage(f).then(function (b64) {
        photoB64 = b64;
        var pv = el.querySelector('#kdsp-preview'); pv.src = 'data:image/jpeg;base64,' + b64; pv.hidden = false;
        el.querySelector('.kdsp-photo-hint').textContent = 'ถ่ายใหม่';
        submit.disabled = false;
      }).catch(function (err) {
        photoB64 = null; submit.disabled = true;
        el.querySelector('.kdsp-photo-hint').textContent = 'ถ่ายรูป part';
        _kdToast(err && err.message === 'too-large' ? 'รูปใหญ่เกินไป ลองถ่ายใหม่' : 'ไฟล์รูปไม่ถูกต้อง ลองใหม่');
      });
    });
    submit.addEventListener('click', async function () {
      if (!photoB64) return;
      if (_submitCount24h() >= CAP_BLOCK) { _kdToast('วันนี้เพิ่มของเยอะเกินไปแล้ว ลองพรุ่งนี้'); return; }
      var row = { status: 'pending', code: '', qty: qty, note: el.querySelector('#kdsp-note').value || '', photo_data: photoB64, created_at: Date.now(), created_by_role: (typeof getRole === 'function' ? getRole() : 'workshop') };
      submit.disabled = true;
      try {
        if (JSON.stringify(row).length > MAX_BYTES) throw new Error('too-large');
        _undoLast = await saveIntake(row);
        _recordSubmit();
        _kdToast('ส่งแล้ว รอเอ๋ตรวจ · กดเลิกได้');
        renderHome();
      } catch (e) { submit.disabled = false; _kdToast('บันทึกไม่สำเร็จ ลองใหม่'); }
    });
    return el;
  }

  async function _undoLastIntake() {
    if (!_undoLast) return;
    var id = _undoLast; _undoLast = null;
    try { await _deleteStock(id); _kdToast('ยกเลิกแล้ว'); renderHome(); } catch (e) { _kdToast('ยกเลิกไม่สำเร็จ'); }
  }
```

> The "undo" affordance: after a submit, `renderHome()` re-renders; show an "เลิกล่าสุด" button at the top of the capture card when `_undoLast` is set (added in `_buildCapture` header when `_undoLast` truthy — engineer wires the button to `_undoLastIntake`). Keep it one-step + session-scoped.

- [ ] **Step 2: Wire the undo button** — at the top of `_buildCapture`'s `innerHTML`, prepend (only when `_undoLast`):

```javascript
      (_undoLast ? '<button type="button" id="kdsp-undo" class="kdsp-btn kdsp-btn-ghost">เลิกล่าสุด</button>' : '') +
```
and after building `el`, add: `var u = el.querySelector('#kdsp-undo'); if (u) u.onclick = _undoLastIntake;`

- [ ] **Step 3: Syntax check**

Run: `node --check stockpart.js`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add stockpart.js
git commit -m "feat(stock-part): worker capture screen (Thai) + rate cap + undo-last"
```

---

## Task 5: Admin review queue + code picker

**Files:** Modify `stockpart.js`.

- [ ] **Step 1: Implement review + code picker** — add to `stockpart.js`

```javascript
  // ── admin review queue + code picker ────────────────────────
  function _pending() {
    var out = [];
    for (var id in _stockCache) { var r = _stockCache[id]; if (r && r.status === 'pending') out.push(Object.assign({ id: id }, r)); }
    out.sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });
    return out;
  }
  function _buildReview() {
    var el = document.createElement('section'); el.className = 'kdsp-section';
    var rows = _pending();
    var h = '<h3 class="kdsp-h">Review queue <span class="kdsp-count">' + rows.length + '</span></h3>';
    if (!rows.length) h += '<p class="kdsp-empty">Nothing to review</p>';
    el.innerHTML = h;
    var now = Date.now();
    rows.forEach(function (r) {
      var card = document.createElement('div'); card.className = 'kdsp-card';
      var bounce = r.bounced_from ? '<div class="kdsp-flag">ช่างบอกไม่ใช่ ' + escapeHtml(r.bounced_from) + '</div>' : '';
      card.innerHTML =
        '<div class="kdsp-revrow">' +
          '<img class="kdsp-thumb" src="data:image/jpeg;base64,' + (r.photo_data || '') + '" alt="">' +
          '<div class="kdsp-revmeta">' +
            '<p class="kdsp-muted">Qty ' + (r.qty || 0) + ' · by ' + escapeHtml(r.created_by_role || '') + ' · ' + relativeTime(now, r.created_at) + '</p>' +
            bounce +
            '<input type="text" class="kdsp-input kdsp-pick-q" placeholder="Find part code…" data-id="' + escapeHtml(r.id) + '">' +
            '<div class="kdsp-pick-results" data-id="' + escapeHtml(r.id) + '"></div>' +
            '<p class="kdsp-ai-slot kdsp-muted">AI suggestion — coming soon</p>' +
            '<div class="kdsp-actions">' +
              '<button type="button" class="kdsp-btn kdsp-btn-primary kdsp-assign" data-id="' + escapeHtml(r.id) + '" disabled>Assign code → send to worker</button>' +
              '<button type="button" class="kdsp-btn kdsp-btn-danger kdsp-reject" data-id="' + escapeHtml(r.id) + '">Reject</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      el.appendChild(card);

      var chosen = { code: '', meta: {} };
      var input = card.querySelector('.kdsp-pick-q');
      var results = card.querySelector('.kdsp-pick-results');
      var assignBtn = card.querySelector('.kdsp-assign');
      function paintResults() {
        var list = codePickerFilter(_uploadedDxfsCache || {}, input.value).slice(0, 30);
        if (!list.length) { results.innerHTML = '<p class="kdsp-muted">No matching code</p>'; return; }
        results.innerHTML = list.map(function (m) {
          return '<div class="kdsp-cand" data-code="' + escapeHtml(m.master_code) + '">' +
            '<code>' + escapeHtml(m.master_code) + '</code>' +
            '<span class="kdsp-muted">' + (m.thickness_mm != null ? m.thickness_mm + 'mm' : '') + ' ' + escapeHtml(m.material || '') + ' ' + escapeHtml(m.grain || '') + '</span>' +
            '<button type="button" class="kdsp-3d" data-code="' + escapeHtml(m.master_code) + '">3D</button>' +
            '<button type="button" class="kdsp-use" data-code="' + escapeHtml(m.master_code) + '" data-th="' + (m.thickness_mm == null ? '' : m.thickness_mm) + '" data-mat="' + escapeHtml(m.material || '') + '" data-grn="' + escapeHtml(m.grain || '') + '">use</button>' +
          '</div>';
        }).join('');
      }
      input.addEventListener('input', paintResults);
      results.addEventListener('click', function (e) {
        var b3 = e.target.closest('.kdsp-3d'); if (b3) { _kdOpen3D(b3.getAttribute('data-code')); return; }
        var bu = e.target.closest('.kdsp-use'); if (!bu) return;
        chosen = { code: bu.getAttribute('data-code'), meta: { thickness_mm: bu.getAttribute('data-th') ? Number(bu.getAttribute('data-th')) : null, material: bu.getAttribute('data-mat'), grain: bu.getAttribute('data-grn') } };
        input.value = chosen.code; assignBtn.disabled = false; paintResults();
      });
      assignBtn.addEventListener('click', async function () {
        if (!chosen.code) return; assignBtn.disabled = true;
        try { await assignCode(r.id, chosen.code, chosen.meta); _kdToast('ส่งให้ช่างยืนยันแล้ว'); } catch (e) { assignBtn.disabled = false; _kdToast('บันทึกไม่สำเร็จ'); }
      });
      card.querySelector('.kdsp-reject').addEventListener('click', async function () {
        try { await rejectIntake(r.id); _kdToast('ปฏิเสธแล้ว'); } catch (e) { _kdToast('ทำรายการไม่สำเร็จ'); }
      });
    });
    return el;
  }
```

- [ ] **Step 2: Syntax check**

Run: `node --check stockpart.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add stockpart.js
git commit -m "feat(stock-part): admin review queue + code picker (uploaded_dxfs search + 3D compare)"
```

---

## Task 6: Worker GLB-confirm screen (Thai)

**Files:** Modify `stockpart.js`.

- [ ] **Step 1: Implement the confirm-GLB list** — add to `stockpart.js`

```javascript
  // ── worker confirm-GLB list (Thai) ──────────────────────────
  function _awaiting() {
    var out = [];
    for (var id in _stockCache) { var r = _stockCache[id]; if (r && r.status === 'awaiting_worker_confirm') out.push(Object.assign({ id: id }, r)); }
    out.sort(function (a, b) { return (b.reviewed_at || 0) - (a.reviewed_at || 0); });
    return out;
  }
  function _buildWorkerConfirm() {
    var el = document.createElement('section'); el.className = 'kdsp-section kdsp-th';
    var rows = _awaiting();
    el.innerHTML = '<h3 class="kdsp-h">รอยืนยันว่าใช่ part นี้ไหม</h3>' + (rows.length ? '' : '<p class="kdsp-empty">ยังไม่มีรายการรอยืนยัน</p>');
    rows.forEach(function (r) {
      var card = document.createElement('div'); card.className = 'kdsp-card';
      card.innerHTML =
        '<div class="kdsp-revrow">' +
          '<img class="kdsp-thumb" src="data:image/jpeg;base64,' + (r.photo_data || '') + '" alt="">' +
          '<div class="kdsp-revmeta">' +
            '<p class="kdsp-muted"><code>' + escapeHtml(r.code || '') + '</code> · ' + (r.thickness_mm != null ? r.thickness_mm + 'mm ' : '') + escapeHtml(r.material || '') + '</p>' +
            '<button type="button" class="kdsp-btn kdsp-btn-ghost kdsp-see3d" data-code="' + escapeHtml(r.code || '') + '">ดูรูป 3D</button>' +
            '<div class="kdsp-actions">' +
              '<button type="button" class="kdsp-btn kdsp-btn-primary kdsp-ok" data-id="' + escapeHtml(r.id) + '">✓ ถูกต้อง</button>' +
              '<button type="button" class="kdsp-btn kdsp-btn-danger kdsp-no" data-id="' + escapeHtml(r.id) + '">✗ ไม่ใช่</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      el.appendChild(card);
      card.querySelector('.kdsp-see3d').addEventListener('click', function () { if (r.code) _kdOpen3D(r.code); });
      card.querySelector('.kdsp-ok').addEventListener('click', async function () {
        try { await workerConfirmGlb(r.id); _kdToast('เข้าคลังแล้ว ขอบคุณ'); } catch (e) { _kdToast('ทำรายการไม่สำเร็จ'); }
      });
      card.querySelector('.kdsp-no').addEventListener('click', async function () {
        try { await workerRejectGlb(r.id); _kdToast('ส่งกลับให้เอ๋เลือกใหม่'); } catch (e) { _kdToast('ทำรายการไม่สำเร็จ'); }
      });
    });
    return el;
  }
```

- [ ] **Step 2: Syntax check + commit**

Run: `node --check stockpart.js`
```bash
git add stockpart.js
git commit -m "feat(stock-part): worker GLB-confirm screen (Thai, photo + 3D + check/reject)"
```

---

## Task 7: Stock list (grouped, search, admin edit/delete) + renderHome router

**Files:** Modify `stockpart.js`.

- [ ] **Step 1: Implement the stock list + the role router** — add to `stockpart.js`

```javascript
  // ── stock list ──────────────────────────────────────────────
  var _listQuery = '';
  function _buildList(readOnly) {
    var el = document.createElement('section'); el.className = 'kdsp-section';
    var groups = confirmedByCode();
    var codes = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b); });
    if (_listQuery) { var q = _listQuery.toLowerCase(); codes = codes.filter(function (c) { return c.toLowerCase().indexOf(q) !== -1; }); }
    el.innerHTML = '<div class="kdsp-listhead"><h3 class="kdsp-h">Stock parts</h3>' +
      '<input type="text" id="kdsp-search" class="kdsp-input" placeholder="Search code…" value="' + escapeHtml(_listQuery) + '"></div>';
    var grid = document.createElement('div'); grid.className = 'kdsp-grid'; el.appendChild(grid);
    if (!codes.length) { grid.innerHTML = '<p class="kdsp-empty">' + (_listQuery ? 'No matching code' : 'No stock yet') + '</p>'; }
    codes.forEach(function (code) {
      var g = groups[code];
      var card = document.createElement('div'); card.className = 'kdsp-card kdsp-stockcard';
      var photo = (g.rows[0] && g.rows[0].photo_data) ? '<img class="kdsp-thumb" src="data:image/jpeg;base64,' + g.rows[0].photo_data + '" alt="">' : '<div class="kdsp-thumb kdsp-noimg"></div>';
      card.innerHTML = photo +
        '<code class="kdsp-code">' + escapeHtml(code) + '</code>' +
        '<div class="kdsp-meta"><span class="kdsp-pill">×' + g.qty + ' in stock</span>' +
        '<span class="kdsp-muted">' + (g.thickness_mm != null ? g.thickness_mm + 'mm ' : '') + escapeHtml(g.material || '') + '</span></div>' +
        '<div class="kdsp-cardfoot"><button type="button" class="kdsp-link kdsp-view3d" data-code="' + escapeHtml(code) + '">View 3D</button>' +
        (readOnly ? '' : '<button type="button" class="kdsp-icon kdsp-del" data-code="' + escapeHtml(code) + '" title="delete one row">✕</button>') + '</div>';
      grid.appendChild(card);
      card.querySelector('.kdsp-view3d').addEventListener('click', function () { _kdOpen3D(code); });
      if (!readOnly) card.querySelector('.kdsp-del').addEventListener('click', async function () {
        var rid = g.rows[0] && g.rows[0].id; if (!rid) return;
        try { await _deleteStock(rid); _kdToast('ลบ 1 แถวแล้ว'); } catch (e) { _kdToast('ลบไม่สำเร็จ'); }
      });
    });
    var search = el.querySelector('#kdsp-search');
    search.addEventListener('input', function () { _listQuery = search.value; renderHome(); setTimeout(function () { var s = ROOT.querySelector('#kdsp-search'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }, 0); });
    return el;
  }

  // ── role router ─────────────────────────────────────────────
  function renderHome() {
    if (typeof ROOT === 'undefined' || !ROOT) return;
    if (ROOT.querySelector && ROOT.querySelector('.kdsp-input:focus') && document.activeElement && document.activeElement.id !== 'kdsp-search') return; // don't yank focus mid-type (except search, handled above)
    var admin = (typeof isAdmin === 'function') && isAdmin();
    ROOT.innerHTML = '';
    var wrap = document.createElement('div'); wrap.className = 'kdsp-home';
    if (admin) { wrap.appendChild(_buildReview()); wrap.appendChild(_buildList(false)); }
    else { wrap.appendChild(_buildCapture()); wrap.appendChild(_buildWorkerConfirm()); wrap.appendChild(_buildList(true)); }
    ROOT.appendChild(wrap);
  }
```

Replace the Task-0 `renderHome` stub with this final one (and ensure `window.kdStockPart.renderHome` still points at it).

- [ ] **Step 2: Syntax check**

Run: `node --check stockpart.js && node --test test/stockpart-logic.test.mjs test/stockpart-lifecycle.test.mjs`
Expected: syntax OK; all tests still pass.

- [ ] **Step 3: Commit**

```bash
git add stockpart.js
git commit -m "feat(stock-part): stock list (grouped, search, admin delete) + role-based renderHome"
```

---

## Task 8: Styling (`.kdsp-*` + Thai font + theme safety)

**Files:** Modify `style.css`.

- [ ] **Step 1: Append the base styles** — at the END of `style.css`

```css
/* ── Stock Part (S1) ─────────────────────────────────────────── */
.kdsp-home { max-width: 760px; margin: 0 auto; padding: 12px; display: flex; flex-direction: column; gap: 16px; }
.kdsp-th { font-family: "Flux Architect", "IBM Plex Sans Thai", "Noto Sans Thai", "Leelawadee UI", "Sukhumvit Set", "Thonburi", Tahoma, -apple-system, sans-serif; }
.kdsp-section { display: flex; flex-direction: column; gap: 10px; }
.kdsp-h { font-size: 16px; margin: 0 0 4px; }
.kdsp-count { opacity: .6; font-weight: normal; }
.kdsp-card { background: #1b2330; border: 1px solid #2c3a4e; border-radius: 12px; padding: 12px; }
.kdsp-empty, .kdsp-muted { color: #8a97a8; }
.kdsp-photo { display: flex; align-items: center; justify-content: center; min-height: 120px; border: 1px dashed #3a4a60; border-radius: 12px; cursor: pointer; }
.kdsp-preview, .kdsp-thumb { max-width: 100%; border-radius: 10px; }
.kdsp-thumb { width: 92px; height: 92px; object-fit: cover; background: #0f1419; }
.kdsp-noimg { display: inline-block; }
.kdsp-row { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
.kdsp-qty { display: flex; align-items: center; gap: 12px; }
.kdsp-qty button { width: 36px; height: 36px; border-radius: 8px; font-size: 18px; }
.kdsp-input { width: 100%; box-sizing: border-box; padding: 9px 12px; border-radius: 8px; border: 1px solid #2c3a4e; background: #0f1419; color: #e8eef5; margin-top: 8px; }
.kdsp-btn { padding: 10px 14px; border-radius: 10px; border: 1px solid #2c3a4e; background: transparent; color: #e8eef5; cursor: pointer; }
.kdsp-btn-primary { background: #d29922; border-color: #d29922; color: #1b2330; font-weight: 600; }
.kdsp-btn-danger { color: #ff8a80; border-color: #5a2b2b; }
.kdsp-btn-ghost { opacity: .85; }
.kdsp-btn[disabled] { opacity: .45; cursor: default; }
.kdsp-revrow { display: flex; gap: 12px; }
.kdsp-revmeta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.kdsp-actions { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
.kdsp-flag { color: #ff8a80; font-size: 13px; }
.kdsp-pick-results, .kdsp-cand { display: flex; flex-direction: column; gap: 4px; }
.kdsp-cand { flex-direction: row; align-items: center; gap: 8px; padding: 4px 0; }
.kdsp-cand code { font-size: 13px; }
.kdsp-listhead { display: flex; align-items: center; gap: 12px; justify-content: space-between; }
.kdsp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.kdsp-stockcard { display: flex; flex-direction: column; gap: 8px; }
.kdsp-code { font-size: 13px; }
.kdsp-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kdsp-pill { background: #1f3d2e; color: #7ee0a8; border-radius: 999px; padding: 2px 9px; font-size: 12px; }
.kdsp-cardfoot { display: flex; align-items: center; justify-content: space-between; border-top: 1px solid #2c3a4e; padding-top: 8px; }
.kdsp-link { background: none; border: none; color: #6fb1ff; cursor: pointer; padding: 0; }
.kdsp-icon { background: none; border: none; color: #8a97a8; cursor: pointer; }
.kdsp-ai-slot { font-size: 12px; font-style: italic; }
```

- [ ] **Step 2: Add per-theme opaque overrides** — inside the `html[data-theme="sketch"]` block (next to the existing `.kdstock-box.kdstock-box` rule ≈line 5600), add the doubled-class form:

```css
html[data-theme="sketch"] .kdsp-card.kdsp-card { background-color: var(--paper2) !important; border: 1px solid var(--pen) !important; }
html[data-theme="sketch"] .kdsp-input.kdsp-input { background-color: var(--paper) !important; color: var(--ink) !important; }
html[data-theme="sketch"] .kdsp-btn-primary.kdsp-btn-primary { background-color: var(--pen) !important; color: var(--paper) !important; }
```
and the same in the `html[data-theme="chalk"]` block (≈line 6320) using `--board2`/`--board`/`--line`:
```css
html[data-theme="chalk"] .kdsp-card.kdsp-card { background-color: var(--board2) !important; border: 1px solid var(--line) !important; }
html[data-theme="chalk"] .kdsp-input.kdsp-input { background-color: var(--board) !important; color: var(--chalk, #e8eef5) !important; }
html[data-theme="chalk"] .kdsp-btn-primary.kdsp-btn-primary { background-color: var(--line) !important; color: var(--board) !important; }
```

> Verify the exact CSS var names that the sketch/chalk blocks already use (grep `--paper2` / `--board2` in style.css) and match them; the doubled-class `.kdsp-card.kdsp-card` (specificity 0,2,0) is required to beat the `(0,2,5)` blanket reset.

- [ ] **Step 3: Commit**

```bash
git add style.css
git commit -m "feat(stock-part): styles + Thai font class + sketch/chalk opaque theme overrides"
```

---

## Task 9: Live verification + board log

**Files:** none (verification + coordination).

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: the existing suite + `stockpart-logic`/`stockpart-lifecycle` all pass.

- [ ] **Step 2: Push and watch the deploy**

```bash
git push origin main
gh run watch
```
Then `fetch(no-store)` the live `stockpart.js` until it contains `kdStockPart` (per [[feedback_check_deploy]]; say "the live file"/"CDN", never "edge").

- [ ] **Step 3: Live manual verification in Chrome (NOT Edge), real devices**

Verify on the live host:
1. Tab "Stock Part" shows for a worker role and for admin.
2. Worker: take a photo (phone camera) + qty → "ส่งเข้าคิวตรวจ" → appears in admin Review queue. Thai labels render (Leelawadee UI/system Thai), not boxes.
3. Admin: search a real code from `uploaded_dxfs`, "3D" opens the model, "use" → "Assign code → send to worker".
4. Worker: item appears in "รอยืนยัน", "ดูรูป 3D" opens the GLB, "✓ ถูกต้อง" → moves to Stock list with `×N in stock`; test "✗ ไม่ใช่" on another → returns to admin queue flagged "ช่างบอกไม่ใช่ …".
5. Stock list: search filters; admin ✕ deletes one row; View 3D works.
6. Theme check: switch dark / sketch / chalk / obsidian — every `.kdsp-*` surface stays opaque + readable (getComputedStyle in DevTools).
7. Console: 0 errors through the whole round-trip.

- [ ] **Step 4: Log to the coordination board** — append ONE entry to `docs/coordination/group-sync.md` (per [[feedback_log_changes_to_sync]]): what shipped (Stock Part S1), the real commit hash, live-verified note, and that S2 (nest don't-re-cut) will need Group 1. Commit + push the board.

```bash
git add docs/coordination/group-sync.md
git commit -m "board: Stock Part S1 shipped + live-verified"
git push origin main
```

---

## Self-review checklist (run after implementing)

- **Spec coverage:** capture / review / worker-confirm / list / code-picker / lifecycle / Thai font / theme safety / escaping / quota guards — each has a task above. ✓
- **Type/name consistency:** `status` values (`pending`/`awaiting_worker_confirm`/`confirmed`/`rejected`), field names (`code`, `qty`, `photo_data`, `bounced_from`, `reviewed_by_role`, `worker_confirmed_at`), and function names (`saveIntake`/`assignCode`/`workerConfirmGlb`/`workerRejectGlb`/`rejectIntake`/`stockQtyByCode`/`confirmedByCode`/`renderHome`/`init`) are used identically across tasks and tests. ✓
- **No placeholders:** every code step has real code; the only "verify exact var name" notes are for the sketch/chalk CSS custom-properties (which differ per theme block and must be matched live). 
- **Escaping:** all user/data strings rendered via `escapeHtml`; codes in `data-*`/`querySelector` use `escapeHtml`/`CSS.escape`; photos via `data:` URI (inert). ✓
