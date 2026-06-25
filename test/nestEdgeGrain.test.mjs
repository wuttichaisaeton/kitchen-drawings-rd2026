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

// ── PREVIEW rotation + edge-overlay angle mapping ───────────────────────
// เอ๋'s rule: grain in the single-part preview is ALWAYS horizontal, so the
// SHAPE rotates so the chosen edge becomes horizontal ('grain ให้ preview
// แนวนอนเท่านั้น ... รูปต้องหมุนตามด้วย'). These guard the preview-only math
// added in _drawPartPreview / _attachEdgeClickLayer (preview rotates shape by
// -grainAngle via _rotatePoly; overlay maps a rotated on-screen edge back to
// its ORIGINAL angle via origAngle = screenAngle + grainAngle). (2026-06-26)

// Faithful copy of the overlay's per-edge angle math.
function edgeAngleDeg(a, b) {        // on-screen [0,180) angle of a poly edge
  let ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
  return ((ang % 180) + 180) % 180;
}
function origAngleFromScreen(screenAng, angOffset) {   // overlay's stored value
  return (((screenAng + angOffset) % 180) + 180) % 180;
}
// Find the [0,180) angle of the longest outer edge (proxy for "an edge").
function edgeAnglesOf(outer) {
  const out = [];
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i], b = outer[(i + 1) % outer.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) continue;
    out.push(edgeAngleDeg(a, b));
  }
  return out;
}

test('preview rotation: clicking edge at original angle θ makes it horizontal', () => {
  // A right triangle: the hypotenuse runs at a non-trivial original angle.
  const part = {
    grain: 'EDGE',
    polys: { outer: [[0, 0], [600, 0], [0, 400], [0, 0]], holes: [], strokes: [] },
    bbox: [0, 0, 600, 400],
  };
  // Original angle of the hypotenuse (600,0)->(0,400).
  const thetaHyp = edgeAngleDeg([600, 0], [0, 400]);
  // User "clicks" that edge → grainAngle = thetaHyp.
  part.grainAngle = ((thetaHyp % 180) + 180) % 180;
  // Preview pre-rotates the SHAPE by -grainAngle (same _rotatePoly the engine
  // uses). The chosen edge must now be HORIZONTAL (screen angle ≈ 0/180).
  const rotOuter = _rotatePoly(part.polys.outer, part.grainAngle);
  const rotHyp = edgeAngleDeg(rotOuter[1], rotOuter[2]);   // (600,0)->(0,400) after rot
  const horiz = Math.min(rotHyp, 180 - rotHyp);            // distance to horizontal
  assert.ok(horiz < 0.001, `chosen edge horizontal after rotation (was ${rotHyp.toFixed(3)}°)`);
});

test('edge-overlay maps rotated on-screen angle back to ORIGINAL angle', () => {
  const outer = [[0, 0], [600, 0], [0, 400], [0, 0]];
  const grainAngle = edgeAngleDeg([600, 0], [0, 400]);   // pick the hypotenuse
  const rotOuter = _rotatePoly(outer, grainAngle);       // preview-rotated shape
  // For EVERY rotated edge: origAngle(screenAngle, +grainAngle) must equal the
  // edge's angle in the ORIGINAL (un-rotated) geometry.
  const origAngles = edgeAnglesOf(outer);
  const screenAngles = edgeAnglesOf(rotOuter);
  assert.equal(screenAngles.length, origAngles.length, 'same edge count');
  for (let i = 0; i < screenAngles.length; i++) {
    const mapped = origAngleFromScreen(screenAngles[i], grainAngle);
    const d = Math.min(
      Math.abs(mapped - origAngles[i]),
      180 - Math.abs(mapped - origAngles[i]));
    assert.ok(d < 0.001, `edge ${i}: mapped ${mapped.toFixed(2)} ≈ orig ${origAngles[i].toFixed(2)}`);
  }
});

