# SIM.BENDING — Press-Brake Bending Simulator (full spec)

> Self-contained spec for the per-part press-brake bending animation inside the
> **Kitchen by Rough Design** web app (`drawings-ui`). Written so another engineer
> (human or AI) can reproduce or re-implement it from scratch. 2026-06-04.

---

## 1. What it is

For each sheet-metal part, SIM.BENDING shows whether the part can be bent on a
press brake and animates the bending sequence. A **box / pan** part (e.g. `test v2`,
a 300×200 tray, 8 bends) is shown in **two synchronized columns**:

| Column | What it shows | Purpose |
|--------|---------------|---------|
| **2D PRESS** (left) | A cross-section of the punch + die + sheet, zoomed in on the **active bend**. Punch descends, touches the sheet, the sheet tips up into a **V** at the die. Already-formed bends stay bent (cumulative chain). | See whether a fold **collides** with the tool ("พับแล้วติดหรือไม่"). |
| **3D ISOMETRIC** (right) | The real flat pattern folding up into the box, one bend per step, with the real tool (Kyokko #202 sash or gooseneck #453) descending. The **whole piece tips up** around the active bend line at the die (press-brake V), then settles. | See the part take shape in 3D with the correct tooling. |

Both columns **march through the same bend at the same instant** ("จุดที่พับต้องตรงกัน").

---

## 2. Files

| File | Role |
|------|------|
| `drawings-ui/simbend-sim.js` | **2D PRESS** engine. `window.kdSimBend.mount(canvas, record, code)`. Generic linear press-brake station: die fixed at bottom, punch (real DXF silhouette) descends into the V, the part re-anchors so the active bend sits over the die. This is the **reference** sim เอ๋ pointed to (matches her `ScreenRecording` clip). |
| `drawings-ui/simbend-3d.js` | **3D ISOMETRIC** engine. `window.kdSimBend3D.mount(canvas, record, code)` + `mount2d` (an alternate 2D, **currently unused**). Also exports the shared tool profiles `SASH_PROF`, `GOOSE_PROF`. |
| `drawings-ui/tool-art.js` | DXF-lifted punch silhouettes (`window.KD_TOOLART.profileFor(pObj)`), `PROFILES[series]`. |
| `drawings-ui/app.js` | Mounts both columns for `record.kind === 'box'`; tooling catalog `KYOKKO_CATALOG_SERIES`; per-step Punch/Die dropdowns; `onOverrideChange`. |
| `drawings-ui/style.css` | `.sb-sim-cols`, `.sb-sim-col`, `.sb-card-wide` (full-grid span for side-by-side), `.sb-sim-canvas-2d`. |

No bundler — edit + push to `main`; GitHub Pages deploys in ~1 min. (The React-Flow
editor is the only thing that needs `npm run build:editor`; these sim files don't.)

---

## 3. Data model (the `record` passed to both mounts)

```js
record = {
  kind: 'box',                 // box → mount both columns
  bendable: true,
  order: ['B1','B4','B5','B8','B2','B3','B6','B7'],   // bend sequence (step order)
  per_bend: [
    { bend:'B1', step:1, angle_deg:90, flange_mm:7,  punch:'AUTO'|'P-KYOKKO-202-R02'|'GN...', die:'AUTO'|..., flat_len:6.13, ... },
    ...
  ],
  box_geom: {
    base: { w, h }, thickness,
    flat_w, flat_h,            // developed blank: 343.05 × 243.05 for test v2
    walls: [
      { id:'B5', axis:'V'|'H', side:'+'|'-', height, width, offset, step,
        flat_len, needs_gooseneck:true|false, ... }
    ],
    flat_pattern: {
      outline:    [[x,y], ...],            // developed outline WITH 45° mitred corners
      bend_lines: [[[x,y],[x,y]], ...]     // Layer "BEND" segments = fold positions
    }
  }
}
```

Key real numbers for `test v2` (verified against live RTDB `bend_sim/test v2`):
- Flat blank **343.05 (X) × 243.05 (Y)** — deliberately different so you can see which side bends.
- Wall developed length **16.26**, lip **6.13**; base inner ≈ **298.27 × 198.27**.
- 8 bends, order `B1→B4→B5→B8→B2→B3→B6→B7`; flange_mm pattern 7,7,18,18,7,7,18,18
  (7 = lip, 18 = wall — note these are **mould** heights; the developed `flat_len` is 6.13 / 16.26).

---

## 4. The five requirements (เอ๋'s spec) and how each is met

### R1 — Punch length = the **internal length** of the section being folded
The 3D tool is extruded to `eHalf` = **half the base inner rectangle**:
`fpHalfW = (bx1-bx0)/2`, `fpHalfH = (by1-by0)/2` (the rect between the two
perpendicular bend lines). A V-axis (X-side) wall uses `fpHalfH`; an H-axis (Y-side)
wall uses `fpHalfW`. So the tool spans the actual bend-line (the inner fold edge),
not the full blank. HUD shows `TOOL <2*eHalf> MM`.

### R2 — The 2D punch must be the **same tool** as the ISO
`simbend-3d.js` exports `SASH_PROF` (#202) and `GOOSE_PROF` (#453, concave throat)
on `window.kdSimBend3D`. In `simbend-sim.js`:
- `model.useGoose` is computed the **same way as the 3D**: `box_geom.walls.some(w => w.needs_gooseneck || w.punch === 'gooseneck')`.
- `resolvePunch` default when AUTO: `useGoose ? 'GN-453-AUTO' : 'P-KYOKKO-202-R02'`.
- If no DXF silhouette is found for the pick, it falls back to the **shared** `GOOSE_PROF`/`SASH_PROF`.
Result: for a pan that needs a gooseneck, **both** columns draw the identical #453 silhouette.

### R3 — 2D zoomed to inspect collision (not too far out)
`simbend-sim.js frame()`:
```js
var maxF  = Math.min(maxFlange, 55);
var scale = Math.max(0.6, Math.min(6*dpr, (h*0.195)/Math.max(maxF, 36)));
var dieCx = w/2, dieCy = h*0.72;
```
Tight enough to read the V + collision, loose enough to show the whole punch body.
`maxFlange = max(segLen)` is clamped so a long base segment can't shrink everything;
the far ends of the strip just run off-frame.

### R4 — ISO motion like the 2D + the active bend in sync
The 2D press cadence is the reference (`simbend-sim.js`):
`MOVE 450 (descend) + FOLD 900 (fold) + HOLD 350` = **1700 ms / step**, no start
offset, `END_HOLD 800`. The 3D was **retimed to match exactly** (`simbend-3d.js`):
```js
var START = 0, MOVE = 1350, HOLD = 350, END = 800;   // MOVE = 450 descend + 900 fold
var TOUCH = 0.333;   // = 450/1350: punch finishes descending, THEN folds
```
Both engines are `requestAnimationFrame` loops using `t = (ts - startTs) % totalT`.
With identical `totalT` and per-step boundaries, and both mounted in the same tick,
they show the **same step/bend at the same instant** (verified: both HUDs read
`STEP 4/8 · B8`, then `STEP 2/8 · B4`).
The motion shape (unchanged, approved by เอ๋): **punch descends and touches FIRST,
then the sheet tips into a V**. In 3D the whole piece tips around the active bend
line at the die (`vlift`, `bump = sin(gfold·π)·30°`), base + walls rising together.

### R5 — 2D lengths/positions correct
`simbend-sim.js buildModel` used `flange: Math.max(18, flange_mm)` — the **18 mm
floor flattened the lip (~6) and the wall (~16) to the same length**, so the chain
read wrong. Fixed to:
```js
flange: Math.max(4, (b.flat_len != null ? b.flat_len : (b.flange_mm != null ? b.flange_mm : 35)))
```
Now lip vs wall segments are distinct and the bend positions follow.

---

## 5. How the engines work (algorithms)

### 2D PRESS (`simbend-sim.js`)
1. `buildModel(record)` → `spatial[]` (per bend: angle, flange/flat_len, punch type,
   collides), `segLen[]` (chain segment lengths), `order[]`, `useGoose`.
2. `buildTimeline` → `phases[]` with `tMove / t0 / tFold / tEnd` per step.
3. `stateAt(t)` → which bend is active, its fold angle (bends formed in earlier phases
   **stay** at their target = cumulative chain), `descend` 0→1.
4. `vertices(model, a)` → chain points in mm (flat baseline, each bend rotates the
   running direction by its current angle).
5. `anchor(pts, st)` → rotate so the active bend's bisector points up (+y to the
   punch) and the vertex sits at the die; symmetric V, **no wobble**.
6. `frame(t)` → draw die (`DIE_PROF`), the orange sheet polyline, and the punch
   (`drawPunch` with the real `profile` if present, else a parametric fallback).

### 3D ISOMETRIC (`simbend-3d.js`, `FLAT` path)
1. Read `box_geom.flat_pattern`. Partition the developed outline by the BEND lines
   into base + 4 walls + 4 lips using **Sutherland–Hodgman** rectangle clipping (`clipRect`).
2. Each flap = `[name, axis(V/H), foldLine, side, step, rect, wallLine]`. Lips ride
   their wall (fold about the lip line, then about the wall line).
3. `frac(step,t)` ramps 0→1 over `MOVE`; `gfold` gates the fold to **after TOUCH**;
   `gpunchZ` descends the punch over the first `TOUCH` then rides the sheet.
4. Press-V: `vlift` rotates base + all flaps about the active bend line by
   `bump = sin(min(1,gfold)·π)·30°` — the whole piece tips at the die, then settles.
5. Tooling: `addExtrusion(die, DIE_PROF)`, `addExtrusion(punch, punchForStep(active).prof, …, eHalf, goose?±1:1)`.
   Straight extrusion so the concave gooseneck end-caps show.
6. Isometric projection: `iso(p) = {x:(p.x−p.y)·cosθ, y:p.z−(p.x+p.y)·sinθ}`, θ=26°,
   painter's-algorithm depth sort `depth = x+y+z·1.5`. **+z is UP.**

### Tool profiles (tip-at-origin, +y up, mm; scaled by `TOOL_SCALE = 0.5`)
- `SASH_PROF` — Kyokko #202 (16 pts).
- `GOOSE_PROF` — gooseneck #453 (34 pts, concave throat / hook).
- `DIE_PROF` — V die.
- Throat (concave) of the gooseneck faces the **rising flange** of the workpiece
  (`uSign = side==='+' ? -1 : 1` in ISO). Lift from clean DXF — **don't guess shapes**.

### Per-step punch override (`punchForStep(step)`, both engines)
Reads `record.per_bend[].punch`; maps `202/SASH→#202`, `453/GN/GOOSE→#453`,
`109→#109`; AUTO → `USE_GOOSE ? gooseneck : sash`. So changing a row's **Punch
dropdown updates the drawn tool** in both 2D and 3D for that step.

---

## 6. App wiring (`app.js`)

- `record.kind === 'box'` → render a `.sb-card-wide` card with two `.sb-sim-col`s:
  `_simController2D = window.kdSimBend.mount(canvas2d, rec, expanded)` (2D),
  `_simController = window.kdSimBend3D.mount(canvas3d, rec, expanded)` (3D).
- **Guard in `onOverrideChange`**: `if (rec.kind !== 'box') rec.kind = rec.bendable ? 'found' : 'impossible';`
  — without this, changing a tool dropdown clobbered `kind` and the 3D fell back to 2D.
- Both controllers re-mount on any per-step override so the sim follows the dropdowns.

---

## 7. Constraints / gotchas (hard-won)

- **+z is UP** in the iso projection (`y: p.z − (p.x+p.y)·sinθ`); getting the sign
  wrong droops the walls and puts the die on top.
- **Don't guess tool shapes** — lift real outlines from clean DXF (Layer "Visible" +
  DIMENSION). Messy multi-sketch DXF dumps are unparseable.
- **No Thai in rendered UI text** (Flux Architect web font can't render it). HUD,
  buttons, labels = English only. (Source-code comments may be Thai.)
- The user **imports tools herself** — never delete an imported tool; AUTO-added
  tools may be removed.
- The two animation loops set their own `startTs`; they stay in sync only because
  `totalT` and per-step boundaries are identical and they mount in the same tick. If
  you change one engine's timing, change the other to match.
- Fusion `.f3d`/`.f2d` saves are the user's job; web-side git commits are fine.

---

## 8. Open / unconfirmed

- **R1 numbers**: the spec image shows internal **186 × 286** (wall 7); the file's
  real base is **298 × 198**. The code uses the real base inner edge. If 186/286 is
  intended, confirm where it's measured (top opening vs base floor).
- **2D throat direction** per wall (most-thrashed item historically): concave side
  should face the already-folded/rising flange. Re-verify if a side looks wrong.

---

## 9. Live state

Deployed on GitHub Pages: `https://wuttichaisaeton.github.io/kitchen-drawings-rd2026/`
Latest relevant commits: `e12e68b` (2D punch=ISO + real lengths + zoom),
`a46ea81` (ISO timeline synced to 2D). All five requirements live & verified in preview.
