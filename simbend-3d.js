/* simbend-3d.js — isometric 3-D pan/box fold sim for box parts (kind:"box").
 * Reads record.box_geom {base{w,h}, thickness, walls[{id,axis,side,height,width,
 * offset,step,angle_deg,punch,needs_gooseneck,collides,...}]} and folds the walls
 * wall-by-wall in `step` order on an isometric canvas. Each side has a main wall
 * (taller) + a return lip (shorter); the lip folds at its own (earlier) step and
 * rides the wall up (lip-before-wall). Sash vs gooseneck colour; red on collides.
 * Controller interface mirrors simbend-sim.js so app.js can mount either.
 *   window.kdSimBend3D.mount(canvas, record, code) -> controller
 * (เอ๋ box-bending feature 2026-06-04, per spec 2026-06-03-box-bending-collision.)
 */
(function () {
  'use strict';
  var R = Math.PI / 180;
  // Timeline MATCHED to the 2D press (simbend-sim.js: MOVE 450 descend + FOLD 900 fold
  // + HOLD 350, no start offset, END_HOLD 800) so the ISO and the 2D march through the
  // SAME bend at the SAME instant (เอ๋ 2026-06-04 'จุดที่พับต้องตรงกัน'). Here MOVE is the
  // combined descend+fold window (1350) gated by TOUCH≈450/1350; HOLD/END/period match.
  var START = 0, MOVE = 1350, HOLD = 350, END = 800;   // ms — keep MOVE+HOLD = 2D's 1700/step
  var PEN_HI = 34;   // punch tip lift above the bend line when the wall is flat (descends to ~1 when folded)
  var HORN_LEN = 70;    // mm at each punch end where the bottom relief (horn) ramps up
  var HORN_RISE = 20;   // how far the bottom tip lifts at the very ends (top stays flat → #453)

  // ── tool cross-sections (shared by the 3-D fold + the 2-D press view) ──
  // [u across hinge, z up], tip at origin. REAL outlines lifted 1:1 from เอ๋'s clean
  // DXFs: SASH = Kyokko #202, GOOSE = gooseneck #453 (concave throat). TOOL_SCALE
  // shrinks them so the real-mm tool doesn't dwarf small flanges.
  var TOOL_SCALE = 0.5;
  function scaleProf(p, k) { return p.map(function (q) { return [q[0] * k, q[1] * k]; }); }
  var DIE_PROF = [[-13, 0], [-4, 0], [0, -6], [4, 0], [13, 0], [13, -16], [-13, -16]];
  var SASH_PROF = scaleProf([[0,0],[12.728,12.728],[12.728,87],[20.728,95],[20.728,105],[17.728,105],[17.728,112.5],[20.728,112.5],[20.728,130],[7.728,130],[7.728,100],[-5.272,100],[-5.272,95],[2.728,87],[2.728,13.618],[-5.444,5.445]], TOOL_SCALE);
  var GOOSE_PROF = scaleProf([[0,0],[4.09,4.39],[4.09,4.85],[8.9,10],[20.31,22.24],[28.65,31.18],[49,53],[49,77],[36,90],[20,90],[20,95],[17,95],[17,103],[20,103],[17,120],[7,120],[7,90],[-7,90],[-7,81],[11.84,61.5],[13.01,60.13],[14.01,58.62],[14.82,57.01],[15.43,55.31],[15.84,53.56],[16.03,51.76],[16,49.95],[15.76,48.17],[15.3,46.42],[14.64,44.74],[8.32,31.18],[4.15,22.24],[-1.56,10],[-4.24,4.25]], TOOL_SCALE);

  function mount(canvas, record, code) {
    var box = record && record.box_geom;
    if (!box || !canvas) return null;
    var ctx = canvas.getContext('2d');
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    var base = box.base || { w: 200, h: 200 };
    var allWalls = (box.walls || []).slice();
    if (!allWalls.length) return null;

    var activeTlen = 0;
    function getStepForFlapName(name) {
      var axis = name.charAt(0); // 'X' or 'Y'
      var side = name.charAt(1) === 'p' ? '+' : '-';
      var isLip = name.charAt(2) === 'l';
      
      var matching = allWalls.filter(function (w) {
        return w.axis === axis && w.side === side;
      });
      if (matching.length === 0) return 0;
      matching.sort(function (a, b) { return a.height - b.height; });
      var wallObj = isLip ? matching[0] : (matching[1] || matching[0]);
      return wallObj ? wallObj.step : 0;
    }

    // ── pair each side's main wall (taller) with its return lip (shorter) ──
    var groups = {};
    allWalls.forEach(function (w) {
      var k = w.axis + w.side;
      (groups[k] = groups[k] || []).push(w);
    });
    var pairs = [];   // {main, lip|null}
    Object.keys(groups).forEach(function (k) {
      var g = groups[k].slice().sort(function (a, b) { return b.height - a.height; });
      pairs.push({ main: g[0], lip: g[1] || null });
    });
    var nSteps = allWalls.length;
    var maxStep = allWalls.reduce(function (m, w) { return Math.max(m, w.step || 0); }, 0);
    var totalT = START + maxStep * (MOVE + HOLD) + END;
    var overridePunchId = 'AUTO';
    var overridePunchType = 'AUTO';
    var overrideDieId = 'AUTO';
    var overrideDieV = 'AUTO';
    var overrideDieAngle = 'AUTO';
    var overrideDieType = 'AUTO';
    var overrideDieVList = 'AUTO';
    // ONE tooling set for the whole job (เอ๋: don't swap tools — set up once, bend all
    // steps). If any wall needs a gooseneck, the gooseneck #453 covers every bend.
    var ONE_GOOSE = allWalls.some(function (x) { return x.punch === 'gooseneck' || x.needs_gooseneck; });
    // ONE tool LENGTH for every step: sized to the LONG side (เอ๋ — size to the long
    // wall, bend the short side first, never resize). Clamped so the bar still clears
    // the perpendicular (short) walls standing when the long walls are bent last.
    var _longWall = allWalls.reduce(function (a, b) {
      return (b.width > a.width || (b.width === a.width && b.height > a.height)) ? b : a;
    });
    // full long-side length; the horns (raised bottom at the ends) clear the
    // standing short walls — so the bar isn't shortened (เอ๋: หลบด้วย horn).
    var ONE_TOOL_HALF = _longWall.width / 2;
    // #202 is the default, but a pan that needs the clearance is correctly bent with
    // the gooseneck #453 (เอ๋: "กรณีนี้ที่ถูกคือ 453") — concave horn ends + throat.
    var USE_GOOSE = allWalls.some(function (x) { return x.needs_gooseneck || x.punch === 'gooseneck'; });
    // resolve the punch for a step from the per-bend override (เอ๋: เปลี่ยนมีดใน dropdown
    // แล้วภาพต้องเปลี่ยนตาม). AUTO → gooseneck if the pan needs it, else #202 sash.
    function punchForStep(step) {
      var pid = '';
      if (overridePunchId && overridePunchId !== 'AUTO') {
        pid = overridePunchId.toUpperCase();
      } else {
        var b = (record.per_bend || []).filter(function (x) { return x.step === step; })[0];
        pid = (b && b.punch && b.punch !== 'AUTO') ? ('' + b.punch).toUpperCase() : '';
      }
      if (pid.indexOf('202') >= 0 || pid.indexOf('SASH') >= 0) return { prof: SASH_PROF, goose: false, name: '#202 SASH' };
      if (pid.indexOf('453') >= 0 || pid.indexOf('GN') >= 0 || pid.indexOf('GOOSE') >= 0) return { prof: GOOSE_PROF, goose: true, name: 'GOOSENECK #453' };
      if (pid.indexOf('109') >= 0) return { prof: SASH_PROF, goose: false, name: '#109' };
      return USE_GOOSE ? { prof: GOOSE_PROF, goose: true, name: 'GOOSENECK #453' } : { prof: SASH_PROF, goose: false, name: '#202 SASH' };
    }

    // fold fraction 0..1 for a given step at time t
    function frac(step, t) {
      var s = START + (step - 1) * (MOVE + HOLD);
      if (t < s) return 0;
      if (t >= s + MOVE) return 1;
      return (t - s) / MOVE;
    }
    // The punch must first come DOWN and touch the sheet, THEN the sheet tips up into
    // the V (เอ๋: "มีดกดลงโดนแผ่น แผ่นถึงค่อยๆกระดกเป็นรูปตัว V"). So the FOLD is gated to
    // the back part of the move while the punch descends over the front part.
    var TOUCH = 0.333;   // = 2D MOVE(450) / 3D MOVE(1350): punch finishes descending, then folds
    function gfold(step, t) { var f = frac(step, t); return f <= TOUCH ? 0 : (f - TOUCH) / (1 - TOUCH); }
    function gpunchZ(f) { return f < TOUCH ? PEN_HI * (1 - f / TOUCH) + 1 : 1; }   // descends to the sheet, then rides it

    // ── 3-D point builders (z up; base in z=0 plane, centred at origin) ──
    function wallQuad(w, deg) {
      // fold the DEVELOPED strip (flat_len from the real flat pattern) so the blank
      // unrolls truthfully; fall back to the mould height if flat_len is absent.
      var th = deg * R, off = w.offset, h = (w.flat_len != null ? w.flat_len : w.height), hw = w.width / 2;
      var sg = w.side === '+' ? 1 : -1;
      var cz = Math.sin(th) * h, cc = off + Math.cos(th) * h;
      if (w.axis === 'X') {
        return [{ x: sg * off, y: -hw, z: 0 }, { x: sg * off, y: hw, z: 0 },
                { x: sg * cc, y: hw, z: cz }, { x: sg * cc, y: -hw, z: cz }];
      }
      return [{ x: -hw, y: sg * off, z: 0 }, { x: hw, y: sg * off, z: 0 },
              { x: hw, y: sg * cc, z: cz }, { x: -hw, y: sg * cc, z: cz }];
    }
    // lip rides the wall: total bend = wallDeg + lipDeg from horizontal-outward.
    function lipQuad(main, mainDeg, lip, lipDeg) {
      var fe = wallQuad(main, mainDeg);           // main free edge = pts [2],[3]
      var a = fe[3], b = fe[2];                    // free-edge corners
      var tot = (mainDeg + lipDeg) * R, h = (lip.flat_len != null ? lip.flat_len : lip.height);
      var sg = main.side === '+' ? 1 : -1;
      var dx, dy, dz = Math.sin(tot) * h, c = Math.cos(tot) * h;
      if (main.axis === 'X') { dx = sg * c; dy = 0; } else { dx = 0; dy = sg * c; }
      return [a, b, { x: b.x + dx, y: b.y + dy, z: b.z + dz },
                    { x: a.x + dx, y: a.y + dy, z: a.z + dz }];
    }
    function baseQuad() {
      var hw = base.w / 2, hh = base.h / 2;
      return [{ x: -hw, y: -hh, z: 0 }, { x: hw, y: -hh, z: 0 },
              { x: hw, y: hh, z: 0 }, { x: -hw, y: hh, z: 0 }];
    }

    // ── REAL flat-pattern fold (เอ๋): clip the developed outline — which carries the
    // 45° corner reliefs — into base + 4 walls + 4 lips by the BEND lines, then fold
    // each strip up around its bend line in step order (lips ride their wall). Used
    // when box_geom.flat_pattern is present; else the box_geom rectangular fold below
    // is the fallback. ──
    var FP = box.flat_pattern;
    var FLAT = !!(FP && FP.outline && FP.outline.length >= 3 && FP.bend_lines && FP.bend_lines.length >= 8);
    var fpBase = null, fpFlaps = [], fpCx = 0, fpCy = 0, fpHalfW = base.w / 2, fpHalfH = base.h / 2;
    function clipHP(poly, inside, inter) {
      var out = [], n = poly.length;
      for (var i = 0; i < n; i++) {
        var a = poly[i], b = poly[(i + 1) % n], ina = inside(a), inb = inside(b);
        if (ina) out.push(a);
        if (ina !== inb) out.push(inter(a, b));
      }
      return out;
    }
    function clipRect(poly, x0, x1, y0, y1) {
      var p = poly;
      p = clipHP(p, function (q) { return q[0] >= x0; }, function (a, b) { return [x0, a[1] + (b[1]-a[1])*(x0-a[0])/(b[0]-a[0])]; });
      p = clipHP(p, function (q) { return q[0] <= x1; }, function (a, b) { return [x1, a[1] + (b[1]-a[1])*(x1-a[0])/(b[0]-a[0])]; });
      p = clipHP(p, function (q) { return q[1] >= y0; }, function (a, b) { return [a[0] + (b[0]-a[0])*(y0-a[1])/(b[1]-a[1]), y0]; });
      p = clipHP(p, function (q) { return q[1] <= y1; }, function (a, b) { return [a[0] + (b[0]-a[0])*(y1-a[1])/(b[1]-a[1]), y1]; });
      return p;
    }
    if (FLAT) (function buildFP() {
      var poly = FP.outline.map(function (p) { return [p[0], p[1]]; });
      var vx = [], hy = [];
      FP.bend_lines.forEach(function (s) {
        if (Math.abs(s[0][0] - s[1][0]) < 1) vx.push((s[0][0] + s[1][0]) / 2);
        else hy.push((s[0][1] + s[1][1]) / 2);
      });
      vx.sort(function (a, b) { return a - b; }); hy.sort(function (a, b) { return a - b; });
      if (vx.length < 4 || hy.length < 4) { FLAT = false; return; }
      var bx0 = vx[1], bx1 = vx[2], by0 = hy[1], by1 = hy[2], BIG = 1e4;
      fpCx = (bx0 + bx1) / 2; fpCy = (by0 + by1) / 2; fpHalfW = (bx1 - bx0) / 2; fpHalfH = (by1 - by0) / 2;
      fpBase = clipRect(poly, bx0, bx1, by0, by1);
      var defs = [   // name, axis, foldLine, side, rect, wallLine(lip only)
        ['Xnw', 'V', bx0, -1, [vx[0], bx0, by0, by1], null],
        ['Xpw', 'V', bx1,  1, [bx1, vx[3], by0, by1], null],
        ['Ynw', 'H', by0, -1, [bx0, bx1, hy[0], by0], null],
        ['Ypw', 'H', by1,  1, [bx0, bx1, by1, hy[3]], null],
        ['Xnl', 'V', vx[0], -1, [-BIG, vx[0], by0, by1], bx0],
        ['Xpl', 'V', vx[3],  1, [vx[3], BIG, by0, by1], bx1],
        ['Ynl', 'H', hy[0], -1, [bx0, bx1, -BIG, hy[0]], by0],
        ['Ypl', 'H', hy[3],  1, [bx0, bx1, hy[3], BIG], by1],
      ];
      defs.forEach(function (d) {
        var r = d[4], pl = clipRect(poly, r[0], r[1], r[2], r[3]);
        var stepNum = getStepForFlapName(d[0]);
        if (pl.length >= 3) fpFlaps.push({ name: d[0], ax: d[1], line: d[2], side: d[3], step: stepNum, wline: d[5], poly: pl });
      });
    })();
    function fvAround(p, X0, side, th) { var dx = p.x - X0; return { x: X0 + dx * Math.cos(th) - side * p.z * Math.sin(th), y: p.y, z: side * dx * Math.sin(th) + p.z * Math.cos(th) }; }
    function fhAround(p, Y0, side, th) { var dy = p.y - Y0; return { x: p.x, y: Y0 + dy * Math.cos(th) - side * p.z * Math.sin(th), z: side * dy * Math.sin(th) + p.z * Math.cos(th) }; }
    function fpStepOf(name) { for (var i = 0; i < fpFlaps.length; i++) if (fpFlaps[i].name === name) return fpFlaps[i].step; return 0; }
    function foldedFlap(fl, t) {
      var F = fl.ax === 'V' ? fvAround : fhAround;
      var L0 = fl.ax === 'V' ? fl.line - fpCx : fl.line - fpCy;
      var p3 = fl.poly.map(function (q) { return { x: q[0] - fpCx, y: q[1] - fpCy, z: 0 }; });
      var thw = gfold(fl.step, t) * Math.PI / 2;
      if (fl.wline != null) {                                    // lip: fold at lip line, then ride the wall
        var wl = fl.ax === 'V' ? fl.wline - fpCx : fl.wline - fpCy;
        var wstep = fpStepOf(fl.name.charAt(0) + fl.name.charAt(1) + 'w');
        var thw2 = gfold(wstep, t) * Math.PI / 2;
        p3 = p3.map(function (p) { return F(p, L0, fl.side, thw); });
        return p3.map(function (p) { return F(p, wl, fl.side, thw2); });
      }
      return p3.map(function (p) { return F(p, L0, fl.side, thw); });
    }
    function fpBasePts() { return fpBase.map(function (q) { return { x: q[0] - fpCx, y: q[1] - fpCy, z: 0 }; }); }
    
    // find return lip heights for axis X and Y (usually 7mm)
    var lipHeightX = 0;
    var lipHeightY = 0;
    allWalls.forEach(function (w) {
      if (w.height < 12) {
        if (w.axis === 'X') lipHeightX = w.height;
        else if (w.axis === 'Y') lipHeightY = w.height;
      }
    });
    // The inner opening = base − 2×(lip DEVELOPED length). The lip is the shortest
    // return; its flat_len (≈6.13) is what projects inward, not the 7mm mould height.
    var lipFlat = Math.min.apply(null, allWalls.map(function (w) {
      return (w.flat_len != null ? w.flat_len : w.height);
    }));
    if (!isFinite(lipFlat) || lipFlat <= 0) lipFlat = 6.13;

    // pseudo-wall for the active flap's tooling (die/punch along the bend line)
    function fpActiveTool(active) {
      var fl = null; fpFlaps.forEach(function (x) { if (x.step === active) fl = x; });
      if (!fl) return null;
      var L0 = fl.ax === 'V' ? fl.line - fpCx : fl.line - fpCy;
      // Punch length = the INNER OPENING of that side (เอ๋ measured it in Fusion:
      // short 186, long 286). The opening = base edge − 2×(the perpendicular returns'
      // flat length). The returns are the LIPS, whose developed length is flat_len≈6.13
      // — NOT the 7mm mould height (that gave 184.26/284.26, ~1.74mm short each side).
      //   V-axis (X-wall, folds along Y): base.h − 2·lip = 198.26 − 12.26 = 186.00
      //   H-axis (Y-wall, folds along X): base.w − 2·lip = 298.26 − 12.26 = 286.00
      var eHalf = Math.max(10, ((fl.ax === 'V' ? base.h : base.w) - 2 * lipFlat) / 2);
      return { axis: fl.ax === 'V' ? 'X' : 'Y', side: fl.side > 0 ? '+' : '-', offset: Math.abs(L0),
               eHalf: eHalf };
    }

    // ── isometric projection (camera az/elev fixed) ──
    var ISO = 26 * R;
    // view from ABOVE: world +z renders UP on screen (tray opens up / หงายขึ้น),
    // so die (z<0) sits at the bottom and the punch (z>0) comes down from the top.
    function iso(p) { return { x: (p.x - p.y) * Math.cos(ISO), y: p.z - (p.x + p.y) * Math.sin(ISO) }; }
    function depth(p) { return p.x + p.y + p.z * 1.5; }   // painter's: bigger = nearer (above-front cam), draw last

    // static scale/centre from the fully-folded bounds (stable, no jump)
    var scale = 1, cx = 0, cy = 0;
    function computeFit(w, h) {
      var pts = FLAT ? fpBasePts() : [].concat(baseQuad());
      if (FLAT) {
        fpFlaps.forEach(function (fl) { pts = pts.concat(foldedFlap(fl, 1e9)); });   // fully folded bounds
        // tooling envelope (#202 punch + die) at each flap bend line so it never clips
        fpFlaps.forEach(function (fl) {
          var pw = { axis: fl.ax === 'V' ? 'X' : 'Y', side: fl.side > 0 ? '+' : '-', offset: Math.abs(fl.ax === 'V' ? fl.line - fpCx : fl.line - fpCy) };
          SASH_PROF.forEach(function (p) { pts.push(csTo3d(pw, p[0], p[1] + PEN_HI, 0)); });
        });
      } else pairs.forEach(function (pr) {
        pts = pts.concat(wallQuad(pr.main, pr.main.angle_deg || 90));
        if (pr.lip) pts = pts.concat(lipQuad(pr.main, pr.main.angle_deg || 90, pr.lip, pr.lip.angle_deg || 90));
        // include the (real, tall) tooling envelope so the punch never clips off-canvas
        var prof = SASH_PROF;   // default tool = Kyokko #202 sash (เอ๋: #202 default everywhere)
        prof.forEach(function (p) { pts.push(csTo3d(pr.main, p[0], p[1] + PEN_HI, 0)); });
        DIE_PROF.forEach(function (p) { pts.push(csTo3d(pr.main, p[0], p[1], 0)); });
      });
      var P = pts.map(iso);
      var minx = Math.min.apply(0, P.map(function (p) { return p.x; }));
      var maxx = Math.max.apply(0, P.map(function (p) { return p.x; }));
      var miny = Math.min.apply(0, P.map(function (p) { return p.y; }));
      var maxy = Math.max.apply(0, P.map(function (p) { return p.y; }));
      var sx = (w * 0.86) / Math.max(1, maxx - minx);
      var sy = (h * 0.74) / Math.max(1, maxy - miny);
      scale = Math.min(sx, sy);
      cx = w / 2 - ((minx + maxx) / 2) * scale;
      cy = h / 2 + ((miny + maxy) / 2) * scale;   // +y because screen y is down and iso y is up
    }
    function toScreen(p) { var q = iso(p); return { x: cx + q.x * scale, y: cy - q.y * scale }; }

    function fillQuad(pts3, fill, stroke, lw) {
      var s = pts3.map(toScreen);
      ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y);
      for (var i = 1; i < s.length; i++) ctx.lineTo(s[i].x, s[i].y);
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = (lw || 1) * dpr; ctx.lineJoin = 'round'; ctx.stroke(); }
    }

    // ── colours ──
    var C_BASE = '#9aa6b2', C_BASE_E = '#5d6b78';
    var C_SASH = '#e8923a', C_GOOSE = '#4a90e2', C_RED = '#e0574a';
    var C_LIP = 'rgba(255,255,255,0.12)';
    var C_DIE = '#737d88', C_DIE_E = '#454e58', C_PUNCH = '#aab3bd', C_PUNCH_E = '#4c555f';

    // press tooling at the active wall's bend line — die (V block, below) + punch
    // (real silhouette, descends from above). One solid bar, gooseneck throat out.
    function csTo3d(w, u, z, e) {
      var sg = w.side === '+' ? 1 : -1, off = w.offset;
      if (w.axis === 'X') return { x: sg * off + u, y: e, z: z };
      return { x: e, y: sg * off + u, z: z };
    }
    // Extrude a tool cross-section as ONE solid bar (เอ๋: no section/segment cuts).
    // eHalf = half-length along the bend line; uSign flips the profile across u so
    // the gooseneck throat (concave) faces OUTSIDE the workpiece.
    function addExtrusion(items, w, prof, zOff, fill, stroke, dbias, eMinOrHalf, uSign, eMax) {
      var eMin, eMaxVal;
      if (eMax !== undefined) {
        eMin = eMinOrHalf;
        eMaxVal = eMax;
      } else {
        var eHalf = eMinOrHalf != null ? eMinOrHalf : w.width / 2;
        eMin = -eHalf;
        eMaxVal = eHalf;
      }
      if (uSign && uSign !== 1) prof = prof.map(function (p) { return [p[0] * uSign, p[1]]; });
      var front = prof.map(function (p) { return csTo3d(w, p[0], p[1] + zOff, eMaxVal); });
      var back = prof.map(function (p) { return csTo3d(w, p[0], p[1] + zOff, eMin); });
      for (var i = 0; i < prof.length; i++) {
        var j = (i + 1) % prof.length;
        var q = [front[i], front[j], back[j], back[i]];
        items.push({ pts: q, fill: fill, stroke: stroke, lw: 1, d: cen(q) + (dbias || 0) });
      }
      items.push({ pts: front, fill: fill, stroke: stroke, lw: 1, d: cen(front) + (dbias || 0) + 0.3 });
      items.push({ pts: back, fill: fill, stroke: stroke, lw: 1, d: cen(back) + (dbias || 0) - 0.3 });
    }
    // The punch as ONE solid bar with a HORN relief: the working tip is flat in the
    // middle and rises toward both ends (top edge stays straight — mounts in the ram),
    // so the ends clear the already-standing perpendicular walls (#453 side profile).
    function sweptPunch(items, w, prof, zBase, eHalf, uSign, fill, stroke, dbias) {
      if (uSign && uSign !== 1) prof = prof.map(function (p) { return [p[0] * uSign, p[1]]; });
      var profH = prof.reduce(function (m, p) { return Math.max(m, p[1]); }, 1);
      var N = 16, slices = [];
      for (var k = 0; k <= N; k++) {
        var e = -eHalf + (2 * eHalf) * k / N;
        var a = Math.abs(e) - (eHalf - HORN_LEN);
        var lift = a > 0 ? Math.min(1, a / HORN_LEN) * HORN_RISE : 0;
        slices.push(prof.map(function (p) { return csTo3d(w, p[0], p[1] + zBase + lift * (1 - p[1] / profH), e); }));
      }
      var n = prof.length;
      for (var s = 0; s < slices.length - 1; s++) {       // solid side facets (filled, no lines)
        var A = slices[s], B = slices[s + 1];
        for (var i = 0; i < n; i++) {
          var j = (i + 1) % n, q = [A[i], A[j], B[j], B[i]];
          items.push({ pts: q, fill: fill, stroke: null, lw: 0, d: cen(q) + (dbias || 0) });
        }
      }
      [0, Math.floor(n / 2)].forEach(function (edge) {     // silhouette runs (tip + a side) define the horn shape
        for (var s2 = 0; s2 < slices.length - 1; s2++) {
          var seg = [slices[s2][edge], slices[s2 + 1][edge], slices[s2 + 1][edge], slices[s2][edge]];
          items.push({ pts: seg, fill: null, stroke: stroke, lw: 1, d: cen(seg) + (dbias || 0) + 0.3 });
        }
      });
      items.push({ pts: slices[0], fill: null, stroke: stroke, lw: 1.2, d: cen(slices[0]) + (dbias || 0) - 0.3 });
      items.push({ pts: slices[slices.length - 1], fill: null, stroke: stroke, lw: 1.2, d: cen(slices[slices.length - 1]) + (dbias || 0) + 0.3 });
    }

    function frame(t) {
      var w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      computeFit(w, h);

      // active step (1-based) at time t
      var active = 0;
      for (var st = 1; st <= maxStep; st++) { if (t >= START + (st - 1) * (MOVE + HOLD)) active = st; }

      // collect drawables (base + folded flaps/walls + lips) with depth + style
      var items = [];
      if (FLAT) {
        // press-brake V (เอ๋ confirmed): while a bend is forming, the WHOLE piece tips
        // up around the active bend line at the die (base + walls rise together), then
        // settles flat as the press completes. The die/punch stay fixed; the part tilts.
        var af = null; fpFlaps.forEach(function (x) { if (x.step === active) af = x; });
        var afL0 = af ? (af.ax === 'V' ? af.line - fpCx : af.line - fpCy) : 0;
        var afF = (af && af.ax === 'V') ? fvAround : fhAround;
        var bump = af ? Math.sin(Math.min(1, gfold(active, t)) * Math.PI) * (30 * R) : 0;   // V tips only after the punch touches
        function vlift(arr) { return (af && bump) ? arr.map(function (p) { return afF(p, afL0, -af.side, bump); }) : arr; }
        items.push({ pts: vlift(fpBasePts()), fill: C_BASE, stroke: C_BASE_E, lw: 1.5, d: depth({ x: 0, y: 0, z: 0 }) - 1e6 });
        fpFlaps.forEach(function (fl) {
          var wObj = null;
          for (var i = 0; i < allWalls.length; i++) {
            if (allWalls[i].step === fl.step) { wObj = allWalls[i]; break; }
          }
          var collides = wObj && wObj.collides;
          var baseCol = collides ? C_RED : C_SASH;
          var fp3 = vlift(foldedFlap(fl, t)), act = (fl.step === active), isLip = fl.wline != null;
          items.push({ pts: fp3, fill: shade(baseCol, act ? 0.98 : (isLip ? 0.6 : 0.82)), stroke: collides ? C_RED : '#2b3340',
                       lw: act ? 2 : 1.1, d: cenN(fp3) + (isLip ? 0.5 : 0) });
        });
        var tw = fpActiveTool(active);
        if (tw && active >= 1) {
          var penZ2 = gpunchZ(frac(active, t));     // punch descends + touches, then rides the sheet up
          var pk = punchForStep(active);            // per-step punch (respects the dropdown override)
          var aw = null; allWalls.forEach(function (x) { if (x.step === active) aw = x; });
          var collides = aw && aw.collides;
          var pFill = collides ? C_RED : C_PUNCH;
          var pStroke = collides ? C_RED : C_PUNCH_E;
          addExtrusion(items, tw, DIE_PROF, 0, C_DIE, C_DIE_E, -3, tw.eHalf, 1);            // die under the active bend (fixed)

          // The curved (gooseneck) punch is a STRAIGHT extrusion CUT FLAT at both ends,
          // SYMMETRIC about the centre (เอ๋ 2026-06-04: "มีดบนล่างเท่ากัน ตัดตรง" — both end
          // caps equal + planar, total length = the side's inner opening 186/286). So we
          // use ±eHalf directly — NO per-side clip (that made the two ends unequal).
          activeTlen = Math.round(2 * tw.eHalf);
          addExtrusion(items, tw, pk.prof, penZ2, pFill, pStroke, 6, tw.eHalf, pk.goose ? (tw.side === '+' ? -1 : 1) : 1);
        }
      } else {
      var bq = baseQuad();
      items.push({ pts: bq, fill: C_BASE, stroke: C_BASE_E, lw: 1.5, d: depth({ x: 0, y: 0, z: 0 }) - 1e6 });
      pairs.forEach(function (pr) {
        var m = pr.main, mw = m.collides ? C_RED : C_SASH;
        var md = (m.angle_deg || 90) * frac(m.step, t);
        var mq = wallQuad(m, md);
        var act = (m.step === active);
        items.push({ pts: mq, fill: shade(mw, act ? 0.95 : 0.78), stroke: m.collides ? C_RED : '#2b3340', lw: act ? 2 : 1.2,
                     d: cen(mq), label: m });
        if (pr.lip) {
          var ld = (pr.lip.angle_deg || 90) * frac(pr.lip.step, t);
          var lq = lipQuad(m, md, pr.lip, ld);
          items.push({ pts: lq, fill: pr.lip.collides ? C_RED : shade(mw, 0.6), stroke: pr.lip.collides ? C_RED : '#2b3340', lw: 1, d: cen(lq) + 0.5 });
        }
      });
      var aw = null; allWalls.forEach(function (x) { if (x.step === active) aw = x; });
      if (aw && active >= 1) {
        var f = frac(aw.step, t);
        var penZ = PEN_HI * (1 - f) + 1;             // punch tip: high when flat → ~0 when folded
        var pFill = aw.collides ? C_RED : C_PUNCH, pStroke = aw.collides ? C_RED : C_PUNCH_E;
        addExtrusion(items, aw, DIE_PROF, 0, C_DIE, C_DIE_E, -3, ONE_TOOL_HALF, 1);
        addExtrusion(items, aw, SASH_PROF, penZ, pFill, pStroke, 6, ONE_TOOL_HALF, 1);
      }
      activeTlen = Math.round(ONE_TOOL_HALF * 2);
      }

      items.sort(function (a, b) { return a.d - b.d; });
      items.forEach(function (it) { fillQuad(it.pts, it.fill, it.stroke, it.lw); });

      drawHud(w, h, active, t);
    }
    function cen(q) { var c = { x: 0, y: 0, z: 0 }; q.forEach(function (p) { c.x += p.x / 4; c.y += p.y / 4; c.z += p.z / 4; }); return depth(c); }
    function cenN(q) { var n = q.length, c = { x: 0, y: 0, z: 0 }; q.forEach(function (p) { c.x += p.x / n; c.y += p.y / n; c.z += p.z / n; }); return depth(c); }
    function shade(hex, k) {
      if (hex.indexOf('#') !== 0) return hex;
      var n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      return 'rgb(' + Math.round(r * k) + ',' + Math.round(g * k) + ',' + Math.round(b * k) + ')';
    }

    function drawHud(w, h, active, t) {
      var wall = null;
      allWalls.forEach(function (x) { if (x.step === active) wall = x; });
      ctx.fillStyle = 'rgba(12,19,27,0.82)'; ctx.fillRect(0, 0, w, 30 * dpr);
      ctx.fillStyle = '#cad6e6'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.font = (12 * dpr) + 'px "Flux Architect", monospace';
      var tlen = activeTlen || Math.round(ONE_TOOL_HALF * 2);
      var hud = wall
        ? ('STEP ' + active + '/' + maxStep + '  ·  ' + wall.id + '  ·  ' + wall.axis + (wall.side || '') +
           '  ·  PUNCH: ' + punchForStep(active).name +
           '  ·  TOOL ' + tlen + 'mm')
        : 'PAN FOLD  ·  ' + pairs.length + ' walls';
      ctx.fillText(hud, 10 * dpr, 15 * dpr);

      if (wall && wall.collides) {
        ctx.fillStyle = C_RED; ctx.textAlign = 'right';
        ctx.font = 'bold ' + (12 * dpr) + 'px "Flux Architect", monospace';
        ctx.fillText('✗ HITS ' + (wall.collides_with || 'WALL'), w - 10 * dpr, 15 * dpr);
      }
      // footer verdict
      var anyCol = allWalls.some(function (x) { return x.collides; });
      ctx.fillStyle = 'rgba(12,19,27,0.82)'; ctx.fillRect(0, h - 26 * dpr, w, 26 * dpr);
      ctx.textAlign = 'left'; ctx.font = 'bold ' + (12 * dpr) + 'px "Flux Architect", monospace';
      if (record.bendable && !anyCol) { ctx.fillStyle = '#4ecca3'; ctx.fillText('✓ BENDABLE (box)  ·  ' + (record.order || []).join(' → '), 10 * dpr, h - 13 * dpr); }
      else { ctx.fillStyle = C_RED; ctx.fillText('✗ ' + (record.reason || 'collision').toUpperCase(), 10 * dpr, h - 13 * dpr); }
    }

    // ── animation loop ──
    var raf = null, startTs = null, paused = false, pauseT = 0, statusCb = null;
    function resize() {
      var cw = canvas.clientWidth || canvas.parentElement && canvas.parentElement.clientWidth || 560;
      canvas.width = Math.round(cw * dpr); canvas.height = Math.round(300 * dpr);
    }
    function loop(ts) {
      if (paused) return;
      if (startTs == null) startTs = ts - pauseT;
      var t = (ts - startTs) % totalT;
      pauseT = t;
      frame(t);
      raf = requestAnimationFrame(loop);
    }
    resize();
    var ro = null;
    try { ro = new ResizeObserver(function () { resize(); frame(pauseT); }); ro.observe(canvas); } catch (e) {}
    raf = requestAnimationFrame(loop);

    return {
      frame: frame,
      setTime: function (val) { pauseT = val; frame(val); },
      destroy: function () { if (raf) cancelAnimationFrame(raf); if (ro) try { ro.disconnect(); } catch (e) {} },
      toggle: function () { paused = !paused; if (!paused) { startTs = null; raf = requestAnimationFrame(loop); } else if (raf) cancelAnimationFrame(raf); },
      isPlaying: function () { return !paused; },
      set onstatus(fn) { statusCb = fn; },
      setPunchOverride: function (id, type) {
        overridePunchId = id;
        overridePunchType = type;
        frame(pauseT);
      },
      setDieOverride: function (id, v, angle, type, vList) {
        overrideDieId = id;
        overrideDieV = v;
        overrideDieAngle = angle;
        overrideDieType = type;
        overrideDieVList = vList;
        frame(pauseT);
      },
      recordClip: function () {
        try {
          var stream = canvas.captureStream(30);
          var rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
          var chunks = [];
          rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
          rec.onstop = function () {
            var blob = new Blob(chunks, { type: 'video/webm' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob); a.download = (code || 'box') + '-fold.webm'; a.click();
            if (statusCb) statusCb('clip saved');
          };
          rec.start(); if (statusCb) statusCb('recording…');
          setTimeout(function () { try { rec.stop(); } catch (e) {} }, Math.min(totalT, 8000));
        } catch (e) { if (statusCb) statusCb('clip not supported'); }
      }
    };
  }

  // ── 2-D press cross-section from the REAL flat pattern (เอ๋): the developed strip
  // ALONG the active bend's axis, at true DXF lengths — X-walls bend in the 343 mm
  // direction (base 298), Y-walls in the 243 mm direction (base 198), so the two are
  // different and you can SEE which side is bending. Bends fold at their Layer-BEND
  // positions, and during the active bend the whole strip tips up at the die (press-
  // brake V), synced to the 3-D step. ──
  function mount2d(canvas, record, code) {
    var box = record && record.box_geom;
    if (!box || !canvas) return null;
    var ctx = canvas.getContext('2d');
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    var walls = (box.walls || []).slice();
    if (!walls.length) return null;
    var maxStep = walls.reduce(function (m, w) { return Math.max(m, w.step || 0); }, 0);
    var totalT = START + maxStep * (MOVE + HOLD) + END;
    var USE_GOOSE = walls.some(function (x) { return x.needs_gooseneck || x.punch === 'gooseneck'; });
    function punchForStep(step) {
      var b = (record.per_bend || []).filter(function (x) { return x.step === step; })[0];
      var pid = (b && b.punch && b.punch !== 'AUTO') ? ('' + b.punch).toUpperCase() : '';
      if (pid.indexOf('202') >= 0 || pid.indexOf('SASH') >= 0) return { prof: SASH_PROF, goose: false, name: '#202' };
      if (pid.indexOf('453') >= 0 || pid.indexOf('GN') >= 0 || pid.indexOf('GOOSE') >= 0) return { prof: GOOSE_PROF, goose: true, name: 'GN#453' };
      if (pid.indexOf('109') >= 0) return { prof: SASH_PROF, goose: false, name: '#109' };
      return USE_GOOSE ? { prof: GOOSE_PROF, goose: true, name: 'GN#453' } : { prof: SASH_PROF, goose: false, name: '#202' };
    }
    function frac(step, t) {
      var s = START + (step - 1) * (MOVE + HOLD);
      if (t < s) return 0; if (t >= s + MOVE) return 1; return (t - s) / MOVE;
    }
    var C_DIE = '#737d88', C_DIE_E = '#454e58', C_PUNCH = '#aab3bd', C_PUNCH_E = '#4c555f',
        C_BASE = '#9aa6b2', C_WALL = '#e8923a', C_LIP = '#c77a2e', C_RED = '#e0574a';
    // developed base half-length along each axis (from the flat pattern; fallback to box.base)
    function baseHalf(axis) {
      if (box.flat_w && box.flat_h) {
        // flat_w spans X (343), flat_h spans Y (243). base = flat − 2*(wall+lip).
        var devSide = 2 * (FLEN_WALL + FLEN_LIP);
        return ((axis === 'X' ? box.flat_w : box.flat_h) - devSide) / 2;
      }
      return (axis === 'X' ? (box.base.w) : (box.base.h)) / 2;
    }
    var FLEN_WALL = 16.26, FLEN_LIP = 6.13;
    walls.forEach(function (w) { if (w.flat_len != null) { if (w.height >= 12) FLEN_WALL = w.flat_len; else FLEN_LIP = w.flat_len; } });

    function frame(t) {
      var W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      var active = 0; for (var st = 1; st <= maxStep; st++) { if (t >= START + (st - 1) * (MOVE + HOLD)) active = st; }
      var aw = null; walls.forEach(function (x) { if (x.step === active) aw = x; });
      var axis = aw ? aw.axis : 'X';
      var bh = baseHalf(axis), total = 2 * (bh + FLEN_WALL + FLEN_LIP);
      var f = frac(active, t), TOUCH2 = 0.34;
      function g2(step) { var ff = frac(step, t); return ff <= TOUCH2 ? 0 : (ff - TOUCH2) / (1 - TOUCH2); }   // gated fold (touch first)
      function sideW(sd, wall) { return walls.filter(function (w) { return w.axis === axis && w.side === (sd > 0 ? '+' : '-') && (wall ? w.height >= 12 : w.height < 12); })[0]; }
      // CUMULATIVE chain: every bend of this axis stays folded at its own step (เอ๋:
      // "เมื่อพับเป็นฉากแล้วต้องคงรูป") — base flat, wall folds up, lip rides the wall.
      function buildSide(sd) {
        var wall = sideW(sd, true), lip = sideW(sd, false);
        var u = sd * bh, z = 0, ang = 0, pts = [[u, z]];                 // [0] wall bend (base edge)
        if (wall) ang += g2(wall.step) * (Math.PI / 2);
        u += sd * FLEN_WALL * Math.cos(ang); z += FLEN_WALL * Math.sin(ang); pts.push([u, z]);   // [1] lip bend
        if (lip) ang += g2(lip.step) * (Math.PI / 2);
        u += sd * FLEN_LIP * Math.cos(ang); z += FLEN_LIP * Math.sin(ang); pts.push([u, z]);     // [2] lip end
        return pts;
      }
      var Rs = buildSide(1), Ls = buildSide(-1);
      var av = [0, 0];                                        // active bend vertex → goes to the die
      if (aw) { var S = aw.side === '+' ? Rs : Ls; av = aw.height >= 12 ? S[0] : S[1]; }
      var bump = Math.sin(Math.min(1, g2(active)) * Math.PI) * (24 * Math.PI / 180);   // press-brake V tilt
      function place(p) { var u = p[0] - av[0], z = p[1] - av[1], c = Math.cos(bump), sn = Math.sin(bump); return [u * c - z * sn, u * sn + z * c]; }
      var chain = [Ls[2], Ls[1], Ls[0], Rs[0], Rs[1], Rs[2]].map(place);
      // fit from the placed chain + punch reach
      var allU = chain.map(function (p) { return p[0]; }), allZ = chain.map(function (p) { return p[1]; });
      var uLo = Math.min.apply(0, allU), uHi = Math.max.apply(0, allU), zLo = Math.min(-18, Math.min.apply(0, allZ)), zHi = Math.max.apply(0, allZ);
      zHi = Math.max(zHi, PEN_HI + 130 * TOOL_SCALE);
      var s = Math.min((W * 0.92) / Math.max(60, uHi - uLo), (H * 0.78) / Math.max(60, zHi - zLo));
      var ox = W / 2 - ((uLo + uHi) / 2) * s, baseY = H / 2 + ((zLo + zHi) / 2) * s;
      function X(u) { return ox + u * s; }
      function Y(z) { return baseY - z * s; }
      function line(pts, col, lw) { ctx.beginPath(); pts.forEach(function (p, i) { var xx = X(p[0]), yy = Y(p[1]); if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy); }); ctx.strokeStyle = col; ctx.lineWidth = lw * dpr; ctx.lineJoin = ctx.lineCap = 'round'; ctx.stroke(); }
      function poly(pts, fill, stroke, lw) { ctx.beginPath(); pts.forEach(function (p, i) { var xx = X(p[0]), yy = Y(p[1]); if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy); }); ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = (lw || 1) * dpr; ctx.lineJoin = 'round'; ctx.stroke(); } }
      poly(DIE_PROF, C_DIE, C_DIE_E, 1);                     // die fixed at the active bend (origin)
      line([chain[1], chain[2]], C_LIP, 6); line([chain[0], chain[1]], C_WALL, 7);   // left lip + wall
      line([chain[2], chain[3]], C_BASE, 7);                                         // base (cumulative shape held)
      line([chain[3], chain[4]], C_WALL, 7); line([chain[4], chain[5]], C_LIP, 6);   // right wall + lip
      var penZ = f < TOUCH2 ? PEN_HI * (1 - f / TOUCH2) + 1 : 1;   // descends + touches, then rides the sheet
      var pk = punchForStep(active);               // per-step punch (respects the dropdown override)
      var pp = pk.prof.map(function (p) { return [p[0], p[1] + penZ]; });
      poly(pp, C_PUNCH, C_PUNCH_E, 1);
      // HUD
      ctx.fillStyle = 'rgba(12,19,27,0.82)'; ctx.fillRect(0, 0, W, 28 * dpr);
      ctx.fillStyle = '#cad6e6'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = (12 * dpr) + 'px "Flux Architect", monospace';
      ctx.fillText(aw ? ('STEP ' + active + '/' + maxStep + '  ·  ' + aw.id + '  ·  ' + (axis === 'X' ? 'LONG' : 'SHORT') + ' side  ·  blank ' + Math.round(total) + 'mm  ·  ' + punchForStep(active).name) : '2D PRESS', 10 * dpr, 14 * dpr);
    }

    var raf = null, startTs = null, paused = false, pauseT = 0, statusCb = null, ro = null;
    function resize() { var cw = canvas.clientWidth || canvas.parentElement && canvas.parentElement.clientWidth || 560; canvas.width = Math.round(cw * dpr); canvas.height = Math.round(300 * dpr); }
    function loop(ts) { if (paused) return; if (startTs == null) startTs = ts - pauseT; var t = (ts - startTs) % totalT; pauseT = t; frame(t); raf = requestAnimationFrame(loop); }
    resize(); try { ro = new ResizeObserver(function () { resize(); frame(pauseT); }); ro.observe(canvas); } catch (e) {}
    raf = requestAnimationFrame(loop);
    return {
      destroy: function () { if (raf) cancelAnimationFrame(raf); if (ro) try { ro.disconnect(); } catch (e) {} },
      toggle: function () { paused = !paused; if (!paused) { startTs = null; raf = requestAnimationFrame(loop); } else if (raf) cancelAnimationFrame(raf); },
      isPlaying: function () { return !paused; },
      set onstatus(fn) { statusCb = fn; },
      recordClip: function () { if (statusCb) statusCb('use the 3-D clip'); }
    };
  }

  // Expose the REAL tool silhouettes so the 2D press can draw the SAME punch as the
  // ISO view (เอ๋ 2026-06-04 'มีดต้องเหมือน Iso'). These are tip-at-origin, +y up.
  window.kdSimBend3D = { mount: mount, mount2d: mount2d,
                         SASH_PROF: SASH_PROF, GOOSE_PROF: GOOSE_PROF };
})();
