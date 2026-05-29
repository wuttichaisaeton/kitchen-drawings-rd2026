# Nesting — "Max Remnant" mode (largest reusable rectangular offcut)

**Date:** 2026-05-30
**Group:** 2 (Web) — `drawings-ui/` · `nest.js`
**Status:** design approved, pre-implementation
**Supersedes:** `2026-05-30-nest-hybrid-gapfill-design.md` (gap-fill is now a
technique inside this mode, not the goal).

## Goal

Add a new nesting mode, **"Max Remnant"**, whose objective is: arrange the
parts however works best so the leftover material forms the **largest possible
single rectangle** — a clean, reusable offcut for future jobs.

User intent (เอ๋, 2026-05-30): "เรียงยังไงก็ได้ ให้เหลือเศษเป็นรูปทรงสี่เหลี่ยม
ขนาดใหญ่ที่สุด." This is the real underlying goal behind the earlier
"clean rectangular leftover" and "tuck the chevrons inside" asks.

## Approach (objective + the techniques that serve it)

The objective is a **selection criterion**: among valid layouts that don't waste
sheets, pick the one whose largest empty rectangle is biggest. Two techniques
feed it:
- **Corner packing** — the existing BL Corner / Left / Bottom packers push parts
  toward an edge/corner, consolidating free space on the opposite side.
- **Gap-fill** — tuck small rotatable parts (chevrons) into interior gaps so they
  don't sit in the would-be offcut and break it up (the technique from the
  superseded hybrid spec, reused here as a candidate generator).

## Decisions (locked during brainstorming)

- **New mode "Max Remnant"** in the mode dropdown. Auto / True Shape / MaxRects /
  BL Corner / Left / Bottom are UNCHANGED (zero regression). Can be promoted to
  the Auto default later if เอ๋ likes it.
- **Scoring order (never waste sheets for a bigger remnant):**
  1. fewest unplaced pieces,
  2. then fewest sheets,
  3. then **largest single empty rectangle (desc)** ← the new objective.
  So Max Remnant never uses more sheets than the rectangle packers would; among
  equally-efficient layouts it picks the biggest offcut.
- **Remnant measured on the TRUE-SHAPE occupancy grid.** The largest empty
  rectangle is computed over a raster grid where every placed part's REAL
  silhouette (+ gap halo) is marked occupied. That yields the biggest rectangle
  of genuinely-clear material you could cut from the leftover (slivers between
  parts are too small to form a large rectangle, so they don't inflate the
  score).
- **Reuse the existing overlap-safe raster primitives** (`_rasterMask`,
  `_blFind`, `_stamp`) for gap-fill and for building the occupancy grid — no new
  collision code.
- **Fill candidate rule (for the gap-fill technique):** `grain === 'ANY'` AND
  bbox area ≤ `HYBRID_FILL_AREA_FRAC` (= 0.08) of the sheet area. Tunable
  constant.

## Architecture & data flow

New function `_nestMultiSheetMaxRemnant(pieces, stock, gap)` in `nest.js`,
dispatched from `_nestMultiSheet` (`~1198`):
`if (mode === 'Max Remnant') return _nestMultiSheetMaxRemnant(pieces, stock, gap);`

```
1. Generate candidate layouts (each is a {sheets, unplaced}):
   - rectangle packers: runOne('MaxRects'|'Bottom'|'BL Corner'|'Left')
     → obtained by calling _nestMultiSheet(pieces, stock, gap, m) per mode.
   - gapFilled(best rectangle candidate): the hybrid relocate pass — for each
     sheet, seed a true-shape occ grid with the big parts, then _blFind+_stamp
     each fill part (grain ANY + small) into the lowest-leftmost interior gap;
     a fill part with no gap keeps its original position. (Never worse: no
     extra sheet, no lost part — same guarantee as the superseded hybrid spec.)

2. Score each candidate:
   - unplacedCount, sheetCount (as today)
   - remnant = max over its sheets of _largestEmptyRect(trueOcc(sheet)).area
   Pick the best by (unplaced asc, sheets asc, remnant desc).

3. Return the winning candidate unchanged in shape ({sheets, unplaced}).
```

### New helper: `_largestEmptyRect(occ, gw, gh)`

