// END-TO-END live-wiring guard for the AUTO last-partial-sheet DOWNSIZE
// (04-Ruth case, เอ๋ 2026-06-26).
//
// WHY THIS EXISTS — the gap the prior downsize tests left open.
// nestDownsizeLastSheet / nestDownsizeRealPath / nestDownsizeGateRace all
// validate the downsize logic against FAITHFUL COPIES of _downsizeLastFreshSheet
// / _runNesting pasted into the test file. They never load the real module, so
// they pass even when the live WIRING is broken — exactly the trap that let the
// auto path silently stop downsizing while every unit test stayed green ("prior
// tests passed but the live wiring was broken").
//
// This test instead boots the REAL nest.js inside jsdom, renders the REAL UI,
// and dispatches a REAL click on the actual #kdnest-run button — i.e. it drives
// the genuine _runNestingAuto → _runNesting → _downsizeLastFreshSheet →
// _refreshView/_renderCostSummary chain end to end. It asserts BOTH bugs are
// closed on the live path:
//   (1) the final S.flatSheets LAST sheet is the downsized 8x4 (auto path
//       actually invokes the downsize with the user's original enabled set), and
//   (2) the recomputed total cost = 13,350 (4×2,750 + 1×2,350), and the rendered
//       Total Cost summary shows that post-downsize mix — not the stale 13,750
//       computed before the swap.
//
// PRE/POST proof (verified while writing this): run the SAME harness against the
// pre-fix nest.js (commit 2803cc8~1, before allowKeys + the eligibility fix) and
// the last sheet stays 10x4 with cost 13,750 → this test FAILS. Against current
// HEAD it swaps to 8x4 with cost 13,350 → this test PASSES.
import { test } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, '..', 'nest.js'), 'utf8');

// Boot nest.js inside a real jsdom window (mirrors nestOrientDom.test.mjs).
function boot() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><main id="root"></main></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const { window } = dom;
  const _store = new Map();
  const _ls = {
    getItem: k => (_store.has(k) ? _store.get(k) : null),
    setItem: (k, v) => _store.set(k, String(v)),
    removeItem: k => _store.delete(k),
    clear: () => _store.clear(),
  };
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
  window.requestAnimationFrame = (cb) => { if (cb) cb(); return 0; };
  window.cancelAnimationFrame = () => {};
  window.isAdmin = () => false;
  // The auto run asks "Remember remnants?" via confirm and may alert on no-op.
  // nest.js references bare confirm/alert/fetch → they resolve to globals here.
  globalThis.confirm = () => false;
  globalThis.alert = () => {};
  globalThis.fetch = async () => { throw new Error('no network in test'); };
  window.confirm = globalThis.confirm;
  window.alert = globalThis.alert;
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

function rectPolys(w, h) { return { outer: [[0, 0], [w, 0], [w, h], [0, h]], holes: [], strokes: [], entities: [] }; }
function part(code, w, h) {
  return {
    code, qty: 1, selected: true, manual: false,
    grain: 'H', grainAngle: null, mirror: false, flip180: false,
    w, h, bbox: [0, 0, w, h], polys: rectPolys(w, h),
    dxfUrl: 'x', dxfLoaded: true, dxfError: null, thickness: 1,
  };
}

// The 04-Ruth shape: 4 BIG parts each filling its own 10x4 sheet, + 7 SMALL
// parts that land together on the 5th (partial) sheet — which the auto path must
// downsize 10x4 → 8x4. BIG = 3040x1210 (nearly the full 3050x1220) so nothing
// else can tuck onto those sheets; the 7 smalls are the real RUTH_LAST set.
function seedRuth(T, window) {
  const S = T.state();
  S.rootEl = window.document.getElementById('root');
  S.parts = [
    part('BIG1', 3040, 1210), part('BIG2', 3040, 1210),
    part('BIG3', 3040, 1210), part('BIG4', 3040, 1210),
    part('TS1BHH-080000', 817, 108),
    part('FN1BLA-070000', 696, 123),
    part('FN2BNX-070000', 696, 123),
    part('DSB0BA-070050', 634, 127),
    part('BM1LI0-080000', 793, 99),
    part('FN2BNX-060000', 596, 123),
    part('BM1LI0-070000', 693, 99),
  ];
  S.flatSheets = [];
  S.unplaced = [];
  S.currentSheetIdx = 0;
  S.projectName = 'TEST';
  S.projectKey = 'test';
  S.mergedProjects = ['test'];
  S.cabinetsOff = new Set();
  S.capFold = new Set();
  S.grainRows = [];
  S.optManual = false;       // AUTO path (the one under test)
  S.rectLeftover = false;    // keep the last-sheet rectifier out of the way
  S.skipRemnants = true;     // no offcut reuse — pure fresh-stock cost decision
  S.gap = 5;
  S.mode = 'Desktop';
  // Three enabled sizes — the user's original selection. 8x4 is the strictly
  // cheaper size the partial last sheet must downsize to.
  S.sheetStock = [
    { w: 3050, h: 1220, qty: 20, prc: 2750, thickness: 1, enabled: true, label: '10x4' },
    { w: 2440, h: 1220, qty: 10, prc: 2350, thickness: 1, enabled: true, label: '8x4'  },
    { w: 3050, h: 1525, qty: 7,  prc: 3850, thickness: 1, enabled: true, label: '10x5' },
  ];
  return S;
}

