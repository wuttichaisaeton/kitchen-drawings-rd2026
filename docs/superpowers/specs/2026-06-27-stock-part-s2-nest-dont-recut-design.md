# Stock Part S2 — nest "don't re-cut" (subtract confirmed stock from a nest run) — design

**Owner:** G2 / WEB · RD 13 · **Date:** 2026-06-27 · **Status:** approved (เอ๋ 2026-06-27 — per-row toggle)
**Builds on:** Stock Part S1/S3 (`window.kdStockPart.stockQtyByCode(code)` / `confirmedByCode()` — already public), and the web nesting tool `nest.js` (`S.parts` part list, `_buildNestPieces()` qty→pieces expansion, `_viewHtml()` part-row render, the `.kdnest-part-review` / `.kdnest-part-grainwarn` per-row badge pattern). The nest is web-side now (`nest.js` replaced the Python NestingTool — [[project_web_nesting_phase1]]), so this is a pure web change; **no Group 1 / Fusion change**. See [[project_stock_part]].

## Goal

A leftover part already sitting on the shelf (a **confirmed** Stock Part) shouldn't be re-cut in a new job. When a nest loads its parts, for each part code that has confirmed stock, **cut fewer** (demand − stock), show how many came from stock, link to the Stock Part, and let เอ๋ **turn it off per row** when the shelf part can't actually be used (wrong finish, damaged). *"อยากให้ตอนฟิวชั่นส่งไฟล์มาที่เว็บเพื่อจะตัด แล้วคุณสามารถรับรู้ได้เอง ไม่ต้องตัด part ที่มีอยู่แล้ว."*

## Locked decisions (เอ๋ 2026-06-27)

| Fork | Decision | Why |
|---|---|---|
| **Default behaviour** | **Subtract by default, per-row toggle to disable** (option 3) | "don't re-cut" saves material automatically, but เอ๋ keeps a one-tap escape for shelf parts that can't be used |
| **Subtraction point** | `_buildNestPieces()` — `cutQty = max(0, p.qty − inStock)` when the row's toggle is on | one spot; recomputed live every Run, so it always reflects current stock |
| **Toggle state** | `p.useStock` (bool, default **true**), **in-memory** (not saved in the nest snapshot) | stock changes over time → re-evaluate every session, never act on a stale saved number |
| **Stock source** | `window.kdStockPart.stockQtyByCode(code)` (live, already public) | confirmed-only, recomputed from `_stockCache` each call; no new RTDB, no reservation |
| **Reservation** | **none** (MVP) — two jobs see the same stock | matches S1's no-reservation, trust-based shop; a real reservation ledger is deferred |
| **Photo migration RTDB→GitHub** | **out of scope** here | separate storage optimisation; unrelated to don't-re-cut |

## Architecture / integration points (nest.js)

1. **Part model** — `_newPart(code, qty)` (nest.js ~149) and `_loadProjectParts()` (~849) build `S.parts` rows `{code, qty, selected, w, h, thickness, grain, material, …}`. **Add `useStock: true`** to the row shape (default on; no other change). `code` is the master code, the same key `stockQtyByCode` aggregates by.
2. **Subtraction (the core)** — `_buildNestPieces()` (~4505) loops `for (i=0; i<p.qty; i++) pieces.push(...)` per selected part. Replace the loop bound with the stock-adjusted count:
   ```js
   var inStock = (p.useStock !== false && window.kdStockPart && typeof kdStockPart.stockQtyByCode === 'function') ? (kdStockPart.stockQtyByCode(p.code) || 0) : 0;
   var cutQty = _stockAdjustedQty(p.qty, inStock, p.useStock !== false);   // = max(0, qty − inStock) when on; qty when off
   for (var i = 0; i < cutQty; i++) pieces.push({ … });
   ```
   So a part fully covered by stock contributes **0 pieces** (nested/cut nothing); partially covered cuts the remainder; toggle off cuts the full qty.
3. **Row render + toggle + link** — in `_viewHtml()` partsRows (~6723), after the qty input, when `stockQtyByCode(p.code) > 0` render a stock control (mirrors the `.kdnest-part-review` row-class pattern):
   - `♻ N` badge = the **toggle** (click flips `p.useStock` → re-render). Active (using stock) = solid/green; inactive = greyed + struck-through.
   - cut hint: "cut 3 (5−2)" when subtracting, or "✓ all in stock" when cutQty 0.
   - `↗` mini-link → open the Stock Part tab focused on the code.
   - add a row class `.kdnest-part-instock` (active) so the row reads at a glance, exactly like `.kdnest-part-review`.
