# Cabinet Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each workshop role (laser/bend/assemble) a per-cabinet **NEW / CHANGED** marker across the Nest, Sim.Bending, and Projects-mindmap surfaces, synced per department via RTDB, so new cabinet groups (e.g. F2 in "02 Ruth") never get mixed up with finished groups.

**Architecture:** A small **standalone freshness engine** in `app.js` (global, every surface calls it) computes a per-cabinet **fingerprint** from `manifest.projects[pk].parts` grouped by `variant_root` (code→qty + max `uploaded_dxfs[code].uploaded_at` over those codes). A per-role RTDB snapshot `cabinet_seen/<role>/<pk>/<cab>` (mirrors the existing `bent_status` pattern verbatim, +1 role level) records the fingerprint each role last acknowledged. Status = NEW (no snapshot, fresh <24h) / CHANGED (snapshot fp ≠ current) / OLD. Each surface renders the badge with the existing amber `.part-new-badge` CSS and hard-codes its own role at the call site.

**Tech Stack:** Vanilla JS (`app.js`, `nest.js`, `style.css` load directly — no bundler, no test framework). Firebase RTDB + localStorage. **Verification = preview browser (hit-test via `elementFromPoint`, synthetic RTDB inject + self-clean) + `node --check` + live `curl` after deploy** — this repo has no unit-test harness; that is the established discipline, not unit tests.

**Spec:** `docs/superpowers/specs/2026-06-11-cabinet-freshness-design.md`

**Reused mechanisms (read before starting):**
- `bent_status` engine — `app.js`: `LS_BENT_KEY` (99), `_bentCache`/`bentKey` (3510-3513), `_seedBentFromLocal`/`_mirrorBentToLocal` (3518-3543), `markBent` (3615), `isBent` (3612), `initBentSync` listener (3770), call site (11957).
- `isNewProject` 24h baseline — `app.js`: `projectActivityMs` (2165), `isNewProject` (2176), `markProjectSeen` (2183), `LS_SEEN_PROJECTS_KEY` (2154).
- `_aggregatePartsByCode` (889→ actually 989) strips `variant_root` — returns `{code,qty,family,urn}`.
- Nest capsules (shipped 9376a84) — `nest.js`: `_addContrib`/`_recomputeCabinetQtys`/`_cabinetGroups`/`_toggleCabinet`/`S.cabinetsOff`, capsule `.kdnest-cab` render + `kdnest-cabs` row, `S.dxfsAll`.
- mindmap spoke — `app.js` `_renderProjectSpoke` (9215), `statusInfo`+`warnFrame` (9225-9281), `buildProjectTree` keeps `_variant_root`/`_is_variant_root` per node.
- Sim.Bending dashboard — `app.js` ~6762-6792 (`_simBendSync.byCode`, `buildSbCard`), `sbNewKeys`/`sbNewPill` (6743-6748).
- `.part-new-badge` CSS — `style.css` ~6977-7005 (amber, `!important` theme overrides).

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `app.js` | freshness engine (fingerprint, seen-store, status) + Sim.Bending + mindmap render hooks + init call | Modify |
| `nest.js` | Nest capsule pill badge + acknowledge + summary | Modify |
| `style.css` | `.kdnest-cab-new` / `.kdnest-cab-changed` / dimmed-OFF + mindmap freshness frame color | Modify |

All freshness logic lives in **one block in `app.js`** (the engine) so the three surfaces share one source of truth; each surface only adds a thin render hook keyed by its hard-coded role.

---

## Task 1: Freshness engine (fingerprint + seen-store + status) — `app.js`, no UI yet

**Files:**
- Modify: `app.js` — add a new block just after the `bent_status` block (after `initAssembledSync`, ~app.js:3805) and one init call at ~app.js:11958.

- [ ] **Step 1: Add the engine block**

Insert after `initAssembledSync` (~line 3805) in `app.js`:

