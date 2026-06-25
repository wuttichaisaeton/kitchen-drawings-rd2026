// Guards the per-sheet PRICE field + auto total-cost SUM for the Sheet Stock
// table in nest.js (เอ๋ 2026-06-26).
//
// nest.js is a browser IIFE, so this test carries a FAITHFUL copy of the four
// load-bearing pure bits:
//   1. _getPriceDefault — size→price map (dimensions first, label fallback).
//   2. the load/seed no-clobber rule: (+prc || 0) || _getPriceDefault(...).
//   3. _applyPriceDefault — seed only when prc is unset/0, never overwrite.
//   4. _countFreshSheetsBySize + the SUM — FRESH full sheets only, remnants
//      (fromRemnant != null) excluded, grouped by size × that size's price.
//
// Live UI (input render, in-place summary re-render) was verified in the
// browser preview; this is the fast CI guard for the math + migration.
import { test } from 'node:test';
import assert from 'node:assert';

// ── verbatim copy from nest.js (_getPriceDefault) ────────────────────────
function _getPriceDefault(w, h, label) {
  if ((w === 3050 && h === 1525) || (w === 1525 && h === 3050)) return 3850;
  if ((w === 3050 && h === 1220) || (w === 1220 && h === 3050)) return 2750;
  if ((w === 2440 && h === 1220) || (w === 1220 && h === 2440)) return 2350;
  const l = String(label || '').toLowerCase();
  if (l.includes('10x5')) return 3850;
  if (l.includes('10x4')) return 2750;
  if (l.includes('8x4'))  return 2350;
  return 0;
}
function _applyPriceDefault(row) {
  if (!row.prc) row.prc = _getPriceDefault(row.w, row.h, row.label);
}
// load coercion (localStorage + RTDB share the no-clobber rule)
const coercePrc = r => ({
  w: +r.w || 0, h: +r.h || 0,
  prc: (+r.prc || 0) || _getPriceDefault(+r.w || 0, +r.h || 0, String(r.label || '')),
  label: String(r.label || ''),
});
// _countFreshSheetsBySize + SUM (operates on flatSheets + sheetStock)
function totalCost(flatSheets, sheetStock) {
  const sizeMap = new Map();
  for (const sheet of (flatSheets || [])) {
    if (sheet.fromRemnant !== null && sheet.fromRemnant !== undefined) continue;
    const w = Math.round(sheet.sw), h = Math.round(sheet.sh);
    const key = `${w}x${h}`;
    if (!sizeMap.has(key)) {
      const stock = sheetStock.find(s => Math.round(s.w) === w && Math.round(s.h) === h);
      const prc = (stock && stock.prc) || _getPriceDefault(w, h, (stock && stock.label) || '');
      sizeMap.set(key, { w, h, count: 0, prc });
    }
    sizeMap.get(key).count += 1;
  }
  let total = 0;
  for (const e of sizeMap.values()) total += e.prc * e.count;
  return { total, sizeMap };
}

// ── tests ────────────────────────────────────────────────────────────────
test('default-by-size: dimensions map to the right price', () => {
  assert.equal(_getPriceDefault(2440, 1220, ''), 2350, '8x4');
  assert.equal(_getPriceDefault(3050, 1220, ''), 2750, '10x4');
  assert.equal(_getPriceDefault(3050, 1525, ''), 3850, '10x5');
  assert.equal(_getPriceDefault(3050, 1525, ''), _getPriceDefault(1525, 3050, ''), 'rotated matches');
  assert.equal(_getPriceDefault(1000, 1000, ''), 0, 'unknown → custom 0');
});

test('default-by-size: label fallback when dimensions do not match', () => {
  assert.equal(_getPriceDefault(0, 0, '10x5'), 3850);
  assert.equal(_getPriceDefault(0, 0, '8X4'), 2350, 'case-insensitive');
  assert.equal(_getPriceDefault(0, 0, '(custom)'), 0);
});

test('no-clobber: a user-entered price survives load (short-circuit on truthy prc)', () => {
  const loaded = coercePrc({ w: 3050, h: 1525, prc: 4000, label: '10x5' });
  assert.equal(loaded.prc, 4000, 'user price kept, NOT reset to 3850');
});

test('backward-compat: old row with no prc field gets the size default on load', () => {
  const loaded = coercePrc({ w: 2440, h: 1220, label: '8x4' });  // no prc
  assert.equal(loaded.prc, 2350, 'missing prc → 8x4 default');
});

test('_applyPriceDefault seeds only when unset/0, never overwrites a price', () => {
  const a = { w: 3050, h: 1220, label: '10x4', prc: 0 };
  _applyPriceDefault(a);
  assert.equal(a.prc, 2750, 'unset → seeded');
  const b = { w: 3050, h: 1220, label: '10x4', prc: 9999 };
  _applyPriceDefault(b);
  assert.equal(b.prc, 9999, 'user price untouched');
});

test('custom row stays 0 until the user types a price', () => {
  const c = { w: 0, h: 0, label: '(custom)', prc: 0 };
  _applyPriceDefault(c);
  assert.equal(c.prc, 0, 'no match → stays 0');
});

test('SUM = fresh full sheets per size × price, remnants EXCLUDED', () => {
  const stock = [
    { w: 3050, h: 1525, prc: 3850, label: '10x5' },
    { w: 2440, h: 1220, prc: 2350, label: '8x4' },
  ];
  const flatSheets = [
    { sw: 3050, sh: 1525, fromRemnant: null },          // fresh 10x5
    { sw: 3050, sh: 1525, fromRemnant: null },          // fresh 10x5
    { sw: 2440, sh: 1220, fromRemnant: null },          // fresh 8x4
    { sw: 1200, sh: 600,  fromRemnant: 'rem_abc123' },  // reused offcut → skip
  ];
  const { total, sizeMap } = totalCost(flatSheets, stock);
  assert.equal(sizeMap.get('3050x1525').count, 2, '2 fresh 10x5');
  assert.equal(sizeMap.get('2440x1220').count, 1, '1 fresh 8x4');
  assert.ok(!sizeMap.has('1200x600'), 'offcut sheet not counted');
  assert.equal(total, 3850 * 2 + 2350 * 1, 'SUM = 10,050');
  assert.equal(total, 10050);
});

test('SUM falls back to size-default price when a stock row is missing', () => {
  const stock = [];  // no matching row
  const flatSheets = [{ sw: 3050, sh: 1220, fromRemnant: null }];
  assert.equal(totalCost(flatSheets, stock).total, 2750, 'falls back to 10x4 default');
});

test('SUM is 0 when every sheet is a reused offcut', () => {
  const flatSheets = [
    { sw: 1000, sh: 500, fromRemnant: 'r1' },
    { sw: 800,  sh: 400, fromRemnant: 'r2' },
  ];
  assert.equal(totalCost(flatSheets, []).total, 0, 'no fresh sheets → 0');
});

test('last-sheet rectified remnant (fromRemnant null) still counts as fresh', () => {
  // _rectifyLastSheet re-packs the LAST fresh sheet to isolate one offcut
  // WITHIN it — the sheet stays fromRemnant === null, so it is billed.
  const stock = [{ w: 3050, h: 1525, prc: 3850, label: '10x5' }];
  const flatSheets = [{ sw: 3050, sh: 1525, fromRemnant: null, lastRemnantRect: { w: 400, h: 1525 } }];
  assert.equal(totalCost(flatSheets, stock).total, 3850, 'rectified sheet billed normally');
});
