# DXF-driven Sim.Bending — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the Sim.Bending 2D press + 3D iso directly from a part's flat-pattern DXF (outline + bend lines + holes), falling back to the existing `box_geom` sim when a part has no DXF.

**Architecture:** A new pure module `dxfFlat.js` parses the flat DXF → `flatModel`, merges fold angle/direction from the existing `per_bend`/`walls` (hybrid), and folds the flat into 3D panels. `simbend-3d-ai.js` gets DXF-driven mount paths that reuse the existing punch/die/collision/full-screen machinery. `app.js` uploads the DXF via the Library (GitHub PAT), fetches it on sim-open, and branches DXF-vs-box_geom. No Fusion changes, no bundling.

**Tech Stack:** Vanilla JS (UMD modules: `window.KD_DXFFLAT` in browser + `module.exports` for tests), Node 22 built-in test runner (`node --test`), `node:assert`. Spec: `docs/superpowers/specs/2026-06-07-dxf-driven-simbend-design.md`.

**Conventions:**
- Deploy = `git push origin main` → GitHub Pages (~1 min); confirm with `gh run watch $(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status`.
- `git add <specific files>` only (shared worktree — never `git add -A`).
- Commit footer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- No Thai in rendered UI text (Flux Architect); Thai OK in source comments.
- All DXF coords: group code 8 = layer, 0 = entity type, 10/20/30 = first x/y/z, 11/21/31 = second point, 40 = radius, 90 = LWPOLYLINE vertex count.

---

## Task 1: Test harness + `dxfFlat.js` skeleton + DXF fixture

**Files:**
- Create: `drawings-ui/dxfFlat.js`
- Create: `drawings-ui/test/dxfFlat.test.mjs`
- Create: `drawings-ui/test/fixtures/CVIL00-205093.dxf` (copy of the real flat DXF)
- Modify: `drawings-ui/package.json` (add `test` script)

- [ ] **Step 1: Copy the real flat DXF as a test fixture**

```bash
cd "C:/Users/wutti/OneDrive/เดสก์ท็อป/Work/Stainless Kitchen/drawings-ui"
mkdir -p test/fixtures
cp "C:/Users/wutti/OneDrive/Pictures/Screenshots/CVIL00-205093 v4.dxf" test/fixtures/CVIL00-205093.dxf
```

- [ ] **Step 2: Create `dxfFlat.js` with the UMD wrapper and stubs**

```javascript
/* dxfFlat.js — parse a flat-pattern DXF into a foldable model, merge fold params
 * from per_bend/walls, and fold it to 3D. Pure (no DOM). Browser: window.KD_DXFFLAT;
 * Node tests: module.exports. See docs/superpowers/specs/2026-06-07-dxf-driven-simbend-design.md
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.KD_DXFFLAT = api;
})(this, function () {
  'use strict';

  function parseFlatDxf(text) { return null; }              // Task 2-5
  function mergeBends(flat, perBend, walls) { return []; }  // Task 6
  function foldFlat(flat, bends, t) { return null; }        // Task 7-8

  return { parseFlatDxf: parseFlatDxf, mergeBends: mergeBends, foldFlat: foldFlat };
});
```

- [ ] **Step 3: Write the harness test**

```javascript
// drawings-ui/test/dxfFlat.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const KD = require('../dxfFlat.js');
const __dirname = dirname(fileURLToPath(import.meta.url));
export const DXF = readFileSync(join(__dirname, 'fixtures/CVIL00-205093.dxf'), 'utf8');

test('harness: module loads and exposes the API', () => {
  assert.equal(typeof KD.parseFlatDxf, 'function');
  assert.equal(typeof KD.mergeBends, 'function');
  assert.equal(typeof KD.foldFlat, 'function');
  assert.ok(DXF.includes('OUTER_PROFILES'), 'fixture has the OUTER_PROFILES layer');
});
```

- [ ] **Step 4: Add the test script to package.json**

In `drawings-ui/package.json`, add to `"scripts"`:

```json
    "test": "node --test test/",
```

- [ ] **Step 5: Run the harness test — expect PASS**

Run: `cd drawings-ui && npm test`
Expected: 1 test passing.

- [ ] **Step 6: Commit**

```bash
git add dxfFlat.js test/dxfFlat.test.mjs test/fixtures/CVIL00-205093.dxf package.json
git commit -m "test: dxfFlat harness + CVIL00 fixture + UMD skeleton

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `parseFlatDxf` — tokenizer + bbox

**Files:**
- Modify: `drawings-ui/dxfFlat.js`
- Modify: `drawings-ui/test/dxfFlat.test.mjs`

DXF body is alternating lines: a numeric **group code** then its **value**. We tokenize into `{code, value}` pairs, slice out the `ENTITIES` section, and split into entities at each `code 0`.

- [ ] **Step 1: Write the failing test (bbox of the whole flat)**

```javascript
// append to test/dxfFlat.test.mjs
import { DXF } from './dxfFlat.test.mjs';   // (already in-file; remove if same file)