test('re-clicking a different edge updates grainAngle consistently', () => {
  const outer = [[0, 0], [600, 0], [0, 400], [0, 0]];
  // 1st click: the hypotenuse → grain runs along it.
  const g1 = edgeAngleDeg([600, 0], [0, 400]);
  let rot1 = _rotatePoly(outer, g1);
  // The bottom edge (0,0)->(600,0) is now at some non-zero screen angle; the
  // hypotenuse is horizontal. Confirm exactly one edge is horizontal.
  const horizCount = (rotOuter) => edgeAnglesOf(rotOuter)
    .filter(a => Math.min(a, 180 - a) < 0.001).length;
  assert.equal(horizCount(rot1), 1, 'one horizontal edge after 1st click');
  // 2nd click: user picks the BOTTOM edge in the rotated view. Its on-screen
  // angle maps to its ORIGINAL angle (= 0) → new grainAngle.
  const botScreen = edgeAngleDeg(rot1[0], rot1[1]);          // bottom edge, rotated
  const g2 = origAngleFromScreen(botScreen, g1);             // overlay's stored value
  assert.ok(Math.min(Math.abs(g2 - 0), 180 - Math.abs(g2 - 0)) < 0.001,
    `2nd-click maps to original bottom-edge angle 0 (got ${g2.toFixed(3)})`);
  // Re-rotating by the NEW grainAngle makes the bottom edge horizontal.
  const rot2 = _rotatePoly(outer, g2);
  const botAfter = edgeAngleDeg(rot2[0], rot2[1]);
  assert.ok(Math.min(botAfter, 180 - botAfter) < 0.001,
    `bottom edge horizontal after re-click (was ${botAfter.toFixed(3)}°)`);
  // And the grain genuinely changed direction (g1 ≠ g2).
  assert.ok(Math.abs(g1 - g2) > 1, 'grainAngle changed between clicks');
});

// ── ROTATE-180 + MIRROR (per-part orientation) ──────────────────────────
// Faithful copies of the mirror helpers from nest.js (_mirrorPts /
// _mirrorEntities / _mirrorGeom) + the canonical transform-order facts the
// engine, preview and export all share. These guard:
//   • mirror twice = exact identity (reflect+reverse is an involution)
//   • flip180 twice = identity (placement rotation, mod 360)
//   • mirror reflects outer/holes/strokes AND entity coords (CIRCLE/ARC/LINE)
//   • mirror preserves bbox extents (w/h unchanged → packer footprint unchanged)
//   • mirror keeps polygon AREA positive (winding flips CW↔CCW but area magnitude
//     is preserved — _polyArea is winding-agnostic via Math.abs)
// (Rotate-180 + Mirror feature 2026-06-26)
function _mirrorPts(pts, axisSum) {
  if (!Array.isArray(pts)) return pts;
  return pts.map(p => [axisSum - p[0], p[1]]).reverse();
}
function _mirrorEntities(entities, axisSum) {
  if (!Array.isArray(entities)) return entities;
  const fx = x => axisSum - x;
  return entities.map(d => {
    if (!d) return d;
    const k = d.kind;
    if (k === 'CIRCLE') return { ...d, cx: fx(d.cx) };
    if (k === 'ARC')    return { ...d, cx: fx(d.cx), a0: Math.PI - d.a1, a1: Math.PI - d.a0 };
    if (k === 'LINE')   return { ...d, x0: fx(d.x0), x1: fx(d.x1) };
    if (k === 'LWPOLYLINE') return { ...d, verts: (d.verts || []).map(v => ({ x: fx(v.x), y: v.y, bulge: -(v.bulge || 0) })) };
    if (k === 'SPLINE') return { ...d,
      ctrl: (d.ctrl || []).map(p => ({ x: fx(p.x), y: p.y })),
      fit:  (d.fit  || []).map(p => ({ x: fx(p.x), y: p.y })) };
    // ELLIPSE: flip centre.x + major-axis X-component AND reverse the partial-
    // arc sweep (start↔end, negated) — lock-step with _entityToWcs's flip branch
    // (a0: -a1, a1: -a0). Matches the live nest.js fix. (partial-arc mirror 2026-06-26)
    if (k === 'ELLIPSE') return { ...d, cx: fx(d.cx), mx: -d.mx, a0: -d.a1, a1: -d.a0 };
    return d;
  });
}
function _mirrorGeom(g) {
  if (!g || !g.bbox) return g;
  const [minX, , maxX] = g.bbox;
  const axisSum = minX + maxX;
  const src = g.polys || {};
  return {
    polys: {
      outer: _mirrorPts(src.outer || [], axisSum),
      holes: (src.holes || []).map(h => _mirrorPts(h, axisSum)),
      strokes: (src.strokes || []).map(s => _mirrorPts(s, axisSum)),
      entities: _mirrorEntities(src.entities || [], axisSum),
    },
    bbox: g.bbox.slice(),
    w: g.w, h: g.h,
  };
}
function _polyAreaSigned(pts) {   // SIGNED shoelace (sign = winding)
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}
function geomOf() {
  // An L-ish concave part with a hole + a couple of true entities.
  return {
    polys: {
      outer: [[0, 0], [600, 0], [600, 200], [300, 200], [300, 400], [0, 400], [0, 0]],
      holes: [[[50, 50], [120, 50], [120, 120], [50, 120], [50, 50]]],
      strokes: [],
      entities: [
        { kind: 'CIRCLE', cx: 500, cy: 100, r: 20 },
        { kind: 'LINE', x0: 10, y0: 10, x1: 590, y1: 10 },
        { kind: 'ARC', cx: 400, cy: 300, r: 30, a0: 0, a1: Math.PI / 2 },
      ],
    },
    bbox: [0, 0, 600, 400], w: 600, h: 400,
  };
}

