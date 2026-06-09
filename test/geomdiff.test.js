// Node test for the pure geometric-diff engine (diff-geom.js).
// Run: node test/geomdiff.test.js   (exit 0 + "OK" lines = pass)
const assert = require('assert');
const { geomDiff } = require('../diff-geom.js');

// minimal parsed-flat builder mirroring KD_DXFFLAT.parseFlatDxf output shape:
// holes = [{type:'circle',c:[x,y],r} | {type:'rect',pts:[[x,y]...]}], bends=[{mid,len,dir,a,b}]
const flat = (w, h, holes, rects, bends) => ({
  bbox: { minX: 0, minY: 0, maxX: w, maxY: h, w, h },
  holes: [].concat(
    (holes || []).map(([x, y, r]) => ({ type: 'circle', c: [x, y], r })),
    (rects || []).map(pts => ({ type: 'rect', pts }))
  ),
  bends: (bends || []).map(([mx, my, len, dir]) => ({ mid: [mx, my], len, dir, a: [mx, my - len / 2], b: [mx, my + len / 2] })),
  outline: { segments: [] }
});

// base: 2 holes (d10 @10,10 ; d10 @90,10). comp: drops the 2nd, adds one @50,50,
// resizes the 1st to d12 (dia diff 2mm > 0.1), and is 50mm wider.
const base = flat(100, 60, [[10, 10, 5], [90, 10, 5]]);
const comp = flat(150, 60, [[10, 10, 6], [50, 50, 5]]);

const r = geomDiff(base, comp, { thickness: 1.0 }, { thickness: 1.0 });
assert.strictEqual(r.holes.removed.length, 1, 'one hole removed (90,10)');
assert.strictEqual(r.holes.added.length, 1, 'one hole added (50,50)');
assert.strictEqual(r.holes.resized.length, 1, 'one hole resized (10,10 d10->d12)');
assert.strictEqual(r.dims.dW, 50, 'width +50');
assert.strictEqual(r.dims.dH, 0, 'height same');
assert.strictEqual(r.material.sameTh, true, 'thickness same');
console.log('geomdiff.test OK');
