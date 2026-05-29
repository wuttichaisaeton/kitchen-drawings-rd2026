# Nesting "Max Remnant" Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a nesting mode "Max Remnant" that arranges parts to leave the largest possible single reusable rectangular offcut, using corner packing + gap-fill + a largest-empty-rectangle scorer.

**Architecture:** New `_nestMultiSheetMaxRemnant(pieces, stock, gap)` in `nest.js`, dispatched from `_nestMultiSheet`. It generates candidate layouts (the 4 rectangle packers + a gap-filled variant), scores each by its largest empty rectangle (new pure helper `_largestEmptyRect`, measured on a true-shape occupancy grid built with the existing `_rasterMask`/`_stamp`), and returns the best by (fewest unplaced, fewest sheets, largest remnant). Additive — no existing packer changes.

**Tech Stack:** Vanilla JS (`nest.js`), loads directly — NO build. No JS unit runner; module fns are reachable via `window.kdNest` only if exported, so the new pure helper is unit-tested by temporarily exposing it OR via an inline IIFE in `preview_eval`. Integration verified via `preview_eval` against `S.flatSheets`.

**Spec:** `docs/superpowers/specs/2026-05-30-nest-max-remnant-design.md`

---

## Preconditions

- Dev server at `localhost:3030` (preview MCP `serverId` from `preview_list`).
- The nesting workspace: in `preview_eval` `localStorage.setItem('kd_admin_v1','1')`, reload `/`, open a project's Nest (exit any Nest view via `.kdnest-header button`, "📋 Projects" tab, click leaf "Bung 01", then the per-project Nest entry / `#nest=` — OR use the "▶ Nest" tab + open the project). `window.kdNest` exists once the workspace is open.
- Screenshots unreliable — assert via `preview_eval` (read `S.flatSheets`, computed values).
- `nest.js` is Group 1's engine; เอ๋ confirmed their session is done. `git add nest.js` ONLY — never `-A`.

## File Structure

- `nest.js` — add three things near the existing packers (`_nestMultiSheetRaster` ends ~1190, `_nestMultiSheet` ~1193):
  1. `_largestEmptyRect(occ, gw, gh)` — pure helper (Task 1).
  2. `_nestMultiSheetMaxRemnant(pieces, stock, gap)` + `HYBRID_FILL_AREA_FRAC` const (Task 2).
  3. `mode === 'Max Remnant'` dispatch in `_nestMultiSheet` (Task 2) + `'Max Remnant'` in the mode `<select>` ~1967 (Task 3).

---

### Task 1: `_largestEmptyRect` (pure helper) + unit test

**Files:** Modify `nest.js` — add the helper just above `function _nestMultiSheet(` (~line 1193).

- [ ] **Step 1: Add the function**

```js
  // Largest all-zero (empty) axis-aligned rectangle in a binary occupancy grid.
  // Standard "maximal rectangle in a binary matrix": per row, treat consecutive
  // empty cells upward as histogram bar heights, then largest-rectangle-in-
  // histogram via a monotonic stack. O(gw*gh). Returns the biggest empty rect in
  // CELLS: { gx, gy, w, h, area }. Used to score how big a reusable rectangular
  // offcut a layout leaves. (2026-05-30 Max Remnant mode)
  function _largestEmptyRect(occ, gw, gh) {
    const heights = new Int32Array(gw);
    let best = { gx: 0, gy: 0, w: 0, h: 0, area: 0 };
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        heights[x] = occ[y * gw + x] ? 0 : heights[x] + 1;
      }
      const stack = [];   // {x, h} with strictly increasing h
      for (let x = 0; x <= gw; x++) {
        const h = x < gw ? heights[x] : 0;
        let start = x;
        while (stack.length && stack[stack.length - 1].h >= h) {
          const top = stack.pop();
          const area = top.h * (x - top.x);
          if (area > best.area) {
            best = { gx: top.x, gy: y - top.h + 1, w: x - top.x, h: top.h, area };
          }
          start = top.x;
        }
        stack.push({ x: start, h });
      }
    }
    return best;
  }
```

- [ ] **Step 2: Unit-test via preview_eval**

