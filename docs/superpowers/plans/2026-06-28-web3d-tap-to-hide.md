# Web 3D tap-to-hide — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) — steps use `- [ ]`.

**Goal:** Admin taps a part in the web 3D (🧊) viewer to hide it; the hide is shared via RTDB so every device (incl. the workshop) stops showing it — no Fusion re-export.

**Architecture:** A per-GLB hidden-CODE set, loaded from RTDB `glb_hidden/<key>` when `_kdOpen3D(code)` opens, folded into the existing `applyExplode`/`resetExplode` visibility assignment, toggled by a new admin "🙈" button in `.kd3d-explodebar`, and written when `_pickAndIsolate` runs in hide-mode. Pure key-sanitizer is unit-tested; visual hide is verified on เอ๋'s device (model-viewer can't paint in a headless tab).

**Tech Stack:** vanilla JS (app.js), THREE via model-viewer, Firebase RTDB, `node --test`.

Spec: `docs/superpowers/specs/2026-06-28-web3d-tap-to-hide-design.md`

---

### Task 1: Pure RTDB-key sanitizer + test

**Files:**
- Modify: `app.js` (add `_glbHiddenKey` near the other `_kd3d*` helpers, ~line 2057)
- Test: `test/web3dHide.test.mjs` (create)

- [ ] **Step 1: Write the test** (`test/web3dHide.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert';

// verbatim mirror of app.js _glbHiddenKey
function _glbHiddenKey(code) {
  return String(code == null ? '' : code).replace(/[.#$\[\]/]/g, '_').trim() || 'unknown';
}

test('keeps spaces + hyphens (valid RTDB key)', () => {
  assert.equal(_glbHiddenKey('02 Wipha-L'), '02 Wipha-L');
  assert.equal(_glbHiddenKey('OTHERS-000000'), 'OTHERS-000000');
});
test('replaces RTDB-illegal chars . # $ [ ] /', () => {
  assert.equal(_glbHiddenKey('a.b#c$d[e]f/g'), 'a_b_c_d_e_f_g');
});
test('blank → unknown', () => {
  assert.equal(_glbHiddenKey(''), 'unknown');
  assert.equal(_glbHiddenKey(null), 'unknown');
});
```

- [ ] **Step 2: Run → fails** (helper only in test). `node --test test/web3dHide.test.mjs`

- [ ] **Step 3: Add `_glbHiddenKey` to app.js** (after `_kd3dPartsGlbUrl`, ~line 2063), VERBATIM same as the mirror:

```js
// RTDB key for a GLB's hidden-code set. RTDB keys forbid . # $ [ ] / — replace
// them; spaces/hyphens are allowed so "02 Wipha-L" stays readable. (เอ๋ 2026-06-28)
function _glbHiddenKey(code) {
  return String(code == null ? '' : code).replace(/[.#$\[\]/]/g, '_').trim() || 'unknown';
}
```

- [ ] **Step 4: Run → passes.** `node --check app.js && node --test test/web3dHide.test.mjs`

- [ ] **Step 5: Commit.** `git add app.js test/web3dHide.test.mjs && git commit -m "web3d: _glbHiddenKey RTDB-key sanitizer + test"`

---

### Task 2: Hidden-set state + load/subscribe in the viewer

**Files:** Modify: `app.js` — `_kdOpen3D` state block (~2978, near `explodeUnits`/`_ovlRows`) + after the model loads.

- [ ] **Step 1: Add state** next to `let explodeUnits = [];` (~2978):

```js
  let _glbHidden = new Set();      // hidden PART CODES (labels) for this GLB — shared via RTDB
  let _hideMode = false;           // admin "🙈 tap-to-hide" toggle
  let _glbHiddenRef = null;        // RTDB ref (detached on close)
  const _isUnitHidden = (u) => { try { return _glbHidden.has(_extractPartLabel(u.node.name || '')); } catch { return false; } };
```

- [ ] **Step 2: Load + subscribe** — add a function (near `applyExplode`, ~4116) and call it once after `explodeUnits` are built (right after `snapshotScene` populates them — search the call site that sets `explodeUnits` from the loaded model, ~3585+, and call `_loadGlbHidden()` after it):

```js
  function _loadGlbHidden() {
    try {
      if (!window.firebaseDB) return;
      const key = _glbHiddenKey(code);
      _glbHiddenRef = window.firebaseDB.ref('glb_hidden/' + key);
      _glbHiddenRef.on('value', (snap) => {
        const v = snap.val();
        _glbHidden = new Set(Array.isArray(v) ? v : (v ? Object.values(v) : []));
        try { applyExplode(explodePct); } catch {}
        try { _renderHideUI(); } catch {}
      });
    } catch (e) { console.warn('[kd3d] glb_hidden load failed', e); }
  }
```

- [ ] **Step 3: Detach on close** — find the modal close/cleanup (where `_ovlRoot` is nulled / the modal is removed, ~3264) and add:

```js
    try { if (_glbHiddenRef) { _glbHiddenRef.off(); _glbHiddenRef = null; } } catch {}
```

- [ ] **Step 4: `node --check app.js`** (no test — integration verified live in Task 6).

- [ ] **Step 5: Commit.** `git add app.js && git commit -m "web3d: load+subscribe glb_hidden set per GLB"`

---

### Task 3: Fold hidden into visibility (applyExplode + resetExplode)

**Files:** Modify: `app.js:4126` and `app.js:4165`.

- [ ] **Step 1: applyExplode** — change the visibility line (4126) from:

```js
      u.node.visible = !_poppedCode || sel;
```
to:
```js
      u.node.visible = (!_poppedCode || sel) && !_isUnitHidden(u);
```

- [ ] **Step 2: resetExplode** — change (4165) from:

```js
      u.node.visible = true;
```
to:
```js
      u.node.visible = !_isUnitHidden(u);
```

- [ ] **Step 3: `node --check app.js`.**

- [ ] **Step 4: Commit.** `git add app.js && git commit -m "web3d: hidden parts stay hidden across explode/reset"`

---

### Task 4: 🙈 toggle + restore UI (admin) + pick-to-hide

**Files:** Modify: `app.js` — explodebar HTML (~2692), pick handler (~4512), wiring (~4323); `style.css`.

- [ ] **Step 1: Add buttons to the explodebar HTML** (~2692, after the `.kd3d-explode-info` span), admin-only:

```js
        ${isAdmin() ? '<button type="button" class="kd3d-hidebtn" title="แตะชิ้นเพื่อซ่อน / Tap a part to hide it">🙈 ซ่อน</button><button type="button" class="kd3d-restorebtn" title="คืนชิ้นที่ซ่อน" style="display:none">↺ <span class="kd3d-restoren">0</span></button>' : ''}
```

- [ ] **Step 2: Wire toggle + restore + a `_renderHideUI`** near the slider wiring (~4324):

```js
  const _hideBtn = body.querySelector('.kd3d-hidebtn');
  const _restoreBtn = body.querySelector('.kd3d-restorebtn');
  function _saveGlbHidden() {
    try { if (window.firebaseDB) window.firebaseDB.ref('glb_hidden/' + _glbHiddenKey(code)).set([..._glbHidden]); }
    catch (e) { try { _kdToast && _kdToast('Save failed'); } catch {} }
  }
  function _renderHideUI() {
    if (_hideBtn) _hideBtn.classList.toggle('is-on', _hideMode);
    if (_restoreBtn) {
      _restoreBtn.style.display = _glbHidden.size ? '' : 'none';
      const n = _restoreBtn.querySelector('.kd3d-restoren'); if (n) n.textContent = String(_glbHidden.size);
    }
  }
  if (_hideBtn) _hideBtn.addEventListener('click', () => { _hideMode = !_hideMode; _renderHideUI(); });
  if (_restoreBtn) _restoreBtn.addEventListener('click', () => {
    if (!_glbHidden.size) return;
    _glbHidden.clear(); _saveGlbHidden(); applyExplode(explodePct); _renderHideUI();
    try { _kdToast && _kdToast('คืนชิ้นที่ซ่อนแล้ว'); } catch {}
  });
  _renderHideUI();
```

- [ ] **Step 3: Branch `_pickAndIsolate`** — at the top of the labelled-part section (after `if (!label || ...) return;`, ~4542), before the isolate code:

```js
    if (_hideMode && isAdmin()) {
      _glbHidden.add(label); _saveGlbHidden();
      applyExplode(explodePct);
      requestAnimationFrame(() => _fitVisibleWorld());
      _renderHideUI();
      return;
    }
```

- [ ] **Step 4: style.css** — add near the other 3D-modal rules:

```css
.kd3d-modal .kd3d-explodebar .kd3d-hidebtn,
.kd3d-modal .kd3d-explodebar .kd3d-restorebtn{flex:0 0 auto;background:transparent;border:1px solid #2b3a4d;color:#9fb0c0;font:inherit;font-size:11px;padding:5px 9px;border-radius:6px;cursor:pointer;white-space:nowrap}
.kd3d-modal .kd3d-explodebar .kd3d-hidebtn.is-on{background:#7a2c2c;border-color:#a23b3b;color:#ffd9d9}
```

- [ ] **Step 5: `node --check app.js`.**

- [ ] **Step 6: Commit.** `git add app.js style.css && git commit -m "web3d: admin 🙈 tap-to-hide toggle + restore (RTDB-shared)"`

---

### Task 5: Deploy

- [ ] Push; `gh run watch` the run for this commit; confirm `success`.
- [ ] curl-verify live: `app.js` contains `_glbHiddenKey` and `kd3d-hidebtn`.

---

### Task 6: Live verification (Chrome MCP) + report

- [ ] As admin, open 02 Wipha-L 🧊, switch to explode/inspect; assert `.kd3d-hidebtn` present; tap it (is-on); call `_pickAndIsolate` on a known part via a synthetic pick OR tap a part; assert RTDB `glb_hidden/02 Wipha-L` now contains the code and the unit's `node.visible===false` (read via the THREE scene). NOTE: the visual disappearance can't be confirmed headless (model-viewer rAF-gated) — confirm `node.visible===false` + RTDB write headlessly; เอ๋ confirms visually on device.
- [ ] As worker (`?role=assemble`), open the same GLB; assert the code's unit `node.visible===false` and NO `.kd3d-hidebtn` rendered.
- [ ] Restore: tap ↺ → RTDB set empty, unit visible again.
- [ ] Board-log + tell เอ๋ to hard-reload + tap the white panels to hide.

---

## Self-review
- **Spec coverage:** tap-to-hide ✓ (T4); hide-by-code ✓ (`_extractPartLabel` in `_isUnitHidden`); RTDB-shared ✓ (T2/T4); admin-only toggle+restore ✓ (T4 `isAdmin()`); apply across explode/reset/reload ✓ (T3 + subscribe re-applies); restore ✓ (T4); coexists with Fusion fix ✓ (independent). Unit test ✓ (T1); live ✓ (T6).
- **Placeholders:** none — all steps have concrete code.
- **Type consistency:** `_glbHidden:Set`, `_glbHiddenKey(code)`, `_isUnitHidden(u)`, `_renderHideUI`, `_saveGlbHidden`, `_hideMode` consistent across tasks; `code` is `_kdOpen3D`'s arg; `explodePct`/`applyExplode`/`_fitVisibleWorld`/`_extractPartLabel`/`_poppedCode` are existing in-scope names (verified at 4117/4126/4512/4548).
- **Risk:** exact line of `explodeUnits`-populated call site for `_loadGlbHidden()` (Step T2.2) confirmed at implementation; the `_kdToast` global guarded with `&&`.
