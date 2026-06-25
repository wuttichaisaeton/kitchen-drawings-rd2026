// DOM-LEVEL regression test for the Nest "Rotate 180 + Mirror" orientation
// buttons. The earlier helper tests (nestEdgeGrain.test.mjs) call
// _applyOrientFlag / _orientedGeom in isolation and PASS — but they never
// exercise the real button → click handler → preview path, so they missed a
// LIVE bug: clicking ⟲180 / ⟷ targeted the WRONG part, jumped the preview, and
// the active class didn't track the previewed part.
//
// This test loads the REAL nest.js inside a jsdom window, seeds S with parts,
// renders the REAL markup + wires the REAL handlers, then dispatches a REAL
// 'click' on the actual button element and asserts:
//   (a) S.previewCode is UNCHANGED (preview stays on the part you were viewing),
//   (b) the PREVIEWED part's mirror/flip180 flag is now true (the right part),
//   (c) _orientedGeom for that part reflects the new orientation,
//   (d) the button element carries the active class (per-previewed-part).
// (live orient-button fix 2026-06-26)
import { test } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, '..', 'nest.js'), 'utf8');

// Boot nest.js inside a real jsdom window so querySelector / addEventListener /
// dispatchEvent / innerHTML-parsing all behave like a browser.
function boot() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><main id="root"></main></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',   // a real origin so window.localStorage works
  });
  const { window } = dom;
  // jsdom localStorage can still be flaky under opaque origins; supply a plain
  // in-memory shim so nest.js's module-eval localStorage reads never throw.
  const _store = new Map();
  const _ls = {
    getItem: k => (_store.has(k) ? _store.get(k) : null),
    setItem: (k, v) => _store.set(k, String(v)),
    removeItem: k => _store.delete(k),
    clear: () => _store.clear(),
  };
  // canvas getContext isn't implemented by jsdom; stub it so _drawPartPreview
  // doesn't throw (we only care about the part-list handlers + state here).
  window.HTMLCanvasElement.prototype.getContext = () => ({
    save() {}, restore() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    closePath() {}, stroke() {}, fill() {}, arc() {}, ellipse() {}, rect() {},
    fillRect() {}, strokeRect() {}, translate() {}, scale() {}, rotate() {},
    setTransform() {}, resetTransform() {}, setLineDash() {}, fillText() {},
    measureText: () => ({ width: 0 }), clip() {}, clearShadow() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    bezierCurveTo() {}, quadraticCurveTo() {}, arcTo() {},
  });
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
  // app.js helpers nest.js may probe — keep them absent/no-op.
  window.isAdmin = () => false;
  // Run nest.js's IIFE with our window's globals bound as free vars.
  // eslint-disable-next-line no-new-func
  new window.Function(
    'window', 'document', 'localStorage', 'CSS', 'requestAnimationFrame',
    'setTimeout', 'clearTimeout', 'devicePixelRatio', 'navigator', 'HTMLCanvasElement',
    SRC
  )(
    window, window.document, _ls, window.CSS,
    window.requestAnimationFrame, window.setTimeout.bind(window),
    window.clearTimeout.bind(window), 1, window.navigator, window.HTMLCanvasElement
  );
  return { window, T: window.kdNest._test };
}

