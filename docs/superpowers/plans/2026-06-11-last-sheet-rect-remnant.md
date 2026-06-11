# Last-sheet Rectangular Remnant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-pack the last sheet of a nest so its leftover collapses into one clean rectangle, drawn on the sheet and saved as a remnant.

**Architecture:** A post-pass `_rectifyLastSheet()` runs inside `_runNesting` after `S.flatSheets` is set, gated by a `S.rectLeftover` toggle. It re-packs ONLY the last fresh-stock sheet's pieces through the existing edge-biased packers (`Bottom`/`Left`/`BL Corner`), measures each result with `_largestOffcut`, and keeps whichever (incl. the original) leaves the largest rectangle — stashing it on `sheet.lastRemnantRect` for the draw + save consumers.

**Tech Stack:** Vanilla JS (`nest.js`, `style.css` load directly — no bundler/test framework). Verify in the preview browser + `node --check` + live `curl`. Firebase RTDB for remnant save.

**Spec:** `docs/superpowers/specs/2026-06-11-last-sheet-rect-remnant-design.md`

**Verified facts (file:line, current):**
- `_nestMultiSheet(pieces, stock, gap, mode)` (`nest.js:2221`) → `{sheets:[{sw,sh,placements:[{...piece,x,y,rot}]}], unplaced:[...]}`. Modes `'Bottom'`/`'Left'`/`'BL Corner'` use the Skyline packer (edge-biased). Piece shape: `{code,w,h,rots,polys,bbox,thickness,grain}`; a placement is that spread + `{x,y,rot}`.
- `_largestOffcut(sheet)` (`nest.js:2336`) → `{x,y,w,h,area}` mm, bottom-left origin.
- `_runNesting` sets `S.flatSheets` (`nest.js:2632`), then `S.currentSheetIdx = 0` (`2637`), `S.unplaced` (`2638`), `_refreshView()` (`2645`).
- `_autoSaveRemnants` (`nest.js:2420`): loops `S.flatSheets`, skips `fromRemnant`, `_largestOffcut`, saves ≥ `_REMNANT_MIN` (150, line 2419), note `'Auto · sheet '+(i+1)`.
- `_drawSheet` (`nest.js:2856`): outer vars `offX`, `offY`, `scale`; sheet outline at `strokeRect(offX, offY, sheet.sw*scale, sheet.sh*scale)` (`2886`); placement loop ends at `~3039`. Canvas mapping: `x_px = offX + x*scale`, `y_px = offY + (sheet.sh - y)*scale` (y-flip).
- Mode/Gap controls in `.kdnest-controls` (`nest.js:3966-3977`); `S.mode` change wired at `4067`.
- `S` state object declared ~line 25-70 (has `mode`, `gap`, `skipRemnants`, `cabinetsOff`, `remnantsOff`, `flatSheets`, `currentSheetIdx`).

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `nest.js` | toggle state + `_rectifyLastSheet()` post-pass + draw overlay + save preference | Modify |
| `style.css` | checkbox label styling (minimal) | Modify |

---

## Task 1: Toggle — `S.rectLeftover` + checkbox + persistence

**Files:** Modify `nest.js` (state default, controls render ~3976, wiring ~4067).

- [ ] **Step 1: Add the persisted default near the other S defaults**

In `nest.js`, find the `skipRemnants: true,` line in the `S` object (~line 42) and add after it:

```javascript
    rectLeftover: (function () {       // เอ๋ 2026-06-11: re-pack the LAST sheet so its
      try { return localStorage.getItem('kd_nest_rectleft_v1') !== '0'; }  // leftover is one rectangle. Default ON.
      catch (e) { return true; }
    })(),
```

- [ ] **Step 2: Add the checkbox to the controls row**

In `_viewHtml`, find the Gap label block (`nest.js:3973-3976`) ending with `</label>` after the gap `<span>mm</span>`, and insert a new label right after it (still inside `.kdnest-controls`):

