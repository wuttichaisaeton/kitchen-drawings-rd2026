// Regression test for the EDGE (angled) grain nesting path in nest.js.
//
// nest.js is a browser IIFE (not importable), so this test carries FAITHFUL
// copies of the EDGE geometry helpers + the SkylinePacker/raster pack loops
// and the defensive loop cap. It guards two things the live regression cared
// about:
//   1. _edgeRotatedGeom produces a FINITE, sane (positive) bbox + w/h for an
//      EDGE part at any angle (degrees → radians done right; no NaN).
//   2. The packing `while (remaining.length)` loop TERMINATES — both for a real
//      EDGE piece AND for a pathological piece that never shrinks `remaining`
//      (the loop-cap guard must bail to `unplaced` rather than hang the UI).
//
// Live end-to-end verification (real TOPTRI-000000.dxf across all 8 modes) was
// done in the browser preview; this file is the fast CI guard. (2026-06-25)
import { test } from 'node:test';
import assert from 'node:assert';

// ── verbatim copies from nest.js ───────────────────────────────────────
function _rotatePoly(pts, angleDeg) {
  if (!Array.isArray(pts)) return pts;
  const rad = -angleDeg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return pts.map(p => [p[0] * cos - p[1] * sin, p[0] * sin + p[1] * cos]);
}
function _rotateBbox(bbox, angleDeg, newPts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of (newPts || [])) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  if (!isFinite(minX)) {
    const [x0, y0, x1, y1] = bbox || [0, 0, 0, 0];
    return _rotateBbox(null, 0, _rotatePoly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], angleDeg));
  }
  return [minX, minY, maxX, maxY];
}
function _edgeRotatedGeom(p) {
  const a = p.grainAngle;
  const src = p.polys || {};
  const newOuter = _rotatePoly(src.outer || [], a);
  const newHoles = (src.holes || []).map(h => _rotatePoly(h, a));
  const newStrokes = (src.strokes || []).map(s => _rotatePoly(s, a));
  const allPts = [].concat(newOuter, ...newHoles, ...newStrokes);
  const newBbox = _rotateBbox(p.bbox, a, allPts);
  return {
    bbox: newBbox,
    w: Math.round((newBbox[2] - newBbox[0]) * 100) / 100,
    h: Math.round((newBbox[3] - newBbox[1]) * 100) / 100,
  };
}
function _packLoopCap(pieceCount) { return Math.max(1000, (Number(pieceCount) || 0) * 4 + 1000); }

class SkylinePacker {
  constructor(W, H) { this.W = W; this.H = H; this.skyline = [{ x: 0, y: 0, w: W }]; }
  place(w, h) {
    let best = null;
    for (let i = 0; i < this.skyline.length; i++) {
      let maxY = this.skyline[i].y, accum = 0, j = i;
      while (accum < w && j < this.skyline.length) { if (this.skyline[j].y > maxY) maxY = this.skyline[j].y; accum += this.skyline[j].w; j++; }
      if (accum < w) continue;
      if (maxY + h > this.H) continue;
      const x = this.skyline[i].x;
      if (best === null || maxY < best.y || (maxY === best.y && x < best.x)) best = { x, y: maxY, i };
    }
    if (!best) return null;
    this._update(best.i, best.x, best.y, w, h);
    return [best.x, best.y];
  }
  _update(idx, x, y, w, h) {
    const newSeg = { x, y: y + h, w };
    const next = [];
    for (let i = 0; i < this.skyline.length; i++) {
      if (i < idx) { next.push(this.skyline[i]); continue; }
      const s = this.skyline[i];
      if (s.x + s.w <= x) { next.push(s); continue; }
      if (s.x >= x + w) { next.push(s); continue; }
      if (s.x < x) next.push({ x: s.x, y: s.y, w: x - s.x });
      if (s.x + s.w > x + w) next.push({ x: x + w, y: s.y, w: s.x + s.w - (x + w) });
    }
    next.push(newSeg); next.sort((a, b) => a.x - b.x);
    const merged = [];
    for (const s of next) {
      const last = merged[merged.length - 1];
      if (last && last.y === s.y && last.x + last.w === s.x) last.w += s.w; else merged.push({ ...s });
    }
    this.skyline = merged;
  }
}
// Faithful copy of nest.js runOne (Skyline branch) WITH the loop-cap guard.
function packWithGuard(pieces, stock, gap) {
  const sorted = pieces.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h));
  const stockCopy = stock.map(s => ({ ...s }));
  const sheets = [];
  let remaining = sorted.slice();
  let guard = _packLoopCap(remaining.length);
  let bailed = false;
  while (remaining.length) {
    if (--guard < 0) { bailed = true; break; }
    let placedAny = false;
    for (let si = 0; si < stockCopy.length; si++) {
      const s = stockCopy[si];
      if (s.qty === 0) continue;
      const packer = new SkylinePacker(s.w, s.h);
      const placed = [], stillLeft = [];
      for (const piece of remaining) {
        let was = false;
        for (const rot of piece.rots) {
          const rw = (rot === 90 || rot === 270) ? piece.h + gap : piece.w + gap;
          const rh = (rot === 90 || rot === 270) ? piece.w + gap : piece.h + gap;
          if (packer.place(rw, rh)) { placed.push(piece); was = true; break; }
        }
        if (!was) stillLeft.push(piece);
      }
      if (placed.length) { sheets.push({ placements: placed }); if (s.qty > 0) s.qty -= 1; remaining = stillLeft; placedAny = true; break; }
    }
    if (!placedAny) break;
  }
  return { sheets, unplaced: remaining, bailed };
}

