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

// (1) dims
const rDim = geomDiff(flat(100, 60, []), flat(100, 90, []));
assert.strictEqual(rDim.dims.dW, 0, 'W same');
assert.strictEqual(rDim.dims.dH, 30, 'H +30');
console.log('geomdiff dims OK');

// (2) bends — comp adds one bend line at x=10
const rBend = geomDiff(
  flat(100, 60, [], [], [[50, 0, 60, 'V']]),
  flat(100, 60, [], [], [[50, 0, 60, 'V'], [10, 0, 60, 'V']])
);
assert.strictEqual(rBend.bends.added.length, 1, 'one bend added @x=10');
assert.strictEqual(rBend.bends.removed.length, 0, 'no bend removed');
assert.strictEqual(rBend.bends.baseN, 1, 'base 1 bend');
assert.strictEqual(rBend.bends.compN, 2, 'comp 2 bends');
console.log('geomdiff bends OK');

// (3) cutouts — base has a rect notch, comp drops it
const rCut = geomDiff(
  flat(100, 60, [], [[[10, 10], [20, 10], [20, 20], [10, 20]]]),
  flat(100, 60, [], [])
);
assert.strictEqual(rCut.cutouts.removed.length, 1, 'one cutout removed');
assert.strictEqual(rCut.cutouts.added.length, 0, 'no cutout added');
console.log('geomdiff cutouts OK');

// (4) material / thickness
const rMat = geomDiff(flat(100, 60, []), flat(100, 60, []), { thickness: 1.0 }, { thickness: 1.5 });
assert.strictEqual(rMat.material.sameTh, false, 'thickness differs');
assert.strictEqual(rMat.material.baseTh, 1.0, 'base 1.0');
assert.strictEqual(rMat.material.compTh, 1.5, 'comp 1.5');
console.log('geomdiff material OK');

// summary builder — 7 category lines, dims line reflects +50mm width
const sum = require('../diff-geom.js').geomDiffSummary(r);
assert.strictEqual(sum.length, 7, 'summary has 7 lines');
assert.ok(sum[0].text.includes('W +50mm'), 'dims line shows W +50mm');
assert.ok(sum[1].text.includes('1 holes added'), 'holes-added line');
assert.ok(sum.some(l => /Thickness: same/.test(l.text)), 'thickness line present');
console.log('geomdiff summary OK');
