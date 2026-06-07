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