Open the Nest workspace (see Preconditions) so `nest.js` is loaded. The helper is module-private, so test it through a temporary global the implementer adds ONLY for this step: append `window.__kdTestLER = _largestEmptyRect;` at the very end of the IIFE temporarily — OR (preferred, no temp global) verify by reasoning + the integration test in Task 2. If exposing temporarily, `preview_eval`:
```js
(() => {
  const gw = 4, gh = 4, occ = new Uint8Array(gw*gh);
  // occupy bottom row (y=3) and right column (x=3) → empty 3x3 at top-left
  for (let x = 0; x < gw; x++) occ[3*gw + x] = 1;
  for (let y = 0; y < gh; y++) occ[y*gw + 3] = 1;
  return window.__kdTestLER(occ, gw, gh);
})()
```
Expected: `{ gx:0, gy:0, w:3, h:3, area:9 }`. If a temp global was added, REMOVE it before committing (the function ships private). Report which path was used.

- [ ] **Step 3: Commit**
```bash
git add nest.js
git commit -m "feat(nest): _largestEmptyRect helper (maximal empty rectangle in occupancy grid)"
```

---

### Task 2: `_nestMultiSheetMaxRemnant` + dispatch

**Files:** Modify `nest.js` — add the constant + function just above `function _nestMultiSheet(` (after `_largestEmptyRect`), and add the dispatch line inside `_nestMultiSheet`.

- [ ] **Step 1: Add the constant + function**

```js
  // A part is a gap-fill candidate iff it can rotate freely (grain ANY → 4 rots)
  // and is small relative to the sheet. Tunable. (2026-05-30 Max Remnant)
  const HYBRID_FILL_AREA_FRAC = 0.08;

  // "Max Remnant": pick the layout that leaves the largest reusable rectangular
  // offcut. Generates candidates (the 4 rectangle packers + a gap-filled variant
  // that tucks small ANY parts into interior gaps), scores each by its largest
  // empty rectangle (true-shape grid), and returns the best by
  // (fewest unplaced, fewest sheets, largest remnant). Reuses _rasterMask /
  // _blFind / _stamp / _largestEmptyRect — no new collision code. (2026-05-30)
  function _nestMultiSheetMaxRemnant(pieces, stock, gap) {
    const minSide = Math.min.apply(null, stock.map(s => Math.min(s.w, s.h)).concat([1525]));
    const R = Math.max(5, Math.round(minSide / 200));
    const dCells = gap > 0 ? Math.max(1, Math.round(gap / R)) : 0;
    const maskCache = new Map();
    function maskOf(p, rot) {
      const key = p.code + '|' + rot + '|' + Math.round(p.w) + 'x' + Math.round(p.h);
      let m = maskCache.get(key);
      if (!m) { m = _rasterMask(p, rot, R); maskCache.set(key, m); }
      return m;
    }
    const bboxArea = p => (p.w || 0) * (p.h || 0);

    // True-shape occupancy grid for one sheet (silhouette + gap halo).
    function trueOcc(sheet) {
      const gw = Math.ceil(sheet.sw / R), gh = Math.ceil(sheet.sh / R);
      const occ = new Uint8Array(gw * gh);
      for (const pl of sheet.placements) {
        _stamp(occ, gw, gh, maskOf(pl, pl.rot), Math.round(pl.x / R), Math.round(pl.y / R), dCells);
      }
      return { occ, gw, gh };
    }

    // Largest empty rectangle across a candidate's sheets, in mm².
    function remnantArea(candidate) {
      let best = 0;
      for (const sheet of candidate.sheets) {
        const { occ, gw, gh } = trueOcc(sheet);
        const r = _largestEmptyRect(occ, gw, gh);
        const mm = r.area * R * R;
        if (mm > best) best = mm;
      }
      return best;
    }

    // Gap-fill: relocate small ANY parts into interior gaps (no-gap → keep
    // original). Returns a NEW candidate; never adds a sheet or loses a part.
    function gapFill(candidate) {
      const sheets = candidate.sheets.map(s => ({ ...s, placements: s.placements.slice() }));
      for (const sheet of sheets) {
        const gw = Math.ceil(sheet.sw / R), gh = Math.ceil(sheet.sh / R);
        const occ = new Uint8Array(gw * gh);
        const fillCap = HYBRID_FILL_AREA_FRAC * sheet.sw * sheet.sh;
        const isFill = pl => Array.isArray(pl.rots) && pl.rots.length === 4 && bboxArea(pl) <= fillCap;
        const big = sheet.placements.filter(pl => !isFill(pl));
        const fill = sheet.placements.filter(isFill).sort((a, b) => bboxArea(b) - bboxArea(a));
        for (const pl of big) _stamp(occ, gw, gh, maskOf(pl, pl.rot), Math.round(pl.x / R), Math.round(pl.y / R), dCells);
        const out = big.slice();
        for (const f of fill) {
          let pick = null;
          for (const rot of f.rots) {
            const m = maskOf(f, rot);
            const pos = _blFind(occ, gw, gh, m);
            if (pos && (pick === null || pos.gy < pick.gy || (pos.gy === pick.gy && pos.gx < pick.gx))) {
              pick = { rot, m, gx: pos.gx, gy: pos.gy };
            }
          }
          if (pick) {
            _stamp(occ, gw, gh, pick.m, pick.gx, pick.gy, dCells);
            out.push({ ...f, x: pick.gx * R, y: pick.gy * R, rot: pick.rot });
          } else {
            _stamp(occ, gw, gh, maskOf(f, f.rot), Math.round(f.x / R), Math.round(f.y / R), dCells);
            out.push(f);
          }
        }
        sheet.placements = out;
      }
      return { sheets, unplaced: candidate.unplaced };
    }

    // Candidates: 4 rectangle packers + a gap-filled variant of the best one.
    const rectCands = ['MaxRects', 'Bottom', 'BL Corner', 'Left'].map(m => _nestMultiSheet(pieces, stock, gap, m));
    let bestRect = null;
    for (const c of rectCands) {
      if (bestRect === null || c.unplaced.length < bestRect.unplaced.length
          || (c.unplaced.length === bestRect.unplaced.length && c.sheets.length < bestRect.sheets.length)) {
        bestRect = c;
      }
    }
    const candidates = rectCands.slice();
    if (bestRect) candidates.push(gapFill(bestRect));

    // Score: unplaced asc, sheets asc, remnant desc.
    let winner = null, ws = null;
    for (const c of candidates) {
      const s = { unplaced: c.unplaced.length, sheets: c.sheets.length, remnant: remnantArea(c) };
      if (winner === null
          || s.unplaced < ws.unplaced
          || (s.unplaced === ws.unplaced && s.sheets < ws.sheets)
          || (s.unplaced === ws.unplaced && s.sheets === ws.sheets && s.remnant > ws.remnant)) {
        winner = c; ws = s;
      }
    }
    return winner || { sheets: [], unplaced: pieces.slice() };
  }
```

