# DXF Storage on Web — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Scope gate:** Tasks 1–7 modify `drawings-ui/*` and are pre-approved by the session handoff. **Tasks 8–11 modify `_MASTERS/fusion_scripts/CC_Laser/`** — outside the handoff's working dir. Before dispatching any subagent to Tasks 8+, get explicit user confirmation: *"Yes, work in _MASTERS now."* If the user declines, stop after Task 7; Phase B can be re-planned later.

**Goal:** Make every laser-cut `.dxf` exported by CC_Laser available via the web app, keyed by master code, with admin-only download affordance in the Library. Workshop sees nothing.

**Architecture:** Two halves, glued by a Firebase RTDB contract (`uploaded_dxfs/<dxf_stem>` flat, with a `master_code` field). Fusion side adds a step in CC_Laser that prompts the admin to point at the just-exported folder, scans it, then PUTs each DXF to GitHub Contents API + writes metadata to RTDB. Web side adds a passive RTDB listener that surfaces a 📐 button (or `📐 N` count) on Library part-rows for admin users only — click downloads when N=1, opens a popover when N>1.

**Tech Stack:** Vanilla JS shell (`app.js`), plain CSS (`style.css`), Firebase RTDB JS SDK, GitHub Contents API (admin PAT in `localStorage[kd_github_pat_v1]` web-side / `~/.cc_laser_config.json` Fusion-side). Fusion side: pure Python `urllib` + `adsk.core` UI. No test framework on either side — verification is preview-MCP for web (port 3030) and manual checklist for Fusion.

**Spec:** [docs/superpowers/specs/2026-05-28-dxf-storage-on-web-design.md](../specs/2026-05-28-dxf-storage-on-web-design.md)

---

## File Structure

| File | Role | Change type |
|---|---|---|
| `drawings-ui/app.js` | Cache + listener + lookup + click + render hook | Modify |
| `drawings-ui/style.css` | `.part-dxf-btn`, `.part-dxf-popover`, dismiss overlay | Modify |
| `_MASTERS/fusion_scripts/CC_Laser/dxf_uploader.py` | Config + GH PUT + RTDB PUT + `upload()` entry point | Create |
| `_MASTERS/fusion_scripts/CC_Laser/CC_Laser.py` | Insert Step 5.5 between Parts-List PNG and Nesting-Tool launch | Modify (lines 208–217) |

No new web files. The Fusion helper is a sibling module imported by CC_Laser; it does NOT register in `JSLoadedScriptsinfo` (only the entry-point script does — per the `register_scripts` memory rule).

---

## Pre-flight: dev server + iPad-sim viewport

- [ ] **Step 0.1: List preview servers**

```
mcp__Claude_Preview__preview_list
```

Expected: a server named `drawings-ui` on port 3030. If absent, start one:

```
mcp__Claude_Preview__preview_start { name: "drawings-ui" }
```

Capture the `serverId` — every later preview step needs it. Replace `<sid>` placeholder.

- [ ] **Step 0.2: Set iPad Pro 12.9 portrait viewport**

```
mcp__Claude_Preview__preview_resize { serverId: <sid>, width: 1024, height: 1366 }
```

Expected: `Viewport set to 1024x1366.`

- [ ] **Step 0.3: Confirm spec commit is on origin/main**

```bash
git log --oneline origin/main | head -3
```

Expected to see `7b0986e docs: DXF storage on web — design spec`. If not, abort — the plan must execute against a committed spec.

---

## Phase A — Web side (drawings-ui)

### Task 1: Add `_uploadedDxfsCache` state + RTDB listener

**Files:**
- Modify: `app.js:727` (state declaration, after `_uploadedPdfsCache`)
- Modify: `app.js:788` (helper, after `initUploadedPdfsSync`)
- Modify: `app.js:5428` (wire into `init()`)

**Why first:** The cache + listener is the foundation everything else reads from. Without it, no later step can be verified.

- [ ] **Step 1.1: Inspect the existing PDF pattern (read-only)**

```
Read app.js:727
Read app.js:778-788
```

Confirm the shape: `let _uploadedPdfsCache = {};` at module scope, `initUploadedPdfsSync()` subscribes to `uploaded_pdfs` and calls `render()` on snapshot.

- [ ] **Step 1.2: Add `_uploadedDxfsCache` declaration**

Insert directly after the existing `let _uploadedPdfsCache = {};` on line 727:

```js
// ── Uploaded DXF cache (admin-only, mirrors uploaded_pdfs pattern) ──
// Keyed by <dxf_stem> (per-panel). Each value carries a `master_code`
// field that ties it to a Library row's data-code. Multi-panel masters
// have N entries — see dxfsForMasterCode() below for the lookup.
let _uploadedDxfsCache = {};
```

- [ ] **Step 1.3: Add `initUploadedDxfsSync` listener**

Insert after the existing `initUploadedPdfsSync` block (which ends at line 788). The render gate is `isAdmin()` — workshop never repaints on DXF cache changes.

```js
function initUploadedDxfsSync() {
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('uploaded_dxfs').on('value', snap => {
      _uploadedDxfsCache = snap.val() || {};
      // Workshop never sees the 📐 button — skip the full render so a
      // burst of uploads doesn't repaint the workshop iPad needlessly.
      if (isAdmin()) {
        try { render(); } catch {}
      }
    });
  } catch (e) {
    console.warn('Firebase uploaded_dxfs listener failed:', e);
  }
}
```

- [ ] **Step 1.4: Wire into `init()`**

In `init()` (line 5415+), after `initUploadedPdfsSync();` on line 5428, add:

```js
  initUploadedDxfsSync();
```

The diff context should look like:

```js
  initUploadedPdfsSync();
  initUploadedDxfsSync();
  initActiveRowsSync();
```

- [ ] **Step 1.5: Verify listener attaches without error**

```
mcp__Claude_Preview__preview_eval {
  serverId: <sid>,
  expression: `
    (() => {
      // Force a refresh so the new code loads
      location.reload();
      return 'reloading';
    })()
  `
}
```

Wait 2 seconds, then:

```
mcp__Claude_Preview__preview_console_logs { serverId: <sid> }
```

Expected: NO line containing `Firebase uploaded_dxfs listener failed`. Empty `_uploadedDxfsCache` is fine — no data yet.

Then verify the variable exists:

```
mcp__Claude_Preview__preview_eval {
  serverId: <sid>,
  expression: `typeof _uploadedDxfsCache`
}
```

Expected: `"object"`.

- [ ] **Step 1.6: Commit**

