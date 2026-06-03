# Box-bending collision (CC_CheckBend, Fusion / Group 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a box/pan-aware bending branch to CC_CheckBend that computes fold order, auto-gooseneck escalation, and perpendicular-wall collision for rectangular pans (analytic) and irregular boxes (formed-aware 3-D fallback), and publishes a `box`-kind `bend_sim/<code>` record (with `box_geom`) for the web 3-D sim — leaving the shipped **linear** path (max_flange + mould legs) untouched.

**Architecture:** A new pure `box_detect` groups extracted bends by bend-axis direction → `linear` (1 axis, existing path) / `rectangular` / `irregular`. Rectangular pans go to a pure, calibratable `box_model` that reuses `max_flange` for the rising-wall limit and a calibrated per-punch perpendicular-clearance threshold for the already-formed-wall collision, then searches pair-by-pair fold orders with per-wall standard→gooseneck escalation. Irregular boxes go to a formed-aware oracle (`formed_collision`) driven by the existing `sequence_search` (whose `(formed, next)` oracle signature already supports order-dependence). The action branches on `box_detect`, builds wall geometry from the folded body, and pushes a `box` record; `web_push.build_record` gains a backward-compatible `box=` argument.

**Tech Stack:** Python 3 (Fusion add-in modules + pure offline-tested modules), Autodesk Fusion API (`adsk.core`/`adsk.fusion`) in the action only, RTDB REST via `urllib` (existing `web_push`). Tests are plain `python tests/test_*.py` scripts (assert + `if __name__ == "__main__"` runner), no pytest.

**Repos & commits:** Code lives in the **`_MASTERS`** git repo (LOCAL, no remote) at `_MASTERS/fusion_scripts/CC_CheckBend/`. Other parallel sessions have unrelated `M` changes staged there — **always `git add` only the exact CC_CheckBend files this plan touches**, never `git add -A`. This plan document lives in the **`drawings-ui`** repo (has `origin/main`); the coordination board `drawings-ui/docs/coordination/group-sync.md` is the G1↔G2 channel.

**Working-dir note (Windows / Thai OneDrive path):** the project root has Thai characters. Run test commands from the CC_CheckBend dir. All paths below are relative to the repo-agnostic project root `C:\Users\wutti\OneDrive\เดสก์ท็อป\Work\Stainless Kitchen`.

---

## File structure

| File | Responsibility | Pure? |
|------|----------------|-------|
| `_MASTERS/fusion_scripts/CC_CheckBend/box_detect.py` | group bends by axis → `{is_box, kind, axes, axis_of}` | pure |
| `_MASTERS/fusion_scripts/CC_CheckBend/box_model.py` ⭐ | rectangular pan: per-wall checks + fold-order search + `box_geom` assembly | pure (reuses `max_flange`) |
| `_MASTERS/fusion_scripts/CC_CheckBend/formed_collision.py` | irregular box: formed-aware collision oracle for `sequence_search` | pure (injected geometry) |
| `_MASTERS/standards/bend_tools/punch_profiles.json` | add `perp_clear_mm` per punch profile (calibratable) | data |
| `_MASTERS/fusion_scripts/CC_CheckBend/web_push.py` | extend `build_record` with `box=` (box fields + `box_geom` + `legs=null`) | pure |
| `_MASTERS/fusion_scripts/CC_CheckBend/sequence_search.py` | (no code change) regression test proving formed-aware oracle works | pure |
| `_MASTERS/fusion_scripts/CC_CheckBend/CC_CheckBend_action.py` | wire `box_detect` branch, extract walls (adsk), dispatch box_model / formed fallback, push | adsk |
| `tests/test_box_detect.py`, `tests/test_box_model.py`, `tests/test_box_model_calib.py`, `tests/test_formed_collision.py`, `tests/test_sequence_search_formed.py`, `tests/test_web_push_box.py` | offline tests | pure |

### Shared data shapes (used across tasks — define once, reuse verbatim)

**Wall dict** (built by the action from geometry; consumed by `box_model`):
```python
{
  "id": "B1",          # == the Bend.id it came from
  "axis": "X",         # "X" or "Y" (which of the two box axes)
  "side": "+",         # "+" or "-" (which side of the base, for iso layout)
  "height": 14.0,      # free rising wall length (mm) = the wall's flange face extent
  "width": 300.0,      # along its own bend axis (mm) = bend_length
  "offset": 0.0,       # position along the perpendicular axis (mm, for iso layout)
  "inside_radius": 1.0,
  "angle": 90.0,       # deg
  "base_cl": 300.0,    # developed-centerline base leg for the rising-wall march (mm)
  "punch_id": "P-...", "die_id": "D-...", "v": 6,   # selected tool (or None)
}
```

**`box_model.solve(...)` return:**
```python
{
  "bendable": True,
  "kind": "box",
  "order": ["B1", "B2", "B3", "B4"],   # wall ids in fold order
  "reason": "",                         # "" iff bendable
  "per_wall": {
    "B1": {"step": 1, "axis": "X", "punch_type": "standard",
           "needs_gooseneck": False, "collides_with": None, "max_flange": None},
    # ...
  },
}
```

---

## Task 1: `box_detect` — classify a part as linear / rectangular / irregular

**Files:**
- Create: `_MASTERS/fusion_scripts/CC_CheckBend/box_detect.py`
- Test: `_MASTERS/fusion_scripts/CC_CheckBend/tests/test_box_detect.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_box_detect.py`:
```python
# -*- coding: utf-8 -*-
"""Offline tests for box_detect (no Fusion). Run: python tests/test_box_detect.py"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import box_detect
import bend_extractor


def _b(id, axis_dir, angle=90.0):
    return bend_extractor.Bend(id, 1.0, angle, 100.0, 20.0, axis_dir=axis_dir)


def test_single_axis_is_linear():
    r = box_detect.detect([_b("B1", (1, 0, 0)), _b("B2", (1, 0, 0))])
    assert r["is_box"] is False
    assert r["kind"] == "linear"


def test_two_perpendicular_axes_is_rectangular():
    bends = [_b("B1", (1, 0, 0)), _b("B2", (1, 0, 0)),
             _b("B3", (0, 1, 0)), _b("B4", (0, 1, 0))]
    r = box_detect.detect(bends)
    assert r["is_box"] is True
    assert r["kind"] == "rectangular"
    assert r["axis_of"]["B1"] == r["axis_of"]["B2"]
    assert r["axis_of"]["B1"] != r["axis_of"]["B3"]
    assert len(r["axes"]) == 2


def test_antiparallel_axes_are_one_axis():
    # +X and -X are the SAME bend axis (sign-independent)
    r = box_detect.detect([_b("B1", (1, 0, 0)), _b("B2", (-1, 0, 0))])
    assert r["kind"] == "linear"


def test_three_axes_is_irregular():
    bends = [_b("B1", (1, 0, 0)), _b("B2", (0, 1, 0)), _b("B3", (0, 0, 1))]
    r = box_detect.detect(bends)
    assert r["is_box"] is True
    assert r["kind"] == "irregular"


def test_two_nonperpendicular_axes_is_irregular():
    bends = [_b("B1", (1, 0, 0)), _b("B2", (0.7071, 0.7071, 0))]
    r = box_detect.detect(bends)
    assert r["kind"] == "irregular"


if __name__ == "__main__":
    for n, fn in sorted(globals().items()):
        if n.startswith("test_") and callable(fn):
            fn(); print("ok", n)
    print("ALL PASS")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "_MASTERS/fusion_scripts/CC_CheckBend" && python tests/test_box_detect.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'box_detect'`.

- [ ] **Step 3: Write minimal implementation**