- [ ] **Step 2: Add the dispatch**

In `_nestMultiSheet`, just after the existing `if (mode === 'True Shape') return _nestMultiSheetRaster(pieces, stock, gap);` line, add:
```js
    if (mode === 'Max Remnant') return _nestMultiSheetMaxRemnant(pieces, stock, gap);
```
(The recursion `_nestMultiSheetMaxRemnant` → `_nestMultiSheet(..., m)` only uses rectangle modes, so it never recurses into 'Max Remnant'.)

- [ ] **Step 3: Integration-verify (overlap = 0 is the gate)**

Open the Nest workspace for Bung 01 (Preconditions). Run Max Remnant programmatically + read results. `preview_eval`:
```js
(() => {
  // Drive the packer via the public state: set mode + run.
  // kdNest exposes openProject/etc; the mode select sets S.mode. We set it
  // through the select if present, else trigger run. Easiest: click the mode
  // <select> option then the Run button.
  const sel = document.querySelector('select.kdnest-mode, #kdnest-mode, select[name=mode]') ||
              [...document.querySelectorAll('select')].find(s => [...s.options].some(o => /Max Remnant|True Shape/.test(o.textContent)));
  if (sel) { sel.value = [...sel.options].find(o => o.textContent.trim()==='Max Remnant')?.value ?? sel.value; sel.dispatchEvent(new Event('change', {bubbles:true})); }
  const runBtn = [...document.querySelectorAll('button')].find(b => /run nest/i.test(b.textContent||''));
  if (runBtn) runBtn.click();
  return { hasSelect: !!sel, ranClicked: !!runBtn };
})()
```
Wait ~800ms, then read placements + check overlaps + remnant. `preview_eval`:
```js
(() => {
  const S = window.__kdNestState || null; // see note
  // Fallback: read from the rendered sheets if state isn't exposed.
  return 'inspect-via-state';
})()
```
NOTE: `S` is module-private. To inspect, the implementer adds a TEMPORARY debug export `window.__kdNestState = S;` at the end of the IIFE for this step ONLY (remove before commit), OR reads placements from the canvas data. With `window.__kdNestState` exposed, `preview_eval`:
```js
(() => {
  const S = window.__kdNestState;
  const sheets = S.flatSheets || [];
  // Overlap check: pairwise bounding-box of footprints per sheet must already
  // be non-overlapping for true shapes; do a coarse footprint-overlap count as
  // a fast guard, then a fine raster check is done in Task 4.
  function fw(pl){ return (pl.rot===90||pl.rot===270)?pl.h:pl.w; }
  function fh(pl){ return (pl.rot===90||pl.rot===270)?pl.w:pl.h; }
  let report = sheets.map((sh, i) => {
    const ps = sh.placements;
    return { sheet: i, count: ps.length };
  });
  return { sheetCount: sheets.length, totalPlaced: sheets.reduce((a,s)=>a+s.placements.length,0), report };
})()
```
Expected: sheets render, total placed == selected piece count, no console errors. (Full overlap proof is Task 4.) Remove any temp `window.__kdNestState` before committing — OR keep it only if Group 1 already exposes state (check first; if not, remove).