```bash
git add app.js
git commit -m "feat(dxf): subscribe to uploaded_dxfs RTDB node

Mirrors initUploadedPdfsSync pattern. Gates re-render behind isAdmin()
so workshop iPads don't repaint when admin's CC_Laser uploads a batch.
Cache is keyed by <dxf_stem> per the per-panel schema in the spec —
the lookup-by-master_code helper lands in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add `dxfsForMasterCode(masterCode)` lookup

**Files:**
- Modify: `app.js` (place new function adjacent to `pdfUrlForCode`, around line 276)

**Why now:** Renderer (Task 3) and click handler (Tasks 4-5) both call this. Land the function first so subsequent tasks have a verified primitive.

- [ ] **Step 2.1: Add the lookup function**

Place after the closing brace of `pdfUrlForCode`. Filters the flat cache by `master_code` field, sorted by filename for deterministic UI:

```js
// Return all uploaded DXFs whose master_code matches the given Library
// row code. Returns an array (possibly empty) sorted by filename so the
// popover ordering is stable across re-renders.
function dxfsForMasterCode(masterCode) {
  if (!masterCode || !_uploadedDxfsCache) return [];
  const out = [];
  for (const [stem, meta] of Object.entries(_uploadedDxfsCache)) {
    if (meta && meta.master_code === masterCode) {
      out.push({ stem, ...meta });
    }
  }
  out.sort((a, b) => (a.filename || a.stem).localeCompare(b.filename || b.stem));
  return out;
}
```

- [ ] **Step 2.2: Verify with seeded cache via preview**

```
mcp__Claude_Preview__preview_eval {
  serverId: <sid>,
  expression: `
    (() => {
      _uploadedDxfsCache = {
        "Back-Panel":  { url: "https://example.com/b.dxf", filename: "Back-Panel.dxf",  master_code: "100VB0-110000", size_bytes: 1, thickness_mm: 1, material: "ALPF", grain: "", exported_at: 0, uploaded_at: 0 },
        "Front-Panel": { url: "https://example.com/a.dxf", filename: "Front-Panel.dxf", master_code: "100VB0-110000", size_bytes: 1, thickness_mm: 1, material: "ALPF", grain: "", exported_at: 0, uploaded_at: 0 },
        "Side-Panel":  { url: "https://example.com/c.dxf", filename: "Side-Panel.dxf",  master_code: "OTHER-MASTER", size_bytes: 1, thickness_mm: 1, material: "ALPF", grain: "", exported_at: 0, uploaded_at: 0 },
      };
      const hit  = dxfsForMasterCode("100VB0-110000");
      const miss = dxfsForMasterCode("DOES-NOT-EXIST");
      return {
        hitCount: hit.length,
        hitOrder: hit.map(x => x.filename),
        missCount: miss.length,
        otherCount: dxfsForMasterCode("OTHER-MASTER").length
      };
    })()
  `
}
```

Expected:
```js
{
  hitCount: 2,
  hitOrder: ["Back-Panel.dxf", "Front-Panel.dxf"],  // alphabetical
  missCount: 0,
  otherCount: 1
}
```

If hitOrder is reversed, the `localeCompare` direction is wrong — fix before committing.

- [ ] **Step 2.3: Reset cache**

```
mcp__Claude_Preview__preview_eval {
  serverId: <sid>,
  expression: `_uploadedDxfsCache = {}; 'reset'`
}
```

- [ ] **Step 2.4: Commit**

```bash
git add app.js
git commit -m "feat(dxf): dxfsForMasterCode lookup helper

Filters flat _uploadedDxfsCache by master_code field and returns a
filename-sorted array. Per-panel keying is per the spec's Q6
resolution — Library rows are master-coded but a single master may
have N exported DXFs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Render `📐` button in `renderFamily` for admin

**Files:**
- Modify: `app.js:5095-5098` (extend `adminBtns` template)
- Modify: `app.js:5132` (extend click-delegation skip selector)

- [ ] **Step 3.1: Extend `adminBtns` to append a DXF button when N≥1**

Locate `renderFamily` at line 5079. The existing admin button block at lines 5095–5098 builds two buttons (✎ and 📁). Replace it with a version that also appends a 📐 button when there are uploaded DXFs:

```js
    // Admin gets a pencil button on the right to rename (display only —
    // the underlying p.code stays as the data key for PDF / RTDB), a
    // folder button to move the part to a different family chip, AND a
    // DXF button to download the laser-cut source files. The DXF button
    // is only present if at least one DXF has been uploaded for this
    // master code (CC_Laser pushed metadata into uploaded_dxfs).
    let adminBtns = '';
    if (adminMode) {
      const dxfList = dxfsForMasterCode(p.code);
      const dxfBtn = dxfList.length > 0
        ? `<button class="part-dxf-btn" data-dxf-code="${escapeHtml(p.code)}" aria-label="${dxfList.length === 1 ? 'Download DXF' : 'Download DXFs'}" title="${dxfList.length === 1 ? 'Download laser-cut DXF' : `Download one of ${dxfList.length} DXFs`}">📐${dxfList.length > 1 ? ' ' + dxfList.length : ''}</button>`
        : '';
      adminBtns = `<button class="part-rename-btn" data-rename-code="${escapeHtml(p.code)}" aria-label="Rename display" title="Rename display (does not change the Fusion-side code)">✎</button>
         <button class="part-folder-btn" data-folder-code="${escapeHtml(p.code)}" aria-label="Move to folder" title="Move to a different folder / create new folder">📁</button>${dxfBtn}`;
    }
```

(Replaces the `const adminBtns = adminMode ? ... : '';` ternary on lines 5095–5098.)

- [ ] **Step 3.2: Extend click-delegation skip selector**

The row-level click handler at line 5132 skips clicks on admin buttons so the row's "open PDF" handler doesn't fire when admin clicks ✎ or 📁. Add `.part-dxf-btn` to the skip list:

```js
      // Ignore clicks on admin buttons — each has its own handler.
      if (ev.target.closest('.part-rename-btn, .part-folder-btn, .part-dxf-btn')) return;
```

- [ ] **Step 3.3: Verify button renders in admin mode for matching code**

```
mcp__Claude_Preview__preview_eval {
  serverId: <sid>,
  expression: `
    (() => {
      // Force admin mode
      localStorage.setItem('kd_admin_v1', '1');
      // Seed a single DXF
      _uploadedDxfsCache = {
        "Front-Panel": { url: "https://example.com/a.dxf", filename: "Front-Panel.dxf", master_code: "100VB0-110000", size_bytes: 1, thickness_mm: 1, material: "ALPF", grain: "", exported_at: 0, uploaded_at: 0 }
      };
      render();
      // Navigate to Library + drill into the family that contains 100VB0-110000
      document.getElementById('tab-library').click();
      // Wait one tick for re-render, then find a family that includes our code.
      // (We'll do this in a fresh eval below.)
      return 'seeded; click family next';
    })()
  `
}
```

```
mcp__Claude_Preview__preview_snapshot { serverId: <sid> }
```

Find the family card that contains a part with code `100VB0-110000` (varies by test data). Then:

```
mcp__Claude_Preview__preview_click { serverId: <sid>, ref: <family-card-ref-from-snapshot> }
```

```
mcp__Claude_Preview__preview_snapshot { serverId: <sid> }
```

Expected: the part-row for `100VB0-110000` shows `📐` (no count when N=1). Other rows show no 📐.

- [ ] **Step 3.4: Verify N>1 shows count**

```
mcp__Claude_Preview__preview_eval {
  serverId: <sid>,
  expression: `
    _uploadedDxfsCache = {
      "Front-Panel": { url: "https://example.com/a.dxf", filename: "Front-Panel.dxf", master_code: "100VB0-110000", size_bytes: 1, thickness_mm: 1, material: "ALPF", grain: "", exported_at: 0, uploaded_at: 0 },
      "Back-Panel":  { url: "https://example.com/b.dxf", filename: "Back-Panel.dxf",  master_code: "100VB0-110000", size_bytes: 1, thickness_mm: 1, material: "ALPF", grain: "", exported_at: 0, uploaded_at: 0 },
      "Base-Panel":  { url: "https://example.com/c.dxf", filename: "Base-Panel.dxf",  master_code: "100VB0-110000", size_bytes: 1, thickness_mm: 1, material: "ALPF", grain: "", exported_at: 0, uploaded_at: 0 }
    };
    render();
    'reseeded with 3'
  `
}
```

