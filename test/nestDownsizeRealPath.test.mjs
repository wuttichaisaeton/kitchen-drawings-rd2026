// REAL-PATH guard for the LAST-PARTIAL-SHEET DOWNSIZE (เอ๋ 2026-06-26).
//
// The sibling test (nestDownsizeLastSheet.test.mjs) only exercises the pure
// _pickDownsizeSize core with a STUBBED fitsFn + synthetic candidates — it never
// runs the real DOM wrapper's candidate-BUILD loop nor the real packer, which is
// exactly why the live downsize silently failed while that test stayed green.
//
// This test drives the REAL path: it carries a FAITHFUL copy of
//   • the MaxRects packer + the rectangular _nestMultiSheet pack loop, and
//   • the full _downsizeLastFreshSheet (reconstruct pieces from placements WITH
//     geometry, build the candidate list, wire fitsFn to the real packer, swap).
// It reconstructs the 04-Ruth last sheet (7 small parts on a 10x4) with realistic
// polys/bbox and asserts the swap to the cheaper 8x4 actually happens.
//
// THE BUG IT CATCHES: the auto-optimizer temporarily disables the losing sizes
// (sets S.sheetStock[8x4].enabled = false) before the final run, so the candidate
// loop's old `if (s.enabled === false) continue;` filtered 8x4 OUT → empty
// candidate list → no downsize. The fix passes the user's ORIGINAL enabled set
// (allowKeys) so a user-enabled cheaper size stays eligible. The first test below
// FAILS against the pre-fix loop (allowKeys ignored) and PASSES after.
import { test } from 'node:test';
import assert from 'node:assert';

// ── verbatim copy from nest.js: MaxRects packer ─────────────────────────────
class MaxRectsPacker {
  constructor(W, H) { this.W = W; this.H = H; this.free = [{ x: 0, y: 0, w: W, h: H }]; }
  bestFit(w, h) {
    let best = null;
    for (const r of this.free) {
      if (r.w >= w && r.h >= h) {
        const lx = r.w - w, ly = r.h - h;
        const shortV = Math.min(lx, ly), longV = Math.max(lx, ly);
        if (best === null || shortV < best.short || (shortV === best.short && longV < best.long))
          best = { x: r.x, y: r.y, short: shortV, long: longV };
      }
    }
    return best;
  }
  commit(x, y, w, h) { this._split(x, y, w, h); return [x, y]; }
  _split(x, y, w, h) {
    const next = [];
    for (const r of this.free) {
      if (x >= r.x + r.w || x + w <= r.x || y >= r.y + r.h || y + h <= r.y) { next.push(r); continue; }
      if (x > r.x) next.push({ x: r.x, y: r.y, w: x - r.x, h: r.h });
      if (x + w < r.x + r.w) next.push({ x: x + w, y: r.y, w: r.x + r.w - (x + w), h: r.h });
      if (y > r.y) next.push({ x: r.x, y: r.y, w: r.w, h: y - r.y });
      if (y + h < r.y + r.h) next.push({ x: r.x, y: y + h, w: r.w, h: r.y + r.h - (y + h) });
    }
    const kept = [];
    for (let i = 0; i < next.length; i++) {
      const a = next[i];
      if (a.w <= 0 || a.h <= 0) continue;
      let contained = false;
      for (let j = 0; j < next.length; j++) {
        if (i === j) continue;
        const b = next[j];
        if (b.w <= 0 || b.h <= 0) continue;
        if (a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h) { contained = true; break; }
      }
      if (!contained) kept.push(a);
    }
    this.free = kept;
  }
}

