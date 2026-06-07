# Sim.Bending FLAN-live + throat-clearance collision — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Editing a FLAN (flange length) cell in the Sim.Bending step table live-grows the flange in the 2-D/3-D sim, updates the on-part dimension number, and re-checks collision against a per-punch throat clearance computed from the DXF profile.

**Architecture:** Root cause found — the 2-D label + 2-D chain + collision all read `wall.height`, but the FLAN save handler only wrote `wall.flat_len`, so the number never moved. Fix = FLAN writes `height` (+ `flat_len` kept equal) so every consumer follows; replace the 3-value hard-coded `sameSideClearMm` with `throatClearForProfile(punch.prof)` (geometry from `tool-art.js` profiles, calibrated 453≈42 / 103≈12); add a live `change` listener that updates the in-memory record and re-mounts the sim (the render loop re-runs collision itself).

**Tech Stack:** Vanilla JS (loads directly, no bundler). No test framework → pure helpers verified with `node` assertion harnesses (copy-paste pattern used across this repo); `node --check` syntax gate; live verification in the Claude Preview server (port 3030).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `drawings-ui/simbend-3d-ai.js` | `throatClearForProfile` (new), `stackedHitId` uses it, both `mount`/`mount2d` copies | Modify |
| `drawings-ui/app.js` | FLAN→`height` in SAVE handler; `_remountSimBend()` extract; live `.sb-edit-flange` listener | Modify |

**Contractual symbols (used across tasks):**
- `throatClearForProfile(prof)` → number (mm). Pure. In `simbend-3d-ai.js`.
- `stackedHitId(walls, aw, active, punch)` — unchanged signature; body uses `throatClearForProfile(punch.prof)` + compares `w.height`.
- `_remountSimBend()` — in `app.js`; destroys + re-mounts `_simController`/`_simController2D` from `processedCache[_simBendExpanded]`.

> NOTE: there are **TWO** copies of `punchForStep`/`sameSideClearMm`-adjacent logic — the 3-D `mount` (simbend-3d-ai.js ~151-743) and the 2-D `mount2d` (~746-1067). `sameSideClearMm` + `stackedHitId` are module-level (defined once, ~102-122) and shared by both, so they're fixed once. The 2-D label uses `dseg.height` (line ~952); the 3-D extrude uses `flat_len ?? height` (~247). Making FLAN write `height` satisfies both.

---

## Task 1: `throatClearForProfile` — geometric throat clearance (pure)

**Files:**
- Modify: `drawings-ui/simbend-3d-ai.js` (replace `sameSideClearMm`, ~lines 99-107)

- [ ] **Step 1: Write the calibration harness (not committed)**

Create `drawings-ui/_t.mjs`. The 4 profiles are copied verbatim from `tool-art.js` `PROFILES`:

```js
const PROFILES = {
  '202': [[0,0],[12.728,12.728],[12.728,87],[20.728,95],[20.728,105],[17.728,105],[17.728,112.5],[20.728,112.5],[20.728,130],[7.728,130],[7.728,100],[-5.272,100],[-5.272,95],[2.728,87],[2.728,13.618],[-5.444,5.445]],
  '109': [[0,0],[3,3],[3,67.5],[19.5,84],[19.5,125],[6.5,125],[6.5,95],[-6.5,95],[-6.5,71],[-3,67.5],[-3,3]],
  '453': [[0,0],[4.092,4.388],[4.092,4.842],[49,53],[49,77],[36,90],[20,90],[20,95],[17,95],[17,103],[20,103],[17,120],[7,120],[7,90],[-7,90],[-7,81],[11.835,61.495],[14.009,58.621],[15.435,55.311],[16.03,51.756],[15.76,48.162],[14.64,44.736],[-4.243,4.243]],
  '103': [[0,0],[19.158,71.5],[17.033,71.5],[17.033,79.3],[20.033,79.3],[20.033,97],[7.033,97],[7.033,67],[-6.967,67],[-6.967,26]]
};

var THROAT_OFFSET = 2.0;   // tune this in Step 3
function throatClearForProfile(prof) {
  if (!prof || prof.length < 3) return 10;
  var tipHW = 0, maxY = 0, i, j;
  for (i = 0; i < prof.length; i++) { if (prof[i][1] > maxY) maxY = prof[i][1]; if (prof[i][1] <= 8 && Math.abs(prof[i][0]) > tipHW) tipHW = Math.abs(prof[i][0]); }
  var xWall = tipHW + THROAT_OFFSET;
  function sideClearance(sign) {
    var clear = 0, y;
    for (y = 1; y <= maxY; y += 0.5) {
      var halfX = 0;
      for (i = 0, j = prof.length - 1; i < prof.length; j = i++) {
        var y1 = prof[i][1], y2 = prof[j][1], x1 = prof[i][0], x2 = prof[j][0];
        if ((y1 <= y && y2 >= y) || (y2 <= y && y1 >= y)) {
          var t = Math.abs(y2 - y1) < 1e-9 ? 0 : (y - y1) / (y2 - y1);
          var xc = x1 + t * (x2 - x1);
          var ext = sign > 0 ? xc : -xc;
          if (ext > halfX) halfX = ext;
        }
      }
      if (halfX <= xWall) clear = y; else break;
    }
    return clear;
  }
  return Math.max(sideClearance(1), sideClearance(-1));
}

import assert from 'assert';
const c453 = throatClearForProfile(PROFILES['453']);
const c103 = throatClearForProfile(PROFILES['103']);
const c202 = throatClearForProfile(PROFILES['202']);
const c109 = throatClearForProfile(PROFILES['109']);
console.log('453=' + c453.toFixed(1), '103=' + c103.toFixed(1), '202=' + c202.toFixed(1), '109=' + c109.toFixed(1));
assert(Math.abs(c453 - 42) <= 4, '#453 should be ~42, got ' + c453);
assert(Math.abs(c103 - 12) <= 4, '#103 should be ~12, got ' + c103);
assert(c453 > c202, 'gooseneck clears more than sash');
console.log('PASS Task1');
```