// An ASYMMETRIC shape (a notch in one corner, like SDTRIL) so a mirror is
// detectable in the geometry, plus a long horizontal "other" part so a wrong
// resolution would visibly jump the preview to IT.
function notchPart(code) {
  return {
    code, qty: 1, selected: true, manual: false,
    grain: 'H', grainAngle: null, mirror: false, flip180: false,
    w: 600, h: 400, bbox: [0, 0, 600, 400],
    polys: {
      outer: [[0, 0], [600, 0], [600, 400], [400, 400], [400, 200], [0, 200], [0, 0]],
      holes: [], strokes: [], entities: [{ kind: 'CIRCLE', cx: 500, cy: 100, r: 20 }],
    },
    dxfUrl: 'x', dxfLoaded: true, dxfError: null, thickness: 1,
  };
}
function longPart(code) {
  return {
    code, qty: 1, selected: true, manual: false,
    grain: 'H', grainAngle: null, mirror: false, flip180: false,
    w: 1500, h: 80, bbox: [0, 0, 1500, 80],
    polys: { outer: [[0, 0], [1500, 0], [1500, 80], [0, 80], [0, 0]], holes: [], strokes: [], entities: [] },
    dxfUrl: 'x', dxfLoaded: true, dxfError: null, thickness: 1,
  };
}
function seed(T, parts, previewCode) {
  const S = T.state();
  S.parts = parts;
  S.flatSheets = [];
  S.currentSheetIdx = 0;
  S.unplaced = [];
  S.grainSkippedRemnants = 0;
  S.projectName = 'TEST';
  S.projectKey = 'test';
  S.mergedProjects = ['test'];
  S.cabinetsOff = new Set();
  S.capFold = new Set();
  S.grainRows = [];                 // loaded grain rules (orient rows live here)
  S.rootEl = T.state().rootEl || null;
  S.previewCode = previewCode || null;
  return S;
}
function centroidX(outer) { let s = 0; for (const p of outer) s += p[0]; return s / outer.length; }
function btnIn(window, code, sel) {
  const row = window.document.querySelector('.kdnest-part[data-code="' + code + '"]');
  return row ? row.querySelector(sel) : null;
}

// CRITICAL setup: the previewed/clicked part is at INDEX 1, with a DECOY long
// part at INDEX 0. The live bug jumped the preview to "a long horizontal part"
// and flagged the wrong part — exactly what a handler that resolves S.parts[0]
// / the-first-selected / a stale closure (instead of the row's own part) would
// do. Previewing the SECOND part makes any such wrong-key resolution FAIL the
// assertions (a same-shape index-0 part would let the bug hide). (live fix)
test('DOM: clicking ⟷ Mirror mirrors the PREVIEWED part (index 1, not the decoy), keeps preview, syncs active', () => {
  const { window, T } = boot();
  const S = T.state();
  S.rootEl = window.document.getElementById('root');
  const DECOY = longPart('SD0SUP-000000');       // index 0 — the "long horizontal" the bug jumped to
  const P = notchPart('SDTRIL-000001');          // index 1 — the asymmetric previewed part
  seed(T, [DECOY, P], 'SDTRIL-000001');          // previewing P (index 1)
  T.refreshView();

  const pBtnBefore = btnIn(window, 'SDTRIL-000001', '.kdnest-part-mirror');
  const dBtnBefore = btnIn(window, 'SD0SUP-000000', '.kdnest-part-mirror');
  assert.ok(pBtnBefore, 'previewed-part mirror button exists');
  assert.equal(pBtnBefore.classList.contains('kdnest-orient-active'), false, 'P mirror not active pre-click');
  assert.equal(dBtnBefore.classList.contains('kdnest-orient-active'), false, 'decoy (never touched) mirror NOT active');

  const beforeCx = centroidX(T.orientedGeom(P).polys.outer);

  // REAL click on the PREVIEWED part's Mirror button (the index-1 row).
  pBtnBefore.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // (a) preview stays on P — did NOT jump to the long decoy at index 0.
  assert.equal(T.state().previewCode, 'SDTRIL-000001', 'preview stayed on the previewed part (did not jump to decoy)');
  // (b) the PREVIEWED part is flagged; the decoy is untouched (catches S.parts[0]).
  assert.equal(P.mirror, true, 'previewed part mirror toggled true');
  assert.equal(DECOY.mirror, false, 'decoy at index 0 untouched');
  // and exactly one MIRROR row, for the PREVIEWED code (not the decoy code).
  const mrows = S.grainRows.filter(r => String(r.grain).toUpperCase() === 'MIRROR');
  assert.equal(mrows.length, 1, 'one MIRROR row persisted');
  assert.equal(mrows[0].pattern, 'SDTRIL-000001', 'MIRROR row keyed to the PREVIEWED code');
  // (c) oriented geom for the previewed part reflects across its bbox centre.
  const afterCx = centroidX(T.orientedGeom(P).polys.outer);
  const centre = (P.bbox[0] + P.bbox[2]) / 2;
  assert.ok(Math.abs((beforeCx + afterCx) - 2 * centre) < 1e-6, 'previewed geometry mirrored across centre');
  assert.ok(Math.abs(beforeCx - afterCx) > 1, 'previewed geometry actually moved');
  // (d) after re-render, the previewed part's button is active; the decoy's is not.
  assert.equal(btnIn(window, 'SDTRIL-000001', '.kdnest-part-mirror').classList.contains('kdnest-orient-active'), true,
    'previewed-part mirror button active after click');
  assert.equal(btnIn(window, 'SD0SUP-000000', '.kdnest-part-mirror').classList.contains('kdnest-orient-active'), false,
    'decoy mirror button still NOT active');
});