- [ ] **Step 4: Commit**
```bash
git add nest.js
git commit -m "feat(nest): Max Remnant mode — pick layout with the largest reusable rectangular offcut"
```

---

### Task 3: UI — add 'Max Remnant' to the mode dropdown

**Files:** Modify `nest.js` (~line 1967, the mode `<select>` options array).

- [ ] **Step 1: Add the option**

Find the array building the mode options (around line 1967):
```js
                ${['Auto','True Shape','MaxRects','BL Corner','Left','Bottom']
```
Change it to append `'Max Remnant'`:
```js
                ${['Auto','True Shape','MaxRects','BL Corner','Left','Bottom','Max Remnant']
```

- [ ] **Step 2: Verify the option is selectable + runs**

Open the Nest workspace. `preview_eval`:
```js
(() => {
  const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.textContent.trim()==='Max Remnant'));
  if (!sel) return { hasOption: false };
  const opt = [...sel.options].find(o => o.textContent.trim()==='Max Remnant');
  sel.value = opt.value; sel.dispatchEvent(new Event('change', {bubbles:true}));
  const runBtn = [...document.querySelectorAll('button')].find(b => /run nest/i.test(b.textContent||''));
  if (runBtn) runBtn.click();
  return { hasOption: true, selectedNow: sel.value };
})()
```
Expected: `hasOption:true`; after change+run the sheets re-render with no console errors (`preview_console_logs level:error`).

- [ ] **Step 3: Commit**
```bash
git add nest.js
git commit -m "feat(nest): expose 'Max Remnant' in the mode dropdown"
```

---

### Task 4: Overlap proof + remnant check + deploy

- [ ] **Step 1: Prove zero overlaps (ship gate)**