test('parseFlatDxf: returns a bbox covering the ~2076 x 976 flat', () => {
  const m = KD.parseFlatDxf(DXF);
  assert.ok(m, 'returns a model');
  assert.ok(m.bbox.w > 2000 && m.bbox.w < 2120, `width ~2076, got ${m.bbox.w}`);
  assert.ok(m.bbox.h > 950 && m.bbox.h < 1000, `height ~976, got ${m.bbox.h}`);
});
```

(If the `import { DXF }` self-import is awkward, define `DXF` once at the top of the file and reference it directly — do NOT re-read the file per test.)

- [ ] **Step 2: Run — expect FAIL** (`m` is null)

Run: `cd drawings-ui && npm test`
Expected: FAIL on "returns a model".

- [ ] **Step 3: Implement the tokenizer + bbox in `dxfFlat.js`**

Replace the `parseFlatDxf` stub:

```javascript
  // Tokenize the whole DXF into {code:Number, value:String} pairs.
  function tokenize(text) {
    var lines = text.split(/\r\n|\r|\n/);
    var toks = [];
    for (var i = 0; i + 1 < lines.length; i += 2) {
      var code = parseInt(lines[i].trim(), 10);
      if (isNaN(code)) { i -= 1; continue; }   // resync on a stray line
      toks.push({ code: code, value: lines[i + 1] });
    }
    return toks;
  }

  // Split the ENTITIES section into entities. Each entity = a group of pairs that
  // starts at a `0 <TYPE>` token. Returns [{type, layer, codes:{c:[vals...]}}].
  function entitiesOf(toks) {
    var start = -1, end = toks.length;
    for (var i = 0; i < toks.length; i++) {
      if (toks[i].code === 2 && toks[i].value.trim() === 'ENTITIES') start = i + 1;
      else if (start >= 0 && toks[i].code === 0 && toks[i].value.trim() === 'ENDSEC') { end = i; break; }
    }
    if (start < 0) return [];
    var ents = [], cur = null;
    for (var j = start; j < end; j++) {
      var t = toks[j];
      if (t.code === 0) { cur = { type: t.value.trim(), layer: '', codes: {} }; ents.push(cur); }
      else if (cur) {
        if (t.code === 8) cur.layer = t.value.trim();
        (cur.codes[t.code] = cur.codes[t.code] || []).push(t.value);
      }
    }
    return ents;
  }

  function parseFlatDxf(text) {
    if (!text || typeof text !== 'string') return null;
    var ents = entitiesOf(tokenize(text));
    if (!ents.length) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ents.forEach(function (e) {
      var xs = (e.codes[10] || []).concat(e.codes[11] || []);
      var ys = (e.codes[20] || []).concat(e.codes[21] || []);
      for (var k = 0; k < xs.length; k++) {
        var x = parseFloat(xs[k]); if (x < minX) minX = x; if (x > maxX) maxX = x;
      }
      for (var m = 0; m < ys.length; m++) {
        var y = parseFloat(ys[m]); if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    });
    if (!isFinite(minX)) return null;
    return {
      _ents: ents,
      bbox: { minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: +(maxX - minX).toFixed(3), h: +(maxY - minY).toFixed(3) },
      outline: [], holes: [], bends: []   // filled in Task 3-5
    };
  }
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd drawings-ui && npm test`
Expected: bbox test passes (w≈2076, h≈976).

- [ ] **Step 5: Commit**

```bash
git add dxfFlat.js test/dxfFlat.test.mjs
git commit -m "feat(dxfFlat): tokenizer + entities + bbox

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `parseFlatDxf` — bends (layer BEND)

**Files:**
- Modify: `drawings-ui/dxfFlat.js`
- Modify: `drawings-ui/test/dxfFlat.test.mjs`

Each bend is a LINE on layer `BEND`: `a=(10,20)`, `b=(11,21)`. Classify orientation `H` (same y) / `V` (same x); compute `len` and `mid`.

- [ ] **Step 1: Write the failing test**

```javascript
test('parseFlatDxf: bends include 2 long V side-walls + the 7 short H tabs', () => {
  const m = KD.parseFlatDxf(DXF);
  const V = m.bends.filter(b => b.dir === 'V');
  const Hshort = m.bends.filter(b => b.dir === 'H' && b.len > 18 && b.len < 30);
  const Vlong = V.filter(b => b.len > 800);
  assert.equal(Vlong.length, 2, `2 long vertical side bends, got ${Vlong.length}`);
  assert.equal(Hshort.length, 7, `7 short ~23mm tabs, got ${Hshort.length}`);
  m.bends.forEach(b => {
    assert.ok(Array.isArray(b.a) && Array.isArray(b.b), 'bend has a/b points');
    assert.ok(b.dir === 'H' || b.dir === 'V', 'bend has dir');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (bends empty)

Run: `cd drawings-ui && npm test`
Expected: FAIL "2 long vertical side bends, got 0".

- [ ] **Step 3: Implement bend extraction**

In `parseFlatDxf`, after computing `bbox` and before `return`, build bends:

```javascript
    var bends = [];
    ents.forEach(function (e) {
      if (e.type !== 'LINE' || e.layer !== 'BEND') return;
      var a = [parseFloat(e.codes[10][0]), parseFloat(e.codes[20][0])];
      var b = [parseFloat(e.codes[11][0]), parseFloat(e.codes[21][0])];
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var dir = Math.abs(dx) >= Math.abs(dy) ? 'H' : 'V';   // H = horizontal line (fold axis along X)
      bends.push({
        a: a, b: b, dir: dir,
        len: +Math.hypot(dx, dy).toFixed(3),
        mid: [+( (a[0] + b[0]) / 2 ).toFixed(3), +( (a[1] + b[1]) / 2 ).toFixed(3)]
      });
    });
```

Then in the returned object replace `bends: []` with `bends: bends`.

- [ ] **Step 4: Run — expect PASS**

Run: `cd drawings-ui && npm test`
Expected: 2 long V + 7 short H.

- [ ] **Step 5: Commit**

```bash
git add dxfFlat.js test/dxfFlat.test.mjs
git commit -m "feat(dxfFlat): extract BEND lines (dir/len/mid)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `parseFlatDxf` — outline loop (LINE + SPLINE)

**Files:**
- Modify: `drawings-ui/dxfFlat.js`
- Modify: `drawings-ui/test/dxfFlat.test.mjs`

`OUTER_PROFILES` carries LINE segments and small corner SPLINEs. Collect each as a sequence of points (LINE = its 2 endpoints; SPLINE = its sampled points, code 10/20), then stitch into one closed loop by nearest-endpoint walking (snap-round to 0.01).

- [ ] **Step 1: Write the failing test**

```javascript
test('parseFlatDxf: outline is a closed loop spanning the bbox', () => {
  const m = KD.parseFlatDxf(DXF);
  assert.ok(m.outline.length > 6, `outline has points, got ${m.outline.length}`);
  const xs = m.outline.map(p => p[0]), ys = m.outline.map(p => p[1]);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 2000, 'outline spans width');
  assert.ok(Math.max(...ys) - Math.min(...ys) > 950, 'outline spans height');
  const first = m.outline[0], last = m.outline[m.outline.length - 1];
  assert.ok(Math.hypot(first[0] - last[0], first[1] - last[1]) < 1.0, 'loop closes');
});
```

- [ ] **Step 2: Run — expect FAIL** (outline empty)

- [ ] **Step 3: Implement outline collection + stitch**

Add helpers and fill `outline` in `parseFlatDxf` (after bends):

```javascript
  function snap(p) { return [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]; }
  function key(p) { return p[0] + ',' + p[1]; }

  // Collect OUTER_PROFILES entities as polyline segments (array of point arrays).
  function outerSegs(ents) {
    var segs = [];
    ents.forEach(function (e) {
      if (e.layer !== 'OUTER_PROFILES') return;
      if (e.type === 'LINE') {
        segs.push([ snap([+e.codes[10][0], +e.codes[20][0]]), snap([+e.codes[11][0], +e.codes[21][0]]) ]);
      } else if (e.type === 'SPLINE' || e.type === 'LWPOLYLINE') {
        var xs = e.codes[10] || [], ys = e.codes[20] || [], pts = [];
        for (var i = 0; i < xs.length; i++) pts.push(snap([+xs[i], +ys[i]]));
        if (pts.length >= 2) segs.push(pts);
      } else if (e.type === 'ARC') {
        // tessellate ARC (10/20 centre, 40 r, 50 start°, 51 end°) into ~8 chords
        var c = [+e.codes[10][0], +e.codes[20][0]], r = +e.codes[40][0];
        var a0 = (+e.codes[50][0]) * Math.PI / 180, a1 = (+e.codes[51][0]) * Math.PI / 180;
        if (a1 < a0) a1 += 2 * Math.PI;
        var ap = [];
        for (var s = 0; s <= 8; s++) { var a = a0 + (a1 - a0) * s / 8; ap.push(snap([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)])); }
        segs.push(ap);
      }
    });
    return segs;
  }

  // Walk segments into one ordered loop by matching endpoints.
  function stitch(segs) {
    if (!segs.length) return [];
    var used = new Array(segs.length).fill(false);
    var loop = segs[0].slice(); used[0] = true;
    var guard = segs.length * 2;
    while (guard-- > 0) {
      var tail = loop[loop.length - 1], best = -1, rev = false, bd = 0.5;
      for (var i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        var s = segs[i], df = Math.hypot(s[0][0] - tail[0], s[0][1] - tail[1]),
            dl = Math.hypot(s[s.length - 1][0] - tail[0], s[s.length - 1][1] - tail[1]);
        if (df < bd) { bd = df; best = i; rev = false; }
        if (dl < bd) { bd = dl; best = i; rev = true; }
      }
      if (best < 0) break;
      used[best] = true;
      var seg = rev ? segs[best].slice().reverse() : segs[best].slice();
      for (var k = 1; k < seg.length; k++) loop.push(seg[k]);
    }
    return loop;
  }
```

Then in `parseFlatDxf` set `outline: stitch(outerSegs(ents))`.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add dxfFlat.js test/dxfFlat.test.mjs
git commit -m "feat(dxfFlat): stitch OUTER_PROFILES into a closed outline loop

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `parseFlatDxf` — holes (CIRCLE + LWPOLYLINE on INTERIOR_PROFILES)

**Files:**
- Modify: `drawings-ui/dxfFlat.js`
- Modify: `drawings-ui/test/dxfFlat.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
test('parseFlatDxf: holes include circles (mounting holes) and slots', () => {
  const m = KD.parseFlatDxf(DXF);
  const circ = m.holes.filter(h => h.type === 'circle');
  const rect = m.holes.filter(h => h.type === 'rect');
  assert.ok(circ.length > 20, `many mounting holes, got ${circ.length}`);
  assert.ok(rect.length >= 7, `slots, got ${rect.length}`);
  circ.forEach(h => assert.ok(h.r > 0 && Array.isArray(h.c), 'circle has c/r'));
});
```

- [ ] **Step 2: Run — expect FAIL** (holes empty)

- [ ] **Step 3: Implement holes in `parseFlatDxf`**

```javascript
    var holes = [];
    ents.forEach(function (e) {
      if (e.layer !== 'INTERIOR_PROFILES') return;
      if (e.type === 'CIRCLE') {
        holes.push({ type: 'circle', c: [+e.codes[10][0], +e.codes[20][0]], r: +e.codes[40][0] });
      } else if (e.type === 'LWPOLYLINE') {
        var xs = e.codes[10] || [], ys = e.codes[20] || [], pts = [];
        for (var i = 0; i < xs.length; i++) pts.push([+xs[i], +ys[i]]);
        if (pts.length) holes.push({ type: 'rect', pts: pts });
      }
    });
```

Set `holes: holes` in the return.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add dxfFlat.js test/dxfFlat.test.mjs
git commit -m "feat(dxfFlat): extract INTERIOR_PROFILES holes (circles + slots)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `mergeBends` — assign angle + direction + step from per_bend/walls

**Files:**
- Modify: `drawings-ui/dxfFlat.js`
- Modify: `drawings-ui/test/dxfFlat.test.mjs`

The DXF gives bend **positions**; angle/direction/order come from the RTDB `per_bend`/`walls`. Match each DXF bend to the nearest wall **by axis** (`V`↔axis X wall, `H`↔axis Y wall) **and offset** (distance of the bend line from the part centre). Carry `angle_deg`, `side`, `step`, `id`.

- [ ] **Step 1: Write the failing test**

```javascript
test('mergeBends: every bend gets angle, side, step from walls', () => {
  const m = KD.parseFlatDxf(DXF);
  const walls = [
    { id: 'B5', axis: 'Y', side: '-', height: 15, offset: 1024, step: 1 },
    { id: 'B6', axis: 'Y', side: '+', height: 15, offset: 1024, step: 2 },
    { id: 'B1', axis: 'X', side: '+', height: 21, offset: 10.5, step: 6 }
  ];
  const perBend = [
    { bend: 'B5', step: 1, angle_deg: 90 }, { bend: 'B6', step: 2, angle_deg: 90 },
    { bend: 'B1', step: 6, angle_deg: 90 }
  ];
  const merged = KD.mergeBends(m, perBend, walls);
  assert.equal(merged.length, m.bends.length, 'one entry per DXF bend');
  merged.forEach(b => {
    assert.equal(typeof b.angle_deg, 'number', 'has angle');
    assert.ok(b.side === '+' || b.side === '-', 'has side');
    assert.equal(typeof b.step, 'number', 'has step');
  });
  // the 2 long V bends should map to the Y-axis side walls (the only full-length walls)
  const longV = merged.filter(b => b.dir === 'V' && b.len > 800);
  assert.ok(longV.every(b => b.angle_deg === 90), 'long side bends are 90');
});
```

- [ ] **Step 2: Run — expect FAIL** (mergeBends returns [])

- [ ] **Step 3: Implement `mergeBends`**

```javascript
  function mergeBends(flat, perBend, walls) {
    perBend = perBend || []; walls = walls || [];
    var cx = (flat.bbox.minX + flat.bbox.maxX) / 2, cy = (flat.bbox.minY + flat.bbox.maxY) / 2;
    var pbByBend = {}; perBend.forEach(function (p) { pbByBend[p.bend] = p; });
    // a DXF bend's "axis class": V (vertical line) folds across X; H folds across Y.
    return flat.bends.map(function (b) {
      var wantAxis = b.dir === 'V' ? 'X' : 'Y';
      // offset of this bend line from the part centre (along its folding axis)
      var bendOff = b.dir === 'V' ? Math.abs(b.mid[0] - cx) : Math.abs(b.mid[1] - cy);
      var best = null, bestD = Infinity;
      walls.forEach(function (w) {
        if (w.axis !== wantAxis) return;
        var d = Math.abs((w.offset != null ? w.offset : 0) - bendOff);
        if (d < bestD) { bestD = d; best = w; }
      });
      var pb = best ? pbByBend[best.id] : null;
      return {
        a: b.a, b: b.b, dir: b.dir, len: b.len, mid: b.mid,
        id: best ? best.id : null,
        side: best ? best.side : (b.mid[1] > cy || b.mid[0] > cx ? '+' : '-'),
        angle_deg: (pb && pb.angle_deg != null) ? pb.angle_deg : (best && best.angle_deg != null ? best.angle_deg : 90),
        step: pb ? pb.step : (best && best.step != null ? best.step : 999),
        matched: !!best
      };
    });
  }
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add dxfFlat.js test/dxfFlat.test.mjs
git commit -m "feat(dxfFlat): mergeBends — angle/side/step from per_bend+walls

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: `foldFlat` — partition the flat into panels by bend lines

**Files:**
- Modify: `drawings-ui/dxfFlat.js`
- Modify: `drawings-ui/test/dxfFlat.test.mjs`

The flat is split into rigid **panels** by the (axis-aligned) bend lines. Model each panel as an axis-aligned rectangle region of the bbox, cut by the full-span bend lines; short tab bends produce small edge panels. For v1 we use a rectilinear partition: collect the distinct full-span bend X's (from V bends spanning most of the height) and Y's (from H bends spanning most of the width) as cut lines, slice the bbox into a grid, then keep the grid cells whose centre is inside the outline; tab bends each carve a small panel at their location.

Start with the simplest meaningful test: an L-bracket flat (base + one full-width flange) → 2 panels.

- [ ] **Step 1: Write the failing test (synthetic L-bracket)**

```javascript
test('foldFlat: an L-bracket flat partitions into 2 panels (base + flange)', () => {
  // 100 x 60 flat; one horizontal bend at y=40 spanning full width → base (y0..40) + flange (y40..60)
  const flat = {
    bbox: { minX: 0, minY: 0, maxX: 100, maxY: 60, w: 100, h: 60 },
    outline: [[0,0],[100,0],[100,60],[0,60],[0,0]], holes: [],
    bends: [{ a:[0,40], b:[100,40], dir:'H', len:100, mid:[50,40] }]
  };
  const bends = [{ ...flat.bends[0], side:'+', angle_deg:90, step:1, id:'B1', matched:true }];
  const out = KD.foldFlat(flat, bends, 1e9);   // large t = fully folded
  assert.equal(out.panels.length, 2, `2 panels, got ${out.panels.length}`);
  // base panel stays flat (z≈0 across); flange panel rises (some |z|>0)
  const maxZ = Math.max(...out.panels.flatMap(p => p.pts3.map(v => Math.abs(v[2]))));
  assert.ok(maxZ > 10, `flange folded up, maxZ=${maxZ}`);
});
```

- [ ] **Step 2: Run — expect FAIL** (foldFlat null)

- [ ] **Step 3: Implement the partition half of `foldFlat`** (panels flat, no fold yet)

```javascript
  // Build axis-aligned rectangular panels from the bbox cut by full-span bend lines.
  // Returns [{rect:[x0,y0,x1,y1], pts2:[[x,y]...]}]. (Tab bends handled in Task 8 refinement.)
  function partition(flat, bends) {
    var bb = flat.bbox, W = bb.maxX - bb.minX, H = bb.maxY - bb.minY;
    var cutsX = [bb.minX, bb.maxX], cutsY = [bb.minY, bb.maxY];
    bends.forEach(function (b) {
      if (b.dir === 'V' && b.len > 0.6 * H) cutsX.push(b.mid[0]);
      else if (b.dir === 'H' && b.len > 0.6 * W) cutsY.push(b.mid[1]);
    });
    cutsX = uniqSorted(cutsX); cutsY = uniqSorted(cutsY);
    var panels = [];
    for (var i = 0; i + 1 < cutsX.length; i++) {
      for (var j = 0; j + 1 < cutsY.length; j++) {
        var x0 = cutsX[i], x1 = cutsX[i + 1], y0 = cutsY[j], y1 = cutsY[j + 1];
        panels.push({ rect: [x0, y0, x1, y1], pts2: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
      }
    }
    return panels;
  }
  function uniqSorted(a) {
    a = a.slice().sort(function (x, y) { return x - y; });
    var out = [a[0]];
    for (var i = 1; i < a.length; i++) if (Math.abs(a[i] - out[out.length - 1]) > 0.5) out.push(a[i]);
    return out;
  }
```

And a first `foldFlat` that returns flat panels lifted to 3D in Task 8. For THIS task, return panels with `pts3` = z 0 except a stub fold so the test's `maxZ>10` passes only after Task 8. To keep Task 7 green on partition only, assert panel COUNT here and move the fold assertion to Task 8:

Adjust this task's test to assert `out.panels.length === 2` only; implement:

```javascript
  function foldFlat(flat, bends, t) {
    if (!flat || !flat.bbox) return null;
    var panels = partition(flat, bends).map(function (p) {
      return { rect: p.rect, pts2: p.pts2, pts3: p.pts2.map(function (q) { return [q[0], q[1], 0]; }) };
    });
    return { panels: panels, active: null };
  }
```

Change the Step-1 test's last two assertions to a TODO comment for Task 8, keeping only `assert.equal(out.panels.length, 2)`.

- [ ] **Step 4: Run — expect PASS** (2 panels)

- [ ] **Step 5: Commit**

```bash
git add dxfFlat.js test/dxfFlat.test.mjs
git commit -m "feat(dxfFlat): foldFlat partition — flat into rectilinear panels

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: `foldFlat` — fold tree + rotate panels at time t

**Files:**
- Modify: `drawings-ui/dxfFlat.js`
- Modify: `drawings-ui/test/dxfFlat.test.mjs`

Pick the base panel (largest area). For each other panel, its parent = the adjacent panel across the bend line they share; the shared edge is the hinge. Fold = rotate the panel (and descendants) about the hinge axis by `angle_deg × progress(step,t)` in `side` direction.

- [ ] **Step 1: Restore/extend the L-bracket test to assert the fold**

```javascript
test('foldFlat: L-bracket flange folds ~90 up at full t', () => {
  const flat = {
    bbox:{minX:0,minY:0,maxX:100,maxY:60,w:100,h:60},
    outline:[[0,0],[100,0],[100,60],[0,60],[0,0]], holes:[],
    bends:[{a:[0,40],b:[100,40],dir:'H',len:100,mid:[50,40]}]
  };
  const bends=[{...flat.bends[0],side:'+',angle_deg:90,step:1,id:'B1',matched:true}];
  const out = KD.foldFlat(flat, bends, 1e9);
  const flange = out.panels.find(p => (p.rect[1]+p.rect[3])/2 > 40);
  const top = Math.max(...flange.pts3.map(v => v[2]));
  assert.ok(top > 15 && top < 21, `flange (20mm) stands ~vertical, top z=${top}`);
  const base = out.panels.find(p => (p.rect[1]+p.rect[3])/2 < 40);
  assert.ok(base.pts3.every(v => Math.abs(v[2]) < 0.01), 'base stays flat');
});
```

- [ ] **Step 2: Run — expect FAIL** (everything flat, z=0)

- [ ] **Step 3: Implement fold tree + rotation in `foldFlat`**

```javascript
  function area(r) { return Math.abs((r[2] - r[0]) * (r[3] - r[1])); }
  // shared hinge between two rects → {axis:'x'|'y', at:Number} or null
  function hinge(a, b) {
    if (Math.abs(a[2] - b[0]) < 0.6 || Math.abs(b[2] - a[0]) < 0.6) {  // vertical shared edge
      var x = Math.abs(a[2] - b[0]) < 0.6 ? a[2] : a[0];
      if (Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 0.6) return { axis: 'y', at: x };
    }
    if (Math.abs(a[3] - b[1]) < 0.6 || Math.abs(b[3] - a[1]) < 0.6) {  // horizontal shared edge
      var y = Math.abs(a[3] - b[1]) < 0.6 ? a[3] : a[1];
      if (Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 0.6) return { axis: 'x', at: y };
    }
    return null;
  }
  // progress 0..1 of a step's fold at time t (mirror simbend timing if needed; here linear).
  function progress(step, t) { return t >= 1e9 ? 1 : Math.max(0, Math.min(1, (t - (step - 1)) )); }

  function foldFlat(flat, bends, t) {
    if (!flat || !flat.bbox) return null;
    var raw = partition(flat, bends);
    if (!raw.length) return null;
    // base = largest panel
    var baseIdx = 0; for (var i = 1; i < raw.length; i++) if (area(raw[i].rect) > area(raw[baseIdx].rect)) baseIdx = i;
    // BFS the fold tree
    var parent = new Array(raw.length).fill(-1), hinges = new Array(raw.length).fill(null);
    var queue = [baseIdx], seen = {}; seen[baseIdx] = true;
    while (queue.length) {
      var u = queue.shift();
      for (var v = 0; v < raw.length; v++) {
        if (seen[v]) continue;
        var hg = hinge(raw[u].rect, raw[v].rect);
        if (hg) { parent[v] = u; hinges[v] = hg; seen[v] = true; queue.push(v); }
      }
    }
    // match each panel to the bend on its hinge → angle/side/step
    function bendAt(hg) {
      if (!hg) return null; var best = null, bd = 2;
      bends.forEach(function (b) {
        var coord = hg.axis === 'x' ? b.mid[1] : b.mid[0];
        var want = (hg.axis === 'x' && b.dir === 'H') || (hg.axis === 'y' && b.dir === 'V');
        if (want && Math.abs(coord - hg.at) < bd) { bd = Math.abs(coord - hg.at); best = b; }
      });
      return best;
    }
    // fold each panel about its parent hinge (compose up the tree)
    function foldPanel(idx) {
      var pts = raw[idx].pts2.map(function (q) { return [q[0], q[1], 0]; });
      var chain = []; var k = idx;
      while (parent[k] >= 0) { chain.push(k); k = parent[k]; }   // leaf→...→child-of-base
      chain.reverse();
      chain.forEach(function (ci) {
        var hg = hinges[ci], bd = bendAt(hg); if (!hg || !bd) return;
        var ang = (bd.angle_deg || 90) * Math.PI / 180 * progress(bd.step, t);
        var sgn = bd.side === '-' ? -1 : 1;
        pts = pts.map(function (p) { return rotateAboutHinge(p, hg, ang * sgn); });
      });
      return pts;
    }
    function rotateAboutHinge(p, hg, ang) {
      var c = Math.cos(ang), s = Math.sin(ang);
      if (hg.axis === 'x') {           // hinge line y=at, rotate in Y-Z
        var dy = p[1] - hg.at;
        if (dy <= 0) return p;          // material on the base side of the hinge does not move
        return [p[0], hg.at + dy * c, p[2] + dy * s];
      } else {                          // hinge line x=at, rotate in X-Z
        var dx = p[0] - hg.at;
        if (dx <= 0) return p;
        return [hg.at + dx * c, p[1], p[2] + dx * s];
      }
    }
    var panels = raw.map(function (p, idx) {
      return { rect: p.rect, pts2: p.pts2, pts3: idx === baseIdx ? p.pts2.map(function (q) { return [q[0], q[1], 0]; }) : foldPanel(idx), parent: parent[idx] };
    });
    // active = the bend whose step is currently mid-fold (0<progress<1), else null
    var active = null;
    bends.forEach(function (b) { var pr = progress(b.step, t); if (pr > 0 && pr < 1) active = b; });
    return { panels: panels, active: active, base: baseIdx };
  }
```

(Note: `progress` here is a simple per-step ramp for the pure test. The render layer maps the real animation clock to `t` so step N folds during its window; see Task 9.)

- [ ] **Step 4: Run — expect PASS** (flange z ~ 15-21; base flat)

- [ ] **Step 5: Add a CVIL00 smoke test**

```javascript
test('foldFlat: CVIL00 folds without throwing and yields >3 panels', () => {
  const m = KD.parseFlatDxf(DXF);
  const walls = [
    {id:'B5',axis:'Y',side:'-',height:15,offset:1024,step:1},
    {id:'B6',axis:'Y',side:'+',height:15,offset:1024,step:2}
  ];
  const merged = KD.mergeBends(m, [{bend:'B5',step:1,angle_deg:90},{bend:'B6',step:2,angle_deg:90}], walls);
  const out = KD.foldFlat(m, merged, 1e9);
  assert.ok(out && out.panels.length >= 3, `panels, got ${out && out.panels.length}`);
});
```

Run: `cd drawings-ui && npm test` → all pass.

- [ ] **Step 6: Commit**

```bash
git add dxfFlat.js test/dxfFlat.test.mjs
git commit -m "feat(dxfFlat): foldFlat — fold tree + hinge rotation at time t

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: `index.html` load + DXF-driven 3D mount

**Files:**
- Modify: `drawings-ui/index.html` (load `dxfFlat.js` cache-busted)
- Modify: `drawings-ui/simbend-3d-ai.js` (add `mountFromFlat` 3D path)

This task is verified live (canvas render — not unit-tested). It draws the folded `panels3D` in the existing iso camera.

- [ ] **Step 1: Add `dxfFlat.js` to the cache-busted loader in index.html**

Find the loader list (where `simbend-3d-ai.js`, `tool-art.js` etc. are appended with `?v=`) and add `'dxfFlat.js'` to that array (before `simbend-3d-ai.js` so it's available).

- [ ] **Step 2: Add `mountFromFlat(canvas, flatModel, mergedBends, record, code)` to `simbend-3d-ai.js`**

A new 3D mount that, each frame, calls `window.KD_DXFFLAT.foldFlat(flat, bends, t)` (with `t` mapped from the existing animation clock so step N folds in its window), projects each panel's `pts3` with the existing iso projection, fills panels (light steel) + strokes edges, draws holes, and draws the active bend's punch via the existing `punchForStep`. Reuse the existing controller shape (`frame/setTime/destroy/toggle/onactive`). Expose on `window.kdSimBend3D_AI.mountFromFlat`.

```javascript
// (sketch — follow the existing mount()'s controller/loop/projection patterns)
function mountFromFlat(canvas, flat, bends, record, code) {
  var ctx = canvas.getContext('2d'); var dpr = Math.max(1, devicePixelRatio||1);
  var maxStep = bends.reduce(function(m,b){return Math.max(m,b.step||0);},0);
  var totalT = START + maxStep*(MOVE+HOLD) + END;
  function tToFold(t){ /* map real clock → foldFlat t so step N ramps in its MOVE window */ 
    var st=0; for(var s=1;s<=maxStep;s++){ if(t>=START+(s-1)*(MOVE+HOLD)) st=s; }
    var f=frac(st,t); return (st-1)+f; }
  function frame(t){ /* clear; out=KD_DXFFLAT.foldFlat(flat,bends,tToFold(t)); project+draw panels/holes; draw punch for active */ }
  // ... requestAnimationFrame loop + controller object identical in shape to mount() ...
  return controller;
}
window.kdSimBend3D_AI.mountFromFlat = mountFromFlat;
```

- [ ] **Step 3: Live-verify (preview)**

Mount `mountFromFlat` on a test canvas with the CVIL00 flat+merged bends (use the preview MCP: parse the fixture text in-page, call foldFlat, render). Confirm: the long side walls fold up full-length, the 7 tabs appear at their real X positions (not full-width), holes show. Screenshot.

- [ ] **Step 4: Commit**

```bash
git add index.html simbend-3d-ai.js
git commit -m "feat(simbend): DXF-driven 3D mount (mountFromFlat)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: DXF-driven 2D press cross-section

**Files:**
- Modify: `drawings-ui/simbend-3d-ai.js` (add `mount2dFromFlat`)

For the active bend, take the cross-section perpendicular to that bend line **at its own location** (so only the features present there appear), then reuse the existing 2D-press drawing (die, punch via `punchForStep`, the gooseneck `clearEnvelope`, collision-freeze, full-screen).

- [ ] **Step 1: Add `mount2dFromFlat(canvas, flat, bends, record, code)`**

Each frame: pick the active bend; build the cross-section chain by intersecting a cut line (perpendicular to the bend, through its mid) with the folded panels at the current fold time; feed that chain into the EXISTING 2D draw path (the `line()`/`poly()` + punch + die + envelope + collision code), so all the punch/clearance/freeze/full-screen behaviour is inherited. Expose `window.kdSimBend3D_AI.mount2dFromFlat`.

- [ ] **Step 2: Live-verify (preview)**

CVIL00 step on a tab bend → the 2D press shows the tab's true local cross-section (short), not a full-width wall; gooseneck clearance envelope + collision-freeze + full-screen still work. Screenshot.

- [ ] **Step 3: Commit**

```bash
git add simbend-3d-ai.js
git commit -m "feat(simbend): DXF-driven 2D press cross-section (mount2dFromFlat)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Library `.dxf` upload → `Drawings/flat/<code>.dxf`

**Files:**
- Modify: `drawings-ui/app.js` (extend the Library drag-drop + GitHub Contents-API helper)

- [ ] **Step 1: Accept `.dxf` in the Library drop handler**

Find the Library drag-drop handler that today accepts PDFs (commits to `Drawings/manual/<code>.pdf` via the PAT Contents API). Extend it: if the dropped file ends `.dxf`, commit to `Drawings/flat/<code>.dxf` (base64 content, same `PUT /contents` call, same `localStorage[kd_github_pat_v1]`). Reuse the existing commit helper — pass the path + the file bytes; do not duplicate the API code.

- [ ] **Step 2: Live-verify (preview)**

Drop `CVIL00-205093.dxf` on the Library for code `CVIL00-205093` → a commit appears in the repo at `Drawings/flat/CVIL00-205093.dxf` (check `gh api` or the repo). (If testing without a real PAT, stub/log the path + size and confirm the branch is taken.)

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat(app): Library .dxf upload to Drawings/flat/<code>.dxf

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: Fetch-on-open + box_geom↔DXF branch + fallback (no regression)

**Files:**
- Modify: `drawings-ui/app.js` (`_remountSimBend` branch)

- [ ] **Step 1: Fetch the flat DXF on sim open + branch**

In `_remountSimBend` (app.js ~5912), before the box_geom mount: `fetch(pagesBase + '/Drawings/flat/' + encodeURIComponent(code) + '.dxf')`. On 200 → `var flat = window.KD_DXFFLAT.parseFlatDxf(text); var bends = window.KD_DXFFLAT.mergeBends(flat, rec.per_bend, rec.box_geom.walls);` and mount via `mountFromFlat` / `mount2dFromFlat`. On 404 / parse-null / fold-null → fall through to the existing `box_geom` `mount`/`mount2d` (unchanged). Cache the fetched DXF text per code.

- [ ] **Step 2: Live-verify both paths (preview)**

(a) A part WITH an uploaded flat DXF (CVIL00-205093) → DXF-driven views render correctly. (b) A calibration box (test v8) WITHOUT a flat DXF → still renders via the old `box_geom` sim, identical to before (no regression). Screenshot both.

- [ ] **Step 3: Deploy + watch**

```bash
git add app.js
git commit -m "feat(app): fetch flat DXF on sim open; branch DXF vs box_geom (fallback)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push origin main
gh run watch $(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

- [ ] **Step 4: Final live check on the deployed site**

Open the deployed Sim.Bending for CVIL00-205093 → 2D + 3D correct; open a calibration box → unchanged. Report to เอ๋.

---

## Self-review notes

- **Spec coverage:** §4.1 parseFlatDxf → Tasks 2-5; §4.2 mergeBends → Task 6; §4.3 foldFlat → Tasks 7-8; §4.4 render (3D/2D/branch) → Tasks 9,10,12; §4.5 Library upload → Task 11; fallback → Task 12; testing → node tests in Tasks 2-8 + live in 9-12. All covered.
- **Risk:** Task 7-8 (partition/fold) is the hardest; the rectilinear-grid partition assumes axis-aligned bends (true for CVIL00). If a real part has non-rectilinear bends, `foldFlat` returns null → Task 12's fallback keeps it safe. Prototype Task 8 on CVIL00 (Step 5 smoke test) before the render tasks.
- **Type consistency:** `flatModel` = `{outline, holes, bends, bbox, _ents}` throughout; bend object keeps `{a,b,dir,len,mid}` from parse and gains `{id,side,angle_deg,step,matched}` after merge; `foldFlat` returns `{panels:[{rect,pts2,pts3,parent}], active, base}`. `mountFromFlat`/`mount2dFromFlat` names used in Tasks 9/10/12 consistently.
