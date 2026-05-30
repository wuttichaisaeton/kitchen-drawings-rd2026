# Save Project — nest job persistence + part sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Nest workspace's `📤 Save sheets to Laser` button into `💾 Save Project` that persists the full nest job (layout + part edits + stock + settings) to Firebase with history, mirrors a latest-parts snapshot the Laser Cut List reads, lets the user reload past jobs, and exports a JSON backup.

**Architecture:** Additive changes to two directly-loaded files. `nest.js` gains save/restore/export logic + two new buttons + a Saved-Jobs popover, writing three RTDB nodes (`nest_jobs/<pk>/<jobId>` history, `nest_parts/<pk>` latest snapshot, plus a new optional `parts[]` field on existing `cut_sheets/<pk>/<id>` entries) and a localStorage backup. `app.js` adds a `nest_parts` listener and merges that snapshot into the Laser Cut List (append manual rects, override grain/qty) and shows a per-sheet parts summary in the Cut Sheets popover.

**Tech Stack:** Vanilla ES (no bundler for `nest.js`/`app.js` — edit then push), Firebase Realtime Database (`window.firebaseDB`), GitHub Contents API (existing PAT helper `window.getGitHubPat`). No test framework exists in this repo; verification is `node --check` for syntax plus structured manual checks (the local preview MCP has crashed prior sessions — do **not** rely on it).

**Spec:** `docs/superpowers/specs/2026-05-30-nest-save-project-design.md`

**Working dir:** `C:/Users/wutti/OneDrive/เดสก์ท็อป/Work/Stainless Kitchen/drawings-ui`

