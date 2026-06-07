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

  function snap(p) { return [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]; }

  // Collect OUTER_PROFILES entities as polyline segments (array of point arrays).
  function outerSegs(ents) {
    var segs = [];
    ents.forEach(function (e) {
      if (e.layer !== 'OUTER_PROFILES') return;
      if (e.type === 'LINE') {
        segs.push([ snap([+e.codes[10][0], +e.codes[20][0]]), snap([+e.codes[11][0], +e.codes[21][0]]) ]);
      } else if (e.type === 'SPLINE' || e.type === 'LWPOLYLINE') {
        var xs = e.codes[10] || [], ys = e.codes[20] || [], pts = [];
        for (var i = 0; i < xs.length; i++) pts.push(snap([+xs[i], +ys[i]]));
        if (pts.length >= 2) segs.push(pts);
      } else if (e.type === 'ARC') {
        var c = [+e.codes[10][0], +e.codes[20][0]], r = +e.codes[40][0];
        var a0 = (+e.codes[50][0]) * Math.PI / 180, a1 = (+e.codes[51][0]) * Math.PI / 180;
        if (a1 < a0) a1 += 2 * Math.PI;
        var ap = [];
        for (var s = 0; s <= 8; s++) { var a = a0 + (a1 - a0) * s / 8; ap.push(snap([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)])); }
        segs.push(ap);
      }
    });
    return segs;
  }

  // Walk segments into one ordered loop by matching endpoints.
  function stitch(segs) {
    if (!segs.length) return [];
    var used = new Array(segs.length).fill(false);
    var loop = segs[0].slice(); used[0] = true;
    var guard = segs.length * 2;
    while (guard-- > 0) {
      var tail = loop[loop.length - 1], best = -1, rev = false, bd = 0.5;
      for (var i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        var s = segs[i], df = Math.hypot(s[0][0] - tail[0], s[0][1] - tail[1]),
            dl = Math.hypot(s[s.length - 1][0] - tail[0], s[s.length - 1][1] - tail[1]);
        if (df < bd) { bd = df; best = i; rev = false; }
        if (dl < bd) { bd = dl; best = i; rev = true; }
      }
      if (best < 0) break;
      used[best] = true;
      var seg = rev ? segs[best].slice().reverse() : segs[best].slice();
      for (var k = 1; k < seg.length; k++) loop.push(seg[k]);
    }
    return loop;
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
    var bends = [];
    ents.forEach(function (e) {
      if (e.type !== 'LINE' || e.layer !== 'BEND') return;
      var a = [parseFloat(e.codes[10][0]), parseFloat(e.codes[20][0])];
      var b = [parseFloat(e.codes[11][0]), parseFloat(e.codes[21][0])];
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var dir = Math.abs(dx) >= Math.abs(dy) ? 'H' : 'V';   // H = horizontal line (fold axis along X)
      bends.push({
        a: a, b: b, dir: dir,
        len: +Math.hypot(dx, dy).toFixed(3),
        mid: [+( (a[0] + b[0]) / 2 ).toFixed(3), +( (a[1] + b[1]) / 2 ).toFixed(3)]
      });
    });
    var holes = [];
    ents.forEach(function (e) {
      if (e.layer !== 'INTERIOR_PROFILES') return;
      if (e.type === 'CIRCLE') {
        holes.push({ type: 'circle', c: [+e.codes[10][0], +e.codes[20][0]], r: +e.codes[40][0] });
      } else if (e.type === 'LWPOLYLINE') {
        var xs = e.codes[10] || [], ys = e.codes[20] || [], pts = [];
        for (var i = 0; i < xs.length; i++) pts.push([+xs[i], +ys[i]]);
        if (pts.length) holes.push({ type: 'rect', pts: pts });
      }
    });
    return {
      _ents: ents,
      bbox: { minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: +(maxX - minX).toFixed(3), h: +(maxY - minY).toFixed(3) },
      outline: stitch(outerSegs(ents)), holes: holes, bends: bends
    };
  }              // Task 2-5
  function mergeBends(flat, perBend, walls) {
    perBend = perBend || []; walls = walls || [];
    var cx = (flat.bbox.minX + flat.bbox.maxX) / 2, cy = (flat.bbox.minY + flat.bbox.maxY) / 2;
    var pbByBend = {}; perBend.forEach(function (p) { pbByBend[p.bend] = p; });
    return flat.bends.map(function (b) {
      var wantAxis = b.dir === 'V' ? 'X' : 'Y';
      var bendOff = b.dir === 'V' ? Math.abs(b.mid[0] - cx) : Math.abs(b.mid[1] - cy);
      var best = null, bestD = Infinity;
      walls.forEach(function (w) {
        if (w.axis !== wantAxis) return;
        var d = Math.abs((w.offset != null ? w.offset : 0) - bendOff);
        if (d < bestD) { bestD = d; best = w; }
      });
      var pb = best ? pbByBend[best.id] : null;
      return {
        a: b.a, b: b.b, dir: b.dir, len: b.len, mid: b.mid,
        id: best ? best.id : null,
        side: best ? best.side : (b.mid[1] > cy || b.mid[0] > cx ? '+' : '-'),
        angle_deg: (pb && pb.angle_deg != null) ? pb.angle_deg : (best && best.angle_deg != null ? best.angle_deg : 90),
        step: pb ? pb.step : (best && best.step != null ? best.step : 999),
        matched: !!best
      };
    });
  }  // Task 6
  function foldFlat(flat, bends, t) { return null; }        // Task 7-8

  return { parseFlatDxf: parseFlatDxf, mergeBends: mergeBends, foldFlat: foldFlat };
});
