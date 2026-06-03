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

    // ── isometric projection (camera az/elev fixed) ──
    var ISO = 26 * R;
    function iso(p) { return { x: (p.x - p.y) * Math.cos(ISO), y: (p.x + p.y) * Math.sin(ISO) - p.z }; }
    function depth(p) { return p.x + p.y - p.z * 1.5; }   // painter's: bigger = nearer-back, draw first

    // static scale/centre from the fully-folded bounds (stable, no jump)
    var scale = 1, cx = 0, cy = 0;
    function computeFit(w, h) {
      var pts = [].concat(baseQuad());
      pairs.forEach(function (pr) {
        pts = pts.concat(wallQuad(pr.main, pr.main.angle_deg || 90));
        if (pr.lip) pts = pts.concat(lipQuad(pr.main, pr.main.angle_deg || 90, pr.lip, pr.lip.angle_deg || 90));
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
        var m = pr.main, mw = m.collides ? C_RED : (m.punch === 'gooseneck' ? C_GOOSE : C_SASH);
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
      var hud = wall
        ? ('STEP ' + active + '/' + maxStep + '  ·  ' + wall.id + '  ·  ' + wall.axis + (wall.side || '') +
           '  ·  PUNCH: ' + (wall.punch || 'sash').toUpperCase() + (wall.needs_gooseneck ? ' (GN)' : '') +
           '  ·  H' + wall.height)
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