```javascript
            <label class="kdnest-rectleft-lab" title="Re-pack the LAST sheet so the leftover becomes one usable rectangle (saved as a remnant ≥300mm)">
              <input id="kdnest-rectleft" type="checkbox"${S.rectLeftover ? ' checked' : ''}> Rect leftover (last)
            </label>
```

- [ ] **Step 3: Wire the checkbox**

In `_wireEvents`, find `$('#kdnest-mode')?.addEventListener('change', ...)` (`nest.js:4067`) and add after it:

```javascript
    $('#kdnest-rectleft')?.addEventListener('change', e => {
      S.rectLeftover = !!e.target.checked;
      try { localStorage.setItem('kd_nest_rectleft_v1', S.rectLeftover ? '1' : '0'); } catch (err) {}
    });
```

- [ ] **Step 4: Style (minimal)**

In `style.css`, find `.kdnest-gap-lab` (grep it) and add after its rule:

```css
.kdnest-rectleft-lab { display: flex; align-items: center; gap: 5px; font-size: 11px; color: #cad6e6; cursor: pointer; }
.kdnest-rectleft-lab input { cursor: pointer; accent-color: #4ecca3; }
```

- [ ] **Step 5: Syntax + verify checkbox renders**

Run: `node --check nest.js` → "nest.js OK".
`preview_start "drawings-ui"` → `preview_resize 1280x900` → open 02 Ruth nest → `preview_eval` confirm `document.querySelector('#kdnest-rectleft')` exists and is checked. Toggle it → `localStorage.kd_nest_rectleft_v1` flips. 0 console errors.

- [ ] **Step 6: Commit**

