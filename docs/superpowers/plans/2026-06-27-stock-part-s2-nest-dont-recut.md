# Stock Part S2 — nest "don't re-cut" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline). Steps use checkbox (`- [ ]`) syntax.

**Goal:** When a nest run expands a part's qty into pieces, subtract the confirmed Stock Part qty for that code (toggle-able per row) so already-on-the-shelf parts aren't re-cut; badge the row + link to the Stock Part.

**Architecture:** A pure `_stockAdjustedQty(demand, inStock, useStock)` decides the cut count; `_buildNestPieces` calls it with `window.kdStockPart.stockQtyByCode(p.code)`. Each part row carries `useStock` (default true, in-memory). The row renders a `♻N` toggle + cut hint + `↗` link (mirrors the existing `.kdnest-part-review` badge pattern). `kdStockPart.focusCode(code)` deep-links to the Stock Part tab.

**Tech Stack:** vanilla JS (`drawings-ui/nest.js`, `stockpart.js`), `node --test`. nest.js is a browser IIFE with no test export, so the pure bit is guarded by a **verbatim-copy** test (the established `test/nestStockEnable.test.mjs` pattern).

**Spec:** `drawings-ui/docs/superpowers/specs/2026-06-27-stock-part-s2-nest-dont-recut-design.md`.

**Commit only the files each task names** (parallel sessions share the folder).

---

## Task 1: `_stockAdjustedQty` pure helper + guard test

**Files:** Modify `nest.js`; Create `test/nestStockDontRecut.test.mjs`.

- [ ] **Step 1: Add the helper to `nest.js`** — near the other small pure helpers (e.g. right after `_newPart`, ~line 176):

```javascript
  // S2 "don't re-cut": how many to actually cut = demand minus confirmed stock
  // (when the row's stock toggle is on). Clamped to >= 0.
  function _stockAdjustedQty(demand, inStock, useStock) {
    demand = Math.max(0, demand | 0);
    if (!useStock) return demand;
    return Math.max(0, demand - Math.max(0, inStock | 0));
  }
```

- [ ] **Step 2: Create the guard test** (verbatim copy, mirrors `nestStockEnable.test.mjs`) — `test/nestStockDontRecut.test.mjs`

```javascript
// Guards the S2 "don't re-cut" cut-count rule in nest.js. nest.js is a browser
// IIFE (no import), so this carries a FAITHFUL copy of the pure helper — keep in
// sync with nest.js _stockAdjustedQty. Live subtraction + badge verified in-browser.
import { test } from 'node:test';
import assert from 'node:assert';

// ── verbatim copy from nest.js (_stockAdjustedQty) ──────────────────────
function _stockAdjustedQty(demand, inStock, useStock) {
  demand = Math.max(0, demand | 0);
  if (!useStock) return demand;
  return Math.max(0, demand - Math.max(0, inStock | 0));
}

test('subtracts stock when the row toggle is on', () => {
  assert.equal(_stockAdjustedQty(5, 2, true), 3);
  assert.equal(_stockAdjustedQty(5, 5, true), 0);   // fully covered → cut nothing
  assert.equal(_stockAdjustedQty(5, 9, true), 0);   // more stock than demand → 0, not negative
});
test('ignores stock when the row toggle is off', () => {
  assert.equal(_stockAdjustedQty(5, 2, false), 5);
});
test('clamps / handles zero + junk', () => {
  assert.equal(_stockAdjustedQty(0, 2, true), 0);
  assert.equal(_stockAdjustedQty(-3, 2, true), 0);
  assert.equal(_stockAdjustedQty(5, 0, true), 5);
});
```

- [ ] **Step 3: Run** — `node --test test/nestStockDontRecut.test.mjs` → all pass.
- [ ] **Step 4: Syntax** — `node --check nest.js`.
- [ ] **Step 5: Commit** — `git add nest.js test/nestStockDontRecut.test.mjs && git commit -m "feat(nest): _stockAdjustedQty (don't re-cut cut-count) + guard test"`

---

## Task 2: `useStock` on the part + subtraction in `_buildNestPieces`

**Files:** Modify `nest.js`.

- [ ] **Step 1: Add `useStock` to `_newPart`** — in the returned object literal (`nest.js:150`), add after `selected: true,`:

```javascript
      useStock: true,  // S2: subtract confirmed Stock Part qty from this row's cut count (toggle in the row)
```

- [ ] **Step 2: Subtract in `_buildNestPieces`** — replace the inner loop header (`nest.js:4505`):

