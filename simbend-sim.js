/* simbend-sim.js — REALISTIC press-brake station animation for Sim.Bending.
 * Die fixed at the bottom; the punch (real profile) descends and presses the
 * sheet into the V groove; the bend forms at the die one stroke at a time, the
 * part re-anchoring so the active bend sits over the V (as on a real brake).
 * Colliding bends flash red. ▶/⏸ + ⬇ Clip (.webm). 2026-06-02 rev2 (Group 1).
 *   window.kdSimBend.mount(canvas, record, code) -> controller
 */
(function () {
  'use strict';
  var FOLD = 900, HOLD = 350, MOVE = 450, END_HOLD = 800;   // ms per phase part
  function rad(d) { return d * Math.PI / 180; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
  function norm(a) { var m = Math.hypot(a.x, a.y) || 1; return { x: a.x / m, y: a.y / m }; }

  // ---- model ------------------------------------------------------------
  function buildModel(record) {
    var per = (record && record.per_bend) || [];
    var spatial = per.map(function (b, i) {
      var v = b.v_mm != null ? b.v_mm
            : (b.radius_mm != null ? b.radius_mm / 0.16 : 8);
      return {
        id: b.bend != null ? b.bend : ('B' + (i + 1)),
        idx: i,
        angle: (b.angle_deg != null ? b.angle_deg : 90),
        collides: !!b.collides,
        hits: b.hits || 'punch',
        at_angle: (b.at_angle != null ? b.at_angle : null),
        die: b.die || null,
        v: v,
        gooseneck: (b.die || '').indexOf('GN') >= 0,
        flange: Math.max(18, (b.flange_mm != null ? b.flange_mm : 35))
      };
    });
    var N = spatial.length;
    var idToIdx = {}; spatial.forEach(function (s) { idToIdx[s.id] = s.idx; });
    var order = (Array.isArray(record.order) && record.order.length)
      ? record.order.map(function (id) { return idToIdx[id]; }).filter(function (i) { return i != null; })
      : spatial.map(function (s) { return s.idx; });
    var segLen = [Math.max(20, spatial[0] ? spatial[0].flange : 30)];
    for (var k = 0; k < N; k++) segLen.push(spatial[k].flange);
    var model = { record: record, spatial: spatial, N: N, order: order,
                  segLen: segLen, bendable: !!record.bendable };
    buildTimeline(model);
    return model;
  }

  function buildTimeline(model) {
    var phases = [], t = 0;
    for (var s = 0; s < model.order.length; s++) {
      var idx = model.order[s], b = model.spatial[idx];
      var blocking = b.collides;
      var target = (blocking && b.at_angle != null) ? b.at_angle : b.angle;
      phases.push({ idx: idx, b: b, step: s + 1,
                    tMove: t, t0: t + MOVE, tFold: t + MOVE + FOLD,
                    tEnd: t + MOVE + FOLD + HOLD, target: target, blocking: blocking });
      t += MOVE + FOLD + HOLD;
      if (blocking && !model.bendable) break;
    }
    model.phases = phases;
    model.totalT = t + END_HOLD;
  }

  function stateAt(model, t) {
    var a = {}; model.spatial.forEach(function (s) { a[s.idx] = 0; });
    var active = null, step = 0, collide = false, ab = null, descend = 0, moving = false;
    for (var i = 0; i < model.phases.length; i++) {
      var p = model.phases[i];
      // bends formed in earlier phases stay at their target
      if (i < curPhaseIndex(model, t)) a[p.idx] = p.target;
      if (t >= p.tMove && t < p.tEnd) {
        active = p.idx; step = p.step; ab = p.b;
        if (t < p.t0) { moving = true; a[p.idx] = 0; descend = 0; }
        else if (t < p.tFold) {
          var f = (t - p.t0) / FOLD; a[p.idx] = lerp(0, p.target, f); descend = f;
        } else { a[p.idx] = p.target; descend = 1; if (p.blocking) collide = true; }
      }
    }
    if (t >= model.totalT - END_HOLD) {
      var lp = model.phases[model.phases.length - 1];
      if (lp) { step = lp.step; active = lp.idx; ab = lp.b; a[lp.idx] = lp.target; descend = 1;
        if (lp.blocking || !model.bendable) collide = lp.blocking || collide; }
    }
    return { a: a, active: active, step: step, collide: collide, ab: ab, descend: descend, moving: moving };
  }
  function curPhaseIndex(model, t) {
    for (var i = 0; i < model.phases.length; i++) if (t < model.phases[i].tEnd) return i;
    return model.phases.length;
  }

  // chain vertices in mm (y up), flat baseline along +x
  function vertices(model, a) {
    var pts = [{ x: 0, y: 0 }], dir = 0;
    for (var k = 0; k <= model.N; k++) {
      pts.push({ x: pts[k].x + Math.cos(dir) * model.segLen[k],
                 y: pts[k].y + Math.sin(dir) * model.segLen[k] });
      if (k < model.N) dir += rad(a[k] || 0);
    }
    return pts;
  }

  // re-anchor so active bend vertex sits at the die, concave (punch) side up
  function anchor(pts, model, st) {
    var k = st.active, Vi = k + 1, V = pts[Vi];
    var r1 = pts[k] ? norm(sub(pts[k], V)) : null;
    var r2 = pts[k + 2] ? norm(sub(pts[k + 2], V)) : null;
    var bis;
    if (r1 && r2) bis = { x: r1.x + r2.x, y: r1.y + r2.y };
    else { var r = r1 || r2; bis = { x: -r.x, y: -r.y }; }
    if (Math.hypot(bis.x, bis.y) < 1e-6) bis = { x: 0, y: 1 };
    var bang = Math.atan2(bis.y, bis.x);
    var rot = Math.PI / 2 - bang;            // bisector -> +y (up toward punch)
    var c = Math.cos(rot), s = Math.sin(rot);
    var activeV = model.overrideDieV != null ? model.overrideDieV : model.spatial[k].v;
    var pen = (activeV / 2) * Math.tan(rad((st.a[k] || 0) / 2)) * st.descend;
    var out = pts.map(function (p) {
      var dx = p.x - V.x, dy = p.y - V.y;
      return { x: dx * c - dy * s, y: dx * s + dy * c - pen };
    });
    return { pts: out, pen: pen };
  }

  // ---- mount ------------------------------------------------------------
  function mount(canvas, record, code) {
    var model = buildModel(record);
    var ctx = canvas.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var raf = null, playing = false, startT = 0, pausedAt = 0, statusCb = null;
    var maxFlange = Math.max.apply(null, model.segLen);

    function resize() {
      var w = canvas.clientWidth || 600, h = canvas.clientHeight || 340;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }

    function drawDie(cx, cy, v, scale, dieAngle, type, vList) {
      dieAngle = dieAngle || 88;
      type = type || '1V';
      vList = vList || [v];
      var halfAng = rad(dieAngle / 2);
      var depth = (v / 2) / Math.tan(halfAng);
      
      var H = type === '2V' ? 30 : 25;

      ctx.fillStyle = '#000000';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.5 * dpr;

      ctx.beginPath();
      if (type === '2V' && vList.length >= 2) {
        var v1 = vList[0], v2 = vList[1];
        var spacing = Math.max(22, (v1 + v2) * 1.1);
        var v_top = v;
        var v_bottom = v === v1 ? v2 : v1;
        var depth_top = depth;
        var depth_bottom = (v_bottom / 2) / Math.tan(halfAng);
        
        var blockW = spacing + (v1 + v2) * 1.1 + 18;
        blockW = Math.max(36, Math.min(126, blockW));

        var leftX = cx - (blockW / 2) * scale;
        var rightX = cx + (blockW / 2) * scale;
        var botY = cy + H * scale;

        ctx.moveTo(leftX, botY);
        ctx.lineTo(cx - (v_bottom / 2) * scale, botY);
        ctx.lineTo(cx, botY - depth_bottom * scale);
        ctx.lineTo(cx + (v_bottom / 2) * scale, botY);
        ctx.lineTo(rightX, botY);
        ctx.lineTo(rightX, cy);
        ctx.lineTo(cx + (v_top / 2) * scale, cy);
        ctx.lineTo(cx, cy + depth_top * scale);
        ctx.lineTo(cx - (v_top / 2) * scale, cy);
        ctx.lineTo(leftX, cy);
      } else {
        // 1V
        var blockW = Math.max(34, v * 2.2);
        blockW = Math.max(36, Math.min(126, blockW));

        var leftX = cx - (blockW / 2) * scale;
        var rightX = cx + (blockW / 2) * scale;
        var botY = cy + H * scale;
        var tangY = botY + 12 * scale;

        ctx.moveTo(leftX, cy);
        ctx.lineTo(cx - (v / 2) * scale, cy);
        ctx.lineTo(cx, cy + depth * scale);
        ctx.lineTo(cx + (v / 2) * scale, cy);
        ctx.lineTo(rightX, cy);
        ctx.lineTo(rightX, botY);
        ctx.lineTo(cx + 6.5 * scale, botY);
        ctx.lineTo(cx + 6.5 * scale, tangY);
        ctx.lineTo(cx - 6.5 * scale, tangY);
        ctx.lineTo(cx - 6.5 * scale, botY);
        ctx.lineTo(leftX, botY);
      }
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    }

    function drawPunch(cx, tipY, blocked, type, t, scale) {
      var shake = blocked ? Math.sin(t / 35) * 2.5 * dpr : 0;
      var x = cx + shake;
      
      var H = 120;
      var ang = 88;
      var R = 0.8;
      if (type === 'gooseneck') { H = 150; ang = 88; R = 0.8; }
      else if (type === 'acute') { H = 130; ang = 30; R = 0.4; }
      else if (type === 'hemming') { H = 100; ang = 0; R = 0.0; }

      ctx.fillStyle = blocked ? 'rgba(224,87,74,0.95)' : '#000000';
      ctx.strokeStyle = blocked ? '#ff7a6c' : '#000000';
      ctx.lineWidth = 1.4 * dpr;

      var topY = 160 - H;
      var tangH = 32;
      var tangY1 = topY;
      var tangY2 = topY + tangH;

      function tx(artX) { return x + (artX - 50) * scale; }
      function ty(artY) { return tipY - (160 - artY) * scale; }

      var bodyW = 28;
      var halfAng = ang / 2;
      var rise = (bodyW / 2) / Math.tan(rad(halfAng));
      var maxRise = H - 45;
      var actualRise = Math.min(rise, maxRise);
      var shoulderY = 160 - actualRise;
      var shoulderW = actualRise * Math.tan(rad(halfAng));

      ctx.beginPath();
      
      // Start of combined path at tang top-left corner
      ctx.moveTo(tx(43), ty(tangY1));
      ctx.lineTo(tx(57), ty(tangY1));
      ctx.lineTo(tx(57), ty(tangY2 - 2));
      ctx.lineTo(tx(55), ty(tangY2 - 2));
      ctx.lineTo(tx(55), ty(tangY2));

      // Clockwise body profile
      if (type === 'hemming') {
        ctx.lineTo(tx(64), ty(tangY2 + 4));
        ctx.lineTo(tx(64), ty(160 - 8));
        ctx.lineTo(tx(62), ty(160 - 6));
        ctx.lineTo(tx(62), ty(160));
        ctx.lineTo(tx(38), ty(160));
        ctx.lineTo(tx(38), ty(160 - 6));
        ctx.lineTo(tx(36), ty(160 - 8));
        ctx.lineTo(tx(36), ty(tangY2 + 4));
      } else {
        // Right side of body
        if (type === 'gooseneck') {
          var throatY1 = tangY2 + 10;
          var throatY2 = (throatY1 + shoulderY) / 2;
          ctx.lineTo(tx(64), ty(throatY1));
          ctx.quadraticCurveTo(tx(22), ty(throatY1 + 10), tx(25), ty(throatY2));
          ctx.quadraticCurveTo(tx(28), ty(throatY2 + 20), tx(50 + shoulderW), ty(shoulderY));
        } else {
          ctx.lineTo(tx(64), ty(tangY2 + 4));
          ctx.lineTo(tx(64), ty(shoulderY));
          ctx.lineTo(tx(50 + shoulderW), ty(shoulderY));
        }

        // Wedge tip with radius R
        var tipR = Math.max(0.4, Math.min(R, 2.5));
        var dx = tipR * Math.cos(rad(halfAng));
        var dy = tipR * Math.sin(rad(halfAng));
        var tx1 = 50 - dx;
        var ty1 = 160 - tipR + dy;
        var tx2 = 50 + dx;
        var ty2 = 160 - tipR + dy;

        ctx.lineTo(tx(tx2), ty(ty2));
        ctx.quadraticCurveTo(tx(50), ty(160), tx(tx1), ty(ty1));

        // Left side of body going back up
        ctx.lineTo(tx(50 - shoulderW), ty(shoulderY));
        ctx.lineTo(tx(36), ty(shoulderY));
        ctx.lineTo(tx(36), ty(tangY2 + 4));
      }

      // Safety hook features on the left side of tang
      ctx.lineTo(tx(45), ty(tangY2));
      ctx.lineTo(tx(45), ty(tangY2 - 2));
      ctx.lineTo(tx(43), ty(tangY2 - 7));
      ctx.lineTo(tx(43), ty(tangY2 - 13));
      ctx.lineTo(tx(45), ty(tangY2 - 16));
      ctx.lineTo(tx(45), ty(tangY2 - 23));
      ctx.lineTo(tx(43), ty(tangY2 - 26));
      ctx.lineTo(tx(43), ty(tangY1));

      ctx.closePath();
      ctx.fill(); ctx.stroke();
    }

    function frame(t) {
      resize();
      var w = canvas.width, h = canvas.height;
      var st = stateAt(model, t);
      var pts = vertices(model, st.a);
      var an = st.active != null ? anchor(pts, model, st) : { pts: pts, pen: 0 };
      var P = an.pts;

      var scale = Math.max(0.5, Math.min(4 * dpr,
        (h * 0.34) / Math.max(maxFlange, 20)));
      var dieCx = w / 2, dieCy = h * 0.58;
      function px(p) { return dieCx + p.x * scale; }
      function py(p) { return dieCy - p.y * scale; }

      ctx.clearRect(0, 0, w, h);
      // ram guide line
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.moveTo(dieCx, 0); ctx.lineTo(dieCx, h); ctx.stroke();

      var v = model.overrideDieV != null ? model.overrideDieV : (st.ab ? st.ab.v : 8);
      var dieAngle = model.overrideDieAngle != null ? model.overrideDieAngle : 88;
      var dieType = model.overrideDieType != null ? model.overrideDieType : 
        (st.ab && st.ab.die && st.ab.die.includes('2V') ? '2V' : '1V');
      var dieVList = model.overrideDieVList != null ? model.overrideDieVList : 
        (st.ab && st.ab.die && st.ab.die.includes('0608') ? [6, 8] : 
         (st.ab && st.ab.die && st.ab.die.includes('0812') ? [8, 12] : 
          (st.ab && st.ab.die && st.ab.die.includes('1220') ? [12, 20] : [v])));
          
      drawDie(dieCx, dieCy, v, scale, dieAngle, dieType, dieVList);

      // sheet (the part) — thick steel polyline
      ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.lineWidth = 6 * dpr;
      var g = ctx.createLinearGradient(0, dieCy - 80 * dpr, 0, dieCy + 20 * dpr);
      g.addColorStop(0, '#ffb03a'); g.addColorStop(1, '#ea6f09');
      ctx.strokeStyle = g;
      ctx.beginPath(); ctx.moveTo(px(P[0]), py(P[0]));
      for (var i = 1; i < P.length; i++) ctx.lineTo(px(P[i]), py(P[i]));
      ctx.stroke();

      // punch tip sits at the active bend vertex (descending into the V)
      if (st.active != null) {
        var Vtx = P[st.active + 1];
        var pType = model.overridePunchType != null ? model.overridePunchType : (model.spatial[st.active].gooseneck ? 'gooseneck' : 'standard');
        drawPunch(dieCx, py(Vtx), st.collide, pType, t, scale);
      }

      // bend dots
      model.spatial.forEach(function (sp) {
        var vtx = P[sp.idx + 1]; if (!vtx) return;
        var full = sp.collides && sp.at_angle != null ? sp.at_angle : sp.angle;
        var done = (st.a[sp.idx] || 0) >= full - 0.01;
        var col = '#33404f';
        if (st.active === sp.idx && st.collide) col = '#e0574a';
        else if (st.active === sp.idx) col = '#f2b84e';
        else if (done) col = sp.collides ? '#e0574a' : '#4ecca3';
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(px(vtx), py(vtx), 4 * dpr, 0, 7); ctx.fill();
      });

      // HUD
      ctx.fillStyle = '#cad6e6'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      ctx.font = (13 * dpr) + 'px "Flux Architect", monospace';
      if (st.ab) {
        var phaseTxt = st.moving ? 'position' : 'press';
        ctx.fillText('Step ' + st.step + '/' + model.phases.length + '  ·  ' +
          st.ab.id + (st.ab.die ? ' (' + st.ab.die + ')' : '') + '  ·  ' +
          Math.round(st.ab.angle) + '°  ·  ' + phaseTxt, 12 * dpr, 10 * dpr);
      }
      if (st.collide) {
        ctx.fillStyle = '#e0574a';
        ctx.fillText('✗ ' + (st.ab ? st.ab.id : '') + ' hits ' + (st.ab ? st.ab.hits : 'punch') +
          (st.ab && st.ab.at_angle != null ? ' @' + Math.round(st.ab.at_angle) + '°' : ''),
          12 * dpr, 30 * dpr);
      }
      ctx.fillStyle = model.bendable ? '#4ecca3' : '#e0574a';
      ctx.font = 'bold ' + (14 * dpr) + 'px "Flux Architect", monospace';
      ctx.fillText(model.bendable
        ? '✓ BENDABLE  —  ' + model.order.map(function (i) { return model.spatial[i].id; }).join(' → ')
        : '✗ NOT BENDABLE' + (record.reason ? '  —  ' + record.reason : ''),
        12 * dpr, h - 24 * dpr);
    }

    function loop(now) {
      if (!playing) return;
      frame((now - startT) % model.totalT);
      raf = requestAnimationFrame(loop);
    }
    function play() { if (playing) return; playing = true; startT = performance.now() - pausedAt; raf = requestAnimationFrame(loop); if (statusCb) statusCb('playing'); }
    function pause() { if (!playing) return; playing = false; pausedAt = (performance.now() - startT) % model.totalT; if (raf) cancelAnimationFrame(raf); if (statusCb) statusCb('paused'); }
    function toggle() { playing ? pause() : play(); }
    function restart() { pausedAt = 0; startT = performance.now(); if (!playing) play(); }
    function destroy() { playing = false; if (raf) cancelAnimationFrame(raf); }

    function recordClip() {
      if (!canvas.captureStream || typeof MediaRecorder === 'undefined') { if (statusCb) statusCb('clip not supported'); return; }
      var stream = canvas.captureStream(30);
      var mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      var rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4000000 });
      var chunks = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = function () {
        var blob = new Blob(chunks, { type: 'video/webm' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a'); a.href = url; a.download = (code || 'bend-sim') + '.webm';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        if (statusCb) statusCb('clip saved');
      };
      restart(); rec.start(); if (statusCb) statusCb('recording…');
      setTimeout(function () { try { rec.stop(); } catch (e) {} }, model.totalT + 60);
    }

    resize(); frame(0); play();
    return { play: play, pause: pause, toggle: toggle, restart: restart,
             recordClip: recordClip, destroy: destroy,
             isPlaying: function () { return playing; },
             setPunchOverride: function (type) {
               model.overridePunchType = type;
               frame(pausedAt);
             },
             setDieOverride: function (v, angle, type, vList) {
               model.overrideDieV = v;
               model.overrideDieAngle = angle;
               model.overrideDieType = type;
               model.overrideDieVList = vList;
               frame(pausedAt);
             },
             set onstatus(fn) { statusCb = fn; } };
  }

  window.kdSimBend = { mount: mount };
})();