```javascript
// ──────────────────────────────────────────────────────────────────────
// Cabinet Freshness (เอ๋ 2026-06-11: "คนประกอบ คนพับ คนตัด Laser ก็ต้องรู้ว่า
// อะไรใหม่เข้ามา อะไรเก่า ... ต้อง Sync กัน"). Per-ROLE NEW/CHANGED markers per
// cabinet (variant_root). Standalone — computes per-cabinet code→qty straight
// from the manifest so Nest, Sim.Bending and the mindmap all get the SAME
// fingerprint without any of them needing the nest session's `contrib`.
// Mirrors the bent_status sync verbatim, +1 role level. Spec:
// docs/superpowers/specs/2026-06-11-cabinet-freshness-design.md
// ──────────────────────────────────────────────────────────────────────
const LS_CAB_SEEN_KEY = 'kd_cabinet_seen_v1';
const NO_CAB = '__NO_CAB__';                       // RTDB-safe key for variant_root ''
const CAB_NEW_WINDOW_MS = 24 * 3600 * 1000;        // first-render baseline, mirrors isNewProject

let _cabSeenCache = {};   // { "role|pk|cab": { fp, seen_at } }

function cabSeenKey(role, pk, cab) { return `${role}|${pk}|${cab || NO_CAB}`; }

// Per-cabinet { code -> summed qty } for a project, straight from the manifest.
// Skips wrappers (qty-0 containers). '' variant_root is the shared/no-cabinet
// bucket. Returns Map<cab, Map<code, qty>>.
function _cabinetCodeQty(projectKey) {
  const out = new Map();
  const proj = manifest && manifest.projects && manifest.projects[projectKey];
  if (!proj || !Array.isArray(proj.parts)) return out;
  for (const p of proj.parts) {
    if (!p || !p.code || p.is_wrapper) continue;
    const cab = String(p.variant_root || '').trim();
    let codes = out.get(cab);
    if (!codes) { codes = new Map(); out.set(cab, codes); }
    codes.set(p.code, (codes.get(p.code) || 0) + (p.qty || 0));
  }
  return out;
}

// Cheap stable string hash (djb2) → base36. Order-independent inputs are
// sorted by the caller before hashing.
function _fnvHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Freshest signal (ms) for a cabinet = newest uploaded_at over its codes.
// Used both in the fingerprint and in the 24h baseline.
function _cabinetFreshestMs(codeQty) {
  let ms = 0;
  // _uploadedDxfsCache is the module-level map populated by initUploadedDxfsSync
  // (app.js:2789 declared, :3016 filled) — same handle dxfsForProject reads.
  const dxfs = (typeof _uploadedDxfsCache === 'object' && _uploadedDxfsCache) ? _uploadedDxfsCache : {};
  for (const code of codeQty.keys()) {
    const meta = dxfs[code];
    if (meta && +meta.uploaded_at) ms = Math.max(ms, +meta.uploaded_at);
  }
  return ms;
}

// Fingerprint of ONE cabinet. codeQty = Map<code, qty> for that cabinet.
// fp = hash( sorted "code:qty" (qty>0)  +  '|' + maxUploadedAt ).
// Version component intentionally omitted in phase 1 (last_drawn_version 0/0
// dormant until Fusion F29). Returns '' for an empty cabinet (no qty>0 codes).
function _cabinetFingerprint(codeQty) {
  const parts = [];
  for (const [code, qty] of codeQty) if (qty > 0) parts.push(`${code}:${qty}`);
  if (!parts.length) return '';
  parts.sort();
  return _fnvHash(parts.join(',') + '|' + String(_cabinetFreshestMs(codeQty)));
}

// Status for one cabinet for one role: 'new' | 'changed' | 'old'.
function cabinetFreshness(role, projectKey, cab, codeQty) {
  const fp = _cabinetFingerprint(codeQty);
  const snap = _cabSeenCache[cabSeenKey(role, projectKey, cab)];
  if (!snap) {
    return (_cabinetFreshestMs(codeQty) >= Date.now() - CAB_NEW_WINDOW_MS) ? 'new' : 'old';
  }
  return (snap.fp !== fp) ? 'changed' : 'old';
}

// Convenience: status for every cabinet of a project, for one role.
// Returns Map<cab, {status, fp, codeQty}>. Orphan snapshot keys (cabinets no
// longer in the manifest, e.g. after a rename) are simply not produced here.
function cabinetFreshnessAll(role, projectKey) {
  const res = new Map();
  for (const [cab, codeQty] of _cabinetCodeQty(projectKey)) {
    res.set(cab, { status: cabinetFreshness(role, projectKey, cab, codeQty),
                   fp: _cabinetFingerprint(codeQty), codeQty });
  }
  return res;
}

function _mirrorCabSeenToLocal() {
  // Nest { role: { pk: { cab: {fp,seen_at} } } } for compactness + offline seed.
  const nested = {};
  for (const [k, v] of Object.entries(_cabSeenCache)) {
    const [role, pk, cab] = k.split('|');
    (((nested[role] = nested[role] || {})[pk] = nested[role][pk] || {}))[cab] = v;
  }
  try { localStorage.setItem(LS_CAB_SEEN_KEY, JSON.stringify(nested)); } catch {}
}
function _seedCabSeenFromLocal() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_CAB_SEEN_KEY) || '{}');
    _cabSeenCache = {};
    for (const [role, pks] of Object.entries(o || {}))
      for (const [pk, cabs] of Object.entries(pks || {}))
        for (const [cab, v] of Object.entries(cabs || {}))
          _cabSeenCache[cabSeenKey(role, pk, cab)] = v;
  } catch {}
}
_seedCabSeenFromLocal();

// Mark ONE cabinet seen for a role = store its CURRENT fingerprint.
function markCabinetSeen(role, projectKey, cab, fp) {
  const k = cabSeenKey(role, projectKey, cab);
  const payload = { fp: fp || '', seen_at: Date.now() };
  _cabSeenCache[k] = payload;
  if (window.firebaseDB) {
    try { window.firebaseDB.ref(`cabinet_seen/${role}/${projectKey}/${cab || NO_CAB}`).set(payload); }
    catch (e) { console.warn('Firebase cabinet_seen write failed:', e); }
  }
  _mirrorCabSeenToLocal();
}

// Mark ALL of a project's cabinets seen for ONE role (the "เห็นทั้งหมด" button).
function markAllCabinetsSeen(role, projectKey) {
  const all = cabinetFreshnessAll(role, projectKey);
  const updates = {};
  for (const [cab, info] of all) {
    const payload = { fp: info.fp, seen_at: Date.now() };
    _cabSeenCache[cabSeenKey(role, projectKey, cab)] = payload;
    updates[`cabinet_seen/${role}/${projectKey}/${cab || NO_CAB}`] = payload;
  }
  if (window.firebaseDB && Object.keys(updates).length) {
    try { window.firebaseDB.ref().update(updates); }
    catch (e) { console.warn('Firebase cabinet_seen bulk failed:', e); }
  }
  _mirrorCabSeenToLocal();
}

function initCabinetSeenSync() {
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('cabinet_seen').on('value', snap => {
      const data = snap.val() || {};
      _cabSeenCache = {};
      for (const [role, pks] of Object.entries(data))
        for (const [pk, cabs] of Object.entries(pks || {}))
          for (const [cab, payload] of Object.entries(cabs || {}))
            _cabSeenCache[`${role}|${pk}|${cab}`] = payload;
      _mirrorCabSeenToLocal();
      if (typeof render === 'function') { try { render(); } catch {} }
    }, err => console.warn('Firebase cabinet_seen listener error:', err));
  } catch (e) { console.warn('Failed to attach cabinet_seen listener:', e); }
}
```