- [ ] **Step 2: Run it — see the computed values**

Run: `cd drawings-ui && node _t.mjs`
Expected: prints the 4 values; assertions likely FAIL on the first `THROAT_OFFSET` guess.

- [ ] **Step 3: Calibrate `THROAT_OFFSET` until both anchors pass**

Adjust `THROAT_OFFSET` (try 1.0–8.0) and re-run `node _t.mjs` until `#453 ≈ 42` and `#103 ≈ 12` (±4) and `PASS Task1` prints. **If no single offset satisfies both anchors**, add an explicit override (spec §4.1 sanctions this for the calibration anchors only) — change the function to:

```js
var THROAT_OVERRIDE = { '453': 42, '103': 12 };   // catalog-known anchors
function throatClearForProfile(prof, seriesHint) {
  if (seriesHint && THROAT_OVERRIDE[seriesHint] != null) return THROAT_OVERRIDE[seriesHint];
  // ... geometric body as above ...
}
```
…and re-run until the computed `#202`/`#109` are sane (`> 0`, `#202 ≤ #453`). Record the final values in the commit message.

- [ ] **Step 4: Replace `sameSideClearMm` in `simbend-3d-ai.js`**

Delete the existing `sameSideClearMm` (the function + its lead comment, ~lines 99-107) and paste in its place the calibrated `throatClearForProfile` (the exact body that passed in Step 3, including the final `THROAT_OFFSET`/override). Keep a one-line comment noting the calibration anchors.

- [ ] **Step 5: Syntax gate**

Run: `cd drawings-ui && node --check simbend-3d-ai.js`
Expected: exit 0.

- [ ] **Step 6: Remove harness + commit**

```bash
cd drawings-ui
rm _t.mjs
git add simbend-3d-ai.js
git commit -m "feat(sim): throatClearForProfile — per-punch throat clearance from DXF profile (calibrated 453/103)"
```

---

## Task 2: `stackedHitId` uses the computed clearance

**Files:**
- Modify: `drawings-ui/simbend-3d-ai.js` (`stackedHitId`, ~lines 112-122)

- [ ] **Step 1: Point the collision at the profile clearance**

In `stackedHitId`, replace the clearance line:

```js
    var clr = sameSideClearMm(punch);   // OLD
```
with:
```js
    var clr = throatClearForProfile(punch && punch.prof);   // per-punch geometric throat clearance
```
(The punch object from `punchForStep` already carries `.prof` — the resolved DXF profile points.) The rest of `stackedHitId` is unchanged (`(w.height || 0) > clr`).

- [ ] **Step 2: Syntax gate**

Run: `cd drawings-ui && node --check simbend-3d-ai.js`
Expected: exit 0.
Run: `grep -n "sameSideClearMm" simbend-3d-ai.js`
Expected: no matches (fully removed).

- [ ] **Step 3: Commit**

```bash
cd drawings-ui
git add simbend-3d-ai.js
git commit -m "feat(sim): stackedHitId uses throatClearForProfile(punch.prof)"
```

---

## Task 3: FLAN writes `height` (so the number + length + collision all follow)

**Files:**
- Modify: `drawings-ui/app.js` (SAVE-config handler, ~lines 6071-6082)

- [ ] **Step 1: Set `height` (+ keep `flat_len`) from the edited flange**

In the SAVE handler block that copies edits into `rec.box_geom.walls`, change:

