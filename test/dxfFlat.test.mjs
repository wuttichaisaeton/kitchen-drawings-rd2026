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

test('mergeBends: every bend gets angle, side, step from walls', () => {
  const m = KD.parseFlatDxf(DXF);
  const walls = [
    { id: 'B5', axis: 'Y', side: '-', height: 15, offset: 1024, step: 1 },
    { id: 'B6', axis: 'Y', side: '+', height: 15, offset: 1024, step: 2 },
    { id: 'B1', axis: 'X', side: '+', height: 21, offset: 10.5, step: 6 }
  ];
  const perBend = [
    { bend: 'B5', step: 1, angle_deg: 90 }, { bend: 'B6', step: 2, angle_deg: 90 },
    { bend: 'B1', step: 6, angle_deg: 90 }
  ];
  const merged = KD.mergeBends(m, perBend, walls);
  assert.equal(merged.length, m.bends.length, 'one entry per DXF bend');
  merged.forEach(b => {
    assert.equal(typeof b.angle_deg, 'number', 'has angle');
    assert.ok(b.side === '+' || b.side === '-', 'has side');
    assert.equal(typeof b.step, 'number', 'has step');
  });
  const longV = merged.filter(b => b.dir === 'V' && b.len > 800);
  assert.ok(longV.every(b => b.angle_deg === 90), 'long side bends are 90');
});

test('foldFlat: an L-bracket flat partitions into 2 panels (base + flange)', () => {
  const flat = {
    bbox: { minX: 0, minY: 0, maxX: 100, maxY: 60, w: 100, h: 60 },
    outline: [[0,0],[100,0],[100,60],[0,60],[0,0]], holes: [],
    bends: [{ a:[0,40], b:[100,40], dir:'H', len:100, mid:[50,40] }]
  };
  const bends = [{ ...flat.bends[0], side:'+', angle_deg:90, step:1, id:'B1', matched:true }];
  const out = KD.foldFlat(flat, bends, 1e9);
  assert.ok(out, 'returns a result');
  assert.equal(out.panels.length, 2, `2 panels, got ${out.panels.length}`);
  // (fold/z behaviour is verified in the next task)
});

test('foldFlat: L-bracket flange folds ~90 up at full t', () => {
  const flat = {
    bbox:{minX:0,minY:0,maxX:100,maxY:60,w:100,h:60},
    outline:[[0,0],[100,0],[100,60],[0,60],[0,0]], holes:[],
    bends:[{a:[0,40],b:[100,40],dir:'H',len:100,mid:[50,40]}]
  };
  const bends=[{...flat.bends[0],side:'+',angle_deg:90,step:1,id:'B1',matched:true}];
  const out = KD.foldFlat(flat, bends, 1e9);
  const flange = out.panels.find(p => (p.rect[1]+p.rect[3])/2 > 40);
  const top = Math.max(...flange.pts3.map(v => v[2]));
  assert.ok(top > 15 && top < 21, `flange (20mm) stands ~vertical, top z=${top}`);
  const base = out.panels.find(p => (p.rect[1]+p.rect[3])/2 < 40);
  assert.ok(base.pts3.every(v => Math.abs(v[2]) < 0.01), 'base stays flat');
});

test('foldFlat: CVIL00 folds without throwing and yields >3 panels', () => {
  const m = KD.parseFlatDxf(DXF);
  const walls = [
    {id:'B5',axis:'Y',side:'-',height:15,offset:1024,step:1},
    {id:'B6',axis:'Y',side:'+',height:15,offset:1024,step:2}
  ];
  const merged = KD.mergeBends(m, [{bend:'B5',step:1,angle_deg:90},{bend:'B6',step:2,angle_deg:90}], walls);
  const out = KD.foldFlat(m, merged, 1e9);
  assert.ok(out && out.panels.length >= 3, `panels, got ${out && out.panels.length}`);
});