Create `box_detect.py`:
```python
# -*- coding: utf-8 -*-
"""Classify a sheet-metal part by its bend-axis directions so CC_CheckBend can
route it: 1 axis -> linear (existing max_flange/mould-legs path, untouched);
2 perpendicular axes -> rectangular pan (box_model); anything else -> irregular
box (formed-aware 3-D fallback). Pure: reads only Bend.axis_dir tuples + angle,
no Fusion import, unit-tested offline."""

PERP_DOT_TOL = 0.2     # |dot(axisA, axisB)| below this => perpendicular


def _axis_key(axis_dir):
    """Sign-independent axis key (+X and -X are the same bend axis)."""
    if not axis_dir:
        return (0.0, 0.0, 0.0)
    return tuple(round(abs(c), 1) for c in axis_dir)


def _perp(k1, k2):
    d = k1[0] * k2[0] + k1[1] * k2[1] + k1[2] * k2[2]
    return abs(d) < PERP_DOT_TOL


def detect(bends):
    """Return {is_box, kind, axes, axis_of}. axes = distinct axis keys in
    first-seen order; axis_of = {bend.id: index into axes}."""
    axes = []
    axis_of = {}
    for b in bends:
        k = _axis_key(getattr(b, "axis_dir", None))
        if k not in axes:
            axes.append(k)
        axis_of[b.id] = axes.index(k)
    n = len(axes)
    if n <= 1:
        kind, is_box = "linear", False
    elif n == 2 and _perp(axes[0], axes[1]):
        kind, is_box = "rectangular", True
    else:
        kind, is_box = "irregular", True
    return {"is_box": is_box, "kind": kind, "axes": axes, "axis_of": axis_of}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "_MASTERS/fusion_scripts/CC_CheckBend" && python tests/test_box_detect.py`
Expected: `ok test_*` ×5 then `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add _MASTERS/fusion_scripts/CC_CheckBend/box_detect.py _MASTERS/fusion_scripts/CC_CheckBend/tests/test_box_detect.py
git commit -m "feat(checkbend): box_detect — classify linear/rectangular/irregular by bend axes"
```

---

## Task 2: `box_model` per-wall checks (rising-wall + perpendicular clearance + punch length)

**Files:**
- Create: `_MASTERS/fusion_scripts/CC_CheckBend/box_model.py`
- Test: `_MASTERS/fusion_scripts/CC_CheckBend/tests/test_box_model.py`

This task builds the per-wall predicates only; the order search comes in Task 3 (same file). Uses the real `punch_profiles.json` for the rising-wall march (reusing `max_flange`).

- [ ] **Step 1: Write the failing test**

Create `tests/test_box_model.py`:
```python
# -*- coding: utf-8 -*-
"""Offline tests for box_model per-wall predicates. Run: python tests/test_box_model.py"""
import os, sys
_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_DIR))
import box_model
import max_flange

_PROFILES = os.path.normpath(os.path.join(
    _DIR, "..", "..", "..", "standards", "bend_tools", "punch_profiles.json"))


def _profiles():
    return max_flange.load_profiles(_PROFILES)


def _wall(id, axis, height, base_cl=300.0, angle=90.0, side="+", width=300.0):
    return {"id": id, "axis": axis, "side": side, "height": height,
            "width": width, "offset": 0.0, "inside_radius": 1.0,
            "angle": angle, "base_cl": base_cl}


def test_short_wall_on_big_base_no_rising_limit():
    # 14mm wall on a 300mm pan floor -> punch never collides with the rising wall
    ok_std, ok_goose, mf_std, mf_goose = box_model.rising_wall_check(
        _wall("B1", "X", 14.0), _profiles())
    assert ok_std is True
    assert mf_std is None          # no rising-wall limit (clears)


def test_perp_clear_standard_only_short_walls():
    pc = {"standard": 12.0, "sash": 12.0, "gooseneck": 60.0}
    assert box_model.perp_clear_check(0.0, "standard", pc) is True     # nothing up
    assert box_model.perp_clear_check(10.0, "standard", pc) is True    # 10 <= 12
    assert box_model.perp_clear_check(30.0, "standard", pc) is False   # 30 > 12
    assert box_model.perp_clear_check(30.0, "gooseneck", pc) is True   # 30 <= 60
    assert box_model.perp_clear_check(80.0, "gooseneck", pc) is False  # 80 > 60


def test_punch_length_fits_inside_width():
    # punch length == wall width; must be <= inside span between perpendicular walls
    assert box_model.punch_length_check(300.0, 300.0) is True
    assert box_model.punch_length_check(310.0, 300.0) is False


if __name__ == "__main__":
    for n, fn in sorted(globals().items()):
        if n.startswith("test_") and callable(fn):
            fn(); print("ok", n)
    print("ALL PASS")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "_MASTERS/fusion_scripts/CC_CheckBend" && python tests/test_box_model.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'box_model'`.

- [ ] **Step 3: Write minimal implementation**

Create `box_model.py` (predicates only — Task 3 appends `solve` + `assemble_box_geom`):
```python
# -*- coding: utf-8 -*-
"""Rectangular-pan bending model (analytic, pure, calibratable like max_flange).

A pan bends on two perpendicular axes (up to 4 walls around a base). For each
wall being formed, given the walls already up, we check:
  1. rising-wall clearance — the wall rising beside the punch blade (reuses
     max_flange against the punch silhouette);
  2. perpendicular standing-wall clearance — the perpendicular walls already up
     sit at the ENDS of this wall's punch; a STRAIGHT punch only clears very short
     ones, a GOOSENECK throat clears tall ones (calibrated per-punch threshold);
  3. punch length vs inside width — the punch (= wall width) must fit between the
     inside faces of the perpendicular walls.
Auto-gooseneck: prefer the standard punch; escalate to gooseneck only when the
standard collides and an owned gooseneck clears. No Fusion import — unit-tested
offline + calibrated against เอ๋'s real pan."""
import max_flange as _mf

# Calibrated perpendicular-clearance thresholds (mm) — how tall a perpendicular
# already-formed wall each punch type can clear at the ends of the blade.
# CALIBRATED in Task 5 against เอ๋'s judgement; these are the seed defaults.
DEFAULT_PERP_CLEAR = {"standard": 12.0, "sash": 12.0, "gooseneck": 42.0}


def rising_wall_check(wall, profiles, punch_type_std="sash",
                      punch_type_goose="gooseneck"):
    """Return (ok_std, ok_goose, mf_std, mf_goose). mf_* is the max_flange limit
    for that punch (None = no limit); ok_* = wall fits under it."""
    poly_std = _mf.resolve_profile(profiles, None, punch_type_std)
    poly_goose = _mf.resolve_profile(profiles, None, punch_type_goose)
    base_cl = wall.get("base_cl")
    ang = wall.get("angle", 90.0)
    mf_std = _mf.compute_max_flange(poly_std, base_cl, ang) if poly_std else None
    mf_goose = _mf.compute_max_flange(poly_goose, base_cl, ang) if poly_goose else None
    h = wall["height"]
    ok_std = (mf_std is None) or (h <= mf_std)
    ok_goose = (mf_goose is None) or (h <= mf_goose)
    return ok_std, ok_goose, mf_std, mf_goose


def perp_clear_check(h_perp, punch_type, perp_clear=None):
    """True if `punch_type` clears a perpendicular formed wall of height h_perp."""
    pc = perp_clear or DEFAULT_PERP_CLEAR
    return h_perp <= pc.get(punch_type, 0.0)


def punch_length_check(punch_length_mm, inside_width_mm):
    """True if the punch (== wall width) fits between the perpendicular walls."""
    if inside_width_mm is None:
        return True
    return punch_length_mm <= inside_width_mm + 1e-6
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "_MASTERS/fusion_scripts/CC_CheckBend" && python tests/test_box_model.py`
Expected: `ok test_*` ×3 then `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add _MASTERS/fusion_scripts/CC_CheckBend/box_model.py _MASTERS/fusion_scripts/CC_CheckBend/tests/test_box_model.py
git commit -m "feat(checkbend): box_model per-wall predicates (rising-wall + perp clearance + punch length)"
```

---

## Task 3: `box_model.solve` — pair-by-pair fold-order search + `assemble_box_geom`