test('mirror twice = exact identity (outer/holes coords restored)', () => {
  const g = geomOf();
  const once = _mirrorGeom(g);
  const twice = _mirrorGeom(once);
  for (let i = 0; i < g.polys.outer.length; i++) {
    assert.ok(Math.abs(twice.polys.outer[i][0] - g.polys.outer[i][0]) < 1e-9, `outer[${i}].x restored`);
    assert.ok(Math.abs(twice.polys.outer[i][1] - g.polys.outer[i][1]) < 1e-9, `outer[${i}].y restored`);
  }
  for (let i = 0; i < g.polys.holes[0].length; i++) {
    assert.ok(Math.abs(twice.polys.holes[0][i][0] - g.polys.holes[0][i][0]) < 1e-9, `hole[${i}].x restored`);
  }
});

test('mirror twice = identity for entities (CIRCLE/LINE/ARC)', () => {
  const g = geomOf();
  const twice = _mirrorGeom(_mirrorGeom(g));
  const e0 = g.polys.entities, e2 = twice.polys.entities;
  assert.ok(Math.abs(e2[0].cx - e0[0].cx) < 1e-9, 'CIRCLE cx restored');
  assert.ok(Math.abs(e2[1].x0 - e0[1].x0) < 1e-9 && Math.abs(e2[1].x1 - e0[1].x1) < 1e-9, 'LINE x restored');
  // ARC: a0/a1 are remapped to π−a1 / π−a0 each pass; two passes restore the sweep.
  const norm = a => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  assert.ok(Math.abs(norm(e2[2].a0) - norm(e0[2].a0)) < 1e-9, 'ARC a0 restored');
  assert.ok(Math.abs(norm(e2[2].a1) - norm(e0[2].a1)) < 1e-9, 'ARC a1 restored');
  assert.ok(Math.abs(e2[2].cx - e0[2].cx) < 1e-9, 'ARC cx restored');
});

