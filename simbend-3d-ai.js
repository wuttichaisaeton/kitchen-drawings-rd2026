/* simbend-3d-ai.js — Antigravity's isometric 3-D pan/box fold sim for box parts (kind:"box").
 * Unified 1:1 scale, solid punch, width = baseLen - 14, and no-seesaw flat blank animation.
 */
(function () {
  'use strict';
  var R = Math.PI / 180;
  var START = 0, MOVE = 1350, HOLD = 350, END = 800;   // ms
  var PEN_HI = 34;   // punch tip lift
  var HORN_LEN = 70;    // mm bottom relief horn
  var HORN_RISE = 20;

  var TOOL_SCALE = 1.0;
  function scaleProf(p, k) { return p.map(function (q) { return [q[0] * k, q[1] * k]; }); }
  var DIE_PROF = [[-13, 0], [-4, 0], [0, -6], [4, 0], [13, 0], [13, -60], [-13, -60]];
  var SASH_PROF = scaleProf([[0,0],[12.728,12.728],[12.728,87],[20.728,95],[20.728,105],[17.728,105],[17.728,112.5],[20.728,112.5],[20.728,130],[7.728,130],[7.728,100],[-5.272,100],[-5.272,95],[2.728,87],[2.728,13.618],[-5.444,5.445]], TOOL_SCALE);
  var GOOSE_PROF = scaleProf([[0,0],[4.09,4.39],[4.09,4.85],[8.9,10],[20.31,22.24],[28.65,31.18],[49,53],[49,77],[36,90],[20,90],[20,95],[17,95],[17,103],[20,103],[17,120],[7,120],[7,90],[-7,90],[-7,81],[11.84,61.5],[13.01,60.13],[14.01,58.62],[14.82,57.01],[15.43,55.31],[15.84,53.56],[16.03,51.76],[16,49.95],[15.76,48.17],[15.3,46.42],[14.64,44.74],[8.32,31.18],[4.15,22.24],[-1.56,10],[-4.24,4.25]], TOOL_SCALE);

  // step/bend dot palette — MIRRORS app.js BEND_COLORS so the sim's circled-step
  // badge background matches the table dot for that bend (เอ๋: 'สีพื้นหลังวงกลม
  // สัมพันธ์กับสี step'). Indexed by bend number: B1→0, B2→1, ...
  var BEND_COLORS = ['#e0574a', '#4ecca3', '#4a90e2', '#f2b84e', '#c471ed', '#2ecc71', '#e67e22', '#1abc9c', '#e84393', '#6c5ce7'];
  function bendColor(id) {
    var n = parseInt(String(id || '').replace(/\D/g, ''), 10);
    if (!n || isNaN(n)) return '#e0574a';
    return BEND_COLORS[(n - 1) % BEND_COLORS.length];
  }
  // How tall a STANDING wall the blade can clear at its side (mm). Mirrors
  // box_model.DEFAULT_PERP_CLEAR: a gooseneck throat ~42, a straight/sash ~10.
  function punchClearMm(goose) { return goose ? 42 : 10; }
  // Stacked-wall collision the per-axis solver misses (เอ๋: 'step 7,8 ชน'): folding an
  // INNER wall while a taller OUTER wall on the SAME axis+side is already standing —
  // if that formed wall is taller than the blade can clear, the punch hits it. Returns
  // the offending wall id (or null).
  function stackedHitId(walls, aw, active, goose) {
    if (!aw) return null;
    var clr = punchClearMm(goose);
    for (var i = 0; i < walls.length; i++) {
      var w = walls[i];
      if (w === aw) continue;
      if (w.axis === aw.axis && w.side === aw.side &&
          (w.step || 0) < active && (w.height || 0) > clr) return w.id;
    }
    return null;
  }
  // ── 2D contact geometry: is a wall segment actually touching the punch THIS frame ──
  function segInt(p1, p2, p3, p4) {
    var d = (p4[1] - p3[1]) * (p2[0] - p1[0]) - (p4[0] - p3[0]) * (p2[1] - p1[1]);
    if (Math.abs(d) < 1e-9) return null;
    var ua = ((p4[0] - p3[0]) * (p1[1] - p3[1]) - (p4[1] - p3[1]) * (p1[0] - p3[0])) / d;
    var ub = ((p2[0] - p1[0]) * (p1[1] - p3[1]) - (p2[1] - p1[1]) * (p1[0] - p3[0])) / d;
    if (ua < 0 || ua > 1 || ub < 0 || ub > 1) return null;
    return [p1[0] + ua * (p2[0] - p1[0]), p1[1] + ua * (p2[1] - p1[1])];
  }
  function ptInPoly(p, poly) {
    var x = p[0], y = p[1], inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  // Return the contact point where wall segment a→b meets punch polygon `poly`, else null.
  function segVsPoly(a, b, poly) {
    for (var i = 0; i < poly.length; i++) {
      var ix = segInt(a, b, poly[i], poly[(i + 1) % poly.length]);
      if (ix) return ix;
    }
    if (ptInPoly(b, poly)) return b;
    if (ptInPoly(a, poly)) return a;
    return null;
  }

  function mount(canvas, record, code) {
    window.__activeRecord = record;
    var box = record && record.box_geom;
    if (!box || !canvas) return null;
    var ctx = canvas.getContext('2d');
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    var base = box.base || { w: 200, h: 200 };
    var allWalls = (box.walls || []).slice();
    if (!allWalls.length) return null;

    var activeTlen = 0;
    function getStepForFlapName(name) {
      var axis = name.charAt(0);
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

    var groups = {};
    allWalls.forEach(function (w) {
      var k = w.axis + w.side;
      (groups[k] = groups[k] || []).push(w);
    });
    var pairs = [];
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
    var ONE_GOOSE = allWalls.some(function (x) { return x.punch === 'gooseneck' || x.needs_gooseneck; });
    var _longWall = allWalls.reduce(function (a, b) {
      return (b.width > a.width || (b.width === a.width && b.height > a.height)) ? b : a;
    });
    var ONE_TOOL_HALF = _longWall.width / 2;
    var USE_GOOSE = allWalls.some(function (x) { return x.needs_gooseneck || x.punch === 'gooseneck'; });
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

    function frac(step, t) {
      var s = START + (step - 1) * (MOVE + HOLD);
      if (t < s) return 0;
      if (t >= s + MOVE) return 1;
      return (t - s) / MOVE;
    }
    function gfold(step, t) {
      var f = frac(step, t);
      if (f < 0.25) return 0;
      if (f < 0.75) return (f - 0.25) / 0.5;
      return 1;
    }

    function wallQuad(w, deg) {
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
    function lipQuad(main, mainDeg, lip, lipDeg) {
      var fe = wallQuad(main, mainDeg);
      var a = fe[3], b = fe[2];
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
      var defs = [
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
      if (fl.wline != null) {
        // Outer flap rides its inner wall (double-fold) so it stays CONNECTED — the
        // single-fold experiment detached the tall outer wall (ขาดออกจากกัน). With the
        // outline now extracted in correct order (rectangular walls), the double-fold
        // gives a clean connected wall, not a slanted triangle. [เอ๋]
        var wl = fl.ax === 'V' ? fl.wline - fpCx : fl.wline - fpCy;
        var wstep = fpStepOf(fl.name.charAt(0) + fl.name.charAt(1) + 'w');
        var thw2 = gfold(wstep, t) * Math.PI / 2;
        p3 = p3.map(function (p) { return F(p, L0, fl.side, thw); });
        return p3.map(function (p) { return F(p, wl, fl.side, thw2); });
      }
      return p3.map(function (p) { return F(p, L0, fl.side, thw); });
    }
    function fpBasePts() { return fpBase.map(function (q) { return { x: q[0] - fpCx, y: q[1] - fpCy, z: 0 }; }); }
    
    var lipHeightX = 0;
    var lipHeightY = 0;
    allWalls.forEach(function (w) {
      if (w.height < 12) {
        if (w.axis === 'X') lipHeightX = w.height;
        else if (w.axis === 'Y') lipHeightY = w.height;
      }
    });
    var lipFlat = Math.min.apply(null, allWalls.map(function (w) {
      return (w.flat_len != null ? w.flat_len : w.height);
    }));
    if (!isFinite(lipFlat) || lipFlat <= 0) lipFlat = 6.13;

    function fpActiveTool(active) {
      var fl = null; fpFlaps.forEach(function (x) { if (x.step === active) fl = x; });
      if (!fl) return null;
      var L0 = fl.ax === 'V' ? fl.line - fpCx : fl.line - fpCy;
      var baseLen = fl.ax === 'V' ? base.h : base.w;
      var punch_width = baseLen - 14.0;
      var eHalf = Math.max(10, punch_width / 2);
      return { axis: fl.ax === 'V' ? 'X' : 'Y', side: fl.side > 0 ? '+' : '-', offset: Math.abs(L0),
               eHalf: eHalf };
    }

    var ISO = 26 * R;
    function iso(p) { return { x: (p.x - p.y) * Math.cos(ISO), y: p.z - (p.x + p.y) * Math.sin(ISO) }; }
    function depth(p) { return p.x + p.y + p.z * 1.5; }

    var scale = 1, cx = 0, cy = 0;
    function computeFit(w, h) {
      var pts = FLAT ? fpBasePts() : [].concat(baseQuad());
      if (FLAT) {
        fpFlaps.forEach(function (fl) { pts = pts.concat(foldedFlap(fl, 1e9)); });
        fpFlaps.forEach(function (fl) {
          var pw = { axis: fl.ax === 'V' ? 'X' : 'Y', side: fl.side > 0 ? '+' : '-', offset: Math.abs(fl.ax === 'V' ? fl.line - fpCx : fl.line - fpCy) };
          SASH_PROF.forEach(function (p) { pts.push(csTo3d(pw, p[0], p[1] + PEN_HI, 0)); });
        });
      } else pairs.forEach(function (pr) {
        pts = pts.concat(wallQuad(pr.main, pr.main.angle_deg || 90));
        if (pr.lip) pts = pts.concat(lipQuad(pr.main, pr.main.angle_deg || 90, pr.lip, pr.lip.angle_deg || 90));
        var prof = SASH_PROF;
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
      cy = h / 2 + ((miny + maxy) / 2) * scale;
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

    var C_BASE = '#9aa6b2', C_BASE_E = '#5d6b78';
    var C_SASH = '#e8923a', C_GOOSE = '#4a90e2', C_RED = '#e0574a';
    var C_LIP = 'rgba(255,255,255,0.12)';
    var C_DIE = '#737d88', C_DIE_E = '#454e58', C_PUNCH = '#aab3bd', C_PUNCH_E = '#4c555f';

    function csTo3d(w, u, z, e) {
      var sg = w.side === '+' ? 1 : -1, off = w.offset;
      if (w.axis === 'X') return { x: sg * off + u, y: e, z: z };
      return { x: e, y: sg * off + u, z: z };
    }
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

    function frame(t) {
      var w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      computeFit(w, h);

      var active = 0;
      for (var st = 1; st <= maxStep; st++) { if (t >= START + (st - 1) * (MOVE + HOLD)) active = st; }
      // report the active step/bend so the app can highlight the matching table row [เอ๋]
      if (activeCb && active !== _lastActive) {
        _lastActive = active;
        var _awid = null;
        for (var _ai = 0; _ai < allWalls.length; _ai++) { if (allWalls[_ai].step === active) { _awid = allWalls[_ai].id; break; } }
        activeCb(_awid, active);
      }

      // transient stacked-collision flags for THIS frame (เอ๋: 'step 7,8 ชน') — folding an
      // inner wall while a taller same-side wall is already standing & the blade can't
      // clear it. Cleared every frame so nothing leaks into the data/table.
      for (var _si = 0; _si < allWalls.length; _si++) { allWalls[_si]._stk = false; allWalls[_si]._stkWith = null; }
      var _awWall = null;
      for (var _wi = 0; _wi < allWalls.length; _wi++) { if (allWalls[_wi].step === active) { _awWall = allWalls[_wi]; break; } }
      var _stkHit = stackedHitId(allWalls, _awWall, active, punchForStep(active).goose);
      if (_stkHit && _awWall) {
        _awWall._stk = true; _awWall._stkWith = _stkHit;
        for (var _hi = 0; _hi < allWalls.length; _hi++) { if (allWalls[_hi].id === _stkHit) allWalls[_hi]._stk = true; }
      }

      var items = [];
      if (FLAT) {
        var af = null; fpFlaps.forEach(function (x) { if (x.step === active) af = x; });
        var afL0 = af ? (af.ax === 'V' ? af.line - fpCx : af.line - fpCy) : 0;
        var afF = (af && af.ax === 'V') ? fvAround : fhAround;
        var bump = 0;
        var SINK = 7;
        var sink = 0;
        if (af) {
          var targetAng = 90;
          var wObj = null;
          for (var i = 0; i < allWalls.length; i++) {
            if (allWalls[i].step === active) { wObj = allWalls[i]; break; }
          }
          if (wObj && wObj.angle_deg != null) targetAng = wObj.angle_deg;
          var targetAngRad = targetAng * R;

          var f = frac(active, t);
          if (f < 0.25) {
            bump = 0;
            sink = 0;
          } else if (f < 0.75) {
            var ratio = (f - 0.25) / 0.5;
            bump = ratio * (targetAngRad / 2);
            sink = ratio * SINK;
          } else {
            var ratio = (1 - Math.min(1, (f - 0.75) / 0.25));
            bump = ratio * (targetAngRad / 2);
            sink = ratio * SINK;
          }
        }
        function vlift(arr) {
          var r = (af && bump) ? arr.map(function (p) { return afF(p, afL0, -af.side, bump); }) : arr;
          return sink ? r.map(function (p) { return { x: p.x, y: p.y, z: p.z - sink }; }) : r;
        }
        items.push({ pts: vlift(fpBasePts()), fill: C_BASE, stroke: C_BASE_E, lw: 1.5, d: depth({ x: 0, y: 0, z: 0 }) - 1e6 });
        fpFlaps.forEach(function (fl) {
          var wObj = null;
          for (var i = 0; i < allWalls.length; i++) {
            if (allWalls[i].step === fl.step) { wObj = allWalls[i]; break; }
          }
          var collides = wObj && (wObj.collides || wObj._stk);
          var baseCol = collides ? C_RED : C_SASH;
          var fp3 = vlift(foldedFlap(fl, t)), act = (fl.step === active), isLip = fl.wline != null;
          items.push({ pts: fp3, fill: shade(baseCol, act ? 0.98 : (isLip ? 0.6 : 0.82)), stroke: collides ? C_RED : '#2b3340',
                       lw: act ? 2 : 1.1, d: cenN(fp3) + (isLip ? 0.5 : 0) });
        });
        var tw = fpActiveTool(active);
        if (tw && active >= 1) {
          var f_active = frac(active, t);
          var penZ2 = PEN_HI;
          if (f_active < 0.25) {
            penZ2 = PEN_HI * (1 - f_active / 0.25) - sink;
          } else if (f_active < 0.75) {
            penZ2 = -sink;
          } else {
            penZ2 = -sink + PEN_HI * ((f_active - 0.75) / 0.25);
          }
          var pk = punchForStep(active);
          var aw = null; allWalls.forEach(function (x) { if (x.step === active) aw = x; });
          var collides = aw && (aw.collides || aw._stk);
          var pFill = collides ? C_RED : C_PUNCH;
          var pStroke = collides ? C_RED : C_PUNCH_E;
          addExtrusion(items, tw, DIE_PROF, 0, C_DIE, C_DIE_E, -3, tw.eHalf, 1);
          
          var eMin = -tw.eHalf;
          var eMax = tw.eHalf;
          if (record.box_geom) {
            var clearance = 1.0;
            fpFlaps.forEach(function (fl) {
              if (fl.step >= active) return;
              if (tw.axis === 'X') {
                if (fl.ax === 'H') {
                  var pts = foldedFlap(fl, 1e9);
                  if (fl.side < 0) {
                    var yMax = Math.max.apply(null, pts.map(function (p) { return p.y; }));
                    eMin = Math.max(eMin, yMax + clearance);
                  } else {
                    var yMin = Math.min.apply(null, pts.map(function (p) { return p.y; }));
                    eMax = Math.min(eMax, yMin - clearance);
                  }
                }
              } else {
                if (fl.ax === 'V') {
                  var pts = foldedFlap(fl, 1e9);
                  if (fl.side < 0) {
                    var xMax = Math.max.apply(null, pts.map(function (p) { return p.x; }));
                    eMin = Math.max(eMin, xMax + clearance);
                  } else {
                    var xMin = Math.min.apply(null, pts.map(function (p) { return p.x; }));
                    eMax = Math.min(eMax, xMin - clearance);
                  }
                }
              }
            });
          }
          activeTlen = Math.round(eMax - eMin);
          var punchUSign = pk.goose ? (aw && aw.side === '+' ? -1 : 1) : 1;
          addExtrusion(items, tw, pk.prof, penZ2, pFill, pStroke, 6, eMin, punchUSign, eMax);
        }
      } else {
        var bq = baseQuad();
        items.push({ pts: bq, fill: C_BASE, stroke: C_BASE_E, lw: 1.5, d: depth({ x: 0, y: 0, z: 0 }) - 1e6 });
        pairs.forEach(function (pr) {
          var m = pr.main, mCol = (m.collides || m._stk), mw = mCol ? C_RED : C_SASH;
          var md = (m.angle_deg || 90) * frac(m.step, t);
          var mq = wallQuad(m, md);
          var act = (m.step === active);
          items.push({ pts: mq, fill: shade(mw, act ? 0.95 : 0.78), stroke: mCol ? C_RED : '#2b3340', lw: act ? 2 : 1.2,
                       d: cen(mq), label: m });
          if (pr.lip) {
            var lCol = (pr.lip.collides || pr.lip._stk);
            var ld = (pr.lip.angle_deg || 90) * frac(pr.lip.step, t);
            var lq = lipQuad(m, md, pr.lip, ld);
            items.push({ pts: lq, fill: lCol ? C_RED : shade(mw, 0.6), stroke: lCol ? C_RED : '#2b3340', lw: 1, d: cen(lq) + 0.5 });
          }
        });
        var aw = null; allWalls.forEach(function (x) { if (x.step === active) aw = x; });
        if (aw && active >= 1) {
          var f = frac(aw.step, t);
          var penZ = PEN_HI * (1 - f) + 1;
          var pFill = (aw.collides || aw._stk) ? C_RED : C_PUNCH, pStroke = (aw.collides || aw._stk) ? C_RED : C_PUNCH_E;
          var pWidthHalf = Math.max(10, (aw.width - 14.0) / 2);
          addExtrusion(items, aw, DIE_PROF, 0, C_DIE, C_DIE_E, -3, pWidthHalf, 1);
          addExtrusion(items, aw, SASH_PROF, penZ, pFill, pStroke, 6, pWidthHalf, 1);
          activeTlen = Math.round(pWidthHalf * 2);
        } else {
          activeTlen = Math.round(ONE_TOOL_HALF * 2);
        }
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
           '  ·  TOOL ' + tlen + 'mm [AI]')
        : 'PAN FOLD [AI]  ·  ' + pairs.length + ' walls';
      ctx.fillText(hud, 10 * dpr, 15 * dpr);

      // เอ๋: small circled CURRENT-STEP number, top-right — circle bg = this step's colour
      if (active) {
        var bx = w - 24 * dpr, by = 50 * dpr, br = 14 * dpr;
        ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fillStyle = wall ? bendColor(wall.id) : '#e0574a'; ctx.fill();
        ctx.lineWidth = 2 * dpr; ctx.strokeStyle = 'rgba(12,19,27,0.85)'; ctx.stroke();
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = 'bold ' + (15 * dpr) + 'px "Flux Architect", monospace';
        ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(12,19,27,0.55)'; ctx.strokeText(String(active), bx, by + dpr);
        ctx.fillStyle = '#fff'; ctx.fillText(String(active), bx, by + dpr);
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      }

      if (wall && (wall.collides || wall._stk)) {
        ctx.fillStyle = C_RED; ctx.textAlign = 'right';
        ctx.font = 'bold ' + (12 * dpr) + 'px "Flux Architect", monospace';
        ctx.fillText('✗ HITS ' + (wall.collides_with || wall._stkWith || 'WALL'), w - 10 * dpr, 15 * dpr);
      }
      var anyCol = allWalls.some(function (x) { return x.collides || x._stk; });
      var stkAny = allWalls.some(function (x) { return x._stk; });
      ctx.fillStyle = 'rgba(12,19,27,0.82)'; ctx.fillRect(0, h - 26 * dpr, w, 26 * dpr);
      ctx.textAlign = 'left'; ctx.font = 'bold ' + (12 * dpr) + 'px "Flux Architect", monospace';
      if (record.bendable && !anyCol) { ctx.fillStyle = '#4ecca3'; ctx.fillText('✓ BENDABLE (box)  ·  ' + (record.order || []).join(' → '), 10 * dpr, h - 13 * dpr); }
      else { ctx.fillStyle = C_RED; ctx.fillText('✗ ' + ((stkAny && !record.reason) ? 'STACKED WALL COLLISION — INNER FOLD BLOCKED BY OUTER' : (record.reason || 'collision').toUpperCase()), 10 * dpr, h - 13 * dpr); }
    }

    var raf = null, startTs = null, paused = false, pauseT = 0, statusCb = null;
    var activeCb = null, _lastActive = -2;
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

    var controller = {
      frame: frame,
      setTime: function (val) { pauseT = val; frame(val); },
      destroy: function () { if (raf) cancelAnimationFrame(raf); if (ro) try { ro.disconnect(); } catch (e) {} },
      toggle: function () { paused = !paused; if (!paused) { startTs = null; raf = requestAnimationFrame(loop); } else if (raf) cancelAnimationFrame(raf); },
      isPlaying: function () { return !paused; },
      set onstatus(fn) { statusCb = fn; },
      set onactive(fn) { activeCb = fn; _lastActive = -2; },
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
    window.__active3DController = controller;
    return controller;
  }

  function mount2d(canvas, record, code) {
    window.__activeRecord = record;
    var box = record && record.box_geom;
    if (!box || !canvas) return null;
    var ctx = canvas.getContext('2d');
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    var base = box.base || { w: 200, h: 200 };
    var walls = (box.walls || []).slice();
    if (!walls.length) return null;
    var maxStep = walls.reduce(function (m, w) { return Math.max(m, w.step || 0); }, 0);
    var totalT = START + maxStep * (MOVE + HOLD) + END;
    var USE_GOOSE = walls.some(function (x) { return x.needs_gooseneck || x.punch === 'gooseneck'; });

    var overridePunchId = 'AUTO';
    var overridePunchType = 'AUTO';
    var overrideDieId = 'AUTO';
    var overrideDieV = 'AUTO';
    var overrideDieAngle = 'AUTO';
    var overrideDieType = 'AUTO';
    var overrideDieVList = 'AUTO';

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
    function frac(step, t) {
      var s = START + (step - 1) * (MOVE + HOLD);
      if (t < s) return 0; if (t >= s + MOVE) return 1; return (t - s) / MOVE;
    }
    var C_DIE = '#737d88', C_DIE_E = '#454e58', C_PUNCH = '#aab3bd', C_PUNCH_E = '#4c555f',
        C_BASE = '#9aa6b2', C_WALL = '#e8923a', C_LIP = '#c77a2e', C_RED = '#e0574a';
    // Developed length of one wall/lip for the press cross-section. A WALL (h>=12) uses
    // its mould HEIGHT (CheckBend's flat_len was the neighbour wall's tiny length for
    // stacked walls h18+h52 — made the 52mm flange too short); a real LIP (h<12) uses
    // flat_len. [เอ๋]
    function _featLen(w) {
      return (w.height || 0) >= 12 ? w.height : (w.flat_len != null ? w.flat_len : w.height);
    }
    function baseHalf(axis) {
      var dev = 0;
      walls.forEach(function (w) { if (w.axis === axis) dev += _featLen(w); });
      if (box.flat_w && box.flat_h) {
        return ((axis === 'X' ? box.flat_w : box.flat_h) - dev) / 2;
      }
      return (axis === 'X' ? (box.base.w) : (box.base.h)) / 2;
    }

    function frame(t) {
      var W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      var active = 0; for (var st = 1; st <= maxStep; st++) { if (t >= START + (st - 1) * (MOVE + HOLD)) active = st; }
      var aw = null; walls.forEach(function (x) { if (x.step === active) aw = x; });
      if (activeCb && active !== _lastActive) { _lastActive = active; activeCb(aw ? aw.id : null, active); }
      var axis = aw ? aw.axis : 'X';
      var bh = baseHalf(axis);
      var total = 2 * bh;
      walls.forEach(function (w) { if (w.axis === axis) total += _featLen(w); });
      var f = frac(active, t);
      // 2D press phases (เอ๋: ค้างที่จังหวะ 45° นานหน่อยเพื่อตรวจ collision):
      //   descend → fold + tip-up → HOLD at the 45° peak (inspection window) → settle back.
      var HOLD_P0 = 0.16, HOLD_P1 = 0.40, HOLD_P2 = 0.88;   // peak-hold spans P1..P2 (~0.48·MOVE)
      function getFoldFraction(step, t) {
        var ff = frac(step, t);
        if (ff < HOLD_P0) return 0;
        if (ff < HOLD_P1) return (ff - HOLD_P0) / (HOLD_P1 - HOLD_P0);
        return 1;   // stays folded through the peak-hold + settle
      }
      // Build a full developed side: base edge → each wall/lip in order (walls inner→outer
      // by height, then the lip). Supports MORE THAN ONE wall per side (test v6 h18+h52),
      // so the tall 52mm flange shows its real length. Returns {pts, segs}. [เอ๋]
      function buildSide(sd) {
        var sg = sd > 0 ? '+' : '-';
        var feats = walls.filter(function (w) { return w.axis === axis && w.side === sg; })
          .sort(function (a, b) {
            var ka = (a.height >= 12 ? 0 : 1), kb = (b.height >= 12 ? 0 : 1);
            return ka !== kb ? ka - kb : a.height - b.height;
          });
        var u = sd * bh, z = 0, ang = 0, pts = [[u, z]], segs = [];
        feats.forEach(function (w) {
          var len = _featLen(w);
          ang += getFoldFraction(w.step, t) * (Math.PI / 2);
          u += sd * len * Math.cos(ang); z += len * Math.sin(ang);
          pts.push([u, z]); segs.push(w);
        });
        return { pts: pts, segs: segs };
      }
      var Rside = buildSide(1), Lside = buildSide(-1);
      // active vertex = the fold line of the active wall (centre it at the die)
      var av = [0, 0];
      if (aw) {
        var sObj = aw.side === '+' ? Rside : Lside, ai = 0;
        for (var i = 0; i < sObj.segs.length; i++) { if (sObj.segs[i].step === active) { ai = i; break; } }
        av = sObj.pts[ai];
      }
      
      var activeV = 8;
      if (aw) {
        var bObj = (record.per_bend || []).filter(function (x) { return x.step === active; })[0];
        if (bObj && bObj.v_mm != null) activeV = bObj.v_mm;
      }
      var maxPen = activeV / 2;
      
      var bump = 0;
      var pen = 0;
      var sdSign = (aw && aw.side === '+') ? 1 : -1;
      if (aw) {
        var pk;   // 0..1 peak factor — 1 = full 45° tip-up + full die penetration
        if (f < HOLD_P0) pk = 0;
        else if (f < HOLD_P1) pk = (f - HOLD_P0) / (HOLD_P1 - HOLD_P0);   // ramp up to the peak
        else if (f < HOLD_P2) pk = 1;                                      // HOLD at 45° — inspect collision
        else pk = 1 - (f - HOLD_P2) / (1 - HOLD_P2);                       // settle back to flat
        bump = -sdSign * pk * (Math.PI / 4);
        pen = pk * maxPen;
      }
      
      function place(p) { var u = p[0] - av[0], z = p[1] - av[1], c = Math.cos(bump), sn = Math.sin(bump); return [u * c - z * sn, u * sn + z * c - pen]; }
      // Stitch the full cross-section: L outermost → L base → R base → R outermost.
      // cSegs[i] = the wall/lip for the segment chain[i]→chain[i+1] (null = the base). [เอ๋]
      var Lpts = Lside.pts, Rpts = Rside.pts, cPts = [], cSegs = [];
      for (var ci = Lpts.length - 1; ci >= 1; ci--) { cPts.push(Lpts[ci]); cSegs.push(Lside.segs[ci - 1]); }
      cPts.push(Lpts[0]); cSegs.push(null);          // L base corner, then the BASE segment
      cPts.push(Rpts[0]);                            // R base corner
      for (var cj = 1; cj < Rpts.length; cj++) { cSegs.push(Rside.segs[cj - 1]); cPts.push(Rpts[cj]); }
      var chain = cPts.map(place);
      // FIXED camera (เอ๋: ร่องพับต้องอยู่กลาง-ล่างนิ่ง ไม่วิ่งไปมา, frame แรกเห็นมีดเต็มตัว,
      // ชิ้นงานเห็นไม่เต็มก็ได้). The active bend already sits at model-origin (place() subtracts
      // av), so we pin model-origin to a CONSTANT screen point (bottom-centre) with a CONSTANT
      // scale sized to the punch+die envelope — never the blank. Result: the die-groove never
      // drifts between steps and the punch is always fully in frame; the long blank simply runs
      // off the sides (acceptable per เอ๋).
      var punchTopZ = PEN_HI + 130 * TOOL_SCALE;   // top of the fully-lifted punch
      // Zoom in tighter (เอ๋: zoom เข้าไปอีก) — the bend + die + punch throat fill the frame; the
      // top of the punch shank is allowed to crop under the HUD bar. Die V-notch stays near the bottom.
      var botPad = 12 * dpr;                        // die V-notch near the bottom (groove peeks up)
      var baseY0 = H - botPad;                      // die reference (drives the SCALE only)
      var ZOOM2D = 1.5;                             // >1 zooms in; raise for more, lower for less
      var s = ZOOM2D * (baseY0 - 34 * dpr) / punchTopZ;  // constant scale — ZOOM UNCHANGED (เอ๋)
      var PAN_UP = 0.18 * H;                        // เอ๋: pan the 2D view UP (same zoom); raise/lower to taste
      var baseY = baseY0 - PAN_UP;                  // shift all content up by PAN_UP
      var ox = W / 2;                               // die V-notch horizontally centred (fixed)
      function X(u) { return ox + u * s; }
      function Y(z) { return baseY - z * s; }
      function line(pts, col, lw) { ctx.beginPath(); pts.forEach(function (p, i) { var xx = X(p[0]), yy = Y(p[1]); if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy); }); ctx.strokeStyle = col; ctx.lineWidth = lw * dpr; ctx.lineJoin = ctx.lineCap = 'round'; ctx.stroke(); }
      function poly(pts, fill, stroke, lw) { ctx.beginPath(); pts.forEach(function (p, i) { var xx = X(p[0]), yy = Y(p[1]); if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy); }); ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = (lw || 1) * dpr; ctx.lineJoin = 'round'; ctx.stroke(); } }
      poly(DIE_PROF, C_DIE, C_DIE_E, 1);

      // PUNCH first so the metal sheet is drawn ON TOP of it — เอ๋:
      // 'แสดงโลหะอยู่หน้ามีด' (the workpiece must read in front of the blade).
      var penZ = PEN_HI;
      if (aw) {
        if (f < HOLD_P0) {
          penZ = PEN_HI * (1 - f / HOLD_P0) - pen;                 // punch descends to the die
        } else if (f < HOLD_P2) {
          penZ = -pen;                                             // down through fold + the 45° hold
        } else {
          penZ = -pen + PEN_HI * ((f - HOLD_P2) / (1 - HOLD_P2));  // lift after the inspection hold
        }
      }
      var pk = punchForStep(active);
      var uSign = pk.goose ? ((aw && aw.side === '+') ? -1 : 1) : 1;
      var pp = pk.prof.map(function (p) { return [p[0] * uSign, p[1] + penZ]; });
      poly(pp, C_PUNCH, C_PUNCH_E, 1);

      // metal drawn AFTER (= in front of) the punch so the sheet is always visible
      for (var si = 0; si < cSegs.length; si++) {
        var seg = cSegs[si];
        var col = (seg == null) ? C_BASE : (seg.step === active ? C_RED : (seg.height >= 12 ? C_WALL : C_LIP));
        var lw = (seg && seg.height < 12) ? 6 : 7;
        line([chain[si], chain[si + 1]], col, lw);
      }

      // COLLISION — either the solver flagged this bend, OR a taller stacked wall on the
      // same side is already up and the blade can't clear it (เอ๋: 'step 7,8 ชน').
      var stackHit = stackedHitId(walls, aw, active, punchForStep(active).goose);
      var collideWith = (aw && aw.collides_with) || stackHit;
      var collide = !!(aw && aw.collides) || !!stackHit;

      // เอ๋: warning + ring track the ACTUAL contact frames — show only while the colliding
      // wall is really touching the punch this frame, hidden before it reaches / after it
      // clears. Geometric: does the hit wall's segment intersect the punch polygon now?
      var contactPt = null, hitSegIdx = -1;
      if (collide && collideWith) {
        for (var hi = 0; hi < cSegs.length; hi++) {
          if (cSegs[hi] && cSegs[hi].id === collideWith) { hitSegIdx = hi; break; }
        }
        if (hitSegIdx >= 0) contactPt = segVsPoly(chain[hitSegIdx], chain[hitSegIdx + 1], pp);
      }
      // hit wall in this cross-section → gate on real contact; else (hits DIE / perpendicular
      // wall, not drawn here) → gate on the punch-engaged window so it still flashes sensibly.
      var showCol = collide && (hitSegIdx >= 0 ? !!contactPt : (f >= HOLD_P0 && f <= HOLD_P2));

      // ring the exact contact point
      if (showCol && contactPt) {
        ctx.beginPath(); ctx.arc(X(contactPt[0]), Y(contactPt[1]), 18 * dpr, 0, Math.PI * 2);
        ctx.lineWidth = 3 * dpr; ctx.strokeStyle = '#e0574a'; ctx.stroke();
      }

      ctx.fillStyle = 'rgba(12,19,27,0.82)'; ctx.fillRect(0, 0, W, 28 * dpr);
      ctx.fillStyle = '#cad6e6'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = (12 * dpr) + 'px "Flux Architect", monospace';
      var tlen = aw ? Math.round((axis === 'X' ? base.h : base.w) - 14) : Math.round(ONE_TOOL_HALF * 2);
      ctx.fillText(aw ? ('STEP ' + active + '/' + maxStep + '  ·  ' + aw.id + '  ·  ' + (axis === 'Y' ? 'LONG' : 'SHORT') + ' side  ·  blank ' + Math.round(total) + 'mm  ·  ' + punchForStep(active).name + '  ·  TOOL ' + tlen + 'mm [AI]') : '2D PRESS [AI]', 10 * dpr, 14 * dpr);
      // COLLISION warning banner — only while actually in contact (เอ๋: เฟรมที่ชนเท่านั้น)
      if (showCol) {
        var ch = 22 * dpr;
        ctx.fillStyle = 'rgba(224,87,74,0.95)'; ctx.fillRect(0, 28 * dpr, W, ch);
        ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.font = 'bold ' + (12 * dpr) + 'px "Flux Architect", monospace';
        var hitTxt = collideWith ? (' hits ' + collideWith) : '';
        ctx.fillText('⚠ COLLISION — ' + (aw ? aw.id : '') + hitTxt + ' — change punch / order', 10 * dpr, 28 * dpr + ch / 2);
      }
      // เอ๋: small circled CURRENT-STEP number, top-right — circle bg = this step's colour
      if (active) {
        var bx = W - 24 * dpr, by = 48 * dpr, br = 14 * dpr;
        ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fillStyle = aw ? bendColor(aw.id) : '#e0574a'; ctx.fill();
        ctx.lineWidth = 2 * dpr; ctx.strokeStyle = 'rgba(12,19,27,0.85)'; ctx.stroke();
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = 'bold ' + (15 * dpr) + 'px "Flux Architect", monospace';
        ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(12,19,27,0.55)'; ctx.strokeText(String(active), bx, by + dpr);
        ctx.fillStyle = '#fff'; ctx.fillText(String(active), bx, by + dpr);
        ctx.textAlign = 'left';
      }
    }

    var raf = null, startTs = null, paused = false, pauseT = 0, statusCb = null, ro = null;
    var activeCb = null, _lastActive = -2;
    function resize() { var cw = canvas.clientWidth || canvas.parentElement && canvas.parentElement.clientWidth || 560; canvas.width = Math.round(cw * dpr); canvas.height = Math.round(300 * dpr); }
    function loop(ts) { if (paused) return; if (startTs == null) startTs = ts - pauseT; var t = (ts - startTs) % totalT; pauseT = t; frame(t); raf = requestAnimationFrame(loop); }
    resize(); try { ro = new ResizeObserver(function () { resize(); frame(pauseT); }); ro.observe(canvas); } catch (e) {}
    raf = requestAnimationFrame(loop);
    var controller = {
      frame: frame,
      setTime: function (val) { pauseT = val; frame(val); },
      destroy: function () { if (raf) cancelAnimationFrame(raf); if (ro) try { ro.disconnect(); } catch (e) {} },
      toggle: function () { paused = !paused; if (!paused) { startTs = null; raf = requestAnimationFrame(loop); } else if (raf) cancelAnimationFrame(raf); },
      isPlaying: function () { return !paused; },
      set onstatus(fn) { statusCb = fn; },
      set onactive(fn) { activeCb = fn; _lastActive = -2; },
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
      recordClip: function () { if (statusCb) statusCb('use the 3-D clip'); }
    };
    window.__active2DController = controller;
    return controller;
  }

  window.kdSimBend3D_AI = { mount: mount, mount2d: mount2d,
                            SASH_PROF: SASH_PROF, GOOSE_PROF: GOOSE_PROF };
})();
