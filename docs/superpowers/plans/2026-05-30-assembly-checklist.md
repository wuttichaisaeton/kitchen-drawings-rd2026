# Assembly Checklist Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bottom-left button in the mindmap editor that expands into a flat checklist of every part used (code · qty · tick box · per-part comments), with ticks synced to the existing `assembled_status` and comments to the existing per-code comments.

**Architecture:** A new `ChecklistPanel` React component in `editor/main.jsx`, mounted as a React Flow `<Panel position="bottom-left">`. It reads/writes through `window.kdAPI` (adds `assemblyParts(pk)` + exposes `addComment`). It re-reads on the editor's existing `extSyncNonce`, which already bumps on assembled and comment Firebase writes — so ticks/comments from the mindmap or other devices update the list with no remount.

**Tech Stack:** Vanilla JS (`app.js`, loads directly — no build). React Flow editor bundled with esbuild (`editor/main.jsx` + `editor/style.css` → `npm run build:editor`). No JS unit runner; verify via `preview_eval` against `localhost:3030`.

**Spec:** `docs/superpowers/specs/2026-05-30-assembly-checklist-design.md`

---

## Preconditions

- Dev server at `localhost:3030` (preview MCP `serverId` from `preview_list`).
- To reach the editor: app loads on the ROOT route `/`. If the preview is in the Nest view, click the `.kdnest-header button` (back), then the "📋 Projects" tab, then the leaf element whose exact textContent is "Bung 01"; wait ~1.4s for `#kme-mount`.
- Set admin first if needed: `localStorage.setItem('kd_admin_v1','1')`.
- Screenshots unreliable in this env — assert via DOM/`window`.

## File Structure

- `app.js` — `_exposeKdApi()` (~line 4329) gains two entries: `assemblyParts` (new) and `addComment` (existing function, newly exposed). No other app.js logic changes.
- `editor/main.jsx` — add `ChecklistPanel` component (near the other node/panel components, before the `Editor` component that returns `<ReactFlow>`), and mount it in a new `<Panel position="bottom-left">` alongside the existing Show-all / zoom-fit / back panels (~line 1448-1483).
- `editor/style.css` — styles for `.kme-checklist-btn`, `.kme-checklist`, rows, and the comment thread.

---

### Task 1: kdAPI — expose `assemblyParts` + `addComment`

**Files:**
- Modify: `app.js` — inside `_exposeKdApi()` `window.kdAPI = { … }` (~line 4330)

- [ ] **Step 1: Add the two entries**

In `app.js`, inside the `window.kdAPI = { … }` object literal, add (next to the existing `getComments,` line is a natural spot):

```js
    // Per-code comment write (read side getComments already exposed). Used by
    // the assembly checklist panel's inline comment thread. (2026-05-30)
    addComment,
    // Aggregated parts for the project: unique code + summed qty across
    // variants (real parts only — wrappers aren't in project.parts). Drives
    // the assembly checklist list. (2026-05-30)
    assemblyParts: (pk) => _aggregatePartsByCode((manifest.projects?.[pk]?.parts) || []),
```

- [ ] **Step 2: Verify in the page**

Reload to root: `preview_eval` → `(() => { location.href='/'; return 'reload'; })()`. Then `preview_eval`:
```js
(() => {
  const pk = Object.keys((window.manifest && window.manifest.projects) || {})[0];
  const parts = window.kdAPI.assemblyParts ? window.kdAPI.assemblyParts(pk) : 'MISSING';
  return {
    addCommentType: typeof window.kdAPI.addComment,
    assemblyPartsType: typeof window.kdAPI.assemblyParts,
    pk,
    isArray: Array.isArray(parts),
    count: Array.isArray(parts) ? parts.length : null,
    sample: Array.isArray(parts) ? parts.slice(0,2) : parts,
  };
})()
```
Expected: `addCommentType:"function"`, `assemblyPartsType:"function"`, `isArray:true`, `count` > 0, `sample` rows shaped `{code, qty, family, urn}`. No console errors.

- [ ] **Step 3: Commit**
```bash
git add app.js
git commit -m "feat(api): expose assemblyParts + addComment on kdAPI for the assembly checklist"
```

---

### Task 2: `ChecklistPanel` component + mount

**Files:**
- Modify: `editor/main.jsx` — add the component + mount it in a `<Panel>`
- Build: `npm run build:editor`

- [ ] **Step 1: Add the `ChecklistPanel` component**

In `editor/main.jsx`, add this component just before the `Editor` function component (the one that renders `<ReactFlow>`). It uses `useState`/`useMemo` (already imported) and reads `window.kdAPI`:

```jsx
// Assembly checklist — a flat, tick-as-you-build list mounted bottom-left on
// the canvas. Ticks write the SAME assembled_status the 🧩 node toggle uses;
// comments reuse the per-code comments system. Re-reads whenever `nonce`
// (the editor's extSyncNonce) bumps — which app.js does on every assembled or
// comment Firebase write — so ticks/comments from the mindmap or another
// device show here with no remount. (2026-05-30)
function ChecklistPanel({ projectKey, nonce }) {
  const api = window.kdAPI || {};
  const [open, setOpen] = useState(false);
  const [openCode, setOpenCode] = useState(null);   // row whose comments are expanded
  const [draft, setDraft] = useState('');

  // Stable aggregated parts list (changes only when the project changes).
  const parts = useMemo(
    () => (api.assemblyParts ? api.assemblyParts(projectKey) : []),
    [projectKey]
  );

  // Touch `nonce` so React re-runs reads of isAssembled/getComments below
  // after a Firebase tick/comment lands. No local mirror needed.
  void nonce;

  if (!open) {
    return (
      <button className="kme-checklist-btn" onClick={() => setOpen(true)} title="Assembly checklist">
        <svg className="kme-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 3.5h7.5M6 8h7.5M6 12.5h7.5"/>
          <path d="M2 3.3l1 1 1.6-1.8M2 7.8l1 1 1.6-1.8M2 12.3l1 1 1.6-1.8"/>
        </svg>
        <span>Checklist</span>
      </button>
    );
  }

  const total = parts.length;
  const done = parts.filter(p => api.isAssembled?.(projectKey, p.code)).length;

  const toggle = (code) => {
    const next = !api.isAssembled?.(projectKey, code);
    api.markAssembled?.(projectKey, code, next);
  };
  const submitComment = (code) => {
    const t = draft.trim();
    if (!t) return;
    api.addComment?.(code, t);
    setDraft('');
  };

  return (
    <div className="kme-checklist">
      <div className="kme-checklist-head">
        <span className="kme-checklist-title">Checklist</span>
        <span className="kme-checklist-progress">{done}/{total}</span>
        <button className="kme-checklist-close" onClick={() => setOpen(false)} title="Close">✕</button>
      </div>
      <div className="kme-checklist-list">
        {parts.map(p => {
          const checked = !!api.isAssembled?.(projectKey, p.code);
          const comments = api.getComments?.(p.code) || [];
          const expanded = openCode === p.code;
          return (
            <div key={p.code} className={'kme-checklist-row' + (checked ? ' is-done' : '')}>
              <label className="kme-checklist-main">
                <input type="checkbox" checked={checked} onChange={() => toggle(p.code)} />
                <span className="kme-checklist-code">{p.code}</span>
                <span className="kme-checklist-qty">×{p.qty}</span>
              </label>
              <button
                className="kme-checklist-cmt-toggle"
                onClick={() => { setOpenCode(expanded ? null : p.code); setDraft(''); }}
                title="Comments"
              >💬{comments.length ? ' ' + comments.length : ''}</button>
              {expanded && (
                <div className="kme-checklist-thread">
                  {comments.map((c, i) => (
                    <div key={c._key || i} className="kme-cmt">{c.text}</div>
                  ))}
                  <div className="kme-cmt-add">
                    <input
                      className="kme-cmt-input"
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') submitComment(p.code); }}
                      placeholder="เพิ่ม comment…"
                    />
                    <button className="kme-cmt-send" onClick={() => submitComment(p.code)}>Add</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount it in a bottom-left Panel**

In the `Editor` component's JSX, inside `<ReactFlow> … </ReactFlow>`, next to the existing `<Panel position="bottom-right">` (zoom-fit) and `<Panel position="top-right">` (Show all), add:

```jsx
          <Panel position="bottom-left">
            <ChecklistPanel projectKey={projectKey} nonce={extSyncNonce} />
          </Panel>
