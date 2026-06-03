# Box-bending collision support for CC_CheckBend + Sim.Bending

**Date:** 2026-06-03
**Owners:** Group 1 (Fusion / CC_CheckBend) + Group 2 (Web / Sim.Bending)
**Status:** Design approved (brainstorm), ready for implementation plan.

## 1. Goal

CC_CheckBend currently models **linear (single bend-axis) parts** — channels, trays
bent on one axis, panel+lip. It already exports per-bend feasibility, `max_flange`
(punch collision limit), `flat_length`, and mould-line `legs`.

A **pan / box** bends on **two perpendicular axes** (4 walls around a base). For
these parts the linear model breaks: `legs[]` is meaningless (a pan unfolds to a
2-D cross, not a leg sequence) and the real difficulty — the punch and the
moving wall colliding with **already-formed perpendicular walls** — is not
modelled at all.

เอ๋ wants, for a pan:
1. **Feasibility + bend order + which walls need a gooseneck** (a box-aware
   checker), and
2. **A 3-D isometric sim** that folds the pan wall-by-wall and highlights
   collisions.
Gooseneck selection is **automatic** (escalate from standard when needed) with a
**per-bend override** dropdown (already present in the web).

## 2. Scope

- **In scope:** rectangular pans (axis-aligned base + up to 4 walls, each wall
  optionally with a return lip); an irregular-box fallback; the box `bend_sim`
  contract; the web 3-D fold sim.
- **Out of scope / non-goals:** non-rectangular / freeform multi-axis parts beyond
  the irregular fallback's best-effort; corner-relief geometry generation; true
  FEA; changing the **linear** path (max_flange / mould legs stay exactly as
  shipped — boxes are a new branch, linear parts are untouched).

## 3. Approach (Hybrid)

Chosen approach **C (Hybrid)**:
- **Rectangular pan → analytic `box_model`** (pure, calibratable like max_flange):
  fast, low-risk, covers ~all kitchen pans.
- **Irregular box → full-3-D formed-aware fallback:** reuse `collision_core` /
  `fold` / `bend_graph` with a new formed-aware oracle + per-bend punch
  reorientation, driven by `sequence_search`.
- **Linear (1 axis) → unchanged** existing path.

## 4. Architecture / data flow

```
extract_bends
   │
   ▼
box_detect ──1 axis──────────────► linear path (unchanged: max_flange + mould legs)
   │
   ├─ rectangular box ──► box_model (analytic) ──┐
   │                                             ├─► per-bend {step, axis, punch,
   └─ irregular box ───► formed-3D fallback ─────┘     needs_gooseneck, collides_with}
                          (sequence_search +                 + order + box_geom
                           formed-aware oracle)                     │
                                                                    ▼
                                              web_push.build_record (box fields,
                                                 legs=null, box_geom) → push
                                                                    │
                                                                    ▼
                                              web simbend-3d.js (3-D isometric fold)
```

## 5. Box-bending model (`box_model`, analytic core)

**Geometry (from the folded body):** base = the largest planar face (W×L),
thickness T. Each wall: `{axis: X|Y, side, height h, width (base-edge length),
inside_radius, angle, lip?}`. A wall's optional return lip is its own bend (the
wall's flange).

**Per-wall checks when forming wall *i*, given the set of already-formed walls:**

1. **Rising-wall clearance (existing max_flange):** the wall rises beside the
   punch blade → `needs_gooseneck` if `h > max_flange(standard punch)` for that
   wall. Gooseneck's larger `max_flange` may clear it.
2. **Perpendicular standing-wall clearance:** the walls perpendicular to wall *i*
   that are already up (height `h_perp`) sit at the **ends** of wall *i*'s punch.
   The punch descends into the die; its profile must clear the perpendicular
   wall tops. Each punch profile carries a calibrated **`perp_clear_mm`** in
   `punch_profiles.json` — the tallest perpendicular standing wall it clears
   (sash/straight = **12 mm**, gooseneck = **42 mm**). Rule: if
   `h_perp > punch.perp_clear_mm` → that punch collides → escalate to a
   gooseneck; if `h_perp > gooseneck.perp_clear_mm` too → the step is infeasible
   in this order. (E.g. test v1's 18 mm walls: sash 12 < 18 → blocked → gooseneck
   42 ≥ 18 → clears.)