**Files:**
- Modify: `_MASTERS/fusion_scripts/CC_CheckBend/box_model.py` (append `solve` + `assemble_box_geom`)
- Test: `_MASTERS/fusion_scripts/CC_CheckBend/tests/test_box_model.py` (append cases)

- [ ] **Step 1: Write the failing test (append to `tests/test_box_model.py`, before the `__main__` block)**

```python
def test_solve_short_pan_all_standard_bendable():
    # 4 short walls (5/14mm) on a 300mm pan -> all standard, bendable, no gooseneck
    walls = [_wall("B1", "X", 14.0, base_cl=300.0, side="+"),
             _wall("B2", "X", 14.0, base_cl=300.0, side="-"),
             _wall("B3", "Y", 5.0, base_cl=300.0, side="+"),
             _wall("B4", "Y", 5.0, base_cl=300.0, side="-")]
    r = box_model.solve(walls, _profiles())
    assert r["bendable"] is True
    assert r["kind"] == "box"
    assert sorted(r["order"]) == ["B1", "B2", "B3", "B4"]
    assert all(not w["needs_gooseneck"] for w in r["per_wall"].values())
    # steps are 1..4 and the same-axis pair is contiguous
    steps = {wid: r["per_wall"][wid]["step"] for wid in r["per_wall"]}
    assert sorted(steps.values()) == [1, 2, 3, 4]


def test_solve_tall_last_pair_needs_gooseneck():
    # first pair short (10mm), last pair tall (30mm) -> last pair must clear the
    # 10mm perpendicular walls already up: 10 <= standard 12 OK; but make the
    # LAST pair's perpendicular obstacle exceed standard so it escalates.
    pc = {"standard": 12.0, "sash": 12.0, "gooseneck": 42.0}
    walls = [_wall("B1", "X", 30.0, base_cl=300.0, side="+"),
             _wall("B2", "X", 30.0, base_cl=300.0, side="-"),
             _wall("B3", "Y", 30.0, base_cl=300.0, side="+"),
             _wall("B4", "Y", 30.0, base_cl=300.0, side="-")]
    r = box_model.solve(walls, _profiles(), perp_clear=pc)
    assert r["bendable"] is True
    # the pair formed LAST has 30mm perpendicular walls up (>12) -> gooseneck
    last_axis = r["per_wall"][r["order"][-1]]["axis"]
    last_pair = [w for w in r["per_wall"].values() if w["axis"] == last_axis]
    assert all(w["needs_gooseneck"] for w in last_pair)
    assert all(w["punch_type"] == "gooseneck" for w in last_pair)


def test_solve_impossible_when_even_gooseneck_cannot_clear():
    pc = {"standard": 12.0, "sash": 12.0, "gooseneck": 42.0}
    walls = [_wall("B1", "X", 80.0, base_cl=300.0, side="+"),
             _wall("B2", "X", 80.0, base_cl=300.0, side="-"),
             _wall("B3", "Y", 80.0, base_cl=300.0, side="+"),
             _wall("B4", "Y", 80.0, base_cl=300.0, side="-")]
    r = box_model.solve(walls, _profiles(), perp_clear=pc)
    assert r["bendable"] is False
    assert r["reason"]
    # the binding wall records what it collides with
    blocked = [w for w in r["per_wall"].values() if w["collides_with"]]
    assert blocked


def test_assemble_box_geom_shape():
    walls = [_wall("B1", "X", 14.0, side="+"), _wall("B3", "Y", 5.0, side="+")]
    r = box_model.solve(walls, _profiles())
    geom = box_model.assemble_box_geom(
        base_w=300.0, base_h=300.0, thickness=1.0,
        flat_w=328.0, flat_h=310.0, walls=walls, solve_res=r)
    assert geom["base"] == {"w": 300.0, "h": 300.0}
    assert geom["thickness"] == 1.0
    assert geom["flat_w"] == 328.0 and geom["flat_h"] == 310.0
    ids = {w["id"] for w in geom["walls"]}
    assert ids == {"B1", "B3"}
    w0 = next(w for w in geom["walls"] if w["id"] == "B1")
    for k in ("axis", "side", "height", "width", "offset", "step",
              "angle_deg", "punch", "needs_gooseneck", "max_flange", "collides"):
        assert k in w0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "_MASTERS/fusion_scripts/CC_CheckBend" && python tests/test_box_model.py`
Expected: FAIL — `AttributeError: module 'box_model' has no attribute 'solve'`.

- [ ] **Step 3: Append the implementation to `box_model.py`**

```python
def _by_axis(walls):
    """{axis: [wall, ...]} preserving order; up to 2 axes for a rectangular pan."""
    groups = {}
    for w in walls:
        groups.setdefault(w["axis"], []).append(w)
    return groups


def _axis_order_candidates(groups, order_rule):
    """Yield candidate axis sequences. Pair-by-pair: form one axis fully, then
    the other. order_rule 'shorter_pair_first' tries the axis whose tallest wall
    is shorter first (its short walls are what the last punch must clear)."""
    axes = list(groups.keys())
    if len(axes) <= 1:
        return [axes]
    a, b = axes[0], axes[1]
    ha = max(w["height"] for w in groups[a])
    hb = max(w["height"] for w in groups[b])
    if order_rule == "shorter_pair_first":
        first = a if ha <= hb else b
    else:                                   # "taller_pair_first"
        first = a if ha >= hb else b
    second = b if first == a else a
    # primary candidate, then the reverse as a fallback
    return [[first, second], [second, first]]


def _evaluate_order(axis_seq, groups, profiles, perp_clear,
                    punch_type_std, punch_type_goose):
    """Form walls axis-pair by axis-pair in axis_seq order. Return
    (ok, per_wall, order, reason). per_wall has step/axis/punch_type/
    needs_gooseneck/collides_with/max_flange."""
    formed = []                  # list of formed wall dicts
    per_wall = {}
    order = []
    step = 0
    for axis in axis_seq:
        for w in groups[axis]:
            step += 1
            # tallest perpendicular wall already up
            h_perp = max([f["height"] for f in formed if f["axis"] != axis],
                         default=0.0)
            ok_std, ok_goose, mf_std, mf_goose = rising_wall_check(
                w, profiles, punch_type_std, punch_type_goose)
            # inside width the punch must fit (perpendicular walls' span ~ base);
            # use the perpendicular axis base_cl as the inside span proxy.
            inside_span = w.get("base_cl")
            len_ok = punch_length_check(w["width"], inside_span)
            std_ok = ok_std and perp_clear_check(h_perp, punch_type_std, perp_clear) and len_ok
            goose_ok = ok_goose and perp_clear_check(h_perp, punch_type_goose, perp_clear) and len_ok
            if std_ok:
                ptype, needs_gn, mf, collides = punch_type_std, False, mf_std, None
            elif goose_ok:
                ptype, needs_gn, mf, collides = punch_type_goose, True, mf_goose, None
            else:
                # binding: name the tallest perpendicular wall (or self if the
                # rising wall itself is over the gooseneck limit)
                tall = max([f for f in formed if f["axis"] != axis],
                           key=lambda f: f["height"], default=None)
                collides = (tall["id"] if (tall and h_perp > 0) else w["id"])
                reason = ("wall %s height %.1fmm cannot clear formed wall(s) "
                          "(%.1fmm) even with a gooseneck"
                          % (w["id"], w["height"], h_perp))
                per_wall[w["id"]] = {"step": step, "axis": axis,
                                     "punch_type": punch_type_goose,
                                     "needs_gooseneck": True,
                                     "collides_with": collides, "max_flange": mf_goose}
                return False, per_wall, order, reason
            per_wall[w["id"]] = {"step": step, "axis": axis, "punch_type": ptype,
                                 "needs_gooseneck": needs_gn,
                                 "collides_with": None, "max_flange": mf}
            order.append(w["id"])
            formed.append(w)
    return True, per_wall, order, ""


def solve(walls, profiles, perp_clear=None, order_rule="shorter_pair_first",
          punch_type_std="sash", punch_type_goose="gooseneck"):
    """Rectangular-pan feasibility + fold order. Tries the pair-by-pair order
    candidates; returns the first collision-free order with per-wall gooseneck
    escalation, else bendable=False with the binding reason. See module docstring."""
    groups = _by_axis(walls)
    best_fail = None
    for axis_seq in _axis_order_candidates(groups, order_rule):
        ok, per_wall, order, reason = _evaluate_order(
            axis_seq, groups, profiles, perp_clear,
            punch_type_std, punch_type_goose)
        if ok:
            return {"bendable": True, "kind": "box", "order": order,
                    "reason": "", "per_wall": per_wall}
        if best_fail is None:
            best_fail = (per_wall, order, reason)
    per_wall, order, reason = best_fail
    return {"bendable": False, "kind": "box", "order": order,
            "reason": reason or "no collision-free pan fold order exists",
            "per_wall": per_wall}


def assemble_box_geom(base_w, base_h, thickness, flat_w, flat_h, walls, solve_res):
    """Build the §7 box_geom dict (parameters only, no mesh) for the web 3-D sim.
    Merges each wall's geometry with its per_wall tooling/collision result."""
    pw = solve_res.get("per_wall", {})
    out_walls = []
    for w in walls:
        r = pw.get(w["id"], {})
        out_walls.append({
            "id": w["id"], "axis": w["axis"], "side": w.get("side", "+"),
            "height": w["height"], "width": w["width"], "offset": w.get("offset", 0.0),
            "step": r.get("step"), "angle_deg": w.get("angle", 90.0),
            "punch": r.get("punch_type"), "punch_id": w.get("punch_id"),
            "die": w.get("die_id"), "needs_gooseneck": bool(r.get("needs_gooseneck")),
            "max_flange": r.get("max_flange"),
            "collides": r.get("collides_with") is not None,
        })
    out_walls.sort(key=lambda x: (x["step"] is None, x["step"] or 0))
    return {"base": {"w": base_w, "h": base_h}, "thickness": thickness,
            "flat_w": flat_w, "flat_h": flat_h, "walls": out_walls}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "_MASTERS/fusion_scripts/CC_CheckBend" && python tests/test_box_model.py`
