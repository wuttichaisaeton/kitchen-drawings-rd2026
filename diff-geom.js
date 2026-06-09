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
    // cat tags (holes/bends/dims/cutouts/material) align with G1 CC_Diff's 5 categories
    // and drive the per-category toggles in the Geometry Diff view.
    return [
      { cat: 'dims', color: '#c9d1d9', text: 'Size: W ' + _fmt(d.dims.dW) + ' . H ' + _fmt(d.dims.dH) +
        '  (' + d.dims.baseW + 'x' + d.dims.baseH + ' -> ' + d.dims.compW + 'x' + d.dims.compH + ')' },
      { cat: 'holes', color: '#3fb950', text: d.holes.added.length + ' holes added' },
      { cat: 'holes', color: '#f85149', text: d.holes.removed.length + ' holes removed' },
      { cat: 'holes', color: '#F2A93B', text: d.holes.resized.length + ' holes resized (dia >0.1mm)' },
      { cat: 'bends', color: '#c9d1d9', text: 'Bends: ' + d.bends.added.length + ' added . ' + d.bends.removed.length +
        ' removed  (' + d.bends.baseN + ' -> ' + d.bends.compN + ')' },
      { cat: 'cutouts', color: '#c9d1d9', text: 'Cutouts: ' + d.cutouts.added.length + ' added . ' + d.cutouts.removed.length +
        ' removed' + (d.outline.changed ? '  . outline size changed' : '') },
      { cat: 'material', color: (m.sameTh === false ? '#F2A93B' : '#8b949e'), text: matTxt }
    ];
  }

  // Pixel-region diff (for the "Download PDF with diff" export). Pure: takes the two
  // rendered-page RGBA buffers (Uint8 / Uint8ClampedArray) + dims, returns the regions
  // where they differ — coarse grid cells flagged by grayscale-threshold, then flood-
  // filled into clusters. No DXF→sheet coordinate mapping needed (robust path). Each
  // region carries a bbox + a circle (cx,cy,r) for drawing a dashed marker on the PDF.
  function pixelDiffRegions(baseData, compData, width, height, opts) {
    opts = opts || {};
    var TH = opts.threshold != null ? opts.threshold : 50;
    var CELL = opts.cell != null ? opts.cell : 16;
    var MINCELLS = opts.minCells != null ? opts.minCells : 2;
    var cols = Math.ceil(width / CELL), rows = Math.ceil(height / CELL);
    var cellDiff = new Uint8Array(cols * rows);
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var i = (y * width + x) * 4;
        var bg = (baseData[i] + baseData[i + 1] + baseData[i + 2]) / 3;
        var cg = (compData[i] + compData[i + 1] + compData[i + 2]) / 3;
        if (Math.abs(bg - cg) > TH) cellDiff[((y / CELL) | 0) * cols + ((x / CELL) | 0)] = 1;
      }
    }
    var seen = new Uint8Array(cols * rows);
    var regions = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var idx = r * cols + c;
        if (!cellDiff[idx] || seen[idx]) continue;
        var stack = [idx]; seen[idx] = 1;
        var minc = c, maxc = c, minr = r, maxr = r, count = 0;
        while (stack.length) {
          var cur = stack.pop(); count++;
          var cr = (cur / cols) | 0, cc = cur % cols;
          if (cc < minc) minc = cc; if (cc > maxc) maxc = cc;
          if (cr < minr) minr = cr; if (cr > maxr) maxr = cr;
          if (cc > 0 && cellDiff[cur - 1] && !seen[cur - 1]) { seen[cur - 1] = 1; stack.push(cur - 1); }
          if (cc < cols - 1 && cellDiff[cur + 1] && !seen[cur + 1]) { seen[cur + 1] = 1; stack.push(cur + 1); }
          if (cr > 0 && cellDiff[cur - cols] && !seen[cur - cols]) { seen[cur - cols] = 1; stack.push(cur - cols); }
          if (cr < rows - 1 && cellDiff[cur + cols] && !seen[cur + cols]) { seen[cur + cols] = 1; stack.push(cur + cols); }
        }
        if (count >= MINCELLS) {
          var x0 = minc * CELL, y0 = minr * CELL, x1 = (maxc + 1) * CELL, y1 = (maxr + 1) * CELL;
          regions.push({
            x: x0, y: y0, w: x1 - x0, h: y1 - y0, cells: count,
            cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, r: Math.max(x1 - x0, y1 - y0) / 2 + CELL
          });
        }
      }
    }
    return regions;
  }

  root.KD_GEOMDIFF = { geomDiff: geomDiff, geomDiffSummary: geomDiffSummary, pixelDiffRegions: pixelDiffRegions, T: T, DIA_T: DIA_T };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.KD_GEOMDIFF;
})(typeof window !== 'undefined' ? window : globalThis);
