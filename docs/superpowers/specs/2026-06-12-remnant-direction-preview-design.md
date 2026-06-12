# Remnant direction choice + side-by-side preview — design

**Owner:** G2 / WEB 14 (spec) → WEB 15 (implement) · **Date:** 2026-06-12 · **Status:** approved (design), handed off for implementation
**File:** `nest.js` + `style.css`. No schema/Fusion change. Builds directly on the
**last-sheet rectangular remnant** feature (`_rectifyLastSheet`, commit d537ab9).

## Goal

When the last sheet leaves a usable rectangle, let เอ๋ choose **which way the leftover
runs** and **see both options before picking**. e (cut-sheet screenshot, red box on the
RIGHT column; current result = a full-width top strip 3050×390): *"เพิ่ม Preview ให้ดู
และเลือกได้ว่า อยากให้เหลือเศษ ตามแนวยาว หรือแนวขวาง"*. RD spec: board entry
2026-06-12 "REMNANT DIRECTION choice (long │ vs wide ─) + PREVIEW".

## Locked decisions (e)

| Fork | Decision |
|---|---|
| Direction control | **─ wide** (parts DOWN → full-width band on top) vs **│ long** (parts LEFT → full-height column on right) |
| Preview | **Modal showing BOTH variants side-by-side, click to pick** |
| Default highlight | **Highlight the direction whose leftover is BIGGER** (recommended) |

## Background — what exists (read first, from the d537ab9 work)

- `_rectifyLastSheet()` (`nest.js` ~2349, called in `_runNesting` right after
  `S.currentSheetIdx = 0`): finds the last fresh-stock sheet, reconstructs pieces from
  `sheet.placements` (`{code,w,h,rots,polys,bbox,thickness,grain}`), loops packers
  `['Bottom','Left','BL Corner','MaxRects']`, measures each via `_largestOffcut`, keeps
  the largest-rect layout (original = floor), stashes `sheet.lastRemnantRect = {x,y,w,h}`
  when ≥ `_REMNANT_MIN_LAST` (300mm) both sides, and auto-jumps to that sheet. Gated by
  `S.rectLeftover` (toggle `#kdnest-rectleft`, default ON, `kd_nest_rectleft_v1`).
- `_nestMultiSheet(pieces, stock, gap, mode)` → `{sheets:[{sw,sh,placements:[{...piece,x,y,rot}]}], unplaced}`.
  `'Bottom'` packs against the bottom edge; `'Left'` against the left edge (Skyline).
- `_largestOffcut(sheet)` → `{x,y,w,h,area}` mm, bottom-left origin.
- `_drawSheet(canvas, sheet)` renders a sheet (placements + sheet outline + the green
  `sheet.lastRemnantRect` box). It reads `S.flatSheets`/`S.currentSheetIdx` for colour
  continuity but draws the `sheet` arg passed in.
- `_autoSaveRemnants` (on 💾 Save Nest) saves `sheet.lastRemnantRect` ≥300 tagged
  "(last · rect)".
- Modal pattern: `.kdstock-frame` / `.kdstock-modal` (opaque in every theme, draggable).

## Architecture

`_rectifyLastSheet()` becomes **direction-aware**: instead of one auto-picked layout it
computes up to **two variants** and stashes both on the sheet; a small chooser decides
(or asks) which to apply. The draw + save consumers are unchanged — they still read
`sheet.lastRemnantRect` + `sheet.placements`, which the chooser sets to the picked variant.

### Data
- `sheet._rectVariants = { h: <variant>|null, v: <variant>|null }` where
  `variant = { placements, rect }` (`rect = {x,y,w,h}`).
  - **h (─ wide):** parts packed toward the BOTTOM → leftover is a wide band on top.
  - **v (│ long):** parts packed toward the LEFT → leftover is a tall column on the right.
- `S.rectDir` (`'h'|'v'`, persisted `kd_nest_rectdir`) — the remembered preference.