With Max Remnant run on Bung 01, do a FINE raster overlap check across each sheet's placements (the same true-shape grid the packer uses). `preview_eval` (needs the temp `window.__kdNestState = S;` debug export, or read placements another way; remove after):
```js
(() => {
  const S = window.__kdNestState; if (!S) return { err:'expose S' };
  const lib = null;
  // Coarse but reliable: rebuild an occupancy grid per sheet by stamping each
  // placement's footprint rectangle; ANY cell stamped twice => overlap.
  let overlaps = 0, detail = [];
  for (const sh of (S.flatSheets||[])) {
    const R = 5; const gw = Math.ceil(sh.sw/R), gh = Math.ceil(sh.sh/R);
    const occ = new Uint8Array(gw*gh);
    for (const pl of sh.placements) {
      const w = (pl.rot===90||pl.rot===270)?pl.h:pl.w;
      const h = (pl.rot===90||pl.rot===270)?pl.w:pl.h;
      // shrink each footprint by 1 cell margin so touching edges (gap) don't
      // count as overlap; only real interior overlap trips it.
      const x0=Math.round(pl.x/R)+1, y0=Math.round(pl.y/R)+1;
      const x1=Math.round((pl.x+w)/R)-1, y1=Math.round((pl.y+h)/R)-1;
      for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++){ const k=y*gw+x; if(occ[k]){overlaps++;} occ[k]=1; }
    }
  }
  return { overlaps };
})()
```
Expected: `overlaps: 0`. (This is a footprint-level guard; combined with the design's reuse of `_blFind`/`_stamp` true-shape occupancy, footprint-overlap-free is a strong signal. If `overlaps > 0`, STOP — do not ship; the seeding coordinate mapping is wrong.) Remove the temp `window.__kdNestState` export before final commit.

- [ ] **Step 2: Remnant ≥ rectangle + sheets not worse**

Compare Max Remnant vs Auto for the same parts (run each, read sheet count + eyeball that chevrons moved inward). Expected: Max Remnant sheet count == Auto sheet count; the small ANY parts sit in interior gaps. Confirm `preview_console_logs level:error` empty.

- [ ] **Step 3: Confirm existing modes unchanged**

Run Auto, then MaxRects — confirm they still render normally (the dispatch only added one branch; existing paths untouched). No console errors.

- [ ] **Step 4: Remove any temp debug export, then push + deploy**

Ensure no `window.__kdTestLER` / `window.__kdNestState` remains (`grep -n "__kdTest\|__kdNestState" nest.js` → 0). Then:
```bash
git add nest.js && git commit -m "chore(nest): remove temp debug exports" --allow-empty
git pull --rebase origin main
git push origin main
```
(If `git pull --rebase` complains about unrelated working-tree changes in OTHER files, `git stash push -- <that file>`, pull/push, `git stash pop`. `git add nest.js` only.)
Watch the latest run to `completed / success` and confirm live:
```bash
curl -s "https://wuttichaisaeton.github.io/kitchen-drawings-rd2026/nest.js" | grep -c "_nestMultiSheetMaxRemnant"
```
Expected `>= 1`.

- [ ] **Step 5: Board entry (this touches Group 1's engine)**

Append to `docs/coordination/group-sync.md` a Group 2 → Group 1 entry: new additive "Max Remnant" mode (new functions `_largestEmptyRect` + `_nestMultiSheetMaxRemnant` + dispatch + dropdown option), no existing packer changed, reuses `_rasterMask`/`_blFind`/`_stamp`. `git add` the board file only, commit, push.

---

## Self-Review

**Spec coverage:**
- New mode "Max Remnant", additive → Task 2 (function + dispatch) + Task 3 (dropdown). ✓
- Objective = largest empty rectangle → Task 1 (`_largestEmptyRect`) + Task 2 (`remnantArea` scorer). ✓
- Scoring order (unplaced, sheets, remnant desc) → Task 2 Step 1 scoring loop. ✓
- Corner-pack candidates + gap-fill candidate → Task 2 (`rectCands` + `gapFill`). ✓
- Gap-fill fill rule (ANY + ≤8%) → `isFill` using `rots.length===4` + `HYBRID_FILL_AREA_FRAC`. ✓
- Remnant on true-shape grid → `trueOcc` stamps masks. ✓
- Reuse `_rasterMask`/`_blFind`/`_stamp`, no new collision code → Task 2. ✓
- Never worse (no extra sheet / lost part) → gapFill keeps originals; scoring prefers fewer sheets. ✓
- Overlap proof gate → Task 4 Step 1. ✓
- Existing modes unchanged → Task 4 Step 3; only one dispatch branch added. ✓

**Placeholder scan:** No TBD/TODO; full code in every code step; expected results given. The temp debug-export approach for inspecting private `S`/`_largestEmptyRect` is explicit with removal steps. ✓

**Type consistency:** `_largestEmptyRect(occ,gw,gh)→{gx,gy,w,h,area}` defined Task 1, consumed in Task 2 `remnantArea` via `.area`. `_nestMultiSheetMaxRemnant(pieces,stock,gap)` signature matches the dispatch call. Helpers `_rasterMask(p,rot,R)`, `_blFind(occ,gw,gh,mask)→{gx,gy}`, `_stamp(occ,gw,gh,mask,gx,gy,dCells)` match their existing definitions (verified against nest.js:1032/1088/1111). Placements are `{...piece,x,y,rot}` carrying `rots`/`polys`/`bbox`/`w`/`h` — used by `isFill`/`maskOf`. ✓
