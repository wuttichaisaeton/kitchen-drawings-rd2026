# Role-access links (`?role=`) + per-role tab lockdown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shareable link per channel — `?admin=1` sees everything; `?role=assemble|laser|bend` (and aliases `?asm`/`?laser`/`?bend`) bake that role, clear admin, and restrict the visitor to Projects + Stock Part with the project view auto-scoped to their work.

**Architecture:** Two surgical edits to `app.js` — (1) `_visibleTabsForRole()` tightens the three worker roles to `{projects, stockpart}`; (2) `applyUrlFlags()` gains a pure `_resolveRoleFlag(params)` helper that maps `?role=`/`?asm`/`?laser`/`?bend` → `{role, project}`, then bakes role + clears admin. The per-project role *body* (Cut List / Bend List / Assembly + the 📐 Cut Sheets / 📑 All PDF buttons) already exists in `renderProject` and is untouched.

**Tech Stack:** Vanilla JS (no bundler), `node --test` (`.mjs`), GitHub Pages deploy, Chrome MCP live verify.

Spec: `docs/superpowers/specs/2026-06-28-role-access-links-design.md`

---

### Task 1: Tighten per-role tab visibility

**Files:**
- Modify: `app.js:188-200` (`_visibleTabsForRole`)
- Test: `test/roleAccessLinks.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `test/roleAccessLinks.test.mjs`. `_visibleTabsForRole` calls globals `isAdmin()`/`getRole()`, so mirror its pure logic as `_tabsFor(isAdmin, role)` — keep VERBATIM in sync with app.js (same pattern as `nestStockDontRecut.test.mjs`).

```js
import { test } from 'node:test';
import assert from 'node:assert';

// ── verbatim mirror of app.js _visibleTabsForRole (parameterised) ──────────
function _tabsFor(isAdmin, role) {
  if (isAdmin) return { projects: true, library: true, drawing: true, nest: true, simbend: true, stockpart: true };
  switch (role) {
    case 'laser':    return { projects: true, library: false, drawing: false, nest: false, simbend: false, stockpart: true };
    case 'bend':     return { projects: true, library: false, drawing: false, nest: false, simbend: false, stockpart: true };
    case 'assemble': return { projects: true, library: false, drawing: false, nest: false, simbend: false, stockpart: true };
    default:         return { projects: true, library: false, drawing: true,  nest: false, simbend: false, stockpart: true };
  }
}

