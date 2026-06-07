# Sim.Bending — live FLAN edit → flange geometry + label + throat-clearance collision

**Date:** 2026-06-07
**Area:** `drawings-ui` — `simbend-3d-ai.js` (3-D/2-D sim engine), `tool-art.js` (DXF punch profiles), `app.js` (step table + sim mount)
**Requested by:** เอ๋ — *"เมื่อเปลี่ยนค่านี้ [FLAN] ตัวเลขต้องเปลี่ยน และความยาวต้องเพิ่มขึ้น จะชนหรือไม่ชน ให้ดูรูปนี้ หรือ ตารางจาก KYOKKO catalog ปรับมีดตัวนี้ และตัวอื่นด้วย"*
**Status:** Design approved (brainstorm) — ready for implementation plan.

## 1. Goal

In the Sim.Bending step table the **FLAN** (flange length, `flange_mm`) cell is editable, but editing it today does almost nothing useful for the operator:
- It only takes effect on **SAVE CONFIG** (not live), and
- it writes `wall.flat_len` while the **collision check reads `wall.height`** — so the flange length and the collision verdict are disconnected, and
- the rendered flange length + the 2-D **dimension label** (the "25"/"18" numbers) do not follow the edited value.

เอ๋ wants: change FLAN → the flange in 2-D/3-D **grows to the new length**, the **dimension number updates**, and the sim **re-checks collision** against the punch's real **throat clearance** taken from the KYOKKO DXF profile — for **#453 and every other punch**. Live what-if (does not touch the saved part until SAVE CONFIG).

## 2. Scope

- **In scope:** live FLAN editing → flange length (2-D + 3-D) + dimension label + collision re-evaluation; a geometric **throat-clearance** function derived from the `tool-art.js` DXF profiles, replacing the 3-value hard-coded `sameSideClearMm`; aligning the flange value used by render and by collision.
- **Out of scope:** tonnage / force-capacity limits (the catalog's Max-Ton chart) — collision is purely geometric here; changing the saved `bend_sim` record except via the existing **SAVE CONFIG** button; the Fusion-side `box_model.py` (its same-side stacked check is tracked separately — this is the web SIM only); non-FLAN cells (punch/die/angle/V already work).

## 3. Current state (what exists)

- **Step table + cells** (`app.js`): per-bend rows from `bend_sim/<code>.per_bend[]`; flange cell = `<input class="sb-edit-flange" data-bend=…>` (app.js ~5773). The **SAVE CONFIG** click handler (app.js ~6054) reads every cell into `b.flange_mm`/`b.flange_mm_out` and copies `wall.flat_len = b.flange_mm` into `rec.box_geom.walls[]`, then rebuilds (`window.kdSimBend.buildModel(rec)`).
- **Sim mount** (`app.js` ~5916): box parts → `window.kdSimBend3D.mount(canvas, rec, …)` (3-D) + `.mount2d(canvas2d, rec, …)` (2-D press); linear → `window.kdSimBend.mount`. Controllers held in `_simController` / `_simController2D`; the 2-D controller also exposes `window.__active2DController`.
- **Collision** (`simbend-3d-ai.js`): `stackedHitId(walls, aw, active, punch)` flags a hit when a same-axis/same-side wall formed earlier has `height > sameSideClearMm(punch)`. `sameSideClearMm` is hard-coded: `/453/→42`, `/103/→12`, else `10`.
- **Profiles** (`tool-art.js`): `PROFILES` = exact DXF traces (tip at origin, Y up) for Kyokko **#202** (sash), **#109** (straight), **#453** (gooseneck), **#103** (acute). `resolveProfilePts(tool)` matches by `profile_pts`/`profile_id`/`series`.

## 4. Design

### 4.1 `throatClearForProfile(profilePts, side)` — geometric clearance (new)

Replaces `sameSideClearMm`. Given a punch's DXF profile polygon (tip at `(0,0)`, Y up) and the bend `side` (which side the already-formed same-side wall stands on), compute the **maximum height of a vertical standing wall, offset horizontally just past the tip, that does NOT intersect the punch silhouette** on the relief side. That height = the throat clearance (a deep gooseneck relief → large; a straight/acute → small).

Algorithm:
1. Pick the relief side (the side toward the formed wall); take the profile's silhouette on that side as a function `xEdge(y)`.
2. Place the wall as a vertical line at `xWall = tipHalfWidth + OFFSET` (OFFSET = small calibrated gap ≈ die-shoulder/air clearance).
3. Walk `y` upward from the tip; the clearance = the largest `y` for which `xEdge(y) ≤ xWall` continuously from the tip (i.e. the wall clears the punch up to that height; the first `y` where the body bulges past `xWall` caps it).
4. **Calibrate `OFFSET`** so the known anchors come out right: **#453 → ≈42**, **#103 → ≈12**. Verify **#202 (sash) ≈12** and **#109 (straight) ≈10** land sensibly; **#463** (90° gooseneck, no profile yet) inherits the gooseneck value (≈42) until its DXF is traced.

Robustness:
- **Fallback:** if a punch has no resolvable profile → default `10` (straight) — never throw.
- **Optional override map** `THROAT_OVERRIDE = { '453': 42, '103': 12, ... }`: if a computed value is judged off during calibration, an explicit entry wins. Keeps the established "calibrated constant" discipline as a safety net while defaulting to geometry.
- Result is **memoized per profile+side** (profiles are static) so it isn't recomputed every frame.

`stackedHitId` calls `throatClearForProfile(resolveProfilePts(punch), aw.side)` instead of `sameSideClearMm(punch)`. Same comparison (`formedWall.height > clear`).

### 4.2 FLAN drives ONE effective flange length (render + collision aligned)

Today FLAN → `wall.flat_len`, collision → `wall.height`. **Unify:** the sim's per-wall effective flange length (used by both the 3-D wall extrusion / 2-D flange draw AND `stackedHitId`'s `height` comparison) reads the edited FLAN. Concretely: when FLAN changes, set the wall's collision/length field (`height`, keeping `flat_len` in sync) from `flange_mm` so a longer flange both *looks* longer and *counts* as taller for clearance. (The exact field the renderer + `stackedHitId` consume is pinned in the plan; the rule: one value, two consumers.)

