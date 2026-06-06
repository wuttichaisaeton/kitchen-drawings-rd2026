# Nest "Run Temp" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `⚡ Run Temp` button to the Web Nest workspace that nests ad-hoc typed `code`/`qty` parts, previews them, and downloads cut-sheet DXFs locally — persisting nothing.

**Architecture:** A self-contained modal owns all temp state in modal-local vars (never `S`). Temp reuses the existing packer (`_nestMultiSheet`), DXF parser (`_loadDxfInto`, extracted from `_loadAllDxfs`), sheet renderer (`_drawSheet`), and cut-sheet DXF builder (`_buildSheetDxf`). Piece-building and thickness-keying are extracted to shared pure helpers so the temp path and the normal `_runNesting` path stay DRY.

**Tech Stack:** Vanilla JS (`drawings-ui/nest.js`, loaded directly — no bundler), Firebase RTDB (read-only here), GitHub Pages deploy. No test framework in-repo → pure helpers verified via `node -e` harnesses (copy-paste pattern already used for the nest_parts merge), `node --check nest.js` as the syntax gate, and a scripted manual live-verification checklist for DOM/Firebase behaviour.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `drawings-ui/nest.js` | Button, modal, temp helpers, refactors | Modify |
| `drawings-ui/style.css` | `.kdtemp-*` modal styles | Modify (small; reuse `.kdstock-*` where possible) |

All new functions live inside the existing nest.js IIFE alongside their siblings.

**New/changed symbols (names are contractual across tasks):**
- `_loadDxfInto(p)` — async, single-part DXF fetch+parse (extracted).
- `_thickKey(t)` — module-level thickness key (hoisted from `_runNesting`).
- `_partsToPieces(parts)` — pure, parts → packer pieces (extracted).
- `_classifyTempParts(parts)` — pure, splits resolved parts into `{ok, notFound, noGeom}`.
- `_resolveTempParts(rows)` — async, `[{code,qty}]` → resolved part objects.
- `_computeTempSheets(okParts)` — sync, `{sheets, unplaced, noStock}` (no remnants).
- `_downloadDxfText(filename, text)` — DOM blob download.
- `_openRunTempModal()` — the modal.

---

## Task 1: Extract `_loadDxfInto(p)` from `_loadAllDxfs` (behaviour-preserving)

**Files:**
- Modify: `drawings-ui/nest.js` (`_loadAllDxfs`, ~line 468–495)

- [ ] **Step 1: Replace `_loadAllDxfs` with an extracted single-part loader**

Replace the whole existing `_loadAllDxfs` function (lines ~468–495) with:

```js
  // Fetch + parse ONE part's DXF into polys/bbox/w/h. Used by the bulk
  // project loader (_loadAllDxfs) AND by Run Temp (per ad-hoc code).
  async function _loadDxfInto(p) {
    if (!p.dxfUrl) { p.dxfError = 'No DXF uploaded yet'; return; }
    try {
      const fetchUrl = _toJsdelivrUrl(p.dxfUrl);
      const resp = await fetch(fetchUrl, { cache: 'force-cache' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      const parsed = window.dxf.parseString(text);
      const ex = _extractPolygons(parsed);
      p.polys = { outer: ex.outer, strokes: ex.strokes || [], holes: ex.holes };
      p.bbox = ex.bbox;
      if (ex.bbox) {
        // Default W/H to the bbox dimensions; user can override.
        p.w = Math.round(ex.bbox[2] - ex.bbox[0]);
        p.h = Math.round(ex.bbox[3] - ex.bbox[1]);
      }
      p.dxfLoaded = true;
    } catch (e) {
      p.dxfError = String(e.message || e);
    }
  }

  async function _loadAllDxfs() {
    await _ensureDxfLib();
    await Promise.all(S.parts.map(p => _loadDxfInto(p)));
  }
```

- [ ] **Step 2: Syntax gate**

