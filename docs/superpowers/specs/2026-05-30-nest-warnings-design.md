# Nesting workspace warnings â€” design

**Date:** 2026-05-30
**Group:** 2 (Web) â€” `drawings-ui/` Â· `nest.js` + `style.css`
**Status:** APPROVED design (brainstormed; supersedes `2026-05-30-nest-warnings-draft.md`)

## Why

The Nesting workspace (`nest.js`) shows no warnings today. A worker can Run
Nesting, hit "Save sheets to Laser", cut the sheets, and only afterwards
discover a part didn't fit, had an undecided grain, or doesn't match its DXF â€”
wasting material. The Laser cut list (`app.js`) already surfaces grain glyphs
per row; the Nesting workspace needs equivalent (and stronger) warnings so the
problem is seen *before* cutting.

à¹€à¸­à¹‹'s asks: "à¹€à¸•à¸·à¸­à¸™à¹€à¸£à¸·à¹ˆà¸­à¸‡à¹à¸™à¸§ grain à¸—à¸µà¹ˆà¹„à¸¡à¹ˆà¹à¸™à¹ˆà¹ƒà¸ˆ + à¸ˆà¸³à¸™à¸§à¸™à¸‚à¸²à¸” â€¦ à¸‡à¸²à¸™à¸ˆà¸°à¸§à¸²à¸‡à¹„à¸¡à¹ˆà¹„à¸”à¹‰ à¸‚à¸²à¸”à¹„à¸›
à¸«à¸™à¸¶à¹ˆà¸‡à¸Šà¸´à¹‰à¸™ à¸à¹‡à¹„à¸¡à¹ˆà¸¡à¸µà¸à¸²à¸£à¹à¸ˆà¹‰à¸‡à¹€à¸•à¸·à¸­à¸™" and "à¸Šà¸´à¹‰à¸™à¸™à¸µà¹‰à¸”à¸¹à¹à¸›à¸¥à¸à¹† à¹ƒà¸«à¹‰à¹€à¸‚à¹‰à¸²à¹„à¸›à¸”à¸¹à¸«à¸™à¹ˆà¸­à¸¢ / à¸Šà¸´à¹‰à¸™à¸™à¸µà¹‰à¹„à¸¡à¹ˆà¸¡à¸µ
DXF â€” à¹à¸ˆà¹‰à¸‡à¹€à¸•à¸·à¸­à¸™à¹ƒà¸™à¸Šà¹ˆà¸­à¸‡ Grain à¸™à¹ˆà¸²à¸ˆà¸°à¸”à¸µ".

## Decisions (from brainstorm)

1. **Unplaced** â†’ warn only (prominent red banner). Do **not** block export.
2. **Unplaced detail** â†’ grouped by part code with a count (`CODE Ã—N`).
3. **Grain** â†’ amber banner **and** a per-row marker in the grain cell.
4. **Looks-weird** â†’ all three checks: no DXF Â· bboxâ‰ code-size Â· parse/degenerate.
5. **FORK A** (size check) â†’ compare the parsed DXF bbox to the dimensions
   encoded in the 13-char part code (`â€¦-WWWHHH`), not to `p.w`/`p.h` (which are
   *forced* equal to the bbox on load, so they can never disagree).
6. **FORK B** (grain uncertain) â†’ flag parts whose grain fell through to the
   default `ANY` because **no grain rule and no DXF metadata set it** â€” i.e.
   grain was never deliberately decided. (Literal `?` essentially never occurs
   on load, so checking for `?` alone would never fire.)

## Architecture

All changes are **additive** and confined to two directly-loaded files
(`nest.js`, `style.css`) â€” no build step. `git add nest.js style.css` only
(shared working dir; never `git add -A`).

### Data: store the unplaced set

`_runNesting()` builds `result.unplaced`, `console.warn`s it (`nest.js:1570`),
then discards it. Add:

```js
S.unplaced = result.unplaced;   // [{code, w, h, thickness, ...}] per-instance
```

before `_refreshView()`. Initialise `S.unplaced = []` in the state template and
reset it in `close()` alongside `S.flatSheets = []`.

### Data: mark grain provenance (FORK B)

In `_loadProjectParts()`, where grain is resolved, record whether it was set
explicitly:

- Default `_newPart` / `_newManualPart`: `grainExplicit: false`.
- When `meta.grain` is applied (`nest.js:538`): set `part.grainExplicit = true`.
- When a grain rule matches (`nest.js:560`): set `part.grainExplicit = true`.
- Manual rectangles (`_newManualPart`): set `grainExplicit = true` (a plain rect
  has no meaningful grain â€” exclude it from the warning to avoid noise).

The grain-uncertain predicate is then simply `p.selected && !p.grainExplicit`.
This is unambiguous and avoids re-deriving provenance from the final value.

### Render: one warnings block

New pure helper `_warningsHtml()` reads `S.parts`, `S.flatSheets`, `S.unplaced`
and returns a string of 0â€“3 stacked banner `<div>`s (empty string when all
clear). Injected at the **top of the result pane** in `_viewHtml()` â€” first
child of `<main class="kdnest-canvas-wrap">`, above `.kdnest-canvas-top`:

```js
<main class="kdnest-canvas-wrap">
  ${_warningsHtml()}
  <div class="kdnest-canvas-top"> â€¦ </div>
  <canvas id="kdnest-canvas"></canvas>
</main>
```

Because `_refreshView()` rebuilds `S.rootEl.innerHTML` from `_viewHtml()`, the
banners refresh automatically after every Run / grain toggle / select change.
Banners are **persistent** (not dismissible) so a real problem can't be clicked
away before cutting. No event wiring needed (static, informational).

Grain/review banners depend only on `S.parts`, so they appear as soon as the
project opens (before Run) â€” useful early signal. The unplaced banner only
appears after a run (empty `S.unplaced` before).

### The three warnings

All text is **English** (Flux Architect web font; Thai not supported in
rendered UI â€” Comments are the only exception and don't apply here).

**â‘  Unplaced â€” red, rendered first (loudest)**
- Condition: `S.unplaced.length > 0`.
- Group the per-instance unplaced pieces by `code`, count each.
- Header: `âš  N piece(s) couldn't be placed`.
- Lines: `CODE Ã—N`. For a code whose `thickness` has no matching active sheet
  stock (the `stockForThick.length === 0` branch, `nest.js:1553`), append
  ` (t=Xmm â€” no matching sheet stock)` â€” a distinct, common cause.
- Warn only; the Save/export button stays enabled (decision 1).

**â‘¡ Grain uncertain â€” amber**
- Condition: any `p.selected && !p.grainExplicit` (FORK B).
- Header: `N part(s) have no confirmed grain â€” defaulting to ANY (any rotation)`.
- Lines: the affected codes (deduped).
- Per-row marker: add class `kdnest-grain-warn` to the grain `<button>` for
  those parts (amber ring) + tooltip `grain not set by any rule â€” defaulting to ANY`.
  (The glyph stays `âœ±`; the ring is the marker. Satisfies "marker à¹ƒà¸™à¸Šà¹ˆà¸­à¸‡ Grain".)

**â‘¢ Review / looks-weird â€” orange**
- Per selected part, collect reasons:
  - **No DXF**: `!p.dxfUrl` â†’ `no DXF uploaded`.
  - **Parse/degenerate**: `p.dxfError` (and `dxfUrl` present) â†’ `DXF error`; or
    `dxfLoaded` but `polys.outer` missing / `< 3` points / near-zero area
    (`< 1 mmÂ²` of the shoelace area) â†’ `degenerate outline`.
  - **Size mismatch (FORK A)**: only for `dxfLoaded` parts whose `code` matches
    `/-(\d{3})(\d{3})$/`. Decode `wCode = WWW*10`, `hCode = HHH*10` (mm). For each
    encoded value `> 0` (000 = "not encoded", skip), require that *some* bbox
    dimension (`bw = round(maxX-minX)`, `bh = round(maxY-minY)`) is within
    **25 mm** of it (orientation-agnostic â€” naming W/H â†” bbox axis varies by
    family). If an encoded dim has no match â†’ reason
    `DXF size â‰ˆ bwÃ—bh, code says ~wCodeÃ—hCode`. (25 mm tolerance (widened from 10 on 2026-05-30 per เอ๋) absorbs the
    10 mm-rounded code precision while still catching gross mismatches, e.g.
    800 vs 400.)
- Header: `Review N part(s):`. Lines: `CODE â€” reason1; reason2`.
- Per-row marker: add class `kdnest-part-review` to the row (left orange border)
  for any part with â‰¥1 review reason. (`No DXF` already shows the `âš ` status
  glyph; this adds row-level emphasis + ties to the banner.)

### CSS (`style.css`)

New, scoped to nest:
- `.kdnest-warn` (shared: padding, radius, small Flux text, stacked margin).
- `.kdnest-warn--unplaced` (red bg/border), `--grain` (amber), `--review`
  (orange). Code chips reuse the existing nest mono/Flux styling.
- `.kdnest-grain-warn` (amber ring on the grain button).
- `.kdnest-part-review` (orange left border on the part row).
Palette consistent with the existing `.kdnest-part-err` / status colours.

## Out of scope (YAGNI)

- No export/print blocking or "cut anyway" override (decision 1).
- No dismiss/snooze of banners.
- No changes to the packers, grain rules editor, or remnant stock.
- No remnant Phase-2 work (separate spec).

## Testing / verification

- `node --check nest.js` after edits (syntax gate).
- Logic review of the three predicates against the part-object shape documented
  here (fields: `code, qty, w, h, grain, grainExplicit, thickness, selected,
  manual, dxfUrl, dxfMeta, polys{outer,strokes,holes}, bbox, dxfLoaded,
  dxfError`).
- **Preview MCP is avoided** (it crashed prior sessions). à¹€à¸­à¹‹ to eyeball the
  banners on a real project (e.g. Bung 01: known to have an unplaced/short case
  and at least one DXF-less / mismatched code) after deploy. Note the prior
  session's Max Remnant overlap proof is still pending the same way.

## Files

- `nest.js` â€” `S.unplaced` storage + reset; `grainExplicit` provenance in
  `_loadProjectParts`; new `_warningsHtml()`; inject in `_viewHtml`;
  `kdnest-grain-warn` / `kdnest-part-review` classes in the part-row template.
- `style.css` â€” the warning/marker styles above.
