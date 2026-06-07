import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const KD = require('../dxfFlat.js');
const __dirname = dirname(fileURLToPath(import.meta.url));
export const DXF = readFileSync(join(__dirname, 'fixtures/CVIL00-205093.dxf'), 'utf8');

test('harness: module loads and exposes the API', () => {
  assert.equal(typeof KD.parseFlatDxf, 'function');
  assert.equal(typeof KD.mergeBends, 'function');
  assert.equal(typeof KD.foldFlat, 'function');
  assert.ok(DXF.includes('OUTER_PROFILES'), 'fixture has the OUTER_PROFILES layer');
});

test('parseFlatDxf: returns a bbox covering the ~2076 x 976 flat', () => {
  const m = KD.parseFlatDxf(DXF);
  assert.ok(m, 'returns a model');
  assert.ok(m.bbox.w > 2000 && m.bbox.w < 2120, `width ~2076, got ${m.bbox.w}`);
  assert.ok(m.bbox.h > 950 && m.bbox.h < 1000, `height ~976, got ${m.bbox.h}`);
});

test('parseFlatDxf: bends include 2 long V side-walls + the 7 short H tabs', () => {
  const m = KD.parseFlatDxf(DXF);
  const V = m.bends.filter(b => b.dir === 'V');
  const Hshort = m.bends.filter(b => b.dir === 'H' && b.len > 18 && b.len < 30);
  const Vlong = V.filter(b => b.len > 800);
  assert.equal(Vlong.length, 2, `2 long vertical side bends, got ${Vlong.length}`);
  assert.equal(Hshort.length, 7, `7 short ~23mm tabs, got ${Hshort.length}`);
  m.bends.forEach(b => {
    assert.ok(Array.isArray(b.a) && Array.isArray(b.b), 'bend has a/b points');
    assert.ok(b.dir === 'H' || b.dir === 'V', 'bend has dir');
  });
});

test('parseFlatDxf: outline is a closed loop spanning the bbox', () => {
  const m = KD.parseFlatDxf(DXF);
  assert.ok(m.outline.length > 6, `outline has points, got ${m.outline.length}`);
  const xs = m.outline.map(p => p[0]), ys = m.outline.map(p => p[1]);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 2000, 'outline spans width');
  assert.ok(Math.max(...ys) - Math.min(...ys) > 950, 'outline spans height');
  const first = m.outline[0], last = m.outline[m.outline.length - 1];
  assert.ok(Math.hypot(first[0] - last[0], first[1] - last[1]) < 1.0, 'loop closes');
});

test('parseFlatDxf: holes include circles (mounting holes) and slots', () => {
  const m = KD.parseFlatDxf(DXF);
  const circ = m.holes.filter(h => h.type === 'circle');
  const rect = m.holes.filter(h => h.type === 'rect');
  assert.ok(circ.length > 20, `many mounting holes, got ${circ.length}`);
  assert.ok(rect.length >= 7, `slots, got ${rect.length}`);
  circ.forEach(h => assert.ok(h.r > 0 && Array.isArray(h.c), 'circle has c/r'));
});