Expected: all `ok test_*` then `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add _MASTERS/fusion_scripts/CC_CheckBend/box_model.py _MASTERS/fusion_scripts/CC_CheckBend/tests/test_box_model.py
git commit -m "feat(checkbend): box_model.solve fold-order search + assemble_box_geom"
```

---

## Task 4: `perp_clear_mm` in `punch_profiles.json` (calibratable thresholds)

**Files:**
- Modify: `_MASTERS/standards/bend_tools/punch_profiles.json`
- Test: `_MASTERS/fusion_scripts/CC_CheckBend/tests/test_box_model.py` (append one case)

The perpendicular-clearance thresholds belong with the punch silhouettes (the same provenance as the march polygons), so `box_model` can read them per profile instead of relying on the hardcoded `DEFAULT_PERP_CLEAR`. Add a loader.

- [ ] **Step 1: Write the failing test (append before `__main__` in `tests/test_box_model.py`)**

```python
def test_perp_clear_loaded_from_profiles():
    data = _profiles()
    pc = box_model.perp_clear_from_profiles(data)
    # both punch types present, gooseneck clears more than the straight punch
    assert "gooseneck" in pc and "sash" in pc
    assert pc["gooseneck"] > pc["sash"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "_MASTERS/fusion_scripts/CC_CheckBend" && python tests/test_box_model.py`
Expected: FAIL — `AttributeError: module 'box_model' has no attribute 'perp_clear_from_profiles'`.

- [ ] **Step 3a: Add `perp_clear_mm` to each profile in `punch_profiles.json`**

In `sash88`, after `"tip_radius_mm": 0.2,` add:
```json
      "perp_clear_mm": 12.0,
```
In `gooseneck88`, after `"tip_radius_mm": 0.8,` add:
```json
      "perp_clear_mm": 42.0,
```
(Seed values — recalibrated with เอ๋ in Task 5. The gooseneck throat in its silhouette spans ~42 mm; a straight sash punch clears only a short formed wall before its flat flank hits.)

- [ ] **Step 3b: Add the loader to `box_model.py`** (append after `perp_clear_check`):
```python
def perp_clear_from_profiles(profiles, punch_type_std="sash",
                             punch_type_goose="gooseneck"):
    """Read perp_clear_mm out of punch_profiles.json into a {type: mm} table for
    perp_clear_check / solve. Falls back to DEFAULT_PERP_CLEAR per type when a
    profile omits it."""
    profs = profiles.get("profiles", {})
    std = profs.get("sash88", {}).get("perp_clear_mm",
                                      DEFAULT_PERP_CLEAR["sash"])
    goose = profs.get("gooseneck88", {}).get("perp_clear_mm",
                                             DEFAULT_PERP_CLEAR["gooseneck"])
    return {"standard": std, "sash": std, "gooseneck": goose}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "_MASTERS/fusion_scripts/CC_CheckBend" && python tests/test_box_model.py`
Expected: all `ok test_*` then `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add _MASTERS/standards/bend_tools/punch_profiles.json _MASTERS/fusion_scripts/CC_CheckBend/box_model.py _MASTERS/fusion_scripts/CC_CheckBend/tests/test_box_model.py
git commit -m "feat(checkbend): perp_clear_mm thresholds in punch_profiles + box_model loader"
```

---

## Task 5: Calibrate `box_model` against เอ๋ (order rule + clearance threshold)