test('worker roles see only Projects + Stock Part', () => {
  for (const role of ['laser', 'bend', 'assemble']) {
    const t = _tabsFor(false, role);
    assert.deepEqual(t, { projects: true, library: false, drawing: false, nest: false, simbend: false, stockpart: true }, role);
  }
});
test('admin sees every tab regardless of role', () => {
  assert.deepEqual(_tabsFor(true, 'laser'), { projects: true, library: true, drawing: true, nest: true, simbend: true, stockpart: true });
});
test('workshop (generic default) keeps Drawing', () => {
  assert.equal(_tabsFor(false, 'workshop').drawing, true);
  assert.equal(_tabsFor(false, 'workshop').nest, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/roleAccessLinks.test.mjs`
Expected: FAIL — `_tabsFor` here already encodes the NEW map, but app.js still has the OLD map, so this test passes in isolation yet does NOT match app.js. To make the test MEANINGFUL as a guard, first paste the CURRENT app.js map (laser nest:true, bend simbend:true, assemble drawing:true) into `_tabsFor`, run → the `worker roles` test FAILS. That confirms the test detects the old behavior. Then proceed to Step 3.

- [ ] **Step 3: Apply the new map in BOTH places**

In `app.js:194-199`, replace the worker cases so laser/bend/assemble are all `{projects, stockpart}` only:

```js
  switch (getRole()) {
    case 'laser':    return { projects: true, library: false, drawing: false, nest: false, simbend: false, stockpart: true };
    case 'bend':     return { projects: true, library: false, drawing: false, nest: false, simbend: false, stockpart: true };
    case 'assemble': return { projects: true, library: false, drawing: false, nest: false, simbend: false, stockpart: true };
    default:         return { projects: true, library: false, drawing: true,  nest: false, simbend: false, stockpart: true };
  }
```

(Only laser `nest:true→false`, bend `simbend:true→false`, assemble `drawing:true→false` change; `default`/workshop unchanged.) Ensure the test's `_tabsFor` matches this exactly.

- [ ] **Step 4: Run test + syntax check**

Run: `node --check app.js && node --test test/roleAccessLinks.test.mjs`
Expected: app.js OK; all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add app.js test/roleAccessLinks.test.mjs
git commit -m "role: worker roles (laser/bend/assemble) see only Projects + Stock Part"
```

---

### Task 2: `?role=` handler + `?bend` + clear-admin (pure `_resolveRoleFlag`)

**Files:**
- Modify: `app.js:401-456` (the `?role` strip + `?asm` + `?laser` blocks inside `applyUrlFlags`)
- Modify: `app.js` (add `_resolveRoleFlag` helper just above `applyUrlFlags`, ~line 388)
- Test: `test/roleAccessLinks.test.mjs` (extend)

- [ ] **Step 1: Write the failing test (extend the file)**

Append to `test/roleAccessLinks.test.mjs`. Mirror `_resolveRoleFlag` verbatim. Use a tiny stub matching the `URLSearchParams` surface the helper uses (`has`/`get`).

```js
// ── verbatim mirror of app.js _resolveRoleFlag ────────────────────────────
const _ALIAS_ROLE = { asm: 'assemble', laser: 'laser', bend: 'bend' };
function _resolveRoleFlag(params) {
  if (params.has('role')) {
    const r = (params.get('role') || '').toLowerCase();
    return ['assemble', 'laser', 'bend'].includes(r) ? { role: r, project: '' } : { role: null, project: '' };
  }
  for (const k of ['asm', 'laser', 'bend']) {
    if (!params.has(k)) continue;
    const v = params.get(k) || '';
    const project = (v === '' || v.toLowerCase() === 'all') ? '' : v;
    return { role: _ALIAS_ROLE[k], project };
  }
  return null;
}
const P = (obj) => ({ has: (k) => k in obj, get: (k) => obj[k] });

test('?role= canonical maps + validates (case-insensitive)', () => {
  assert.deepEqual(_resolveRoleFlag(P({ role: 'laser' })), { role: 'laser', project: '' });
  assert.deepEqual(_resolveRoleFlag(P({ role: 'ASSEMBLE' })), { role: 'assemble', project: '' });
  assert.deepEqual(_resolveRoleFlag(P({ role: 'bend' })), { role: 'bend', project: '' });
});
test('?role=<unknown> consumed but bakes nothing', () => {
  assert.deepEqual(_resolveRoleFlag(P({ role: 'foo' })), { role: null, project: '' });
});
test('aliases ?asm/?laser/?bend map to roles, =all is generic', () => {
  assert.deepEqual(_resolveRoleFlag(P({ asm: '' })), { role: 'assemble', project: '' });
  assert.deepEqual(_resolveRoleFlag(P({ asm: 'all' })), { role: 'assemble', project: '' });
  assert.deepEqual(_resolveRoleFlag(P({ laser: '' })), { role: 'laser', project: '' });
  assert.deepEqual(_resolveRoleFlag(P({ bend: '' })), { role: 'bend', project: '' });
});
test('alias with a value drops into that project', () => {
  assert.deepEqual(_resolveRoleFlag(P({ asm: 'Bung 01' })), { role: 'assemble', project: 'Bung 01' });
  assert.deepEqual(_resolveRoleFlag(P({ bend: 'Ruth 02' })), { role: 'bend', project: 'Ruth 02' });
});
test('no role flag → null; ?role wins over aliases', () => {
  assert.equal(_resolveRoleFlag(P({ p: 'X' })), null);
  assert.deepEqual(_resolveRoleFlag(P({ role: 'bend', laser: '' })), { role: 'bend', project: '' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/roleAccessLinks.test.mjs`
Expected: FAIL — `_resolveRoleFlag` is only in the test mirror; this step proves the spec'd behavior before app.js has it. (The mirror passes alone; the real guard is that Step 3 makes app.js match this exact logic. Eyeball that the mirror and app.js stay identical.)

- [ ] **Step 3: Add `_resolveRoleFlag` to app.js**

Insert just ABOVE `(function applyUrlFlags() {` (app.js ~388):

```js
// Map a URL's role flags → {role, project} (or null if none). Pure + tested
// (test/roleAccessLinks.test.mjs). Canonical `?role=<role>` (value = role,
// generic only); aliases `?asm`/`?laser`/`?bend` (value = ''|'all' generic, or
// a project key to drop into). Unknown ?role= value → {role:null} (consumed,
// bakes nothing). `?role=` is checked first so it wins if both are present.
const _ALIAS_ROLE = { asm: 'assemble', laser: 'laser', bend: 'bend' };
function _resolveRoleFlag(params) {
  if (params.has('role')) {
    const r = (params.get('role') || '').toLowerCase();
    return ['assemble', 'laser', 'bend'].includes(r) ? { role: r, project: '' } : { role: null, project: '' };
  }
  for (const k of ['asm', 'laser', 'bend']) {
    if (!params.has(k)) continue;
    const v = params.get(k) || '';
    const project = (v === '' || v.toLowerCase() === 'all') ? '' : v;
    return { role: _ALIAS_ROLE[k], project };
  }
  return null;
}
```

- [ ] **Step 4: Replace the old role/asm/laser blocks in `applyUrlFlags`**

In `app.js`, DELETE the three existing blocks: the `?role` strip (`if (params.has('role')) { params.delete('role'); dirty = true; }`, ~401-408), the `?asm` block (~430-444), and the `?laser` block (~445-456). Replace ALL THREE with one block (place where the `?asm` block was, AFTER the `?p` deep-link block so `__kdInitialProject` precedence is unchanged):

```js
    // Role links (เอ๋ 2026-06-28): one shared link per channel. `?role=assemble|
    // laser|bend` is canonical; `?asm`/`?laser`/`?bend` are kept as aliases (old
    // LINE shares keep working, `?asm`/`?laser`/`?bend` also accept =<project>).
    // The link FULLY scopes the view: it bakes the role AND clears admin, so
    // "กดเข้าช่องทางไหน ก็เห็นแค่ช่องทางนั้น" — `?admin=1` is the only path back to
    // the full view. (Supersedes the 2026-06-09 ?role= retirement + the older
    // ?asm __kdAsmBakeRole mount-time bake: baking here at parse-time is earlier,
    // so role-gated chrome is correct on the very first paint.)
    const _roleFlag = _resolveRoleFlag(params);
    if (_roleFlag) {
      if (_roleFlag.role) {
        try {
          localStorage.setItem(LS_ROLE_KEY, _roleFlag.role);
          localStorage.removeItem(LS_ADMIN_KEY);
        } catch {}
        if (_roleFlag.project) window.__kdInitialProject = _roleFlag.project;
      }
      ['role', 'asm', 'laser', 'bend'].forEach((k) => params.delete(k));
      dirty = true;
    }
```

Leave the `?admin` block (above) and the mount-time `bakeAsm` reader (~16130) untouched — `__kdAsmBakeRole` is simply never set now, so its branch is dead-but-harmless (role is already baked at parse-time).

- [ ] **Step 5: Run full suite + syntax check**

Run: `node --check app.js && node --test test/*.test.mjs`
Expected: app.js OK; ALL tests pass (roleAccessLinks + the existing suite, 0 fail).

- [ ] **Step 6: Commit**

```bash
git add app.js test/roleAccessLinks.test.mjs
git commit -m "role: ?role= links + ?bend alias, bake role + clear admin (?role wins, unknown=no-op)"
```

---

### Task 3: Deploy + live verification across all four links

**Files:** none (verify + deploy + board)

- [ ] **Step 1: Push + watch deploy**

```bash
git pull --rebase origin main; git push origin main
sha=$(git rev-parse HEAD); rid=$(gh run list --branch main --limit 8 --json databaseId,headSha -q "map(select(.headSha==\"$sha\"))[0].databaseId")
gh run watch "$rid" --exit-status; gh run view "$rid" --json conclusion -q .conclusion
```
Expected: `success`.

- [ ] **Step 2: curl-verify the live bundle**

```bash
curl -s "https://wuttichaisaeton.github.io/kitchen-drawings-rd2026/app.js?n=$(date +%s)" | grep -c "_resolveRoleFlag"
```
Expected: ≥ 2 (definition + call site).

- [ ] **Step 3: Live verify each link (Chrome MCP, fresh tab per link)**

For each of `?admin=1`, `?role=assemble`, `?role=laser`, `?role=bend`: navigate fresh, then read state via `javascript_tool`:
- assert `localStorage.kd_admin_v1` is `null` for the three `?role=` links, `'1'` for `?admin=1`;
- assert `localStorage.kd_role_v1` matches (assemble/laser/bend);
- assert the URL was stripped (`location.search` has no role/admin param);
- assert the visible tab set = `[tab-projects, tab-stockpart]` for workers, all 6 for admin (read `[id^="tab-"]` with `display!=='none'`);
- assert the top-left `#header-status` shows the right indicator (role-badge text for workers; 🔓 Admin for admin);
- open a project and assert the body: laser → Cut List + visible `#project-cut-sheets-btn`; bend → Bend List + visible `#all-pdf-btn`; assemble → `#kme-mount` (Assembly).
Per [[feedback_verify_visual_before_claim]] + [[reference_chrome_mcp_raf_gating]], also screenshot one worker link on the sketch theme. Reset test localStorage afterward.

- [ ] **Step 4: Board log**

Append a WEB entry to `docs/coordination/group-sync.md` (what/why/HEAD/curl-live/per-link verify results), commit + push that file only.

---

## Self-review

- **Spec coverage:** ?role= canonical ✓ (Task 2); ?bend alias ✓ (Task 2 helper); clear-admin ✓ (Task 2 Step 4); aliases kept ✓; unknown-role no-op ✓ (test + helper); tab lockdown ✓ (Task 1); per-project body unchanged ✓ (explicitly not touched); verification across links ✓ (Task 3).
- **Placeholder scan:** none — every code/command step is concrete.
- **Type consistency:** `_resolveRoleFlag` returns `{role, project}|null` everywhere; `_ALIAS_ROLE`, `LS_ROLE_KEY`, `LS_ADMIN_KEY`, `__kdInitialProject` names match app.js. The test mirror and the app.js copy of both helpers are byte-identical by construction.
- **Risk:** `__kdAsmBakeRole` branch becomes dead but harmless (left in place); single-commit revert restores prior behavior.
