// Guards the LAST-PARTIAL-SHEET DOWNSIZING logic in nest.js (เอ๋ 2026-06-26):
// after the optimizer picks its plan, the LAST fresh sheet (usually partial — a
// few parts + a big leftover) is swapped to the CHEAPEST enabled size its parts
// still fit on, lowering total cost. e.g. for "04 Ruth" the plan was 10x4 ×5 =
// 13,750, but the last sheet's ~7 small parts fit on an 8x4 (2,350) → the mix
// 10x4 ×4 + 8x4 ×1 = 13,350 wins.
//
// nest.js is a browser IIFE, so this test carries a FAITHFUL copy of the pure
// selection core (_pickDownsizeSize) and drives it with a stubbed `fitsFn` that
// stands in for the headless packer (_nestMultiSheet). The real DOM wrapper
// (_downsizeLastFreshSheet) reconstructs parts, builds the candidate list, and
// wires fitsFn to _nestMultiSheet; that wiring + the live render/cost/badge were
// verified in the browser preview. This is the fast CI guard for the math.
import { test } from 'node:test';
import assert from 'node:assert';

// ── verbatim copy from nest.js ─────────────────────────────────────────────
function _pickDownsizeSize(currentPrc, candidates, fitsFn) {
  const cheaper = (candidates || [])
    .filter(c => (c.prc || 0) < currentPrc)   // STRICTLY cheaper only — never upsize
    .slice()
    .sort((a, b) => (a.prc || 0) - (b.prc || 0));   // try cheapest first
  for (const cand of cheaper) {
    const placements = fitsFn(cand);
    if (placements && placements.length) return { size: cand, placements };
  }
  return null;
}

// Sizes + prices straight from the spec (stock rows row.prc).
const S10x4 = { w: 3050, h: 1220, prc: 2750 };
const S8x4  = { w: 2440, h: 1220, prc: 2350 };
const S10x5 = { w: 3050, h: 1525, prc: 3850 };

// A fake packed-placements array (non-empty = "fit").
const okFit = [{}, {}, {}, {}, {}, {}, {}];   // 7 small parts placed

// Helper: total plan cost for "N-1 full sheets of the winner size + the (maybe
// downsized) last sheet", mirroring _countFreshSheetsBySize semantics.
const planCost = (fullCount, fullPrc, lastPrc) => fullCount * fullPrc + lastPrc;

// ── tests ──────────────────────────────────────────────────────────────────
test('DOWNSIZE: last 10x4 sheet whose parts fit on 8x4 → mix 13,350 beats 13,750', () => {
  // Optimizer winner: all 10x4, 5 sheets = 13,750. Last sheet holds ~7 small
  // parts. fitsFn says they fit on 8x4 (cheaper) but the only candidate offered
  // is the cheaper-than-10x4 set.
  const candidates = [S8x4 /* 2350 */];   // (10x4 itself excluded by the wrapper: same size)
  // fitsFn: 8x4 fits all the parts.
  const fitsFn = (cand) => (cand.w === S8x4.w && cand.h === S8x4.h) ? okFit : null;

  const pick = _pickDownsizeSize(S10x4.prc /* current last sheet = 10x4 */, candidates, fitsFn);
  assert.ok(pick, 'a cheaper fitting size was found');
  assert.equal(pick.size.prc, 2350, 'picked the 8x4 (2,350)');
  assert.equal(pick.placements.length, 7, 'all 7 parts carried onto the smaller sheet');

  // The resulting plan cost: 4×10x4 (full) + 1×8x4 (downsized last) = 13,350,
  // strictly cheaper than the un-downsized 5×10x4 = 13,750.
  const before = planCost(4, S10x4.prc, S10x4.prc);   // 5×10x4
  const after  = planCost(4, S10x4.prc, pick.size.prc); // 4×10x4 + 8x4
  assert.equal(before, 13750);
  assert.equal(after, 13350);
  assert.ok(after < before, 'downsizing strictly lowered the total cost');
});

test('GUARD: parts do NOT fit the smaller size → no swap, plan unchanged', () => {
  // The last sheet's parts are too big for the cheaper 8x4: fitsFn returns null.
  const candidates = [S8x4];
  const fitsFn = () => null;   // nothing fits the smaller sheet
  const pick = _pickDownsizeSize(S10x4.prc, candidates, fitsFn);
  assert.equal(pick, null, 'no fit → null → caller keeps the original sheet size');
});

test('GUARD: never swap to a same/more-expensive size (no upsize, no lateral)', () => {
  // Only a MORE expensive size (10x5) is offered, and a fitsFn that WOULD fit it.
  // It must be ignored because it is not strictly cheaper than the current 10x4.
  const candidates = [S10x5 /* 3850 > 2750 */];
  const fitsFn = () => okFit;   // would fit, but it's pricier
  const pick = _pickDownsizeSize(S10x4.prc, candidates, fitsFn);
  assert.equal(pick, null, 'pricier candidate filtered out → no swap');
});

test('DOWNSIZE: among multiple cheaper fitting sizes, pick the CHEAPEST', () => {
  // Two cheaper sizes both fit; the optimizer must take the cheapest (8x4).
  const cheaperMid = { w: 2000, h: 1000, prc: 2500 };   // hypothetical mid-price
  const candidates = [cheaperMid /* 2500 */, S8x4 /* 2350 */];
  const fitsFn = () => okFit;   // both fit
  const pick = _pickDownsizeSize(S10x4.prc, candidates, fitsFn);
  assert.ok(pick);
  assert.equal(pick.size.prc, 2350, 'cheapest fitting size wins');
});

test('GUARD: empty / no candidates → null (no cheaper enabled size exists)', () => {
  assert.equal(_pickDownsizeSize(2750, [], () => okFit), null);
  assert.equal(_pickDownsizeSize(2750, null, () => okFit), null);
});