test('mirror reflects coords across the bbox vertical centre', () => {
  const g = geomOf();
  const m = _mirrorGeom(g);
  const axisSum = g.bbox[0] + g.bbox[2];   // 600
  // Every outer point's x must be axisSum − origX (order reversed, so match by set).
  const origXs = g.polys.outer.map(p => p[0]).sort((a, b) => a - b);
  const mirXs = m.polys.outer.map(p => axisSum - p[0]).sort((a, b) => a - b);
  for (let i = 0; i < origXs.length; i++) {
    assert.ok(Math.abs(mirXs[i] - origXs[i]) < 1e-9, 'reflected x set matches original');
  }
  // A CIRCLE at cx=500 reflects to 600−500 = 100.
  assert.ok(Math.abs(m.polys.entities[0].cx - 100) < 1e-9, 'CIRCLE cx reflected to 100');
});

test('mirror preserves bbox extents → packer footprint (w/h) unchanged', () => {
  const g = geomOf();
  const m = _mirrorGeom(g);
  assert.deepEqual(m.bbox, g.bbox, 'bbox unchanged by reflection-about-centre');
  assert.equal(m.w, g.w, 'w unchanged');
  assert.equal(m.h, g.h, 'h unchanged');
});

test('mirror flips winding but preserves area magnitude (DXF stays valid)', () => {
  const g = geomOf();
  const m = _mirrorGeom(g);
  const a0 = _polyAreaSigned(g.polys.outer);
  const a1 = _polyAreaSigned(m.polys.outer);
  assert.ok(Math.abs(Math.abs(a0) - Math.abs(a1)) < 1e-6, 'area magnitude preserved');
  assert.ok(Math.sign(a0) !== 0 && Math.abs(a1) > 0, 'non-degenerate area both ways');
});

test('flip180 twice = identity (placement rotation, mod 360)', () => {
  const flip = r => (((r || 0) + 180) % 360 + 360) % 360;
  for (const r of [0, 90, 180, 270]) {
    assert.equal(flip(flip(r)), r, `flip180 twice on rot ${r} = identity`);
    assert.ok([0, 90, 180, 270].includes(flip(r)), `flip180(${r}) stays an exact quarter-turn`);
  }
  assert.equal(flip(0), 180, '0→180');
  assert.equal(flip(90), 270, '90→270');
});

test('canonical order: EDGE pre-rotate THEN mirror keeps grain horizontal', () => {
  // An EDGE part pre-rotated to horizontal, then mirrored: the (now horizontal)
  // chosen edge must STAY horizontal after a left-right flip (grain semantics).
  const part = {
    grain: 'EDGE',
    polys: { outer: [[0, 0], [600, 0], [0, 400], [0, 0]], holes: [], strokes: [] },
    bbox: [0, 0, 600, 400],
  };
  part.grainAngle = edgeAngleDeg([600, 0], [0, 400]);   // the hypotenuse
  const edge = _edgeRotatedGeom(part);
  // Build a bundle for the mirror helper (it needs polys + bbox).
  const rotOuter = _rotatePoly(part.polys.outer, part.grainAngle);
  const bundle = { polys: { outer: rotOuter, holes: [], strokes: [], entities: [] }, bbox: edge.bbox, w: edge.w, h: edge.h };
  const mir = _mirrorGeom(bundle);
  // The chosen edge was rotOuter[1]->rotOuter[2] (now horizontal). After mirror
  // + reverse, it maps to some pair; assert SOME edge is still horizontal.
  const horiz = edgeAnglesOf(mir.polys.outer).filter(a => Math.min(a, 180 - a) < 0.01).length;
  assert.ok(horiz >= 1, 'a horizontal edge survives the mirror (grain stays horizontal)');
});

