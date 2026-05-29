# Nesting — Hybrid gap-fill mode

**Date:** 2026-05-30
**Group:** 2 (Web) — `drawings-ui/` · `nest.js`
**Status:** design approved, pre-implementation

## Goal

Add a new nesting mode, **"Hybrid"**, that keeps the big parts rectangle-packed
(so the leftover stays a clean reusable rectangle — เอ๋'s 2026-05-30 ask) AND
tucks small rotatable parts (e.g. the BXXTR0 chevrons) into the interior gaps
between the big parts instead of leaving them stranded at a sheet edge by their
bounding box.

User intent (เอ๋, 2026-05-30, pointing at chevrons stranded at the top-right of
a sheet): "Rotate แล้วเอาเข้ามาข้างในได้" — these small parts can rotate and
move into the empty interior.

## Background (why this is needed)

Auto runs the rectangle packers (MaxRects/Bottom/BL/Left) then true-shape last,
and true-shape only "wins" when it strictly saves a whole sheet
(`nest.js:1287-1294`). When everything already fits on one sheet, the rectangle
layout wins — and rectangle packing places each part by its **bounding box**, so
a chevron's big bbox lands at the edge with wasted interior gaps. True-shape mode
*would* tuck them in but abandons the clean rectangular leftover. Hybrid gets
both.

## Decisions (locked during brainstorming)

- **Approach B — Hybrid gap-fill**, as a **NEW mode "Hybrid"** in the mode
  dropdown. Auto / True Shape / MaxRects / BL Corner / Left / Bottom are
  UNCHANGED (zero regression to existing modes; can be promoted to the Auto
  default later if เอ๋ likes it).
- **Safe framing — start from the rectangle layout, then relocate only.** The
  base layout is the existing best rectangle pack of ALL parts (same as Auto's
  rectangle result). Hybrid then *relocates* small fill parts into interior gaps
  where one exists; a fill part with no gap **keeps its original position**.
  Consequence: Hybrid can NEVER be worse than the rectangle layout — same sheet
  count, no part ever lost; it only moves small parts into gaps.
- **Reuse the existing overlap-safe raster primitives** — `_rasterMask`,
  `_blFind`, `_stamp` — so NO new collision code is written (the raster packer's
  finicky overlap logic is reused as-is, not reinvented).
- **Fill candidate rule:** a part is a "fill" (gap-tuck) candidate iff
  `grain === 'ANY'` (free to rotate) AND its bbox area ≤ `HYBRID_FILL_AREA_FRAC`
  (= 0.08) of the sheet area. Everything else is a "big" part and stays
  rectangle-packed. The fraction is a tunable module constant.

## Architecture & data flow

New function `_nestMultiSheetHybrid(pieces, stock, gap)` in `nest.js`, dispatched
from `_nestMultiSheet` (`~1198`): `if (mode === 'Hybrid') return _nestMultiSheetHybrid(pieces, stock, gap);`

```
1. base = best rectangle pack of ALL pieces.
   Run runOne for each rectangle mode ['MaxRects','Bottom','BL Corner','Left']
   (the same set Auto uses, MINUS true-shape) and pick the result with fewest
   unplaced then fewest sheets. (Reuse: call the rectangle path — see Note A.)

2. isFill(piece) = piece.grain === 'ANY'
      && bboxArea(piece) <= HYBRID_FILL_AREA_FRAC * (sheet.sw * sheet.sh)

3. For each sheet in base.sheets:
   - R = max(5, round(min(sw,sh)/200)); dCells = gap>0 ? max(1, round(gap/R)) : 0
     (identical to _nestMultiSheetRaster's resolution).
   - gw = ceil(sw/R), gh = ceil(sh/R); occ = new Uint8Array(gw*gh).
   - Partition this sheet's placements into bigP (NOT isFill) and fillP (isFill).
   - SEED: for each p in bigP, _stamp(occ, gw, gh, maskOf(p, p.rot),
       round(p.x/R), round(p.y/R), dCells).  // mark big silhouettes + halos
   - RELOCATE fill parts (largest fill first, for stability):
       for each f in fillP sorted by bbox area desc:
         best = null
         for rot in f.rots:  // f keeps its grain rots; ANY = [0,90,180,270]
           pos = _blFind(occ, gw, gh, maskOf(f, rot))
           if pos && (best===null || pos.gy<best.gy || (pos.gy===best.gy && pos.gx<best.gx)):
             best = { rot, mask, gx, gy }
         if best:  _stamp(occ,...,best); newPlacement = {...f, x:best.gx*R, y:best.gy*R, rot:best.rot}
         else:     _stamp(occ, maskOf(f, f.rot) at round(f.x/R),round(f.y/R)); keep f's original {x,y,rot}
   - sheet.placements = bigP ++ (relocated/kept fillP)

4. base.unplaced is returned unchanged (rectangle pack already minimised it;
   Hybrid never removes a placed part).
```

`maskOf(p, rot)` = a mask cache wrapping `_rasterMask(p, rot, R)` keyed by
`code|rot|WxH` (same caching pattern as `_nestMultiSheetRaster.getMask`). The
placements carry `polys`/`bbox`/`w`/`h` (they are `{...piece, x, y, rot}`), so
`_rasterMask` has everything it needs.

**Note A (reusing the rectangle pack):** the rectangle packer lives in `runOne`,
a closure inside `_nestMultiSheet`. Rather than refactor it out (risk to the
finicky shared function), `_nestMultiSheetHybrid` obtains the base by calling
`_nestMultiSheet(pieces, stock, gap, m)` for each m in the four rectangle modes
and picking the best (fewest unplaced, then fewest sheets). This reuses the exact
existing rectangle logic with no refactor.

**Why overlap-safe:** seeding stamps the big parts' true silhouettes (+ gap halo)
into `occ`; `_blFind` only returns a position where the fill mask hits NO occupied
cell; `_stamp` then marks it. This is the identical occupancy contract the raster
packer already relies on. A relocated fill part cannot overlap a big part or an
earlier-relocated fill part. A kept (no-gap) fill part stays exactly where the
rectangle packer (already overlap-free) put it.

## UI

Add `'Hybrid'` to the mode `<select>` (the list at `~nest.js:1967`:
`['Auto','True Shape','MaxRects','BL Corner','Left','Bottom']` → add `'Hybrid'`).
No other UI change. `S.mode` flows into `_runNesting` → `_nestMultiSheet` as today.

## Non-goals / unaffected

- No change to Auto, True Shape, MaxRects, BL Corner, Left, Bottom behavior.
- No change to `_rasterMask` / `_blFind` / `_stamp` / `MaxRectsPacker` /
  `SkylinePacker` (reused as-is).
- No change to rotation transforms, drawing, DXF export, grain rules, labels.
- Not made the default — `Auto` stays the default mode.
- Multi-sheet, thickness grouping, remnant stock — unchanged (Hybrid operates
  within `_nestMultiSheet`, which is already called per thickness group).

## Testing / verification

Manual on `localhost:3030` (preview), in the Nesting workspace for a project
with chevrons (e.g. Bung 01), mode = **Hybrid**, Run Nesting:
- **No overlaps** — the critical check. For every sheet, assert no two
  placements' true silhouettes overlap (reuse / mirror the verification Group 1
  used: replicate the placement transform per piece and test pairwise polygon /
  raster overlap = 0). This MUST pass before shipping.
- Sheet count == the Auto/rectangle sheet count for the same parts (Hybrid never
  adds a sheet).
- No part lost — placement count == selected piece count (minus any genuinely
  unplaced that rectangle also couldn't place).
- The small ANY chevrons (BXXTR0 etc.) now sit in interior gaps (lower `y` /
  more central) rather than stranded at the top edge; big parts unchanged.
- Auto mode output is byte-identical to before (no regression) — run Auto, diff
  placements vs a pre-change run.
- Assert via `preview_eval` against `S.flatSheets` (read placements) — screenshots
  unreliable here.

## Files touched

- `nest.js` — add `_nestMultiSheetHybrid`, the `mode === 'Hybrid'` dispatch in
  `_nestMultiSheet`, the `HYBRID_FILL_AREA_FRAC` constant, and `'Hybrid'` in the
  mode `<select>`. Loads directly — no build.

## Coordination note

`nest.js` is Group 1's actively-built packing engine; เอ๋ confirmed Group 1's
session is finished, so editing is now collision-free. Implementation is
ADDITIVE (new function + new mode option + one dispatch line) — it does not
modify any existing packer, minimising risk to their work. A board entry will
flag the new mode for Group 1.
