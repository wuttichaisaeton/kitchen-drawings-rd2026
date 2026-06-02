/* tool-art.js — SVG side-profile illustrations of press-brake tooling, drawn
 * from each tool's real spec (included angle, tip radius, gooseneck throat,
 * V-opening). Used as "รูปภาพ" thumbnails in the My-Tooling library and bigger
 * in the bend view. No deps. window.KD_TOOLART.punch(tool[,opt]) / .die(tool[,opt])
 * return an <svg> string. 2026-06-03.
 */
(function () {
  'use strict';
  var STEEL = '#dce8f5', STEEL_M = '#aebccd', STEEL_D = '#6b7785', EDGE = '#cfe0f2', BG = 'none';

  function rad(deg) { return deg * Math.PI / 180; }
  function sin(deg) { return Math.sin(rad(deg)); }
  function cos(deg) { return Math.cos(rad(deg)); }
  function tan(deg) { return Math.tan(rad(deg)); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // ---- PUNCH (tip points DOWN) -----------------------------------------
  // viewBox 0..100 x, 0..170 y. Mount/body at top, working tip at bottom.
  function punch(tool, opt) {
    opt = opt || {};
    var w = opt.w || 90, h = opt.h || 120;
    var type = (tool && tool.type) || 'standard';
    var ang = (tool && tool.angle_deg != null) ? tool.angle_deg : 88;
    var R = (tool && tool.tip_radius_mm != null) ? tool.tip_radius_mm : 0.8;
    var H = (tool && tool.height_mm != null) ? tool.height_mm : 120;
    
    var cx = 50, tipY = 160;
    var topY = tipY - H; // Mount starts here. H goes from 100 to 150
    var showDims = !!opt.showDimensions;

    // 1. Draw Amada Mount (Tang) from topY to topY + 32
    // Width is 14mm (X from 43 to 57)
    var tangH = 32;
    var tangY1 = topY;
    var tangY2 = topY + tangH;
    var tangWidth = 14;
    
    // Safety hook detail on the left (X from 43 to 45)
    var tangPath = 'M ' + cx + ',' + tangY1 +
                   ' L 57,' + tangY1 +
                   ' L 57,' + (tangY2 - 2) +
                   ' L 55,' + (tangY2 - 2) +
                   ' L 55,' + tangY2 +
                   ' L 45,' + tangY2 +
                   ' L 45,' + (tangY2 - 2) +
                   ' L 43,' + (tangY2 - 7) +
                   ' L 43,' + (tangY2 - 13) +
                   ' L 45,' + (tangY2 - 16) +
                   ' L 45,' + (tangY2 - 23) +
                   ' L 43,' + (tangY2 - 26) +
                   ' L 43,' + tangY1 +
                   ' Z';

    // 2. Draw Shoulder and Body
    var bodyW = 28;
    var halfAng = clamp(ang, 10, 120) / 2;
    var rise = (bodyW / 2) / tan(halfAng);
    var maxRise = H - 45; // Leave room for mount/body
    var actualRise = Math.min(rise, maxRise);
    var shoulderY = tipY - actualRise;
    var shoulderW = actualRise * tan(halfAng);

    var path = '';
    if (type === 'hemming') {
      // flat flattening surface at bottom (24mm wide)
      path = 'M 45,' + tangY2 +
             ' L 36,' + (tangY2 + 4) +
             ' L 36,' + (tipY - 8) +
             ' L 38,' + (tipY - 6) +
             ' L 38,' + tipY +
             ' L 62,' + tipY +
             ' L 62,' + (tipY - 6) +
             ' L 64,' + (tipY - 8) +
             ' L 64,' + (tangY2 + 4) +
             ' L 55,' + tangY2 + ' Z';
    } else {
      // Wedge tip: Left side is straight down, right side might have gooseneck
      var rightProfile = '';
      if (type === 'gooseneck') {
        var throatY1 = tangY2 + 10;
        var throatY2 = (throatY1 + shoulderY) / 2;
        rightProfile = ' L 64,' + throatY1 +
                       ' Q 22,' + (throatY1 + 10) + ' 25,' + throatY2 +
                       ' Q 28,' + (throatY2 + 20) + ' ' + (cx + shoulderW) + ',' + shoulderY;
      } else {
        rightProfile = ' L 64,' + (tangY2 + 4) +
                       ' L 64,' + shoulderY +
                       ' L ' + (cx + shoulderW) + ',' + shoulderY;
      }

      // Tip rounded shape calculation
      var tipR = Math.max(0.4, Math.min(R, 2.5));
      var dx = tipR * cos(halfAng);
      var dy = tipR * sin(halfAng);
      var tx1 = cx - dx;
      var ty1 = tipY - tipR + dy;
      var tx2 = cx + dx;
      var ty2 = tipY - tipR + dy;

      path = 'M 45,' + tangY2 +
             ' L 36,' + (tangY2 + 4) +
             ' L 36,' + shoulderY +
             ' L ' + (cx - shoulderW) + ',' + shoulderY +
             ' L ' + tx1 + ',' + ty1 +
             ' Q ' + cx + ',' + tipY + ' ' + tx2 + ',' + ty2 +
             rightProfile +
             ' L 55,' + tangY2 + ' Z';
    }

    var defs = '';
    var dims = '';
    var fillAttr = 'url(#pg)';
    var strokeAttr = EDGE;
    var strokeWidth = '1.2';

    if (showDims) {
      fillAttr = '#000000';
      strokeAttr = '#000000';
      strokeWidth = '1';

      // Dimension overlays in theme green
      defs = '<defs>' +
             '<marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">' +
             '<path d="M 0 0 L 10 5 L 0 10 z" fill="#4ecca3" />' +
             '</marker>' +
             '</defs>';
             
      // 1. Height dimension (left side, text inside margin)
      var dimX = 14;
      dims += '<!-- Height -->' +
              '<line x1="36" y1="' + topY + '" x2="' + (dimX - 4) + '" y2="' + topY + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />' +
              '<line x1="36" y1="' + tipY + '" x2="' + (dimX - 4) + '" y2="' + tipY + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />' +
              '<line x1="' + dimX + '" y1="' + topY + '" x2="' + dimX + '" y2="' + tipY + '" stroke="#4ecca3" stroke-width="1" marker-start="url(#arrow)" marker-end="url(#arrow)" />' +
              '<text x="' + (dimX + 5) + '" y="' + ((topY + tipY) / 2) + '" fill="#4ecca3" font-size="9.5" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="start" alignment-baseline="middle">' + H + ' mm</text>';

      if (type !== 'hemming') {
        // 2. Angle dimension (arc near tip)
        var arcR = 24;
        var ax1 = cx - arcR * sin(halfAng);
        var ay1 = tipY - arcR * cos(halfAng);
        var ax2 = cx + arcR * sin(halfAng);
        var ay2 = tipY - arcR * cos(halfAng);
        dims += '<!-- Angle -->' +
                '<path d="M ' + ax1 + ',' + ay1 + ' A ' + arcR + ',' + arcR + ' 0 0,1 ' + ax2 + ',' + ay2 + '" fill="none" stroke="#4ecca3" stroke-width="1.2" stroke-dasharray="2 2" marker-start="url(#arrow)" marker-end="url(#arrow)" />' +
                '<text x="' + cx + '" y="' + (tipY - arcR - 8) + '" fill="#4ecca3" font-size="9.5" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="middle">' + ang + '°</text>';

        // 3. Tip radius dimension (leader line)
        var lx1 = cx + 18;
        var ly1 = tipY - 18;
        var lx2 = cx + 1.5;
        var ly2 = tipY - 1.5;
        dims += '<!-- Tip Radius -->' +
                '<line x1="' + lx1 + '" y1="' + ly1 + '" x2="' + lx2 + '" y2="' + ly2 + '" stroke="#4ecca3" stroke-width="1" marker-end="url(#arrow)" />' +
                '<text x="' + (lx1 + 3) + '" y="' + (ly1 - 2) + '" fill="#4ecca3" font-size="9.5" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="start">R' + R + '</text>';
      } else {
        // Flat face width dimension for Hemming
        dims += '<!-- Hem width -->' +
                '<line x1="38" y1="' + (tipY + 4) + '" x2="38" y2="' + (tipY + 12) + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />' +
                '<line x1="62" y1="' + (tipY + 4) + '" x2="62" y2="' + (tipY + 12) + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />' +
                '<line x1="38" y1="' + (tipY + 8) + '" x2="62" y2="' + (tipY + 8) + '" stroke="#4ecca3" stroke-width="1" marker-start="url(#arrow)" marker-end="url(#arrow)" />' +
                '<text x="50" y="' + (tipY + 19) + '" fill="#4ecca3" font-size="9" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="middle">Flat 24mm</text>';
      }
    } else {
      // standard linear gradient defs
      defs = '<defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="1">' +
             '<stop offset="0" stop-color="' + STEEL + '"/>' +
             '<stop offset="0.4" stop-color="' + STEEL_M + '"/>' +
             '<stop offset="1" stop-color="' + STEEL_D + '"/>' +
             '</linearGradient></defs>';
    }

    var bodySvg = tangPath + ' ' + path;
    var drawContent = defs +
                      '<path d="' + bodySvg + '" fill="' + fillAttr + '" stroke="' + strokeAttr + '" stroke-width="' + strokeWidth + '" stroke-linejoin="round" fill-rule="evenodd" />' +
                      dims;

    return _svg(w, h, 100, 170, drawContent);
  }

  // ---- DIE (V groove opens UP) -----------------------------------------
  // viewBox 0..140 x, 0..90 y. Block with one or two V grooves cut from the top.
  function die(tool, opt) {
    opt = opt || {};
    var w = opt.w || 120, h = opt.h || 74;
    var type = (tool && tool.type) || '1V';
    var ang = (tool && tool.angle_deg != null) ? tool.angle_deg : 88;
    var vlist = (tool && tool.v_list) || [12];
    var H = (tool && tool.height_mm != null) ? tool.height_mm : 60;
    
    var cx = 70, top = 18;
    var bot = top + H; // height scales to H
    var showDims = !!opt.showDimensions;

    var halfAng = clamp(ang, 10, 120) / 2;

    var path = '';
    var left = 0, right = 0;
    var cx1 = 0, cx2 = 0;
    var V1 = vlist[0], V2 = vlist[1];

    if (type === '2V' && vlist.length >= 2) {
      // Two grooves spaced apart
      var spacing = Math.max(22, (V1 + V2) * 1.1);
      cx1 = cx - spacing / 2;
      cx2 = cx + spacing / 2;
      var blockW = spacing + (V1 + V2) * 1.1 + 18;
      blockW = clamp(blockW, 55, 126);
      left = cx - blockW / 2;
      right = cx + blockW / 2;

      var depth1 = (V1 / 2) / tan(halfAng);
      var apexY1 = top + Math.min(depth1, H - 12);
      var depth2 = (V2 / 2) / tan(halfAng);
      var apexY2 = top + Math.min(depth2, H - 12);

      path = 'M ' + left + ',' + bot +
             ' L ' + left + ',' + top +
             ' L ' + (cx1 - V1 / 2) + ',' + top +
             ' L ' + cx1 + ',' + apexY1 +
             ' L ' + (cx1 + V1 / 2) + ',' + top +
             ' L ' + (cx2 - V2 / 2) + ',' + top +
             ' L ' + cx2 + ',' + apexY2 +
             ' L ' + (cx2 + V2 / 2) + ',' + top +
             ' L ' + right + ',' + top +
             ' L ' + right + ',' + bot + ' Z';
    } else {
      // 1V groove centered
      var V = vlist[0];
      var blockW = Math.max(34, V * 2.2);
      blockW = clamp(blockW, 36, 126);
      left = cx - blockW / 2;
      right = cx + blockW / 2;

      var depth = (V / 2) / tan(halfAng);
      var apexY = top + Math.min(depth, H - 12);

      path = 'M ' + left + ',' + bot +
             ' L ' + left + ',' + top +
             ' L ' + (cx - V / 2) + ',' + top +
             ' L ' + cx + ',' + apexY +
             ' L ' + (cx + V / 2) + ',' + top +
             ' L ' + right + ',' + top +
             ' L ' + right + ',' + bot + ' Z';
    }

    var defs = '';
    var dims = '';
    var fillAttr = 'url(#dg)';
    var strokeAttr = EDGE;
    var strokeWidth = '1.2';

    if (showDims) {
      fillAttr = '#000000';
      strokeAttr = '#000000';
      strokeWidth = '1';

      defs = '<defs>' +
             '<marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">' +
             '<path d="M 0 0 L 10 5 L 0 10 z" fill="#4ecca3" />' +
             '</marker>' +
             '</defs>';

      // 1. Height dimension (left side, text inside margin)
      var dimX = 16;
      dims += '<!-- Height -->' +
              '<line x1="' + left + '" y1="' + top + '" x2="' + (dimX - 4) + '" y2="' + top + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />' +
              '<line x1="' + left + '" y1="' + bot + '" x2="' + (dimX - 4) + '" y2="' + bot + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />' +
              '<line x1="' + dimX + '" y1="' + top + '" x2="' + dimX + '" y2="' + bot + '" stroke="#4ecca3" stroke-width="1" marker-start="url(#arrow)" marker-end="url(#arrow)" />' +
              '<text x="' + (dimX + 5) + '" y="' + ((top + bot) / 2) + '" fill="#4ecca3" font-size="9.5" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="start" alignment-baseline="middle">' + H + ' mm</text>';

      if (type === '2V' && vlist.length >= 2) {
        // 2. Two V opening dimensions
        var V1 = vlist[0], V2 = vlist[1];
        var yDim = top - 6;
        dims += '<!-- V1 width -->' +
                '<line x1="' + (cx1 - V1 / 2) + '" y1="' + top + '" x2="' + (cx1 - V1 / 2) + '" y2="' + (yDim - 2) + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />' +
                '<line x1="' + (cx1 + V1 / 2) + '" y1="' + top + '" x2="' + (cx1 + V1 / 2) + '" y2="' + (yDim - 2) + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />' +
                '<line x1="' + (cx1 - V1 / 2) + '" y1="' + yDim + '" x2="' + (cx1 + V1 / 2) + '" y2="' + yDim + '" stroke="#4ecca3" stroke-width="1" marker-start="url(#arrow)" marker-end="url(#arrow)" />' +
                '<text x="' + cx1 + '" y="' + (yDim - 4) + '" fill="#4ecca3" font-size="9" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="middle">V' + V1 + '</text>';

        dims += '<!-- V2 width -->' +
                '<line x1="' + (cx2 - V2 / 2) + '" y1="' + top + '" x2="' + (cx2 - V2 / 2) + '" y2="' + (yDim - 2) + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />' +
                '<line x1="' + (cx2 + V2 / 2) + '" y1="' + top + '" x2="' + (cx2 + V2 / 2) + '" y2="' + (yDim - 2) + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />' +
                '<line x1="' + (cx2 - V2 / 2) + '" y1="' + yDim + '" x2="' + (cx2 + V2 / 2) + '" y2="' + yDim + '" stroke="#4ecca3" stroke-width="1" marker-start="url(#arrow)" marker-end="url(#arrow)" />' +
                '<text x="' + cx2 + '" y="' + (yDim - 4) + '" fill="#4ecca3" font-size="9" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="middle">V' + V2 + '</text>';
                
        // 3. Angles (text inside V)
        var depth1 = (V1 / 2) / tan(halfAng);
        var apexY1 = top + Math.min(depth1, H - 12);
        var depth2 = (V2 / 2) / tan(halfAng);
        var apexY2 = top + Math.min(depth2, H - 12);
        dims += '<!-- Angles -->' +
                '<text x="' + cx1 + '" y="' + (apexY1 - 8) + '" fill="#4ecca3" font-size="8.5" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="middle">' + ang + '°</text>' +
                '<text x="' + cx2 + '" y="' + (apexY2 - 8) + '" fill="#4ecca3" font-size="8.5" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="middle">' + ang + '°</text>';
      } else {
        // Single V opening dimension
        var V = vlist[0];
        var yDim = top - 6;
        dims += '<!-- V width -->' +
                '<line x1="' + (cx - V / 2) + '" y1="' + top + '" x2="' + (cx - V / 2) + '" y2="' + (yDim - 2) + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />' +
                '<line x1="' + (cx + V / 2) + '" y1="' + top + '" x2="' + (cx + V / 2) + '" y2="' + (yDim - 2) + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />' +
                '<line x1="' + (cx - V / 2) + '" y1="' + yDim + '" x2="' + (cx + V / 2) + '" y2="' + yDim + '" stroke="#4ecca3" stroke-width="1" marker-start="url(#arrow)" marker-end="url(#arrow)" />' +
                '<text x="' + cx + '" y="' + (yDim - 4) + '" fill="#4ecca3" font-size="10" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="middle">V' + V + '</text>';
                
        // Angle inside V
        var depth = (V / 2) / tan(halfAng);
        var apexY = top + Math.min(depth, H - 12);
        dims += '<!-- Angle -->' +
                '<text x="' + cx + '" y="' + (apexY - 10) + '" fill="#4ecca3" font-size="9.5" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="middle">' + ang + '°</text>';
      }
    } else {
      defs = '<defs><linearGradient id="dg" x1="0" y1="0" x2="1" y2="1">' +
             '<stop offset="0" stop-color="' + STEEL + '"/>' +
             '<stop offset="0.5" stop-color="' + STEEL_M + '"/>' +
             '<stop offset="1" stop-color="' + STEEL_D + '"/>' +
             '</linearGradient></defs>';
    }

    var drawContent = defs +
                      '<path d="' + path + '" fill="' + fillAttr + '" stroke="' + strokeAttr + '" stroke-width="' + strokeWidth + '" stroke-linejoin="round" />' +
                      dims;

    return _svg(w, h, 140, 90, drawContent);
  }

  function _svg(w, h, vw, vh, inner) {
    return '<svg class="tool-svg" width="' + w + '" height="' + h +
      '" viewBox="0 0 ' + vw + ' ' + vh + '" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      inner + '</svg>';
  }

  window.KD_TOOLART = { punch: punch, die: die };
})();
