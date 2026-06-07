import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const KD = require('../dxfFlat.js');
const __dirname = dirname(fileURLToPath(import.meta.url));
export const DXF = readFileSync(join(__dirname, 'fixtures/CVIL00-205093.dxf'), 'utf8');

test('harness: module loads and exposes the API', () => {
  assert.equal(typeof KD.parseFlatDxf, 'function');
  assert.equal(typeof KD.mergeBends, 'function');
  assert.equal(typeof KD.foldFlat, 'function');
  assert.ok(DXF.includes('OUTER_PROFILES'), 'fixture has the OUTER_PROFILES layer');
});
