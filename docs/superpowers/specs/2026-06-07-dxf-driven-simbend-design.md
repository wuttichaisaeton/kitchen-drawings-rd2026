# Sim.Bending — render from the flat-pattern DXF (not box_geom)

**Date:** 2026-06-07
**Area:** `drawings-ui` — `simbend-3d-ai.js` (sim engine), `app.js` (Sim.Bending tab + Library upload), new `dxfFlat.js` (DXF parser)
**Requested by:** เอ๋ — real part `CVIL00-205093` renders wrong in both the 2D press and the 3D iso.
**Status:** Design approved (brainstorm) — ready for implementation plan.

## 1. Problem

The Sim.Bending views are built entirely from `box_geom` (base + walls with axis/side/height/width/offset), which Fusion's CheckBend derives. For complex real parts this derivation is wrong:

- **`CVIL00-205093`** is a long channel (base 2048 × 21.76): two full-length side flanges + top/bottom flanges + **7 small ~23 mm tabs** at 300 mm spacing + many holes + left/right end-tabs.
- Its `box_geom` had **wrong tab widths (7.76 vs real ~23 mm)**, only **5 tabs not 7**, and dropped the top/bottom/hem flanges.
- The sim renders `box_geom`, and `buildSide` further assumes **every wall spans the full part width** — so a 7.76 mm tab is drawn as a 2048 mm wall. Both the 2D press (X-axis steps) and the 3D iso come out wrong.

The part's **flat-pattern DXF is the ground truth.** `CVIL00-205093 v4.dxf` carries everything on clean layers: `OUTER_PROFILES` (outline as LINE/SPLINE), `INTERIOR_PROFILES` (holes as LWPOLYLINE/CIRCLE), `BEND` (bend centre lines), `BEND_EXTENT` (bend region edges).

**Decision (เอ๋):** render the sim **directly from the flat DXF** (accurate for any part) rather than patching `box_geom` or fixing Fusion CheckBend.

## 2. Scope

- **In scope:** parse a part's flat-pattern DXF → an accurate folded model → both the **2D press** and **3D iso** views, driven by the DXF geometry; a **Library upload** path for the flat DXF (like the existing manual-PDF upload); a **hybrid** merge that takes fold **angle + direction** from the existing `per_bend`/`walls` RTDB data; a **fallback** to the current `box_geom` sim when a part has no flat DXF.
- **Out of scope:** changing Fusion CheckBend or the `box_geom` it writes (we leave it as the fallback source); auto-export of the DXF from Fusion (manual upload only); tonnage/force limits; re-deriving bend **order** (reuse `per_bend[].step`).

## 3. Current state (what exists, reused)

- **Library upload (PDF):** `app.js` drag-drop commits a file to the `kitchen-drawings-rd2026` repo via the GitHub Contents API using a one-time admin PAT in `localStorage[kd_github_pat_v1]` (PDF lands at `Drawings/manual/<code>.pdf`, served by Pages ~1 min later). The flat-DXF upload reuses this exact path, target `Drawings/flat/<code>.dxf`.
- **Sim mount:** `app.js` `_remountSimBend()` (~5912) mounts `window.kdSimBend3D.mount` (3D) + `.mount2d` (2D) for box parts from `rec` (the `bend_sim/<code>` record incl `box_geom` + `per_bend`).
- **Punch/die/collision (reuse as-is):** `punchForStep` (per-bend tool, fixed 2026-06-07), `sameSideClearMm`, `clearEnvelope`, the gooseneck clearance envelope draw, the collision-freeze, the Full-Screen button. These consume per-bend tool/clearance data, not the wall geometry, so they carry over to the DXF-driven views unchanged.
- **DXF parsing precedent:** the tool profiles were lifted from clean DXFs; the same group-code parsing (10/20/30 = x/y/z, layer = code 8, entity type = code 0) applies.

## 4. Design

### 4.1 `dxfFlat.js` — `parseFlatDxf(text) → flatModel` (new, pure)

Group-code DXF parser, no deps. Walks the `ENTITIES` section, buckets by layer (code 8):

- **OUTER_PROFILES** → the outer boundary. LINE (10/20→11/21), SPLINE (sample the fit/control points 10/20), ARC (tessellate). Stitch endpoints into one closed loop (snap-round 0.01, walk adjacency — same recipe as the tool-profile trace). → `outline: [[x,y]…]`.
- **INTERIOR_PROFILES** → `holes: [{type:'rect'|'circle', …}]` (LWPOLYLINE vertices code 10/20; CIRCLE centre 10/20 + radius 40). Used for drawing only.
- **BEND** → `bends: [{a:[x,y], b:[x,y], mid, dir:'H'|'V', len}]` — each bend centre line. (BEND_EXTENT is ignored for v1; bend allowance handled by the centre line.)
- Returns `{ outline, holes, bends, bbox }`.

**Robustness:** unknown entities skipped; a malformed/empty DXF returns `null` → caller falls back to `box_geom`. Memoise per code.

### 4.2 `mergeBends(flatModel, per_bend, walls) → bends[]` with fold params

