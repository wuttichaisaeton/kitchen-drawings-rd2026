# Drawing-Outdated chip → open .f2d + clickable on ALL surfaces — Implementation Plan

> **For agentic workers:** single-file change (`app.js`), executed inline. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The amber "⚠ drawing outdated" chip opens the part's `.f2d` drawing in Fusion (not the 3D master), and every outdated / re-check chip is clickable on every surface (bend list, Sim.Bending sb-cards, project BOM, Library).

**Architecture:**
1. **Router (`_routeLeafToFusion`)** — when `status:'stale'` and there is no literal `drawing_urn` yet, call the bridge with the MASTER urn + `kind=drawing` so CC_Auto resolves the linked `.f2d` itself. When `drawing_urn` exists, keep the direct fast path.
2. **Clickability** — pass `{clickable:true}` to `_outdatedChips` at the 3 remaining surfaces, and wire ONE capture-phase document-level delegated click listener keyed on `data-act` (replaces the bend-list-only scoped listener). Capture phase fires before the container handlers (sb-card expand / bom-row PDF / part-row PDF) and `stopPropagation()` suppresses them — no per-surface ignore-list edits needed.

**Tech Stack:** vanilla JS (no bundling), GitHub Pages, Fusion bridge at `http://127.0.0.1:8765`.

**Bridge contract (Fusion lane, parallel session):** `/open?urn=<masterLineageUrn>&kind=drawing` → opens the linked `.f2d`. No `kind` / not found → opens the urn as today (3D master).

**Lane rules:** commit pathspec `app.js` only (NOT nest.js = WEB14; do NOT `git add -A` — Fusion tools auto-commit `Drawings/`). No Thai in rendered UI. `git pull --rebase` before each edit/push.

---

### Task 1: Router supports `kind=drawing` + on-demand `.f2d` resolution

**Files:**
- Modify: `app.js` — `bridgeOpen` closure (~10930) and the stale block (~10951-10956) inside `_routeLeafToFusion`.

- [ ] **Step 1: Add `kind` param to `bridgeOpen`**

```js
  const bridgeOpen = async (u, kind) => {
    const hit = async () => {
      const kindParam = kind ? `&kind=${encodeURIComponent(kind)}` : '';
      const r = await fetch(`http://127.0.0.1:8765/open?urn=${encodeURIComponent(u)}${kindParam}&t=${Date.now()}`,
        { method: 'GET', mode: 'cors', cache: 'no-store' });
      return r.ok;
    };
    try { return await hit(); }
    catch (e) {
      await new Promise(res => setTimeout(res, 2000));
      return hit();   // second throw propagates to the caller's catch
    }
  };
```

- [ ] **Step 2: Restructure the stale block to resolve `.f2d` on demand**

Replace the existing `if (node.status === 'stale' && drawingUrn) { ... }` block with:

```js
  // Stale (drawing exists but out of date) → open the Fusion .f2d drawing.
  // Fast path: a literal .f2d lineage urn (drawing_urn from F30's stamp) → open
  // it directly. No drawing_urn yet (master not re-exported since the stamp) →
  // hand the MASTER urn to the bridge with kind=drawing so CC_Auto resolves the
  // linked .f2d itself (/open?urn=<master>&kind=drawing). Bridge can't find one →
  // it opens the 3D master, an acceptable "got เอ๋ to Fusion" fallback.
  // (RD 04 2026-06-12 e67c8b0 — on-demand resolve, NO manifest backfill.)
  if (node.status === 'stale' && (drawingUrn || urn)) {
    bridgeAttempted = true;
    const target = drawingUrn || urn;
    const kind = drawingUrn ? null : 'drawing';
    try { if (await bridgeOpen(target, kind)) { _toastOpening(node.code); return; } bridgeError = 'bridge declined'; }
    catch (e) { bridgeError = e?.message || 'fetch failed'; }
  }
```

The subsequent `if (urn) { ... bridgeOpen(urn) }` block stays unchanged (3D-master fallback when the stale attempt declined/threw).

- [ ] **Step 3:** `node --check app.js` → no errors.

---

### Task 2: Make `_outdatedChips` clickable on the 3 remaining surfaces

**Files:**
- Modify: `app.js:7095` (sb-card), `app.js:9340` (project BOM), `app.js:11953` (Library).

- [ ] **Step 1:** sb-card — `${_outdatedChips(code)}` → `${_outdatedChips(code, { clickable: true })}`
- [ ] **Step 2:** BOM row — `${_outdatedChips(p.code)}` → `${_outdatedChips(p.code, { clickable: true })}`
- [ ] **Step 3:** Library row — `${_outdatedChips(p.code)}` → `${_outdatedChips(p.code, { clickable: true })}`

(`_bendRecheckChip` stays passive on these surfaces — re-check remains bend-list-only per 379d28e.)

---

### Task 3: One capture-phase delegated listener; remove the scoped bend-list listener

**Files:**
- Modify: `app.js` — remove the `.bend-row .sb-recheck-act` forEach in `_wireBendList` (~1726-1753); add `_wireOutdatedChipDelegation()` near `window.kdRouteLeaf` (~10998).

- [ ] **Step 1: Remove the per-render scoped listener** (lines ~1726-1753) and leave a pointer comment:

```js
  // Outdated / re-check chips are wired GLOBALLY via _wireOutdatedChipDelegation
  // (one capture-phase document listener handling every surface — bend list,
  // sb-cards, BOM, Library — keyed on data-act). Nothing per-render here.