```
(`projectKey` and `extSyncNonce` are already in `Editor` scope — `extSyncNonce` is the `useState` declared for the `kme:extsync` listener.)

- [ ] **Step 3: Build the bundle**

Run: `npm run build:editor`
Expected: `editor.bundle.js` (+ `editor.bundle.css`) written, "Done in NNms".

- [ ] **Step 4: Verify behavior on Bung 01**

Set admin + open Bung 01 (see Preconditions). Then `preview_eval` — open the panel and read the list:
```js
(() => {
  const btn = document.querySelector('.kme-checklist-btn');
  if (btn) btn.click();
  const rows = [...document.querySelectorAll('.kme-checklist-row')];
  return {
    btnPresent: !!btn,
    panelPresent: !!document.querySelector('.kme-checklist'),
    rowCount: rows.length,
    firstCode: rows[0]?.querySelector('.kme-checklist-code')?.textContent,
    firstQty: rows[0]?.querySelector('.kme-checklist-qty')?.textContent,
    progress: document.querySelector('.kme-checklist-progress')?.textContent,
  };
})()
```
Expected: `btnPresent:true`, after click `panelPresent:true`, `rowCount` equals the project's unique-part count, `firstCode` a 13-char code, `firstQty` like `×N`, `progress` like `"X/Y"`.

Then verify a tick syncs to assembled_status — `preview_eval`:
```js
(() => {
  const row = document.querySelector('.kme-checklist-row');
  const code = row.querySelector('.kme-checklist-code').textContent;
  const cb = row.querySelector('input[type=checkbox]');
  const before = window.kdAPI.isAssembled(Object.keys(window.manifest.projects)[0], code);
  cb.click();
  const pk = Object.keys(window.manifest.projects)[0];
  const after = window.kdAPI.isAssembled(pk, code);
  return { code, before, after, flipped: before !== after };
})()
```
Expected: `flipped:true` (ticking wrote to assembled_status via markAssembled). Check `preview_console_logs level:error` is empty. (Optionally click again to restore the original state.)

- [ ] **Step 5: Commit**
```bash
git add editor/main.jsx editor.bundle.js editor.bundle.css
git commit -m "feat(editor): assembly checklist panel (parts list + tick + per-code comments)"
```

---

### Task 3: Checklist CSS

**Files:**
- Modify: `editor/style.css` (append a new section)
- Build: `npm run build:editor`

- [ ] **Step 1: Append the styles**

Add to `editor/style.css`:

```css
/* ── Assembly checklist (bottom-left Panel) ─────────────────────────── */
.kme-checklist-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 11px; border-radius: 9px;
  background: #161b22; color: #e6edf3;
  border: 1px solid #30363d; cursor: pointer;
  font-family: inherit; font-size: 13px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.45);
  -webkit-tap-highlight-color: transparent;
}
.kme-checklist-btn:hover { border-color: #4a90e2; }
.kme-checklist-btn .kme-btn-icon { width: 16px; height: 16px; }

.kme-checklist {
  width: 300px; max-width: 78vw; max-height: 60vh;
  display: flex; flex-direction: column;
  background: #11161d; color: #e6edf3;
  border: 1px solid #30363d; border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.6);
  overflow: hidden; font-family: inherit;
}
.kme-checklist-head {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 12px; border-bottom: 1px solid #21262d;
}
.kme-checklist-title { font-weight: 700; font-size: 13px; }
.kme-checklist-progress { color: #9aa7b4; font-size: 12px; }
.kme-checklist-close {
  margin-left: auto; background: none; border: none;
  color: #9aa7b4; font-size: 15px; cursor: pointer; line-height: 1;
}
.kme-checklist-close:hover { color: #e6edf3; }

.kme-checklist-list { overflow-y: auto; padding: 4px 0; }
.kme-checklist-row {
  display: flex; flex-wrap: wrap; align-items: center;
  gap: 8px; padding: 7px 12px; border-bottom: 1px solid #1a1f24;
}
.kme-checklist-main {
  display: flex; align-items: center; gap: 8px;
  flex: 1; min-width: 0; cursor: pointer;
}
.kme-checklist-main input { width: 17px; height: 17px; accent-color: #3fb950; flex: none; }
.kme-checklist-code {
  font-family: ui-monospace, monospace; font-size: 12.5px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.kme-checklist-qty { color: #9aa7b4; font-size: 12px; flex: none; }
.kme-checklist-row.is-done .kme-checklist-code { text-decoration: line-through; opacity: 0.55; }
.kme-checklist-cmt-toggle {
  background: none; border: none; color: #9aa7b4;
  font-size: 12px; cursor: pointer; flex: none;
}
.kme-checklist-cmt-toggle:hover { color: #e6edf3; }

.kme-checklist-thread {
  flex-basis: 100%; margin-top: 6px;
  border-top: 1px dashed #21262d; padding-top: 6px;
  display: flex; flex-direction: column; gap: 4px;
}
/* Comments are the ONE place Thai is allowed — use a Thai-capable fallback
   stack (Flux Architect can't render Thai). */
.kme-cmt, .kme-cmt-input {
  font-family: 'IBM Plex Sans Thai', 'Noto Sans Thai', system-ui, sans-serif;
  font-size: 12.5px;
}
.kme-cmt { color: #cdd9e5; background: #161b22; border-radius: 6px; padding: 4px 8px; }
.kme-cmt-add { display: flex; gap: 6px; }
.kme-cmt-input {
  flex: 1; min-width: 0; background: #0d1117; color: #e6edf3;
  border: 1px solid #30363d; border-radius: 6px; padding: 5px 8px;
}
.kme-cmt-send {
  background: #1f6feb; color: #fff; border: none; border-radius: 6px;
  padding: 5px 10px; font-size: 12px; cursor: pointer; flex: none;
}
.kme-cmt-send:hover { background: #2b7bf3; }
```

- [ ] **Step 2: Build**

Run: `npm run build:editor`  → expect bundle written.

- [ ] **Step 3: Verify styles applied**

Open Bung 01, open the panel. `preview_eval`:
```js
(() => {
  document.querySelector('.kme-checklist-btn')?.click();
  const panel = document.querySelector('.kme-checklist');
  const cs = panel && getComputedStyle(panel);
  const code = document.querySelector('.kme-checklist-code');
  return {
    panelWidth: cs?.width,
    panelHasBorder: cs ? cs.borderStyle !== 'none' : false,
    codeFont: code ? getComputedStyle(code).fontFamily : null,
  };
})()
```
Expected: `panelWidth` ≈ `300px` (or viewport-clamped), `panelHasBorder:true`, `codeFont` includes a monospace family. No console errors.

- [ ] **Step 4: Commit**
```bash
git add editor/style.css editor.bundle.js editor.bundle.css
git commit -m "style(editor): assembly checklist panel styling (+ Thai font for comments)"
```

---

### Task 4: Final verification + deploy

- [ ] **Step 1: End-to-end sanity on Bung 01**

Open the panel. Verify, via `preview_eval`: (a) ticking a row updates the header `progress` text and the matching mindmap node's assembled state; (b) tapping 💬 on a row toggles the comment thread (`.kme-checklist-thread` appears/disappears); (c) the panel button sits bottom-left and does not overlap the bottom-right zoom-fit button. Confirm `preview_console_logs level:error` is empty.

- [ ] **Step 2: Push + watch deploy**
```bash
git pull --rebase origin main
git push origin main
```
Watch the latest run to `completed / success` (`gh run list --limit 1 --json databaseId -q '.[0].databaseId'` → `gh run watch <id> --exit-status`), then confirm the live bundle carries the feature:
```bash
curl -s "https://wuttichaisaeton.github.io/kitchen-drawings-rd2026/editor.bundle.js" | grep -c "kme-checklist"
```
Expected: `>= 1`. (Real Pages host is `wuttichaisaeton.github.io/kitchen-drawings-rd2026`, NOT `kitchen-drawings-rd2026.github.io` — see `reference_pages_url_and_dxf_download` memory.)

- [ ] **Step 3: No board entry**

Web-only feature; reuses existing `assembled_status`/`comments` schemas unchanged; no question for Group 1. Skip `group-sync.md`.

---

## Self-Review

**Spec coverage:**
- Bottom-left button in editor → Task 2 Step 2 (`<Panel position="bottom-left">`). ✓
- Expands to parts list with total qty → Task 2 component + Task 1 `assemblyParts`. ✓
- Tick box ↔ existing assembled_status (synced with 🧩) → Task 2 `toggle` calls `markAssembled`; verified flip in Step 4. ✓
- Per-code comments → Task 2 thread uses `getComments` + `addComment` (exposed Task 1). ✓
- Live sync on extSyncNonce → component takes `nonce={extSyncNonce}`, references it. ✓
- All roles → no role gate added (component always mounted). ✓
- Header progress = codes done/total → Task 2 `{done}/{total}`. ✓
- No Thai except comments → labels English; `.kme-cmt`/`.kme-cmt-input` use Thai font (Task 3). ✓
- kdAPI additions → Task 1. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every check has an expected result. ✓

**Type consistency:** `assemblyParts(pk)` returns `[{code, qty, family, urn}]` (Task 1) and the component reads `p.code`/`p.qty` (Task 2). `isAssembled(pk, code)`/`markAssembled(pk, code, bool)`/`getComments(code)`/`addComment(code, text)` signatures match their app.js definitions. CSS class names (`kme-checklist`, `kme-checklist-row`, `kme-checklist-code`, `kme-checklist-progress`, `kme-cmt-input`, etc.) are identical between Task 2 (JSX) and Task 3 (CSS) and Task 4 (assertions). ✓
