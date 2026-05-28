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
      // Default stock — user can extend via the Sheet Stock dialog.
      { w: 1525, h: 3050, qty: -1, label: '5×10' },  // -1 = unlimited
      { w: 1220, h: 2440, qty: -1, label: '4×8'  },
    ],
    mode: 'Auto',
    skipRemnants: true,   // default ON — user 2026-05-28 wants fresh stock first
    dontRemember: false,  // Phase 2 toggle — pre-wired UI, packer doesn't
                          // track remnants yet so both flags are no-ops
                          // until that lands. User 2026-05-28 wanted UI
                          // parity with the Python tool's twin toggles.
    gap: 2,
    flatSheets: [],   // [{thick, sw, sh, placements:[{code, x, y, w, h, rot, polys, bbox}]}]
    currentSheetIdx: 0,
    rootEl: null,     // <main id="root"> at the time we opened
    prevHtml: null,   // saved so close() can restore
    closing: false,
  };

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
    const m = String(url).match(
      /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/
    );
    if (!m) return url;
    return `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}`;
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
    function entityPoints(e) {
      if (!e || _bendLayer(e.layer)) return null;
      if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') {
        return (e.vertices || []).map(v => [ocsFlipX(e, v.x), v.y]);
      }
      if (e.type === 'LINE') {
        return [[ocsFlipX(e, e.start.x), e.start.y],
                [ocsFlipX(e, e.end.x), e.end.y]];
      }
      if (e.type === 'CIRCLE') {
        const N = 32;
        const arr = [];
        const cx = ocsFlipX(e, e.x);
        for (let i = 0; i <= N; i++) {
          const a = (i / N) * Math.PI * 2;
          arr.push([cx + e.r * Math.cos(a), e.y + e.r * Math.sin(a)]);
        }
        return arr;
      }
      if (e.type === 'ARC') {
        const N = 24;
        const a0 = (e.startAngle || 0) * Math.PI / 180;
        const a1 = (e.endAngle || 0) * Math.PI / 180;
        const span = a1 < a0 ? (a1 + 2 * Math.PI - a0) : (a1 - a0);
        const arr = [];
        const cx = ocsFlipX(e, e.x);
        for (let i = 0; i <= N; i++) {
          const a = a0 + span * (i / N);
          arr.push([cx + e.r * Math.cos(a), e.y + e.r * Math.sin(a)]);
        }
        return arr;
      }
      if (e.type === 'SPLINE') {
        // Prefer fitPoints (the curve passes through these) over
        // controlPoints (Bezier handles, can sit far OUTSIDE the
        // actual curve — gave a 2x bbox overestimate on Fusion's
        // BM1NO0 sheet-metal flat patterns 2026-05-28). Fall back
        // to controlPoints only when no fitPoints present.
        if (Array.isArray(e.fitPoints) && e.fitPoints.length >= 2) {
          return e.fitPoints.map(p => [ocsFlipX(e, p.x), p.y]);
        }
        if (Array.isArray(e.controlPoints)) {
          return e.controlPoints.map(p => [ocsFlipX(e, p.x), p.y]);
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
    const outerCandidates = [];
    const interior = [];
    for (const e of parsed.entities) {
      const pts = entityPoints(e);
      if (!pts || pts.length < 2) continue;
      const layer = String(e.layer || '');
      // Only cut-path layers contribute to bbox.
      if (isCutLayer(layer)) {
        for (const [x, y] of pts) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
      if (/OUTER/i.test(layer)) {
        outerCandidates.push(pts);
      } else if (/INTERIOR/i.test(layer)) {
        interior.push(pts);
      } else {
        // Render-only — won't affect bbox.
        outerCandidates.push(pts);
      }
    }

    const bbox = isFinite(minX) ? [minX, minY, maxX, maxY] : null;
    // Outer = the longest-perimeter loop among candidates — proxy for
    // "outer profile". DXFs from Fusion's Sheet Metal DXF Creator
    // always have an OUTER_PROFILES layer with one closed loop.
    function perim(pts) {
      let p = 0;
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i][0] - pts[i - 1][0];
        const dy = pts[i][1] - pts[i - 1][1];
        p += Math.hypot(dx, dy);
      }
      return p;
    }
    let outer = outerCandidates.length
      ? outerCandidates.reduce((a, b) => (perim(b) > perim(a) ? b : a))
      : [];
    return { outer, holes: interior, bbox };
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
        p.polys = { outer: ex.outer, holes: ex.holes };
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
        part.thickness = meta.thickness_mm || 0;
        part.grain = (meta.grain || part.grain || 'ANY').toUpperCase();
      }
    }
    S.projectKey = projectKey;
    S.projectName = project.name || projectKey;
    S.parts = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
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
    place(w, h) {
      let best = null;  // {x, y, short, long}
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
      if (!best) return null;
      this._split(best.x, best.y, w, h);
      return [best.x, best.y];
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

  // ── Driver: pack onto multiple sheet sizes ─────────────────────────
  function _nestMultiSheet(pieces, stock, gap, mode) {
    // pieces: [{code, w, h, rots:[0,90,...], qty}]
    // stock: [{w, h, qty}]   qty=-1 → unlimited
    // Returns: {sheets: [{sw, sh, placements:[{...}]}], unplaced: [...]}

    function makePacker(sw, sh, m) {
      return m === 'MaxRects' ? new MaxRectsPacker(sw, sh)
                              : new SkylinePacker(sw, sh, m);
    }

    function runOne(modeStr) {
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
            let wasPlaced = false;
            for (const rot of piece.rots) {
              const rw = (rot === 90 || rot === 270) ? piece.h + gap : piece.w + gap;
              const rh = (rot === 90 || rot === 270) ? piece.w + gap : piece.h + gap;
              const pos = packer.place(rw, rh);
              if (pos) {
                placed.push({
                  ...piece,
                  x: pos[0],
                  y: pos[1],
                  rot: rot,
                });
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
      for (const m of ['MaxRects', 'BL Corner', 'Left', 'Bottom']) {
        const r = runOne(m);
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

  // ════════════════════════════════════════════════════════════════════
  //  Run Nesting
  // ════════════════════════════════════════════════════════════════════
  function _runNesting() {
    // Expand parts into per-instance pieces (qty copies each) and
    // restrict rotations by grain (H = no 90/270, V = no 0/180,
    // ANY = all four).
    const pieces = [];
    for (const p of S.parts) {
      if (!p.selected) continue;
      if (!p.bbox || p.w <= 0 || p.h <= 0) continue;
      const rots = (p.grain === 'H') ? [0, 180]
                 : (p.grain === 'V') ? [90, 270]
                 :                     [0, 90, 180, 270];
      for (let i = 0; i < p.qty; i++) {
        pieces.push({
          code: p.code, w: p.w, h: p.h, rots: rots,
          polys: p.polys, bbox: p.bbox, thickness: p.thickness,
        });
      }
    }
    if (pieces.length === 0) {
      alert('No parts to nest — check selection / DXF loading status.');
      return;
    }
    const result = _nestMultiSheet(pieces, S.sheetStock, S.gap, S.mode);
    S.flatSheets = result.sheets.map(s => ({
      thick: s.placements[0] ? s.placements[0].thickness : '',
      sw: s.sw, sh: s.sh, placements: s.placements,
    }));
    S.currentSheetIdx = 0;
    if (result.unplaced.length) {
      console.warn('[kdNest] unplaced pieces:', result.unplaced);
    }
    _refreshView();
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
    // Clear
    ctx.fillStyle = '#0b1117';
    ctx.fillRect(0, 0, cw, ch);
    // Sheet outline
    ctx.strokeStyle = '#2a5dff';
    ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
    ctx.strokeRect(offX, offY, sheet.sw * scale, sheet.sh * scale);
    // Each placement
    const palette = ['#4ecca3', '#ffa726', '#e74c3c', '#9b59b6',
                     '#3498db', '#f1c40f', '#1abc9c', '#e67e22',
                     '#16a085', '#c0392b'];
    sheet.placements.forEach(function (pl, i) {
      const colour = palette[i % palette.length];
      // Sheet coords → canvas coords (flip Y because DXF is y-up)
      function toCanvas(x, y) {
        return [offX + x * scale, offY + (sheet.sh - y) * scale];
      }
      // Compute rotated bbox-rectangle outline so the user can see the
      // placement footprint when polys aren't loaded.
      const w = (pl.rot === 90 || pl.rot === 270) ? pl.h : pl.w;
      const h = (pl.rot === 90 || pl.rot === 270) ? pl.w : pl.h;
      const [cx, cy] = toCanvas(pl.x, pl.y + h);
      ctx.fillStyle = colour + '33';
      ctx.fillRect(cx, cy, w * scale, h * scale);
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.5 * (window.devicePixelRatio || 1);
      ctx.strokeRect(cx, cy, w * scale, h * scale);
      // Polygon outer if available — gives the user the real outline.
      if (pl.polys && pl.polys.outer && pl.polys.outer.length > 1) {
        const [bMinX, bMinY] = [pl.bbox[0], pl.bbox[1]];
        ctx.beginPath();
        for (let k = 0; k < pl.polys.outer.length; k++) {
          const [px, py] = pl.polys.outer[k];
          // Translate so bbox origin = (0,0); rotate; offset to (pl.x, pl.y)
          let lx = px - bMinX, ly = py - bMinY;
          if (pl.rot === 90)  { const t = lx; lx = -ly + pl.w;  ly = t; }
          if (pl.rot === 180) { lx = pl.w - lx; ly = pl.h - ly; }
          if (pl.rot === 270) { const t = lx; lx = ly;          ly = pl.h - t; }
          const [ax, ay] = toCanvas(pl.x + lx, pl.y + ly);
          if (k === 0) ctx.moveTo(ax, ay);
          else         ctx.lineTo(ax, ay);
        }
        ctx.closePath();
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1 * (window.devicePixelRatio || 1);
        ctx.stroke();
      }
      // Holes (INTERIOR_PROFILES) — small dots / outlines
      if (pl.polys && pl.polys.holes) {
        ctx.strokeStyle = colour + 'aa';
        ctx.lineWidth = 0.6 * (window.devicePixelRatio || 1);
        for (const hole of pl.polys.holes) {
          if (hole.length < 2) continue;
          const [bMinX, bMinY] = [pl.bbox[0], pl.bbox[1]];
          ctx.beginPath();
          for (let k = 0; k < hole.length; k++) {
            const [px, py] = hole[k];
            let lx = px - bMinX, ly = py - bMinY;
            if (pl.rot === 90)  { const t = lx; lx = -ly + pl.w;  ly = t; }
            if (pl.rot === 180) { lx = pl.w - lx; ly = pl.h - ly; }
            if (pl.rot === 270) { const t = lx; lx = ly;          ly = pl.h - t; }
            const [ax, ay] = toCanvas(pl.x + lx, pl.y + ly);
            if (k === 0) ctx.moveTo(ax, ay);
            else         ctx.lineTo(ax, ay);
          }
          ctx.stroke();
        }
      }
      // Label: #N code
      ctx.fillStyle = '#e8eef5';
      ctx.font = `${12 * (window.devicePixelRatio || 1)}px "Flux Architect", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelX = cx + (w * scale) / 2;
      const labelY = cy + (h * scale) / 2;
      const text = `#${i + 1} ${pl.code}`;
      ctx.fillText(text, labelX, labelY);
    });
  }

  // ════════════════════════════════════════════════════════════════════
  //  Save Sheets → cut_sheets/<projectKey>/<id>
  // ════════════════════════════════════════════════════════════════════
  async function _saveSheetsToProject() {
    if (!S.flatSheets.length) {
      alert('No nested sheets — click ▶ Run Nesting first.');
      return;
    }
    // Reuse app.js's PAT prompter + GitHub helpers.
    const pat = (window.getGitHubPat || function () { return null; })();
    if (!pat) { alert('GitHub PAT needed to upload.'); return; }

    const projectKey = S.projectKey;
    const ts = (function () {
      const d = new Date();
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
    })();
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
        };
        await window.firebaseDB.ref(`cut_sheets/${projectKey}/${sheetId}`).set(meta);
        ok++;
      } catch (e) {
        fail++;
        if (!firstErr) firstErr = String(e.message || e);
      }
    }
    if (btn) { btn.disabled = false; btn.textContent = origText; }
    alert(`Save Sheets to Project '${S.projectName}'\n\nUploaded: ${ok}\nFailed:   ${fail}` +
          (firstErr ? `\n\nFirst error: ${firstErr}` : ''));
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
        if (pl.rot === 90)  { const t = lx; lx = -ly + pl.w;  ly = t; }
        if (pl.rot === 180) { lx = pl.w - lx; ly = pl.h - ly; }
        if (pl.rot === 270) { const t = lx; lx = ly;          ly = pl.h - t; }
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
    if (canvas && S.flatSheets[S.currentSheetIdx]) {
      // Give the canvas a tick to size before draw.
      requestAnimationFrame(() => _drawSheet(canvas, S.flatSheets[S.currentSheetIdx]));
    }
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
      const status = p.dxfLoaded
        ? `<span class="kdnest-part-ok" title="DXF loaded">✓</span>`
        : p.dxfError
          ? `<span class="kdnest-part-err" title="${_esc(p.dxfError)}">⚠</span>`
          : `<span class="kdnest-part-load" title="loading…">⋯</span>`;
      const g = grainGlyph(p.grain);
      const onSheetIdx = findSheetIdx(p.code);
      const viewDisabled = !p.dxfUrl;
      const sheetDisabled = onSheetIdx < 0;
      return `
        <div class="kdnest-part" data-code="${_esc(p.code)}">
          <input type="checkbox" class="kdnest-part-sel" ${p.selected ? 'checked' : ''}>
          <span class="kdnest-part-num">#${i + 1}</span>
          <span class="kdnest-part-code">${_esc(p.code)}</span>
          <input type="number" class="kdnest-part-w" value="${p.w || ''}" min="0" step="1" placeholder="W">
          <span class="kdnest-x">×</span>
          <input type="number" class="kdnest-part-h" value="${p.h || ''}" min="0" step="1" placeholder="H">
          <input type="number" class="kdnest-part-qty" value="${p.qty}" min="0" step="1" title="qty">
          <button class="kdnest-part-grain ${g.cls}" data-grain="${p.grain}" title="${g.title} — click to cycle ?→H→V→ANY">${g.ch}</button>
          <button class="kdnest-part-view" title="View this part's DXF preview" ${viewDisabled ? 'disabled' : ''}>👁</button>
          <button class="kdnest-part-onsheet" data-sheet="${onSheetIdx}" title="${sheetDisabled ? 'Run Nesting first to place this part' : 'Jump to the sheet where this part is laid out'}" ${sheetDisabled ? 'disabled' : ''}>📍</button>
          ${status}
        </div>`;
    }).join('');

    const sheetStockRows = S.sheetStock.map((s, i) => `
      <div class="kdnest-stock-row">
        <input type="number" data-i="${i}" data-k="w" value="${s.w}" min="1" class="kdnest-stock-dim">
        <span>×</span>
        <input type="number" data-i="${i}" data-k="h" value="${s.h}" min="1" class="kdnest-stock-dim">
        <span>mm · qty</span>
        <input type="number" data-i="${i}" data-k="qty" value="${s.qty}" class="kdnest-stock-qty" title="-1 = unlimited">
        <span class="kdnest-stock-label">${_esc(s.label || '')}</span>
      </div>`).join('');

    const sheetNavInfo = nSheets ? `${S.currentSheetIdx + 1} / ${nSheets}` : '0 / 0';
    const curSheet = S.flatSheets[S.currentSheetIdx];
    const sheetSubLine = curSheet
      ? `${Math.round(curSheet.sw)}×${Math.round(curSheet.sh)} mm · ${curSheet.placements.length} parts`
      : 'Run Nesting to layout';

    return `
      <div class="kdnest-shell">
        <aside class="kdnest-sidebar">
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
                ${['Auto','MaxRects','BL Corner','Left','Bottom']
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
            <button id="kdnest-save-sheets" class="kdnest-btn kdnest-btn-save" ${nSheets ? '' : 'disabled'}>📤 Save Sheets to Project</button>
          </div>
          <div class="kdnest-parts">
            <div class="kdnest-parts-head">
              <button id="kdnest-parts-all" class="kdnest-mini">All</button>
              <button id="kdnest-parts-none" class="kdnest-mini">None</button>
              <span class="kdnest-parts-count">${totalUnique} / ${S.parts.length} · ${totalPcs} pcs</span>
            </div>
            ${partsRows || '<div class="kdnest-empty">No parts in this project</div>'}
          </div>
        </aside>
        <main class="kdnest-canvas-wrap">
          <div class="kdnest-canvas-top">
            <span class="kdnest-canvas-info">Sheet ${sheetNavInfo} · ${_esc(sheetSubLine)}</span>
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
    $('#kdnest-save-sheets')?.addEventListener('click', _saveSheetsToProject);
    $('#kdnest-prev')?.addEventListener('click', () => {
      if (S.currentSheetIdx > 0) { S.currentSheetIdx--; _refreshView(); }
    });
    $('#kdnest-next')?.addEventListener('click', () => {
      if (S.currentSheetIdx < S.flatSheets.length - 1) { S.currentSheetIdx++; _refreshView(); }
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
    // Sheet-stock editors
    S.rootEl.querySelectorAll('.kdnest-stock-dim, .kdnest-stock-qty').forEach(el => {
      el.addEventListener('change', e => {
        const i = parseInt(e.target.dataset.i, 10);
        const k = e.target.dataset.k;
        if (!isNaN(i) && S.sheetStock[i]) {
          S.sheetStock[i][k] = parseFloat(e.target.value) || 0;
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
        _refreshView();
      });
      // View part — open DXF preview modal for this part's source DXF.
      // Reuses app.js's _renderDxfPreviewModal if exposed; else falls
      // back to opening the raw URL.
      row.querySelector('.kdnest-part-view')?.addEventListener('click', () => {
        if (!part.dxfUrl) return;
        if (typeof window._renderDxfPreviewModal === 'function') {
          window._renderDxfPreviewModal({
            url: part.dxfUrl,
            filename: `${part.code}.dxf`,
            thickness_mm: part.thickness,
            grain: part.grain,
            material: 'ALPF',
            uploaded_at: Date.now(),
          });
        } else {
          window.open(part.dxfUrl, '_blank');
        }
      });
      // View @ sheet — jump to whichever sheet currently has this
      // part placed. Disabled (gray) until Run Nesting has assigned
      // a sheet for the code.
      row.querySelector('.kdnest-part-onsheet')?.addEventListener('click', e => {
        const idx = parseInt(e.currentTarget.dataset.sheet, 10);
        if (idx >= 0 && idx < S.flatSheets.length) {
          S.currentSheetIdx = idx;
          _refreshView();
        }
      });
    });
    // Canvas redraw on resize.
    window.addEventListener('resize', () => {
      const canvas = $('#kdnest-canvas');
      if (canvas && S.flatSheets[S.currentSheetIdx]) {
        _drawSheet(canvas, S.flatSheets[S.currentSheetIdx]);
      }
    }, { passive: true });
  }

  // ════════════════════════════════════════════════════════════════════
  //  Public API
  // ════════════════════════════════════════════════════════════════════
  async function openProject(projectKey) {
    if (!projectKey) return;
    S.rootEl = document.getElementById('root');
    if (!S.rootEl) return;
    S.prevHtml = S.rootEl.innerHTML;
    S.rootEl.innerHTML = `<p class="loading">Loading nesting workspace…</p>`;
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
    S.currentSheetIdx = 0;
  }

  window.kdNest = {
    openProject: openProject,
    close: close,
  };
})();
