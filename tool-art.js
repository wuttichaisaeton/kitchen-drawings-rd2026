/* tool-art.js — SVG side-profile illustrations of press-brake tooling, drawn
 * from each tool's real spec (included angle, tip radius, gooseneck throat,
 * V-opening). Used as "รูปภาพ" thumbnails in the My-Tooling library and bigger
 * in the bend view. No deps. window.KD_TOOLART.punch(tool[,opt]) / .die(tool[,opt])
 * return an <svg> string. 2026-06-02 (Group 1).
 */
(function () {
  'use strict';
  var STEEL = '#aebccd', STEEL_D = '#6b7785', EDGE = '#cfe0f2', BG = 'none';
  function tan(deg) { return Math.tan(deg * Math.PI / 180); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // ---- PUNCH (tip points DOWN) -----------------------------------------
  // viewBox 0..100 x, 0..130 y. Mount/body at top, working tip at bottom.
  function punch(tool, opt) {
    opt = opt || {};
    var w = opt.w || 90, h = opt.h || 120;
    var type = (tool && tool.type) || 'standard';
    var ang = (tool && tool.angle_deg != null) ? tool.angle_deg : 88;
    var R = (tool && tool.tip_radius_mm != null) ? tool.tip_radius_mm : 0.8;
    var cx = 50, bodyTop = 6, bodyW = 26, tipY = 122;
    var half = bodyW / 2;
    var path, extra = '';

    if (type === 'hemming') {
      // flat, wide bottom (no point) — closes hems
      path = 'M' + (cx - 22) + ',' + bodyTop +
             ' L' + (cx + 22) + ',' + bodyTop +
             ' L' + (cx + 22) + ',' + (tipY - 6) +
             ' L' + (cx + 14) + ',' + tipY +
             ' L' + (cx - 14) + ',' + tipY +
             ' L' + (cx - 22) + ',' + (tipY - 6) + ' Z';
    } else {
      // wedge tip: faces rise from the tip at (included angle / 2) from vertical
      var halfAng = clamp(ang, 10, 120) / 2;
      var run = half;                       // horizontal half-width of the body
      var rise = run / tan(halfAng);        // vertical length of the wedge
      var shoulderY = tipY - rise;
      var tipR = clamp(R * 3, 1.2, 6);      // visual tip rounding
      if (type === 'gooseneck') {
        // swan-neck: a throat notch cut into the RIGHT side for flange clearance
        path =
          'M' + (cx - half) + ',' + bodyTop +
          ' L' + (cx + half) + ',' + bodyTop +
          ' L' + (cx + half) + ',' + (bodyTop + 40) +
          ' Q' + (cx - 2) + ',' + (bodyTop + 54) + ' ' + (cx + half - 4) + ',' + (bodyTop + 72) +
          ' L' + (cx + half - 4) + ',' + (shoulderY) +
          ' L' + (cx + tipR) + ',' + (tipY - tipR) +
          ' Q' + cx + ',' + tipY + ' ' + (cx - tipR) + ',' + (tipY - tipR) +
          ' L' + (cx - half) + ',' + shoulderY + ' Z';
      } else {
        // standard / acute symmetric wedge
        path =
          'M' + (cx - half) + ',' + bodyTop +
          ' L' + (cx + half) + ',' + bodyTop +
          ' L' + (cx + half) + ',' + shoulderY +
          ' L' + (cx + tipR) + ',' + (tipY - tipR) +
          ' Q' + cx + ',' + tipY + ' ' + (cx - tipR) + ',' + (tipY - tipR) +
          ' L' + (cx - half) + ',' + shoulderY + ' Z';
      }
      // centreline
      extra = '<line x1="' + cx + '" y1="' + (bodyTop + 4) + '" x2="' + cx +
              '" y2="' + (tipY - 10) + '" stroke="' + STEEL_D +
              '" stroke-width="0.8" stroke-dasharray="3 3" opacity="0.5"/>';
    }
    return _svg(w, h, 100, 130,
      '<defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + EDGE + '"/><stop offset="1" stop-color="' + STEEL_D + '"/>' +
      '</linearGradient></defs>' +
      '<path d="' + path + '" fill="url(#pg)" stroke="' + EDGE + '" stroke-width="1.2" stroke-linejoin="round"/>' +
      extra);
  }

  // ---- DIE (V groove opens UP) -----------------------------------------
  // viewBox 0..130 x, 0..80 y. Block with one or two V grooves cut from the top.
  function die(tool, opt) {
    opt = opt || {};
    var w = opt.w || 120, h = opt.h || 74;
    var type = (tool && tool.type) || '1V';
    var ang = (tool && tool.angle_deg != null) ? tool.angle_deg : 88;
    var vlist = (tool && tool.v_list) || [12];
    var top = 6, bot = 74, left = 4, right = 126;
    var halfAng = clamp(ang, 10, 120) / 2;

    function groove(cx, v) {
      var px = clamp(v * 3.2, 10, 60);       // pixel opening (scaled V)
      var hw = px / 2;
      var depth = hw / tan(halfAng);
      var apexY = Math.min(bot - 6, top + depth);
      return 'M' + (cx - hw) + ',' + top +
             ' L' + cx + ',' + apexY +
             ' L' + (cx + hw) + ',' + top;
    }

    var grooves = '';
    if (type === '2V' && vlist.length >= 2) {
      grooves = '<path d="' + groove(42, vlist[0]) + '" fill="' + BG + '" stroke="' + EDGE + '" stroke-width="1.4" stroke-linejoin="round"/>' +
                '<path d="' + groove(88, vlist[1]) + '" fill="' + BG + '" stroke="' + EDGE + '" stroke-width="1.4" stroke-linejoin="round"/>';
    } else {
      grooves = '<path d="' + groove(65, vlist[0]) + '" fill="' + BG + '" stroke="' + EDGE + '" stroke-width="1.6" stroke-linejoin="round"/>';
    }
    // block body (the V is rendered as a cut: draw body then overdraw grooves)
    var body = '<rect x="' + left + '" y="' + top + '" width="' + (right - left) +
               '" height="' + (bot - top) + '" rx="3" fill="url(#dg)" stroke="' + EDGE +
               '" stroke-width="1.2"/>';
    return _svg(w, h, 130, 80,
      '<defs><linearGradient id="dg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + STEEL + '"/><stop offset="1" stop-color="' + STEEL_D + '"/>' +
      '</linearGradient></defs>' +
      body +
      // mask the grooves by drawing background-coloured V wedges over the block
      _grooveCut(type, vlist, halfAng, top, bot) +
      grooves);
  }

  function _grooveCut(type, vlist, halfAng, top, bot) {
    function wedge(cx, v) {
      var hw = clamp(v * 3.2, 10, 60) / 2;
      var depth = hw / tan(halfAng);
      var apexY = Math.min(bot - 6, top + depth);
      return '<path d="M' + (cx - hw) + ',' + top + ' L' + cx + ',' + apexY +
             ' L' + (cx + hw) + ',' + top + ' Z" fill="#0b121a"/>';
    }
    if (type === '2V' && vlist.length >= 2) return wedge(42, vlist[0]) + wedge(88, vlist[1]);
    return wedge(65, vlist[0]);
  }

  function _svg(w, h, vw, vh, inner) {
    return '<svg class="tool-svg" width="' + w + '" height="' + h +
      '" viewBox="0 0 ' + vw + ' ' + vh + '" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      inner + '</svg>';
  }

  window.KD_TOOLART = { punch: punch, die: die };
})();