> **Note on `_uploadedDxfs`:** confirm the accessor name for the in-memory `uploaded_dxfs` map before this step — grep `app.js` for `uploaded_dxfs` / `initUploadedDxfsSync` (3012) and use whatever cache it populates (e.g. a module-level `_uploadedDxfsCache` or `window.kdUploadedDxfs`). Adjust `_cabinetFreshestMs` to read that exact handle. This is the only external dependency of the engine.

- [ ] **Step 2: Wire the init call**

In `app.js` after `initAssembledSync();` (~line 11958) add:

```javascript
  initCabinetSeenSync();
```

- [ ] **Step 3: Syntax check**

Run: `node --check "C:\Users\wutti\OneDrive\เดสก์ท็อป\Work\Stainless Kitchen\drawings-ui\app.js"`
Expected: no output (exit 0).

- [ ] **Step 4: Verify the engine in preview (no UI yet)**

`preview_start "drawings-ui"` → `preview_resize 1280x900`. Then `preview_eval`:

```javascript
(async () => {
  for (let i=0;i<60 && !window.kdManifest;i++) await new Promise(r=>setTimeout(r,250));
  // engine functions are module-scoped; expose a probe via the existing render globals
  const pk = '02 Ruth';
  const groups = window.__cabProbe ? window.__cabProbe(pk) : 'no-probe';
  return groups;
})()
```