test('DOM: clicking ⟲180 Rotate flips the PREVIEWED part (index 1, not the decoy), keeps preview, syncs active', () => {
  const { window, T } = boot();
  const S = T.state();
  S.rootEl = window.document.getElementById('root');
  const DECOY = longPart('SD0SUP-000000');       // index 0
  const P = notchPart('SDTRIL-000001');          // index 1 — previewed
  seed(T, [DECOY, P], 'SDTRIL-000001');
  T.refreshView();

  const pBtn = btnIn(window, 'SDTRIL-000001', '.kdnest-part-flip180');
  assert.ok(pBtn, 'previewed flip180 button exists');
  assert.equal(pBtn.classList.contains('kdnest-orient-active'), false, 'P flip180 not active pre-click');

  pBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.equal(T.state().previewCode, 'SDTRIL-000001', 'preview stayed on previewed part');
  assert.equal(P.flip180, true, 'previewed part flip180 toggled true');
  assert.equal(DECOY.flip180, false, 'decoy at index 0 untouched');
  const frows = S.grainRows.filter(r => String(r.grain).toUpperCase() === 'FLIP180');
  assert.equal(frows.length, 1, 'one FLIP180 row persisted');
  assert.equal(frows[0].pattern, 'SDTRIL-000001', 'FLIP180 row keyed to the PREVIEWED code');
  assert.equal(btnIn(window, 'SDTRIL-000001', '.kdnest-part-flip180').classList.contains('kdnest-orient-active'), true,
    'previewed flip180 button active after click');
  assert.equal(btnIn(window, 'SD0SUP-000000', '.kdnest-part-flip180').classList.contains('kdnest-orient-active'), false,
    'decoy flip180 button still NOT active');
});

test('DOM: button active state tracks the PREVIEWED part when preview switches', () => {
  const { window, T } = boot();
  const S = T.state();
  S.rootEl = window.document.getElementById('root');
  const A = notchPart('SDTRIL-000001');          // index 0
  const B = notchPart('SD0SUP-000000');          // index 1
  seed(T, [A, B], 'SD0SUP-000000');              // previewing B (index 1)
  T.refreshView();

  // Mirror the previewed part B (index 1).
  btnIn(window, 'SD0SUP-000000', '.kdnest-part-mirror')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(B.mirror, true, 'B (previewed, index 1) mirrored');
  assert.equal(A.mirror, false, 'A (index 0) NOT mirrored — proves index-0 wasn\'t targeted');
  // B's button active, A's not.
  assert.equal(btnIn(window, 'SD0SUP-000000', '.kdnest-part-mirror').classList.contains('kdnest-orient-active'), true);
  assert.equal(btnIn(window, 'SDTRIL-000001', '.kdnest-part-mirror').classList.contains('kdnest-orient-active'), false);

  // Switch preview to A (👁) — A's mirror button must still read its OWN flag (false).
  T.setPreview('SDTRIL-000001');
  assert.equal(T.state().previewCode, 'SDTRIL-000001', 'preview switched to A');
  assert.equal(btnIn(window, 'SDTRIL-000001', '.kdnest-part-mirror').classList.contains('kdnest-orient-active'), false,
    'A mirror button reflects A\'s own (false) flag, not B\'s');
  // B is still mirrored — its row's button stays active even though B isn't previewed.
  assert.equal(btnIn(window, 'SD0SUP-000000', '.kdnest-part-mirror').classList.contains('kdnest-orient-active'), true,
    'B mirror button still active (B is still mirrored)');
});