```javascript
      for (let i = 0; i < p.qty; i++) {
```
with:
```javascript
      const _inStock = (p.useStock !== false && window.kdStockPart && typeof window.kdStockPart.stockQtyByCode === 'function') ? (window.kdStockPart.stockQtyByCode(p.code) || 0) : 0;
      const _cutQty = _stockAdjustedQty(p.qty, _inStock, p.useStock !== false);
      for (let i = 0; i < _cutQty; i++) {
```

- [ ] **Step 3: Syntax** — `node --check nest.js`.
- [ ] **Step 4: Commit** — `git add nest.js && git commit -m "feat(nest): part.useStock (default on) + subtract confirmed stock in _buildNestPieces"`

---

## Task 3: Row badge `♻N` (toggle + cut hint + link) + row class

**Files:** Modify `nest.js`.

- [ ] **Step 1: Add `_stockBadge(p)`** — near `_stockAdjustedQty`:

```javascript
  // S2 row badge: shows confirmed stock for this code + the toggle + cut hint + a
  // deep-link to the Stock Part. Returns '' when the code has no confirmed stock.
  function _stockInfo(p) {
    const inStock = (!p.manual && window.kdStockPart && typeof window.kdStockPart.stockQtyByCode === 'function') ? (window.kdStockPart.stockQtyByCode(p.code) || 0) : 0;
    const on = p.useStock !== false;
    return { inStock: inStock, on: on, cut: _stockAdjustedQty(p.qty, inStock, on) };
  }
  function _stockBadge(p) {
    const s = _stockInfo(p);
    if (s.inStock <= 0) return '';
    const hint = !s.on ? 'stock off' : (s.cut <= 0 ? '✓ all in stock' : 'cut ' + s.cut + ' (' + p.qty + '−' + s.inStock + ')');
    return '<span class="kdnest-stock' + (s.on ? ' kdnest-stock-on' : '') + '" data-code="' + _esc(p.code) + '">'
      + '<button type="button" class="kdnest-stock-toggle" title="' + s.inStock + ' in stock — click to ' + (s.on ? 'ignore (cut full qty)' : 'use stock') + '">♻' + s.inStock + '</button>'
      + '<span class="kdnest-stock-hint">' + hint + '</span>'
      + '<a class="kdnest-stock-link" title="View in Stock Part">↗</a></span>';
  }
```

- [ ] **Step 2: Render the badge in the part row** — in `_viewHtml` partsRows, after the qty input line (`nest.js:6769`):
```javascript
          <input type="number" class="kdnest-part-qty" value="${p.qty}" min="0" step="1" title="qty">
```
add on the next line:
```javascript
          ${_stockBadge(p)}
```

- [ ] **Step 3: Add the `.kdnest-part-instock` row class** — in the same template's opening `<div class="kdnest-part…">`, append to the class expression. Find:
```javascript
        <div class="kdnest-part${p.manual ? ' kdnest-part-manual' : ''}${rowGrainWarn}${reviewMark}${(S.highlightCode && p.code === S.highlightCode) ? ' kdnest-part-active' : ''}" data-code="${_esc(p.code)}">
```
insert `${_stockInfo(p).inStock > 0 && _stockInfo(p).on ? ' kdnest-part-instock' : ''}` right before the `" data-code=` (after the `kdnest-part-active` expression).

- [ ] **Step 4: Syntax** — `node --check nest.js`.
- [ ] **Step 5: Commit** — `git add nest.js && git commit -m "feat(nest): stock badge (♻N toggle + cut hint + link) + .kdnest-part-instock row class"`

---

## Task 4: Wire the toggle + link; add `kdStockPart.focusCode`

**Files:** Modify `nest.js`, `stockpart.js`.

- [ ] **Step 1: `kdStockPart.focusCode(code)`** — in `stockpart.js`, add the function near `renderHome` and expose it on `window.kdStockPart`:

```javascript
  function focusCode(code) { _listQuery = String(code || ''); renderHome(); }
```
add `focusCode: focusCode,` to the `window.kdStockPart = { … }` public object (next to `renderHome`).

- [ ] **Step 2: Wire the badge controls** — in `nest.js` where the part-row events are attached (`~line 7236`, near `row.querySelector('.kdnest-part-qty')?.addEventListener('change', …)`), add inside that same per-row wiring block:

```javascript
      row.querySelector('.kdnest-stock-toggle')?.addEventListener('click', e => {
        e.stopPropagation();
        const p = S.parts.find(x => x.code === row.getAttribute('data-code'));
        if (p) { p.useStock = (p.useStock === false); _render(); }   // flip + repaint
      });
      row.querySelector('.kdnest-stock-link')?.addEventListener('click', e => {
        e.stopPropagation();
        const code = row.getAttribute('data-code');
        document.getElementById('tab-stockpart')?.click();
        if (window.kdStockPart && typeof window.kdStockPart.focusCode === 'function') window.kdStockPart.focusCode(code);
      });
```
> Verify the repaint function name used by the qty handler in that block (it is the nest re-render — match whatever the adjacent `.kdnest-part-qty` change handler calls, e.g. `_render()` / `_renderParts()` / `render()`). Use the SAME call so the row updates after a toggle.

- [ ] **Step 3: Syntax** — `node --check nest.js && node --check stockpart.js`.
- [ ] **Step 4: Commit** — `git add nest.js stockpart.js && git commit -m "feat(nest): wire stock toggle (flip useStock + repaint) + ↗ link to Stock Part (kdStockPart.focusCode)"`

---

## Task 5: CSS for the stock badge

**Files:** Modify `style.css`.

- [ ] **Step 1: Append** (after the existing `.kdnest-part-*` rules, or at the stock section):

```css
.kdnest-stock { display: inline-flex; align-items: center; gap: 5px; margin-left: 4px; font-size: 12px; }
.kdnest-stock-toggle { border: 1px solid #2c3a4e; border-radius: 999px; background: #2a3340; color: #8a97a8; cursor: pointer; padding: 1px 8px; font-size: 12px; }
.kdnest-stock-on .kdnest-stock-toggle { background: #1f3d2e; color: #7ee0a8; border-color: #2f6f4a; }   /* using stock = green */
.kdnest-stock:not(.kdnest-stock-on) .kdnest-stock-toggle { text-decoration: line-through; opacity: .7; } /* off = struck */
.kdnest-stock-hint { color: #8a97a8; }
.kdnest-stock-link { color: #6fb1ff; cursor: pointer; text-decoration: none; }
.kdnest-part-instock { box-shadow: inset 3px 0 0 #2f6f4a; }   /* subtle left rail, like other row flags */
```

- [ ] **Step 2: Commit** — `git add style.css && git commit -m "feat(nest): stock badge styles (green=using, struck=off, instock row rail)"`

---

## Task 6: Deploy + live verify + board

**Files:** none (+ board).

- [ ] **Step 1: Full suite** — `node --check nest.js && node --test` → all green (existing + `nestStockDontRecut`).
- [ ] **Step 2: Deploy** — `git push origin main`; `gh run watch` the run for this HEAD; `curl -s -H 'Cache-Control: no-store' .../nest.js | grep -c _stockAdjustedQty` ≥ 1.
- [ ] **Step 3: Live (Chrome, ?admin=1, NOT Edge):** in a project that has a part whose code has confirmed Stock Part qty (or temporarily confirm a stock row for a code in the project), open the Nest tab:
  - the row shows `♻N` + "cut (qty−N)"; the row has the instock rail.
  - Run nest → pieces for that code = `qty − N` (verify via `_buildNestPieces` result count or the placed count); a fully-covered part contributes 0 and is not flagged unplaced.
  - click `♻` → toggles to struck/grey, cut hint → full qty; Run → full qty.
  - click `↗` → switches to the Stock Part tab focused on that code.
  - a code with no stock shows no badge. Console clean.
- [ ] **Step 4: Board** — append one entry to `docs/coordination/group-sync.md` (S2 shipped, the integration points, live-verified), commit + push.

---

## Self-review
- **Spec coverage:** subtract-by-default (T2), per-row toggle (T3/T4), badge + cut hint + link (T3/T4), `useStock` in-memory (T2), `_stockAdjustedQty` (T1), `focusCode` deep-link (T4), no reservation/photo-migration (out of scope). ✓
- **Type consistency:** `_stockAdjustedQty(demand,inStock,useStock)`, `p.useStock`, `_stockInfo`/`_stockBadge`, `kdStockPart.stockQtyByCode`/`focusCode`, classes `.kdnest-stock`/`-on`/`-toggle`/`-hint`/`-link`/`.kdnest-part-instock` consistent across tasks. ✓
- **No placeholders:** the only "verify" note (T4 Step 2) is to match the adjacent qty-handler's repaint call name — a real lookup, resolved at execution. ✓
- **Back-compat:** `p.useStock !== false` treats missing as on; no stock → no badge, behaviour unchanged; nest.js had 0 prior stock refs. ✓
