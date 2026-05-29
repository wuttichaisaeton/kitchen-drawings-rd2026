# Assembly checklist panel

**Date:** 2026-05-30
**Group:** 2 (Web) — `drawings-ui/`
**Status:** design approved, pre-implementation

## Goal

Add a bottom-left button to the mindmap editor (the assembly surface) that
expands into a flat checklist of every part used in the project — each row
showing the part code, total quantity, a tick box, and per-part comments. It
gives the workshop an easy linear "tick as you build" view alongside the
spatial 🧩 toggles on the mindmap.

User intent (เอ๋, 2026-05-30): "ที่ assembly ให้มีปุ่ม checklist มุมซ้ายล่าง
กดแล้วขยายเป็นจำนวนของที่ใช้ทั้งหมด พร้อมช่องติ๊กถูก และมีช่อง comments."

## Decisions (locked during brainstorming)

- **Home:** a new `ChecklistPanel` React component inside `editor/main.jsx`,
  mounted as React Flow `<Panel position="bottom-left">` (the only free
  corner; Show all=top-right, zoom-fit=bottom-right, back=top-left). Collapsed
  = a small clipboard/checklist icon button; tap → slide-up panel over the
  canvas. Works in fullscreen (Panels are canvas-relative, like Show all).
- **Visibility:** shown in **all roles** (workshop/laser/bend/assemble). It is
  a read+tick aid, not gated. (Revisit if เอ๋ wants it assembly-only.)
- **List content = "จำนวนของที่ใช้ทั้งหมด":** unique parts with summed qty via
  the existing `_aggregatePartsByCode(project.parts)` → `[{code, qty, family,
  urn}]`. Real parts only (wrappers/variant-roots are virtual, not in
  `project.parts`, so they don't appear).
- **Tick box ↔ existing `assembled_status`:** ticking a row calls
  `markAssembled(projectKey, code, done)`; the row's checked state reads
  `isAssembled(projectKey, code)`. Single source of truth shared with the 🧩
  node toggle, the assembly progress pill, and checklist-mode fading — tick
  here and the mindmap updates, and vice-versa.
- **Comments = per part code:** reuse the existing per-code comments
  (`getComments(code)` + a newly-exposed `addComment(code, text)`, RTDB
  `comments/<code>`). Each row shows a 💬 count; tapping expands an inline
  thread (existing comments + an input to add one). Same comments shown
  elsewhere for that code.
- **Live sync:** the panel re-reads on the editor's existing `extSyncNonce`,
  which already bumps on BOTH assembled and comment Firebase writes (both
  listeners call `_refreshAssemblyUI` → `kme:extsync`). So a tick/comment from
  another device or from the mindmap updates the list with no remount.

## Architecture & data flow

```
app.js (data + RTDB)                 editor/main.jsx (React Flow)
─────────────────────                ────────────────────────────
window.kdAPI = {                     <Editor projectKey=…>
  …existing…                           extSyncNonce  ← kme:extsync
  isAssembled, markAssembled,          <ReactFlow>
  getComments,                           …nodes/edges…
  assemblyParts(pk),   ← NEW             <Panel position="bottom-left">
  addComment(code,txt) ← NEW               <ChecklistPanel
}                                            projectKey
                                             nonce={extSyncNonce} />
                                         </Panel>
```

- `ChecklistPanel` reads `window.kdAPI`. On open and whenever `nonce` changes,
  it pulls `api.assemblyParts(projectKey)` and, per row, `api.isAssembled` and
  `api.getComments`.
- Ticking → `api.markAssembled(projectKey, code, next)`. The assembled
  listener echoes back, bumps `extSyncNonce`, and the panel re-reads (the row
  shows checked) — no local optimistic state needed, but the component may
  set local state for instant feedback and reconcile on the nonce.
- Adding a comment → `api.addComment(code, text)`; the comments listener bumps
  `extSyncNonce`; the thread re-reads.

### Component breakdown (`editor/main.jsx`)

- `ChecklistPanel({ projectKey, nonce })` — owns open/closed state + which row's
  comment thread is expanded.
  - **Collapsed:** an icon button (`kme-checklist-btn`).
  - **Expanded:** a panel (`kme-checklist`) with:
    - **Header:** title "Checklist" + progress `{done}/{total}` (unique codes
      assembled / total unique codes) + a close affordance (tap the button
      again).
    - **Rows** (`kme-checklist-row`), one per aggregated part: `[checkbox]
      CODE  ×qty  [💬 n]`. Checked rows get a dimmed/strikethrough style.
    - **Comment thread** (lazy, only for the expanded row): list of existing
      comments (text + time) + a text input with a send button calling
      `addComment`.

### kdAPI additions (`app.js`, in `_exposeKdApi`)

- `assemblyParts: (pk) => _aggregatePartsByCode((manifest.projects?.[pk]?.parts) || [])`
- `addComment` (the existing `addComment(code, text)` function, exposed)

(`isAssembled`, `markAssembled`, `getComments` are already exposed.)

## Styling / i18n

- New CSS in `editor/style.css` for the button, panel, rows, and comment
  thread. Match the dark theme + existing `kme-*` button styling.
- **No Thai in rendered UI text** (Flux Architect) — labels English ("Checklist",
  "{n}/{m}", "Add comment…"). **Exception:** comment text + the comment input
  use the Thai-supporting font fallback (IBM Plex Sans Thai / Noto Sans Thai),
  consistent with the existing comments feature.

## Non-goals / unaffected

- No change to `assembled_status` or `comments` RTDB schemas (shared; reused
  as-is).
- Does not replace the 🧩 node toggle — complementary flat view.
- No per-row quantity editing; no comment deletion in the panel (admin delete
  lives elsewhere).
- Does not change the layer-coloring, status badges, collapse/expand, or
  checklist-mode behavior.

## Testing / verification

Manual on `localhost:3030` (preview), Bung 01:
- Bottom-left button renders; tap toggles the panel open/closed (works in
  fullscreen too).
- Panel lists all unique parts with `×qty`; count matches
  `_aggregatePartsByCode(project.parts).length`.
- Ticking a row marks it assembled: the same node's 🧩 state + the project's
  assembled progress pill update (and survive a reopen — persisted to RTDB).
- Un-ticking reverses it.
- 💬 expands a row's comment thread; adding a comment persists and shows for
  that code elsewhere.
- Header progress `{done}/{total}` updates on tick.
- No console errors; assert via DOM/`preview_eval` (screenshots unreliable in
  this env).

## Files touched

- `app.js` — add `assemblyParts` + expose `addComment` in `_exposeKdApi`.
  (loads directly, no build)
- `editor/main.jsx` — add `ChecklistPanel`, mount in a bottom-left `<Panel>`.
- `editor/style.css` — panel/button/row/comment styles.
  → `npm run build:editor`, commit `editor.bundle.js` + `editor.bundle.css`.