### 4.3 Live update on cell edit (what-if)

Add an `input`/`change` listener on `.sb-edit-flange` (separate from SAVE CONFIG) that:
1. Parses the new value; writes it into the in-memory `rec` (`per_bend[i].flange_mm` + the matching `box_geom.walls[].height`/`flat_len`) — **in-memory only**, not RTDB.
2. Triggers a **sim rebuild** of the active controllers (`_simController` / `_simController2D` via their mount or a `rebuild(rec)` entry) so the 2-D + 3-D views re-extrude the flange, re-draw the dimension label, and re-run `stackedHitId`.
3. Updates the row's NOTE / collision indicator (FORMABLE ↔ COLLISION) from the new verdict.

SAVE CONFIG keeps persisting the override (unchanged path). A what-if that isn't saved is discarded on reload — matching "ไม่แก้ part จริง".

### 4.4 2-D dimension label follows FLAN

The 2-D press view's dimension number for the active wall must read the (possibly-overridden) `flange_mm` so the on-screen "25/18" updates with the cell. (Label draw is in the 2-D controller; point it at the effective flange value.)

## 5. Components & isolation

| Unit | Purpose | Interface | Deps | Tested |
|------|---------|-----------|------|--------|
| `throatClearForProfile` (simbend-3d-ai.js) | geometric throat clearance from a DXF profile | `(profilePts, side) -> mm` (pure) | profile polygon | node (pure) |
| `stackedHitId` (edit) | use computed clearance | unchanged signature | throatClearForProfile, resolveProfilePts | live |
| sim rebuild entry (simbend-3d-ai.js) | re-sim from an updated `rec` | `controller.rebuild(rec)` or re-mount | — | live |
| FLAN live listener (app.js) | cell edit → in-memory rec → rebuild | DOM event | sim controllers | live |
| 2-D label source (2-D controller) | label reads effective flange | — | rec | live |

## 6. Testing

- **Pure node test — `throatClearForProfile`:** feed the 4 `tool-art.js` profiles; assert **#453 ≈ 42** and **#103 ≈ 12** (±1–2 mm after calibration), and that **#202 < #453** and **#109 ≤ #202** (gooseneck clears the most). Monotonic sanity: a taller wall than the returned clearance must intersect, one just under must clear.
- **Live (preview):** open a box part's sim; edit a FLAN cell up → the 2-D/3-D flange visibly lengthens, the dimension number changes, and on a #453 gooseneck step the verdict flips COLLISION when FLAN exceeds the clearance, FORMABLE below it. Edit down → reverts. Confirm `bend_sim` in RTDB is unchanged until SAVE CONFIG.
- **No-regression:** punch/die/angle/V edits + SAVE CONFIG still behave as before; linear (non-box) parts unaffected.

## 7. Files touched

- `drawings-ui/simbend-3d-ai.js` — `throatClearForProfile` (replaces `sameSideClearMm`), `stackedHitId` call site, effective-flange field, a rebuild entry, 2-D label source.
- `drawings-ui/app.js` — `.sb-edit-flange` live listener (in-memory rec update + controller rebuild + NOTE refresh).
- `drawings-ui/tool-art.js` — none expected (profiles already present); add `#463` trace later if/when its DXF is available.
- No bundling (these load directly); push → Pages deploy.

## 8. Open questions (resolve during implementation)

- Exact `OFFSET` constant + whether `#202`/`#109` need an override entry — settle during calibration against the #453/#103 anchors.
- Which single field (`height` vs a new `eff_flange`) the renderer + `stackedHitId` should both read — pick the one already consumed by the 3-D extrusion to minimise churn.
- Debounce the live listener (`input` every keystroke vs `change` on blur) — default `change` to avoid re-sim thrash; revisit if เอ๋ wants per-keystroke.
