# Blueprint Theme — design

**Date:** 2026-06-01
**Author:** Group 2 (Web)
**Status:** Approved (เอ๋ 2026-06-01)

## Goal

Add a 4th UI theme, **Blueprint** — white/cyan technical lines on a deep
blueprint-blue ground. It fits the app's domain (laser-cut sheet-metal
drawings) and the existing "drawing medium on a surface" theme language
(Sketch = pencil/paper, Chalk = chalk/board).

## Decisions (locked with เอ๋)

1. **Background** = deep blueprint blue **with a faint grid** (subtle cyan
   lines on `body` only; cards/panels are solid blue and sit above it).
2. **Borders / corners** = crisp 1px technical lines, small radius (~3px).
   NOT the wobbly hand-drawn borders Sketch/Chalk use.
3. **Status colours** (green ALL DRAWN / red / amber) are **kept** so the
   workshop can still read status at a glance — only the chrome turns blue.

## Palette

| token         | value      | use                              |
|---------------|------------|----------------------------------|
| `--bp-bg`     | `#0d2440`  | body ground                      |
| `--bp-bg2`    | `#102a4c`  | header / footer                  |
| `--bp-panel`  | `#143861`  | cards / panels / rows (lifted)   |
| `--bp-panel2` | `#17406e`  | hover / raised                   |
| `--bp-line`   | `#5b9bd5`  | technical border line            |
| `--bp-faint`  | `rgba(120,170,225,0.22)` | grid lines / dividers |
| `--bp-ink`    | `#dbe9ff`  | primary text                     |
| `--bp-ink-soft`| `#8fb3da` | muted text                       |
| `--bp-accent` | `#6fb7ff`  | active tab / emphasis            |

## Architecture (mirrors existing theme system — 3 touch points)

1. **`index.html`** — add `{ id: 'blueprint', label: 'Blueprint - technical' }`
   to the `THEMES` array (picker entry; persists in `kd_theme_v1`).
2. **`style.css`** — `html[data-theme="blueprint"]` block mirroring the Sketch
   core block's selector coverage:
   - vars; `body/#root/main` ground + faint grid (repeating-linear-gradient).
   - universal reset (`body *:not(svg)…` → transparent bg, `--bp-ink` text,
     `--bp-faint` border, no shadow).
   - repaint surfaces: header/footer/h1; the card/panel/row/modal/nest list;
     buttons/tabs/`.action-btn`/`.filter-btn`/`.kdnest-btn`/`.theme-*`;
     inputs/`#search`/`.search-wrap`/placeholders; active tab (accent);
     dividers; muted text; mindmap (`.react-flow`, `.kme-node`, edges,
     handles); `.theme-menu`.
   - Borders crisp: `1px solid var(--bp-line)`, `border-radius: 3px`,
     `box-shadow: none`.
   - Status badges keep their own colours (no override).
3. **`nest.js`** — add a `blueprint` branch to the canvas palettes so the
   DXF part preview + Nest sheet render as white/cyan lines on blue:
   - `_drawPartPreview`: `BG #0d2440`, `INK #cfe3ff`, `MUTED #7c9cc0`,
     `STEEL rgba(120,170,225,0.28)`. (Modal stays transparent → part lines
     show through onto the blue page; only the Nest workspace uses the BG.)
   - sheet draw: `_outerBG #0d2440`, `_hatchInk rgba(200,225,255,0.35)`.
   - labels: keep the light else-branch (already legible on blue).

## Verification

- Preview each tab (Projects / Library / Nest / Cut list) in the blueprint
  theme — chrome turns blue, status badges stay coloured, no unreadable
  ink-on-ink, no leftover dark dark panels.
- Open the DXF preview → part renders as white/cyan lines on the blue page.
- Switch through all four themes (dark/sketch/chalk/blueprint) — none break.
- Mobile + desktop widths — no overflow.
- Push, watch the correct Pages run to success, curl the 3 files live.

## Out of scope

- No Sketch-v2-style engraved-heading flourishes; Blueprint is flat
  technical, not decorative.
- No new semantic colours; reuse existing badge colours.
