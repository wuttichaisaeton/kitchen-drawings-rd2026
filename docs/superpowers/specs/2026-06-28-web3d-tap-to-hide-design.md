# Web 3D viewer — tap-to-hide parts — design

**Date:** 2026-06-28
**Author:** RD 13 (Group 2 / Web)
**Status:** approved by เอ๋ 2026-06-28

## Goal

เอ๋ wants to hide specific parts from the web 3D (🧊) viewer **without re-exporting from
Fusion** — a web-side override the owner controls directly. (The Fusion-side hide fix
`occ.isVisible` in CC_Export3D, commit e0bfc4b, still applies on the next export; this is an
independent, immediate, web-only layer that does NOT depend on Fusion.)

Trigger: เอ๋ couldn't get the Fusion re-export to drop hidden side-panels, and I cannot drive
Fusion from here (MCP disconnected). So the reliable path is a web 3D "tap a part → hide it".

## Decisions (locked with เอ๋)

- **Tap-to-hide**, built on the existing raycast pick (`_pickAndIsolate`, app.js ~4512).
- **Hide by part CODE** (the `_extractPartLabel(node.name)` label), so all instances of that
  code hide and the rule is stable across re-exports (node names carry volatile _2/_3 suffixes;
  codes don't).
- **Shared via RTDB** → every device, including the workshop, applies the hidden set (the whole
  point: declutter the workshop view).
- **Admin-only** toggles hide/restore; workers are view-only (they just see the result).
- Coexists with the Fusion `isVisible` fix (web override is additive).

## Architecture

One new concern — a per-GLB hidden-code set — wired into the existing 3D viewer in `app.js`
(`_kdOpen3D` and its inner `_pickAndIsolate` / `applyExplode`). No editor/`main.jsx` change.

### Data
- RTDB path **`glb_hidden/<key>`** = array of part codes (labels) to hide, where `<key>` is the
  GLB code being viewed (the `code` arg to `_kdOpen3D`), sanitized for RTDB (replace any of
  ``. # $ [ ] /`` with `_`; spaces/hyphens are allowed so "02 Wipha-L" is fine).
- In-memory: `Set` of hidden labels for the open viewer.

### Pure helper (testable)
`_glbHiddenKey(code)` → sanitized RTDB key. Unit-tested.
The add/remove/has set ops are trivial `Set` usage; the label match reuses `_extractPartLabel`.

### Load + apply
1. On `_kdOpen3D(code)`, after `explodeUnits` are built, fetch `glb_hidden/<key>` once
   (`firebaseDB.ref(...).once('value')`) into `hiddenSet`.
2. `_applyHidden()` walks `explodeUnits`; for each unit whose `_extractPartLabel(unit.node.name)`
   ∈ `hiddenSet`, set the unit's mesh subtree `.visible = false` and mark the unit so explode /
   isolate / fit logic skips it. Call `_applyHidden()` **after** `applyExplode()` and after any
   re-render, so hidden parts never reappear on explode-% change, mode switch, or reload.
3. The overlay parts list (`_ovlRows`) dims/marks hidden rows (admin sees which are hidden).

### Hide interaction (admin)
- A toolbar toggle button **🙈 ซ่อนชิ้น** (admin only). State `_hideMode` (default off).
- In `_pickAndIsolate`: if `_hideMode` and a labelled part is picked → instead of isolating,
  add the label to `hiddenSet`, write RTDB, `_applyHidden()`, re-fit. If `_hideMode` is off →
  existing isolate behaviour, unchanged.
- Live RTDB subscription (`on('value')`) so a hide on เอ๋'s phone reflects on the iPad/PC viewer
  without reload (and detaches on modal close).

### Restore (admin)
- A control **"ซ่อนอยู่ N · คืนค่า"** (shown when `hiddenSet.size > 0`, admin only): opens a small
  list of hidden codes; tapping one removes it from the set + RTDB and `_applyHidden()` re-shows it.
  A "คืนทั้งหมด" clears the set.

### Non-admin
- Toggle + restore controls are not rendered for non-admins. The hidden set still loads and
  `_applyHidden()` runs → workers see the de-cluttered model. (Mirrors the role gating already
  used elsewhere via `isAdmin()`.)

## Error handling
- No `firebaseDB` / fetch fails → `hiddenSet` empty, viewer shows everything (no worse than today);
  log a warning, never throw.
- `isLightBulbOn`-style: wrap the RTDB write in try/catch + a toast on failure.
- A hidden code that no longer exists in the GLB is simply a no-op on apply.

## Testing
- **Unit (node --test):** `_glbHiddenKey` sanitization (spaces/hyphens kept; `. # $ [ ] /` → `_`),
  and a mirrored set add/remove/has + label-membership check. Pattern: `test/web3dHide.test.mjs`,
  mirroring the helper verbatim (same as `nestStockDontRecut.test.mjs`).
- **Live (Chrome MCP):** as admin open 02 Wipha-L 🧊 → toggle 🙈 → tap a part → it disappears;
  reload → still hidden; open as a worker (?role=assemble) → same part hidden, no toggle shown;
  restore → part returns. Screenshot for เอ๋.

## Files touched
- `app.js` — 3D viewer: `_glbHiddenKey` helper, hidden-set load/subscribe in `_kdOpen3D`,
  `_applyHidden()`, `_hideMode` toggle button + restore control, branch in `_pickAndIsolate`.
- `style.css` — the 🙈 toggle + restore control styling (small).
- `test/web3dHide.test.mjs` (new).
- No Fusion / editor changes.

## Out of scope (YAGNI)
- Hiding a single INSTANCE of a repeated code (we hide by code = all instances).
- Hiding in the per-part `_parts.glb` modes beyond applying the same set (same `_applyHidden`).
- Any Fusion round-trip (separate, already handled by e0bfc4b).

## Rollback
Single-commit revert; RTDB `glb_hidden/*` left harmless (ignored if the feature is gone).
