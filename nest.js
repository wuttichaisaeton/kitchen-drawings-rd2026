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
    sheetStock: [
      // Defaults requested 2026-05-28:
      //   3050 × 1525  qty 1  thickness 1  label '10x5'  (10ft × 5ft)
      //   3050 × 1220  qty 1  thickness 1  label '10x4'  (10ft × 4ft)
      //   2440 × 1220  qty 1  thickness 1  label '8x4'   (8ft × 4ft)
      //   custom (W,H,qty,thickness all editable)
      // Row order = priority; ↑/↓ buttons reorder. Rows with w=0
      // or h=0 are skipped by the packer. Thickness gates which
      // parts each row can hold — a 0.8mm sheet only takes 0.8mm
      // parts even if a row above it has a 1mm sheet that fits.
      { w: 3050, h: 1525, qty: 1, thickness: 1, label: '10x5' },
      { w: 3050, h: 1220, qty: 1, thickness: 1, label: '10x4' },
      { w: 2440, h: 1220, qty: 1, thickness: 1, label: '8x4'  },
      { w: 0,    h: 0,    qty: 0, thickness: 1, label: '(custom)' },
    ],
    mode: 'Desktop',   // default — mirrors the desktop NestingTool (เอ๋: best layout, 2026-05-30)
    skipRemnants: true,   // default ON — user 2026-05-28 wants fresh stock first
    dontRemember: false,  // Phase 2 toggle — pre-wired UI, packer doesn't
                          // track remnants yet so both flags are no-ops
                          // until that lands. User 2026-05-28 wanted UI
                          // parity with the Python tool's twin toggles.
    gap: 2,
    grainMap: null,       // populated by _loadGrainMap once per session
    sidebarWidth: null,   // px — null = use CSS default; admin can drag to resize
    highlightCode: null,  // when set, draw a glow ring around every
                          // placement with this code on the current sheet —
                          // turned on by the 📍 'View @ sheet' button so
                          // the user can spot WHERE on the sheet that
                          // part ended up (user 2026-05-28: 'view@sheet
                          // ให้ทำ Hilight ด้วย').
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
      w: 0, h: 0, grain: 'ANY', grainExplicit: true, thickness: 1,
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
      grain: 'ANY',     // H / V / ANY — read from CSV later
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
    const outerStrokes = [];   // every OUTER-layer polyline / line / arc
    const interior = [];       // every INTERIOR-layer entity
    for (const e of parsed.entities) {
      const pts = entityPoints(e);
      if (!pts || pts.length < 2) continue;
      const layer = String(e.layer || '');
      if (isCutLayer(layer)) {
        for (const [x, y] of pts) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
      if (/OUTER/i.test(layer)) {
        outerStrokes.push(pts);
      } else if (/INTERIOR/i.test(layer)) {
        interior.push(pts);
      } else {
        // Untagged cut content — assume outer.
        outerStrokes.push(pts);
      }
    }

    const bbox = isFinite(minX) ? [minX, minY, maxX, maxY] : null;

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
    return { outer, strokes, holes: interior, bbox };
  }

  // ── Fetch + parse DXFs in parallel ─────────────────────────────────
  // Returns when ALL parts have either {bbox set, polys set} or
  // {dxfError set}. Errors don't block — those parts get filtered
  // out before nesting.
  async function _loadAllDxfs() {
    await _ensureDxfLib();
    const tasks = S.parts.map(async function (p) {
      if (!p.dxfUrl) {
        p.dxfError = 'No DXF uploaded yet';
        return;
      }
      try {
        const fetchUrl = _toJsdelivrUrl(p.dxfUrl);
        const resp = await fetch(fetchUrl, { cache: 'force-cache' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        const parsed = window.dxf.parseString(text);
        const ex = _extractPolygons(parsed);
        p.polys = { outer: ex.outer, strokes: ex.strokes || [], holes: ex.holes };
        p.bbox = ex.bbox;
        if (ex.bbox) {
          // Default W/H to the bbox dimensions; user can override.
          p.w = Math.round(ex.bbox[2] - ex.bbox[0]);
          p.h = Math.round(ex.bbox[3] - ex.bbox[1]);
        }
        p.dxfLoaded = true;
      } catch (e) {
        p.dxfError = String(e.message || e);
      }
    });
    await Promise.all(tasks);
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

    // Aggregate qty by code.
    const byCode = new Map();
    for (const p of partsRaw) {
      if (!p || !p.code) continue;
      const ex = byCode.get(p.code);
      if (ex) ex.qty += (p.qty || 0);
      else byCode.set(p.code, _newPart(p.code, p.qty));
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

    // Apply grain.json rules — same pattern table the Python tool reads
    // from NestingTool/grain.xlsx. User edits the xlsx; a one-shot
    // conversion writes drawings-ui/grain.json next to it. Patterns:
    // exact > XX wildcard > longest prefix > longest suffix > longest
    // substring (matches Python's lookup_in_map priority).
    if (true) {   // always reload live RTDB grain_rules (เอ๋'s modal edits win over the grain.json seed)
      // grain_rules (RTDB, edited in the 🧬 Grain modal) is the live source;
      // grain.json is the seed when RTDB is empty. _loadGrainRows does both.
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
        if (looked && looked.thickness && !part.thickness) {
          const t = parseFloat(looked.thickness.replace(/mm/i, ''));
          if (!isNaN(t)) part.thickness = t;
        }
      }
    }

    S.projectKey = projectKey;
    S.projectName = project.name || projectKey;
    S.parts = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  }

  // ── Grain rules editor (RTDB grain_rules, seeded from grain.json) ─────
  // Edit grain/thickness on the web instead of opening grain.xlsx. Stored
  // at RTDB grain_rules = { rows:[{pattern,grain,thickness}], updated_at }.
  // Phase B (Fusion) syncs this back to grain.xlsx + grain.json for the
  // desktop/laser side. (user 2026-05-29)
  function _grainCh(g) {
    g = String(g || '').toUpperCase();
    return g === 'H' ? '─' : g === 'V' ? '│' : '✱';
  }
  function _grainNext(g) {
    g = String(g || '').toUpperCase();
    return g === 'H' ? 'V' : g === 'V' ? 'ANY' : 'H';
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
    S.grainRows = (rows || []).map(r => ({
      pattern: String(r.pattern || ''),
      grain: String(r.grain || 'ANY').toUpperCase(),
      thickness: (r.thickness == null ? '' : String(r.thickness)),
    }));
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
      if (looked && looked.thickness) {
        const t = parseFloat(String(looked.thickness).replace(/mm/i, ''));
        if (!isNaN(t)) part.thickness = t;
      }
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
        <button class="kdng-grain" data-i="${i}" title="grain — click to cycle H / V / ANY">${_grainCh(r.grain)}</button>
        <input class="kdng-th" data-i="${i}" value="${_esc(r.thickness)}" placeholder="mm" inputmode="decimal">
        <button class="kdng-del" data-i="${i}" title="delete rule">✕</button>
      </div>`;
    const half = Math.ceil(rows.length / 2);
    const colA = rows.slice(0, half).map((r, i) => cell(r, i)).join('');
    const colB = rows.slice(half).map((r, i) => cell(r, i + half)).join('');
    const modal = document.createElement('div');
    modal.className = 'kdng-modal';
    modal.innerHTML = `
      <div class="kdng-backdrop"></div>
      <div class="kdng-box">
        <div class="kdng-head">🧬 Grain rules
          <span class="kdng-sub">pattern → grain · thickness · ${rows.length} rules · shared</span>
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
    q('.kdng-backdrop').addEventListener('click', discard);
    q('#kdng-cancel').addEventListener('click', discard);
    modal.querySelectorAll('.kdng-pat').forEach(el => el.addEventListener('input', e => {
      const i = +e.target.dataset.i; if (S.grainRows[i]) S.grainRows[i].pattern = e.target.value;
    }));
    modal.querySelectorAll('.kdng-th').forEach(el => el.addEventListener('input', e => {
      const i = +e.target.dataset.i; if (S.grainRows[i]) S.grainRows[i].thickness = e.target.value;
    }));
    modal.querySelectorAll('.kdng-grain').forEach(el => el.addEventListener('click', e => {
      const i = +e.currentTarget.dataset.i;
      if (S.grainRows[i]) {
        S.grainRows[i].grain = _grainNext(S.grainRows[i].grain);
        e.currentTarget.textContent = _grainCh(S.grainRows[i].grain);
      }
    }));
    modal.querySelectorAll('.kdng-del').forEach(el => el.addEventListener('click', e => {
      const i = +e.currentTarget.dataset.i; S.grainRows.splice(i, 1); _renderGrainModal();
    }));
    q('#kdng-add').addEventListener('click', () => {
      S.grainRows.push({ pattern: '', grain: 'ANY', thickness: '' }); _renderGrainModal();
    });
    q('#kdng-save').addEventListener('click', async () => {
      const btn = q('#kdng-save'); btn.disabled = true; btn.textContent = '💾 Saving…';
      try { await _saveGrainRows(); modal.remove(); _refreshView(); }
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
      return '<div class="kdstock-card" data-id="' + _esc(r.id) + '">'
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
      + '<div class="kdstock-foot"><span class="kdng-spacer"></span><button id="kdstock-close" class="kdnest-btn">Close</button></div>'
      + '</div>';
    document.body.appendChild(modal);
    const q = sel => modal.querySelector(sel);
    const close = () => modal.remove();
    q('.kdstock-backdrop').addEventListener('click', close);
    q('#kdstock-close').addEventListener('click', close);
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
    const m = { exact: {}, prefix: [], xx: [], substring: [], suffix: [] };
    for (const row of rows) {
      const pattern = String(row.pattern || '').trim();
      if (!pattern) continue;
      const value = { grain: String(row.grain || 'H').toUpperCase(), thickness: row.thickness || '' };
      const starts = pattern.startsWith('*');
      const ends = pattern.endsWith('*');
      if (starts && ends && pattern.length > 2) {
        const sub = pattern.replace(/^\*+|\*+$/g, '').replace(/[-_]+$/, '').toLowerCase();
        if (sub) m.substring.push([sub, value]);
      } else if (starts) {
        const suf = pattern.replace(/^\*+/, '').replace(/[-_]+$/, '').toLowerCase();
        if (suf) m.suffix.push([suf, value]);
      } else if (ends) {
        const pre = pattern.replace(/\*+$/, '').replace(/[-_]+$/, '').toLowerCase();
        if (pre) m.prefix.push([pre, value]);
      } else if (/XX/.test(pattern)) {
        const re = new RegExp(
          '^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/XX/g, '..') + '(\\s|$|-|_)',
          'i'
        );
        m.xx.push([re, value]);
      } else {
        m.exact[pattern] = value;
        const clean = pattern.replace(/\s+v\d+$/, '');
        if (clean !== pattern) m.exact[clean] = value;
      }
    }
    // Sort longer patterns first — more-specific match wins.
    m.prefix.sort((a, b) => b[0].length - a[0].length);
    m.suffix.sort((a, b) => b[0].length - a[0].length);
    m.substring.sort((a, b) => b[0].length - a[0].length);
    return m;
  }

  function _lookupPattern(name, m) {
    if (!m || !name) return null;
    if (m.exact[name]) return m.exact[name];
    const lower = name.toLowerCase();
    for (const [re, val] of m.xx) if (re.test(name)) return val;
    for (const [pre, val] of m.prefix) if (lower.startsWith(pre)) return val;
    for (const [suf, val] of m.suffix) if (lower.endsWith(suf)) return val;
    for (const [sub, val] of m.substring) if (lower.indexOf(sub) >= 0) return val;
    return null;
  }

  // ════════════════════════════════════════════════════════════════════
  //  Packers (JS ports of the Python implementations)
  // ════════════════════════════════════════════════════════════════════

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
      for (let gy = 0; gy < mh; gy++) {
        const Y = (gy + 0.5) * R, xs = [];
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

  function _nestMultiSheetRaster(pieces, stock, gap) {
    // Resolution: ~1/200 of the smaller sheet side, min 5mm. Finer = tighter
    // + more accurate gap, but quadratically slower.
    const minSide = Math.min.apply(null, stock.map(s => Math.min(s.w, s.h)).concat([1525]));
    const R = Math.max(5, Math.round(minSide / 200));
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
    while (remaining.length) {
      let placedAny = false;
      for (let si = 0; si < stockCopy.length; si++) {
        const s = stockCopy[si];
        if (s.qty === 0) continue;
        const gw = Math.ceil(s.w / R), gh = Math.ceil(s.h / R);
        const occ = new Uint8Array(gw * gh);
        const placed = [], stillLeft = [];
        for (const piece of remaining) {
          let best = null;
          for (const rot of piece.rots) {
            const mask = getMask(piece, rot);
            const pos = _blFind(occ, gw, gh, mask);
            if (pos && (best === null || pos.gy < best.gy ||
                        (pos.gy === best.gy && pos.gx < best.gx))) {
              best = { rot, mask, gx: pos.gx, gy: pos.gy };
            }
          }
          if (best) {
            _stamp(occ, gw, gh, best.mask, best.gx, best.gy, dCells);
            placed.push({ ...piece, x: best.gx * R, y: best.gy * R, rot: best.rot });
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
      const gw = Math.ceil(sheet.sw / R), gh = Math.ceil(sheet.sh / R);
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
        const gw = Math.ceil(sheet.sw / R), gh = Math.ceil(sheet.sh / R);
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
      while (remaining.length) {
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
      const r = runFirstFit(m);
      if (best === null || r.unplaced.length < best.unplaced.length
          || (r.unplaced.length === best.unplaced.length && r.sheets.length < best.sheets.length)) {
        best = r;
      }
    }
    return best || { sheets: [], unplaced: pieces.slice() };
  }

  function _nestMultiSheet(pieces, stock, gap, mode) {
    // pieces: [{code, w, h, rots:[0,90,...], qty}]
    // stock: [{w, h, qty}]   qty=-1 → unlimited
    // Returns: {sheets: [{sw, sh, placements:[{...}]}], unplaced: [...]}

    if (mode === 'True Shape') return _nestMultiSheetRaster(pieces, stock, gap);
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
      while (remaining.length) {
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
  // After a run, save the largest offcut of each sheet to the shared Remnants
  // pool (เอ๋ 2026-05-31 'กด run nesting แล้ว...ทำไมไม่มีเศษวัสดุ'). Skipped when
  // Don't remember is checked. Re-running REPLACES this project's prior auto
  // offcuts (auto:true + sourceProject) so tuning doesn't pile up duplicates;
  // manual remnants and other projects' offcuts are never touched.
  const _REMNANT_MIN = 150;   // mm — ignore slivers smaller than this on a side
  async function _autoSaveRemnants() {
    if (S.dontRemember) return;          // user opted out of remembering this run
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
        const off = _largestOffcut(sheet);
        if (!(off.w >= _REMNANT_MIN && off.h >= _REMNANT_MIN)) continue;
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
          note: 'Auto · sheet ' + (i + 1),
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
    } catch (e) { console.warn('[kdNest] auto-save remnants failed:', e); }
  }

  // ════════════════════════════════════════════════════════════════════
  //  Run Nesting
  // ════════════════════════════════════════════════════════════════════
  function _runNesting() {
    S.previewCode = null;   // running shows the nest result, not a part preview
    // Expand parts into per-instance pieces (qty copies each) and
    // restrict rotations by grain (H = no 90/270, V = no 0/180,
    // ANY = all four).
    const pieces = [];
    for (const p of S.parts) {
      if (!p.selected) continue;
      if (p.w <= 0 || p.h <= 0) continue;
      if (!p.bbox && !p.manual) continue;   // DXF parts need a parsed bbox; manual synth one
      const bbox = p.bbox || [0, 0, p.w, p.h];
      const rots = (p.grain === 'H') ? [0, 180]
                 : (p.grain === 'V') ? [90, 270]
                 :                     [0, 90, 180, 270];
      for (let i = 0; i < p.qty; i++) {
        pieces.push({
          code: p.code, w: p.w, h: p.h, rots: rots,
          polys: p.polys, bbox: bbox, thickness: p.thickness,
          grain: String(p.grain || 'ANY').toUpperCase(),   // for remnant grain-fit gating
        });
      }
    }
    if (pieces.length === 0) {
      alert('No parts to nest — check selection / DXF loading status.');
      return;
    }
    // Skip zero-sized stock rows (the always-present empty 4th row,
    // or any row the user blanked out). Preserve order = priority.
    const activeStock = S.sheetStock.filter(s => s.w > 0 && s.h > 0 && (s.qty !== 0 || s.qty === -1));
    if (activeStock.length === 0) {
      alert('No usable sheet stock — fill in at least one row with W, H and qty.');
      return;
    }

    // Group pieces by thickness so a 0.8mm BM part can't get nested
    // onto a 1mm stock sheet (and vice versa). User 2026-05-28 asked
    // for thickness per stock row precisely so the cut shop doesn't
    // mix gauges. Stock is filtered per group — a row with
    // thickness=1 only takes thickness=1 pieces. Pieces whose
    // thickness has no matching stock row land in 'unplaced'.
    function thickKey(t) {
      const n = typeof t === 'number' ? t : parseFloat(String(t).replace(/[^\d.]/g, ''));
      return isNaN(n) ? '?' : String(Math.round(n * 100) / 100);
    }
    const byThick = new Map();
    for (const piece of pieces) {
      const k = thickKey(piece.thickness);
      if (!byThick.has(k)) byThick.set(k, []);
      byThick.get(k).push(piece);
    }

    // Saved offcuts as stock rows for this thickness — uses the ACTUAL cut
    // size when the Laser worker recorded it, else the calculated size. Carries
    // the remnant's grain + material/finish so the packer can gate by grain and
    // the banner can flag a mismatch. (เอ๋ 2026-05-31 'นำค่าจริงมาใช้' +
    // 'ตัด nest จริงต้องเอาเศษมาใช้' + 'อยากให้ครบ')
    function _remnantStockForThick(tk) {
      const out = [];
      for (const r of (S.remnants || [])) {
        if (thickKey(r.thickness ?? 1) !== tk) continue;
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
    // Can a piece with directional grain pg ('H'/'V'/'ANY'/'?'/...) be cut from
    // a remnant whose own grain is rg? A reused offcut already has a grain
    // direction baked in, so a directional part must match it. MIXED (sheet had
    // both H+V parts) is unsafe for any directional part. ANY remnant takes
    // anything; ANY/?/unset part takes any remnant. (feedback_remnants_grain_finish)
    function _grainFits(pieceGrain, remGrain) {
      const pg = String(pieceGrain || 'ANY').toUpperCase();
      const rg = String(remGrain || 'ANY').toUpperCase();
      if (pg !== 'H' && pg !== 'V') return true;   // non-directional part: any remnant ok
      if (rg === 'ANY') return true;               // fresh-grained offcut: any direction ok
      return rg === pg;                            // directional part needs same-direction remnant
    }

    const allSheets = [];
    const allUnplaced = [];
    let _grainSkippedRemnants = 0;   // count offcuts a grain clash kept out of a group
    for (const [tk, group] of byThick) {
      let stockForThick = activeStock.filter(s => thickKey(s.thickness ?? 1) === tk);
      // Use saved offcuts FIRST (prepended → packer walks stock in priority
      // order), unless "Skip remnants" is ticked. This is what finally makes
      // the SKIP REMNANTS toggle do something + the remnant pool consumable.
      let remStock = [];
      if (!S.skipRemnants) {
        const allRem = _remnantStockForThick(tk);
        // A thickness group can still hold a mix of grains; keep an offcut only
        // if EVERY directional piece in the group can be cut from it (so we
        // never lay an H part on a V/MIXED offcut). Offcuts that clash are
        // dropped from stock and counted for the review banner.
        remStock = allRem.filter(rm => group.every(pc => _grainFits(pc.grain, rm.grain)));
        _grainSkippedRemnants += (allRem.length - remStock.length);
        stockForThick = remStock.concat(stockForThick);
      }
      if (stockForThick.length === 0) {
        allUnplaced.push(...group);
        continue;
      }
      const r = _nestMultiSheet(group, stockForThick, S.gap, S.mode);
      // Tag each produced sheet that landed on a remnant (exact size match,
      // consumed 1:1) so the view labels it + auto-save skips it (no
      // offcut-of-an-offcut). Original remnant stays in the pool (not auto-
      // deleted — the worker removes it after cutting).
      const remMatch = remStock.slice();
      for (const s of r.sheets) {
        let fromRemnant = null;
        const mi = remMatch.findIndex(rm => rm.w === Math.round(s.sw) && rm.h === Math.round(s.sh));
        if (mi >= 0) { fromRemnant = remMatch[mi]._remnantId; remMatch.splice(mi, 1); }
        allSheets.push({ ...s, thick: tk, fromRemnant: fromRemnant });
      }
      allUnplaced.push(...r.unplaced);
    }
    const result = { sheets: allSheets, unplaced: allUnplaced };
    S.flatSheets = result.sheets.map(s => ({
      thick: s.thick,
      sw: s.sw, sh: s.sh, placements: s.placements,
      fromRemnant: s.fromRemnant || null,
    }));
    S.currentSheetIdx = 0;
    S.unplaced = result.unplaced || [];
    // How many saved offcuts a grain clash kept out of this run — drives the
    // review banner so the worker knows a leftover was skipped (not silently).
    S.grainSkippedRemnants = _grainSkippedRemnants;
    if (S.unplaced.length) {
      console.warn('[kdNest] unplaced pieces:', S.unplaced);
    }
    _refreshView();
    // Remember the offcuts (unless Don't remember). Fire-and-forget so the
    // layout shows instantly; it refreshes the remnant pool in the background.
    _autoSaveRemnants();
  }

  // ── Grain-direction hatch ──────────────────────────────────────────
  // Thin parallel lines showing which way the grain runs, so a worker can read
  // the grain at a glance on the Part preview, the Sheet, and a Remnant
  // thumbnail (เอ๋ 2026-05-31 'ทำ Hatch ขีดบางๆ จะได้รู้ Grain ทิศทางไหน').
  // H = horizontal lines, V = vertical, MIXED = crosshatch (sheet had both),
  // ANY/unset = nothing. Function declarations → hoisted, usable everywhere
  // in this IIFE (incl. _remnantPreview above).
  function _grainHatchCanvas(ctx, grain, x0, y0, x1, y1, colour, dpr) {
    const g = String(grain || '').toUpperCase();
    if (g !== 'H' && g !== 'V' && g !== 'MIXED') return;
    const step = 8 * (dpr || 1);
    ctx.save();
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(0.5, 0.5 * (dpr || 1));
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    if (g === 'H' || g === 'MIXED') for (let y = y0 + step; y < y1; y += step) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    if (g === 'V' || g === 'MIXED') for (let x = x0 + step; x < x1; x += step) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    ctx.stroke();
    ctx.restore();
  }
  function _grainHatchSvg(grain, x, y, w, h, colour) {
    const g = String(grain || '').toUpperCase();
    if (g !== 'H' && g !== 'V' && g !== 'MIXED') return '';
    const step = 6, lines = [];
    if (g === 'H' || g === 'MIXED') for (let yy = y + step; yy < y + h; yy += step) lines.push('<line x1="' + x.toFixed(1) + '" y1="' + yy.toFixed(1) + '" x2="' + (x + w).toFixed(1) + '" y2="' + yy.toFixed(1) + '"/>');
    if (g === 'V' || g === 'MIXED') for (let xx = x + step; xx < x + w; xx += step) lines.push('<line x1="' + xx.toFixed(1) + '" y1="' + y.toFixed(1) + '" x2="' + xx.toFixed(1) + '" y2="' + (y + h).toFixed(1) + '"/>');
    if (!lines.length) return '';
    return '<g stroke="' + colour + '" stroke-width="0.4" opacity="0.5">' + lines.join('') + '</g>';
  }

  // ════════════════════════════════════════════════════════════════════
  //  Single-part preview (desktop-style clear view + ↑/↓ keyboard nav)
  // ════════════════════════════════════════════════════════════════════
  // Draw ONE part filling the canvas — outer profile + holes + multi-piece
  // strokes — so the worker can read it clearly, like the desktop tool's
  // preview pane. (user 2026-05-30 'view part ชัดเจนเหมือน nest บน desktop')
  function _drawPartPreview(canvas, part) {
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
    // BG = the ACTUAL surrounding background so the preview blends into the
    // workspace in every theme (เอ๋ 2026-05-31 'ในช่องการแสดงภาพ ให้พื้นหลัง
    // เป็นสีเดียวกับพื้นหลังโดยรอบ'). Read the computed bg of the canvas's
    // wrapper; transparent (theme reset) → fall back to <body>, then the
    // per-theme constant. INK/MUTED stay theme-based for contrast.
    const BG = _sketch ? '#efe7d6' : _chalk ? '#26302e' : '#0f1419';
    const INK = _sketch ? '#1b1815' : _chalk ? '#f4f1e8' : '#4ecca3';
    const MUTED = _sketch ? '#6f6757' : _chalk ? '#9fb3ad' : '#88aab1';
    // Opaque steel silhouette so the diecut reads as a real metal part, not a
    // washed-out outline (เอ๋ 2026-05-31 'dicut ขาวออก' — colour+'22' = ~13%
    // alpha was nearly invisible). Solid mid-grey on every theme.
    const STEEL = _sketch ? '#b9b2a2' : _chalk ? '#8f9991' : 'rgba(78,204,163,0.40)';
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, cw, ch);
    const polys = part && part.polys;
    const bbox = part && part.bbox;
    if (!polys || !bbox) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${14 * dpr}px "Flux Architect", monospace`;
      ctx.fillStyle = MUTED;
      ctx.fillText(part && part.dxfError ? ('DXF error: ' + part.dxfError)
                   : 'DXF not loaded yet…', cw / 2, ch / 2);
      return;
    }
    const [minX, minY, maxX, maxY] = bbox;
    const pw0 = (maxX - minX) || 1, ph0 = (maxY - minY) || 1;
    // Rotate the preview to reflect grain: V = part runs vertically (placed
    // at 90 deg), H / ANY = native. (user 2026-05-30 'กด grain แล้วภาพไม่หมุนตาม')
    const grot = (part && part.grain === 'V') ? 90 : 0;
    const mapPt = (x, y) => {
      const u = x - minX, v = y - minY;
      return (grot === 90) ? [-v + ph0, u] : [u, v];
    };
    const fw = (grot === 90) ? ph0 : pw0, fh = (grot === 90) ? pw0 : ph0;
    const pad = 44 * dpr;
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
    if (polys.outer && polys.outer.length > 1) {
      trace(polys.outer, true);
      ctx.fillStyle = STEEL; ctx.fill();
      // Grain hatch — clipped to the silhouette so the lines read as grain on
      // the metal. The preview is already rotated so V parts run vertically
      // (grot=90), so screen-space H/V matches what the worker sees on the
      // sheet. (เอ๋ 2026-05-31 'ทำ Hatch ขีดบางๆ จะได้รู้ Grain ทิศทางไหน')
      if (part.grain === 'H' || part.grain === 'V') {
        ctx.save(); trace(polys.outer, true); ctx.clip();
        _grainHatchCanvas(ctx, part.grain, offX, offY, offX + drawW, offY + drawH, INK, dpr);
        ctx.restore();
      }
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
  }

  function _scrollPreviewRow() {
    if (!S.rootEl || !S.previewCode) return;
    const row = S.rootEl.querySelector('.kdnest-part[data-code="' + (window.CSS && CSS.escape ? CSS.escape(S.previewCode) : S.previewCode) + '"]');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
  function _setPreview(code) {
    S.previewCode = code;
    _refreshView();
    _scrollPreviewRow();
  }
  function _movePreview(delta) {
    if (!S.parts.length) return;
    let idx = S.parts.findIndex(p => p.code === S.previewCode);
    if (idx < 0) idx = (delta > 0 ? -1 : 0);
    idx = Math.max(0, Math.min(S.parts.length - 1, idx + delta));
    S.previewCode = S.parts[idx].code;
    _refreshView();
    _scrollPreviewRow();
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
      : _stheme === 'chalk' ? '#26302e' : '#0f1419';
    ctx.fillStyle = _outerBG;
    ctx.fillRect(0, 0, cw, ch);
    // Sheet outline
    ctx.strokeStyle = '#2a5dff';
    ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
    ctx.strokeRect(offX, offY, sheet.sw * scale, sheet.sh * scale);
    // Sheet grain hatch — ONE direction for the whole sheet (a real sheet has a
    // single grain). Derived from the parts on it: H/V → lines, MIXED → cross-
    // hatch (a grain clash slipped through), ANY → none. Drawn faint UNDER the
    // parts so the translucent part fills sit on top. (เอ๋ 2026-05-31 'ทำ Hatch
    // ขีดบางๆ จะได้รู้ Grain ทิศทางไหน')
    {
      const _sg = (typeof _sheetGrain === 'function') ? _sheetGrain(sheet) : 'ANY';
      const _hatchInk = _stheme === 'sketch' ? 'rgba(60,50,40,0.55)'
        : _stheme === 'chalk' ? 'rgba(220,230,225,0.45)' : 'rgba(150,170,190,0.45)';
      ctx.save();
      ctx.beginPath();
      ctx.rect(offX, offY, sheet.sw * scale, sheet.sh * scale);
      ctx.clip();
      _grainHatchCanvas(ctx, _sg, offX, offY, offX + sheet.sw * scale, offY + sheet.sh * scale, _hatchInk, window.devicePixelRatio || 1);
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

    // -- Label pass: merge same-code SMALL parts sitting close together
    // (user 2026-05-30 'รวม Label ... อยู่ใกล้กัน เฉพาะชิ้นเล็กๆ') so a row
    // of triangles reads 'CODE x6' once instead of six overlapping IDs.
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // Label ink: sketch theme has a light (cream) sheet → white text is
    // invisible, so use near-black ink. chalk/default sheets are dark → keep
    // the light ink. (user 2026-05-31 'theme pencil ให้ตัวอีกษรเป็นสีดำ')
    const _lblNorm = _stheme === 'sketch' ? '#1a1f26' : '#e8eef5';
    const _lblHot  = _stheme === 'sketch' ? '#000000' : '#fffce8';
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
      sheetStock: (S.sheetStock || []).map(s => ({
        w: s.w || 0, h: s.h || 0, qty: s.qty || 0,
        thickness: s.thickness ?? 1, label: s.label || '',
      })),
      parts: (S.parts || []).map(_serializePart),
      sheets: (S.flatSheets || []).map(_serializeSheet),
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

    const btn = document.querySelector('#kdnest-save-sheets');
    const origText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏫ Uploading…'; }

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
      await window.firebaseDB.ref(`nest_parts/${projectKey}`).set({
        saved_at: job.saved_at, jobId: jobId, parts: job.parts,
      });
      S.lastSavedJobId = jobId;
      jobSaved = true;
    } catch (e) {
      jobErr = String(e.message || e);
    }
    try {
      localStorage.setItem('kd_nest_job_' + projectKey, JSON.stringify({ jobId, ...job }));
    } catch (e) { /* quota / private mode — non-fatal */ }

    if (btn) { btn.disabled = false; btn.textContent = origText; }
    alert(`Save Project — '${S.projectName}'\n\n` +
          `Cut sheets uploaded: ${ok}` + (fail ? `\nFailed: ${fail}` : '') +
          `\nNest job: ${jobSaved ? 'saved (' + job.name + ')' : 'FAILED — ' + jobErr}` +
          (firstErr ? `\n\nFirst cut-sheet error: ${firstErr}` : ''));
  }

  // Restore a saved nest job into S: settings + parts + stock, then re-parse
  // DXFs and re-attach polys/bbox to the saved placements by code. No re-run —
  // the saved layout renders as-is. (user 2026-05-30 'โหลดงานเก่า')
  async function _restoreJob(job) {
    if (!job) return;
    S.mode = job.mode || S.mode;
    S.gap = (typeof job.gap === 'number') ? job.gap : S.gap;
    S.skipRemnants = !!job.skipRemnants;
    S.dontRemember = !!job.dontRemember;
    if (Array.isArray(job.sheetStock) && job.sheetStock.length) {
      S.sheetStock = job.sheetStock.map(s => ({
        w: s.w || 0, h: s.h || 0, qty: s.qty || 0,
        thickness: s.thickness ?? 1, label: s.label || '',
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
      return base;
    });
    S.previewCode = null;
    S.highlightCode = null;
    S.flatSheets = [];
    S.currentSheetIdx = 0;
    _refreshView();
    // Re-parse DXFs (fills polys/bbox + may correct w/h from the real bbox).
    await _loadAllDxfs();
    if (S.closing) return;
    // Rebuild flatSheets from the saved placements, re-attaching geometry from
    // the freshly-loaded part of the same code.
    S.flatSheets = (job.sheets || []).map(sh => ({
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
    S.currentSheetIdx = 0;
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
      return `
        <div class="kdjobs-row" data-id="${_esc(j.jobId)}">
          <div class="kdjobs-main">
            <span class="kdjobs-name">${_esc(j.name || j.jobId)}</span>
            <span class="kdjobs-meta">${nSheets} sheets · ${nParts} parts · ${_esc(j.mode || '')}</span>
          </div>
          <button class="kdjobs-load" data-id="${_esc(j.jobId)}">Load</button>
          ${isAdminUser ? `<button class="kdjobs-del" data-id="${_esc(j.jobId)}" title="Delete this saved job">✕</button>` : ''}
        </div>`;
    }).join('') : '<div class="kdjobs-empty">No saved jobs yet. Click 💾 Save Project to create one.</div>';

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

  // DXF builder for one nested sheet — minimal R12-ish text format.
  // ezdxf would be nicer but we have to ship browser-only. The format
  // below works in any DXF reader (NestingTool's ezdxf-based reader
  // can round-trip it). Outer sheet border + each placement's outer
  // polygon, all on layer "0" for now (sufficient for laser cut).
  function _buildSheetDxf(sheet) {
    const lines = ['0','SECTION','2','HEADER','9','$INSUNITS','70','4','0','ENDSEC',
                   '0','SECTION','2','ENTITIES'];

    function lwpolyline(pts, layer) {
      if (!pts || pts.length < 2) return;
      lines.push('0','LWPOLYLINE','8', layer || '0',
                 '90', String(pts.length), '70','1');
      for (const [x, y] of pts) {
        lines.push('10', x.toFixed(3), '20', y.toFixed(3));
      }
    }
    // Sheet outline
    lwpolyline([[0,0],[sheet.sw,0],[sheet.sw,sheet.sh],[0,sheet.sh],[0,0]], 'SHEET_BORDER');
    // Each placement: outer profile (rotated, offset)
    for (const pl of sheet.placements) {
      if (!pl.polys || !pl.polys.outer || pl.polys.outer.length < 2) {
        // Fallback: just the bbox rect
        const w = (pl.rot === 90 || pl.rot === 270) ? pl.h : pl.w;
        const h = (pl.rot === 90 || pl.rot === 270) ? pl.w : pl.h;
        lwpolyline([[pl.x, pl.y],[pl.x+w, pl.y],[pl.x+w, pl.y+h],[pl.x, pl.y+h],[pl.x, pl.y]],
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
      lwpolyline(pl.polys.outer.map(([x,y]) => transform(x,y)), 'OUTER_PROFILES');
      if (pl.polys.holes) {
        for (const hole of pl.polys.holes) {
          lwpolyline(hole.map(([x,y]) => transform(x,y)), 'INTERIOR_PROFILES');
        }
      }
    }
    lines.push('0','ENDSEC','0','EOF');
    return lines.join('\n');
  }

  // ════════════════════════════════════════════════════════════════════
  //  UI rendering
  // ════════════════════════════════════════════════════════════════════
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
        requestAnimationFrame(() => _drawPartPreview(canvas, part));
      } else if (S.flatSheets[S.currentSheetIdx]) {
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
    if (!p || !p.selected || p.manual) return false;
    const g = String(p.grain || '').toUpperCase();
    return g !== 'H' && g !== 'V' && g !== 'ANY';   // warn ONLY '?'/unmatched (เอ๋ 2026-05-31 'เตือนเฉพาะค่าที่ไม่แน่ใจ' = desktop's "Grain unspecified"); H/V/ANY = decided -> no warn
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
  // "Looks weird" reasons for a selected part (empty array = nothing to flag).
  // Checks: no DXF · DXF parse error / degenerate outline · parsed bbox vs the
  // size encoded in the 13-char code (…WWWHHH, 10mm units), ±25mm tolerance.
  // (user 2026-05-30 'ชิ้นนี้ดูแปลกๆ ให้เข้าไปดูหน่อย / ชิ้นนี้ไม่มี DXF')
  function _reviewReasons(p) {
    const out = [];
    if (!p || !p.selected || p.manual) return out;
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
        const TOL = 25;   // ±25mm (เอ๋ 2026-05-30) — was 10; absorbs panel-vs-channel + tier-rounding so legit parts don't over-flag
        const near = v => v > 0 && (Math.abs(bw - v) <= TOL || Math.abs(bh - v) <= TOL);
        const wBad = wCode > 0 && !near(wCode);
        const hBad = hCode > 0 && !near(hCode);
        if (wBad || hBad) {
          out.push(`DXF size ≈ ${bw}\xd7${bh}, code says ~${wCode}\xd7${hCode}`);
        }
      }
    }
    return out;
  }

  // Build 0–3 stacked warning banners for the result pane. Persistent (not
  // dismissible) so a real problem can't be clicked away before cutting.
  // (user 2026-05-30 'จำนวนขาด ... ก็ไม่มีการแจ้งเตือน')
  function _warningsHtml() {
    const banners = [];

    // ① Unplaced (red, loudest) — only after a run.
    if (S.unplaced && S.unplaced.length) {
      // Active stock thicknesses, so we can flag the "no matching sheet" cause.
      const tk = t => {
        const n = typeof t === 'number' ? t : parseFloat(String(t).replace(/[^\d.]/g, ''));
        return isNaN(n) ? '?' : String(Math.round(n * 100) / 100);
      };
      const stockThick = new Set(
        (S.sheetStock || [])
          .filter(s => s.w > 0 && s.h > 0 && (s.qty !== 0 || s.qty === -1))
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
        return `<div class="kdnest-warn-line">${_esc(code)} ×${e.qty}${suffix}</div>`;
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

    // ③ Review / looks-weird (orange).
    const reviews = [];
    for (const p of S.parts) {
      const reasons = _reviewReasons(p);
      if (reasons.length) reviews.push({ code: p.code, reasons });
    }
    if (reviews.length) {
      const lines = reviews.map(r =>
        `<div class="kdnest-warn-line">${_esc(r.code)} — ${_esc(r.reasons.join('; '))}</div>`
      ).join('');
      banners.push(
        `<div class="kdnest-warn kdnest-warn--review">
           <div class="kdnest-warn-head">Review ${reviews.length} part${reviews.length === 1 ? '' : 's'}:</div>
           ${lines}
         </div>`
      );
    }

    return banners.join('');
  }

  function _viewHtml() {
    const nSheets = S.flatSheets.length;
    const totalPcs = S.parts.reduce((s, p) => s + (p.selected ? (p.qty || 0) : 0), 0);
    const totalUnique = S.parts.filter(p => p.selected).length;
    const loadedDxfs = S.parts.filter(p => p.dxfLoaded).length;
    const errorDxfs = S.parts.filter(p => p.dxfError).length;

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

    const partsRows = S.parts.map((p, i) => {
      const status = p.manual
        ? `<button class="kdnest-part-del" title="Remove this manual part">✕</button>`
        : p.dxfLoaded
          ? `<span class="kdnest-part-ok" title="DXF loaded">✓</span>`
          : p.dxfError
            ? `<span class="kdnest-part-err" title="${_esc(p.dxfError)}">⚠</span>`
            : `<span class="kdnest-part-load" title="loading…">⋯</span>`;
      const g = grainGlyph(p.grain);
      const onSheetIdx = findSheetIdx(p.code);
      const viewDisabled = !p.dxfUrl;
      const sheetDisabled = onSheetIdx < 0;
      // DXF parts: W/H come from the parsed bbox — lock them so a stray edit
      // can't desync the size from the actual cut geometry. Manual rectangles
      // stay editable. (user 2026-05-30)
      const whLock = p.manual ? '' : ' disabled title="size comes from the DXF — locked"';
      const grainDir = _isGrainDirectional(p);
      const grainWarn = grainDir ? ' kdnest-grain-warn' : '';
      const rowGrainWarn = grainDir ? ' kdnest-part-grainwarn' : '';
      const reviewMark = _reviewReasons(p).length ? ' kdnest-part-review' : '';
      return `
        <div class="kdnest-part${p.manual ? ' kdnest-part-manual' : ''}${rowGrainWarn}${reviewMark}${p.code === S.previewCode ? ' kdnest-part-active' : ''}" data-code="${_esc(p.code)}">
          <input type="checkbox" class="kdnest-part-sel" ${p.selected ? 'checked' : ''}>
          <span class="kdnest-part-num">#${i + 1}</span>
          <span class="kdnest-part-code">${p.manual ? '▭ ' : ''}${_esc(p.code)}</span>
          <input type="number" class="kdnest-part-w" value="${p.w || ''}" min="0" step="1" placeholder="W"${whLock}>
          <span class="kdnest-x">×</span>
          <input type="number" class="kdnest-part-h" value="${p.h || ''}" min="0" step="1" placeholder="H"${whLock}>
          <input type="number" class="kdnest-part-qty" value="${p.qty}" min="0" step="1" title="qty">
          <button class="kdnest-part-grain ${g.cls}${grainWarn}" data-grain="${p.grain}" title="${grainWarn ? 'grain not set yet — pick H/V if it matters · ' : ''}${g.title} — click to cycle ?→H→V→ANY">${g.ch}</button>
          <button class="kdnest-part-view" title="${p.manual ? 'Manual rectangle — no DXF' : 'View this part (preview)'}" ${viewDisabled ? 'disabled' : ''}>👁</button>
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

    const sheetStockRows = S.sheetStock.map((s, i) => {
      const upDisabled = i === 0 ? 'disabled' : '';
      const downDisabled = i === S.sheetStock.length - 1 ? 'disabled' : '';
      return `
      <div class="kdnest-stock-row" data-i="${i}">
        <button class="kdnest-stock-up"   data-i="${i}" title="Higher priority (try this size first)" ${upDisabled}>↑</button>
        <button class="kdnest-stock-down" data-i="${i}" title="Lower priority"                       ${downDisabled}>↓</button>
        <input type="number" data-i="${i}" data-k="w"         value="${s.w || ''}"        min="0" class="kdnest-stock-dim"   placeholder="W">
        <span>×</span>
        <input type="number" data-i="${i}" data-k="h"         value="${s.h || ''}"        min="0" class="kdnest-stock-dim"   placeholder="H">
        <span>mm</span>
        <input type="number" data-i="${i}" data-k="qty"       value="${s.qty || 0}"               class="kdnest-stock-qty"   title="qty — use -1 for unlimited">
        <input type="number" data-i="${i}" data-k="thickness" value="${s.thickness ?? 1}" min="0" step="0.1" class="kdnest-stock-thick" title="Thickness (mm) — only parts of this thickness get nested onto this stock">
        <span class="kdnest-stock-thick-suffix">mm</span>
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
      return `Preview: #${i + 1} ${_esc(pp.code)}${dims} · ↑/↓ flip · ‹ › exits`;
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
              <div class="kdnest-title-main">📐 Nesting</div>
              <div class="kdnest-title-sub">${_esc(S.projectName)} · ${totalUnique} unique · ${totalPcs} pcs · ${loadedDxfs}/${S.parts.length} DXF loaded${errorDxfs ? ` · ⚠ ${errorDxfs} err` : ''}</div>
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
            <label class="kdnest-skip-lab" title="Skip = packer won't USE saved remnants for this run">
              <input id="kdnest-skip" type="checkbox" ${S.skipRemnants ? 'checked' : ''}>
              Skip remnants
            </label>
            <label class="kdnest-skip-lab" title="Don't remember = this run won't ADD new remnants to the saved pool (testing-friendly)">
              <input id="kdnest-dont-remember" type="checkbox" ${S.dontRemember ? 'checked' : ''}>
              Don't remember
            </label>
          </div>
          <div class="kdnest-stock">
            <div class="kdnest-stock-title">Sheet stock</div>
            ${sheetStockRows}
          </div>
          <div class="kdnest-actions">
            <button id="kdnest-run" class="kdnest-btn kdnest-btn-run">▶ Run Nesting</button>
            <button id="kdnest-save-sheets" class="kdnest-btn kdnest-btn-save" ${nSheets ? '' : 'disabled'} title="Upload cut sheets to Laser + save this nest job (layout, parts, stock)">💾 Save Project</button>
            <button id="kdnest-jobs" class="kdnest-btn kdnest-btn-jobs" title="Load or delete a previously saved nest job">📂 Saved Jobs</button>
            <button id="kdnest-export" class="kdnest-btn kdnest-btn-export" title="Download this nest as a JSON backup file">⬇ Export JSON</button>
            <button id="kdnest-grain" class="kdnest-btn kdnest-btn-grain" title="Edit grain / thickness rules (shared — no Excel needed)">🧬 Grain</button>
            <button id="kdnest-stock" class="kdnest-btn kdnest-btn-stock" title="Remnant offcut stock — view / add / delete">📦 Remnants Stock</button>
          </div>
          <div class="kdnest-parts">
            <div class="kdnest-parts-head">
              <button id="kdnest-parts-all" class="kdnest-mini">All</button>
              <button id="kdnest-parts-none" class="kdnest-mini">None</button>
              ${isAdminUser ? '<button id="kdnest-add-rect" class="kdnest-mini kdnest-add-rect" title="Add a manual rectangular part (no DXF) — set W×H">+ ▭ Rect</button>' : ''}
              <span class="kdnest-parts-count">${totalUnique} / ${S.parts.length} · ${totalPcs} pcs</span>
            </div>
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

  function _wireEvents() {
    const $ = sel => S.rootEl.querySelector(sel);
    $('#kdnest-back')?.addEventListener('click', close);
    $('#kdnest-run')?.addEventListener('click', _runNesting);
    $('#kdnest-save-sheets')?.addEventListener('click', _saveProject);
    $('#kdnest-jobs')?.addEventListener('click', _openSavedJobsModal);
    $('#kdnest-export')?.addEventListener('click', _exportJobJson);
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
    $('#kdnest-mode')?.addEventListener('change', e => { S.mode = e.target.value; });
    $('#kdnest-gap')?.addEventListener('change', e => { S.gap = parseFloat(e.target.value) || 0; });
    $('#kdnest-skip')?.addEventListener('change', e => { S.skipRemnants = e.target.checked; });
    $('#kdnest-dont-remember')?.addEventListener('change', e => { S.dontRemember = e.target.checked; });
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
    // Sheet-stock editors + ↑/↓ priority reorder. The packer walks the
    // stock list in order, so moving a row up = 'try this size first'.
    S.rootEl.querySelectorAll('.kdnest-stock-dim, .kdnest-stock-qty, .kdnest-stock-thick').forEach(el => {
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
        }
      });
    });
    S.rootEl.querySelectorAll('.kdnest-stock-up').forEach(btn => {
      btn.addEventListener('click', e => {
        const i = parseInt(e.currentTarget.dataset.i, 10);
        if (i > 0) {
          const arr = S.sheetStock;
          [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
          _refreshView();
        }
      });
    });
    S.rootEl.querySelectorAll('.kdnest-stock-down').forEach(btn => {
      btn.addEventListener('click', e => {
        const i = parseInt(e.currentTarget.dataset.i, 10);
        if (i < S.sheetStock.length - 1) {
          const arr = S.sheetStock;
          [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
          _refreshView();
        }
      });
    });
    // Per-part edits — preserve focus + scroll position via delegation.
    S.rootEl.querySelectorAll('.kdnest-part').forEach(row => {
      const code = row.dataset.code;
      const part = S.parts.find(p => p.code === code);
      if (!part) return;
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
        if (!S.closing) _refreshView();
      });
    } catch (e) {
      console.error('[kdNest] open failed', e);
      S.rootEl.innerHTML = `<p class="loading">Failed to open nesting: ${_esc(e.message || e)}</p>`;
    }
  }

  function close() {
    S.closing = true;
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
      polys: { outer: ex.outer, strokes: ex.strokes || [], holes: ex.holes },
      bbox: ex.bbox,
    };
  }

  window.kdNest = {
    openProject: openProject,
    close: close,
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
  };
})();
