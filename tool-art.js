/* tool-art.js — SVG side-profile illustrations of press-brake tooling, drawn
 * from each tool's real spec (included angle, tip radius, gooseneck throat,
 * V-opening). Used as "รูปภาพ" thumbnails in the My-Tooling library and bigger
 * in the bend view. No deps. window.KD_TOOLART.punch(tool[,opt]) / .die(tool[,opt])
 * return an <svg> string. 2026-06-03 rev2 — auto-scale viewBox.
 */
(function () {
  'use strict';

  function rad(deg) { return deg * Math.PI / 180; }
  function sin(deg) { return Math.sin(rad(deg)); }
  function cos(deg) { return Math.cos(rad(deg)); }
  function tan(deg) { return Math.tan(rad(deg)); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // EXACT punch profiles lifted 1:1 from each tool's clean DXF (layer
  // "Visible"), keyed by Kyokko series. Ordered [x,y] mm loop, tip at origin
  // (0,0), Y up. Resolved automatically for any tool whose series / id
  // (P-KYOKKO-<series>-...) matches — no per-call wiring needed.
  var PROFILES = {
    // #202 Sash Punch (H130) — Punch No.202 88 R0.2 Drawing v2 Assembly.dxf
    '202': [[0,0],[12.728,12.728],[12.728,87],[20.728,95],[20.728,105],[17.728,105],[17.728,112.5],[20.728,112.5],[20.728,130],[7.728,130],[7.728,100],[-5.272,100],[-5.272,95],[2.728,87],[2.728,13.618],[-5.444,5.445]],
    // #109 Straight Punch (H95 / overall 125) — Punches No.10870 Drawing v1 Assembly.dxf
    '109': [[0,0],[3,3],[3,67.5],[19.5,84],[19.5,125],[6.5,125],[6.5,95],[-6.5,95],[-6.5,71],[-3,67.5],[-3,3]],
    // #453 Thin-Tip Small Gooseneck (H90, R15 throat) — Punches Gooseneck № 453 Drawing v1 Assembly.dxf
    // 24-pt loop incl the R15 throat arc (the concave gooseneck relief on the left)
    '453': [[0,0],[-5.657,5.657],[19.52,59.648],[20.841,63.432],[21.381,67.403],[21.119,71.402],[20.065,75.268],[18.261,78.847],[15.78,81.994],[-9.333,108],[-9.333,120],[9.333,120],[9.333,160],[22.667,160],[26.667,137.333],[22.667,137.333],[22.667,126.667],[26.667,126.667],[26.667,120],[48,120],[65.333,102.667],[65.333,70.667],[5.456,6.456],[5.456,5.851]],
    // #103 30° Acute Punch — Punch 30 deg Drawing v1 Assembly.dxf (10 Visible lines)
    // long offset 30° blade (right working face 148mm) + notched head; tip-to-top 194
    '103': [[0,0],[38.317,143],[34.067,143],[34.067,158.6],[40.067,158.6],[40.067,194],[14.067,194],[14.067,134],[-13.933,134],[-13.933,52]]
  };

  // Resolve a tool's exact DXF profile_pts: explicit tool.profile_pts, else a
  // known PROFILES entry matched by profile_id / series / Kyokko id. Returns
  // the ordered [x,y] mm loop (tip at origin, Y up) or null. Shared by the
  // punch() art AND the SIM animation (window.KD_TOOLART.profileFor) so both
  // draw the same real silhouette.
  function resolveProfile(tool) {
    if (!tool) return null;
    if (Object.prototype.toString.call(tool.profile_pts) === '[object Array]' && tool.profile_pts.length >= 3) {
      return tool.profile_pts;
    }
    var pkey = tool.profile_id || tool.series || null;
    if (!pkey && typeof tool.id === 'string') { var pm = tool.id.match(/KYOKKO-([^-]+)-/); if (pm) pkey = pm[1]; }
    return (pkey && PROFILES[pkey]) ? PROFILES[pkey] : null;
  }

  // ---- PUNCH (tip points DOWN) -----------------------------------------
  // All coords are in mm-scale. ViewBox auto-fits with padding.
  function punch(tool, opt) {
    opt = opt || {};
    var w = opt.w || 90, h = opt.h || 120;
    var type = (tool && tool.type) || 'standard';
    var ang = (tool && tool.angle_deg != null) ? tool.angle_deg : 88;
    var R = (tool && tool.tip_radius_mm != null) ? tool.tip_radius_mm : 0.8;
    var H = (tool && tool.height_mm != null) ? tool.height_mm : 120;
    
    var showDims = !!opt.showDimensions;

    // All drawing in a local coordinate system:
    // Origin at tip (0,0), Y axis going UP. This means:
    //   tip = (0, 0)
    //   mount top = (0, H)
    // We'll flip Y at the end via viewBox.

    var tangH = 32;  // Amada mount height
    var halfAng = clamp(ang, 10, 120) / 2;
    
    // Body calculations
    var bodyW = 28;
    var rise = (bodyW / 2) / tan(halfAng);
    var maxRise = H - tangH - 13;  // leave room for mount + transition
    var actualRise = Math.min(rise, maxRise);
    var shoulderW = actualRise * tan(halfAng);

    // Tip rounded shape
    var tipR = Math.max(0.4, Math.min(R, 2.5));
    var dx = tipR * cos(halfAng);
    var dy = tipR * sin(halfAng);

    // Build path points (tip at bottom, mount at top). Y increases upward.
    var points = [];

    // Start with the mount/tang (top part)
    var tangBot = H - tangH;  // bottom of tang
    var tangTop = H;          // top of tang

    // We build a clockwise path starting from tang top-left
    // Tang: centered at x=0, width 14 (-7 to +7)
    var tangPath = '';
    // Safety hook detail on left side
    tangPath = 'M -7,' + tangTop;
    tangPath += ' L 7,' + tangTop;
    tangPath += ' L 7,' + (tangBot + 2);
    tangPath += ' L 5,' + (tangBot + 2);
    tangPath += ' L 5,' + tangBot;

    // Transition to body right side
    var bodyPath = '';
    var hookPath = '';
    
    if (type === 'hemming') {
      // Flat flattening surface at bottom
      bodyPath = ' L 14,' + (tangBot - 4);
      bodyPath += ' L 14,' + 8;
      bodyPath += ' L 12,' + 6;
      bodyPath += ' L 12,' + 0;
      bodyPath += ' L -12,' + 0;
      bodyPath += ' L -12,' + 6;
      bodyPath += ' L -14,' + 8;
      bodyPath += ' L -14,' + (tangBot - 4);
    } else if (type === 'gooseneck') {
      // Gooseneck profile matching Kyokko #462/#452 catalog
      var Bh = tangBot;  // body height from tip to tang bottom
      
      // Right side: 45° diagonal bevel from top to middle, then straight down to tip area
      var rx_top = 14;                    // right shoulder at tang
      var ry_top = tangBot - 4;           // just below tang
      var rx_wide = 24;                   // widest point of right cheek
      var ry_wide = Bh * 0.3;            // about 30% up from tip
      var rx_low = 24;                    // stays wide near tip
      var ry_low = dy + (rx_low - dx);    // meets tip face at 45° (roughly)

      // Left side: deep throat concavity (the gooseneck relief)
      // Neck dimensions: 9mm physical thickness on the real tool
      var neckT = 9 * (Bh / 90);         // scale neck thickness to body height
      var neckH = neckT * 1.414;          // horizontal shift for 45° slope

      // Left side intersection (where left tip face 45° meets left neck 45°)
      var xIntersect = -neckH / 2;
      var yIntersect = dy + dx - neckH / 2;

      // Neck top end (same height as right wide corner)
      var yNeckEnd = ry_low;
      var xNeckEnd = xIntersect + (yIntersect - yNeckEnd);  // 45° upward-right

      // Throat: deep concave pocket to the right
      var throatX = 10;
      var throatY = Bh * 0.45;

      // Right side path (top to bottom)
      bodyPath = ' L ' + rx_top + ',' + ry_top;
      bodyPath += ' L ' + rx_wide + ',' + ry_wide;
      bodyPath += ' L ' + rx_low + ',' + ry_low;

      // Right tip face
      bodyPath += ' L ' + dx + ',' + dy;

      // Tip arc
      bodyPath += ' Q 0,0 ' + (-dx) + ',' + dy;

      // Left tip face up to intersect
      bodyPath += ' L ' + xIntersect + ',' + yIntersect;

      // Left neck diagonal going up
      bodyPath += ' L ' + xNeckEnd + ',' + yNeckEnd;

      // Throat curve (deep concave pocket)
      bodyPath += ' Q ' + throatX + ',' + (throatY + (yNeckEnd - throatY) * 0.5) + ' ' + throatX + ',' + throatY;

      // From throat to left shoulder going up with curves
      bodyPath += ' Q -14,' + (Bh * 0.3) + ' -14,' + (Bh * 0.15);

      // Left shoulder to tang
      bodyPath += ' L -14,' + (tangBot - 4);
    } else if (type === 'sash') {
      // Sash punch (Kyokko #202) — SYMMETRIC profile rebuilt from เอ๋'s
      // engineering drawing (Punch No.202 88° R0.2). tip-down, mirror about
      // x=0. Heights reference overall H=130; scale s = H/130.
      //   tang top 26.17 (notch 23.17) · neck 13.17 · foot 18 · 88° R0.2 tip
      //   key heights: tang 130→112.5 · 135° bevel ends 105 · foot ~16→tip
      var s = H / 130;
      var halfTw   = (tool && tool.tang_w_mm ? tool.tang_w_mm : 26.17) / 2 * s; // 13.09
      var halfStep = 23.17 / 2 * s;   // tang top notch 11.59
      var halfNeck = (tool && tool.neck_w_mm ? tool.neck_w_mm : 13.17) / 2 * s; // 6.59
      var halfFoot = (tool && tool.tip_w_mm ? tool.tip_w_mm : 18) / 2 * s;      // 9.0
      var yTangBot = 112.5 * s;
      var yBevel   = 105 * s;         // 135° upper bevel ends → neck
      var yNeckBot = 16 * s;          // neck bottom → flare out to foot
      var flareH   = (halfFoot - halfNeck);
      var yFootTop = yNeckBot - flareH;
      var yFootBot = halfFoot / tan(halfAng);   // 88° tip face reaches the foot half-width here
      if (yFootBot >= yFootTop - 1) yFootBot = Math.max(dy + 1, yFootTop - 2);
      var stepD    = 2 * s;           // tang top notch depth

      // TANG: top edge with a centered step notch, then right wall down
      tangPath  = 'M ' + (-halfTw) + ',' + H;
      tangPath += ' L ' + (-halfStep) + ',' + H;
      tangPath += ' L ' + (-halfStep) + ',' + (H - stepD);
      tangPath += ' L ' + ( halfStep) + ',' + (H - stepD);
      tangPath += ' L ' + ( halfStep) + ',' + H;
      tangPath += ' L ' + ( halfTw) + ',' + H;
      tangPath += ' L ' + ( halfTw) + ',' + yTangBot;

      // RIGHT side down: 135° bevel → straight neck → flare → foot → 88° tip
      bodyPath  = ' L ' + ( halfNeck) + ',' + yBevel;
      bodyPath += ' L ' + ( halfNeck) + ',' + yNeckBot;
      bodyPath += ' L ' + ( halfFoot) + ',' + yFootTop;
      bodyPath += ' L ' + ( halfFoot) + ',' + yFootBot;
      bodyPath += ' L ' + dx + ',' + dy;
      // R0.2 tip arc
      bodyPath += ' Q 0,0 ' + (-dx) + ',' + dy;
      // LEFT side up (mirror)
      bodyPath += ' L ' + (-halfFoot) + ',' + yFootBot;
      bodyPath += ' L ' + (-halfFoot) + ',' + yFootTop;
      bodyPath += ' L ' + (-halfNeck) + ',' + yNeckBot;
      bodyPath += ' L ' + (-halfNeck) + ',' + yBevel;
      bodyPath += ' L ' + (-halfTw) + ',' + yTangBot;
      hookPath  = ' Z';   // symmetric — close back to the tang top-left
    } else {
      // Standard / acute — based on actual DXF geometry (Kyokko No.202)
      // Body width from tool spec or default 10mm
      var bw = (tool && tool.body_w_mm) ? tool.body_w_mm : 10;
      var halfBw = bw / 2;
      
      // Tang from DXF: 30mm wide × 13mm tall, with step notch
      var tw = (tool && tool.tang_w_mm) ? tool.tang_w_mm : 30;
      var tangHdxf = 13;
      var tangBot = H - tangHdxf;
      var tangTop = H;
      
      // Step/notch on tang: 3mm deep, 7.5mm wide
      var stepW = 7.5;
      var stepD = 3;
      var stepLeft = halfBw;
      var stepRight = stepLeft + stepW;
      
      // 45° bevel from tang to body
      var bevelSize = tangHdxf - halfBw;
      var shoulderH = tangBot - bevelSize;
      
      // Tip angle geometry
      var tipRise = (halfBw) / tan(halfAng);
      var maxTipRise = shoulderH - 4;
      var actualTipRise = Math.min(tipRise, maxTipRise);
      var tipSW = actualTipRise * tan(halfAng);

      // Path: clockwise from tang top-left
      tangPath = 'M ' + (-tw/2) + ',' + tangTop;
      // Top of tang with step notch
      tangPath += ' L ' + stepRight + ',' + tangTop;
      tangPath += ' L ' + stepRight + ',' + (tangTop - stepD);
      tangPath += ' L ' + stepLeft + ',' + (tangTop - stepD);
      tangPath += ' L ' + stepLeft + ',' + tangTop;
      tangPath += ' L ' + (tw/2) + ',' + tangTop;
      // Tang right wall down
      tangPath += ' L ' + (tw/2) + ',' + tangBot;

      // Right 45° bevel to body
      bodyPath = ' L ' + halfBw + ',' + shoulderH;
      // Body right wall down
      bodyPath += ' L ' + halfBw + ',' + actualTipRise;
      // Right tip face
      bodyPath += ' L ' + tipSW + ',' + actualTipRise;
      bodyPath += ' L ' + dx + ',' + dy;
      // Tip arc
      bodyPath += ' Q 0,0 ' + (-dx) + ',' + dy;
      // Left tip face up
      bodyPath += ' L ' + (-tipSW) + ',' + actualTipRise;
      bodyPath += ' L ' + (-halfBw) + ',' + actualTipRise;
      // Body left wall up
      bodyPath += ' L ' + (-halfBw) + ',' + shoulderH;
      // Left 45° bevel to tang
      bodyPath += ' L ' + (-tangHdxf/2) + ',' + tangBot;

      // Left tang hook
      hookPath = ' L ' + (-halfBw) + ',' + tangBot;
      hookPath += ' L ' + (-halfBw) + ',' + (tangBot + 2);
      hookPath += ' L ' + (-(halfBw+2)) + ',' + (tangBot + 7);
      hookPath += ' L ' + (-(halfBw+2)) + ',' + (tangBot + 13);
      hookPath += ' L ' + (-tw/2) + ',' + tangTop;
      hookPath += ' Z';
    }

    // For gooseneck/hemming types, use the generic hook path
    if (type !== 'standard' && type !== 'acute' && type !== 'sash') {
      hookPath = ' L -5,' + (H - tangH);
      hookPath += ' L -5,' + (H - tangH + 2);
      hookPath += ' L -7,' + (H - tangH + 7);
      hookPath += ' L -7,' + (H - tangH + 13);
      hookPath += ' L -5,' + (H - tangH + 16);
      hookPath += ' L -5,' + (H - tangH + 23);
      hookPath += ' L -7,' + (H - tangH + 26);
      hookPath += ' L -7,' + H;
      hookPath += ' Z';
    }

    // EXACT-profile mode: tool.profile_pts = ordered [x,y] mm loop (tip at
    // origin, Y up) lifted straight from the tool's DXF (the "Visible" layer).
    // Renders the real silhouette 1:1 instead of the parametric approximation.
    // Resolve an exact DXF profile (shared with the SIM via profileFor below).
    var resolvedPts = resolveProfile(tool);
    var usePts = !!resolvedPts;
    var fullPath, minX, maxX, minY, maxY;
    var padX = 8, padY = 8;
    if (usePts) {
      var pts = resolvedPts;
      fullPath = 'M ' + pts[0][0] + ',' + pts[0][1];
      for (var pi = 1; pi < pts.length; pi++) fullPath += ' L ' + pts[pi][0] + ',' + pts[pi][1];
      fullPath += ' Z';
      var pxs = pts.map(function (p) { return p[0]; });
      var pys = pts.map(function (p) { return p[1]; });
      minX = Math.min.apply(null, pxs) - padX;
      maxX = Math.max.apply(null, pxs) + padX;
      minY = Math.min.apply(null, pys) - padY;
      maxY = Math.max.apply(null, pys) + padY;
    } else {
      fullPath = tangPath + bodyPath + hookPath;
      // Approximate: X from -24 to +24, Y from 0 to H
      minX = -28 - padX;
      maxX = 28 + padX;
      minY = -2 - padY;
      maxY = H + padY;
    }

    // SVG flips Y: we transform (x, y_local) -> (x - minX, maxY - y_local)
    var vw = maxX - minX;
    var vh = maxY - minY;
    
    // Build the SVG with a transform that flips Y and translates
    var transform = 'translate(' + (-minX) + ',' + maxY + ') scale(1,-1)';

    var defs = '';
    var dims = '';
    var fillAttr = '#6c757d';
    var strokeAttr = '#495057';
    var strokeWidth = '1';

    if (showDims) {
      defs = '<defs>' +
             '<marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">' +
             '<path d="M 0 0 L 10 5 L 0 10 z" fill="#4ecca3" />' +
             '</marker>' +
             '</defs>';

      // Height dimension (left side) — in FLIPPED Y coords (SVG y = maxY - local_y)
      var dimX_svg = -minX - 20;
      var topY_svg = maxY - H;
      var tipY_svg = maxY;
      dims += '<!-- Height -->';
      dims += '<line x1="' + (-minX - 14) + '" y1="' + topY_svg + '" x2="' + (dimX_svg - 4) + '" y2="' + topY_svg + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />';
      dims += '<line x1="' + (-minX - 14) + '" y1="' + tipY_svg + '" x2="' + (dimX_svg - 4) + '" y2="' + tipY_svg + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />';
      dims += '<line x1="' + dimX_svg + '" y1="' + topY_svg + '" x2="' + dimX_svg + '" y2="' + tipY_svg + '" stroke="#4ecca3" stroke-width="1" marker-start="url(#arrow)" marker-end="url(#arrow)" />';
      dims += '<text x="' + (dimX_svg + 4) + '" y="' + ((topY_svg + tipY_svg) / 2) + '" fill="#4ecca3" font-size="9.5" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="start" alignment-baseline="middle">' + H + ' mm</text>';

      if (type !== 'hemming') {
        // Angle dimension (arc near tip)
        var arcR = 18;
        var ax1_svg = -minX - arcR * sin(halfAng);
        var ay1_svg = maxY - arcR * cos(halfAng);
        var ax2_svg = -minX + arcR * sin(halfAng);
        var ay2_svg = maxY - arcR * cos(halfAng);
        dims += '<!-- Angle -->';
        dims += '<path d="M ' + ax1_svg + ',' + ay1_svg + ' A ' + arcR + ',' + arcR + ' 0 0,1 ' + ax2_svg + ',' + ay2_svg + '" fill="none" stroke="#4ecca3" stroke-width="1.2" stroke-dasharray="2 2" marker-start="url(#arrow)" marker-end="url(#arrow)" />';
        dims += '<text x="' + (-minX) + '" y="' + (maxY - arcR - 8) + '" fill="#4ecca3" font-size="9.5" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="middle">' + ang + '°</text>';

        // Tip radius dimension
        var lx1 = -minX + 16;
        var ly1 = maxY - 16;
        var lx2 = -minX + 1.5;
        var ly2 = maxY - 1.5;
        dims += '<!-- Tip Radius -->';
        dims += '<line x1="' + lx1 + '" y1="' + ly1 + '" x2="' + lx2 + '" y2="' + ly2 + '" stroke="#4ecca3" stroke-width="1" marker-end="url(#arrow)" />';
        dims += '<text x="' + (lx1 + 3) + '" y="' + (ly1 - 2) + '" fill="#4ecca3" font-size="9.5" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="start">R' + R + '</text>';
      } else {
        dims += '<!-- Hem width -->';
        var hw_l = -minX - 12;
        var hw_r = -minX + 12;
        var hw_y = maxY + 8;
        dims += '<line x1="' + hw_l + '" y1="' + (maxY + 4) + '" x2="' + hw_l + '" y2="' + (hw_y + 2) + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />';
        dims += '<line x1="' + hw_r + '" y1="' + (maxY + 4) + '" x2="' + hw_r + '" y2="' + (hw_y + 2) + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />';
        dims += '<line x1="' + hw_l + '" y1="' + hw_y + '" x2="' + hw_r + '" y2="' + hw_y + '" stroke="#4ecca3" stroke-width="1" marker-start="url(#arrow)" marker-end="url(#arrow)" />';
        dims += '<text x="' + (-minX) + '" y="' + (hw_y + 12) + '" fill="#4ecca3" font-size="9" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="middle">Flat 24mm</text>';
      }
    }

    var drawContent = defs +
      '<g transform="' + transform + '">' +
      '<path d="' + fullPath + '" fill="' + fillAttr + '" stroke="' + strokeAttr + '" stroke-width="' + strokeWidth + '" stroke-linejoin="round" fill-rule="evenodd" />' +
      '</g>' +
      dims;

    return _svg(w, h, vw, vh, 0, 0, drawContent);
  }

  // ---- DIE (V groove opens UP) -----------------------------------------
  function die(tool, opt) {
    opt = opt || {};
    var w = opt.w || 120, h = opt.h || 74;
    var type = (tool && tool.type) || '1V';
    var ang = (tool && tool.angle_deg != null) ? tool.angle_deg : 88;
    var vlist = (tool && tool.v_list) || [12];
    var H = (tool && tool.height_mm != null) ? tool.height_mm : 60;
    
    var showDims = !!opt.showDimensions;
    var halfAng = clamp(ang, 10, 120) / 2;

    // Die in local coords: top surface at y=0, body extends downward (negative Y)
    // V groove opens upward into the body
    var path = '';
    var blockW = 0;
    var left = 0, right = 0;
    var V1 = vlist[0], V2 = vlist.length >= 2 ? vlist[1] : V1;
    var cx1 = 0, cx2 = 0;

    if (type === '2V' && vlist.length >= 2) {
      var spacing = Math.max(22, (V1 + V2) * 1.1);
      cx1 = -spacing / 2;
      cx2 = spacing / 2;
      blockW = spacing + (V1 + V2) * 1.1 + 18;
      blockW = clamp(blockW, 55, 126);
      left = -blockW / 2;
      right = blockW / 2;

      var depth1 = (V1 / 2) / tan(halfAng);
      var apexY1 = Math.min(depth1, H - 12);
      var depth2 = (V2 / 2) / tan(halfAng);
      var apexY2 = Math.min(depth2, H - 12);

      path = 'M ' + left + ',' + (-H);
      path += ' L ' + left + ',0';
      path += ' L ' + (cx1 - V1 / 2) + ',0';
      path += ' L ' + cx1 + ',' + (-apexY1);
      path += ' L ' + (cx1 + V1 / 2) + ',0';
      path += ' L ' + (cx2 - V2 / 2) + ',0';
      path += ' L ' + cx2 + ',' + (-apexY2);
      path += ' L ' + (cx2 + V2 / 2) + ',0';
      path += ' L ' + right + ',0';
      path += ' L ' + right + ',' + (-H) + ' Z';
    } else {
      var V = vlist[0];
      blockW = Math.max(34, V * 2.2);
      blockW = clamp(blockW, 36, 126);
      left = -blockW / 2;
      right = blockW / 2;

      var depth = (V / 2) / tan(halfAng);
      var apexY = Math.min(depth, H - 12);

      path = 'M ' + left + ',' + (-H);
      path += ' L ' + left + ',0';
      path += ' L ' + (-V / 2) + ',0';
      path += ' L 0,' + (-apexY);
      path += ' L ' + (V / 2) + ',0';
      path += ' L ' + right + ',0';
      path += ' L ' + right + ',' + (-H) + ' Z';
    }

    // ViewBox: die body from left to right, top=0 to bottom=-H
    var padX = 8, padY = 8;
    var minX = left - padX;
    var maxX = right + padX;
    var vw = maxX - minX;
    var vh = H + padY * 2;

    // Transform: flip Y so y=0 is at top of SVG, y=H is at bottom
    // SVG coords: x_svg = x - minX, y_svg = -y + padY  (since die goes negative Y downward)
    var transform = 'translate(' + (-minX) + ',' + padY + ') scale(1,-1)';

    var defs = '';
    var dims = '';
    var fillAttr = '#6c757d';
    var strokeAttr = '#495057';
    var strokeWidth = '1';

    if (showDims) {
      defs = '<defs>' +
             '<marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">' +
             '<path d="M 0 0 L 10 5 L 0 10 z" fill="#4ecca3" />' +
             '</marker>' +
             '</defs>';

      // Height dimension (left side) — in SVG coords
      var dimX_svg = 10;
      var topY_svg = padY;      // top of die in SVG
      var botY_svg = padY + H;  // bottom of die in SVG
      dims += '<!-- Height -->';
      dims += '<line x1="' + ((-minX) + left) + '" y1="' + topY_svg + '" x2="' + (dimX_svg - 4) + '" y2="' + topY_svg + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />';
      dims += '<line x1="' + ((-minX) + left) + '" y1="' + botY_svg + '" x2="' + (dimX_svg - 4) + '" y2="' + botY_svg + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />';
      dims += '<line x1="' + dimX_svg + '" y1="' + topY_svg + '" x2="' + dimX_svg + '" y2="' + botY_svg + '" stroke="#4ecca3" stroke-width="1" marker-start="url(#arrow)" marker-end="url(#arrow)" />';
      dims += '<text x="' + (dimX_svg + 5) + '" y="' + ((topY_svg + botY_svg) / 2) + '" fill="#4ecca3" font-size="9.5" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="start" alignment-baseline="middle">' + H + ' mm</text>';

      if (type === '2V' && vlist.length >= 2) {
        var yDim = padY - 6;
        // V1 width
        var v1_l_svg = (-minX) + cx1 - V1 / 2;
        var v1_r_svg = (-minX) + cx1 + V1 / 2;
        dims += '<line x1="' + v1_l_svg + '" y1="' + padY + '" x2="' + v1_l_svg + '" y2="' + (yDim - 2) + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />';
        dims += '<line x1="' + v1_r_svg + '" y1="' + padY + '" x2="' + v1_r_svg + '" y2="' + (yDim - 2) + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />';
        dims += '<line x1="' + v1_l_svg + '" y1="' + yDim + '" x2="' + v1_r_svg + '" y2="' + yDim + '" stroke="#4ecca3" stroke-width="1" marker-start="url(#arrow)" marker-end="url(#arrow)" />';
        dims += '<text x="' + ((-minX) + cx1) + '" y="' + (yDim - 4) + '" fill="#4ecca3" font-size="9" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="middle">V' + V1 + '</text>';

        // V2 width
        var v2_l_svg = (-minX) + cx2 - V2 / 2;
        var v2_r_svg = (-minX) + cx2 + V2 / 2;
        dims += '<line x1="' + v2_l_svg + '" y1="' + padY + '" x2="' + v2_l_svg + '" y2="' + (yDim - 2) + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />';
        dims += '<line x1="' + v2_r_svg + '" y1="' + padY + '" x2="' + v2_r_svg + '" y2="' + (yDim - 2) + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />';
        dims += '<line x1="' + v2_l_svg + '" y1="' + yDim + '" x2="' + v2_r_svg + '" y2="' + yDim + '" stroke="#4ecca3" stroke-width="1" marker-start="url(#arrow)" marker-end="url(#arrow)" />';
        dims += '<text x="' + ((-minX) + cx2) + '" y="' + (yDim - 4) + '" fill="#4ecca3" font-size="9" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="middle">V' + V2 + '</text>';

        // Angle texts inside V
        var depth1 = (V1 / 2) / tan(halfAng);
        var apexY1_svg = padY + Math.min(depth1, H - 12);
        var depth2 = (V2 / 2) / tan(halfAng);
        var apexY2_svg = padY + Math.min(depth2, H - 12);
        dims += '<text x="' + ((-minX) + cx1) + '" y="' + (apexY1_svg - 8) + '" fill="#4ecca3" font-size="8.5" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="middle">' + ang + '°</text>';
        dims += '<text x="' + ((-minX) + cx2) + '" y="' + (apexY2_svg - 8) + '" fill="#4ecca3" font-size="8.5" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="middle">' + ang + '°</text>';
      } else {
        var V = vlist[0];
        var yDim = padY - 6;
        var v_l_svg = (-minX) - V / 2;
        var v_r_svg = (-minX) + V / 2;
        dims += '<line x1="' + v_l_svg + '" y1="' + padY + '" x2="' + v_l_svg + '" y2="' + (yDim - 2) + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />';
        dims += '<line x1="' + v_r_svg + '" y1="' + padY + '" x2="' + v_r_svg + '" y2="' + (yDim - 2) + '" stroke="#4ecca3" stroke-width="0.8" stroke-dasharray="2 2" />';
        dims += '<line x1="' + v_l_svg + '" y1="' + yDim + '" x2="' + v_r_svg + '" y2="' + yDim + '" stroke="#4ecca3" stroke-width="1" marker-start="url(#arrow)" marker-end="url(#arrow)" />';
        dims += '<text x="' + (-minX) + '" y="' + (yDim - 4) + '" fill="#4ecca3" font-size="10" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="middle">V' + V + '</text>';

        var depth = (V / 2) / tan(halfAng);
        var apexY_svg = padY + Math.min(depth, H - 12);
        dims += '<text x="' + (-minX) + '" y="' + (apexY_svg - 10) + '" fill="#4ecca3" font-size="9.5" font-family="\'Flux Architect\', monospace" font-weight="bold" text-anchor="middle">' + ang + '°</text>';
      }
    }

    var drawContent = defs +
      '<g transform="' + transform + '">' +
      '<path d="' + path + '" fill="' + fillAttr + '" stroke="' + strokeAttr + '" stroke-width="' + strokeWidth + '" stroke-linejoin="round" />' +
      '</g>' +
      dims;

    return _svg(w, h, vw, vh, 0, 0, drawContent);
  }

  function _svg(w, h, vw, vh, vx, vy, inner) {
    return '<svg class="tool-svg" width="' + w + '" height="' + h +
      '" viewBox="' + vx + ' ' + vy + ' ' + vw + ' ' + vh + '" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" preserveAspectRatio="xMidYMid meet">' +
      inner + '</svg>';
  }

  window.KD_TOOLART = { punch: punch, die: die, profileFor: resolveProfile };
})();
