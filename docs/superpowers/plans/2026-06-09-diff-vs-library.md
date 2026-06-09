# Diff vs Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the web app, let a user compare a part against a similar Library part and see a categorised, mm-accurate diff (holes, size, bends, cutouts, thickness).

**Architecture:** Adopt GA's prior-art `diff-tools.js` (Level B PDF pixel-diff + Level C DXF hole-diff + 3-tab Compare modal, already overrides app.js's Level A `_openSimilarCompareModal`). Add a pure, node-testable `_geomDiff()` in a new `diff-geom.js`, and evolve the modal's 3rd tab into a "Geometry Diff" that renders `_geomDiff` output + a text summary. The hole rule (T=0.5mm centre, dia>0.1mm resized) is the shared contract with G1's CC_DiffHoles.

**Tech Stack:** Vanilla JS (no bundler — `app.js`/`index.html`/`diff-tools.js`/`diff-geom.js` load directly via cache-busted script tags), pdf.js (Level B), `KD_DXFFLAT.parseFlatDxf` from `dxfFlat.js` (Level C+), HTML canvas. Pure logic node-tested; UI live-verified via the preview server (plain-DOM modal).

**Conventions:** Commit explicit paths only (shared tree has other agents' WIP). No Thai in rendered UI. Verify live before each board ping. `git fetch` + check `rev-list --left-right --count HEAD...origin/main`; push directly when 0 behind (rebase blocked by others' dirty tracked files).

---

### Task B: Adopt + wire GA's Level B/C foundation (ship first)

GA built a near-complete Level B + C + 3-tab modal in untracked `diff-tools.js` and a matching `index.html` edit (adds pdf.js + registers `diff-tools.js`). RD ruled G2 owns Diff B/C; adopt as-is, credit GA. No new logic — this is adoption + live verification.

