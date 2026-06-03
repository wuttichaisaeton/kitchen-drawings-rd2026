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
  var START = 350, MOVE = 700, HOLD = 220, END = 900;   // ms
  var PEN_HI = 34;   // punch tip lift above the bend line when the wall is flat (descends to ~1 when folded)
  var HORN_GAP = 1.5;   // mm gap each end so the punch clears the already-standing perpendicular walls
  var SEG_MID = [300, 200, 50, 40, 20, 15, 10];   // Kyokko middle segments (horns = 100 at each end)

  function mount(canvas, record, code) {
    var box = record && record.box_geom;
    if (!box || !canvas) return null;
    var ctx = canvas.getContext('2d');
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    var base = box.base || { w: 200, h: 200 };
    var allWalls = (box.walls || []).slice();
    if (!allWalls.length) return null;

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
    // ONE tooling set for the whole job (เอ๋: don't swap tools — set up once, bend all
    // steps). If any wall needs a gooseneck, the gooseneck #453 covers every bend.
    var ONE_GOOSE = allWalls.some(function (x) { return x.punch === 'gooseneck' || x.needs_gooseneck; });

    // fold fraction 0..1 for a given step at time t
    function frac(step, t) {
      var s = START + (step - 1) * (MOVE + HOLD);
      if (t < s) return 0;
      if (t >= s + MOVE) return 1;
      return (t - s) / MOVE;
    }

    // ── 3-D point builders (z up; base in z=0 plane, centred at origin) ──
    function wallQuad(w, deg) {
      var th = deg * R, off = w.offset, h = w.height, hw = w.width / 2;
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
      var tot = (mainDeg + lipDeg) * R, h = lip.height;
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
    function scaleProf(p, k) { return p.map(function (q) { return [q[0] * k, q[1] * k]; }); }

    // ── isometric projection (camera az/elev fixed) ──
    var ISO = 26 * R;
    // view from ABOVE: world +z renders UP on screen (tray opens up / หงายขึ้น),
    // so die (z<0) sits at the bottom and the punch (z>0) comes down from the top.
    function iso(p) { return { x: (p.x - p.y) * Math.cos(ISO), y: p.z - (p.x + p.y) * Math.sin(ISO) }; }
    function depth(p) { return p.x + p.y + p.z * 1.5; }   // painter's: bigger = nearer (above-front cam), draw last

    // static scale/centre from the fully-folded bounds (stable, no jump)
    var scale = 1, cx = 0, cy = 0;
    function computeFit(w, h) {
      var pts = [].concat(baseQuad());
      pairs.forEach(function (pr) {
        pts = pts.concat(wallQuad(pr.main, pr.main.angle_deg || 90));
        if (pr.lip) pts = pts.concat(lipQuad(pr.main, pr.main.angle_deg || 90, pr.lip, pr.lip.angle_deg || 90));
        // include the (real, tall) tooling envelope so the punch never clips off-canvas
        var prof = pr.main.punch === 'gooseneck' ? GOOSE_PROF : SASH_PROF;
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

    // ── press tooling: die (V-groove block under the bend line) + punch (blade
    // descending from above), shown at the ACTIVE wall's bend line, extruded
    // along the wall width. Cross-section [u across hinge, z up], tip at origin. ──
    // Punch silhouettes are REAL outlines lifted 1:1 from เอ๋'s clean DXFs (tip
    // at origin, +z up — same recipe as tool-art.js): SASH = Kyokko #202 (W26×H130),
    // GOOSE = Kyokko gooseneck #453 v4 Assembly (W56×H120, concave throat on the
    // left). TOOL_SCALE shrinks them uniformly if they dwarf the part on screen.
    var TOOL_SCALE = 0.5;
    var DIE_PROF   = [[-13, 0], [-4, 0], [0, -6], [4, 0], [13, 0], [13, -16], [-13, -16]];
    var SASH_PROF  = scaleProf([[0,0],[12.728,12.728],[12.728,87],[20.728,95],[20.728,105],[17.728,105],[17.728,112.5],[20.728,112.5],[20.728,130],[7.728,130],[7.728,100],[-5.272,100],[-5.272,95],[2.728,87],[2.728,13.618],[-5.444,5.445]], TOOL_SCALE);
    var GOOSE_PROF = scaleProf([[0,0],[4.09,4.39],[4.09,4.85],[8.9,10],[20.31,22.24],[28.65,31.18],[49,53],[49,77],[36,90],[20,90],[20,95],[17,95],[17,103],[20,103],[17,120],[7,120],[7,90],[-7,90],[-7,81],[11.84,61.5],[13.01,60.13],[14.01,58.62],[14.82,57.01],[15.43,55.31],[15.84,53.56],[16.03,51.76],[16,49.95],[15.76,48.17],[15.3,46.42],[14.64,44.74],[8.32,31.18],[4.15,22.24],[-1.56,10],[-4.24,4.25]], TOOL_SCALE);
    function csTo3d(w, u, z, e) {
      var sg = w.side === '+' ? 1 : -1, off = w.offset;
      if (w.axis === 'X') return { x: sg * off + u, y: e, z: z };
      return { x: e, y: sg * off + u, z: z };
    }
    // ── item 3: punch half-length along the bend line. If a perpendicular wall is
    // already standing (folded at an earlier step), the blade must end INSIDE it —
    // shorter than the wall width and centred — so it doesn't crush the up wing.
    function punchHalf(aw) {
      var hw = aw.width / 2, inside = Infinity;
      allWalls.forEach(function (x) {
        if (x.axis !== aw.axis && x.step < aw.step && x.height >= aw.height - 0.01)
          inside = Math.min(inside, x.offset);
      });
      return inside < Infinity ? Math.min(hw, inside - HORN_GAP) : hw;
    }
    // ── item 2: cut positions along a bar of length L assembled from standard
    // Kyokko segments (punch reserves a 100 mm horn at each end). Returns boundary
    // offsets in [0,L] for drawing the segment-joint lines.
    function segBoundaries(L, isPunch) {
      var rem = L, segs = [], horn = isPunch && L >= 200;
      if (horn) { segs.push(100); rem -= 200; }
      for (var k = 0; k < SEG_MID.length; k++) {
        while (rem >= SEG_MID[k] - 0.01 && rem > 8) { segs.push(SEG_MID[k]); rem -= SEG_MID[k]; if (segs.length > 80) { rem = 0; break; } }
      }
      if (rem > 0.5 && segs.length) segs[segs.length - 1] += rem;
      if (horn) segs.push(100);
      var b = [], acc = 0;
      for (var i = 0; i < segs.length - 1; i++) { acc += segs[i]; b.push(acc); }
      return b;
    }
    function addExtrusion(items, w, prof, zOff, fill, stroke, dbias, eHalf, uSign, seam) {
      if (eHalf == null) eHalf = w.width / 2;
      if (uSign && uSign !== 1) prof = prof.map(function (p) { return [p[0] * uSign, p[1]]; });
      var front = prof.map(function (p) { return csTo3d(w, p[0], p[1] + zOff, eHalf); });
      var back = prof.map(function (p) { return csTo3d(w, p[0], p[1] + zOff, -eHalf); });
      for (var i = 0; i < prof.length; i++) {
        var j = (i + 1) % prof.length;
        var q = [front[i], front[j], back[j], back[i]];
        items.push({ pts: q, fill: fill, stroke: stroke, lw: 1, d: cen(q) + (dbias || 0) });
      }
      items.push({ pts: front, fill: fill, stroke: stroke, lw: 1, d: cen(front) + (dbias || 0) + 0.3 });
      items.push({ pts: back, fill: fill, stroke: stroke, lw: 1, d: cen(back) + (dbias || 0) - 0.3 });
      if (seam) seam.forEach(function (bpos) {                       // segment-joint lines
        var e = -eHalf + bpos;
        var loop = prof.map(function (p) { return csTo3d(w, p[0], p[1] + zOff, e); });
        items.push({ pts: loop, fill: null, stroke: stroke, lw: 0.7, d: cen(loop) + (dbias || 0) + 0.2 });
      });
    }

    function frame(t) {
      var w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      computeFit(w, h);

      // active step (1-based) at time t
      var active = 0;
      for (var st = 1; st <= maxStep; st++) { if (t >= START + (st - 1) * (MOVE + HOLD)) active = st; }

      // collect drawables (base + per wall its quad, + lip) with depth + style
      var items = [];
      var bq = baseQuad();
      items.push({ pts: bq, fill: C_BASE, stroke: C_BASE_E, lw: 1.5, d: depth({ x: 0, y: 0, z: 0 }) - 1e6 });
      pairs.forEach(function (pr) {
        var m = pr.main, mw = m.collides ? C_RED : (ONE_GOOSE || m.punch === 'gooseneck' ? C_GOOSE : C_SASH);
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

      // press tooling at the active wall's bend line: die (static, below) +
      // punch (descends from above as the wall folds; sash vs gooseneck shape).
      var aw = null; allWalls.forEach(function (x) { if (x.step === active) aw = x; });
      if (aw && active >= 1) {
        var f = frac(aw.step, t);
        var penZ = PEN_HI * (1 - f) + 1;             // punch tip: high when flat → ~0 when folded
        var pFill = aw.collides ? C_RED : C_PUNCH, pStroke = aw.collides ? C_RED : C_PUNCH_E;
        var eHalf = punchHalf(aw);                   // item 3: shorten + centre vs standing walls
        var uSign = aw.side === '+' ? 1 : -1;        // throat (concave) hugs the rising flap (clears the sheet being folded)
        var prof = (ONE_GOOSE || aw.punch === 'gooseneck') ? GOOSE_PROF : SASH_PROF;
        addExtrusion(items, aw, DIE_PROF, 0, C_DIE, C_DIE_E, -3, aw.width / 2, 1, segBoundaries(aw.width, false)); // die: full bed, segmented
        addExtrusion(items, aw, prof, penZ, pFill, pStroke, 6, eHalf, uSign, segBoundaries(eHalf * 2, true));      // punch: real shape, segmented, shorter+centred
      }

      items.sort(function (a, b) { return a.d - b.d; });
      items.forEach(function (it) { fillQuad(it.pts, it.fill, it.stroke, it.lw); });

      drawHud(w, h, active, t);
    }
    function cen(q) { var c = { x: 0, y: 0, z: 0 }; q.forEach(function (p) { c.x += p.x / 4; c.y += p.y / 4; c.z += p.z / 4; }); return depth(c); }
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
      var tlen = wall ? Math.round(punchHalf(wall) * 2) : 0;
      var clr = wall && tlen < Math.round(wall.width) ? ' (horn-clr ' + tlen + '<' + Math.round(wall.width) + ')' : '';
      var hud = wall
        ? ('STEP ' + active + '/' + maxStep + '  ·  ' + wall.id + '  ·  ' + wall.axis + (wall.side || '') +
           '  ·  PUNCH: ' + (ONE_GOOSE ? 'GOOSENECK #453' : (wall.punch || 'sash').toUpperCase()) + (ONE_GOOSE ? ' (1 setup, all ' + maxStep + ')' : '') +
           '  ·  TOOL ' + tlen + 'mm' + clr)
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
      destroy: function () { if (raf) cancelAnimationFrame(raf); if (ro) try { ro.disconnect(); } catch (e) {} },
      toggle: function () { paused = !paused; if (!paused) { startTs = null; raf = requestAnimationFrame(loop); } else if (raf) cancelAnimationFrame(raf); },
      isPlaying: function () { return !paused; },
      set onstatus(fn) { statusCb = fn; },
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

  window.kdSimBend3D = { mount: mount };
})();
