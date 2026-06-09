# Diff vs Library (web) — design

**Owner:** G2 / WEB 12 · **Date:** 2026-06-09 · **Status:** approved (approach A)
**Mirrors:** G1 `CC_DiffHoles` (Fusion). The "what differs" rules below are the shared
contract — Fusion and Web MUST agree so a diff reported on one side matches the other.

## Goal

When a user is looking at a part drawing in the web app, let them pick a *similar*
part from the Library and **visually flag what differs** between the two — not just
"these two look different" but a categorised, mm-accurate report (holes, size, bends,
cutouts, thickness). Same intent as G1's `CC_DiffHoles`, on the web side.

## Shared "what differs" definition (aligned with G1)

A **HOLE** = a circular interior loop (DXF `CIRCLE` on `INTERIOR_PROFILES`). Two
parts are compared in a **shared bbox-origin frame** (each hole/feature shifted by
its own `bbox.minX/minY` so the two flats overlay regardless of absolute DXF origin).

| Class | Rule |
|---|---|
| hole **removed** | a base hole with no compare hole whose centre is within **T = 0.5 mm** |
| hole **added** | a compare hole with no base hole within T = 0.5 mm |
| hole **resized** | centres match within T but **diameter differs > 0.1 mm** |

These three constants (T = 0.5 mm centre, 0.1 mm dia) are the G1 contract. Do not
diverge without a board `NEEDS:` note to G1.

## Data sources (all client-side, one fetch per part)

`window.KD_DXFFLAT.parseFlatDxf(text)` (in `dxfFlat.js`) returns, from
`Drawings/flat/<code>.dxf`:

- `bbox: {minX,minY,maxX,maxY,w,h}` — from `OUTER_PROFILES` layer → **(1) outer dims**
- `bends: [{a,b,dir('H'|'V'),len,mid}]` — `BEND`-layer LINE entities → **(2) bends**
- `holes: [{type:'circle',c,r} | {type:'rect',pts}]` — `INTERIOR_PROFILES` →
  circles = Level C holes; **rects = cutouts/notches/slots** → **(3) cutouts**
- `outline: {segments|loops}` — stitched outer profile → **(3) outline**
- BOM record `thickness_mm` / `rec.thickness` (NOT in the DXF) → **(4) thickness/material**

Bend **angle** is not present in a flat DXF (these parts are 90°, as G1 assumes), so
bend diff = count + position (`mid`) + length + direction, not angle.

## Architecture (isolation: pure logic ⟂ render ⟂ UI)

1. **`_geomDiff(baseFlat, compFlat, baseRec, compRec)` — pure function**, returns:
   ```
   {
     dims:     { baseW, baseH, compW, compH, dW, dH },          // (1)
     holes:    { added:[], removed:[], resized:[] },            // Level C
     bends:    { added:[], removed:[], baseN, compN },          // (2)
     cutouts:  { added:[], removed:[] },                        // (3) rect holes
     outline:  { changed: bool },                               // (3) outer profile
     material: { baseTh, compTh, sameTh }                       // (4) text only
   }
   ```
   No DOM, no canvas — unit-testable with node. Matching uses the bbox-origin frame
   + tolerance T (holes/cutouts/bends matched by centre/mid within T).
2. **`_renderGeomDiff(diff, baseFlat, compFlat, containerEl)`** — draws the compare
   flat (outline + holes) and overlays: green = added, red = removed (with an X),
   amber = resized; boxes the differing cutouts/bends. Reuses GA's canvas-fit math.
3. **Text summary panel** beside the canvas — one line per non-empty category, e.g.
   `W +50mm · H same · 1 bend added · 2 holes removed · 1 hole resized · thickness same (1.0mm)`.
4. **Modal**: extend GA's `_openSimilarCompareModal(baseCode, fam)` (in
   `diff-tools.js`). Existing tabs: Side-by-Side PDF · Visual PDF Diff · DXF Hole
   Diff. Add one tab **"Geometry Diff"** that runs `_geomDiff` → `_renderGeomDiff` +
   the summary panel. Candidate picker stays family + `-WWWHHH` suffix.

## Ship order (incremental, commit each; B first per RD)

1. **B — adopt + wire GA's foundation.** Commit `diff-tools.js` (Level B pixel-diff +
   Level C hole-diff + modal) and the `index.html` script wiring (verify it loads
   pdf.js + KD_DXFFLAT + diff-tools.js cleanly, modal opens, tabs switch). Credit GA.
2. **C — refine Level C** to the full G1 def: add the **resized** class (dia > 0.1 mm,
   amber). Keep added/removed.
3. **(1) outer dims** — `_geomDiff.dims` + summary line + bbox delta.
4. **(2) bends** — set-diff `bends` by `mid` (within T) + highlight added/removed bend
   lines on the canvas.
5. **(3) cutouts + outline** — diff `rect` holes (notches/slots) + flag outer-outline
   change; box the differing regions.
6. **(4) thickness/material** — BOM text note (not a located feature → text only).

Each step: edit → verify live (load `02 Ruth` or a part with a `-WWWHHH` twin, open
the modal, read the rendered DOM/canvas + console) → commit explicit-path → board ping.

## Verification

- `_geomDiff` is pure → node test with synthetic flats (known added/removed/resized)
  asserting the returned counts, like the family-colour logic test.
- Live: open the Compare modal on a real twin pair (e.g. an L/R `-WWWHHH` match such
  as the SDLCN2/SDRCN2 pair G1 used — L→R = 10 holes removed) and confirm the web diff
  reports the **same** counts G1's CC_DiffHoles reported (Fusion+Web agreement check).
- 0 console errors; PDF tab + Geometry tab both render.

## Out of scope (YAGNI)

- Bend **angle** diff (not in flat DXF; parts are 90°).
- Sub-pixel PDF registration/alignment for Level B (GA's grayscale-threshold overlay
  is the agreed crude-but-useful first pass; geometry diff is the accurate path).
- 3-way / multi-part diff — one base vs one compare only.
- Persisting diff results to RTDB.

## Coordination notes

- `diff-tools.js` + the `index.html` edit are GA's untracked WIP in the shared tree.
  RD ruled G2 owns Diff B/C and GA stood down, so G2 commits them (crediting GA).
- Shared-tree hygiene: commit explicit paths only; never `git add -A`.