If the engine functions are not reachable from preview (module scope), TEMPORARILY add `window.__cabProbe = (pk)=>[...cabinetFreshnessAll('laser',pk)].map(([c,i])=>({cab:c||'(none)',status:i.status,fp:i.fp}));` at the end of the engine block for this verification, confirm it returns 10 cabinets + 1 `(none)` for 02 Ruth all `status:'new'` or `'old'` (depending on uploaded_at age), then REMOVE the probe line before commit. Expected: 11 entries, every `fp` non-empty except possibly the shared bucket.

- [ ] **Step 5: Commit**

```bash
git -c rebase.autoStash=true pull --rebase origin main
git add app.js
git commit -m "feat(freshness): cabinet freshness engine — fingerprint + per-role seen-store + RTDB sync

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Nest surface — capsule pill NEW/CHANGED badge + acknowledge — `nest.js` + `style.css`

**Files:**
- Modify: `nest.js` — the capsule row render (`_cabinetGroups`/`.kdnest-cab` block) + its click wiring.
- Modify: `style.css` — `.kdnest-cab-new` / `.kdnest-cab-changed` / dimmed-OFF.

- [ ] **Step 1: Read the current capsule render + wiring**

Read `nest.js` around the `kdnest-cabs` row render and the `.kdnest-cab` click handler (grep `kdnest-cab` in `nest.js`). Confirm `S.projectKey`, `_cabinetGroups()`, `S.cabinetsOff` are in scope where the row is built.

- [ ] **Step 2: Compute freshness per capsule + render the badge**

In the capsule-row builder, for each cabinet `g.cab`, call the app.js global (nest.js already calls app.js globals like `displayCodeFor`):

```javascript
const _freshAll = (typeof cabinetFreshnessAll === 'function')
  ? cabinetFreshnessAll('laser', S.projectKey) : new Map();
// inside the per-cabinet pill template:
const _fr = _freshAll.get(g.cab);
const _frCls = _fr && _fr.status === 'new' ? ' kdnest-cab-new'
             : _fr && _fr.status === 'changed' ? ' kdnest-cab-changed' : '';
const _frTag = _fr && _fr.status === 'new' ? '<sup class="kdnest-cab-fr">NEW</sup>'
             : _fr && _fr.status === 'changed' ? '<sup class="kdnest-cab-fr">⟳</sup>' : '';
```

Append `${_frCls}` to the pill's `class="kdnest-cab…"` and `${_frTag}` inside the pill label (next to the existing qty `<sup>`). For an OFF cabinet the existing `kdnest-cab-off` already dims it — the badge stays (dimmed with the pill = เอ๋'s "โชว์แบบหรี่").

- [ ] **Step 3: Add the summary line + "เห็นทั้งหมด" button**

Directly under the capsule row (`kdnest-cabs`), add a summary when anything is new/changed:

```javascript
const _frCounts = [..._freshAll.values()].reduce((a,i)=>{a[i.status]=(a[i.status]||0)+1;return a;},{});
const _frSummary = (_frCounts.new||_frCounts.changed)
  ? `<div class="kdnest-cabs-fresh">${_frCounts.new?`<span class="kdnest-cab-fr">${_frCounts.new} ตู้ใหม่</span>`:''}${_frCounts.changed?`<span class="kdnest-cab-fr">⟳ ${_frCounts.changed} แก้ไข</span>`:''}<button id="kdnest-cabs-seen" class="kdnest-mini" title="Mark every cabinet seen for the laser role">เห็นทั้งหมด</button></div>`
  : '';