### `_rectifyLastSheet()` (revised)
1. Toggle/last-fresh-sheet/piece-reconstruction unchanged.
2. Compute **h variant**: re-pack pieces with the bottom-biased packer (`'Bottom'`, and
   if it can't place all pieces, fall back to `'MaxRects'` — denser). Accept only if all
   pieces fit one sheet. `rect_h = _largestOffcut(layout)`. (For a bottom-packed layout
   the largest empty rect is the top band, which is what we want.)
3. Compute **v variant**: same with the left-biased packer (`'Left'`, fallback `'MaxRects'`).
   `rect_v = _largestOffcut(layout)`.
4. A variant is **valid** only if its rect is ≥300mm both sides.
5. `sheet._rectVariants = { h: validH ? {placements,rect_h} : null, v: validV ? {...} : null }`.
6. **Apply policy** (no UI yet — the chooser, below, drives the modal):
   - both null → no remnant (clear `lastRemnantRect`), behave as today.
   - exactly one valid → apply it immediately (set `placements`+`lastRemnantRect`, jump),
     no modal.
   - both valid → set the DEFAULT pick = remembered `S.rectDir` if that direction is valid,
     else the larger-area one; stash it as the provisional apply, and flag
     `sheet._rectChoosePending = true` so `_runNesting` opens the chooser after render.
7. Helper `_applyRectVariant(sheet, dir)`: `sheet.placements = variant.placements`,
   `sheet.lastRemnantRect = variant.rect`, `S.currentSheetIdx = <that sheet index>`.

### Chooser modal (`_openRectDirModal(sheet, sheetIdx)`)
Opened from `_runNesting` after `_refreshView()` when `sheet._rectChoosePending` and both
variants exist (and `S.rectLeftover`).
- `.kdstock-modal` + `.kdstock-frame` (reuse opaque/draggable), title "Remnant direction".
- Two `<canvas>` side by side, each drawn with `_drawSheet(canvasEl, variantSheet)` where
  `variantSheet = {thick, sw, sh, placements: variant.placements, lastRemnantRect: variant.rect}`.
  Under each: a label "─ Wide · W×H" / "│ Long · W×H".
- The **bigger-area** variant gets a green ring + a "bigger" chip (the recommended one);
  if `S.rectDir` is set and valid it is the pre-selected card instead.
- Click a card → `_applyRectVariant(sheet, dir)`, set `S.rectDir = dir` (persist
  `kd_nest_rectdir`), close modal, `_refreshView()` (now on the chosen sheet with its green
  box). A "Keep both? no" — there is one result; the unchosen variant is discarded.
- Backdrop/✕ close = apply the default pick (don't trap the user with no result).

### Draw / save
Unchanged. After the chooser applies, `sheet.lastRemnantRect` + `sheet.placements` are the
chosen variant, so `_drawSheet`'s green box and `_autoSaveRemnants` "(last · rect)" already
work. `rememberRemnants` records the actual chosen rect as today.

## Edge cases / risks
- **Last sheet busy:** if neither Bottom nor Left (nor MaxRects fallback) can fit all
  pieces on one sheet (e.g. 02 Ruth's 87-piece sheet), both variants are null → no remnant,
  exactly as the d537ab9 baseline. Correct.
- **One direction clearly worse** (grain-locked long parts): that variant may still be
  valid but smaller; the modal shows both honestly and highlights the bigger. Fine.
- **`_drawSheet` reads `S.currentSheetIdx`/`S.flatSheets`** for some state (highlight,
  colour map keyed across all sheets) — passing a standalone `variantSheet` is safe for the
  shape outline + green box, but verify the colour map (`codeColour` built from
  `S.flatSheets`) still resolves piece colours (it keys by `code`, which the variant shares)
  and that no `S.currentSheetIdx`-dependent overlay misfires on the mini canvas. If it does,
  draw the mini with a minimal local renderer (outline + filled placement rects + green box)
  rather than the full `_drawSheet`.
- **Modal spam:** the chooser only opens when BOTH variants are valid AND
  `S.rectLeftover`. A remembered `S.rectDir` does NOT auto-skip the modal (e asked to SEE
  both) — but it pre-selects the remembered card so one Enter/click confirms. (If e later
  says it's too much, gate with a "remember & don't ask" checkbox — out of scope now.)
- **Grid coarseness / coordinate space:** same caveats as d537ab9 (`_largestOffcut` ~25mm
  grid; green box via `toCanvas` y-flip).
- **MIXED grain:** unchanged caveat — a MIXED last sheet's remnant isn't directional-reusable.

## Non-goals
- Changing earlier sheets, the main Mode, or the True-Shape path.
- A blind toggle without preview (e explicitly wants the visual comparison).
- Auto-applying the remembered direction without showing the modal (e wants to see both).

## Testing
- **Variants computed:** on a 1-cabinet 02 Ruth run (empty last sheet — the d537ab9 test
  case), confirm `sheet._rectVariants.h` and `.v` are both non-null with different rects
  (h = wide top band, v = tall right column), both ≥300.
- **Modal:** both-valid → modal opens with two mini canvases, the bigger-area one ringed;
  click the other → that layout applies, green box matches, `kd_nest_rectdir` set; reopen
  run → remembered card pre-selected.
- **One valid:** force one direction invalid (e.g. tiny stock) → no modal, the valid one
  applies.
- **Busy sheet:** full 02 Ruth run → both null → no modal, no remnant (baseline intact).
- **Save:** chosen rect saved "(last · rect)" via the existing path (synthetic RTDB check,
  self-clean).
- `node --check`; 0 console errors; live curl markers after deploy.