```js
          if (rec.box_geom && rec.box_geom.walls) {
            const wObj = rec.box_geom.walls.find(w => w.id === b.bend);
            if (wObj) {
              wObj.punch = b.punch;
              wObj.die = b.die;
              wObj.angle_deg = b.angle_deg;
              wObj.flat_len = b.flange_mm;
```
to also set `height` (every sim consumer — 2-D label `dseg.height`, 2-D chain, 3-D `flat_len ?? height`, and `stackedHitId` — reads `height`):

```js
          if (rec.box_geom && rec.box_geom.walls) {
            const wObj = rec.box_geom.walls.find(w => w.id === b.bend);
            if (wObj) {
              wObj.punch = b.punch;
              wObj.die = b.die;
              wObj.angle_deg = b.angle_deg;
              wObj.flat_len = b.flange_mm;
              wObj.height = b.flange_mm;   // drive label + 2D/3D length + collision (เอ๋ 2026-06-07)
```
(Leave the closing braces + the `needs_gooseneck` block that follow exactly as-is.)

- [ ] **Step 2: Syntax gate**

Run: `cd drawings-ui && node --check app.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
cd drawings-ui
git add app.js
git commit -m "fix(sim): FLAN edit writes wall.height so the 2D number + length + collision follow"
```

---

## Task 4: Live FLAN edit — re-mount the sim on change

**Files:**
- Modify: `drawings-ui/app.js` (extract `_remountSimBend`, ~lines 5907-5925; add listener near the table wiring)

- [ ] **Step 1: Extract `_remountSimBend()` from the mount block**

Find the mount block (app.js ~5907-5925). Replace the inline block:

```js
  if (_simController) { try { _simController.destroy(); } catch (e) {} _simController = null; }
  if (_simController2D) { try { _simController2D.destroy(); } catch (e) {} _simController2D = null; }
  if (_simBendExpanded && window.kdSimBend) {
    const card = ROOT.querySelector(`.sb-card[data-code="${_simBendExpanded.replace(/"/g, '')}"]`);
    const canvas = card && card.querySelector('.sb-sim-canvas');
    const canvas2d = card && card.querySelector('.sb-sim-canvas-2d');   // box only
    const rec = processedCache[_simBendExpanded];
    if (canvas && rec) {
      _simController = (rec.kind === 'box' && window.kdSimBend3D)
        ? window.kdSimBend3D.mount(canvas, rec, _simBendExpanded)
        : window.kdSimBend.mount(canvas, rec, _simBendExpanded);
      if (canvas2d) {
        _simController2D = (rec.kind === 'box' && window.kdSimBend3D)
          ? window.kdSimBend3D.mount2d(canvas2d, rec, _simBendExpanded)
          : (window.kdSimBend ? window.kdSimBend.mount(canvas2d, rec, _simBendExpanded) : null);
      }
```

with a call to a new hoisted function, keeping the rest of the block (the `playBtn`/`recBtn`/`status`/`highlightActiveRow` wiring that follows) where it is by having `_remountSimBend` return the `card`:

```js
  const card = _remountSimBend();
  if (_simBendExpanded && window.kdSimBend && card) {
    const rec = processedCache[_simBendExpanded];
    if (card.querySelector('.sb-sim-canvas') && rec) {
```

Then define `_remountSimBend` (place it next to the other `_sim*` helpers, above this block):

```js
  function _remountSimBend() {
    if (_simController) { try { _simController.destroy(); } catch (e) {} _simController = null; }
    if (_simController2D) { try { _simController2D.destroy(); } catch (e) {} _simController2D = null; }
    if (!_simBendExpanded || !window.kdSimBend) return null;
    const card = ROOT.querySelector(`.sb-card[data-code="${_simBendExpanded.replace(/"/g, '')}"]`);
    const canvas = card && card.querySelector('.sb-sim-canvas');
    const canvas2d = card && card.querySelector('.sb-sim-canvas-2d');
    const rec = processedCache[_simBendExpanded];
    if (!canvas || !rec) return card;
    _simController = (rec.kind === 'box' && window.kdSimBend3D)
      ? window.kdSimBend3D.mount(canvas, rec, _simBendExpanded)
      : window.kdSimBend.mount(canvas, rec, _simBendExpanded);
    if (canvas2d) {
      _simController2D = (rec.kind === 'box' && window.kdSimBend3D)
        ? window.kdSimBend3D.mount2d(canvas2d, rec, _simBendExpanded)
        : (window.kdSimBend ? window.kdSimBend.mount(canvas2d, rec, _simBendExpanded) : null);
    }
    return card;
  }
```

> The remaining lines after the original block (`const playBtn = card.querySelector('.sb-sim-play'); ...`) stay unchanged — they already reference `card`. Verify `card` is in scope for them (it now comes from `_remountSimBend()`); if the original used a block-scoped `const card` inside `if (...)`, hoist the `const card = _remountSimBend();` so the later wiring still sees it.

- [ ] **Step 2: Syntax gate**

Run: `cd drawings-ui && node --check app.js`
Expected: exit 0.

- [ ] **Step 3: Add the live `.sb-edit-flange` listener**

Where the bend-table cells are wired (the same place the SAVE button + selects are bound — search for `'.sb-edit-flange'` / the SAVE handler near app.js ~6030). Add, after the table is rendered/bound:

```js
    ROOT.querySelectorAll('.sb-edit-flange').forEach(inp => {
      inp.addEventListener('change', () => {
        const code = _simBendExpanded;
        const rec = code && processedCache[code];
        if (!rec) return;
        const bendId = inp.dataset.bend;
        const v = parseFloat(inp.value);
        if (isNaN(v)) return;
        const b = (rec.per_bend || []).find(x => x.bend === bendId);
        if (b) { b.flange_mm = v; b.flange_mm_out = v; }
        if (rec.box_geom && rec.box_geom.walls) {
          const w = rec.box_geom.walls.find(x => x.id === bendId);
          if (w) { w.flat_len = v; w.height = v; }   // one value → label + length + collision
        }
        _remountSimBend();   // re-extrudes flange, redraws the number, re-runs collision
      });
    });
```

This is a what-if: it mutates the in-memory `rec` only. SAVE CONFIG still persists to RTDB as before.

- [ ] **Step 4: Syntax gate**

Run: `cd drawings-ui && node --check app.js`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
cd drawings-ui
git add app.js
git commit -m "feat(sim): live FLAN edit — update in-memory rec + re-mount sim (flange grows, number + collision update)"
```

---

## Task 5: Integration — live verify + deploy

**Files:** none (verification only)

- [ ] **Step 1: Final syntax gate**

Run: `cd drawings-ui && node --check app.js && node --check simbend-3d-ai.js && echo OK`
Expected: `OK`.

- [ ] **Step 2: Live verify in preview**

Start the preview (`drawings-ui` config, port 3030), open a **box** part's Sim.Bending (e.g. `Bung 01` parts; admin role to see Sim.Bending). With the step table visible:

1. Edit a FLAN cell to a larger number (e.g. a #453 gooseneck step 18 → 50) and blur.
   - Expected: the 2-D flange visibly lengthens; the on-part number changes from 18 → 50; the 2-D/3-D collision banner re-evaluates (✗ STACKED WALL COLLISION when the formed same-side wall now exceeds the punch clearance).
2. Edit it back down (50 → 10).
   - Expected: flange shortens, number → 10, banner returns to ✓ BENDABLE.
3. Confirm via `preview_eval` that `processedCache[<code>]` changed but RTDB `bend_sim/<code>` is unchanged (no SAVE).

Use `preview_eval` to read `document.querySelector('.sb-edit-flange')` + drive `.value` + dispatch a `change` event, then `preview_screenshot` the 2-D canvas to confirm the number + length + banner. (Screenshot may transiently time out — retry or use `preview_snapshot`.)

- [ ] **Step 3: Push + watch deploy**

```bash
cd drawings-ui
git pull --rebase origin main
git push origin main
rid=$(gh run list --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$rid" --exit-status; gh run view "$rid" --json status,conclusion -q '.status + " / " + .conclusion'
```
Expected: `completed / success`.

- [ ] **Step 4: Report**

Summarise: calibrated clearance values (453/103/202/109), the live behaviour confirmed, deploy conclusion, elapsed time (⏱).

---

## Self-Review

**Spec coverage:**
- Live FLAN → flange length (2-D + 3-D) → Tasks 3 (height) + 4 (live re-mount). ✓
- Dimension number updates → Task 3 (label reads `height`, line ~952) + Task 4 (re-mount). ✓
- Collision re-evaluated → Task 2 (clearance source) + 4 (re-mount runs the render-loop collision). ✓
- Throat clearance computed from DXF profile, calibrated 453≈42/103≈12, all punches → Task 1. ✓
- What-if (no part change until SAVE) → Task 4 (in-memory `rec` only). ✓
- Replace hard-coded `sameSideClearMm` → Tasks 1+2. ✓
- Covers other punches → Task 1 (geometry per profile; #463 inherits gooseneck until traced). ✓

**Placeholder scan:** No TBD/TODO; every code step shows code. The calibration loop (Task 1 Step 3) is a real tune-until-anchors-pass step with a concrete fallback, not a placeholder. ✓

**Type/name consistency:** `throatClearForProfile(prof)` defined Task 1, called Task 2 with `punch.prof`; `_remountSimBend()` defined + called Task 4; `processedCache`, `_simBendExpanded`, `_simController(2D)`, `.sb-edit-flange`, `b.flange_mm`, `w.height`/`w.flat_len` consistent across tasks. ✓
