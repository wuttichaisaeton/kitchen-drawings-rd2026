# Remnant Direction Choice + Side-by-Side Preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the LAST nesting sheet leaves a usable rectangle, let เอ๋ choose whether the leftover runs **wide (─, full-width band on top)** or **long (│, full-height column on right)** by showing **both variants side-by-side in a modal** and clicking to pick.

**Architecture:** Make the existing `_rectifyLastSheet()` (nest.js ~2343, from commit d537ab9) *direction-aware*: instead of auto-picking the single largest-rect layout, it computes up to **two** variants (h = bottom-biased pack → wide top band; v = left-biased pack → tall right column), stashes both on `sheet._rectVariants`, applies a sensible default, and — when both are valid — flags a pending chooser. `_runNesting` opens a chooser modal (two `_drawSheet` mini-canvases) after it renders. Clicking a card applies that variant to the live `sheet.placements` + `sheet.lastRemnantRect`, which every downstream consumer (`_drawSheet` green box, `_autoSaveRemnants` "(last · rect)") already reads unchanged. No schema/Fusion change.

**Tech Stack:** Vanilla JS browser IIFE (no bundler — `nest.js` loads directly), Canvas 2D, `localStorage` for preference persistence, `node --check` for syntax + a standalone node harness for the one pure helper, then live preview verification on GitHub Pages. CSS in `style.css` (per-theme opaque modal already established via `.kdstock-frame`).

**Spec:** `docs/superpowers/specs/2026-06-12-remnant-direction-preview-design.md` (approved by เอ๋).

---

## Background — verified code facts (read before starting)

These were confirmed by reading the live code; the plan depends on them:

- **`_runNesting()`** is at `nest.js:2536`, **synchronous** (`function _runNesting()`). It sets `S.currentSheetIdx = 0` (2700), calls `_rectifyLastSheet()` (2702), then `_refreshView()` (2709). The chooser hook goes **right after** `_refreshView()`.
- **`_rectifyLastSheet()`** is at `nest.js:2343`. It: returns early if `!S.rectLeftover`; finds the last non-`fromRemnant` sheet index `li`; reconstructs `pieces` from `sheet.placements` (keeping `code,w,h,rots,polys,bbox,thickness,grain`); builds `stock = [{w:sheet.sw,h:sheet.sh,qty:1,thickness:sheet.thick}]`; loops packers `['Bottom','Left','BL Corner','MaxRects']` via `_nestMultiSheet`, keeping the largest `_largestOffcut`; sets `sheet.lastRemnantRect` when `≥ _REMNANT_MIN_LAST` (300) both sides; sets `S.currentSheetIdx = li`.
- **`_nestMultiSheet(pieces, stock, gap, mode)`** (`nest.js:2225`) → `{ sheets:[{thick,sw,sh,placements:[{...piece,x,y,rot}]}], unplaced:[...] }`. Modes include `'Bottom'` (packs toward bottom edge), `'Left'` (packs toward left edge), `'MaxRects'` (densest), `'BL Corner'`, `'Desktop'`.
- **`_largestOffcut(sheet)`** (`nest.js:2393`) → `{x,y,w,h,area}` mm, bottom-left origin. Works on any `{sw,sh,placements}` shape.
- **`_drawSheet(canvas, sheet)`** (`nest.js:2920`) takes a canvas + a sheet object `{thick,sw,sh,placements,lastRemnantRect}`. **Verified it does NOT read `S.currentSheetIdx`** — the only `S.*` it touches are `S.flatSheets` (for the cross-sheet colour map at 2982, falls back to `[sheet]`) and `S.highlightCode`. So calling it standalone on a variant sheet is SAFE: colours resolve because the variant's `code`s exist in `S.flatSheets`, and it draws `sheet.lastRemnantRect` as a green dashed box (3109–3127). It reads `canvas.clientWidth/clientHeight` (2923–2924) → the canvas **must be in the DOM with a CSS size** before drawing.
- **`_REMNANT_MIN_LAST = 300`** (`nest.js:2342`).
- **Modal pattern:** `.kdstock-modal` > `.kdstock-backdrop` + `.kdstock-frame` (`role="dialog"`), head `.kdstock-head` (draggable: CSS `cursor:move` at style.css:6309), `.kdstock-close`. Reference impl: `_renderSavedJobsModal` (`nest.js:3549`). `.kdstock-frame` is `position:relative; z-index:1` (style.css:4762) so the backdrop can't swallow clicks — **do not** make the frame `position:static`.
- **Persistence pattern:** `rectLeftover` IIFE (`nest.js:43-46`) reads `localStorage.getItem('kd_nest_rectleft_v1')` in a try/catch. Mirror this for `rectDir`.
- **State object** `S` starts at `nest.js:~30`; sheet nav vars: `S.flatSheets`, `S.currentSheetIdx`.
- No existing collisions: `rectDir`, `_rectVariants`, `_rectChoosePending`, `_pickDefaultRectDir`, `_applyRectVariant`, `_openRectDirModal`, `kdrectdir` appear **0 times** in nest.js/style.css.
- `node v22.15.0` is available.

