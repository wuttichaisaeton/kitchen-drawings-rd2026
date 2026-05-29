# Cut list — show nesting part number (#N)

**Date:** 2026-05-30
**Group:** 2 (Web) — `drawings-ui/`
**Status:** design approved, pre-implementation

## Goal

Show each Laser cut-list row the same part number (#N) the Nesting workspace
assigns, so a worker can cross-reference a part between the two views ("#3 in
the nest" ↔ "#3 in the cut list"). The number appears at the front (left) of
each cut-list row.

User intent (เอ๋, 2026-05-30): "cutlist ต้อง sync number มาจาก nesting."

## Decisions (locked during brainstorming)

- **Approach A — decoupled.** The cut list computes #N itself using the SAME
  rule the nest uses, rather than reading numbers from the nest. The numbers
  match because both apply one deterministic rule. Touches `app.js` (+ a CSS
  rule) only — **not `nest.js`** (Group 1's actively-edited file), no runtime
  coupling.
- **Numbering rule:** `#N` = 1-based rank of the part's code in the
  alphabetically-sorted list of all unique codes in the project. This mirrors
  `nest.js:572` exactly: `S.parts = [...byCode.values()].sort((a,b) =>
  a.code.localeCompare(b.code))` and the row label `#${i+1}`.
- **Position:** #N at the front of the row, left of the code (like the nest's
  `#3  BM1NO0-080000`).

## Why the numbers match (and the one caveat)

Both views aggregate the same `project.parts` into the same set of unique
codes (the nest header and the cut-list header both read "17 UNIQUE" for Bung
01). Ranking that identical set by `code.localeCompare` yields identical #N in
both. **Caveat:** if the nest ever stops sorting parts alphabetically (e.g.
adds manual part reordering), the decoupled cut list would diverge; today parts
are not user-reorderable, so the rule is stable. If that changes, switch to
reading the number from a `kdNest` API (Approach B).

## Architecture & implementation

Single function: `_renderCutList(parts, projectKey)` in `app.js` (~line 810).

1. After `const aggregated = _aggregatePartsByCode(parts);`, build a
   code→number map using the nest's rule:
   ```js
   const _nestNumberByCode = new Map();
   [...aggregated]
     .sort((a, b) => a.code.localeCompare(b.code))
     .forEach((p, i) => _nestNumberByCode.set(p.code, i + 1));
   ```
   (Sort a COPY so the existing family grouping/order below is untouched.)
2. In the per-row template, prepend a number cell before `.cut-code`:
   ```js
   <span class="cut-num">#${_nestNumberByCode.get(p.code)}</span>
   ```
3. The existing family grouping and within-family code sort are unchanged — so
   a family section shows its parts' GLOBAL nest numbers (not 1..n within the
   section); e.g. the BEAM section shows `#3 BM1NO0-080000`, `#4
   BM1NO0-120000`. That non-contiguity is expected and is the whole point
   (the number is the nest's global index).

CSS: add a `.cut-num` rule to the main `style.css` (the cut-list `.cut-*`
classes live there; the cut list is rendered by `app.js`, not the editor).
Muted, monospace, fixed-ish width so codes stay aligned:
```css
.cut-num { color: #6e7b8a; font-family: ui-monospace, monospace; font-size: 12px; min-width: 2.4em; text-align: right; flex: none; }
```
(Final selector/layout to match the existing `.cut-row` flex layout — verified
against `style.css` at implementation time.)

## Non-goals / unaffected

- No change to `nest.js` (Approach A is decoupled).
- No change to family grouping, sorting, grain badge, status pill, or row click
  behavior — purely an added leading `#N` cell.
- No RTDB / schema changes.
- The nest's own numbering is unchanged (it already shows #N).

## Testing / verification

Manual on `localhost:3030` (preview), Bung 01, Laser cut list:
- Each row shows a `#N` matching the nest's number for that code. Spot-check
  against the nest's alphabetical order: `#1 BK1DN1-080000`, `#2 BK1DN1-120000`,
  `#3 BM1NO0-080000`, … `#17 TS2TRX-000000`.
- Numbers are NOT contiguous within a family section (they're global) — that's
  correct.
- No console errors; assert via DOM/`preview_eval` (screenshots unreliable
  here): read `.cut-num` texts + their sibling `.cut-code`, sort the codes
  alphabetically, confirm rank == shown number.

## Files touched

- `app.js` — `_renderCutList`: build `_nestNumberByCode`, prepend `.cut-num`
  cell. (loads directly, no build)
- `style.css` — `.cut-num` styling. (loads directly, no build)
