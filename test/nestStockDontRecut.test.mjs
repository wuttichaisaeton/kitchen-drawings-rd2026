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