Run: `cd drawings-ui && node --check nest.js`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
cd drawings-ui
git add nest.js
git commit -m "refactor(nest): extract _loadDxfInto from _loadAllDxfs"
```

---

## Task 2: Hoist `_thickKey` + extract pure `_partsToPieces`

**Files:**
- Modify: `drawings-ui/nest.js` (`_runNesting`, ~line 1804–1853)

- [ ] **Step 1: Write the failing test (pure logic harness)**

Create a throwaway harness (NOT committed) `drawings-ui/_t.mjs`:

```js
function _thickKey(t) {
  const n = typeof t === 'number' ? t : parseFloat(String(t).replace(/[^\d.]/g, ''));
  return isNaN(n) ? '?' : String(Math.round(n * 100) / 100);
}
function _partsToPieces(parts) {
  const pieces = [];
  for (const p of parts) {
    if (!p.selected) continue;
    if (p.w <= 0 || p.h <= 0) continue;
    if (!p.bbox && !p.manual) continue;
    const bbox = p.bbox || [0, 0, p.w, p.h];
    const rots = (p.grain === 'H') ? [0, 180]
               : (p.grain === 'V') ? [90, 270]
               :                     [0, 90, 180, 270];
    for (let i = 0; i < p.qty; i++) {
      pieces.push({ code: p.code, w: p.w, h: p.h, rots,
        polys: p.polys, bbox, thickness: p.thickness,
        grain: String(p.grain || 'ANY').toUpperCase() });
    }
  }
  return pieces;
}
import assert from 'assert';
// qty expands; unselected/zero/no-bbox skipped; grain gates rotations
const parts = [
  { code:'A', qty:2, selected:true, w:10, h:20, bbox:[0,0,10,20], grain:'H', thickness:1, polys:null },
  { code:'B', qty:1, selected:false, w:5, h:5, bbox:[0,0,5,5], grain:'V', thickness:1 },
  { code:'C', qty:1, selected:true, w:0, h:5, bbox:[0,0,0,5], grain:'ANY', thickness:1 },
  { code:'D', qty:1, selected:true, w:5, h:5, manual:true, grain:'ANY', thickness:0.8 },
];
const pc = _partsToPieces(parts);
assert.strictEqual(pc.length, 3, 'A×2 + D×1 (B unselected, C zero-w skipped)');
assert.deepStrictEqual(pc[0].rots, [0,180], 'H grain → 0/180');
assert.deepStrictEqual(pc[2].bbox, [0,0,5,5], 'manual synthesises bbox');
assert.strictEqual(_thickKey('0.8mm'), '0.8');
assert.strictEqual(_thickKey(1), '1');
assert.strictEqual(_thickKey('junk'), '?');
console.log('PASS Task2');
```

- [ ] **Step 2: Run it to confirm the algorithm is correct**

Run: `cd drawings-ui && node _t.mjs`
Expected: `PASS Task2`

- [ ] **Step 3: Add the module-level helpers to nest.js**

Insert directly ABOVE `function _runNesting() {` (line ~1804):

```js
  // Module-level thickness key (also used inside _runNesting via a local
  // alias, and by Run Temp's _computeTempSheets). '?' when unparseable.
  function _thickKey(t) {
    const n = typeof t === 'number' ? t : parseFloat(String(t).replace(/[^\d.]/g, ''));
    return isNaN(n) ? '?' : String(Math.round(n * 100) / 100);
  }

  // Expand parts → per-instance packer pieces (qty copies; rotations gated
  // by grain: H=0/180, V=90/270, else all four). Shared by _runNesting and
  // Run Temp so the two paths can't drift. Pure.
  function _partsToPieces(parts) {
    const pieces = [];
    for (const p of parts) {
      if (!p.selected) continue;
      if (p.w <= 0 || p.h <= 0) continue;
      if (!p.bbox && !p.manual) continue;
      const bbox = p.bbox || [0, 0, p.w, p.h];
      const rots = (p.grain === 'H') ? [0, 180]
                 : (p.grain === 'V') ? [90, 270]
                 :                     [0, 90, 180, 270];
      for (let i = 0; i < p.qty; i++) {
        pieces.push({
          code: p.code, w: p.w, h: p.h, rots: rots,
          polys: p.polys, bbox: bbox, thickness: p.thickness,
          grain: String(p.grain || 'ANY').toUpperCase(),
        });
      }
    }
    return pieces;
  }
```

- [ ] **Step 4: Rewire `_runNesting` to use the shared helpers**

In `_runNesting`, replace the piece-building block (the `const pieces = [];` loop, lines ~1809–1825) with:

```js
    const pieces = _partsToPieces(S.parts);
```

Then replace the local `function thickKey(t) { ... }` definition (lines ~1844–1847) with a local alias so the existing `thickKey(...)` call sites below are unchanged:

```js
    const thickKey = _thickKey;
```

- [ ] **Step 5: Syntax gate + confirm no leftover duplicate**

Run: `cd drawings-ui && node --check nest.js`
Expected: exit 0.
Run: `grep -n "function thickKey" nest.js`
Expected: no matches (only the `const thickKey = _thickKey;` alias remains).

- [ ] **Step 6: Remove the harness and commit**

```bash
cd drawings-ui
rm _t.mjs
git add nest.js
git commit -m "refactor(nest): hoist _thickKey + extract _partsToPieces (shared by Run Temp)"
```

---

## Task 3: Pure `_classifyTempParts` + async `_resolveTempParts`

**Files:**
- Modify: `drawings-ui/nest.js` (add functions near `_loadDxfInto`)

- [ ] **Step 1: Test `_classifyTempParts` (pure)**

Create throwaway `drawings-ui/_t.mjs`:

```js
function _classifyTempParts(parts) {
  const ok = [], notFound = [], noGeom = [];
  for (const p of parts) {
    if (!p.dxfUrl) { notFound.push(p.code); continue; }
    if (p.dxfError || !p.bbox || !(p.w > 0 && p.h > 0)) { noGeom.push(p.code); continue; }
    ok.push(p);
  }
  return { ok, notFound, noGeom };
}
import assert from 'assert';
const r = _classifyTempParts([
  { code:'A', dxfUrl:'u', bbox:[0,0,1,1], w:1, h:1 },           // ok
  { code:'B', dxfUrl:'' },                                        // not found
  { code:'C', dxfUrl:'u', dxfError:'HTTP 404' },                 // no geom
  { code:'D', dxfUrl:'u', bbox:null, w:0, h:0 },                 // no geom
]);
assert.deepStrictEqual(r.ok.map(p=>p.code), ['A']);
assert.deepStrictEqual(r.notFound, ['B']);
assert.deepStrictEqual(r.noGeom, ['C','D']);
console.log('PASS Task3');
```

- [ ] **Step 2: Run it**

Run: `cd drawings-ui && node _t.mjs`
Expected: `PASS Task3`

- [ ] **Step 3: Add both functions to nest.js**

Insert directly BELOW `_loadDxfInto` (after its closing brace):

```js
  // Split resolved temp parts into usable vs problem buckets for the summary.
  function _classifyTempParts(parts) {
    const ok = [], notFound = [], noGeom = [];
    for (const p of parts) {
      if (!p.dxfUrl) { notFound.push(p.code); continue; }
      if (p.dxfError || !p.bbox || !(p.w > 0 && p.h > 0)) { noGeom.push(p.code); continue; }
      ok.push(p);
    }
    return { ok, notFound, noGeom };
  }

  // Resolve ad-hoc [{code, qty}] rows into part objects with geometry, the
  // same way the project list does — uploaded_dxfs/<code> meta + grain.json
  // rules + DXF fetch/parse. Read-only; never writes anywhere.
  async function _resolveTempParts(rows) {
    await _ensureDxfLib();
    try { await _loadGrainRows(); _grainRowsToMap(); } catch (e) {
      console.warn('[kdNest] temp grain rules load failed (continuing):', e);
    }
    const parts = [];
    for (const row of rows) {
      const code = String(row.code || '').trim();
      if (!code) continue;
      const qty = Math.max(1, parseInt(row.qty, 10) || 1);
      const p = {
        code: code, qty: qty, selected: true, manual: false,
        grain: 'ANY', thickness: 0, w: 0, h: 0,
        polys: null, bbox: null, dxfUrl: '', dxfMeta: null,
      };
      try {
        if (window.firebaseDB) {
          const snap = await window.firebaseDB.ref('uploaded_dxfs/' + code).once('value');
          const meta = snap.val();
          if (meta) {
            p.dxfUrl = meta.url || '';
            p.dxfMeta = meta;
            p.thickness = meta.thickness_mm || 0;
            if (meta.grain) p.grain = String(meta.grain).toUpperCase();
          }
        }
      } catch (e) { /* leave dxfUrl empty → classified not-found */ }
      // Grain/thickness rule override (same priority as the main list).
      if (S.grainMap) {
        const looked = _lookupPattern(code, S.grainMap);
        if (looked && looked.grain) p.grain = looked.grain;
        if (looked && looked.thickness && !p.thickness) {
          const t = parseFloat(String(looked.thickness).replace(/mm/i, ''));
          if (!isNaN(t)) p.thickness = t;
        }
      }
      if (p.dxfUrl) { await _loadDxfInto(p); }
      parts.push(p);
    }
    return parts;
  }
```

- [ ] **Step 4: Syntax gate**

Run: `cd drawings-ui && node --check nest.js`
Expected: exit 0.

- [ ] **Step 5: Remove harness + commit**

```bash
cd drawings-ui
rm _t.mjs
git add nest.js
git commit -m "feat(nest): add _classifyTempParts + _resolveTempParts for Run Temp"
```

---

## Task 4: `_computeTempSheets` (no remnants, no persistence)

**Files:**
- Modify: `drawings-ui/nest.js` (add below `_resolveTempParts`)

- [ ] **Step 1: Add the function**

Insert below `_resolveTempParts`:

```js
  // Nest the ok temp parts into sheets — reuses the core packer but NEVER
  // touches remnants, S.flatSheets, or any persistence. Returns the sheets
  // + leftover pieces. (Run Temp = skipRemnants forced true.)
  function _computeTempSheets(okParts) {
    const pieces = _partsToPieces(okParts);
    const activeStock = S.sheetStock.filter(s => s.w > 0 && s.h > 0 && (s.qty !== 0 || s.qty === -1));
    if (pieces.length === 0) return { sheets: [], unplaced: [], noStock: false };
    if (activeStock.length === 0) return { sheets: [], unplaced: pieces, noStock: true };
    const byThick = new Map();
    for (const piece of pieces) {
      const k = _thickKey(piece.thickness);
      if (!byThick.has(k)) byThick.set(k, []);
      byThick.get(k).push(piece);
    }
    const allSheets = [], allUnplaced = [];
    for (const [tk, group] of byThick) {
      const stockForThick = activeStock.filter(s => _thickKey(s.thickness ?? 1) === tk);
      if (stockForThick.length === 0) { allUnplaced.push(...group); continue; }
      const r = _nestMultiSheet(group, stockForThick, S.gap, S.mode);
      for (const s of r.sheets) allSheets.push({ thick: tk, sw: s.sw, sh: s.sh, placements: s.placements, fromRemnant: null });
      allUnplaced.push(...r.unplaced);
    }
    return { sheets: allSheets, unplaced: allUnplaced, noStock: false };
  }
```

- [ ] **Step 2: Syntax gate**

Run: `cd drawings-ui && node --check nest.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
cd drawings-ui
git add nest.js
git commit -m "feat(nest): add _computeTempSheets (temp nest, no remnants/persistence)"
```

---

## Task 5: `_downloadDxfText` blob download

**Files:**
- Modify: `drawings-ui/nest.js` (add near `_buildSheetDxf`, ~line 2710)

- [ ] **Step 1: Add the helper**

Insert directly ABOVE `function _buildSheetDxf(sheet) {`:

```js
  // Trigger a local download of DXF text as a file. Used by Run Temp's
  // Download button — no GitHub upload, purely client-side blob.
  function _downloadDxfText(filename, text) {
    const blob = new Blob([text], { type: 'application/dxf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
```

- [ ] **Step 2: Syntax gate**

Run: `cd drawings-ui && node --check nest.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
cd drawings-ui
git add nest.js
git commit -m "feat(nest): add _downloadDxfText blob helper"
```

---

## Task 6: The Run Temp modal

**Files:**
- Modify: `drawings-ui/nest.js` (add `_openRunTempModal` near `_renderStockModal`, ~line 846)

- [ ] **Step 1: Add `_openRunTempModal`**

Insert directly ABOVE `function _openStockModal() {` (line ~846):

```js
  // ⚡ Run Temp — ad-hoc one-off nest for missing/dropped parts. Type
  // code/qty, nest (reusing the packer + current stock, NO remnants),
  // preview, then download cut-sheet DXFs locally. Persists NOTHING:
  // all state lives in this closure; closing the modal discards it.
  function _openRunTempModal() {
    document.querySelectorAll('.kdtemp-modal').forEach(m => m.remove());

    let rows = [{ code: '', qty: '' }];   // entry rows
    let tempSheets = [];                  // last run result (local only)
    let sheetIdx = 0;
    let lastSummary = '';

    const modal = document.createElement('div');
    modal.className = 'kdtemp-modal';
    document.body.appendChild(modal);
    const close = () => modal.remove();   // discard — nothing was saved

    function rowsHtml() {
      return rows.map((r, i) =>
        '<div class="kdtemp-row">'
        + '<input class="kdtemp-code" data-i="' + i + '" type="text" placeholder="Part code" value="' + _esc(r.code) + '">'
        + '<input class="kdtemp-qty" data-i="' + i + '" type="number" min="1" placeholder="1" value="' + _esc(r.qty) + '">'
        + '<button class="kdtemp-del" data-i="' + i + '" title="Remove row">✕</button>'
        + '</div>').join('');
    }

    function render() {
      const hasResult = tempSheets.length > 0;
      const sheet = hasResult ? tempSheets[sheetIdx] : null;
      modal.innerHTML = '<div class="kdtemp-backdrop"></div>'
        + '<div class="kdtemp-box">'
        + '<div class="kdtemp-head">⚡ Run Temp'
        + '<span class="kdtemp-sub">one-off cut · not saved</span></div>'
        + '<div class="kdtemp-entry">' + rowsHtml()
        + '<button id="kdtemp-add" class="kdnest-mini">+ Add</button></div>'
        + (lastSummary ? '<div class="kdtemp-summary">' + _esc(lastSummary) + '</div>' : '')
        + (hasResult
            ? '<div class="kdtemp-preview">'
              + '<div class="kdtemp-nav"><button id="kdtemp-prev" class="kdnest-nav-btn">‹</button>'
              + '<span class="kdtemp-navinfo">Sheet ' + (sheetIdx + 1) + ' / ' + tempSheets.length
              + ' · ' + Math.round(sheet.sw) + '×' + Math.round(sheet.sh)
              + ' · ' + _esc(String(sheet.thick)) + 'mm</span>'
              + '<button id="kdtemp-next" class="kdnest-nav-btn">›</button></div>'
              + '<canvas id="kdtemp-canvas" class="kdtemp-canvas"></canvas></div>'
            : '')
        + '<div class="kdtemp-foot">'
        + '<button id="kdtemp-primary" class="kdnest-btn kdnest-btn-run">'
        + (hasResult ? '⬇ Download Temp' : '⚡ Run') + '</button>'
        + '<span class="kdng-spacer"></span>'
        + '<button id="kdtemp-close" class="kdnest-btn">Close</button>'
        + '</div></div>';
      wire();
      if (sheet) {
        const cv = modal.querySelector('#kdtemp-canvas');
        if (cv) { _drawSheet(cv, sheet); requestAnimationFrame(() => _drawSheet(cv, sheet)); }
      }
    }

    function readRows() {
      modal.querySelectorAll('.kdtemp-code').forEach(el => { rows[+el.dataset.i].code = el.value; });
      modal.querySelectorAll('.kdtemp-qty').forEach(el => { rows[+el.dataset.i].qty = el.value; });
    }

    async function run() {
      readRows();
      const entry = rows.filter(r => String(r.code || '').trim());
      if (entry.length === 0) { lastSummary = 'Enter at least one part code.'; render(); return; }
      const btn = modal.querySelector('#kdtemp-primary');
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Resolving…'; }
      let parts;
      try {
        parts = await _resolveTempParts(entry);
      } catch (e) {
        lastSummary = 'Resolve failed: ' + (e.message || e);
        tempSheets = []; render(); return;
      }
      const { ok, notFound, noGeom } = _classifyTempParts(parts);
      const res = _computeTempSheets(ok);
      tempSheets = res.sheets;
      sheetIdx = 0;
      const placed = tempSheets.reduce((n, s) => n + s.placements.length, 0);
      const unplacedCodes = [...new Set(res.unplaced.map(p => p.code))];
      lastSummary =
        (res.noStock ? 'No usable sheet stock — set W/H/qty in the nest panel first. ' : '')
        + tempSheets.length + ' sheets · placed ' + placed
        + (unplacedCodes.length ? ' · unplaced [' + unplacedCodes.join(', ') + ']' : '')
        + (notFound.length ? ' · not found [' + notFound.join(', ') + ']' : '')
        + (noGeom.length ? ' · no DXF [' + noGeom.join(', ') + ']' : '');
      render();
    }

    function download() {
      if (tempSheets.length === 0) return;
      const ts = _jobStamp();
      tempSheets.forEach((sheet, i) => {
        setTimeout(() => {
          try {
            const dxf = _buildSheetDxf(sheet);
            _downloadDxfText('TEMP_' + ts + '_s' + (i + 1) + '.dxf', dxf);
          } catch (e) { console.warn('[kdNest] temp sheet ' + (i + 1) + ' build failed:', e); }
        }, i * 250);
      });
      // Download = done. Give the last download a moment to fire, then close.
      setTimeout(close, tempSheets.length * 250 + 300);
    }

    function wire() {
      const q = sel => modal.querySelector(sel);
      q('.kdtemp-backdrop')?.addEventListener('click', close);
      q('#kdtemp-close')?.addEventListener('click', close);
      q('#kdtemp-add')?.addEventListener('click', () => { readRows(); rows.push({ code: '', qty: '' }); render(); });
      modal.querySelectorAll('.kdtemp-del').forEach(b => b.addEventListener('click', e => {
        readRows();
        const i = +e.currentTarget.dataset.i;
        rows.splice(i, 1);
        if (rows.length === 0) rows = [{ code: '', qty: '' }];
        render();
      }));
      const primary = q('#kdtemp-primary');
      if (primary) primary.addEventListener('click', () => {
        if (tempSheets.length > 0) download();
        else run();
      });
      q('#kdtemp-prev')?.addEventListener('click', () => { if (sheetIdx > 0) { sheetIdx--; render(); } });
      q('#kdtemp-next')?.addEventListener('click', () => { if (sheetIdx < tempSheets.length - 1) { sheetIdx++; render(); } });
    }

    // Esc closes (discard).
    const onKey = e => { if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(); } };
    document.addEventListener('keydown', onKey);

    render();
  }
```

> NOTE: when the user edits code/qty then hits **+ Add** or **Run**, `readRows()` captures the current input values first so nothing typed is lost on re-render. Editing any input after a result is shown does NOT auto-clear `tempSheets` — pressing the primary button while a result exists downloads; to re-nest a changed set the user removes/edits rows then... (the button is in Download state). To force a fresh run after a result, the user closes and reopens, OR we treat any code/qty `input` event as invalidating the result — see Task 6 Step 2.

- [ ] **Step 2: Invalidate a stale result when entry changes**

So an edited entry can't be downloaded as the old result, add input invalidation. In `wire()`, after the `.kdtemp-del` block, add:

```js
      modal.querySelectorAll('.kdtemp-code, .kdtemp-qty').forEach(el => el.addEventListener('input', () => {
        if (tempSheets.length > 0) {
          readRows();
          tempSheets = [];
          lastSummary = 'Entry changed — press ⚡ Run again.';
          render();
        }
      }));
```

- [ ] **Step 3: Syntax gate**

Run: `cd drawings-ui && node --check nest.js`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
cd drawings-ui
git add nest.js
git commit -m "feat(nest): add Run Temp modal (entry, run, preview, download, discard)"
```

---

## Task 7: Wire the `⚡ Run Temp` button into the toolbar

**Files:**
- Modify: `drawings-ui/nest.js` (toolbar HTML ~line 3081; `_wireEvents` ~line 3122)

- [ ] **Step 1: Add the button to the actions row**

In the `.kdnest-actions` block, directly AFTER the `#kdnest-run` button line (~3081), add:

```js
            <button id="kdnest-runtemp" class="kdnest-btn kdnest-btn-runtemp" title="One-off cut for a missing/dropped part — type code, nest, download DXF. Not saved.">⚡ Run Temp</button>
```

- [ ] **Step 2: Register the listener**

In `_wireEvents`, directly AFTER the `$('#kdnest-run')?.addEventListener('click', _runNesting);` line (~3122), add:

```js
    $('#kdnest-runtemp')?.addEventListener('click', _openRunTempModal);
```

- [ ] **Step 3: Syntax gate**

Run: `cd drawings-ui && node --check nest.js`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
cd drawings-ui
git add nest.js
git commit -m "feat(nest): wire up the ⚡ Run Temp toolbar button"
```

---

## Task 8: `.kdtemp-*` styles

**Files:**
- Modify: `drawings-ui/style.css`

- [ ] **Step 1: Find the existing stock-modal styles to mirror**

Run: `cd drawings-ui && grep -n "kdstock-modal\|kdstock-box\|kdstock-backdrop\|kdstock-head" style.css | head`
Expected: line numbers for the stock modal block (the visual template).

- [ ] **Step 2: Append the temp-modal styles**

Append to the end of `style.css` (values mirror the stock modal; adjust only if the stock block uses different tokens — keep the same backdrop/box/head look):

```css
/* ⚡ Run Temp modal — one-off nest, nothing persisted. Mirrors .kdstock-modal. */
.kdtemp-modal { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; }
.kdtemp-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.55); }
.kdtemp-box { position: relative; background: #0e1620; border: 1px solid #24323f; border-radius: 10px;
  width: min(560px, 94vw); max-height: 90vh; overflow: auto; padding: 14px 16px; box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
.kdtemp-head { font-size: 16px; font-weight: 600; color: #e6f0f5; display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.kdtemp-sub { font-size: 12px; color: #8aa0ad; font-weight: 400; }
.kdtemp-entry { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.kdtemp-row { display: flex; gap: 6px; align-items: center; }
.kdtemp-row .kdtemp-code { flex: 1 1 auto; }
.kdtemp-row .kdtemp-qty { width: 64px; }
.kdtemp-row input { background: #0b1117; border: 1px solid #24323f; color: #e6f0f5; border-radius: 6px; padding: 6px 8px; }
.kdtemp-del { background: transparent; border: 0; color: #c46; font-size: 15px; cursor: pointer; }
.kdtemp-summary { font-size: 12.5px; color: #cfe0ea; background: #0b1117; border: 1px solid #1d2935;
  border-radius: 6px; padding: 7px 9px; margin-bottom: 10px; line-height: 1.45; }
.kdtemp-preview { margin-bottom: 10px; }
.kdtemp-nav { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 6px; }
.kdtemp-navinfo { font-size: 12px; color: #9fb4c0; }
.kdtemp-canvas { width: 100%; height: 320px; background: #0b1117; border: 1px solid #1d2935; border-radius: 6px; display: block; }
.kdtemp-foot { display: flex; align-items: center; gap: 8px; }
.kdnest-btn-runtemp { background: #3a2d12; border-color: #6b5320; color: #ffd98a; }
```

- [ ] **Step 3: Commit**

```bash
cd drawings-ui
git add style.css
git commit -m "style(nest): .kdtemp-* Run Temp modal styles"
```

---

## Task 9: Integration — deploy + live verification

**Files:** none (verification only)

- [ ] **Step 1: Final syntax gate**

Run: `cd drawings-ui && node --check nest.js`
Expected: exit 0.

- [ ] **Step 2: Pull, push, watch deploy**

```bash
cd drawings-ui
git pull --rebase origin main
git push origin main
gh run list --limit 1
gh run watch <run-id> --exit-status
gh run view <run-id> --json status,conclusion -q '.status + " / " + .conclusion'
```
Expected: `completed / success`.

- [ ] **Step 3: Live manual verification (admin) on `wuttichaisaeton.github.io/kitchen-drawings-rd2026`**

Open a project → Nest workspace. Confirm sheet stock has at least one usable row. Then:

1. Click `⚡ Run Temp` → modal opens with one empty row + `+ Add`.
2. Type a real part code that has an uploaded DXF, qty `2` → `⚡ Run`.
   - Expected: preview canvas draws the sheet(s); summary shows `N sheets · placed 2`; button is now `⬇ Download Temp`.
3. Add a second row with a bogus code `ZZZNOPE` → button flips back to `⚡ Run` with "Entry changed"; press Run.
   - Expected: summary lists `not found [ZZZNOPE]`; the valid part still packs.
4. Click `⬇ Download Temp` → one `.dxf` per sheet downloads (`TEMP_<ts>_sN.dxf`); modal closes.
5. Open the downloaded DXF in a viewer → the part outline(s) are present.
6. **No-persistence check:** in the Firebase console, confirm `nest_jobs/<pk>`, `nest_parts/<pk>` are unchanged (no new entry with this timestamp); in the GitHub repo, confirm no new file under `CutSheets/<pk>/`.
7. Reopen `⚡ Run Temp`, type a code, Run, then close with ✕ WITHOUT downloading → reopen: entry is empty (nothing remembered).
8. **No-regression:** run normal `▶ Run Nesting` + `💾 Save Project` → still works; the temp run did not alter `S.flatSheets` (the main canvas still shows the normal result).

- [ ] **Step 4: Report to user**

Summarise: deploy conclusion, the 8 checks above, elapsed time (⏱). Note the no-persistence + no-regression confirmations explicitly.

---

## Self-Review

**Spec coverage:**
- Button `⚡ Run Temp` → Task 7. ✓
- Isolated modal, code/qty entry → Task 6. ✓
- Resolve geometry from `uploaded_dxfs` + grain rules → Task 3. ✓
- Reuse packer + current stock, no remnants → Task 4. ✓
- Per-sheet preview (`_drawSheet`) → Task 6. ✓
- Single toggle button Run ⇄ Download → Task 6 (`#kdtemp-primary`). ✓
- Download cut-sheet DXF per sheet, no upload → Tasks 5 + 6. ✓
- Discard on close, persists nothing → Task 6 (`close`) + Task 9 Step 3 checks 6–7. ✓
- `_loadDxfInto` extraction → Task 1. ✓
- DRY piece-building / thickness key → Task 2. ✓
- CSS → Task 8. ✓
- No-regression on normal flow → Task 2 Step 5 + Task 9 Step 3 check 8. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code. The NOTE after Task 6 Step 1 is explanatory, resolved by Step 2. ✓

**Type/name consistency:** `_loadDxfInto`, `_thickKey`, `_partsToPieces`, `_classifyTempParts` (`{ok,notFound,noGeom}`), `_resolveTempParts`, `_computeTempSheets` (`{sheets,unplaced,noStock}`), `_downloadDxfText(filename,text)`, `_openRunTempModal`, ids `#kdnest-runtemp`/`#kdtemp-primary`/`#kdtemp-canvas` — used consistently across tasks. ✓