function freshCost(S) {
  let total = 0;
  for (const s of (S.flatSheets || [])) {
    if (s.fromRemnant) continue;
    const w = Math.round(s.sw), h = Math.round(s.sh);
    const row = S.sheetStock.find(r => Math.round(r.w) === w && Math.round(r.h) === h);
    total += (row && row.prc) || 0;
  }
  return total;
}

test('E2E: clicking Run auto-downsizes the last 10x4 to 8x4 AND the cost recomputes to 13,350', async () => {
  const { window, T } = boot();
  const S = seedRuth(T, window);
  T.refreshView();   // render the real UI so #kdnest-run + its handler exist

  const runBtn = window.document.querySelector('#kdnest-run');
  assert.ok(runBtn, 'Run button rendered');

  // REAL click → _runNestingAuto (the bound handler). It is async (yields between
  // trials), so let the microtasks/timers settle before asserting.
  runBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));

  const sheets = S.flatSheets || [];
  assert.equal(S.unplaced.length, 0, 'all parts placed (no unplaced)');
  assert.equal(sheets.length, 5, 'five fresh sheets: 4 big + 1 partial');

  // (a) the partial LAST sheet was downsized 10x4 → 8x4 by the AUTO path.
  const last = sheets[sheets.length - 1];
  assert.equal(Math.round(last.sw), 2440, 'BUG 1 fixed: last sheet downsized to 8x4 width');
  assert.equal(Math.round(last.sh), 1220, 'last sheet height = 8x4');
  assert.equal(last.placements.length, 7, 'all 7 small parts carried onto the 8x4');
  // the first four stay 10x4
  for (let i = 0; i < 4; i++) {
    assert.equal(Math.round(sheets[i].sw), 3050, `big sheet ${i} stays 10x4 width`);
    assert.equal(Math.round(sheets[i].sh), 1220, `big sheet ${i} stays 10x4 height`);
  }

  // (b) the recomputed total cost reflects the post-downsize mix: 4×2750 + 2350.
  assert.equal(freshCost(S), 13350, 'BUG 1: plan cost dropped to 13,350 (was 13,750 with no downsize)');

  // (c) BUG 2 fixed: the RENDERED Total Cost summary shows the post-downsize mix
  // (recomputed AFTER the swap via _countFreshSheetsBySize), not the stale
  // 13,750 it would show if the cost were rendered before the downsize.
  const summaryEl = S.rootEl.querySelector('.kdnest-cost-summary');
  assert.ok(summaryEl, 'cost summary rendered');
  const txt = summaryEl.textContent.replace(/\s+/g, ' ').trim();
  assert.ok(txt.includes('13,350'), `summary shows 13,350 total — got: "${txt}"`);
  assert.ok(!txt.includes('13,750'), `summary must NOT show the pre-downsize 13,750 — got: "${txt}"`);
  assert.ok(txt.includes('(2,750 × 4)'), `summary breakdown shows 4× the 10x4 price — got: "${txt}"`);
  assert.ok(txt.includes('(2,350 × 1)'), `summary breakdown shows 1× the 8x4 price — got: "${txt}"`);
});

// GUARD: Manual toggle ON must NOT downsize — today's exact behavior, untouched.
// Manual keeps all 5 sheets at 10x4 (cost 13,750); the auto cost-optimize +
// downsize never run.
test('E2E: Manual path leaves the last sheet at 10x4 (no auto downsize)', async () => {
  const { window, T } = boot();
  const S = seedRuth(T, window);
  S.optManual = true;   // Manual ON
  T.refreshView();

  const runBtn = window.document.querySelector('#kdnest-run');
  runBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));

  const sheets = S.flatSheets || [];
  const last = sheets[sheets.length - 1];
  assert.equal(Math.round(last.sw), 3050, 'Manual: last sheet stays 10x4 (no downsize)');
  assert.equal(freshCost(S), 13750, 'Manual: cost stays 13,750 (no auto optimize)');
});