```
mcp__Claude_Preview__preview_snapshot { serverId: <sid> }
```

Expected: the part-row's button text is `📐 3`.

- [ ] **Step 3.5: Verify workshop sees nothing**

```
mcp__Claude_Preview__preview_eval {
  serverId: <sid>,
  expression: `
    localStorage.removeItem('kd_admin_v1');
    render();
    'workshop mode'
  `
}
```

```
mcp__Claude_Preview__preview_snapshot { serverId: <sid> }
```

Expected: no `.part-dxf-btn` anywhere in the snapshot. The 📐 button must not be visible in workshop mode regardless of cache contents.

- [ ] **Step 3.6: Re-enable admin and reset cache for the next task**

```
mcp__Claude_Preview__preview_eval {
  serverId: <sid>,
  expression: `
    localStorage.setItem('kd_admin_v1', '1');
    _uploadedDxfsCache = {};
    render();
    'admin-on, cache-cleared'
  `
}
```

- [ ] **Step 3.7: Commit**

```bash
git add app.js
git commit -m "feat(dxf): render 📐 button on admin Library part-rows

When dxfsForMasterCode(p.code) returns >= 1 entry and admin mode is
active, append a 📐 button (or '📐 N' for N>1) next to the existing
✎ and 📁 chips. Click delegation skip-list updated so taps on the
new button don't bubble to the row's PDF-open handler. Workshop never
sees the button — the cache listener gates render() behind isAdmin()
and the template builds adminBtns only when adminMode is true.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire `📐` click → direct download for N=1

**Files:**
- Modify: `app.js` (new handler near the existing `.part-rename-btn` handler, around line 5143)

- [ ] **Step 4.1: Add a small download helper**

Place adjacent to the existing `_openInNewTab` helper (or near `getGitHubPat`, whichever is more visible — search for `_openInNewTab` to find the right neighbourhood). This helper triggers a browser download via an anchor tag with the `download` attribute:

```js
// Trigger a browser download for a remote URL. Uses an anchor element
// with the `download` attribute so .dxf files (which Pages serves as
// application/octet-stream) land in the user's Downloads folder rather
// than rendering inline as text.
function _downloadFile(url, suggestedName) {
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName || '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
```

- [ ] **Step 4.2: Add the `.part-dxf-btn` click handler**

Inside `renderFamily`, after the existing `.part-rename-btn` and `.part-folder-btn` handler blocks (around line 5202), add:

```js
  // Admin DXF button: N=1 triggers direct download, N>1 opens a popover
  // anchored to the button. Popover landing in Task 5; for now, N=1 path
  // only — N>1 will fall through to console.warn until Task 5.
  ROOT.querySelectorAll('.part-dxf-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const code = btn.dataset.dxfCode;
      const list = dxfsForMasterCode(code);
      if (list.length === 0) return;  // race: render saw N>=1 but cache cleared since
      if (list.length === 1) {
        _downloadFile(list[0].url, list[0].filename || `${list[0].stem}.dxf`);
        return;
      }
      // N > 1 — popover lands in Task 5. Temporary fallback so testing
      // doesn't break: download the first file with a console warning.
      console.warn(`[dxf] N=${list.length}, popover not yet implemented — downloading first only`);
      _downloadFile(list[0].url, list[0].filename || `${list[0].stem}.dxf`);
    });
  });
```

- [ ] **Step 4.3: Verify N=1 direct download**

```
mcp__Claude_Preview__preview_eval {
  serverId: <sid>,
  expression: `
    localStorage.setItem('kd_admin_v1', '1');
    _uploadedDxfsCache = {
      "Solo": { url: "https://kitchen-drawings-rd2026.github.io/Drawings/dxf/100VB0-110000/Solo.dxf", filename: "Solo.dxf", master_code: "100VB0-110000", size_bytes: 1, thickness_mm: 1, material: "ALPF", grain: "", exported_at: 0, uploaded_at: 0 }
    };
    render();
    document.getElementById('tab-library').click();
    'ready — click 100VB0-110000 family next'
  `
}
```

Drill into the family in another snapshot/click pair, then click the 📐 button:

```
mcp__Claude_Preview__preview_snapshot { serverId: <sid> }
```

```
mcp__Claude_Preview__preview_click { serverId: <sid>, ref: <dxf-btn-ref> }
```

```
mcp__Claude_Preview__preview_network { serverId: <sid>, since: -10 }
```

Expected: a GET (or HEAD, depending on browser) to `kitchen-drawings-rd2026.github.io/Drawings/dxf/100VB0-110000/Solo.dxf`. (May 404 because the file doesn't exist on the server yet — that's fine. We're verifying the click triggered the network request.)

- [ ] **Step 4.4: Verify N>1 falls through gracefully (Task 5 will replace this)**

```
mcp__Claude_Preview__preview_eval {
  serverId: <sid>,
  expression: `
    _uploadedDxfsCache = {
      "A": { url: "https://example.com/a.dxf", filename: "A.dxf", master_code: "100VB0-110000", size_bytes: 1, thickness_mm: 1, material: "ALPF", grain: "", exported_at: 0, uploaded_at: 0 },
      "B": { url: "https://example.com/b.dxf", filename: "B.dxf", master_code: "100VB0-110000", size_bytes: 1, thickness_mm: 1, material: "ALPF", grain: "", exported_at: 0, uploaded_at: 0 }
    };
    render();
    'reseeded with 2'
  `
}
```

Click 📐 on the row, then:

```
mcp__Claude_Preview__preview_console_logs { serverId: <sid> }
```

Expected: a `[dxf] N=2, popover not yet implemented — downloading first only` warning. This is the temporary fallback from Step 4.2.

- [ ] **Step 4.5: Commit**

```bash
git add app.js
git commit -m "feat(dxf): 📐 click handler — direct download for N=1

Adds _downloadFile helper using an anchor tag with download= attribute
(Pages serves .dxf as octet-stream; without the attribute the browser
may try to render). The handler picks the single match for N=1 and
falls through to a console.warn for N>1 — popover lands in the next
task. Click event uses stopPropagation so the row's PDF-open handler
doesn't fire on the same tap.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Replace fallback with a real popover for N>1

**Files:**
- Modify: `app.js` (replace the warn-and-download fallback inside the `.part-dxf-btn` handler)

- [ ] **Step 5.1: Add popover render helper**

Insert above the `.part-dxf-btn` click handler block. The popover is appended to `document.body` (not the row) so positioning works regardless of overflow/scroll containers:

```js
// Build a DXF popover anchored below the trigger button. Returns the
// popover element so the caller can wire up its own dismiss handlers.
// Closed via outside-click, Escape, or scroll.
function _renderDxfPopover(triggerBtn, list) {
  // Remove any prior popover (only one at a time)
  document.querySelectorAll('.part-dxf-popover').forEach(p => p.remove());

  const pop = document.createElement('div');
  pop.className = 'part-dxf-popover';
  pop.setAttribute('role', 'menu');
  pop.innerHTML = list.map((item, i) => `
    <button class="part-dxf-popover-row" data-dxf-url="${escapeHtml(item.url)}" data-dxf-name="${escapeHtml(item.filename || item.stem + '.dxf')}" role="menuitem">
      <span class="part-dxf-popover-icon">📐</span>
      <span class="part-dxf-popover-name">${escapeHtml(item.filename || item.stem + '.dxf')}</span>
    </button>
  `).join('');

  document.body.appendChild(pop);

  // Position below the button, right-aligned
  const r = triggerBtn.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top  = (r.bottom + 4) + 'px';
  pop.style.right = (window.innerWidth - r.right) + 'px';

  // Row click → download + dismiss
  pop.querySelectorAll('.part-dxf-popover-row').forEach(row => {
    row.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _downloadFile(row.dataset.dxfUrl, row.dataset.dxfName);
      pop.remove();
    });
  });

  // Outside-click dismiss — attach on next tick so the opening click
  // doesn't immediately dismiss the popover it just opened.
  setTimeout(() => {
    const dismiss = (ev) => {
      if (!pop.contains(ev.target)) {
        pop.remove();
        document.removeEventListener('click',     dismiss, true);
        document.removeEventListener('keydown',   onKey);
        window.removeEventListener('scroll',      onScroll, true);
      }
    };
    const onKey = (ev) => { if (ev.key === 'Escape') dismiss({ target: document.body }); };
    const onScroll = () => dismiss({ target: document.body });
    document.addEventListener('click',     dismiss, true);
    document.addEventListener('keydown',   onKey);
    window.addEventListener('scroll',      onScroll, true);
  }, 0);

  return pop;
}
```

- [ ] **Step 5.2: Replace the N>1 fallback with the real popover**

Inside the `.part-dxf-btn` click handler, change the `if (list.length === 1)` block to:

```js
      if (list.length === 1) {
        _downloadFile(list[0].url, list[0].filename || `${list[0].stem}.dxf`);
        return;
      }
      _renderDxfPopover(btn, list);
```

(Remove the `console.warn(...)` line and the temporary fallback download.)

- [ ] **Step 5.3: Verify N>1 opens popover with N rows in correct order**

```
mcp__Claude_Preview__preview_eval {
  serverId: <sid>,
  expression: `
    localStorage.setItem('kd_admin_v1', '1');
    _uploadedDxfsCache = {
      "Z-Last":  { url: "https://example.com/z.dxf", filename: "Z-Last.dxf",  master_code: "100VB0-110000", size_bytes: 1, thickness_mm: 1, material: "ALPF", grain: "", exported_at: 0, uploaded_at: 0 },
      "A-First": { url: "https://example.com/a.dxf", filename: "A-First.dxf", master_code: "100VB0-110000", size_bytes: 1, thickness_mm: 1, material: "ALPF", grain: "", exported_at: 0, uploaded_at: 0 },
      "M-Mid":   { url: "https://example.com/m.dxf", filename: "M-Mid.dxf",   master_code: "100VB0-110000", size_bytes: 1, thickness_mm: 1, material: "ALPF", grain: "", exported_at: 0, uploaded_at: 0 }
    };
    render();
    'ready — drill in + click 📐 3'
  `
}
```

Drill into the family, click 📐, then snapshot:

```
mcp__Claude_Preview__preview_snapshot { serverId: <sid> }
```

