# Library Link From BOM Node — Design

**Date:** 2026-05-27
**Scope:** `drawings-ui` (kitchen-drawings-rd2026)
**Approach:** A — clickable `⚠ NO PDF` chip on BOM mindmap nodes

## Problem

On the project mindmap, a BOM leaf node without a PDF shows a red `⚠ NO PDF` badge in its header. The user has no direct path from that node to the Library tab — they must back out to the projects list, tap the Library tab, find the right family card, drill in, and scroll-find the part. That is ~5 taps on iPad for a daily action.

The request: tap the part's `NO PDF` chip → land on that part in the Library, ready to inspect or drop a PDF.

Existing Fusion-related affordances on the same node must keep working:
- `⧉ kme-link-badge` (when paired via CC_LinkNode) → opens the Fusion file
- Tapping the node body itself → `_routeLeafToFusion` (status routing — missing→3D, drawn→2D drawing) per the leaf-click-routing memory

The new chip click goes to **Library**, not Fusion.

## UX Flow

1. User sees a BOM node (e.g. `FN1BLA-080000`) with `⚠ NO PDF` chip in dark red.
2. User taps the chip (cursor: pointer, hit area ≥32×32px to accommodate gloved/wet hands on iPad).
3. Tab switches to `📦 Library` (active class moves).
4. Library navigation stack is **replaced** (not pushed) with the family of that part:
   `stack = [{ kind:'family', name: familyOfCode(code), highlight: code }]`
   — so a single Back press goes to Library home, matching the mental model "I went to Library".
5. `renderFamily()` renders the family parts list as usual.
6. After render, the part row scrolls into the centre of the viewport (`scrollIntoView({ block:'center', behavior:'smooth' })`).
7. The row gets a `.part-row-highlight` class for **2.5 s**, then auto-removes.
   - CSS: outline 2px solid `var(--fam-color)`, box-shadow glow, `kd-highlight-pulse` keyframes fading from full intensity to 0.
8. User can tap the row to open its PDF (existing behaviour) or, in admin, drop a PDF onto it to upload.

## Architecture & Data Flow

```
┌──────────────────────────────────────────────────────────┐
│ editor/main.jsx (React Flow)                             │
│   BOM node header                                        │
│     ⚠ NO PDF chip                                        │
│       onClick → e.stopPropagation()                      │
│              → api.openInLibrary(code)                   │
│       class kme-missing-badge (+ nodrag in click-router) │
└──────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────┐
│ app.js — window.kdAPI                                    │
│   openInLibrary(code):                                   │
│     view = 'library'                                     │
│     update #tab-projects / #tab-library .active          │
│     stack = [{ kind:'family',                            │
│                name: _remapFamilyForCode(code),          │
│                highlight: code }]                        │
│     render()                                             │
│                                                          │
│   renderFamily(fam, highlight) — extended signature      │
│     existing render code unchanged                       │
│     part-row gains data-code="<code>" attribute          │
│     if (highlight):                                      │
│       row = ROOT.querySelector(                          │
│         `.part-row[data-code="${highlight}"]`)           │
│       row?.scrollIntoView({ block:'center',              │
│                              behavior:'smooth' })        │
│       row?.classList.add('part-row-highlight')           │
│       setTimeout(() => row?.classList                    │
│         .remove('part-row-highlight'), 2500)             │
└──────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────┐
│ style.css                                                │
│   .kme-missing-badge                                     │
│     cursor: pointer                                      │
│     min-height: 32px; padding: 6px 10px                  │
│     :hover / :active states                              │
│     text → "⚠ NO PDF 🔗"  (link affordance)              │
│                                                          │
│   .part-row-highlight                                    │
│     outline: 2px solid var(--fam-color)                  │
│     box-shadow: 0 0 24px var(--fam-color)                │
│     animation: kd-highlight-pulse 2.5s ease-out          │
│                                                          │
│   @keyframes kd-highlight-pulse                          │
│     0%  { box-shadow: 0 0 24px var(--fam-color); }       │
│     100%{ box-shadow: 0 0 0 var(--fam-color); }          │
└──────────────────────────────────────────────────────────┘
```

### Key contracts

