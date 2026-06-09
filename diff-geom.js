// diff-geom.js — pure geometric diff between two parsed flat-DXF parts.
// Shared "what differs" contract with G1 CC_DiffHoles: a HOLE = a circular interior
// loop; the two parts are compared in a shared bbox-origin frame (each feature shifted
// by its own bbox.minX/minY so the flats overlay regardless of DXF origin); centre match
// tolerance T = 0.5 mm; a matched hole whose diameter differs by > 0.1 mm = "resized".
// No DOM / no canvas → unit-testable under node (see test/geomdiff.test.js). The browser
// gets window.KD_GEOMDIFF; node gets module.exports.
(function (root) {
  var T = 0.5, DIA_T = 0.1;

  function _circles(flat) {
    var bx = flat.bbox.minX, by = flat.bbox.minY;
    return (flat.holes || []).filter(function (h) { return h.type === 'circle'; })
      .map(function (h) { return { cx: h.c[0] - bx, cy: h.c[1] - by, d: 2 * h.r, r: h.r }; });
  }
  function _rects(flat) {
    var bx = flat.bbox.minX, by = flat.bbox.minY;
    return (flat.holes || []).filter(function (h) { return h.type === 'rect'; })
      .map(function (h) {
        var sx = 0, sy = 0, n = h.pts.length;
        h.pts.forEach(function (p) { sx += p[0]; sy += p[1]; });
        return { cx: sx / n - bx, cy: sy / n - by, pts: h.pts };
      });
  }
  function _bends(flat) {
    var bx = flat.bbox.minX, by = flat.bbox.minY;
    return (flat.bends || []).map(function (b) {
      return { mx: b.mid[0] - bx, my: b.mid[1] - by, len: b.len, dir: b.dir, a: b.a, b: b.b };
    });
  }
  function _near(a, b) { return Math.hypot(a.cx - b.cx, a.cy - b.cy) <= T; }
  function _nearM(a, b) { return Math.hypot(a.mx - b.mx, a.my - b.my) <= T; }
  function _th(rec) {
    if (!rec) return null;
    if (rec.thickness != null) return +rec.thickness;
    if (rec.thickness_mm != null) return +rec.thickness_mm;
    return null;
  }

  function geomDiff(baseFlat, compFlat, baseRec, compRec) {
    // --- holes (Level C: added / removed / resized) ---
    var bH = _circles(baseFlat), cH = _circles(compFlat);
    var hAdded = [], hRemoved = [], hResized = [];
    bH.forEach(function (b) {
      var m = cH.find(function (c) { return _near(b, c); });
      if (!m) hRemoved.push(b);
      else if (Math.abs(m.d - b.d) > DIA_T) hResized.push({ cx: b.cx, cy: b.cy, r: m.r, baseD: b.d, compD: m.d });
    });
    cH.forEach(function (c) { if (!bH.find(function (b) { return _near(b, c); })) hAdded.push(c); });

    // --- (1) outer dimensions ---
    var bb = baseFlat.bbox, cb = compFlat.bbox;
    var dims = {
      baseW: bb.w, baseH: bb.h, compW: cb.w, compH: cb.h,
      dW: +(cb.w - bb.w).toFixed(2), dH: +(cb.h - bb.h).toFixed(2)
    };

    // --- (2) bends ---
    var bB = _bends(baseFlat), cB = _bends(compFlat);
    var bnAdded = [], bnRemoved = [];
    bB.forEach(function (b) { if (!cB.find(function (c) { return _nearM(b, c); })) bnRemoved.push(b); });
    cB.forEach(function (c) { if (!bB.find(function (b) { return _nearM(b, c); })) bnAdded.push(c); });

    // --- (3) cutouts / notches (rect interior loops) ---
    var bR = _rects(baseFlat), cR = _rects(compFlat);
    var cuAdded = [], cuRemoved = [];
    bR.forEach(function (b) { if (!cR.find(function (c) { return _near(b, c); })) cuRemoved.push(b); });
    cR.forEach(function (c) { if (!bR.find(function (b) { return _near(b, c); })) cuAdded.push(c); });

    // --- (4) thickness / material (text note; not a located feature) ---
    var bt = _th(baseRec), ct = _th(compRec);
    var material = {
      baseTh: bt, compTh: ct,
      sameTh: (bt != null && ct != null) ? Math.abs(bt - ct) <= 0.001 : bt === ct
    };

    return {
      dims: dims,
      holes: { added: hAdded, removed: hRemoved, resized: hResized },
      bends: { added: bnAdded, removed: bnRemoved, baseN: bB.length, compN: cB.length },
      cutouts: { added: cuAdded, removed: cuRemoved },
      outline: { changed: dims.dW !== 0 || dims.dH !== 0 },
      material: material
    };
  }

  // Pure summary builder — one line per diff category. Returns [{text,color}] so
  // both the canvas panel (diff-tools.js) and the node test consume the same source.
  // ASCII only (Flux web font can't render Thai/fancy glyphs in the rendered UI).
  function _fmt(v) { return v === 0 ? 'same' : ((v > 0 ? '+' : '') + v + 'mm'); }
  function geomDiffSummary(d) {
    var m = d.material;
    var matTxt = (m.baseTh == null && m.compTh == null)
      ? 'Thickness: unknown'
      : (m.sameTh ? ('Thickness: same (' + m.baseTh + 'mm)')
                  : ('Thickness: ' + m.baseTh + 'mm -> ' + m.compTh + 'mm'));
    return [
      { color: '#c9d1d9', text: 'Size: W ' + _fmt(d.dims.dW) + ' . H ' + _fmt(d.dims.dH) +
        '  (' + d.dims.baseW + 'x' + d.dims.baseH + ' -> ' + d.dims.compW + 'x' + d.dims.compH + ')' },
      { color: '#3fb950', text: d.holes.added.length + ' holes added' },
      { color: '#f85149', text: d.holes.removed.length + ' holes removed' },
      { color: '#F2A93B', text: d.holes.resized.length + ' holes resized (dia >0.1mm)' },
      { color: '#c9d1d9', text: 'Bends: ' + d.bends.added.length + ' added . ' + d.bends.removed.length +
        ' removed  (' + d.bends.baseN + ' -> ' + d.bends.compN + ')' },
      { color: '#c9d1d9', text: 'Cutouts: ' + d.cutouts.added.length + ' added . ' + d.cutouts.removed.length +
        ' removed' + (d.outline.changed ? '  . outline size changed' : '') },
      { color: (m.sameTh === false ? '#F2A93B' : '#8b949e'), text: matTxt }
    ];
  }

  root.KD_GEOMDIFF = { geomDiff: geomDiff, geomDiffSummary: geomDiffSummary, T: T, DIA_T: DIA_T };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.KD_GEOMDIFF;
})(typeof window !== 'undefined' ? window : globalThis);