Largest all-zero axis-aligned rectangle in a binary grid — the standard
"maximal rectangle in a binary matrix" via per-row histograms + largest-
rectangle-in-histogram (monotonic stack), O(gw·gh). Returns
`{ gx, gy, gw: w, gh: h, area }` (in cells; ×R for mm). `occ` is the true-shape
occupancy grid for one sheet.

### Helper: `trueOcc(sheet, R, gap)`

Build `occ = Uint8Array(gw*gh)`, then for each placement `_stamp` its
`_rasterMask(p, p.rot, R)` at `round(p.x/R), round(p.y/R)` with `dCells` from
gap. (Same primitives + same top-left coordinate space the raster packer and
`_drawSheet` use — verified consistent, so masks land where the parts actually
are. This coordinate alignment is the #1 correctness risk and is covered by the
overlap test below.)

### Gap-fill candidate generator (from the superseded hybrid spec)

`isFill(p) = p.grain === 'ANY' && bboxArea(p) <= HYBRID_FILL_AREA_FRAC*(sw*sh)`.
Per sheet: partition into big / fill; seed occ with big masks; relocate each fill
(largest first) via `_blFind` over its rots into the lowest-leftmost free gap,
`_stamp` it; if none fits, keep its original placement (and stamp it so later
fills see it). Reuses `_rasterMask`/`_blFind`/`_stamp` — overlap-safe by
construction.

**Note A (reusing the rectangle pack):** `runOne` is a closure inside
`_nestMultiSheet`; rather than refactor it out, obtain rectangle candidates by
calling `_nestMultiSheet(pieces, stock, gap, m)` for each rectangle mode. No
refactor of the shared finicky function.

## UI

Add `'Max Remnant'` to the mode `<select>` (list at `~nest.js:1967`:
`['Auto','True Shape','MaxRects','BL Corner','Left','Bottom']` → append
`'Max Remnant'`). No other UI change. `S.mode` flows through `_runNesting` →
`_nestMultiSheet` as today.

## Non-goals / unaffected

- No change to Auto, True Shape, MaxRects, BL Corner, Left, Bottom behavior.
- No change to `_rasterMask` / `_blFind` / `_stamp` / `MaxRectsPacker` /
  `SkylinePacker` / rotation transforms / drawing / DXF export / grain / labels.
- Not the default — `Auto` stays default.
- Does not try to GUARANTEE a specific reserved rectangle (no reserve-and-fit
  search); it MAXIMIZES the empty rectangle over the candidate layouts. (A
  reserve-and-binary-search approach is a possible future enhancement, out of
  scope.)

## Testing / verification

Manual on `localhost:3030` (preview), Nesting workspace, mode = **Max Remnant**,
Run Nesting on a project with chevrons (Bung 01). Assert via `preview_eval`
against `S.flatSheets` (screenshots unreliable):
- **No overlaps (critical, gate to ship):** for every sheet, no two placements'
  true silhouettes overlap (replicate the placement transform per piece, test
  pairwise; reuse Group 1's overlap-verification approach). MUST be 0.
- **Sheet count not worse** than Auto/rectangle for the same parts.
- **No part lost:** placed count == selected count minus genuine unplaced.
- **Remnant improved:** `_largestEmptyRect` area for Max Remnant ≥ the same
  metric for the plain rectangle (Auto) layout on the same parts (it optimizes
  for this, so it should win or tie).
- **Chevrons moved inward:** the small ANY parts sit in interior gaps, not
  stranded at an edge that splits the offcut.
- **Existing modes unchanged:** Auto output identical to a pre-change run
  (no regression).
- Unit-check `_largestEmptyRect` on a tiny hand-built grid (e.g. a 5×5 with a
  known 3×2 hole) returns the expected rectangle.

## Files touched

- `nest.js` — add `_nestMultiSheetMaxRemnant`, `_largestEmptyRect`, the gap-fill
  helper, the `HYBRID_FILL_AREA_FRAC` constant, the `mode === 'Max Remnant'`
  dispatch, and `'Max Remnant'` in the mode `<select>`. Loads directly — no
  build.

## Coordination note

`nest.js` is Group 1's actively-built packing engine; เอ๋ confirmed Group 1's
session is finished, so editing is collision-free now. Implementation is
ADDITIVE (new functions + new mode option + one dispatch line) — no existing
packer is modified. A board entry will flag the new mode for Group 1.
