// Guards the "N PCS = ALPF sheet-metal pieces ONLY" count in the 3D explode bar
// (app.js _kdOpen3D). app.js is a browser script (no import) → faithful copy of the
// pure hardware-detection + count filter. Keep in sync with _kd3dIsHardware /
// _kd3dUnitIsHardware / the `.kd3d-explode-info` count (เอ๋ 2026-06-28: the count
// must match the cut/nest part total, i.e. exclude __HW hinges/legs/slides).
import { test } from 'node:test';
import assert from 'node:assert';

// ── verbatim from app.js ────────────────────────────────────────────────
const _kd3dIsHardware = (name) => typeof name === 'string' && name.includes('__HW');
// A unit is hardware if its node name OR any descendant mesh name carries __HW
// (Fusion tags the exported node, which for a multi-mesh part is a child).
function _kd3dUnitIsHardware(node) {
  if (!node) return false;
  if (_kd3dIsHardware(node.name)) return true;
  return (node.descendants || []).some(n => _kd3dIsHardware(n.name || ''));
}
const alpfPcs = (units) => units.filter(u => !_kd3dUnitIsHardware(u.node)).length;

test('counts ALPF parts, excludes __HW hardware (tag on the unit node)', () => {
  const units = [
    { node: { name: 'SD00NA-080000' } },          // ALPF
    { node: { name: 'FN2BLA-040000' } },          // ALPF
    { node: { name: 'HingeBlum__HW_1' } },        // hardware
    { node: { name: 'Leg__HW_2' } },              // hardware
  ];
  assert.equal(alpfPcs(units), 2);                // only the 2 ALPF panels
});

test('excludes hardware tagged on a DESCENDANT mesh, not the unit node', () => {
  const units = [
    { node: { name: 'Slide', descendants: [{ name: 'rail__HW_0' }] } },  // hw on child
    { node: { name: 'DSV100-050080', descendants: [{ name: 'sheet' }] } }, // ALPF
  ];
  assert.equal(alpfPcs(units), 1);
});

test('all-ALPF cabinet: count equals total units', () => {
  const units = [
    { node: { name: 'BK1DN1-100000' } },
    { node: { name: 'FN2BN0-000000' } },
    { node: { name: 'TS2TRX-000000' } },
  ];
  assert.equal(alpfPcs(units), 3);
});

test('__HW only affects the trailing tag — code extraction is on the first "__" (backward compatible)', () => {
  // a GLB with zero __HW nodes counts everything (legacy behaviour)
  const legacy = [{ node: { name: 'A-1' } }, { node: { name: 'B-2' } }];
  assert.equal(alpfPcs(legacy), 2);
  // an all-hardware edge case counts 0 (never negative / NaN)
  assert.equal(alpfPcs([{ node: { name: 'x__HW' } }]), 0);
});