// ── BASELINE PACK-DIMS REGRESSION (native non-EDGE non-mirror part) ──────
// Faithful copy of nest.js's _orientedGeom (native branch) + the pack-dims
// decision in _runNesting. BEFORE the Rotate/Mirror feature, the pack loop fed
// the packer the INTEGER-rounded p.w/p.h. AFTER, _orientedGeom returns a
// 2-decimal geom.w (Math.round(extent*100)/100, e.g. 599.65 vs 600) which —
// if blindly adopted — drifts the packer footprint sub-mm and can alter daily
// nesting layouts. The fix: only adopt geom dims when EDGE or mirror is active;
// otherwise fall back to p.w/p.h exactly. These guard that the NATIVE case is
// byte-identical to the pre-feature integer dims. (regression fix 2026-06-26)
function _orientedGeomNative(p) {
  // mirrors nest.js _orientedGeom for the no-EDGE branch (native bundle).
  const [minX, minY, maxX, maxY] = p.bbox;
  return { polys: p.polys, bbox: p.bbox.slice(),
           w: Math.round((maxX - minX) * 100) / 100,
           h: Math.round((maxY - minY) * 100) / 100 };
}
function packDims(p) {
  // mirrors nest.js _runNesting: isEdge=false here (native), so geom is the
  // native bundle and _geomActive = (isEdge || p.mirror) && geom.
  const isEdge = false;
  const geom = _orientedGeomNative(p);
  const _geomActive = (isEdge || p.mirror) && geom;
  const useW = (_geomActive && geom.w > 0) ? geom.w : p.w;
  const useH = (_geomActive && geom.h > 0) ? geom.h : p.h;
  return { useW, useH };
}

test('native non-EDGE non-mirror part: packer dims = integer p.w/p.h (pre-feature)', () => {
  // p.w/p.h are the integer-rounded BOM dims (Math.round of the bbox extent),
  // but the bbox itself carries sub-mm float extents (599.65 / 399.4).
  const p = {
    code: 'NATIVE-1', grain: 'H', mirror: false, flip180: false,
    w: 600, h: 399,                         // integer-rounded dims (the daily-relied-on values)
    bbox: [0, 0, 599.65, 399.4],            // float extents from the DXF parse
    polys: { outer: [[0, 0], [599.65, 0], [599.65, 399.4], [0, 399.4]], holes: [], strokes: [], entities: [] },
  };
  const { useW, useH } = packDims(p);
  assert.equal(useW, 600, 'packer width = integer p.w (NOT geom.w 599.65)');
  assert.equal(useH, 399, 'packer height = integer p.h (NOT geom.h 399.4)');
  // And prove the regression would have fired without the guard:
  const geom = _orientedGeomNative(p);
  assert.equal(geom.w, 599.65, 'geom.w is the 2-decimal value the old buggy path used');
  assert.notEqual(geom.w, p.w, 'geom.w differs from integer p.w → must NOT win for native parts');
});

test('mirror-active part DOES adopt oriented geom dims (feature still works)', () => {
  const p = {
    code: 'MIR-1', grain: 'H', mirror: true, flip180: false,
    w: 600, h: 399,
    bbox: [0, 0, 599.65, 399.4],
    polys: { outer: [[0, 0], [599.65, 0], [599.65, 399.4], [0, 399.4]], holes: [], strokes: [], entities: [] },
  };
  const { useW, useH } = packDims(p);
  assert.equal(useW, 599.65, 'mirror active → geom.w wins');
  assert.equal(useH, 399.4, 'mirror active → geom.h wins');
});