function edgePiece(angleDeg) {
  const part = {
    grain: 'EDGE', grainAngle: angleDeg,
    polys: { outer: [[0, 0], [600, 0], [0, 400], [0, 0]], holes: [], strokes: [] },
    bbox: [0, 0, 600, 400],
  };
  const e = _edgeRotatedGeom(part);
  return { code: 'TRI-EDGE', w: e.w, h: e.h, rots: [0, 180], _edge: e };
}

// ── tests ──────────────────────────────────────────────────────────────
for (const angle of [0, 45, 90, 135, 135.00000170010264, 179]) {
  test(`_edgeRotatedGeom(${angle}) → finite, positive bbox + w/h`, () => {
    const p = edgePiece(angle);
    assert.ok(p._edge.bbox.every(Number.isFinite), 'bbox finite');
    assert.ok(Number.isFinite(p.w) && Number.isFinite(p.h), 'w/h finite');
    assert.ok(p.w > 0 && p.h > 0, 'w/h positive');
    // diagonal of a 600x400 box ≈ 721 — neither dim should exceed that.
    assert.ok(p.w <= 722 && p.h <= 722, 'w/h within rotated-diagonal bound');
  });
}

test('EDGE piece nests on a sheet and the pack loop terminates', () => {
  const p = edgePiece(135);
  const r = packWithGuard([{ ...p, qty: 1 }], [{ w: 1525, h: 3050, qty: -1 }], 5);
  assert.equal(r.unplaced.length, 0, 'EDGE piece placed');
  assert.equal(r.bailed, false, 'no loop-cap bail on a healthy run');
  assert.equal(r.sheets.length, 1);
});

test('EDGE piece larger than the sheet → unplaced, NOT an infinite loop', () => {
  // a long part rotated so its diagonal exceeds the sheet in both axes
  const part = {
    grain: 'EDGE', grainAngle: 45,
    polys: { outer: [[0, 0], [4000, 0], [0, 3000], [0, 0]], holes: [], strokes: [] },
    bbox: [0, 0, 4000, 3000],
  };
  const e = _edgeRotatedGeom(part);
  const piece = { code: 'BIG', w: e.w, h: e.h, rots: [0, 180], qty: 1 };
  const r = packWithGuard([piece], [{ w: 1525, h: 3050, qty: -1 }], 5);
  assert.equal(r.unplaced.length, 1, 'oversize EDGE piece is unplaced');
  assert.equal(r.bailed, false, 'terminates via !placedAny, not the cap');
});

test('loop-cap guard bails a pathological non-shrinking loop instead of hanging', () => {
  // Model a regression where a pass reports progress but `remaining` never
  // shrinks. The cap MUST stop it. We assert it bails within the cap bound.
  let remaining = [{ code: 'STUCK' }];
  let guard = _packLoopCap(remaining.length);
  let iters = 0, bailed = false;
  while (remaining.length) {
    if (--guard < 0) { bailed = true; break; }
    iters++;
    // no shrink — the bug
  }
  assert.equal(bailed, true, 'cap stopped the loop');
  assert.ok(iters <= _packLoopCap(1), `bailed within cap (${iters})`);
});