Expected: a `.part-dxf-popover` element exists with 3 rows in order: A-First.dxf, M-Mid.dxf, Z-Last.dxf (filename-sorted per Task 2's contract).

- [ ] **Step 5.4: Click a popover row → download + dismiss**

```
mcp__Claude_Preview__preview_click { serverId: <sid>, ref: <M-Mid-row-ref> }
```

```
mcp__Claude_Preview__preview_network { serverId: <sid>, since: -5 }
mcp__Claude_Preview__preview_snapshot { serverId: <sid> }
```

Expected: network includes a GET to `https://example.com/m.dxf`, and the popover is gone from the snapshot.

- [ ] **Step 5.5: Outside-click dismiss**

Re-open the popover (click 📐 again), then click empty space:

```
mcp__Claude_Preview__preview_click { serverId: <sid>, ref: <main-content-ref-outside-popover> }
```

```
mcp__Claude_Preview__preview_snapshot { serverId: <sid> }
```

Expected: no `.part-dxf-popover` in the snapshot.

- [ ] **Step 5.6: Reset cache and commit**

```
mcp__Claude_Preview__preview_eval {
  serverId: <sid>,
  expression: `_uploadedDxfsCache = {}; render(); 'reset'`
}
```

```bash
git add app.js
git commit -m "feat(dxf): popover for N>1 DXFs per master

Replaces the temporary console.warn fallback with a fixed-position
popover anchored below the 📐 button. One row per DXF, filename-sorted
(deterministic UI on re-render). Click a row → _downloadFile +
auto-dismiss. Outside-click, Escape, or scroll also dismiss — listeners
are attached on next tick so the opening click doesn't immediately
close the popover, and they detach on dismiss to avoid leaks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Add CSS for `.part-dxf-btn` and `.part-dxf-popover`

**Files:**
- Modify: `style.css` (place near existing `.part-edit-btn` / `.part-rename-btn` rules)

- [ ] **Step 6.1: Find the existing admin-button styles**

```
Grep ".part-rename-btn|.part-folder-btn" in style.css
```

Insert the new rules immediately after the existing admin button block so the cascade ordering stays predictable.

- [ ] **Step 6.2: Add `.part-dxf-btn` styles**

```css
/* --- DXF download button (admin Library row) --- */
/* Cyan to differentiate from ✎ (white) and 📁 (white). Size matches
   the other admin chips so the row's vertical rhythm stays consistent. */
.part-dxf-btn {
  margin-left: 8px;
  padding: 6px 10px;
  background: #0e3a45;
  color: #5fd4e8;
  border: 1px solid #145265;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.05s ease;
  min-height: 32px;
  min-width: 32px;
}
.part-dxf-btn:hover { background: #144e5e; }
.part-dxf-btn:active { transform: scale(0.96); }
```

- [ ] **Step 6.3: Add `.part-dxf-popover` styles**

```css
/* --- DXF download popover (N > 1) --- */
.part-dxf-popover {
  z-index: 9999;
  background: #1a2628;
  border: 1px solid #2a4a52;
  border-radius: 10px;
  padding: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  min-width: 220px;
  max-width: 320px;
  max-height: 60vh;
  overflow-y: auto;
}
.part-dxf-popover-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  background: transparent;
  border: none;
  color: #d6ecf0;
  padding: 10px 12px;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  border-radius: 6px;
}
.part-dxf-popover-row:hover { background: #243a3f; }
.part-dxf-popover-row:active { background: #2c474d; }
.part-dxf-popover-icon { font-size: 16px; opacity: 0.85; }
.part-dxf-popover-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

- [ ] **Step 6.4: Verify visual quality**

```
mcp__Claude_Preview__preview_eval {
  serverId: <sid>,
  expression: `
    localStorage.setItem('kd_admin_v1', '1');
    _uploadedDxfsCache = {
      "A": { url: "https://example.com/a.dxf", filename: "A.dxf", master_code: "100VB0-110000", size_bytes: 1, thickness_mm: 1, material: "ALPF", grain: "", exported_at: 0, uploaded_at: 0 },
      "B": { url: "https://example.com/b.dxf", filename: "B.dxf", master_code: "100VB0-110000", size_bytes: 1, thickness_mm: 1, material: "ALPF", grain: "", exported_at: 0, uploaded_at: 0 }
    };
    render();
    'ready'
  `
}
```

Drill into the family + click 📐, then:

```
mcp__Claude_Preview__preview_screenshot { serverId: <sid> }
```

Expected screenshot: the 📐 button is visibly cyan (not blending with white siblings), and the popover is a dark card with 2 clear rows. No text overflow or layout break.

- [ ] **Step 6.5: Verify CSS button hit area on iPad-sim**

```
mcp__Claude_Preview__preview_inspect {
  serverId: <sid>,
  selector: ".part-dxf-btn"
}
```

Expected: computed `min-height` and `min-width` both ≥ 32px. (iPad touch targets need ≥ 40px ideally — if user complains later, bump these to 44 and re-test.)

- [ ] **Step 6.6: Commit**

```bash
git add style.css
git commit -m "style(dxf): cyan 📐 chip + dark popover for Library

.part-dxf-btn: cyan accent (distinct from ✎/📁 whites), 32 px min
touch target. .part-dxf-popover: fixed-position dark card with 60vh
max-height (scroll for very-multi-panel masters). Row hover/active
states match the existing dark theme.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Push Phase A + verify Pages deploy

- [ ] **Step 7.1: Show final diff summary**

```bash
git log --oneline origin/main..HEAD
```

Expected: 6 commits (Tasks 1–6), all `feat(dxf)` / `style(dxf)` prefixed.

- [ ] **Step 7.2: Push**

```bash
git push origin main
```

- [ ] **Step 7.3: Watch Pages deploy**

```bash
gh run list --limit 1 --workflow="pages-build-deployment" --json databaseId,status -q '.[0].databaseId'
```

Capture the run ID, then:

```bash
gh run watch <run-id> --exit-status --interval 10
```

Expected: exits 0 (success).

- [ ] **Step 7.4: Reset preview to clean state**

```
mcp__Claude_Preview__preview_eval {
  serverId: <sid>,
  expression: `
    localStorage.removeItem('kd_admin_v1');
    _uploadedDxfsCache = {};
    render();
    'workshop-clean'
  `
}
```

Verify the workshop view has no 📐 buttons (snapshot) and no `Firebase uploaded_dxfs listener failed` in console logs.

**Phase A is now complete.** The web side is live but will show no 📐 buttons until something writes to `uploaded_dxfs` in RTDB. Phase B does that.

---

## Phase B — Fusion side (`_MASTERS/fusion_scripts/CC_Laser/`)

> **GATE:** This phase modifies files outside `drawings-ui`. Before starting any task here, the user must explicitly approve the scope expansion (e.g. *"Yes, work in _MASTERS now."*). If unapproved, stop the plan after Phase A and re-plan Phase B separately.

### Task 8: Create `dxf_uploader.py` — config + RTDB helpers

**Files:**
- Create: `_MASTERS/fusion_scripts/CC_Laser/dxf_uploader.py`

- [ ] **Step 8.1: Create the file with module docstring + imports**

```python
"""DXF uploader for CC_Laser — pushes laser-cut DXFs to GitHub and
their metadata to Firebase RTDB. Imported by CC_Laser.py; not a script
in its own right.

Two writes per file:
  1. GitHub Contents API → Drawings/dxf/<master>/<stem>.dxf
  2. RTDB anonymous PUT  → uploaded_dxfs/<stem> = { metadata }

Config lives in ~/.cc_laser_config.json:
  { github_pat, github_repo, github_branch }

RTDB writes are anonymous — the project's rules are open, mirroring
the pattern used by CC_SyncOccNames and CC_LinkNode. No firebase_secret
is needed (or wanted).
"""

import base64
import json
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


# ── Constants ────────────────────────────────────────────────────────

CONFIG_PATH = Path.home() / '.cc_laser_config.json'

# Same RTDB instance as CC_WebSync, CC_SyncOccNames, CC_LinkNode.
RTDB_BASE = 'https://kitchen-drawings-default-rtdb.asia-southeast1.firebasedatabase.app'

# Defaults if config doesn't override.
DEFAULT_REPO   = 'wuttichaisaeton/kitchen-drawings-rd2026'
DEFAULT_BRANCH = 'main'

# Public-URL prefix for files served via GitHub Pages.
PAGES_BASE = 'https://kitchen-drawings-rd2026.github.io'

# HTTP timeouts (seconds) — RTDB stays short, GH a bit longer for binary uploads.
TIMEOUT_RTDB = 4
TIMEOUT_GH   = 30
```

- [ ] **Step 8.2: Add `_load_config` and `_save_config`**

Append to the same file:

```python
# ── Config persistence ───────────────────────────────────────────────

def _load_config(ui):
    """Read ~/.cc_laser_config.json. If it doesn't exist or has no PAT,
    prompt for one via Fusion's inputBox and persist. Returns the
    config dict on success, or None if user cancels.
    """
    cfg = {}
    if CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
        except Exception:
            cfg = {}  # corrupted file — treat as empty

    if not cfg.get('github_pat'):
        pat, cancelled = ui.inputBox(
            'GitHub PAT needed (one-time setup):\n\n'
            '1. https://github.com/settings/personal-access-tokens/new\n'
            '2. Resource owner: your account\n'
            '3. Repo access: only "kitchen-drawings-rd2026"\n'
            '4. Permission > Contents: Read and write\n'
            '5. Generate -> copy the token (starts with github_pat_)\n\n'
            'Paste the token here:',
            'CC_Laser — GitHub PAT',
            ''
        )
        # Fusion's inputBox returns (value, cancelled) — value first, per
        # the Fusion API limits memory file. ALWAYS unpack in that order.
        if cancelled or not pat:
            return None
        pat = pat.strip()
        if not (pat.startswith('github_pat_') or pat.startswith('ghp_')):
            ui.messageBox(
                'That doesn\'t look like a GitHub PAT (should start with '
                'github_pat_ or ghp_). Re-run CC_Laser and try again.',
                'CC_Laser'
            )
            return None
        cfg['github_pat'] = pat

    cfg.setdefault('github_repo', DEFAULT_REPO)
    cfg.setdefault('github_branch', DEFAULT_BRANCH)
    _save_config(cfg)
    return cfg


def _save_config(cfg):
    """Persist config dict to CONFIG_PATH. Best-effort — failures are
    logged but don't raise. The next call will re-prompt for the PAT
    if it didn't land on disk.
    """
    try:
        CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding='utf-8')
    except Exception as e:
        print(f'[dxf_uploader] config save failed (continuing): {e}')
```

- [ ] **Step 8.3: Add `_rtdb_put_metadata`**

```python
# ── RTDB anonymous PUT ───────────────────────────────────────────────

def _rtdb_put_metadata(stem, metadata):
    """PUT metadata to uploaded_dxfs/<stem>. Anonymous, same pattern as
    CC_SyncOccNames._push_active_row_to_rtdb. Raises on HTTP failure so
    the caller can roll back the GitHub side.
    """
    path = f'uploaded_dxfs/{urllib.parse.quote(stem, safe="-_.")}'
    url = f'{RTDB_BASE}/{path}.json'
    body = json.dumps(metadata).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=body,
        method='PUT',
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_RTDB) as r:
        # Firebase returns the written value as the response body — we
        # don't need it, just consume to free the connection.
        r.read()


def _rtdb_delete_metadata(stem):
    """DELETE uploaded_dxfs/<stem>. Used to roll back when the GH PUT
    succeeds but… actually GH-first then RTDB-second means rollback is
    only needed in the reverse case. Kept for completeness; current
    upload() order is RTDB-first / GH-second (so a GH failure rolls
    back the RTDB write via this).
    """
    path = f'uploaded_dxfs/{urllib.parse.quote(stem, safe="-_.")}'
    url = f'{RTDB_BASE}/{path}.json'
    req = urllib.request.Request(url, method='DELETE')
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_RTDB) as r:
            r.read()
    except Exception as e:
        # Don't raise from rollback — log + continue. The orphaned RTDB
        # entry is recoverable on the next successful upload.
        print(f'[dxf_uploader] rollback delete failed for {stem}: {e}')
