// Guards the AUTO COST-OPTIMIZE selection logic in nest.js (เอ๋ 2026-06-26):
// given synthetic headless trial results + a per-size price map, the optimizer
// must pick the MIN-cost scenario that places EVERYTHING (0 unplaced), tie-break
// on fewest fresh sheets, and pick NOTHING when no scenario is feasible.
//
// nest.js is a browser IIFE, so this test carries a FAITHFUL copy of the two
// pure scoring functions (_scoreTrialResult + _pickCheapestTrial). The full
// packing (_nestMultiSheet) is NOT needed here — we feed synthetic trial
// results, exactly as the task spec requires.
//
// Live trial orchestration + spinner + Auto-chosen badge were verified in the
// browser preview; this is the fast CI guard for the cost-compare math.
import { test } from 'node:test';
import assert from 'node:assert';

// ── verbatim copy from nest.js ─────────────────────────────────────────────
function _scoreTrialResult(res, priceBySize) {
  if (!res || (res.unplaced && res.unplaced.length)) return null;
  let cost = 0, fresh = 0;
  for (const s of (res.sheets || [])) {
    const key = `${Math.round(s.sw)}x${Math.round(s.sh)}`;
    cost += (priceBySize[key] || 0);
    fresh++;
  }
  return { cost, freshCount: fresh };
}
function _pickCheapestTrial(trials, priceBySize) {
  let best = null;
  for (const t of trials) {
    const sc = _scoreTrialResult(t.result, priceBySize);
    if (!sc) continue;
    const cand = { ...t, cost: sc.cost, freshCount: sc.freshCount };
    if (best === null
        || cand.cost < best.cost
        || (cand.cost === best.cost && cand.freshCount < best.freshCount)) {
      best = cand;
    }
  }
  return best;
}

// ── helpers to build synthetic trial results ───────────────────────────────
const PRICE = { '3050x1525': 3850, '2440x1220': 2350, '3050x1220': 2750 };
const sheet = (w, h) => ({ sw: w, sh: h, placements: [{}] });
const feasible = (...sizes) => ({ sheets: sizes.map(([w, h]) => sheet(w, h)), unplaced: [] });
const infeasible = (...sizes) => ({ sheets: sizes.map(([w, h]) => sheet(w, h)), unplaced: [{}, {}] });

// ── tests ──────────────────────────────────────────────────────────────────
test('scoring: cost = sum of fresh sheets by size, no-unplaced only', () => {
  assert.deepEqual(
    _scoreTrialResult(feasible([3050, 1525], [2440, 1220]), PRICE),
    { cost: 3850 + 2350, freshCount: 2 });
  assert.equal(_scoreTrialResult(infeasible([3050, 1525]), PRICE), null,
    'any unplaced → infeasible (null)');
  assert.equal(_scoreTrialResult(null, PRICE), null, 'no result → null');
});

test('PICK: prefers the cheaper MIX over a pricier single-size plan', () => {
  // The headline case from the spec: a 10x5 ×2 + 8x4 ×1 mix = 10,050 must beat
  // an all-10x5 plan of 3 sheets = 11,550.
  const trials = [
    { name: 'mix-all', keys: new Set(['3050x1525', '2440x1220']),
      result: feasible([3050, 1525], [3050, 1525], [2440, 1220]) },     // 10,050
    { name: '3050x1525', keys: new Set(['3050x1525']),
      result: feasible([3050, 1525], [3050, 1525], [3050, 1525]) },     // 11,550
  ];
  const win = _pickCheapestTrial(trials, PRICE);
  assert.equal(win.name, 'mix-all', 'cheapest mix wins');
  assert.equal(win.cost, 10050);
});

test('PICK: a cheaper single size beats a mix when it places everything', () => {
  const trials = [
    { name: '2440x1220', keys: new Set(['2440x1220']),
      result: feasible([2440, 1220], [2440, 1220]) },                   // 4,700
    { name: 'mix-all', keys: new Set(['3050x1525', '2440x1220']),
      result: feasible([3050, 1525], [2440, 1220]) },                   // 6,200
  ];
  const win = _pickCheapestTrial(trials, PRICE);
  assert.equal(win.name, '2440x1220');
  assert.equal(win.cost, 4700);
});

test('PICK: infeasible (has unplaced) scenarios are never chosen', () => {
  const trials = [
    { name: 'cheap-but-broken', keys: new Set(['2440x1220']),
      result: infeasible([2440, 1220]) },                              // 2,350 BUT unplaced
    { name: 'works', keys: new Set(['3050x1525']),
      result: feasible([3050, 1525], [3050, 1525]) },                  // 7,700
  ];
  const win = _pickCheapestTrial(trials, PRICE);
  assert.equal(win.name, 'works', 'the only 0-unplaced plan wins despite higher cost');
  assert.equal(win.cost, 7700);
});

test('PICK: tie on cost → fewer fresh sheets wins', () => {
  // Equal cost (4,700), different sheet count. B carries an extra zero-priced
  // sheet (an unknown size → priced 0) so cost stays 4,700 but freshCount=3.
  const A = { name: 'A-2sheets',
    result: { sheets: [sheet(2440, 1220), sheet(2440, 1220)], unplaced: [] } };          // 4700, 2 sheets
  const B = { name: 'B-3sheets',
    result: { sheets: [sheet(2440, 1220), sheet(2440, 1220), sheet(1, 1)], unplaced: [] } }; // 4700+0, 3 sheets
  const win = _pickCheapestTrial([B, A], PRICE);
  assert.equal(win.cost, 4700, 'both cost 4,700');
  assert.equal(win.name, 'A-2sheets', 'tie → fewer fresh sheets');
});

test('PICK: returns null when NO scenario places everything', () => {
  const trials = [
    { name: 'a', result: infeasible([3050, 1525]) },
    { name: 'b', result: infeasible([2440, 1220]) },
  ];
  assert.equal(_pickCheapestTrial(trials, PRICE), null,
    'all infeasible → null → caller falls back to normal run');
});