**Files:**
- Create (commit untracked): `diff-tools.js`
- Modify (commit GA's edit): `index.html` (pdf.js script + `diff-tools.js` in the cache-bust load array)

- [ ] **Step 1: Read both files to confirm they are GA's Diff work and nothing else**

Run: `git diff index.html` and open `diff-tools.js`.
Expected: `index.html` adds only the pdf.js `<script>` + `pdfjsLib`/worker shim + `'diff-tools.js'` in the load array. `diff-tools.js` defines `_renderPdfToCanvas`, `_runPdfVisualDiff`, `_runDxfHoleDiff`, `_openSimilarCompareModal` (the 3-tab override). No unrelated changes. If `index.html` has unrelated edits, stage only the wiring hunks with `git add -p`.

- [ ] **Step 2: Syntax-check diff-tools.js**

Run: `node --check diff-tools.js`
Expected: no output (exit 0).

- [ ] **Step 3: Commit the two files (explicit paths, credit GA)**

```bash
git fetch origin main && git rev-list --left-right --count HEAD...origin/main
git add diff-tools.js index.html
git commit -m "feat(diff): adopt Level B+C Compare modal (diff-tools.js) — GA prior-art, wired

3-tab Compare modal overrides app.js Level A _openSimilarCompareModal:
Side-by-Side PDF / Visual PDF Diff (pdf.js pixel-diff) / DXF Hole Diff
(KD_DXFFLAT, T=0.5mm added/removed). index.html loads pdf.js + diff-tools.js.

Co-authored-by: GA (Antigravity)
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push origin main
```
Expected: push succeeds (0 behind), or `git pull --rebase` is blocked by others' dirty files → push directly since 0 behind.

- [ ] **Step 4: Live-verify the override works**

In the running preview (port 3030): reload (cross a minute so the `?v` cache-bust refetches), open project `02 Ruth`, switch to the Library tab, find a part row with a 🔍 `.part-compare-btn`, click it. Via `preview_eval`, assert the enhanced modal rendered:
```js
(() => {
  const ov = document.querySelector('.bt-overlay');
  return {
    modal: !!ov,
    tabs: [...document.querySelectorAll('#cmp-btn-sidebyside,#cmp-btn-pdfdiff,#cmp-btn-dxfdiff')].map(b=>b.textContent),
    pdfjs: !!window.pdfjsLib,
    parser: !!window.KD_DXFFLAT
  };
})()
```
Expected: `modal:true`, `tabs:["Side-by-Side PDF","Visual PDF Diff","DXF Hole Diff"]`, `pdfjs:true`, `parser:true`. Then click `#cmp-btn-pdfdiff` and confirm the single-view canvas container appears (no console error via `preview_console_logs level:error`).

- [ ] **Step 5: Board ping**

Append to `docs/coordination/group-sync.md`: "G2 DONE Diff B+C adopted+wired (commit <hash>), 3-tab Compare modal live (🔍 on part rows), pdf.js+KD_DXFFLAT load, 0 errors." Commit explicit path + push.

---

### Task C: Pure `_geomDiff()` (full G1 def incl. resized) + node test + evolve tab

Build the complete pure diff engine (all 6 categories) in a new node-testable file. Wire only the HOLES surface this task (added/removed/**resized**), satisfying "Level C refined to full G1 def". Later tasks surface the already-computed categories.

**Files:**
- Create: `diff-geom.js`
- Create: `test/geomdiff.test.js`
- Modify: `index.html` (add `'diff-geom.js'` before `'diff-tools.js'` in the load array)
- Modify: `diff-tools.js` (3rd tab → "Geometry Diff": call `KD_GEOMDIFF.geomDiff` + new `_renderGeomDiff`)

- [ ] **Step 1: Write the failing node test (synthetic flats)**

Create `test/geomdiff.test.js`:
```js
const assert = require('assert');
const { geomDiff } = require('../diff-geom.js');

// minimal parsed-flat builder: bbox + circle holes + rect cutouts + bends
const flat = (w, h, holes, rects, bends) => ({
  bbox: { minX: 0, minY: 0, maxX: w, maxY: h, w, h },
  holes: [].concat(
    (holes || []).map(([x, y, r]) => ({ type: 'circle', c: [x, y], r })),
    (rects || []).map(pts => ({ type: 'rect', pts }))
  ),
  bends: (bends || []).map(([mx, my, len, dir]) => ({ mid: [mx, my], len, dir, a: [0,0], b: [0,0] })),
  outline: { segments: [] }
});

// base: 2 holes (d10 @10,10 ; d10 @90,10). comp: drops the 2nd, adds one @50,50,
// and resizes the 1st to d12 (dia diff 2mm > 0.1).
const base = flat(100, 60, [[10,10,5],[90,10,5]]);
const comp = flat(150, 60, [[10,10,6],[50,50,5]]);

const r = geomDiff(base, comp, { thickness: 1.0 }, { thickness: 1.0 });
assert.strictEqual(r.holes.removed.length, 1, 'one hole removed (90,10)');
assert.strictEqual(r.holes.added.length, 1, 'one hole added (50,50)');
assert.strictEqual(r.holes.resized.length, 1, 'one hole resized (10,10 d10->d12)');
assert.strictEqual(r.dims.dW, 50, 'width +50');
assert.strictEqual(r.dims.dH, 0, 'height same');
assert.strictEqual(r.material.sameTh, true, 'thickness same');
console.log('geomdiff.test OK');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/geomdiff.test.js`
Expected: FAIL — `Cannot find module '../diff-geom.js'`.

- [ ] **Step 3: Implement `diff-geom.js` (full pure engine)**

Create `diff-geom.js`:
```js
// diff-geom.js — pure geometric diff between two parsed flat-DXF parts.
// Shared contract w/ G1 CC_DiffHoles: hole = circular interior loop; compared in a
// shared bbox-origin frame; T=0.5mm centre match, dia diff >0.1mm = "resized".
(function (root) {
  var T = 0.5, DIA_T = 0.1;
  function _circles(flat) {
    var bx = flat.bbox.minX, by = flat.bbox.minY;
    return (flat.holes || []).filter(function (h) { return h.type === 'circle'; })
      .map(function (h) { return { cx: h.c[0] - bx, cy: h.c[1] - by, d: 2 * h.r, r: h.r }; });
  }
  function _rects(flat) {
    var bx = flat.bbox.minX, by = flat.bbox.minY;
    return (flat.holes || []).filter(function (h) { return h.type === 'rect'; })
      .map(function (h) {
        var sx = 0, sy = 0, n = h.pts.length;
        h.pts.forEach(function (p) { sx += p[0]; sy += p[1]; });
        return { cx: sx / n - bx, cy: sy / n - by, pts: h.pts };
      });
  }
  function _bends(flat) {
    var bx = flat.bbox.minX, by = flat.bbox.minY;
    return (flat.bends || []).map(function (b) {
      return { mx: b.mid[0] - bx, my: b.mid[1] - by, len: b.len, dir: b.dir, a: b.a, b: b.b };
    });
  }
  function _near(a, b) { return Math.hypot(a.cx - b.cx, a.cy - b.cy) <= T; }
  function _nearM(a, b) { return Math.hypot(a.mx - b.mx, a.my - b.my) <= T; }
  function _th(rec) {
    if (!rec) return null;
    if (rec.thickness != null) return +rec.thickness;
    if (rec.thickness_mm != null) return +rec.thickness_mm;
    return null;
  }
  function geomDiff(baseFlat, compFlat, baseRec, compRec) {
    var bH = _circles(baseFlat), cH = _circles(compFlat);
    var hAdded = [], hRemoved = [], hResized = [];
    bH.forEach(function (b) {
      var m = cH.find(function (c) { return _near(b, c); });
      if (!m) hRemoved.push(b);
      else if (Math.abs(m.d - b.d) > DIA_T) hResized.push({ cx: b.cx, cy: b.cy, r: m.r, baseD: b.d, compD: m.d });
    });
    cH.forEach(function (c) { if (!bH.find(function (b) { return _near(b, c); })) hAdded.push(c); });

    var bb = baseFlat.bbox, cb = compFlat.bbox;
    var dims = { baseW: bb.w, baseH: bb.h, compW: cb.w, compH: cb.h,
                 dW: +(cb.w - bb.w).toFixed(2), dH: +(cb.h - bb.h).toFixed(2) };

    var bB = _bends(baseFlat), cB = _bends(compFlat);
    var bnAdded = [], bnRemoved = [];
    bB.forEach(function (b) { if (!cB.find(function (c) { return _nearM(b, c); })) bnRemoved.push(b); });
    cB.forEach(function (c) { if (!bB.find(function (b) { return _nearM(b, c); })) bnAdded.push(c); });

    var bR = _rects(baseFlat), cR = _rects(compFlat);
    var cuAdded = [], cuRemoved = [];
    bR.forEach(function (b) { if (!cR.find(function (c) { return _near(b, c); })) cuRemoved.push(b); });
    cR.forEach(function (c) { if (!bR.find(function (b) { return _near(b, c); })) cuAdded.push(c); });

    var bt = _th(baseRec), ct = _th(compRec);
    var material = { baseTh: bt, compTh: ct,
                     sameTh: (bt != null && ct != null) ? Math.abs(bt - ct) <= 0.001 : bt === ct };

    return {
      dims: dims,
      holes: { added: hAdded, removed: hRemoved, resized: hResized },
      bends: { added: bnAdded, removed: bnRemoved, baseN: bB.length, compN: cB.length },
      cutouts: { added: cuAdded, removed: cuRemoved },
      outline: { changed: dims.dW !== 0 || dims.dH !== 0 },
      material: material
    };
  }
  root.KD_GEOMDIFF = { geomDiff: geomDiff, T: T, DIA_T: DIA_T };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.KD_GEOMDIFF;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/geomdiff.test.js`
Expected: `geomdiff.test OK` (exit 0).

- [ ] **Step 5: Wire `diff-geom.js` into index.html**

In `index.html`, in the cache-bust load array, add `'diff-geom.js'` immediately before `'diff-tools.js'`:
```js
['nest.js', ..., 'app.js', 'diff-geom.js', 'diff-tools.js', 'antigravity-inject.js']
```
Run: `node --check index.html` is N/A (HTML); instead grep to confirm: `grep -n "diff-geom.js" index.html` → one hit before `diff-tools.js`.

- [ ] **Step 6: Add `_renderGeomDiff` + summary, repurpose 3rd tab**

In `diff-tools.js`: (a) rename the 3rd tab button text `DXF Hole Diff` → `Geometry Diff`; (b) in `updateView()`'s `dxfdiff` branch, call a new `_renderGeomDiff(baseCode, currentCompareCode, canvasContainer)` instead of `_runDxfHoleDiff`. Add `_renderGeomDiff` (fetches both flat DXFs like `_runDxfHoleDiff`, parses via `KD_DXFFLAT.parseFlatDxf`, gets BOM recs, calls `KD_GEOMDIFF.geomDiff`, draws the compare flat outline + holes with green=added / red=removed(X) / **amber=resized** rings, and writes a summary line into a side panel). Reuse `_runDxfHoleDiff`'s canvas-fit math (translate/scale, `1/scale` linewidths). Summary this task = holes only:
```js
const s = `${d.holes.added.length} added · ${d.holes.removed.length} removed · ${d.holes.resized.length} resized`;
```
Keep `_runDxfHoleDiff` in the file (unused) or delete it; deleting is cleaner — remove it and its tab references are already replaced.

- [ ] **Step 7: Live-verify holes incl. resized**

Preview: open the Compare modal, switch to "Geometry Diff" tab on a pair with flat DXFs (`CVIL00-205093 v3` vs `v7` if both load; else verify the render path renders the outline + summary without error). Via `preview_eval` read the summary panel text + `preview_console_logs level:error` (none). The authoritative correctness check is the node test (Step 4); the live check confirms the render path + amber resized ring.

- [ ] **Step 8: Commit + board ping**

```bash
git fetch origin main && git rev-list --left-right --count HEAD...origin/main
git add diff-geom.js test/geomdiff.test.js index.html diff-tools.js
git commit -m "feat(diff): pure _geomDiff (G1 def incl. dia>0.1 resized) + Geometry Diff tab

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push origin main
```
Board: "G2 DONE Level C refined — _geomDiff resized (dia>0.1mm amber), node-tested, Geometry Diff tab live."

---

### Task 1: Surface outer-dimensions diff

`_geomDiff.dims` is already computed + node-tested (Task C Step 1 asserts `dW`/`dH`). This task only adds it to the summary panel + a size badge.

**Files:**
- Modify: `diff-tools.js` (`_renderGeomDiff` summary)
- Modify: `test/geomdiff.test.js` (add a dims-only assertion variant)

- [ ] **Step 1: Extend the node test**

Append to `test/geomdiff.test.js`:
```js
const r2 = geomDiff(flat(100,60,[]), flat(100,90,[]));
assert.strictEqual(r2.dims.dW, 0, 'W same');
assert.strictEqual(r2.dims.dH, 30, 'H +30');
console.log('geomdiff dims OK');
```

- [ ] **Step 2: Run test**

Run: `node test/geomdiff.test.js`
Expected: `geomdiff.test OK` then `geomdiff dims OK`.

- [ ] **Step 3: Add dims to summary**

In `_renderGeomDiff`, prepend a dims line:
```js
const fmt = v => v === 0 ? 'same' : (v > 0 ? `+${v}` : `${v}`) + 'mm';
const dimLine = `Size: W ${fmt(d.dims.dW)} · H ${fmt(d.dims.dH)} (base ${d.dims.baseW}x${d.dims.baseH} → ${d.dims.compW}x${d.dims.compH})`;
```
Render `dimLine` above the holes line in the summary panel.

- [ ] **Step 4: Live-verify + commit + board ping**

Preview: Geometry Diff tab shows the Size line. `preview_console_logs level:error` none. Commit `diff-tools.js test/geomdiff.test.js`; board: "G2 DONE Diff category (1) outer dims + delta mm."

---

### Task 2: Surface bend diff + canvas highlight

`_geomDiff.bends` already computed/returned. Add summary line + draw added/removed bend lines on the canvas.

**Files:**
- Modify: `diff-tools.js` (`_renderGeomDiff`: bend summary + draw bend segments)
- Modify: `test/geomdiff.test.js`

- [ ] **Step 1: Extend node test**

```js
const rb = geomDiff(
  flat(100,60,[],[],[[50,0,60,'V']]),
  flat(100,60,[],[],[[50,0,60,'V'],[10,0,60,'V']])
);
assert.strictEqual(rb.bends.added.length, 1, 'one bend added @x=10');
assert.strictEqual(rb.bends.removed.length, 0, 'no bend removed');
console.log('geomdiff bends OK');
```

- [ ] **Step 2: Run test** — Run: `node test/geomdiff.test.js`; Expected: all three OK lines.

- [ ] **Step 3: Draw bends + summary**

In `_renderGeomDiff`, after drawing holes, draw bend lines from `compFlat.bends` (normalised to bbox origin) in muted grey; overdraw `d.bends.added` in green and `d.bends.removed` in red (dashed), using each bend's `a`/`b` endpoints shifted by the compare bbox origin. Add summary line:
```js
const bendLine = `Bends: ${d.bends.added.length} added · ${d.bends.removed.length} removed (base ${d.bends.baseN} → ${d.bends.compN})`;
```

- [ ] **Step 4: Live-verify + commit + board ping** — Geometry tab shows bend line + highlights; 0 errors. Commit `diff-tools.js test/geomdiff.test.js`; board: "G2 DONE Diff category (2) bends count/pos."

---

### Task 3: Surface cutouts/notches + outline-change flag

`_geomDiff.cutouts` (rect interior loops) + `_geomDiff.outline.changed` already computed. Add summary + box the differing cutouts.

**Files:**
- Modify: `diff-tools.js` (`_renderGeomDiff`)
- Modify: `test/geomdiff.test.js`

- [ ] **Step 1: Extend node test**

```js
const rc = geomDiff(
  flat(100,60,[],[[[10,10],[20,10],[20,20],[10,20]]]),
  flat(100,60,[],[])
);
assert.strictEqual(rc.cutouts.removed.length, 1, 'one cutout removed');
assert.strictEqual(rc.cutouts.added.length, 0, 'no cutout added');
console.log('geomdiff cutouts OK');
```

- [ ] **Step 2: Run test** — Expected: all OK lines including cutouts.

- [ ] **Step 3: Draw cutouts + summary**

In `_renderGeomDiff`, draw a bounding box around each `d.cutouts.added` (green) and `d.cutouts.removed` (red) at its centroid `cx,cy` (size from `pts` extent). Add summary line:
```js
const cutLine = `Cutouts: ${d.cutouts.added.length} added · ${d.cutouts.removed.length} removed${d.outline.changed ? ' · outline size changed' : ''}`;
```

- [ ] **Step 4: Live-verify + commit + board ping** — Commit; board: "G2 DONE Diff category (3) cutouts/notches + outline flag."

---

### Task 4: Surface thickness/material text note

`_geomDiff.material` already computed from BOM recs. Add a text line (no canvas marker — not a located feature). Requires `_renderGeomDiff` to look up each code's BOM record.

**Files:**
- Modify: `diff-tools.js` (`_renderGeomDiff`: pass BOM recs to `geomDiff`, add material line)
- Modify: `test/geomdiff.test.js`

- [ ] **Step 1: Extend node test**

```js
const rm = geomDiff(flat(100,60,[]), flat(100,60,[]), { thickness: 1.0 }, { thickness: 1.5 });
assert.strictEqual(rm.material.sameTh, false, 'thickness differs');
assert.strictEqual(rm.material.baseTh, 1.0);
assert.strictEqual(rm.material.compTh, 1.5);
console.log('geomdiff material OK');
```

- [ ] **Step 2: Run test** — Expected: all OK lines including material.

- [ ] **Step 3: Look up BOM recs + summary line**

In `_renderGeomDiff`, resolve each code's BOM record via the app's existing lookup (the same source the Library uses for `thickness_mm`; e.g. `partsByFamily()`/`manifest` record for the code — use whatever `app.js` exposes, confirmed at implementation time). Pass `baseRec`/`compRec` to `geomDiff`. Add summary line:
```js
const matLine = d.material.baseTh == null && d.material.compTh == null
  ? 'Thickness: unknown'
  : `Thickness: ${d.material.sameTh ? `same (${d.material.baseTh}mm)` : `${d.material.baseTh}mm → ${d.material.compTh}mm`}`;
```

- [ ] **Step 4: Live-verify + commit + board ping** — Commit; board: "G2 DONE Diff vs Library COMPLETE — all 6 categories (holes/dims/bends/cutouts/outline/thickness) live; aligned w/ G1 def."

---

## Self-Review

**Spec coverage:** Level B (Task B) · Level C resized (Task C) · (1) dims (Task 1) · (2) bends (Task 2) · (3) cutouts+outline (Task 3) · (4) thickness (Task 4) · shared G1 hole contract (diff-geom.js constants T/DIA_T) · pure node-testable engine (diff-geom.js + test) · GA adoption/credit (Task B) — all covered.

**Placeholder scan:** `_renderGeomDiff` BOM-record lookup in Task 4 Step 3 is the one "confirm at implementation time" — acceptable because the exact app.js accessor for a code's thickness must be read live (candidates: `manifest.auto_generated[code]`, a `partsByFamily()` entry); the diff LOGIC is fully specified and tested. All other steps have complete code.

**Type consistency:** `geomDiff(base, comp, baseRec, compRec)` signature, `KD_GEOMDIFF.geomDiff`, return keys `{dims,holes{added,removed,resized},bends{added,removed,baseN,compN},cutouts{added,removed},outline{changed},material{baseTh,compTh,sameTh}}` — used consistently across Tasks C–4 and the tests. `_renderGeomDiff(baseCode, compCode, containerEl)` consistent.