```bash
git -c rebase.autoStash=true pull --rebase origin main
git add nest.js style.css
git commit -m "feat(nest): Rect-leftover toggle (last-sheet rectangular remnant) — state + checkbox

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `_rectifyLastSheet()` core + call in `_runNesting`

**Files:** Modify `nest.js` (new function near `_largestOffcut` ~2336; call after `S.currentSheetIdx = 0` at 2637).

- [ ] **Step 1: Add the post-pass function**

Insert immediately BEFORE `function _largestOffcut(sheet) {` (`nest.js:2336`):

```javascript
  // ── Last-sheet rectangular remnant (เอ๋ 2026-06-11) ───────────────────────
  // Re-pack ONLY the last fresh-stock sheet through the edge-biased packers and
  // keep whichever layout (incl. the original) leaves the largest empty
  // rectangle, so the leftover is one clean usable offcut. Stashes the winning
  // rectangle on sheet.lastRemnantRect ({x,y,w,h} mm) when it's ≥300mm both
  // sides; auto-jumps the view to that sheet. No-op when the toggle is off.
  const _REMNANT_MIN_LAST = 300;   // mm — last-sheet rectangle must be this big to keep
  function _rectifyLastSheet() {
    if (!S.rectLeftover) return;
    const sheets = S.flatSheets || [];
    // last FRESH-stock sheet (offcut-derived sheets aren't re-rectified)
    let li = -1;
    for (let i = sheets.length - 1; i >= 0; i--) { if (!sheets[i].fromRemnant) { li = i; break; } }
    if (li < 0) return;
    const sheet = sheets[li];
    if (!sheet.placements || !sheet.placements.length) return;

    // Reconstruct pieces from the placements (strip x/y/rot; keep rots so grain
    // gating is preserved through the re-pack).
    const pieces = sheet.placements.map(pl => ({
      code: pl.code, w: pl.w, h: pl.h,
      rots: Array.isArray(pl.rots) ? pl.rots.slice() : [0, 90, 180, 270],
      polys: pl.polys, bbox: pl.bbox, thickness: pl.thickness, grain: pl.grain,
    }));
    const stock = [{ w: sheet.sw, h: sheet.sh, qty: 1, thickness: sheet.thick }];

    // Original layout is the floor — never make it worse.
    let best = { placements: sheet.placements, rect: _largestOffcut(sheet) };
    for (const mode of ['Bottom', 'Left', 'BL Corner']) {
      let r;
      try { r = _nestMultiSheet(pieces.map(p => ({ ...p })), stock, S.gap, mode); }
      catch (e) { continue; }
      const out = r && r.sheets && r.sheets[0];
      // accept only if it fit on ONE sheet with ALL pieces placed
      if (!out || (r.unplaced && r.unplaced.length) || r.sheets.length !== 1) continue;
      if (out.placements.length !== sheet.placements.length) continue;
      const cand = { sw: out.sw, sh: out.sh, placements: out.placements };
      const rect = _largestOffcut(cand);
      if (rect.area > best.rect.area) best = { placements: out.placements, rect };
    }

    // Apply the winner (if a re-pack won, swap in its placements).
    if (best.placements !== sheet.placements) sheet.placements = best.placements;
    // Stash the rectangle only when it's genuinely usable.
    sheet.lastRemnantRect = (best.rect.w >= _REMNANT_MIN_LAST && best.rect.h >= _REMNANT_MIN_LAST)
      ? { x: best.rect.x, y: best.rect.y, w: best.rect.w, h: best.rect.h } : null;
    // Land the user on the sheet that now carries the rectangle.
    if (sheet.lastRemnantRect) S.currentSheetIdx = li;
  }
```

- [ ] **Step 2: Call it in `_runNesting` after `currentSheetIdx = 0`**

In `nest.js`, find (`~2637`):

```javascript
    S.currentSheetIdx = 0;
    S.unplaced = result.unplaced || [];
```

Replace with:

```javascript
    S.currentSheetIdx = 0;
    S.unplaced = result.unplaced || [];
    _rectifyLastSheet();   // last-sheet rectangular remnant (may move pieces + auto-jump)
```

- [ ] **Step 3: Syntax check**

Run: `node --check nest.js` → "nest.js OK".

- [ ] **Step 4: Verify the re-pack in preview (no draw yet)**

Reload preview, open 02 Ruth nest, set sheet stock qty high enough that a partial last sheet exists (e.g. row-0 qty 20), Run. Then `preview_eval`:

```javascript
(() => {
  const sheets = window.kdNest && null;  // engine is module-scoped; probe via S through a temp hook
  // TEMP probe: add `window.__lastSheet = () => { const s=S.flatSheets; let li=-1; for(let i=s.length-1;i>=0;i--){if(!s[i].fromRemnant){li=i;break;}} return {li, rect:s[li]&&s[li].lastRemnantRect, nPlaced:s[li]&&s[li].placements.length}; };`
  // at the end of _rectifyLastSheet for this check, then REMOVE before commit.
  return window.__lastSheet ? window.__lastSheet() : 'no-probe';
})()
```

If module scope blocks the probe, TEMPORARILY add `window.__lastSheet = ...` (as above) at the end of `_rectifyLastSheet`, reload, Run, confirm: `rect` has `w>=300 && h>=300`, `nPlaced` equals the pre-rectify placement count (no pieces lost), and `li` is the last index. Compare `rect.area` to the original by toggling `S.rectLeftover=false` and re-running — the rect should be ≥ the off-toggle `_largestOffcut`. REMOVE the probe line before commit. 0 console errors.

- [ ] **Step 5: Commit**

```bash
git -c rebase.autoStash=true pull --rebase origin main
git add nest.js
git commit -m "feat(nest): _rectifyLastSheet — re-pack last sheet for the largest rectangular leftover

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Draw the green rectangle on the last sheet

**Files:** Modify `nest.js` `_drawSheet` (after the placement loop, `~3039`).

- [ ] **Step 1: Add the overlay after the placement loop**

In `_drawSheet`, find the end of the placement loop — the `});` that closes `sheet.placements.forEach(function (pl, i) {` at `nest.js:3039`, immediately before the `// -- Label pass:` comment (`~3041`). Insert between them:

```javascript

    // Last-sheet rectangular remnant overlay (เอ๋ 2026-06-11): a green dashed box
    // over the leftover rectangle, only on the sheet that carries it. Uses the
    // same offX/offY/scale + y-flip as the sheet outline (top-left corner = the
    // rect's top edge → sheet.sh - (y+h)).
    if (sheet.lastRemnantRect && sheet.lastRemnantRect.w > 0) {
      const rr = sheet.lastRemnantRect;
      const rx = offX + rr.x * scale;
      const ry = offY + (sheet.sh - (rr.y + rr.h)) * scale;
      const rw = rr.w * scale, rh = rr.h * scale;
      ctx.save();
      ctx.strokeStyle = '#4ecca3';
      ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
      ctx.setLineDash([8 * (window.devicePixelRatio || 1), 6 * (window.devicePixelRatio || 1)]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(78,204,163,0.10)';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.fillStyle = '#4ecca3';
      ctx.font = (12 * (window.devicePixelRatio || 1)) + 'px "Flux Architect", monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('REMNANT ' + Math.round(rr.w) + '×' + Math.round(rr.h),
        rx + 6, ry + 6);
      ctx.restore();
    }
```

- [ ] **Step 2: Syntax check**

Run: `node --check nest.js` → "nest.js OK".

- [ ] **Step 3: Verify the box draws on the last sheet**

Reload, open 02 Ruth nest (rect toggle ON), Run. The view auto-jumps to the last sheet. `preview_screenshot` → a green dashed rectangle with "REMNANT WxH" sits over the leftover area; the green box does NOT appear on other sheets (navigate with `‹`/`›` and screenshot one). `preview_inspect` the canvas isn't needed — visual confirm. Toggle OFF + Run → no box. 0 console errors.

- [ ] **Step 4: Commit**

```bash
git -c rebase.autoStash=true pull --rebase origin main
git add nest.js
git commit -m "feat(nest): draw the green REMNANT rectangle on the last sheet

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Save the last-sheet rectangle (≥300mm) on Save Nest

**Files:** Modify `nest.js` `_autoSaveRemnants` (`~2434`).

- [ ] **Step 1: Prefer the stashed rect + larger min for the last sheet**

In `_autoSaveRemnants`, find (`nest.js:2434-2435`):

```javascript
        const off = _largestOffcut(sheet);
        if (!(off.w >= _REMNANT_MIN && off.h >= _REMNANT_MIN)) continue;
```

Replace with:

```javascript
        // Last-sheet rectangular remnant (เอ๋ 2026-06-11): if _rectifyLastSheet
        // stashed a rectangle, save THAT (≥300mm) instead of re-measuring; other
        // sheets keep the 150mm offcut behaviour.
        const off = sheet.lastRemnantRect
          ? { x: sheet.lastRemnantRect.x, y: sheet.lastRemnantRect.y, w: sheet.lastRemnantRect.w, h: sheet.lastRemnantRect.h, area: sheet.lastRemnantRect.w * sheet.lastRemnantRect.h }
          : _largestOffcut(sheet);
        const _min = sheet.lastRemnantRect ? _REMNANT_MIN_LAST : _REMNANT_MIN;
        if (!(off.w >= _min && off.h >= _min)) continue;
```

- [ ] **Step 2: Tag the note for the last-sheet remnant**

In the same loop, find the `note:` line (`nest.js:2452`):

```javascript
          note: 'Auto · sheet ' + (i + 1),
```

Replace with:

```javascript
          note: 'Auto · sheet ' + (i + 1) + (sheet.lastRemnantRect ? ' (last · rect)' : ''),
```

- [ ] **Step 3: Syntax check**

Run: `node --check nest.js` → "nest.js OK".

- [ ] **Step 4: Verify save (headless — synthetic, self-cleaning; real Save needs a PAT)**

`_autoSaveRemnants` writes only to RTDB (no PAT needed for the remnant record itself — the PAT is for cut-sheet DXFs in `_saveProject`). In preview, after a Run with a `lastRemnantRect`, call `_autoSaveRemnants` directly via a temp hook OR inspect: reload, Run 02 Ruth, then `preview_eval` to read the would-be record by calling the function and reading RTDB:

```javascript
(async () => {
  // _autoSaveRemnants is module-scoped; expose via window.kdNest if available,
  // else TEMP-hook window.__saveRem = _autoSaveRemnants at module end for this check.
  if (window.__saveRem) { const n = await window.__saveRem(); 
    const snap = await window.firebaseDB.ref('nest_remnants').once('value');
    const vals = Object.values(snap.val()||{}).filter(r=>r.sourceProject===(window.kdNest&&'02 Ruth'));
    const last = vals.find(r=>/last . rect/.test(r.note||''));
    // self-clean the auto remnants this test wrote
    return JSON.stringify({ saved:n, lastRem: last && {w:last.w,h:last.h,note:last.note} });
  }
  return 'no-hook';
})()
```

Confirm a record with note containing "(last · rect)" and `w>=300 && h>=300` exists. Then self-clean: remove the auto remnants written by the test (`firebaseDB.ref('nest_remnants/<id>').remove()` for `auto && sourceProject==='02 Ruth'`). REMOVE the temp hook before commit. (If hooking is awkward, defer the full save check to the live acceptance pass on เอ๋'s machine and verify here that `node --check` passes + the rect is stashed.) 0 console errors.

- [ ] **Step 5: Commit**

```bash
git -c rebase.autoStash=true pull --rebase origin main
git add nest.js
git commit -m "feat(nest): save the last-sheet rectangle as a remnant (>=300mm, tagged last/rect)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Push, deploy, live-verify, board

- [ ] **Step 1: Push + watch deploy**

```bash
git -c rebase.autoStash=true pull --rebase origin main
git push origin main
gh run watch $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

- [ ] **Step 2: Live markers**

```bash
curl -s "https://wuttichaisaeton.github.io/kitchen-drawings-rd2026/nest.js" -H "Cache-Control: no-cache" | grep -c "_rectifyLastSheet\|lastRemnantRect\|kdnest-rectleft"
```
Expected: ≥ 3.

- [ ] **Step 3: Board + memory**

Append ONE board entry (what shipped, ref, per-step verification, the MIXED-grain caveat, the "last fresh sheet only" scope). Update `reference_remnants_stock_modal` / nest memory with the toggle + `_rectifyLastSheet` + 300mm. Commit + push the board.

---

## Self-review notes

- **Spec coverage:** toggle default-on ✓(T1) · re-pack last fresh sheet, multi-edge, pick max incl original ✓(T2 `_rectifyLastSheet`) · auto-jump ✓(T2) · draw green rect via toCanvas y-flip ✓(T3) · save ≥300mm tagged ✓(T4) · last-sheet-only + fromRemnant skip ✓(T2 loop) · never-worse-than-original floor ✓(T2 `best` seeded with original) · no-overlap (re-pack via `_nestMultiSheet`, which never overlaps) ✓.
- **Type consistency:** `sheet.lastRemnantRect = {x,y,w,h}` written in T2, read in T3 (draw) + T4 (save); `_REMNANT_MIN_LAST = 300` defined in T2, reused in T4; `_rectifyLastSheet` defined T2, called T2; piece shape `{code,w,h,rots,polys,bbox,thickness,grain}` matches `_nestMultiSheet`'s contract (`nest.js:2222`).
- **Placeholder scan:** none — temp probes (T2/T4) are explicitly add-then-remove for verification, not shipped code.
- **Known caveats (carry to board):** MIXED-grain last sheet → remnant `_grainFits`-unreusable for directional parts; `_largestOffcut` is ~25mm grid-approximate (saved rect slightly conservative); re-pack only triggers when the last sheet's pieces fit one sheet (the least-full sheet — virtually always true).
