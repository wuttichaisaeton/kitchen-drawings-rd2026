// Guards the role-access scheme in app.js (2026-06-28). app.js is a browser
// IIFE (no import), so this carries FAITHFUL mirrors of the pure helpers —
// keep byte-identical with app.js _visibleTabsForRole / _resolveRoleFlag.
// Side effects (localStorage bake, admin clear, URL strip) are verified live.
import { test } from 'node:test';
import assert from 'node:assert';

// ── verbatim mirror of app.js _visibleTabsForRole (parameterised) ──────────
function _tabsFor(isAdmin, role) {
  if (isAdmin) return { projects: true, library: true, drawing: true, nest: true, simbend: true, stockpart: true };
  switch (role) {
    case 'laser':    return { projects: true, library: false, drawing: false, nest: false, simbend: false, stockpart: true };
    case 'bend':     return { projects: true, library: false, drawing: false, nest: false, simbend: false, stockpart: true };
    case 'assemble': return { projects: true, library: false, drawing: false, nest: false, simbend: false, stockpart: true };
    default:         return { projects: true, library: false, drawing: true,  nest: false, simbend: false, stockpart: true };
  }
}

test('worker roles see only Projects + Stock Part', () => {
  for (const role of ['laser', 'bend', 'assemble']) {
    assert.deepEqual(
      _tabsFor(false, role),
      { projects: true, library: false, drawing: false, nest: false, simbend: false, stockpart: true },
      role
    );
  }
});
test('admin sees every tab regardless of role', () => {
  assert.deepEqual(_tabsFor(true, 'laser'),
    { projects: true, library: true, drawing: true, nest: true, simbend: true, stockpart: true });
});
test('workshop (generic default) keeps Drawing, no Nest', () => {
  assert.equal(_tabsFor(false, 'workshop').drawing, true);
  assert.equal(_tabsFor(false, 'workshop').nest, false);
});

// ── verbatim mirror of app.js _resolveRoleFlag ────────────────────────────
const _ALIAS_ROLE = { asm: 'assemble', laser: 'laser', bend: 'bend' };
function _resolveRoleFlag(params) {
  if (params.has('role')) {
    const r = (params.get('role') || '').toLowerCase();
    return ['assemble', 'laser', 'bend'].includes(r) ? { role: r, project: '' } : { role: null, project: '' };
  }
  for (const k of ['asm', 'laser', 'bend']) {
    if (!params.has(k)) continue;
    const v = params.get(k) || '';
    const project = (v === '' || v.toLowerCase() === 'all') ? '' : v;
    return { role: _ALIAS_ROLE[k], project };
  }
  return null;
}
const P = (obj) => ({ has: (k) => k in obj, get: (k) => obj[k] });

test('?role= canonical maps + validates (case-insensitive)', () => {
  assert.deepEqual(_resolveRoleFlag(P({ role: 'laser' })), { role: 'laser', project: '' });
  assert.deepEqual(_resolveRoleFlag(P({ role: 'ASSEMBLE' })), { role: 'assemble', project: '' });
  assert.deepEqual(_resolveRoleFlag(P({ role: 'bend' })), { role: 'bend', project: '' });
});
test('?role=<unknown> consumed but bakes nothing', () => {
  assert.deepEqual(_resolveRoleFlag(P({ role: 'foo' })), { role: null, project: '' });
});
test('aliases ?asm/?laser/?bend map to roles, =all is generic', () => {
  assert.deepEqual(_resolveRoleFlag(P({ asm: '' })), { role: 'assemble', project: '' });
  assert.deepEqual(_resolveRoleFlag(P({ asm: 'all' })), { role: 'assemble', project: '' });
  assert.deepEqual(_resolveRoleFlag(P({ laser: '' })), { role: 'laser', project: '' });
  assert.deepEqual(_resolveRoleFlag(P({ bend: '' })), { role: 'bend', project: '' });
});
test('alias with a value drops into that project', () => {
  assert.deepEqual(_resolveRoleFlag(P({ asm: 'Bung 01' })), { role: 'assemble', project: 'Bung 01' });
  assert.deepEqual(_resolveRoleFlag(P({ bend: 'Ruth 02' })), { role: 'bend', project: 'Ruth 02' });
});
test('no role flag → null; ?role wins over aliases', () => {
  assert.equal(_resolveRoleFlag(P({ p: 'X' })), null);
  assert.deepEqual(_resolveRoleFlag(P({ role: 'bend', laser: '' })), { role: 'bend', project: '' });
});