4. **Wiring** — after the parts list renders, attach: badge click → `p.useStock = !(p.useStock !== false ? true : false)` then the existing re-render; `↗` click → `document.getElementById('tab-stockpart')?.click(); window.kdStockPart.focusCode(p.code)`.

## New unit — `_stockAdjustedQty(demand, inStock, useStock)`  (pure, testable)
```js
function _stockAdjustedQty(demand, inStock, useStock) {
  demand = Math.max(0, demand | 0);
  if (!useStock) return demand;
  return Math.max(0, demand - Math.max(0, inStock | 0));
}
```
Used by `_buildNestPieces()` and by the row's cut-hint text. The ONLY new logic; everything else is wiring + markup.

## stockpart.js addition — `kdStockPart.focusCode(code)` (small, public)
A one-liner so the nest badge can deep-link: set the stock-list search to the code and repaint the Stock Part home.
```js
function focusCode(code) { _listQuery = String(code || ''); renderHome(); }
// expose on window.kdStockPart
```
(`_listQuery` already drives `_buildList`'s filter, which already matches confirmed stock + the "in catalog" section — so focusing a code shows its stock + catalog entry.)

## Data flow
```
confirmed Stock Parts ──stockQtyByCode(code)──►  nest.js
  S.parts[i].useStock (default true, in-memory)
        │
        ▼  _buildNestPieces():  cutQty = _stockAdjustedQty(qty, inStock, useStock)
   pieces[]  (fewer when stock covers some/all)  ──►  packer / Run  (unchanged downstream)
   part row:  ♻N toggle + "cut 3 (5−2)" / "✓ all in stock" + ↗ link
```

## Edge cases
- `inStock ≥ qty` → cutQty 0; row shows "✓ all in stock", contributes no pieces (and isn't an "unplaced" error — it's intentionally not cut).
- `code` has no confirmed stock → no badge, behaviour unchanged.
- toggle **off** → full qty cut, badge greyed/struck (stock ignored for that row).
- `kdStockPart` not loaded (shouldn't happen — loads before app.js) → guard → inStock 0 → full qty (safe fallback).
- manual rectangle parts (`p.manual`, code like `RECT-N`) → `stockQtyByCode` returns 0 → no badge (correct).
- ✏️ code override (`nest_code_overrides`) → the row's effective `p.code` is what's matched (consistent with how the picker/preview already use it).
- Same code in two nest jobs → both see the same stock (no reservation, MVP — documented).

## Security / performance
- No new RTDB nodes, no writes, no PAT. `stockQtyByCode` reads the already-loaded `_stockCache` (O(rows)); called per selected part at Run and per row at render — negligible.
- No change to packing/placement, DXF, or save format. `useStock` is not persisted (recomputed each session) so a saved nest never carries a stale stock assumption.

## Testing
- **Tier-1 (`node --test`, nest.js or a small extracted unit):** `_stockAdjustedQty` — `(5,2,true)=3`, `(5,5,true)=0`, `(5,9,true)=0`, `(5,2,false)=5`, `(0,2,true)=0`, negatives clamped. (Mirror the `test/nestStockEnable.test.mjs` harness if `_stockAdjustedQty` is exposed on a nest test hook; else test it as a pure function.)
- **Tier-1 (stockpart):** `focusCode(code)` sets `_listQuery` and the list filters to that code (extend `test/stockpart-*`).
- **Tier-3 (live, Chrome only):** load a project whose parts include a code that has confirmed stock → the row shows `♻N` + "cut (qty−N)"; Run nests `qty−N`; toggle off → nests full qty + badge greys; `↗` opens the Stock Part tab on that code; a fully-covered part nests 0 and is not flagged unplaced. Console clean.

## Phase scope
**SHIP (S2):** `useStock` on the part row (default on); `_stockAdjustedQty` + the `_buildNestPieces` subtraction; the `♻N` toggle + cut-hint + `↗` link + `.kdnest-part-instock` row class; `kdStockPart.focusCode`; tests above.

**DEFER:** stock **reservation** ledger (so concurrent jobs don't double-count); **photo migration** RTDB→GitHub; surfacing the stock saving in the cut-sheet summary / cost; persisting `useStock` in the saved nest.