```

(`_bendPartByCode` stays — still used by the `.bend-fusion-btn` handler above.)

- [ ] **Step 2: Add the global delegated listener** after `window.kdRouteLeaf = _routeLeafToFusion;`:

```js
// Clickable outdated / re-check chips on EVERY surface (bend list, sb-cards,
// project BOM, Library). ONE delegated listener in the CAPTURE phase so it fires
// BEFORE the container handlers (sb-card expand, bom-row PDF open, part-row PDF
// open) and stopPropagation suppresses them — no per-surface ignore-list edits.
// (RD 04 2026-06-12 e67c8b0 "clickable on ALL surfaces".)
//   data-act='drawing' → the part's .f2d (router stale-path; drawing_urn fast
//                        path, else master urn + kind=drawing so Fusion finds it)
//   data-act='dxf'     → 3D master (run 🔥 / CC_Laser)
//   data-act='recheck' → 3D master (re-run CC_CheckBend)
// Chips are opt-in (data-act present only when {clickable}); passive chips never match.
let _outdatedChipDelegated = false;
function _wireOutdatedChipDelegation() {
  if (_outdatedChipDelegated) return;
  _outdatedChipDelegated = true;
  document.addEventListener('click', (ev) => {
    const chip = ev.target.closest && ev.target.closest('.sb-recheck-act[data-act]');
    if (!chip) return;
    ev.stopPropagation();   // capture phase → beats the container's own click
    const code = chip.dataset.code;
    if (!code) return;
    const act = chip.dataset.act;
    const urn = _urnForCode(code) || null;
    if (act === 'dxf' || act === 'recheck') {
      // DXF-outdated + ↻ re-check are model→bend actions → open the 3D master.
      _routeLeafToFusion({ code, urn }, { fusionOnly: true });
    } else {
      // drawing-outdated → the part's .f2d. drawing_urn (when stamped) is the fast
      // path; otherwise the router asks the bridge to resolve the master's linked
      // .f2d via kind=drawing. fusionOnly so it never opens the OLD pdf.
      const eff = _effectiveDrawingCode(code);
      const entry = ((manifest && manifest.auto_generated) || {})[eff] || null;
      _routeLeafToFusion(
        { code, urn, drawing_urn: entry ? (entry.drawing_urn || null) : null, status: 'stale' },
        { fusionOnly: true });
    }
  }, true);   // ← capture phase
}
_wireOutdatedChipDelegation();
```

- [ ] **Step 3:** `node --check app.js` → no errors.

---

### Verification (TDD — the codebase's real test loop is instrumented preview)

- [ ] `node --check app.js` clean.
- [ ] preview_start; open 02 Ruth, `?admin=1`, role=bend.
- [ ] Spy: override `window.fetch` to record `127.0.0.1:8765/open` URLs and resolve `{ok:true}` (avoids the bridge-down alert).
- [ ] **Assert (a):** click `.sb-recheck-act[data-act="drawing"]` → recorded bridge URL contains `kind=drawing` (drawing_urn is null in current manifest) and `urn=` is the master urn.
- [ ] **Assert (dxf):** click `.sb-recheck-act[data-act="dxf"]` → recorded URL has NO `kind=drawing` (3D master).
- [ ] **Assert (b) clickability:** on bend list, sb-card (Sim.Bending), project BOM, Library — `.sb-recheck-act[data-act]` chips exist and a programmatic click records a bridge call (proves the capture listener fires on every surface, and the container action — card expand / PDF open — did NOT fire).
- [ ] 0 console errors.
- [ ] Commit pathspec `app.js` + this plan; push; `gh run watch` deploy success; live markers present.
- [ ] Board entry + memory note.

---

## Self-Review

- **Spec coverage:** (a) router `.f2d`/`kind=drawing` → Task 1. (b) `{clickable}` at 7095/9340/11953 → Task 2; delegated handler on all surfaces → Task 3. ✓
- **Placeholders:** none — all code is literal. ✓
- **Type consistency:** `bridgeOpen(u, kind)` 2-arg used in Task 1 stale block; `_urnForCode`/`_effectiveDrawingCode`/`manifest`/`_routeLeafToFusion` all confirmed module-scope. `data-act` values `drawing`/`dxf`/`recheck` match `_outdatedChips`/`_bendRecheckChip` emitters. ✓
