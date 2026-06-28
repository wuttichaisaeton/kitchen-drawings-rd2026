// Guards _codeDims / _dimGap in stockpart.js — the code-suffix dimension decode.
// stockpart.js is a browser IIFE (no import) → faithful copy of the helpers; keep
// in sync. เอ๋ 2026-06-29: 2SD/2CN codes are HEIGHT-FIRST (first3=height, next3=
// depth); all other families stay WIDTH-FIRST (first3=width, next3=height). The
// length auto-match (_dimGap) must stay order-independent either way.
import { test } from 'node:test';
import assert from 'node:assert';

// ── verbatim from stockpart.js ──────────────────────────────────────────
function _codeDims(code) {
  var suf = (String(code || '').split('-')[1] || '').replace(/\D/g, '');
  if (suf.length < 6) return null;
  var a = parseInt(suf.slice(0, 3), 10), b = parseInt(suf.slice(3, 6), 10);
  if (/^2(SD|CN)/i.test(String(code || ''))) return { h: a, d: b, vals: [a, b] };
  return { w: a, h: b, vals: [a, b] };
}
function _dimGap(d, target) {
  if (!d || !d.vals) return Infinity;
  var best = Infinity;
  d.vals.forEach(function (v) { best = Math.min(best, Math.abs(v * 10 - target), Math.abs(v - target)); });
  return best;
}

test('2CN / 2SD decode HEIGHT-FIRST (first3 = height, next3 = depth)', () => {
  assert.deepEqual(_codeDims('2CN002-120039'), { h: 120, d: 39, vals: [120, 39] });
  assert.deepEqual(_codeDims('2SD000-120040'), { h: 120, d: 40, vals: [120, 40] });
  assert.deepEqual(_codeDims('2SD0C1-120026'), { h: 120, d: 26, vals: [120, 26] });
  // height is the LONG dimension for these (the whole point) — not labelled width
  const cn = _codeDims('2CN002-120039');
  assert.equal(cn.w, undefined);     // no "width" slot for height-first families
  assert.equal(cn.h * 10, 1200);     // real height
  assert.equal(cn.d * 10, 390);      // real depth
});

test('other families stay WIDTH-FIRST (first3 = width, next3 = height)', () => {
  assert.deepEqual(_codeDims('FN2BLA-040000'), { w: 40, h: 0, vals: [40, 0] });
  assert.deepEqual(_codeDims('DSV100-050080'), { w: 50, h: 80, vals: [50, 80] });
  // a 2.. code that is NOT SD/CN keeps width-first (only SD/CN are height-first)
  assert.deepEqual(_codeDims('2FNLL0-060072'), { w: 60, h: 72, vals: [60, 72] });
});

test('_dimGap stays order-independent — matches a 2CN on EITHER height or depth', () => {
  const cn = _codeDims('2CN002-120039');     // H1200, D390
  assert.equal(_dimGap(cn, 1200), 0);        // worker measured the height
  assert.equal(_dimGap(cn, 390), 0);         // worker measured the depth
  assert.ok(_dimGap(cn, 395) <= 5);          // within tolerance
  assert.ok(_dimGap(cn, 800) > 5);           // neither dim → no match
});

test('_dimGap unchanged for normal width-first codes (no regression)', () => {
  const d = _codeDims('DSV100-050080');      // W500, H800
  assert.equal(_dimGap(d, 500), 0);
  assert.equal(_dimGap(d, 800), 0);
  assert.equal(_dimGap(d, 80), 0);           // raw value also tried (cm)
  assert.ok(_dimGap(d, 650) > 5);
});

test('null / short suffix → null (guarded)', () => {
  assert.equal(_codeDims('2CN002'), null);
  assert.equal(_codeDims(''), null);
  assert.equal(_dimGap(null, 100), Infinity);
});