```

Insert `${_frSummary}` after the `kdnest-cabs` row in the sidebar template.

- [ ] **Step 4: Wire per-pill ✓ acknowledge + "เห็นทั้งหมด"**

Acknowledge per cabinet = long-press is awkward on the pill; add a tiny `✓` affordance. Simplest: make a **double-click on a pill** acknowledge it (single click already toggles ON/OFF — capsules). Add to the `.kdnest-cab` wiring:

```javascript
btn.addEventListener('dblclick', (e) => {
  e.preventDefault(); e.stopPropagation();
  const cab = btn.dataset.cab;
  const codeQty = _cabinetCodeQty(S.projectKey).get(cab) || new Map();
  markCabinetSeen('laser', S.projectKey, cab, _cabinetFingerprint(codeQty));
  _refreshView();
});
```

And wire the summary button:

```javascript
S.rootEl.querySelector('#kdnest-cabs-seen')?.addEventListener('click', () => {
  markAllCabinetsSeen('laser', S.projectKey);
  _refreshView();
});
```

> If `_cabinetCodeQty` / `_cabinetFingerprint` are module-scoped in app.js and not reachable from nest.js, expose them on `window` at the end of the engine block (`window.kdCabFreshness = { codeQty:_cabinetCodeQty, fp:_cabinetFingerprint, freshAll:cabinetFreshnessAll, markSeen:markCabinetSeen, markAll:markAllCabinetsSeen }`) and call through that handle from nest.js. Decide this once and use it consistently.

- [ ] **Step 5: CSS**

Add to `style.css` after `.kdnest-cab-off` (grep `kdnest-cab-off`):

```css
.kdnest-cab-fr { font-size: 8.5px; font-weight: 700; color: #F2A93B; margin-left: 4px; }
.kdnest-cab-new { border-color: #F2A93B; box-shadow: 0 0 0 1px #F2A93B inset; }
.kdnest-cab-changed { border-color: #F2A93B; border-style: dashed; }
.kdnest-cabs-fresh { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:2px 0 6px; font-size:10.5px; color:#F2A93B; }
```

- [ ] **Step 6: Verify in preview**

`node --check nest.js`. Open 02 Ruth Nest. Clean LS first (`localStorage.removeItem('kd_cabinet_seen_v1')`). Expected: some pills show `NEW` (cabinets with uploaded_at <24h) or none (all old). Inject a synthetic snapshot for one cabinet with a WRONG fp via RTDB, reload → that pill shows `⟳`; double-click a NEW pill → badge clears + summary count drops; "เห็นทั้งหมด" clears all. Self-clean: `firebaseDB.ref('cabinet_seen/laser/02 Ruth').remove()` + `localStorage.removeItem('kd_cabinet_seen_v1')`. 0 console errors.

- [ ] **Step 7: Commit**

```bash
git -c rebase.autoStash=true pull --rebase origin main
git add nest.js style.css
git commit -m "feat(freshness): Nest capsule NEW/CHANGED badges + acknowledge (laser role)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Sim.Bending surface — per-cabinet NEW/CHANGED grouping + acknowledge — `app.js`

**Files:**
- Modify: `app.js` — the Sim.Bending project dashboard (~6762-6792) + the `↻ Sync` bar (~6749-6759).

- [ ] **Step 1: Read the dashboard render fully**

Read `app.js` 6740-6815 (sync bar, project dashboard sections, card click wiring). Note `_simBendSync.byCode` is keyed by code with `.status` only — it carries NO cabinet. Cabinet must be derived from the manifest via `_cabinetCodeQty(_simBendProject)`.

- [ ] **Step 2: Build a code→cabinet index + a fresh-cabinets banner**

In the project-dashboard branch (after `const by = _simBendSync.byCode || {};`), add:

```javascript
const _cabFresh = cabinetFreshnessAll('bend', _simBendProject);   // Map<cab,{status,...}>
const _codeCab = new Map();   // code -> [cab,...]
for (const [cab, codes] of _cabinetCodeQty(_simBendProject)) for (const code of codes.keys())
  (_codeCab.get(code) || _codeCab.set(code, []).get(code)).push(cab);
const _freshCabs = [..._cabFresh].filter(([,i]) => i.status === 'new' || i.status === 'changed');
const _freshBanner = _freshCabs.length ? `
  <div class="sb-dash-section sb-fresh-banner">
    <div class="sb-section-head">🆕 ตู้ใหม่/แก้ไขที่ต้องพับ (${_freshCabs.length})
      <button class="sb-cabs-seen part-new-badge" style="cursor:pointer;border:none;">เห็นทั้งหมด</button></div>
    <div class="sb-fresh-cabs">${_freshCabs.map(([cab,i]) =>
      `<span class="sb-fresh-cab ${i.status}" data-cab="${escapeHtml(cab||NO_CAB)}">${escapeHtml(cab?displayCodeFor(cab):'No cabinet / shared')} ${i.status==='new'?'NEW':'⟳'}</span>`
    ).join('')}</div>
  </div>` : '';
```

Insert `${_freshBanner}` at the TOP of `mainHtml` (before `progressHtml`).

- [ ] **Step 3: Tag each card whose code belongs to a fresh cabinet**

In `buildSbCard(code)` (read it first, ~6439), compute a freshness class from `_codeCab` (pass it in or read a closure var) and add an amber dot to the card head when any of the code's cabinets is new/changed. Minimal version — append to the card-head HTML:

```javascript
const _cabsOf = (_codeCab.get(code) || []);
const _cardFresh = _cabsOf.some(c => { const f=_cabFresh.get(c); return f && (f.status==='new'||f.status==='changed'); });
const _cardFreshTag = _cardFresh ? '<span class="part-new-badge" title="belongs to a new/changed cabinet">●</span>' : '';
```

Insert `${_cardFreshTag}` into the `.sb-card-head` template. (If `buildSbCard` cannot see `_codeCab`/`_cabFresh` due to scope, hoist those two to the function that owns `buildSbCard` so both the dashboard and the card builder share them.)

- [ ] **Step 4: Wire "เห็นทั้งหมด" for the bend role**

After `ROOT.innerHTML = …` in the Sim.Bending render, add:

```javascript
ROOT.querySelector('.sb-cabs-seen')?.addEventListener('click', () => {
  if (_simBendProject) { markAllCabinetsSeen('bend', _simBendProject); render(); }
});
ROOT.querySelectorAll('.sb-fresh-cab').forEach(el => el.addEventListener('dblclick', () => {
  const cab = el.dataset.cab === NO_CAB ? '' : el.dataset.cab;
  const codeQty = _cabinetCodeQty(_simBendProject).get(cab) || new Map();
  markCabinetSeen('bend', _simBendProject, cab, _cabinetFingerprint(codeQty));
  render();
}));
```

- [ ] **Step 5: CSS**

Add to `style.css`:

```css
.sb-fresh-banner { border:1px solid #F2A93B; border-radius:8px; padding:6px 10px; margin-bottom:10px; }
.sb-fresh-cabs { display:flex; gap:6px; flex-wrap:wrap; }
.sb-fresh-cab { font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid #F2A93B; color:#F2A93B; cursor:pointer; }
.sb-fresh-cab.changed { border-style:dashed; }
```

- [ ] **Step 6: Verify in preview**

`node --check app.js`. Switch to role `bend` (header toggle) → Sim.Bending tab → Sync 02 Ruth. Clean `kd_cabinet_seen_v1`. Expected: a "ตู้ใหม่/แก้ไขที่ต้องพับ" banner lists fresh cabinets; cards of their codes carry an amber ●. Double-click a fresh-cab chip → it leaves the banner; "เห็นทั้งหมด" empties the banner. The laser role's snapshot (Task 2) is unaffected — confirm Nest still shows them NEW. Self-clean RTDB + LS. 0 console errors.

- [ ] **Step 7: Commit**

```bash
git -c rebase.autoStash=true pull --rebase origin main
git add app.js style.css
git commit -m "feat(freshness): Sim.Bending per-cabinet NEW/CHANGED banner + card dots (bend role)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Projects mindmap surface — variant_root spoke NEW/CHANGED frame — `app.js`

**Files:**
- Modify: `app.js` — `_renderProjectSpoke` (9215) `statusInfo`/`warnFrame`; the mindmap render entry to compute freshness once + a "เห็นทั้งหมด" control.

- [ ] **Step 1: Compute freshness for the project once per render**

Find where the project mindmap is rendered (grep `_renderProjectSpoke(` caller). Before the spokes are built, compute:

```javascript
const _mmFresh = cabinetFreshnessAll('assemble', projectKey);   // Map<cab,{status,...}>
```

Thread `_mmFresh` into `_renderProjectSpoke(p, projectKey, workflow, expandedSet, _mmFresh)` (add the param at the definition + the call site).

- [ ] **Step 2: Add a freshness frame on cabinet (variant_root) nodes**

In `_renderProjectSpoke`, after the existing `warnFrame` (9281), add a freshness frame for nodes that ARE a cabinet root. A node's cabinet key = `n._variant_root` (the node's own variant_root) when `n._is_variant_root`, else fall through to the part's `n._variant_root`:

```javascript
// VERIFIED: buildProjectTree Pass 4 synthesizes a cabinet container node with
// `code: vr` + `_is_variant_root: true` (app.js:8780-8800), so n.code IS the
// variant_root string for those nodes. EDGE: a cabinet whose code equals its
// own variant_root (e.g. 02 Ruth's C1H100-093I30) gets NO synthetic node
// (app.js:8777 `if (node.code === vr) continue`) — that part node IS its own
// cabinet, so also treat `n.code === n._variant_root` as a cabinet root.
const _cabKey = n._is_variant_root ? n.code
              : (n._variant_root && n.code === n._variant_root) ? n.code : null;
const _fr = _cabKey != null && _mmFresh ? _mmFresh.get(_cabKey) : null;
const freshFrame = (_fr && (_fr.status === 'new' || _fr.status === 'changed'))
  ? `<rect class="pm-fresh-frame" x="${-halfW - 5}" y="${-halfH - 5}" width="${PSPOKE_W + 10}" height="${PSPOKE_H + 10}" rx="13"
          fill="none" stroke="#F2A93B" stroke-width="2.5" ${_fr.status==='changed'?'stroke-dasharray="6 3"':''} opacity="0.95" />
     <g class="pm-fresh-badge" transform="translate(${halfW - 30}, ${-halfH - 8})">
       <rect x="-2" y="-9" width="34" height="16" rx="8" fill="#F2A93B" />
       <text x="2" dy="3" font-size="9" font-weight="700" fill="#1B2430">${_fr.status==='new'?'NEW':'⟳ แก้'}</text>
     </g>` : '';
```

> **Verify the cabinet-node identity first:** read `buildProjectTree` (8567+) to confirm how a `variant_root` container node stores its cabinet key — whether it's `node.code === variant_root`, `node._variant_root`, or `node._is_variant_root` with the cabinet string elsewhere. Use the field that actually equals the manifest `variant_root` string so `_mmFresh.get(_cabKey)` hits. Adjust `_cabKey` accordingly. This is the one identity to get right in this task.

Insert `${freshFrame}` into the spoke's returned SVG right after `${warnFrame}`.

- [ ] **Step 3: Add a "เห็นทั้งหมด (ประกอบ)" admin control near the mindmap header**

Where the project mindmap toolbar/header is built, add a button (admin or assemble role) that calls:

```javascript
markAllCabinetsSeen('assemble', projectKey); render();
```

(Per-cabinet ack on a spoke is optional in phase 1 — the spoke is already crowded with bent/assembled/timer/comments buttons; "mark all seen" + the natural clear-on-fp-match when a cabinet stops changing is enough. Document this choice in the commit.)

- [ ] **Step 4: CSS (optional — frame is inline-styled)**

No new CSS required (frame uses inline `stroke`). Skip.

- [ ] **Step 5: Verify in preview**

`node --check app.js`. Role `assemble` (or admin) → open 02 Ruth project mindmap. Clean LS. Expected: cabinet (variant_root) spokes that are fresh get an amber frame + NEW/⟳ badge; part leaves do NOT (only cabinet roots). "เห็นทั้งหมด (ประกอบ)" clears them. Confirm the existing `⏰ OUTDATED` warnFrame still renders and the two frames don't visually collide (fresh frame is OUTSIDE the warn frame — bigger rx/offset). Self-clean. 0 console errors.

- [ ] **Step 6: Commit**

```bash
git -c rebase.autoStash=true pull --rebase origin main
git add app.js
git commit -m "feat(freshness): mindmap variant_root spoke NEW/CHANGED frame (assemble role)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Polish — CHANGED outranks Outdated + final cross-surface verify + deploy

**Files:**
- Modify: `app.js` / `style.css` as needed for the precedence dimming.

- [ ] **Step 1: Demote competing amber hints when a cabinet is CHANGED**

Where the mindmap/Sim.Bending render the existing `⏰ OUTDATED` (stale) / `Redo` re-check chips, when the SAME cabinet/code also carries a freshness CHANGED, reduce the older chip's opacity so two amber signals don't compete. In `_renderProjectSpoke`, when `freshFrame` is non-empty, render the `warnFrame` (stale) at `opacity="0.45"`:

```javascript
const _warnOpacity = freshFrame ? '0.45' : '0.9';
// replace the warnFrame's opacity="0.9" with opacity="${_warnOpacity}"
```

- [ ] **Step 2: Full cross-surface manual pass on real 02 Ruth**

In preview, with `kd_cabinet_seen_v1` cleaned and RTDB `cabinet_seen` empty:
1. Role `laser` / Nest → note which cabinets are NEW. Double-click one → clears for laser only.
2. Role `bend` / Sim.Bending → SAME cabinets still NEW (per-role independence proven). Clear via banner.
3. Role `assemble` / mindmap → SAME cabinets still NEW. Clear via "เห็นทั้งหมด".
4. Inject a synthetic manifest qty change for one cabinet (or a synthetic snapshot with stale fp) → that cabinet shows CHANGED in all three surfaces for roles that had acked it.
Self-clean RTDB `cabinet_seen` + LS after. 0 console errors across all three.

- [ ] **Step 3: Push + watch deploy + live verify**

```bash
git -c rebase.autoStash=true pull --rebase origin main
git add app.js style.css
git commit -m "feat(freshness): CHANGED outranks Outdated; cross-surface verified

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push origin main
gh run watch $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

Then `curl` live `app.js` + `nest.js` + `style.css` for markers `cabinet_seen`, `kdnest-cab-new`, `pm-fresh-frame`, `sb-fresh-banner`. Expected: all present.

- [ ] **Step 4: Board entry + memory**

Append ONE board entry to `docs/coordination/group-sync.md` (what shipped, refs, per-role verification, F29 phase-2 note). Add a memory file `reference_cabinet_freshness.md` + MEMORY.md pointer. Commit + push the board.

---

## Self-review notes

- **Spec coverage:** unit=cabinet ✓(engine groups by variant_root) · per-role ✓(role hard-coded per surface, 3 call sites) · re-export=CHANGED ✓(fp includes max uploaded_at) · acknowledge=explicit ✓(dblclick + "เห็นทั้งหมด") · No-cabinet bucket ✓(NO_CAB key, shown as one card) · OFF dimmed ✓(kdnest-cab-off keeps badge) · Complete=normal ✓(no special-case) · CHANGED-outranks-Outdated ✓(Task 5) · 24h baseline ✓ · orphan keys ignored ✓(cabinetFreshnessAll only emits manifest cabinets) · sync mirrors bent_status ✓.
- **Deferred (per spec):** version component, role-gated rules, multi-project merge keys, GC, cross-role lifecycle.
- **Type consistency:** `cabinetFreshnessAll(role, pk)` → Map<cab,{status,fp,codeQty}> used identically in Tasks 2/3/4; `markCabinetSeen(role,pk,cab,fp)` / `markAllCabinetsSeen(role,pk)` signatures stable; `NO_CAB`/`_cabinetCodeQty`/`_cabinetFingerprint` names consistent; reachability-from-nest.js resolved once via a `window.kdCabFreshness` handle if module scope blocks direct calls.
- **Known risk (documented):** a shared code re-uploaded for another cabinet flips both cabinets CHANGED (single `uploaded_dxfs/<code>` timestamp) — accepted phase-1 false-positive, never a false-negative.