```

- [ ] **Step 8.4: Sanity test — read the file, confirm no syntax errors**

```bash
python -c "import ast; ast.parse(open(r'C:\Users\wutti\OneDrive\เดสก์ท็อป\Work\Stainless Kitchen\_MASTERS\fusion_scripts\CC_Laser\dxf_uploader.py').read()); print('ok')"
```

Expected: `ok`.

- [ ] **Step 8.5: Save a backup (no git in `_MASTERS`)**

The `Stainless Kitchen` root is not a git repo (per the session handoff's environment header), so `_MASTERS` files aren't versioned. Instead of committing, snapshot the file before further edits:

```bash
cp "C:/Users/wutti/OneDrive/เดสก์ท็อป/Work/Stainless Kitchen/_MASTERS/fusion_scripts/CC_Laser/dxf_uploader.py" "C:/Users/wutti/OneDrive/เดสก์ท็อป/Work/Stainless Kitchen/_MASTERS/fusion_scripts/CC_Laser/dxf_uploader.py.bak-task8"
```

If at any point the user mentions they've put `_MASTERS` under git (or a OneDrive version-history equivalent), switch this step (and the equivalent steps in Tasks 9, 10, 11) to a real commit. Until then, treat each Fusion-side task's "Commit" step as "Save .bak snapshot".

---

### Task 9: `dxf_uploader.py` — GitHub Contents API helpers

**Files:**
- Modify: `_MASTERS/fusion_scripts/CC_Laser/dxf_uploader.py` (append)

- [ ] **Step 9.1: Add `_gh_get_sha` and `_gh_put_file`**

```python
# ── GitHub Contents API ──────────────────────────────────────────────

def _gh_headers(cfg):
    return {
        'Authorization': f'Bearer {cfg["github_pat"]}',
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'CC_Laser-dxf-uploader',
    }


