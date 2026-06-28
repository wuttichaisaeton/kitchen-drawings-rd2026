// Guards the 3D explode-bar readout "N PART · M PCS" — ALPF sheet-metal only.
// app.js is a browser script (no import) → faithful copy of the pure helpers.
// Keep in sync with _kd3dIsHardware / _kd3dUnitIsHardware / _extractPartLabel and
// the `.kd3d-explode-info` count. เอ๋ 2026-06-28/29: PCS = total ALPF pieces
// (exclude __HW hinges/legs/slides); PART = distinct ALPF part TYPES (unique codes).
import { test } from 'node:test';
import assert from 'node:assert';

// ── verbatim from app.js ────────────────────────────────────────────────
const _kd3dIsHardware = (name) => typeof name === 'string' && name.includes('__HW');
function _kd3dUnitIsHardware(node) {
  if (!node) return false;
  if (_kd3dIsHardware(node.name)) return true;
  return (node.descendants || []).some(n => _kd3dIsHardware(n.name || ''));
}
const _extractPartLabel = (name) => {
  if (!name) return '';
  const idx = name.indexOf('__');
  let comp = idx >= 0 ? name.substring(0, idx) : name;
  comp = comp.replace(/[ _]v\d+$/i, '').trim();
  if (comp.includes('-')) return comp;
  return '';
};
// the two readout numbers
const alpfUnits = (units) => units.filter(u => !_kd3dUnitIsHardware(u.node));
const alpfPcs = (units) => alpfUnits(units).length;
const alpfParts = (units) =>
  new Set(alpfUnits(units).map(u => _extractPartLabel(u.node.name || '')).filter(Boolean)).size;

test('PCS = total ALPF pieces, PART = distinct codes (instanced ×N → 1 PART, N PCS)', () => {
  const units = [
    { node: { name: 'TS2TRX-000000__Body1' } },   // \
    { node: { name: 'TS2TRX-000000__Body1_2' } }, //  } 4 instances of ONE code
    { node: { name: 'TS2TRX-000000__Body1_3' } }, // /
    { node: { name: 'TS2TRX-000000__Body1_4' } }, ///
    { node: { name: 'BK1DN1-100000__Body1' } },   // a 2nd distinct code
    { node: { name: 'Hinge__HW_1' } },            // hardware — excluded from both
  ];
  assert.equal(alpfPcs(units), 5);    // 4 + 1 ALPF pieces (hardware dropped)
  assert.equal(alpfParts(units), 2);  // TS2TRX-000000 + BK1DN1-100000
});

test('matches the 1LLV04-100SHD screenshot: 16 PART · 36 PCS', () => {
  // (code, qty) straight off เอ๋'s explode labels
  const spec = [
    ['BK1DN1-100000', 1], ['FN2BN0-000000', 2], ['BM1LI0-100000', 4], ['FN3BLA-100000', 3],
    ['BXXTR0-000000', 4], ['SD00NA-080000', 2], ['DSV100-050080', 2], ['SD0SUP-000000', 4],
    ['SD0SI1-100035', 1], ['DSV2L3-050080', 1], ['SD0SI2-100000', 1], ['DSV2R3-050080', 1],
    ['FN0F00-100000', 1], ['TS1BHH-100000', 4], ['FN2BLA-040000', 1], ['TS2TRX-000000', 4],
  ];
  const units = [];
  spec.forEach(([code, qty], ci) => {
    for (let i = 0; i < qty; i++) units.push({ node: { name: `${code}__Body${i}_${ci}` } });
  });
  // a few hardware units that must NOT count
  units.push({ node: { name: 'BlumHinge__HW_0' } }, { node: { name: 'Leg__HW_1' } });
  assert.equal(alpfParts(units), 16);
  assert.equal(alpfPcs(units), 36);
});

test('hardware on a descendant mesh is excluded from both counts', () => {
  const units = [
    { node: { name: 'Slide', descendants: [{ name: 'rail__HW_0' }] } },     // hw
    { node: { name: 'DSV100-050080__Body1', descendants: [{ name: 'sheet' }] } }, // ALPF
  ];
  assert.equal(alpfPcs(units), 1);
  assert.equal(alpfParts(units), 1);
});

test('version stamp + body suffix collapse to one PART (instances share a code)', () => {
  const units = [
    { node: { name: 'FN2BNX-060000 v13__Body3' } },
    { node: { name: 'FN2BNX-060000__Body3_2' } },
  ];
  assert.equal(alpfPcs(units), 2);
  assert.equal(alpfParts(units), 1);   // " v13" stamp stripped → same code
});