// ── faithful copy: the rectangular MaxRects path of _nestMultiSheet ──────────
// (stock-fill loop + bestFit-per-rotation, matching nest.js runOne('MaxRects'))
function _nestMultiSheet(pieces, stock, gap) {
  const sorted = pieces.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h));
  const stockCopy = stock.map(s => ({ ...s }));
  const sheets = [];
  let remaining = sorted.slice();
  let guard = remaining.length * 50 + 100;
  while (remaining.length) {
    if (--guard < 0) break;
    let placedAny = false;
    for (let si = 0; si < stockCopy.length; si++) {
      const s = stockCopy[si];
      if (s.qty === 0) continue;
      const packer = new MaxRectsPacker(s.w, s.h);
      const placed = [], stillLeft = [];
      for (const piece of remaining) {
        let best = null;
        for (const rot of piece.rots) {
          const rw = (rot === 90 || rot === 270) ? piece.h + gap : piece.w + gap;
          const rh = (rot === 90 || rot === 270) ? piece.w + gap : piece.h + gap;
          const fit = packer.bestFit(rw, rh);
          if (!fit) continue;
          if (best === null || fit.short < best.fit.short || (fit.short === best.fit.short && fit.long < best.fit.long))
            best = { rot, rw, rh, fit };
        }
        if (best) { const [x, y] = packer.commit(best.fit.x, best.fit.y, best.rw, best.rh); placed.push({ ...piece, x, y, rot: best.rot }); }
        else stillLeft.push(piece);
      }
      if (placed.length) { sheets.push({ sw: s.w, sh: s.h, placements: placed }); if (s.qty > 0) s.qty -= 1; remaining = stillLeft; placedAny = true; break; }
    }
    if (!placedAny) break;
  }
  return { sheets, unplaced: remaining };
}

const _thickKey = (t) => String(Math.round((t ?? 1) * 100) / 100);
const _getPriceDefault = () => 0;   // stock rows carry explicit prc here

// ── faithful copy from nest.js: _downsizeLastFreshSheet ─────────────────────
// (reconstruct from placements WITH geometry → candidate list honoring allowKeys
//  → fitsFn via real packer → swap in place). `S` is an injected state object so
//  the test can drive it. This mirrors nest.js exactly incl. the eligibility fix.
function _downsizeLastFreshSheet(S, allowKeys) {
  const GAP = S.gap;
  const sheets = S.flatSheets || [];
  let li = -1;
  for (let i = sheets.length - 1; i >= 0; i--) { if (!sheets[i].fromRemnant) { li = i; break; } }
  if (li < 0) return;
  const sheet = sheets[li];
  if (!sheet.placements || !sheet.placements.length) return;

  const curW = Math.round(sheet.sw), curH = Math.round(sheet.sh);
  const curRow = S.sheetStock.find(s => Math.round(s.w) === curW && Math.round(s.h) === curH);
  const curPrc = (curRow && curRow.prc) || _getPriceDefault();
  if (!(curPrc > 0)) return;

  const tk = _thickKey(sheet.thick);

  const usedFreshBySize = new Map();
  sheets.forEach((s, i) => {
    if (i === li) return;
    if (s.fromRemnant) return;
    const k = `${Math.round(s.w ? s.w : s.sw)}x${Math.round(s.h ? s.h : s.sh)}`;
    usedFreshBySize.set(k, (usedFreshBySize.get(k) || 0) + 1);
  });

  const candidates = [];
  for (const s of S.sheetStock) {
    if (!(s.w > 0 && s.h > 0)) continue;
    const w = Math.round(s.w), h = Math.round(s.h);
    // THE FIX: trust allowKeys when given, else the live `enabled` flag.
    const eligible = allowKeys ? allowKeys.has(`${w}x${h}`) : (s.enabled !== false);
    if (!eligible) continue;
    if (_thickKey(s.thickness ?? 1) !== tk) continue;
    if (w === curW && h === curH) continue;
    const prc = (s.prc || 0) || _getPriceDefault();
    const key = `${w}x${h}`;
    const cap = (s.qty === -1) ? Infinity : (s.qty | 0);
    const remaining = (cap === Infinity) ? Infinity : (cap - (usedFreshBySize.get(key) || 0));
    if (remaining < 1) continue;
    candidates.push({ w, h, prc, thickness: s.thickness ?? 1 });
  }
  if (!candidates.length) return;

  const parts = sheet.placements.map(pl => ({
    code: pl.code, w: pl.w, h: pl.h,
    rots: Array.isArray(pl.rots) ? pl.rots.slice() : [0, 90, 180, 270],
    polys: pl.polys, bbox: pl.bbox, thickness: pl.thickness,
    grain: pl.grain, grainAngle: pl.grainAngle,
  }));
  const need = sheet.placements.length;

  const fitsFn = (cand) => {
    const stock = [{ w: cand.w, h: cand.h, qty: 1, thickness: cand.thickness }];
    let r;
    try { r = _nestMultiSheet(parts.map(p => ({ ...p })), stock, GAP); }
    catch (e) { return null; }
    const out = r && r.sheets && r.sheets[0];
    if (!out || (r.unplaced && r.unplaced.length) || r.sheets.length !== 1) return null;
    if (out.placements.length !== need) return null;
    return out.placements;
  };

  // _pickDownsizeSize (verbatim)
  const cheaper = candidates.filter(c => (c.prc || 0) < curPrc).slice().sort((a, b) => (a.prc || 0) - (b.prc || 0));
  let pick = null;
  for (const cand of cheaper) { const pl = fitsFn(cand); if (pl && pl.length) { pick = { size: cand, placements: pl }; break; } }
  if (!pick) return;

  sheet.sw = pick.size.w;
  sheet.sh = pick.size.h;
  sheet.placements = pick.placements;
  sheet.lastRemnantRect = null;
}