// ── PARTIAL-ARC ELLIPSE MIRROR SWEEP REVERSAL ───────────────────────────
// A PARTIAL elliptical arc must reverse its sweep (a0/a1 swap+negate) under a
// mirror, exactly like _entityToWcs's flip branch (a0: -end, a1: -start).
// Without it, the wrong swept portion renders after a mirror. A full ellipse is
// unaffected; double-mirror must restore the original sweep. (partial-arc 2026-06-26)
test('partial elliptical arc: mirror reverses the sweep (a0/a1 swap+negate)', () => {
  const axisSum = 600;
  const s = Math.PI / 6, en = 2 * Math.PI / 3;     // a 30°→120° partial arc
  const ell = { kind: 'ELLIPSE', cx: 300, cy: 100, mx: 80, my: 0, ratio: 0.5, a0: s, a1: en };
  const m = _mirrorEntities([ell], axisSum)[0];
  // Matches _entityToWcs flip: a0 → -a1, a1 → -a0.
  assert.ok(Math.abs(m.a0 - (-en)) < 1e-12, 'mirrored a0 = -a1 (sweep reversed)');
  assert.ok(Math.abs(m.a1 - (-s))  < 1e-12, 'mirrored a1 = -a0 (sweep reversed)');
  assert.ok(Math.abs(m.cx - (axisSum - 300)) < 1e-12, 'centre x reflected');
  assert.ok(Math.abs(m.mx - (-80)) < 1e-12, 'major-axis X-component flipped');
});

test('partial elliptical arc: double mirror restores the sweep', () => {
  const axisSum = 600;
  const ell = { kind: 'ELLIPSE', cx: 300, cy: 100, mx: 80, my: 0, ratio: 0.5, a0: Math.PI / 6, a1: 2 * Math.PI / 3 };
  const twice = _mirrorEntities(_mirrorEntities([ell], axisSum), axisSum)[0];
  assert.ok(Math.abs(twice.a0 - ell.a0) < 1e-12, 'a0 restored after double mirror');
  assert.ok(Math.abs(twice.a1 - ell.a1) < 1e-12, 'a1 restored after double mirror');
  assert.ok(Math.abs(twice.cx - ell.cx) < 1e-12, 'cx restored');
  assert.ok(Math.abs(twice.mx - ell.mx) < 1e-12, 'mx restored');
});

// ── TOGGLE TAKES EFFECT IMMEDIATELY (the live-flag + repaint fix) ────────
// The previous bug: clicking Mirror/Rotate-180 toggled the button's CSS class
// but the LIVE part object's flag stayed false and the preview never repainted
// until a full reload (the handler awaited an RTDB-gated save before applying).
// These tests load the REAL nest.js (via a tiny DOM/localStorage shim) and call
// the REAL _applyOrientFlag + _orientedGeom — NOT copies — to prove that:
//   • the toggle mutates the live part object's flag (and the rows array),
//   • _orientedGeom(part) then returns MIRRORED geometry (centroid x reflected
//     across the bbox centre),
//   • toggling twice returns the flag AND the geometry to the original,
//   • flip180 toggles the flag on the same object (it's a placement rotation,
//     so geometry is unchanged by design — guarded separately above).
// (Rotate-180 + Mirror toggle-immediately fix 2026-06-26)
async function loadRealNest() {
  // Minimal shim so nest.js's IIFE (which touches window/document/localStorage
  // at module-eval time) runs under Node. We only need the pure _test helpers.
  const store = new Map();
  const win = {
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    addEventListener() {}, removeEventListener() {},
    devicePixelRatio: 1, CSS: { escape: s => s },
    requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {},
  };
  win.window = win;
  const doc = { createElement: () => ({ style: {}, getContext: () => ({}) }),
                getElementById: () => null, addEventListener() {}, querySelector: () => null };
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'nest.js'), 'utf8');
  // Run nest.js's IIFE with window/document/localStorage/etc. supplied as
  // FUNCTION PARAMETERS — the source resolves these as free vars, so they bind
  // to our shim, not Node globals (no need to mutate globalThis at all).
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'localStorage', 'CSS', 'requestAnimationFrame',
               'setTimeout', 'clearTimeout', 'devicePixelRatio', 'navigator', src)
    (win, doc, win.localStorage, win.CSS, win.requestAnimationFrame,
     win.setTimeout, win.clearTimeout, win.devicePixelRatio, { userAgent: 'node' });
  return win.kdNest._test;
}
function centroidX(outer) {
  let sx = 0; for (const p of outer) sx += p[0]; return sx / outer.length;
}
function rectPart(code) {
  // An asymmetric part so a mirror is detectable: weight skewed to the right.
  return {
    code, grain: 'H', mirror: false, flip180: false,
    w: 600, h: 400, bbox: [0, 0, 600, 400],
    polys: {
      outer: [[0, 0], [600, 0], [600, 400], [400, 400], [400, 200], [0, 200], [0, 0]],
      holes: [], strokes: [], entities: [{ kind: 'CIRCLE', cx: 500, cy: 100, r: 20 }],
    },
  };
}

