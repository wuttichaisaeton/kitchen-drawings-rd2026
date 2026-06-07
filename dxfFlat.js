/* dxfFlat.js — parse a flat-pattern DXF into a foldable model, merge fold params
 * from per_bend/walls, and fold it to 3D. Pure (no DOM). Browser: window.KD_DXFFLAT;
 * Node tests: module.exports. See docs/superpowers/specs/2026-06-07-dxf-driven-simbend-design.md
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.KD_DXFFLAT = api;
})(this, function () {
  'use strict';

  // Tokenize the whole DXF into {code:Number, value:String} pairs.
  function tokenize(text) {
    var lines = text.split(/\r\n|\r|\n/);
    var toks = [];
    for (var i = 0; i + 1 < lines.length; i += 2) {
      var code = parseInt(lines[i].trim(), 10);
      if (isNaN(code)) { i -= 1; continue; }   // resync on a stray line
      toks.push({ code: code, value: lines[i + 1] });
    }
    return toks;
  }

  // Split the ENTITIES section into entities. Each entity = a group of pairs that
  // starts at a `0 <TYPE>` token. Returns [{type, layer, codes:{c:[vals...]}}].
  function entitiesOf(toks) {
    var start = -1, end = toks.length;
    for (var i = 0; i < toks.length; i++) {
      if (toks[i].code === 2 && toks[i].value.trim() === 'ENTITIES') start = i + 1;
      else if (start >= 0 && toks[i].code === 0 && toks[i].value.trim() === 'ENDSEC') { end = i; break; }
    }
    if (start < 0) return [];
    var ents = [], cur = null;
    for (var j = start; j < end; j++) {
      var t = toks[j];
      if (t.code === 0) { cur = { type: t.value.trim(), layer: '', codes: {} }; ents.push(cur); }
      else if (cur) {
        if (t.code === 8) cur.layer = t.value.trim();
        (cur.codes[t.code] = cur.codes[t.code] || []).push(t.value);
      }
    }
    return ents;
  }

  function parseFlatDxf(text) {
    if (!text || typeof text !== 'string') return null;
    var ents = entitiesOf(tokenize(text));
    if (!ents.length) return null;
    // Compute bbox from OUTER_PROFILES layer only (the authoritative flat outline).
    var outer = ents.filter(function (e) { return e.layer === 'OUTER_PROFILES'; });
    var pool = outer.length ? outer : ents;   // fallback to all if layer absent
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pool.forEach(function (e) {
      var xs = (e.codes[10] || []).concat(e.codes[11] || []);
      var ys = (e.codes[20] || []).concat(e.codes[21] || []);
      for (var k = 0; k < xs.length; k++) {
        var x = parseFloat(xs[k]); if (x < minX) minX = x; if (x > maxX) maxX = x;
      }
      for (var m = 0; m < ys.length; m++) {
        var y = parseFloat(ys[m]); if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    });
    if (!isFinite(minX)) return null;
    return {
      _ents: ents,
      bbox: { minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: +(maxX - minX).toFixed(3), h: +(maxY - minY).toFixed(3) },
      outline: [], holes: [], bends: []   // filled in later tasks
    };
  }              // Task 2-5
  function mergeBends(flat, perBend, walls) { return []; }  // Task 6
  function foldFlat(flat, bends, t) { return null; }        // Task 7-8

  return { parseFlatDxf: parseFlatDxf, mergeBends: mergeBends, foldFlat: foldFlat };
});