---

## File Structure

| File | Responsibility | Changes |
|---|---|---|
| `nest.js` | All nesting logic + the chooser | Add `S.rectDir` state + persistence; add pure `_pickDefaultRectDir()`; rewrite `_rectifyLastSheet()` to be direction-aware; add `_applyRectVariant()`; add `_openRectDirModal()`; hook it into `_runNesting`. |
| `style.css` | Chooser modal layout | Add `.kdrectdir-*` classes (two side-by-side canvas cards, "bigger" green ring + chip, responsive stack on narrow). |
| `test/rectdir_pick.test.js` (throwaway) | Unit-test the one pure helper | New tiny node harness for `_pickDefaultRectDir` logic; deleted after Task 2 (codebase has no test runner — this mirrors the board's "node-test" practice). |

> Per the codebase convention (vanilla IIFE, browser-only, no module exports), only the **pure decision helper** is node-unit-tested. The packing + canvas integration is verified **live** in the preview (Tasks 6–7), which is this repo's established verification path (CLAUDE.md verification workflow).

---

### Task 1: Add `S.rectDir` state + persistence

**Files:**
- Modify: `nest.js` (the `S = {...}` state literal, next to `rectLeftover` at `nest.js:43-46`)

- [ ] **Step 1: Add the state field**

Find the `rectLeftover` IIFE block (`nest.js:43-46`) and insert this immediately AFTER its closing `})(),` line:

```javascript
    rectDir: (function () {            // เอ๋ 2026-06-12: remembered leftover direction
      try {                            // 'h' = wide band on top, 'v' = tall column right.
        const v = localStorage.getItem('kd_nest_rectdir');   // null until first pick
        return (v === 'h' || v === 'v') ? v : null;
      } catch (e) { return null; }
    })(),
```

- [ ] **Step 2: Verify syntax**

Run: `node --check nest.js`
Expected: no output (exit 0). If it errors, fix the comma/brace before continuing.

- [ ] **Step 3: Commit**

```bash
git add nest.js
git commit -m "feat(nest): add remembered rectDir state (kd_nest_rectdir)"
```

---

### Task 2: Pure `_pickDefaultRectDir()` helper (TDD)

Decides which direction to apply by default when both variants are valid: the remembered direction if still valid, else the bigger-area one. This is the only genuinely pure piece — unit-test it.

**Files:**
- Create (throwaway): `test/rectdir_pick.test.js`
- Modify: `nest.js` (add the helper near `_rectifyLastSheet`, before line 2343)

- [ ] **Step 1: Write the failing test harness**

Create `test/rectdir_pick.test.js`:

```javascript
// Throwaway node harness for _pickDefaultRectDir (deleted after this task).
// Re-implements ONLY the pure helper's expected contract to lock behaviour,
// then requires the real one via a tiny extraction shim.
const assert = require('assert');

// Load the real helper by evaluating just its definition in a sandbox.
// The function is self-contained (no closure deps) so we can eval its source.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'nest.js'), 'utf8');
const m = src.match(/function _pickDefaultRectDir\([\s\S]*?\n  \}/);
assert(m, '_pickDefaultRectDir not found in nest.js');
const _pickDefaultRectDir = eval('(' + m[0].replace(/^\s*function _pickDefaultRectDir/, 'function') + ')');

const H = { rect: { w: 1000, h: 400, area: 400000 } };   // wide band
const V = { rect: { w: 400, h: 1000, area: 400000 } };   // tall column
const Hbig = { rect: { w: 1000, h: 600, area: 600000 } };
const Vsmall = { rect: { w: 400, h: 500, area: 200000 } };

// both null -> null
assert.strictEqual(_pickDefaultRectDir({ h: null, v: null }, null), null, 'both null');
// only one valid -> that one
assert.strictEqual(_pickDefaultRectDir({ h: H, v: null }, null), 'h', 'only h');
assert.strictEqual(_pickDefaultRectDir({ h: null, v: V }, 'h'), 'v', 'only v (ignore stale remembered)');
// both valid + remembered valid -> remembered
assert.strictEqual(_pickDefaultRectDir({ h: Hbig, v: Vsmall }, 'v'), 'v', 'remembered v wins even if smaller');
assert.strictEqual(_pickDefaultRectDir({ h: Hbig, v: Vsmall }, 'h'), 'h', 'remembered h');
// both valid + remembered null -> bigger area
assert.strictEqual(_pickDefaultRectDir({ h: Hbig, v: Vsmall }, null), 'h', 'bigger=h');
assert.strictEqual(_pickDefaultRectDir({ h: Vsmall, v: Hbig }, null), 'v', 'bigger=v');
// tie + no remembered -> 'h'
assert.strictEqual(_pickDefaultRectDir({ h: H, v: V }, null), 'h', 'tie -> h');

console.log('OK _pickDefaultRectDir: 8 assertions passed');
```

- [ ] **Step 2: Run it to confirm it fails (helper not defined yet)**

Run: `node test/rectdir_pick.test.js`
Expected: FAIL — `AssertionError: _pickDefaultRectDir not found in nest.js`.

- [ ] **Step 3: Implement the helper**

In `nest.js`, immediately BEFORE the `_REMNANT_MIN_LAST` line (currently `nest.js:2342`), add:

```javascript
  // Default leftover direction when BOTH variants are usable (เอ๋ 2026-06-12):
  // honour the remembered pick if it's still valid, otherwise recommend the
  // bigger-area rectangle. Pure (no closures) so it is node-unit-tested.
  // variants = { h:{rect:{w,h,area}}|null, v:{...}|null }; remembered 'h'|'v'|null.
  function _pickDefaultRectDir(variants, remembered) {
    const h = variants && variants.h, v = variants && variants.v;
    if (!h && !v) return null;
    if (h && !v) return 'h';
    if (v && !h) return 'v';
    if (remembered === 'h' || remembered === 'v') return remembered;
    const ah = (h.rect.area != null) ? h.rect.area : h.rect.w * h.rect.h;
    const av = (v.rect.area != null) ? v.rect.area : v.rect.w * v.rect.h;
    return av > ah ? 'v' : 'h';   // tie -> 'h'
  }
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node test/rectdir_pick.test.js`
Expected: `OK _pickDefaultRectDir: 8 assertions passed`

- [ ] **Step 5: Syntax check + delete the throwaway harness**

Run: `node --check nest.js`  → expected exit 0
Run: `rm test/rectdir_pick.test.js` (do not commit it — the repo has no test runner; the assertions are captured in this plan).

- [ ] **Step 6: Commit**

```bash
git add nest.js
git commit -m "feat(nest): _pickDefaultRectDir — remembered-or-bigger default (8 node assertions green)"
```

---

### Task 3: Make `_rectifyLastSheet()` compute both variants + add `_applyRectVariant()`

Rewrite the body so it computes the **h** (bottom-biased) and **v** (left-biased) variants, validates each (≥300mm both sides), stashes them on `sheet._rectVariants`, applies the default via `_applyRectVariant`, and flags `S._rectPendingIdx` when BOTH are valid (so the chooser opens).

**Files:**
- Modify: `nest.js:2343-2387` (the whole `_rectifyLastSheet` function body) + add `_applyRectVariant` directly after it.

- [ ] **Step 1: Replace the function body**

Replace lines `nest.js:2343-2387` (from `function _rectifyLastSheet() {` through its closing `}` before the `// ── Auto-remember offcuts ──` comment) with:

```javascript
  function _rectifyLastSheet() {
    S._rectPendingIdx = -1;            // reset each run (chooser hook reads this)
    if (!S.rectLeftover) return;
    const sheets = S.flatSheets || [];
    // last FRESH-stock sheet (offcut-derived sheets aren't re-rectified)
    let li = -1;
    for (let i = sheets.length - 1; i >= 0; i--) { if (!sheets[i].fromRemnant) { li = i; break; } }
    if (li < 0) return;
    const sheet = sheets[li];
    if (!sheet.placements || !sheet.placements.length) return;
    const origPlacements = sheet.placements;   // floor — never make the result worse

    // Reconstruct pieces from the placements (strip x/y/rot; keep rots so grain
    // gating is preserved through the re-pack).
    const pieces = sheet.placements.map(pl => ({
      code: pl.code, w: pl.w, h: pl.h,
      rots: Array.isArray(pl.rots) ? pl.rots.slice() : [0, 90, 180, 270],
      polys: pl.polys, bbox: pl.bbox, thickness: pl.thickness, grain: pl.grain,
    }));
    const stock = [{ w: sheet.sw, h: sheet.sh, qty: 1, thickness: sheet.thick }];

    // Re-pack the single last sheet with one edge-biased mode; the primary mode
    // collapses the leftover toward one edge, 'MaxRects' is the denser fallback
    // when the primary can't fit every piece on one sheet. Returns the packed
    // placements (all pieces on ONE sheet) or null.
    const _repack = (modes) => {
      for (const mode of modes) {
        let r;
        try { r = _nestMultiSheet(pieces.map(p => ({ ...p })), stock, S.gap, mode); }
        catch (e) { continue; }
        const out = r && r.sheets && r.sheets[0];
        if (!out || (r.unplaced && r.unplaced.length) || r.sheets.length !== 1) continue;
        if (out.placements.length !== sheet.placements.length) continue;
        return out.placements;
      }
      return null;
    };
    // Build one direction's variant: re-pack, measure the largest rect, accept
    // only when ≥300mm both sides. rect/placements live in mm/sheet space.
    const _variant = (modes) => {
      const placements = _repack(modes);
      if (!placements) return null;
      const rect = _largestOffcut({ sw: sheet.sw, sh: sheet.sh, placements });
      if (!(rect.w >= _REMNANT_MIN_LAST && rect.h >= _REMNANT_MIN_LAST)) return null;
      return { placements, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h, area: rect.area } };
    };

    // h (─ wide): parts toward the BOTTOM -> leftover = wide band on top.
    // v (│ long): parts toward the LEFT  -> leftover = tall column on right.
    const variants = {
      h: _variant(['Bottom', 'MaxRects']),
      v: _variant(['Left', 'MaxRects']),
    };
    sheet._rectVariants = variants;

    const dir = _pickDefaultRectDir(variants, S.rectDir);
    if (!dir) {
      // Neither direction yields a usable rectangle — behave as the no-remnant
      // baseline: keep the original layout, no green box.
      sheet.placements = origPlacements;
      sheet.lastRemnantRect = null;
      return;
    }
    _applyRectVariant(sheet, li, dir);
    // Both valid -> ask เอ๋ to SEE both (modal); one valid -> applied silently.
    if (variants.h && variants.v) S._rectPendingIdx = li;
  }

  // Apply one computed variant to the live sheet (swap placements + rect) and
  // land the view on it. Shared by the default-apply and the chooser click.
  function _applyRectVariant(sheet, idx, dir) {
    const variant = sheet._rectVariants && sheet._rectVariants[dir];
    if (!variant) return;
    sheet.placements = variant.placements;
    sheet.lastRemnantRect = { x: variant.rect.x, y: variant.rect.y, w: variant.rect.w, h: variant.rect.h };
    S.currentSheetIdx = idx;
  }
```

- [ ] **Step 2: Verify syntax**

Run: `node --check nest.js`
Expected: exit 0.

- [ ] **Step 3: Sanity-check the contract via grep**

Run: `grep -nE "_rectVariants|_applyRectVariant|S\._rectPendingIdx|_pickDefaultRectDir" nest.js`
Expected: `_rectVariants` set in `_rectifyLastSheet` + read in `_applyRectVariant`; `S._rectPendingIdx` set in `_rectifyLastSheet`; `_pickDefaultRectDir` called once. No call to `_openRectDirModal` yet (Task 4).

- [ ] **Step 4: Commit**

```bash
git add nest.js
git commit -m "feat(nest): _rectifyLastSheet computes h/v variants + _applyRectVariant; flags pending chooser"
```

---

### Task 4: Chooser modal `_openRectDirModal()` + wire into `_runNesting`

**Files:**
- Modify: `nest.js` — add `_openRectDirModal` (place it right after `_applyRectVariant` from Task 3) and hook it into `_runNesting` after `_refreshView()` (currently `nest.js:2709`).

- [ ] **Step 1: Add the modal function**

Add immediately after the `_applyRectVariant` function (Task 3):

```javascript
  // Side-by-side chooser shown when the last sheet's leftover can run either way
  // (เอ๋ 2026-06-12 'เพิ่ม Preview ให้ดู และเลือกได้ว่า อยากให้เหลือเศษ ตามแนวยาว
  // หรือแนวขวาง'). Two mini _drawSheet canvases; the bigger-area one is ringed +
  // chipped (recommended); a remembered dir pre-selects its card. Click = apply +
  // remember; backdrop/✕ = keep the already-applied default (never trap with no
  // result). Opens only when BOTH variants exist (gated by the caller).
  function _openRectDirModal(idx) {
    const sheet = (S.flatSheets || [])[idx];
    if (!sheet || !sheet._rectVariants || !sheet._rectVariants.h || !sheet._rectVariants.v) return;
    document.querySelectorAll('.kdrectdir-modal').forEach(m => m.remove());
    const V = sheet._rectVariants;
    const areaH = V.h.rect.area != null ? V.h.rect.area : V.h.rect.w * V.h.rect.h;
    const areaV = V.v.rect.area != null ? V.v.rect.area : V.v.rect.w * V.v.rect.h;
    const biggerDir = areaV > areaH ? 'v' : 'h';
    const preDir = (S.rectDir === 'h' || S.rectDir === 'v') ? S.rectDir : biggerDir;
    const dim = (r) => Math.round(r.w) + '×' + Math.round(r.h) + 'mm';

    const card = (dir, glyph, name, rect) => `
      <div class="kdrectdir-card${dir === preDir ? ' kdrectdir-pre' : ''}${dir === biggerDir ? ' kdrectdir-big' : ''}" data-dir="${dir}">
        <canvas class="kdrectdir-canvas" data-dir="${dir}"></canvas>
        <div class="kdrectdir-cap">${glyph} ${name} · ${dim(rect)}${dir === biggerDir ? ' <span class="kdrectdir-chip">bigger</span>' : ''}</div>
      </div>`;

    const modal = document.createElement('div');
    modal.className = 'kdstock-modal kdrectdir-modal';
    modal.innerHTML = '<div class="kdstock-backdrop"></div>'
      + `<div class="kdstock-frame" role="dialog" aria-label="Remnant direction">
           <div class="kdstock-head">Remnant direction
             <span class="kdstock-sub">pick how the leftover runs — click a layout</span>
             <button class="kdstock-close" aria-label="Close">✕</button>
           </div>
           <div class="kdrectdir-body">
             ${card('h', '─', 'Wide', V.h.rect)}
             ${card('v', '│', 'Long', V.v.rect)}
           </div>
         </div>`;
    document.body.appendChild(modal);

    // Draw each variant into its mini canvas. Canvas must be laid out (in DOM
    // with a CSS size) before _drawSheet reads clientWidth — double-rAF like
    // _refreshView. Standalone variantSheet is safe (verified: _drawSheet reads
    // only S.flatSheets[colour] + S.highlightCode, draws the sheet arg).
    const drawAll = () => {
      modal.querySelectorAll('.kdrectdir-canvas').forEach(cv => {
        const d = cv.dataset.dir;
        const vSheet = {
          thick: sheet.thick, sw: sheet.sw, sh: sheet.sh,
          placements: V[d].placements,
          lastRemnantRect: { x: V[d].rect.x, y: V[d].rect.y, w: V[d].rect.w, h: V[d].rect.h },
        };
        _drawSheet(cv, vSheet);
      });
    };
    requestAnimationFrame(() => { drawAll(); requestAnimationFrame(drawAll); });

    const close = () => modal.remove();
    const pick = (dir) => {
      _applyRectVariant(sheet, idx, dir);
      S.rectDir = dir;
      try { localStorage.setItem('kd_nest_rectdir', dir); } catch (e) {}
      close();
      _refreshView();           // re-render on the chosen sheet (green box = chosen rect)
    };
    // Backdrop / ✕ = keep the already-applied default pick (no trap, one result).
    modal.querySelector('.kdstock-backdrop').addEventListener('click', close);
    modal.querySelector('.kdstock-close').addEventListener('click', close);
    modal.querySelectorAll('.kdrectdir-card').forEach(c =>
      c.addEventListener('click', () => pick(c.dataset.dir)));
  }
```

- [ ] **Step 2: Wire it into `_runNesting`**

Find `_refreshView();` at `nest.js:2709` (inside `_runNesting`, the one right after the `if (S.unplaced.length){...}` block). Insert AFTER it:

```javascript
    // Last-sheet leftover can run either way → let เอ๋ see both and pick.
    if (S.rectLeftover && S._rectPendingIdx >= 0) _openRectDirModal(S._rectPendingIdx);
```

- [ ] **Step 3: Verify syntax**

Run: `node --check nest.js`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add nest.js
git commit -m "feat(nest): _openRectDirModal side-by-side chooser, wired into _runNesting"
```

---

### Task 5: Modal CSS (`.kdrectdir-*`)

**Files:**
- Modify: `style.css` — add after the `.kdstock-frame` block (`style.css:~4772`), in the base (dark) theme section so the existing per-theme `.kdstock-frame`/`.kdstock-backdrop` opacity rules cover it.

- [ ] **Step 1: Add the styles**

Append after the `.kdstock-sub` rule (`style.css:4774`):

```css
/* Remnant-direction chooser (เอ๋ 2026-06-12): two side-by-side variant previews.
   Reuses .kdstock-frame (opaque + above backdrop in every theme). Wider frame
   for two canvases; stacks on narrow screens (iPad portrait). */
.kdrectdir-modal .kdstock-frame { max-width: 760px; }
.kdrectdir-body { display: flex; gap: 14px; padding: 16px; flex-wrap: wrap; }
.kdrectdir-card {
  flex: 1 1 320px; min-width: 0; cursor: pointer;
  background: #0f1620; border: 1px solid #1c2530; border-radius: 8px;
  padding: 8px; transition: border-color .12s, box-shadow .12s, transform .08s;
}
.kdrectdir-card:hover { border-color: #2a5dff; transform: translateY(-1px); }
.kdrectdir-card:active { transform: translateY(0); }
.kdrectdir-canvas { width: 100%; height: 240px; display: block; border-radius: 6px; }
.kdrectdir-cap {
  margin-top: 8px; text-align: center; font-family: "Flux Architect", monospace;
  font-size: 13px; color: #cfe0e6;
}
/* The recommended (bigger-leftover) card: green ring + chip. */
.kdrectdir-card.kdrectdir-big { border-color: #4ecca3; box-shadow: 0 0 0 1px #4ecca3 inset; }
.kdrectdir-chip {
  display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 10px;
  background: #4ecca3; color: #0f1620; font-size: 10px; font-weight: 700; vertical-align: middle;
}
/* The pre-selected card (remembered dir, or bigger when none remembered): amber outline. */
.kdrectdir-card.kdrectdir-pre { outline: 2px solid #e08e2b; outline-offset: -1px; }
@media (max-width: 560px) { .kdrectdir-card { flex-basis: 100%; } }
```

- [ ] **Step 2: Sanity check the CSS parses (no tooling — visual grep)**

Run: `grep -c "kdrectdir" style.css`
Expected: ≥ 9 (the selectors above). Confirms the block landed.

- [ ] **Step 3: Commit**

```bash
git add style.css
git commit -m "feat(nest): CSS for the remnant-direction chooser (side-by-side, ring on bigger)"
```

---

### Task 6: Live verification in the preview

The integration (packing → variants → modal → apply) is verified live — the repo has no headless canvas runner.

**Files:** none (verification only). Uses preview_* tools.

- [ ] **Step 1: Start the dev server**

`preview_start` on the `drawings-ui` directory (static server; `nest.js`/`style.css` load directly, no build). Then `preview_eval: window.location.reload()` if needed.

- [ ] **Step 2: Open a project whose last sheet is nearly empty + Run Nesting**

The d537ab9 test case is a **1-cabinet 02 Ruth** run (leaves an empty-ish last sheet). Navigate to the Nest workspace, pick that project (or any project with a single small cabinet enabled so the last fresh sheet has lots of free space), ensure the **"Rect leftover (last)"** toggle (`#kdnest-rectleft`) is ON, and click **▶ Run Nesting** (`preview_click`). Answer the remnants-remember `confirm()` (either is fine).

- [ ] **Step 3: Confirm the chooser opens with two variants**

`preview_snapshot` + `preview_screenshot`. Expected: a `.kdrectdir-modal` with **two** mini canvases — left "─ Wide · W×Hmm" (a wide leftover band drawn as a green dashed box across the top), right "│ Long · W×Hmm" (a tall green box down the right). The bigger-area card carries the green ring + "bigger" chip. `preview_console_logs` → 0 errors.

If a canvas is blank: check `_drawSheet` got a non-zero `clientWidth` (the double-rAF should handle it; if not, the `.kdrectdir-canvas` height/width CSS from Task 5 is missing or the modal wasn't in the DOM yet).

- [ ] **Step 4: Pick the non-default card → it applies**

`preview_click` the card that is NOT pre-selected. Expected: modal closes; the main sheet view jumps to the last sheet showing that direction's green "REMNANT W×H" box (the dashed overlay from `_drawSheet`, nest.js:3109). `preview_eval: localStorage.getItem('kd_nest_rectdir')` → equals the dir you clicked (`'h'` or `'v'`).

- [ ] **Step 5: Re-run → remembered card is pre-selected**

Click **▶ Run Nesting** again (same project). Expected: the chooser reopens with the remembered direction's card carrying the amber `kdrectdir-pre` outline (it may differ from the green "bigger" ring — that's intended: bigger = recommendation, amber = your remembered pick).

- [ ] **Step 6: Busy-sheet baseline (no modal)**

Open **full 02 Ruth** (all cabinets) and Run Nesting. Expected: the last sheet is too busy for either edge packer to fit all pieces on one sheet → `_rectVariants` both null → **no modal**, no green remnant box (identical to the d537ab9 baseline). `preview_eval: document.querySelector('.kdrectdir-modal')` → `null`.

- [ ] **Step 7: Save Nest carries the chosen rect**

From the 1-cabinet run (with a chosen direction), click **💾 Save Nest** and accept remember-remnants. Expected: the save summary reports a remnant; the saved offcut's note ends with **"(last · rect)"** and its `w×h` equals the chosen variant's rect (the existing `_autoSaveRemnants` path at nest.js:2515 — unchanged, just reads the new `lastRemnantRect`). Verify via the Remnants Stock modal (📦) showing the new auto offcut for this project, then (optional) delete it to self-clean.

- [ ] **Step 8: Record results**

Note pass/fail per scenario. If any fail, debug from source (read the failing function, fix, re-verify from Step 3) — do NOT proceed to deploy on a failure.

---

### Task 7: Deploy + live-site verification + board entry

**Files:** none new (push + verify). Follows CLAUDE.md deploy rules + `feedback_check_deploy` (watch the deploy until the version is live).

- [ ] **Step 1: Push**

```bash
git push origin main
```

- [ ] **Step 2: Watch the deploy to green**

Run: `gh run watch` (or `gh run list --limit 1`) until the GitHub Pages deploy for this push shows **success**. Do not claim done until it's green.

- [ ] **Step 3: Live curl markers**

Run (PowerShell): fetch the deployed `nest.js` with no-store and confirm the new code is live:
```bash
curl -s "https://wuttichaisaeton.github.io/kitchen-drawings-rd2026/nest.js" | grep -c "_openRectDirModal\|_pickDefaultRectDir\|kd_nest_rectdir"
```
Expected: ≥ 3 (the three markers present in the served file).

Run:
```bash
curl -s "https://wuttichaisaeton.github.io/kitchen-drawings-rd2026/style.css" | grep -c "kdrectdir"
```
Expected: ≥ 9.

- [ ] **Step 4: One live-site smoke check**

Load the live URL in the preview (not localhost), Run Nesting on the 1-cabinet project, confirm the chooser opens + a pick applies + persists. (Catches the jsdelivr/CDN-staleness class noted in memory — verify on the live site, not just local.)

- [ ] **Step 5: Append the board entry**

Per `feedback_log_changes_to_sync` (log every change to the Sync board immediately, with what+why+ref+verify+next). `git pull --rebase origin main` first (another session may have appended), then add ONE entry at the BOTTOM of `docs/coordination/group-sync.md`:

```
### 2026-06-12 - G2 (WEB15) -> e + RD: REMNANT DIRECTION + side-by-side PREVIEW DONE (<commit>, LIVE)
STATUS: shipped item 1 of the WEB14 handoff.
_rectifyLastSheet now computes BOTH leftover directions (─ wide = parts down/band on top; │ long = parts left/column right), validates each ≥300mm, and when both are usable opens a side-by-side chooser (two _drawSheet mini-canvases) after Run Nesting — bigger-leftover card ringed green + "bigger" chip, remembered dir (kd_nest_rectdir) amber-preselected, click to apply. One valid → applies silently; both null (busy sheet, e.g. full 02 Ruth) → no modal = d537ab9 baseline. Downstream unchanged: _drawSheet green box + _autoSaveRemnants "(last · rect)" read the chosen rect. Verified: 1-cabinet 02 Ruth → modal w/ 2 variants → pick persists → re-run pre-selects; full 02 Ruth → no modal; Save → "(last · rect)" rect = chosen. node --check clean; deploy <run> green; live nest.js/style.css markers verified.
FYI G1/RD: nest.js + style.css touched → pull --rebase before your next edit there.
**NEEDS:** nothing
```

- [ ] **Step 6: Commit + push the board entry**

```bash
git add docs/coordination/group-sync.md
git commit -m "docs(sync): WEB15 — remnant direction + preview shipped"
git push origin main
```

- [ ] **Step 7: Update memory**

Update `reference_remnants_stock_modal` (or `reference_nest_warnings`/a remnants memo) noting the new direction chooser: `_rectifyLastSheet` is now direction-aware (`_rectVariants {h,v}`), `_openRectDirModal` chooser, `S.rectDir`/`kd_nest_rectdir` persistence, default = remembered-or-bigger. One line in `MEMORY.md` if a new file is created.

---

## Self-Review (completed by plan author)

**1. Spec coverage:**
- "─ wide vs │ long direction control" → Task 3 (`_variant(['Bottom',...])` = h/wide; `_variant(['Left',...])` = v/long). ✓
- "Modal showing BOTH side-by-side, click to pick" → Task 4 (`_openRectDirModal`, two cards) + Task 5 (CSS flex). ✓
- "Highlight the bigger-leftover direction (recommended)" → Task 4 `biggerDir` → `.kdrectdir-big` green ring + chip (Task 5). ✓
- "Default = remembered if valid else bigger" → Task 2 `_pickDefaultRectDir` + Task 4 `preDir`. ✓
- "both null → no remnant (baseline)" → Task 3 `if(!dir){...lastRemnantRect=null}` + Task 6 Step 6. ✓
- "exactly one valid → apply, no modal" → Task 3 (`_applyRectVariant`; pending flag only set when both valid). ✓
- "backdrop/✕ = apply default, don't trap" → Task 4 `close()` keeps the already-applied default (default applied in Task 3 before the flag). ✓
- "draw/save unchanged" → Tasks rely on existing `_drawSheet`/`_autoSaveRemnants`; Task 6 Step 7 verifies. ✓
- "persist `kd_nest_rectdir`" → Task 1 (read) + Task 4 (write). ✓
- "`_drawSheet` reads S.currentSheetIdx risk" → resolved: verified it does NOT (Background facts); standalone variantSheet is safe. ✓
- Testing scenarios (variants computed / modal / one valid / busy / save) → Task 6 Steps 3–7. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Every code step has full code. ✓

**3. Type consistency:** `_rectVariants = {h,v}` with `{placements, rect:{x,y,w,h,area}}` used identically in Task 3 (set), Task 4 (read `V.h.rect.area`, `V[d].placements`), Task 2 helper (`variants.h.rect.area`). `_applyRectVariant(sheet, idx, dir)` signature matches both call sites (Task 3 default-apply `_applyRectVariant(sheet, li, dir)`, Task 4 `_applyRectVariant(sheet, idx, dir)`). `S._rectPendingIdx` set in Task 3, read in Task 4. `_openRectDirModal(idx)` matches the `_runNesting` call. ✓