**Files:**
- Create: `_MASTERS/fusion_scripts/CC_CheckBend/tests/test_box_model_calib.py`
- Modify (if เอ๋'s answers require): `_MASTERS/standards/bend_tools/punch_profiles.json`, `_MASTERS/fusion_scripts/CC_CheckBend/box_model.py` (`order_rule` default)

This is the calibration analogue of `test_max_flange.py` (which pinned 42.86 / 53.19). It encodes เอ๋'s shop judgement as a regression test so future edits can't silently break it. **Communicate with เอ๋ using images** (per `feedback_communicate_with_images`): show the candidate fold order + which walls get a gooseneck as a labelled diagram/screenshot before pinning numbers.

- [ ] **Step 1: Ask เอ๋ the two open calibration questions** (use `AskUserQuestion`):
  - Order rule: when both pairs differ in height, bend the **shorter** pair first (default) or the **taller** pair first? (Show the consequence: which pair ends up needing a gooseneck.)
  - Perpendicular-clearance threshold: at what already-formed perpendicular-wall **height (mm)** does a straight/sash punch stop clearing and a gooseneck become necessary? (Anchor with the real punch heights: #109 H95, #202 sash H130, gooseneck #453 H90; throat ≈ the gooseneck `perp_clear_mm`.)

- [ ] **Step 2: Write the calibration test from เอ๋'s answers + test v1's known geometry**

Create `tests/test_box_model_calib.py` (fill the `EAE_*` constants from เอ๋'s answers + the test-v1 wall heights captured live in Task 7; the structure below pins test v1 = **bendable, all standard, no gooseneck**, which must hold regardless of the exact threshold because its walls are 5/14 mm):
```python
# -*- coding: utf-8 -*-
"""Calibration regression for box_model — pins เอ๋'s shop judgement.
Run: python tests/test_box_model_calib.py"""
import os, sys
_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_DIR))
import box_model, max_flange

_PROFILES = os.path.normpath(os.path.join(
    _DIR, "..", "..", "..", "standards", "bend_tools", "punch_profiles.json"))

# test v1: 8 bends = 4 axis-X + 4 axis-Y, walls 5/14 mm on a ~300mm pan floor.
# (legs 7/18/300/18/7 -> two wall heights 5 and 14 after bend region.)
TESTV1 = (
    [{"id": "X+", "axis": "X", "side": "+", "height": 14.0, "width": 300.0,
      "offset": 0.0, "inside_radius": 1.0, "angle": 90.0, "base_cl": 300.0},
     {"id": "X-", "axis": "X", "side": "-", "height": 14.0, "width": 300.0,
      "offset": 0.0, "inside_radius": 1.0, "angle": 90.0, "base_cl": 300.0},
     {"id": "Y+", "axis": "Y", "side": "+", "height": 5.0, "width": 300.0,
      "offset": 0.0, "inside_radius": 1.0, "angle": 90.0, "base_cl": 300.0},
     {"id": "Y-", "axis": "Y", "side": "-", "height": 5.0, "width": 300.0,
      "offset": 0.0, "inside_radius": 1.0, "angle": 90.0, "base_cl": 300.0}])


def test_testv1_bendable_all_standard():
    data = max_flange.load_profiles(_PROFILES)
    pc = box_model.perp_clear_from_profiles(data)
    r = box_model.solve(TESTV1, data, perp_clear=pc)
    assert r["bendable"] is True, r["reason"]
    assert all(not w["needs_gooseneck"] for w in r["per_wall"].values()), \
        "test v1 (5/14mm walls) must NOT need a gooseneck"
    print("  test v1: bendable, order=%s, no gooseneck OK" % r["order"])


if __name__ == "__main__":
    test_testv1_bendable_all_standard()
    print("ALL PASS")
```

- [ ] **Step 3: If เอ๋'s answers differ from the seeds, update them**
  - Order rule → change `solve(..., order_rule=...)` default in `box_model.py`.
  - Threshold → update `perp_clear_mm` in `punch_profiles.json`.
  Re-run both `tests/test_box_model.py` and `tests/test_box_model_calib.py`.

- [ ] **Step 4: Run both tests to verify they pass**

Run: `cd "_MASTERS/fusion_scripts/CC_CheckBend" && python tests/test_box_model.py && python tests/test_box_model_calib.py`
Expected: `ALL PASS` for both.

- [ ] **Step 5: Commit**

```bash
git add _MASTERS/fusion_scripts/CC_CheckBend/tests/test_box_model_calib.py _MASTERS/fusion_scripts/CC_CheckBend/box_model.py _MASTERS/standards/bend_tools/punch_profiles.json
git commit -m "feat(checkbend): calibrate box_model order rule + perp clearance to เอ๋'s judgement"
```

---

## Task 6: `formed_collision` oracle (irregular-box fallback) + `sequence_search` regression

**Files:**
- Create: `_MASTERS/fusion_scripts/CC_CheckBend/formed_collision.py`
- Test: `_MASTERS/fusion_scripts/CC_CheckBend/tests/test_formed_collision.py`
- Test: `_MASTERS/fusion_scripts/CC_CheckBend/tests/test_sequence_search_formed.py`

`sequence_search.search(bend_ids, oracle, ...)` already passes `formed` to the oracle, so no code change there — Task 6 proves a formed-aware oracle yields order-dependence, and provides `formed_collision.make_oracle` for the action to inject Fusion geometry into. Geometry is injected as plain data so the oracle is unit-testable offline.

- [ ] **Step 1: Write the failing `sequence_search` regression test**

Create `tests/test_sequence_search_formed.py`:
```python
# -*- coding: utf-8 -*-
"""Prove sequence_search honours a FORMED-aware oracle (order-dependent).
Run: python tests/test_sequence_search_formed.py"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sequence_search as ss


def test_formed_aware_oracle_forces_pairing():
    # B3,B4 (axis Y) may only form AFTER both B1,B2 (axis X) are up
    xset = {"B1", "B2"}
    def oracle(formed, nxt):
        if nxt in ("B3", "B4"):
            return not xset.issubset(formed)   # collide until X pair formed
        return False
    r = ss.search(["B1", "B2", "B3", "B4"], oracle, node_budget=5000)
    assert r["bendable"] is True
    o = r["order"]
    assert o.index("B1") < o.index("B3")
    assert o.index("B2") < o.index("B3")
    assert o.index("B1") < o.index("B4")
    assert o.index("B2") < o.index("B4")


if __name__ == "__main__":
    test_formed_aware_oracle_forces_pairing()
    print("ALL PASS")
```

- [ ] **Step 2: Run it to verify it passes immediately** (sequence_search already supports this — this is a guard test, not a red test)

Run: `cd "_MASTERS/fusion_scripts/CC_CheckBend" && python tests/test_sequence_search_formed.py`
Expected: `ALL PASS`. (If it fails, sequence_search regressed — fix there.)

- [ ] **Step 3: Write the failing `formed_collision` test**

Create `tests/test_formed_collision.py`:
```python
# -*- coding: utf-8 -*-
"""Offline collide/clear tests for the formed-aware oracle. Geometry injected as
plain vertex lists (cm) so no Fusion is needed. Run: python tests/test_formed_collision.py"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import formed_collision
import geom3d


def _aabb_tris(lo, hi):
    """8 corners of an AABB as a couple of triangles per face (enough for the
    edge-pierces-face tri-tri test). Minimal: return the AABB itself; the oracle
    uses AABB overlap for formed walls in the MVP."""
    return geom3d.AABB(lo, hi)


def test_clear_when_far_apart():
    # next bend's moving side is far from every formed wall + the tool
    geom = {
        "moving_aabb": {"B2": geom3d.AABB((5, 0, 0), (6, 1, 1))},
        "formed_aabb": {"B1": geom3d.AABB((0, 0, 0), (1, 1, 1))},
        "tool_aabb":   {"B2": geom3d.AABB((5, 0, 2), (6, 1, 3))},
    }
    oracle = formed_collision.make_oracle(geom, tol_cm=0.0)
    assert oracle(frozenset({"B1"}), "B2") is False


def test_collide_when_moving_overlaps_formed():
    geom = {
        "moving_aabb": {"B2": geom3d.AABB((0.5, 0, 0), (1.5, 1, 1))},  # overlaps B1
        "formed_aabb": {"B1": geom3d.AABB((0, 0, 0), (1, 1, 1))},
        "tool_aabb":   {"B2": geom3d.AABB((5, 0, 2), (6, 1, 3))},
    }
    oracle = formed_collision.make_oracle(geom, tol_cm=0.0)
    assert oracle(frozenset({"B1"}), "B2") is True


def test_no_formed_walls_uses_tool_only():
    geom = {
        "moving_aabb": {"B1": geom3d.AABB((0, 0, 0), (1, 1, 1))},
        "formed_aabb": {},
        "tool_aabb":   {"B1": geom3d.AABB((0.5, 0, 0), (1.5, 1, 1))},  # tool overlaps
    }
    oracle = formed_collision.make_oracle(geom, tol_cm=0.0)
    assert oracle(frozenset(), "B1") is True


if __name__ == "__main__":
    for n, fn in sorted(globals().items()):
        if n.startswith("test_") and callable(fn):
            fn(); print("ok", n)
    print("ALL PASS")
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd "_MASTERS/fusion_scripts/CC_CheckBend" && python tests/test_formed_collision.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'formed_collision'`.

- [ ] **Step 5: Write minimal implementation**

Create `formed_collision.py`:
```python
# -*- coding: utf-8 -*-
"""Formed-aware collision oracle for the irregular-box fallback (design §6).

The MVP oracle: forming bend `next` collides if its moving side overlaps (a) the
assigned tool for `next`, or (b) ANY wall already formed in this order. Geometry
is injected as AABBs (cm) keyed by bend id so this is pure + unit-tested offline;
the action builds the AABBs from real Fusion geometry, reorienting/translating
the tool to each bend's axis (the P2 'tool translated +Z only' limit is lifted
per-bend by the caller passing a per-bend tool AABB).

This is intentionally AABB-level (broad phase) like P2 — the tri-tri narrow phase
in collision_core can be layered in later behind the same oracle interface; for
the irregular fallback (rare in kitchen work; rectangular pans use box_model) the
AABB oracle is the pragmatic first cut."""


def make_oracle(geom, tol_cm=0.0):
    """geom = {moving_aabb:{id:AABB}, formed_aabb:{id:AABB}, tool_aabb:{id:AABB}}.
    Returns oracle(formed_frozenset, next_id) -> True if forming next_id now
    collides with its tool or any already-formed wall."""
    moving = geom.get("moving_aabb", {})
    formed_a = geom.get("formed_aabb", {})
    tool = geom.get("tool_aabb", {})

    def oracle(formed, next_id):
        mv = moving.get(next_id)
        if mv is None:
            return False
        t = tool.get(next_id)
        if t is not None and mv.overlap(t, tol_cm):
            return True
        for fid in formed:
            fa = formed_a.get(fid)
            if fa is not None and mv.overlap(fa, tol_cm):
                return True
        return False

    return oracle
```

- [ ] **Step 6: Verify `geom3d.AABB.overlap` signature matches**

Run: `cd "_MASTERS/fusion_scripts/CC_CheckBend" && python -c "import geom3d, inspect; print(inspect.signature(geom3d.AABB.overlap))"`
Expected: prints a signature accepting `(self, other, tol)` (the P2 `overlap(tol)` = penetration on every axis). If the parameter name differs, adjust the `mv.overlap(...)` calls in `formed_collision.py` accordingly.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd "_MASTERS/fusion_scripts/CC_CheckBend" && python tests/test_formed_collision.py && python tests/test_sequence_search_formed.py`
Expected: `ALL PASS` for both.

- [ ] **Step 8: Commit**

```bash
git add _MASTERS/fusion_scripts/CC_CheckBend/formed_collision.py _MASTERS/fusion_scripts/CC_CheckBend/tests/test_formed_collision.py _MASTERS/fusion_scripts/CC_CheckBend/tests/test_sequence_search_formed.py
git commit -m "feat(checkbend): formed-aware collision oracle (irregular box) + sequence_search regression"
```

---

## Task 7: Extend `web_push.build_record` with `box=` (box fields + box_geom + legs=null)

**Files:**
- Modify: `_MASTERS/fusion_scripts/CC_CheckBend/web_push.py`
- Test: `_MASTERS/fusion_scripts/CC_CheckBend/tests/test_web_push_box.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_web_push_box.py`:
```python
# -*- coding: utf-8 -*-
"""Offline tests for web_push.build_record box extension. Run: python tests/test_web_push_box.py"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import web_push
import bend_extractor


def _b(id):
    return bend_extractor.Bend(id, 1.0, 90.0, 300.0, 14.0)


def _results():
    r = {"ok": True, "reasons": [], "v_required_mm": 8.0, "tonnage_kN": 50.0}
    return [(_b("B1"), dict(r)), (_b("B3"), dict(r))]


def _box():
    return {
        "bendable": True,
        "order": ["B1", "B3"],
        "reason": "",
        "per_wall": {
            "B1": {"step": 1, "axis": "X", "punch_type": "standard",
                   "needs_gooseneck": False, "collides_with": None, "max_flange": None},
            "B3": {"step": 2, "axis": "Y", "punch_type": "gooseneck",
                   "needs_gooseneck": True, "collides_with": None, "max_flange": 42.0},
        },
        "box_geom": {"base": {"w": 300.0, "h": 300.0}, "thickness": 1.0,
                     "flat_w": 328.0, "flat_h": 310.0, "walls": []},
    }


def test_box_record_kind_and_legs():
    rec = web_push.build_record(_results(), None, None, None, "2026-06-03T10:00",
                                thickness=1.0, flat_length=328.0,
                                legs=[1, 2, 3], box=_box())
    assert rec["kind"] == "box"
    assert rec["bendable"] is True
    assert rec["legs"] is None                 # boxes force legs=null
    assert rec["order"] == ["B1", "B3"]
    assert "box_geom" in rec and rec["box_geom"]["base"]["w"] == 300.0


def test_box_per_bend_enriched():
    rec = web_push.build_record(_results(), None, None, None, "2026-06-03T10:00",
                                thickness=1.0, box=_box())
    by_id = {e["bend"]: e for e in rec["per_bend"]}
    assert by_id["B1"]["axis"] == "X"
    assert by_id["B1"]["step"] == 1
    assert by_id["B1"]["needs_gooseneck"] is False
    assert by_id["B3"]["punch_type"] == "gooseneck"
    assert by_id["B3"]["needs_gooseneck"] is True
    assert by_id["B3"]["max_flange"] == 42.0


def test_linear_record_unchanged_when_box_none():
    rec = web_push.build_record(_results(), None, None, None, "2026-06-03T10:00",
                                thickness=1.0, legs=[1, 2, 3])
    assert rec["kind"] in ("found", "impossible")
    assert rec["legs"] == [1, 2, 3]            # linear path keeps legs
    assert "box_geom" not in rec
    assert "axis" not in rec["per_bend"][0]


if __name__ == "__main__":
    for n, fn in sorted(globals().items()):
        if n.startswith("test_") and callable(fn):
            fn(); print("ok", n)
    print("ALL PASS")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "_MASTERS/fusion_scripts/CC_CheckBend" && python tests/test_web_push_box.py`
Expected: FAIL — `TypeError: build_record() got an unexpected keyword argument 'box'`.

- [ ] **Step 3: Edit `web_push.build_record`**

Change the signature (line 22-24) to add `box=None` at the end:
```python
def build_record(results, collisions, tool_by_bend, search_res, checked_at,
                 checked_by="fusion", thickness=None, flat_length=None, legs=None,
                 max_flange_by_bend=None, box=None):
```

Then, immediately before the final `return { ... }` (line 90), insert the box override block, and change the function to build the dict into a variable so it can be patched:

Replace the closing `return {` ... `}` (lines 90-106) with:
```python
    rec = {
        "bendable": bendable,
        "kind": kind,
        "order": order,
        "n_bends": len(results),
        "n_problems": n_problems,
        "reason": reason,
        "per_bend": per_bend,
        "thickness": thickness,
        "flat_length": flat_length,
        "legs": legs,
        "checked_at": checked_at,
        "checked_by": checked_by,
    }
    if box is not None:
        # Box/pan part: override the linear verdict with box_model's result, force
        # legs=null (a pan unfolds to a 2-D cross, not a 1-D leg sequence), enrich
        # per_bend with axis/step/punch_type/needs_gooseneck/collides_with, and
        # attach box_geom so the web can synthesize + animate the 3-D fold.
        rec["kind"] = "box"
        rec["bendable"] = bool(box.get("bendable"))
        rec["order"] = list(box.get("order", []))
        rec["legs"] = None
        rec["reason"] = "" if rec["bendable"] else (box.get("reason", "") or
                                                    "no collision-free pan fold order exists")
        per_wall = box.get("per_wall", {})
        for entry in rec["per_bend"]:
            w = per_wall.get(entry["bend"])
            if not w:
                continue
            entry["axis"] = w.get("axis")
            entry["step"] = w.get("step")
            entry["punch_type"] = w.get("punch_type")
            entry["needs_gooseneck"] = bool(w.get("needs_gooseneck"))
            entry["collides_with"] = w.get("collides_with")
            if w.get("max_flange") is not None:
                entry["max_flange"] = w.get("max_flange")
        rec["box_geom"] = box.get("box_geom")
    return rec
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "_MASTERS/fusion_scripts/CC_CheckBend" && python tests/test_web_push_box.py`
Expected: all `ok test_*` then `ALL PASS`.

- [ ] **Step 5: Run the existing web_push test to confirm no regression**

Run: `cd "_MASTERS/fusion_scripts/CC_CheckBend" && python tests/test_web_push.py`
Expected: `ALL PASS` (linear path unchanged).

- [ ] **Step 6: Commit**

```bash
git add _MASTERS/fusion_scripts/CC_CheckBend/web_push.py _MASTERS/fusion_scripts/CC_CheckBend/tests/test_web_push_box.py
git commit -m "feat(checkbend): web_push.build_record box= extension (box_geom, legs=null, per-bend axis/step)"
```

---

## Task 8: Action wiring — box_detect branch, wall extraction, dispatch, push

**Files:**
- Modify: `_MASTERS/fusion_scripts/CC_CheckBend/CC_CheckBend_action.py`

This is the only adsk task; it has no offline unit test (verified live in Task 9 via Fusion MCP). It must leave the **linear** path byte-for-byte equivalent — the box branch only activates when `box_detect.detect(...)["is_box"]`.

- [ ] **Step 1: Register the new modules for import + reload**

In the import block (line 13-14), add `box_detect`, `box_model`, `formed_collision`:
```python
import tri3, mesh_extract, sequence_search, web_push, amada_tools
import max_flange as max_flange_mod
import box_detect, box_model, formed_collision
```
In the `importlib.reload` loop inside `run()` (line 249-253), append them so dev edits pick up on each click:
```python
        for _m in (bend_math, cc_config, bend_extractor, report,
                   geom3d, fold, collision_core, bend_graph, tool_select,
                   tool_library, tool_match, tri3, mesh_extract,
                   sequence_search, web_push, amada_tools, max_flange_mod,
                   box_detect, box_model, formed_collision):
            importlib.reload(_m)
```

- [ ] **Step 2: Add a wall-extraction helper** (adsk; insert after `_flat_pattern_info`, before `def run`):
```python
def _extract_walls(body, bends, tool_by_bend, base_cl_default):
    """Build box_model wall dicts from the folded body (adsk). For each bend the
    rising wall = its free (non-shared) flange face; height = that face's
    perpendicular extent (mm); width = bend_length; side/offset from the wall
    face centroid relative to the base face centre; base_cl = the pan-floor span
    perpendicular to the wall (proxied by base_cl_default = longest base extent).
    axis label 'X'/'Y' from box_detect's axis index."""
    det = box_detect.detect(bends)
    axis_label = {0: "X", 1: "Y"}
    # base face = largest planar face; its centre seeds side/offset
    base = bend_graph.largest_planar_face(body)
    bc = None
    if base is not None:
        bb = base.boundingBox
        bc = (0.5 * (bb.minPoint.x + bb.maxPoint.x),
              0.5 * (bb.minPoint.y + bb.maxPoint.y),
              0.5 * (bb.minPoint.z + bb.maxPoint.z))
    walls = []
    for b in bends:
        ai = det["axis_of"].get(b.id, 0)
        axis = axis_label.get(ai, "X")
        # rising wall = the smaller-extent / free flange face
        ea = _face_extent_mm(b.face_a, b.axis_dir)
        eb = _face_extent_mm(b.face_b, b.axis_dir)
        if ea is None and eb is None:
            height = b.flange_length_mm
            wall_face = b.face_a or b.face_b
        elif eb is None or (ea is not None and ea <= eb):
            height, wall_face = ea, b.face_a
        else:
            height, wall_face = eb, b.face_b
        # side/offset from the wall face centroid vs base centre, along the
        # perpendicular (non-axis) horizontal direction
        side, offset = "+", 0.0
        if wall_face is not None and bc is not None:
            wbb = wall_face.boundingBox
            wc = (0.5 * (wbb.minPoint.x + wbb.maxPoint.x),
                  0.5 * (wbb.minPoint.y + wbb.maxPoint.y),
                  0.5 * (wbb.minPoint.z + wbb.maxPoint.z))
            # perpendicular horizontal axis = cross(axis_dir, world up Z)
            ad = b.axis_dir or (1.0, 0.0, 0.0)
            perp = (ad[1] * 1.0 - ad[2] * 0.0,
                    ad[2] * 0.0 - ad[0] * 1.0,
                    ad[0] * 0.0 - ad[1] * 0.0)
            d = ((wc[0] - bc[0]) * perp[0] + (wc[1] - bc[1]) * perp[1]
                 + (wc[2] - bc[2]) * perp[2])
            side = "+" if d >= 0 else "-"
            offset = round(abs(d) * 10.0, 2)
        t = tool_by_bend.get(b.id)
        walls.append({
            "id": b.id, "axis": axis, "side": side,
            "height": round(height, 2) if height is not None else b.flange_length_mm,
            "width": round(b.bend_length_mm, 2), "offset": offset,
            "inside_radius": round(b.inside_radius_mm, 3), "angle": b.angle_deg,
            "base_cl": base_cl_default,
            "punch_id": getattr(t, "punch_id", None) if t else None,
            "die_id": getattr(t, "die_id", None) if t else None,
            "v": getattr(t, "v", None) if t else None,
        })
    return walls, det
```

- [ ] **Step 3: Branch the publish block on box vs linear**

In `run()`, the publish block (lines 401-423) currently always builds a linear record. Wrap it so a box part builds + pushes a `box` record instead. Replace the body of the `try:` (lines 404-421, from `import datetime` through `web_push.push(code, rec)`) with:
```python
            import datetime
            code = web_push.safe_code(comp.name)
            checked_at = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M")
            flat_length, flat_thick, legs = _flat_pattern_info(comp)
            thk = flat_thick if flat_thick else round(thickness_mm, 2)
            prof_path = os.path.normpath(os.path.join(
                _DIR, "..", "..", "standards", "bend_tools", "punch_profiles.json"))
            profiles_data = max_flange_mod.load_profiles(prof_path)

            det = box_detect.detect(bends)
            box_payload = None
            if det["is_box"]:
                # pan-floor span (mm) ~ the body's longest horizontal extent;
                # used as each wall's base leg for the rising-wall march + inside width
                bb = body.boundingBox
                exts = sorted([(bb.maxPoint.x - bb.minPoint.x),
                               (bb.maxPoint.y - bb.minPoint.y),
                               (bb.maxPoint.z - bb.minPoint.z)], reverse=True)
                base_cl_default = round(exts[0] * 10.0, 2)
                walls, _det = _extract_walls(body, bends, tool_by_bend,
                                             base_cl_default)
                pc = box_model.perp_clear_from_profiles(profiles_data)
                if det["kind"] == "rectangular":
                    solve_res = box_model.solve(walls, profiles_data, perp_clear=pc)
                else:
                    # irregular: AABB formed-aware oracle via sequence_search.
                    # Fall back to box_model's verdict shape so the web still
                    # renders; the order comes from the search.
                    geom = _build_formed_geom(body, bends, tool_by_bend)
                    oracle = formed_collision.make_oracle(geom,
                                                          tol_cm=cfg["collision_tol_mm"] / 10.0)
                    sr = sequence_search.search([b.id for b in bends], oracle,
                                                node_budget=cfg["search_node_budget"])
                    solve_res = {"bendable": sr["bendable"], "kind": "box",
                                 "order": sr["order"],
                                 "reason": ("" if sr["bendable"]
                                            else "no collision-free order (irregular box)"),
                                 "per_wall": {w["id"]: {
                                     "step": (sr["order"].index(w["id"]) + 1
                                              if w["id"] in sr["order"] else None),
                                     "axis": w["axis"], "punch_type": "gooseneck",
                                     "needs_gooseneck": True, "collides_with": None,
                                     "max_flange": None} for w in walls}}
                base_w = base_cl_default
                base_h = round(exts[1] * 10.0, 2)
                box_geom = box_model.assemble_box_geom(
                    base_w, base_h, thk, flat_length or base_w,
                    base_h, walls, solve_res)
                box_payload = {"bendable": solve_res["bendable"],
                               "order": solve_res["order"],
                               "reason": solve_res.get("reason", ""),
                               "per_wall": solve_res["per_wall"],
                               "box_geom": box_geom}

            max_flange_by_bend = _compute_max_flange(
                bends, tool_by_bend, thk, profiles_data)
            rec = web_push.build_record(
                results, collisions, tool_by_bend, search_res, checked_at,
                checked_by="fusion", thickness=thk,
                flat_length=flat_length, legs=legs,
                max_flange_by_bend=max_flange_by_bend, box=box_payload)
            web_push.push(code, rec)
```

- [ ] **Step 4: Add the `_build_formed_geom` helper for the irregular branch** (insert after `_extract_walls`):
```python
def _build_formed_geom(body, bends, tool_by_bend):
    """AABBs (cm) for the formed-aware oracle: each bend's moving side, its final
    formed wall, and its tool. MVP: moving side = formed-side vertex AABB; formed
    wall = the same AABB (the wall stands where its moving side ends up); tool =
    a synthesized punch AABB over the bend axis. Good enough for the rare
    irregular-box fallback; rectangular pans use box_model (analytic)."""
    adj = bend_graph.build_adjacency(body)
    fixed = bend_graph.largest_planar_face(body)
    moving_aabb, formed_aabb, tool_aabb = {}, {}, {}
    for b in bends:
        faces = bend_graph.moving_side_faces(adj, b, fixed)
        verts = bend_graph.faces_vertices(faces)
        if verts:
            ab = geom3d.AABB.from_points(verts)
            moving_aabb[b.id] = ab
            formed_aabb[b.id] = ab
        t = tool_by_bend.get(b.id)
        pr = getattr(t, "v", None) or 8.0
        lohi = amada_tools.punch_aabb_specs(0.8, 120.0, b.bend_length_mm)
        tool_aabb[b.id] = _translate_aabb_to_axis(lohi, b.axis_origin, False)
    return {"moving_aabb": moving_aabb, "formed_aabb": formed_aabb,
            "tool_aabb": tool_aabb}
```

- [ ] **Step 5: Syntax-check the action offline** (it imports adsk, so only compile-check):

Run: `cd "_MASTERS/fusion_scripts/CC_CheckBend" && python -c "import ast; ast.parse(open('CC_CheckBend_action.py', encoding='utf-8').read()); print('syntax OK')"`
Expected: `syntax OK`.

- [ ] **Step 6: Commit**

```bash
git add _MASTERS/fusion_scripts/CC_CheckBend/CC_CheckBend_action.py
git commit -m "feat(checkbend): action box branch — detect, extract walls, box_model/formed dispatch, push box record"
```

---

## Task 9: Live verification on test v1 (Fusion MCP) + push real box record + ping G2

**Files:** none (verification + coordination)

- [ ] **Step 1: Confirm test v1 is the active doc + has a flat pattern**

Via Fusion MCP (`mcp__Autodesk_Fusion__fusion_mcp_execute`), read the active document and its active component; confirm it has a body with bends on two perpendicular axes. If `flatPattern` is absent, `flat_length`/`flat_w`/`flat_h` will be None — ask เอ๋ to create a flat pattern if she wants the Flat display, but the box collision result does **not** require it (box_detect/box_model run on the folded body).

- [ ] **Step 2: Dry-run the box pipeline through Fusion MCP** (read-only — do NOT trigger a Fusion save, per `feedback_user_saves`):

Use the Thai-OneDrive-path gotcha workaround. Execute in Fusion:
```python
import ctypes, sys
short = ctypes.windll.kernel32.GetShortPathNameW
DIR = short(r"C:\Users\wutti\OneDrive\เดสก์ท็อป\Work\Stainless Kitchen\_MASTERS\fusion_scripts\CC_CheckBend", None, 0)
buf = ctypes.create_unicode_buffer(DIR)
short(r"C:\Users\wutti\OneDrive\เดสก์ท็อป\Work\Stainless Kitchen\_MASTERS\fusion_scripts\CC_CheckBend", buf, DIR)
sys.path.insert(0, buf.value)
import adsk.core, adsk.fusion, importlib
import bend_extractor, box_detect, box_model, max_flange as mf
for m in (bend_extractor, box_detect, box_model, mf):
    importlib.reload(m)
app = adsk.core.Application.get()
design = adsk.fusion.Design.cast(app.activeProduct)
comp = design.activeComponent
body = comp.bRepBodies.item(0)
bends = bend_extractor.extract_bends(body)
det = box_detect.detect(bends)
app.log("kind=%s nbends=%d axes=%d" % (det["kind"], len(bends), len(det["axes"])))
```
Expected log: `kind=rectangular nbends=8 axes=2` (test v1 = 4 axis-X + 4 axis-Y). If `kind` is `irregular` or `nbends != 8`, inspect the axis grouping (`det["axis_of"]`) and the `PERP_DOT_TOL` — capture a screenshot of the result for เอ๋.

- [ ] **Step 3: Run the full CC_CheckBend button** (เอ๋ clicks the ribbon button, or trigger the action) and verify the pushed record:

After the run, GET the record and confirm the box shape:
```bash
curl -s "https://kitchen-drawings-default-rtdb.asia-southeast1.firebasedatabase.app/bend_sim/test%20v1.json"
```
Expected: `"kind":"box"`, `"legs":null`, `"box_geom"` present with `walls[]` carrying `axis`/`side`/`height`/`step`/`punch`/`needs_gooseneck`, `"bendable":true`, no `needs_gooseneck` (5/14 mm walls). Capture the JSON + a web screenshot.

- [ ] **Step 4: Verify the web didn't regress on a linear part**

Re-run CC_CheckBend on a known linear part (e.g. the #202 channel or `SD00NA-080000`) and confirm its record is still `kind` ∈ {found, impossible}, `legs` is the mould-line array (not null), and no `box_geom`. (Regression guard for Task 8's branch.)

- [ ] **Step 5: Ping G2 on the coordination board**

`git pull --rebase origin main` in `drawings-ui`, append ONE entry to `docs/coordination/group-sync.md` (template at its top): announce the first real `box` record is live at `bend_sim/test v1` (and any 2nd pan), paste the `box_geom` shape G2 will read, confirm `legs=null` for boxes + linear parts untouched, and that simbend-3d.js can now be built test-driven against the real record. `git add` only that file, commit, push (rebase + retry if rejected).

- [ ] **Step 6: Update memory**

Update `reference_cc_checkbend.md` with a "BOX-BENDING" section (box_detect/box_model/formed_collision, the calibrated perp_clear + order rule, the `box` record contract) and shorten the MEMORY.md index line if needed (it's over the size warning). Record the test v1 calibration result.

---

## Self-review notes (spec coverage)

- Spec §3 Hybrid: rectangular→`box_model` (Tasks 2-5), irregular→`formed_collision`+`sequence_search` (Task 6), linear untouched (Tasks 7-8 gate on `is_box`). ✅
- Spec §5 box model checks 1/2/3: `rising_wall_check` / `perp_clear_check` / `punch_length_check` (Task 2), auto-gooseneck escalation + order rule (Task 3), calibration (Task 5). ✅
- Spec §6 formed-aware oracle + (per-bend) tool reorient: `formed_collision` + `_build_formed_geom` per-bend tool AABB (Task 6, 8). ✅ (AABB-level MVP; tri-tri narrow phase noted as a later layer behind the same interface.)
- Spec §7 contract (`kind:"box"`, `legs:null`, box `per_bend` fields, `box_geom`): `web_push` Task 7 + `assemble_box_geom` Task 3. ✅
- Spec §9 components table: box_detect / box_model / formed_collision / sequence_search(regression) / web_push / action — all present. ✅
- Spec §10 testing: offline tests per module + calibration + linear regression (Task 7 step 5, Task 9 step 4) + live (Task 9). ✅
- Spec §11 open questions: order rule + perp threshold asked + calibrated in Task 5; `flat_length` kept as longest dim with `box_geom.base` carrying real W×H (Task 8). ✅
- Spec §8 simbend-3d.js is **Group 2's** deliverable (built test-driven once box records flow — confirmed on the board); out of scope for this G1 plan.
