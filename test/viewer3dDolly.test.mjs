// Guards the 3D viewer zoom = DOLLY (camera radius) math in app.js (_kdOpen3D).
// app.js is a browser script (no import), so this carries a FAITHFUL copy of the
// pure radius helpers — keep in sync with _dolly (wheel) + the pinch branch.
//
// Background: zoom used to be done via fieldOfView, which model-viewer's framing
// clamps on the narrow side → "zoom out ได้อย่างเดียว zoom in ไม่ได้" (เอ๋
// 2026-06-28). Dolly on the orbital radius has no such clamp, so it zooms BOTH
// ways and actually changes distance ("ระยะ"). Clamp = [0.2×, 5×] framed radius.
import { test } from 'node:test';
import assert from 'node:assert';

// ── verbatim copy of _dolly's radius math (wheel) ───────────────────────
function dollyRadius(curRadius, factor, R0) {
  return Math.max(R0 * 0.2, Math.min(R0 * 5, curRadius * factor));
}
// ── verbatim copy of the pinch branch radius math ───────────────────────
function pinchRadius(startRadius, scale, R0) {
  return Math.max(R0 * 0.2, Math.min(R0 * 5, startRadius / Math.max(0.2, scale)));
}

const R0 = 5709;  // a real framed radius (FN2BNX-095000)

test('wheel zoom IN (factor 0.89) moves the camera CLOSER (smaller radius)', () => {
  const r = dollyRadius(R0, 0.89, R0);
  assert.ok(r < R0, 'zoom in must reduce radius');
  assert.ok(Math.abs(r - R0 * 0.89) < 1e-6);
});

test('wheel zoom OUT (factor 1.12) moves the camera FARTHER (bigger radius)', () => {
  const r = dollyRadius(R0, 1.12, R0);
  assert.ok(r > R0, 'zoom out must grow radius');
  assert.ok(Math.abs(r - R0 * 1.12) < 1e-6);
});

test('zoom is reversible — in then out returns near the start', () => {
  let r = R0;
  for (let i = 0; i < 5; i++) r = dollyRadius(r, 0.89, R0);   // zoom in 5×
  assert.ok(r < R0);
  for (let i = 0; i < 5; i++) r = dollyRadius(r, 1.12, R0);   // zoom out 5×
  assert.ok(r > R0 * 0.9 && r < R0 * 1.1, 'should land back near R0');
});

test('clamp: cannot dolly closer than 0.2× the framed radius', () => {
  let r = R0;
  for (let i = 0; i < 100; i++) r = dollyRadius(r, 0.89, R0);  // hammer zoom-in
  assert.ok(r >= R0 * 0.2 - 1e-6, 'floored at 0.2×R0');
  assert.ok(Math.abs(r - R0 * 0.2) < 1e-6);
});

test('clamp: cannot dolly farther than 5× the framed radius', () => {
  let r = R0;
  for (let i = 0; i < 100; i++) r = dollyRadius(r, 1.12, R0);  // hammer zoom-out
  assert.ok(r <= R0 * 5 + 1e-6, 'capped at 5×R0');
  assert.ok(Math.abs(r - R0 * 5) < 1e-6);
});

test('pinch APART (scale>1) zooms IN (smaller radius)', () => {
  const r = pinchRadius(R0, 2.0, R0);   // fingers spread to 2× start distance
  assert.ok(r < R0, 'pinch apart must reduce radius');
  assert.ok(Math.abs(r - R0 / 2) < 1e-6);
});

test('pinch TOGETHER (scale<1) zooms OUT (bigger radius)', () => {
  const r = pinchRadius(R0, 0.5, R0);   // fingers pinch to half start distance
  assert.ok(r > R0, 'pinch together must grow radius');
  assert.ok(Math.abs(r - R0 / 0.5) < 1e-6 || r === R0 * 5);  // 2×R0 here, under cap
});

test('pinch scale is floored at 0.2 so radius never explodes', () => {
  const r = pinchRadius(R0, 0.0001, R0);   // degenerate pinch
  assert.ok(r <= R0 * 5 + 1e-6, 'still capped at 5×R0');
});