The flat DXF has bend **positions** but not **angle/direction**. Take those from the existing RTDB data:

- For each DXF bend line, find the matching `per_bend`/`walls` entry by **axis** (`dir:'V'`↔a wall folding across X, `dir:'H'`↔across Y) **and position** (nearest by the bend's offset from the part centre vs `wall.offset`/the bend-line coordinate). Assign `angle_deg`, `side` (+/- → fold up/down which way), `step`, `id`.
- Bends with no confident match default to `angle 90°`, `side` = the dominant side, `step` = a trailing order. Log unmatched count (no silent drop).
- This keeps fold params from the source Fusion already writes; the DXF only fixes geometry.

### 4.3 Fold engine — `foldFlat(flatModel, bends, t) → panels3D` (the hard unit)

1. **Partition** the flat outline into rigid **panels** separated by the bend lines: extend each bend line across the part, cut the outline into regions. Bends are axis-aligned (H/V) here, so partition is a rectilinear split; tabs become small panels hanging off an edge via a short bend line.
2. **Fold tree:** pick the **base panel** (largest area, or the panel touching the most bends). BFS outward: each panel's parent = the panel across its first bend line; the bend line is the hinge.
3. **Fold:** rotate each panel (and all its descendants) about its parent hinge by `angle_deg × progress`, in `side` direction. `progress` per panel = its bend's `step` vs the global animation time `t` (reuse the existing step/`frac` timing + collision-freeze).
4. Returns 3D polygons per panel (+ which bend is active at `t`). The **2D press** for the active bend = the cross-section perpendicular to that bend line, taken **at the bend's own location** (so only the features actually there appear — tabs no longer span the whole part).

**v1 simplification:** if partition fails (non-rectilinear / overlapping bends), fall back to `box_geom` for that part and surface a one-line note. Don't half-render.

### 4.4 Render

- **3D iso:** extend/parallel the existing `mount` — draw the folded `panels3D` (fills + edges) + holes, animate by step, same camera/controls. Punch drawn per active bend (existing `punchForStep`).
- **2D press:** the active bend's true cross-section + the existing punch/die/clearance-envelope/collision/Full-Screen machinery (unchanged consumers).
- **Branch:** `_remountSimBend` checks for a flat DXF (fetched on open). DXF present → DXF-driven mount; absent → current `box_geom` mount. One code path switches; the box_geom engine is untouched.

### 4.5 Library upload of the flat DXF

Extend the Library drag-drop: accept `.dxf`, commit to `Drawings/flat/<code>.dxf` via the existing PAT/Contents-API helper. On Sim.Bending open, fetch `https://<pages>/Drawings/flat/<code>.dxf`; 404 → no DXF → fallback.

## 5. Components & isolation

| Unit | Purpose | Interface | Tested |
|------|---------|-----------|--------|
| `parseFlatDxf` (dxfFlat.js) | DXF text → flatModel | `(text) → {outline,holes,bends,bbox}\|null` (pure) | node, real CVIL00 v4.dxf |
| `mergeBends` | add angle/dir/step to bends | `(flat, per_bend, walls) → bends[]` (pure) | node |
| `foldFlat` | flat → folded 3D panels at time t | `(flat, bends, t) → {panels, active}` (pure) | node, L-bracket |
| 3D render | draw folded panels | mount(canvas, model, …) | live |
| 2D press render | cross-section at active bend | mount2d(canvas, model, …) | live |
| app.js upload + fetch + branch | deliver DXF, choose engine | DOM + fetch | live |

## 6. Testing

- **Node (pure):** `parseFlatDxf(CVIL00 v4.dxf)` → bbox ≈ 2076×976, holes>0, bends include the 2 long verticals + the 7×23 mm tabs. `mergeBends` → every bend gets an angle+side. `foldFlat` on a hand-made L-bracket → folded coords match a 90° fold.
- **Live (preview):** upload `CVIL00-205093` flat DXF → its 3D folds correctly (tabs at their real positions/widths, full-length side walls), 2D press shows the true per-bend cross-section, collision/envelope/full-screen still work. A part with **no** flat DXF still renders via `box_geom` (no regression — calibration boxes unchanged).

## 7. Files touched

- `drawings-ui/dxfFlat.js` — **new** (`parseFlatDxf`, `mergeBends`, `foldFlat`).
- `drawings-ui/simbend-3d-ai.js` — DXF-driven `mount`/`mount2d` paths (reuse punch/die/collision/envelope/freeze/full-screen).
- `drawings-ui/app.js` — Library `.dxf` upload, fetch-on-open, box_geom↔DXF branch in `_remountSimBend`.
- `drawings-ui/index.html` — load `dxfFlat.js` (cache-busted like the others).
- No Fusion changes; no bundling.

## 8. Open questions (resolve in the plan)

- Exact panel-partition algorithm for the rectilinear case + the tab edge-panels (the riskiest unit — prototype on CVIL00 first).
- Bend↔per_bend matching tolerance, and the fallback when a bend is unmatched.
- Whether the 2D press shows ONE cross-section per active bend or a representative one when the bend has features at multiple positions.
