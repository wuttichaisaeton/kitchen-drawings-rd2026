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
