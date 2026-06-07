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
  // ── collision alarm sound (Web Audio) — เอ๋: 'มีเสียงด้วยได้ไหม' (+ iOS iPad/iPhone) ──
  // iPadOS 13+ reports as "Mac" but has touch — treat touch-capable Apple as iOS.
  var _isIOS = /iP(hone|ad|od)/.test(navigator.platform || '') ||
               (/Macintosh/.test(navigator.userAgent || '') && 'ontouchend' in document);
  var _audioCtx = null, _mediaDest = null, _unmuteEl = null;
  function _ensureAudio() {
    try {
      if (!_audioCtx) {
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        // iOS: also feed an inline <audio> element via a MediaStream so playback uses the
        // media session — lets the beep be heard even with the ring/silent switch engaged.
        try {
          if (_audioCtx.createMediaStreamDestination) {
            _mediaDest = _audioCtx.createMediaStreamDestination();
            _unmuteEl = document.createElement('audio');
            _unmuteEl.setAttribute('playsinline', '');
            _unmuteEl.setAttribute('webkit-playsinline', '');
            _unmuteEl.muted = false; _unmuteEl.volume = 1;
            _unmuteEl.srcObject = _mediaDest.stream;
            _unmuteEl.style.cssText = 'position:absolute;width:0;height:0;opacity:0';
            document.body.appendChild(_unmuteEl);
          }
        } catch (e) { _mediaDest = null; }
      }
      if (_audioCtx.state === 'suspended') _audioCtx.resume();
      return _audioCtx;
    } catch (e) { return null; }
  }
  // audio is blocked until a user gesture — unlock on the first touch/click. iOS needs an
  // actual node started INSIDE the gesture + the media element to begin playing.
  (function () {
    var done = false, evs = ['touchend', 'touchstart', 'pointerdown', 'mousedown', 'click', 'keydown'];
    var unlock = function () {
      if (done) return; done = true;
      var ctx = _ensureAudio();
      if (ctx) {
        try { ctx.resume(); } catch (e) {}
        try { var b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); } catch (e) {}
      }
      if (_unmuteEl) { try { _unmuteEl.play(); } catch (e) {} }
      evs.forEach(function (ev) { document.removeEventListener(ev, unlock, true); });
    };
    evs.forEach(function (ev) { try { document.addEventListener(ev, unlock, true); } catch (e) {} });
  })();
  var _lastAlarmAt = -1e9;
  function playCollisionAlarm() {
    var ctx = _ensureAudio();
    if (!ctx || ctx.state !== 'running') return;
    if (_unmuteEl && _unmuteEl.paused) { try { _unmuteEl.play(); } catch (e) {} }
    var now = ctx.currentTime;
    if (now - _lastAlarmAt < 0.25) return;   // debounce double-fires
    _lastAlarmAt = now;
    [0, 0.16].forEach(function (off) {       // two short harsh beeps
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(340, now + off);
      o.frequency.setValueAtTime(250, now + off + 0.07);
      g.gain.setValueAtTime(0.0001, now + off);
      g.gain.exponentialRampToValueAtTime(0.16, now + off + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, now + off + 0.13);
      o.connect(g);
      g.connect(ctx.destination);                       // normal speaker path
      if (_isIOS && _mediaDest) g.connect(_mediaDest);  // iOS media-session path (silent switch)
      o.start(now + off); o.stop(now + off + 0.14);
    });
  }
  // How tall a STANDING wall the blade can clear at its side (mm). Mirrors
  // box_model.DEFAULT_PERP_CLEAR: a gooseneck throat ~42, a straight/sash ~10.
  function punchClearMm(goose) { return goose ? 42 : 10; }
  // How tall a SAME-SIDE stacked outer wall a punch can clear while folding the inner
  // wall behind it (mm). Per-punch catalog/shop values (เอ๋ 2026-06-07). NOTE: pure
  // geometry from the DXF profile was tried and rejected — it over-cleared the narrow-
  // shank sash/straight punches (gave 130/69 where the shop value is ~12/10), so the
  // collision would never warn for the most common punch. Anchor every known punch to
  // its KYOKKO/shop value instead: deep gooseneck #453/#463 ≈ 42 (relief clears tall
  // same-side walls); acute #103 ≈ 12; sash #202 ≈ 12; straight #109 ≈ 10; unknown → 10.
  // Keyed by the punch name from punchForStep() ({prof, goose, name}).
  function sameSideClearMm(punch) {
    var n = (punch && punch.name) || '';
    if (/453|463/.test(n)) return 45;          // deep gooseneck relief (เอ๋ 2026-06-07: 45 clears, 46 hits)
    if (punch && punch.goose) return 45;       // any gooseneck
    if (/103|acute/i.test(n)) return 12;       // acute spike
    if (/202|sash/i.test(n)) return 12;        // sash punch
    if (/109|straight/i.test(n)) return 10;    // straight punch
    return 10;                                  // default / unknown
  }
  // Stacked-wall collision the per-axis solver misses (เอ๋: 'step 7,8 ชน'): folding an
  // INNER wall while a taller OUTER wall on the SAME axis+side is already standing —
  // if that formed wall is taller than the active punch can clear at its side, the punch
  // hits it. Returns the offending wall id (or null).
  function stackedHitId(walls, aw, active, punch) {
    if (!aw) return null;
    var clr = sameSideClearMm(punch);   // per-punch (deep GN clears, acute spike doesn't)
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
  // KYOKKO gooseneck CLEARANCE ENVELOPE — traced 1:1 from เอ๋'s clean DXF (453.svg, 2026-06-07):
  // model coords, tip at origin, Y up → tip → 60mm@45° up the relief side → punch neck. Drawn in
  // the 2D press as a visual clearance GUIDE (เอ๋ 'ลากเส้น envelope จาก DXF'); the collision verdict
  // stays on the stable numeric sameSideClearMm (เอ๋ chose 'เลขนิ่ง 45 + วาดเส้น'). null = no envelope.
  function clearEnvelope(punch) {
    var n = (punch && punch.name) || '';
    if (/453|463/.test(n) || (punch && punch.goose)) return [[0, 0], [-42.43, 42.43], [-5, 79.85]];
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
    var _stkScreenPt = null;   // screen pos of the colliding wall this frame (for the ISO alarm ring)
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
    var _PNAME = { '202': '#202 SASH', '109': '#109 STRAIGHT', '453': 'GOOSENECK #453', '103': '#103 ACUTE GN' };
    function _exactProf(profId) {
      try { if (window.KD_TOOLART && window.KD_TOOLART.profileFor) { var p = window.KD_TOOLART.profileFor({ profile_id: profId }); if (p && p.length >= 3) return scaleProf(p, TOOL_SCALE); } } catch (e) {}
      return null;
    }
    function punchForStep(step) {
      var rawId = '';
      // เอ๋ 'เปลี่ยนมีดแล้ว แบบไม่เปลี่ยน': a per-STEP punch (table row) is the most specific
      // → it WINS over the global override, which only applies to rows left on AUTO.
      var b = (record.per_bend || []).filter(function (x) { return x.step === step; })[0];
      if (b && b.punch && b.punch !== 'AUTO') rawId = '' + b.punch;
      else if (overridePunchId && overridePunchId !== 'AUTO') rawId = '' + overridePunchId;
      var pid = rawId.toUpperCase();
      var series = (pid.match(/KYOKKO-([^-]+)/) || [])[1] || '';
      var isGoose = (series === '453' || series === '103' || pid.indexOf('GOOSE') >= 0 || pid.indexOf('GN') >= 0);
      // เอ๋ 'มีด 103,109 ไม่ขึ้น': draw the REAL shared DXF outline (tool-art) for every
      // punch — 202 / 109 / 453 / 103 — not just two hard-coded shapes.
      if (series) {
        var ex = _exactProf(series);
        if (ex) return { prof: ex, goose: isGoose, name: _PNAME[series] || ('#' + series) };
      }
      if (pid.indexOf('202') >= 0 || pid.indexOf('SASH') >= 0) return { prof: SASH_PROF, goose: false, name: '#202 SASH' };
      if (pid.indexOf('453') >= 0 || pid.indexOf('GN') >= 0 || pid.indexOf('GOOSE') >= 0) return { prof: GOOSE_PROF, goose: true, name: 'GOOSENECK #453' };
      if (pid.indexOf('109') >= 0) return { prof: SASH_PROF, goose: false, name: '#109' };
      // AUTO: use THIS bend's OWN punch kind (the solver's per_bend.punch_type / needs_gooseneck),
      // NOT the global USE_GOOSE — which forced a gooseneck on EVERY auto step (เอ๋ 2026-06-07:
      // CVIL00-205093's 15mm tray side-walls B5/B6 came out as goosenecks while only the tiny
      // end-tabs B1-B4/B7 actually need one).
      var _sg = b ? (b.needs_gooseneck || b.punch_type === 'gooseneck') : USE_GOOSE;
      var aS = _sg ? '453' : '202', aex = _exactProf(aS);
      if (aex) return { prof: aex, goose: _sg, name: _sg ? 'GOOSENECK #453' : '#202 SASH' };
      return _sg ? { prof: GOOSE_PROF, goose: true, name: 'GOOSENECK #453' } : { prof: SASH_PROF, goose: false, name: '#202 SASH' };
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
      var _stkHit = stackedHitId(allWalls, _awWall, active, punchForStep(active));
      // เอ๋ 'ไม่ชนก็เตือน': only flag while the blade is actually pressed down (the contact
      // window) — not during the approach or the lift. Otherwise the warning shows the
      // whole step even when nothing is touching.
      var _stkFrac = frac(active, t);
      if (_stkHit && _awWall && _stkFrac >= 0.28 && _stkFrac <= 0.80) {
        _awWall._stk = true; _awWall._stkWith = _stkHit;
        for (var _hi = 0; _hi < allWalls.length; _hi++) { if (allWalls[_hi].id === _stkHit) allWalls[_hi]._stk = true; }
      }
      _stkScreenPt = null;   // recomputed below from the hit wall's projected centroid

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
          // เอ๋: on ISO the pulsing ring marks the hit — keep the plate/punch their NORMAL
          // colour (only a real solver collision still tints red; stacked _stk → ring only).
          var collides = wObj && wObj.collides;
          var baseCol = collides ? C_RED : C_SASH;
          var fp3 = vlift(foldedFlap(fl, t)), act = (fl.step === active), isLip = fl.wline != null;
          items.push({ pts: fp3, fill: shade(baseCol, act ? 0.98 : (isLip ? 0.6 : 0.82)), stroke: collides ? C_RED : '#2b3340',
                       lw: act ? 2 : 1.1, d: cenN(fp3) + (isLip ? 0.5 : 0) });
          // capture the colliding wall's screen centroid for the ISO alarm ring [เอ๋]
          if (wObj && _awWall && wObj.id === _awWall._stkWith) {
            var _cc = { x: 0, y: 0, z: 0 }, _nn = fp3.length || 1;
            fp3.forEach(function (p) { _cc.x += p.x / _nn; _cc.y += p.y / _nn; _cc.z += p.z / _nn; });
            _stkScreenPt = toScreen(_cc);
          }
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
          var collides = aw && aw.collides;
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
          // เอ๋: SASH is asymmetric too — mirror by side like the gooseneck (not goose-only)
          var punchUSign = (aw && aw.side === '+') ? -1 : 1;
          addExtrusion(items, tw, pk.prof, penZ2, pFill, pStroke, 6, eMin, punchUSign, eMax);
        }
      } else {
        var bq = baseQuad();
        items.push({ pts: bq, fill: C_BASE, stroke: C_BASE_E, lw: 1.5, d: depth({ x: 0, y: 0, z: 0 }) - 1e6 });
        pairs.forEach(function (pr) {
          var m = pr.main, mCol = m.collides, mw = mCol ? C_RED : C_SASH;
          var md = (m.angle_deg || 90) * frac(m.step, t);
          var mq = wallQuad(m, md);
          var act = (m.step === active);
          items.push({ pts: mq, fill: shade(mw, act ? 0.95 : 0.78), stroke: mCol ? C_RED : '#2b3340', lw: act ? 2 : 1.2,
                       d: cen(mq), label: m });
          if (pr.lip) {
            var lCol = pr.lip.collides;
            var ld = (pr.lip.angle_deg || 90) * frac(pr.lip.step, t);
            var lq = lipQuad(m, md, pr.lip, ld);
            items.push({ pts: lq, fill: lCol ? C_RED : shade(mw, 0.6), stroke: lCol ? C_RED : '#2b3340', lw: 1, d: cen(lq) + 0.5 });
          }
        });
        var aw = null; allWalls.forEach(function (x) { if (x.step === active) aw = x; });
        if (aw && active >= 1) {
          var f = frac(aw.step, t);
          var penZ = PEN_HI * (1 - f) + 1;
          var pFill = aw.collides ? C_RED : C_PUNCH, pStroke = aw.collides ? C_RED : C_PUNCH_E;
          var pWidthHalf = Math.max(10, (aw.width - 14.0) / 2);
          addExtrusion(items, aw, DIE_PROF, 0, C_DIE, C_DIE_E, -3, pWidthHalf, 1);
          addExtrusion(items, aw, SASH_PROF, penZ, pFill, pStroke, 6, pWidthHalf, (aw.side === '+') ? -1 : 1);
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
      // เอ๋: ISO collision alarm — pulsing ring on the colliding wall during the press
      var _fA = frac(active, t);
      if (_stkScreenPt && _fA >= 0.22 && _fA <= 0.82) {
        var rx = _stkScreenPt.x, ry = _stkScreenPt.y;
        var ping = (t % 720) / 720;
        var throb = 0.5 + 0.5 * Math.sin(t / 95);
        ctx.save();
        ctx.beginPath(); ctx.arc(rx, ry, (16 + ping * 22) * dpr, 0, Math.PI * 2);
        ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(224,87,74,' + (0.9 * (1 - ping)).toFixed(3) + ')'; ctx.stroke();
        ctx.shadowColor = '#e0574a'; ctx.shadowBlur = (8 + 14 * throb) * dpr;
        ctx.beginPath(); ctx.arc(rx, ry, 16 * dpr, 0, Math.PI * 2);
        ctx.lineWidth = (3 + 1.5 * throb) * dpr; ctx.strokeStyle = '#ff6f60'; ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.beginPath(); ctx.arc(rx, ry, 3 * dpr, 0, Math.PI * 2); ctx.fillStyle = '#fff2ef'; ctx.fill();
        ctx.restore();
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
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

    var _PNAME = { '202': '#202 SASH', '109': '#109 STRAIGHT', '453': 'GOOSENECK #453', '103': '#103 ACUTE GN' };
    function _exactProf(profId) {
      try { if (window.KD_TOOLART && window.KD_TOOLART.profileFor) { var p = window.KD_TOOLART.profileFor({ profile_id: profId }); if (p && p.length >= 3) return scaleProf(p, TOOL_SCALE); } } catch (e) {}
      return null;
    }
    function punchForStep(step) {
      var rawId = '';
      // เอ๋ 'เปลี่ยนมีดแล้ว แบบไม่เปลี่ยน': a per-STEP punch (table row) is the most specific
      // → it WINS over the global override, which only applies to rows left on AUTO.
      var b = (record.per_bend || []).filter(function (x) { return x.step === step; })[0];
      if (b && b.punch && b.punch !== 'AUTO') rawId = '' + b.punch;
      else if (overridePunchId && overridePunchId !== 'AUTO') rawId = '' + overridePunchId;
      var pid = rawId.toUpperCase();
      var series = (pid.match(/KYOKKO-([^-]+)/) || [])[1] || '';
      var isGoose = (series === '453' || series === '103' || pid.indexOf('GOOSE') >= 0 || pid.indexOf('GN') >= 0);
      // เอ๋ 'มีด 103,109 ไม่ขึ้น': draw the REAL shared DXF outline (tool-art) for every
      // punch — 202 / 109 / 453 / 103 — not just two hard-coded shapes.
      if (series) {
        var ex = _exactProf(series);
        if (ex) return { prof: ex, goose: isGoose, name: _PNAME[series] || ('#' + series) };
      }
      if (pid.indexOf('202') >= 0 || pid.indexOf('SASH') >= 0) return { prof: SASH_PROF, goose: false, name: '#202 SASH' };
      if (pid.indexOf('453') >= 0 || pid.indexOf('GN') >= 0 || pid.indexOf('GOOSE') >= 0) return { prof: GOOSE_PROF, goose: true, name: 'GOOSENECK #453' };
      if (pid.indexOf('109') >= 0) return { prof: SASH_PROF, goose: false, name: '#109' };
      // AUTO: use THIS bend's OWN punch kind (the solver's per_bend.punch_type / needs_gooseneck),
      // NOT the global USE_GOOSE — which forced a gooseneck on EVERY auto step (เอ๋ 2026-06-07:
      // CVIL00-205093's 15mm tray side-walls B5/B6 came out as goosenecks while only the tiny
      // end-tabs B1-B4/B7 actually need one).
      var _sg = b ? (b.needs_gooseneck || b.punch_type === 'gooseneck') : USE_GOOSE;
      var aS = _sg ? '453' : '202', aex = _exactProf(aS);
      if (aex) return { prof: aex, goose: _sg, name: _sg ? 'GOOSENECK #453' : '#202 SASH' };
      return _sg ? { prof: GOOSE_PROF, goose: true, name: 'GOOSENECK #453' } : { prof: SASH_PROF, goose: false, name: '#202 SASH' };
    }
    function frac(step, t) {
      var s = START + (step - 1) * (MOVE + HOLD);
      if (t < s) return 0; if (t >= s + MOVE) return 1; return (t - s) / MOVE;
    }
    // เอ๋ 'ค้างจุดที่ชนไว้สักพักเพื่อดูรายละเอียด': a step whose verdict is COLLISION lingers an extra
    // EXTRA_HOLD ms FROZEN at its press peak (where the contact + alarm ring show) before playing on.
    // _stepCol[step] is static (the verdict doesn't depend on t); stepRealStart() is the stretched
    // timeline. frame() maps real time → a canonical uniform time so the rest of the draw is unchanged.
    var EXTRA_HOLD = 1500;
    var _stepCol = [];
    for (var _cs = 1; _cs <= maxStep; _cs++) {
      var _caw = null; for (var _ci = 0; _ci < walls.length; _ci++) { if (walls[_ci].step === _cs) { _caw = walls[_ci]; break; } }
      _stepCol[_cs] = !!(_caw && _caw.collides) || !!stackedHitId(walls, _caw, _cs, punchForStep(_cs));
    }
    function stepRealStart(st) { var s = START; for (var k = 1; k < st; k++) { s += (MOVE + HOLD) + (_stepCol[k] ? EXTRA_HOLD : 0); } return s; }
    totalT = stepRealStart(maxStep) + (MOVE + HOLD) + (_stepCol[maxStep] ? EXTRA_HOLD : 0) + END;
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

    function frame(tReal) {
      var W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      // active step from the REAL (collision-stretched) timeline, then remap to a CANONICAL uniform
      // time `t` that FREEZES a colliding step at its press peak (HOLD_P1 = 0.40·MOVE) for
      // EXTRA_HOLD ms — so frac()/folds/penZ/collision draw exactly as before. เอ๋ 'ค้างจุดที่ชน'.
      var active = 0; for (var st = 1; st <= maxStep; st++) { if (tReal >= stepRealStart(st)) active = st; }
      var _localT = tReal - stepRealStart(active);
      var _peakT = 0.40 * MOVE;
      var _cLocal = (_stepCol[active] && _localT > _peakT) ? (_peakT + Math.max(0, _localT - _peakT - EXTRA_HOLD)) : _localT;
      var t = START + (active - 1) * (MOVE + HOLD) + _cLocal;
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
            // DXF-derived walls carry an explicit `seq` (developed order from the base outward —
            // wall→return→lip) so a hem stacks in the REAL order; box_geom walls have no seq → keep
            // the original height heuristic (taller=inner wall, shorter=outer return). เอ๋ 2026-06-08.
            if (a.seq != null && b.seq != null) return a.seq - b.seq;
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
      var botPad = 12 * dpr;                        // die V-notch near the bottom (groove peeks up)
      var baseY0 = H - botPad;                      // die reference (drives the SCALE only)

      // Punch polygon (MODEL coords) — built here (before the camera) so we can locate
      // the collision contact to centre the zoom on. Reused by the punch draw below.
      var penZ = PEN_HI;
      if (aw) {
        if (f < HOLD_P0) penZ = PEN_HI * (1 - f / HOLD_P0) - pen;       // descends to the die
        else if (f < HOLD_P2) penZ = -pen;                              // down through fold + 45° hold
        else penZ = -pen + PEN_HI * ((f - HOLD_P2) / (1 - HOLD_P2));    // lift after the hold
      }
      var pk = punchForStep(active);
      var uSign = (aw && aw.side === '+') ? -1 : 1;   // mirror the blade lean toward the workpiece
      var pp = pk.prof.map(function (p) { return [p[0] * uSign, p[1] + penZ]; });

      // FIXED camera — no auto-zoom (เอ๋ 2026-06-07 'ไม่เอา Zoom แล้ว มันวิ่งไปมา'). Constant
      // scale, die-groove pinned bottom-centre; the long blank runs off the sides.
      var ZOOM2D = 1.5;
      var s = ZOOM2D * (baseY0 - 34 * dpr) / punchTopZ;
      var baseY = baseY0 - 0.18 * H;
      var ox = W / 2;
      function X(u) { return ox + u * s; }
      function Y(z) { return baseY - z * s; }
      function line(pts, col, lw) { ctx.beginPath(); pts.forEach(function (p, i) { var xx = X(p[0]), yy = Y(p[1]); if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy); }); ctx.strokeStyle = col; ctx.lineWidth = lw * dpr; ctx.lineJoin = ctx.lineCap = 'round'; ctx.stroke(); }
      function poly(pts, fill, stroke, lw) { ctx.beginPath(); pts.forEach(function (p, i) { var xx = X(p[0]), yy = Y(p[1]); if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy); }); ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = (lw || 1) * dpr; ctx.lineJoin = 'round'; ctx.stroke(); } }
      poly(DIE_PROF, C_DIE, C_DIE_E, 1);

      // PUNCH first so the metal sheet is drawn ON TOP of it (เอ๋: 'แสดงโลหะอยู่หน้ามีด').
      // pk / penZ / uSign / pp were computed before the camera block (above).
      poly(pp, C_PUNCH, C_PUNCH_E, 1);

      // metal drawn AFTER (= in front of) the punch so the sheet is always visible.
      // Every flange line is drawn at its REAL length (mm × the constant scale), the same
      // across all steps (เอ๋ 2026-06-07 'ยาวตาม mm จริง สเกลเดียวทุก step'): a 42mm wall is the
      // same length whether it's the active fold or a formed wall, and an 18mm wall is 18/42
      // of it. No clipping (clipping distorted the formed-wall length).
      for (var si = 0; si < cSegs.length; si++) {
        var seg = cSegs[si];
        var col = (seg == null) ? C_BASE : (seg.step === active ? C_RED : (seg.height >= 12 ? C_WALL : C_LIP));
        var lw = (seg && seg.height < 12) ? 6 : 7;
        line([chain[si], chain[si + 1]], col, lw);
      }

      // Reference marker (เอ๋ 2026-06-07 'เส้น marker จากกราฟ'): on each FORMED same-side wall,
      // an amber dashed tick at the punch's max same-side clearance (the catalog/graph value).
      // The wall is drawn full length, so any part past the tick = it would hit the blade.
      // Gooseneck → draw the REAL clearance envelope straight from the punch's DXF, anchored at the
      // punch tip (เอ๋ 'ลากเส้น envelope จาก DXF'). Other punches → the per-wall 'max N' tick.
      var _envG = aw ? clearEnvelope(pk) : null;
      if (_envG) {
        var envM = _envG.map(function (p) { return [p[0] * uSign, p[1] + penZ]; });
        ctx.save();
        ctx.globalAlpha = 0.25;  // เอ๋ 2026-06-08: clearance line + label fainter — 25% (was 50%)
        ctx.setLineDash([5 * dpr, 4 * dpr]);
        ctx.strokeStyle = '#ffb74d'; ctx.lineWidth = 2 * dpr; ctx.lineJoin = ctx.lineCap = 'round';
        ctx.beginPath();
        for (var ei = 0; ei < envM.length; ei++) { var _ex = X(envM[ei][0]), _ey = Y(envM[ei][1]); if (ei) ctx.lineTo(_ex, _ey); else ctx.moveTo(_ex, _ey); }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ffb74d'; ctx.font = 'bold ' + (10 * dpr) + 'px "Flux Architect", monospace';
        ctx.textAlign = (uSign < 0) ? 'right' : 'left'; ctx.textBaseline = 'middle';
        ctx.fillText('clearance', X(envM[1][0]) + (uSign < 0 ? -4 : 4) * dpr, Y(envM[1][1]));
        ctx.restore();
      } else {
        var _clr = aw ? sameSideClearMm(pk) : 0;
        if (_clr > 0) {
          ctx.save();
          ctx.setLineDash([5 * dpr, 4 * dpr]);
          ctx.strokeStyle = '#ffb74d'; ctx.fillStyle = '#ffb74d';
          ctx.font = 'bold ' + (10 * dpr) + 'px "Flux Architect", monospace';
          ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          for (var ki = 0; ki < cSegs.length; ki++) {
            var ks = cSegs[ki];
            if (!ks || ks.step == null || ks.step >= active) continue;
            if (ks.axis !== aw.axis || ks.side !== aw.side) continue;   // same-side formed walls only
            var e0 = chain[ki], e1 = chain[ki + 1];
            var kbase = e0[1] < e1[1] ? e0 : e1;     // smaller model-z = base (near die)
            var ktop = e0[1] < e1[1] ? e1 : e0;
            var klen = Math.hypot(ktop[0] - kbase[0], ktop[1] - kbase[1]) || 1;
            if (klen <= _clr) continue;              // wall shorter than the limit → nothing to flag
            var kux = (ktop[0] - kbase[0]) / klen, kuz = (ktop[1] - kbase[1]) / klen;
            var lim = [kbase[0] + kux * _clr, kbase[1] + kuz * _clr];   // limit point along the wall
            var pxu = -kuz, pzu = kux, tkm = 6;                          // perpendicular tick (model units)
            ctx.beginPath();
            ctx.moveTo(X(lim[0] - pxu * tkm), Y(lim[1] - pzu * tkm));
            ctx.lineTo(X(lim[0] + pxu * tkm), Y(lim[1] + pzu * tkm));
            ctx.lineWidth = 2 * dpr; ctx.stroke();
            ctx.fillText('max ' + Math.round(_clr), X(lim[0] + pxu * tkm) + 3 * dpr, Y(lim[1] + pzu * tkm));
          }
          ctx.restore();
        }
      }

      // เอ๋: number each folded line with its flange length (mm). Colour follows the theme:
      // BLACK on the light "Pencil" (sketch) paper, WHITE on the dark themes (default /
      // chalk / Luxury-obsidian). No box, no border, no fill.
      var _thm = document.documentElement.getAttribute('data-theme') || '';
      var _numCol = (_thm === 'sketch') ? '#1b1815' : '#ffffff';
      for (var di = 0; di < cSegs.length; di++) {
        var dseg = cSegs[di];
        if (!dseg) continue;                       // skip the flat base
        var lbl = String(Math.round(dseg.height || 0));
        var actL = dseg.step === active;
        var mxp = X((chain[di][0] + chain[di + 1][0]) / 2);
        var myp = Y((chain[di][1] + chain[di + 1][1]) / 2);
        ctx.fillStyle = _numCol;
        ctx.font = 'bold ' + ((actL ? 14 : 11) * dpr) + 'px "Flux Architect", monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(lbl, mxp, myp);
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      }

      // COLLISION — either the solver flagged this bend, OR a taller stacked wall on the
      // same side is already up and the blade can't clear it (เอ๋: 'step 7,8 ชน').
      var stackHit = stackedHitId(walls, aw, active, punchForStep(active));
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
      // EXCEPTION: a same-side STACKED collision (taller outer wall blocks the inner fold) is a
      // 3-D blockage the flat cross-section can't always show as a polygon overlap — the punch
      // may be drawn clearing the shorter wall — so gate it on the press-hold window like the
      // ISO view, never on geometric contact (เอ๋: 'ต้องเตือน'). [_isStacked]
      var _isStacked = !!stackHit && !(aw && aw.collides);
      var showCol = collide && (_isStacked
        ? (f >= HOLD_P0 && f <= HOLD_P2)
        : (hitSegIdx >= 0 ? !!contactPt : (f >= HOLD_P0 && f <= HOLD_P2)));
      if (showCol && !_colWasOn) playCollisionAlarm();   // beep on the contact rising edge [เอ๋]
      _colWasOn = showCol;

      // ring the exact contact point — pulsing "alarm" effect [เอ๋: เพิ่ม Effect]
      if (showCol && contactPt) {
        var cx = X(contactPt[0]), cy = Y(contactPt[1]);
        var ping = (tReal % 720) / 720;              // 0..1 expanding radar ping (real time → keeps
        var throb = 0.5 + 0.5 * Math.sin(tReal / 95); // pulsing during the collision freeze) [เอ๋]
        ctx.save();
        // expanding ping ring — grows outward and fades
        ctx.beginPath(); ctx.arc(cx, cy, (15 + ping * 18) * dpr, 0, Math.PI * 2);
        ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(224,87,74,' + (0.9 * (1 - ping)).toFixed(3) + ')'; ctx.stroke();
        // glowing main ring — throbs
        ctx.shadowColor = '#e0574a'; ctx.shadowBlur = (6 + 12 * throb) * dpr;
        ctx.beginPath(); ctx.arc(cx, cy, 15 * dpr, 0, Math.PI * 2);
        ctx.lineWidth = (3 + 1.5 * throb) * dpr; ctx.strokeStyle = '#ff6f60'; ctx.stroke();
        ctx.shadowBlur = 0;
        // bright spark at the contact
        ctx.beginPath(); ctx.arc(cx, cy, 2.6 * dpr, 0, Math.PI * 2); ctx.fillStyle = '#fff2ef'; ctx.fill();
        ctx.restore();
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
    var activeCb = null, _lastActive = -2, _colWasOn = false;
    function resize() { var cw = canvas.clientWidth || canvas.parentElement && canvas.parentElement.clientWidth || 560; var chh = canvas.clientHeight || 300; canvas.width = Math.round(cw * dpr); canvas.height = Math.round(chh * dpr); }
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

  // ── DXF-driven 3D iso (เอ๋ 2026-06-08) ────────────────────────────────────────
  // Self-contained: folds the part each frame via window.KD_DXFFLAT.foldFlat and draws
  // the panels in a standard isometric projection (no dependency on mount()'s closures).
  // Used when a part has an uploaded flat-pattern DXF; otherwise mount() (box_geom) runs.
  function mountFromFlat(canvas, flat, bends, record, code) {
    if (!canvas || !flat || !(window.KD_DXFFLAT && window.KD_DXFFLAT.foldFlat)) return null;
    var ctx = canvas.getContext('2d');
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    var maxStep = bends.reduce(function (m, b) { return Math.max(m, b.step || 0); }, 0) || 1;
    var totalT = START + maxStep * (MOVE + HOLD) + END;
    function fracL(step, t) { var s = START + (step - 1) * (MOVE + HOLD); if (t < s) return 0; if (t >= s + MOVE) return 1; return (t - s) / MOVE; }
    function foldT(t) { var st = 0; for (var s = 1; s <= maxStep; s++) { if (t >= START + (s - 1) * (MOVE + HOLD)) st = s; } return (st - 1) + fracL(st, t); }
    var ca = Math.cos(Math.PI / 6), sa = Math.sin(Math.PI / 6);
    function iso(v) { return [(v[0] - v[1]) * ca, (v[0] + v[1]) * sa - v[2]]; }
    var C_DIE = '#737d88', C_DIE_E = '#454e58', C_PUNCH = '#aab3bd', C_PUNCH_E = '#4c555f';
    // The press-brake "clip" (เอ๋ 2026-06-08 'ทำ 3D ให้แสดง Clip'): a V-die below the active hinge +
    // a punch descending onto it, extruded along the bend line. Attached to the bend foldFlat is
    // animating THIS step (step === st), so it always clamps the flange that's bending, in sync.
    function toolingFor(ab, f) {
      var A = ab.a, B = ab.b, dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1;
      var nx = -dy / L, ny = dx / L;                          // unit perpendicular to the hinge (in XY)
      var penZ = (f < 0.16) ? PEN_HI * (1 - f / 0.16) : (f < 0.88 ? 0 : PEN_HI * ((f - 0.88) / 0.12));
      function ring(prof, zOff, end) { return prof.map(function (p) { return [end[0] + p[0] * nx, end[1] + p[0] * ny, p[1] + zOff]; }); }
      return { die: [ring(DIE_PROF, 0, A), ring(DIE_PROF, 0, B)], punch: [ring(SASH_PROF, penZ, A), ring(SASH_PROF, penZ, B)] };
    }
    function favg(face) { var s = 0; face.forEach(function (v) { s += v[0] + v[1] + v[2]; }); return s / face.length; }

    function frame(t) {
      var W = canvas.width, H = canvas.height; ctx.clearRect(0, 0, W, H);
      var out = window.KD_DXFFLAT.foldFlat(flat, bends, foldT(t));
      if (!out || !out.panels.length) return;
      // the bend bending THIS step (the same step foldFlat is animating) → the tooling clips it.
      var st = 0; for (var s = 1; s <= maxStep; s++) { if (t >= START + (s - 1) * (MOVE + HOLD)) st = s; }
      var ab = null; bends.forEach(function (b) { if (b.step === st) ab = b; });
      var tool = ab ? toolingFor(ab, fracL(st, t)) : null;
      // screen mapping spans the part AND the tooling so the punch stays in frame
      var ip = []; out.panels.forEach(function (p) { p.pts3.forEach(function (v) { ip.push(iso(v)); }); });
      if (tool) [tool.die[0], tool.die[1], tool.punch[0], tool.punch[1]].forEach(function (r) { r.forEach(function (v) { ip.push(iso(v)); }); });
      var minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      ip.forEach(function (q) { if (q[0] < minx) minx = q[0]; if (q[0] > maxx) maxx = q[0]; if (q[1] < miny) miny = q[1]; if (q[1] > maxy) maxy = q[1]; });
      var pad = 26 * dpr;
      var sc = Math.min((W - 2 * pad) / ((maxx - minx) || 1), (H - 2 * pad) / ((maxy - miny) || 1));
      var ox = (W - (maxx + minx) * sc) / 2, oy = (H - (maxy + miny) * sc) / 2;
      function S(v) { var q = iso(v); return [ox + q[0] * sc, oy + q[1] * sc]; }
      // extrude a tool (front+back profile rings) as a depth-sorted solid
      function drawTool(rings, fill, stroke) {
        var front = rings[0], back = rings[1], faces = [];
        for (var i = 0; i < front.length; i++) { var j = (i + 1) % front.length; faces.push([front[i], front[j], back[j], back[i]]); }
        faces.push(front.slice()); faces.push(back.slice());
        faces.sort(function (a, b) { return favg(a) - favg(b); });
        faces.forEach(function (fc) {
          var sp = fc.map(S); ctx.beginPath(); sp.forEach(function (q, k) { if (k) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.closePath();
          ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = stroke; ctx.lineWidth = 1 * dpr; ctx.lineJoin = 'round'; ctx.stroke();
        });
      }
      function depth(p) { var s = 0; p.pts3.forEach(function (v) { s += v[0] + v[1] + v[2]; }); return s / p.pts3.length; }
      var order = out.panels.map(function (_, i) { return i; }).sort(function (a, b) { return depth(out.panels[a]) - depth(out.panels[b]); });
      if (tool) drawTool(tool.die, C_DIE, C_DIE_E);            // die below/behind the sheet → drawn first
      order.forEach(function (i) {
        var p = out.panels[i], sp = p.pts3.map(S);
        ctx.beginPath(); sp.forEach(function (q, k) { if (k) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.closePath();
        ctx.fillStyle = (out.active && p.parent != null && p.parent >= 0) ? 'rgba(224,87,74,0.16)' : 'rgba(170,179,189,0.30)';
        ctx.fill(); ctx.strokeStyle = '#aab3bd'; ctx.lineWidth = 1.4 * dpr; ctx.lineJoin = 'round'; ctx.stroke();
      });
      if (tool) drawTool(tool.punch, C_PUNCH, C_PUNCH_E);      // punch above the sheet → drawn on top
      ctx.fillStyle = 'rgba(12,19,27,0.82)'; ctx.fillRect(0, 0, W, 26 * dpr);
      ctx.fillStyle = '#cad6e6'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = (12 * dpr) + 'px "Flux Architect", monospace';
      ctx.fillText('3D (DXF) · ' + (code || '') + ' · ' + out.panels.length + ' panels' + (ab ? '  ·  STEP ' + st + '/' + maxStep + '  ·  bending ' + (ab.id || '') : ''), 10 * dpr, 13 * dpr);
      if (activeCb && ab && ab.id !== _lastA) { _lastA = ab.id; activeCb(ab.id, ab.step); }
    }
    var raf = null, startTs = null, paused = false, pauseT = 0, activeCb = null, _lastA = null, ro = null;
    function resize() { var cw = canvas.clientWidth || 560, chh = canvas.clientHeight || 300; canvas.width = Math.round(cw * dpr); canvas.height = Math.round(chh * dpr); }
    function loop(ts) { if (paused) return; if (startTs == null) startTs = ts - pauseT; var t = (ts - startTs) % totalT; pauseT = t; frame(t); raf = requestAnimationFrame(loop); }
    resize(); try { ro = new ResizeObserver(function () { resize(); frame(pauseT); }); ro.observe(canvas); } catch (e) {}
    raf = requestAnimationFrame(loop);
    return {
      frame: frame, setTime: function (v) { pauseT = v; frame(v); },
      destroy: function () { if (raf) cancelAnimationFrame(raf); if (ro) try { ro.disconnect(); } catch (e) {} },
      toggle: function () { paused = !paused; if (!paused) { startTs = null; raf = requestAnimationFrame(loop); } else if (raf) cancelAnimationFrame(raf); },
      isPlaying: function () { return !paused; },
      set onstatus(fn) {}, set onactive(fn) { activeCb = fn; _lastA = null; },
      setPunchOverride: function () {}, setDieOverride: function () {}, recordClip: function () {}
    };
  }

  // ── DXF-driven 2D PRESS (เอ๋ 2026-06-08) ──────────────────────────────────────
  // For the active bend, draws the TRUE cross-section from KD_DXFFLAT.crossSection (the active
  // flange folds UP at the die — เอ๋'s "point 1 → point 2") + the die + the descending punch +
  // the 50%-alpha gooseneck clearance envelope. The long base runs off the right (like the box sim).
  function mount2dFromFlat(canvas, flat, bends, record, code) {
    if (!canvas || !flat || !(window.KD_DXFFLAT && window.KD_DXFFLAT.crossSection)) return null;
    var ctx = canvas.getContext('2d');
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    var maxStep = bends.reduce(function (m, b) { return Math.max(m, b.step || 0); }, 0) || 1;
    var totalT = START + maxStep * (MOVE + HOLD) + END;
    var C_DIE = '#737d88', C_DIE_E = '#454e58', C_PUNCH = '#aab3bd', C_PUNCH_E = '#4c555f';
    function fracL(step, t) { var s = START + (step - 1) * (MOVE + HOLD); if (t < s) return 0; if (t >= s + MOVE) return 1; return (t - s) / MOVE; }
    function foldT(t) { var st = 0; for (var s = 1; s <= maxStep; s++) { if (t >= START + (s - 1) * (MOVE + HOLD)) st = s; } return (st - 1) + fracL(st, t); }
    function gooseProf() { try { var p = window.KD_TOOLART && window.KD_TOOLART.profileFor({ id: 'P-KYOKKO-453-R15' }); if (p && p.length >= 3) return p; } catch (e) {} return GOOSE_PROF; }

    function frame(t) {
      var W = canvas.width, H = canvas.height; ctx.clearRect(0, 0, W, H);
      var st = 0; for (var s2 = 1; s2 <= maxStep; s2++) { if (t >= START + (s2 - 1) * (MOVE + HOLD)) st = s2; }
      var aw = null; bends.forEach(function (b) { if (b.step === st) aw = b; }); if (!aw) aw = bends[0];
      var cs = window.KD_DXFFLAT.crossSection(flat, bends, foldT(t), aw);
      var sc = (H * 0.5) / 90;                       // px per mm (≈90mm tall view)
      var baseY = H * 0.80, ox = W * 0.42;
      function X(u) { return ox + u * sc; }
      function Y(z) { return baseY - z * sc; }
      function poly(pts, fill, stroke, lw, off) { off = off || 0; ctx.beginPath(); pts.forEach(function (p, i) { var xx = X(p[0]), yy = Y(p[1] + off); if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy); }); ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = (lw || 1) * dpr; ctx.lineJoin = 'round'; ctx.stroke(); } }
      // DIE (V-notch at u=0). DIE_PROF y is downward (negative) → fed as z so Y() flips it below.
      poly(DIE_PROF.map(function (p) { return [p[0], p[1]]; }), C_DIE, C_DIE_E, 1.2);
      // PUNCH descending into the die V over the active step's MOVE phase.
      var f = fracL(st, t);
      var penZ = (f < 0.16) ? PEN_HI * (1 - f / 0.16) : (f < 0.88 ? 0 : PEN_HI * ((f - 0.88) / 0.12));
      var pp = gooseProf().map(function (p) { return [p[0], p[1] + penZ]; });
      poly(pp, C_PUNCH, C_PUNCH_E, 1);
      // 50%-alpha clearance envelope (gooseneck)
      var env = clearEnvelope({ name: 'GOOSENECK #453', goose: true });
      if (env) {
        ctx.save(); ctx.globalAlpha = 0.5; ctx.setLineDash([5 * dpr, 4 * dpr]);
        ctx.strokeStyle = '#ffb74d'; ctx.lineWidth = 2 * dpr; ctx.lineJoin = ctx.lineCap = 'round';
        ctx.beginPath(); env.forEach(function (p, i) { var xx = X(p[0]), yy = Y(p[1] + penZ); if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy); }); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = '#ffb74d'; ctx.font = 'bold ' + (10 * dpr) + 'px "Flux Architect", monospace'; ctx.textBaseline = 'middle';
        ctx.fillText('clearance', X(env[1][0]) + 4 * dpr, Y(env[1][1] + penZ)); ctx.restore();
      }
      // METAL cross-section — active flange (near u=0, z>0) red, the rest orange. Base runs off-screen.
      if (cs) cs.segments.forEach(function (seg) {
        var nearBend = Math.abs(seg[0][0]) < 30 && Math.abs(seg[1][0]) < 30;
        var rises = Math.max(seg[0][1], seg[1][1]) > 1.5;
        ctx.beginPath(); ctx.moveTo(X(seg[0][0]), Y(seg[0][1])); ctx.lineTo(X(seg[1][0]), Y(seg[1][1]));
        ctx.strokeStyle = (nearBend && rises) ? '#e0574a' : '#e8923a'; ctx.lineWidth = 7 * dpr; ctx.lineCap = 'round'; ctx.stroke();
      });
      ctx.fillStyle = 'rgba(12,19,27,0.82)'; ctx.fillRect(0, 0, W, 26 * dpr);
      ctx.fillStyle = '#cad6e6'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = (12 * dpr) + 'px "Flux Architect", monospace';
      ctx.fillText('2D PRESS (DXF) · STEP ' + st + '/' + maxStep + ' · ' + (aw.id || '') + ' · GOOSENECK #453', 10 * dpr, 13 * dpr);
      if (activeCb && aw && aw.id !== _lastA) { _lastA = aw.id; activeCb(aw.id, aw.step); }
    }
    var raf = null, startTs = null, paused = false, pauseT = 0, activeCb = null, _lastA = null, ro = null;
    function resize() { var cw = canvas.clientWidth || 560, chh = canvas.clientHeight || 300; canvas.width = Math.round(cw * dpr); canvas.height = Math.round(chh * dpr); }
    function loop(ts) { if (paused) return; if (startTs == null) startTs = ts - pauseT; var t = (ts - startTs) % totalT; pauseT = t; frame(t); raf = requestAnimationFrame(loop); }
    resize(); try { ro = new ResizeObserver(function () { resize(); frame(pauseT); }); ro.observe(canvas); } catch (e) {}
    raf = requestAnimationFrame(loop);
    return {
      frame: frame, setTime: function (v) { pauseT = v; frame(v); },
      destroy: function () { if (raf) cancelAnimationFrame(raf); if (ro) try { ro.disconnect(); } catch (e) {} },
      toggle: function () { paused = !paused; if (!paused) { startTs = null; raf = requestAnimationFrame(loop); } else if (raf) cancelAnimationFrame(raf); },
      isPlaying: function () { return !paused; },
      set onstatus(fn) {}, set onactive(fn) { activeCb = fn; _lastA = null; },
      setPunchOverride: function () {}, setDieOverride: function () {}, recordClip: function () {}
    };
  }

  window.kdSimBend3D_AI = { mount: mount, mount2d: mount2d, mountFromFlat: mountFromFlat, mount2dFromFlat: mount2dFromFlat,
                            SASH_PROF: SASH_PROF, GOOSE_PROF: GOOSE_PROF };
})();
