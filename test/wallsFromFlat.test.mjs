// Tests for KD_DXFFLAT.wallsFromFlat — the DXF→box_geom-wall model that drives the rebuilt
// 2-D press (เอ๋ 2026-06-08 "DXF ล้วน + เดา step เอง"). Fusion's box_geom mis-derives CVIL, so the
// 2-D press reads real flanges from the flat DXF instead. See dxfFlat.js wallsFromFlat().
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const KD = require('../dxfFlat.js');
const __dirname = dirname(fileURLToPath(import.meta.url));
const DXF = readFileSync(join(__dirname, 'fixtures/CVIL00-205093.dxf'), 'utf8');

function wf() { return KD.wallsFromFlat(KD.parseFlatDxf(DXF)); }

test('wallsFromFlat: is exported and returns a model', () => {
  assert.equal(typeof KD.wallsFromFlat, 'function');
  const m = wf();
  assert.ok(m && Array.isArray(m.walls), 'returns {walls,...}');
});

test('wallsFromFlat: base is the REAL tray panel (~2048 x 928), not Fusion box_geom 21.76', () => {
  const m = wf();
  assert.ok(m.base.w > 2000 && m.base.w < 2070, `base.w ~2048, got ${m.base.w}`);
  assert.ok(m.base.h > 900 && m.base.h < 950, `base.h ~928 (NOT 21.76), got ${m.base.h}`);
  assert.ok(Math.abs(m.flat_w - 2076.524) < 1, `flat_w ~2076, got ${m.flat_w}`);
  assert.ok(Math.abs(m.flat_h - 976.548) < 1, `flat_h ~976, got ${m.flat_h}`);
});

test('wallsFromFlat: derives 6 full-span flanges (tabs skipped)', () => {
  const m = wf();
  assert.equal(m.walls.length, 6, `6 walls, got ${m.walls.length}`);
  // 4 on axis Y (front + the 3-stack hem back), 2 on axis X (left/right side returns)
  assert.equal(m.walls.filter(w => w.axis === 'Y').length, 4, 'four Y-axis walls');
  assert.equal(m.walls.filter(w => w.axis === 'X').length, 2, 'two X-axis walls');
});

test('wallsFromFlat: base+walls reconstruct the flat extent on each axis', () => {
  const m = wf();
  const devY = m.walls.filter(w => w.axis === 'Y').reduce((s, w) => s + w.height, 0);
  const devX = m.walls.filter(w => w.axis === 'X').reduce((s, w) => s + w.height, 0);
  assert.ok(Math.abs(m.base.h + devY - m.flat_h) < 0.5, `base.h + Y walls ≈ flat_h (${m.base.h}+${devY} vs ${m.flat_h})`);
  assert.ok(Math.abs(m.base.w + devX - m.flat_w) < 0.5, `base.w + X walls ≈ flat_w (${m.base.w}+${devX} vs ${m.flat_w})`);
});

test('wallsFromFlat: the +Y hem is a 3-wall stack with correct seq (wall→return→lip)', () => {
  const m = wf();
  const back = m.walls.filter(w => w.axis === 'Y' && w.side === '+').sort((a, b) => a.seq - b.seq);
  assert.equal(back.length, 3, 'three stacked +Y walls (flange/return/lip)');
  // seq 0 = innermost (nearest base) is the tallest flange; the lip is outermost (highest seq)
  assert.ok(back[0].height > back[2].height, `inner flange (${back[0].height}) taller than the lip (${back[2].height})`);
  assert.deepEqual(back.map(w => w.seq), [0, 1, 2], 'seq runs 0..2 from base outward');
});

test('wallsFromFlat: gooseneck only on inner stacked walls; standalone + outermost = sash', () => {
  const m = wf();
  m.walls.forEach(w => {
    const maxSeq = Math.max(...m.walls.filter(o => o.axis === w.axis && o.side === w.side).map(o => o.seq));
    const expectGoose = w.seq < maxSeq;          // inner of a stack ⇒ must clear an outer formed wall
    assert.equal(w.needs_gooseneck, expectGoose, `${w.id} (seq ${w.seq}/${maxSeq}) goose=${w.needs_gooseneck}`);
    assert.equal(w.punch_type, expectGoose ? 'gooseneck' : 'sash');
  });
  // the two standalone side returns + the front flange are all sash
  assert.equal(m.walls.filter(w => !w.needs_gooseneck).length, 4, 'four sash walls');
  assert.equal(m.walls.filter(w => w.needs_gooseneck).length, 2, 'two gooseneck (inner top stack) walls');
});

