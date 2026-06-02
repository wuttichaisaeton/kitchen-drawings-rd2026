/* simbend-sim.js — 2D press-brake bend-sequence animation for the Sim.Bending
 * view. Synthesizes a folding cross-section from a bend_sim record's per_bend +
 * order data and animates the part folding bend-by-bend, with a punch/die at the
 * active bend and a red highlight where a bend collides. Exposes:
 *   window.kdSimBend.mount(canvas, record, code) -> controller
 *     controller: { play(), pause(), toggle(), restart(), recordClip(), destroy(),
 *                   isPlaying() , onstatus: fn(text) }
 * No build step, no deps. 2026-06-02 (Group 1, P4 visual sim).
 */
(function () {
  'use strict';
  var FOLD = 750, HOLD = 450, END_HOLD = 900;   // ms per bend phase
  function rad(d) { return d * Math.PI / 180; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // ---- model ------------------------------------------------------------
  function buildModel(record) {
    var per = (record && record.per_bend) || [];
    var spatial = per.map(function (b, i) {
      return {
        id: b.bend != null ? b.bend : ('B' + (i + 1)),
        idx: i,
        angle: (b.angle_deg != null ? b.angle_deg : 90),
        collides: !!b.collides,
        hits: b.hits || 'punch',
        at_angle: (b.at_angle != null ? b.at_angle : null),
        die: b.die || null,
        ok: b.ok !== false,
        flange: (b.flange_mm != null ? b.flange_mm : 30)
      };
    });
    var N = spatial.length;
    var idToIdx = {}; spatial.forEach(function (s) { idToIdx[s.id] = s.idx; });
    var order;
    if (Array.isArray(record.order) && record.order.length) {
      order = record.order.map(function (id) { return idToIdx[id]; })
                          .filter(function (i) { return i != null; });
    } else {
      order = spatial.map(function (s) { return s.idx; });
    }
    // segment lengths (virtual units) ~ flange, clamped, +1 leading segment
    var segLen = [1.0];
    for (var k = 0; k < N; k++) {
      var f = spatial[k].flange;
      segLen.push(Math.max(0.6, Math.min(2.2, f / 25)));
    }
    var model = { record: record, spatial: spatial, N: N, order: order,
                  segLen: segLen, bendable: !!record.bendable };
    buildTimeline(model);
    return model;
  }

  function buildTimeline(model) {
    var phases = [], t = 0;
    for (var s = 0; s < model.order.length; s++) {
      var idx = model.order[s], b = model.spatial[idx];
      var blocking = b.collides;            // a colliding bend can't complete
      var target = (blocking && b.at_angle != null) ? b.at_angle : b.angle;
      phases.push({ idx: idx, b: b, step: s + 1, t0: t, tFold: t + FOLD,
                    tEnd: t + FOLD + HOLD, target: target, blocking: blocking });
      t += FOLD + HOLD;
      if (blocking && !model.bendable) break;   // sequence stops at the block
    }
    model.phases = phases;
    model.totalT = t + END_HOLD;
  }

  function angleByIdxAt(model, t) {
    var a = {};
    model.spatial.forEach(function (s) { a[s.idx] = 0; });
    var active = null, step = 0, collide = false, activeBend = null;
    for (var i = 0; i < model.phases.length; i++) {
      var p = model.phases[i];
      if (t >= p.tEnd) { a[p.idx] = p.target; }
      else if (t >= p.tFold) {
        a[p.idx] = p.target; active = p.idx; step = p.step; activeBend = p.b;
        if (p.blocking) collide = true;
      } else if (t >= p.t0) {
        a[p.idx] = lerp(0, p.target, (t - p.t0) / FOLD);
        active = p.idx; step = p.step; activeBend = p.b;
      }
    }
    if (t >= model.totalT - END_HOLD) {
      var lp = model.phases[model.phases.length - 1];
      if (lp) { step = lp.step; active = lp.idx; activeBend = lp.b;
        if (lp.blocking || !model.bendable) collide = lp.blocking || collide; }
    }
    return { a: a, active: active, step: step, collide: collide, activeBend: activeBend };
  }

  // vertices in math coords (y up) for a given angle map
  function vertices(model, a) {
    var pts = [{ x: 0, y: 0 }], dir = 0;
    for (var k = 0; k <= model.N; k++) {
      var L = model.segLen[k];
      pts.push({ x: pts[k].x + Math.cos(dir) * L, y: pts[k].y + Math.sin(dir) * L });
      if (k < model.N) dir += rad(a[k] || 0);
    }
    return pts;
  }

  function bounds(pts) {
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    pts.forEach(function (p) {
      if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
      if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
    });
    return { minx: minx, miny: miny, maxx: maxx, maxy: maxy };
  }

  // ---- rendering --------------------------------------------------------
  function mount(canvas, record, code) {
    var model = buildModel(record);
    var ctx = canvas.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var raf = null, playing = false, startT = 0, pausedAt = 0, statusCb = null;

    // stable fit: union of the flat shape and the fully-folded shape
    var flat = vertices(model, {});
    var fullAngles = {}; model.spatial.forEach(function (s) {
      fullAngles[s.idx] = (s.collides && s.at_angle != null) ? s.at_angle : s.angle; });
    var folded = vertices(model, fullAngles);
    var bb = bounds(flat.concat(folded));

    function resize() {
      var w = canvas.clientWidth || 600, h = canvas.clientHeight || 320;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }

    function fit() {
      var w = canvas.width, h = canvas.height, pad = 46 * dpr;
      var gw = (bb.maxx - bb.minx) || 1, gh = (bb.maxy - bb.miny) || 1;
      var sc = Math.min((w - pad * 2) / gw, (h - pad * 2) / gh);
      var cx = (bb.minx + bb.maxx) / 2, cy = (bb.miny + bb.maxy) / 2;
      return {
        sc: sc,
        px: function (p) { return w / 2 + (p.x - cx) * sc; },
        py: function (p) { return h / 2 - (p.y - cy) * sc; }   // flip y
      };
    }

    function drawTool(T, vtx, blocked, t, phaseT) {
      // vtx = active bend vertex (screen). die V below, punch wedge above.
      var x = T.px(vtx), y = T.py(vtx);
      var s = Math.max(18 * dpr, T.sc * 0.32);
      var shake = blocked ? Math.sin(t / 40) * 2 * dpr : 0;
      // die (grey V opening up, below the part)
      ctx.strokeStyle = '#6b7785'; ctx.lineWidth = 3 * dpr; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x - s * 1.4, y + s * 1.6);
      ctx.lineTo(x, y + s * 0.15);
      ctx.lineTo(x + s * 1.4, y + s * 1.6);
      ctx.stroke();
      // punch (wedge from above descending; lower as the fold progresses)
      var drop = lerp(s * 1.3, s * 0.18, Math.min(1, phaseT));
      var py = y - drop + shake;
      ctx.fillStyle = blocked ? 'rgba(224,87,74,0.92)' : 'rgba(150,162,176,0.92)';
      ctx.beginPath();
      ctx.moveTo(x, py);
      ctx.lineTo(x - s * 0.5, py - s * 1.5);
      ctx.lineTo(x + s * 0.5, py - s * 1.5);
      ctx.closePath(); ctx.fill();
    }

    function frame(tNow) {
      resize();
      var t = tNow;
      var st = angleByIdxAt(model, t);
      var pts = vertices(model, st.a);
      var T = fit();
      var w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // bed line
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.moveTo(0, h * 0.62); ctx.lineTo(w, h * 0.62); ctx.stroke();

      // tool at the active bend (bend k lives at vertex k+1)
      if (st.active != null) {
        var vtx = pts[st.active + 1];
        // phase progress for punch drop
        var p = null;
        for (var i = 0; i < model.phases.length; i++)
          if (model.phases[i].idx === st.active) p = model.phases[i];
        var phaseT = p ? Math.min(1, Math.max(0, (t - p.t0) / FOLD)) : 1;
        drawTool(T, vtx, st.collide, t, phaseT);
      }

      // the part (thick steel polyline)
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.lineWidth = 7 * dpr;
      var grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#cfe0f2'); grad.addColorStop(1, '#7d93ab');
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(T.px(pts[0]), T.py(pts[0]));
      for (var k = 1; k < pts.length; k++) ctx.lineTo(T.px(pts[k]), T.py(pts[k]));
      ctx.stroke();

      // bend dots: green = done/clear, amber = active, red = collide
      model.spatial.forEach(function (s) {
        var v = pts[s.idx + 1];
        var done = st.a[s.idx] >= ((s.collides && s.at_angle != null) ? s.at_angle : s.angle) - 0.01;
        var col = '#2f3a47';
        if (s.collides && (st.active === s.idx || (st.collide && st.active === s.idx))) col = '#e0574a';
        else if (st.active === s.idx) col = '#f2b84e';
        else if (done) col = (s.collides ? '#e0574a' : '#4ecca3');
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(T.px(v), T.py(v), 5 * dpr, 0, Math.PI * 2); ctx.fill();
      });

      // collision flash overlay near the active bend
      if (st.collide && st.active != null) {
        var cv = pts[st.active + 1];
        ctx.strokeStyle = 'rgba(224,87,74,' + (0.5 + 0.5 * Math.abs(Math.sin(t / 120))) + ')';
        ctx.lineWidth = 3 * dpr;
        ctx.beginPath(); ctx.arc(T.px(cv), T.py(cv), 16 * dpr, 0, Math.PI * 2); ctx.stroke();
      }

      // HUD text (top-left)
      ctx.fillStyle = '#cad6e6';
      ctx.font = (13 * dpr) + 'px "Flux Architect", monospace';
      ctx.textBaseline = 'top';
      var hud;
      if (st.activeBend) {
        hud = 'Step ' + st.step + '/' + model.phases.length + '  ·  ' +
              st.activeBend.id + (st.activeBend.die ? ' (' + st.activeBend.die + ')' : '') +
              '  ·  ' + Math.round(st.activeBend.angle) + '°';
      } else { hud = 'flat blank'; }
      ctx.fillText(hud, 12 * dpr, 10 * dpr);
      if (st.collide) {
        ctx.fillStyle = '#e0574a';
        ctx.fillText('✗ ' + (st.activeBend ? st.activeBend.id : '') + ' hits ' +
          (st.activeBend ? st.activeBend.hits : 'punch') +
          (st.activeBend && st.activeBend.at_angle != null ? ' @' + Math.round(st.activeBend.at_angle) + '°' : ''),
          12 * dpr, 30 * dpr);
      }
      // verdict (bottom)
      ctx.textAlign = 'left';
      ctx.fillStyle = model.bendable ? '#4ecca3' : '#e0574a';
      ctx.font = 'bold ' + (14 * dpr) + 'px "Flux Architect", monospace';
      var verdict = model.bendable
        ? '✓ BENDABLE  —  ' + model.order.map(function (i) { return model.spatial[i].id; }).join(' → ')
        : '✗ NOT BENDABLE' + (record.reason ? '  —  ' + record.reason : '');
      ctx.fillText(verdict, 12 * dpr, h - 24 * dpr);
    }

    function loop(now) {
      if (!playing) return;
      var t = (now - startT) % model.totalT;
      frame(t);
      raf = requestAnimationFrame(loop);
    }

    function play() {
      if (playing) return;
      playing = true;
      startT = performance.now() - pausedAt;
      raf = requestAnimationFrame(loop);
      if (statusCb) statusCb('playing');
    }
    function pause() {
      if (!playing) return;
      playing = false;
      pausedAt = (performance.now() - startT) % model.totalT;
      if (raf) cancelAnimationFrame(raf);
      if (statusCb) statusCb('paused');
    }
    function toggle() { playing ? pause() : play(); }
    function restart() { pausedAt = 0; startT = performance.now(); if (!playing) play(); }
    function destroy() { playing = false; if (raf) cancelAnimationFrame(raf); }

    function recordClip() {
      if (!canvas.captureStream || typeof MediaRecorder === 'undefined') {
        if (statusCb) statusCb('clip not supported in this browser');
        return;
      }
      var stream = canvas.captureStream(30);
      var mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9' : 'video/webm';
      var rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4000000 });
      var chunks = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = function () {
        var blob = new Blob(chunks, { type: 'video/webm' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = (code || 'bend-sim') + '.webm';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        if (statusCb) statusCb('clip saved');
      };
      restart(); rec.start();
      if (statusCb) statusCb('recording…');
      setTimeout(function () { try { rec.stop(); } catch (e) {} }, model.totalT + 60);
    }

    // initial paint + autoplay
    resize(); frame(0); play();

    return {
      play: play, pause: pause, toggle: toggle, restart: restart,
      recordClip: recordClip, destroy: destroy,
      isPlaying: function () { return playing; },
      set onstatus(fn) { statusCb = fn; }
    };
  }

  window.kdSimBend = { mount: mount };
})();