- **`kdAPI.openInLibrary(code: string): void`** — new public method on `window.kdAPI`. Always re-runs: even if the user is already on Library/this family/this code, calling again rebuilds the stack and re-fires the highlight animation (so a second tap of the chip "flashes" the row again — useful when the row scrolled out of view). Silently no-ops only if `code` is falsy or `_remapFamilyForCode(code)` is null.
- **`navTo`** is **not** the entry point. We mutate `stack` directly and call `render()` to support the replace-not-push semantics. This is explicitly different from `navTo` (which pushes).
- **`renderFamily(fam, highlight?)`** — signature widened. All existing callers pass `fam` only and continue to work.
- **`.part-row` gains `data-code` attribute** — additive, does not affect existing handlers (which read `data-url`).
- **`_remapFamilyForCode(code)`** — already exists, source of truth for prefix→chip mapping. Reuse, do not duplicate.

### What stays unchanged

- `⧉ kme-link-badge` click handler — opens the Fusion-linked file as today.
- Leaf node body click → `_routeLeafToFusion` — status-based routing to Fusion 3D / 2D.
- All other action-row mini buttons (timer, bent, assembled, PDF).
- The PDF button's conditional render (`code && api.pdfUrlForCode?.(code)`).
- `uploading…` badge — replaces NO PDF chip during drop-upload as today; not clickable.
- Library home, search, project list, custom mindmap editor.

## Edge Cases

| Case | Handling |
|---|---|
| Code with no family match | `_remapFamilyForCode` returns `null` → openInLibrary early-returns (no nav) |
| BOM node currently uploading (badge swapped) | Chip not rendered → no click possible |
| Highlight target row missing in Library | `querySelector` returns null → skip scroll + class; render still completes |
| Chip tapped while node being dragged | `nodrag` selector on chip prevents React Flow drag-start |
| Same code in multiple families | `_remapFamilyForCode` is deterministic — picks the one configured |
| Library tab clicked again while already on Library highlight view | No re-highlight; user is already there |

## Testing Plan

### A. Browser-driven (preview tool, iPad-sim viewport)

Manual verification via the preview MCP at 1024×1366 and 1366×1024:

1. Navigate into a project with at least one NO PDF BOM node (e.g. `100VB0-080000` — 3 no-drawing parts).
2. Tap a `⚠ NO PDF` chip.
3. Assert via `preview_snapshot`:
   - `#tab-library` has `.active` class
   - main contains a `section-title` for the expected family chip
   - a `.part-row` with `data-code` matching has `.part-row-highlight` class
4. Wait 3 s, re-snapshot → `.part-row-highlight` is gone.
5. Press Back → lands on Library home grid (not project mindmap).

### B. Regression checks

Each must still work unchanged:

- `⧉` link badge → opens Fusion file
- Node body tap → `_routeLeafToFusion` is called with `{ code, status, urn, drawing_urn }`
- PDF mini button → opens GH Pages PDF in new tab
- Timer / bent / assembled toggles
- Library home grid → family drill (no `highlight`) → part row tap → PDF open
- Search → result tap

### C. iPad PWA (user verification)

เอ๋ทดสอบบน iPad PWA จริง:
- Touch target on chip is comfortable (no mistap into adjacent text)
- Animation feels smooth, not jarring
- Back button respects the replace-not-push semantics

## Build & Deploy

- `npm run build:editor` regenerates `editor.bundle.js` from `editor/main.jsx`.
- Commit: `editor/main.jsx`, `editor.bundle.js`, `editor.bundle.css` (if changed), `app.js`, `style.css`, this spec.
- Push to `main` → GitHub Pages serves in ~1 min.
- Verify deploy version per the `check_deploy` memory.

## Out of Scope

- Touch target sizing for other mini buttons (timer/bent/assembled/PDF/reset). The iPad simulator test flagged those as undersized too, but that's a separate audit — not part of this spec.
- New Project button (E1 Section 2-3) — separate pending work per handoff.
- Search-from-mindmap or any other deep-link entry into Library beyond the NO PDF chip.

## Open Questions

None at spec time. Both raised during brainstorming have been answered:

- Back behaviour: replace stack, Back goes to Library home ✓
- Highlight duration: 2.5 s with fade ✓