3. **Punch length vs inside width:** the punch length (= wall *i* width) must fit
   between the inside faces of the perpendicular walls. Normally holds (the wall
   spans the base width). Flag if a corner/relief makes it not.

**Order:** the classic box order forms one opposite **pair** first, then the
perpendicular pair last (the last pair's punch must clear the first pair → the
gooseneck case). Heuristic: group by axis, form the pair that leaves the most
clearance first; the **last pair** is where gooseneck/perp-clearance binds.
`box_model` evaluates the natural pair-by-pair order(s) and picks the first that
is collision-free with per-wall gooseneck escalation; if none, reports the
binding wall + reason.

**Auto-gooseneck:** per wall, if the **standard** punch collides (check 1 or 2)
and an **owned gooseneck** clears, select the gooseneck (`needs_gooseneck=true`,
`punch_type="gooseneck"`). Else if nothing owned clears → that wall is the
blocking reason (`collides_with`). The web per-bend dropdown can override.

**Calibration:** `box_model` is pure → calibrate the clearance thresholds and the
order rule against **เอ๋'s real pan ("test v1")** and her shop judgement (which
walls she actually goosenecks, what order she bends), the same way max_flange was
calibrated to 42.86 / 53.19.

## 6. Irregular-box fallback (`formed_collision`)

For boxes that aren't clean rectangles, reuse the P2/P3 machinery with two
additions (both noted as seams in the current code):
- **Formed-aware oracle:** when evaluating bend *N* in an order, fold the walls
  formed earlier in that order to their final state and treat them as collision
  obstacles (in addition to the punch/die), not just the moving side vs the tool.
- **Per-bend punch reorientation:** orient the punch/die long axis to the current
  bend's axis (today tools are translated +Z only — the P2 limit). 
`sequence_search` gains the formed-aware oracle; the search reports a
collision-free order or `impossible` / `not_found_budget` as today.

## 7. Output contract (`bend_sim/<code>` additions)

```jsonc
{
  "kind": "box",                  // new, alongside found/impossible/not_found_budget
  "order": [/* bend ids in fold order */],
  "legs": null,                   // boxes: no leg what-if (avoid misleading 1-D legs)
  "flat_length": <num|null>,      // present only if a flat pattern exists (overall blank;
  "thickness":   <num|null>,      //   for a pan this is a 2-D size — informational)
  "per_bend": [{
    "bend": "B1", "axis": "X|Y", "step": 1,
    "punch_id": "...", "punch_type": "standard|gooseneck|sash",
    "needs_gooseneck": true,
    "collides_with": "<wall id>|null",
    "max_flange": <num|null>,     // unchanged (per-wall rising-wall limit)
    "flange_mm": <num>, ...       // existing fields
  }],
  "box_geom": {                   // lets the web synthesize + animate the 3-D pan
    "base":   { "w": <num>, "h": <num> },   // pan floor footprint (iso view)
    "thickness": <num>,
    "flat_w": <num>, "flat_h": <num>,       // developed cross/plus bounding (Flat display)
    "walls": [{
      "id": "B1", "axis": "X|Y", "side": "+|-",
      "height": <num>, "width": <num>, "offset": <num>,
      "step": 1, "angle_deg": <num>,
      "punch": "standard|gooseneck", "punch_id": "...", "die": "...",
      "needs_gooseneck": true, "max_flange": <num|null>, "collides": false
    }]
  }
}
```

`box_geom` is **parameters only** (no mesh) — the web builds the 3-D pan itself,
mirroring how `simbend-sim.js` synthesizes the 2-D fold from `per_bend`.

