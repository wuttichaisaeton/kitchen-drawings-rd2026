# SIM.BENDING — Kinematics realism roadmap (เอ๋ 2026-06-04)

Current state APPROVED by เอ๋ for size/proportion: punch length 186 (short) / 286 (long)
inner opening, TOOL_SCALE 0.5, die + gooseneck punch rendered semi-transparent
(fill alpha 0.12, bright edges). Commit 7bb20e5.

Below are 4 kinematics gaps เอ๋ wants for a "complete" sim. Do ONE AT A TIME, get sign-off
each, to avoid regressions. Status assessed against the current 3-D engine (simbend-3d.js).

---

## 1. Real bending kinematics — vertical stroke + sink into the V-die
**Want:** the PUNCH descends vertically (vertical stroke) and presses the sheet DOWN into
the V-die; the rest of the sheet slides slightly over the die mouth as the flange tips up
around the punch tip. Not just a flange rotation with flat sheet + stationary tool.

**Current status (partial):**
- ✅ Punch descends before the fold: `gpunchZ(frac)` lowers the punch from `PEN_HI` to the
  sheet over the first `TOUCH` (0.333) of the move, then rides the sheet.
- ✅ Fold gated to AFTER touch: `gfold` (fold only starts once the punch has touched).
- ✅ Press-V tip: `vlift` rotates base + flaps about the active bend line at the die so the
  whole piece tips into a V, then settles.
- ❌ The sheet **sinking into the V-die** (the bend point dropping into the groove by the
  penetration depth) is NOT shown — the bend pivots in place, it doesn't descend into the V.
- ❌ The slight **slide of the flat over the die mouth** as it forms is NOT shown.
**To do:** drop the active bend vertex into the V by the penetration depth during the press
(the 2-D `mount2d`/`simbend-sim.js` `pen` does this; port the idea to 3-D), and let the
flat ride the die shoulders.

## 2. Dynamic sweep / trajectory collision (mid-fold)
**Want:** show collisions that happen MID-PATH (e.g. clears at 90° but hits at 45°, or vice
versa). Operator must SEE the colliding instant in slow motion to fix the design.

**Current status:**
- ✅ Backend `collision_core.py` (Fusion side) already samples sub-angles along the path.
- ⚠️ Web sim flags `collides` per bend (red), but does NOT pause/slow at the mid-path hit.
**To do:** when `per_bend[i].collides`, ease the animation to the `at_angle` (the colliding
angle) and hold/flash there in slow-mo so the operator sees exactly where it jams, before
continuing.

## 3. Part handling between steps — retract / rotate / flip (no teleport)
**Want:** between bend N and N+1 the part is retracted, rotated, or flipped — not teleported.
Long parts may hit the machine frame or the backgauge during the move.

**Current status:**
- ❌ The 3-D fold keeps the part fixed and just folds the next flap in place (effectively a
  teleport between which bend is active). No reposition/rotate/flip transition.
**To do:** add a short between-steps transition (retract → rotate/flip → re-seat) and,
optionally, a frame/backgauge envelope to flag clashes. (Bigger task.)

## 4. Unloading / demolding after the box is closed
**Want:** once 4 sides are up the box surrounds the punch; show the operator sliding the box
OFF the punch (left/right). Tall box + long punch + tight frame → may lock on.

**Current status:**
- ❌ Animation ends with the box closed around the punch; no unload/slide-off motion.
**To do:** after the last fold, slide the finished box along the punch axis until it clears
the punch end (and flag if the punch is longer than the slide clearance). This is the real
reason the punch length / clearance matters.

---

## Order of work (proposed)
1 → 2 → 4 → 3 (1 is foundational and most visible; 3 is the biggest). Each shipped + verified
on live before the next. No size changes (186/286 + transparency are locked).
