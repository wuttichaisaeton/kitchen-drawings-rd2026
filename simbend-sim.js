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
      var punchId = b.punch || '';
      var pType = 'standard';
      if (punchId.indexOf('GN') >= 0) pType = 'gooseneck';
      else if (punchId.indexOf('ACUTE') >= 0) pType = 'acute';
      else if (punchId.indexOf('HEM') >= 0) pType = 'hemming';

      return {
        id: b.bend != null ? b.bend : ('B' + (i + 1)),
        idx: i,
        angle: (b.angle_deg != null ? b.angle_deg : 90),
        collides: !!b.collides,
        ok: b.ok !== false,
        hits: b.hits || 'punch',
        at_angle: (b.at_angle != null ? b.at_angle : null),
        die: b.die || null,
        punch: b.punch || null,
        punchType: pType,
        gooseneck: pType === 'gooseneck',
        reason: b.reason || null,
        v: v,
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
    if (Math.hypot(bis.x, bis.y) < 1e-6) {
      // Active bend not folded yet (flanges collinear): the old {0,1} default kept
      // the baseline at its local orientation — OK for a 1st bend (already flat)
      // but a 2nd+ bend's baseline is VERTICAL after the prior fold, so the part
      // stood on end / sank into the die. Lay it FLAT instead (เอ๋ 'ต้องวางราบ
      // แนวนอน'): orient perpendicular to the baseline, choosing the side that puts
      // the rest of the part (already-formed flanges) ABOVE the die.
      var base = r2 || r1;
      var perp = { x: -base.y, y: base.x };
      var meanY = function (b) {
        var bg = Math.atan2(b.y, b.x), rt = Math.PI / 2 - bg;
        var cc = Math.cos(rt), ss = Math.sin(rt), sy = 0, n = 0;
        pts.forEach(function (p, i) {
          if (i === Vi) return;
          sy += (p.x - V.x) * ss + (p.y - V.y) * cc; n++;
        });
        return n ? sy / n : 0;
      };
      bis = meanY(perp) >= meanY({ x: -perp.x, y: -perp.y })
        ? perp : { x: -perp.x, y: -perp.y };
    }
    var bang = Math.atan2(bis.y, bis.x);
    var rot = Math.PI / 2 - bang;            // bisector -> +y (up toward punch)
    var c = Math.cos(rot), s = Math.sin(rot);
    
    // Resolve active V using our helper
    var activeV = resolveDie(model, st).v;
    
    var pen = (activeV / 2) * Math.tan(rad((st.a[k] || 0) / 2)) * st.descend;
    var out = pts.map(function (p) {
      var dx = p.x - V.x, dy = p.y - V.y;
      return { x: dx * c - dy * s, y: dx * s + dy * c - pen };
    });
    return { pts: out, pen: pen };
  }

  function resolvePunch(model, st) {
    var cat = window.KD_TOOLING_FULL || window.KD_TOOLING || { punches: [], dies: [] };
    var pType = 'standard';
    var pAngle = 88;
    var pRadius = 0.8;
    var pHeight = 120;

    var pId = null;
    if (model.overridePunchId && model.overridePunchId !== 'AUTO') {
      pId = model.overridePunchId;
    } else if (model.overridePunchType && model.overridePunchType !== 'AUTO') {
      pId = model.overridePunchType; // fallback
    } else {
      pId = st.ab ? st.ab.punch : null;
    }

    // Preliminary default punch when nothing is selected yet (เอ๋ 2026-06-03
    // 'มีด 202 เป็น Default ก่อนในเบื้องต้น เดี๋ยวพร้อมผมจะให้เลือกเอง') — a REAL
    // owned library punch (#202 Sash), NOT an invented generic 'standard' that
    // doesn't exist in the library.
    if (!pId) pId = 'P-KYOKKO-202-R02';

    var pObj = pId ? cat.punches.find(function (p) { return p.id === pId; }) : null;
    if (pObj) {
      pType = pObj.type || 'standard';
      pAngle = pObj.angle_deg != null ? pObj.angle_deg : 88;
      pRadius = pObj.tip_radius_mm != null ? pObj.tip_radius_mm : 0.8;
      pHeight = pObj.height_mm != null ? pObj.height_mm : 120;
    } else {
      var typeStr = pId || model.overridePunchType || (st.ab && st.ab.punchType) || 'standard';
      typeStr = typeStr.toLowerCase();
      if (typeStr.indexOf('gn') >= 0 || typeStr.indexOf('gooseneck') >= 0) {
        pType = 'gooseneck'; pHeight = 150;
      } else if (typeStr.indexOf('acute') >= 0) {
        pType = 'acute'; pAngle = 30; pRadius = 0.4; pHeight = 130;
      } else if (typeStr.indexOf('hem') >= 0) {
        pType = 'hemming'; pAngle = 0; pRadius = 0; pHeight = 100;
      } else {
        pType = 'standard';
      }
    }
    // Real DXF silhouette for the selected punch (shared with the tooling art)
    // so the SIM draws the actual tool, not a generic shape (เอ๋ 2026-06-03
    // 'รูปมีดยังไม่ตรงกับที่เลือก').
    var prof = (pObj && window.KD_TOOLART && window.KD_TOOLART.profileFor)
      ? window.KD_TOOLART.profileFor(pObj) : null;
    return { type: pType, angle: pAngle, radius: pRadius, height: pHeight, profile: prof };
  }

  function resolveDie(model, st) {
    var cat = window.KD_TOOLING_FULL || window.KD_TOOLING || { punches: [], dies: [] };
    var dType = '1V';
    var dAngle = 88;
    var dV = 8;
    var dHeight = 60;
    var dVList = [8];

    var dId = null;
    if (model.overrideDieId && model.overrideDieId !== 'AUTO') {
      dId = model.overrideDieId;
    } else {
      dId = st.ab ? st.ab.die : null;
    }

    var dObj = dId ? cat.dies.find(function (d) { return d.id === dId; }) : null;
    if (dObj) {
      dType = dObj.type || '1V';
      dAngle = dObj.angle_deg != null ? dObj.angle_deg : 88;
      dV = dObj.v_list ? dObj.v_list[0] : 8;
      dHeight = dObj.height_mm != null ? dObj.height_mm : 60;
      dVList = dObj.v_list || [dV];
    } else {
      var typeStr = dId || (st.ab && st.ab.die) || '1V';
      typeStr = typeStr.toLowerCase();
      dV = st.ab && st.ab.v != null ? st.ab.v : 8;
      if (typeStr.indexOf('2v') >= 0) {
        dType = '2V';
        dVList = typeStr.indexOf('0608') >= 0 ? [6, 8] :
                 typeStr.indexOf('0812') >= 0 ? [8, 12] :
                 typeStr.indexOf('1220') >= 0 ? [12, 20] : [dV, dV * 1.5];
      } else {
        // Preliminary default die = Kyokko 2V reversible with Fusion's V (เอ๋
        // 'ร่อง KYOKKO 2V เป็น Default ก่อน'), not a 1V.
        dType = '2V';
        dVList = [dV];
        dHeight = 80;
      }
      if (typeStr.indexOf('-30') >= 0 || typeStr.indexOf('30') >= 0) {
        dAngle = 30;
      }
    }
    
    // Override logic
    if (model.overrideDieV != null && model.overrideDieV !== 'AUTO') {
      dV = model.overrideDieV;
      if (model.overrideDieVList != null && model.overrideDieVList !== 'AUTO') {
        dVList = model.overrideDieVList;
      } else {
        dVList = [dV];
      }
    }
    if (model.overrideDieAngle != null && model.overrideDieAngle !== 'AUTO') {
      dAngle = model.overrideDieAngle;
    }
    if (model.overrideDieType != null && model.overrideDieType !== 'AUTO') {
      dType = model.overrideDieType;
    }
    return { type: dType, angle: dAngle, v: dV, height: dHeight, vList: dVList };
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

      ctx.fillStyle = '#6c757d';
      ctx.strokeStyle = '#495057';
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

    function drawPunch(cx, tipY, blocked, type, t, scale, angle, radius, height, profile) {
      var shake = blocked ? Math.sin(t / 35) * 2.5 * dpr : 0;
      var x = cx + shake;

      // EXACT profile (from the tool's DXF): tip at origin, Y up, mm. Map to
      // canvas — tip sits at (x, tipY), Y flips, scale = mm→px. Draws the real
      // selected punch instead of the parametric shape below.
      if (profile && profile.length >= 3) {
        ctx.fillStyle = blocked ? 'rgba(224,87,74,0.95)' : '#6c757d';
        ctx.strokeStyle = blocked ? '#ff7a6c' : '#495057';
        ctx.lineWidth = 1.4 * dpr;
        ctx.beginPath();
        ctx.moveTo(x + profile[0][0] * scale, tipY - profile[0][1] * scale);
        for (var qi = 1; qi < profile.length; qi++) {
          ctx.lineTo(x + profile[qi][0] * scale, tipY - profile[qi][1] * scale);
        }
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        return;
      }

      var H = height != null ? height : 120;
      var ang = angle != null ? angle : 88;
      var R = radius != null ? radius : 0.8;
      if (type === 'gooseneck') {
        H = height != null ? height : 150;
        ang = angle != null ? angle : 88;
        R = radius != null ? radius : 0.8;
      } else if (type === 'acute') {
        H = height != null ? height : 130;
        ang = angle != null ? angle : 30;
        R = radius != null ? radius : 0.4;
      } else if (type === 'hemming') {
        H = height != null ? height : 100;
        ang = 0;
        R = 0.0;
      }

      ctx.fillStyle = blocked ? 'rgba(224,87,74,0.95)' : '#6c757d';
      ctx.strokeStyle = blocked ? '#ff7a6c' : '#495057';
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
        // Tip calculations moved to the top of the block
        var tipR = Math.max(0.4, Math.min(R, 2.5));
        var dx = tipR * Math.cos(rad(halfAng));
        var dy = tipR * Math.sin(rad(halfAng));
        var tx1 = 50 - dx;
        var ty1 = 160 - tipR + dy;
        var tx2 = 50 + dx;
        var ty2 = 160 - tipR + dy;

        var ry1;

        if (type === 'gooseneck') {
          var Bh = 160 - tangY2;
          var rx3 = cx + 14;
          var ry3 = tangY2 + 4;
          var rx2 = cx + 24;
          var ry2 = tangY2 + Bh * 0.3;
          var rx1 = cx + 24;
          ry1 = ty2 - (rx1 - tx2);

          ctx.lineTo(tx(rx3), ty(ry3));
          ctx.lineTo(tx(rx2), ty(ry2));
          ctx.lineTo(tx(rx1), ty(ry1));
        } else {
          // Right side of body (straight vertical back)
          ctx.lineTo(tx(64), ty(tangY2 + 4));
          ctx.lineTo(tx(64), ty(shoulderY));
          ctx.lineTo(tx(50 + shoulderW), ty(shoulderY));
        }

        ctx.lineTo(tx(tx2), ty(ty2));
        ctx.quadraticCurveTo(tx(50), ty(160), tx(tx1), ty(ty1));

        // Left side of body going back up
        if (type === 'gooseneck') {
          var Bh = 160 - tangY2;
          var neckT = 9 * (Bh / 90);
          var neckH = neckT * 1.414;
          var xIntersect = cx - neckH / 2;
          var yIntersect = ty2 + dx - neckH / 2;
          var yNeckEnd = ry1;
          var xNeckEnd = xIntersect + (yIntersect - yNeckEnd);
          var throatX = cx + 10;
          var throatY = tangY2 + Bh * 0.45;

          ctx.lineTo(tx(xIntersect), ty(yIntersect));
          ctx.lineTo(tx(xNeckEnd), ty(yNeckEnd));
          ctx.quadraticCurveTo(tx(throatX), ty(throatY + (yNeckEnd - throatY) * 0.5), tx(throatX), ty(throatY));
          ctx.quadraticCurveTo(tx(36), ty(tangY2 + Bh * 0.3), tx(36), ty(tangY2 + Bh * 0.15));
          ctx.lineTo(tx(36), ty(tangY2 + 4));
        } else {
          ctx.lineTo(tx(50 - shoulderW), ty(shoulderY));
          ctx.lineTo(tx(36), ty(shoulderY));
          ctx.lineTo(tx(36), ty(tangY2 + 4));
        }
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

      // Zoomed out so the full tool + part fit with headroom (เอ๋ 'Zoom out ออกมาอีก').
      var scale = Math.max(0.4, Math.min(4 * dpr,
        (h * 0.19) / Math.max(maxFlange, 26)));
      var dieCx = w / 2, dieCy = h * 0.66;
      function px(p) { return dieCx + p.x * scale; }
      function py(p) { return dieCy - p.y * scale; }

      ctx.clearRect(0, 0, w, h);
      // ram guide line
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.moveTo(dieCx, 0); ctx.lineTo(dieCx, h); ctx.stroke();

      var rd = resolveDie(model, st);
      drawDie(dieCx, dieCy, rd.v, scale, rd.angle, rd.type, rd.vList);

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
        var rp = resolvePunch(model, st);
        drawPunch(dieCx, py(Vtx), st.collide, rp.type, t, scale, rp.angle, rp.radius, rp.height, rp.profile);
      }

      // Draw red halos (circles) around unbendable/colliding bend vertices on the sheet metal
      model.spatial.forEach(function (sp) {
        var vtx = P[sp.idx + 1]; if (!vtx) return;
        var isBad = !sp.ok || sp.collides;
        if (isBad) {
          ctx.strokeStyle = '#e0574a';
          ctx.lineWidth = 1.5 * dpr;
          ctx.beginPath();
          ctx.arc(px(vtx), py(vtx), 9 * dpr, 0, 2 * Math.PI);
          ctx.stroke();
        }
      });

      // bend dots
      // bend dots — each bend gets a unique color from the palette
      var BEND_COLORS_SIM = [
        '#e0574a', '#4ecca3', '#4a90e2', '#f2b84e', '#c471ed',
        '#2ecc71', '#e67e22', '#1abc9c', '#e84393', '#6c5ce7'
      ];
      model.spatial.forEach(function (sp) {
        var vtx = P[sp.idx + 1]; if (!vtx) return;
        var col = BEND_COLORS_SIM[sp.idx % BEND_COLORS_SIM.length];
        
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(px(vtx), py(vtx), 4 * dpr, 0, 2 * Math.PI);
        ctx.fill();

        // Inner white dot for active bend
        if (st.active === sp.idx) {
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(px(vtx), py(vtx), 1.5 * dpr, 0, 2 * Math.PI);
          ctx.fill();
        }
      });

      // HUD Top Bar Background
      ctx.fillStyle = 'rgba(11, 18, 26, 0.85)';
      ctx.fillRect(0, 0, w, 28 * dpr);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.moveTo(0, 28 * dpr); ctx.lineTo(w, 28 * dpr); ctx.stroke();

      // Top Bar Text (Left-aligned details)
      ctx.fillStyle = '#cad6e6'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.font = (12 * dpr) + 'px "Flux Architect", monospace';
      if (st.ab) {
        var phaseTxt = (st.moving ? 'position' : 'press').toUpperCase();
        var rpInfo = resolvePunch(model, st);
        var rdInfo = resolveDie(model, st);
        // Drop the tool info from the left label when a right-aligned error is
        // shown, so the two don't overlap on narrow cards (เอ๋ 2026-06-03
        // 'ตัวแดงซ้อนทับกัน'). The tools are listed in the step table anyway.
        var hasErr = !st.ab.ok || st.collide;
        var toolInfo = hasErr ? '' : ('  ·  PUNCH: ' + rpInfo.type.toUpperCase() + '  ·  DIE: V' + rdInfo.v);
        ctx.fillText('STEP ' + st.step + '/' + model.phases.length + '  ·  ' +
          st.ab.id + '  ·  ' +
          Math.round(st.ab.angle) + '°  ·  ' + phaseTxt + toolInfo, 12 * dpr, 14 * dpr);
      }

      // Top Bar Text (Right-aligned error/warning)
      if (st.ab && (!st.ab.ok || st.collide)) {
        ctx.fillStyle = '#e0574a'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
        ctx.font = 'bold ' + (12 * dpr) + 'px "Flux Architect", monospace';
        var errorMsg = '';
        if (st.collide) {
          errorMsg = '✗ HITS ' + (st.ab.hits || 'PUNCH').toUpperCase() + (st.ab.at_angle != null ? ' @' + Math.round(st.ab.at_angle) + '°' : '');
        } else {
          errorMsg = '✗ ' + (st.ab.reason || 'REJECTED').toUpperCase();
        }
        ctx.fillText(errorMsg, w - 12 * dpr, 14 * dpr);
      }

      // HUD Bottom Bar Background
      ctx.fillStyle = 'rgba(11, 18, 26, 0.85)';
      ctx.fillRect(0, h - 28 * dpr, w, 28 * dpr);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.moveTo(0, h - 28 * dpr); ctx.lineTo(w, h - 28 * dpr); ctx.stroke();

      // Bottom Bar Text (Overall part status)
      ctx.fillStyle = model.bendable ? '#4ecca3' : '#e0574a';
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.font = 'bold ' + (12 * dpr) + 'px "Flux Architect", monospace';
      var statusTxt = model.bendable
        ? '✓ BENDABLE  —  ' + model.order.map(function (i) { return model.spatial[i].id; }).join(' → ')
        : '✗ NOT BENDABLE' + (model.record.reason ? '  —  ' + model.record.reason : '');
      ctx.fillText(statusTxt.toUpperCase(), 12 * dpr, h - 14 * dpr);
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
             setPunchOverride: function (id, type) {
               model.overridePunchId = id;
               model.overridePunchType = type;
               frame(pausedAt);
             },
             setDieOverride: function (id, v, angle, type, vList) {
               model.overrideDieId = id;
               model.overrideDieV = v;
               model.overrideDieAngle = angle;
               model.overrideDieType = type;
               model.overrideDieVList = vList;
               frame(pausedAt);
             },
             set onstatus(fn) { statusCb = fn; } };
  }

  // ---- 2D Collision Checking helpers (Requirement 1 & 4) ----------------
  function anchorWithDescend(pts, activeBendIdx, a, descend, activeV) {
    var k = activeBendIdx, Vi = k + 1, V = pts[Vi];
    var r1 = pts[k] ? norm(sub(pts[k], V)) : null;
    var r2 = pts[k + 2] ? norm(sub(pts[k + 2], V)) : null;
    var bis;
    if (r1 && r2) bis = { x: r1.x + r2.x, y: r1.y + r2.y };
    else { var r = r1 || r2; bis = { x: -r.x, y: -r.y }; }
    if (Math.hypot(bis.x, bis.y) < 1e-6) {
      // Active bend not folded yet (flanges collinear): the old {0,1} default kept
      // the baseline at its local orientation — OK for a 1st bend (already flat)
      // but a 2nd+ bend's baseline is VERTICAL after the prior fold, so the part
      // stood on end / sank into the die. Lay it FLAT instead (เอ๋ 'ต้องวางราบ
      // แนวนอน'): orient perpendicular to the baseline, choosing the side that puts
      // the rest of the part (already-formed flanges) ABOVE the die.
      var base = r2 || r1;
      var perp = { x: -base.y, y: base.x };
      var meanY = function (b) {
        var bg = Math.atan2(b.y, b.x), rt = Math.PI / 2 - bg;
        var cc = Math.cos(rt), ss = Math.sin(rt), sy = 0, n = 0;
        pts.forEach(function (p, i) {
          if (i === Vi) return;
          sy += (p.x - V.x) * ss + (p.y - V.y) * cc; n++;
        });
        return n ? sy / n : 0;
      };
      bis = meanY(perp) >= meanY({ x: -perp.x, y: -perp.y })
        ? perp : { x: -perp.x, y: -perp.y };
    }
    var bang = Math.atan2(bis.y, bis.x);
    var rot = Math.PI / 2 - bang;
    var c = Math.cos(rot), s = Math.sin(rot);
    
    var pen = (activeV / 2) * Math.tan(rad((a[k] || 0) / 2)) * descend;
    var out = pts.map(function (p) {
      var dx = p.x - V.x, dy = p.y - V.y;
      return { x: dx * c - dy * s, y: dx * s + dy * c - pen };
    });
    return out;
  }

  function getPunchPolygon(type, angle, radius, height) {
    var H = height || 120;
    var ang = angle || 88;
    var R = radius || 0.8;
    
    var bodyW = 28;
    var halfAng = ang / 2;
    var rise = (bodyW / 2) / Math.tan(rad(halfAng));
    var maxRise = H - 45;
    var actualRise = Math.min(rise, maxRise);
    var shoulderW = actualRise * Math.tan(rad(halfAng));
    
    if (type === 'gooseneck') {
      var Bh = H - 32;
      var tipR = Math.max(0.4, Math.min(R, 2.5));
      var dx = tipR * Math.cos(rad(halfAng));
      var dy = tipR * Math.sin(rad(halfAng));

      // Neck calculations (9mm physical parallel neck, scaled to Bh)
      var neckT = 9 * (Bh / 90);
      var neckH = neckT * 1.414;

      var y_neck_end = 24 - dx + tipR - dy;
      var y_intersect = tipR - dy - dx + neckH / 2;

      return [
        { x: 0, y: 0 },
        { x: dx, y: tipR - dy },
        { x: 24, y: y_neck_end },
        { x: 24, y: 0.7 * Bh },
        { x: 14, y: H - 36 },
        { x: 5, y: H - 32 },
        { x: 7, y: H },
        { x: -7, y: H },
        { x: -5, y: H - 32 },
        { x: -14, y: H - 36 },
        { x: -14, y: 0.85 * Bh },
        { x: -8, y: 0.7 * Bh },
        { x: 10, y: 0.55 * Bh },
        { x: 13.5 - 0.25 * neckH, y: 0.275 * Bh + 0.5 * y_neck_end },
        { x: 24 - neckH, y: y_neck_end },
        { x: -neckH / 2, y: y_intersect },
        { x: -dx, y: tipR - dy }
      ];
    } else if (type === 'hemming') {
      return [
        { x: -12, y: 0 },
        { x: 12, y: 0 },
        { x: 12, y: H },
        { x: -12, y: H }
      ];
    } else {
      return [
        { x: 0, y: 0 },
        { x: shoulderW, y: actualRise },
        { x: 14, y: actualRise },
        { x: 7, y: H - 32 },
        { x: 7, y: H },
        { x: -7, y: H },
        { x: -7, y: H - 32 },
        { x: -14, y: actualRise },
        { x: -shoulderW, y: actualRise }
      ];
    }
  }

  function getDiePolygon(type, angle, v, height, vList) {
    var H = height || 60;
    var ang = angle || 88;
    var V = v || 8;
    var halfAng = ang / 2;
    var depth = (V / 2) / Math.tan(rad(halfAng));
    
    var blockW = type === '2V' ? 60 : Math.max(34, V * 2.2);
    blockW = Math.max(36, Math.min(126, blockW));
    
    return [
      { x: -blockW / 2, y: 0 },
      { x: -V / 2, y: 0 },
      { x: 0, y: -depth },
      { x: V / 2, y: 0 },
      { x: blockW / 2, y: 0 },
      { x: blockW / 2, y: -H },
      { x: -blockW / 2, y: -H }
    ];
  }

  function lineIntersects(p1, p2, p3, p4) {
    var d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
    if (d === 0) return false;
    var u = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
    var v = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
    return (u >= 0 && u <= 1 && v >= 0 && v <= 1);
  }

  function pointInPolygon(pt, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i].x, yi = poly[i].y;
      var xj = poly[j].x, yj = poly[j].y;
      var intersect = ((yi > pt.y) !== (yj > pt.y))
          && (pt.x < (xj - xi) * (pt.y - yi) / ((yj - yi) || 1) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function segmentIntersectsPolygon(p1, p2, poly) {
    for (var i = 0; i < poly.length; i++) {
      if (lineIntersects(p1, p2, poly[i], poly[(i + 1) % poly.length])) return true;
    }
    if (pointInPolygon(p1, poly) || pointInPolygon(p2, poly)) return true;
    return false;
  }

  function checkCollisionAt(model, activeBendIdx, a, punch, die) {
    var pts = vertices(model, a);
    var descends = [0.0, 0.5, 1.0];
    for (var di = 0; di < descends.length; di++) {
      var desc = descends[di];
      var pen = (die.v / 2) * Math.tan(rad((a[activeBendIdx] || 0) / 2)) * desc;
      var ptsAnchored = anchorWithDescend(pts, activeBendIdx, a, desc, die.v);
      
      var punchPoly = getPunchPolygon(punch.type, punch.angle, punch.radius, punch.height);
      var punchPolyTrans = punchPoly.map(function(p) { return { x: p.x, y: p.y - pen }; });
      var diePoly = getDiePolygon(die.type, die.angle, die.v, die.height, die.vList);
      
      for (var i = 0; i < model.N; i++) {
        if (i === activeBendIdx || i === activeBendIdx + 1) continue;
        var p1 = ptsAnchored[i];
        var p2 = ptsAnchored[i + 1];
        if (!p1 || !p2) continue;
        
        if (segmentIntersectsPolygon(p1, p2, punchPolyTrans)) {
          return { collides: true, with: 'punch', at_angle: a[activeBendIdx] * desc };
        }
        if (segmentIntersectsPolygon(p1, p2, diePoly)) {
          return { collides: true, with: 'die', at_angle: a[activeBendIdx] * desc };
        }
      }
    }
    return { collides: false, with: null, at_angle: null };
  }

  window.kdSimBend = {
    mount: mount,
    buildModel: buildModel,
    stateAt: stateAt,
    vertices: vertices,
    anchor: anchor,
    resolvePunch: resolvePunch,
    resolveDie: resolveDie,
    checkCollisionAt: checkCollisionAt,
    getPunchPolygon: getPunchPolygon,
    getDiePolygon: getDiePolygon
  };
})();