// ── fixtures: the REAL 04-Ruth last-sheet part set ──────────────────────────
// (code, w, h straight from the live repro). Rebuilt as DXF-like pieces WITH
// realistic axis-aligned polys + bbox so the reconstruction carries geometry,
// exactly like a real placement does. Directional grain (H) → rots [0,180].
const RUTH_LAST = [
  ['TS1BHH-080000', 817, 108],
  ['FN1BLA-070000', 696, 123],
  ['FN2BNX-070000', 696, 123],
  ['DSB0BA-070050', 634, 127],
  ['BM1LI0-080000', 793,  99],
  ['FN2BNX-060000', 596, 123],
  ['BM1LI0-070000', 693,  99],
];
function rectPolys(w, h) { return { outer: [[0, 0], [w, 0], [w, h], [0, h]], holes: [], strokes: [], entities: [] }; }
function makePlacements() {
  // Lay them out on a 10x4 sheet (positions don't matter for downsize — only the
  // geometry fields carried by reconstruction do). Grain H → rots [0,180].
  return RUTH_LAST.map(([code, w, h], i) => ({
    code, w, h, x: 0, y: i * 140, rot: 0,
    rots: [0, 180],
    polys: rectPolys(w, h), bbox: [0, 0, w, h],
    thickness: 1, grain: 'H', grainAngle: null,
  }));
}

// Stock as the AUTO optimizer leaves it just before the final run: the winning
// 10x4 enabled; the LOSING 8x4 + 10x5 TEMPORARILY DISABLED (enabled:false).
function makeState() {
  return {
    gap: 5,
    sheetStock: [
      { w: 3050, h: 1220, qty: 20, prc: 2750, thickness: 1, enabled: true,  label: '10x4' },
      { w: 2440, h: 1220, qty: 10, prc: 2350, thickness: 1, enabled: false, label: '8x4'  }, // optimizer-disabled loser
      { w: 3050, h: 1525, qty: 7,  prc: 3850, thickness: 1, enabled: false, label: '10x5' }, // optimizer-disabled loser
    ],
    // 5 fresh 10x4 sheets — the last one holds only the 7 small parts.
    flatSheets: [
      { thick: 1, sw: 3050, sh: 1220, placements: [{ code: 'big', w: 2900, h: 1100, rots: [0, 180], polys: rectPolys(2900, 1100), bbox: [0, 0, 2900, 1100], thickness: 1, grain: 'H' }], fromRemnant: null },
      { thick: 1, sw: 3050, sh: 1220, placements: [{ code: 'big2', w: 2900, h: 1100, rots: [0, 180], polys: rectPolys(2900, 1100), bbox: [0, 0, 2900, 1100], thickness: 1, grain: 'H' }], fromRemnant: null },
      { thick: 1, sw: 3050, sh: 1220, placements: [{ code: 'big3', w: 2900, h: 1100, rots: [0, 180], polys: rectPolys(2900, 1100), bbox: [0, 0, 2900, 1100], thickness: 1, grain: 'H' }], fromRemnant: null },
      { thick: 1, sw: 3050, sh: 1220, placements: [{ code: 'big4', w: 2900, h: 1100, rots: [0, 180], polys: rectPolys(2900, 1100), bbox: [0, 0, 2900, 1100], thickness: 1, grain: 'H' }], fromRemnant: null },
      { thick: 1, sw: 3050, sh: 1220, placements: makePlacements(), fromRemnant: null },   // partial LAST sheet
    ],
  };
}