**Critical repo rules (from CLAUDE.md + memory):**
- `git add nest.js app.js` (and the plan/spec docs) **by exact path only** — never `git add -A` (Group 1/Fusion shares this working dir and sweeps broad adds).
- Before each push: `git pull --rebase origin main` then push; if rejected, rebase again.
- No Thai in rendered UI strings (Flux Architect web font can't render it). Source-code comments may be Thai.
- `nest.js` / `app.js` need no build. (The `editor/` bundle is NOT touched by this plan.)

---

## File Structure

- **`nest.js`** (Nest workspace IIFE, `window.kdNest`) — owns: the Save Project flow, the job object builder, Saved-Jobs popover, restore, JSON export, the three action buttons + wiring. Writes `nest_jobs`, `nest_parts`, `cut_sheets.parts[]`, localStorage. Does **not** read `nest_parts`.
- **`app.js`** (main app) — owns: the `nest_parts` Firebase listener + cache + `nestPartsForProject(pk)` accessor, the Laser Cut List merge (`_renderCutList`), and the per-sheet parts summary in `_renderCutSheetsModal`. Reads `nest_parts`; never writes it.

Data contract (verbatim from spec):
```
nest_jobs/<pk>/<jobId> = { saved_at, name, mode, gap, skipRemnants, dontRemember,
  sheetStock:[{w,h,qty,thickness,label}],
  parts:[{code,qty,selected,grain,thickness,w,h,manual,dxfUrl}],
  sheets:[{thick,sw,sh,placements:[{code,x,y,w,h,rot}]}] }   // NO polys
nest_parts/<pk> = { saved_at, jobId, parts:[ ...same shape... ] }
cut_sheets/<pk>/<id> = { ...existing..., parts:[{code,qty,w,h,grain,thickness,rot}] }
```
`jobId` = `<YYYYMMDD_HHMMSS>` slug. localStorage key = `kd_nest_job_<pk>`.

---

## Task 1: Job-object builder + part/sheet serializers (pure helpers)

Build the pure functions first so later tasks just call them. These have no DOM/Firebase deps and are the testable core.

**Files:**
- Modify: `nest.js` — insert a new helper block just above `_saveSheetsToLaser` (currently at `nest.js:1894`).

- [ ] **Step 1: Add the serializer helpers**

Insert immediately before the `// ═══…  Save sheets to Laser` banner comment (just above line 1888). Paste exactly:

```javascript
  // ════════════════════════════════════════════════════════════════════
  //  Save Project — job serialization helpers (pure; no DOM/Firebase)
  // ════════════════════════════════════════════════════════════════════
  // Timestamp slug YYYYMMDD_HHMMSS (local) — used as the jobId + filename.
  function _jobStamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  // Human label "YYYY-MM-DD HH:MM" (local) for the Saved Jobs list.
  function _jobLabel() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  // Strip a part down to the persisted fields (no polys/bbox — re-parsed on restore).
  function _serializePart(p) {
    return {
      code: p.code, qty: p.qty || 0, selected: !!p.selected,
      grain: p.grain || 'ANY', thickness: p.thickness || 0,
      w: p.w || 0, h: p.h || 0, manual: !!p.manual, dxfUrl: p.dxfUrl || '',
    };
  }
  // Strip a flatSheet to thick/size + placements without polys/bbox.
  function _serializeSheet(s) {
    return {
      thick: s.thick, sw: s.sw, sh: s.sh,
      placements: (s.placements || []).map(pl => ({
        code: pl.code, x: pl.x, y: pl.y, w: pl.w, h: pl.h, rot: pl.rot || 0,
      })),
    };
  }
  // Per-cut-sheet parts summary: group a sheet's placements by code, attach
  // grain/thickness from the matching S.parts entry. Used in cut_sheets.parts[].
  function _sheetPartsSummary(sheet) {
    const byCode = new Map();
    for (const pl of (sheet.placements || [])) {
      const ex = byCode.get(pl.code);
      if (ex) { ex.qty += 1; continue; }
      const part = S.parts.find(p => p.code === pl.code);
      byCode.set(pl.code, {
        code: pl.code, qty: 1, w: pl.w, h: pl.h, rot: pl.rot || 0,
        grain: (part && part.grain) || 'ANY',
        thickness: (part && part.thickness) || 0,
      });
    }
    return [...byCode.values()];
  }
  // Assemble the full job object from current S. Pure (reads S, returns data).
  function _buildJob() {
    return {
      saved_at: Date.now(),
      name: _jobLabel(),
      mode: S.mode, gap: S.gap,
      skipRemnants: !!S.skipRemnants, dontRemember: !!S.dontRemember,
      sheetStock: (S.sheetStock || []).map(s => ({
        w: s.w || 0, h: s.h || 0, qty: s.qty || 0,
        thickness: s.thickness ?? 1, label: s.label || '',
      })),
      parts: (S.parts || []).map(_serializePart),
      sheets: (S.flatSheets || []).map(_serializeSheet),
    };
  }
```

- [ ] **Step 2: Syntax check**

Run: `node --check nest.js`
Expected: exits 0, no output.

- [ ] **Step 3: Logic self-check (read, don't run)**

Confirm by reading: `_serializeSheet` and `_serializePart` emit **no** `polys`/`bbox` keys; `_sheetPartsSummary` counts one per placement (qty increments) and falls back to `'ANY'`/`0` when a code has no `S.parts` match; `_buildJob` references only fields that exist on `S` (`mode,gap,skipRemnants,dontRemember,sheetStock,parts,flatSheets` — all present in the state template at `nest.js:40-62`).

- [ ] **Step 4: Commit**

```bash
git add nest.js docs/superpowers/plans/2026-05-30-nest-save-project.md
git commit -m "feat(nest): job serialization helpers for Save Project"
```

---

## Task 2: Rename Save flow to `_saveProject` + write the new nodes

Extend the existing upload routine: keep all cut-sheet behaviour, attach `parts[]` per sheet, then write `nest_jobs`, `nest_parts`, and the localStorage backup.

**Files:**
- Modify: `nest.js` — `_saveSheetsToLaser` (currently `nest.js:1894-1967`).

- [ ] **Step 1: Rename the function declaration**

Change line 1894 from:
```javascript
  async function _saveSheetsToLaser() {
```
to:
```javascript
  async function _saveProject() {
```

- [ ] **Step 2: Capture the jobId/stamp once and reuse for cut-sheet ids**

Replace the timestamp block (currently lines 1904-1908):
```javascript
    const ts = (function () {
      const d = new Date();
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
    })();
```
with:
```javascript
    const jobId = _jobStamp();
    const ts = jobId;   // cut-sheet ids share the job stamp so they group together
```

- [ ] **Step 3: Attach `parts[]` to each cut-sheet meta**

In the per-sheet loop, find the `meta` object (currently lines 1946-1956). Add a `parts` field. Change:
```javascript
        const meta = {
          url, filename: `${sheetId}.dxf`,
          thickness_mm: thicknessMm,
          parts_count: sheet.placements.length,
          sheet_w_mm: Math.round(sheet.sw),
          sheet_h_mm: Math.round(sheet.sh),
          uploaded_at: Date.now(),
          uploaded_via: 'web-nest',
          original_filename: `${sheetId}.dxf`,
          size_bytes: content.length,
        };
```
to (add the one `parts:` line):
```javascript
        const meta = {
          url, filename: `${sheetId}.dxf`,
          thickness_mm: thicknessMm,
          parts_count: sheet.placements.length,
          sheet_w_mm: Math.round(sheet.sw),
          sheet_h_mm: Math.round(sheet.sh),
          uploaded_at: Date.now(),
          uploaded_via: 'web-nest',
          original_filename: `${sheetId}.dxf`,
          size_bytes: content.length,
          parts: _sheetPartsSummary(sheet),
        };
```

- [ ] **Step 4: Write nest_jobs + nest_parts + localStorage after the cut-sheet loop**

Find the loop's end + button restore + final alert (currently lines 1963-1966):
```javascript
    }
    if (btn) { btn.disabled = false; btn.textContent = origText; }
    alert(`Save sheets to Laser — '${S.projectName}'\n\nUploaded: ${ok}\nFailed:   ${fail}` +
          (firstErr ? `\n\nFirst error: ${firstErr}` : ''));
  }
```
Replace with:
```javascript
    }

    // Persist the full nest job (history) + the latest-parts snapshot + a
    // local backup. These are independent of the cut-sheet DXF upload above,
    // so a GitHub failure still saves the job for restore.
    const job = _buildJob();
    let jobSaved = false, jobErr = '';
    try {
      await window.firebaseDB.ref(`nest_jobs/${projectKey}/${jobId}`).set(job);
      await window.firebaseDB.ref(`nest_parts/${projectKey}`).set({
        saved_at: job.saved_at, jobId: jobId, parts: job.parts,
      });
      S.lastSavedJobId = jobId;
      jobSaved = true;
    } catch (e) {
      jobErr = String(e.message || e);
    }
    try {
      localStorage.setItem('kd_nest_job_' + projectKey, JSON.stringify({ jobId, ...job }));
    } catch (e) { /* quota / private mode — non-fatal */ }

    if (btn) { btn.disabled = false; btn.textContent = origText; }
    alert(`Save Project — '${S.projectName}'\n\n` +
          `Cut sheets uploaded: ${ok}` + (fail ? `\nFailed: ${fail}` : '') +
          `\nNest job: ${jobSaved ? 'saved (' + job.name + ')' : 'FAILED — ' + jobErr}` +
          (firstErr ? `\n\nFirst cut-sheet error: ${firstErr}` : ''));
  }
```

- [ ] **Step 5: Add `S.lastSavedJobId` to the state template**

In the state object (around `nest.js:56-61`), after the `flatSheets: [],` line add:
```javascript
    lastSavedJobId: null,  // set by _saveProject; informational
```

- [ ] **Step 6: Syntax check**

Run: `node --check nest.js`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add nest.js
git commit -m "feat(nest): _saveProject writes nest_jobs + nest_parts + cut_sheets.parts[] + local backup"
```

---

## Task 3: Restore a saved job into the workspace

`_restoreJob` rebuilds `S` from a job object, re-parses DXFs, and re-attaches polygons to placements so the saved layout renders without a re-run.

**Files:**
- Modify: `nest.js` — add `_restoreJob` after `_saveProject` (after the function you renamed in Task 2).

- [ ] **Step 1: Add `_restoreJob`**

Insert directly after the closing `}` of `_saveProject` (just before the `// DXF builder for one nested sheet` comment at what was `nest.js:1969`):

```javascript
  // Restore a saved nest job into S: settings + parts + stock, then re-parse
  // DXFs and re-attach polys/bbox to the saved placements by code. No re-run —
  // the saved layout renders as-is. (user 2026-05-30 'โหลดงานเก่า')
  async function _restoreJob(job) {
    if (!job) return;
    S.mode = job.mode || S.mode;
    S.gap = (typeof job.gap === 'number') ? job.gap : S.gap;
    S.skipRemnants = !!job.skipRemnants;
    S.dontRemember = !!job.dontRemember;
    if (Array.isArray(job.sheetStock) && job.sheetStock.length) {
      S.sheetStock = job.sheetStock.map(s => ({
        w: s.w || 0, h: s.h || 0, qty: s.qty || 0,
        thickness: s.thickness ?? 1, label: s.label || '',
      }));
    }
    // Rebuild parts: start from a fresh part shell per code, overlay saved fields.
    S.parts = (job.parts || []).map(sp => {
      const base = sp.manual ? _newManualPart() : _newPart(sp.code, sp.qty);
      base.code = sp.code;
      base.qty = sp.qty || 0;
      base.selected = !!sp.selected;
      base.grain = sp.grain || 'ANY';
      base.thickness = sp.thickness || 0;
      base.w = sp.w || 0;
      base.h = sp.h || 0;
      base.manual = !!sp.manual;
      base.dxfUrl = sp.dxfUrl || '';
      base.dxfLoaded = !!sp.manual;   // manual rects need no fetch
      base.dxfError = null;
      base.polys = null; base.bbox = null;
      return base;
    });
    S.previewCode = null;
    S.highlightCode = null;
    S.flatSheets = [];
    S.currentSheetIdx = 0;
    _refreshView();
    // Re-parse DXFs (fills polys/bbox + may correct w/h from the real bbox).
    await _loadAllDxfs();
    if (S.closing) return;
    // Rebuild flatSheets from the saved placements, re-attaching geometry from
    // the freshly-loaded part of the same code.
    S.flatSheets = (job.sheets || []).map(sh => ({
      thick: sh.thick, sw: sh.sw, sh: sh.sh,
      placements: (sh.placements || []).map(pl => {
        const part = S.parts.find(p => p.code === pl.code);
        return {
          code: pl.code, x: pl.x, y: pl.y, w: pl.w, h: pl.h, rot: pl.rot || 0,
          polys: part ? part.polys : null,
          bbox: part ? part.bbox : null,
        };
      }),
    }));
    S.currentSheetIdx = 0;
    _refreshView();
  }
```

- [ ] **Step 2: Syntax check**

Run: `node --check nest.js`
Expected: exits 0.

- [ ] **Step 3: Logic self-check (read, don't run)**

Confirm: `_restoreJob` only references functions defined in nest.js (`_newManualPart` `nest.js:66`, `_newPart` `nest.js:77`, `_loadAllDxfs` `nest.js:465`, `_refreshView`). Placements re-attach `polys`/`bbox` from `S.parts` after `_loadAllDxfs` resolves, matching the draw path in `_drawSheet` (which reads `pl.polys`/`pl.bbox`). Manual parts get `dxfLoaded=true` and `polys=null` → drawn as rects, same as live manual rects.

- [ ] **Step 4: Commit**

```bash
git add nest.js
git commit -m "feat(nest): _restoreJob rebuilds layout from a saved job (re-parse + re-attach polys)"
```

---

## Task 4: Saved Jobs popover (list / load / delete)

**Files:**
- Modify: `nest.js` — add `_openSavedJobsModal` + `_renderSavedJobsModal` after `_restoreJob`.

- [ ] **Step 1: Add the popover functions**

Insert after `_restoreJob`'s closing `}`:

```javascript
  // ── Saved Jobs popover ────────────────────────────────────────────────
  // Lists nest_jobs/<pk>/* newest-first; load or (admin) delete each.
  function _openSavedJobsModal() {
    const pk = S.projectKey;
    if (!pk || !window.firebaseDB) { alert('No project / database unavailable.'); return; }
    window.firebaseDB.ref(`nest_jobs/${pk}`).once('value')
      .then(snap => _renderSavedJobsModal(snap.val() || {}))
      .catch(e => alert('Saved Jobs load failed: ' + (e.message || e)));
  }
  function _renderSavedJobsModal(bucket) {
    document.querySelectorAll('.kdjobs-modal').forEach(m => m.remove());
    const isAdminUser = (typeof window.isAdmin === 'function' && window.isAdmin());
    const jobs = Object.entries(bucket)
      .map(([jobId, v]) => ({ jobId, ...v }))
      .sort((a, b) => (b.saved_at || 0) - (a.saved_at || 0));

    const rows = jobs.length ? jobs.map(j => {
      const nSheets = Array.isArray(j.sheets) ? j.sheets.length : 0;
      const nParts = Array.isArray(j.parts) ? j.parts.length : 0;
      return `
        <div class="kdjobs-row" data-id="${_esc(j.jobId)}">
          <div class="kdjobs-main">
            <span class="kdjobs-name">${_esc(j.name || j.jobId)}</span>
            <span class="kdjobs-meta">${nSheets} sheets · ${nParts} parts · ${_esc(j.mode || '')}</span>
          </div>
          <button class="kdjobs-load" data-id="${_esc(j.jobId)}">Load</button>
          ${isAdminUser ? `<button class="kdjobs-del" data-id="${_esc(j.jobId)}" title="Delete this saved job">✕</button>` : ''}
        </div>`;
    }).join('') : '<div class="kdjobs-empty">No saved jobs yet. Click 💾 Save Project to create one.</div>';

    const modal = document.createElement('div');
    modal.className = 'kdstock-modal kdjobs-modal';
    modal.innerHTML = '<div class="kdstock-backdrop"></div>'
      + `<div class="kdstock-frame" role="dialog" aria-label="Saved Jobs">
           <div class="kdstock-head">📂 Saved Jobs
             <span class="kdstock-sub">${_esc(S.projectName)} · ${jobs.length} saved</span>
             <button class="kdstock-close" aria-label="Close">✕</button>
           </div>
           <div class="kdjobs-body">${rows}</div>
         </div>`;
    document.body.appendChild(modal);

    const closeModal = () => modal.remove();
    modal.querySelector('.kdstock-backdrop').addEventListener('click', closeModal);
    modal.querySelector('.kdstock-close').addEventListener('click', closeModal);
    modal.querySelectorAll('.kdjobs-load').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const job = bucket[id];
      closeModal();
      if (job) await _restoreJob(job);
    }));
    modal.querySelectorAll('.kdjobs-del').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!confirm('Delete saved job "' + id + '"? This cannot be undone.')) return;
      try {
        await window.firebaseDB.ref(`nest_jobs/${S.projectKey}/${id}`).remove();
        const snap = await window.firebaseDB.ref(`nest_jobs/${S.projectKey}`).once('value');
        _renderSavedJobsModal(snap.val() || {});
      } catch (e) { alert('Delete failed: ' + (e.message || e)); }
    }));
  }
```

- [ ] **Step 2: Syntax check**

Run: `node --check nest.js`
Expected: exits 0.

- [ ] **Step 3: Logic self-check (read, don't run)**

Confirm: reuses existing `.kdstock-modal`/`.kdstock-backdrop`/`.kdstock-frame`/`.kdstock-head`/`.kdstock-sub`/`.kdstock-close` classes (defined in style.css for the Stock modal) so no new CSS is required for the frame; only `.kdjobs-*` inner classes are new (styled in Task 7). Uses `_esc` (`nest.js:2212`). Delete is admin-gated via `window.isAdmin`.

- [ ] **Step 4: Commit**

```bash
git add nest.js
git commit -m "feat(nest): Saved Jobs popover (list newest-first, load, admin delete)"
```

---

## Task 5: JSON export (`⬇ Export JSON`)

**Files:**
- Modify: `nest.js` — add `_exportJobJson` after `_renderSavedJobsModal`.

- [ ] **Step 1: Add `_exportJobJson`**

Insert after `_renderSavedJobsModal`'s closing `}`:

```javascript
  // Download the current nest state as a JSON backup (insurance outside
  // Firebase). Does not require a prior save. (user 2026-05-30 'เก็บเป็นไฟล์')
  function _exportJobJson() {
    const pk = S.projectKey || 'project';
    const payload = {
      kind: 'kd-nest-job', version: 1,
      projectKey: pk, projectName: S.projectName || pk,
      exported_at: Date.now(),
      job: _buildJob(),
    };
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = `${pk}_nest_${_jobStamp()}.json`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
    } catch (e) {
      alert('Export failed: ' + (e.message || e));
    }
  }
```

- [ ] **Step 2: Syntax check**

Run: `node --check nest.js`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add nest.js
git commit -m "feat(nest): Export JSON button downloads a nest-job backup file"
```

---

## Task 6: Wire the three buttons (rename + two new) in the UI

**Files:**
- Modify: `nest.js` — `_viewHtml` actions block (`nest.js:2182-2187`) and `_wireEvents` (`nest.js:2222`).

- [ ] **Step 1: Update the actions buttons markup**

In `_viewHtml`, find the actions block (currently `nest.js:2182-2187`):
```javascript
          <div class="kdnest-actions">
            <button id="kdnest-run" class="kdnest-btn kdnest-btn-run">▶ Run Nesting</button>
            <button id="kdnest-save-sheets" class="kdnest-btn kdnest-btn-save" ${nSheets ? '' : 'disabled'}>📤 Save sheets to Laser</button>
            <button id="kdnest-grain" class="kdnest-btn kdnest-btn-grain" title="Edit grain / thickness rules (shared — no Excel needed)">🧬 Grain</button>
            <button id="kdnest-stock" class="kdnest-btn kdnest-btn-stock" title="Remnant offcut stock — view / add / delete">📦 Remnants Stock</button>
          </div>
```
Replace with:
```javascript
          <div class="kdnest-actions">
            <button id="kdnest-run" class="kdnest-btn kdnest-btn-run">▶ Run Nesting</button>
            <button id="kdnest-save-sheets" class="kdnest-btn kdnest-btn-save" ${nSheets ? '' : 'disabled'} title="Upload cut sheets to Laser + save this nest job (layout, parts, stock)">💾 Save Project</button>
            <button id="kdnest-jobs" class="kdnest-btn kdnest-btn-jobs" title="Load or delete a previously saved nest job">📂 Saved Jobs</button>
            <button id="kdnest-export" class="kdnest-btn kdnest-btn-export" title="Download this nest as a JSON backup file">⬇ Export JSON</button>
            <button id="kdnest-grain" class="kdnest-btn kdnest-btn-grain" title="Edit grain / thickness rules (shared — no Excel needed)">🧬 Grain</button>
            <button id="kdnest-stock" class="kdnest-btn kdnest-btn-stock" title="Remnant offcut stock — view / add / delete">📦 Remnants Stock</button>
          </div>
```

- [ ] **Step 2: Update the wiring**

In `_wireEvents`, change line 2222 from:
```javascript
    $('#kdnest-save-sheets')?.addEventListener('click', _saveSheetsToLaser);
```
to (keep the same id, point at the renamed function, add the two new buttons):
```javascript
    $('#kdnest-save-sheets')?.addEventListener('click', _saveProject);
    $('#kdnest-jobs')?.addEventListener('click', _openSavedJobsModal);
    $('#kdnest-export')?.addEventListener('click', _exportJobJson);
```

- [ ] **Step 3: Verify no stale reference to the old function name**

Run: `grep -n "_saveSheetsToLaser" nest.js`
Expected: **no output** (the declaration was renamed in Task 2; this was the only caller).

- [ ] **Step 4: Syntax check**

Run: `node --check nest.js`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add nest.js
git commit -m "feat(nest): rename button to Save Project + add Saved Jobs / Export JSON buttons"
```

---

## Task 7: CSS for the Saved Jobs rows

**Files:**
- Modify: `style.css` — append a small block (reuses the Stock modal frame; only inner rows are new).

- [ ] **Step 1: Find an anchor**

Run: `grep -n "kdstock-head\|kdnest-btn-stock\|kdstock-row" style.css | head`
Expected: at least one match (the Stock modal styles). Note any line; append the new block at end of file regardless.

- [ ] **Step 2: Append the styles**

Append to the end of `style.css`:
```css
/* Saved Jobs popover rows (frame reuses .kdstock-* styles) */
.kdjobs-body { display: flex; flex-direction: column; gap: 8px; padding: 4px 2px; }
.kdjobs-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; border-radius: 8px;
  background: rgba(255,255,255,0.04);
}
.kdjobs-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.kdjobs-name { font-family: "Flux Architect", ui-monospace, monospace; font-size: 14px; overflow-wrap: anywhere; }
.kdjobs-meta { font-size: 12px; opacity: 0.7; }
.kdjobs-load, .kdjobs-del {
  flex: 0 0 auto; border: 0; border-radius: 6px; cursor: pointer;
  padding: 6px 12px; font-size: 13px;
}
.kdjobs-load { background: #2d7d5a; color: #fff; }
.kdjobs-del  { background: #7d2d2d; color: #fff; padding: 6px 10px; }
.kdjobs-empty { opacity: 0.7; padding: 12px; font-size: 13px; }
.kdnest-btn-jobs, .kdnest-btn-export { /* inherit .kdnest-btn; no special colour needed */ }
```

- [ ] **Step 3: Verify no Thai crept into rendered CSS content**

Run: `grep -nP "[\x{0E00}-\x{0E7F}]" style.css | tail`
Expected: no NEW Thai in the appended block (pre-existing matches elsewhere are fine; the block above is ASCII-only).

- [ ] **Step 4: Commit**

```bash
git add style.css
git commit -m "style: Saved Jobs popover rows"
```

---

## Task 8: app.js — `nest_parts` listener + accessor

**Files:**
- Modify: `app.js` — alongside `_cutSheetsCache` / `initCutSheetsSync` (`app.js:2194-2209`) and the init call list (`app.js:7783`).

- [ ] **Step 1: Add cache + listener + accessor**

After `cutSheetsForProject` (ends `app.js:2209`), insert:
```javascript

// ── Nest parts snapshot (latest Save Project per project) ──────────────
// Written by nest.js _saveProject to nest_parts/<pk>. The Laser Cut List
// merges this so manual rects + grain/qty edits made in the Nest workspace
// reach the laser worker. app.js only READS this node.
let _nestPartsCache = {};
function initNestPartsSync() {
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('nest_parts').on('value', snap => {
      _nestPartsCache = snap.val() || {};
      if (typeof render === 'function') render();
    });
  } catch (e) {
    console.warn('Firebase nest_parts listener failed:', e);
  }
}
function nestPartsForProject(projectKey) {
  if (!projectKey || !_nestPartsCache) return [];
  const node = _nestPartsCache[projectKey];
  return (node && Array.isArray(node.parts)) ? node.parts : [];
}
```

- [ ] **Step 2: Call the init alongside the others**

At the init list (`app.js:7783`), after `initCutSheetsSync();` add:
```javascript
  initNestPartsSync();
```

- [ ] **Step 3: Syntax check**

Run: `node --check app.js`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat(app): nest_parts Firebase listener + nestPartsForProject accessor"
```

---

## Task 9: app.js — merge nest_parts into the Laser Cut List

Append manual-rect codes absent from the manifest; override grain/qty when the code matches an aggregated row.

**Files:**
- Modify: `app.js` — `_renderCutList` (aggregation at `app.js:810-832`; grain cell at `app.js:855-860`).

- [ ] **Step 1: Merge nest parts into the aggregated list**

In `_renderCutList`, immediately after the aggregation line `const aggregated = _aggregatePartsByCode(parts);` (`app.js:811`), insert:
```javascript
  // Merge the latest nest snapshot: override grain/qty on matching codes and
  // append nest-only codes (manual rectangles) the manifest doesn't know about.
  // (user 2026-05-30 'sync รายละเอียด Part ไปด้วย')
  const _nestParts = (typeof nestPartsForProject === 'function')
    ? nestPartsForProject(projectKey) : [];
  const _nestByCode = new Map(_nestParts.map(np => [np.code, np]));
  const _aggByCode = new Map(aggregated.map(a => [a.code, a]));
  for (const np of _nestParts) {
    const row = _aggByCode.get(np.code);
    if (row) {
      if (np.qty) row.qty = np.qty;          // nest qty wins (latest truth)
      row._nestGrain = np.grain || null;     // grain override consumed below
    } else {
      aggregated.push({
        code: np.code, qty: np.qty || 0,
        family: 'Other', urn: null,
        _nestGrain: np.grain || null, _nestOnly: true,
      });
    }
  }
```

- [ ] **Step 2: Prefer the nest grain in the grain cell**

In the per-row render, find the grain lookup (currently `app.js:856-859`):
```javascript
        if (window.kdNest && typeof window.kdNest.lookupGrain === 'function') {
          const g = window.kdNest.lookupGrain(p.code) || '?';
          const gly = window.kdNest.grainGlyph(g);
          grainCell = `<span class="cut-grain ${gly.cls}" title="${gly.title}">${gly.ch}</span>`;
        }
```
Replace with (prefer the per-part nest grain, fall back to the shared rule):
```javascript
        if (window.kdNest && typeof window.kdNest.grainGlyph === 'function') {
          const g = p._nestGrain
            || (typeof window.kdNest.lookupGrain === 'function' ? window.kdNest.lookupGrain(p.code) : null)
            || '?';
          const gly = window.kdNest.grainGlyph(g);
          grainCell = `<span class="cut-grain ${gly.cls}" title="${gly.title}">${gly.ch}</span>`;
        }
```

- [ ] **Step 3: Syntax check**

Run: `node --check app.js`
Expected: exits 0.

- [ ] **Step 4: Logic self-check (read, don't run)**

Confirm: `_nestOnly` rows flow through the existing row renderer unchanged — they have `code`/`qty`/`family`, so `_remapFamilyForCode(p.code, p.family)` (`app.js:828`) groups them, and with no DXF they render `⚠ no DXF` (correct — a manual rect has no uploaded DXF). The `#N` nest-number map (`app.js:819-822`) re-sorts all aggregated codes including the appended ones, so numbering stays consistent.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "feat(app): Laser Cut List merges nest_parts (append manual rects + grain/qty override)"
```

---

## Task 10: app.js — per-sheet parts summary in the Cut Sheets popover

**Files:**
- Modify: `app.js` — `_renderCutSheetsModal` row markup (`app.js:1244-1262`).

- [ ] **Step 1: Render a parts summary line when present**

In the `sheets.map(s => { ... })` block, after the `const via = ...` line (`app.js:1251`), add:
```javascript
        const partsSummary = Array.isArray(s.parts) && s.parts.length
          ? s.parts.map(pt => `${escapeHtml(pt.code)}×${pt.qty || 1}`).join(', ')
          : '';
```
Then in the row template, after the `<span class="cs-sub">…</span>` line (`app.js:1257`), add a conditional line:
```javascript
              ${partsSummary ? `<span class="cs-parts" title="Parts on this sheet">${partsSummary}</span>` : ''}
```
So the `.cs-row-main` block reads:
```javascript
            <div class="cs-row-main">
              <span class="cs-filename">${escapeHtml(filename)}</span>
              <span class="cs-meta">${thMm} · ${parts}${sz ? ' · ' + sz : ''}</span>
              <span class="cs-sub">${escapeHtml(ago)}${via}</span>
              ${partsSummary ? `<span class="cs-parts" title="Parts on this sheet">${partsSummary}</span>` : ''}
            </div>
```

- [ ] **Step 2: Add a small style for `.cs-parts`**

Append to `style.css`:
```css
.cs-parts { font-size: 11px; opacity: 0.65; overflow-wrap: anywhere; margin-top: 2px; }
```

- [ ] **Step 3: Syntax check**

Run: `node --check app.js`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add app.js style.css
git commit -m "feat(app): Cut Sheets popover shows per-sheet parts summary"
```

---

## Task 11: Integration verification + deploy

No automated tests exist; verify by syntax + grep invariants, then deploy and confirm live, then have เอ๋ eyeball the runtime flow.

- [ ] **Step 1: Full syntax pass**

Run: `node --check nest.js && node --check app.js && echo OK`
Expected: `OK`.

- [ ] **Step 2: Invariant greps**

Run: `grep -c "_saveSheetsToLaser" nest.js` → expect `0`.
Run: `grep -c "_saveProject\|_restoreJob\|_openSavedJobsModal\|_exportJobJson\|_buildJob" nest.js` → expect `>= 6`.
Run: `grep -c "nestPartsForProject\|initNestPartsSync\|_nestPartsCache" app.js` → expect `>= 4`.

- [ ] **Step 3: Push (rebase first — Group 1 shares this dir)**

```bash
git pull --rebase origin main
git push origin main
```
Then confirm: `LOCAL=$(git rev-parse HEAD)` equals `REMOTE=$(git rev-parse origin/main)`.

- [ ] **Step 4: Confirm Pages serves the new code**

Poll until live (Pages lags ~1 min):
```bash
n=0; until curl -s "https://wuttichaisaeton.github.io/kitchen-drawings-rd2026/nest.js?v=$(date +%s)$n" -o /tmp/lnest.js && grep -q '_saveProject' /tmp/lnest.js; do n=$((n+1)); [ $n -gt 40 ] && { echo TIMEOUT; break; }; sleep 8; done; grep -c '_saveProject' /tmp/lnest.js
```
Expected: a non-zero count (new nest.js live).

- [ ] **Step 5: Runtime eyeball (เอ๋ — preview MCP is avoided; check on the live site, Bung 01)**

Verify in order:
1. Nest workspace shows `💾 Save Project`, `📂 Saved Jobs`, `⬇ Export JSON`.
2. Run Nesting → add a manual rect → toggle a grain → `💾 Save Project` → alert reports "Nest job: saved".
3. Reload the page → open the project's Nest → `📂 Saved Jobs` → the job is listed → Load → the saved layout + manual rect + grain return (no re-run).
4. Switch to Laser role → open the project → Cut List shows the manual-rect code as a row, and the toggled grain matches.
5. Project view → `📐 Cut Sheets` → each sheet row shows a `CODE×N, …` parts line.
6. `⬇ Export JSON` → a `<pk>_nest_<stamp>.json` file lands in Downloads.
7. `📂 Saved Jobs` (admin) → `✕` on a job → it disappears from the list.

- [ ] **Step 6: Update the coordination board + commit**

Append a `## [date] Group 2 (Web) → Group 1 (Fusion)` entry to `docs/coordination/group-sync.md` summarizing: Save Project shipped; new RTDB nodes `nest_jobs/<pk>/<jobId>`, `nest_parts/<pk>`, and the optional `parts[]` field added to `cut_sheets/<pk>/<id>` (FYI for CC_Laser — it can keep writing cut_sheets without `parts[]`; the web shows no per-sheet summary for those). Then:
```bash
git add docs/coordination/group-sync.md
git pull --rebase origin main
git commit -m "coord(Group2->1): Save Project shipped — nest_jobs/nest_parts/cut_sheets.parts[]"
git push origin main
```

---

## Self-Review (completed during planning)

**Spec coverage:**
- Rename button → Task 6. ✅
- Cut sheets + `parts[]` → Task 1 (`_sheetPartsSummary`) + Task 2 (step 3). ✅
- `nest_jobs` history → Task 2 (step 4). ✅
- `nest_parts` snapshot → Task 2 (step 4). ✅
- localStorage backup → Task 2 (step 4). ✅
- Saved Jobs popover (load/delete) → Task 4. ✅
- Restore (re-parse + re-attach) → Task 3. ✅
- Export JSON button (separate) → Task 5 + Task 6. ✅
- Cut List merge (append manual + override grain/qty) → Task 8 + Task 9. ✅
- Per-sheet parts summary in popover → Task 10. ✅
- No import in v1 → not implemented (correct). ✅
- English UI, `git add` by path, rebase-before-push → Tasks 6/7/11. ✅

**Type/name consistency:** `_buildJob`/`_serializePart`/`_serializeSheet`/`_sheetPartsSummary`/`_jobStamp`/`_jobLabel` (Task 1) are consumed by `_saveProject` (Task 2) and `_exportJobJson` (Task 5); `_restoreJob` (Task 3) is called by the Saved Jobs popover (Task 4) and references `_newPart`/`_newManualPart`/`_loadAllDxfs`/`_refreshView` (existing). `nestPartsForProject` (Task 8) is consumed by `_renderCutList` (Task 9). Button ids `kdnest-save-sheets` (kept), `kdnest-jobs`, `kdnest-export` match between markup (Task 6 step 1) and wiring (Task 6 step 2). RTDB paths identical across spec + Tasks 2/4/8. ✅

**Placeholder scan:** no TBD/TODO; every code step shows full code. ✅