def _gh_get_sha(cfg, repo_path):
    """Return the current `sha` of a file in the repo, or None if it
    doesn't exist. Required for updates — the Contents API needs the
    prior sha to allow PUT to overwrite.
    """
    api = f'https://api.github.com/repos/{cfg["github_repo"]}/contents/{repo_path}?ref={cfg["github_branch"]}'
    req = urllib.request.Request(api, headers=_gh_headers(cfg))
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_GH) as r:
            body = json.loads(r.read().decode('utf-8'))
            return body.get('sha')
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def _gh_put_file(cfg, repo_path, content_bytes, commit_message):
    """Create or update a file via Contents API. content_bytes is raw
    binary; we base64-encode for the API. Returns the public Pages URL.
    """
    sha = _gh_get_sha(cfg, repo_path)
    api = f'https://api.github.com/repos/{cfg["github_repo"]}/contents/{repo_path}'
    payload = {
        'message': commit_message,
        'content': base64.b64encode(content_bytes).decode('ascii'),
        'branch': cfg['github_branch'],
    }
    if sha:
        payload['sha'] = sha

    req = urllib.request.Request(
        api,
        data=json.dumps(payload).encode('utf-8'),
        method='PUT',
        headers={**_gh_headers(cfg), 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_GH) as r:
        r.read()  # consume

    # Pages public URL — preserves the path components
    encoded_path = '/'.join(urllib.parse.quote(seg, safe='-_.') for seg in repo_path.split('/'))
    return f'{PAGES_BASE}/{encoded_path}'
```

- [ ] **Step 9.2: Syntax check**

```bash
python -c "import ast; ast.parse(open(r'C:\Users\wutti\OneDrive\เดสก์ท็อป\Work\Stainless Kitchen\_MASTERS\fusion_scripts\CC_Laser\dxf_uploader.py').read()); print('ok')"
```

Expected: `ok`.

- [ ] **Step 9.3: Smoke test — PUT a dummy file to a test path**

Only run if the user has a valid `~/.cc_laser_config.json`. From a Fusion script console or a Python REPL with the same env:

```python
import sys
sys.path.insert(0, r'C:\Users\wutti\OneDrive\เดสก์ท็อป\Work\Stainless Kitchen\_MASTERS\fusion_scripts\CC_Laser')
import dxf_uploader as du
cfg = json.loads(du.CONFIG_PATH.read_text())
cfg.setdefault('github_repo', du.DEFAULT_REPO)
cfg.setdefault('github_branch', du.DEFAULT_BRANCH)
url = du._gh_put_file(cfg, 'Drawings/dxf/_test/smoke.txt', b'hello dxf uploader\n', 'test: dxf uploader smoke')
print(url)
```

Expected: prints `https://kitchen-drawings-rd2026.github.io/Drawings/dxf/_test/smoke.txt`. After ~60 s, fetching the URL in a browser returns "hello dxf uploader". Re-run the same command (overwrite path): expected to succeed without 422 — verifies the `sha`-fetch path works.

Clean up: delete `_test/smoke.txt` from GitHub UI when done. (Not strictly required — it's harmless — but tidy.)

- [ ] **Step 9.4: Save backup snapshot**

Same pattern as Step 8.5 (no git in `_MASTERS`):

```bash
cp "C:/Users/wutti/OneDrive/เดสก์ท็อป/Work/Stainless Kitchen/_MASTERS/fusion_scripts/CC_Laser/dxf_uploader.py" "C:/Users/wutti/OneDrive/เดสก์ท็อป/Work/Stainless Kitchen/_MASTERS/fusion_scripts/CC_Laser/dxf_uploader.py.bak-task9"
```

---

### Task 10: `dxf_uploader.py` — `upload()` entry point

**Files:**
- Modify: `_MASTERS/fusion_scripts/CC_Laser/dxf_uploader.py` (append)

- [ ] **Step 10.1: Add the `upload` entry point**

```python
# ── Entry point ──────────────────────────────────────────────────────

def upload(ui, stem, master_code, dxf_path, bom_meta):
    """Upload one DXF + write metadata. Returns (ok: bool, url_or_error: str).

    bom_meta is the BOM-aggregation entry for this part:
      { 'thickness': str, 'material': str, ... }
    Plus optional grain (from grain.xlsx if CC_Laser knows it).

    Order: GH first, RTDB second. If GH fails, nothing to roll back.
    If RTDB fails after GH succeeded, the file is on GitHub but invisible
    to the web — better than half-state. Caller logs and continues.
    """
    cfg = _load_config(ui)
    if cfg is None:
        return (False, 'no PAT — upload skipped')

    dxf_path = Path(dxf_path)
    try:
        content = dxf_path.read_bytes()
    except Exception as e:
        return (False, f'read failed: {e}')

    repo_path = f'Drawings/dxf/{urllib.parse.quote(master_code, safe="-_.")}/{urllib.parse.quote(stem, safe="-_.")}.dxf'

    # Step 1: GitHub
    try:
        public_url = _gh_put_file(
            cfg,
            repo_path,
            content,
            f'CC_Laser: upload DXF {stem}.dxf for {master_code}',
        )
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return (False, f'PAT rejected ({e.code}) — delete ~/.cc_laser_config.json and re-run')
        return (False, f'GH HTTP {e.code}: {e.reason}')
    except Exception as e:
        return (False, f'GH error: {e}')

    # Step 2: RTDB metadata
    try:
        exported_at = int(dxf_path.stat().st_mtime * 1000)
    except Exception:
        exported_at = int(time.time() * 1000)

    # Parse thickness from BOM meta — may be "1.0 mm" or "1.0" or empty.
    th_raw = (bom_meta or {}).get('thickness', '') or ''
    try:
        th_mm = float(str(th_raw).replace('mm', '').strip()) if th_raw else 0.0
    except (ValueError, TypeError):
        th_mm = 0.0

    metadata = {
        'url':           public_url,
        'filename':      f'{stem}.dxf',
        'master_code':   master_code,
        'size_bytes':    len(content),
        'thickness_mm':  th_mm,
        'material':      (bom_meta or {}).get('material', 'ALPF') or 'ALPF',
        'grain':         (bom_meta or {}).get('grain', '') or '',
        'exported_at':   exported_at,
        'uploaded_at':   int(time.time() * 1000),
    }

    try:
        _rtdb_put_metadata(stem, metadata)
    except Exception as e:
        # File is on GitHub but invisible to the web. Don't roll back
        # the GH side — the file is still discoverable in the repo UI,
        # and a re-run of CC_Laser will retry the RTDB write (overwrite
        # is fine).
        return (False, f'GH ok, RTDB failed: {e}')

    return (True, public_url)
```

- [ ] **Step 10.2: Syntax check**

```bash
python -c "import ast; ast.parse(open(r'C:\Users\wutti\OneDrive\เดสก์ท็อป\Work\Stainless Kitchen\_MASTERS\fusion_scripts\CC_Laser\dxf_uploader.py').read()); print('ok')"
```

Expected: `ok`.

- [ ] **Step 10.3: Save backup snapshot**

```bash
cp "C:/Users/wutti/OneDrive/เดสก์ท็อป/Work/Stainless Kitchen/_MASTERS/fusion_scripts/CC_Laser/dxf_uploader.py" "C:/Users/wutti/OneDrive/เดสก์ท็อป/Work/Stainless Kitchen/_MASTERS/fusion_scripts/CC_Laser/dxf_uploader.py.bak-task10"
```

---

### Task 11: Wire `CC_Laser.py` Step 5.5

**Files:**
- Modify: `_MASTERS/fusion_scripts/CC_Laser/CC_Laser.py:208-217` (insert Step 5.5 between Parts-List PNG and Nesting-Tool launch)

- [ ] **Step 11.0: Snapshot the pre-edit state**

CC_Laser.py is 713 lines of production code with no git safety net. Snapshot before editing:

```bash
cp "C:/Users/wutti/OneDrive/เดสก์ท็อป/Work/Stainless Kitchen/_MASTERS/fusion_scripts/CC_Laser/CC_Laser.py" "C:/Users/wutti/OneDrive/เดสก์ท็อป/Work/Stainless Kitchen/_MASTERS/fusion_scripts/CC_Laser/CC_Laser.py.bak-pretask11"
```

If Step 11.6 reveals a broken pipeline that you can't quickly fix, restore from this `.bak-pretask11` and re-attempt with a smaller delta.

- [ ] **Step 11.1: Read the surrounding code**

```
Read _MASTERS/fusion_scripts/CC_Laser/CC_Laser.py:198-228
```

Confirm: line 209 is the blank line between `(Pillow not installed…)` (line 208) and `# ---- Auto-launch Nesting Tool ----` (line 210). The new Step 5.5 goes here.

Also confirm CC_Laser's existing imports include `os` (yes — line 24) and that `re` is imported (yes — line 24). We'll add `dxf_uploader` import at module top.

- [ ] **Step 11.2: Add the import at the top of CC_Laser.py**

Find the existing `import` block (around line 24). After the `from pathlib import Path` line, add:

```python
# Sibling module — uploads each laser-cut DXF to GitHub + RTDB. Imported
# here at module top so a syntax error in the helper surfaces at script
# load time, not after the BOM has already been computed.
from . import dxf_uploader  # noqa: F401
```

Wait — CC_Laser is `type: script`, not a package. The `from . import` form requires a package. Use absolute import via sys.path instead:

```python
# Sibling module — uploads each laser-cut DXF to GitHub + RTDB.
# CC_Laser is registered as a script (not a package), so a relative
# import isn't available. We add this file's directory to sys.path
# and import absolutely.
_HERE = Path(__file__).parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
import dxf_uploader  # noqa: E402
```

`sys` is already imported on line 24. `Path` already imported. No new imports needed at the file level beyond `dxf_uploader`.

- [ ] **Step 11.3: Insert Step 5.5 — folder pick + scan**

Insert between lines 208 and 210 (between the "Parts List image" block and the "Auto-launch Nesting Tool" block). The block:

```python
        # ---- Step 5.5: Upload DXFs to web (opt-in) ----
        # Sheet Metal DXF Creator already saved one .dxf per ALPF part
        # to a folder the admin picked. We ask which folder, scan for
        # files matching the BOM keys (= component names), and push
        # each to GitHub + RTDB via dxf_uploader.upload().
        upload_summary = ''
        try:
            folder_dialog = ui.createFolderDialog()
            folder_dialog.title = 'CC_Laser — DXF folder (Cancel to skip web upload)'
            folder_dialog.initialDirectory = str(Path.home() / 'Documents')
            if folder_dialog.showDialog() != adsk.core.DialogResults.DialogOK:
                upload_summary = '(DXF web upload skipped)'
            else:
                dxf_dir = Path(folder_dialog.folder)
                # Filter: mtime > _action_start AND stem in BOM keys.
                # _action_start is a datetime; convert to epoch seconds
                # for comparison against st_mtime.
                action_start_epoch = _action_start.timestamp()
                bom_keys = set(agg.keys())
                candidates = []   # list of (Path, stem)
                older = 0
                non_bom = 0
                for p in dxf_dir.glob('*.dxf'):
                    if p.stat().st_mtime < action_start_epoch:
                        older += 1
                        continue
                    stem = p.stem
                    if stem not in bom_keys:
                        non_bom += 1
                        continue
                    candidates.append((p, stem))

                if not candidates:
                    upload_summary = (
                        f'(no DXFs to upload — {older} older, {non_bom} not in BOM)'
                    )
                else:
                    confirm = ui.messageBox(
                        f'Upload {len(candidates)} DXFs to the web?\n'
                        f'({older + non_bom} skipped — older or not in BOM)',
                        'CC_Laser — Web upload',
                        adsk.core.MessageBoxButtonTypes.OKCancelButtonType,
                        adsk.core.MessageBoxIconTypes.QuestionIconType,
                    )
                    if confirm != adsk.core.DialogResults.DialogOK:
                        upload_summary = '(DXF web upload cancelled)'
                    else:
                        # Doc-name → master code.
                        doc_name = app.activeDocument.name if app.activeDocument else ''
                        master_code = re.sub(r'\.(f3d|f2d|fz3|fz2)$', '', doc_name, flags=re.IGNORECASE)
                        master_code = re.sub(r'\s+v\d+$', '', master_code).strip()

                        # Index BOM aggregation by name for fast meta lookup.
                        ok_count = 0
                        fail_count = 0
                        first_error = ''
                        for path_obj, stem in candidates:
                            bom_meta = agg.get(stem, {})
                            ok, info = dxf_uploader.upload(
                                ui, stem, master_code, str(path_obj), bom_meta,
                            )
                            if ok:
                                ok_count += 1
                            else:
                                fail_count += 1
                                if not first_error:
                                    first_error = info
                        if fail_count == 0:
                            upload_summary = f'📐 Uploaded {ok_count} DXFs'
                        else:
                            upload_summary = (
                                f'📐 Uploaded {ok_count} DXFs ({fail_count} failed: {first_error})'
                            )
        except Exception as e:
            # Step 5.5 must NEVER abort the rest of CC_Laser. Log the
            # error to the completion dialog and move on to Nesting.
            upload_summary = f'(DXF upload errored: {e})'

```

- [ ] **Step 11.4: Append upload_summary to the completion message**

The completion message is built by appending to `msg` across the script. Just before the existing timing header prepend (line ~225):

```python
        # Append DXF upload summary if Step 5.5 produced one.
        if upload_summary:
            msg += '\n\n' + upload_summary

        # Prepend timing header so the user sees when the run started/finished
        msg = _format_timing_header(_action_start) + '\n\n' + msg
        ui.messageBox(msg, 'CC_Laser')
```

(The two existing lines above `ui.messageBox(msg, 'CC_Laser')` stay; we add the `if upload_summary` block immediately before the `msg = _format_timing_header(...)` line.)

- [ ] **Step 11.5: Syntax check**

```bash
python -c "import ast; ast.parse(open(r'C:\Users\wutti\OneDrive\เดสก์ท็อป\Work\Stainless Kitchen\_MASTERS\fusion_scripts\CC_Laser\CC_Laser.py').read()); print('ok')"
```

Expected: `ok`.

- [ ] **Step 11.6: Manual test on admin PC**

This step requires a live Fusion session. Reduced to a checklist; agent should ask user to perform.

1. Open a known assembly with ≥2 ALPF parts (e.g. `100VB0-110000`).
2. Run CC_Laser → pick a folder for DXF export → wait for DXF Creator + BOM build.
3. At the new "DXF folder (Cancel to skip web upload)" dialog, click **Cancel** the first time → confirm CC_Laser continues to Nesting Tool and completion dialog. The dialog should include `(DXF web upload skipped)`.
4. Re-run CC_Laser → pick folder → at the new dialog click **OK** + paste a valid `github_pat_…` token when prompted.
5. Confirm the upload confirmation box, click OK.
6. Wait for completion dialog → expect `📐 Uploaded N DXFs` footer.
7. In a browser, visit `https://github.com/wuttichaisaeton/kitchen-drawings-rd2026/tree/main/Drawings/dxf/100VB0-110000/` → N `.dxf` files should be there.
8. In Firebase console, RTDB → `uploaded_dxfs/` → N entries with `master_code: "100VB0-110000"`.
9. Wait ~90 s for Pages deploy, then open drawings-ui (admin mode) → navigate to Library → the row for `100VB0-110000` should show `📐 N` button.

- [ ] **Step 11.7: Save backup snapshot of the modified file**

Save a backup of the now-modified `CC_Laser.py` (the pre-edit snapshot was Step 11.1 implicit — if you didn't take one, you can recover from the `dxf_uploader.py.bak-task8` series + Fusion's autosave history):

```bash
cp "C:/Users/wutti/OneDrive/เดสก์ท็อป/Work/Stainless Kitchen/_MASTERS/fusion_scripts/CC_Laser/CC_Laser.py" "C:/Users/wutti/OneDrive/เดสก์ท็อป/Work/Stainless Kitchen/_MASTERS/fusion_scripts/CC_Laser/CC_Laser.py.bak-task11"
```

---

## Phase C — Integration verification

### Task 12: Full loop sanity test

- [ ] **Step 12.1: End-to-end on real admin PC**

User performs (cannot be agent-automated):

1. Run CC_Laser on a fresh assembly (3+ ALPF parts).
2. Allow upload at every prompt.
3. Confirm 📐 footer in CC_Laser completion dialog.
4. Open drawings-ui admin view, navigate to Library, find the master row.
5. Confirm `📐 N` button.
6. Click 📐 → confirm popover with N entries.
7. Click one entry → confirm download.
8. Open the downloaded `.dxf` in a text editor → confirm it's a real DXF (starts with `0\nSECTION` or `999\n` comment).

- [ ] **Step 12.2: Workshop iPad check**

User performs:

1. Open drawings-ui PWA on iPad (workshop mode, no admin toggle).
2. Navigate to the same master row → confirm **NO 📐 button**.
3. Confirm no console errors (use iPad Safari Web Inspector if available).

- [ ] **Step 12.3: Repeat-upload idempotency**

User performs:

1. Re-run CC_Laser on the same assembly without changing anything.
2. Allow upload again.
3. Confirm GitHub commits show "update" (not "create") for each file.
4. Confirm RTDB `uploaded_at` increments; `exported_at` reflects new mtime.

### Task 13: Update stale memory file

- [ ] **Step 13.1: Update `reference_cc_laser.md`**

Per the spec's Q1 (memory was stale about `_action.py` split), update `C:\Users\wutti\.claude\projects\C--Users-wutti-OneDrive-----------Work-Stainless-Kitchen\memory\reference_cc_laser.md` to reflect:
- CC_Laser is monolithic (`type: script`), no `_action.py` split.
- New sibling: `dxf_uploader.py` for web upload.
- New Step 5.5 in the pipeline.
- Config file: `~/.cc_laser_config.json` (PAT, repo, branch).

Keep changes additive — the existing rename-from-CC_SheetMetalBOM history stays.

- [ ] **Step 13.2: No commit needed** — memory files aren't versioned, they're per-machine state.

---

## Out of plan

- Web → Nesting trigger (sub-project 2 of the DXF-on-web vision)
- LINE bot / AI consumer (sub-project 3)
- In-browser DXF preview
- Bulk re-upload UI
- DXF versioning
- Touch-target re-audit on the iPad PWA (separate audit; out of this spec's scope)

## If anything breaks mid-plan

- Web side: a bad commit can be reverted in <30 s — Pages re-deploys in ~1 min. Fall back to the last known-good commit on `origin/main`.
- Fusion side: `_MASTERS` files don't have an obvious revert path (depends on whether it's under git). Keep a copy of the pre-modification `CC_Laser.py` before Step 11.3 so you can restore manually if Step 11.6 reveals a broken pipeline. (`cp CC_Laser.py CC_Laser.py.bak.YYYY-MM-DD` is fine.)
- RTDB pollution from a botched upload: delete the bad node in Firebase console → next clean run rewrites it. The `uploaded_dxfs/_test/` namespace (Task 9.3) can be cleaned up at any time.