test('REAL toggle: mirror flag flips on the live part + geom reflects', async () => {
  const T = await loadRealNest();
  assert.equal(typeof T.applyOrientFlag, 'function', 'real _applyOrientFlag exposed');
  assert.equal(typeof T.orientedGeom, 'function', 'real _orientedGeom exposed');
  const part = rectPart('MIRTOG-1');
  const rows = [];
  const before = centroidX(T.orientedGeom(part).polys.outer);
  // toggle ON (what the click handler does to the LIVE object + rows array)
  T.applyOrientFlag(part, 'mirror', true, rows);
  assert.equal(part.mirror, true, 'live part.mirror set true by the toggle');
  assert.equal(rows.length, 1, 'a MIRROR row persisted');
  assert.equal(String(rows[0].grain).toUpperCase(), 'MIRROR', 'row tagged MIRROR');
  const after = centroidX(T.orientedGeom(part).polys.outer);
  const axisCentre = (part.bbox[0] + part.bbox[2]) / 2;   // 300
  // The centroid x must reflect across the bbox centre (before+after ≈ 2·centre).
  assert.ok(Math.abs((before + after) - 2 * axisCentre) < 1e-6,
    `centroid x mirrored across centre (before ${before.toFixed(2)} + after ${after.toFixed(2)} ≈ ${2 * axisCentre})`);
  assert.ok(Math.abs(before - after) > 1, 'geometry actually moved (asymmetric part)');
});

test('REAL toggle twice: mirror returns flag + geometry to original', async () => {
  const T = await loadRealNest();
  const part = rectPart('MIRTOG-2');
  const rows = [];
  const orig = T.orientedGeom(part).polys.outer.map(p => p.slice());
  T.applyOrientFlag(part, 'mirror', true, rows);
  T.applyOrientFlag(part, 'mirror', false, rows);   // second click toggles off
  assert.equal(part.mirror, false, 'flag back to false after two toggles');
  assert.equal(rows.length, 0, 'MIRROR row removed on toggle-off (in place)');
  const back = T.orientedGeom(part).polys.outer;
  for (let i = 0; i < orig.length; i++) {
    assert.ok(Math.abs(back[i][0] - orig[i][0]) < 1e-9 && Math.abs(back[i][1] - orig[i][1]) < 1e-9,
      `outer[${i}] restored after double toggle`);
  }
});

test('REAL toggle: flip180 flips the live flag (placement-rotation, geom intact)', async () => {
  const T = await loadRealNest();
  const part = rectPart('FLIPTOG-1');
  const rows = [];
  T.applyOrientFlag(part, 'flip180', true, rows);
  assert.equal(part.flip180, true, 'live part.flip180 set true');
  assert.equal(String(rows[0].grain).toUpperCase(), 'FLIP180', 'FLIP180 row persisted');
  // flip180 is NOT applied in _orientedGeom (it's a placement +180 after packing),
  // so the oriented geometry is unchanged — only the flag carries the intent.
  const g = T.orientedGeom(part);
  assert.ok(g && g.polys && g.polys.outer.length, 'oriented geom still valid with flip180 set');
  T.applyOrientFlag(part, 'flip180', false, rows);
  assert.equal(part.flip180, false, 'flag back to false');
  assert.equal(rows.length, 0, 'FLIP180 row removed on toggle-off');
});
