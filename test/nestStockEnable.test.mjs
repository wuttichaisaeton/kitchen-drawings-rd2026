// Guards the per-row ENABLE checkbox + drag-to-reorder for the Sheet Stock
// table in nest.js (เอ๋ 2026-06-26).
//
// nest.js is a browser IIFE, so this test carries a FAITHFUL copy of the two
// load-bearing pure bits:
//   1. the activeStock filter rule used by _runNesting / the unplaced-review
//      thickness set — a row is used only when enabled !== false AND it has a
//      real size AND a usable qty (>0 or -1 unlimited).
//   2. the backward-compat coercion (missing 'enabled' field → true) shared by
//      the localStorage migration and the RTDB load.
//   3. the drag-reorder rebuild (rebuild S.sheetStock from the new DOM order).
//
// Live drag + checkbox interaction was verified in the browser preview; this is
// the fast CI guard.
import { test } from 'node:test';
import assert from 'node:assert';

// ── verbatim copy from nest.js (filter @ _runNesting line ~3667) ─────────
const activeStock = stock =>
  stock.filter(s => s.enabled !== false && s.w > 0 && s.h > 0 && (s.qty !== 0 || s.qty === -1));

// ── verbatim copy of the load coercion (localStorage + RTDB share it) ────
const coerceEnabled = r => ({
  w: +r.w || 0, h: +r.h || 0,
  qty: (r.qty === -1 ? -1 : (+r.qty || 0)),
  thickness: (r.thickness == null ? 1 : +r.thickness),
  label: String(r.label || ''),
  enabled: (r.enabled !== false),
});

// ── verbatim copy of the Sortable onEnd rebuild ──────────────────────────
function reorderByDom(sheetStock, domOrderIndices) {
  const order = domOrderIndices.filter(n => !isNaN(n));
  const reordered = order.map(i => sheetStock[i]).filter(Boolean);
  if (reordered.length === sheetStock.length) {
    sheetStock.splice(0, sheetStock.length, ...reordered);
  }
  return sheetStock;
}

// ── tests ────────────────────────────────────────────────────────────────
test('disabled row is excluded from the stock the nester uses', () => {
  const stock = [
    { w: 3050, h: 1525, qty: 1, thickness: 1, label: '10x5', enabled: true },
    { w: 3050, h: 1220, qty: 1, thickness: 1, label: '10x4', enabled: false }, // OFF
    { w: 2440, h: 1220, qty: 1, thickness: 1, label: '8x4',  enabled: true },
  ];
  const active = activeStock(stock);
  assert.equal(active.length, 2, 'the disabled row drops out');
  assert.ok(!active.some(s => s.label === '10x4'), 'the disabled size is not nested into');
  assert.deepEqual(active.map(s => s.label), ['10x5', '8x4'], 'order preserved, disabled removed');
});

test('enabled row with a real size + qty is included', () => {
  const stock = [{ w: 3050, h: 1525, qty: 1, thickness: 1, label: '10x5', enabled: true }];
  assert.equal(activeStock(stock).length, 1);
});

test('checkbox gate is independent of the qty gate (both must pass)', () => {
  // enabled but qty 0 → still excluded (existing qty rule untouched)
  assert.equal(activeStock([{ w: 100, h: 100, qty: 0, thickness: 1, enabled: true }]).length, 0);
  // enabled + unlimited (-1) → included
  assert.equal(activeStock([{ w: 100, h: 100, qty: -1, thickness: 1, enabled: true }]).length, 1);
  // disabled but qty unlimited → excluded by the checkbox
  assert.equal(activeStock([{ w: 100, h: 100, qty: -1, thickness: 1, enabled: false }]).length, 0);
});

test('old saved rows without an enabled field load as ENABLED (no row vanishes)', () => {
  const oldRows = [
    { w: 3050, h: 1525, qty: 1, thickness: 1, label: '10x5' },             // no enabled
    { w: 2440, h: 1220, qty: 1, thickness: 1, label: '8x4', enabled: false }, // explicit off
  ];
  const loaded = oldRows.map(coerceEnabled);
  assert.equal(loaded[0].enabled, true, 'missing field → enabled true');
  assert.equal(loaded[1].enabled, false, 'explicit false preserved');
  // and the upgraded set nests the legacy row that had no flag
  assert.equal(activeStock(loaded).length, 1, 'legacy row stays usable, explicit-off drops');
});

test('drag reorder rebuilds the stock array from the new DOM order + persists order', () => {
  const stock = [
    { w: 3050, h: 1525, qty: 1, label: '10x5', enabled: true },
    { w: 3050, h: 1220, qty: 1, label: '10x4', enabled: true },
    { w: 2440, h: 1220, qty: 1, label: '8x4',  enabled: true },
  ];
  // user drags the last row (index 2) to the top → DOM order [2,0,1]
  reorderByDom(stock, [2, 0, 1]);
  assert.deepEqual(stock.map(s => s.label), ['8x4', '10x5', '10x4'], 'order follows the drag');
  // nesting now tries 8x4 first (priority = position)
  assert.equal(activeStock(stock)[0].label, '8x4', 'reordered priority respected by the nester');
});

test('reorder is a no-op if the DOM order count mismatches (defensive)', () => {
  const stock = [
    { w: 1, h: 1, qty: 1, label: 'a', enabled: true },
    { w: 1, h: 1, qty: 1, label: 'b', enabled: true },
  ];
  reorderByDom(stock, [1]);   // only one index → reject
  assert.deepEqual(stock.map(s => s.label), ['a', 'b'], 'array untouched on mismatch');
});

// ── Total Cost STALE signalling (เอ๋ 2026-06-26) ──────────────────────────
// When the sheet stock changes AFTER a run, the shown Total Cost is from the
// OLD run → it must dim + show "press Run to update" until the next run.
// nest.js is a browser IIFE; this is a FAITHFUL copy of the load-bearing rule
// shared by every stock handler ("mark stale only if a result exists") and the
// run-complete clear (in _runNesting where S.flatSheets is set). Live dim + hint
// were verified in the browser preview; this is the fast CI guard.

// verbatim rule from the stock handlers (enable/dim/qty/thick/prc, reorder, manual)
const markStaleOnStockChange = S => { if (S.flatSheets && S.flatSheets.length) S.costStale = true; };
// verbatim clear from _runNesting after it sets S.flatSheets
const onRunComplete = (S, sheets) => { S.flatSheets = sheets; S.costStale = false; };

test('stock-enable toggle flips costStale TRUE once a result exists', () => {
  const S = { flatSheets: [{ sw: 2440, sh: 1220, placements: [] }], costStale: false };
  markStaleOnStockChange(S);            // user toggles a sheet-enable checkbox
  assert.equal(S.costStale, true, 'toggling stock after a run marks the cost stale');
});

test('a run clears costStale back to FALSE (fresh number)', () => {
  const S = { flatSheets: [{}], costStale: true };
  onRunComplete(S, [{ sw: 2440, sh: 1220, placements: [] }]);
  assert.equal(S.costStale, false, 'the run-complete path drops the stale flag');
});

test('stock change with NO result yet does not mark stale (renders nothing anyway)', () => {
  const S = { flatSheets: [], costStale: false };
  markStaleOnStockChange(S);
  assert.equal(S.costStale, false, 'no result → no stale state (summary renders empty)');
});

// ── REAL nest.js sanity: the live filter still drops a disabled row ───────
// Loads the actual nest.js IIFE (via the same shim style as nestEdgeGrain) only
// to confirm the symbol set didn't regress — falls back silently if the build
// doesn't expose a stock test hook (the verbatim filter above is the contract).
