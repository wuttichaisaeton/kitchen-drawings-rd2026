# Nesting workspace warnings — design

**Date:** 2026-05-30
**Group:** 2 (Web) — `drawings-ui/` · `nest.js` + `style.css`
**Status:** APPROVED design (brainstormed; supersedes `2026-05-30-nest-warnings-draft.md`)

## Why

The Nesting workspace (`nest.js`) shows no warnings today. A worker can Run
Nesting, hit "Save sheets to Laser", cut the sheets, and only afterwards
discover a part didn't fit, had an undecided grain, or doesn't match its DXF —
wasting material. The Laser cut list (`app.js`) already surfaces grain glyphs
per row; the Nesting workspace needs equivalent (and stronger) warnings so the
problem is seen *before* cutting.

เอ๋'s asks: "เตือนเรื่องแนว grain ที่ไม่แน่ใจ + จำนวนขาด … งานจะวางไม่ได้ ขาดไป
หนึ่งชิ้น ก็ไม่มีการแจ้งเตือน" and "ชิ้นนี้ดูแปลกๆ ให้เข้าไปดูหน่อย / ชิ้นนี้ไม่มี
DXF — แจ้งเตือนในช่อง Grain น่าจะดี".

## Decisions (from brainstorm)

1. **Unplaced** → warn only (prominent red banner). Do **not** block export.
2. **Unplaced detail** → grouped by part code with a count (`CODE ×N`).
3. **Grain** → amber banner **and** a per-row marker in the grain cell.
4. **Looks-weird** → all three checks: no DXF · bbox≠code-size · parse/degenerate.
5. **FORK A** (size check) → compare the parsed DXF bbox to the dimensions
   encoded in the 13-char part code (`…-WWWHHH`), not to `p.w`/`p.h` (which are
   *forced* equal to the bbox on load, so they can never disagree).
6. **FORK B** (grain uncertain) → flag parts whose grain fell through to the
   default `ANY` because **no grain rule and no DXF metadata set it** — i.e.
   grain was never deliberately decided. (Literal `?` essentially never occurs
   on load, so checking for `?` alone would never fire.)

## Architecture

All changes are **additive** and confined to two directly-loaded files
(`nest.js`, `style.css`) — no build step. `git add nest.js style.css` only
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
  has no meaningful grain — exclude it from the warning to avoid noise).

The grain-uncertain predicate is then simply `p.selected && !p.grainExplicit`.
This is unambiguous and avoids re-deriving provenance from the final value.

### Render: one warnings block

New pure helper `_warningsHtml()` reads `S.parts`, `S.flatSheets`, `S.unplaced`
and returns a string of 0–3 stacked banner `<div>`s (empty string when all
clear). Injected at the **top of the result pane** in `_viewHtml()` — first
child of `<main class="kdnest-canvas-wrap">`, above `.kdnest-canvas-top`:

```js
<main class="kdnest-canvas-wrap">
  ${_warningsHtml()}
  <div class="kdnest-canvas-top"> … </div>
  <canvas id="kdnest-canvas"></canvas>
</main>
```

Because `_refreshView()` rebuilds `S.rootEl.innerHTML` from `_viewHtml()`, the
banners refresh automatically after every Run / grain toggle / select change.
Banners are **persistent** (not dismissible) so a real problem can't be clicked
away before cutting. No event wiring needed (static, informational).

Grain/review banners depend only on `S.parts`, so they appear as soon as the
project opens (before Run) — useful early signal. The unplaced banner only
appears after a run (empty `S.unplaced` before).

### The three warnings

All text is **English** (Flux Architect web font; Thai not supported in
rendered UI — Comments are the only exception and don't apply here).

**① Unplaced — red, rendered first (loudest)**
- Condition: `S.unplaced.length > 0`.
- Group the per-instance unplaced pieces by `code`, count each.
- Header: `⚠ N piece(s) couldn't be placed`.
- Lines: `CODE ×N`. For a code whose `thickness` has no matching active sheet
  stock (the `stockForThick.length === 0` branch, `nest.js:1553`), append
  ` (t=Xmm — no matching sheet stock)` — a distinct, common cause.
- Warn only; the Save/export button stays enabled (decision 1).

**② Grain uncertain — amber**
- Condition: any `p.selected && !p.grainExplicit` (FORK B).
- Header: `N part(s) have no confirmed grain — defaulting to ANY (any rotation)`.
- Lines: the affected codes (deduped).
- Per-row marker: add class `kdnest-grain-warn` to the grain `<button>` for
  those parts (amber ring) + tooltip `grain not set by any rule — defaulting to ANY`.
  (The glyph stays `✱`; the ring is the marker. Satisfies "marker ในช่อง Grain".)

**③ Review / looks-weird — orange**
- Per selected part, collect reasons:
  - **No DXF**: `!p.dxfUrl` → `no DXF uploaded`.
  - **Parse/degenerate**: `p.dxfError` (and `dxfUrl` present) → `DXF error`; or
    `dxfLoaded` but `polys.outer` missing / `< 3` points / near-zero area
    (`< 1 mm²` of the shoelace area) → `degenerate outline`.
  - **Size mismatch (FORK A)**: only for `dxfLoaded` parts whose `code` matches
    `/-(\d{3})(\d{3})$/`. Decode `wCode = WWW*10`, `hCode = HHH*10` (mm). For each
    encoded value `> 0` (000 = "not encoded", skip), require that *some* bbox
    dimension (`bw = round(maxX-minX)`, `bh = round(maxY-minY)`) is within
    **25 mm** of it (orientation-agnostic — naming W/H ↔ bbox axis varies by
    family). If an encoded dim has no match → reason
    `DXF size ≈ bw×bh, code says ~wCode×hCode`. (25 mm tolerance — widened from
    10 mm on 2026-05-30 per เอ๋ — absorbs panel-vs-channel size encodings +
    tier-rounding so legit parts don't over-flag, while still catching gross
    mismatches, e.g. 800 vs 400.)
- Header: `Review N part(s):`. Lines: `CODE — reason1; reason2`.
- Per-row marker: add class `kdnest-part-review` to the row (left orange border)
  for any part with ≥1 review reason. (`No DXF` already shows the `⚠` status
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
- **Preview MCP is avoided** (it crashed prior sessions). เอ๋ to eyeball the
  banners on a real project (e.g. Bung 01: known to have an unplaced/short case
  and at least one DXF-less / mismatched code) after deploy. Note the prior
  session's Max Remnant overlap proof is still pending the same way.

## Files

- `nest.js` — `S.unplaced` storage + reset; `grainExplicit` provenance in
  `_loadProjectParts`; new `_warningsHtml()`; inject in `_viewHtml`;
  `kdnest-grain-warn` / `kdnest-part-review` classes in the part-row template.
- `style.css` — the warning/marker styles above.
