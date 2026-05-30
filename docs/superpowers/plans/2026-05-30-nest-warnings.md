# Nesting workspace warnings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three stacked warning banners (unplaced pieces, grain-uncertain parts, looks-weird parts) + per-row markers to the web Nesting workspace so a worker sees missing/short pieces, undecided grain, and suspicious parts BEFORE cutting.

**Architecture:** Additive changes to `nest.js` (warning logic + render injection + per-row markers) and `style.css` (banner + marker styles). No build step. Three warnings derive from shared pure predicates so the banners and the per-row markers always agree. The unplaced set (today `console.warn`'d and discarded) is stored on `S.unplaced`; grain "decided vs defaulted" is tracked with a new `grainExplicit` flag set wherever grain is deliberately assigned.

**Tech Stack:** Vanilla ES (no bundler — edit then push), verified with `node --check` (no test framework in this repo; the local preview MCP has crashed prior sessions — do NOT use it).

**Spec:** `docs/superpowers/specs/2026-05-30-nest-warnings-design.md`

**Working dir:** `C:/Users/wutti/OneDrive/เดสก์ท็อป/Work/Stainless Kitchen/drawings-ui`

**Critical repo rules:**
- `git add nest.js style.css` (+ plan/spec/coordination docs) **by exact path only** — never `git add -A` (Group 1/Fusion shares this working dir).
- Before each push: `git pull --rebase origin main` then push; if rejected, rebase again.
- No Thai in rendered UI strings (Flux Architect can't render it). `//` comments may be Thai.
- `nest.js`/`style.css` need no build.
- Bash output on this machine is sometimes delayed/echoed — re-run a command once if it looks empty before concluding failure.

---

## File Structure

- **`nest.js`** — adds: `S.unplaced` state + reset; `grainExplicit` provenance in `_newPart`/`_newManualPart`/`_loadProjectParts`; `S.unplaced = result.unplaced` in `_runNesting`; two pure predicates `_isGrainUncertain(p)` + `_reviewReasons(p)`; `_warningsHtml()`; injection into `_viewHtml`; per-row `kdnest-grain-warn` / `kdnest-part-review` markers.
- **`style.css`** — adds: `.kdnest-warn` + `--unplaced`/`--grain`/`--review` banner styles; `.kdnest-grain-warn` ring; `.kdnest-part-review` row border.

Part object shape (existing): `{code, qty, selected, grain, thickness, w, h, manual, dxfUrl, dxfMeta, polys:{outer,strokes,holes}, bbox:[minX,minY,maxX,maxY], dxfLoaded, dxfError}`. Unplaced piece shape (from `_runNesting`): `{code, w, h, rots, polys, bbox, thickness}`.

---

## Task 1: State + grain provenance + store unplaced

**Files:** Modify `nest.js`.

- [ ] **Step 1: Add `unplaced` + `grainExplicit` defaults to state/part factories**

In the `S` state object, find the line:
```javascript
    flatSheets: [],   // [{thick, sw, sh, placements:[{code, x, y, w, h, rot, polys, bbox}]}]
```
Add immediately after it:
```javascript
    unplaced: [],     // pieces the packer couldn't place (set by _runNesting; for the warning banner)
```

In `_newManualPart()`, find:
```javascript
      w: 0, h: 0, grain: 'ANY', thickness: 1,
```
Replace with:
```javascript
      w: 0, h: 0, grain: 'ANY', grainExplicit: true, thickness: 1,
```
(A manual rectangle has no meaningful grain — mark it decided so it never triggers the grain-uncertain warning.)

In `_newPart(code, qty)`, find:
```javascript
      grain: 'ANY',     // H / V / ANY — read from CSV later
```
Replace with:
```javascript
      grain: 'ANY',     // H / V / ANY — read from CSV later
      grainExplicit: false,  // true once a DXF-meta grain or a grain rule sets it (else it's just the default)
```

- [ ] **Step 2: Set `grainExplicit = true` where grain is deliberately assigned in `_loadProjectParts`**

Find (the DXF-meta grain assignment):
```javascript
        part.grain = (meta.grain || part.grain || 'ANY').toUpperCase();
```
Replace with:
```javascript
        part.grain = (meta.grain || part.grain || 'ANY').toUpperCase();
        if (meta.grain) part.grainExplicit = true;
```

Find (the grain-rule match):
```javascript
        const looked = _lookupPattern(part.code, S.grainMap);
        if (looked && looked.grain) part.grain = looked.grain;
```
Replace with:
```javascript
        const looked = _lookupPattern(part.code, S.grainMap);
        if (looked && looked.grain) { part.grain = looked.grain; part.grainExplicit = true; }
```

- [ ] **Step 3: Store the unplaced set in `_runNesting`**

Find (near the end of `_runNesting`):
```javascript
    S.currentSheetIdx = 0;
    if (result.unplaced.length) {
      console.warn('[kdNest] unplaced pieces:', result.unplaced);
    }
    _refreshView();
```
Replace with:
```javascript
    S.currentSheetIdx = 0;
    S.unplaced = result.unplaced || [];
    if (S.unplaced.length) {
      console.warn('[kdNest] unplaced pieces:', S.unplaced);
    }
    _refreshView();
```

- [ ] **Step 4: Reset `S.unplaced` in `close()`**

In `close()`, find:
```javascript
    S.flatSheets = [];
    S.currentSheetIdx = 0;
    S.previewCode = null;
```
Replace with:
```javascript
    S.flatSheets = [];
    S.unplaced = [];
    S.currentSheetIdx = 0;
    S.previewCode = null;
```

- [ ] **Step 5: Syntax check**

Run: `node --check nest.js`
Expected: exits 0, no output.

- [ ] **Step 6: Verify the flags exist**

Run: `grep -n "grainExplicit\|S.unplaced\|unplaced:" nest.js`
Expected: `grainExplicit` in `_newPart`, `_newManualPart`, and twice in `_loadProjectParts`; `unplaced: []` in state; `S.unplaced =` in `_runNesting`; `S.unplaced = []` in `close()`.

- [ ] **Step 7: Commit**

```bash
git add nest.js docs/superpowers/plans/2026-05-30-nest-warnings.md
git commit -m "feat(nest): store unplaced set + track grain provenance (grainExplicit)"
```

---

## Task 2: Pure warning predicates

Two pure functions used by BOTH the banners (Task 3) and the per-row markers, so they can never disagree.

**Files:** Modify `nest.js` — insert directly ABOVE `function _viewHtml() {`.

- [ ] **Step 1: Insert the predicates**

Read the lines just above `function _viewHtml() {` to get a unique anchor, then insert this block immediately before it:

```javascript
  // ── Warning predicates (pure; shared by the banners + per-row markers) ──
  // Grain is "uncertain" when it fell through to the default ANY because no
  // DXF-meta grain and no grain rule ever set it (grainExplicit stays false).
  // (user 2026-05-30 'เตือนเรื่องแนว grain ที่ไม่แน่ใจ')
  function _isGrainUncertain(p) {
    return !!(p && p.selected && !p.manual && !p.grainExplicit);
  }
  // Shoelace area of a polygon ([[x,y],...]) — used to spot degenerate outlines.
  function _polyArea(pts) {
    if (!Array.isArray(pts) || pts.length < 3) return 0;
    let a = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  }
  // "Looks weird" reasons for a selected part (empty array = nothing to flag).
  // Checks: no DXF · DXF parse error / degenerate outline · parsed bbox vs the
  // size encoded in the 13-char code (…WWWHHH, 10mm units), ±10mm tolerance.
  // (user 2026-05-30 'ชิ้นนี้ดูแปลกๆ ให้เข้าไปดูหน่อย / ชิ้นนี้ไม่มี DXF')
  function _reviewReasons(p) {
    const out = [];
    if (!p || !p.selected || p.manual) return out;
    if (!p.dxfUrl) { out.push('no DXF'); return out; }   // can't cut → nothing else to check
    if (p.dxfError) { out.push('DXF error: ' + p.dxfError); return out; }
    if (p.dxfLoaded) {
      const outer = p.polys && p.polys.outer;
      if (!outer || outer.length < 3 || _polyArea(outer) < 1) {
        out.push('degenerate outline');
      }
      // Size-vs-code (FORK A): compare the parsed bbox to the dims encoded in
      // the code. p.w/p.h are forced equal to the bbox on load, so the code is
      // the only independent reference.
      const m = /-(\d{3})(\d{3})$/.exec(p.code || '');
      if (m && p.bbox) {
        const bw = Math.round(p.bbox[2] - p.bbox[0]);
        const bh = Math.round(p.bbox[3] - p.bbox[1]);
        const wCode = parseInt(m[1], 10) * 10;
        const hCode = parseInt(m[2], 10) * 10;
        const TOL = 10;
        const near = v => v > 0 && (Math.abs(bw - v) <= TOL || Math.abs(bh - v) <= TOL);
        const wBad = wCode > 0 && !near(wCode);
        const hBad = hCode > 0 && !near(hCode);
        if (wBad || hBad) {
          out.push(`DXF size ≈ ${bw}×${bh}, code says ~${wCode}×${hCode}`);
        }
      }
    }
    return out;
  }
```

- [ ] **Step 2: Syntax check**

Run: `node --check nest.js`
Expected: exits 0.

- [ ] **Step 3: Logic self-check (read, don't run)**

Confirm: `_isGrainUncertain` excludes manual + decided-grain parts; `_reviewReasons` returns `['no DXF']` early for parts without `dxfUrl` (but never for manual rects — guarded), flags `dxfError`, flags degenerate outer (`<3` pts or area `<1`), and flags size mismatch only when the code ends in `-WWWHHH` and an encoded (non-000) dimension is >10mm from BOTH bbox dims. The orientation-agnostic `near()` (matches either bbox axis) tolerates family-specific W/H↔axis swaps. `grep -n "_isGrainUncertain\|_reviewReasons\|_polyArea" nest.js` shows definitions only (no callers yet — Task 3 adds them).

- [ ] **Step 4: Commit**

```bash
git add nest.js
git commit -m "feat(nest): pure warning predicates (_isGrainUncertain, _reviewReasons)"
```

---

## Task 3: Warnings banner + per-row markers

**Files:** Modify `nest.js` — add `_warningsHtml()` (above `_viewHtml`, after the Task 2 predicates), inject it in `_viewHtml`, and add the two per-row marker classes in the parts-row template.

- [ ] **Step 1: Add `_warningsHtml()`**

Insert immediately AFTER the `_reviewReasons` function (from Task 2) and before `function _viewHtml() {`:

```javascript
  // Build 0–3 stacked warning banners for the result pane. Persistent (not
  // dismissible) so a real problem can't be clicked away before cutting.
  // (user 2026-05-30 'จำนวนขาด ... ก็ไม่มีการแจ้งเตือน')
  function _warningsHtml() {
    const banners = [];

    // ① Unplaced (red, loudest) — only after a run.
    if (S.unplaced && S.unplaced.length) {
      // Active stock thicknesses, so we can flag the "no matching sheet" cause.
      const tk = t => {
        const n = typeof t === 'number' ? t : parseFloat(String(t).replace(/[^\d.]/g, ''));
        return isNaN(n) ? '?' : String(Math.round(n * 100) / 100);
      };
      const stockThick = new Set(
        (S.sheetStock || [])
          .filter(s => s.w > 0 && s.h > 0 && (s.qty !== 0 || s.qty === -1))
          .map(s => tk(s.thickness ?? 1))
      );
      const byCode = new Map();
      for (const pc of S.unplaced) {
        const e = byCode.get(pc.code) || { qty: 0, thickness: pc.thickness };
        e.qty += 1;
        byCode.set(pc.code, e);
      }
      const lines = [...byCode.entries()].map(([code, e]) => {
        const noStock = !stockThick.has(tk(e.thickness));
        const suffix = noStock ? ` (t=${tk(e.thickness)}mm — no matching sheet stock)` : '';
        return `<div class="kdnest-warn-line">${_esc(code)} ×${e.qty}${suffix}</div>`;
      }).join('');
      const total = S.unplaced.length;
      banners.push(
        `<div class="kdnest-warn kdnest-warn--unplaced">
           <div class="kdnest-warn-head">⚠ ${total} piece${total === 1 ? '' : 's'} couldn't be placed</div>
           ${lines}
         </div>`
      );
    }

    // ② Grain uncertain (amber).
    const grainCodes = S.parts.filter(_isGrainUncertain).map(p => p.code);
    if (grainCodes.length) {
      const uniq = [...new Set(grainCodes)];
      banners.push(
        `<div class="kdnest-warn kdnest-warn--grain">
           <div class="kdnest-warn-head">${uniq.length} part${uniq.length === 1 ? '' : 's'} have no confirmed grain — defaulting to ANY (any rotation)</div>
           <div class="kdnest-warn-line">${uniq.map(_esc).join(', ')}</div>
         </div>`
      );
    }

    // ③ Review / looks-weird (orange).
    const reviews = [];
    for (const p of S.parts) {
      const reasons = _reviewReasons(p);
      if (reasons.length) reviews.push({ code: p.code, reasons });
    }
    if (reviews.length) {
      const lines = reviews.map(r =>
        `<div class="kdnest-warn-line">${_esc(r.code)} — ${_esc(r.reasons.join('; '))}</div>`
      ).join('');
      banners.push(
        `<div class="kdnest-warn kdnest-warn--review">
           <div class="kdnest-warn-head">Review ${reviews.length} part${reviews.length === 1 ? '' : 's'}:</div>
           ${lines}
         </div>`
      );
    }

    return banners.join('');
  }
```

- [ ] **Step 2: Inject the banners into `_viewHtml`**

Find:
```javascript
        <main class="kdnest-canvas-wrap">
          <div class="kdnest-canvas-top">
```
Replace with:
```javascript
        <main class="kdnest-canvas-wrap">
          ${_warningsHtml()}
          <div class="kdnest-canvas-top">
```

- [ ] **Step 3: Add the per-row markers in the parts-row template**

In the `partsRows` map, the row currently computes `const g = grainGlyph(p.grain);` etc. and returns a template. Make two edits.

First, after the line `const whLock = p.manual ? '' : ' disabled title="size comes from the DXF — locked"';` add:
```javascript
      const grainWarn = _isGrainUncertain(p) ? ' kdnest-grain-warn' : '';
      const reviewMark = _reviewReasons(p).length ? ' kdnest-part-review' : '';
```

Then change the row's opening div from:
```javascript
        <div class="kdnest-part${p.manual ? ' kdnest-part-manual' : ''}" data-code="${_esc(p.code)}">
```
to:
```javascript
        <div class="kdnest-part${p.manual ? ' kdnest-part-manual' : ''}${reviewMark}" data-code="${_esc(p.code)}">
```

And change the grain button from:
```javascript
          <button class="kdnest-part-grain ${g.cls}" data-grain="${p.grain}" title="${g.title} — click to cycle ?→H→V→ANY">${g.ch}</button>
```
to:
```javascript
          <button class="kdnest-part-grain ${g.cls}${grainWarn}" data-grain="${p.grain}" title="${grainWarn ? 'grain not set by any rule — defaulting to ANY · ' : ''}${g.title} — click to cycle ?→H→V→ANY">${g.ch}</button>
```

- [ ] **Step 4: Syntax check**

Run: `node --check nest.js`
Expected: exits 0.

- [ ] **Step 5: Logic self-check (read, don't run)**

Confirm: `_warningsHtml` is called exactly once inside `_viewHtml` (`grep -n "_warningsHtml" nest.js` = definition + 1 call). The banner order is unplaced → grain → review. `_esc` is used on every interpolated code/reason. The grain-warn marker on the button and the `kdnest-part-review` row class use the same predicates as the banners. No Thai in any rendered string (the strings are English; `//` comments may be Thai).

- [ ] **Step 6: Commit**

```bash
git add nest.js
git commit -m "feat(nest): warning banners (unplaced/grain/review) + per-row markers"
```

---

## Task 4: CSS for banners + markers

**Files:** Modify `style.css` — append at end of file.

- [ ] **Step 1: Append the styles**

Append to the end of `style.css`:
```css
/* Nesting workspace warnings (banners injected at top of .kdnest-canvas-wrap) */
.kdnest-warn {
  margin: 8px 10px 0; padding: 8px 12px; border-radius: 8px;
  font-family: "Flux Architect", ui-monospace, monospace; font-size: 12px;
  border: 1px solid transparent;
}
.kdnest-warn-head { font-weight: 700; margin-bottom: 4px; }
.kdnest-warn-line { opacity: 0.9; overflow-wrap: anywhere; }
.kdnest-warn--unplaced { background: rgba(180,40,40,0.18); border-color: #b42828; color: #ffd9d9; }
.kdnest-warn--grain    { background: rgba(190,140,30,0.16); border-color: #be8c1e; color: #ffe9bf; }
.kdnest-warn--review   { background: rgba(200,110,30,0.14); border-color: #c86e1e; color: #ffdcc0; }
/* Per-row markers */
.kdnest-part-grain.kdnest-grain-warn {
  box-shadow: 0 0 0 2px #be8c1e inset; border-radius: 4px;
}
.kdnest-part.kdnest-part-review {
  border-left: 3px solid #c86e1e;
}
```

- [ ] **Step 2: Verify the block landed**

Run: `grep -n "kdnest-warn--unplaced\|kdnest-grain-warn\|kdnest-part-review" style.css`
Expected: shows the new rules.

- [ ] **Step 3: Confirm ASCII-only (no Thai) in the appended block**

Run: `grep -nP "[\x{0E00}-\x{0E7F}]" style.css | tail`
Expected: no NEW Thai in the appended block (pre-existing matches elsewhere are fine; the block above is ASCII-only).

- [ ] **Step 4: Commit**

```bash
git add style.css
git commit -m "style: nesting warning banners + per-row markers"
```

---

## Task 5: Integration verification + deploy

- [ ] **Step 1: Full syntax pass**

Run: `node --check nest.js && echo OK`
Expected: `OK`.

- [ ] **Step 2: Invariant greps**

Run: `grep -c "_warningsHtml" nest.js` → expect `2` (definition + the one call in `_viewHtml`).
Run: `grep -c "_isGrainUncertain" nest.js` → expect `>= 3` (definition + banner + row marker).
Run: `grep -c "_reviewReasons" nest.js` → expect `>= 3` (definition + banner + row marker).
Run: `grep -c "S.unplaced" nest.js` → expect `>= 3` (run-store + close-reset + banner read).

- [ ] **Step 3: Push (rebase first — Group 1 shares this dir)**

```bash
git pull --rebase origin main
git push origin main
```
Then confirm `LOCAL=$(git rev-parse HEAD)` equals `REMOTE=$(git rev-parse origin/main)`.

- [ ] **Step 4: Confirm Pages serves the new code**

Poll until live (Pages lags ~1 min):
```bash
n=0; until curl -s "https://wuttichaisaeton.github.io/kitchen-drawings-rd2026/nest.js?v=$(date +%s)$n" -o /tmp/lnest.js && grep -q '_warningsHtml' /tmp/lnest.js; do n=$((n+1)); [ $n -gt 40 ] && { echo TIMEOUT; break; }; sleep 8; done; grep -c '_warningsHtml' /tmp/lnest.js
```
Expected: a non-zero count.

- [ ] **Step 5: Runtime eyeball (เอ๋ — preview MCP avoided; check on live, Bung 01)**

1. Open the project's Nest → Run Nesting. If any pieces don't fit, a RED banner "⚠ N pieces couldn't be placed" with `CODE ×N` lines appears at the top of the canvas pane.
2. If a part has no grain rule (defaulted ANY), an AMBER banner lists it, and that part's grain glyph in the sidebar has an amber ring.
3. Any part with no DXF / parse error / bbox far from its code size shows in an ORANGE "Review N parts" banner and the row gets an orange left border.
4. A fully-clean project shows NO banners.

- [ ] **Step 6: Update the coordination board + commit**

Append a `## [date] Group 2 (Web) → Group 1 (Fusion)` entry to `docs/coordination/group-sync.md` summarizing: nest warnings shipped (unplaced/grain/review), all nest.js+style.css, no schema changes, no Fusion action needed. Then:
```bash
git add docs/coordination/group-sync.md
git pull --rebase origin main
git commit -m "coord(Group2->1): nest workspace warnings shipped"
git push origin main
```

---

## Self-Review (completed during planning)

**Spec coverage:**
- ① Unplaced banner (warn-only, grouped `CODE ×N`, no-stock-thickness suffix) → Task 1 (store) + Task 3 (`_warningsHtml` banner ①) + Task 4 (CSS). ✅
- ② Grain-uncertain banner + per-row grain marker, defined as "fell to default ANY" (`grainExplicit=false`) → Task 1 (provenance) + Task 2 (`_isGrainUncertain`) + Task 3 (banner ② + grain-warn class) + Task 4. ✅
- ③ Review banner (no DXF · parse/degenerate · bbox-vs-code FORK A ±10mm) + per-row review border → Task 2 (`_reviewReasons`) + Task 3 (banner ③ + review class) + Task 4. ✅
- FORK A = bbox vs code WWWHHH (not p.w/p.h) → `_reviewReasons` size block. ✅
- FORK B = grain default ANY (not literal '?') → `_isGrainUncertain`. ✅
- Warn-only, export NOT blocked → no change to the Save/export buttons. ✅
- English UI, `git add` by path, rebase-before-push → Tasks 3/4/5. ✅
- Banners persistent (not dismissible), injected top of `.kdnest-canvas-wrap` → Task 3 Step 2. ✅

**Type/name consistency:** `_isGrainUncertain`/`_reviewReasons`/`_polyArea` (Task 2) are consumed by `_warningsHtml` + the row template (Task 3). `S.unplaced` written in `_runNesting` + reset in `close()` (Task 1), read in `_warningsHtml` (Task 3). CSS classes `kdnest-warn--unplaced/--grain/--review`, `kdnest-grain-warn`, `kdnest-part-review` match between Task 3 markup and Task 4 styles. ✅

**Placeholder scan:** no TBD/TODO; every code step shows full code. ✅
