# Last-sheet rectangular remnant — design

**Owner:** G2 / WEB 14 · **Date:** 2026-06-11 · **Status:** approved
**File:** `nest.js` + `style.css` (load directly; push → GitHub Pages). No schema/Fusion change.

## Goal

On the **last sheet** of a nest, re-arrange that sheet's pieces so the leftover
material collapses into one clean, usable **rectangle** — which is then drawn on the
sheet and saved as a remnant. เอ๋ showed sheet 9/9 (parts in the lower half, big empty
top) with a blue box round the top row and red arrows pointing those parts DOWN:
*"เพิ่มความสามารถ ให้ แผ่นสุดท้าย เหลือเศษเป็นสี่เหลี่ยม"*. Scope is the **last sheet
only** — earlier sheets keep their current packing (they're internal to the job).

## Locked decisions (เอ๋)

| Fork | Decision |
|---|---|
| Arrange vs label | **Re-pack** (physically move pieces) — not just mark the existing gap |
| Which edge | **Try multiple edges, pick the one giving the LARGEST rectangle** (not a fixed edge) |
| On/off | **Checkbox next to the Mode dropdown, default ON** ("Rectangular leftover (last sheet)") |
| Min size to save | **≥ 300 mm both sides** (larger than the existing 150 mm `_REMNANT_MIN`) |

## Reused foundations (read before building — file:line)

- **`_largestOffcut(sheet)`** (`nest.js:2336-2376`) — histogram + monotonic-stack
  largest-empty-rectangle on a coarse grid (cell ≈ 25 mm). Returns `{x, y, w, h, area}`
  in mm, bottom-left origin, clamped to sheet bounds. This MEASURES "what rectangle is
  left" — used both to pick the best edge and to draw/save the remnant.
- **`_nestMultiSheet(pieces, stock, gap, mode)`** (`nest.js:2221`) — the packer
  dispatcher. The edge-biased modes **`'Bottom'`, `'Left'`, `'BL Corner'`** already
  pack pieces against an edge. Re-packing the last sheet's pieces through these and
  measuring each result is the core of the feature.
- **`_drawSheet`** (`nest.js:2856-3090`) + `toCanvas()` (y-flip via `sheet.sh - y`,
  single shared scale, rot 90/270 swaps w/h). Hook point AFTER the placement loop
  (`~3039`), BEFORE the label pass. Last-sheet detection: `S.currentSheetIdx === S.flatSheets.length - 1`.
- **`_remnantPreview`** (`nest.js:1175-1214`) — already draws a green `#4ecca3`
  leftover rect in the Stock modal; reuse the colour/style on the main canvas.
- **`_autoSaveRemnants`** (`nest.js:2420-2468`) — on 💾 Save Nest, loops `S.flatSheets`,
  skips `fromRemnant` sheets, calls `_largestOffcut` per sheet, saves offcuts ≥ 150 mm
  to RTDB with `_sheetGrain`, material, finish, `offX/offY`, `sheetW/H`, placements.
- **`_sheetGrain(sheet)`** (`nest.js:2380`) — H+V → MIXED.
- Mode dropdown (`nest.js:~3967`) + `S.mode` binding (`~4067`) — pattern for adding the
  checkbox.
- `_runNesting` (`nest.js:2473`): pieces → byThick → scrap-first → fresh pack →
  `allSheets` assembled (~2625-2631) → `S.flatSheets` set (2632), `S.currentSheetIdx = 0`.

## Architecture

A single **post-pass** `_rectifyLastSheet()` run inside `_runNesting` right after
`S.flatSheets` is assembled, gated by the toggle `S.rectLeftover`. It does not touch any
sheet but the last fresh-stock one, and it never leaves pieces unplaced (fallback to the
original layout). Three thin consumers — draw, save, auto-jump — read one stashed field
`sheet.lastRemnantRect`.

### Data added
- `S.rectLeftover` (bool, default `true`, persisted `kd_nest_rectleft_v1`).
- `sheet.lastRemnantRect = {x, y, w, h}` (mm, bottom-left origin) — set only on the last
  sheet when a qualifying rectangle (≥ 300 mm both sides) exists; `null`/absent otherwise.

### `_rectifyLastSheet()` algorithm
1. If `!S.rectLeftover` → return.
2. Find the **last fresh-stock sheet**: the highest-index `S.flatSheets[i]` with
   `!fromRemnant`. If none → return.
3. **Reconstruct pieces** from that sheet's `placements`: for each placement, build the
   piece shape `_nestMultiSheet` expects — `{code, w, h, rots, polys, bbox, thickness, grain}`
   — taking `w/h/polys/bbox` from the placement and `grain/rots/thickness` from the
   matching `S.parts` entry (by code). (Rots must keep the same grain gating the main run
   used, so the re-pack can't violate grain.)
4. `stock = [{ w: sheet.sw, h: sheet.sh, qty: 1, thickness: sheet.thick }]`.
5. **Candidates:** for `mode` in `['Bottom', 'Left', 'BL Corner']`, call
   `_nestMultiSheet(pieces, stock, S.gap, mode)`. Accept a candidate ONLY if it produced
   exactly one sheet with ALL pieces placed (no unplaced). Measure `rect = _largestOffcut(candidateSheet)`.
6. Also measure the **original** sheet's rect (so we never make it worse).
7. **Pick** the candidate (incl. original) with the largest `rect.area`. If the winner is
   a re-packed candidate, replace `S.flatSheets[i]` with the winner's sheet shape
   (`{thick, sw, sh, placements, fromRemnant:null}`), re-attaching `polys/bbox` to each
   placement from the piece set.
8. If `winnerRect.w >= 300 && winnerRect.h >= 300` → set `sheet.lastRemnantRect = winnerRect`.
9. **Auto-jump:** set `S.currentSheetIdx = i` so the user lands on the last sheet and sees
   the green rectangle immediately.

### Draw (`_drawSheet`, ~3039 hook)
When the sheet being drawn is the last sheet and has `lastRemnantRect`, draw a green
(`#4ecca3`) dashed rectangle + a small "REMNANT WxH" label, converting the bottom-left mm
rect to canvas via the existing `toCanvas(off.x, off.y + off.h)` corner (y-flip). Drawn in
both `_drawSheet` passes (harmless).

### Save (`_autoSaveRemnants`)
For the sheet carrying `lastRemnantRect`, prefer that stashed rect over a fresh
`_largestOffcut`, apply the **300 mm** min (vs 150 mm for other sheets), and tag the note
`Auto · sheet (last)`. Everything else (grain/material/finish/offX/offY) unchanged.

### Toggle UI
Checkbox `#kdnest-rectleft` next to the Mode dropdown (`~3967`), label "Rect leftover
(last)", bound to `S.rectLeftover`, persisted to `kd_nest_rectleft_v1`, re-runs nothing on
toggle (takes effect on the next ▶ Run). English label (Flux).

## Non-goals / deferred
- Earlier sheets' leftover shape (last sheet only).
- True-shape compaction beyond the existing edge packers (Bottom/Left/BL is enough to
  pick a max rectangle).
- Changing the default Mode (Desktop stays default; this is an additive post-pass).

## Risks (from the code map)
- **Overlap safety:** re-packing goes through `_nestMultiSheet`, which already places
  without overlap — so unlike editing `_consolidateBands`'s accept-test, this approach
  can't introduce overlaps. The original layout is the floor (step 6/7) so the result is
  never worse.
- **MIXED grain:** a last sheet with both H and V parts yields a MIXED remnant that
  `_grainFits` won't reuse for directional parts. Document in the completion note; not a
  bug.
- **Grid coarseness:** `_largestOffcut` rect is ~25 mm-approximate and clamped to bounds;
  the saved remnant is slightly conservative. Fine for stock; don't present as exact.
- **Coordinate space:** the green box must use `toCanvas` (y-flip) or it lands wrong.
- **Re-pack may not fit one sheet:** if the edge packer can't place all pieces on the
  single last-sheet stock (rare — the last sheet is the least-full), that candidate is
  rejected; if all candidates fail, keep the original layout.

## Testing
- Re-pack picks the larger rectangle: on 02 Ruth's real last sheet, confirm
  `_rectifyLastSheet` yields `lastRemnantRect` with both sides larger than the original
  layout's `_largestOffcut`, all pieces still placed, no overlap (placement count
  unchanged).
- Toggle off → no `lastRemnantRect`, original layout untouched.
- Draw: green rect appears on the last sheet (auto-jumped) at the right place
  (preview_inspect / screenshot); not on other sheets.
- Save: synthetic Save path (or RTDB inspect) records the last-sheet rect ≥ 300 mm with
  note "sheet (last)"; <300 mm doesn't save. Self-clean RTDB.
- `node --check`; 0 console errors; live curl markers after deploy.
