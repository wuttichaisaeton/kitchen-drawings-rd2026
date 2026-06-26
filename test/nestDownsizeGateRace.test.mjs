// ASYNC-GATE-RACE guard for the LAST-PARTIAL-SHEET DOWNSIZE (เอ๋ 2026-06-26).
//
// Context. The auto cost-optimizer enables the last-sheet downsize like this:
//
//     S.optDownsizePass = true;            // gate flag
//     _runNesting(...);                    // downsize runs INSIDE, gated by the flag
//     S.optDownsizePass = false;           // reset on the very next line
//
// Today _runNesting is fully SYNCHRONOUS (its only blocking point is window.confirm,
// which does not yield the event loop), so the gated downsize line executes BEFORE
// the reset and everything works. But that correctness depends entirely on the
// function never awaiting before the downsize line. The instant _runNesting becomes
// async — or someone inserts an `await` (an RTDB read, a real async confirm dialog,
// a _yield) ahead of the downsize — the synchronous reset wins the race: it clears
// the flag while the call is suspended at the await, so when execution resumes the
// gate is already false and the downsize is silently skipped. That is a latent
// "works on my machine, never fires in prod" trap.
//
// THE FIX (committed alongside this test): the downsize INTENT + the user's
// original-enabled allow-set are passed as EXPLICIT ARGUMENTS into _runNesting
// ( _runNesting({ downsize:true, allowKeys }) ) instead of being read from the
// racing flag. An argument captured in the call's own scope cannot be mutated by a
// later line in the caller, so the downsize fires regardless of async ordering.
//
// This test models BOTH channels against a _runNesting that DOES await before the
// downsize line:
//   • FLAG channel  → reset wins the race → downsize SKIPPED   (the bug; asserted)
//   • PARAM channel → intent travels in the arg → downsize RUNS (the fix; asserted)
// The PARAM assertion FAILS against pre-fix code (which had no opts arg) and PASSES
// after, closing the live gap the synchronous unit tests could never catch.
import { test } from 'node:test';
import assert from 'node:assert';

// A faithful stand-in for the downsize side effect: swap the last sheet 10x4→8x4
// and recompute the plan cost. Pure — the real _downsizeLastFreshSheet logic is
// covered by nestDownsizeRealPath.test.mjs; here we only care WHETHER it runs.
function applyDownsize(state, allowKeys) {
  const last = state.sheets[state.sheets.length - 1];
  if (!allowKeys || !allowKeys.has('2440x1220')) return;   // 8x4 must be allowed
  last.sw = 2440; last.sh = 1220;                          // 10x4 → 8x4
}
function planCost(state) {
  return state.sheets.reduce((c, s) =>
    c + (s.sw === 3050 && s.sh === 1220 ? 2750 : (s.sw === 2440 && s.sh === 1220 ? 2350 : 0)), 0);
}
function freshState() {
  // 5 fresh 10x4 sheets; the last holds the small parts and is downsize-eligible.
  return { sheets: Array.from({ length: 5 }, () => ({ sw: 3050, sh: 1220 })) };
}
const USER_ENABLED = new Set(['3050x1220', '2440x1220', '3050x1525']);

// ── Model A: the BUGGY flag channel + an ASYNC _runNesting ───────────────────
// _runNesting awaits (a microtask — the modal/confirm/RTDB the real one may grow)
// BEFORE the gated downsize line. The orchestrator sets the flag, fires the call
// WITHOUT awaiting it, then resets the flag synchronously — exactly the live shape.
async function runViaFlag() {
  const S = { downsizePass: false, allowKeys: null, ...freshState() };

  async function _runNesting() {
    await Promise.resolve();                 // <-- the async boundary that exposes the race
    if (S.downsizePass) applyDownsize(S, S.allowKeys);   // gated by the FLAG
  }

  S.downsizePass = true;
  S.allowKeys = USER_ENABLED;
  const p = _runNesting();                    // not awaited (orchestrator is sync here)
  S.downsizePass = false;                     // <-- reset RACES the suspended call
  S.allowKeys = null;
  await p;                                     // let the suspended call finish
  return { S, cost: planCost(S) };
}

// ── Model B: the FIXED parameter channel + the SAME async _runNesting ────────
// Intent travels in the call's argument, captured in its own scope → immune to the
// caller's reset.
async function runViaParam() {
  const S = { downsizePass: false, allowKeys: null, ...freshState() };

  async function _runNesting(opts) {
    const doDownsize = opts ? !!opts.downsize : !!S.downsizePass;
    const allow = opts ? (opts.allowKeys || null) : (S.allowKeys || null);
    await Promise.resolve();                 // same async boundary
    if (doDownsize) applyDownsize(S, allow);  // gated by the ARGUMENT
  }

  S.downsizePass = true;
  S.allowKeys = USER_ENABLED;
  const p = _runNesting({ downsize: true, allowKeys: USER_ENABLED });
  S.downsizePass = false;                     // reset still races — but no longer matters
  S.allowKeys = null;
  await p;
  return { S, cost: planCost(S) };
}

test('RACE REPRO: flag-gated downsize across an await is SKIPPED (reset wins)', async () => {
  const { S, cost } = await runViaFlag();
  const last = S.sheets[S.sheets.length - 1];
  assert.equal(last.sw, 3050, 'flag was reset before the awaited downsize line → stays 10x4');
  assert.equal(cost, 13750, 'no downsize → plan cost stuck at 13,750 (the live bug)');
});

test('FIX: parameter-gated downsize across the SAME await STILL runs (10x4→8x4)', async () => {
  const { S, cost } = await runViaParam();
  const last = S.sheets[S.sheets.length - 1];
  assert.equal(last.sw, 2440, 'intent carried in the arg → last sheet swapped to 8x4');
  assert.equal(last.sh, 1220, '8x4 height');
  assert.equal(cost, 13350, 'downsize applied → plan cost drops to 13,350');
  assert.ok(cost < 13750, 'strictly cheaper');
});

// Sanity: the param channel is also correct on the SYNCHRONOUS path (today's
// reality) — it must never regress the working case.
test('FIX is also correct when _runNesting is synchronous (no regression)', async () => {
  const S = { downsizePass: false, allowKeys: null, ...freshState() };
  function _runNestingSync(opts) {
    const doDownsize = opts ? !!opts.downsize : !!S.downsizePass;
    const allow = opts ? (opts.allowKeys || null) : (S.allowKeys || null);
    if (doDownsize) applyDownsize(S, allow);
  }
  _runNestingSync({ downsize: true, allowKeys: USER_ENABLED });
  assert.equal(S.sheets[S.sheets.length - 1].sw, 2440, 'sync param path downsizes too');
  assert.equal(planCost(S), 13350);
});

// GUARD: the Manual path passes NO opts and never sets the flag → no downsize.
test('Manual path (no opts, flag off) never downsizes', async () => {
  const S = { downsizePass: false, allowKeys: null, ...freshState() };
  function _runNestingSync(opts) {
    const doDownsize = opts ? !!opts.downsize : !!S.downsizePass;
    const allow = opts ? (opts.allowKeys || null) : (S.allowKeys || null);
    if (doDownsize) applyDownsize(S, allow);
  }
  _runNestingSync();   // manual call: undefined opts, flag stays false
  assert.equal(S.sheets[S.sheets.length - 1].sw, 3050, 'manual run untouched, stays 10x4');
  assert.equal(planCost(S), 13750);
});