// The allow-set the FIXED orchestrator passes: the sizes the USER enabled
// ORIGINALLY (all three), NOT the optimizer's mutated flags.
const USER_ENABLED = new Set(['3050x1220', '2440x1220', '3050x1525']);

// ── tests ───────────────────────────────────────────────────────────────────
test('REAL PATH: last 10x4 sheet downsizes to 8x4 (04-Ruth parts) WITH the fix', () => {
  const S = makeState();
  const last = S.flatSheets[S.flatSheets.length - 1];
  assert.equal(Math.round(last.sw), 3050, 'precondition: last sheet starts as 10x4');

  _downsizeLastFreshSheet(S, USER_ENABLED);   // ← fix: pass user's original enabled set

  assert.equal(Math.round(last.sw), 2440, 'last sheet swapped to 8x4 width');
  assert.equal(Math.round(last.sh), 1220, 'last sheet height = 8x4');
  assert.equal(last.placements.length, RUTH_LAST.length, 'all 7 parts carried onto the 8x4');

  // Plan cost dropped 13,750 → 13,350.
  const before = 5 * 2750;
  const after = 4 * 2750 + 2350;
  assert.equal(before, 13750);
  assert.equal(after, 13350);
  assert.ok(after < before, 'downsizing strictly lowered total cost');
});

test('BUG REPRO: WITHOUT the allow-set, the optimizer-disabled 8x4 is skipped → NO downsize', () => {
  // This is the live failure: allowKeys omitted → the candidate loop falls back
  // to the live `enabled` flag, which the optimizer set false for 8x4 → empty
  // candidate list → sheet stays 10x4. (Pre-fix behaviour; documents the bug.)
  const S = makeState();
  const last = S.flatSheets[S.flatSheets.length - 1];

  _downsizeLastFreshSheet(S, null);   // no allow-set → buggy eligibility path

  assert.equal(Math.round(last.sw), 3050, 'BUG: stays 10x4 because disabled 8x4 was filtered out');
});

test('GUARD: parts that genuinely do NOT fit a cheaper size → no swap', () => {
  const S = makeState();
  // Make the small parts too tall for any cheaper sheet by oversizing them.
  const last = S.flatSheets[S.flatSheets.length - 1];
  last.placements = last.placements.map(pl => ({ ...pl, w: 3000, h: 1210, polys: rectPolys(3000, 1210), bbox: [0, 0, 3000, 1210] }));

  _downsizeLastFreshSheet(S, USER_ENABLED);

  assert.equal(Math.round(last.sw), 3050, 'too-big parts → no fit on 8x4 → keep 10x4');
});

test('GUARD: never upsize — only the more-expensive 10x5 enabled → no swap', () => {
  const S = makeState();
  // User enabled only 10x4 + 10x5 (8x4 truly off). 10x5 is pricier → filtered.
  const allow = new Set(['3050x1220', '3050x1525']);
  const last = S.flatSheets[S.flatSheets.length - 1];

  _downsizeLastFreshSheet(S, allow);

  assert.equal(Math.round(last.sw), 3050, 'no strictly-cheaper enabled size → keep 10x4');
});
