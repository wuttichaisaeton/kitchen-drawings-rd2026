// Guards the RTDB-key sanitizer for the web 3D tap-to-hide feature (2026-06-28).
// app.js is a browser global (no import), so this mirrors _glbHiddenKey VERBATIM —
// keep in sync. The visual hide (model-viewer node.visible) is verified live.
import { test } from 'node:test';
import assert from 'node:assert';

// ── verbatim mirror of app.js _glbHiddenKey ───────────────────────────────
function _glbHiddenKey(code) {
  return String(code == null ? '' : code).replace(/[.#$\[\]/]/g, '_').trim() || 'unknown';
}

test('keeps spaces + hyphens (valid RTDB key)', () => {
  assert.equal(_glbHiddenKey('02 Wipha-L'), '02 Wipha-L');
  assert.equal(_glbHiddenKey('OTHERS-000000'), 'OTHERS-000000');
});
test('replaces RTDB-illegal chars . # $ [ ] /', () => {
  assert.equal(_glbHiddenKey('a.b#c$d[e]f/g'), 'a_b_c_d_e_f_g');
});
test('blank/null → unknown', () => {
  assert.equal(_glbHiddenKey(''), 'unknown');
  assert.equal(_glbHiddenKey(null), 'unknown');
  assert.equal(_glbHiddenKey(undefined), 'unknown');
});
