// Kitchen by Rough Design — Web Nesting (Phase 1 MVP, 2026-05-28)
//
// Replaces the standalone Python Nesting Tool with an in-browser
// nesting workspace. Reads parts + DXFs straight from RTDB +
// uploaded_dxfs/, packs onto configured sheet stock using Skyline
// (BL Corner / Left / Bottom) or MaxRects (BSSF), renders the laid-
// out sheets on canvas, and pushes the nested-sheet DXFs back to
// cut_sheets/<projectKey>/<id> so the workshop's 📐 Cut Sheets button
// surfaces them right where the Python tool used to.
//
// Public API: window.kdNest.openProject(projectKey)
//             window.kdNest.close()
//
// Coordinate convention: same as the Python tool — DXF (x, y) in mm,
// y-up. Canvas uses y-down so we flip when rendering. Sheet origin
// is bottom-left of the sheet.

(function () {
  'use strict';

  // ── Global state (one workspace at a time) ─────────────────────────
  const S = {
    projectKey: null,
    projectName: '',
    parts: [],        // see _newPart()
    // Defaults requested 2026-05-28: 3050×1525 '10x5' / 3050×1220 '10x4' /
    // 2440×1220 '8x4' / custom. Row order = priority; ↑/↓ reorder. w=0 or h=0
    // rows are skipped by the packer. Thickness gates which parts a row holds.
    // เอ๋ 2026-06-12: the whole table (sizes/qty/order) persists to localStorage
    // (kd_nest_stock_v1) so a reload doesn't silently reset qty to 1/1/1
    // ('131/225 short'). Defaults apply only on first visit / unreadable store.
    sheetStock: (function () {
      // เอ๋ 2026-06-26: per-sheet PRICE (THB). Seeded by size so a fresh
      // visit already costs out (8x4=2350, 10x4=2750, 10x5=3850, custom=0).
      const _def = [
        { w: 3050, h: 1525, qty: 1, thickness: 1, prc: 3850, label: '10x5', enabled: true },
        { w: 3050, h: 1220, qty: 1, thickness: 1, prc: 2750, label: '10x4', enabled: true },
        { w: 2440, h: 1220, qty: 1, thickness: 1, prc: 2350, label: '8x4',  enabled: true },
        { w: 0,    h: 0,    qty: 0, thickness: 1, prc: 0,    label: '(custom)', enabled: true },
      ];
      try {
        const j = JSON.parse(localStorage.getItem('kd_nest_stock_v1'));
        if (Array.isArray(j) && j.length && j.every(r => r && typeof r === 'object'
            && 'w' in r && 'h' in r && 'qty' in r)) {
          return j.map(r => ({
            w: +r.w || 0, h: +r.h || 0,
            qty: (r.qty === -1 ? -1 : (+r.qty || 0)),
            thickness: (r.thickness == null ? 1 : +r.thickness),
            // เอ๋ 2026-06-26: PRC. Old rows (no prc) get the size default;
            // a user-entered non-zero price short-circuits and is preserved.
            prc: (+r.prc || 0) || _getPriceDefault(+r.w || 0, +r.h || 0, String(r.label || '')),
            label: String(r.label || ''),
            // เอ๋ 2026-06-26: per-row enable checkbox. Old saved rows have no
            // 'enabled' field → !== false defaults them ON so nothing vanishes.
            enabled: (r.enabled !== false),
          }));
        }
      } catch (e) {}
      return _def;
    })(),
    mode: 'Desktop',   // default — mirrors the desktop NestingTool (เอ๋: best layout, 2026-05-30)
    skipRemnants: true,   // default ON — user 2026-05-28 wants fresh stock first
    rectLeftover: (function () {       // เอ๋ 2026-06-11: re-pack the LAST sheet so its
      try { return localStorage.getItem('kd_nest_rectleft_v1') !== '0'; }  // leftover is one rectangle. Default ON.
      catch (e) { return true; }
    })(),
    rectDir: (function () {            // เอ๋ 2026-06-12: remembered leftover direction
      try {                            // 'h' = wide band on top, 'v' = tall column right.
        const v = localStorage.getItem('kd_nest_rectdir');   // null until first pick
        return (v === 'h' || v === 'v') ? v : null;
      } catch (e) { return null; }
    })(),
    rememberRemnants: true,  // per-RUN choice (เอ๋ 2026-06-10): ▶ Run Nesting asks
                          // whether THIS run's leftover offcuts get saved to the
                          // Remnants library on Save Nest. Default true = prior
                          // behavior. OUTPUT saving — independent of skipRemnants
                          // (which is INPUT reuse of stock).
    dontRemember: false,  // Phase 2 toggle — pre-wired UI, packer doesn't
                          // track remnants yet so both flags are no-ops
                          // until that lands. User 2026-05-28 wanted UI
                          // parity with the Python tool's twin toggles.
    gap: 2,
    // COMMON-LINE cutting (เอ๋ 2026-06-26): merge a shared straight edge between
    // two touching parts into ONE laser cut (saves cut length + material). Opt-in,
    // OFF by default → _buildSheetDxf is byte-identical when off. Only axis-aligned
    // straight edges merge (rectangles); curved/diagonal parts are untouched.
    // commonTabs: leave small UNCUT bridges on merged edges so parts don't shift
    // mid-cut (เอ๋'s laser does kerf-comp). Both persisted.
    commonLine: (function () { try { return localStorage.getItem('kd_nest_common_v1') === '1'; } catch (e) { return false; } })(),
    commonTabs: (function () { try { return localStorage.getItem('kd_nest_commontab_v1') === '1'; } catch (e) { return false; } })(),
    commonTabMm: (function () { try { const n = parseFloat(localStorage.getItem('kd_nest_commontabmm_v1') || ''); return (n > 0 && n < 20) ? n : 0.3; } catch (e) { return 0.3; } })(),
    // AUTO COST-OPTIMIZE (เอ๋ 2026-06-26): Run defaults to auto-finding the
    // CHEAPEST enabled sheet-size mix (by each size's prc) and may MIX sizes.
    // optManual ON → run as-is (today's exact behavior, no trials). Persisted.
    optManual: (function () {
      try { return localStorage.getItem('kd_nest_optmanual_v1') === '1'; }
      catch (e) { return false; }
    })(),
    optChosen: false,     // last run came from the auto-optimizer → show "Auto-chosen" badge
    costStale: false,     // sheet-stock changed AFTER a run → Total Cost dims + "press Run to update"
                          // until the next run recomputes it (เอ๋ 2026-06-26 'กดปิดแล้ว cost ไม่เปลี่ยน').
                          // Set true in the stock handlers; cleared false when _runNesting sets S.flatSheets.
    grainMap: null,       // populated by _loadGrainMap once per session
    sidebarWidth: null,   // px — null = use CSS default; admin can drag to resize
    highlightCode: null,  // when set, draw a glow ring around every
                          // placement with this code on the current sheet —
                          // turned on by the 📍 'View @ sheet' button so
                          // the user can spot WHERE on the sheet that
                          // part ended up (user 2026-05-28: 'view@sheet
                          // ให้ทำ Hilight ด้วย').
    cabinetsOff: null,    // Set of EXCLUDED cabinet keys (variant_root strings;
                          // '' = parts under no cabinet). Cabinet capsules
                          // (เอ๋ 2026-06-11) — persisted per project in
                          // localStorage kd_nest_cabsel_<pk>.
    capFold: null,        // Set of COLLAPSED F-group codes (F1/F2…); persisted
                          // per project in localStorage kd_nest_capfold_<pk>
                          // (เอ๋ 2026-06-12 — group capsules into F-folders).
    flatSheets: [],   // [{thick, sw, sh, placements:[{code, x, y, w, h, rot, polys, bbox}]}]
    unplaced: [],     // pieces the packer couldn't place (set by _runNesting; for the warning banner)
    grainSkippedRemnants: 0,  // saved offcuts a grain clash kept out of the last run (review banner)
    lastSavedJobId: null,  // set by _saveProject; informational
    currentSheetIdx: 0,
    previewCode: null,    // single-part preview mode (↑/↓ cycles; null = sheet view)
    rootEl: null,     // <main id="root"> at the time we opened
    prevHtml: null,   // saved so close() can restore
    closing: false,
  };

  // Admin-added rectangular part — no DXF, editable W/H, nests as a plain
  // rectangle. (user 2026-05-30 'เพิ่ม row admin เพิ่ม Part สี่เหลี่ยมเอง')
  function _newManualPart() {
    S._manualSeq = (S._manualSeq || 0) + 1;
    return {
      code: 'RECT-' + S._manualSeq,
      qty: 1, selected: true, manual: true,
      w: 0, h: 0, grain: 'ANY', grainAngle: null, grainExplicit: true, thickness: 1,
      polys: null, bbox: null, dxfUrl: '', dxfMeta: null,
      dxfLoaded: true,   // nothing to fetch — ready immediately
    };
  }

  function _newPart(code, qty) {
    return {
      code: code,
      qty: qty || 1,
      selected: true,
      // bbox + polygons populated from DXF once loaded
      w: 0, h: 0,
      grain: 'ANY',     // H / V / ANY / EDGE — read from CSV later
      // EDGE (angled grain): grain runs parallel to a user-picked outline edge.
      // grainAngle = that edge's angle in degrees [0,180); null = not an EDGE
      // part. Additive — H/V/ANY parts keep grainAngle null and behave exactly
      // as before. (angled-grain feature 2026-06-25)
      grainAngle: null,
      thickness: 0,     // mm — read from uploaded_dxfs metadata
      polys: null,      // {outer: [[x,y],...], holes: [[[x,y]...], ...]}
      bbox: null,       // [minX, minY, maxX, maxY] in DXF coords
      dxfUrl: '',
      dxfMeta: null,    // FULL RTDB uploaded_dxfs entry — passed verbatim
                        // to _renderDxfPreviewModal when user hits 👁 so
                        // the modal renders the same uploaded_at / size
                        // / filename text as the Laser cut list does
                        // (user 2026-05-28: 'BK1DN1-120000 view ยังไม่
                        // ถูก sync มาจาก Laser' was the divergence —
                        // Nesting was passing a synthesised meta).
      dxfLoaded: false,
      dxfError: null,
    };
  }

  // ── DXF library lazy-load ──────────────────────────────────────────
  // Same CDN+API as app.js's preview modal so we don't double-bundle.
  // window.dxf becomes available on resolve.
  let _dxfLibPromise = null;
  function _ensureDxfLib() {
    if (window.dxf) return Promise.resolve();
    if (_dxfLibPromise) return _dxfLibPromise;
    _dxfLibPromise = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/dxf@5.1.1/dist/dxf.min.js';
      s.onload = resolve;
      s.onerror = function () {
        _dxfLibPromise = null;
        reject(new Error('DXF library failed to load'));
      };
      document.head.appendChild(s);
    });
    return _dxfLibPromise;
  }

  // GitHub Pages doesn't serve CORS for raw files, but jsdelivr mirrors
  // the repo with CORS. app.js has the same helper — duplicate the rule
  // here so nest.js doesn't depend on app.js's internal scope.
  function _toJsdelivrUrl(url) {
    if (!url) return url;
    let m = String(url).match(
      /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/
    );
    if (m) return `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}`;
    // CC_Laser writes the DXF url as the SYNTHETIC host
    // `<repoName>.github.io/<path>` — that host doesn't resolve (it's a
    // (repoName, path) encoding, see group-sync 2026-05-29). Map it to the
    // jsdelivr mirror of the real repo. Without this every CC_Laser DXF
    // failed to fetch → "0/N DXF LOADED · ⚠ N ERR". (fix 2026-05-30)
    m = String(url).match(/^https?:\/\/([^./]+)\.github\.io\/(.+)$/);
    if (m) return `https://cdn.jsdelivr.net/gh/wuttichaisaeton/${m[1]}@main/${m[2]}`;
    return url;
  }

  // ── Polygon extraction from parsed DXF ─────────────────────────────
  // Returns {outer, holes, bbox}. ``outer`` = largest closed loop on
  // OUTER_PROFILES (or the largest loop overall if no such layer);
  // ``holes`` = any loops inside outer (we don't currently use them for
  // packing — bbox of outer is what the packer cares about — but we
  // keep them so the canvas render can show drilled holes).
  function _bendLayer(name) {
    return /(bend|fold|flex)/i.test(String(name || ''));
  }

  // ── True-entity normaliser (for vector DXF export) ──────────────────
  // Convert ONE parsed DXF entity into a normalised WCS true-entity
  // descriptor — same geometry the renderer/packer tessellates, but kept
  // as a CIRCLE / ARC / LINE / LWPOLYLINE(+bulge) / SPLINE / ELLIPSE so
  // _buildSheetDxf can re-emit a real curve instead of a faceted polyline
  // (เอ๋ HARD RULE 'vector ทุกส่วน'; laser operator's circles were
  // straight-segment polygons). The OCS mirror (extrusionZ < 0 → x→-x,
  // see _extractPolygons.ocsFlipX) is BAKED IN here so the result is pure
  // WCS — the placement transform (rotation + offset, NO reflection) then
  // applies uniformly. Reads the EXACT same fields as entityPoints so the
  // two stay in lock-step. Returns null for bend / unsupported entities.
  function _entityToWcs(e) {
    if (!e) return null;
    const flip = (typeof e.extrusionZ === 'number' && e.extrusionZ < 0);
    const fx = flip ? (x => -x) : (x => x);
    const T = e.type;
    if (T === 'CIRCLE') {
      if (!(e.r > 0)) return null;
      return { kind: 'CIRCLE', cx: fx(e.x), cy: e.y, r: e.r };
    }
    if (T === 'ARC') {
      if (!(e.r > 0)) return null;
      const a0 = e.startAngle || 0, a1 = e.endAngle || 0;     // radians (this lib)
      let span = a1 - a0;
      while (span < 0) span += 2 * Math.PI;
      while (span > 2 * Math.PI) span -= 2 * Math.PI;
      if (span < 1e-9) span = 2 * Math.PI;
      // No flip: CCW a0→a0+span. Flip (mirror X): a point at angle a maps to
      // angle (π−a) on the mirrored circle, and the sweep reverses → represent
      // as CCW from (π−a1) to (π−a0).
      if (!flip) return { kind: 'ARC', cx: e.x, cy: e.y, r: e.r, a0: a0, a1: a0 + span };
      return { kind: 'ARC', cx: -e.x, cy: e.y, r: e.r, a0: Math.PI - (a0 + span), a1: Math.PI - a0 };
    }
    if (T === 'LINE') {
      if (!e.start || !e.end) return null;
      return { kind: 'LINE', x0: fx(e.start.x), y0: e.start.y, x1: fx(e.end.x), y1: e.end.y };
    }
    if (T === 'LWPOLYLINE' || T === 'POLYLINE') {
      const vs = e.vertices || [];
      if (vs.length < 2) return null;
      // Mirror reverses arc handedness → negate every bulge when flipped.
      const verts = vs.map(v => ({ x: fx(v.x), y: v.y, bulge: flip ? -(v.bulge || 0) : (v.bulge || 0) }));
      return { kind: 'LWPOLYLINE', verts: verts, closed: !!e.closed };
    }
    if (T === 'ELLIPSE') {
      const A = Math.hypot(e.majorX || 0, e.majorY || 0);
      if (A < 1e-9) return null;
      const ratio = (e.axisRatio != null ? e.axisRatio : 1);
      let s = e.startAngle || 0;
      let en = (e.endAngle == null) ? 2 * Math.PI : e.endAngle;
      if (en <= s + 1e-9) en += 2 * Math.PI;
      // Flip mirrors centre.x + the major-axis X component; the parameter
      // sweep reverses (start↔end, negated).
      if (!flip) return { kind: 'ELLIPSE', cx: e.x, cy: e.y, mx: e.majorX || 0, my: e.majorY || 0, ratio: ratio, a0: s, a1: en };
      return { kind: 'ELLIPSE', cx: -e.x, cy: e.y, mx: -(e.majorX || 0), my: e.majorY || 0, ratio: ratio, a0: -en, a1: -s };
    }
    if (T === 'SPLINE') {
      // de Boor is an affine combination of control points, so mirroring the
      // control polygon (x→−x) mirrors the curve exactly; knots/degree stay.
      const ctrl = (Array.isArray(e.controlPoints) ? e.controlPoints : []).map(p => ({ x: fx(p.x), y: p.y }));
      const fit = (Array.isArray(e.fitPoints) ? e.fitPoints : []).map(p => ({ x: fx(p.x), y: p.y }));
      if (ctrl.length < 2 && fit.length < 2) return null;
      return { kind: 'SPLINE', ctrl: ctrl, fit: fit, knots: e.knots, degree: e.degree || 3, closed: !!e.closed };
    }
    return null;
  }

  function _extractPolygons(parsed) {
    if (!parsed || !Array.isArray(parsed.entities)) {
      return { outer: [], holes: [], bbox: null };
    }
    // Approximate each entity as a polyline of (x, y) points. Splines
    // get sampled into ~30 segments per control-point span. Skip bend
    // layers — they're just visual overlay, not cut paths.
    //
    // OCS flip: Fusion's Sheet Metal DXF Creator emits each entity in
    // its own Object Coordinate System with extrusion=(0,0,-1) for
    // back-face primitives (CIRCLE / ARC most commonly). The dxf JS
    // library hands us the raw OCS coordinates; we have to mirror X
    // ourselves when extrusionZ < 0 to get the World Coordinate System
    // (WCS) location. Without this, interior holes that Fusion placed
    // at WCS x = +615 land at OCS x = -615 → bbox blows up to 2× the
    // real part width (user 2026-05-28 saw BM1NO0-080000 reported as
    // 1519×59 instead of 793×59). Mirrors Python NestingTool's
    // _ocs_flip() exactly.
    function ocsFlipX(e, x) {
      if (e && typeof e.extrusionZ === 'number' && e.extrusionZ < 0) return -x;
      return x;
    }
    // ── Curve flatteners (parity with Python nest_gui.py) ────────────
    // LWPOLYLINE bulge → arc points. ``bulge`` lives on the START vertex
    // of each segment (DXF spec); = tan(includedAngle / 4), signed
    // (+ = CCW). Without this, rounded corners collapse to chords and the
    // bbox shrinks (e.g. SD0SUP read 75×52 instead of 87×60) AND the
    // outline can't close → no fill. Mirrors Python _bulge_arc_bbox.
    // Returns the points AFTER (x0,y0) up to and including (x1,y1).
    function bulgeArc(x0, y0, x1, y1, bulge) {
      const dx = x1 - x0, dy = y1 - y0;
      const chord = Math.hypot(dx, dy);
      if (chord < 1e-9 || Math.abs(bulge) < 1e-9) return [[x1, y1]];
      const ang = 4 * Math.atan(bulge);            // signed sweep
      const half = chord / 2;
      const r = half / Math.sin(ang / 2);          // signed radius
      const m = half / Math.tan(ang / 2);          // signed mid→centre dist
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      const cx = mx - (dy / chord) * m;            // perp to chord (-dy,dx)
      const cy = my + (dx / chord) * m;
      const a0 = Math.atan2(y0 - cy, x0 - cx);
      const R = Math.abs(r);
      const N = Math.max(2, Math.ceil(Math.abs(ang) / (Math.PI / 12)));  // ~15°/seg
      const out = [];
      for (let i = 1; i <= N; i++) {
        const a = a0 + ang * (i / N);
        out.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
      }
      return out;
    }

    // B-spline (NURBS w/ uniform weights) → flattened points via de Boor.
    // Fusion emits SPLINE with controlPoints + knots + degree and EMPTY
    // fitPoints; using raw controlPoints (Bezier hull) overestimates the
    // bbox. Evaluating the actual curve matches Python's _spline_points
    // (ezdxf flattening). Falls back to controlPoints if knots malformed.
    function bsplineFlatten(ctrl, deg, knots, samples) {
      const n = ctrl.length - 1;
      if (n < deg || !Array.isArray(knots) || knots.length !== n + deg + 2) {
        return ctrl.slice();
      }
      function evalAt(u) {
        let s = deg;
        for (let i = deg; i <= n; i++) {
          if (u >= knots[i] && u < knots[i + 1]) { s = i; break; }
          if (i === n) s = n;
        }
        const d = [];
        for (let j = 0; j <= deg; j++) d.push(ctrl[s - deg + j].slice());
        for (let r = 1; r <= deg; r++) {
          for (let j = deg; j >= r; j--) {
            const idx = s - deg + j;
            const den = knots[idx + deg - r + 1] - knots[idx];
            const al = den > 1e-12 ? (u - knots[idx]) / den : 0;
            d[j][0] = (1 - al) * d[j - 1][0] + al * d[j][0];
            d[j][1] = (1 - al) * d[j - 1][1] + al * d[j][1];
          }
        }
        return d[deg];
      }
      const u0 = knots[deg], u1 = knots[n + 1];
      const M = Math.max(samples || 24, ctrl.length * 4);
      const out = [];
      for (let i = 0; i <= M; i++) {
        try { out.push(evalAt(u0 + (u1 - u0) * (i / M))); } catch (_) { /* skip */ }
      }
      return out.length >= 2 ? out : ctrl.slice();
    }

    function entityPoints(e) {
      if (!e || _bendLayer(e.layer)) return null;
      if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') {
        // Walk segments honouring per-vertex bulge. Build in RAW coords
        // then OCS-flip x at the end (flipping mid-arc would invert the
        // bulge handedness).
        const vs = e.vertices || [];
        if (!vs.length) return null;
        const raw = [[vs[0].x, vs[0].y]];
        const segs = e.closed ? vs.length : vs.length - 1;
        for (let i = 0; i < segs; i++) {
          const a = vs[i], b = vs[(i + 1) % vs.length];
          if (a.bulge && Math.abs(a.bulge) > 1e-9) {
            for (const p of bulgeArc(a.x, a.y, b.x, b.y, a.bulge)) raw.push(p);
          } else {
            raw.push([b.x, b.y]);
          }
        }
        return raw.map(p => [ocsFlipX(e, p[0]), p[1]]);
      }
      if (e.type === 'LINE') {
        return [[ocsFlipX(e, e.start.x), e.start.y],
                [ocsFlipX(e, e.end.x), e.end.y]];
      }
      if (e.type === 'CIRCLE') {
        // OCS-flip the WHOLE point (not just the centre) so mirrored
        // (extrusion=-1) entities land at the right X.
        const N = 32;
        const arr = [];
        for (let i = 0; i <= N; i++) {
          const a = (i / N) * Math.PI * 2;
          arr.push([ocsFlipX(e, e.x + e.r * Math.cos(a)), e.y + e.r * Math.sin(a)]);
        }
        return arr;
      }
      if (e.type === 'ARC') {
        // Two fixes vs the old code (2026-05-29):
        //  (1) start/endAngle are RADIANS in this dxf lib, NOT degrees
        //      (confirmed: endAngle 6.28 = 2π). The old ×π/180 collapsed
        //      every arc to a ~0.1mm nub → corner fillets vanished, so
        //      the outline couldn't close (no fill) and bbox lost the
        //      fillet extent.
        //  (2) OCS-flip the WHOLE sampled point, not just the centre —
        //      for extrusion=-1 the correct WCS map is x→-x per point;
        //      flipping only the centre swept the arc the wrong way so
        //      its endpoints missed the neighbouring segments.
        const a0 = e.startAngle || 0;
        const a1 = e.endAngle || 0;
        let span = a1 - a0;
        while (span < 0) span += 2 * Math.PI;
        while (span > 2 * Math.PI) span -= 2 * Math.PI;
        const N = Math.max(2, Math.ceil(span / (Math.PI / 12)));
        const arr = [];
        for (let i = 0; i <= N; i++) {
          const a = a0 + span * (i / N);
          arr.push([ocsFlipX(e, e.x + e.r * Math.cos(a)), e.y + e.r * Math.sin(a)]);
        }
        return arr;
      }
      if (e.type === 'ELLIPSE') {
        // center (x,y) + major-axis endpoint vector (majorX,majorY) +
        // axisRatio (minor/major) + start/end PARAMETER angles (radians,
        // NOT degrees — confirmed from the dxf lib output). Mirrors
        // Python _ellipse_points. Missing this dropped FN2BNX's rounded
        // ends → broken outline + no fill + wrong extent.
        const A = Math.hypot(e.majorX || 0, e.majorY || 0);
        if (A < 1e-9) return null;
        const B = A * (e.axisRatio != null ? e.axisRatio : 1);
        const rot = Math.atan2(e.majorY || 0, e.majorX || 0);
        let s = e.startAngle || 0;
        let en = (e.endAngle == null) ? 2 * Math.PI : e.endAngle;
        if (en <= s + 1e-9) en += 2 * Math.PI;
        const cs = Math.cos(rot), sn = Math.sin(rot);
        const N = Math.max(8, Math.ceil((en - s) / (Math.PI / 24)));
        const out = [];
        for (let i = 0; i <= N; i++) {
          const t = s + (en - s) * (i / N);
          const ex = A * Math.cos(t), ey = B * Math.sin(t);
          const px = e.x + ex * cs - ey * sn;
          const py = e.y + ex * sn + ey * cs;
          out.push([ocsFlipX(e, px), py]);
        }
        return out;
      }
      if (e.type === 'SPLINE') {
        // Curve passes through fitPoints when present; otherwise evaluate
        // the actual B-spline from controlPoints+knots+degree (Fusion
        // ships empty fitPoints). Raw controlPoints overestimate bbox.
        if (Array.isArray(e.fitPoints) && e.fitPoints.length >= 2) {
          return e.fitPoints.map(p => [ocsFlipX(e, p.x), p.y]);
        }
        if (Array.isArray(e.controlPoints) && e.controlPoints.length >= 2) {
          const ctrl = e.controlPoints.map(p => [p.x, p.y]);
          const deg = e.degree || 3;
          const pts = bsplineFlatten(ctrl, deg, e.knots, 24);
          return pts.map(p => [ocsFlipX(e, p[0]), p[1]]);
        }
        return null;
      }
      return null;
    }

    // Bbox is computed from OUTER_PROFILES + INTERIOR_PROFILES only —
    // bend layers are noise, and an unlabelled-layer fallback is too
    // permissive (Fusion DXFs always tag the cut paths correctly, and
    // including unlabelled entities risks pulling in dimension text /
    // construction lines that blow up the bbox).
    function isCutLayer(layer) {
      const L = String(layer || '');
      return /OUTER/i.test(L) || /INTERIOR/i.test(L);
    }

    let minX = +Infinity, minY = +Infinity, maxX = -Infinity, maxY = -Infinity;
    // Fallback bbox over EVERY cut entity (any non-bend layer). Used only when
    // the strict OUTER/INTERIOR bbox below finds nothing — some CC_Laser
    // fallback/sketch exports put all geometry on the default layer "0" instead
    // of OUTER_/INTERIOR_PROFILES, so the strict bbox came back null and the
    // part rendered with blank W×H = looked NO-DXF even though it loaded fine
    // (เอ๋ 2026-06-20: 2CN000-120000 / 2CN002-120024 / 2DN000-060000, all on "0").
    let aMinX = +Infinity, aMinY = +Infinity, aMaxX = -Infinity, aMaxY = -Infinity;
    const outerStrokes = [];   // every OUTER-layer polyline / line / arc
    const interior = [];       // every INTERIOR-layer entity
    // True-entity descriptors (CIRCLE/ARC/LINE/…) parallel to the tessellated
    // strokes — kept so the DXF exporter can emit real curves (vector-only).
    // Each carries cls ('OUTER'|'INTERIOR') for the right output layer.
    const trueEnts = [];
    let nPts = 0;              // entities that yielded a point chain
    for (const e of parsed.entities) {
      const pts = entityPoints(e);
      if (!pts || pts.length < 2) continue;
      const layer = String(e.layer || '');
      const cut = isCutLayer(layer);
      for (const [x, y] of pts) {
        if (x < aMinX) aMinX = x;
        if (y < aMinY) aMinY = y;
        if (x > aMaxX) aMaxX = x;
        if (y > aMaxY) aMaxY = y;
        if (cut) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
      const cls = /INTERIOR/i.test(layer) ? 'INTERIOR' : 'OUTER';
      if (/INTERIOR/i.test(layer)) {
        interior.push(pts);
      } else {
        // OUTER or untagged cut content — assume outer.
        outerStrokes.push(pts);
      }
      nPts++;
      const d = _entityToWcs(e);
      if (d) { d.cls = cls; trueEnts.push(d); }
    }
    // Only hand the exporter true entities when they cover EVERY cut entity —
    // a partial set would drop geometry. Otherwise the exporter falls back to
    // the tessellated polyline (older cached parts, or an unsupported type).
    const entities = (trueEnts.length === nPts && nPts > 0) ? trueEnts : [];

    // Prefer the OUTER/INTERIOR-tagged bbox (tight — ignores any stray
    // construction lines on untagged layers). Fall back to the all-entity bbox
    // ONLY when no cut-layer geometry exists at all (layer-"0" exports), so a
    // normal part's bbox is unchanged but a layer-"0" part stops reading 0×0.
    const bbox = isFinite(minX) ? [minX, minY, maxX, maxY]
               : (isFinite(aMinX) ? [aMinX, aMinY, aMaxX, aMaxY] : null);

    // The renderer wants ONE 'outer' polyline to draw as a filled
    // closed shape (single LWPOLYLINE = the common Fusion case), AND
    // a list of additional strokes to draw on top for parts whose
    // cut path is made of disconnected lines + splines (e.g.
    // BK1DN1-120000.dxf has 24 LINE + 16 SPLINE entities on
    // OUTER_PROFILES — no single LWPOLYLINE). Without ``strokes``
    // those parts rendered with just a stub of a line, losing their
    // outline (user 2026-05-28: 'BK1DN1-120000 ไม่มีรูป Part').
    function perim(pts) {
      let p = 0;
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i][0] - pts[i - 1][0];
        const dy = pts[i][1] - pts[i - 1][1];
        p += Math.hypot(dx, dy);
      }
      return p;
    }
    // Stitch disconnected OUTER segments (LINE/ARC/ELLIPSE/SPLINE pieces)
    // into ONE ordered closed loop by joining endpoints within tol. When
    // it closes, that loop becomes ``outer`` → the renderer can fill it
    // (a part with rounded corners exports as many segments, not a single
    // LWPOLYLINE, so without this it showed an unfilled outline only —
    // user 2026-05-29 'ถ้าสมบูรณ์ต้องมี fill'). Falls back to the old
    // longest-segment + draw-all-strokes behaviour if it can't close.
    function stitchLoop(segments, tol) {
      const segs = segments.map(s => s.slice()).filter(s => s.length >= 2);
      if (segs.length < 2) return null;
      const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;
      const used = new Array(segs.length).fill(false);
      used[0] = true;
      let loop = segs[0].slice();
      let go = true;
      while (go) {
        go = false;
        const tail = loop[loop.length - 1];
        // Pick the NEAREST unused endpoint within tol, not the first one
        // found — at a junction several segments sit within tol and
        // grabbing the wrong branch dead-ends the walk before it closes.
        let bi = -1, brev = false, bd = Infinity;
        for (let i = 0; i < segs.length; i++) {
          if (used[i]) continue;
          const s = segs[i];
          const da = Math.hypot(tail[0] - s[0][0], tail[1] - s[0][1]);
          const db = Math.hypot(tail[0] - s[s.length - 1][0], tail[1] - s[s.length - 1][1]);
          if (da < bd) { bd = da; bi = i; brev = false; }
          if (db < bd) { bd = db; bi = i; brev = true; }
        }
        if (bi >= 0 && bd <= tol) {
          const s = brev ? segs[bi].slice().reverse() : segs[bi];
          for (let k = 1; k < s.length; k++) loop.push(s[k]);
          used[bi] = true;
          go = true;
        }
      }
      // Accept only a clean loop: every segment consumed AND end≈start.
      if (used.every(Boolean) && loop.length >= 4 && near(loop[0], loop[loop.length - 1])) {
        return loop;
      }
      return null;
    }

    let outer = [];
    let strokes = [];
    if (outerStrokes.length === 1) {
      // Single polyline — most Fusion exports. Use as outer; no
      // extra strokes needed.
      outer = outerStrokes[0];
    } else if (outerStrokes.length > 1) {
      const loop = stitchLoop(outerStrokes, 0.5);
      if (loop) {
        // Closed contour reassembled → fills correctly.
        outer = loop;
      } else {
        // Couldn't close (genuine gap / multi-island). Keep the LONGEST
        // segment as the 'outer' candidate so labels + transforms still
        // work, then draw every segment via ``strokes``.
        outer = outerStrokes.reduce((a, b) => (perim(b) > perim(a) ? b : a));
        strokes = outerStrokes;
      }
    }
    return { outer, strokes, holes: interior, bbox, entities };
  }

  // ── Fetch + parse DXFs in parallel ─────────────────────────────────
  // Returns when ALL parts have either {bbox set, polys set} or
  // {dxfError set}. Errors don't block — those parts get filtered
  // out before nesting.
  // Fetch + parse ONE part's DXF → sets polys/bbox/dxfLoaded (or dxfError).
  // opts.directUrl = fetch that exact URL (no-store) instead of the jsdelivr
  // mirror — used right after a manual ⚠ drop-upload: raw.githubusercontent
  // serves the just-committed file immediately, while jsdelivr@main lags ~1min.
  // opts.text = parse THESE bytes directly (the File we just uploaded) — no
  // fetch at all, so no CDN lag/lie: raw can serve the OLD cached file for
  // minutes after a REPLACE, which makes a fresh drop look "still broken"
  // (WEB16 2026-06-20 — the size/view we show must be EXACTLY what landed).
  async function _loadOneDxf(p, opts) {
    if (!(opts && typeof opts.text === 'string') && !p.dxfUrl && !(opts && opts.directUrl)) {
      p.dxfError = 'No DXF uploaded yet';
      return;
    }
    try {
      let text;
      if (opts && typeof opts.text === 'string') {
        text = opts.text;
      } else {
        // Cache-bust by CONTENT VERSION: jsdelivr serves multi-hour max-age, so
        // a plain (or force-) cached fetch kept showing the PRE-fix bytes after
        // a re-export (เอ๋ 2026-06-10 'เหมือนเดิม' — DSV1 despike invisible).
        // content_md5 keys the browser cache per content; else uploaded_at; else Date.now().
        const ver = (p.dxfMeta && (p.dxfMeta.content_md5 || p.dxfMeta.uploaded_at)) || Date.now();
        let fetchUrl;
        if (opts && opts.directUrl) {
          fetchUrl = opts.directUrl + (opts.directUrl.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(ver);
        } else {
          fetchUrl = _toJsdelivrUrl(p.dxfUrl) + '?v=' + encodeURIComponent(ver);
          // COMMIT-PINNED when the uploader stamped one: @<sha> jsdelivr URLs
          // are immutable — zero CDN staleness, no purging needed.
          if (p.dxfMeta && p.dxfMeta.commit) {
            fetchUrl = fetchUrl.replace('@main/', '@' + p.dxfMeta.commit + '/');
          }
        }
        // Abort a stalled fetch after 15s so one bad part can't hang Promise.all.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        let resp;
        try { resp = await fetch(fetchUrl, { cache: (opts && opts.directUrl) ? 'no-store' : 'force-cache', signal: ctrl.signal }); }
        finally { clearTimeout(timer); }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        text = await resp.text();
      }
      // Size guard: a real per-part DXF is tens of KB (the uploader caps at 1 MB).
      // A multi-MB file is broken/bloated — skip the SYNCHRONOUS (un-abortable)
      // parse so it can't freeze the UI; surface a clear error instead.
      if (text.length > 1500000) throw new Error('DXF too large (' + Math.round(text.length / 1024) + ' KB) — re-export a clean one');
      const parsed = window.dxf.parseString(text);
      const ex = _extractPolygons(parsed);
      p.polys = { outer: ex.outer, strokes: ex.strokes || [], holes: ex.holes, entities: ex.entities || [] };
      p.bbox = ex.bbox;
      if (ex.bbox) {
        // Default W/H to the bbox dimensions; user can override.
        p.w = Math.round(ex.bbox[2] - ex.bbox[0]);
        p.h = Math.round(ex.bbox[3] - ex.bbox[1]);
      }
      p.dxfLoaded = true;
      p.dxfError = null;
    } catch (e) {
      p.dxfError = (e && e.name === 'AbortError') ? 'DXF fetch timed out' : String(e.message || e);
    }
  }

  // Returns when ALL parts have either {bbox+polys} or {dxfError}. Re-renders the
  // list as each DXF SETTLES (debounced) so a slow/failed part can't hold back the
  // ✓ on the others — and its own ⚠↻ shows the moment it times out (RD isolate).
  async function _loadAllDxfs() {
    await _ensureDxfLib();
    let rerenderTO = null;
    const onSettle = () => {
      if (S.closing || !S.rootEl) return;
      clearTimeout(rerenderTO);
      rerenderTO = setTimeout(() => { if (!S.closing && S.rootEl) _refreshViewKeepScroll(); }, 200);
    };
    await Promise.all(S.parts.map(p => _loadOneDxf(p).then(onSettle, onSettle)));
  }

  // ── NO-DXF auto-detect: live ⚠→✓ when a DXF lands (เอ๋ 2026-06-20, WEB16) ────
  // While the Nest list is open, watch RTDB uploaded_dxfs. When a DXF appears for a
  // part that's still ⚠ (no DXF) or errored — Fusion 🔥 export, another device's
  // drop — re-resolve + (re)load it (raw directUrl = immediate, no jsdelivr lag) and
  // re-render IN PLACE (scroll preserved, NO jump — เอ๋ "อยู่หน้าเดิม ไม่กระโดด").
  // Fusion 22 acked the key is uploaded_dxfs/<code> == part.code byte-exact
  // ([[reference_github_pat_drawings_upload]]). Detached on close() — no leak, no
  // fire after the workspace is gone. Debounced 400ms so a Fusion BATCH upload
  // (many DXFs at once) re-renders once, not N times.
  function _installDxfWatcher() {
    if (!window.firebaseDB || S._dxfWatchRef) return;
    const ref = window.firebaseDB.ref('uploaded_dxfs');
    let pending = null, to = null;
    const process = async () => {
      to = null;
      const all = pending; pending = null;
      if (!all || S.closing || !S.rootEl) return;
      S.dxfsAll = all;   // keep fresh (rename re-resolve + staleness checks reuse it)
      const toLoad = [];
      for (const p of S.parts) {
        if (!p || p.manual || p.dxfLoaded) continue;
        const meta = all[p.code];
        if (!meta || !meta.url) continue;
        // Act on a NEW arrival only: no url yet, a different url, or an errored part
        // whose meta got a newer uploaded_at (Fusion re-exported a clean file to the
        // same path). Won't loop: once loaded, dxfLoaded skips it; a still-broken file
        // keeps its uploaded_at in p.dxfMeta → no retry until a NEWER upload.
        const fresh = (p.dxfUrl !== meta.url) ||
          (p.dxfError && (!p.dxfMeta || p.dxfMeta.uploaded_at !== meta.uploaded_at));
        if (!fresh) continue;
        p.dxfUrl = meta.url; p.dxfMeta = meta; p.dxfError = null;
        p.thickness = meta.thickness_mm || p.thickness || 0;
        toLoad.push(p);
      }
      if (!toLoad.length) return;
      await _ensureDxfLib();
      await Promise.all(toLoad.map(p => _loadOneDxf(p, { directUrl: p.dxfUrl })));
      if (!S.closing && S.rootEl) _refreshViewKeepScroll();
    };
    const cb = ref.on('value', snap => {
      if (S.closing || !S.rootEl) return;
      pending = snap.val() || {};
      clearTimeout(to); to = setTimeout(process, 400);
    });
    S._dxfWatchRef = ref; S._dxfWatchCb = cb; S._dxfWatchClear = () => clearTimeout(to);
  }
  function _teardownDxfWatcher() {
    if (S._dxfWatchRef && S._dxfWatchCb) { try { S._dxfWatchRef.off('value', S._dxfWatchCb); } catch (e) {} }
    if (S._dxfWatchClear) { try { S._dxfWatchClear(); } catch (e) {} }
    S._dxfWatchRef = null; S._dxfWatchCb = null; S._dxfWatchClear = null;
  }

  // ── ✏️ Inline rename / re-point a part code (เอ๋ 2026-06-20, WEB16) ──────────
  // Fix a legacy/typo'd code in the Nest list (e.g. 2CVH19-346LL0 → 2CH000-…)
  // WITHOUT touching Fusion or the real DXF files (เอ๋ chose "web override").
  // The override lives in RTDB nest_code_overrides/<manifestCode> = {to,at} —
  // nest-LOCAL (not app.js drawing_links), keyed by the MANIFEST code so it
  // survives a Fusion/BOM re-sync (the manifest re-emits the orig code every
  // load → we re-map). part.origCode keeps the manifest code for revert.
  // Re-point = part.code becomes the new code → DXF / size / grain all resolve
  // to it. CASE-PRESERVED — never uppercase (the drawing_links relink bug,
  // [[reference_drawing_links_pick_pdf]]).
  async function _applyCodeOverride(part, rawVal) {
    const next = String(rawVal == null ? '' : rawVal).trim();   // NO uppercase
    const orig = part.origCode || part.code;
    if (!next) return { err: 'empty code' };
    if (!/^[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(next)) return { err: 'invalid format (expected like 2CH000-120000)' };
    if (next === part.code) return { ok: true, noop: true };
    const reverting = (next === orig);
    // Persist (or clear) the override, keyed by the MANIFEST code.
    if (window.firebaseDB) {
      try {
        if (reverting) await window.firebaseDB.ref('nest_code_overrides/' + orig).remove();
        else await window.firebaseDB.ref('nest_code_overrides/' + orig).set({ to: next, at: Date.now() });
      } catch (e) { return { err: 'save failed: ' + ((e && e.message) || e) }; }
    }
    if (S.codeOverrides) { if (reverting) delete S.codeOverrides[orig]; else S.codeOverrides[orig] = { to: next, at: 0 }; }
    // Re-point in memory.
    if (reverting) { part.code = orig; delete part.origCode; }
    else { part.origCode = orig; part.code = next; }
    // Re-resolve DXF + grain + size for the EFFECTIVE code (the same lookups
    // _loadProjectParts does — by part.code, which is now the new code).
    part.dxfUrl = ''; part.dxfMeta = null; part.dxfLoaded = false; part.dxfError = null;
    part.polys = null; part.bbox = null; part.w = 0; part.h = 0;
    let meta = (S.dxfsAll && S.dxfsAll[part.code]) || null;
    if (!meta && window.firebaseDB) {
      try { const s = await window.firebaseDB.ref('uploaded_dxfs/' + part.code).once('value'); meta = s.val() || null; if (meta && S.dxfsAll) S.dxfsAll[part.code] = meta; } catch (e) {}
    }
    if (meta) { part.dxfUrl = meta.url || ''; part.dxfMeta = meta; part.thickness = meta.thickness_mm || part.thickness || 0; }
    if (S.grainMap) { const lk = _lookupPattern(part.code, S.grainMap); part.grain = (lk && lk.grain) ? lk.grain : '?'; }
    try { await _ensureDxfLib(); await _loadOneDxf(part); } catch (e) {}
    return { ok: true, reverting: reverting, to: part.code };
  }

  // Swap the code label for an inline text field (admin ✏️). Enter = save,
  // Esc / blur = cancel, type the ORIGINAL manifest code to revert. Re-renders
  // in place (scroll preserved) so เอ๋'s spot in the list never jumps.
  function _startRenameEdit(row, part) {
    const span = row.querySelector('.kdnest-part-code');
    if (!span || row.querySelector('.kdnest-part-code-edit')) return;
    const cur = part.code;
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'kdnest-part-code-edit'; inp.value = cur;
    inp.spellcheck = false; inp.autocapitalize = 'off'; inp.setAttribute('autocomplete', 'off');
    inp.title = 'Type the correct code · Enter = save · Esc = cancel · type the original code to revert';
    inp.style.cssText = 'font:inherit;width:14ch;max-width:46vw;padding:1px 4px;border:1px solid #2563eb;border-radius:4px;background:rgba(37,99,235,0.12);color:inherit';
    span.style.display = 'none';
    span.insertAdjacentElement('afterend', inp);
    inp.focus(); inp.select();
    let done = false;
    const cleanup = () => { try { inp.remove(); } catch (e) {} span.style.display = ''; };
    const commit = async () => {
      if (done) return; done = true;
      const val = inp.value;   // case-preserved (NO uppercase)
      cleanup();
      const res = await _applyCodeOverride(part, val);
      if (res && res.err) { alert('Rename failed: ' + res.err); return; }
      if (res && res.noop) return;
      _refreshViewKeepScroll();
    };
    const cancel = () => { if (done) return; done = true; cleanup(); };
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    inp.addEventListener('blur', () => cancel());
  }

  // ── Load parts list ────────────────────────────────────────────────
  // Projects live in the static manifest.json (loaded by app.js, exposed
  // as window.kdManifest). DXFs live under RTDB uploaded_dxfs/<code> +
  // GitHub raw under that meta.url. We aggregate qty by code (the same
  // code can appear multiple times in a project across variants) and
  // attach the DXF URL + thickness + grain so the run-nesting phase has
  // everything it needs without further fetches.
  async function _loadProjectParts(projectKey) {
    const manifest = window.kdManifest;
    if (!manifest || !manifest.projects) {
      throw new Error('Manifest not loaded — refresh the page');
    }
    const project = manifest.projects[projectKey];
    if (!project) throw new Error(`Project '${projectKey}' not in manifest`);
    const partsRaw = Array.isArray(project.parts) ? project.parts : [];

    // Pull DXF metadata from RTDB. Even if Firebase init failed, fall
    // back to empty — the parts list still renders, individual parts
    // just won't have W/H until a DXF lands.
    let dxfsAll = {};
    if (window.firebaseDB) {
      try {
        const snap = await window.firebaseDB.ref('uploaded_dxfs').once('value');
        dxfsAll = snap.val() || {};
      } catch (e) {
        console.warn('[kdNest] uploaded_dxfs fetch failed', e);
      }
    }
    // Stash for the staleness checks (saved-job "Outdated" badges) — reuses
    // this fetch, no extra RTDB reads (RD 02 staleness-badges spec, เอ๋
    // "ทุกอย่างต้องตรงกันเสมอ ถ้าผมลืมละ").
    S.dxfsAll = dxfsAll;
    S.loadedJobStale = null;   // fresh project open = no loaded job

    // Per-part code overrides (✏️ rename, เอ๋ 2026-06-20): nest-LOCAL re-point
    // map keyed by MANIFEST code → survives a Fusion/BOM re-sync. Loaded whole,
    // applied to the aggregated parts below (before DXF/grain attach).
    let codeOverrides = {};
    if (window.firebaseDB) {
      try { const ovs = await window.firebaseDB.ref('nest_code_overrides').once('value'); codeOverrides = ovs.val() || {}; }
      catch (e) { console.warn('[kdNest] code overrides load failed', e); }
    }
    S.codeOverrides = codeOverrides;

    // Aggregate qty by code. Skip WRAPPER entries (container/occurrence codes,
    // qty 0 — CC_Assembly emits them to carry the deep tree): without this they
    // flooded the nest as phantom "unique parts" with no DXF — เอ๋'s 1NSVB0
    // showed "36 unique / 16 no-DXF" when the real cut list is 24/37 (2026-06-10).
    const byCode = new Map();
    // Raw index (INCLUDES wrappers) so _resolveCabinet can climb parent_code.
    const _byCodeRaw = new Map();
    for (const p of partsRaw) if (p && p.code) _byCodeRaw.set(p.code, p);
    for (const p of partsRaw) {
      if (!p || !p.code || p.is_wrapper) continue;
      // Cabinet capsules (เอ๋ 2026-06-11): the TOP cabinet this occurrence lives
      // under. Resolved via app.js _resolveCabinet — robust to the 17:06 manifest
      // re-scan that moved variant_root off leaves onto top wrappers (climb
      // parent_code). '' = no cabinet. Tracked per part as contrib [{pk,cab,qty}]
      // (the per-CABINET mirror of part.sources) because aggregation-by-code can
      // merge occurrences from 2+ cabinets and a toggle subtracts only that share.
      const cab = (typeof _resolveCabinet === 'function') ? _resolveCabinet(p, _byCodeRaw) : String(p.variant_root || '').trim();
      const ex = byCode.get(p.code);
      if (ex) {
        ex.qty += (p.qty || 0);
        if (!ex.urn && p.urn) ex.urn = p.urn;
        _addContrib(ex, projectKey, cab, p.qty || 0);
      } else {
        const np = _newPart(p.code, p.qty);
        // Fusion lineage urn (CC_Assembly) — lets a no-DXF row open the part
        // in Fusion via the :8765 bridge, same as the mindmap NO-PDF badge
        // (เอ๋ 2026-06-10 "สร้าง Link ให้ผมกลับไปทำที่ Fusion เหมือน NO PDF").
        np.urn = p.urn || null;
        _addContrib(np, projectKey, cab, p.qty || 0);
        byCode.set(p.code, np);
      }
    }

    // Apply ✏️ code overrides BEFORE DXF/grain attach so the new code resolves
    // its OWN DXF/size/grain. part.origCode retained for display + revert.
    for (const part of byCode.values()) {
      const ov = codeOverrides[part.code];
      const to = ov && (typeof ov === 'string' ? ov : ov.to);
      if (to && to !== part.code) { part.origCode = part.code; part.code = to; }
    }

    for (const part of byCode.values()) {
      const meta = dxfsAll[part.code];
      if (meta) {
        part.dxfUrl = meta.url || '';
        part.dxfMeta = meta;  // verbatim — used by 👁 view button
        part.thickness = meta.thickness_mm || 0;
        part.grain = (meta.grain || part.grain || 'ANY').toUpperCase();
        if (meta.grain) part.grainExplicit = true;
      }
    }

    // Drop phantom "cabinet-as-part" leaks. CC_Assembly should flag every
    // container occurrence is_wrapper (the skip at the aggregation loop above),
    // but it classifies leaf-vs-container on MATERIAL alone — so a bodyless
    // group whose root carries an ALPF tag (e.g. 1NSVB0-060050, a CABINET with
    // ~17 child parts and no sheet-metal body) slips through as a qty-1 part with
    // no DXF → a false "1 ERR / NO DXF". (เอ๋ 2026-06-26 "มันเป็น group ไม่ใช่ part")
    // SAFE 4-clause backstop (verified across 131 projects to drop ONLY
    // 1NSVB0-060050): a code is a phantom container iff (a) it is NEVER a child
    // (no occurrence has parent_code), (b) variant_root === itself, (c) it IS the
    // parent_code of >=1 other part (has children), AND (d) it has no DXF. Clause
    // (d) is the hard fail-safe: a real cuttable part always has a DXF, so a real
    // dual-role part (e.g. SD00NA-080050, a side panel that also parents supports)
    // is never dropped. Warns (not silent) so a future miss leaves a trace.
    {
      const parentCodes = new Set();        // codes that parent >=1 other part
      const codesWithParent = new Set();    // codes that ARE a child somewhere
      const vrOfCode = new Map();           // code → its variant_root (first seen)
      for (const p of partsRaw) {
        if (!p || !p.code) continue;
        if (p.parent_code) { parentCodes.add(p.parent_code); codesWithParent.add(p.code); }
        if (p.variant_root != null && !vrOfCode.has(p.code)) vrOfCode.set(p.code, p.variant_root);
      }
      for (const [key, part] of [...byCode.entries()]) {
        if (parentCodes.has(key) && !codesWithParent.has(key) && vrOfCode.get(key) === key && !part.dxfUrl) {
          console.warn('[kdNest] dropping phantom container-as-part (no is_wrapper, has children, no DXF):', key);
          byCode.delete(key);
        }
      }
    }

    // Apply grain.json rules — same pattern table the Python tool reads
    // from NestingTool/grain.xlsx. User edits the xlsx; a one-shot
    // conversion writes drawings-ui/grain.json next to it. Patterns:
    // exact > XX wildcard > longest prefix > longest suffix > longest
    // substring (matches Python's lookup_in_map priority).
    if (true) {   // always reload live RTDB grain_rules (เอ๋'s modal edits win over the grain.json seed)
      // grain_rules (RTDB, edited in the 🧬 Grain modal) is the live source;
      // grain.json is the seed when RTDB is empty. _loadGrainRows does both.
      // FORCE a fresh read: _loadGrainRows() short-circuits on a cached
      // S.grainRows, so without clearing it a 2nd project (or a rule edited on
      // ANOTHER device since this session loaded) keeps STALE grain/fix-height
      // — that's why a saved BK* fix-height didn't reach the parts (เอ๋ 2026-06-10).
      S.grainRows = null;
      try {
        await _loadGrainRows();
        _grainRowsToMap();
      } catch (e) {
        console.warn('[kdNest] grain rules load failed (continuing without):', e);
      }
    }
    if (S.grainMap) {
      for (const part of byCode.values()) {
        const looked = _lookupPattern(part.code, S.grainMap);
        part.grain = (looked && looked.grain) ? looked.grain : '?';   // no rule matched -> '?' uncertain (desktop parity)
        // Thickness override mirrors the Python behaviour — grain.xlsx
        // can pin the value when Fusion's export is wrong (BM* = 1mm).
        if (looked && looked.thickness) {
          const t = parseFloat(looked.thickness.replace(/mm/i, ''));
          if (!isNaN(t)) part.thickness = t;
        }
        // FIX (เอ๋ 2026-06-10): one value-list whose meaning follows the
        // direction — │ V → the value(s) become the HEIGHT, ─ H → the WIDTH.
        // Locks orientation at nest time (cut size unchanged). ✱ ANY → no fix.
        const _fix = _parseFixHeights(looked && looked.fix);
        const _g = looked ? String(looked.grain || '').toUpperCase() : '';
        part.fixHeights = (_g === 'V') ? _fix : [];
        part.fixWidths  = (_g === 'H') ? _fix : [];
      }
    }

    S.projectKey = projectKey;
    S.projectName = project.name || projectKey;
    S.parts = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
    _applyOrientFlagsToParts();   // FLIP180/MIRROR per-part flags from grain_rules
    // Multi-project nesting (เอ๋ board 76ebca5): provenance per part — which
    // project wants how many of this code. Fresh open = single source.
    S.mergedProjects = [projectKey];
    for (const p of S.parts) p.sources = { [projectKey]: p.qty || 0 };
    // Cabinet capsules: restore this project's persisted OFF-set; recompute
    // qty from the ON subset only when something is actually excluded (the
    // full-sum qty above is already correct when every cabinet is ON).
    S.cabinetsOff = _loadCabSel(projectKey);
    S.capFold = _loadCapFold(projectKey);   // F-folder collapse state
    if (S.cabinetsOff.size) _recomputeCabinetQtys();
  }

  // ── "+ Project" merge (เอ๋ board 76ebca5: multi-project nesting) ──────────
  // Pulls another project's LEAF parts into the current list. Same code across
  // projects = the same master part (same DXF) → qty merges into one row, with
  // per-project counts kept in part.sources so cut sheets / saved jobs can say
  // "ตู้ไหนกี่ชิ้น". DXF meta + grain rules applied exactly like the primary
  // load (S.dxfsAll + S.grainMap reused — no extra fetches).
  async function _mergeProjectParts(projectKey) {
    const m = window.kdManifest;
    const project = m && m.projects && m.projects[projectKey];
    if (!project) { alert(`Project '${projectKey}' not in manifest`); return; }
    if ((S.mergedProjects || []).includes(projectKey)) return;
    const byCode = new Map();
    const _rawParts = Array.isArray(project.parts) ? project.parts : [];
    const _byCodeRaw = new Map();
    for (const p of _rawParts) if (p && p.code) _byCodeRaw.set(p.code, p);
    for (const p of _rawParts) {
      if (!p || !p.code || p.is_wrapper) continue;
      const cab = (typeof _resolveCabinet === 'function') ? _resolveCabinet(p, _byCodeRaw) : String(p.variant_root || '').trim();
      const ex = byCode.get(p.code);
      if (ex) {
        ex.qty += (p.qty || 0); if (!ex.urn && p.urn) ex.urn = p.urn;
        _addContrib(ex, projectKey, cab, p.qty || 0);
      } else {
        const np = _newPart(p.code, p.qty);
        np.urn = p.urn || null;
        _addContrib(np, projectKey, cab, p.qty || 0);
        byCode.set(p.code, np);
      }
    }
    for (const part of byCode.values()) {
      const meta = (S.dxfsAll || {})[part.code];
      if (meta) {
        part.dxfUrl = meta.url || '';
        part.dxfMeta = meta;
        part.thickness = meta.thickness_mm || 0;
        part.grain = (meta.grain || part.grain || 'ANY').toUpperCase();
        if (meta.grain) part.grainExplicit = true;
      }
      if (S.grainMap) {
        const looked = _lookupPattern(part.code, S.grainMap);
        part.grain = (looked && looked.grain) ? looked.grain : '?';
        if (looked && looked.thickness) {
          const t = parseFloat(String(looked.thickness).replace(/mm/i, ''));
          if (!isNaN(t)) part.thickness = t;
        }
        const _fix = _parseFixHeights(looked && looked.fix);
        const _g = looked ? String(looked.grain || '').toUpperCase() : '';
        part.fixHeights = (_g === 'V') ? _fix : [];
        part.fixWidths  = (_g === 'H') ? _fix : [];
      }
    }
    // Merge into the live list: same code → one row, qty summed, source recorded.
    for (const np of byCode.values()) {
      const ex = S.parts.find(p => p.code === np.code && !p.manual);
      if (ex) {
        ex.qty = (ex.qty || 0) + (np.qty || 0);
        ex.sources = ex.sources || { [S.projectKey]: ex.qty - (np.qty || 0) };
        ex.sources[projectKey] = (ex.sources[projectKey] || 0) + (np.qty || 0);
        for (const c of (np.contrib || [])) _addContrib(ex, c.pk, c.cab, c.qty);
      } else {
        np.sources = { [projectKey]: np.qty || 0 };
        S.parts.push(np);
      }
    }
    S.parts.sort((a, b) => a.code.localeCompare(b.code));
    _applyOrientFlagsToParts();   // FLIP180/MIRROR per-part flags from grain_rules
    (S.mergedProjects = S.mergedProjects || [S.projectKey]).push(projectKey);
    // If cabinets are excluded, the merged contributions must respect that too
    // (a merged cabinet sharing a key with an OFF one keeps only the ON share).
    if (S.cabinetsOff && S.cabinetsOff.size) _recomputeCabinetQtys();
    S.loadedJobStale = null;   // the list changed — any loaded-job badge is moot
    _refreshView();
    await _loadAllDxfs();
    if (!S.closing) _refreshView();
  }

  // ── "↻ Re-resolve codes" (RD/เอ๋ 2026-06-20) ───────────────────────────────
  // A saved/loaded nest stores each part's code as a snapshot at add-time. When a
  // project's part code is later corrected in Fusion (CC_Assembly rename, e.g.
  // 2CN027-000000 → 2CN002-120000), the snapshot keeps the OLD code → its
  // uploaded_dxfs/<old> is null → NO-DXF. A page refresh doesn't help (a loaded
  // nest re-reads its own snapshot, not the manifest). This re-reads every part's
  // CURRENT code from a FRESH manifest by its STABLE Fusion lineage urn, adopts
  // it, re-links the DXF, and clears the stuck NO-DXF rows IN PLACE — no
  // remove/re-add. Loaded jobs that predate urn-persistence recover the urn from
  // the manifest for any part whose code hasn't drifted yet.
  async function _reresolveCodes() {
    const btn = S.rootEl && S.rootEl.querySelector('#kdnest-reresolve');
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '↻ …'; }
    try {
      // 1) FRESH manifest — defeats stale CDN / in-memory manifest AND the loaded
      //    nest's own snapshot. ?t= makes the Drawings/*.json a CDN cache-miss
      //    (same trick app.js uses) + no-store bypasses the browser cache.
      let manifest = window.kdManifest;
      try {
        const mu = (window.APP_CONFIG && window.APP_CONFIG.MANIFEST_URL) || 'Drawings/manifest.json';
        const url = mu + (mu.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
        const resp = await fetch(url, { cache: 'no-store' });
        if (resp.ok) { manifest = await resp.json(); window.kdManifest = manifest; }
      } catch (e) { console.warn('[kdNest] re-resolve: manifest refetch failed, using cached', e); }
      if (!manifest || !manifest.projects) { alert('Manifest unavailable — cannot re-resolve codes.'); return; }

      // 2) urn ⇄ current-code maps across EVERY source project in this nest.
      const projKeys = (S.mergedProjects && S.mergedProjects.length) ? S.mergedProjects : [S.projectKey];
      const codeByUrn = new Map();   // lineage urn → current code
      const urnByCode = new Map();   // current code → lineage urn (recover urn for un-drifted parts)
      for (const pk of projKeys) {
        const proj = manifest.projects[pk];
        if (!proj || !Array.isArray(proj.parts)) continue;
        for (const mp of proj.parts) {
          if (!mp || !mp.code || mp.is_wrapper || !mp.urn) continue;
          if (!codeByUrn.has(mp.urn)) codeByUrn.set(mp.urn, mp.code);
          urnByCode.set(mp.code, mp.urn);
        }
      }

      // 3) fresh uploaded_dxfs + ✏️ code overrides + grain map (so the corrected
      //    code resolves its OWN DXF / size / grain, exactly like a fresh open).
      let dxfsAll = S.dxfsAll || {};
      if (window.firebaseDB) {
        try { const s = await window.firebaseDB.ref('uploaded_dxfs').once('value'); dxfsAll = s.val() || {}; S.dxfsAll = dxfsAll; }
        catch (e) { console.warn('[kdNest] re-resolve: uploaded_dxfs fetch failed', e); }
      }
      let overrides = S.codeOverrides || {};
      if (window.firebaseDB) {
        try { const s = await window.firebaseDB.ref('nest_code_overrides').once('value'); overrides = s.val() || {}; S.codeOverrides = overrides; }
        catch (e) { /* keep prior overrides */ }
      }
      if (!S.grainMap) { try { S.grainRows = null; await _loadGrainRows(); _grainRowsToMap(); } catch (e) { /* continue without */ } }

      // 4) re-resolve each part: adopt current code (urn → manifest, then ✏️
      //    override), re-link DXF meta, re-apply grain rules.
      const remap = new Map();   // oldCode → newCode (to follow on the laid-out sheets)
      const beforeNoDxf = new Set();
      const toReload = [];
      let changed = 0;
      for (const p of S.parts) {
        if (p.manual) continue;
        if (!p.dxfLoaded || p.dxfError || !p.polys) beforeNoDxf.add(p);
        const oldCode = p.code;
        // recover a missing urn from the manifest (un-drifted parts / pre-urn jobs)
        if (!p.urn && urnByCode.has(oldCode)) p.urn = urnByCode.get(oldCode);
        let newCode = (p.urn && codeByUrn.has(p.urn)) ? codeByUrn.get(p.urn) : oldCode;
        const ov = overrides[newCode];
        const ovTo = ov && (typeof ov === 'string' ? ov : ov.to);
        if (ovTo && ovTo !== newCode) newCode = ovTo;
        const codeChanged = newCode !== oldCode;
        if (codeChanged) { remap.set(oldCode, newCode); p.code = newCode; p.origCode = null; changed++; }
        // re-link DXF meta for the (possibly new) code
        const meta = dxfsAll[p.code];
        if (meta) {
          p.dxfUrl = meta.url || '';
          p.dxfMeta = meta;
          p.thickness = meta.thickness_mm || 0;
          p.grain = (meta.grain || p.grain || 'ANY').toUpperCase();
          if (meta.grain) p.grainExplicit = true;
        } else if (codeChanged) {
          // the corrected code has no uploaded DXF (yet) → honest NO-DXF, not a stale link
          p.dxfUrl = ''; p.dxfMeta = null; p.dxfLoaded = false; p.dxfError = 'No DXF uploaded yet'; p.polys = null; p.bbox = null;
        }
        // grain rules are the live source (same as a fresh load — เอ๋'s modal edits win)
        if (S.grainMap) {
          const looked = _lookupPattern(p.code, S.grainMap);
          p.grain = (looked && looked.grain) ? looked.grain : '?';
          if (looked && looked.thickness) { const t = parseFloat(String(looked.thickness).replace(/mm/i, '')); if (!isNaN(t)) p.thickness = t; }
          const _fix = _parseFixHeights(looked && looked.fix);
          const _g = looked ? String(looked.grain || '').toUpperCase() : '';
          p.fixHeights = (_g === 'V') ? _fix : [];
          p.fixWidths  = (_g === 'H') ? _fix : [];
        }
        // (re)load the DXF when the code changed or the part is currently NO-DXF
        if (p.dxfUrl && (codeChanged || !p.dxfLoaded || p.dxfError || !p.polys)) {
          p.dxfLoaded = false; p.dxfError = null; p.polys = null; p.bbox = null;
          toReload.push(p);
        }
      }

      // 5) reload in place — STANDARD path (no directUrl): _loadOneDxf maps the
      //    stored url through _toJsdelivrUrl (uploaded_dxfs urls use a synthetic
      //    github.io host that only resolves via the CORS-friendly jsdelivr
      //    mirror; a raw directUrl fetch fails CORS) + commit-pin + content_md5
      //    cache key — exactly how the initial load resolves every part.
      if (toReload.length) {
        try { await _ensureDxfLib(); } catch (e) { /* parse will surface the error per-part */ }
        await Promise.all(toReload.map(p => _loadOneDxf(p).catch(() => {})));
      }

      // 6) the laid-out sheets reference parts by code — follow the rename so the
      //    placements keep their outline + the saved cut sheet uses the right code.
      if (S.flatSheets && S.flatSheets.length) {
        for (const sh of S.flatSheets) {
          for (const pl of (sh.placements || [])) {
            if (remap.has(pl.code)) pl.code = remap.get(pl.code);
            const part = S.parts.find(x => x.code === pl.code && !x.manual);
            if (part) { pl.polys = part.polys; pl.bbox = part.bbox; }
          }
        }
      }

      // 7) tally, render in place (no scroll jump), report.
      let resolvedNow = 0, stillMissing = 0;
      for (const p of S.parts) {
        if (p.manual) continue;
        if (beforeNoDxf.has(p) && p.dxfLoaded && p.polys && !p.dxfError) resolvedNow++;
        if (!p.dxfUrl) stillMissing++;
      }
      S.loadedJobStale = null;   // codes are now reconciled to the live manifest
      if (!S.closing) _refreshViewKeepScroll();

      let msg;
      if (!changed && !resolvedNow) {
        msg = stillMissing
          ? `Codes already current — ${stillMissing} part(s) still have no uploaded DXF (export + upload in Fusion, or remove if not needed).`
          : 'All codes already current — nothing to re-resolve.';
      } else {
        msg = `Re-resolved ${changed} code${changed === 1 ? '' : 's'}`;
        if (resolvedNow) msg += ` · ${resolvedNow} now linked to a DXF`;
        if (stillMissing) msg += ` · ${stillMissing} still missing a DXF`;
        msg += '.';
      }
      alert(msg);
    } catch (e) {
      console.error('[kdNest] re-resolve failed', e);
      alert('Re-resolve failed: ' + (e && e.message || e));
    } finally {
      const b2 = S.rootEl && S.rootEl.querySelector('#kdnest-reresolve');
      if (b2) { b2.disabled = false; b2.textContent = orig || '↻ Re-resolve'; }
    }
  }

  // ── Cabinet capsules (เอ๋ 2026-06-11: "เลือกว่าเอาหรือไม่เอา เป็นรายตู้") ──
  // manifest leaf parts carry variant_root = the top cabinet; aggregation by
  // code can merge 2+ cabinets into one row, so every row keeps contrib
  // [{pk, cab, qty}] and a capsule toggle recomputes qty from the ON subset.
  // OFF-set persists per project (localStorage) + rides saved jobs (cabinets_off).
  const _cabSelKey = pk => 'kd_nest_cabsel_' + pk;
  function _loadCabSel(pk) {
    try {
      const v = JSON.parse(localStorage.getItem(_cabSelKey(pk)) || '[]');
      return new Set(Array.isArray(v) ? v.map(x => String(x)) : []);
    } catch (e) { return new Set(); }
  }
  function _saveCabSel() {
    try {
      localStorage.setItem(_cabSelKey(S.projectKey),
        JSON.stringify([...(S.cabinetsOff || new Set())]));
    } catch (e) { /* quota / private mode — non-fatal */ }
  }
  function _addContrib(part, pk, cab, qty) {
    part.contrib = part.contrib || [];
    const e = part.contrib.find(c => c.pk === pk && c.cab === cab);
    if (e) e.qty += qty; else part.contrib.push({ pk, cab, qty });
  }
  // True when EVERY cabinet this part belongs to is excluded → the row is
  // hidden from the list and contributes nothing to Run/Save. Manual rects and
  // rows without cabinet data (old manifests, loaded-job-only codes) never hide.
  function _cabAllOff(p) {
    if (!p || p.manual) return false;
    const off = S.cabinetsOff;
    if (!off || !off.size) return false;
    const c = p.contrib;
    if (!Array.isArray(c) || !c.length) return false;
    return c.every(x => off.has(x.cab));
  }
  // Recompute qty + sources for every contrib-bearing row from the ON-cabinet
  // subset only (a code shared by an ON and an OFF cabinet keeps the ON share).
  function _recomputeCabinetQtys() {
    const off = S.cabinetsOff || new Set();
    for (const p of S.parts) {
      if (p.manual || !Array.isArray(p.contrib) || !p.contrib.length) continue;
      let qty = 0; const src = {};
      for (const c of p.contrib) {
        if (off.has(c.cab)) continue;
        qty += c.qty || 0;
        src[c.pk] = (src[c.pk] || 0) + (c.qty || 0);
      }
      p.qty = qty;
      p.sources = src;
    }
  }
  // Distinct cabinets across the current list: [{cab, pcs, nParts}] — named
  // cabinets alphabetical, the no-cabinet bucket ('') last. pcs = FULL design
  // count (what the cabinet contains), independent of the toggle state.
  function _cabinetGroups() {
    const map = new Map();
    for (const p of S.parts) {
      for (const c of (p.contrib || [])) {
        const g = map.get(c.cab) || { cab: c.cab, pcs: 0, nParts: 0 };
        g.pcs += c.qty || 0;
        g.nParts += 1;
        map.set(c.cab, g);
      }
    }
    return [...map.values()].sort((a, b) =>
      (a.cab === '') - (b.cab === '') || a.cab.localeCompare(b.cab));
  }
  function _toggleCabinet(cab) {
    cab = String(cab == null ? '' : cab);
    S.cabinetsOff = S.cabinetsOff || new Set();
    if (S.cabinetsOff.has(cab)) S.cabinetsOff.delete(cab);
    else S.cabinetsOff.add(cab);
    _saveCabSel();
    _recomputeCabinetQtys();
    S.loadedJobStale = null;   // the list changed deliberately — badge is moot
    _refreshView();
  }
  function _setAllCabinets(on) {
    S.cabinetsOff = on ? new Set() : new Set(_cabinetGroups().map(g => g.cab));
    _saveCabSel();
    _recomputeCabinetQtys();
    S.loadedJobStale = null;
    _refreshView();
  }
  // Rebuild contrib from the CURRENT manifest for every non-manual row (used
  // after a saved-job load, whose snapshot doesn't carry cabinet data). Codes
  // no longer in the manifest keep no contrib → capsules can't touch them.
  function _attachCabinetsFromManifest() {
    const m = window.kdManifest;
    if (!m || !m.projects) return;
    const byCode = new Map();
    for (const pk of (S.mergedProjects || [S.projectKey])) {
      const project = m.projects[pk];
      if (!project || !Array.isArray(project.parts)) continue;
      const _byCodeRaw = new Map();
      for (const p of project.parts) if (p && p.code) _byCodeRaw.set(p.code, p);
      for (const p of project.parts) {
        if (!p || !p.code || p.is_wrapper) continue;
        const cab = (typeof _resolveCabinet === 'function') ? _resolveCabinet(p, _byCodeRaw) : String(p.variant_root || '').trim();
        const list = byCode.get(p.code) || [];
        const e = list.find(c => c.pk === pk && c.cab === cab);
        if (e) e.qty += (p.qty || 0); else list.push({ pk, cab, qty: p.qty || 0 });
        byCode.set(p.code, list);
      }
    }
    for (const part of S.parts) {
      if (part.manual) continue;
      const list = byCode.get(part.code);
      if (list) part.contrib = list.map(c => ({ pk: c.pk, cab: c.cab, qty: c.qty }));
    }
  }

  // ── F-group folders for the capsules (เอ๋ 2026-06-12: "group capsules เป็น
  // Folder F1/F2 เปิดปิดได้") ──────────────────────────────────────────────
  // CC_Assembly emits a top wrapper layer (F1/F2…) above the cabinets: each
  // cabinet's wrapper row carries parent_code = its F-group, and the F-rows
  // themselves are is_wrapper with a code like 'F<digit>' (471344e). We group
  // the capsules under collapsible F-folders, each with a whole-group ON/OFF
  // toggle. Projects with NO F-layer (29/30 today) fall back to the flat list.
  // Returns { folders:[{fg, cabs:[group]}], ungrouped:[group], hasF }.
  function _cabinetFolders() {
    const groups = _cabinetGroups();                 // [{cab,pcs,nParts}] (incl '' bucket)
    const m = window.kdManifest;
    const cabFG = new Map();                          // cab code -> F-group code
    const fOrder = [];                               // ordered distinct F-row codes (incl empty)
    const fSeen = new Set();
    if (m && m.projects) {
      for (const pk of (S.mergedProjects || [S.projectKey])) {
        const proj = m.projects[pk];
        if (!proj || !Array.isArray(proj.parts)) continue;
        const byCode = new Map();
        for (const p of proj.parts) if (p && p.code) byCode.set(p.code, p);
        // F-rows = top wrapper rows whose code is F<digit> (F1/F2…). A cabinet
        // code starting with F but not a digit (FCLL…, FN…, FT…) is NOT a group.
        for (const p of proj.parts) {
          if (p && p.is_wrapper && /^F\d/.test(p.code || '') && !fSeen.has(p.code)) {
            fSeen.add(p.code); fOrder.push(p.code);
          }
        }
        for (const g of groups) {
          if (!g.cab || cabFG.has(g.cab)) continue;
          // A cab that IS an F-row code = parts attached directly to that group
          // (no sub-cabinet) → keep it inside its own folder, not loose.
          if (fSeen.has(g.cab)) { cabFG.set(g.cab, g.cab); continue; }
          const row = byCode.get(g.cab);
          const pc = row && row.parent_code;
          const par = pc && byCode.get(pc);
          if (par && par.is_wrapper && /^F\d/.test(pc)) cabFG.set(g.cab, pc);
        }
      }
    }
    const folders = fOrder.map(fg => ({ fg, cabs: groups.filter(g => cabFG.get(g.cab) === fg) }));
    const ungrouped = groups.filter(g => !cabFG.get(g.cab));   // '' bucket + any non-F cabinet
    return { folders, ungrouped, hasF: folders.length > 0 };
  }
  // Collapse state per project (selection already persists via cabinetsOff).
  const _capFoldKey = pk => 'kd_nest_capfold_' + pk;
  function _loadCapFold(pk) {
    try {
      const v = JSON.parse(localStorage.getItem(_capFoldKey(pk)) || '[]');
      return new Set(Array.isArray(v) ? v.map(x => String(x)) : []);
    } catch (e) { return new Set(); }
  }
  function _saveCapFold() {
    try { localStorage.setItem(_capFoldKey(S.projectKey), JSON.stringify([...(S.capFold || new Set())])); }
    catch (e) { /* quota / private mode — non-fatal */ }
  }
  function _toggleCapFold(fg) {
    S.capFold = S.capFold || new Set();
    if (S.capFold.has(fg)) S.capFold.delete(fg); else S.capFold.add(fg);
    _saveCapFold();
    _refreshView();
  }
  // Whole-group include/exclude: any cabinet ON in the group → exclude them all;
  // all already OFF → include them all (เอ๋ "เลือกปิดทั้งกลุ่มได้").
  function _toggleCabinetGroup(fg) {
    const folder = _cabinetFolders().folders.find(f => f.fg === fg);
    if (!folder || !folder.cabs.length) return;
    S.cabinetsOff = S.cabinetsOff || new Set();
    const off = S.cabinetsOff;
    const anyOn = folder.cabs.some(g => !off.has(g.cab));
    for (const g of folder.cabs) { if (anyOn) off.add(g.cab); else off.delete(g.cab); }
    _saveCabSel();
    _recomputeCabinetQtys();
    S.loadedJobStale = null;
    _refreshView();
  }

  function _openAddProjectModal() {
    document.querySelectorAll('.kdaddproj-modal').forEach(x => x.remove());
    const m = window.kdManifest || {};
    const merged = S.mergedProjects || [S.projectKey];
    const cands = Object.entries(m.projects || {})
      .filter(([key]) => !merged.includes(key))
      .filter(([key]) => !(typeof window.isProjectSoftDeleted === 'function' && window.isProjectSoftDeleted(key)))
      .map(([key, p]) => ({
        key,
        name: p.name || key,
        n: (Array.isArray(p.parts) ? p.parts : []).filter(x => x && x.code && !x.is_wrapper).length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const rows = cands.length ? cands.map(c => `
      <div class="kdjobs-row kdaddproj-row" data-key="${_esc(c.key)}">
        <div class="kdjobs-main">
          <span class="kdjobs-name">${_esc(c.name)}</span>
          <span class="kdjobs-meta">${c.n} unique parts</span>
        </div>
        <button class="kdjobs-load kdaddproj-add" data-key="${_esc(c.key)}">Add</button>
      </div>`).join('') : '<div class="kdjobs-empty">No other projects to add.</div>';
    const modal = document.createElement('div');
    modal.className = 'kdstock-modal kdjobs-modal kdaddproj-modal';
    modal.innerHTML = '<div class="kdstock-backdrop"></div>'
      + `<div class="kdstock-frame" role="dialog" aria-label="Add Project">
           <div class="kdstock-head">＋ Add Project
             <span class="kdstock-sub">merge another project's parts into this nest</span>
             <button class="kdstock-close" aria-label="Close">✕</button>
           </div>
           <div class="kdjobs-body">${rows}</div>
         </div>`;
    document.body.appendChild(modal);
    const closeModal = () => modal.remove();
    modal.querySelector('.kdstock-backdrop').addEventListener('click', closeModal);
    modal.querySelector('.kdstock-close').addEventListener('click', closeModal);
    modal.querySelectorAll('.kdaddproj-add').forEach(btn => btn.addEventListener('click', async () => {
      const key = btn.dataset.key;
      closeModal();
      await _mergeProjectParts(key);
    }));
  }

  // ── Grain rules editor (RTDB grain_rules, seeded from grain.json) ─────
  // Edit grain/thickness on the web instead of opening grain.xlsx. Stored
  // at RTDB grain_rules = { rows:[{pattern,grain,thickness}], updated_at }.
  // Phase B (Fusion) syncs this back to grain.xlsx + grain.json for the
  // desktop/laser side. (user 2026-05-29)
  function _grainCh(g) {
    g = String(g || '').toUpperCase();
    // EDGE (angled grain) rows show ◣ — they are created by clicking an edge in
    // the part preview, never by the modal cycle. (angled-grain 2026-06-25)
    return g === 'H' ? '─' : g === 'V' ? '│' : g === 'EDGE' ? '◣' : '✱';
  }
  function _grainNext(g) {
    g = String(g || '').toUpperCase();
    // Modal cycle stays H→V→ANY→H. Clicking the glyph on an EDGE rule converts
    // it to a plain H rule (EDGE/angle is a preview-only flow; the modal has no
    // angle entry in milestone-1). TODO(phase-5): admin angle column.
    if (g === 'EDGE') return 'H';
    return g === 'H' ? 'V' : g === 'V' ? 'ANY' : 'H';
  }
  // Fix-height accepts MULTIPLE values, comma-separated (เอ๋ 2026-06-10 'หลายตัว
  // เช่น 400,500') — one rule covers BK parts of different heights. Returns a
  // sorted unique array of positive numbers. "789" → [789]; "400, 500mm" → [400,500].
  function _parseFixHeights(v) {
    if (v == null || v === '') return [];
    const out = [];
    String(v).split(/[,\s]+/).forEach(s => {
      const n = parseFloat(String(s).replace(/mm/i, '').trim());
      if (!isNaN(n) && n > 0 && out.indexOf(n) === -1) out.push(n);
    });
    return out;
  }
  // Sort rules A->Z by pattern (user 2026-05-29 'grain ให้เรียงตามตัวอักษร');
  // blank-pattern rows (freshly added, not yet typed) sink to the bottom.
  function _sortGrainRows() {
    if (!Array.isArray(S.grainRows)) return;
    S.grainRows.sort((a, b) => {
      const pa = String(a.pattern || '').trim();
      const pb = String(b.pattern || '').trim();
      if (!pa && !pb) return 0;
      if (!pa) return 1;
      if (!pb) return -1;
      return pa.localeCompare(pb, undefined, { sensitivity: 'base' });
    });
  }
  async function _loadGrainRows() {
    if (S.grainRows) return S.grainRows;
    let rows = null;
    try {
      if (window.firebaseDB) {
        const snap = await window.firebaseDB.ref('grain_rules').once('value');
        const v = snap.val();
        if (v && Array.isArray(v.rows) && v.rows.length) rows = v.rows;
      }
    } catch (e) { console.warn('[kdNest] grain_rules read failed:', e); }
    if (!rows) {
      try {
        const resp = await fetch('grain.json?v=' + Date.now(), { cache: 'no-store' });
        if (resp.ok) { const j = await resp.json(); rows = j.rows || []; }
      } catch (e) { console.warn('[kdNest] grain.json seed failed:', e); }
    }
    // New unified model (เอ๋ 2026-06-10): ONE `fix` field whose meaning follows
    // the direction (grain): │ V → the value(s) are the HEIGHT; ─ H → the WIDTH.
    // Migrate the old split fields: Fix V (height) → grain V; Fix H (width) →
    // grain H — so existing rules keep their intent.
    S.grainRows = (rows || []).map(r => {
      let grain = String(r.grain || 'ANY').toUpperCase();
      let fix = '';
      if (r.fix != null && String(r.fix).trim() !== '') fix = String(r.fix);
      else if (r.height != null && String(r.height).trim() !== '') { fix = String(r.height); grain = 'V'; }
      else if (r.width != null && String(r.width).trim() !== '') { fix = String(r.width); grain = 'H'; }
      // EDGE (angled grain): an optional `angle` field [0,180). Backward-compat —
      // old rows have no `angle`, which loads as null and is simply ignored by
      // the H/V/ANY paths. (angled-grain feature 2026-06-25)
      let angle = null;
      if (r.angle != null && String(r.angle).trim() !== '') {
        const a = Number(r.angle);
        if (!isNaN(a)) angle = ((a % 180) + 180) % 180;
      }
      return {
        pattern: String(r.pattern || ''),
        grain,
        thickness: (r.thickness == null ? '' : String(r.thickness)),
        fix,
        angle,
      };
    });
    return S.grainRows;
  }
  function _grainRowsToMap() {
    if (S.grainRows) S.grainMap = _buildPatternMap(S.grainRows);
  }
  function _applyGrainToParts() {
    if (!S.grainMap) return;
    for (const part of S.parts) {
      const looked = _lookupPattern(part.code, S.grainMap);
      part.grain = (looked && looked.grain) ? looked.grain : '?';   // no rule matched -> '?' uncertain (desktop parity)
      // EDGE angle: only meaningful when the matched rule is EDGE; otherwise
      // clear it so an H/V/ANY rule never carries a stale angle. (2026-06-25)
      part.grainAngle = (looked && looked.grain === 'EDGE' && looked.angle != null)
        ? Number(looked.angle) : null;
      if (looked && looked.thickness) {
        const t = parseFloat(String(looked.thickness).replace(/mm/i, ''));
        if (!isNaN(t)) part.thickness = t;
      }
      const _fix = _parseFixHeights(looked && looked.fix);
      const _g = looked ? String(looked.grain || '').toUpperCase() : '';
      part.fixHeights = (_g === 'V') ? _fix : [];
      part.fixWidths  = (_g === 'H') ? _fix : [];
      // Orientation flags (separate exact-code rows, stack on top of grain).
      part.flip180 = _readPartFlip180(part.code);
      part.mirror  = _readPartMirror(part.code);
    }
  }
  async function _saveGrainRows() {
    const clean = (S.grainRows || []).filter(r => String(r.pattern).trim());
    S.grainRows = clean;
    _sortGrainRows();                       // persist in A->Z pattern order
    if (window.firebaseDB) {
      await window.firebaseDB.ref('grain_rules').set({ rows: S.grainRows, updated_at: Date.now() });
    }
    _grainRowsToMap();
    _applyGrainToParts();
  }
  // ── EDGE (angled grain) persistence ────────────────────────────────
  // Set a part to EDGE grain at `angleDeg` (or clear back to a fresh '?' state)
  // and persist it as an EXACT-code grain rule so it survives reload + applies
  // on every device. Exact-code rules win over wildcard patterns in
  // _lookupPattern, so this overrides any BK*/etc rule for just this one part.
  // Additive — never touches H/V/ANY parts. (angled-grain feature 2026-06-25)
  async function _setPartEdgeGrain(part, angleDeg) {
    if (!part) return;
    if (!S.grainRows) { try { await _loadGrainRows(); } catch (_) { S.grainRows = S.grainRows || []; } }
    const code = part.code;
    let row = (S.grainRows || []).find(r => String(r.pattern) === code);
    if (angleDeg == null) {
      // Clear: drop our exact-code EDGE row (the part falls back to its
      // wildcard rule, or '?' if none) and reset the in-memory part.
      if (row) S.grainRows = S.grainRows.filter(r => r !== row);
      part.grain = '?'; part.grainAngle = null;
    } else {
      const a = ((Number(angleDeg) % 180) + 180) % 180;
      if (!row) {
        row = { pattern: code, grain: 'EDGE', thickness: '', fix: '', angle: a };
        S.grainRows.push(row);
      } else {
        row.grain = 'EDGE'; row.angle = a;
      }
      part.grain = 'EDGE'; part.grainAngle = a;
    }
    try { await _saveGrainRows(); } catch (e) { console.warn('[kdNest] EDGE grain save failed:', e); }
  }

  function _openGrainModal() {
    _loadGrainRows().then(_renderGrainModal)
      .catch(e => alert('Grain load failed: ' + (e.message || e)));
  }
  function _renderGrainModal() {
    document.querySelectorAll('.kdng-modal').forEach(m => m.remove());
    _sortGrainRows();
    const rows = S.grainRows || [];
    const cell = (r, i) => `
      <div class="kdng-row" data-i="${i}">
        <input class="kdng-pat" data-i="${i}" value="${_esc(r.pattern)}" placeholder="BK*" spellcheck="false">
        <input class="kdng-th" data-i="${i}" value="${_esc(r.thickness)}" placeholder="1.0" inputmode="decimal" title="Thickness (mm)">
        <button class="kdng-grain" data-i="${i}" title="direction — click to cycle ─ H (horizontal) / │ V (vertical) / ✱ ANY">${_grainCh(r.grain)}</button>
        <input class="kdng-fix" data-i="${i}" value="${_esc(r.fix)}" placeholder="FIX" inputmode="text" spellcheck="false" title="FIX — the dimension(s) to lock; meaning follows the direction: │ V = that value is the HEIGHT, ─ H = the WIDTH. Multiple comma-separated (e.g. 100,200). The part rotates so that side matches; cut size unchanged. ✱ ANY = free.">
        <button class="kdng-del" data-i="${i}" title="delete rule">✕</button>
      </div>`;
    const half = Math.ceil(rows.length / 2);
    const colA = rows.slice(0, half).map((r, i) => cell(r, i)).join('');
    const colB = rows.slice(half).map((r, i) => cell(r, i + half)).join('');
    const modal = document.createElement('div');
    modal.className = 'kdng-modal';
    // No backdrop: เอ๋ 2026-06-10 "ไม่ต้องทำให้อย่างอื่นจางลงเพราะผมต้องดูตัวเลขด้วย" —
    // the page behind stays bright AND interactive (.kdng-modal is pointer-events:none,
    // only the box catches input), so she can scroll the part list while editing rules.
    // Close = Cancel/Save only (no outside-click discard any more).
    modal.innerHTML = `
      <div class="kdng-box">
        <div class="kdng-head">🧬 Grain rules
          <span class="kdng-sub">pattern · thickness · direction · FIX · ${rows.length} rules · shared</span>
        </div>
        <div class="kdng-grid">
          <div class="kdng-col">${colA || '<div class="kdng-empty">no rules — + Add</div>'}</div>
          <div class="kdng-col">${colB}</div>
        </div>
        <div class="kdng-foot">
          <button id="kdng-add" class="kdnest-mini">+ Add</button>
          <span class="kdng-spacer"></span>
          <button id="kdng-cancel" class="kdnest-btn">Cancel</button>
          <button id="kdng-save" class="kdnest-btn kdnest-btn-run">💾 Save</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const q = sel => modal.querySelector(sel);
    const discard = () => { S.grainRows = null; modal.remove(); };
    q('#kdng-cancel').addEventListener('click', discard);
    modal.querySelectorAll('.kdng-pat').forEach(el => el.addEventListener('input', e => {
      const i = +e.target.dataset.i; if (S.grainRows[i]) S.grainRows[i].pattern = e.target.value;
    }));
    modal.querySelectorAll('.kdng-th').forEach(el => el.addEventListener('input', e => {
      const i = +e.target.dataset.i; if (S.grainRows[i]) S.grainRows[i].thickness = e.target.value;
    }));
    modal.querySelectorAll('.kdng-fix').forEach(el => el.addEventListener('input', e => {
      const i = +e.target.dataset.i; if (S.grainRows[i]) S.grainRows[i].fix = e.target.value;
    }));
    modal.querySelectorAll('.kdng-grain').forEach(el => el.addEventListener('click', e => {
      const i = +e.currentTarget.dataset.i;
      if (S.grainRows[i]) {
        S.grainRows[i].grain = _grainNext(S.grainRows[i].grain);
        if (S.grainRows[i].grain !== 'EDGE') S.grainRows[i].angle = null;   // leaving EDGE drops its angle
        e.currentTarget.textContent = _grainCh(S.grainRows[i].grain);
      }
    }));
    modal.querySelectorAll('.kdng-del').forEach(el => el.addEventListener('click', e => {
      const i = +e.currentTarget.dataset.i; S.grainRows.splice(i, 1); _renderGrainModal();
    }));
    q('#kdng-add').addEventListener('click', () => {
      S.grainRows.push({ pattern: '', grain: 'ANY', thickness: '1.0', fix: '' }); _renderGrainModal();
    });
    q('#kdng-save').addEventListener('click', async () => {
      const btn = q('#kdng-save'); btn.disabled = true; btn.textContent = '💾 Saving…';
      // เอ๋ 2026-06-10 "เมื่อกด save แล้วมีผลกับอะไร ให้ effect Row นั้นๆด้วย":
      // snapshot each part's effective grain state, save, then flash the rows
      // whose grain/thickness/FIX actually changed.
      const keyOf = p => [p.grain, p.thickness,
        (p.fixHeights || []).join(','), (p.fixWidths || []).join(',')].join('|');
      const before = new Map((S.parts || []).map(p => [p, keyOf(p)]));
      try {
        await _saveGrainRows();
        const affected = new Set();
        for (const p of (S.parts || [])) if (before.get(p) !== keyOf(p)) affected.add(p.code);
        modal.remove(); _refreshView();
        _flashGrainAffected(affected);
      }
      catch (err) { alert('Save failed: ' + (err.message || err)); btn.disabled = false; btn.textContent = '💾 Save'; }
    });
    // Drag the dialog by its header (เอ๋ 2026-05-31 'ให้ผมขยับได้'). The box is
    // flex-centred; we offset it with a transform so the centring still holds.
    // dx/dy persist across pointer cycles within this render (reset on re-render).
    (function makeDraggable() {
      const box = q('.kdng-box');
      const handle = q('.kdng-head');
      if (!box || !handle) return;
      let dx = 0, dy = 0, sx = 0, sy = 0, dragging = false;
      handle.addEventListener('pointerdown', (e) => {
        dragging = true; sx = e.clientX; sy = e.clientY;
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        box.style.transform = `translate(${dx + e.clientX - sx}px, ${dy + e.clientY - sy}px)`;
      });
      const end = (e) => {
        if (!dragging) return;
        dragging = false;
        dx += e.clientX - sx; dy += e.clientY - sy;
        try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    })();
  }
  // Amber pulse on the part rows a grain-rules Save actually changed, so เอ๋
  // sees at a glance which parts the new rules touched. Runs AFTER _refreshView
  // (rows are re-rendered there).
  function _flashGrainAffected(codes) {
    if (!codes || !codes.size || !S.rootEl) return;
    S.rootEl.querySelectorAll('.kdnest-part').forEach(row => {
      if (!codes.has(row.dataset.code)) return;
      row.classList.add('kdng-affected');
      setTimeout(() => row.classList.remove('kdng-affected'), 2700);
    });
  }

  // ── grain.json → pattern map ──────────────────────────────────────
  // Mirror Python's _add_pattern_to_map / lookup_in_map structure so
  // the workshop sees the same H/V/ANY assignments on both tools.
  // -- Remnant stock (RTDB nest_remnants) ----------------------------
  // Offcuts left from earlier cuts. Admin records them here (size +
  // which project/day they came from) so leftovers get reused. User
  // 2026-05-30 wanted a 'Stock' button: view source project/date, a
  // preview of the size, manual add + delete. RTDB nest_remnants/<id>
  // = {w,h,thickness,project,date,note,createdAt}.
  async function _loadRemnants() {
    S.remnants = [];
    if (!window.firebaseDB) return;
    try {
      const snap = await window.firebaseDB.ref('nest_remnants').once('value');
      const val = snap.val() || {};
      S.remnants = Object.keys(val).map(id => Object.assign({ id: id }, val[id]))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch (e) { console.warn('[kdNest] nest_remnants read failed:', e); }
  }
  async function _saveRemnant(obj) {
    if (!window.firebaseDB) throw new Error('No database connection');
    const ref = window.firebaseDB.ref('nest_remnants').push();
    await ref.set(obj);
    return ref.key;
  }
  async function _deleteRemnant(id) {
    if (!window.firebaseDB || !id) return;
    await window.firebaseDB.ref('nest_remnants/' + id).remove();
  }
  async function _updateRemnant(id, patch) {
    if (!window.firebaseDB || !id) return;
    await window.firebaseDB.ref('nest_remnants/' + id).update(patch);
  }
  // Who may enter the ACTUAL cut size: Laser (they cut it) + admin. app.js
  // exposes the role predicates on window. (เอ๋ 2026-05-31 'ให้ Laser กรอก
  // ค่าจริงได้')
  function _canEditActual() {
    return (window.isAdmin && window.isAdmin())
        || (window.isLaserUser && window.isLaserUser());
  }
  // Grain + material chips for a remnant card so the worker can tell at a
  // glance if an offcut fits a grain-strict / material-specific job (เอ๋
  // 2026-05-31 'อยากให้ครบ'). MIXED = sheet had H+V parts -> not reusable for
  // directional. ALPF is the default material so it's not chipped (noise).
  function _grainChipFor(r) {
    const g = String((r && r.grain) || '').toUpperCase();
    if (!g || g === 'ANY') return '';
    return ' <span class="kdstock-tag kdstock-tag-grain' + (g === 'MIXED' ? ' kdstock-tag-mixed' : '') + '">' + _esc(g) + '</span>';
  }
  function _matChipFor(r) {
    const m = r && r.material ? String(r.material) : '';
    if (!m || m.toUpperCase() === 'ALPF') return '';
    return ' <span class="kdstock-tag kdstock-tag-mat">' + _esc(m) + (r.finish ? ' ' + _esc(String(r.finish)) : '') + '</span>';
  }
  // Thumbnail. For AUTO remnants (which carry sheetW/sheetH + placements +
  // offcut position) draw the actual sheet layout \u2014 cut pieces as faint grey
  // boxes, the leftover highlighted green \u2014 so the worker sees WHICH part of
  // WHICH sheet it came from (\u0e40\u0e2d\u0e4b 2026-05-31 '\u0e14\u0e39\u0e23\u0e39\u0e1b\u0e44\u0e14\u0e49\u0e27\u0e48\u0e32\u0e21\u0e32\u0e08\u0e32\u0e01\u0e41\u0e1c\u0e48\u0e19\u0e44\u0e2b\u0e19'). For
  // manual remnants (no layout) fall back to a centred rectangle. All text =
  // Flux Architect (\u0e40\u0e2d\u0e4b 2026-05-31 'font flux architect \u0e17\u0e31\u0e49\u0e07\u0e2b\u0e21\u0e14').
  function _remnantPreview(r) {
    const BW = 132, BH = 82, pad = 8;
    const FONT = '\'Flux Architect\', monospace';
    const w = +r.w || 1, h = +r.h || 1;
    const hasLayout = r.sheetW > 0 && r.sheetH > 0;
    if (hasLayout) {
      const SW = +r.sheetW, SH = +r.sheetH;
      const sc = Math.min((BW - 2 * pad) / SW, (BH - 2 * pad) / SH);
      const dw = SW * sc, dh = SH * sc;
      const ox = (BW - dw) / 2, oy = (BH - dh) / 2;
      // flip Y: nest origin is bottom-left, SVG is top-left.
      const mapY = py => oy + dh - py * sc;
      let svg = '<svg class="kdstock-prev" width="' + BW + '" height="' + BH + '" viewBox="0 0 ' + BW + ' ' + BH + '">'
        + '<rect x="0" y="0" width="' + BW + '" height="' + BH + '" fill="#0b1117"/>'
        + '<rect x="' + ox.toFixed(1) + '" y="' + oy.toFixed(1) + '" width="' + dw.toFixed(1) + '" height="' + dh.toFixed(1) + '" fill="#161d24" stroke="#3a4a55" stroke-width="1"/>';
      for (const p of (r.placements || [])) {
        const rx = ox + (+p.x) * sc, ry = mapY((+p.y) + (+p.h));
        svg += '<rect x="' + rx.toFixed(1) + '" y="' + ry.toFixed(1) + '" width="' + Math.max(1, (+p.w) * sc).toFixed(1) + '" height="' + Math.max(1, (+p.h) * sc).toFixed(1) + '" fill="#5a6675" fill-opacity="0.45" stroke="#7d8a99" stroke-width="0.4"/>';
      }
      // Leftover (green) at its real position when known, else centred.
      const lw = w * sc, lh = h * sc;
      const lx = (r.offX != null) ? ox + (+r.offX) * sc : ox + (dw - lw) / 2;
      const ly = (r.offY != null) ? mapY((+r.offY) + h) : oy + (dh - lh) / 2;
      svg += '<rect x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" width="' + Math.max(2, lw).toFixed(1) + '" height="' + Math.max(2, lh).toFixed(1) + '" fill="#4ecca344" stroke="#4ecca3" stroke-width="1.4"/>'
        + _grainHatchSvg(r.grain, lx, ly, Math.max(2, lw), Math.max(2, lh), '#9fe9cf')
        + '<text x="' + (BW / 2) + '" y="' + (BH - 3) + '" fill="#9fe9cf" font-size="9" text-anchor="middle" font-family="' + FONT + '">' + Math.round(w) + '\u00d7' + Math.round(h) + (r.sheetNo ? ' \u00b7 sheet ' + r.sheetNo : '') + '</text>'
        + '</svg>';
      return svg;
    }
    // Manual remnant \u2014 no layout, draw the offcut alone.
    const sc = Math.min((BW - 2 * pad - 8) / w, (BH - 2 * pad - 8) / h);
    const rw = Math.max(4, w * sc), rh = Math.max(4, h * sc);
    const x = (BW - rw) / 2, y = (BH - rh) / 2;
    return '<svg class="kdstock-prev" width="' + BW + '" height="' + BH + '" viewBox="0 0 ' + BW + ' ' + BH + '">'
      + '<rect x="0" y="0" width="' + BW + '" height="' + BH + '" fill="#0b1117"/>'
      + '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + rw.toFixed(1) + '" height="' + rh.toFixed(1) + '" fill="#4ecca322" stroke="#4ecca3" stroke-width="1.5"/>'
      + _grainHatchSvg(r.grain, x, y, rw, rh, '#9fe9cf')
      + '<text x="' + (BW / 2) + '" y="' + (BH / 2) + '" fill="#cfe7ee" font-size="11" text-anchor="middle" dominant-baseline="middle" font-family="' + FONT + '">' + Math.round(w) + '\u00d7' + Math.round(h) + '</text>'
      + '</svg>';
  }
  function _openStockModal() {
    _loadRemnants().then(_renderStockModal).catch(e => alert('Stock load failed: ' + (e.message || e)));
  }
  function _renderStockModal() {
    document.querySelectorAll('.kdstock-modal').forEach(m => m.remove());
    const admin = (typeof window.isAdmin === 'function' && window.isAdmin());
    const canEditActual = _canEditActual();
    // Per-remnant include/exclude (เอ๋ 2026-06-11 "ให้เลือกได้ด้วยว่าจะใช้เศษตัวไหน
    // บ้าง"). S.remnantsOff = Set of EXCLUDED remnant ids; default = all included.
    // The "Use remnants in next run" checkbox is the MASTER — when OFF, the
    // per-remnant boxes are moot (disabled). Session-only (chosen before a Run).
    const _remOff = (S.remnantsOff = S.remnantsOff || new Set());
    const _masterOff = !!S.skipRemnants;
    const list = (S.remnants || []).map(function (r) {
      // The size we USE = actual (measured after cutting) when present, else
      // the calculated leftover. Both shown so the worker sees what was
      // expected vs what's really there. (\u0e40\u0e2d\u0e4b 2026-05-31 '\u0e19\u0e33\u0e04\u0e48\u0e32\u0e08\u0e23\u0e34\u0e07\u0e21\u0e32\u0e43\u0e0a\u0e49 \u0e41\u0e15\u0e48
      // \u0e22\u0e31\u0e07\u0e04\u0e07\u0e21\u0e35\u0e04\u0e48\u0e32\u0e40\u0e14\u0e34\u0e21\u0e42\u0e0a\u0e27\u0e4c\u0e2d\u0e22\u0e39\u0e48')
      const hasActual = (r.actualW != null && r.actualH != null);
      const usedW = hasActual ? +r.actualW : (+r.w || 0);
      const usedH = hasActual ? +r.actualH : (+r.h || 0);
      const dims = Math.round(usedW) + '\u00d7' + Math.round(usedH)
        + (r.thickness ? ' \u00b7 ' + _esc(String(r.thickness)) + 'mm' : '')
        + (hasActual ? ' <span class="kdstock-tag">actual</span>' : '')
        + _grainChipFor(r) + _matChipFor(r);
      const calcLine = hasActual
        ? '<div class="kdstock-calc">calc ' + Math.round(+r.w || 0) + '\u00d7' + Math.round(+r.h || 0) + '</div>'
        : '';
      const prov = [r.project ? _esc(r.project) : '', r.date ? _esc(r.date) : ''].filter(Boolean).join(' \u00b7 ');
      // Actual-size editor \u2014 Laser measures the real offcut after cutting and
      // types it here; placeholders show the calculated value.
      const editor = canEditActual
        ? '<div class="kdstock-actual">'
          + '<span class="kdstock-actual-lab">Actual</span>'
          + '<input class="kdstock-aw" type="number" min="0" placeholder="' + Math.round(+r.w || 0) + '" value="' + (r.actualW != null ? Math.round(+r.actualW) : '') + '">'
          + '<span>\u00d7</span>'
          + '<input class="kdstock-ah" type="number" min="0" placeholder="' + Math.round(+r.h || 0) + '" value="' + (r.actualH != null ? Math.round(+r.actualH) : '') + '">'
          + '<button class="kdstock-actual-save" data-id="' + _esc(r.id) + '" title="Save actual cut size">\u2713</button>'
          + (hasActual ? '<button class="kdstock-actual-clear" data-id="' + _esc(r.id) + '" title="Clear actual \u2014 revert to calculated">\u21ba</button>' : '')
          + '</div>'
        : '';
      const _off = _remOff.has(r.id);
      return '<div class="kdstock-card' + (_off ? ' kdstock-card-off' : '') + '" data-id="' + _esc(r.id) + '">'
        + '<input type="checkbox" class="kdstock-use-cb" data-id="' + _esc(r.id) + '"'
          + (_off ? '' : ' checked') + (_masterOff ? ' disabled' : '')
          + ' title="' + (_masterOff ? 'Enable “Use remnants” below first' : (_off ? 'Excluded from the next run — click to include' : 'Included in the next run — click to exclude')) + '">'
        + _remnantPreview(r)
        + '<div class="kdstock-info">'
        + '<div class="kdstock-dims">' + dims + '</div>'
        + calcLine
        + '<div class="kdstock-prov">' + (prov || '\u2014') + '</div>'
        + (r.note ? '<div class="kdstock-note">' + _esc(r.note) + '</div>' : '')
        + editor
        + '</div>'
        + (admin ? '<button class="kdstock-del" data-id="' + _esc(r.id) + '" title="Delete remnant">\ud83d\uddd1</button>' : '')
        + '</div>';
    }).join('');
    const addForm = admin ? (
      '<div class="kdstock-add">'
      + '<input id="kdstock-w" type="number" min="0" placeholder="W"><span>\u00d7</span>'
      + '<input id="kdstock-h" type="number" min="0" placeholder="H">'
      + '<input id="kdstock-th" type="number" min="0" step="0.1" value="1" title="thickness mm">'
      + '<input id="kdstock-proj" type="text" placeholder="Project" value="' + _esc(S.projectName || '') + '">'
      + '<input id="kdstock-note" type="text" placeholder="Note (optional)">'
      + '<button id="kdstock-add-btn" class="kdnest-btn kdnest-btn-run">+ Add</button>'
      + '</div>') : '';
    const modal = document.createElement('div');
    modal.className = 'kdstock-modal';
    modal.innerHTML = '<div class="kdstock-backdrop"></div>'
      + '<div class="kdstock-box">'
      + '<div class="kdstock-head">\ud83d\udce6 Remnants Stock'
      + '<span class="kdstock-sub">' + (S.remnants || []).length + ' offcuts \u00b7 shared</span></div>'
      + '<div class="kdstock-list">' + (list || '<div class="kdstock-empty">No remnants yet' + (admin ? ' \u2014 add one below' : '') + '</div>') + '</div>'
      + addForm
      + '<div class="kdstock-foot">'
      // Moved here from the sidebar (เอ๋ 2026-06-10 'skip Remnants ให้มาอยู่ที่
      // Remnants stock — คลิกคือใช้งาน'): ticked = the packer USES this pool
      // in the next run (S.skipRemnants = !checked; default stays fresh-first).
      + (((S.remnants || []).length && !S.skipRemnants)
          ? '<button id="kdstock-all" class="kdnest-mini" title="Include every remnant">All</button>'
            + '<button id="kdstock-none" class="kdnest-mini" title="Exclude every remnant">None</button>' : '')
      + '<label class="kdstock-use-lab" title="Ticked = the next Run uses the TICKED saved offcuts before fresh sheets">'
      + '<input id="kdstock-use" type="checkbox"' + (S.skipRemnants ? '' : ' checked') + '> Use remnants in next run</label>'
      + '<span class="kdng-spacer"></span><button id="kdstock-close" class="kdnest-btn">Close</button></div>'
      + '</div>';
    document.body.appendChild(modal);
    const q = sel => modal.querySelector(sel);
    const close = () => modal.remove();
    q('.kdstock-backdrop').addEventListener('click', close);
    q('#kdstock-close').addEventListener('click', close);
    q('#kdstock-use')?.addEventListener('change', function (e) {
      S.skipRemnants = !e.target.checked;   // click = use (เอ๋ 2026-06-10)
      _renderStockModal();   // master toggled → re-render so per-remnant boxes + All/None enable/disable
    });
    // Per-remnant include/exclude — tick = include, untick = exclude from the
    // next run (เอ๋ 2026-06-11). Adjusts S.remnantsOff; re-renders to repaint the
    // dimmed/struck card.
    modal.querySelectorAll('.kdstock-use-cb').forEach(function (el) {
      el.addEventListener('change', function () {
        const id = el.dataset.id;
        S.remnantsOff = S.remnantsOff || new Set();
        if (el.checked) S.remnantsOff.delete(id); else S.remnantsOff.add(id);
        _renderStockModal();
      });
    });
    q('#kdstock-all')?.addEventListener('click', function () {
      S.remnantsOff = new Set();   // include all
      _renderStockModal();
    });
    q('#kdstock-none')?.addEventListener('click', function () {
      S.remnantsOff = new Set((S.remnants || []).map(function (r) { return r.id; }));   // exclude all
      _renderStockModal();
    });
    // Drag the modal by its header so it can be moved off the nest layout to
    // compare (เอ๋ 2026-05-31 'ให้จับย้ายได้'). First drag switches the box from
    // flex-centred to absolute-positioned; clamped to the viewport.
    (function _makeDraggable() {
      const box = q('.kdstock-box');
      const handle = q('.kdstock-head');
      if (!box || !handle) return;
      handle.style.cursor = 'move';
      let drag = null;
      handle.addEventListener('pointerdown', function (e) {
        const r = box.getBoundingClientRect();
        box.style.position = 'absolute';
        box.style.margin = '0';
        box.style.left = r.left + 'px';
        box.style.top = r.top + 'px';
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      handle.addEventListener('pointermove', function (e) {
        if (!drag) return;
        const bw = box.offsetWidth, bh = box.offsetHeight;
        let nx = Math.max(0, Math.min(e.clientX - drag.dx, window.innerWidth - bw));
        let ny = Math.max(0, Math.min(e.clientY - drag.dy, window.innerHeight - bh));
        box.style.left = nx + 'px';
        box.style.top = ny + 'px';
      });
      const end = function (e) { drag = null; try { handle.releasePointerCapture(e.pointerId); } catch (_) {} };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    })();
    modal.querySelectorAll('.kdstock-del').forEach(function (el) {
      el.addEventListener('click', async function () {
        const id = el.dataset.id;
        if (!confirm('Delete this remnant from stock?')) return;
        try { await _deleteRemnant(id); await _loadRemnants(); _renderStockModal(); }
        catch (e) { alert('Delete failed: ' + (e.message || e)); }
      });
    });
    // Save the actual cut size the Laser worker measured. Blank = treat as
    // unset (revert to calc). Persists to RTDB so every view sees it.
    modal.querySelectorAll('.kdstock-actual-save').forEach(function (el) {
      el.addEventListener('click', async function () {
        const card = el.closest('.kdstock-card');
        const aw = parseFloat(card.querySelector('.kdstock-aw').value);
        const ah = parseFloat(card.querySelector('.kdstock-ah').value);
        const patch = (aw > 0 && ah > 0)
          ? { actualW: Math.round(aw), actualH: Math.round(ah), actualAt: Date.now() }
          : { actualW: null, actualH: null, actualAt: null };
        el.disabled = true;
        try { await _updateRemnant(el.dataset.id, patch); await _loadRemnants(); _renderStockModal(); }
        catch (e) { alert('Save failed: ' + (e.message || e)); el.disabled = false; }
      });
    });
    modal.querySelectorAll('.kdstock-actual-clear').forEach(function (el) {
      el.addEventListener('click', async function () {
        el.disabled = true;
        try { await _updateRemnant(el.dataset.id, { actualW: null, actualH: null, actualAt: null }); await _loadRemnants(); _renderStockModal(); }
        catch (e) { alert('Clear failed: ' + (e.message || e)); el.disabled = false; }
      });
    });
    const addBtn = q('#kdstock-add-btn');
    if (addBtn) addBtn.addEventListener('click', async function () {
      const w = parseFloat(q('#kdstock-w').value), h = parseFloat(q('#kdstock-h').value);
      if (!(w > 0) || !(h > 0)) { alert('Enter W and H (mm).'); return; }
      const obj = {
        w: w, h: h,
        thickness: parseFloat(q('#kdstock-th').value) || 1,
        project: (q('#kdstock-proj').value || '').trim(),
        note: (q('#kdstock-note').value || '').trim(),
        date: new Date().toISOString().slice(0, 10),
        createdAt: Date.now(),
      };
      addBtn.disabled = true; addBtn.textContent = 'Saving...';
      try { await _saveRemnant(obj); await _loadRemnants(); _renderStockModal(); }
      catch (e) { alert('Save failed: ' + (e.message || e)); addBtn.disabled = false; addBtn.textContent = '+ Add'; }
    });
  }

  function _buildPatternMap(rows) {
    // Unified rule list. Every pattern compiles to a test fn + a SPECIFICITY
    // (count of literal chars): the most-specific matching rule wins, so
    // เอ๋'s DSV___-___80 (6 literals: DSV + - + 80) beats DSV2* (4) on
    // DSV2L3-050080. Among prefix rules this equals the old longest-prefix-
    // wins. Kind rank breaks literal-count ties (anchored > prefix > suffix
    // > substring).
    // Pattern language (เอ๋ 2026-06-10 'ขึ้นต้นด้วย DSV และลงท้ายด้วย 80'):
    //   X*       prefix        *X  suffix        *X*  substring
    //   XX       exactly-two-chars placeholder (legacy grain.xlsx)
    //   _ runs   "anything here" (same as *), anchored both ends —
    //            DSV___-___80 = starts with DSV AND ends with 80.
    const m = { exact: {}, rules: [] };
    const KIND_RANK = { glob: 0, xx: 0, prefix: 1, suffix: 2, substring: 3 };
    for (const row of rows) {
      const pattern = String(row.pattern || '').trim();
      if (!pattern) continue;
      // FLIP180 / MIRROR rows are per-part ORIENTATION flags, not grain
      // directions — they stack alongside the real grain rule for a code and
      // are read separately (_readPartFlip180/_readPartMirror). Excluding them
      // here keeps an exact-code FLIP180 row from shadowing the same code's
      // H/V/ANY/EDGE grain rule in m.exact. (Rotate-180 + Mirror 2026-06-26)
      const _g = String(row.grain || '').toUpperCase();
      if (_g === 'FLIP180' || _g === 'MIRROR') continue;
      const value = { grain: String(row.grain || 'H').toUpperCase(), thickness: row.thickness || '', fix: row.fix || '',
                      angle: (row.angle == null || row.angle === '') ? null : Number(row.angle) };
      const starts = pattern.startsWith('*');
      const ends = pattern.endsWith('*');
      const inner = pattern.slice(starts ? 1 : 0, ends ? -1 : undefined);
      if (pattern.includes('_') || inner.includes('*')) {
        // Glob — `_` runs and inner `*` mean "anything"; anchored both ends.
        const lit = pattern.replace(/[*_]/g, '');
        const re = new RegExp(
          '^' + pattern.split(/[*_]+/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
          'i'
        );
        m.rules.push({ kind: 'glob', lit: lit.length, test: n => re.test(n), value });
      } else if (starts && ends && pattern.length > 2) {
        const sub = pattern.replace(/^\*+|\*+$/g, '').replace(/-+$/, '').toLowerCase();
        if (sub) m.rules.push({ kind: 'substring', lit: sub.length, test: n => n.toLowerCase().indexOf(sub) >= 0, value });
      } else if (starts) {
        const suf = pattern.replace(/^\*+/, '').replace(/-+$/, '').toLowerCase();
        if (suf) m.rules.push({ kind: 'suffix', lit: suf.length, test: n => n.toLowerCase().endsWith(suf), value });
      } else if (ends) {
        const pre = pattern.replace(/\*+$/, '').replace(/-+$/, '').toLowerCase();
        if (pre) m.rules.push({ kind: 'prefix', lit: pre.length, test: n => n.toLowerCase().startsWith(pre), value });
      } else if (/XX/.test(pattern)) {
        const re = new RegExp(
          '^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/XX/g, '..') + '(\\s|$|-|_)',
          'i'
        );
        m.rules.push({ kind: 'xx', lit: pattern.replace(/XX/g, '').length, test: n => re.test(n), value });
      } else {
        m.exact[pattern] = value;
        const clean = pattern.replace(/\s+v\d+$/, '');
        if (clean !== pattern) m.exact[clean] = value;
      }
    }
    // Most literal chars first; kind rank breaks ties.
    m.rules.sort((a, b) => (b.lit - a.lit) || (KIND_RANK[a.kind] - KIND_RANK[b.kind]));
    return m;
  }

  function _lookupPattern(name, m) {
    if (!m || !name) return null;
    if (m.exact[name]) return m.exact[name];
    for (const r of m.rules) if (r.test(name)) return r.value;
    return null;
  }

  // ════════════════════════════════════════════════════════════════════
  //  Packers (JS ports of the Python implementations)
  // ════════════════════════════════════════════════════════════════════

  // Defensive cap for the multi-sheet `while (remaining.length)` packer loops.
  // Each pass either places ≥1 piece (remaining shrinks) or breaks on
  // !placedAny, so a healthy run needs ≤ pieces.length passes. The cap is a
  // safety net: if a future change (or a NaN/degenerate piece dimension) ever
  // lets a pass report progress without shrinking `remaining`, the loop bails
  // out and dumps the leftovers to `unplaced` instead of freezing the UI.
  // Every input either nests or lands in `unplaced` — never an infinite loop.
  // (angled-grain hardening 2026-06-25)
  function _packLoopCap(pieceCount) {
    return Math.max(1000, (Number(pieceCount) || 0) * 4 + 1000);
  }

  // MaxRects with Best Short Side Fit. Tracks every free rectangle on
  // the sheet — captures internal gaps that Skyline misses.
  class MaxRectsPacker {
    constructor(W, H) {
      this.W = W; this.H = H;
      this.free = [{ x: 0, y: 0, w: W, h: H }];
    }
    bestFit(w, h) {
      // Pure scoring — does NOT mutate free_rects. Returns
      // {x, y, short, long} or null. Used by the caller to compare
      // rotations BEFORE committing to a placement.
      let best = null;
      for (const r of this.free) {
        if (r.w >= w && r.h >= h) {
          const lx = r.w - w, ly = r.h - h;
          const shortV = Math.min(lx, ly), longV = Math.max(lx, ly);
          if (best === null
              || shortV < best.short
              || (shortV === best.short && longV < best.long)) {
            best = { x: r.x, y: r.y, short: shortV, long: longV };
          }
        }
      }
      return best;
    }
    commit(x, y, w, h) {
      this._split(x, y, w, h);
      return [x, y];
    }
    place(w, h) {
      const b = this.bestFit(w, h);
      if (!b) return null;
      return this.commit(b.x, b.y, w, h);
    }
    _split(x, y, w, h) {
      const next = [];
      for (const r of this.free) {
        if (x >= r.x + r.w || x + w <= r.x ||
            y >= r.y + r.h || y + h <= r.y) {
          next.push(r);
          continue;
        }
        if (x > r.x) next.push({ x: r.x, y: r.y, w: x - r.x, h: r.h });
        if (x + w < r.x + r.w)
          next.push({ x: x + w, y: r.y, w: r.x + r.w - (x + w), h: r.h });
        if (y > r.y) next.push({ x: r.x, y: r.y, w: r.w, h: y - r.y });
        if (y + h < r.y + r.h)
          next.push({ x: r.x, y: y + h, w: r.w, h: r.y + r.h - (y + h) });
      }
      // Prune: drop free rects fully contained in another.
      const kept = [];
      for (let i = 0; i < next.length; i++) {
        const a = next[i];
        if (a.w <= 0 || a.h <= 0) continue;
        let contained = false;
        for (let j = 0; j < next.length; j++) {
          if (i === j) continue;
          const b = next[j];
          if (b.w <= 0 || b.h <= 0) continue;
          if (a.x >= b.x && a.y >= b.y &&
              a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h) {
            contained = true; break;
          }
        }
        if (!contained) kept.push(a);
      }
      this.free = kept;
    }
  }

  // Skyline packer with BL Corner / Left / Bottom strategies.
  // Less code than Python because we always run "bottom" semantics
  // here — Left mode rotates internally and reuses the same logic.
  class SkylinePacker {
    constructor(W, H, mode) {
      this.W = W; this.H = H; this.mode = mode || 'BL Corner';
      // Skyline = list of horizontal segments. Each = {x, y, w}.
      this.skyline = [{ x: 0, y: 0, w: W }];
    }
    place(w, h) {
      // Find lowest-Y segment span that fits the rect.
      let best = null;
      for (let i = 0; i < this.skyline.length; i++) {
        let maxY = this.skyline[i].y, accum = 0, j = i;
        while (accum < w && j < this.skyline.length) {
          if (this.skyline[j].y > maxY) maxY = this.skyline[j].y;
          accum += this.skyline[j].w;
          j++;
        }
        if (accum < w) continue;
        if (maxY + h > this.H) continue;
        const x = this.skyline[i].x;
        if (best === null
            || maxY < best.y
            || (maxY === best.y &&
                (this.mode === 'BL Corner' ? x < best.x : maxY < best.y))) {
          best = { x: x, y: maxY, i: i };
        }
      }
      if (!best) return null;
      this._update(best.i, best.x, best.y, w, h);
      return [best.x, best.y];
    }
    _update(idx, x, y, w, h) {
      const newSeg = { x: x, y: y + h, w: w };
      const next = [];
      for (let i = 0; i < this.skyline.length; i++) {
        if (i < idx) { next.push(this.skyline[i]); continue; }
        const s = this.skyline[i];
        if (s.x + s.w <= x) { next.push(s); continue; }
        if (s.x >= x + w)   { next.push(s); continue; }
        // Trim left part
        if (s.x < x) next.push({ x: s.x, y: s.y, w: x - s.x });
        // (newSeg added once below)
        // Trim right part
        if (s.x + s.w > x + w)
          next.push({ x: x + w, y: s.y, w: s.x + s.w - (x + w) });
      }
      // Insert newSeg in sorted x position.
      next.push(newSeg);
      next.sort((a, b) => a.x - b.x);
      // Merge adjacent same-y segments.
      const merged = [];
      for (const s of next) {
        const last = merged[merged.length - 1];
        if (last && last.y === s.y && last.x + last.w === s.x) {
          last.w += s.w;
        } else {
          merged.push({ ...s });
        }
      }
      this.skyline = merged;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  True-shape (raster) nesting
  // ════════════════════════════════════════════════════════════════════
  // The rectangle packers above reserve each part's BOUNDING BOX. For
  // triangles + L/notched parts that wastes ~half the box, so small parts
  // can't tuck into a neighbour's empty corner (user 2026-05-30 'เอาชิ้น
  // เล็กๆเข้ามาแทรกอยู่ภายในได้อีก' → chose True-shape). This packer
  // rasterises each part's REAL outer polygon into a grid bitmap and
  // places it bottom-left by testing the actual silhouette for overlap —
  // so two triangles interlock, a strip slides into a diagonal gap, etc.
  //
  // CRITICAL: the rasterisation uses the SAME rotation transform as the
  // renderer (_drawSheet) so what the packer reserves is exactly what
  // gets drawn + exported. Placement (x,y) = footprint bottom-left in
  // sheet mm (y-up), identical to the rectangle packers' output.

  // Build the occupancy mask for one piece at one rotation. Returns
  // {mw, mh, solid, spans} where solid is the rasterised silhouette and
  // spans[row] = [[c0,c1), …] contiguous solid runs (fast collision test).
  function _rasterMask(piece, rot, R) {
    const bMinX = piece.bbox ? piece.bbox[0] : 0;
    const bMinY = piece.bbox ? piece.bbox[1] : 0;
    const pw = piece.w, ph = piece.h;
    const fw = (rot === 90 || rot === 270) ? ph : pw;   // footprint dims
    const fh = (rot === 90 || rot === 270) ? pw : ph;
    const mw = Math.max(1, Math.ceil(fw / R));
    const mh = Math.max(1, Math.ceil(fh / R));
    const solid = new Uint8Array(mw * mh);
    // Same mapping the renderer's transform() applies (local → footprint).
    function mapPt(px, py) {
      const u = px - bMinX, v = py - bMinY;
      if (rot === 90)  return [-v + ph, u];
      if (rot === 180) return [pw - u, ph - v];
      if (rot === 270) return [v, pw - u];
      return [u, v];
    }
    const outer = (piece.polys && piece.polys.outer && piece.polys.outer.length > 2)
      ? piece.polys.outer : null;
    if (outer) {
      const pts = outer.map(p => mapPt(p[0], p[1]));
      // CONSERVATIVE rasterisation: a cell is solid if the polygon covers ANY
      // part of it — not just its centre. A single centre-Y sample per row
      // UNDER-approximates diagonal edges (a triangle's hypotenuse leaves edge
      // cells uncovered), so a neighbour packs into that gap and the true shapes
      // OVERLAP. Sampling each row at its TOP, CENTRE and BOTTOM edge and
      // unioning the x-spans makes the mask always >= the true shape → no
      // overlap. x-fill is already conservative (floor/ceil). (เอ๋ 2026-06-26
      // 'nesting ชิ้นนี้ผิด ซ้อนกัน' — DSV1TR triangle overlapped a neighbour)
      const scanRow = (Y, gy) => {
        const xs = [];
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          if ((a[1] <= Y && b[1] > Y) || (b[1] <= Y && a[1] > Y)) {
            xs.push(a[0] + (Y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
          }
        }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const c0 = Math.max(0, Math.floor(xs[k] / R));
          const c1 = Math.min(mw, Math.ceil(xs[k + 1] / R));
          for (let c = c0; c < c1; c++) solid[gy * mw + c] = 1;
        }
      };
      for (let gy = 0; gy < mh; gy++) {
        scanRow(gy * R + 1e-6, gy);          // row top edge
        scanRow((gy + 0.5) * R, gy);         // row centre
        scanRow((gy + 1) * R - 1e-6, gy);    // row bottom edge
      }
      // EDGE SUPERCOVER: mark every cell each polygon edge passes through
      // (Amanatides–Woo grid traversal). Closes the sub-cell coverage gaps the
      // row-scan leaves on diagonal/curved outlines (e.g. DSV1TR's 254-pt arc) so
      // the mask stays strictly >= the true shape → the grid collision still
      // GUARANTEES no overlap — but WITHOUT inflating the part by a whole cell.
      // The old 1-cell dilation (f7944f2) closed the same gaps, but its ~R halo
      // also sealed shut the true-shape VOIDS a neighbour should nest into (เอ๋
      // 'true shape ต้องเติมในกรอบแดง' 2026-06-26: the triangle offcut stopped
      // filling). Edge cells only = voids stay open AND still no overlap. Verified
      // headless: notch-fill restored, 0 conservativeness violations, tight
      // interlock of 12 curved triangles = 0 overlaps. Rectangles unaffected
      // (their boundary cells are already interior-filled).
      const _mark = (c, r) => { if (c >= 0 && c < mw && r >= 0 && r < mh) solid[r * mw + c] = 1; };
      const _markSeg = (x0, y0, x1, y1) => {
        let cx = Math.floor(x0 / R), cy = Math.floor(y0 / R);
        const ex = Math.floor(x1 / R), ey = Math.floor(y1 / R);
        const dx = x1 - x0, dy = y1 - y0;
        const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
        const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
        const tDeltaX = dx !== 0 ? Math.abs(R / dx) : Infinity;
        const tDeltaY = dy !== 0 ? Math.abs(R / dy) : Infinity;
        const nextBX = stepX > 0 ? (cx + 1) * R : cx * R;
        const nextBY = stepY > 0 ? (cy + 1) * R : cy * R;
        let tMaxX = dx !== 0 ? Math.abs((nextBX - x0) / dx) : Infinity;
        let tMaxY = dy !== 0 ? Math.abs((nextBY - y0) / dy) : Infinity;
        _mark(cx, cy);
        let guard = mw + mh + 4;
        while ((cx !== ex || cy !== ey) && guard-- > 0) {
          if (tMaxX < tMaxY) { tMaxX += tDeltaX; cx += stepX; }
          else { tMaxY += tDeltaY; cy += stepY; }
          _mark(cx, cy);
        }
      };
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        _markSeg(a[0], a[1], b[0], b[1]);
      }
    }
    // Degenerate / no-polygon (manual rect) → fill the whole footprint.
    let any = false;
    for (let i = 0; i < solid.length; i++) { if (solid[i]) { any = true; break; } }
    if (!any) solid.fill(1);
    // Contiguous spans per row.
    const spans = [];
    for (let y = 0; y < mh; y++) {
      const row = []; let c = 0;
      while (c < mw) {
        if (solid[y * mw + c]) { const s = c; while (c < mw && solid[y * mw + c]) c++; row.push([s, c]); }
        else c++;
      }
      spans.push(row);
    }
    return { mw, mh, solid, spans };
  }

  // Bottom-left first-fit on the occupancy grid. Scans rows from the
  // bottom; within a row advances x, skipping past the blocking column.
  function _blFind(occ, gw, gh, mask) {
    const { mw, mh, spans } = mask;
    if (mw > gw || mh > gh) return null;
    for (let gy = 0; gy <= gh - mh; gy++) {
      let gx = 0;
      while (gx <= gw - mw) {
        let hit = -1;
        for (let r = 0; r < mh && hit < 0; r++) {
          const base = (gy + r) * gw + gx, rowSpans = spans[r];
          for (let si = 0; si < rowSpans.length; si++) {
            const s0 = rowSpans[si][0], s1 = rowSpans[si][1];
            for (let c = s0; c < s1; c++) { if (occ[base + c]) { hit = gx + c; break; } }
            if (hit >= 0) break;
          }
        }
        if (hit < 0) return { gx, gy };
        gx = hit + 1;   // safe forward progress past the blocker
      }
    }
    return null;
  }

  // Stamp a placed part's silhouette + a gap halo into the occupancy grid.
  function _stamp(occ, gw, gh, mask, gx, gy, dCells) {
    const { mw, mh, solid } = mask;
    for (let r = 0; r < mh; r++) {
      for (let c = 0; c < mw; c++) {
        if (!solid[r * mw + c]) continue;
        for (let dy = -dCells; dy <= dCells; dy++) {
          const sy = gy + r + dy; if (sy < 0 || sy >= gh) continue;
          const base = sy * gw;
          for (let dx = -dCells; dx <= dCells; dx++) {
            const sx = gx + c + dx; if (sx < 0 || sx >= gw) continue;
            occ[base + sx] = 1;
          }
        }
      }
    }
  }

  function _nestMultiSheetRaster(pieces, stock, gap, rOverride) {
    // Resolution: coarse ~1/200 (min 5mm) by default — fast, used by the main pack +
    // the cost-optimize trials. The fine-final TIGHTEN post-pass (_tightenSheets) passes
    // a small rOverride per sheet (~3mm) so the ~6mm coarse-grid gaps tighten WITHOUT
    // the optimizer paying for a fine grid. Finer = tighter but quadratically slower.
    const minSide = Math.min.apply(null, stock.map(s => Math.min(s.w, s.h)).concat([1525]));
    const R = (rOverride && rOverride > 0) ? rOverride : Math.max(5, Math.round(minSide / 200));
    const dCells = gap > 0 ? Math.max(1, Math.round(gap / R)) : 0;
    // Sort by TRUE polygon area desc (big shapes anchor first).
    function trueArea(p) {
      const o = p.polys && p.polys.outer;
      if (!o || o.length < 3) return p.w * p.h;
      let a = 0;
      for (let i = 0; i < o.length; i++) { const j = (i + 1) % o.length; a += o[i][0] * o[j][1] - o[j][0] * o[i][1]; }
      return Math.abs(a) / 2 || p.w * p.h;
    }
    const sorted = pieces.slice().sort((a, b) => trueArea(b) - trueArea(a));
    // Mask cache — identical code+rot+dims share a rasterisation.
    const maskCache = new Map();
    function getMask(piece, rot) {
      const key = piece.code + '|' + rot + '|' + Math.round(piece.w) + 'x' + Math.round(piece.h);
      let m = maskCache.get(key);
      if (!m) { m = _rasterMask(piece, rot, R); maskCache.set(key, m); }
      return m;
    }
    const stockCopy = stock.map(s => ({ ...s }));
    const sheets = [];
    let remaining = sorted.slice();
    let _loopGuard = _packLoopCap(remaining.length);
    while (remaining.length) {
      if (--_loopGuard < 0) { console.warn('[kdNest] raster pack loop cap hit — dumping', remaining.length, 'to unplaced'); break; }
      let placedAny = false;
      for (let si = 0; si < stockCopy.length; si++) {
        const s = stockCopy[si];
        if (s.qty === 0) continue;
        // FLOOR, not ceil: a ceil grid is up to R-1mm WIDER/taller than the real
        // sheet, so BL packs parts into that phantom overhang strip → their true
        // outline sticks out 4-5mm past the cut edge = un-cuttable (เอ๋ 2026-06-26
        // 'บาง part เกินออกมา', verified: FN3BLA +4mm right, SD0SUP +5mm top). floor
        // keeps every cell fully inside the sheet. Costs ≤R-1mm of usable W/H (~0.2%).
        const gw = Math.floor(s.w / R), gh = Math.floor(s.h / R);
        const occ = new Uint8Array(gw * gh);
        const placed = [], stillLeft = [];
        for (const piece of remaining) {
          let best = null;
          for (const rot of piece.rots) {
            // flip180 = the part is cut 180° from natural. BAKE it into the packed
            // orientation so the mask we reserve == the shape we cut. The old
            // post-pack +180 (below) reserved the UN-flipped slot then flipped the
            // shape inside its bbox → for non-rect parts (e.g. DSV1TR triangle) the
            // shape moved to the opposite corner and OVERLAPPED interlocked
            // neighbours. (เอ๋ 2026-06-26 'ชิ้นงานยังซ้อนทับกันอยู่' — root cause)
            const placeRot = piece.flip180 ? (((rot + 180) % 360) + 360) % 360 : rot;
            const mask = getMask(piece, placeRot);
            const pos = _blFind(occ, gw, gh, mask);
            if (pos && (best === null || pos.gy < best.gy ||
                        (pos.gy === best.gy && pos.gx < best.gx))) {
              best = { rot: placeRot, mask, gx: pos.gx, gy: pos.gy };
            }
          }
          if (best) {
            _stamp(occ, gw, gh, best.mask, best.gx, best.gy, dCells);
            placed.push({ ...piece, x: best.gx * R, y: best.gy * R, rot: best.rot, _flipBaked: true });
          } else {
            stillLeft.push(piece);
          }
        }
        if (placed.length) {
          sheets.push({ sw: s.w, sh: s.h, placements: placed });
          if (s.qty > 0) s.qty -= 1;
          remaining = stillLeft;
          placedAny = true;
          break;
        }
      }
      if (!placedAny) break;
    }
    return { sheets, unplaced: remaining };
  }

  // Largest all-zero (empty) axis-aligned rectangle in a binary occupancy grid.
  // Standard "maximal rectangle in a binary matrix": per row, treat consecutive
  // empty cells upward as histogram bar heights, then largest-rectangle-in-
  // histogram via a monotonic stack. O(gw*gh). Returns the biggest empty rect in
  // CELLS: { gx, gy, w, h, area }. Used to score how big a reusable rectangular
  // offcut a layout leaves. (2026-05-30 Max Remnant mode)
  function _largestEmptyRect(occ, gw, gh) {
    const heights = new Int32Array(gw);
    let best = { gx: 0, gy: 0, w: 0, h: 0, area: 0 };
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        heights[x] = occ[y * gw + x] ? 0 : heights[x] + 1;
      }
      const stack = [];   // {x, h} with strictly increasing h
      for (let x = 0; x <= gw; x++) {
        const h = x < gw ? heights[x] : 0;
        let start = x;
        while (stack.length && stack[stack.length - 1].h >= h) {
          const top = stack.pop();
          const area = top.h * (x - top.x);
          if (area > best.area) {
            best = { gx: top.x, gy: y - top.h + 1, w: x - top.x, h: top.h, area };
          }
          start = top.x;
        }
        stack.push({ x: start, h });
      }
    }
    return best;
  }

  // A part is a gap-fill candidate iff it can rotate freely (grain ANY → 4 rots)
  // and is small relative to the sheet. Tunable. (2026-05-30 Max Remnant)
  const HYBRID_FILL_AREA_FRAC = 0.08;

  // "Max Remnant": pick the layout that leaves the largest reusable rectangular
  // offcut. Generates candidates (the 4 rectangle packers + a gap-filled variant
  // that tucks small ANY parts into interior gaps), scores each by its largest
  // empty rectangle (true-shape grid), and returns the best by
  // (fewest unplaced, fewest sheets, largest remnant). Reuses _rasterMask /
  // _blFind / _stamp / _largestEmptyRect — no new collision code. (2026-05-30)
  function _nestMultiSheetMaxRemnant(pieces, stock, gap) {
    // NOTE: user-selected mode — unlike Auto's raster (gated at <=150 pieces),
    // there is no piece-count guard here; very large BOMs will be slower.
    const minSide = Math.min.apply(null, stock.map(s => Math.min(s.w, s.h)).concat([1525]));
    const R = Math.max(5, Math.round(minSide / 200));
    const dCells = gap > 0 ? Math.max(1, Math.round(gap / R)) : 0;
    const maskCache = new Map();
    function maskOf(p, rot) {
      const key = p.code + '|' + rot + '|' + Math.round(p.w) + 'x' + Math.round(p.h);
      let m = maskCache.get(key);
      if (!m) { m = _rasterMask(p, rot, R); maskCache.set(key, m); }
      return m;
    }
    const bboxArea = p => (p.w || 0) * (p.h || 0);

    function trueOcc(sheet) {
      const gw = Math.floor(sheet.sw / R), gh = Math.floor(sheet.sh / R);   // floor: keep cells inside the sheet (no overhang) — see _nestMultiSheetRaster
      const occ = new Uint8Array(gw * gh);
      for (const pl of sheet.placements) {
        _stamp(occ, gw, gh, maskOf(pl, pl.rot), Math.round(pl.x / R), Math.round(pl.y / R), dCells);
      }
      return { occ, gw, gh };
    }

    function remnantArea(candidate) {
      let best = 0;
      for (const sheet of candidate.sheets) {
        const { occ, gw, gh } = trueOcc(sheet);
        const r = _largestEmptyRect(occ, gw, gh);
        const mm = r.area * R * R;
        if (mm > best) best = mm;
      }
      return best;
    }

    function gapFill(candidate) {
      const sheets = candidate.sheets.map(s => ({ ...s, placements: s.placements.slice() }));
      for (const sheet of sheets) {
        const gw = Math.floor(sheet.sw / R), gh = Math.floor(sheet.sh / R);   // floor: keep cells inside the sheet (no overhang) — see _nestMultiSheetRaster
        const occ = new Uint8Array(gw * gh);
        const fillCap = HYBRID_FILL_AREA_FRAC * sheet.sw * sheet.sh;
        const isFill = pl => Array.isArray(pl.rots) && pl.rots.length === 4 && bboxArea(pl) <= fillCap;
        const big = sheet.placements.filter(pl => !isFill(pl));
        const fill = sheet.placements.filter(isFill).sort((a, b) => bboxArea(b) - bboxArea(a));
        for (const pl of big) _stamp(occ, gw, gh, maskOf(pl, pl.rot), Math.round(pl.x / R), Math.round(pl.y / R), dCells);
        const out = big.slice();
        for (const f of fill) {
          let pick = null;
          for (const rot of f.rots) {
            const m = maskOf(f, rot);
            const pos = _blFind(occ, gw, gh, m);
            if (pos && (pick === null || pos.gy < pick.gy || (pos.gy === pick.gy && pos.gx < pick.gx))) {
              pick = { rot, m, gx: pos.gx, gy: pos.gy };
            }
          }
          if (pick) {
            _stamp(occ, gw, gh, pick.m, pick.gx, pick.gy, dCells);
            out.push({ ...f, x: pick.gx * R, y: pick.gy * R, rot: pick.rot });
          } else {
            _stamp(occ, gw, gh, maskOf(f, f.rot), Math.round(f.x / R), Math.round(f.y / R), dCells);
            out.push(f);
          }
        }
        sheet.placements = out;
      }
      return { sheets, unplaced: candidate.unplaced };
    }

    const rectCands = ['MaxRects', 'Bottom', 'BL Corner', 'Left'].map(m => _nestMultiSheet(pieces, stock, gap, m));
    let bestRect = null;
    for (const c of rectCands) {
      if (bestRect === null || c.unplaced.length < bestRect.unplaced.length
          || (c.unplaced.length === bestRect.unplaced.length && c.sheets.length < bestRect.sheets.length)) {
        bestRect = c;
      }
    }
    const candidates = rectCands.slice();
    // gapFill is seeded only from bestRect (the sheet-minimising rect layout),
    // not from every candidate — a deliberate perf/quality tradeoff.
    if (bestRect) candidates.push(gapFill(bestRect));

    let winner = null, ws = null;
    for (const c of candidates) {
      const s = { unplaced: c.unplaced.length, sheets: c.sheets.length, remnant: remnantArea(c) };
      if (winner === null
          || s.unplaced < ws.unplaced
          || (s.unplaced === ws.unplaced && s.sheets < ws.sheets)
          || (s.unplaced === ws.unplaced && s.sheets === ws.sheets && s.remnant > ws.remnant)) {
        winner = c; ws = s;
      }
    }
    return winner || { sheets: [], unplaced: pieces.slice() };
  }

  // ── Driver: pack onto multiple sheet sizes ─────────────────────────
  // "Desktop" — a faithful mirror of the desktop NestingTool's Auto
  // (nest_gui.py nest_pieces_multi_sheet / _nest_multi_with_mode): the 4
  // rectangle packers with FIRST-FIT rotation (take the first allowed rotation
  // that fits — like desktop's `for rot in rots: place(); break`), pick fewest
  // unplaced then fewest sheets. NO true-shape. เอ๋ ran every mode and found the
  // desktop layout best (2026-05-30), so this reproduces it exactly. Additive —
  // Auto and every other mode untouched. Both MaxRectsPacker and SkylinePacker
  // expose place(w,h) → [x,y]|null (BSSF position), matching desktop's place().
  function _nestMultiSheetDesktop(pieces, stock, gap) {
    function runFirstFit(mode) {
      const useMax = (mode === 'MaxRects');
      const sorted = pieces.slice().sort((a, b) =>
        mode === 'Left' ? Math.max(b.w, b.h) - Math.max(a.w, a.h)
                        : (b.w * b.h) - (a.w * a.h));
      const stockCopy = stock.map(s => ({ ...s }));
      const sheets = [];
      let remaining = sorted.slice();
      let _loopGuard = _packLoopCap(remaining.length);
      while (remaining.length) {
        if (--_loopGuard < 0) { console.warn('[kdNest] desktop pack loop cap hit — dumping', remaining.length, 'to unplaced'); break; }
        let placedAny = false;
        for (let si = 0; si < stockCopy.length; si++) {
          const s = stockCopy[si];
          if (s.qty === 0) continue;
          const packer = useMax ? new MaxRectsPacker(s.w, s.h) : new SkylinePacker(s.w, s.h, mode);
          const placed = [], stillLeft = [];
          for (const piece of remaining) {
            let wasPlaced = false;
            for (const rot of piece.rots) {
              const rw = (rot === 90 || rot === 270) ? piece.h + gap : piece.w + gap;
              const rh = (rot === 90 || rot === 270) ? piece.w + gap : piece.h + gap;
              const pos = packer.place(rw, rh);   // first rotation that fits wins
              if (pos) { placed.push({ ...piece, x: pos[0], y: pos[1], rot }); wasPlaced = true; break; }
            }
            if (!wasPlaced) stillLeft.push(piece);
          }
          if (placed.length) {
            sheets.push({ sw: s.w, sh: s.h, placements: placed });
            if (s.qty > 0) s.qty -= 1;
            remaining = stillLeft;
            placedAny = true;
            break;
          }
        }
        if (!placedAny) break;
      }
      return { sheets, unplaced: remaining };
    }
    let best = null;
    for (const m of ['MaxRects', 'BL Corner', 'Left', 'Bottom']) {
      const r = _tuckSmallPieces(runFirstFit(m), gap);
      if (best === null || r.unplaced.length < best.unplaced.length
          || (r.unplaced.length === best.unplaced.length && r.sheets.length < best.sheets.length)) {
        best = r;
      }
    }
    // Winner only: band-consolidate the LONG parts, then RE-tuck the smalls so
    // they chain onto the moved rows (a small left where its anchor used to be
    // would float). Same sheets/unplaced — the vote above stays valid.
    if (best) best = _tuckSmallPieces(_consolidateBands(best, gap), gap);
    return best || { sheets: [], unplaced: pieces.slice() };
  }

  // ── PHASE B: band consolidation for LONG parts (RD 03 board daeef18 — เอ๋
  // 1CSVB2-105003 arrows: slide TS1BHH-105000 + BM1LCL-105003 right into the
  // empty strip ABOVE the TS1BHH-095000 row; "ถ้าทำแบบนี้ก็จะประหยัดพื้นที่เพิ่มขึ้น
  // ไปอีก"). เอ๋'s arrows RELAX the bigs-frozen rule: a non-small part may
  // RELOCATE by pure TRANSLATION (rotation kept → grain/FIX locks untouched)
  // DOWN into the free strip on top of an existing row, when the move makes the
  // sheet's largest clean free rect strictly grow. Moves are evaluated as a
  // BAND BATCH, not one-by-one — moving just ONE of เอ๋'s two strips makes the
  // remnant temporarily WORSE (the band rect gets cut before the stack fully
  // empties), so single-move greedy deadlocks; filling the band then comparing
  // once matches her arrows. Worse batch → rolled back, so a sheet can never
  // degrade. Runs once on the winning desktop layout.
  function _consolidateBands(result, gap) {
    const rotDims = (p, rot) => (rot === 90 || rot === 270)
      ? [p.h + gap, p.w + gap] : [p.w + gap, p.h + gap];
    const isSmall = p => Math.max(p.w || 0, p.h || 0) <= SMALL_TUCK_MM;
    const freeListFor = (sheet) => {
      const pk = new MaxRectsPacker(sheet.sw, sheet.sh);
      for (const pl of sheet.placements) {
        const [rw, rh] = rotDims(pl, pl.rot);
        pk._split(pl.x, pl.y, rw, rh);
      }
      return pk.free;
    };
    const maxFreeArea = list => list.reduce((m, r) => Math.max(m, r.w * r.h), 0);
    const EPS = 1000;            // mm² — a batch must beat float noise to stick
    for (const sheet of (result.sheets || [])) {
      if (!sheet.placements || sheet.placements.length < 2) continue;
      let guard = 10;            // accepted-batch cap per sheet
      let progressing = true;
      while (progressing && guard-- > 0) {
        progressing = false;
        const free = freeListFor(sheet);
        const before = maxFreeArea(free);
        // Candidate bands: free rects sitting directly ON TOP of >= 1 placement
        // (the strip above an existing row). rowH = tallest supporting part.
        const bands = [];
        for (const fr of free) {
          if (fr.y <= 0) continue;
          let rowH = 0;
          for (const pl of sheet.placements) {
            const [pw, ph] = rotDims(pl, pl.rot);
            const overlapX = pl.x < fr.x + fr.w && fr.x < pl.x + pw;
            if (overlapX && Math.abs((pl.y + ph) - fr.y) <= 1) rowH = Math.max(rowH, ph);
          }
          if (rowH > 0) bands.push({ fr, rowH });
        }
        bands.sort((a, b) => a.fr.y - b.fr.y);   // lowest band first
        for (const { fr, rowH } of bands) {
          // Candidates: non-small parts from HIGHER up whose height fits the
          // founding row (เอ๋ "ชิ้นที่สูงพอดี band เดิม") — deliberately NOT
          // limited by this band rect's CURRENT width: on เอ๋'s real 1CSVB2
          // sheet the stacked TS1BHH-105000 OVERHANGS the neighbour below and
          // truncates its own target band, so the as-is band only fits one
          // strip and the batch never wins. LIFT-THEN-FILL instead: take the
          // candidates out, rebuild the free space (their old spots open up →
          // the band widens to its true extent), then fill left→right.
          const cands = sheet.placements
            .map((pl, i) => ({ pl, i, d: rotDims(pl, pl.rot) }))
            .filter(c => !isSmall(c.pl) && c.pl.y > fr.y + 1 && c.d[1] <= rowH + 2)
            .sort((a, b) => (b.d[1] - a.d[1]) || (b.d[0] - a.d[0]));
          if (!cands.length) continue;
          // Free space WITHOUT the candidates → the band's true (widest) extent
          // at this row.
          const liftSet = new Set(cands.map(c => c.i));
          const pkLift = new MaxRectsPacker(sheet.sw, sheet.sh);
          sheet.placements.forEach((pl, i) => {
            if (liftSet.has(i)) return;
            const [rw, rh] = rotDims(pl, pl.rot);
            pkLift._split(pl.x, pl.y, rw, rh);
          });
          let band2 = null;
          for (const r2 of pkLift.free) {
            if (Math.abs(r2.y - fr.y) <= 1 && (!band2 || r2.w > band2.w)) band2 = r2;
          }
          if (!band2) continue;
          let cursor = band2.x;
          const movedIdx = [], movedOld = [];
          for (const c of cands) {
            if (c.d[1] > band2.h + 0.001) continue;
            if (cursor + c.d[0] > band2.x + band2.w + 0.001) continue;
            // live overlap check: a SKIPPED candidate still sits at its old
            // spot, which can intrude into the lifted band — never place onto it.
            const nx = cursor, ny = band2.y, nw = c.d[0], nh = c.d[1];
            let clash = false;
            for (let i = 0; i < sheet.placements.length && !clash; i++) {
              if (i === c.i) continue;
              const pl = sheet.placements[i];
              const [pw, ph] = rotDims(pl, pl.rot);
              if (nx < pl.x + pw && pl.x < nx + nw && ny < pl.y + ph && pl.y < ny + nh) clash = true;
            }
            if (clash) continue;
            movedIdx.push(c.i); movedOld.push(sheet.placements[c.i]);
            sheet.placements[c.i] = { ...c.pl, x: nx, y: ny };
            cursor += nw;
          }
          if (!movedIdx.length) continue;
          const after = maxFreeArea(freeListFor(sheet));
          if (after > before + EPS) { progressing = true; break; }   // keep batch, rescan
          for (let k = 0; k < movedIdx.length; k++) sheet.placements[movedIdx[k]] = movedOld[k];   // rollback
        }
      }
    }
    return result;
  }

  // ── Desktop gap-tuck (เอ๋ 2026-06-10, cut-sheet screenshot with red boxes on
  // BXXTR0/TS2TRX/SD0SUP): "เอาชิ้นเล็กๆ พวกนี้เข้าไปด้านในได้ หรือจะ Rotate
  // ด้วยก็ได้เพื่อจัดให้เต็มพื้นที่". The desktop-mirror pass strands small parts
  // on edge strips (skyline modes can't reach interior gaps; first-fit rotation
  // wastes snug spots). This post-pass keeps every BIG placement exactly where
  // the desktop layout put it, lifts the SMALL ones (max side ≤ SMALL_TUCK_MM),
  // rebuilds each sheet's remaining free space (MaxRects split keeps ALL maximal
  // empty rects, so a lifted part's own footprint stays available — placed parts
  // can't be lost), then re-places each small with BSSF across its OWN allowed
  // rotations (grain/FIX locks respected — piece.rots). Earlier sheets are tried
  // first, so smalls migrate off late sheets (an emptied sheet is dropped) and
  // previously-unplaced smalls get a second chance at the gaps. Safety: if the
  // tucked result somehow places fewer pieces, the original layout is returned.
  const SMALL_TUCK_MM = 300;
  function _tuckSmallPieces(orig, gap) {
    const origSheets = orig.sheets || [];
    if (!origSheets.length) return orig;
    const isSmall = p => Math.max(p.w || 0, p.h || 0) <= SMALL_TUCK_MM
                      && (p.w || 0) > 0 && (p.h || 0) > 0;
    const rotDims = (p, rot) => (rot === 90 || rot === 270)
      ? [p.h + gap, p.w + gap] : [p.w + gap, p.h + gap];
    const result = {
      sheets: origSheets.map(s => ({ ...s, placements: s.placements.slice() })),
      unplaced: (orig.unplaced || []).slice(),
    };
    const queue = [];
    const packers = result.sheets.map(sh => {
      const pk = new MaxRectsPacker(sh.sw, sh.sh);
      const keep = [];
      for (const pl of sh.placements) {
        if (isSmall(pl)) { queue.push(pl); continue; }
        const [rw, rh] = rotDims(pl, pl.rot);
        pk._split(pl.x, pl.y, rw, rh);
        keep.push(pl);
      }
      sh.placements = keep;
      return pk;
    });
    if (!queue.length) return orig;
    const stillUnplaced = [];
    for (const up of result.unplaced) {
      if (isSmall(up)) queue.push(up); else stillUnplaced.push(up);
    }
    queue.sort((a, b) => (b.w * b.h) - (a.w * a.h));   // big smalls first
    // Spot choice v3 = REMNANT CONSOLIDATION (เอ๋ "ทำไมไม่เอาไปไว้ตรงนี้ จะได้มี
    // ที่เหลือเยอะๆ" — v2's BAF + bottom-left split the open area; the cluster
    // landed in the bottom-right corner instead of against the placed parts).
    // History: v1 BSSF recreated the open-edge strips ("เหมือนเดิม"); v2 BAF
    // fixed that but anchored low. v3 scores every candidate spot (each free
    // rect × allowed rotation × its 4 corners) by the LARGEST FREE RECTANGLE
    // REMAINING after a simulated split — the one-big-clean-remnant objective,
    // stated directly. Ties → smaller source pocket (BAF: snug notches first),
    // then higher y / higher x (y-up: against the packed cluster, away from
    // the open corner).
    const simMaxFree = (freeList, x, y, w, h) => {
      let maxA = 0;
      for (const r of freeList) {
        if (x >= r.x + r.w || x + w <= r.x || y >= r.y + r.h || y + h <= r.y) {
          const a = r.w * r.h;
          if (a > maxA) maxA = a;
          continue;
        }
        if (x > r.x) { const a = (x - r.x) * r.h; if (a > maxA) maxA = a; }
        if (x + w < r.x + r.w) { const a = (r.x + r.w - (x + w)) * r.h; if (a > maxA) maxA = a; }
        if (y > r.y) { const a = r.w * (y - r.y); if (a > maxA) maxA = a; }
        if (y + h < r.y + r.h) { const a = r.w * (r.y + r.h - (y + h)); if (a > maxA) maxA = a; }
      }
      return maxA;
    };
    // ADJACENCY tier (เอ๋'s arrow = "against the placed parts"): a candidate that
    // touches an existing placement (within gap+1mm) is always preferred over a
    // free-floating one — kills the open-edge strips for good (a strip spot far
    // from everything can only win when NOTHING adjacent fits, which keeps the
    // never-lose-a-part guarantee). Smalls chain off each other, so the cluster
    // grows from the packed mass outward.
    const touches = (si, x, y, w, h) => {
      const pad = gap + 1;
      for (const pl of result.sheets[si].placements) {
        const [pw, ph] = rotDims(pl, pl.rot);
        if (x < pl.x + pw + pad && pl.x < x + w + pad &&
            y < pl.y + ph + pad && pl.y < y + h + pad) return true;
      }
      return false;
    };
    const lost = [];
    for (const piece of queue) {
      let pick = null;
      for (let si = 0; si < result.sheets.length && !pick; si++) {
        const free = packers[si].free;
        let best = null;
        for (const rot of (piece.rots && piece.rots.length ? piece.rots : [0])) {
          const [rw, rh] = rotDims(piece, rot);
          for (const fr of free) {
            if (fr.w < rw || fr.h < rh) continue;
            const pocket = fr.w * fr.h;
            const corners = [
              [fr.x, fr.y],
              [fr.x + fr.w - rw, fr.y],
              [fr.x, fr.y + fr.h - rh],
              [fr.x + fr.w - rw, fr.y + fr.h - rh],
            ];
            for (const [cx, cy] of corners) {
              const adj = touches(si, cx, cy, rw, rh) ? 1 : 0;
              const rem = simMaxFree(free, cx, cy, rw, rh);
              if (!best
                  || adj > best.adj
                  || (adj === best.adj && rem > best.rem)
                  || (adj === best.adj && rem === best.rem && pocket < best.pocket)
                  || (adj === best.adj && rem === best.rem && pocket === best.pocket
                      && (cy > best.y || (cy === best.y && cx > best.x)))) {
                best = { adj, rem, pocket, x: cx, y: cy, rot, rw, rh };
              }
            }
          }
        }
        if (best) pick = { si, ...best };
      }
      if (pick) {
        packers[pick.si].commit(pick.x, pick.y, pick.rw, pick.rh);
        result.sheets[pick.si].placements.push({ ...piece, x: pick.x, y: pick.y, rot: pick.rot });
      } else {
        lost.push(piece);
      }
    }
    result.sheets = result.sheets.filter(sh => sh.placements.length);
    result.unplaced = stillUnplaced.concat(lost);
    // Never worse than the untucked desktop layout.
    if (result.unplaced.length > (orig.unplaced || []).length) return orig;
    return result;
  }

  // True-polygon overlap check on a packed result (sheet mm) — same transform as
  // the renderer _drawSheet / DXF export. Fail-safe for True Shape: its raster
  // collision can leave two parts overlapping (root cause in the raster pack,
  // not the mask — proven 2026-06-26: masks cover their shapes yet clash). If an
  // overlap is detected we fall back to the Desktop (bbox) layout, which can
  // never overlap → no overlapping cut ever reaches the laser. bbox pre-filter
  // keeps it fast (only truly bbox-overlapping pairs get the edge test).
  // (เอ๋ 'ชิ้นงานยังซ้อนทับกันอยู่' — DSV1TR triangle.)
  function _resultHasTrueOverlap(result) {
    if (!result || !result.sheets) return false;
    function placedPoly(pl) {
      const bx = pl.bbox ? pl.bbox[0] : 0, by = pl.bbox ? pl.bbox[1] : 0, pw = pl.w, ph = pl.h, rot = pl.rot;
      const o = pl.polys && pl.polys.outer; if (!o || o.length < 3) return null;
      return o.map(function (p) { const u = p[0] - bx, v = p[1] - by; let X, Y;
        if (rot === 90) { X = -v + ph; Y = u; } else if (rot === 180) { X = pw - u; Y = ph - v; }
        else if (rot === 270) { X = v; Y = pw - u; } else { X = u; Y = v; }
        return [X + pl.x, Y + pl.y]; });
    }
    function bb(poly) { let a = 1e15, b = 1e15, c = -1e15, d = -1e15; for (const p of poly) { if (p[0] < a) a = p[0]; if (p[1] < b) b = p[1]; if (p[0] > c) c = p[0]; if (p[1] > d) d = p[1]; } return [a, b, c, d]; }
    function ori(a, b, c) { const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); return v > 1e-6 ? 1 : v < -1e-6 ? -1 : 0; }
    function segX(p1, p2, p3, p4) { const d1 = ori(p3, p4, p1), d2 = ori(p3, p4, p2), d3 = ori(p1, p2, p3), d4 = ori(p1, p2, p4); return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)); }
    // A crossing alone is NOT a real collision: the ~R-cell raster lets two true
    // outlines touch with a hair of penetration, and at Gap 0 (common-line) parts
    // are MEANT to touch. Only penetration deeper than OVERLAP_TOL_MM is genuine and
    // worth bailing to Desktop for. Measured 04 Ruth Gap 0: 6 pairs, max 0.43mm of
    // sub-cell touching — the old any-crossing test flagged it and demoted the
    // void-filled True Shape layout to Desktop (เอ๋ 'true shape ต้องเติมในกรอบแดง'
    // 2026-06-26). Real packing-bug overlaps (e.g. the flip180 corner-swap) are cm-scale.
    const OVERLAP_TOL_MM = 1.5;
    function _inPoly(x, y, poly) { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) ins = !ins; } return ins; }
    // Deepest vertex penetration (mm) between two placed polygons — a vertex of one
    // poly sitting inside the other, measured to the other's nearest edge.
    function _maxPenMm(PA, PB) { let pen = 0; const probe = (P, Q) => { for (const vtx of P) { if (!_inPoly(vtx[0], vtx[1], Q)) continue; let m = 1e15; for (let i = 0, j = Q.length - 1; i < Q.length; j = i++) { const x1 = Q[j][0], y1 = Q[j][1], x2 = Q[i][0], y2 = Q[i][1]; const dx = x2 - x1, dy = y2 - y1; const L2 = dx * dx + dy * dy || 1e-9; let t = ((vtx[0] - x1) * dx + (vtx[1] - y1) * dy) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t; const px = x1 + t * dx, py = y1 + t * dy; const d = Math.hypot(vtx[0] - px, vtx[1] - py); if (d < m) m = d; } if (m > pen) pen = m; } }; probe(PA, PB); probe(PB, PA); return pen; }
    for (const sh of result.sheets) {
      const ps = (sh.placements || []).map(function (pl) { const poly = placedPoly(pl); return poly ? { poly: poly, box: bb(poly) } : null; }).filter(Boolean);
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        const A = ps[i], B = ps[j];
        if (A.box[2] <= B.box[0] || B.box[2] <= A.box[0] || A.box[3] <= B.box[1] || B.box[3] <= A.box[1]) continue;   // bbox disjoint/touching → skip
        let cross = false;
        for (let a = 0; a < A.poly.length && !cross; a++) { const a1 = A.poly[a], a2 = A.poly[(a + 1) % A.poly.length];
          for (let b = 0; b < B.poly.length; b++) { const b1 = B.poly[b], b2 = B.poly[(b + 1) % B.poly.length];
            if (segX(a1, a2, b1, b2)) { cross = true; break; } } }
        if (cross && _maxPenMm(A.poly, B.poly) > OVERLAP_TOL_MM) return true;   // genuine collision only
      }
    }
    return false;
  }

  function _nestMultiSheet(pieces, stock, gap, mode) {
    // pieces: [{code, w, h, rots:[0,90,...], qty}]
    // stock: [{w, h, qty}]   qty=-1 → unlimited
    // Returns: {sheets: [{sw, sh, placements:[{...}]}], unplaced: [...]}

    if (mode === 'True Shape') {
      const r = _nestMultiSheetRaster(pieces, stock, gap);
      if (_resultHasTrueOverlap(r)) {
        console.warn('[kdNest] True Shape produced overlapping parts — falling back to the Desktop layout (overlap-free).');
        return _nestMultiSheetDesktop(pieces, stock, gap);
      }
      return r;
    }
    if (mode === 'Max Remnant') return _nestMultiSheetMaxRemnant(pieces, stock, gap);
    if (mode === 'Desktop') return _nestMultiSheetDesktop(pieces, stock, gap);

    function makePacker(sw, sh, m) {
      return m === 'MaxRects' ? new MaxRectsPacker(sw, sh)
                              : new SkylinePacker(sw, sh, m);
    }

    function runOne(modeStr) {
      const use_maxrects = (modeStr === 'MaxRects');
      const sorted = pieces.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h));
      const stockCopy = stock.map(s => ({ ...s }));
      const sheets = [];
      let remaining = sorted.slice();
      let _loopGuard = _packLoopCap(remaining.length);
      while (remaining.length) {
        if (--_loopGuard < 0) { console.warn('[kdNest] pack loop cap hit — dumping', remaining.length, 'to unplaced'); break; }
        let placedAny = false;
        for (let si = 0; si < stockCopy.length; si++) {
          const s = stockCopy[si];
          if (s.qty === 0) continue;
          const packer = makePacker(s.w, s.h, modeStr);
          const placed = [];
          const stillLeft = [];
          for (const piece of remaining) {
            // Evaluate EVERY allowed rotation, keep the one whose
            // best-free-rect leftover short side is smallest (BSSF).
            // The previous code broke on the first rotation that fit,
            // which often picked an awful position when a 90° rotate
            // would have nested into a snug gap — that's a big part
            // of why the layout looked 'มั่วหนัก' (user 2026-05-28).
            // MaxRectsPacker has bestFit() that scores without
            // mutating; Skyline still falls through to single-rot try.
            if (use_maxrects) {
              let best = null;
              for (const rot of piece.rots) {
                const rw = (rot === 90 || rot === 270) ? piece.h + gap : piece.w + gap;
                const rh = (rot === 90 || rot === 270) ? piece.w + gap : piece.h + gap;
                const fit = packer.bestFit(rw, rh);
                if (!fit) continue;
                if (best === null
                    || fit.short < best.fit.short
                    || (fit.short === best.fit.short && fit.long < best.fit.long)) {
                  best = { rot, rw, rh, fit };
                }
              }
              if (best) {
                const [x, y] = packer.commit(best.fit.x, best.fit.y, best.rw, best.rh);
                placed.push({ ...piece, x, y, rot: best.rot });
              } else {
                stillLeft.push(piece);
              }
              continue;
            }
            // Skyline path — simpler, place() is destructive so we
            // still break on first fit.
            let wasPlaced = false;
            for (const rot of piece.rots) {
              const rw = (rot === 90 || rot === 270) ? piece.h + gap : piece.w + gap;
              const rh = (rot === 90 || rot === 270) ? piece.w + gap : piece.h + gap;
              const pos = packer.place(rw, rh);
              if (pos) {
                placed.push({ ...piece, x: pos[0], y: pos[1], rot });
                wasPlaced = true;
                break;
              }
            }
            if (!wasPlaced) stillLeft.push(piece);
          }
          if (placed.length) {
            sheets.push({ sw: s.w, sh: s.h, placements: placed });
            if (s.qty > 0) s.qty -= 1;
            remaining = stillLeft;
            placedAny = true;
            break;
          }
        }
        if (!placedAny) break;
      }
      return { sheets, unplaced: remaining };
    }

    if (mode === 'Auto') {
      let best = null;
      // True-shape FIRST so it wins ties (denser interior, cleaner remnant).
      // Skipped on very large BOMs where the raster scan would be slow.
      const runners = [];
      // Rectangle packers FIRST (desktop-style; leftover stays a clean
      // rectangle the user can reuse). True-shape LAST -> only wins when it
      // strictly saves a sheet. (user 2026-05-30 'เหลือพื้นที่ว่างให้เป็น
      // สี่เหลี่ยม เหมือน Nest บน Desktop')
      for (const m of ['MaxRects', 'Bottom', 'BL Corner', 'Left']) runners.push(() => runOne(m));
      if (pieces.length <= 150) runners.push(() => _nestMultiSheetRaster(pieces, stock, gap));
      for (const run of runners) {
        const r = run();
        if (best === null
            || r.unplaced.length < best.unplaced.length
            || (r.unplaced.length === best.unplaced.length
                && r.sheets.length < best.sheets.length)) {
          best = r;
        }
      }
      return best || { sheets: [], unplaced: pieces.slice() };
    }
    return runOne(mode);
  }

  // ── Last-sheet rectangular remnant (เอ๋ 2026-06-11) ───────────────────────
  // Re-pack ONLY the last fresh-stock sheet through the edge-biased packers and
  // keep whichever layout (incl. the original) leaves the largest empty
  // rectangle, so the leftover is one clean usable offcut. Stashes the winning
  // rectangle on sheet.lastRemnantRect ({x,y,w,h} mm) when it's ≥300mm both
  // sides; auto-jumps the view to that sheet. No-op when the toggle is off.
  // Default leftover direction when BOTH variants are usable (เอ๋ 2026-06-12):
  // honour the remembered pick if it's still valid, otherwise recommend the
  // bigger-area rectangle. Pure (no closures) so it is node-unit-tested.
  // variants = { h:{rect:{w,h,area}}|null, v:{...}|null }; remembered 'h'|'v'|null.
  function _pickDefaultRectDir(variants, remembered) {
    const h = variants && variants.h, v = variants && variants.v;
    if (!h && !v) return null;
    if (h && !v) return 'h';
    if (v && !h) return 'v';
    if (remembered === 'h' || remembered === 'v') return remembered;
    const ah = (h.rect.area != null) ? h.rect.area : h.rect.w * h.rect.h;
    const av = (v.rect.area != null) ? v.rect.area : v.rect.w * v.rect.h;
    return av > ah ? 'v' : 'h';   // tie -> 'h'
  }
  // Persist the sheet-stock table so a reload keeps เอ๋'s sizes/qty/order
  // (เอ๋ 2026-06-12 — qty was silently resetting to the 1/1/1 defaults).
  function _persistStock() {
    try { localStorage.setItem('kd_nest_stock_v1', JSON.stringify(S.sheetStock)); } catch (e) {}
  }
  // ── Sheet price (THB/sheet) defaults by physical size (เอ๋ 2026-06-26) ──
  // Material + 550 cutting fee. Dimensions are the reliable signal; label is a
  // fallback. Function declaration → hoisted, so the sheetStock state-init IIFE
  // (top of S) can call it. Custom / unknown → 0 (user types the price).
  function _getPriceDefault(w, h, label) {
    if ((w === 3050 && h === 1525) || (w === 1525 && h === 3050)) return 3850;  // 10x5
    if ((w === 3050 && h === 1220) || (w === 1220 && h === 3050)) return 2750;  // 10x4
    if ((w === 2440 && h === 1220) || (w === 1220 && h === 2440)) return 2350;  // 8x4
    const l = String(label || '').toLowerCase();
    if (l.includes('10x5')) return 3850;
    if (l.includes('10x4')) return 2750;
    if (l.includes('8x4'))  return 2350;
    return 0;  // custom — no clobber, user owns it
  }
  // Apply a size default only when prc is unset/0 — NEVER overwrite a price the
  // user typed. Called when a row's w/h changes (in case it now matches a known
  // size and still has no price).
  function _applyPriceDefault(row) {
    if (!row.prc) row.prc = _getPriceDefault(row.w, row.h, row.label);
  }
  // Count FRESH FULL sheets the last nest used, grouped by stock size. Reused
  // offcuts (fromRemnant !== null) are EXCLUDED — เอ๋: cost = new sheets only,
  // never scraps. The last-sheet rectified remnant stays fromRemnant === null
  // (it isolates a leftover WITHIN a fresh sheet) so it counts normally.
  function _countFreshSheetsBySize() {
    const sizeMap = new Map();   // 'WxH' → {w, h, count, prc, label}
    for (const sheet of (S.flatSheets || [])) {
      if (sheet.fromRemnant !== null && sheet.fromRemnant !== undefined) continue;
      const w = Math.round(sheet.sw), h = Math.round(sheet.sh);
      const key = `${w}x${h}`;
      if (!sizeMap.has(key)) {
        const stock = S.sheetStock.find(s => Math.round(s.w) === w && Math.round(s.h) === h);
        const prc = (stock && stock.prc) || _getPriceDefault(w, h, (stock && stock.label) || '');
        sizeMap.set(key, { w, h, count: 0, prc, label: (stock && stock.label) || '' });
      }
      sizeMap.get(key).count += 1;
    }
    return sizeMap;
  }
  // Build the cost-summary HTML: "(3850 × 2) + (2350 × 1) = 10,050 THB".
  // Empty string when there's no nest result (so it simply doesn't render).
  function _renderCostSummary() {
    if (!(S.flatSheets && S.flatSheets.length)) return '';
    const sizeMap = _countFreshSheetsBySize();
    if (!sizeMap.size) return '';
    let total = 0;
    const lines = [];
    for (const e of sizeMap.values()) {
      total += e.prc * e.count;
      lines.push(`(${e.prc.toLocaleString('en-US')} × ${e.count})`);
    }
    const badge = S.optChosen
      ? '<span class="kdnest-cost-badge" title="Run auto-picked the cheapest enabled sheet-size mix by price">Auto-chosen</span>'
      : '';
    // STALE: stock changed after this result → the number is from the OLD run.
    // Dim the box + add a hint so the worker knows to re-run (เอ๋ 2026-06-26 'กด
    // ปิด sheet แล้ว cost ไม่เปลี่ยน' — it just wasn't recomputed yet). Same box,
    // no layout jump; cleared on the next run via S.costStale=false in _runNesting.
    const stale = !!S.costStale;
    const staleCls = stale ? ' kdnest-cost-stale' : '';
    const hint = stale
      ? '<span class="kdnest-cost-hint">press Run to update</span>'
      : '';
    return `
          <div class="kdnest-cost-summary${staleCls}"${stale ? ' title="Sheet stock changed — press Run to recompute the cost"' : ''}>
            <span class="kdnest-cost-label">Total Cost${badge}</span>
            <span class="kdnest-cost-breakdown">${lines.join(' + ')} = <span class="kdnest-cost-total">${total.toLocaleString('en-US')} THB</span></span>${hint}
          </div>`;
  }
  const _REMNANT_MIN_LAST = 300;   // mm — last-sheet rectangle must be this big to keep
  // Fine-final TIGHTEN (True Shape only): the cost-optimizer + main pack run on the
  // coarse ~6mm grid (fast), which leaves ~6-9mm gaps between parts. This post-pass
  // re-packs each sheet's OWN parts on a fine ~3mm raster grid — a few parts per
  // sheet, so it's cheap (runs ONCE on the final layout, not in the optimizer's
  // repeated trials). Gaps tighten to ~3-4mm while True Shape's void-fill is preserved
  // (still the raster packer, just finer). NEVER-WORSE: any sheet whose fine re-pack
  // drops a part or self-overlaps keeps its original placements untouched.
  // (เอ๋ 2026-06-26 'gap แน่นขึ้น + เร็วปกติ' — coarse-optimize / fine-final.)
  function _tightenSheets(gap) {
    if (S.mode !== 'True Shape') return;
    const sheets = S.flatSheets || [];
    if (!sheets.length) return;
    // _rectifyLastSheet (runs after) rect-repacks the last FRESH sheet when Rect
    // leftover is on — tightening it here would just be overwritten, so skip it.
    let skipIdx = -1;
    if (S.rectLeftover) { for (let i = sheets.length - 1; i >= 0; i--) { if (!sheets[i].fromRemnant) { skipIdx = i; break; } } }
    for (let si = 0; si < sheets.length; si++) {
      if (si === skipIdx) continue;
      const sheet = sheets[si];
      if (!sheet.placements || sheet.placements.length < 2) continue;
      const pieces = sheet.placements.map(pl => ({
        code: pl.code, w: pl.w, h: pl.h,
        rots: Array.isArray(pl.rots) ? pl.rots.slice() : [0, 90, 180, 270],
        polys: pl.polys, bbox: pl.bbox, thickness: pl.thickness, grain: pl.grain,
        flip180: pl.flip180,
      }));
      const minSide = Math.min(sheet.sw, sheet.sh);
      const fineR = Math.max(3, Math.round(minSide / 450));   // ~3mm for kitchen sheets
      let r;
      try { r = _nestMultiSheetRaster(pieces.map(p => ({ ...p })), [{ w: sheet.sw, h: sheet.sh, qty: 1 }], gap, fineR); }
      catch (e) { continue; }
      const out = r && r.sheets && r.sheets[0];
      if (!out || (r.unplaced && r.unplaced.length) || r.sheets.length !== 1) continue;
      if (out.placements.length !== sheet.placements.length) continue;
      if (_resultHasTrueOverlap({ sheets: [{ sw: sheet.sw, sh: sheet.sh, placements: out.placements }] })) continue;
      sheet.placements = out.placements;   // tightened — never-worse verified
    }
  }

  function _rectifyLastSheet() {
    S._rectPendingIdx = -1;            // reset each run (chooser hook reads this)
    if (!S.rectLeftover) return;
    const sheets = S.flatSheets || [];
    // last FRESH-stock sheet (offcut-derived sheets aren't re-rectified)
    let li = -1;
    for (let i = sheets.length - 1; i >= 0; i--) { if (!sheets[i].fromRemnant) { li = i; break; } }
    if (li < 0) return;
    const sheet = sheets[li];
    if (!sheet.placements || !sheet.placements.length) return;
    const origPlacements = sheet.placements;   // floor — never make the result worse

    // Reconstruct pieces from the placements (strip x/y/rot; keep rots so grain
    // gating is preserved through the re-pack).
    const pieces = sheet.placements.map(pl => ({
      code: pl.code, w: pl.w, h: pl.h,
      rots: Array.isArray(pl.rots) ? pl.rots.slice() : [0, 90, 180, 270],
      polys: pl.polys, bbox: pl.bbox, thickness: pl.thickness, grain: pl.grain,
    }));
    const stock = [{ w: sheet.sw, h: sheet.sh, qty: 1, thickness: sheet.thick }];

    // Re-pack the single last sheet with one edge-biased mode; the primary mode
    // collapses the leftover toward one edge, 'MaxRects' is the denser fallback
    // when the primary can't fit every piece on one sheet. Returns the packed
    // placements (all pieces on ONE sheet) or null.
    const _repack = (modes) => {
      for (const mode of modes) {
        let r;
        try { r = _nestMultiSheet(pieces.map(p => ({ ...p })), stock, S.gap, mode); }
        catch (e) { continue; }
        const out = r && r.sheets && r.sheets[0];
        if (!out || (r.unplaced && r.unplaced.length) || r.sheets.length !== 1) continue;
        if (out.placements.length !== sheet.placements.length) continue;
        return out.placements;
      }
      return null;
    };
    // Pack parts toward the LEFT edge so the leftover is a tall column on the
    // RIGHT. The skyline packer only packs bottom-up (mode 'Left' is identical
    // to 'Bottom'), so we pack in a FRAME rotated 90° CW — real-left becomes
    // frame-bottom — then map placements back to real sheet space. This is a
    // proper rotation (NOT a transpose), so parts aren't mirrored; each real
    // rotation comes from the piece's own allowed set, so grain stays legal.
    const _repackLeft = () => {
      const W = sheet.sw, H = sheet.sh;
      const framePieces = pieces.map(p => ({
        ...p,                                    // frame-rot = real-rot − 90
        rots: (Array.isArray(p.rots) ? p.rots : [0, 90, 180, 270])
          .map(r => (((r - 90) % 360) + 360) % 360),
      }));
      const frameStock = [{ w: H, h: W, qty: 1, thickness: sheet.thick }];   // sheet rotated
      for (const mode of ['Bottom', 'MaxRects']) {
        let r;
        try { r = _nestMultiSheet(framePieces.map(p => ({ ...p })), frameStock, S.gap, mode); }
        catch (e) { continue; }
        const out = r && r.sheets && r.sheets[0];
        if (!out || (r.unplaced && r.unplaced.length) || r.sheets.length !== 1) continue;
        if (out.placements.length !== pieces.length) continue;
        return out.placements.map(pl => {
          const fr = (((pl.rot || 0) % 360) + 360) % 360;
          const fu = (fr === 90 || fr === 270) ? pl.h : pl.w;   // frame u-extent (along frame width H)
          // real_x = frame packer-y (v0); real_y flips the frame u-axis.
          return { ...pl, x: pl.y, y: H - pl.x - fu, rot: (fr + 90) % 360 };
        });
      }
      return null;
    };
    // Measure a packed layout's largest empty rect; keep only when ≥300mm both
    // sides. rect/placements live in mm/sheet space.
    const _measure = (placements) => {
      if (!placements) return null;
      const rect = _largestOffcut({ sw: sheet.sw, sh: sheet.sh, placements });
      if (!(rect.w >= _REMNANT_MIN_LAST && rect.h >= _REMNANT_MIN_LAST)) return null;
      return { placements, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h, area: rect.area } };
    };

    // h (─ wide): parts toward the BOTTOM -> leftover = wide band on top.
    // v (│ long): parts toward the LEFT  -> leftover = tall column on right.
    const variants = {
      h: _measure(_repack(['Bottom', 'MaxRects'])),
      v: _measure(_repackLeft()),
    };
    sheet._rectVariants = variants;

    const dir = _pickDefaultRectDir(variants, S.rectDir);
    if (!dir) {
      // Neither direction yields a usable rectangle — behave as the no-remnant
      // baseline: keep the original layout, no green box.
      sheet.placements = origPlacements;
      sheet.lastRemnantRect = null;
      return;
    }
    _applyRectVariant(sheet, li, dir);
    // Both valid -> ask เอ๋ to SEE both (modal); one valid -> applied silently.
    if (variants.h && variants.v) S._rectPendingIdx = li;
  }

  // Apply one computed variant to the live sheet (swap placements + rect) and
  // land the view on it. Shared by the default-apply and the chooser click.
  function _applyRectVariant(sheet, idx, dir) {
    const variant = sheet._rectVariants && sheet._rectVariants[dir];
    if (!variant) return;
    sheet.placements = variant.placements;
    sheet.lastRemnantRect = { x: variant.rect.x, y: variant.rect.y, w: variant.rect.w, h: variant.rect.h };
    S.currentSheetIdx = idx;
  }

  // Side-by-side chooser shown when the last sheet's leftover can run either way
  // (เอ๋ 2026-06-12 'เพิ่ม Preview ให้ดู และเลือกได้ว่า อยากให้เหลือเศษ ตามแนวยาว
  // หรือแนวขวาง'). Two mini _drawSheet canvases; the bigger-area one is ringed +
  // chipped (recommended); a remembered dir pre-selects its card. Click = apply +
  // remember; backdrop/✕ = keep the already-applied default (never trap with no
  // result). Opens only when BOTH variants exist (gated by the caller).
  function _openRectDirModal(idx) {
    const sheet = (S.flatSheets || [])[idx];
    if (!sheet || !sheet._rectVariants || !sheet._rectVariants.h || !sheet._rectVariants.v) return;
    document.querySelectorAll('.kdrectdir-modal').forEach(m => m.remove());
    const V = sheet._rectVariants;
    const areaH = V.h.rect.area != null ? V.h.rect.area : V.h.rect.w * V.h.rect.h;
    const areaV = V.v.rect.area != null ? V.v.rect.area : V.v.rect.w * V.v.rect.h;
    const biggerDir = areaV > areaH ? 'v' : 'h';
    const preDir = (S.rectDir === 'h' || S.rectDir === 'v') ? S.rectDir : biggerDir;
    const dim = (r) => Math.round(r.w) + '×' + Math.round(r.h) + 'mm';

    const card = (dir, glyph, name, rect) => `
      <div class="kdrectdir-card${dir === preDir ? ' kdrectdir-pre' : ''}${dir === biggerDir ? ' kdrectdir-big' : ''}" data-dir="${dir}">
        <canvas class="kdrectdir-canvas" data-dir="${dir}"></canvas>
        <div class="kdrectdir-cap">${glyph} ${name} · ${dim(rect)}${dir === biggerDir ? ' <span class="kdrectdir-chip">bigger</span>' : ''}</div>
      </div>`;

    const modal = document.createElement('div');
    modal.className = 'kdstock-modal kdrectdir-modal';
    modal.innerHTML = '<div class="kdstock-backdrop"></div>'
      + `<div class="kdstock-frame" role="dialog" aria-label="Remnant direction">
           <div class="kdstock-head">Remnant direction
             <span class="kdstock-sub">pick how the leftover runs — click a layout</span>
             <button class="kdstock-close" aria-label="Close">✕</button>
           </div>
           <div class="kdrectdir-body">
             ${card('h', '─', 'Wide', V.h.rect)}
             ${card('v', '│', 'Long', V.v.rect)}
           </div>
         </div>`;
    document.body.appendChild(modal);

    // Draw each variant into its mini canvas. Canvas must be laid out (in DOM
    // with a CSS size) before _drawSheet reads clientWidth — double-rAF like
    // _refreshView. Standalone variantSheet is safe (verified: _drawSheet reads
    // only S.flatSheets[colour] + S.highlightCode, draws the sheet arg).
    const drawAll = () => {
      modal.querySelectorAll('.kdrectdir-canvas').forEach(cv => {
        const d = cv.dataset.dir;
        const vSheet = {
          thick: sheet.thick, sw: sheet.sw, sh: sheet.sh,
          placements: V[d].placements,
          lastRemnantRect: { x: V[d].rect.x, y: V[d].rect.y, w: V[d].rect.w, h: V[d].rect.h },
        };
        _drawSheet(cv, vSheet);
      });
    };
    // Force layout so the canvases get their CSS size, then draw immediately.
    // Don't depend solely on rAF — it can be throttled when the page isn't
    // actively painting (e.g. a backgrounded tab), which would leave the minis
    // blank. The sync reflow makes clientWidth/Height final; the rAF + timeout
    // passes cover late font metrics / HiDPI without being the only path.
    void modal.querySelector('.kdrectdir-body').offsetHeight;   // sync reflow
    drawAll();
    requestAnimationFrame(drawAll);
    setTimeout(drawAll, 30);

    const close = () => modal.remove();
    const pick = (dir) => {
      _applyRectVariant(sheet, idx, dir);
      S.rectDir = dir;
      try { localStorage.setItem('kd_nest_rectdir', dir); } catch (e) {}
      close();
      _refreshView();           // re-render on the chosen sheet (green box = chosen rect)
    };
    // Backdrop / ✕ = keep the already-applied default pick (no trap, one result).
    modal.querySelector('.kdstock-backdrop').addEventListener('click', close);
    modal.querySelector('.kdstock-close').addEventListener('click', close);
    modal.querySelectorAll('.kdrectdir-card').forEach(c =>
      c.addEventListener('click', () => pick(c.dataset.dir)));
  }

  // ── Auto-remember offcuts ──────────────────────────────────────────
  // Largest reusable offcut on a packed sheet — coarse raster + histogram
  // largest-empty-rectangle (standalone twin of the one inside Max Remnant
  // mode so auto-save can reach it). Returns {w,h,x,y,area} in mm (0 if none).
  function _largestOffcut(sheet) {
    if (!sheet || !sheet.placements || !sheet.sw || !sheet.sh) return { w: 0, h: 0, area: 0 };
    const cell = Math.max(5, Math.ceil(Math.max(sheet.sw, sheet.sh) / 120));
    const gw = Math.max(1, Math.ceil(sheet.sw / cell));
    const gh = Math.max(1, Math.ceil(sheet.sh / cell));
    const mask = new Uint8Array(gw * gh);   // 0 = free, 1 = occupied
    for (const pl of sheet.placements) {
      const w = (pl.rot === 90 || pl.rot === 270) ? pl.h : pl.w;
      const h = (pl.rot === 90 || pl.rot === 270) ? pl.w : pl.h;
      const x0 = Math.floor(pl.x / cell), y0 = Math.floor(pl.y / cell);
      const x1 = Math.ceil((pl.x + w) / cell), y1 = Math.ceil((pl.y + h) / cell);
      for (let gy = y0; gy < y1; gy++)
        for (let gx = x0; gx < x1; gx++)
          if (gx >= 0 && gx < gw && gy >= 0 && gy < gh) mask[gy * gw + gx] = 1;
    }
    const heights = new Int32Array(gw);
    let best = { area: 0, x: 0, y: 0, w: 0, h: 0 };
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++)
        heights[gx] = mask[gy * gw + gx] ? 0 : heights[gx] + 1;
      const stack = [];
      for (let gx = 0; gx <= gw; gx++) {
        const cur = gx === gw ? 0 : heights[gx];
        while (stack.length && heights[stack[stack.length - 1]] >= cur) {
          const top = stack.pop();
          const height = heights[top];
          const left = stack.length ? stack[stack.length - 1] + 1 : 0;
          const width = gx - left;
          const area = height * width;
          if (area > best.area) best = {
            area: area, x: left * cell, y: (gy - height + 1) * cell,
            w: width * cell, h: height * cell,
          };
        }
        stack.push(gx);
      }
    }
    best.w = Math.min(best.w, sheet.sw);   // raster rounds up → clamp to sheet
    best.h = Math.min(best.h, sheet.sh);
    return best;
  }
  // Grain of a sheet's leftover = derived from the parts laid on it. H+V
  // together → MIXED (a grain-strict job can't reuse it); a single directional
  // → that direction; else ANY. (feedback_remnants_grain_finish)
  function _sheetGrain(sheet) {
    let hasH = false, hasV = false;
    for (const pl of (sheet.placements || [])) {
      const p = S.parts.find(pp => pp.code === pl.code);
      const g = String((p && p.grain) || 'ANY').toUpperCase();
      if (g === 'H') hasH = true; else if (g === 'V') hasV = true;
    }
    if (hasH && hasV) return 'MIXED';
    if (hasH) return 'H';
    if (hasV) return 'V';
    return 'ANY';
  }
  // Material / finish of a sheet's leftover — taken from the parts laid on it.
  // Parts don't carry these fields yet (BOM has only grain+thickness), so this
  // reads p.material/p.finish if a future BOM adds them, else falls back to the
  // shop default: all laser sheet metal is ALPF ([[reference_alpf_material]]),
  // finish unknown (blank). Stored on the offcut so a future grain+material+
  // finish match key is possible without a re-cut. (feedback_remnants_grain_finish)
  function _sheetMaterial(sheet) {
    for (const pl of (sheet.placements || [])) {
      const p = S.parts.find(pp => pp.code === pl.code);
      if (p && p.material) return String(p.material);
    }
    return 'ALPF';
  }
  function _sheetFinish(sheet) {
    for (const pl of (sheet.placements || [])) {
      const p = S.parts.find(pp => pp.code === pl.code);
      if (p && p.finish) return String(p.finish);
    }
    return '';
  }
  // On 💾 Save Nest, save the largest offcut of each sheet to the shared
  // Remnants pool (เอ๋ 2026-05-31 'กด run nesting แล้ว...ทำไมไม่มีเศษวัสดุ'; moved
  // from end-of-run to Save Nest 2026-06-10 'ถ้าจะ save ให้มา save ที่ save
  // Project' — test Runs no longer pollute the pool, the "Don't remember"
  // checkbox is gone). Re-saving REPLACES this project's prior auto offcuts
  // (auto:true + sourceProject) so tuning doesn't pile up duplicates; manual
  // remnants and other projects' offcuts are never touched.
  const _REMNANT_MIN = 150;   // mm — ignore slivers smaller than this on a side
  async function _autoSaveRemnants() {
    if (!window.firebaseDB) return;
    const pk = S.projectKey || '';
    try {
      await _loadRemnants();
      for (const r of (S.remnants || [])) {   // clear this project's prior auto offcuts
        if (r.auto && r.sourceProject === pk) {
          try { await _deleteRemnant(r.id); } catch (_) {}
        }
      }
      let saved = 0;
      for (let i = 0; i < (S.flatSheets || []).length; i++) {
        const sheet = S.flatSheets[i];
        if (sheet.fromRemnant) continue;   // don't save an offcut-of-an-offcut
        // Last-sheet rectangular remnant (เอ๋ 2026-06-11): if _rectifyLastSheet
        // stashed a rectangle, save THAT (≥300mm) instead of re-measuring; other
        // sheets keep the 150mm offcut behaviour.
        const off = sheet.lastRemnantRect
          ? { x: sheet.lastRemnantRect.x, y: sheet.lastRemnantRect.y, w: sheet.lastRemnantRect.w, h: sheet.lastRemnantRect.h }
          : _largestOffcut(sheet);
        const _min = sheet.lastRemnantRect ? _REMNANT_MIN_LAST : _REMNANT_MIN;
        if (!(off.w >= _min && off.h >= _min)) continue;
        // Footprint rects of every piece on this sheet (W/H swapped for
        // rotated parts) so the preview can draw the actual layout + show
        // WHERE on the sheet the leftover sits (เอ๋ 2026-05-31 'ดูรูปได้ว่า
        // มาจากแผ่นไหน'). Plus the sheet size + the offcut's position.
        const placements = (sheet.placements || []).map(pl => ({
          x: Math.round(pl.x), y: Math.round(pl.y),
          w: Math.round((pl.rot === 90 || pl.rot === 270) ? pl.h : pl.w),
          h: Math.round((pl.rot === 90 || pl.rot === 270) ? pl.w : pl.h),
        }));
        await _saveRemnant({
          w: Math.round(off.w), h: Math.round(off.h),
          thickness: sheet.thick ?? 1,
          grain: _sheetGrain(sheet),
          material: _sheetMaterial(sheet),
          finish: _sheetFinish(sheet),
          project: S.projectName || '',
          note: 'Auto · sheet ' + (i + 1) + (sheet.lastRemnantRect ? ' (last · rect)' : ''),
          date: new Date().toISOString().slice(0, 10),
          createdAt: Date.now(),
          auto: true,
          sourceProject: pk,
          sheetNo: i + 1,
          sheetW: Math.round(sheet.sw), sheetH: Math.round(sheet.sh),
          offX: Math.round(off.x), offY: Math.round(off.y),
          placements: placements,
        });
        saved++;
      }
      await _loadRemnants();   // refresh so an already-open modal repaints current
      if (saved) console.log('[kdNest] auto-saved ' + saved + ' offcut(s) to remnants');
      return saved;
    } catch (e) { console.warn('[kdNest] auto-save remnants failed:', e); return 0; }
  }

  // ── EDGE (angled grain) geometry pre-rotation ───────────────────────
  // For an EDGE part we rotate the geometry by -angle around the origin so the
  // chosen edge becomes horizontal (parallel to the sheet grain). The packer
  // then treats it like an H part (rots [0,180]); the physical part is cut at
  // that angle on the sheet, so the grain runs along the picked edge.
  // Rotating by -angle (CW) makes an edge at +angle land horizontal.
  // (angled-grain feature 2026-06-25)
  function _rotatePoly(pts, angleDeg) {
    if (!Array.isArray(pts)) return pts;
    const rad = -angleDeg * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return pts.map(p => {
      const x = p[0], y = p[1];
      return [x * cos - y * sin, x * sin + y * cos];
    });
  }
  // Recompute an [minX,minY,maxX,maxY] bbox from already-rotated points.
  function _rotateBbox(bbox, angleDeg, newPts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const scan = arr => { for (const p of (arr || [])) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    } };
    scan(newPts);
    if (!isFinite(minX)) {
      // No points — fall back to rotating the bbox corners themselves.
      const [x0, y0, x1, y1] = bbox || [0, 0, 0, 0];
      const corners = _rotatePoly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], angleDeg);
      return _rotateBbox(null, 0, corners);
    }
    return [minX, minY, maxX, maxY];
  }
  // Rotate the normalised WCS true-entity descriptors (CIRCLE/ARC/LINE/
  // LWPOLYLINE/SPLINE/ELLIPSE) by -angle so the exported DXF vector geometry
  // matches the rendered, pre-rotated outline. Positions rotate; sweep-angle
  // fields shift by the SAME -angle so arcs/ellipses keep their handedness.
  function _rotateEntities(entities, angleDeg) {
    if (!Array.isArray(entities)) return entities;
    const rad = -angleDeg * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const rp = (x, y) => [x * cos - y * sin, x * sin + y * cos];
    return entities.map(d => {
      if (!d) return d;
      const k = d.kind;
      if (k === 'CIRCLE') { const [cx, cy] = rp(d.cx, d.cy); return { ...d, cx, cy }; }
      if (k === 'ARC')    { const [cx, cy] = rp(d.cx, d.cy); return { ...d, cx, cy, a0: d.a0 + rad, a1: d.a1 + rad }; }
      if (k === 'LINE')   { const [x0, y0] = rp(d.x0, d.y0), [x1, y1] = rp(d.x1, d.y1); return { ...d, x0, y0, x1, y1 }; }
      if (k === 'LWPOLYLINE') { return { ...d, verts: (d.verts || []).map(v => { const [x, y] = rp(v.x, v.y); return { x, y, bulge: v.bulge || 0 }; }) }; }
      if (k === 'SPLINE') {
        return { ...d,
          ctrl: (d.ctrl || []).map(p => { const [x, y] = rp(p.x, p.y); return { x, y }; }),
          fit:  (d.fit  || []).map(p => { const [x, y] = rp(p.x, p.y); return { x, y }; }) };
      }
      if (k === 'ELLIPSE') {
        const [cx, cy] = rp(d.cx, d.cy);
        // The major-axis vector rotates too (it is a direction, so no translate).
        const mx = d.mx * cos - d.my * sin, my = d.mx * sin + d.my * cos;
        return { ...d, cx, cy, mx, my };
      }
      return d;
    });
  }
  // Build the EDGE-pre-rotated geometry bundle for one part. Returns the rotated
  // polys (outer/holes/strokes/entities) + a fresh bbox, all ready to hand to a
  // piece. (angled-grain feature 2026-06-25)
  function _edgeRotatedGeom(p) {
    const a = p.grainAngle;
    const src = p.polys || {};
    const newOuter = _rotatePoly(src.outer || [], a);
    const newHoles = (src.holes || []).map(h => _rotatePoly(h, a));
    const newStrokes = (src.strokes || []).map(s => _rotatePoly(s, a));
    const newEntities = _rotateEntities(src.entities || [], a);
    // Collect every rotated point so the bbox is exact for concave parts.
    const allPts = [].concat(newOuter, ...newHoles, ...newStrokes);
    const newBbox = _rotateBbox(p.bbox, a, allPts);
    return {
      polys: { outer: newOuter, holes: newHoles, strokes: newStrokes, entities: newEntities },
      bbox: newBbox,
      w: Math.round((newBbox[2] - newBbox[0]) * 100) / 100,
      h: Math.round((newBbox[3] - newBbox[1]) * 100) / 100,
    };
  }

  // ── MIRROR (left-right flip) geometry ───────────────────────────────
  // Reflect geometry across the VERTICAL axis through the bbox centre
  // (x → minX+maxX−x). This is a left-right flip that keeps the bbox
  // dimensions identical (so w/h, the packer footprint, and the placement
  // rotation logic are all untouched) while producing the chemically-
  // opposite (handed) part — what เอ๋ needs when a panel was modelled for
  // the wrong hand. The reflection is applied AFTER any EDGE pre-rotation,
  // in the part's displayed frame, so preview == sheet == DXF identically.
  // Grain stays HORIZONTAL after a left-right flip, so grain semantics are
  // preserved (no V↔H swap). (Rotate-180 + Mirror feature 2026-06-26)
  //
  // CANONICAL TRANSFORM ORDER (used in preview, nesting, export):
  //   1. EDGE pre-rotate (−grainAngle, re-bbox)   — chosen edge → horizontal
  //   2. MIRROR (reflect x across current bbox)    — left-right flip
  //   3. FLIP180 (placement rotation += 180)       — applied after packing
  //
  // Mirror reverses polygon winding (CCW↔CW). _polyArea uses Math.abs so it
  // is winding-agnostic, and the canvas/DXF emitters just close the path —
  // but to keep outer loops in a consistent CCW orientation (and so a future
  // even-odd / nonzero fill never inverts), we REVERSE the point order of
  // every loop after reflecting. A double mirror is therefore an exact
  // identity (reflect + reverse, twice). (winding note 2026-06-26)
  function _mirrorPts(pts, axisSum) {
    if (!Array.isArray(pts)) return pts;
    // reflect x then reverse order (restore winding sense)
    return pts.map(p => [axisSum - p[0], p[1]]).reverse();
  }
  function _mirrorEntities(entities, axisSum) {
    if (!Array.isArray(entities)) return entities;
    const fx = x => axisSum - x;
    return entities.map(d => {
      if (!d) return d;
      const k = d.kind;
      // A reflection reverses arc/ellipse handedness: a point at angle θ on
      // the original maps to (π−θ) on the mirror, and the CCW sweep reverses.
      // Represent the swept arc as CCW from (π−a1) to (π−a0). Same maths as
      // _entityToWcs's OCS-mirror branch — kept in lock-step.
      if (k === 'CIRCLE') return { ...d, cx: fx(d.cx) };
      if (k === 'ARC')    return { ...d, cx: fx(d.cx), a0: Math.PI - d.a1, a1: Math.PI - d.a0 };
      if (k === 'LINE')   return { ...d, x0: fx(d.x0), x1: fx(d.x1) };
      if (k === 'LWPOLYLINE') return { ...d, verts: (d.verts || []).map(v => ({ x: fx(v.x), y: v.y, bulge: -(v.bulge || 0) })) };
      if (k === 'SPLINE') return { ...d,
        ctrl: (d.ctrl || []).map(p => ({ x: fx(p.x), y: p.y })),
        fit:  (d.fit  || []).map(p => ({ x: fx(p.x), y: p.y })) };
      // ELLIPSE: flip centre.x + major-axis X-component, AND reverse the
      // partial-arc sweep (start↔end, negated) so a partial elliptical arc
      // renders the mirrored portion — lock-step with _entityToWcs's flip
      // branch (a0: -en, a1: -s). Full ellipses are unaffected by the swap.
      // (partial-arc mirror fix 2026-06-26)
      if (k === 'ELLIPSE') return { ...d, cx: fx(d.cx), mx: -d.mx, a0: -d.a1, a1: -d.a0 };
      return d;
    });
  }
  // Apply MIRROR to a {polys, bbox, w, h} geometry bundle (the output of
  // _edgeRotatedGeom, or a freshly-built native bundle). Returns a NEW bundle
  // with reflected polys/entities; bbox/w/h are unchanged (reflection about the
  // bbox centre preserves extents). (Rotate-180 + Mirror 2026-06-26)
  function _mirrorGeom(g) {
    if (!g || !g.bbox) return g;
    const [minX, , maxX] = g.bbox;
    const axisSum = minX + maxX;
    const src = g.polys || {};
    return {
      polys: {
        outer: _mirrorPts(src.outer || [], axisSum),
        holes: (src.holes || []).map(h => _mirrorPts(h, axisSum)),
        strokes: (src.strokes || []).map(s => _mirrorPts(s, axisSum)),
        entities: _mirrorEntities(src.entities || [], axisSum),
      },
      bbox: g.bbox.slice(),
      w: g.w, h: g.h,
    };
  }
  // Build the FULLY-ORIENTED geometry bundle for one part: EDGE pre-rotate
  // (if any) → MIRROR (if part.mirror). The result feeds preview, nesting and
  // export identically (single source of truth for the transform order). FLIP180
  // is NOT applied here — it is a placement rotation (+180) added after packing.
  // Returns null when the part has no usable geometry (manual rect, no DXF).
  // Falsy flags → returns the native bundle, byte-for-byte the old behaviour.
  // (Rotate-180 + Mirror 2026-06-26)
  function _orientedGeom(p) {
    if (!p || !p.polys || !p.bbox) return null;
    const isEdge = (p.grain === 'EDGE' && p.grainAngle != null &&
                    Number.isFinite(Number(p.grainAngle)));
    let g;
    if (isEdge) {
      g = _edgeRotatedGeom(p);
      if (!g || !(g.w > 0) || !(g.h > 0) || !g.bbox || !g.bbox.every(Number.isFinite)) g = null;
    }
    if (!g) {
      // Native bundle (no EDGE rotation) — keep the part's own polys/bbox.
      const [minX, minY, maxX, maxY] = p.bbox;
      g = { polys: p.polys, bbox: p.bbox.slice(),
            w: Math.round((maxX - minX) * 100) / 100,
            h: Math.round((maxY - minY) * 100) / 100 };
    }
    if (p.mirror) g = _mirrorGeom(g);
    return g;
  }

  // ── Rotate-180 + Mirror flag persistence (grain_rules rows) ─────────
  // flip180 + mirror are per-part booleans persisted as their OWN exact-code
  // grain_rules rows ({pattern: code, grain: 'FLIP180'|'MIRROR'}), STACKING
  // alongside whatever H/V/ANY/EDGE rule the part already has. They are NOT
  // returned by _lookupPattern (which yields one grain rule per code), so we
  // scan S.grainRows directly. Backward-compatible: old data has no such rows
  // → both flags read false. (Rotate-180 + Mirror feature 2026-06-26)
  function _readPartFlip180(code) {
    return (S.grainRows || []).some(r =>
      String(r.pattern) === code && String(r.grain).toUpperCase() === 'FLIP180');
  }
  function _readPartMirror(code) {
    return (S.grainRows || []).some(r =>
      String(r.pattern) === code && String(r.grain).toUpperCase() === 'MIRROR');
  }
  // Apply the persisted FLIP180/MIRROR rows to every loaded part. Called after
  // grain rows load/save so the in-memory flags track the shared rules.
  function _applyOrientFlagsToParts() {
    for (const part of (S.parts || [])) {
      part.flip180 = _readPartFlip180(part.code);
      part.mirror  = _readPartMirror(part.code);
    }
  }
  // PURE flag-apply — the SINGLE source of truth for setting flip180/mirror on a
  // live part object. Mutates `part` in place AND syncs the persisted-row array
  // so the two never disagree. Returns the new flag value. The toggle (click)
  // path and the load path (_applyOrientFlagsToParts) both funnel through this so
  // the flag lands on the SAME object identity that preview + nesting read — no
  // stale copy, no dependence on an async re-scan. (Rotate-180 + Mirror 2026-06-26)
  //
  // The previous bug: the click handler set part.flip180 then awaited
  // _saveGrainRows() — which calls _applyGrainToParts() (re-derives the flag from
  // S.grainRows) AND writes RTDB — and only repainted in the trailing .then().
  // So the live flag's correctness + the repaint were gated behind a network
  // round-trip and could be clobbered by the grain_rules .on('value') listener
  // reloading S.grainRows mid-flight. The button toggled its class but the flag
  // read false and the preview never repainted until a full reload.
  function _applyOrientFlag(part, which, on, rows) {
    if (!part) return on;
    const code = part.code;
    const tag = (which === 'flip180') ? 'FLIP180' : 'MIRROR';
    if (Array.isArray(rows)) {
      const has = rows.find(r =>
        String(r.pattern) === code && String(r.grain).toUpperCase() === tag);
      if (on && !has) {
        rows.push({ pattern: code, grain: tag, thickness: '', fix: '', angle: null });
      } else if (!on && has) {
        const i = rows.indexOf(has);
        if (i >= 0) rows.splice(i, 1);   // mutate in place (keep array identity)
      }
    }
    if (which === 'flip180') part.flip180 = on; else part.mirror = on;
    return on;
  }
  // Toggle a part's flip180/mirror flag: flip the LIVE flag + repaint IMMEDIATELY
  // (synchronously, before any await), then persist the grain_rules row in the
  // background. The instant-repaint path no longer waits on RTDB, so the preview
  // and the active button state always reflect the live flag the moment the user
  // clicks. (Rotate-180 + Mirror feature 2026-06-26)
  function _toggleOrientFlag(part, which) {
    if (!part) return Promise.resolve();
    const code = part.code;
    const next = !(which === 'flip180' ? part.flip180 : part.mirror);
    // 1) Live flag — set on the same object preview/_runNesting read, RIGHT NOW.
    //    (The row sync waits until the real grain rows are loaded so we never
    //    clobber existing grain rules with a fresh [].)
    _applyOrientFlag(part, which, next, Array.isArray(S.grainRows) ? S.grainRows : null);
    // 2) Repaint NOW — same draw path 👁 uses — so the change is visible instantly
    //    and the row's kdnest-orient-active glyph reflects the live flag.
    _setPreview(code);
    // 3) Persist in the background. If rows weren't loaded yet, load them first
    //    (keeps existing grain rules) THEN apply the orient row to the real array.
    //    _saveGrainRows re-derives flags via _applyGrainToParts, but they already
    //    match what we set above, so the live flag never flips back.
    //
    // 4) RE-ASSERT preview + flag at the END of the chain. The synchronous
    //    _setPreview above is correct the instant the user clicks, but the save
    //    runs an RTDB .set() + _applyGrainToParts(), and any re-render that fires
    //    in between (the uploaded_dxfs/grain listeners, a concurrent refresh) can
    //    reset S.previewCode back to a default (parts[0]) — the LIVE bug เอ๋ hit:
    //    the SDTRIL part's flag was set but the preview JUMPED to parts[0] and the
    //    button read inactive. Re-pinning the previewed code + the flag AFTER the
    //    save settles makes the previewed part survive the whole toggle re-render
    //    chain, no matter what re-rendered in between. Idempotent + cheap.
    //    (live preserve-previewed-part fix 2026-06-26)
    return Promise.resolve()
      .then(() => (Array.isArray(S.grainRows) ? S.grainRows : _loadGrainRows()))
      .then(rows => { _applyOrientFlag(part, which, next, rows); return _saveGrainRows(); })
      .then(() => {
        // _saveGrainRows → _applyGrainToParts re-derives the flag from the saved
        // rows; re-assert it on THIS object so a stale read can never flip it back.
        _applyOrientFlag(part, which, next, Array.isArray(S.grainRows) ? S.grainRows : null);
        // If anything reset the preview off our part during the save, restore it
        // (also repaints, so the active class re-binds to the live flag).
        if (S.previewCode !== code) _setPreview(code);
      })
      .catch(e => console.warn('[kdNest] orient flag save failed:', e));
  }
  function _togglePartFlip180(part) { _toggleOrientFlag(part, 'flip180'); }
  function _togglePartMirror(part)  { _toggleOrientFlag(part, 'mirror'); }

  // ════════════════════════════════════════════════════════════════════
  //  Run Nesting
  // ════════════════════════════════════════════════════════════════════
  // ── Shared nesting helpers (hoisted to module scope so the auto-optimizer
  //    trials and _runNesting both use the EXACT same grouping / remnant / grain
  //    logic). (AUTO COST-OPTIMIZE เอ๋ 2026-06-26) ──────────────────────────
  function _thickKey(t) {
    const n = typeof t === 'number' ? t : parseFloat(String(t).replace(/[^\d.]/g, ''));
    return isNaN(n) ? '?' : String(Math.round(n * 100) / 100);
  }
  function _remnantStockForThick(tk) {
    const out = [];
    for (const r of (S.remnants || [])) {
      if (_thickKey(r.thickness ?? 1) !== tk) continue;
      if (S.remnantsOff && S.remnantsOff.has(r.id)) continue;
      const w = (r.actualW != null) ? +r.actualW : +r.w;
      const h = (r.actualH != null) ? +r.actualH : +r.h;
      if (!(w > 0 && h > 0)) continue;
      out.push({ w: Math.round(w), h: Math.round(h), qty: 1,
                 thickness: r.thickness ?? 1, label: '♻ remnant', _remnantId: r.id,
                 grain: String(r.grain || 'ANY').toUpperCase(),
                 material: r.material || '', finish: r.finish || '' });
    }
    return out;
  }
  function _grainFits(pieceGrain, remGrain, pieceAngle) {
    const pg = String(pieceGrain || 'ANY').toUpperCase();
    const rg = String(remGrain || 'ANY').toUpperCase();
    if (pg === 'EDGE') {
      if (rg === 'ANY') return true;
      if (rg === 'EDGE') {
        const ra = (remGrain && remGrain._angle != null) ? remGrain._angle : null;
        return ra != null && pieceAngle != null && Math.abs(((ra - pieceAngle) % 180 + 180) % 180) < 0.5;
      }
      return false;
    }
    if (pg !== 'H' && pg !== 'V') return true;
    if (rg === 'ANY') return true;
    return rg === pg;
  }

  // Run the remnant scrap-first pre-pass for ONE thickness group, returning the
  // POST-remnant fresh pool (remnants are free/excluded from cost). PURE — does
  // not touch S.flatSheets/UI. Used by both the optimizer (to score only the
  // fresh-stock decision) and conceptually mirrors _runNesting's pre-pass.
  function _remnantPrepass(pool, tk, mode) {
    if (S.skipRemnants) return pool.slice();
    let p = pool.slice();
    for (const rm of _remnantStockForThick(tk)) {
      const compat = p.filter(pc => _grainFits(pc.grain, rm.grain, pc.grainAngle));
      if (!compat.length) continue;
      const rr = _nestMultiSheet(compat, [{ ...rm, qty: 1 }], S.gap, mode);
      const sheet = (rr.sheets || [])[0];
      if (!sheet || !sheet.placements.length) continue;
      const used = new Map();
      for (const pl of sheet.placements) used.set(pl.code, (used.get(pl.code) || 0) + 1);
      p = p.filter(pc => {
        const left = used.get(pc.code) || 0;
        if (left > 0) { used.set(pc.code, left - 1); return false; }
        return true;
      });
    }
    return p;
  }

  // ── LAST-PARTIAL-SHEET DOWNSIZING (เอ๋ 2026-06-26) ───────────────────────────
  // After the optimizer picks a plan, its LAST fresh sheet is usually partial (a
  // few parts + a big leftover). If those parts also fit on a CHEAPER enabled
  // size, swapping the last sheet to that size lowers total cost with zero loss
  // (e.g. 10x4 ×4 + 8x4 ×1 = 13,350 beats 10x4 ×5 = 13,750).
  //
  // PURE selection core: given the current sheet's price and a list of CHEAPER
  // candidate sizes (ascending price), return the first whose `fitsFn(cand)`
  // packs ALL the last sheet's parts onto ONE sheet (0 unplaced). fitsFn returns
  // the packed placements array on success, or null/falsy on no-fit. Returns
  // { size, placements } for the cheapest fitting candidate, or null if none
  // fits / nothing is strictly cheaper. (THE unit-tested downsizing logic.)
  function _pickDownsizeSize(currentPrc, candidates, fitsFn) {
    const cheaper = (candidates || [])
      .filter(c => (c.prc || 0) < currentPrc)   // STRICTLY cheaper only — never upsize
      .slice()
      .sort((a, b) => (a.prc || 0) - (b.prc || 0));   // try cheapest first
    for (const cand of cheaper) {
      const placements = fitsFn(cand);
      if (placements && placements.length) return { size: cand, placements };
    }
    return null;
  }

  // DOM wrapper: operate on the live S.flatSheets. Finds the LAST FRESH sheet,
  // reconstructs its parts, builds the cheaper-enabled-size candidate list for
  // that sheet's thickness (honoring finite qty caps + grain via the headless
  // packer), and — if all parts fit on a cheaper size — swaps the sheet's
  // sw/sh/placements in place. No-op (and never a regression) when nothing
  // cheaper fits. Called from the AUTO path only, BEFORE _rectifyLastSheet so the
  // leftover-rectangle is computed on the final (downsized) size.
  //
  // allowKeys (optional): a Set of `${W}x${H}` size keys the USER originally
  // enabled. The auto-optimizer TEMPORARILY disables the losing sizes on
  // S.sheetStock before the final run (so the winning mix renders) — which means
  // the live `enabled` flag no longer reflects what the user actually allows, and
  // the cheaper downsize target (e.g. 8x4 when the winner is 10x4-only) would be
  // skipped as "disabled". When allowKeys is provided the candidate loop trusts
  // it instead of the live flag, so a user-enabled cheaper size is still eligible.
  // Omitted → fall back to the live `enabled` flag (unchanged behaviour). (fix
  // for live downsize not firing เอ๋ 2026-06-26)
  function _downsizeLastFreshSheet(allowKeys) {
    const sheets = S.flatSheets || [];
    // last FRESH-stock sheet (offcut-derived sheets aren't downsized — remnants
    // are free/excluded from cost).
    let li = -1;
    for (let i = sheets.length - 1; i >= 0; i--) { if (!sheets[i].fromRemnant) { li = i; break; } }
    if (li < 0) return;
    const sheet = sheets[li];
    if (!sheet.placements || !sheet.placements.length) return;

    const curW = Math.round(sheet.sw), curH = Math.round(sheet.sh);
    const curRow = S.sheetStock.find(s => Math.round(s.w) === curW && Math.round(s.h) === curH);
    const curPrc = (curRow && curRow.prc) || _getPriceDefault(curW, curH, (curRow && curRow.label) || '');
    if (!(curPrc > 0)) return;   // unknown/zero price → can't reason about savings

    const tk = _thickKey(sheet.thick);

    // How many fresh sheets of each size the rest of the plan already consumes —
    // so a finite qty cap left over for the candidate size is computed honestly
    // (the last sheet itself doesn't count against the candidate).
    const usedFreshBySize = new Map();
    sheets.forEach((s, i) => {
      if (i === li) return;
      if (s.fromRemnant) return;
      const k = `${Math.round(s.w ? s.w : s.sw)}x${Math.round(s.h ? s.h : s.sh)}`;
      usedFreshBySize.set(k, (usedFreshBySize.get(k) || 0) + 1);
    });

    // Candidate cheaper sizes for this thickness: enabled, sized, and with ≥1
    // remaining qty after the rest of the plan (−1 = unlimited).
    const candidates = [];
    for (const s of S.sheetStock) {
      if (!(s.w > 0 && s.h > 0)) continue;
      const w = Math.round(s.w), h = Math.round(s.h);
      // Eligibility: trust allowKeys (the user's original enabled set) when given,
      // else the live `enabled` flag. The auto-optimizer mutates `enabled` before
      // this runs, so the live flag can't be trusted on the auto path.
      const eligible = allowKeys ? allowKeys.has(`${w}x${h}`) : (s.enabled !== false);
      if (!eligible) continue;
      if (_thickKey(s.thickness ?? 1) !== tk) continue;
      if (w === curW && h === curH) continue;   // same size — nothing to gain
      const prc = (s.prc || 0) || _getPriceDefault(w, h, s.label);
      const key = `${w}x${h}`;
      const cap = (s.qty === -1) ? Infinity : (s.qty | 0);
      const remaining = (cap === Infinity) ? Infinity : (cap - (usedFreshBySize.get(key) || 0));
      if (remaining < 1) continue;   // qty cap exhausted by the rest of the plan
      candidates.push({ w, h, prc, thickness: s.thickness ?? 1,
        grain: String(s.grain || 'ANY').toUpperCase(),
        material: s.material || '', finish: s.finish || '' });
    }
    if (!candidates.length) return;

    // Reconstruct the last sheet's parts (strip x/y/rot; keep rots so grain
    // gating + allowed rotations survive the re-pack). Same shape as rectify.
    const parts = sheet.placements.map(pl => ({
      code: pl.code, w: pl.w, h: pl.h,
      rots: Array.isArray(pl.rots) ? pl.rots.slice() : [0, 90, 180, 270],
      polys: pl.polys, bbox: pl.bbox, thickness: pl.thickness,
      grain: pl.grain, grainAngle: pl.grainAngle, _origGrainAngle: pl._origGrainAngle,
      flip180: pl.flip180, _mirrorActive: pl._mirrorActive,
    }));
    const need = sheet.placements.length;

    // fitsFn: try to pack ALL parts onto ONE sheet of `cand` (qty 1). Uses the
    // same cheap MaxRects + denser fallback the rectify pass uses. Grain +
    // thickness are baked into the pieces, so the packer gates them; if it can't
    // place everything on one sheet it returns >1 sheet or leaves unplaced → no
    // fit. Returns the packed placements on success, null otherwise.
    const fitsFn = (cand) => {
      const stock = [{ w: cand.w, h: cand.h, qty: 1, thickness: cand.thickness,
        grain: cand.grain, material: cand.material, finish: cand.finish }];
      for (const mode of ['MaxRects', 'Bottom']) {
        let r;
        try { r = _nestMultiSheet(parts.map(p => ({ ...p })), stock, S.gap, mode); }
        catch (e) { continue; }
        const out = r && r.sheets && r.sheets[0];
        if (!out || (r.unplaced && r.unplaced.length) || r.sheets.length !== 1) continue;
        if (out.placements.length !== need) continue;   // ALL parts must fit
        return out.placements;
      }
      return null;
    };

    const pick = _pickDownsizeSize(curPrc, candidates, fitsFn);
    if (!pick) return;   // nothing cheaper fits → keep the original plan exactly

    // Swap the last sheet to the smaller, cheaper size in place. _countFreshSheetsBySize
    // re-reads sw/sh → Total Cost drops; the canvas reads S.flatSheets → shows it.
    sheet.sw = pick.size.w;
    sheet.sh = pick.size.h;
    sheet.placements = pick.placements;
    sheet.lastRemnantRect = null;   // rect (if any) is recomputed by _rectifyLastSheet
  }

  // Cost of a headless trial result = sum over FRESH sheets of that size's prc.
  // res.sheets each carry sw/sh; price looked up by size from priceBySize map.
  // (PURE — feed it a result + a {`${w}x${h}`:prc} map; this is the unit tested
  //  selection logic.) Returns {cost, freshCount} or null if any unplaced.
  function _scoreTrialResult(res, priceBySize) {
    if (!res || (res.unplaced && res.unplaced.length)) return null;
    let cost = 0, fresh = 0;
    for (const s of (res.sheets || [])) {
      const key = `${Math.round(s.sw)}x${Math.round(s.sh)}`;
      cost += (priceBySize[key] || 0);
      fresh++;
    }
    return { cost, freshCount: fresh };
  }

  // Pick the cheapest feasible (0-unplaced) trial. trials: array of
  // {name, stock, result}. priceBySize: {`${w}x${h}`:prc}. Returns the winning
  // trial augmented with {cost, freshCount}, or null if none place everything.
  // Tie-break: fewer fresh sheets. (THE unit-tested selection logic.)
  function _pickCheapestTrial(trials, priceBySize) {
    let best = null;
    for (const t of trials) {
      const sc = _scoreTrialResult(t.result, priceBySize);
      if (!sc) continue;   // infeasible (has unplaced) — skip
      const cand = { ...t, cost: sc.cost, freshCount: sc.freshCount };
      if (best === null
          || cand.cost < best.cost
          || (cand.cost === best.cost && cand.freshCount < best.freshCount)) {
        best = cand;
      }
    }
    return best;
  }

  // Expand the selected parts into per-instance pieces (qty copies each) with
  // grain-restricted rotations — the SHARED piece-build used by both the normal
  // run and the auto-optimizer trials, so trials nest the exact same pieces.
  // (extracted from _runNesting for AUTO COST-OPTIMIZE เอ๋ 2026-06-26)
  function _buildNestPieces() {
    const pieces = [];
    for (const p of S.parts) {
      if (!p.selected) continue;
      if (p.w <= 0 || p.h <= 0) continue;
      if (!p.bbox && !p.manual) continue;   // DXF parts need a parsed bbox; manual synth one
      const bbox = p.bbox || [0, 0, p.w, p.h];
      // CANONICAL geometry: EDGE pre-rotate (chosen edge → horizontal) then
      // MIRROR (left-right flip), built once per part via _orientedGeom. The
      // pieces use the oriented polys/bbox/w/h. Parts with neither EDGE grain
      // nor mirror get the native bundle byte-for-byte (unchanged behaviour).
      // FLIP180 is NOT geometry — it's a placement rotation (+180) added after
      // packing. (Rotate-180 + Mirror 2026-06-26)
      let isEdge = (p.grain === 'EDGE' && p.grainAngle != null &&
                    Number.isFinite(Number(p.grainAngle)) && p.polys);
      let geom = _orientedGeom(p);   // EDGE + MIRROR applied; null if no geometry
      // Defensive: a degenerate EDGE rotation yields non-finite/non-positive
      // dims → fall back to native axis-aligned + ANY rots so the piece still
      // nests instead of risking a stuck pack. (hardening 2026-06-25)
      if (isEdge && (!geom || !(geom.w > 0) || !(geom.h > 0) ||
                     !Number.isFinite(geom.w) || !Number.isFinite(geom.h))) {
        isEdge = false;
        geom = (p.mirror && p.polys) ? _mirrorGeom({ polys: p.polys, bbox: bbox.slice(),
          w: p.w, h: p.h }) : null;
      }
      const usePolys = geom ? geom.polys : p.polys;
      const useBbox  = geom ? geom.bbox  : bbox;
      // Pack dims: ONLY adopt the oriented-geom dims when an orientation that
      // actually changes geometry is active (EDGE pre-rotate OR mirror). For a
      // plain native part (no EDGE, no mirror) fall back to the integer-rounded
      // p.w/p.h exactly as the pre-feature code did, so baseline packing stays
      // byte-identical (geom.w is a 2-decimal value, e.g. 599.65 vs old 600 →
      // sub-mm drift would alter daily nesting layouts). (regression fix 2026-06-26)
      const _geomActive = (isEdge || p.mirror) && geom;
      const useW     = (_geomActive && geom.w > 0) ? geom.w : p.w;
      const useH     = (_geomActive && geom.h > 0) ? geom.h : p.h;
      let rots = isEdge          ? [0, 180]
               : (p.grain === 'H') ? [0, 180]
               : (p.grain === 'V') ? [90, 270]
               :                     [0, 90, 180, 270];
      // Fix V / Fix H orientation lock (เอ๋ 2026-06-10). Each is a comma-list of
      // mm values matched ±3mm against the part's two sides; size unchanged, only
      // rotation. Fix V = those value(s) become the HEIGHT (vertical extent: p.h
      // at 0/180, p.w at 90/270). Fix H = those value(s) become the WIDTH. Prefer
      // NO rotation when the target side already matches. Fix V wins if both hit;
      // no match on either → keep the grain rots.
      const tol = 3;
      if (p.fixHeights && p.fixHeights.length &&
          (p.fixHeights.some(v => Math.abs(p.h - v) <= tol) || p.fixHeights.some(v => Math.abs(p.w - v) <= tol))) {
        rots = p.fixHeights.some(v => Math.abs(p.h - v) <= tol) ? [0, 180] : [90, 270];
      } else if (p.fixWidths && p.fixWidths.length) {
        if (p.fixWidths.some(v => Math.abs(p.w - v) <= tol))      rots = [0, 180];   // width already horizontal
        else if (p.fixWidths.some(v => Math.abs(p.h - v) <= tol)) rots = [90, 270];  // rotate so it's the width
      }
      for (let i = 0; i < p.qty; i++) {
        pieces.push({
          code: p.code,
          w: useW,
          h: useH,
          rots: rots,
          polys: usePolys,
          bbox: useBbox,
          thickness: p.thickness,
          grain: String(p.grain || 'ANY').toUpperCase(),   // for remnant grain-fit gating
          // EDGE marker carried through pack→render→export. The geometry is
          // already pre-rotated, so render/export need no extra rotation; this
          // is here for grain-fit gating + future/debug reference. (2026-06-25)
          grainAngle: isEdge ? p.grainAngle : null,
          _origGrainAngle: isEdge ? p.grainAngle : null,
          // Orientation flags carried for grain-fit gating + the post-pack
          // FLIP180 placement-rotation pass below. (Rotate-180 + Mirror 2026-06-26)
          flip180: !!p.flip180,
          _mirrorActive: !!p.mirror,
        });
      }
    }
    return pieces;
  }

  // opts (optional, AUTO path only): { downsize:true, allowKeys:Set } carries the
  // last-partial-sheet downsize INTENT + the user's original enabled size-set as
  // explicit PARAMETERS rather than via the S.optDownsizePass/optDownsizeAllowKeys
  // flags. The flags were set right before this call and reset on the very next
  // line by the orchestrator; passing the intent as an argument means the downsize
  // still fires correctly even if this function later becomes async or grows an
  // `await` before the downsize line (a racing reset could otherwise clear the
  // flag first). Flags are still read as a fallback so the Manual path + any other
  // caller are unaffected. (downsize gate race fix เอ๋ 2026-06-26)
  function _runNesting(opts) {
    S.previewCode = null;   // running shows the nest result, not a part preview
    S.loadedJobStale = null;   // a fresh run supersedes any outdated loaded job
    S.optChosen = false;   // a manual/normal run is NOT auto-chosen (badge off)
    // Expand parts into per-instance pieces (qty copies each) and
    // restrict rotations by grain (H = no 90/270, V = no 0/180,
    // ANY = all four).
    const pieces = _buildNestPieces();
    if (pieces.length === 0) {
      alert('No parts to nest — check selection / DXF loading status.');
      return;
    }
    // Skip zero-sized stock rows (the always-present empty 4th row,
    // or any row the user blanked out). Preserve order = priority.
    const activeStock = S.sheetStock.filter(s => s.enabled !== false && s.w > 0 && s.h > 0 && (s.qty !== 0 || s.qty === -1));
    if (activeStock.length === 0) {
      alert('No usable sheet stock — fill in at least one row with W, H and qty.');
      return;
    }

    // เอ๋ 2026-06-10: ask per-run whether THIS run's leftover offcuts should be
    // remembered in the Remnants library when the nest is saved. Fresh choice
    // every Run. OUTPUT saving — unrelated to the Stock modal's "Use remnants in
    // next run" (INPUT) toggle. Asked only after both validations pass (a no-op
    // Run never prompts) and BEFORE the packing computation starts.
    S.rememberRemnants = confirm(
      'Remember remnants (offcuts) from this run?\n\n' +
      'OK — when you Save Nest, leftover offcuts are saved to your Remnants library.\n' +
      'Cancel — this run\'s offcuts are not saved.'
    );

    // Group pieces by thickness so a 0.8mm BM part can't get nested
    // onto a 1mm stock sheet (and vice versa). User 2026-05-28 asked
    // for thickness per stock row precisely so the cut shop doesn't
    // mix gauges. Stock is filtered per group — a row with
    // thickness=1 only takes thickness=1 pieces. Pieces whose
    // thickness has no matching stock row land in 'unplaced'.
    // thickKey / _remnantStockForThick / _grainFits are now module-scope helpers
    // (_thickKey etc.) shared with the auto-optimizer. (เอ๋ 2026-06-26)
    const thickKey = _thickKey;
    const byThick = new Map();
    for (const piece of pieces) {
      const k = thickKey(piece.thickness);
      if (!byThick.has(k)) byThick.set(k, []);
      byThick.get(k).push(piece);
    }

    const allSheets = [];
    const allUnplaced = [];
    let _grainSkippedRemnants = 0;   // count offcuts a grain clash kept out of a group
    for (const [tk, group] of byThick) {
      const stockForThick = activeStock.filter(s => thickKey(s.thickness ?? 1) === tk);
      // ── SCRAP-FIRST pre-pass (เอ๋ 2026-06-11 "ผมให้ใช้เศษด้วย ทำไมไม่เห็นใช้
      // เลย"). The old gate kept an offcut only when EVERY directional piece in
      // the whole thickness group matched its grain — one V part in the BOM
      // banned an H offcut outright, so remnants were never used on real mixed
      // jobs. Now each offcut gets its own mini-nest of ONLY the compatible
      // pieces (grain fits — a V part can never land on an H offcut); whatever
      // fits is committed to the offcut and removed from the main pool, the
      // rest continue onto fresh stock. Offcut with NO compatible piece →
      // counted for the review banner as before.
      let pool = group;
      if (!S.skipRemnants) {
        for (const rm of _remnantStockForThick(tk)) {
          const compat = pool.filter(pc => _grainFits(pc.grain, rm.grain, pc.grainAngle));
          if (!compat.length) { _grainSkippedRemnants++; continue; }
          const rr = _nestMultiSheet(compat, [{ ...rm, qty: 1 }], S.gap, S.mode);
          const sheet = (rr.sheets || [])[0];
          if (!sheet || !sheet.placements.length) continue;   // nothing fit this offcut
          // Original remnant stays in the pool (not auto-deleted — the worker
          // removes it after cutting); auto-save skips fromRemnant sheets (no
          // offcut-of-an-offcut).
          allSheets.push({ ...sheet, thick: tk, fromRemnant: rm._remnantId });
          // Remove the placed instances from the main pool (count per code —
          // same-code instances are interchangeable).
          const used = new Map();
          for (const pl of sheet.placements) used.set(pl.code, (used.get(pl.code) || 0) + 1);
          pool = pool.filter(pc => {
            const left = used.get(pc.code) || 0;
            if (left > 0) { used.set(pc.code, left - 1); return false; }
            return true;
          });
        }
      }
      if (!pool.length) continue;
      if (stockForThick.length === 0) {
        allUnplaced.push(...pool);
        continue;
      }
      const r = _nestMultiSheet(pool, stockForThick, S.gap, S.mode);
      for (const s of r.sheets) {
        allSheets.push({ ...s, thick: tk, fromRemnant: null });
      }
      allUnplaced.push(...r.unplaced);
    }
    // FLIP180 post-pack pass: rotate every flip180 placement by an extra 180°
    // IN PLACE. A 180° turn never swaps the footprint w↔h, so the piece still
    // fits the exact slot the packer chose — only its orientation flips. The
    // placement transform (sheet draw + DXF export) reads pl.rot, so the cut
    // part and the preview both reflect the flip. Stays in {0,90,180,270} (the
    // four exact values transform() handles). (Rotate-180 + Mirror 2026-06-26)
    for (const s of allSheets) {
      for (const pl of (s.placements || [])) {
        // bbox-mode placements only: the True-Shape raster packer already BAKED
        // the flip into the packed orientation (_flipBaked) so it reserved the
        // correct slot — re-adding 180 here would double-flip + re-introduce the
        // overlap. bbox modes don't bake it (flip in place is safe for a bbox).
        if (pl.flip180 && !pl._flipBaked) pl.rot = (((pl.rot || 0) + 180) % 360 + 360) % 360;
      }
    }
    const result = { sheets: allSheets, unplaced: allUnplaced };
    S.flatSheets = result.sheets.map(s => ({
      thick: s.thick,
      sw: s.sw, sh: s.sh, placements: s.placements,
      fromRemnant: s.fromRemnant || null,
    }));
    S.currentSheetIdx = 0;
    S.unplaced = result.unplaced || [];
    S.costStale = false;   // fresh run → Total Cost is current again (drops the dim + hint)
    // AUTO path only: try to swap the LAST partial fresh sheet for the cheapest
    // enabled size its parts still fit on (lowers Total Cost; no-op if nothing
    // cheaper fits). Runs BEFORE _rectifyLastSheet so the leftover-rectangle is
    // computed on the final (downsized) size. Manual runs never set this flag.
    // Downsize INTENT comes from the explicit arg first (race-proof), falling back
    // to the legacy flags so the Manual path + any other caller are unchanged.
    const _doDownsize = opts ? !!opts.downsize : !!S.optDownsizePass;
    const _downsizeAllow = opts ? (opts.allowKeys || null) : (S.optDownsizeAllowKeys || null);
    if (_doDownsize) _downsizeLastFreshSheet(_downsizeAllow);
    // _tightenSheets(S.gap);   // TEMP-DISABLED 2026-06-27: live run hit >106s (reproduction was ~1.1s) — investigating the discrepancy before re-enabling. Function stays defined but inert.
    _rectifyLastSheet();   // last-sheet rectangular remnant (may move pieces + auto-jump)
    // How many saved offcuts a grain clash kept out of this run — drives the
    // review banner so the worker knows a leftover was skipped (not silently).
    S.grainSkippedRemnants = _grainSkippedRemnants;
    if (S.unplaced.length) {
      console.warn('[kdNest] unplaced pieces:', S.unplaced);
    }
    _refreshView();
    // Last-sheet leftover can run either way → let เอ๋ see both and pick.
    if (S.rectLeftover && S._rectPendingIdx >= 0) _openRectDirModal(S._rectPendingIdx);
    // Offcut remembering moved to 💾 Save Nest (เอ๋ 2026-06-10 'ถ้าจะ save ให้มา
    // save ที่ save Project') — a test Run no longer touches the shared
    // remnant pool; only an explicitly saved nest does.
  }

  // ── AUTO COST-OPTIMIZE orchestrator (เอ๋ 2026-06-26) ────────────────────────
  // The Run button's DEFAULT entry. Auto-finds the CHEAPEST enabled sheet-size
  // mix (by each size's prc) — may MIX sizes — then renders the winner via the
  // normal full path (_runNesting). Manual toggle ON → run as-is, no trials.
  let _optRunning = false;   // guard against double-clicks during the async trials
  async function _runNestingAuto() {
    // MANUAL path = today's exact behavior. Untouched.
    if (S.optManual) { _runNesting(); return; }
    if (_optRunning) return;

    // Build pieces + validate up front (same checks the normal run does) so a
    // no-op run never spins / prompts.
    const pieces = _buildNestPieces();
    if (pieces.length === 0) {
      alert('No parts to nest — check selection / DXF loading status.');
      return;
    }
    const activeStock = S.sheetStock.filter(s => s.enabled !== false && s.w > 0 && s.h > 0 && (s.qty !== 0 || s.qty === -1));
    if (activeStock.length === 0) {
      alert('No usable sheet stock — fill in at least one row with W, H and qty.');
      return;
    }

    _optRunning = true;
    _setRunBtnBusy(true);
    // Yield once so the browser paints the "Optimizing…" state before the
    // (synchronous-per-trial) packing work begins.
    await _yield();

    // Cheap scoring mode for trials; render the WINNER in full mode after.
    // 'MaxRects' = single cheap pass (research: ~5x cheaper than Desktop).
    const TRIAL_MODE = 'MaxRects';

    // Group the SELECTED pieces by thickness (same keying as _runNesting).
    const byThick = new Map();
    for (const piece of pieces) {
      const k = _thickKey(piece.thickness);
      if (!byThick.has(k)) byThick.set(k, []);
      byThick.get(k).push(piece);
    }

    // The chosen stock config we will WRITE back onto S.sheetStock before the
    // final run: per row index → {enabled, qty}. Rows not for an optimized
    // thickness keep their current settings. We only ever set enabled/qty.
    const chosen = new Map();   // rowIndex → {enabled, qty}
    let anyOptimized = false;
    let anyInfeasible = false;

    for (const [tk, group] of byThick) {
      // Rows for THIS thickness, with their real index in S.sheetStock so we can
      // write the winner back. Only enabled, sized, non-zero-qty rows.
      const rows = [];
      S.sheetStock.forEach((s, i) => {
        if (s.enabled === false) return;
        if (!(s.w > 0 && s.h > 0)) return;
        if (s.qty === 0) return;
        if (_thickKey(s.thickness ?? 1) !== tk) return;
        rows.push({ i, s });
      });
      if (rows.length === 0) continue;           // no fresh stock for this thickness — leave to _runNesting (→ unplaced)
      if (rows.length === 1) continue;           // single size: nothing to optimize, current settings stand

      // POST-remnant fresh pool (remnants free/excluded from cost).
      const pool = _remnantPrepass(group, tk, TRIAL_MODE);
      if (!pool.length) continue;                // everything fit on offcuts — no fresh cost decision

      // price-by-size lookup for scoring.
      const priceBySize = {};
      for (const { s } of rows) {
        const key = `${Math.round(s.w)}x${Math.round(s.h)}`;
        priceBySize[key] = (s.prc || 0) || _getPriceDefault(s.w, s.h, s.label);
      }
      // Real finite qty cap per size (−1 = unlimited).
      const capBySize = {};
      for (const { s } of rows) {
        const key = `${Math.round(s.w)}x${Math.round(s.h)}`;
        capBySize[key] = (s.qty === -1) ? Infinity : (s.qty | 0);
      }

      // Build trial stock sets. For a trial each "enabled" size gets qty = its
      // real cap (or a generous unlimited for the trial when cap=Infinity); a
      // size left OUT of the trial is qty 0. A scenario is INFEASIBLE if the
      // packer needs more of a size than its real qty cap allows (caught by
      // _nestMultiSheet honoring the qty) → it leaves pieces unplaced → scored
      // out by _pickCheapestTrial.
      const TRIAL_UNLIMITED = 9999;
      const trialStock = (enabledKeys) => rows.map(({ s }) => {
        const key = `${Math.round(s.w)}x${Math.round(s.h)}`;
        const on = enabledKeys.has(key);
        const cap = capBySize[key];
        const qty = !on ? 0 : (cap === Infinity ? TRIAL_UNLIMITED : cap);
        return { ...s, qty };
      });
      const allKeys = rows.map(({ s }) => `${Math.round(s.w)}x${Math.round(s.h)}`);
      const uniqKeys = [...new Set(allKeys)];

      const scenarios = [];
      // (a) each single size alone
      for (const k of uniqKeys) scenarios.push({ name: k, keys: new Set([k]) });
      // (b) all-sizes mix
      if (uniqKeys.length > 1) scenarios.push({ name: 'mix-all', keys: new Set(uniqKeys) });

      // Run + score the primary scenarios (cheap mode), yielding between trials.
      const trials = [];
      for (const sc of scenarios) {
        const stock = trialStock(sc.keys);
        let res = null;
        try { res = _nestMultiSheet(pool.map(p => ({ ...p })), stock, S.gap, TRIAL_MODE); }
        catch (e) { res = null; }
        trials.push({ name: sc.name, keys: sc.keys, stock, result: res });
        await _yield();
      }

      let winner = _pickCheapestTrial(trials, priceBySize);

      // (c) 2-size combos ONLY as a fallback if NO scenario placed everything.
      if (!winner && uniqKeys.length >= 2) {
        const comboTrials = [];
        for (let a = 0; a < uniqKeys.length; a++) {
          for (let b = a + 1; b < uniqKeys.length; b++) {
            const keys = new Set([uniqKeys[a], uniqKeys[b]]);
            const stock = trialStock(keys);
            let res = null;
            try { res = _nestMultiSheet(pool.map(p => ({ ...p })), stock, S.gap, TRIAL_MODE); }
            catch (e) { res = null; }
            comboTrials.push({ name: `combo:${uniqKeys[a]}+${uniqKeys[b]}`, keys, stock, result: res });
            await _yield();
          }
        }
        winner = _pickCheapestTrial(comboTrials, priceBySize);
      }

      if (!winner) { anyInfeasible = true; continue; }   // nothing places everything for this thickness

      // Record the winning per-row enabled/qty for this thickness.
      anyOptimized = true;
      for (const { i, s } of rows) {
        const key = `${Math.round(s.w)}x${Math.round(s.h)}`;
        const on = winner.keys.has(key);
        chosen.set(i, { enabled: on ? (s.enabled !== false) : false, qty: s.qty });
      }
    }

    // If NOTHING could be optimized to a full placement (parts too big for any
    // enabled size, etc.), fall back to today's behavior so nothing breaks.
    if (!anyOptimized) {
      _optRunning = false;
      _setRunBtnBusy(false);
      S.optDownsizePass = false;   // no winner mix → no downsizing on the fallback run
      _runNesting();   // normal full run surfaces the unplaced as usual
      return;
    }

    // ── Apply the winning mix onto the real stock rows, persist, then render
    //    the FINAL layout via the normal full path ONCE in the user's mode.
    //    Snapshot the rows we touch so we can restore exactly afterwards (we
    //    only flip enabled to drop the losing sizes; qty is kept as the user's).
    const snapshot = new Map();
    for (const [i, cfg] of chosen) {
      snapshot.set(i, { enabled: S.sheetStock[i].enabled, qty: S.sheetStock[i].qty });
      S.sheetStock[i].enabled = cfg.enabled;
      // keep qty as the user set it (real cap) — the packer fills first size by
      // order then the next; the chosen ENABLED set is what makes the mix cheap.
    }
    _persistStock();

    // The downsize pass must see the sizes the USER originally enabled — NOT the
    // optimizer's temporary enabled flags (we just disabled the losing sizes
    // above, which would otherwise hide the cheaper downsize target from the
    // candidate loop). Build the allow-set from the pre-mutation snapshot plus
    // any rows we never touched (left at their own enabled flag). (fix เอ๋
    // 2026-06-26)
    const downsizeAllow = new Set();
    S.sheetStock.forEach((s, i) => {
      if (!(s.w > 0 && s.h > 0)) return;
      const wasEnabled = snapshot.has(i) ? (snapshot.get(i).enabled !== false)
                                         : (s.enabled !== false);
      if (wasEnabled) downsizeAllow.add(`${Math.round(s.w)}x${Math.round(s.h)}`);
    });

    // Pass the downsize intent + allow-set as EXPLICIT ARGS — the authoritative,
    // race-proof channel. The flags are kept in sync only as a legacy fallback for
    // any other reader; they are NOT what drives this call, so the reset below can
    // never win a race against the downsize line inside _runNesting (which is what
    // would silently skip the downsize if _runNesting ever awaited). (fix เอ๋
    // 2026-06-26)
    S.optDownsizePass = true;
    S.optDownsizeAllowKeys = downsizeAllow;
    _runNesting({ downsize: true, allowKeys: downsizeAllow });   // full final render in S.mode (confirm + rect modal fire here, once)
    S.optDownsizePass = false;
    S.optDownsizeAllowKeys = null;
    S.optChosen = true;     // mark this result as auto-chosen → "Auto-chosen" badge

    // Restore the rows' enabled flags so the user's manual stock selection is
    // not silently mutated for the NEXT run (the winner already produced the
    // layout). qty was never changed. Persist the restore.
    for (const [i, snap] of snapshot) {
      S.sheetStock[i].enabled = snap.enabled;
      S.sheetStock[i].qty = snap.qty;
    }
    _persistStock();

    _optRunning = false;
    _setRunBtnBusy(false);
    _refreshView();         // re-render cost summary with the badge + restored rows
  }

  // Yield to the event loop so the UI thread can paint between trials (spinner
  // stays responsive, no freeze). rAF when available, else setTimeout(0).
  function _yield() {
    return new Promise(res => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => res());
      else setTimeout(res, 0);
    });
  }
  // Toggle the Run button's busy/"Optimizing…" state.
  function _setRunBtnBusy(busy) {
    const btn = S.rootEl && S.rootEl.querySelector('#kdnest-run');
    if (!btn) return;
    if (busy) {
      btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add('kdnest-btn-busy');
      btn.textContent = 'Optimizing…';
    } else {
      btn.disabled = false;
      btn.classList.remove('kdnest-btn-busy');
      if (btn.dataset.label) { btn.innerHTML = btn.dataset.label; delete btn.dataset.label; }
    }
  }

  // ── Grain-direction hatch ──────────────────────────────────────────
  // Thin parallel lines showing which way the grain runs, so a worker can read
  // the grain at a glance on the Part preview, the Sheet, and a Remnant
  // thumbnail (เอ๋ 2026-05-31 'ทำ Hatch ขีดบางๆ จะได้รู้ Grain ทิศทางไหน').
  // Grain hatch = ALWAYS HORIZONTAL lines (เอ๋ 2026-05-31 'Sheet จะเป็นเส้น
  // แนวนอนเสมอ และใน Preview ก็จะเป็นเส้นแนวนอนเสมอ ให้คุณ Rotate Part เอา').
  // The stock sheet's grain runs horizontally; a directional part is ROTATED to
  // align with it (the preview already rotates V parts 90°, the packer rotates
  // placements on the sheet). So the lines never change direction — only the
  // PART turns. Drawn only for directional grain (H or V); MIXED/ANY = none.
  // Function declarations → hoisted, usable everywhere in this IIFE.
  function _grainHatchCanvas(ctx, grain, x0, y0, x1, y1, colour, dpr, bold, grainAngle) {
    const g = String(grain || '').toUpperCase();
    if (g !== 'H' && g !== 'V' && g !== 'EDGE') return;   // directional only — MIXED/ANY draw nothing
    const d = dpr || 1;
    const step = 8 * d;
    ctx.save();
    // EDGE (angled grain): rotate the context about the region centre so the
    // always-horizontal hatch lines render at the chosen edge angle. The lines
    // are widened to cover the region after rotation. (angled-grain 2026-06-25)
    // Guard the angle: a non-finite grainAngle (bad CSV/RTDB value) would make
    // ctx.rotate(NaN) a no-op but must NEVER reach the scanline loop with NaN
    // bounds. Treat a bad angle as 0 so the hatch degrades to horizontal instead
    // of misrendering. (angled-grain hardening 2026-06-25)
    if (g === 'EDGE' && grainAngle != null && Number.isFinite(Number(grainAngle))) {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const diag = Math.hypot(x1 - x0, y1 - y0);   // big enough to span the rotated box
      ctx.translate(cx, cy);
      // Canvas Y is flipped vs DXF, so negate the angle to match the geometry.
      ctx.rotate(-Number(grainAngle) * Math.PI / 180);
      ctx.translate(-cx, -cy);
      x0 = cx - diag; x1 = cx + diag; y0 = cy - diag; y1 = cy + diag;
    }
    ctx.strokeStyle = colour;
    // ``bold`` = no steel silhouette behind the hatch (layer-"0" DXF, degenerate
    // outer → no fill). On the bare dark canvas the normal 0.5px/0.45a lines are
    // sub-pixel-faint = invisible (เอ๋ 2026-06-21 'ไม่มีเส้น hatch เลย' on
    // 2CN002-120024 / 2CN026-120000), so draw thicker + more opaque there. Parts
    // WITH a steel fill keep the subtle hatch they already had.
    ctx.lineWidth = bold ? Math.max(1, 1.1 * d) : Math.max(0.5, 0.5 * d);
    ctx.globalAlpha = bold ? 0.5 : 0.45;
    ctx.beginPath();
    // Bounds/step must be finite & step>0 or the loop never terminates — final
    // safety net behind the angle guard above. (angled-grain hardening 2026-06-25)
    if (Number.isFinite(x0) && Number.isFinite(x1) && Number.isFinite(y0) && Number.isFinite(y1) && step > 0) {
      for (let y = y0 + step; y < y1; y += step) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }  // always horizontal
    }
    ctx.stroke();
    ctx.restore();
  }
  function _grainHatchSvg(grain, x, y, w, h, colour) {
    const g = String(grain || '').toUpperCase();
    if (g !== 'H' && g !== 'V') return '';   // directional only
    const step = 6, lines = [];
    for (let yy = y + step; yy < y + h; yy += step) lines.push('<line x1="' + x.toFixed(1) + '" y1="' + yy.toFixed(1) + '" x2="' + (x + w).toFixed(1) + '" y2="' + yy.toFixed(1) + '"/>');  // always horizontal
    if (!lines.length) return '';
    return '<g stroke="' + colour + '" stroke-width="0.4" opacity="0.5">' + lines.join('') + '</g>';
  }

  // ════════════════════════════════════════════════════════════════════
  //  Single-part preview (desktop-style clear view + ↑/↓ keyboard nav)
  // ════════════════════════════════════════════════════════════════════
  // ── Clickable EDGE overlay (angled grain, milestone-1) ──────────────
  // An SVG layer pinned over the preview canvas. Every outer edge becomes a
  // clickable <line> (mapped through the SAME tx() the canvas drew with, so it
  // stays glued through re-render/resize). Hover shows the edge angle; the
  // currently-selected EDGE edge is highlighted. Clicking an edge calls
  // onEdgeClick(part, {angle}) → caller sets EDGE grain to that angle.
  // Holes are skipped; degenerate (<1mm) edges are skipped. (2026-06-25)
  function _attachEdgeClickLayer(canvas, part, onEdgeClick) {
    if (!canvas || !part) return;
    const wrap = canvas.parentElement;
    if (!wrap) return;
    // Remove any stale overlay (re-render rebuilds it fresh).
    wrap.querySelectorAll('.kdnest-edge-overlay').forEach(el => el.remove());
    const tx = canvas._kdPreviewTx;
    // EDGE preview rotates the SHAPE so the chosen edge is horizontal. The
    // canvas stashed the rotated outer loop + the rotation amount (grainAngle).
    // Position the clickable <line>s on the ROTATED geometry (so they glue to
    // the shape on screen), but map each edge's ORIGINAL absolute angle (=
    // on-screen angle + grainAngle) for the value we store on click — clicking
    // edge E then re-rotates the preview so E lands horizontal. For non-EDGE
    // parts (rotAmt == null) this is identity: original outer, no offset.
    // (angled-grain preview 2026-06-26)
    const rotAmt = canvas._kdPreviewEdgeRot;            // grainAngle, or null
    const mirrored = !!canvas._kdPreviewMirror;
    // The DISPLAYED outer differs from part.polys.outer when EDGE-rotated AND/OR
    // mirrored — use the stashed displayed outer in either case so the lines
    // glue to the on-screen shape. (Rotate-180 + Mirror preview 2026-06-26)
    const usingDisplayed = !!canvas._kdPreviewRotOuter && (rotAmt != null && Number.isFinite(Number(rotAmt)) || mirrored);
    const polys = usingDisplayed ? { outer: canvas._kdPreviewRotOuter } : part.polys;
    const angOffset = (rotAmt != null && Number.isFinite(Number(rotAmt))) ? Number(rotAmt) : 0;   // edge-rotated-screen → original angle
    if (typeof tx !== 'function' || !polys || !polys.outer || polys.outer.length < 2) return;
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (!(cssW > 0 && cssH > 0)) return;
    const SVGNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'kdnest-edge-overlay');
    svg.setAttribute('viewBox', `0 0 ${cssW} ${cssH}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    // Pin the SVG exactly over the canvas (wrap is position:relative). Using the
    // canvas's own box keeps the overlay aligned regardless of the warning
    // banners / canvas-top bar above it, and through resize (rebuilt each draw).
    svg.style.left = canvas.offsetLeft + 'px';
    svg.style.top = canvas.offsetTop + 'px';
    svg.style.width = cssW + 'px';
    svg.style.height = cssH + 'px';
    // Tooltip text element (top-left), updated on hover.
    const tip = document.createElementNS(SVGNS, 'text');
    tip.setAttribute('class', 'kdnest-edge-tip');
    tip.setAttribute('x', '8'); tip.setAttribute('y', '16');
    tip.textContent = 'Click an edge to run grain parallel to it';
    const sel = (part.grain === 'EDGE' && part.grainAngle != null) ? ((part.grainAngle % 180) + 180) % 180 : null;
    const pts = polys.outer;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if (!a || !b) continue;
      const dxw = b[0] - a[0], dyw = b[1] - a[1];
      if (Math.hypot(dxw, dyw) < 1) continue;   // skip degenerate <1mm edge
      // On-screen edge angle in the (possibly rotated / mirrored) geometry, [0,180).
      let screenAng = Math.atan2(dyw, dxw) * 180 / Math.PI;
      screenAng = ((screenAng % 180) + 180) % 180;
      // ORIGINAL absolute angle. The displayed shape = reflect_x(rotate(orig,
      // −grainAngle)) under the canonical order (EDGE then MIRROR). To recover
      // the original angle we undo each step: a left-right reflection maps a
      // line at angle θ to 180−θ, so un-reflect first (screen → 180−screen when
      // mirrored), THEN add back the EDGE rotation (angOffset = grainAngle).
      // For a plain part (no rot, no mirror) this is identity. (Rotate-180 +
      // Mirror preview 2026-06-26)
      const unMir = mirrored ? (180 - screenAng) : screenAng;
      const ang = (((unMir + angOffset) % 180) + 180) % 180;
      const [x0, y0] = tx(a[0], a[1]);
      const [x1, y1] = tx(b[0], b[1]);
      // Selected edge = the one whose ORIGINAL angle equals the stored grain
      // (after rotation it is the horizontal edge). Compare in original space.
      const isSel = (sel != null && Math.abs(((ang - sel) % 180 + 180) % 180) < 0.5);
      const line = document.createElementNS(SVGNS, 'line');
      line.setAttribute('x1', x0.toFixed(2)); line.setAttribute('y1', y0.toFixed(2));
      line.setAttribute('x2', x1.toFixed(2)); line.setAttribute('y2', y1.toFixed(2));
      line.setAttribute('class', 'kdnest-edge-line' + (isSel ? ' kdnest-edge-sel' : ''));
      line.dataset.angle = ang.toFixed(2);
      const label = 'Edge angle: ' + ang.toFixed(1) + '°' + (isSel ? '  (current grain)' : '');
      line.addEventListener('mouseenter', () => { tip.textContent = label; });
      line.addEventListener('mouseleave', () => { tip.textContent = 'Click an edge to run grain parallel to it'; });
      line.addEventListener('click', (e) => { e.stopPropagation(); onEdgeClick(part, { angle: ang }); });
      svg.appendChild(line);
    }
    svg.appendChild(tip);
    wrap.appendChild(svg);
  }

  // Draw ONE part filling the canvas — outer profile + holes + multi-piece
  // strokes — so the worker can read it clearly, like the desktop tool's
  // preview pane. (user 2026-05-30 'view part ชัดเจนเหมือน nest บน desktop')
  function _drawPartPreview(canvas, part, opts) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.width = canvas.clientWidth * dpr;
    const ch = canvas.height = canvas.clientHeight * dpr;
    // Theme-aware palette: paper + graphite ink in the Sketch theme so the
    // diecut reads like a drawing on paper; dark canvas + teal otherwise.
    // (เอ๋ 2026-05-31 'ให้เห็นแต่รูปชิ้นงาน ... theme เดียวกัน')
    const _theme = (typeof document !== 'undefined')
      ? document.documentElement.getAttribute('data-theme') : null;
    const _sketch = _theme === 'sketch';
    const _chalk = _theme === 'chalk';
    const _obsidian = _theme === 'obsidian';
    // BG = the ACTUAL surrounding background so the preview blends into the
    // workspace in every theme (เอ๋ 2026-05-31 'ในช่องการแสดงภาพ ให้พื้นหลัง
    // เป็นสีเดียวกับพื้นหลังโดยรอบ'). Read the computed bg of the canvas's
    // wrapper; transparent (theme reset) → fall back to <body>, then the
    // per-theme constant. INK/MUTED stay theme-based for contrast.
    const BG = _sketch ? '#efe7d6' : _chalk ? '#26302e' : _obsidian ? '#08090d' : '#0f1419';
    const INK = _sketch ? '#1b1815' : _chalk ? '#f4f1e8' : _obsidian ? '#e5c158' : '#4ecca3';
    const MUTED = _sketch ? '#6f6757' : _chalk ? '#9fb3ad' : _obsidian ? '#b0a790' : '#88aab1';
    // Opaque steel silhouette so the diecut reads as a real metal part, not a
    // washed-out outline (เอ๋ 2026-05-31 'dicut ขาวออก' — colour+'22' = ~13%
    // alpha was nearly invisible). Solid mid-grey on every theme.
    const STEEL = _sketch ? '#b9b2a2' : _chalk ? '#8f9991' : _obsidian ? 'rgba(229,193,88,0.35)' : 'rgba(78,204,163,0.40)';
    // Transparent mode (modal "show only the part" — เอ๋ 2026-05-31 'โชว์แค่พาร์ท
    // พื้นหลังไม่เอา'): clear instead of filling, so the page shows through and
    // only the silhouette + outline paint. The Nest workspace preview keeps the
    // solid BG (no opts) so it still blends with the workspace.
    if (opts && opts.transparent) {
      ctx.clearRect(0, 0, cw, ch);
    } else {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, cw, ch);
    }
    // EDGE (angled grain): the preview must look EXACTLY like the placed piece
    // on the sheet — grain ALWAYS horizontal per เอ๋'s rule ('grain ให้ preview
    // แนวนอนเท่านั้นตามกฎของเรา ฉะนั้นรูปต้องหมุนตามด้วย'). So instead of drawing
    // the part at native orientation and tilting the hatch, we pre-rotate the
    // GEOMETRY by -grainAngle (chosen edge → horizontal) using the SAME engine
    // helper the nester uses (_edgeRotatedGeom) and draw a plain horizontal
    // hatch. Non-EDGE parts (H/V/ANY/?) are untouched. (angled-grain preview
    // 2026-06-26)
    const _isEdgePreview = (part && part.grain === 'EDGE' && part.grainAngle != null &&
                            Number.isFinite(Number(part.grainAngle)) && part.polys);
    let _edgeGeom = null;
    if (_isEdgePreview) {
      _edgeGeom = _edgeRotatedGeom(part);
      // Defensive: a degenerate rotation (non-finite / non-positive dims) falls
      // back to native orientation so the preview never blanks. (hardening)
      if (!_edgeGeom || !(_edgeGeom.w > 0) || !(_edgeGeom.h > 0) ||
          !_edgeGeom.bbox || !_edgeGeom.bbox.every(Number.isFinite)) {
        _edgeGeom = null;
      }
    }
    // MIRROR (left-right flip): reflect the geometry AFTER EDGE pre-rotation, in
    // the displayed frame — the SAME canonical order the nester uses, so the
    // preview is byte-for-byte the cut part. Reflection about the bbox centre
    // keeps the extents identical. Non-mirror parts are untouched. (Rotate-180 +
    // Mirror preview 2026-06-26)
    let _baseGeom = _edgeGeom;
    if (part && part.mirror && (part.polys || _edgeGeom)) {
      const _src = _edgeGeom || {
        polys: part.polys, bbox: part.bbox && part.bbox.slice(),
        w: part.w, h: part.h,
      };
      if (_src.bbox) _baseGeom = _mirrorGeom(_src);
    }
    const polys = _baseGeom ? _baseGeom.polys : (part && part.polys);
    const bbox = _baseGeom ? _baseGeom.bbox : (part && part.bbox);
    if (!polys || !bbox) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${14 * dpr}px "Flux Architect", monospace`;
      ctx.fillStyle = MUTED;
      ctx.fillText(
        !part || !part.dxfError ? 'Loading DXF…'
          : part.dxfError === 'No DXF uploaded yet' ? '⚠ No DXF — drop a .dxf or open in Fusion'
          : '⚠ DXF failed to load — click ↻ retry',
        cw / 2, ch / 2);
      return;
    }
    const [minX, minY, maxX, maxY] = bbox;
    const pw0 = (maxX - minX) || 1, ph0 = (maxY - minY) || 1;
    // Rotate the preview to reflect the PLACED orientation (เอ๋ 2026-06-10 'ให้
    // preview ทำตามนั้น'). A FIX value locks which side is the height/width, so
    // preview THAT — same rule the nester uses. Else fall back to the direction
    // (V = runs vertical / 90°, H / ANY = native). (orig: 2026-05-30)
    // EDGE parts are ALREADY pre-rotated to horizontal above, so they take no
    // extra grot (the chosen edge is horizontal in `polys`). V/FIX grot only
    // applies to non-EDGE directional parts. (angled-grain preview 2026-06-26)
    let grot = (!_edgeGeom && part && part.grain === 'V') ? 90 : 0;
    if (part && !_edgeGeom) {
      const pw = part.w || pw0, ph = part.h || ph0, tol = 3;
      if (part.fixHeights && part.fixHeights.length) {           // a value → the HEIGHT
        if (part.fixHeights.some(v => Math.abs(ph - v) <= tol)) grot = 0;
        else if (part.fixHeights.some(v => Math.abs(pw - v) <= tol)) grot = 90;
      } else if (part.fixWidths && part.fixWidths.length) {      // a value → the WIDTH
        if (part.fixWidths.some(v => Math.abs(pw - v) <= tol)) grot = 0;
        else if (part.fixWidths.some(v => Math.abs(ph - v) <= tol)) grot = 90;
      }
    }
    // FLIP180: add 180° to the preview rotation — the SAME +180 the nester adds
    // to the placement, so the preview matches the cut part. 0→180, 90→270.
    // A 180° turn never swaps w↔h, so the footprint dims (fw/fh) are unchanged.
    // (Rotate-180 + Mirror preview 2026-06-26)
    if (part && part.flip180) grot = (grot + 180) % 360;
    const mapPt = (x, y) => {
      const u = x - minX, v = y - minY;
      // Match the engine/export placement transform()'s linear part for all four
      // exact rotations (0/90/180/270) so preview == sheet == DXF.
      if (grot === 90)  return [-v + ph0, u];
      if (grot === 180) return [pw0 - u, ph0 - v];
      if (grot === 270) return [v, pw0 - u];
      return [u, v];
    };
    const fw = (grot === 90 || grot === 270) ? ph0 : pw0;
    const fh = (grot === 90 || grot === 270) ? pw0 : ph0;
    // Padding around the part. The DXF preview modal passes a small pad so the
    // canvas hugs the silhouette and the download button sits right against it
    // (เอ๋ 2026-06-01 'ปุ่มดาวน์โหลดให้อยู่ชิด Part เลย'); the Nest workspace
    // preview keeps the roomy 44px default.
    const pad = (opts && typeof opts.pad === 'number' ? opts.pad : 44) * dpr;
    const scale = Math.min((cw - 2 * pad) / fw, (ch - 2 * pad) / fh);
    const drawW = fw * scale, drawH = fh * scale;
    const offX = (cw - drawW) / 2, offY = (ch - drawH) / 2;
    const tx = (x, y) => { const m = mapPt(x, y); return [offX + m[0] * scale, offY + (fh - m[1]) * scale]; };  // flip Y
    const colour = INK;
    const trace = (pts, close) => {
      ctx.beginPath();
      for (let k = 0; k < pts.length; k++) {
        const [ax, ay] = tx(pts[k][0], pts[k][1]);
        if (k === 0) ctx.moveTo(ax, ay); else ctx.lineTo(ax, ay);
      }
      if (close) ctx.closePath();
    };
    // Silhouette = the closed region we FILL (steel) + CLIP the grain hatch to.
    // Normally the OUTER loop. A layer-"0" DXF has a fragmented boundary that
    // didn't stitch (degenerate 2-pt outer), so we rebuild it. The parts เอ๋
    // flagged (2CN002-120024 / 2CN026-120000) are CONCAVE (V-notch / bowtie ends),
    // so a convex hull bled the fill into the notches — instead STITCH the open
    // boundary segments into the EXACT outline (drop the small closed loops =
    // drill holes first; they're what made the original stitch fail) so fill +
    // hatch never cross the perimeter (เอ๋ 2026-06-21 'fill ไม่ให้เกินเส้นรอบรูป').
    // Convex hull stays only as a last-resort fallback if stitching can't close.
    const outerOk = polys.outer && polys.outer.length > 2 && _polyArea(polys.outer) > 1;
    let sil;
    if (outerOk) {
      sil = polys.outer;
    } else {
      const all = (polys.strokes || []).filter(s => s && s.length >= 2);
      const bboxArea = bbox ? Math.abs((bbox[2] - bbox[0]) * (bbox[3] - bbox[1])) : 0;
      const isHoleLoop = (s) => {
        const closed = s.length > 2 && Math.hypot(s[0][0] - s[s.length - 1][0], s[0][1] - s[s.length - 1][1]) < 1.0;
        return closed && _polyArea(s) < Math.max(1, bboxArea * 0.05);   // small closed loop = drill hole
      };
      const boundary = all.filter(s => !isHoleLoop(s));
      sil = _stitchLoop(boundary, 1.0) || _stitchLoop(boundary, 3.0)
        || _convexHull([].concat(polys.outer || [], ...all));   // fallback: hull (may bleed on concave)
    }
    if (sil && sil.length > 2) {
      trace(sil, true);
      ctx.fillStyle = STEEL; ctx.fill();
      // Grain hatch — H/V only, always-horizontal lines (post-revert), clipped to
      // the silhouette so it reads as grain on the metal and never crosses the
      // edge. The preview is rotated so V parts run vertically (grot=90).
      if (part.grain === 'H' || part.grain === 'V' || part.grain === 'EDGE') {
        ctx.save(); trace(sil, true); ctx.clip();
        // EDGE: the SHAPE is already rotated so the chosen edge is horizontal —
        // so the grain hatch is plain HORIZONTAL (no angle), matching the sheet.
        // Pass grain 'H' for EDGE so _grainHatchCanvas draws flat horizontal
        // lines (the angle-rotate branch is bypassed). (angled-grain preview
        // 2026-06-26)
        const _hatchGrain = (part.grain === 'EDGE' && _edgeGeom) ? 'H' : part.grain;
        const _angle = (part.grain === 'EDGE' && !_edgeGeom) ? part.grainAngle : null;
        _grainHatchCanvas(ctx, _hatchGrain, offX, offY, offX + drawW, offY + drawH, INK, dpr, false, _angle);
        ctx.restore();
      }
    }
    // Crisp TRUE outline on top: stroke the real OUTER loop when it's proper. For
    // a reconstructed (hull) silhouette we do NOT stroke the hull — that would cut
    // across the rounded corners; the fragmented `strokes` below draw the real edge.
    if (outerOk) {
      ctx.strokeStyle = colour; ctx.lineWidth = 2.2 * dpr; trace(polys.outer, true); ctx.stroke();
    }
    if (polys.strokes && polys.strokes.length > 1) {
      ctx.strokeStyle = colour; ctx.lineWidth = 1.6 * dpr;
      for (const seg of polys.strokes) { if (seg.length >= 2) { trace(seg, false); ctx.stroke(); } }
    }
    if (polys.holes && polys.holes.length) {
      ctx.strokeStyle = colour + 'cc'; ctx.lineWidth = 1.0 * dpr;
      for (const hole of polys.holes) { if (hole.length >= 2) { trace(hole, true); ctx.stroke(); } }
    }
    // Stash the DXF→CSS-pixel transform so the clickable EDGE overlay maps its
    // <line>s with the EXACT same geometry the canvas just drew (survives
    // re-render/resize — recomputed every draw). tx() is in DEVICE px; divide
    // by dpr for CSS px to match the SVG viewBox. (angled-grain 2026-06-25)
    canvas._kdPreviewTx = (x, y) => { const m = tx(x, y); return [m[0] / dpr, m[1] / dpr]; };
    canvas._kdPreviewPart = part;
    // Stash the EDGE-rotated geometry (or null) so the clickable edge overlay
    // positions its <line>s on the NOW-ROTATED shape via the same tx(), while
    // mapping clicks back to ORIGINAL angles (= on-screen angle + grainAngle).
    // (angled-grain preview 2026-06-26)
    canvas._kdPreviewEdgeRot = _edgeGeom ? part.grainAngle : null;
    // Use the DISPLAYED outer (EDGE-rotated AND/OR mirrored) so the clickable
    // <line>s glue to the shape on screen. The mirror flag lets the overlay
    // reflect each clicked edge's angle back to ORIGINAL space (a reflection
    // maps screen angle α → 180−α). (Rotate-180 + Mirror preview 2026-06-26)
    canvas._kdPreviewRotOuter = (_edgeGeom || (part && part.mirror)) ? polys.outer : null;
    canvas._kdPreviewMirror = !!(part && part.mirror);
  }

  // EDGE overlay click → lock this part's grain parallel to the clicked edge.
  // Clicking the ALREADY-selected edge again clears EDGE back to '?' (toggle).
  // Persists via _setPartEdgeGrain then re-renders so the hatch + highlight
  // update. (angled-grain feature 2026-06-25)
  function _onEdgeClick(part, edge) {
    if (!part || !edge) return;
    const a = ((edge.angle % 180) + 180) % 180;
    const cur = (part.grain === 'EDGE' && part.grainAngle != null) ? ((part.grainAngle % 180) + 180) % 180 : null;
    const same = (cur != null && Math.abs(((cur - a) % 180 + 180) % 180) < 0.5);
    _setPartEdgeGrain(part, same ? null : a).then(() => {
      _setPreview(part.code);   // redraw preview (hatch at new angle) + keep scroll
    });
  }

  function _scrollPreviewRow() {
    if (!S.rootEl || !S.previewCode) return;
    const row = S.rootEl.querySelector('.kdnest-part[data-code="' + (window.CSS && CSS.escape ? CSS.escape(S.previewCode) : S.previewCode) + '"]');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
  // Brief attention pulse on the active row after a keyboard ↑/↓ move so the user
  // always sees WHICH row they're on — motion + glow, theme-agnostic (sketch/chalk
  // drop the active border, so the resting tint alone blends into amber grain-warn
  // rows). The persistent active style stays subtle so text isn't buried. (เอ๋
  // 2026-06-26 'กด keyboard ขึ้นลงแต่ไม่รู้อยู่แถวไหน ให้มี Hilight หรือ effect ด้วย')
  function _pulseActiveRow() {
    if (!S.rootEl || !S.previewCode) return;
    const row = S.rootEl.querySelector('.kdnest-part[data-code="' + (window.CSS && CSS.escape ? CSS.escape(S.previewCode) : S.previewCode) + '"]');
    if (!row) return;
    row.classList.remove('kdnest-part-navpulse');
    void row.offsetWidth;   // reflow → restart the animation on every move
    row.classList.add('kdnest-part-navpulse');
    setTimeout(() => row.classList.remove('kdnest-part-navpulse'), 750);
  }
  function _setPreview(code) {
    // Keep the part-list scroll where it is — the user clicked 👁 (or the grain
    // glyph) ON a row that's already in view, so the re-render must NOT yank the
    // list back to the top (เอ๋ 2026-06-21 'กด 👁 แล้วลิสต์เด้งขึ้นบนสุด ต้อง scroll
    // กลับลงมาทุกที'). Reuses the same keep-scroll re-render as ↻ Re-resolve.
    // (Keyboard ↑/↓ uses _movePreview → _scrollPreviewRow to bring the newly
    // selected row into view — that path is unchanged.)
    S.previewCode = code;
    _refreshViewKeepScroll();
  }
  function _movePreview(delta) {
    if (!S.parts.length) return;
    let idx = S.parts.findIndex(p => p.code === S.previewCode);
    if (idx < 0) idx = (delta > 0 ? -1 : 0);
    idx = Math.max(0, Math.min(S.parts.length - 1, idx + delta));
    S.previewCode = S.parts[idx].code;
    _refreshView();
    _scrollPreviewRow();
    _pulseActiveRow();   // brief attention pulse on the row we landed on (keyboard nav)
  }
  // Sheet index of the first placement of `code`. Module-scoped twin of the
  // findSheetIdx() local inside _refreshView so the keyboard nav below can
  // reach it. -1 = not placed on any sheet yet.
  function _sheetIdxOf(code) {
    for (let i = 0; i < S.flatSheets.length; i++) {
      if (S.flatSheets[i].placements.some(pl => pl.code === code)) return i;
    }
    return -1;
  }
  // ↑/↓ while a part is highlighted on its sheet (📍 View@sheet): step to the
  // prev/next PLACED part, jump to its sheet, and re-highlight — so the worker
  // can browse where each part landed without leaving the sheet view (user
  // 2026-05-30 'Part@sheet ใช้ Keyboard ขึ้นลงได้เหมือนกัน'). Skips parts not
  // yet placed; clamps at the ends like _movePreview.
  function _moveOnSheet(delta) {
    if (!S.parts.length || !S.flatSheets.length) return;
    let idx = S.parts.findIndex(p => p.code === S.highlightCode);
    if (idx < 0) idx = (delta > 0 ? -1 : S.parts.length);
    let next = -1;
    for (let step = idx + delta; step >= 0 && step < S.parts.length; step += delta) {
      if (_sheetIdxOf(S.parts[step].code) >= 0) { next = step; break; }
    }
    if (next < 0) return;  // no placed part in that direction — stay put
    const code = S.parts[next].code;
    S.highlightCode = code;
    S.currentSheetIdx = _sheetIdxOf(code);
    _refreshView();
    // Keep the glow lit while browsing; re-arm the same 3.5s auto-clear the
    // 📍 button uses so it fades a few seconds after the last keypress.
    clearTimeout(window.__kdNestHighlightTO);
    window.__kdNestHighlightTO = setTimeout(() => { S.highlightCode = null; _refreshView(); }, 3500);
  }

  // ════════════════════════════════════════════════════════════════════
  //  Canvas render
  // ════════════════════════════════════════════════════════════════════
  function _drawSheet(canvas, sheet) {
    if (!canvas || !sheet) return;
    const ctx = canvas.getContext('2d');
    const cw = canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
    const ch = canvas.height = canvas.clientHeight * (window.devicePixelRatio || 1);
    const pad = 20 * (window.devicePixelRatio || 1);
    const scale = Math.min(
      (cw - 2 * pad) / sheet.sw,
      (ch - 2 * pad) / sheet.sh
    );
    // Center the sheet on the canvas.
    const offX = (cw - sheet.sw * scale) / 2;
    const offY = (ch - sheet.sh * scale) / 2;
    // Clear — outer canvas bg = the ACTUAL surrounding workspace bg so the
    // sheet view blends in like the part preview does (เอ๋ 2026-05-31 'พื้นหลัง
    // เป็นสีเดียวกับพื้นหลังโดยรอบ' · 'อันนี้ด้วย' · 'pencil & chalk ยังไม่เปลี่ยน').
    // DEFAULT must be PER-THEME (sketch=paper, chalk=board, else dark) — the
    // theme reset wipes the wrapper's bg → computed read returns transparent →
    // without a themed default the sheet stayed dark on the light sketch/chalk
    // workspace. The computed read still wins when it yields a real colour.
    const _stheme = (typeof document !== 'undefined')
      ? document.documentElement.getAttribute('data-theme') : null;
    const _outerBG = _stheme === 'sketch' ? '#efe7d6'
      : _stheme === 'chalk' ? '#26302e'
      : _stheme === 'obsidian' ? '#08090d' : '#0f1419';
    ctx.fillStyle = _outerBG;
    ctx.fillRect(0, 0, cw, ch);
    // Sheet outline
    ctx.strokeStyle = '#2a5dff';
    ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
    ctx.strokeRect(offX, offY, sheet.sw * scale, sheet.sh * scale);
    // Sheet grain hatch — ALWAYS faint HORIZONTAL lines across the whole sheet
    // (เอ๋ 2026-05-31 'ที่ Sheet ให้โชว์ Hatch แนวนอนบางๆ (Grain)'). A stock
    // sheet's grain runs horizontal by convention, regardless of which parts
    // land on it — so this is unconditional (not gated on _sheetGrain, which
    // would skip MIXED/ANY). Directional parts are rotated to align; the sheet
    // grain itself never turns. Drawn UNDER the parts so the part fills sit on top.
    {
      const _hatchInk = _stheme === 'sketch' ? 'rgba(60,50,40,0.45)'
        : _stheme === 'chalk' ? 'rgba(220,230,225,0.35)'
        : _stheme === 'obsidian' ? 'rgba(229,193,88,0.25)' : 'rgba(150,170,190,0.32)';
      const _dpr = window.devicePixelRatio || 1;
      const _step = 11 * _dpr;
      const _x1 = offX + sheet.sw * scale, _y1 = offY + sheet.sh * scale;
      ctx.save();
      ctx.beginPath();
      ctx.rect(offX, offY, sheet.sw * scale, sheet.sh * scale);
      ctx.clip();
      ctx.strokeStyle = _hatchInk;
      ctx.lineWidth = Math.max(0.5, 0.5 * _dpr);
      ctx.beginPath();
      for (let y = offY + _step; y < _y1; y += _step) { ctx.moveTo(offX, y); ctx.lineTo(_x1, y); }
      ctx.stroke();
      ctx.restore();
    }
    // Each placement
    const palette = ['#4ecca3', '#ffa726', '#e74c3c', '#9b59b6',
                     '#3498db', '#f1c40f', '#1abc9c', '#e67e22',
                     '#16a085', '#c0392b'];
    // Same part code -> same colour, stable across every sheet
    // (user 2026-05-30 'Part เดียวกัน สีเดียวกัน').
    const codeColour = {};
    { let ci = 0; (S.flatSheets && S.flatSheets.length ? S.flatSheets : [sheet]).forEach(function (sh) {
        sh.placements.forEach(function (p) { if (!(p.code in codeColour)) { codeColour[p.code] = palette[ci % palette.length]; ci++; } });
      }); }
    const dpr = window.devicePixelRatio || 1;
    const labels = [];   // drawn in a 2nd pass (on top of shapes + clustered)
    sheet.placements.forEach(function (pl, i) {
      const colour = codeColour[pl.code] || palette[i % palette.length];
      const isHighlight = (S.highlightCode && pl.code === S.highlightCode);
      // Sheet coords → canvas coords (flip Y because DXF is y-up).
      function toCanvas(x, y) {
        return [offX + x * scale, offY + (sheet.sh - y) * scale];
      }
      const w = (pl.rot === 90 || pl.rot === 270) ? pl.h : pl.w;
      const h = (pl.rot === 90 || pl.rot === 270) ? pl.w : pl.h;
      const [cx, cy] = toCanvas(pl.x, pl.y + h);

      // Transform a DXF point through the rotation + translation to
      // canvas pixels. Shared by outer + holes so the polygon stays
      // glued together however rot/pos changes.
      const bMinX = pl.bbox ? pl.bbox[0] : 0;
      const bMinY = pl.bbox ? pl.bbox[1] : 0;
      function transform(px, py) {
        let lx = px - bMinX, ly = py - bMinY;
        if (pl.rot === 90)  { const t = lx; lx = -ly + pl.h;  ly = t; }
        if (pl.rot === 180) { lx = pl.w - lx; ly = pl.h - ly; }
        if (pl.rot === 270) { const t = lx; lx = ly;          ly = pl.w - t; }
        return toCanvas(pl.x + lx, pl.y + ly);
      }

      const havePoly = pl.polys && pl.polys.outer && pl.polys.outer.length > 1;
      if (havePoly) {
        // Real outer profile — what the user 2026-05-28 asked for:
        // 'ไม่เอา กรอบ 4 สี่เหลี่ยม เอาเป็นรูปจริงของชิ้นงาน'.
        // Filled translucent + outlined; highlight thickens the stroke
        // and washes a brighter glow under it.
        ctx.beginPath();
        for (let k = 0; k < pl.polys.outer.length; k++) {
          const [ax, ay] = transform(pl.polys.outer[k][0], pl.polys.outer[k][1]);
          if (k === 0) ctx.moveTo(ax, ay); else ctx.lineTo(ax, ay);
        }
        ctx.closePath();
        ctx.fillStyle = colour + (isHighlight ? '55' : '22');
        ctx.fill();
        if (isHighlight) {
          ctx.save();
          ctx.shadowColor = '#fff';
          ctx.shadowBlur = 14 * dpr;
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 4 * dpr;
          ctx.stroke();
          ctx.restore();
        }
        ctx.strokeStyle = colour;
        ctx.lineWidth = (isHighlight ? 2.5 : 1.2) * dpr;
        ctx.stroke();
      } else {
        // Fallback: draw the bbox rectangle. Only happens when the DXF
        // had no parseable outer loop (rare — mostly very old files).
        ctx.beginPath();
        ctx.rect(cx, cy, w * scale, h * scale);
        ctx.fillStyle = colour + (isHighlight ? '55' : '22');
        ctx.fill();
        if (isHighlight) {
          ctx.save();
          ctx.shadowColor = '#fff';
          ctx.shadowBlur = 14 * dpr;
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 4 * dpr;
          ctx.stroke();
          ctx.restore();
        }
        ctx.strokeStyle = colour;
        ctx.lineWidth = (isHighlight ? 2.5 : 1.2) * dpr;
        ctx.stroke();
      }

      // Holes (INTERIOR_PROFILES) — outlines so the user can see
      // drilled openings without confusing them for cut paths.
      if (pl.polys && pl.polys.holes && pl.polys.holes.length) {
        ctx.strokeStyle = colour + 'aa';
        ctx.lineWidth = 0.6 * dpr;
        for (const hole of pl.polys.holes) {
          if (hole.length < 2) continue;
          ctx.beginPath();
          for (let k = 0; k < hole.length; k++) {
            const [ax, ay] = transform(hole[k][0], hole[k][1]);
            if (k === 0) ctx.moveTo(ax, ay); else ctx.lineTo(ax, ay);
          }
          ctx.stroke();
        }
      }
      // Multi-piece outer strokes — parts like BK1DN1-120000 whose
      // outer profile is a chain of separate LINE + SPLINE entities
      // (no single LWPOLYLINE). The single ``outer`` poly we drew
      // above caught only one segment; this stroke pass paints the
      // rest so the user sees the complete outline. Skipped when
      // outer is the single polyline (havePoly is enough on its own).
      if (pl.polys && pl.polys.strokes && pl.polys.strokes.length > 1) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = (isHighlight ? 2.2 : 1.0) * dpr;
        for (const seg of pl.polys.strokes) {
          if (seg.length < 2) continue;
          ctx.beginPath();
          for (let k = 0; k < seg.length; k++) {
            const [ax, ay] = transform(seg[k][0], seg[k][1]);
            if (k === 0) ctx.moveTo(ax, ay); else ctx.lineTo(ax, ay);
          }
          ctx.stroke();
        }
      }

      // Collect label info; drawn in a 2nd pass so labels sit on top of
      // every shape and nearby same-code small parts can merge.
      const drawW = w * scale, drawH = h * scale;
      labels.push({
        i: i, code: pl.code, isHighlight: isHighlight,
        small: (Math.min(w, h) <= 90 || (w * h) <= 90000),
        lx: cx + drawW / 2, ly: cy + drawH / 2,
        sx: pl.x + w / 2, sy: pl.y + h / 2,
        fits: drawW > 60 * dpr && drawH > 14 * dpr,
      });
    });

    // Last-sheet rectangular remnant overlay (เอ๋ 2026-06-11): a green dashed box
    // over the leftover rectangle, only on the sheet that carries it. Uses the
    // same offX/offY/scale + y-flip as the sheet outline (top-left corner = the
    // rect's top edge → sheet.sh - (y+h)).
    if (sheet.lastRemnantRect && sheet.lastRemnantRect.w > 0) {
      const rr = sheet.lastRemnantRect;
      const rx = offX + rr.x * scale;
      const ry = offY + (sheet.sh - (rr.y + rr.h)) * scale;
      const rw = rr.w * scale, rh = rr.h * scale;
      ctx.save();
      ctx.strokeStyle = '#4ecca3';
      ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
      ctx.setLineDash([8 * (window.devicePixelRatio || 1), 6 * (window.devicePixelRatio || 1)]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(78,204,163,0.10)';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.fillStyle = '#4ecca3';
      ctx.font = (12 * (window.devicePixelRatio || 1)) + 'px "Flux Architect", monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('REMNANT ' + Math.round(rr.w) + '×' + Math.round(rr.h), rx + 6, ry + 6);
      ctx.restore();
    }

    // -- Label pass: merge same-code SMALL parts sitting close together
    // (user 2026-05-30 'รวม Label ... อยู่ใกล้กัน เฉพาะชิ้นเล็กๆ') so a row
    // of triangles reads 'CODE x6' once instead of six overlapping IDs.
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // Label ink: sketch theme has a light (cream) sheet → white text is
    // invisible, so use near-black ink. chalk/default sheets are dark → keep
    // the light ink. (user 2026-05-31 'theme pencil ให้ตัวอีกษรเป็นสีดำ')
    const _lblNorm = _stheme === 'sketch' ? '#1a1f26'
      : _stheme === 'obsidian' ? '#e5c158' : '#e8eef5';
    const _lblHot  = _stheme === 'sketch' ? '#000000'
      : _stheme === 'obsidian' ? '#ffffff' : '#fffce8';
    labels.forEach(function (L) {
      L.fp = (L.fits ? 11 : 9) * dpr;
      ctx.font = (L.isHighlight ? 'bold ' : '') + L.fp + 'px "Flux Architect", monospace';
      L.text = '#' + (L.i + 1) + ' ' + L.code;
      L.tw = ctx.measureText(L.text).width;
      L.th = L.fp * 1.25;
    });
    // Same-code labels whose TEXT BOXES overlap merge into one 'CODE xN'
    // (real font, no pill background). Union-find groups transitive
    // overlaps. (user 2026-05-30 'label รวม font จริงไม่ใช่ภาพ; เหมือนกัน
    // แล้วซ้อนทับ ให้รวม')
    const par = labels.map(function (_, i) { return i; });
    function _find(x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; }
    for (let a = 0; a < labels.length; a++) {
      for (let b = a + 1; b < labels.length; b++) {
        if (labels[a].code !== labels[b].code) continue;
        const A = labels[a], B = labels[b];
        if (Math.abs(A.lx - B.lx) < (A.tw + B.tw) / 2 + 2 * dpr &&
            Math.abs(A.ly - B.ly) < (A.th + B.th) / 2) { par[_find(a)] = _find(b); }
      }
    }
    const groups = {};
    labels.forEach(function (L, i) { const r = _find(i); (groups[r] = groups[r] || []).push(i); });
    Object.keys(groups).forEach(function (k) {
      const g = groups[k];
      if (g.length === 1) {
        const L = labels[g[0]];
        ctx.fillStyle = L.isHighlight ? _lblHot : _lblNorm;
        ctx.font = (L.isHighlight ? 'bold ' : '') + L.fp + 'px "Flux Architect", monospace';
        ctx.fillText(L.text, L.lx, L.ly);
        return;
      }
      let mx = 0, my = 0, hot = false;
      g.forEach(function (i) { mx += labels[i].lx / g.length; my += labels[i].ly / g.length; if (labels[i].isHighlight) hot = true; });
      ctx.fillStyle = hot ? _lblHot : _lblNorm;
      ctx.font = 'bold ' + (11 * dpr) + 'px "Flux Architect", monospace';
      ctx.fillText(labels[g[0]].code + ' \u00d7' + g.length, mx, my);
    });
  }

  // ════════════════════════════════════════════════════════════════════
  //  Save Project — job serialization helpers (pure; no DOM/Firebase)
  // ════════════════════════════════════════════════════════════════════
  // Timestamp slug YYYYMMDD_HHMMSS (local) — used as the jobId + filename.
  function _jobStamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  // Human label "YYYY-MM-DD HH:MM" (local) for the Saved Jobs list.
  function _jobLabel() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  // Strip a part down to the persisted fields (no polys/bbox — re-parsed on restore).
  function _serializePart(p) {
    return {
      code: p.code, qty: p.qty || 0, selected: !!p.selected,
      grain: p.grain || 'ANY', thickness: p.thickness || 0,
      w: p.w || 0, h: p.h || 0, manual: !!p.manual, dxfUrl: p.dxfUrl || '',
      // provenance (multi-project nesting): which project wants how many
      sources: p.sources || null,
      // Fusion lineage urn — the STABLE key "↻ Re-resolve" matches on to adopt a
      // part's CURRENT manifest code after a Fusion CC_Assembly rename (the urn
      // never changes across renames; the snapshot code does). Older jobs saved
      // before this carry null → re-resolve recovers it from the manifest by code
      // for any part whose code hasn't drifted yet. (RD/เอ๋ 2026-06-20)
      urn: p.urn || null,
    };
  }
  // Strip a flatSheet to thick/size + placements without polys/bbox.
  function _serializeSheet(s) {
    return {
      thick: s.thick, sw: s.sw, sh: s.sh,
      fromRemnant: s.fromRemnant || null,
      placements: (s.placements || []).map(pl => ({
        code: pl.code, x: pl.x, y: pl.y, w: pl.w, h: pl.h, rot: pl.rot || 0,
      })),
    };
  }
  // Per-cut-sheet parts summary: group a sheet's placements by code, attach
  // grain/thickness from the matching S.parts entry. Used in cut_sheets.parts[].
  function _sheetPartsSummary(sheet) {
    const byCode = new Map();
    for (const pl of (sheet.placements || [])) {
      const ex = byCode.get(pl.code);
      if (ex) { ex.qty += 1; continue; }
      const part = S.parts.find(p => p.code === pl.code);
      byCode.set(pl.code, {
        code: pl.code, qty: 1, w: pl.w, h: pl.h, rot: pl.rot || 0,
        grain: (part && part.grain) || 'ANY',
        thickness: (part && part.thickness) || 0,
      });
    }
    return [...byCode.values()];
  }
  // Assemble the full job object from current S. Pure (reads S, returns data).
  function _buildJob() {
    return {
      saved_at: Date.now(),
      name: _jobLabel(),
      mode: S.mode, gap: S.gap,
      skipRemnants: !!S.skipRemnants, dontRemember: !!S.dontRemember,
      rememberRemnants: S.rememberRemnants !== false,
      sheetStock: (S.sheetStock || []).map(s => ({
        w: s.w || 0, h: s.h || 0, qty: s.qty || 0,
        thickness: s.thickness ?? 1, label: s.label || '',
        prc: s.prc || 0,   // per-sheet price (THB) — เอ๋ 2026-06-26
        enabled: s.enabled !== false,
      })),
      parts: (S.parts || []).map(_serializePart),
      sheets: (S.flatSheets || []).map(_serializeSheet),
      // multi-project nesting: every source project in this nest (primary first)
      merged_projects: (S.mergedProjects && S.mergedProjects.length) ? S.mergedProjects.slice() : [S.projectKey],
      // cabinet capsules: which cabinets were deliberately excluded ('' = the
      // no-cabinet bucket). Load restores the selection; staleness compares
      // against the ON subset only. null (stripped by RTDB) when all ON.
      cabinets_off: (S.cabinetsOff && S.cabinetsOff.size) ? [...S.cabinetsOff] : null,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  //  Save sheets to Laser → cut_sheets/<projectKey>/<id>
  //  (button label was 'Save Sheets to Project' through 2026-05-29 —
  //   renamed because the destination is the Laser-role 📐 Cut Sheets
  //   panel on the same project, not a generic 'project drop'.)
  // ════════════════════════════════════════════════════════════════════
  async function _saveProject() {
    if (!S.flatSheets.length) {
      alert('No nested sheets — click ▶ Run Nesting first.');
      return;
    }
    // Reuse app.js's PAT prompter + GitHub helpers.
    const pat = (window.getGitHubPat || function () { return null; })();
    if (!pat) { alert('GitHub PAT needed to upload.'); return; }

    const projectKey = S.projectKey;
    const jobId = _jobStamp();
    const ts = jobId;   // cut-sheet ids share the job stamp so they group together
    const safeProject = projectKey.replace(/[^A-Za-z0-9._-]+/g, '_');
    const repoPrefix = `CutSheets/${encodeURIComponent(safeProject)}`;

    const btn = document.querySelector('#kdnest-savenest');
    const origText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏫ Uploading…'; }

    // Save now ACCUMULATES — it never deletes old data. (เอ๋ 2026-06-06: 'กด save
    // project ไม่ต้องลบของเก่า ถ้าจะลบเดี๋ยวผมลบเอง แต่ให้ update ค่าใหม่' — covers
    // BOTH parts and cut sheets.) This REVERSES the 2026-05-31 cut_sheets wipe:
    // each save writes its sheets under fresh per-run ids (project_ts_sN), so
    // prior runs' cut sheets stay in the Laser list and pile up by design —
    // เอ๋ prunes them manually. nest_parts below MERGES by code instead of
    // overwriting (see there). (nest_jobs history was already never wiped.)

    let ok = 0, fail = 0, firstErr = '';
    for (let i = 0; i < S.flatSheets.length; i++) {
      const sheet = S.flatSheets[i];
      const sheetId = `${safeProject}_${ts}_s${i + 1}`;
      const path = `${repoPrefix}/${sheetId}.dxf`;
      try {
        const dxfText = _buildSheetDxf(sheet);
        const content = btoa(unescape(encodeURIComponent(dxfText)));
        const resp = await window.fetch(
          `https://api.github.com/repos/wuttichaisaeton/kitchen-drawings-rd2026/contents/${path}`,
          {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${pat}`,
              'Content-Type': 'application/json',
              'Accept': 'application/vnd.github+json',
            },
            body: JSON.stringify({
              message: `Web Nesting: cut sheet ${sheetId}`,
              content,
              branch: 'main',
            }),
          }
        );
        if (!resp.ok) throw new Error(`GH ${resp.status}`);
        const url = `https://raw.githubusercontent.com/wuttichaisaeton/kitchen-drawings-rd2026/main/${path}`;
        const thicknessMm = (function () {
          try { return parseFloat(String(sheet.thick).replace('mm', '').trim()) || 0; }
          catch (e) { return 0; }
        })();
        const meta = {
          url, filename: `${sheetId}.dxf`,
          thickness_mm: thicknessMm,
          parts_count: sheet.placements.length,
          sheet_w_mm: Math.round(sheet.sw),
          sheet_h_mm: Math.round(sheet.sh),
          uploaded_at: Date.now(),
          uploaded_via: 'web-nest',
          original_filename: `${sheetId}.dxf`,
          size_bytes: content.length,
          parts: _sheetPartsSummary(sheet),
        };
        await window.firebaseDB.ref(`cut_sheets/${projectKey}/${sheetId}`).set(meta);
        ok++;
      } catch (e) {
        fail++;
        if (!firstErr) firstErr = String(e.message || e);
      }
    }

    // Persist the full nest job (history) + the latest-parts snapshot + a
    // local backup. These are independent of the cut-sheet DXF upload above,
    // so a GitHub failure still saves the job for restore.
    const job = _buildJob();
    let jobSaved = false, jobErr = '';
    try {
      await window.firebaseDB.ref(`nest_jobs/${projectKey}/${jobId}`).set(job);
      // Merge into nest_parts by code instead of overwriting — keep parts saved
      // by earlier runs, update the ones in THIS run, add any new codes. (เอ๋
      // 2026-06-06: 'ไม่ต้องลบของเก่า … update ค่าใหม่'.) jobId/saved_at advance to
      // this run so the 📍 locator still resolves the freshest saved layout.
      const _byCode = new Map();
      try {
        const _snap = await window.firebaseDB.ref(`nest_parts/${projectKey}/parts`).once('value');
        const _existing = _snap.val();
        const _list = Array.isArray(_existing) ? _existing
          : (_existing && typeof _existing === 'object' ? Object.values(_existing) : []);
        for (const p of _list) { if (p && p.code) _byCode.set(p.code, p); }
      } catch (e) { /* read failed — fall back to writing just this run's parts */ }
      for (const p of job.parts) { if (p && p.code) _byCode.set(p.code, p); }  // new wins
      await window.firebaseDB.ref(`nest_parts/${projectKey}`).set({
        saved_at: job.saved_at, jobId: jobId, parts: Array.from(_byCode.values()),
      });
      S.lastSavedJobId = jobId;
      jobSaved = true;
    } catch (e) {
      jobErr = String(e.message || e);
    }
    try {
      localStorage.setItem('kd_nest_job_' + projectKey, JSON.stringify({ jobId, ...job }));
    } catch (e) { /* quota / private mode — non-fatal */ }

    // Remember this nest's offcuts in the shared Remnants pool — happens at
    // SAVE, not at Run (เอ๋ 2026-06-10 'ถ้าจะ save ให้มา save ที่ save Project').
    // Honors the per-run choice from ▶ Run Nesting (S.rememberRemnants): if เอ๋
    // declined, the offcuts are skipped. Default (no Run yet, e.g. a loaded job)
    // = remember, preserving prior behavior.
    const _rememberRem = S.rememberRemnants !== false;
    let remSaved = 0;
    if (_rememberRem) {
      try { remSaved = await _autoSaveRemnants() || 0; } catch (e) { /* reported below as 0 */ }
    }
    const _remLine = _rememberRem
      ? `\nRemnants remembered: ${remSaved}`
      : `\nRemnants: not saved (your choice)`;

    if (btn) { btn.disabled = false; btn.textContent = origText; }
    alert(`Save Nest — '${S.projectName}'\n\n` +
          `Cut sheets uploaded: ${ok}` + (fail ? `\nFailed: ${fail}` : '') +
          `\nNest job: ${jobSaved ? 'saved (' + job.name + ')' : 'FAILED — ' + jobErr}` +
          _remLine +
          (firstErr ? `\n\nFirst cut-sheet error: ${firstErr}` : ''));
  }

  // ── Staleness check (RD 02 spec / เอ๋ "ทุกอย่างต้องตรงกันเสมอ ถ้าผมลืมละ") ──
  // A saved nest job is OUTDATED when the design moved after it was saved:
  //  (a) the project's manifest part list (code → qty, same is_wrapper-skipping
  //      aggregation as _loadProjectParts) no longer matches the job snapshot, or
  //  (b) any snapshot part's laser DXF was re-uploaded after job.saved_at
  //      (uploaded_dxfs/<code>.uploaded_at, from the S.dxfsAll stash).
  // Pure client-side timestamp/set compares on data already fetched.
  function _manifestPartCounts(projectKey, cabsOff) {
    const m = window.kdManifest;
    const project = m && m.projects && m.projects[projectKey];
    if (!project || !Array.isArray(project.parts)) return null;
    const counts = new Map();
    const _byCodeRaw = new Map();
    if (cabsOff && cabsOff.size) for (const p of project.parts) if (p && p.code) _byCodeRaw.set(p.code, p);
    for (const p of project.parts) {
      if (!p || !p.code || p.is_wrapper) continue;
      // cabinet capsules: a job saved with cabinets excluded is compared
      // against the ON subset only — otherwise every selective save would
      // flag "parts changed" forever. Cabinet resolved via the tree-climb.
      if (cabsOff && cabsOff.size && cabsOff.has(
            (typeof _resolveCabinet === 'function') ? _resolveCabinet(p, _byCodeRaw) : String(p.variant_root || '').trim())) continue;
      counts.set(p.code, (counts.get(p.code) || 0) + (p.qty || 0));
    }
    return counts;
  }
  function _jobStaleness(job, projectKey) {
    const reasons = [];
    if (!job) return reasons;
    // Multi-project jobs: compare against the SUM of every source project's
    // manifest counts (merged_projects, primary-first); single-project jobs
    // fall back to the one key as before.
    const srcKeys = (Array.isArray(job.merged_projects) && job.merged_projects.length)
      ? job.merged_projects : [projectKey || S.projectKey];
    // cabinet capsules: jobs saved with excluded cabinets compare against the
    // ON subset of the manifest; their snapshot rows for fully-excluded codes
    // carry qty 0 and are skipped below (both sides drop the same codes).
    const cabsOff = new Set(Array.isArray(job.cabinets_off)
      ? job.cabinets_off.map(x => String(x)) : []);
    let cur = null;
    for (const k of srcKeys) {
      const c = _manifestPartCounts(k, cabsOff);
      if (!c) continue;
      if (!cur) cur = new Map();
      for (const [code, q] of c) cur.set(code, (cur.get(code) || 0) + q);
    }
    if (cur) {
      const snap = new Map();
      for (const p of (job.parts || [])) {
        if (!p || !p.code || p.manual) continue;   // manual rects aren't in the manifest
        if (!(p.qty > 0)) continue;   // qty 0 = excluded/zeroed — not part of the cut
        snap.set(p.code, (snap.get(p.code) || 0) + (p.qty || 0));
      }
      let diff = snap.size !== cur.size;
      if (!diff) for (const [c, q] of cur) { if (snap.get(c) !== q) { diff = true; break; } }
      if (diff) reasons.push('parts changed');
    }
    const at = +job.saved_at || 0;
    if (at && S.dxfsAll) {
      for (const p of (job.parts || [])) {
        if (!p || !(p.qty > 0)) continue;   // excluded rows can't outdate the nest
        const meta = p.code ? S.dxfsAll[p.code] : null;
        if (meta && (+meta.uploaded_at || 0) > at) { reasons.push('DXF updated'); break; }
      }
    }
    return reasons;
  }
  const _STALE_TITLE = 'Outdated — design changed after this nest was saved. Run Nesting again.';

  // Restore a saved nest job into S: settings + parts + stock, then re-parse
  // DXFs and re-attach polys/bbox to the saved placements by code. No re-run —
  // the saved layout renders as-is. (user 2026-05-30 'โหลดงานเก่า')
  async function _restoreJob(job) {
    if (!job) return;
    // Loaded-nest staleness badge in the workspace header; cleared by the
    // next ▶ Run Nesting (a fresh run IS the fix).
    S.loadedJobStale = _jobStaleness(job);
    S.mode = job.mode || S.mode;
    S.gap = (typeof job.gap === 'number') ? job.gap : S.gap;
    S.skipRemnants = !!job.skipRemnants;
    S.dontRemember = !!job.dontRemember;
    if (Array.isArray(job.sheetStock) && job.sheetStock.length) {
      S.sheetStock = job.sheetStock.map(s => ({
        w: s.w || 0, h: s.h || 0, qty: s.qty || 0,
        thickness: s.thickness ?? 1, label: s.label || '',
        // old saves (no prc) → size default; user prices short-circuit. 2026-06-26
        prc: (+s.prc || 0) || _getPriceDefault(s.w || 0, s.h || 0, s.label || ''),
        enabled: s.enabled !== false,   // old saved nests → default ON
      }));
    }
    // Rebuild parts: start from a fresh part shell per code, overlay saved fields.
    S.parts = (job.parts || []).map(sp => {
      const base = sp.manual ? _newManualPart() : _newPart(sp.code, sp.qty);
      base.code = sp.code;
      base.qty = sp.qty || 0;
      base.selected = !!sp.selected;
      base.grain = sp.grain || 'ANY';
      base.thickness = sp.thickness || 0;
      base.w = sp.w || 0;
      base.h = sp.h || 0;
      base.manual = !!sp.manual;
      base.dxfUrl = sp.dxfUrl || '';
      base.dxfLoaded = !!sp.manual;   // manual rects need no fetch
      base.dxfError = null;
      base.polys = null; base.bbox = null;
      base.sources = sp.sources || null;   // multi-project provenance survives a load
      base.urn = sp.urn || null;           // lineage key for ↻ Re-resolve (older jobs: null → recovered from the manifest by code on re-resolve)
      return base;
    });
    S.mergedProjects = (Array.isArray(job.merged_projects) && job.merged_projects.length)
      ? job.merged_projects.slice() : [S.projectKey];
    // Cabinet capsules: the loaded job's selection becomes the live selection
    // (and persists). Snapshot rows don't carry cabinet data — rebuild contrib
    // from the CURRENT manifest so the capsules stay toggleable after a load.
    // Snapshot qtys are kept as saved; a toggle recomputes from manifest truth.
    S.cabinetsOff = new Set(Array.isArray(job.cabinets_off)
      ? job.cabinets_off.map(x => String(x)) : []);
    _saveCabSel();
    _attachCabinetsFromManifest();
    S.previewCode = null;
    S.highlightCode = null;

    // Build the sheets from the SAVED placements (x/y/w/h are stored on the job)
    // and show them IMMEDIATELY — _drawSheet renders each placement as a coloured
    // rectangle even before its DXF outline loads. Without this, the sheets were
    // assembled only AFTER `await _loadAllDxfs()`, so a slow/stalled DXF fetch
    // left the canvas blank and the load looked frozen (เอ๋ 2026-06-10 'กด Load
    // nest ค้าง ไม่โชว์แผ่นตัด'). The real DXF outlines then enrich the shapes
    // in the background once the fetches resolve.
    const buildSheets = () => (job.sheets || []).map(sh => ({
      thick: sh.thick, sw: sh.sw, sh: sh.sh, fromRemnant: sh.fromRemnant || null,
      placements: (sh.placements || []).map(pl => {
        const part = S.parts.find(p => p.code === pl.code);
        return {
          code: pl.code, x: pl.x, y: pl.y, w: pl.w, h: pl.h, rot: pl.rot || 0,
          polys: part ? part.polys : null,
          bbox: part ? part.bbox : null,
        };
      }),
    }));
    S.flatSheets = buildSheets();
    S.currentSheetIdx = 0;
    _refreshView();                          // sheets visible now (rectangles)

    // Re-parse DXFs (fills polys/bbox + may correct w/h from the real bbox), then
    // re-attach the geometry and redraw with the true part outlines. This await
    // can never strand the sheets now — they are already on screen.
    await _loadAllDxfs();
    if (S.closing) return;
    S.flatSheets = buildSheets();
    S.currentSheetIdx = Math.min(S.currentSheetIdx, Math.max(0, S.flatSheets.length - 1));
    _refreshView();
  }

  // ── Saved Jobs popover ────────────────────────────────────────────────
  // Lists nest_jobs/<pk>/* newest-first; load or (admin) delete each.
  function _openSavedJobsModal() {
    const pk = S.projectKey;
    if (!pk || !window.firebaseDB) { alert('No project / database unavailable.'); return; }
    window.firebaseDB.ref(`nest_jobs/${pk}`).once('value')
      .then(snap => _renderSavedJobsModal(snap.val() || {}))
      .catch(e => alert('Saved Jobs load failed: ' + (e.message || e)));
  }
  function _renderSavedJobsModal(bucket) {
    document.querySelectorAll('.kdjobs-modal').forEach(m => m.remove());
    const isAdminUser = (typeof window.isAdmin === 'function' && window.isAdmin());
    const jobs = Object.entries(bucket)
      .map(([jobId, v]) => ({ jobId, ...v }))
      .sort((a, b) => (b.saved_at || 0) - (a.saved_at || 0));

    const rows = jobs.length ? jobs.map(j => {
      const nSheets = Array.isArray(j.sheets) ? j.sheets.length : 0;
      const nParts = Array.isArray(j.parts) ? j.parts.length : 0;
      const stale = _jobStaleness(j);
      const staleBadge = stale.length
        ? ` <span class="kdjobs-stale" title="${_esc(_STALE_TITLE + ' (' + stale.join(', ') + ')')}">⚠ Outdated</span>` : '';
      return `
        <div class="kdjobs-row" data-id="${_esc(j.jobId)}">
          <div class="kdjobs-main">
            <span class="kdjobs-name">${_esc(j.name || j.jobId)}${staleBadge}</span>
            <span class="kdjobs-meta">${nSheets} sheets · ${nParts} parts · ${_esc(j.mode || '')}${(Array.isArray(j.merged_projects) && j.merged_projects.length > 1) ? ` · <span title="${_esc(j.merged_projects.join(' + '))}">${j.merged_projects.length} projects</span>` : ''}${stale.length ? ` · <span class="kdjobs-stale-why">${_esc(stale.join(' + '))} — Run Nesting again</span>` : ''}</span>
          </div>
          <button class="kdjobs-load" data-id="${_esc(j.jobId)}">Load</button>
          ${isAdminUser ? `<button class="kdjobs-del" data-id="${_esc(j.jobId)}" title="Delete this saved job">✕</button>` : ''}
        </div>`;
    }).join('') : '<div class="kdjobs-empty">No saved nests yet. Run Nesting, then click 💾 Save Nest.</div>';

    const modal = document.createElement('div');
    modal.className = 'kdstock-modal kdjobs-modal';
    modal.innerHTML = '<div class="kdstock-backdrop"></div>'
      + `<div class="kdstock-frame" role="dialog" aria-label="Saved Jobs">
           <div class="kdstock-head">📂 Saved Jobs
             <span class="kdstock-sub">${_esc(S.projectName)} · ${jobs.length} saved</span>
             <button class="kdstock-close" aria-label="Close">✕</button>
           </div>
           <div class="kdjobs-body">${rows}</div>
         </div>`;
    document.body.appendChild(modal);

    const closeModal = () => modal.remove();
    modal.querySelector('.kdstock-backdrop').addEventListener('click', closeModal);
    modal.querySelector('.kdstock-close').addEventListener('click', closeModal);
    modal.querySelectorAll('.kdjobs-load').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const job = bucket[id];
      closeModal();
      if (job) await _restoreJob(job);
    }));
    modal.querySelectorAll('.kdjobs-del').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!confirm('Delete saved job "' + id + '"? This cannot be undone.')) return;
      try {
        await window.firebaseDB.ref(`nest_jobs/${S.projectKey}/${id}`).remove();
        const snap = await window.firebaseDB.ref(`nest_jobs/${S.projectKey}`).once('value');
        _renderSavedJobsModal(snap.val() || {});
      } catch (e) { alert('Delete failed: ' + (e.message || e)); }
    }));
  }

  // Download the current nest state as a JSON backup (insurance outside
  // Firebase). Does not require a prior save. (user 2026-05-30 'เก็บเป็นไฟล์')
  function _exportJobJson() {
    const pk = S.projectKey || 'project';
    const payload = {
      kind: 'kd-nest-job', version: 1,
      projectKey: pk, projectName: S.projectName || pk,
      exported_at: Date.now(),
      job: _buildJob(),
    };
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = `${pk}_nest_${_jobStamp()}.json`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
    } catch (e) {
      alert('Export failed: ' + (e.message || e));
    }
  }

  // ── Common-line merge (เอ๋ 2026-06-26) ─────────────────────────────────
  // Given the axis-aligned straight OUTER edges of all parts on a sheet (sheet
  // mm), return the de-duplicated cut lines: where 2+ parts share a collinear
  // edge (segments coincide/overlap), that span is cut ONCE instead of twice.
  // With tabMm>0, spans shared by >=2 parts are broken with small UNCUT bridges
  // so the parts don't shift mid-cut. Non-axis-aligned edges are never passed in
  // (caller emits them unchanged) → curved/diagonal parts are untouched.
  const _CL_EPS = 0.08;   // mm — coincidence / collinearity tolerance
  function _commonLineTabbed(a, b, mk, out, tabMm) {
    const len = b - a;
    if (len <= Math.max(8, tabMm * 6)) { out.push(mk(a, b)); return; }   // too short → solid cut
    const nTabs = Math.max(1, Math.floor(len / 300));   // ~1 uncut bridge / 300mm (0.3mm tab, thin stainless) [เอ๋ 2026-06-26: 200→300]
    const cutLen = (len - nTabs * tabMm) / (nTabs + 1);
    let pos = a;
    for (let t = 0; t < nTabs; t++) { out.push(mk(pos, pos + cutLen)); pos += cutLen + tabMm; }
    out.push(mk(pos, b));
  }
  function _commonLineMerge(segs, tabMm) {
    const q = v => Math.round(v / _CL_EPS);
    const vert = new Map(), horiz = new Map();   // perpendicular-coord key → {coord, ivs:[{lo,hi}]}
    const add = (map, key, lo, hi, coord) => {
      let g = map.get(key); if (!g) { g = { coord, ivs: [] }; map.set(key, g); }
      g.ivs.push({ lo: Math.min(lo, hi), hi: Math.max(lo, hi) });
    };
    for (const s of segs) {
      const dx = Math.abs(s.x1 - s.x0), dy = Math.abs(s.y1 - s.y0);
      if (dx <= _CL_EPS && dy > _CL_EPS) add(vert, q((s.x0 + s.x1) / 2), s.y0, s.y1, (s.x0 + s.x1) / 2);
      else if (dy <= _CL_EPS && dx > _CL_EPS) add(horiz, q((s.y0 + s.y1) / 2), s.x0, s.x1, (s.y0 + s.y1) / 2);
      // else: not axis-aligned — ignore (should not be passed in)
    }
    const out = [];
    const sweep = (g, mk) => {
      const ivs = g.ivs, bounds = [];
      for (const iv of ivs) { bounds.push(iv.lo, iv.hi); }
      bounds.sort((a, b) => a - b);
      const uniq = [];
      for (const v of bounds) if (!uniq.length || Math.abs(v - uniq[uniq.length - 1]) > _CL_EPS) uniq.push(v);
      for (let i = 0; i + 1 < uniq.length; i++) {
        const a = uniq[i], b = uniq[i + 1];
        if (b - a <= _CL_EPS) continue;
        const mid = (a + b) / 2;
        let cov = 0;
        for (const iv of ivs) if (iv.lo - _CL_EPS <= mid && mid <= iv.hi + _CL_EPS) cov++;
        if (cov === 0) continue;
        if (cov >= 2 && tabMm > 0) _commonLineTabbed(a, b, mk, out, tabMm);
        else out.push(mk(a, b));
      }
    };
    for (const g of vert.values())  sweep(g, (lo, hi) => [g.coord, lo, g.coord, hi]);
    for (const g of horiz.values()) sweep(g, (lo, hi) => [lo, g.coord, hi, g.coord]);
    return out;
  }

  // DXF builder for one nested sheet — minimal R12-ish text format.
  // ezdxf would be nicer but we have to ship browser-only. The format
  // below works in any DXF reader (NestingTool's ezdxf-based reader
  // can round-trip it). Outer sheet border + each placement's outer
  // polygon, all on layer "0" for now (sufficient for laser cut).
  function _buildSheetDxf(sheet) {
    // DXF R12 (no $ACADVER). เอ๋'s laser/CAD reader opens R12-implicit files
    // (TEST_A/B/C 2026-06-22) but mis-renders SPLINE/ELLIPSE as a straight
    // line and rejects $ACADVER AC1015 entirely. So: stay R12, and emit ONLY
    // R12-native entities — LINE / CIRCLE / ARC / LWPOLYLINE(+bulge). SPLINEs
    // (degree-3 corner fillets in Fusion flat patterns) are arc-fitted into
    // true ARCs — still vector + crisp (เอ๋ HARD RULE 'vector ทุกส่วน'), never
    // faceted. The R2000/subclass attempt (f509334) made ezdxf happy but เอ๋'s
    // reader unhappy — exact opposite — so it's reverted here.
    const lines = ['0','SECTION','2','HEADER','9','$INSUNITS','70','4','0','ENDSEC',
                   '0','SECTION','2','ENTITIES'];

    // Common-line collection (opt-in). When ON, axis-aligned OUTER edges are
    // buffered (not emitted) and merged once at the end; everything else (holes,
    // border, labels, curves, non-axis edges) emits normally. OFF → never touched.
    // Common-line CANCELLED (เอ๋ 2026-06-26 'ยกเลิกแผนการรวมเส้นทั้งหมด'). On True
    // Shape's raster grid, shared edges land ~0.5mm apart, so they only merge by
    // snapping = distorting dimensions (which she rejected); the value of the GAP is
    // also grid-quantized. Feature is off everywhere + the 🔗 UI is removed. The merge
    // code below stays inert (never collects). Restore as a toggle to revive it.
    const _clActive = false;
    const _clTab = S.commonTabs ? (S.commonTabMm || 0.5) : 0;
    const _clBuf = [];
    // Feed each polyline edge through line() — line() collects the axis-aligned
    // OUTER ones and emits the rest. Used to decompose OUTER polylines when ON.
    function _clDecompose(pts) {
      for (let i = 0; i + 1 < pts.length; i++) line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], 'OUTER_PROFILES');
    }

    function lwpolyline(pts, layer) {
      if (!pts || pts.length < 2) return;
      if (_clActive && (layer || '0') === 'OUTER_PROFILES') { _clDecompose(pts); return; }
      lines.push('0','LWPOLYLINE','8', layer || '0',
                 '90', String(pts.length), '70','1');
      for (const [x, y] of pts) {
        lines.push('10', x.toFixed(3), '20', y.toFixed(3));
      }
    }
    // Single-line TEXT, centred (72=1 horiz, 73=2 middle) on (x,y). Part-name
    // labels live on PART_LABELS so the cutter can switch them off.
    function text(str, x, y, h, layer) {
      if (str == null || str === '') return;
      lines.push('0','TEXT','8', layer || '0',
                 '10', x.toFixed(3), '20', y.toFixed(3), '30','0',
                 '40', h.toFixed(3),
                 '1', String(str),
                 '72','1','73','2',
                 '11', x.toFixed(3), '21', y.toFixed(3), '31','0');
    }
    // ── R12-native vector writers ──────────────────────────────────────
    function deg(rad) { let d = rad * 180 / Math.PI; d %= 360; if (d < 0) d += 360; return d; }
    function circle(cx, cy, r, layer) {
      lines.push('0','CIRCLE','8', layer || '0',
                 '10', cx.toFixed(3), '20', cy.toFixed(3), '30','0', '40', r.toFixed(3));
    }
    function arc(cx, cy, r, sDeg, eDeg, layer) {
      lines.push('0','ARC','8', layer || '0',
                 '10', cx.toFixed(3), '20', cy.toFixed(3), '30','0', '40', r.toFixed(3),
                 '50', sDeg.toFixed(4), '51', eDeg.toFixed(4));
    }
    function line(x0, y0, x1, y1, layer) {
      if (_clActive && (layer || '0') === 'OUTER_PROFILES') {
        const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
        if ((dx <= _CL_EPS && dy > _CL_EPS) || (dy <= _CL_EPS && dx > _CL_EPS)) {
          _clBuf.push({ x0, y0, x1, y1 });   // axis-aligned OUTER edge → merge later
          return;
        }
      }
      lines.push('0','LINE','8', layer || '0',
                 '10', x0.toFixed(3), '20', y0.toFixed(3), '30','0',
                 '11', x1.toFixed(3), '21', y1.toFixed(3), '31','0');
    }
    function polyBulge(verts, closed, layer) {
      if (!verts || verts.length < 2) return;
      if (_clActive && (layer || '0') === 'OUTER_PROFILES' && verts.every(v => Math.abs(v.bulge || 0) < 1e-9)) {
        const pts = verts.map(v => [v.x, v.y]);
        if (closed) pts.push([verts[0].x, verts[0].y]);
        _clDecompose(pts); return;   // straight OUTER polyline → per-edge merge
      }
      lines.push('0','LWPOLYLINE','8', layer || '0',
                 '90', String(verts.length), '70', closed ? '1' : '0');
      for (const v of verts) {
        lines.push('10', v.x.toFixed(3), '20', v.y.toFixed(3));
        if (Math.abs(v.bulge || 0) > 1e-9) lines.push('42', v.bulge.toFixed(6));
      }
    }
    // ── Curve → ARC conversion (SPLINE/ELLIPSE are not R12; arc-fit keeps
    //    them true-vector instead of faceting or breaking เอ๋'s reader) ────
    // de Boor B-spline evaluation (ctrl = [[x,y],…]) — same maths as the
    // parse-side bsplineFlatten; kept local so the writer is self-contained.
    function bsplineSample(ctrl, deg2, knots, samples) {
      const n = ctrl.length - 1;
      if (n < deg2 || !Array.isArray(knots) || knots.length !== n + deg2 + 2) {
        return ctrl.slice();   // malformed knots → control polygon (low-deg ≈ curve)
      }
      function evalAt(u) {
        let s = deg2;
        for (let i = deg2; i <= n; i++) {
          if (u >= knots[i] && u < knots[i + 1]) { s = i; break; }
          if (i === n) s = n;
        }
        const d = [];
        for (let j = 0; j <= deg2; j++) d.push(ctrl[s - deg2 + j].slice());
        for (let r = 1; r <= deg2; r++) {
          for (let j = deg2; j >= r; j--) {
            const idx = s - deg2 + j;
            const den = knots[idx + deg2 - r + 1] - knots[idx];
            const al = den > 1e-12 ? (u - knots[idx]) / den : 0;
            d[j][0] = (1 - al) * d[j - 1][0] + al * d[j][0];
            d[j][1] = (1 - al) * d[j - 1][1] + al * d[j][1];
          }
        }
        return d[deg2];
      }
      const u0 = knots[deg2], u1 = knots[n + 1];
      const M = Math.max(samples || 48, ctrl.length * 8);
      const out = [];
      for (let i = 0; i <= M; i++) {
        try { out.push(evalAt(u0 + (u1 - u0) * (i / M))); } catch (_) { /* skip */ }
      }
      return out.length >= 2 ? out : ctrl.slice();
    }
    function ellipseSample(d, samples) {
      // P(t) = C + cos t·major + sin t·(ratio·perp(major)), t∈[a0,a1].
      const out = [];
      const M = Math.max(samples || 64, 24);
      let a0 = d.a0, a1 = d.a1;
      if (a1 <= a0) a1 += 2 * Math.PI;
      for (let i = 0; i <= M; i++) {
        const t = a0 + (a1 - a0) * (i / M);
        const c = Math.cos(t), s = Math.sin(t);
        out.push([d.cx + c * d.mx - s * d.ratio * d.my,
                  d.cy + c * d.my + s * d.ratio * d.mx]);
      }
      return out;
    }
    // Circumcircle of 3 points; null if (near-)collinear.
    function circleFrom3(A, B, C) {
      const ax = A[0], ay = A[1], bx = B[0], by = B[1], cx = C[0], cy = C[1];
      const dd = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
      if (Math.abs(dd) < 1e-9) return null;
      const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
      const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / dd;
      const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / dd;
      return { cx: ux, cy: uy, r: Math.hypot(ax - ux, ay - uy) };
    }
    // Greedy fit: emit true ARCs/LINEs for a sampled curve (already in sheet
    // coords). Grow a run while one circle through endpoints+interior stays
    // within tol of every sample; commit, restart. Collinear runs → LINE.
    function emitFittedCurve(pts, layer, tol) {
      const N = pts.length;
      if (N < 2) return;
      const t = tol || 0.05;
      let i = 0;
      while (i < N - 1) {
        let jBest = -1, cBest = null;
        for (let j = i + 2; j < N; j++) {
          const c = circleFrom3(pts[i], pts[(i + j) >> 1], pts[j]);
          if (!c || !(c.r < 1e7)) break;
          let maxDev = 0;
          for (let k = i; k <= j; k++) {
            const dev = Math.abs(Math.hypot(pts[k][0] - c.cx, pts[k][1] - c.cy) - c.r);
            if (dev > maxDev) { maxDev = dev; if (maxDev > t) break; }
          }
          if (maxDev <= t) { jBest = j; cBest = c; } else break;
        }
        if (cBest) {
          const P0 = pts[i], P1 = pts[jBest], Pm = pts[(i + jBest) >> 1];
          const TAU = 2 * Math.PI, nrm = a => ((a % TAU) + TAU) % TAU;
          let a0 = Math.atan2(P0[1] - cBest.cy, P0[0] - cBest.cx);
          let a1 = Math.atan2(P1[1] - cBest.cy, P1[0] - cBest.cx);
          const am = Math.atan2(Pm[1] - cBest.cy, Pm[0] - cBest.cx);
          // DXF ARC is CCW a0→a1; pick the order whose CCW sweep passes Pm.
          if (nrm(am - a0) <= nrm(a1 - a0)) arc(cBest.cx, cBest.cy, cBest.r, deg(a0), deg(a1), layer);
          else                              arc(cBest.cx, cBest.cy, cBest.r, deg(a1), deg(a0), layer);
          i = jBest;
        } else {
          line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], layer);
          i += 1;
        }
      }
    }
    // Place one normalised WCS descriptor onto the sheet: positions go
    // through ``xf`` (the placement transform); sweep angles rotate by
    // ``rotRad``. Pure rotation → bulge signs + arc sweep sense preserved
    // (the transform never mirrors).
    function placeEntity(d, xf, rotRad, layer) {
      if (!d) return;
      if (d.kind === 'CIRCLE') {
        const c = xf(d.cx, d.cy); circle(c[0], c[1], d.r, layer); return;
      }
      if (d.kind === 'ARC') {
        let span = d.a1 - d.a0;
        while (span < 0) span += 2 * Math.PI;
        while (span > 2 * Math.PI) span -= 2 * Math.PI;
        const c = xf(d.cx, d.cy);
        if (span >= 2 * Math.PI - 1e-4 || span < 1e-6) { circle(c[0], c[1], d.r, layer); return; }
        arc(c[0], c[1], d.r, deg(d.a0 + rotRad), deg(d.a0 + span + rotRad), layer); return;
      }
      if (d.kind === 'LINE') {
        const a = xf(d.x0, d.y0), b = xf(d.x1, d.y1); line(a[0], a[1], b[0], b[1], layer); return;
      }
      if (d.kind === 'LWPOLYLINE') {
        const vs = d.verts.map(v => { const p = xf(v.x, v.y); return { x: p[0], y: p[1], bulge: v.bulge || 0 }; });
        polyBulge(vs, d.closed, layer); return;
      }
      if (d.kind === 'SPLINE') {
        // SPLINE is not R12 — sample the true curve (WCS), transform to sheet
        // (rigid → arcs stay arcs), then arc-fit into R12-native ARCs/LINEs.
        const useCtrl = (d.ctrl && d.ctrl.length >= 2);
        const src = (useCtrl ? d.ctrl : d.fit).map(p => [p.x, p.y]);
        const wcs = useCtrl ? bsplineSample(src, d.degree || 3, d.knots, 48) : src;
        const sheetPts = wcs.map(([x, y]) => xf(x, y));
        emitFittedCurve(sheetPts, layer, 0.05); return;
      }
      if (d.kind === 'ELLIPSE') {
        // ELLIPSE is not R12 either — same sample → transform → arc-fit path.
        const sheetPts = ellipseSample(d, 96).map(([x, y]) => xf(x, y));
        emitFittedCurve(sheetPts, layer, 0.05); return;
      }
    }
    // Sheet outline
    lwpolyline([[0,0],[sheet.sw,0],[sheet.sw,sheet.sh],[0,sheet.sh],[0,0]], 'SHEET_BORDER');
    // Each placement: outer profile (rotated, offset) + a centred part-name label
    for (const pl of sheet.placements) {
      // Footprint size on the sheet (W/H swap when rotated 90/270).
      const fw = (pl.rot === 90 || pl.rot === 270) ? pl.h : pl.w;
      const fh = (pl.rot === 90 || pl.rot === 270) ? pl.w : pl.h;
      // RAW code (the production identity the BOM/laser reads), centred on the
      // part, sized to the part but clamped readable.
      const th = Math.max(15, Math.min(50, Math.min(fw, fh) * 0.25));
      text(pl.code, pl.x + fw / 2, pl.y + fh / 2, th, 'PART_LABELS');

      const ents = pl.polys && pl.polys.entities;
      const haveOuter = pl.polys && pl.polys.outer && pl.polys.outer.length >= 2;
      if (!pl.polys || (!haveOuter && !(ents && ents.length))) {
        // Fallback: just the bbox rect (no usable geometry at all)
        lwpolyline([[pl.x, pl.y],[pl.x+fw, pl.y],[pl.x+fw, pl.y+fh],[pl.x, pl.y+fh],[pl.x, pl.y]],
                   'OUTER_PROFILES');
        continue;
      }
      const [bMinX, bMinY] = [pl.bbox[0], pl.bbox[1]];
      function transform(px, py) {
        let lx = px - bMinX, ly = py - bMinY;
        if (pl.rot === 90)  { const t = lx; lx = -ly + pl.h;  ly = t; }
        if (pl.rot === 180) { lx = pl.w - lx; ly = pl.h - ly; }
        if (pl.rot === 270) { const t = lx; lx = ly;          ly = pl.w - t; }
        return [pl.x + lx, pl.y + ly];
      }
      if (ents && ents.length) {
        // TRUE-VECTOR path — emit real CIRCLE/ARC/LINE/LWPOLYLINE(+bulge)/
        // SPLINE/ELLIPSE, rigid-transformed to the placement. rotRad matches
        // transform()'s linear part: rot=90 → (x,y)→(−y,x) = +90° CCW, etc.
        const rotRad = ((pl.rot || 0)) * Math.PI / 180;
        for (const d of ents) {
          placeEntity(d, transform, rotRad, d.cls === 'INTERIOR' ? 'INTERIOR_PROFILES' : 'OUTER_PROFILES');
        }
      } else {
        // FALLBACK — older cached part with no retained entities: keep the
        // tessellated polyline so nothing regresses (faceted, but rare).
        lwpolyline(pl.polys.outer.map(([x,y]) => transform(x,y)), 'OUTER_PROFILES');
        if (pl.polys.holes) {
          for (const hole of pl.polys.holes) {
            lwpolyline(hole.map(([x,y]) => transform(x,y)), 'INTERIOR_PROFILES');
          }
        }
      }
    }
    // Common-line: emit the de-duplicated/tabbed shared edges collected above.
    if (_clActive && _clBuf.length) {
      for (const s of _commonLineMerge(_clBuf, _clTab)) {
        lines.push('0','LINE','8','OUTER_PROFILES',
                   '10', s[0].toFixed(3), '20', s[1].toFixed(3), '30','0',
                   '11', s[2].toFixed(3), '21', s[3].toFixed(3), '31','0');
      }
    }
    lines.push('0','ENDSEC','0','EOF');
    return lines.join('\n');
  }

  // ════════════════════════════════════════════════════════════════════
  //  UI rendering
  // ════════════════════════════════════════════════════════════════════
  // Re-render but keep the part-list scroll where it is (เอ๋ no-jump) — used by
  // the per-DXF settle re-render + the ↻ retry so the page doesn't move.
  function _refreshViewKeepScroll() {
    const sc = S.rootEl && S.rootEl.querySelector('.kdnest-parts');
    const top = sc ? sc.scrollTop : 0;
    _refreshView();
    const sc2 = S.rootEl && S.rootEl.querySelector('.kdnest-parts');
    if (sc2) sc2.scrollTop = top;
  }

  function _refreshView() {
    if (!S.rootEl) return;
    S.rootEl.innerHTML = _viewHtml();
    _wireEvents();
    const canvas = S.rootEl.querySelector('#kdnest-canvas');
    if (canvas) {
      // Give the canvas a tick to size before draw.
      if (S.previewCode) {
        const part = S.parts.find(p => p.code === S.previewCode);
        // Draw directly — the canvas is CSS-sized immediately; reading
        // clientWidth forces layout, so we don't need to wait for rAF
        // (which can be throttled when the tab isn't foregrounded).
        _drawPartPreview(canvas, part);
        _attachEdgeClickLayer(canvas, part, _onEdgeClick);
        requestAnimationFrame(() => { _drawPartPreview(canvas, part); _attachEdgeClickLayer(canvas, part, _onEdgeClick); });
      } else if (S.flatSheets[S.currentSheetIdx]) {
        // Leaving preview → drop any stale EDGE overlay (sheet view has none).
        const _wrap = canvas.parentElement;
        if (_wrap) _wrap.querySelectorAll('.kdnest-edge-overlay').forEach(el => el.remove());
        _drawSheet(canvas, S.flatSheets[S.currentSheetIdx]);
        requestAnimationFrame(() => _drawSheet(canvas, S.flatSheets[S.currentSheetIdx]));
      }
    }
    if (S.previewCode) {
      const row = S.rootEl.querySelector('.kdnest-part[data-code="' + (window.CSS && CSS.escape ? CSS.escape(S.previewCode) : S.previewCode) + '"]');
      if (row) row.classList.add('kdnest-part-previewing');
    }
  }

  // ── Warning predicates (pure; shared by the banners + per-row markers) ──
  // A part with a DIRECTIONAL grain (H or V) must be laid with the grain
  // running the right way — flag it so the worker orients it correctly before
  // cutting. ANY rotates freely (no orientation risk → no flag).
  // (เอ๋ 2026-05-30 'บีเค grain ไปทางแนวนอน ... อันนี้ที่ต้องเตือน')
  function _isGrainDirectional(p) {
    if (!p || !p.selected || p.manual || _cabAllOff(p)) return false;
    const g = String(p.grain || '').toUpperCase();
    return g !== 'H' && g !== 'V' && g !== 'ANY' && g !== 'EDGE';   // warn ONLY '?'/unmatched (เอ๋ 2026-05-31 'เตือนเฉพาะค่าที่ไม่แน่ใจ' = desktop's "Grain unspecified"); H/V/ANY/EDGE = decided -> no warn
  }
  // Shoelace area of a polygon ([[x,y],...]) — used to spot degenerate outlines.
  function _polyArea(pts) {
    if (!Array.isArray(pts) || pts.length < 3) return 0;
    let a = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  }
  // Convex hull (Andrew's monotone chain) of a flat [[x,y],…] cloud. Used to
  // rebuild a closed silhouette for layer-"0" parts whose fragmented boundary
  // didn't stitch into an OUTER loop — so the part preview can FILL + clip the
  // grain hatch to the real shape (the flagged 2CN parts are convex rounded
  // rectangles → hull == outline; interior holes fall inside it). (เอ๋ 2026-06-21)
  function _convexHull(pts) {
    if (!Array.isArray(pts) || pts.length < 3) return Array.isArray(pts) ? pts.slice() : [];
    const p = pts.filter(a => a && isFinite(a[0]) && isFinite(a[1])).map(a => [a[0], a[1]])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }
  // Stitch open boundary segments end-to-end into ONE closed loop (same algorithm
  // as _extractPolygons' inner stitchLoop). Used to rebuild the EXACT outline of a
  // layer-"0" part for fill/hatch clip — unlike a convex hull it FOLLOWS concave
  // notches (the V-notch / bowtie ends on 2CN026) so the fill can't bleed past the
  // perimeter (เอ๋ 2026-06-21 'fill ไม่ให้เกินเส้นรอบรูป'). Returns null unless every
  // segment is consumed AND the loop closes (end ≈ start) within tol.
  function _stitchLoop(segments, tol) {
    const segs = (segments || []).map(s => s.slice()).filter(s => s.length >= 2);
    if (segs.length < 1) return null;
    const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;
    const used = new Array(segs.length).fill(false);
    used[0] = true;
    let loop = segs[0].slice();
    let go = true;
    while (go) {
      go = false;
      const tail = loop[loop.length - 1];
      let bi = -1, brev = false, bd = Infinity;
      for (let i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        const s = segs[i];
        const da = Math.hypot(tail[0] - s[0][0], tail[1] - s[0][1]);
        const db = Math.hypot(tail[0] - s[s.length - 1][0], tail[1] - s[s.length - 1][1]);
        if (da < bd) { bd = da; bi = i; brev = false; }
        if (db < bd) { bd = db; bi = i; brev = true; }
      }
      if (bi >= 0 && bd <= tol) {
        const s = brev ? segs[bi].slice().reverse() : segs[bi];
        for (let k = 1; k < s.length; k++) loop.push(s[k]);
        used[bi] = true;
        go = true;
      }
    }
    if (used.every(Boolean) && loop.length >= 4 && near(loop[0], loop[loop.length - 1])) return loop;
    return null;
  }
  // "Looks weird" reasons for a selected part (empty array = nothing to flag).
  // Checks: no DXF · DXF parse error / degenerate outline · parsed bbox vs the
  // size encoded in the 13-char code (…WWWHHH, 10mm units), ±25mm tolerance.
  // (user 2026-05-30 'ชิ้นนี้ดูแปลกๆ ให้เข้าไปดูหน่อย / ชิ้นนี้ไม่มี DXF')
  function _reviewReasons(p) {
    const out = [];
    if (!p || !p.selected || p.manual || _cabAllOff(p)) return out;
    if (!p.dxfUrl) { out.push('no DXF'); return out; }   // can't cut → nothing else to check
    if (p.dxfError) { out.push('DXF error: ' + p.dxfError); return out; }
    if (p.dxfLoaded) {
      const outer = p.polys && p.polys.outer;
      if (!outer || outer.length < 3 || _polyArea(outer) < 1) {
        out.push('degenerate outline');
      }
      // Size-vs-code (FORK A): compare the parsed bbox to the dims encoded in
      // the code. p.w/p.h are forced equal to the bbox on load, so the code is
      // the only independent reference.
      const m = /-(\d{3})(\d{3})$/.exec(p.code || '');
      if (m && p.bbox) {
        const bw = Math.round(p.bbox[2] - p.bbox[0]);
        const bh = Math.round(p.bbox[3] - p.bbox[1]);
        const wCode = parseInt(m[1], 10) * 10;
        const hCode = parseInt(m[2], 10) * 10;
        // Ratio window, not ±mm (เอ๋ 2026-06-10 "เตือนทำไม" on FN3BLA 700×48 vs
        // "800×0"): the code encodes NOMINAL cabinet dims — real flats are
        // legitimately smaller (clearances: an 800-cab strip cut at 700) or
        // larger (unfolds: DSV100 838 vs 800). Only flag a GROSS mismatch
        // (likely a wrong/stale file): no bbox dim within 0.5–1.5× of the
        // encoded dim. Zero-coded dims (e.g. "-080000" height 000) mean
        // "not specified" and are skipped, never compared.
        // ±80mm explicit allowance (เอ๋ 2026-06-10 "กลุ่มนี้ผมให้ค่าบวกลบได้ 80")
        // OR the 0.5–1.5× ratio window — whichever is looser passes.
        const near = v => v > 0 && [bw, bh].some(b =>
          Math.abs(b - v) <= 80 || (b >= v * 0.5 && b <= v * 1.5));
        const wBad = wCode > 0 && !near(wCode);
        const hBad = hCode > 0 && !near(hCode);
        if (wBad || hBad) {
          out.push(`DXF size ≈ ${bw}\xd7${bh}, code says ~${wCode}\xd7${hCode}`);
        }
      }
    }
    return out;
  }

  // A review reason is BLOCKING (the part literally can't be cut) vs a soft
  // WARNING (loadable but suspect). Blocking → red header chip; warning → amber.
  // Drives the prominent clickable error chip in the header summary. (เอ๋
  // 2026-06-26 'ให้ error เด่น กดดูได้ว่าอันไหนพัง')
  function _reasonIsBlocking(reason) {
    const r = String(reason || '').toLowerCase();
    return r.startsWith('no dxf') || r.startsWith('dxf error') || r.indexOf('degenerate') >= 0;
  }

  // Roll up every part's review reasons into {blocking, warning, parts:[{code,reasons,blocking}]}.
  // Single source of truth for both the header chip count and (reusing the same
  // data) the review banner the chip scrolls to.
  function _reviewSummary() {
    const parts = [];
    let blocking = 0, warning = 0;
    for (const p of S.parts) {
      const reasons = _reviewReasons(p);
      if (!reasons.length) continue;
      const isBlk = reasons.some(_reasonIsBlocking);
      if (isBlk) blocking++; else warning++;
      parts.push({ code: p.code, reasons, blocking: isBlk });
    }
    return { blocking, warning, parts };
  }

  // Build 0–3 stacked warning banners for the result pane. Persistent (not
  // dismissible) so a real problem can't be clicked away before cutting.
  // (user 2026-05-30 'จำนวนขาด ... ก็ไม่มีการแจ้งเตือน')
  function _warningsHtml() {
    const banners = [];

    // ⓪ Run tally — after a run, confirm how many of the requested pieces
    // actually landed on a sheet. Green when ALL placed, red when short, so the
    // worker never assumes 50/50 when it's really 45/50. (เอ๋ 2026-05-31 'บอก
    // ด้วยว่าที่ run มาได้ 50 ชิ้นจริงไหม ... ถ้าไม่ได้ต้องมีการแจ้งเตือน')
    {
      const placed = (S.flatSheets || []).reduce((n, s) => n + ((s.placements || []).length), 0);
      const unplaced = (S.unplaced || []).length;
      const total = placed + unplaced;
      if (total > 0) {   // a run has produced a result
        banners.push(unplaced > 0
          ? `<div class="kdnest-warn kdnest-warn--unplaced">
               <div class="kdnest-warn-head">✗ ${placed} / ${total} pieces placed — ${unplaced} short (see below)</div>
             </div>`
          : `<div class="kdnest-warn kdnest-warn--ok">
               <div class="kdnest-warn-head">✓ all ${total} pieces placed (${(S.flatSheets || []).length} sheet${(S.flatSheets || []).length === 1 ? '' : 's'})</div>
             </div>`);
      }
    }

    // ① Unplaced (red, loudest) — only after a run.
    if (S.unplaced && S.unplaced.length) {
      // Active stock thicknesses, so we can flag the "no matching sheet" cause.
      const tk = t => {
        const n = typeof t === 'number' ? t : parseFloat(String(t).replace(/[^\d.]/g, ''));
        return isNaN(n) ? '?' : String(Math.round(n * 100) / 100);
      };
      const stockThick = new Set(
        (S.sheetStock || [])
          .filter(s => s.enabled !== false && s.w > 0 && s.h > 0 && (s.qty !== 0 || s.qty === -1))
          .map(s => tk(s.thickness ?? 1))
      );
      const byCode = new Map();
      for (const pc of S.unplaced) {
        const e = byCode.get(pc.code) || { qty: 0, thickness: pc.thickness };
        e.qty += 1;
        byCode.set(pc.code, e);
      }
      const lines = [...byCode.entries()].map(([code, e]) => {
        const noStock = !stockThick.has(tk(e.thickness));
        const suffix = noStock ? ` (t=${tk(e.thickness)}mm — no matching sheet stock)` : '';
        return `<div class="kdnest-warn-line" title="${_esc(code)}">${_esc(_disp(code))} ×${e.qty}${suffix}</div>`;
      }).join('');
      const total = S.unplaced.length;
      banners.push(
        `<div class="kdnest-warn kdnest-warn--unplaced">
           <div class="kdnest-warn-head">⚠ ${total} piece${total === 1 ? '' : 's'} couldn't be placed</div>
           ${lines}
         </div>`
      );
    }

    // ② Grain → NO banner. Per เอ๋ 2026-05-30 the grain warning shows ONLY as
    // the amber ring marker (.kdnest-grain-warn) in each row's grain cell —
    // _isGrainDirectional drives that marker in _viewHtml (flags H/V parts so
    // the worker lays the grain the right way).

    // ②b Remnant grain clash — a saved offcut matched on thickness but its
    // grain direction couldn't take this run's directional parts, so it was
    // skipped instead of silently mis-used. Surface it so the worker knows a
    // leftover exists but didn't fit the grain. (เอ๋ 2026-05-31 'อยากให้ครบ')
    if (S.grainSkippedRemnants > 0) {
      banners.push(
        `<div class="kdnest-warn kdnest-warn--review">
           <div class="kdnest-warn-head">♻ ${S.grainSkippedRemnants} saved offcut${S.grainSkippedRemnants === 1 ? '' : 's'} skipped — grain direction doesn't match this run's parts</div>
         </div>`
      );
    }

    // ③ Review / looks-weird. Reuse _reviewSummary (same source the header chip
    // counts) and split by severity: BLOCKING parts (no DXF / DXF error — can't
    // be cut) get a loud RED banner; soft WARNINGS (size-vs-code / bloated) stay
    // amber. The header error chip scrolls to #kdnest-review-anchor. (เอ๋
    // 2026-06-26 'ให้ error เด่น กดดูได้ว่าอันไหนพัง')
    const _rev = _reviewSummary();
    if (_rev.parts.length) {
      const blk = _rev.parts.filter(r => r.blocking);
      const warn = _rev.parts.filter(r => !r.blocking);
      const lineHtml = r =>
        `<div class="kdnest-warn-line" title="${_esc(r.code)}">${_esc(_disp(r.code))} — ${_esc(r.reasons.join('; '))}</div>`;
      let body = '';
      if (blk.length) {
        body += `<div class="kdnest-warn kdnest-warn--unplaced" id="kdnest-review-anchor">
           <div class="kdnest-warn-head">⛔ ${blk.length} part${blk.length === 1 ? '' : 's'} can't be cut — NO DXF / DXF error:</div>
           ${blk.map(lineHtml).join('')}
         </div>`;
      }
      if (warn.length) {
        body += `<div class="kdnest-warn kdnest-warn--review"${blk.length ? '' : ' id="kdnest-review-anchor"'}>
           <div class="kdnest-warn-head">Review ${warn.length} part${warn.length === 1 ? '' : 's'}:</div>
           ${warn.map(lineHtml).join('')}
         </div>`;
      }
      banners.push(body);
    }

    return banners.join('');
  }

  function _viewHtml() {
    const nSheets = S.flatSheets.length;
    // Cabinet capsules: rows whose every cabinet is OFF disappear from the
    // list and all counts (เอ๋: "เอา/ไม่เอา เป็นรายตู้ ... จะได้ไม่ปนกัน").
    const visParts = S.parts.filter(p => !_cabAllOff(p));
    const totalPcs = visParts.reduce((s, p) => s + (p.selected ? (p.qty || 0) : 0), 0);
    const totalUnique = visParts.filter(p => p.selected).length;
    const loadedDxfs = visParts.filter(p => p.dxfLoaded).length;
    // Header error chip: roll up review reasons (NO DXF / DXF error = blocking;
    // size-vs-code / bloated = warning). Prominent + clickable → scrolls to the
    // review banner that lists which parts failed and why. (เอ๋ 2026-06-26)
    const _revHdr = _reviewSummary();
    const _errChip = (() => {
      if (!_revHdr.parts.length) return '';
      if (_revHdr.blocking) {
        const n = _revHdr.blocking;
        const more = _revHdr.warning ? ` +${_revHdr.warning}` : '';
        const tip = _revHdr.parts.filter(r => r.blocking).map(r => _disp(r.code) + ' — ' + r.reasons.join('; ')).join('\n');
        return ` <button class="kdnest-errchip kdnest-errchip-blk" type="button" title="${_esc(n + ' part(s) can\'t be cut (NO DXF / DXF error)' + (_revHdr.warning ? ' · +' + _revHdr.warning + ' to review' : '') + ' — click to see which:\n' + tip)}">⛔ ${n} ERR${more ? `<span class="kdnest-errchip-more">${more}</span>` : ''}</button>`;
      }
      const n = _revHdr.warning;
      const tip = _revHdr.parts.map(r => _disp(r.code) + ' — ' + r.reasons.join('; ')).join('\n');
      return ` <button class="kdnest-errchip kdnest-errchip-warn" type="button" title="${_esc(n + ' part(s) to review — click to see which:\n' + tip)}">⚠ ${n} REVIEW</button>`;
    })();

    // Grain symbols match the Python Nesting Tool + grain.xlsx legend
    // so a worker glancing at either tool sees the same mark per row:
    //   ─  = H  (horizontal — locked to 0/180 rotations)
    //   │  = V  (vertical — locked to 90/270 rotations)
    //   ✱  = ANY (any orientation — packer free to rotate)
    //   ?  = unknown (no grain set yet)
    // Click cycles ? → H → V → ANY → H ... — same as Python's
    // _toggle_grain.
    function grainGlyph(g) {
      if (g === 'H')   return { ch: '─', cls: 'kdnest-grain-h',   title: 'H — horizontal' };
      if (g === 'V')   return { ch: '│', cls: 'kdnest-grain-v',   title: 'V — vertical' };
      if (g === 'ANY') return { ch: '✱', cls: 'kdnest-grain-any', title: 'ANY — any rotation' };
      // EDGE (angled grain): grain locked parallel to a picked outline edge —
      // set by clicking an edge in the part preview, not by the cycle button.
      if (g === 'EDGE') return { ch: '◣', cls: 'kdnest-grain-edge', title: 'EDGE — grain parallel to a picked edge (open preview to change; click glyph to reset)' };
      return { ch: '?', cls: 'kdnest-grain-q', title: '? — grain not set' };
    }

    // Look up sheet index of the first placement for this code, so the
    // 📍 View@sheet button knows where to jump. -1 = not placed yet.
    function findSheetIdx(code) {
      for (let i = 0; i < S.flatSheets.length; i++) {
        if (S.flatSheets[i].placements.some(pl => pl.code === code)) return i;
      }
      return -1;
    }

    const partsRows = visParts.map((p, i) => {
      // Distinguish "no DXF yet" (drop-to-upload affordance) from a DXF that
      // FAILED to load/parse (timeout / HTTP / too large / bad geometry) — the
      // latter gets a clear RETRY button instead of a silent ⋯ (เอ๋ 2026-06-20:
      // "2CN000-120000 ค้าง DXF NOT LOADED YET" — safety net, RD board).
      const _noDxf = p.dxfError === 'No DXF uploaded yet';
      const _loadErr = !!p.dxfError && !_noDxf;
      const status = p.manual
        ? `<button class="kdnest-part-del" title="Remove this manual part">✕</button>`
        : p.dxfLoaded
          // ✓ also opens the part in Fusion (เอ๋ 2026-06-10 "เครื่องหมายถูกก็ทำให้
          // เปิด Fusion ได้ด้วย") — same bridge flow as the ⚠ button below.
          ? `<button class="kdnest-part-fusion kdnest-part-fusion-ok" title="DXF loaded — click to open this part in Fusion">✓</button>`
          : _loadErr
            // DXF failed to load/parse → a clear RETRY button (not a silent hang).
            // Dropping a fresh .dxf on the row also fixes it.
            ? `<button class="kdnest-part-retry" title="${_esc('⚠ Couldn\'t load DXF: ' + p.dxfError)} — click to retry, or drop a fresh .dxf on this row">⚠↻</button>`
            : _noDxf
              // No DXF yet → ⚠ opens the part in Fusion (or drop a .dxf on the row).
              ? `<button class="kdnest-part-fusion" title="No DXF — click to open in Fusion, or drop a .dxf on this row">⚠</button>`
              : `<span class="kdnest-part-load" title="loading DXF…">⋯</span>`;
      const g = grainGlyph(p.grain);
      const onSheetIdx = findSheetIdx(p.code);
      const viewDisabled = !p.dxfUrl;
      const sheetDisabled = onSheetIdx < 0;
      // DXF parts: W/H come from the parsed bbox — lock them so a stray edit
      // can't desync the size from the actual cut geometry. Manual rectangles
      // stay editable. (user 2026-05-30)
      // Size column: a failed/no-DXF part shows "—" (+ the reason in the tooltip),
      // not an empty box (เอ๋ "size ว่าง" was ambiguous).
      const whLock = p.manual ? '' : (_loadErr
        ? ` disabled title="${_esc('size unknown — ' + p.dxfError)}"`
        : ' disabled title="size comes from the DXF — locked"');
      const _szPh = (_loadErr || _noDxf) ? '—' : '';
      const grainDir = _isGrainDirectional(p);
      const grainWarn = grainDir ? ' kdnest-grain-warn' : '';
      const rowGrainWarn = grainDir ? ' kdnest-part-grainwarn' : '';
      const reviewMark = _reviewReasons(p).length ? ' kdnest-part-review' : '';
      return `
        <div class="kdnest-part${p.manual ? ' kdnest-part-manual' : ''}${rowGrainWarn}${reviewMark}${p.code === S.previewCode ? ' kdnest-part-active' : ''}" data-code="${_esc(p.code)}">
          <input type="checkbox" class="kdnest-part-sel" ${p.selected ? 'checked' : ''}>
          <span class="kdnest-part-num">#${i + 1}</span>
          <span class="kdnest-part-code" title="${_esc(p.code)}${p.origCode ? _esc(' · renamed from ' + p.origCode) : ''}${p.sources && Object.keys(p.sources).length > 1 ? _esc(' — ' + Object.entries(p.sources).map(([pk, q]) => pk + ' ×' + q).join(' + ')) : ''}">${p.manual ? '▭ ' : ''}${p.origCode ? '✎ ' : ''}${_esc(_disp(p.code))}${p.sources && Object.keys(p.sources).length > 1 ? `<sup class="kdnest-part-srcs" title="${_esc(Object.entries(p.sources).map(([pk, q]) => pk + ' ×' + q).join(' + '))}">${Object.keys(p.sources).length}P</sup>` : ''}</span>${(!p.manual && typeof window.isAdmin === 'function' && window.isAdmin()) ? `<button class="kdnest-part-rename" title="${p.origCode ? 'Re-pointed to ' + _esc(p.code) + ' (from ' + _esc(p.origCode) + ') — click to change or revert' : 'Rename / re-point this part code (web override — does not touch Fusion)'}" style="background:none;border:none;cursor:pointer;font-size:0.82em;opacity:0.5;padding:0 1px;line-height:1">✏️</button>` : ''}
          <input type="number" class="kdnest-part-w" value="${p.w || ''}" min="0" step="1" placeholder="${_szPh || 'W'}"${whLock}>
          <span class="kdnest-x">×</span>
          <input type="number" class="kdnest-part-h" value="${p.h || ''}" min="0" step="1" placeholder="${_szPh || 'H'}"${whLock}>
          <input type="number" class="kdnest-part-qty" value="${p.qty}" min="0" step="1" title="qty">
          <button class="kdnest-part-grain ${g.cls}${grainWarn}" data-grain="${p.grain}" title="${grainWarn ? 'grain not set yet — pick H/V if it matters · ' : ''}${g.title} — click to cycle ?→H→V→ANY">${g.ch}</button>
          <button class="kdnest-part-view" title="${p.manual ? 'Manual rectangle — no DXF' : 'View this part (preview)'}" ${viewDisabled ? 'disabled' : ''}>👁</button>
          <span class="kdnest-part-orient">
            <button class="kdnest-part-flip180${p.flip180 ? ' kdnest-orient-active' : ''}" title="Rotate 180° — flip this part's orientation (preview + nest + cut DXF)" ${p.manual ? 'disabled' : ''} data-flip180>⟲</button>
            <button class="kdnest-part-mirror${p.mirror ? ' kdnest-orient-active' : ''}" title="Mirror horizontally — left-right flip (makes the opposite-hand part; preview + nest + cut DXF)" ${(p.manual || !p.polys) ? 'disabled' : ''} data-mirror>↔︎</button>
          </span>
          <button class="kdnest-part-onsheet" data-sheet="${onSheetIdx}" title="${sheetDisabled ? 'Run Nesting first to place this part' : 'Jump to the sheet where this part is laid out'}" ${sheetDisabled ? 'disabled' : ''}>📍</button>
          ${status}
        </div>`;
    }).join('');

    // Unset-grain summary banner — counts parts whose grain is still ANY/blank
    // (undecided). One banner above the rows; empty when every part has a grain
    // set. (เอ๋ 2026-05-31 'เตือนเฉพาะตัวที่ไม่แน่ใจ'). Styled .kdnest-grain-summary.
    const _dirParts = S.parts.filter(_isGrainDirectional);
    const grainSummary = _dirParts.length
      ? `<div class="kdnest-grain-summary">⚠ ${_dirParts.length} part${_dirParts.length === 1 ? '' : 's'} have no grain rule — check the grain table (set ─ H / │ V / ✱ ANY)</div>`
      : '';

    // Cabinet capsules row — one pill per cabinet (variant_root), tap = toggle
    // include/exclude, + All/None for the group. Shown only when the manifest
    // actually carries cabinet data (at least one NAMED cabinet) so legacy
    // projects don't get a useless row. Badge = full design pcs of that cabinet.
    const cabGroups = _cabinetGroups();
    const showCabs = cabGroups.some(g => g.cab);
    const offCabsN = showCabs
      ? cabGroups.filter(g => S.cabinetsOff && S.cabinetsOff.has(g.cab)).length : 0;
    // Cabinet freshness (laser role) — NEW/CHANGED markers per cabinet, synced
    // per department (เอ๋ 2026-06-11). Engine is a global in app.js; single
    // project only in phase 1 (merged projects' cabinets just get no badge).
    const _cabFresh = (typeof cabinetFreshnessAll === 'function' && S.projectKey)
      ? cabinetFreshnessAll('laser', S.projectKey) : new Map();
    let _frNew = 0, _frChg = 0;
    for (const [, i] of _cabFresh) { if (i.status === 'new') _frNew++; else if (i.status === 'changed') _frChg++; }
    // F-group folders when the manifest carries an F-layer (471344e); otherwise
    // the flat list. Each folder = ▸/▾ collapse + a whole-group on/off header.
    const _cf = _cabinetFolders();
    const _fCodes = new Set(_cf.folders.map(f => f.fg));   // F1/F2… — for the 'direct' relabel
    // One capsule pill (off-state + freshness markers) — shared by the flat
    // list and the F-folder bodies.
    const _capsuleBtn = (g) => {
      const off = !!(S.cabinetsOff && S.cabinetsOff.has(g.cab));
      // A pill whose cab IS an F-group code = that group's direct parts; label
      // it 'direct' so it doesn't read like a duplicate of the folder header.
      const label = g.cab ? (_fCodes.has(g.cab) ? _disp(g.cab) + ' · direct' : _disp(g.cab)) : 'No cabinet';
      const fr = _cabFresh.get(g.cab);
      const frCls = fr && fr.status === 'new' ? ' kdnest-cab-new'
                  : fr && fr.status === 'changed' ? ' kdnest-cab-changed' : '';
      const frTag = fr && fr.status === 'new' ? '<sup class="kdnest-cab-fr">NEW</sup>'
                  : fr && fr.status === 'changed' ? '<sup class="kdnest-cab-fr">↻</sup>' : '';
      const frWord = fr && fr.status === 'new' ? ' · NEW (just arrived)'
                   : fr && fr.status === 'changed' ? ' · CHANGED (re-exported)' : '';
      const full = (g.cab || 'parts not under any cabinet')
        + ` — ${g.nParts} part${g.nParts === 1 ? '' : 's'} · ${g.pcs} pcs${frWord} · click to ${off ? 'include' : 'exclude'}, double-click = seen`;
      return `<button class="kdnest-cab${off ? ' kdnest-cab-off' : ''}${frCls}" data-cab="${_esc(g.cab)}" title="${_esc(full)}">${_esc(label)}<sup>${g.pcs}</sup>${frTag}</button>`;
    };
    const _capsuleArea = _cf.hasF ? (
        _cf.folders.map(fld => {
          const collapsed = !!(S.capFold && S.capFold.has(fld.fg));
          const total = fld.cabs.length;
          const onN = fld.cabs.filter(g => !(S.cabinetsOff && S.cabinetsOff.has(g.cab))).length;
          const allOff = total > 0 && onN === 0;
          return `<div class="kdnest-cabfolder${allOff ? ' kdnest-cabfolder-off' : ''}" data-fg="${_esc(fld.fg)}">`
            + `<button class="kdnest-cabfold-caret" data-fg="${_esc(fld.fg)}" title="${collapsed ? 'Expand' : 'Collapse'} ${_esc(fld.fg)}">${collapsed ? '▸' : '▾'}</button>`
            + `<button class="kdnest-cabfold-head" data-fg="${_esc(fld.fg)}"${total ? '' : ' disabled'} title="${total ? 'Click to ' + (allOff ? 'include' : 'exclude') + ' the whole ' + _esc(fld.fg) + ' group' : 'Empty group'}">`
            + `<span class="kdnest-cabfold-name">${_esc(fld.fg)}</span><span class="kdnest-cabfold-count">${onN}/${total}</span></button>`
            + `</div>`
            + (collapsed ? '' : `<div class="kdnest-cabfold-body" data-fg="${_esc(fld.fg)}">${
                total ? fld.cabs.map(_capsuleBtn).join('') : '<span class="kdnest-cabfold-empty">(empty)</span>'
              }</div>`);
        }).join('')
        + (_cf.ungrouped.length ? `<div class="kdnest-cabfold-body kdnest-cabfold-loose">${_cf.ungrouped.map(_capsuleBtn).join('')}</div>` : '')
      ) : cabGroups.map(_capsuleBtn).join('');
    const cabsRow = showCabs ? `
            <div class="kdnest-cabs${_cf.hasF ? ' kdnest-cabs-foldered' : ''}">
              <span class="kdnest-cabs-lab" title="Pick which cabinets join this nest — tap to exclude/include, double-tap to mark it seen">Cabinets</span>
              <button id="kdnest-cabs-all" class="kdnest-mini" title="Include every cabinet">All</button>
              <button id="kdnest-cabs-none" class="kdnest-mini" title="Exclude every cabinet">None</button>
              ${_capsuleArea}
            </div>${(_frNew || _frChg) ? `
            <div class="kdnest-cabs-fresh">${_frNew ? `<span class="kdnest-cab-fr">${_frNew} new</span>` : ''}${_frChg ? `<span class="kdnest-cab-fr">↻ ${_frChg} changed</span>` : ''}<button id="kdnest-cabs-seen" class="kdnest-mini" title="Mark every cabinet seen for the laser role">Mark all seen</button></div>` : ''}` : '';

    const sheetStockRows = S.sheetStock.map((s, i) => {
      const enabled = s.enabled !== false;
      return `
      <div class="kdnest-stock-row${enabled ? '' : ' kdnest-stock-off'}" data-i="${i}">
        <span class="drag-handle kdnest-stock-drag-handle" title="Drag to reorder (higher = try this size first)" aria-hidden="true">⋮⋮</span>
        <input type="checkbox" data-i="${i}" data-k="enabled" class="kdnest-stock-enable" ${enabled ? 'checked' : ''} title="Enable / disable this size — disabled rows are skipped when nesting">
        <input type="number" data-i="${i}" data-k="w"         value="${s.w || ''}"        min="0" class="kdnest-stock-dim"   placeholder="W">
        <span>×</span>
        <input type="number" data-i="${i}" data-k="h"         value="${s.h || ''}"        min="0" class="kdnest-stock-dim"   placeholder="H">
        <span>mm</span>
        <input type="number" data-i="${i}" data-k="qty"       value="${s.qty || 0}"               class="kdnest-stock-qty"   title="qty — use -1 for unlimited">
        <input type="number" data-i="${i}" data-k="thickness" value="${s.thickness ?? 1}" min="0" step="0.1" class="kdnest-stock-thick" title="Thickness (mm) — only parts of this thickness get nested onto this stock">
        <span class="kdnest-stock-thick-suffix">mm</span>
        <input type="number" data-i="${i}" data-k="prc" value="${s.prc ?? _getPriceDefault(s.w, s.h, s.label)}" min="0" step="1" class="kdnest-stock-prc" title="Price per sheet (THB) — auto-set by size, override as needed. 8x4=2350, 10x4=2750, 10x5=3850. Custom=0">
        <span class="kdnest-stock-prc-suffix">THB</span>
        <span class="kdnest-stock-label">${_esc(s.label || '')}</span>
      </div>`;
    }).join('');

    const sheetNavInfo = nSheets ? `${S.currentSheetIdx + 1} / ${nSheets}` : '0 / 0';
    const previewInfo = (() => {
      if (!S.previewCode) return '';
      const i = S.parts.findIndex(p => p.code === S.previewCode);
      const pp = S.parts[i];
      if (!pp) return '';
      const dims = (pp.w && pp.h) ? ` (${pp.w}×${pp.h} mm)` : '';
      return `Preview: #${i + 1} ${_esc(_disp(pp.code))}${dims} · ↑/↓ flip · ‹ › exits`;
    })();
    const curSheet = S.flatSheets[S.currentSheetIdx];
    const sheetSubLine = curSheet
      ? `${Math.round(curSheet.sw)}×${Math.round(curSheet.sh)} mm${curSheet.thick && curSheet.thick !== '?' ? ` · ${curSheet.thick}mm` : ''} · ${curSheet.placements.length} parts`
      : 'Run Nesting to layout';

    // Admin-only sidebar splitter — drag the strip between sidebar
    // and canvas to resize. Workshop staff don't need it; admins do
    // (user 2026-05-28: 'ให้ admin ขยาย ย่อ side panel ได้').
    const isAdminUser = (typeof window.isAdmin === 'function' && window.isAdmin());
    const sidebarStyle = (S.sidebarWidth && isAdminUser)
      ? ` style="width:${S.sidebarWidth}px"`
      : '';

    return `
      <div class="kdnest-shell">
        <aside class="kdnest-sidebar"${sidebarStyle}>
          <div class="kdnest-header">
            <button class="kdnest-back" id="kdnest-back" title="Back to project">←</button>
            <div class="kdnest-title">
              <div class="kdnest-title-main"><svg class="nest-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3.5" width="18" height="17" rx="1.5"/><rect x="5.5" y="6" width="6" height="5" rx="0.6"/><rect x="13" y="6" width="5.5" height="8.5" rx="0.6"/><rect x="5.5" y="13" width="7.5" height="5" rx="0.6"/></svg>Nesting</div>
              <div class="kdnest-title-sub">${_esc(S.projectName)}${(S.mergedProjects && S.mergedProjects.length > 1) ? ` <span class="kdjobs-stale" title="${_esc('Merged projects: ' + S.mergedProjects.join(' + '))}">+${S.mergedProjects.length - 1} project${S.mergedProjects.length > 2 ? 's' : ''}</span>` : ''} · ${totalUnique} unique · ${totalPcs} pcs · ${loadedDxfs}/${visParts.length} DXF loaded${_errChip}${offCabsN ? ` · <span class="kdjobs-stale" title="${_esc(cabGroups.filter(g => S.cabinetsOff.has(g.cab)).map(g => g.cab || 'No cabinet').join(' + ') + ' excluded from this nest')}">−${offCabsN} cab</span>` : ''}${(S.loadedJobStale && S.loadedJobStale.length) ? ` · <span class="kdjobs-stale" title="${_esc(_STALE_TITLE + ' (' + S.loadedJobStale.join(', ') + ')')}">⚠ Outdated — Run Nesting again</span>` : ''}</div>
            </div>
          </div>
          <div class="kdnest-controls">
            <label class="kdnest-mode-lab">Mode
              <select id="kdnest-mode">
                ${['Auto','True Shape','MaxRects','BL Corner','Left','Bottom','Max Remnant','Desktop']
                  .map(m => `<option value="${m}" ${m === S.mode ? 'selected' : ''}>${m}</option>`).join('')}
              </select>
            </label>
            <label class="kdnest-gap-lab">Gap
              <input id="kdnest-gap" type="number" value="${S.gap}" min="0" step="1">
              <span>mm</span>
            </label>
            <label class="kdnest-rectleft-lab" title="Re-pack the LAST sheet so the leftover becomes one usable rectangle (saved as a remnant ≥300mm)">
              <input id="kdnest-rectleft" type="checkbox"${S.rectLeftover ? ' checked' : ''}> Rect leftover (last)
            </label>
            <label class="kdnest-optmanual-lab" title="Manual: Run uses the sheet stock exactly as set (no cost-optimize). OFF (default) = Run auto-picks the cheapest enabled sheet-size mix by price.">
              <input id="kdnest-optmanual" type="checkbox"${S.optManual ? ' checked' : ''}> Manual
            </label>
            <!-- Common-line (🔗 + tab) controls removed 2026-06-26 (เอ๋ 'ยกเลิกแผนการรวมเส้นทั้งหมด').
                 _clActive is forced false in _buildSheetDxf; the merge code is inert. -->
          </div>
          <!-- Skip-remnants checkbox moved INTO the Remnants Stock modal as
               "Use remnants" (เอ๋ 2026-06-10 'skip Remnants ให้มาอยู่ที่ Remnants
               stock — คลิกคือใช้งาน'). "Don't remember" removed — offcuts are
               now remembered on 💾 Save Nest, not on every Run. -->
          <div class="kdnest-stock">
            <div class="kdnest-stock-title">Sheet stock</div>
            ${sheetStockRows}
          </div>${_renderCostSummary()}
          <div class="kdnest-actions">
            <button id="kdnest-run" class="kdnest-btn kdnest-btn-run"><svg class="kdnest-btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3.5" width="18" height="17" rx="1.5"/><rect x="5.5" y="6" width="6" height="5" rx="0.6"/><rect x="13" y="6" width="5.5" height="8.5" rx="0.6"/><rect x="5.5" y="13" width="7.5" height="5" rx="0.6"/></svg> Run Nesting</button>
            ${nSheets
              ? '<button id="kdnest-savenest" class="kdnest-btn kdnest-btn-save" title="Save this nest (layout, parts, stock, cut sheets) + save into the Project + remember offcuts"><svg class="kdnest-btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.7 h11 l3 3 V19.5 a0.8 0.8 0 0 1 -0.8 0.8 H5.8 a0.8 0.8 0 0 1 -0.8 -0.8 Z"/><path d="M8 3.7 v4.8 h6.5 v-4.8"/><rect x="8" y="12.5" width="8" height="6" rx="0.4"/></svg> Save Nest</button>'
                + '<button id="kdnest-loadnest" class="kdnest-btn kdnest-btn-jobs" title="Load a DIFFERENT saved nest (switch to another saved layout)"><svg class="kdnest-btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.7 a1 1 0 0 1 1 -1 h4.2 l1.6 2 H20 a1 1 0 0 1 1 1 V19 a1 1 0 0 1 -1 1 H4 a1 1 0 0 1 -1 -1 Z"/><rect x="7" y="11.5" width="10" height="6" rx="0.5"/><line x1="12" y1="11.5" x2="12" y2="17.5"/></svg> Load</button>'
              : '<button id="kdnest-savenest" class="kdnest-btn kdnest-btn-jobs" title="Load a nest you saved earlier to view it"><svg class="kdnest-btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.7 a1 1 0 0 1 1 -1 h4.2 l1.6 2 H20 a1 1 0 0 1 1 1 V19 a1 1 0 0 1 -1 1 H4 a1 1 0 0 1 -1 -1 Z"/><rect x="7" y="11.5" width="10" height="6" rx="0.5"/><line x1="12" y1="11.5" x2="12" y2="17.5"/></svg> Load Nest</button>'}
            <button id="kdnest-grain" class="kdnest-btn kdnest-btn-grain" title="Edit grain / thickness rules (shared — no Excel needed)"><svg class="kdnest-btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="1.5"/><line x1="6.5" y1="9" x2="17.5" y2="9"/><line x1="6.5" y1="12" x2="13.5" y2="12"/><line x1="6.5" y1="15" x2="17.5" y2="15"/><path d="M13.5 12 H18 M16.3 10.3 L18 12 L16.3 13.7"/></svg> Grain</button>
            <button id="kdnest-stock" class="kdnest-btn kdnest-btn-stock" title="Remnant offcut stock — view / add / delete"><svg class="kdnest-btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 4.5 H20.5 V11 H11.5 V19.5 H3.5 Z"/><path d="M11.5 11 H20.5 V19.5 H11.5 Z" stroke-dasharray="2.2 2"/></svg> Remnants Stock</button>
          </div>
          <div class="kdnest-parts">
            <div class="kdnest-parts-head">
              <button id="kdnest-parts-all" class="kdnest-mini">All</button>
              <button id="kdnest-parts-none" class="kdnest-mini">None</button>
              ${isAdminUser ? '<button id="kdnest-add-rect" class="kdnest-mini kdnest-add-rect" title="Add a manual rectangular part (no DXF) — set W×H">+ ▭ Rect</button>' : ''}
              <button id="kdnest-default-grain" class="kdnest-mini kdnest-default-grain" title="Set every part that has NO grain rule (?) to its DEFAULT — the original incoming orientation (kept as drawn, not rotated 90°). Clears the warning; applies for this run only (not saved to the grain table).">Default</button>
              <button id="kdnest-addproj" class="kdnest-mini" title="Merge another project's parts into this nest (multi-project nesting) — per-project counts are kept on every part">+ Project</button>
              <button id="kdnest-reresolve" class="kdnest-mini" title="Re-resolve codes: re-read each part's CURRENT code from the project (by Fusion lineage) and re-link its DXF — clears NO-DXF rows stuck on an old code after a Fusion rename, in place, no remove/re-add.">↻ Re-resolve</button>
              <span class="kdnest-parts-count">${totalUnique} / ${visParts.length} · ${totalPcs} pcs</span>
            </div>
            ${cabsRow}
            ${grainSummary}
            ${partsRows || '<div class="kdnest-empty">No parts in this project</div>'}
          </div>
        </aside>
        ${isAdminUser ? '<div class="kdnest-splitter" id="kdnest-splitter" title="Drag to resize the sidebar (admin only)"></div>' : ''}
        <main class="kdnest-canvas-wrap">
          ${_warningsHtml()}
          <div class="kdnest-canvas-top">
            <span class="kdnest-canvas-info">${S.previewCode ? previewInfo : `Sheet ${sheetNavInfo} · ${_esc(sheetSubLine)}`}</span>
            <div class="kdnest-nav">
              <button id="kdnest-prev" class="kdnest-nav-btn" ${nSheets > 0 ? '' : 'disabled'}>‹</button>
              <span class="kdnest-nav-pos" title="Sheet ${nSheets ? S.currentSheetIdx + 1 : 0} of ${nSheets}">${nSheets ? `${S.currentSheetIdx + 1}/${nSheets}` : '0/0'}</span>
              <button id="kdnest-next" class="kdnest-nav-btn" ${nSheets > 0 ? '' : 'disabled'}>›</button>
            </div>
          </div>
          <canvas id="kdnest-canvas"></canvas>
        </main>
      </div>`;
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Human-facing DISPLAY name for a part code (admin display_override, shared with the
  // rest of the app). The raw code stays the machine identity everywhere else in nest
  // (byCode map, piece keys, data-code attrs, the BOM CSV the laser reads). (RD 02)
  function _disp(code) {
    try { return (typeof displayCodeFor === 'function') ? displayCodeFor(code) : code; }
    catch (e) { return code; }
  }

  function _wireEvents() {
    const $ = sel => S.rootEl.querySelector(sel);
    $('#kdnest-back')?.addEventListener('click', close);
    $('#kdnest-run')?.addEventListener('click', _runNestingAuto);
    // Header error chip → reveal WHICH parts failed. (a) flash the review banner
    // (built from the same _reviewSummary data); (b) ALSO highlight + scroll to
    // the failing part ROWS in the left list so เอ๋ sees the real culprit, not
    // just the banner. (เอ๋ 2026-06-26 'กดดูได้ว่าอันไหนพัง' → 'กดแล้วไป
    // highlight แถวชิ้นที่พังในลิสต์ซ้าย')
    $('.kdnest-errchip')?.addEventListener('click', () => {
      const root = S.rootEl;
      if (!root) return;
      // (a) flash the review banner (keep — useful on narrow / stacked layouts)
      const anchor = root.querySelector('#kdnest-review-anchor');
      if (anchor) {
        anchor.classList.remove('kdnest-warn-flash');
        void anchor.offsetWidth;   // reflow → restart animation
        anchor.classList.add('kdnest-warn-flash');
        setTimeout(() => anchor.classList.remove('kdnest-warn-flash'), 1800);
      }
      // (b) point at the actual broken parts: blink + scroll to the failing ROWS
      //     (blocking first → red; soft review → amber). Match rows by data-code.
      const sev = new Map(_reviewSummary().parts.map(r => [r.code, r.blocking]));
      const rows = [...root.querySelectorAll('.kdnest-part')]
        .filter(el => sev.has(el.getAttribute('data-code')))
        .sort((a, b) => (sev.get(b.getAttribute('data-code')) ? 1 : 0)
                      - (sev.get(a.getAttribute('data-code')) ? 1 : 0));
      for (const el of rows) {
        const cls = sev.get(el.getAttribute('data-code')) ? 'kdnest-row-errflash' : 'kdnest-row-warnflash';
        el.classList.remove(cls);
        void el.offsetWidth;   // reflow → restart animation
        el.classList.add(cls);
        setTimeout(() => el.classList.remove(cls), 2000);
      }
      // scroll the first (blocking) failing row into view LAST so it wins
      if (rows.length) rows[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    // Manual toggle — ON = run as-is (today's behavior, no cost-optimize trials).
    $('#kdnest-optmanual')?.addEventListener('change', e => {
      S.optManual = !!e.target.checked;
      try { localStorage.setItem('kd_nest_optmanual_v1', S.optManual ? '1' : '0'); } catch (_) {}
      // Manual vs auto-optimize changes how Run picks the sheet mix → the shown
      // cost may no longer match what the next run would produce. Mark stale +
      // refresh so the summary dims with the hint.
      if (S.flatSheets && S.flatSheets.length) { S.costStale = true; _refreshView(); }
    });
    // ONE adaptive button (เอ๋ 2026-06-10): nest run/loaded → 💾 Save Nest
    // (save + into Project + remember offcuts); nothing yet → 📂 Load Nest.
    $('#kdnest-savenest')?.addEventListener('click', () =>
      (S.flatSheets || []).length ? _saveProject() : _openSavedJobsModal());
    // Secondary Load — present only when a nest is already showing, so the
    // adaptive button (now 💾 Save Nest) doesn't strand the user with no way to
    // load a DIFFERENT saved nest (เอ๋ 2026-06-10 'กด load nest ไม่ได้' — the
    // Load button vanished once sheets were on screen).
    $('#kdnest-loadnest')?.addEventListener('click', _openSavedJobsModal);
    // Export JSON button removed (เอ๋ 2026-05-31 'i export json ทำงานอยู่หลังบ้าน
    // อยู่แล้ว ถ้าจริงก็ไม่ต้องโชว์') — Save Project already persists the full job
    // to Firebase (nest_jobs/), so the local-file export was redundant UI.
    // _exportJobJson kept in code in case a backup affordance is wanted later.
    $('#kdnest-grain')?.addEventListener('click', _openGrainModal);
    $('#kdnest-stock')?.addEventListener('click', _openStockModal);
    $('#kdnest-prev')?.addEventListener('click', () => {
      const wasPreview = !!S.previewCode; S.previewCode = null;   // ‹ exits preview
      if (S.currentSheetIdx > 0) { S.currentSheetIdx--; _refreshView(); }
      else if (wasPreview) _refreshView();
    });
    $('#kdnest-next')?.addEventListener('click', () => {
      const wasPreview = !!S.previewCode; S.previewCode = null;   // › exits preview
      if (S.currentSheetIdx < S.flatSheets.length - 1) { S.currentSheetIdx++; _refreshView(); }
      else if (wasPreview) _refreshView();
    });
    $('#kdnest-mode')?.addEventListener('change', e => { S.mode = e.target.value; _refreshView(); });   // re-render: 🔗 Common-line auto-disables on True Shape, re-enables on other modes
    $('#kdnest-rectleft')?.addEventListener('change', e => {
      S.rectLeftover = !!e.target.checked;
      try { localStorage.setItem('kd_nest_rectleft_v1', S.rectLeftover ? '1' : '0'); } catch (err) {}
    });
    $('#kdnest-gap')?.addEventListener('change', e => { S.gap = parseFloat(e.target.value) || 0; });
    // Common-line: affects the SAVED Cut Sheet DXF (_buildSheetDxf), not the
    // layout — no re-run needed; re-render only to enable/disable the tab control.
    $('#kdnest-common')?.addEventListener('change', e => {
      S.commonLine = !!e.target.checked;
      try { localStorage.setItem('kd_nest_common_v1', S.commonLine ? '1' : '0'); } catch (_) {}
      _refreshView();
    });
    $('#kdnest-commontab')?.addEventListener('change', e => {
      S.commonTabs = !!e.target.checked;
      try { localStorage.setItem('kd_nest_commontab_v1', S.commonTabs ? '1' : '0'); } catch (_) {}
    });
    $('#kdnest-commontabmm')?.addEventListener('change', e => {
      const n = parseFloat(e.target.value);
      if (n > 0 && n < 20) { S.commonTabMm = n; try { localStorage.setItem('kd_nest_commontabmm_v1', String(n)); } catch (_) {} }
    });
    // (skip/remember checkboxes removed from the sidebar — see Remnants Stock
    // modal's "Use remnants" toggle + Save-Nest offcut remembering.)
    $('#kdnest-parts-all')?.addEventListener('click', () => {
      S.parts.forEach(p => { p.selected = true; }); _refreshView();
    });
    $('#kdnest-parts-none')?.addEventListener('click', () => {
      S.parts.forEach(p => { p.selected = false; }); _refreshView();
    });
    $('#kdnest-add-rect')?.addEventListener('click', () => {
      S.parts.push(_newManualPart());
      _refreshView();
      // focus the new row's W field so the admin can type dimensions right away
      const rows = S.rootEl.querySelectorAll('.kdnest-part-manual .kdnest-part-w');
      const last = rows[rows.length - 1];
      if (last) last.focus();
    });
    // Default direction (เอ๋ 2026-06-10 'default = ค่าในครั้งแรกที่ถูกส่งเข้ามา'):
    // one click sets every part with NO grain rule (grain '?') to its ORIGINAL
    // incoming orientation = grain H (rots [0,180]) — the part keeps the W×H it
    // was drawn with, NOT rotated 90°. Clears the "no grain rule" warning without
    // opening the grain table per part. Session-only (no rule written); a real
    // grain.xlsx/Grain-modal rule still wins.
    $('#kdnest-default-grain')?.addEventListener('click', () => {
      let n = 0;
      for (const p of S.parts) {
        if (p.manual) continue;
        const g = String(p.grain || '').toUpperCase();
        if (g !== 'H' && g !== 'V' && g !== 'ANY') { p.grain = 'H'; n++; }
      }
      _refreshView();
    });
    // ＋ Project — merge another project's parts into this nest (เอ๋ 76ebca5).
    $('#kdnest-addproj')?.addEventListener('click', _openAddProjectModal);
    // ↻ Re-resolve — adopt each part's CURRENT manifest code (by lineage urn) +
    // re-link its DXF in place; fixes NO-DXF rows after a Fusion rename (RD/เอ๋).
    $('#kdnest-reresolve')?.addEventListener('click', _reresolveCodes);
    // Cabinet capsules — tap toggles one cabinet; All/None act on the group.
    $('#kdnest-cabs-all')?.addEventListener('click', () => _setAllCabinets(true));
    $('#kdnest-cabs-none')?.addEventListener('click', () => _setAllCabinets(false));
    S.rootEl.querySelectorAll('.kdnest-cab').forEach(btn => {
      // single click = include/exclude (capsule); double click = acknowledge
      // the cabinet's freshness for the LASER role (badge clears).
      btn.addEventListener('click', () => _toggleCabinet(btn.dataset.cab));
      btn.addEventListener('dblclick', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (typeof markCabinetSeen !== 'function') return;
        const cab = btn.dataset.cab;
        const cq = _cabinetCodeQty(S.projectKey).get(cab) || new Map();
        markCabinetSeen('laser', S.projectKey, cab, _cabinetFingerprint(cq));
        _refreshView();
      });
    });
    // F-folder controls: caret = collapse/expand, header = whole-group on/off.
    S.rootEl.querySelectorAll('.kdnest-cabfold-caret').forEach(btn => {
      btn.addEventListener('click', () => _toggleCapFold(btn.dataset.fg));
    });
    S.rootEl.querySelectorAll('.kdnest-cabfold-head').forEach(btn => {
      btn.addEventListener('click', () => { if (!btn.disabled) _toggleCabinetGroup(btn.dataset.fg); });
    });
    $('#kdnest-cabs-seen')?.addEventListener('click', () => {
      if (typeof markAllCabinetsSeen === 'function' && S.projectKey) {
        markAllCabinetsSeen('laser', S.projectKey); _refreshView();
      }
    });
    // Sheet-stock editors + ↑/↓ priority reorder. The packer walks the
    // stock list in order, so moving a row up = 'try this size first'.
    S.rootEl.querySelectorAll('.kdnest-stock-dim, .kdnest-stock-qty, .kdnest-stock-thick, .kdnest-stock-prc').forEach(el => {
      el.addEventListener('change', e => {
        const i = parseInt(e.target.dataset.i, 10);
        const k = e.target.dataset.k;
        if (!isNaN(i) && S.sheetStock[i]) {
          S.sheetStock[i][k] = parseFloat(e.target.value) || 0;
          // Once the user fills the custom row, drop its '(custom)'
          // label so it doesn't read 'custom' forever after.
          if ((k === 'w' || k === 'h') && S.sheetStock[i].w > 0
              && S.sheetStock[i].h > 0 && S.sheetStock[i].label === '(custom)') {
            S.sheetStock[i].label = '';
          }
          // When the size changes and the row still has no price, seed the
          // size default (no clobber of a user-entered price). เอ๋ 2026-06-26.
          if (k === 'w' || k === 'h') _applyPriceDefault(S.sheetStock[i]);
          _persistStock();
          // Stock changed after a result → the shown cost is from the OLD run.
          if (S.flatSheets && S.flatSheets.length) S.costStale = true;
          // PRC (or a size that changed the auto-price) shifts the total —
          // re-render just the cost summary in place, no full _refreshView.
          if (k === 'prc' || k === 'w' || k === 'h') {
            const summaryEl = S.rootEl.querySelector('.kdnest-cost-summary');
            if (summaryEl) summaryEl.outerHTML = _renderCostSummary();
          }
        }
      });
    });
    // Per-row enable checkbox — disabled rows are skipped when nesting
    // (เอ๋ 2026-06-26). Toggling repaints + persists immediately so the
    // greyed-out look and the next ▶ Run both reflect the new state.
    S.rootEl.querySelectorAll('.kdnest-stock-enable').forEach(cb => {
      cb.addEventListener('change', e => {
        const i = parseInt(e.target.dataset.i, 10);
        if (!isNaN(i) && S.sheetStock[i]) {
          S.sheetStock[i].enabled = e.target.checked;
          _persistStock();
          // Toggling a size on/off changes the cost mix → mark the shown total stale.
          if (S.flatSheets && S.flatSheets.length) S.costStale = true;
          _refreshView();
        }
      });
    });
    // Drag-to-reorder the stock rows (replaces the old ↑/↓ buttons). The
    // packer walks the list top-to-bottom, so order = size priority.
    // Mirrors the project-card Sortable wiring in app.js (forceFallback
    // for iPad/touch). On drop, rebuild S.sheetStock from the new DOM
    // order, persist, and re-render so data-i indices stay fresh.
    const stockListEl = S.rootEl.querySelector('.kdnest-stock');
    if (stockListEl && window.Sortable) {
      window.Sortable.create(stockListEl, {
        animation: 150,
        draggable: '.kdnest-stock-row',   // leave the .kdnest-stock-title put
        handle: '.kdnest-stock-drag-handle',
        ghostClass: 'kdnest-stock-ghost',
        chosenClass: 'kdnest-stock-chosen',
        dragClass: 'kdnest-stock-drag',
        forceFallback: true,
        fallbackTolerance: 4,
        onEnd: () => {
          const order = [...stockListEl.querySelectorAll('.kdnest-stock-row')]
            .map(el => parseInt(el.dataset.i, 10))
            .filter(n => !isNaN(n));
          const reordered = order.map(i => S.sheetStock[i]).filter(Boolean);
          if (reordered.length === S.sheetStock.length) {
            S.sheetStock.splice(0, S.sheetStock.length, ...reordered);
            _persistStock();
            // Order = size priority for the packer → the next run may pick a
            // different mix, so the shown cost is potentially stale.
            if (S.flatSheets && S.flatSheets.length) S.costStale = true;
            _refreshView();
          }
        },
      });
    }
    // Per-part edits — preserve focus + scroll position via delegation.
    S.rootEl.querySelectorAll('.kdnest-part').forEach(row => {
      const code = row.dataset.code;
      const part = S.parts.find(p => p.code === code);
      if (!part) return;
      // ✏️ rename / re-point this part code (admin, web override — เอ๋ 2026-06-20)
      row.querySelector('.kdnest-part-rename')?.addEventListener('click', () => _startRenameEdit(row, part));
      row.querySelector('.kdnest-part-sel')?.addEventListener('change', e => {
        part.selected = e.target.checked;
      });
      row.querySelector('.kdnest-part-w')?.addEventListener('change', e => {
        part.w = parseFloat(e.target.value) || 0;
      });
      row.querySelector('.kdnest-part-h')?.addEventListener('change', e => {
        part.h = parseFloat(e.target.value) || 0;
      });
      row.querySelector('.kdnest-part-qty')?.addEventListener('change', e => {
        part.qty = parseInt(e.target.value, 10) || 0;
      });
      // Grain toggle — click cycles ? → H → V → ANY → H ...
      // Matches the Python tool's _toggle_grain behavior so a worker
      // switching between tools sees the same interaction.
      row.querySelector('.kdnest-part-grain')?.addEventListener('click', () => {
        // EDGE is set by clicking an edge in the preview, NOT by this cycle. So
        // a click on an EDGE glyph RESETS it (clears the persisted EDGE rule
        // back to '?'); the user can then cycle ?→H→V→ANY or re-pick an edge.
        // (angled-grain feature 2026-06-25, spec Option A)
        if (part.grain === 'EDGE') {
          _setPartEdgeGrain(part, null).then(() => _setPreview(part.code));
          return;
        }
        const cycle = { '?': 'H', 'H': 'V', 'V': 'ANY', 'ANY': 'H' };
        part.grain = cycle[part.grain] || 'H';
        _setPreview(part.code);   // preview this part so the grain rotation is visible
      });
      // View part — open DXF preview modal for this part's source DXF.
      // Hand the FULL RTDB metadata to the modal (same object the Laser
      // cut list passes) so all derived fields — uploaded_at "10m ago",
      // size_bytes "19 KB", filename — match between the two views.
      // 👁 → clear in-canvas single-part preview (desktop-style). ↑/↓ then
      // flips through parts; a sheet ‹/› or Run Nesting returns to the nest.
      row.querySelector('.kdnest-part-view')?.addEventListener('click', () => {
        _setPreview(part.code);
      });
      // ⟲180 / ⟷ — per-part orientation toggles. Each flips the LIVE flag on THIS
      // row's part object + makes it the previewed part + repaints IMMEDIATELY (no
      // reload), then persists the FLIP180 / MIRROR exact-code grain_rules row in
      // the background. The flipped flag is honored by both nesting and DXF export
      // so the cut part matches what the worker sees. (Rotate-180 + Mirror 2026-06-26)
      //
      // Resolve the target by the row's LIVE data-code at click time — NOT only the
      // closure `part` — so the button can never act on a stale/other part even if
      // S.parts was re-ordered between render and click. _toggleOrientFlag then pins
      // S.previewCode to this same code, so the canvas stays on (or switches to) the
      // toggled part and the active class tracks it. (live wrong-part hardening 2026-06-26)
      const _orientTarget = () =>
        S.parts.find(p => p.code === row.dataset.code) || part;
      row.querySelector('.kdnest-part-flip180')?.addEventListener('click', () => {
        _togglePartFlip180(_orientTarget());
      });
      row.querySelector('.kdnest-part-mirror')?.addEventListener('click', () => {
        _togglePartMirror(_orientTarget());
      });
      // ⚠ (no DXF) → open the part in Fusion via the :8765 bridge. Reuses
      // app.js's _routeLeafToFusion (kdAPI.routeLeaf): bridge open + "Opening
      // in Fusion…" toast on success, explanatory alert when it can't.
      row.querySelector('.kdnest-part-fusion')?.addEventListener('click', () => {
        // kdAPI.routeLeaf only exists once the mindmap editor has mounted —
        // window.kdRouteLeaf is the always-available handle app.js exposes.
        const route = (window.kdAPI && window.kdAPI.routeLeaf) || window.kdRouteLeaf;
        if (typeof route !== 'function') { alert('Open-in-Fusion bridge not available.'); return; }
        // fusionOnly: this button means "open in FUSION to fix" — never a PDF tab.
        route({ code: part.code, status: 'missing', urn: part.urn || null, drawing_urn: null, fusion_link: null }, { fusionOnly: true });
      });
      // ↻ RETRY — re-attempt loading a DXF that failed (timeout / HTTP / too large /
      // parse). The file's still in uploaded_dxfs; just re-fetch+parse it.
      row.querySelector('.kdnest-part-retry')?.addEventListener('click', async () => {
        const btn = row.querySelector('.kdnest-part-retry');
        if (btn) { btn.textContent = '⏳'; btn.title = 'retrying…'; }
        part.dxfError = null; part.dxfLoaded = false;
        try { await _ensureDxfLib(); await _loadOneDxf(part); } catch (_) {}
        _refreshViewKeepScroll();   // re-render (✓ or ⚠↻) keeping เอ๋'s scroll
      });
      // ⚠ DROP-TO-UPLOAD (เอ๋ 2026-06-20): drag a .dxf onto a NO-DXF row → upload
      // this part's DXF directly (manual, alongside the Fusion-export pipeline) →
      // Drawings/dxf/<code>/<code>.dxf + uploaded_dxfs/<code> via app.js
      // (window.kdUploadPartDxf — SAME laser pipeline, code CASE-PRESERVED). The
      // WHOLE row is the target (easy to hit; the ⚠ shows the affordance). On
      // success the row updates IN PLACE — NO _refreshView — so the page never
      // jumps (เอ๋ "อยู่หน้าเดิม ไม่กระโดด"); a global guard (app.js) stops a missed
      // drop from navigating the browser to the file.
      const _fBtn = row.querySelector('.kdnest-part-fusion, .kdnest-part-retry');
      if (_fBtn && part.dxfError && !part.dxfLoaded) {
        _fBtn.title += ' · or DROP a .dxf on this row to upload it';
        const _over = on => {
          _fBtn.style.boxShadow = on ? '0 0 0 2px #2563eb' : '';
          _fBtn.style.background = on ? 'rgba(37,99,235,0.18)' : '';
          row.style.outline = on ? '1px dashed #2563eb' : '';
          row.style.outlineOffset = on ? '-1px' : '';
        };
        row.addEventListener('dragenter', e => { e.preventDefault(); e.stopPropagation(); _over(true); });
        row.addEventListener('dragover',  e => { e.preventDefault(); e.stopPropagation(); _over(true); });
        row.addEventListener('dragleave', e => { if (e.target === row) _over(false); });
        row.addEventListener('drop', async e => {
          e.preventDefault(); e.stopPropagation(); _over(false);
          const files = [...((e.dataTransfer && e.dataTransfer.files) || [])].filter(f => /\.dxf$/i.test(f.name));
          if (!files.length) { alert('Drop a .dxf file onto this part row.'); return; }
          if (files.length > 1) { alert('Drop one .dxf at a time.'); return; }
          if (typeof window.kdUploadPartDxf !== 'function') { alert('DXF upload not available — open the main app as admin (🔓) first.'); return; }
          const proj = Object.keys(part.sources || {})[0] || '';
          const _txt = _fBtn.textContent, _ttl = _fBtn.title;
          _fBtn.textContent = '⏫'; _fBtn.title = 'uploading…';
          const r = await window.kdUploadPartDxf(proj, part.code, files[0]);
          if (!r || !r.ok) { alert('Upload failed for ' + part.code + ':\n' + ((r && r.error) || 'unknown error')); _fBtn.textContent = _txt; _fBtn.title = _ttl; return; }
          // Parse the DROPPED BYTES directly (opts.text) — NOT a raw re-fetch.
          // After a REPLACE, raw.githubusercontent can serve the OLD cached file
          // for minutes, so re-fetching would show the stale size/view and the
          // drop would look "still broken" even when the upload succeeded
          // (root cause of RD's 2CN000-120000 mis-read 2026-06-20). The File is
          // exactly what we committed → parse it, zero CDN ambiguity.
          part.dxfUrl = r.url; part.dxfMeta = r.metadata || null; part.dxfError = null; part.dxfLoaded = false;
          part.thickness = (r.metadata && r.metadata.thickness_mm) || part.thickness || 0;
          let _bytes = null;
          try { _bytes = await files[0].text(); } catch (_) {}
          try { await _ensureDxfLib(); await _loadOneDxf(part, _bytes != null ? { text: _bytes } : { directUrl: r.url }); } catch (_) {}
          // Update THIS row in place — no full re-render → the page stays exactly put.
          if (part.dxfLoaded) {
            const wEl = row.querySelector('.kdnest-part-w'), hEl = row.querySelector('.kdnest-part-h');
            if (wEl) wEl.value = part.w || ''; if (hEl) hEl.value = part.h || '';
            const vEl = row.querySelector('.kdnest-part-view'); if (vEl) vEl.disabled = false;
            // HONEST state: don't flash a clean ✓ for a file the review logic still
            // flags (degenerate / gross size-vs-code) OR that's obviously BLOATED
            // (a clean per-part DXF is tens of KB; 150 KB+ = a faceted, non-true-
            // vector export → re-export clean per the vector-only rule). เอ๋ saw
            // ✓ on a 197 KB faceted 2CN000-120000 and thought it was fixed — it
            // wasn't (WEB16 2026-06-20). Show ⚠-review so the file's state is true.
            const reasons = _reviewReasons(part);
            const kb = files[0].size ? Math.round(files[0].size / 1024) : 0;
            if (kb >= 150) reasons.push('bloated ' + kb + ' KB — re-export clean vector');
            if (reasons.length) {
              _fBtn.textContent = '⚠';
              _fBtn.classList.remove('kdnest-part-fusion-ok');
              _fBtn.title = 'DXF loaded but needs review: ' + reasons.join('; ') + ' — click to open this part in Fusion';
              row.classList.add('kdnest-part-review');
            } else {
              _fBtn.textContent = '✓';
              _fBtn.classList.add('kdnest-part-fusion-ok');
              _fBtn.title = 'DXF loaded — click to open this part in Fusion';
              row.classList.remove('kdnest-part-review');
            }
          } else {
            // uploaded but the parse failed — it's in uploaded_dxfs now;
            // reopening the nest will load it. Restore the ⚠.
            _fBtn.textContent = '⚠'; _fBtn.title = (part.dxfError || 'DXF error') + ' — uploaded; reopen the nest to load it';
          }
        });
      }
      // ✕ remove a manual rectangular part
      row.querySelector('.kdnest-part-del')?.addEventListener('click', () => {
        S.parts = S.parts.filter(x => x !== part);
        if (S.previewCode === part.code) S.previewCode = null;
        _refreshView();
      });
      // View @ sheet — jump to whichever sheet currently has this
      // part placed AND highlight every placement of this code on
      // that sheet (white glow + thick stroke). 3-second auto-clear
      // so the highlight doesn't linger and confuse a later glance.
      row.querySelector('.kdnest-part-onsheet')?.addEventListener('click', e => {
        const idx = parseInt(e.currentTarget.dataset.sheet, 10);
        if (idx >= 0 && idx < S.flatSheets.length) {
          S.currentSheetIdx = idx;
          S.highlightCode = part.code;
          _refreshView();
          // Auto-clear after a few seconds so the next click on a row
          // doesn't get a confusing stale-highlight from the previous.
          clearTimeout(window.__kdNestHighlightTO);
          window.__kdNestHighlightTO = setTimeout(() => {
            S.highlightCode = null;
            _refreshView();
          }, 3500);
        }
      });
    });
    // Canvas redraw on resize.
    window.addEventListener('resize', () => {
      const canvas = $('#kdnest-canvas');
      if (!canvas) return;
      if (S.previewCode) {
        _drawPartPreview(canvas, S.parts.find(p => p.code === S.previewCode));
      } else if (S.flatSheets[S.currentSheetIdx]) {
        _drawSheet(canvas, S.flatSheets[S.currentSheetIdx]);
      }
    }, { passive: true });

    // Admin sidebar splitter — pointer-driven drag-resize. Width
    // persists to localStorage so the choice survives reload + tab
    // switches. Bounds: 280px (still readable) ↔ 60% of window width.
    const splitter = $('#kdnest-splitter');
    const sidebar = S.rootEl.querySelector('.kdnest-sidebar');
    if (splitter && sidebar) {
      let dragging = false;
      let shellRect = null;
      const MIN_W = 280;
      const onMove = (ev) => {
        if (!dragging || !shellRect) return;
        const x = ev.touches ? ev.touches[0].clientX : ev.clientX;
        const maxW = Math.max(MIN_W + 40, Math.round(window.innerWidth * 0.6));
        let w = Math.max(MIN_W, Math.min(maxW, x - shellRect.left));
        sidebar.style.width = w + 'px';
        S.sidebarWidth = w;
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        try { localStorage.setItem(_LS_SIDEBAR_W, String(S.sidebarWidth || '')); }
        catch (e) {}
        // Canvas needs a redraw since its container resized.
        const canvas = $('#kdnest-canvas');
        if (canvas && S.flatSheets[S.currentSheetIdx]) {
          _drawSheet(canvas, S.flatSheets[S.currentSheetIdx]);
        }
      };
      splitter.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        dragging = true;
        const shell = S.rootEl.querySelector('.kdnest-shell');
        shellRect = shell ? shell.getBoundingClientRect() : { left: 0 };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
    }
  }

  const _LS_SIDEBAR_W = 'kd_nest_sidebar_w_v1';

  // ════════════════════════════════════════════════════════════════════
  //  Public API
  // ════════════════════════════════════════════════════════════════════
  async function openProject(projectKey) {
    if (!projectKey) return;
    S.rootEl = document.getElementById('root');
    if (!S.rootEl) return;
    _teardownDxfWatcher();   // drop any prior project's live DXF watcher first
    // ↑/↓ flips through parts in single-part preview (desktop-style). Bound
    // to the document so it works anywhere in the workspace; ignored while a
    // field is focused so the W/H/qty spinners keep their native arrows.
    if (S._onKeyNav) document.removeEventListener('keydown', S._onKeyNav);
    S._onKeyNav = (e) => {
      if (S.closing || !S.rootEl) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        // In single-part preview → flip parts. While a part is highlighted on
        // its sheet (📍) → browse placed parts on their sheets. Otherwise fall
        // back to entering the single-part preview.
        if (S.previewCode) _movePreview(delta);
        else if (S.highlightCode) _moveOnSheet(delta);
        else _movePreview(delta);
      } else if (e.key === 'Escape') {
        if (S.previewCode) { e.preventDefault(); S.previewCode = null; _refreshView(); }
        else if (S.highlightCode) { e.preventDefault(); clearTimeout(window.__kdNestHighlightTO); S.highlightCode = null; _refreshView(); }
      }
    };
    document.addEventListener('keydown', S._onKeyNav);
    // Fresh run state — clear any prior project's results so a stale "pieces
    // couldn't be placed" banner can't show against the newly-opened project
    // before its first Run. (the banner renders from S.unplaced on _viewHtml)
    S.unplaced = [];
    S.flatSheets = [];
    S.currentSheetIdx = 0;
    S.previewCode = null;
    S.prevHtml = S.rootEl.innerHTML;
    S.rootEl.innerHTML = `<p class="loading">Loading nesting workspace…</p>`;
    // Restore the admin's preferred sidebar width.
    try {
      const w = parseInt(localStorage.getItem(_LS_SIDEBAR_W) || '', 10);
      if (!isNaN(w) && w >= 280) S.sidebarWidth = w;
    } catch (e) {}
    try {
      await _loadProjectParts(projectKey);
      _refreshView();
      // Kick DXF parse off as a background phase so the user sees the
      // parts list immediately, then watches the ✓ markers populate.
      _loadAllDxfs().then(() => {
        if (S.closing) return;
        _refreshView();
        _installDxfWatcher();   // live ⚠→✓ when a DXF lands later (Fusion 🔥 / drop)
      });
    } catch (e) {
      console.error('[kdNest] open failed', e);
      S.rootEl.innerHTML = `<p class="loading">Failed to open nesting: ${_esc(e.message || e)}</p>`;
    }
  }

  function close() {
    S.closing = true;
    _teardownDxfWatcher();   // stop the live DXF listener — no leak, no fire after close
    if (S.rootEl && S.prevHtml != null) {
      S.rootEl.innerHTML = S.prevHtml;
    }
    // Trigger app.js's render() so it rebuilds the project view fresh
    // (state may have changed via Save Sheets).
    if (typeof window.render === 'function') {
      try { window.render(); } catch (e) {}
    }
    S.closing = false;
    S.rootEl = null;
    S.prevHtml = null;
    S.flatSheets = [];
    S.unplaced = [];
    S.currentSheetIdx = 0;
    S.previewCode = null;
    if (S._onKeyNav) { document.removeEventListener('keydown', S._onKeyNav); S._onKeyNav = null; }
  }

  // Eagerly load grain.json once at module init so the Laser cut list
  // (rendered by app.js) can call lookupGrain() synchronously without
  // having to await its own fetch. Promise is also exposed so callers
  // can wait if they need a guaranteed-ready map.
  const _grainReady = (async () => {
    try {
      const resp = await fetch('grain.json?v=' + Date.now(), { cache: 'no-store' });
      if (resp.ok) {
        const json = await resp.json();
        S.grainMap = _buildPatternMap(json.rows || []);
      }
    } catch (e) {
      console.warn('[kdNest] grain.json initial load failed:', e);
    }
  })();

  function lookupGrain(code) {
    const looked = _lookupPattern(code, S.grainMap);
    return looked && looked.grain ? looked.grain : null;
  }

  function grainGlyph(g) {
    if (g === 'H')   return { ch: '─', cls: 'kdnest-grain-h',   title: 'H — horizontal' };
    if (g === 'V')   return { ch: '│', cls: 'kdnest-grain-v',   title: 'V — vertical' };
    if (g === 'ANY') return { ch: '✱', cls: 'kdnest-grain-any', title: 'ANY — any rotation' };
    if (g === 'EDGE') return { ch: '◣', cls: 'kdnest-grain-edge', title: 'EDGE — grain parallel to a picked edge' };
    return { ch: '?', cls: 'kdnest-grain-q', title: '? — grain not set' };
  }

  // Fetch + parse a single DXF url into {polys, bbox} — the exact same
  // pipeline _loadAllDxfs uses per part. Exposed so app.js's Laser
  // cut-list preview renders identically to the Nest preview (clean cut
  // path, bend layers stripped) instead of the cluttered toSVG dump.
  async function loadPartPreview(dxfUrl) {
    await _ensureDxfLib();
    if (!dxfUrl) throw new Error('No DXF uploaded yet');
    const resp = await fetch(_toJsdelivrUrl(dxfUrl), { cache: 'force-cache' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const parsed = window.dxf.parseString(await resp.text());
    const ex = _extractPolygons(parsed);
    return {
      polys: { outer: ex.outer, strokes: ex.strokes || [], holes: ex.holes, entities: ex.entities || [] },
      bbox: ex.bbox,
    };
  }

  window.kdNest = {
    openProject: openProject,
    close: close,
    // The project whose nest WORKSPACE is currently open (null when on the
    // picker / closed). Lets app.js persist "เอ๋ was inside this nest" across a
    // reload and re-open it (เอ๋ 2026-06-20 "กด reload แล้วไปหน้าอื่น"). S.rootEl
    // is set only while the workspace is mounted; close() nulls it.
    currentProject: () => (S.rootEl ? S.projectKey : null),
    // Open the shared Remnants Stock modal from anywhere (e.g. the Laser
    // Cut List) — it loads from RTDB + appends to <body>, no nest workspace
    // needed. (เอ๋ 2026-05-31 'ให้แสดงที่ User Laser ด้วย')
    openStock: _openStockModal,
    // Shared state for app.js (Laser cut list etc.) so all views
    // present the same H/V/ANY badge per part without re-implementing
    // the pattern-matching priority.
    lookupGrain: lookupGrain,
    grainGlyph: grainGlyph,
    grainReady: _grainReady,
    // Shared part preview — app.js's Laser cut-list VIEW reuses these so
    // it looks exactly like the Nest's single-part preview (user
    // 2026-05-30: 'view ใน Part ของ Laser ก็ให้เหมือน view ที่ Nest').
    loadPartPreview: loadPartPreview,
    drawPart: _drawPartPreview,
    // Diagnostics — returns the live nest state (sheets, parts, pieces).
    // Used to measure fill ratio / locate interior gaps when tuning the
    // packer. Harmless (admin-only workspace).
    _debug: function () { return S; },
    // Pure helpers exposed for the Node test harness so it exercises the REAL
    // toggle + geometry code (not copies). No DOM needed: _applyOrientFlag
    // mutates a part + rows array in place; _orientedGeom applies EDGE+mirror.
    // (Rotate-180 + Mirror toggle-takes-effect-immediately fix 2026-06-26)
    _test: {
      applyOrientFlag: _applyOrientFlag,
      orientedGeom: _orientedGeom,
      // DOM-level harness hooks (test-only). Let a jsdom test drive the REAL
      // click path: seed S, render+wire the real handlers, then dispatch a real
      // 'click' on the ⟲180 / ⟷ buttons and assert the previewed part (not some
      // other part) gets the flag + the preview stays put + the button's active
      // class tracks the previewed part. (live orient-button fix 2026-06-26)
      state: () => S,
      refreshView: _refreshView,
      setPreview: _setPreview,
      // Auto-path harness hooks (test-only). Let a Node/jsdom test drive the REAL
      // cost-optimize → final-run → downsize chain and assert the last sheet swaps
      // to the cheaper size EVEN when _runNesting crosses an async boundary (the
      // gate-race regression guard). (downsize gate race fix 2026-06-26)
      runNestingAuto: _runNestingAuto,
      runNesting: _runNesting,
      downsizeLastFreshSheet: _downsizeLastFreshSheet,
      buildNestPieces: _buildNestPieces,
      buildSheetDxf: _buildSheetDxf,        // common-line verification hook
      commonLineMerge: _commonLineMerge,    // pure merge engine (unit-testable)
      rasterMask: _rasterMask,              // True-Shape mask (overlap debug hook)
      // Returns the background save promise so a test can AWAIT the full async
      // toggle chain (live flag → save → re-render settle) before asserting that
      // the previewed part survived — the path a sync-only assertion missed.
      toggleOrientFlag: _toggleOrientFlag,
    },
  };
})();