## 8. Web 3-D sim (`simbend-3d.js`, Group 2)

- Read `box_geom` → build a 3-D pan: base rectangle + 4 hinged wall planes.
- Animate **folding wall-by-wall in `step` order**, isometric camera.
- At a colliding step, flash that wall (and the punch) **red**; show the
  auto-selected punch (sash vs gooseneck) per wall.
- ▶ / ⏸ + ⬇ Clip (reuse the MediaRecorder pattern from `simbend-sim.js`).
- Per-bend **punch override** dropdown already exists → on change, recompute /
  re-push (or web-side recolour) as today.
- Lightweight: CSS-3D transforms or a small canvas/3-D lib — G2's call; no heavy
  engine required for hinged planes.

## 9. Components & isolation

| Unit | Purpose | Interface | Deps | Tested |
|------|---------|-----------|------|--------|
| `box_detect.py` | group bends by axis → is_box, rectangular vs irregular | `detect(bends) -> {is_box, kind, axes, walls}` | bend axes | offline |
| `box_model.py` ⭐ | rectangular pan → order + per-wall tooling/collision | pure: `solve(walls, owned_tools, profiles) -> {order, per_wall, bendable, reason}` | bend_math, max_flange | offline + calibrated |
| `formed_collision.py` | formed-aware oracle + punch reorient (irregular) | `oracle(formed, next) -> collides` | collision_core, fold, bend_graph | offline collide/clear |
| `sequence_search` (extend) | accept formed-aware oracle | existing + oracle arg | — | existing tests |
| `web_push.build_record` (extend) | box fields + box_geom + legs=null for box | pure | — | offline |
| action (wiring) | box_detect → branch box_model / formed-3D | — | all | live verify |
| `simbend-3d.js` (G2) | 3-D pan fold from box_geom | reads box_geom | — | web |

## 10. Testing & calibration

- `box_detect`: synthetic 1-axis (not box), 2-axis rectangular, irregular.
- `box_model`: a rectangular pan (W×L, wall heights, lips) → expected order +
  gooseneck flags; **calibrate against เอ๋'s "test v1":** base **200×300**, flat
  (developed) **243.048×300**, walls **7/7/18/18** (the 18 mm walls carry a 7 mm
  return lip → 8 bends = 4×(wall+lip)). Expected: the **18 mm walls need a
  gooseneck** (sash `perp_clear` 12 < 18), the 7 mm lips do not.
- **Per-bend wall-dim fix (do WITH box_model):** the per-bend `flange_mm`
  currently reports the **face-extent** (flat zone) — under เอ๋'s drawing dims
  (test v1: 5/14 vs real 7/18). This is NOT a clean +setback: on the #202 rig the
  face (43) ≈ เอ๋'s bent dim (42.87) while on test v1 the face (5) < bent (7), so
  the face-extent measure is geometry-inconsistent. Fix the wall dim to เอ๋'s
  **bent/outer** value, **calibrated to BOTH anchors (test v1 7/18 + #202 42.86)**
  — same discipline as max_flange, not a hand-formula.
- `formed_collision`: offline collide / clear cases.
- **Regression:** linear parts (max_flange / mould legs) must be unchanged.
- **Live:** verify on test v1 (create a flat pattern for flat_length) + a 2nd real pan.

## 11. Open questions (resolve during implementation)

- Perpendicular-clearance threshold — **resolved:** `punch_profiles.json.perp_clear_mm`
  (sash 12, gooseneck 42), calibrated by เอ๋. Confirm/extend per punch as needed.
- Order rule when both pairs are equal — pick a deterministic default (e.g. bend
  the **shorter** pair first), confirm with เอ๋.
- Whether `flat_length` for a pan should be `{w,l}` instead of one number (web
  shows a 2-D blank size). Default: keep `flat_length` as the longest dim +
  rely on `box_geom.base` for the real W×L.