test('wallsFromFlat: steps are 1..N unique, outer-first (stacks fold lip→wall)', () => {
  const m = wf();
  const steps = m.walls.map(w => w.step).sort((a, b) => a - b);
  assert.deepEqual(steps, [1, 2, 3, 4, 5, 6], 'steps 1..6 contiguous');
  // within the +Y stack, the OUTERMOST (lip, highest seq) folds FIRST (lowest step)
  const back = m.walls.filter(w => w.axis === 'Y' && w.side === '+');
  const lip = back.find(w => w.seq === 2), innerWall = back.find(w => w.seq === 0);
  assert.ok(lip.step < innerWall.step, `lip folds before the inner wall (${lip.step} < ${innerWall.step})`);
  // every wall carries the fields mount2d needs
  m.walls.forEach(w => {
    ['id', 'axis', 'side', 'height', 'step', 'seq', 'flat_len', 'angle_deg', 'v_mm'].forEach(k =>
      assert.ok(w[k] != null, `${w.id} has ${k}`));
    assert.equal(w.flat_len, w.height, 'flat_len mirrors height so _featLen draws real length');
  });
});

test('wallsFromFlat: per_bend mirrors walls by step (drives punchForStep + v_mm)', () => {
  const m = wf();
  assert.equal(m.per_bend.length, m.walls.length);
  m.walls.forEach(w => {
    const pb = m.per_bend.find(b => b.step === w.step);
    assert.ok(pb, `per_bend has step ${w.step}`);
    assert.equal(pb.needs_gooseneck, w.needs_gooseneck);
    assert.equal(pb.punch_type, w.punch_type);
    assert.ok(pb.v_mm > 0, 'die opening set');
  });
});

test('wallsFromFlat: null-safe on empty / bend-less input', () => {
  assert.equal(KD.wallsFromFlat(null), null);
  assert.equal(KD.wallsFromFlat({ bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10, w: 10, h: 10 }, bends: [] }), null);
});

test('wallsFromFlat: every wall carries its inner fold-line coordinate (foldCoord)', () => {
  const m = wf();
  m.walls.forEach(w => assert.ok(Number.isFinite(w.foldCoord), `${w.id} has a numeric foldCoord`));
  // the +Y stack fold lines step inward→outward: wall(seq0) nearest base has the LOWEST foldCoord
  const back = m.walls.filter(w => w.axis === 'Y' && w.side === '+').sort((a, b) => a.seq - b.seq);
  assert.ok(back[0].foldCoord < back[1].foldCoord && back[1].foldCoord < back[2].foldCoord,
    `+Y foldCoords grow outward: ${back.map(w => w.foldCoord)}`);
});

// ── foldBendsFromFlat: the 3-D fold order (shares the 2-D heuristic, no box_geom) ──
function fb() { return KD.foldBendsFromFlat(KD.parseFlatDxf(DXF)); }

test('foldBendsFromFlat: returns one entry per flat bend, foldFlat-shaped', () => {
  const flat = KD.parseFlatDxf(DXF);
  const bends = KD.foldBendsFromFlat(flat);
  assert.equal(bends.length, flat.bends.length, 'one per DXF bend');
  bends.forEach(b => {
    ['a', 'b', 'dir', 'len', 'mid', 'step'].forEach(k => assert.ok(b[k] != null, `bend has ${k}`));
  });
});

test('foldBendsFromFlat: full-span bends get clean steps 1..6, tabs get 0', () => {
  const bends = fb();
  const stepped = bends.filter(b => b.step > 0).map(b => b.step).sort((a, b) => a - b);
  assert.deepEqual(stepped, [1, 2, 3, 4, 5, 6], `six full-span flanges get steps 1..6, got ${stepped}`);
  // the 7 short ~23mm tabs are NOT in the press sequence (step 0, never a hinge)
  const tabs = bends.filter(b => b.dir === 'H' && b.len > 18 && b.len < 30);
  assert.equal(tabs.length, 7, 'seven tabs present');
  tabs.forEach(t => assert.equal(t.step, 0, 'tab is step 0'));
  assert.equal(Math.max(...bends.map(b => b.step || 0)), 6, 'maxStep is 6 (not inflated by tabs)');
});

test('foldBendsFromFlat: each step maps to exactly one full-span bend (unique active per step)', () => {
  const bends = fb();
  for (let s = 1; s <= 6; s++) {
    assert.equal(bends.filter(b => b.step === s).length, 1, `exactly one bend at step ${s}`);
  }
});

test('foldBendsFromFlat: matches the 2-D walls — same id per step (one story)', () => {
  const flat = KD.parseFlatDxf(DXF);
  const walls = KD.wallsFromFlat(flat).walls;
  const bends = KD.foldBendsFromFlat(flat);
  for (let s = 1; s <= 6; s++) {
    const w = walls.find(x => x.step === s), b = bends.find(x => x.step === s);
    assert.equal(b.id, w.id, `step ${s}: 3-D bend id ${b.id} == 2-D wall id ${w.id}`);
  }
});

test('foldBendsFromFlat: null-safe', () => {
  assert.equal(KD.foldBendsFromFlat(null), null);
});
