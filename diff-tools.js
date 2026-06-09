// --- Diff vs Library (Level B & C) Helpers ---
async function _renderPdfToCanvas(url) {
  if (!window.pdfjsLib) throw new Error("pdf.js not loaded. Please wait or reload.");
  const loadingTask = window.pdfjsLib.getDocument(url);
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  const scale = 1.5;
  const viewport = page.getViewport({ scale });
  
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  canvas.height = viewport.height;
  canvas.width = viewport.width;
  
  const renderContext = { canvasContext: context, viewport: viewport };
  await page.render(renderContext).promise;
  return canvas;
}

async function _runPdfVisualDiff(baseCode, compareCode, containerEl) {
  containerEl.innerHTML = '<div style="color:#8b949e; padding: 20px;">Rendering PDFs for visual diff...</div>';
  try {
    const baseUrl = resolvePartPdfUrl(baseCode);
    const compUrl = resolvePartPdfUrl(compareCode);
    if (!baseUrl || !compUrl) throw new Error("Missing PDF for one of the parts.");
    
    const [baseCanvas, compCanvas] = await Promise.all([
      _renderPdfToCanvas(baseUrl),
      _renderPdfToCanvas(compUrl)
    ]);
    
    const width = Math.max(baseCanvas.width, compCanvas.width);
    const height = Math.max(baseCanvas.height, compCanvas.height);
    
    const diffCanvas = document.createElement('canvas');
    diffCanvas.width = width;
    diffCanvas.height = height;
    diffCanvas.style.maxWidth = '100%';
    diffCanvas.style.maxHeight = '100%';
    diffCanvas.style.objectFit = 'contain';
    diffCanvas.style.border = '1px solid #30363d';
    const ctx = diffCanvas.getContext('2d');
    
    const baseCtx = baseCanvas.getContext('2d');
    const compCtx = compCanvas.getContext('2d');
    
    const baseData = baseCtx.getImageData(0, 0, width, height).data;
    const compData = compCtx.getImageData(0, 0, width, height).data;
    
    const offscreen = document.createElement('canvas');
    offscreen.width = width; offscreen.height = height;
    const offCtx = offscreen.getContext('2d');
    const overlay = offCtx.createImageData(width, height);
    const outData = overlay.data;
    
    for (let i = 0; i < baseData.length; i += 4) {
      const baseGray = (baseData[i] + baseData[i+1] + baseData[i+2]) / 3;
      const compGray = (compData[i] + compData[i+1] + compData[i+2]) / 3;
      
      const diff = Math.abs(baseGray - compGray);
      if (diff > 50) {
        outData[i] = 255;   // R
        outData[i+1] = 0;   // G
        outData[i+2] = 0;   // B
        outData[i+3] = 255; // A
      } else {
        outData[i+3] = 0;
      }
    }
    offCtx.putImageData(overlay, 0, 0);
    
    ctx.globalAlpha = 0.5;
    ctx.drawImage(baseCanvas, 0, 0);
    ctx.globalAlpha = 1.0;
    ctx.drawImage(offscreen, 0, 0);
    
    containerEl.innerHTML = '';
    containerEl.style.display = 'flex';
    containerEl.style.alignItems = 'center';
    containerEl.style.justifyContent = 'center';
    containerEl.style.overflow = 'auto';
    containerEl.style.background = '#0d1117';
    containerEl.appendChild(diffCanvas);
    
  } catch (err) {
    containerEl.innerHTML = `<div style="color:#f85149; padding: 20px;">Error: ${err.message}</div>`;
  }
}

// "Download PDF with diff" — render the COMPARE drawing PDF to a canvas, overlay the
// pixel-region differences (vs the base drawing) as DASHED red circles, export a new
// single-page PDF (pdf-lib, already loaded). Robust pixel-region path — no DXF->sheet
// coordinate mapping (the geometric-rings-on-PDF, which would honor the category
// selector, is the harder follow-up). pdf.js render paints on the live site (it stalls
// only in the headless preview, like the Visual PDF Diff).
async function _exportDiffPdf(baseCode, compCode, btnEl) {
  const orig = btnEl ? btnEl.innerHTML : '';
  if (btnEl) { btnEl.disabled = true; btnEl.innerHTML = 'Rendering...'; }
  try {
    if (!window.pdfjsLib) throw new Error('pdf.js not loaded');
    if (!window.PDFLib) throw new Error('pdf-lib not loaded');
    const baseUrl = resolvePartPdfUrl(baseCode), compUrl = resolvePartPdfUrl(compCode);
    if (!baseUrl || !compUrl) throw new Error('Missing PDF for one of the parts');

    const [baseCanvas, compCanvas] = await Promise.all([
      _renderPdfToCanvas(baseUrl), _renderPdfToCanvas(compUrl)
    ]);
    const w = Math.max(baseCanvas.width, compCanvas.width);
    const h = Math.max(baseCanvas.height, compCanvas.height);

    // composite = the compare drawing + dashed diff markers
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    octx.fillStyle = '#ffffff'; octx.fillRect(0, 0, w, h);
    octx.drawImage(compCanvas, 0, 0);

    const baseData = baseCanvas.getContext('2d').getImageData(0, 0, w, h).data;
    const compData = compCanvas.getContext('2d').getImageData(0, 0, w, h).data;
    const regions = window.KD_GEOMDIFF.pixelDiffRegions(baseData, compData, w, h, { threshold: 50, cell: 16, minCells: 2 });
    octx.strokeStyle = '#d1242f'; octx.lineWidth = 1;   // RD: thin 1px / single stroke
    octx.setLineDash([Math.max(8, w / 120), Math.max(5, w / 200)]);
    regions.forEach(rg => { octx.beginPath(); octx.arc(rg.cx, rg.cy, rg.r, 0, Math.PI * 2); octx.stroke(); });
    octx.setLineDash([]);

    const { PDFDocument } = window.PDFLib;
    const pdfDoc = await PDFDocument.create();
    const png = await pdfDoc.embedPng(out.toDataURL('image/png'));
    const page = pdfDoc.addPage([w, h]);
    page.drawImage(png, { x: 0, y: 0, width: w, height: h });
    const bytes = await pdfDoc.save();

    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = compCode + '_diff.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    if (btnEl) btnEl.innerHTML = '&#10003; ' + regions.length + ' marked';
  } catch (err) {
    if (btnEl) btnEl.innerHTML = '&#10006; ' + (err.message || 'failed');
    console.warn('export diff pdf failed:', err);
  } finally {
    if (btnEl) setTimeout(() => { btnEl.disabled = false; btnEl.innerHTML = orig; }, 2200);
  }
}

// Geometry Diff (Level C + categories) — uses the shared pure engine
// KD_GEOMDIFF.geomDiff (diff-geom.js) so Fusion (CC_DiffHoles) and Web agree on what
// differs. Renders the COMPARE flat (outline + holes) with green=added / red=removed(X)
// / amber=resized rings + a text summary panel. Later tasks extend the summary with
// dims/bends/cutouts/thickness. Replaces the old _runDxfHoleDiff (added/removed only).
// per-category visibility (Holes/Bends/Dims/Cutouts/Material — aligned w/ G1 CC_Diff),
// default all on; persists across toggles within a session. _geomLast caches the last
// computed diff + flats so toggling a category re-PAINTS without re-fetching the DXFs.
let _geomCats = { holes: true, bends: true, dims: true, cutouts: true, material: true };
let _geomLast = null;

async function _renderGeomDiff(baseCode, compCode, containerEl) {
  containerEl.innerHTML = '<div style="color:#8b949e; padding: 20px;">Fetching flat DXFs and computing geometry diff...</div>';
  try {
    if (!window.KD_DXFFLAT) throw new Error("KD_DXFFLAT parser not loaded");
    if (!window.KD_GEOMDIFF) throw new Error("KD_GEOMDIFF engine not loaded");

    const [baseResp, compResp] = await Promise.all([
      fetch('Drawings/flat/' + encodeURIComponent(baseCode) + '.dxf'),
      fetch('Drawings/flat/' + encodeURIComponent(compCode) + '.dxf')
    ]);
    if (!baseResp.ok || !compResp.ok) throw new Error("Could not load flat DXF for one or both parts (need Drawings/flat/<code>.dxf).");

    const baseDxf = window.KD_DXFFLAT.parseFlatDxf(await baseResp.text());
    const compDxf = window.KD_DXFFLAT.parseFlatDxf(await compResp.text());
    if (!baseDxf || !compDxf) throw new Error("Failed to parse DXF geometries.");

    // thickness from the bend_sim record (flat DXF carries no thickness); null -> "unknown".
    const recFor = c => {
      const cache = (typeof _bendSimCache !== 'undefined') ? _bendSimCache : (window._bendSimCache || {});
      const b = cache[c];
      return (b && b.thickness != null) ? { thickness: +b.thickness } : null;
    };
    const d = window.KD_GEOMDIFF.geomDiff(baseDxf, compDxf, recFor(baseCode), recFor(compCode));
    _geomLast = { baseDxf, compDxf, d, containerEl };
    _paintGeomDiff();
  } catch (err) {
    containerEl.innerHTML = `<div style="color:#f85149; padding:20px;">Error: ${err.message}</div>`;
  }
}

// Re-draw the cached diff honoring _geomCats — runs on first render + on every toggle.
function _paintGeomDiff() {
  if (!_geomLast) return;
  const baseDxf = _geomLast.baseDxf, compDxf = _geomLast.compDxf, d = _geomLast.d, containerEl = _geomLast.containerEl;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const W = compDxf.bbox.w || (compDxf.bbox.maxX - compDxf.bbox.minX);
  const H = compDxf.bbox.h || (compDxf.bbox.maxY - compDxf.bbox.minY);
  const margin = 24;
  const cWidth = containerEl.clientWidth || 800;
  const cHeight = containerEl.clientHeight || 600;
  canvas.width = cWidth; canvas.height = cHeight;
  canvas.style.maxWidth = '100%'; canvas.style.maxHeight = '100%';
  const scale = Math.min((cWidth - margin * 2) / W, (cHeight - margin * 2) / H);
  ctx.clearRect(0, 0, cWidth, cHeight);
  ctx.translate(margin, cHeight - margin);
  ctx.scale(scale, -scale);

  // outline + faint holes = context, drawn regardless of category toggles
  ctx.lineWidth = 1 / scale; ctx.strokeStyle = '#c9d1d9';
  if (compDxf.outline && compDxf.outline.segments) {
    compDxf.outline.segments.forEach(seg => {
      ctx.beginPath();
      ctx.moveTo(seg[0][0] - compDxf.bbox.minX, seg[0][1] - compDxf.bbox.minY);
      ctx.lineTo(seg[1][0] - compDxf.bbox.minX, seg[1][1] - compDxf.bbox.minY);
      ctx.stroke();
    });
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  (compDxf.holes || []).filter(h => h.type === 'circle').forEach(h => {
    ctx.beginPath();
    ctx.arc(h.c[0] - compDxf.bbox.minX, h.c[1] - compDxf.bbox.minY, h.r, 0, Math.PI * 2);
    ctx.stroke();
  });

  if (_geomCats.holes) {
    const ring = (h, stroke, fill) => {
      ctx.strokeStyle = stroke; ctx.fillStyle = fill; ctx.lineWidth = 2 / scale;
      ctx.beginPath(); ctx.arc(h.cx, h.cy, (h.r || 3) + 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    };
    d.holes.added.forEach(h => ring(h, '#3fb950', 'rgba(63,185,80,0.2)'));
    d.holes.resized.forEach(h => ring(h, '#F2A93B', 'rgba(242,169,59,0.2)'));
    d.holes.removed.forEach(h => {
      ring(h, '#f85149', 'rgba(248,81,73,0.2)');
      const r = (h.r || 3) + 5;
      ctx.beginPath();
      ctx.moveTo(h.cx - r, h.cy - r); ctx.lineTo(h.cx + r, h.cy + r);
      ctx.moveTo(h.cx + r, h.cy - r); ctx.lineTo(h.cx - r, h.cy + r);
      ctx.stroke();
    });
  }

  if (_geomCats.bends) {
    const drawBend = (bn, off, color, dashed) => {
      if (!bn.a || !bn.b) return;
      ctx.strokeStyle = color; ctx.lineWidth = 2.5 / scale;
      ctx.setLineDash(dashed ? [6 / scale, 4 / scale] : []);
      ctx.beginPath();
      ctx.moveTo(bn.a[0] - off.minX, bn.a[1] - off.minY);
      ctx.lineTo(bn.b[0] - off.minX, bn.b[1] - off.minY);
      ctx.stroke(); ctx.setLineDash([]);
    };
    d.bends.added.forEach(bn => drawBend(bn, compDxf.bbox, '#3fb950', false));
    d.bends.removed.forEach(bn => drawBend(bn, baseDxf.bbox, '#f85149', true));
  }

  if (_geomCats.cutouts) {
    const cutBox = (cu, color) => {
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      (cu.pts || []).forEach(p => { if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0]; if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1]; });
      const hw = isFinite(mnx) ? (mxx - mnx) / 2 : 6, hh = isFinite(mny) ? (mxy - mny) / 2 : 6;
      ctx.strokeStyle = color; ctx.lineWidth = 2 / scale; ctx.setLineDash([]);
      ctx.strokeRect(cu.cx - hw, cu.cy - hh, hw * 2, hh * 2);
    };
    d.cutouts.added.forEach(cu => cutBox(cu, '#3fb950'));
    d.cutouts.removed.forEach(cu => cutBox(cu, '#f85149'));
  }

  // per-category toggle chips + summary (filtered to the enabled categories)
  const CATS = [['holes', 'Holes'], ['bends', 'Bends'], ['dims', 'Dims'], ['cutouts', 'Cutouts'], ['material', 'Material']];
  const chips = CATS.map(([k, label]) => {
    const on = _geomCats[k];
    return `<button class="geomcat-chip" data-cat="${k}" title="Toggle ${label}" style="cursor:pointer;border:1px solid ${on ? '#2F81F7' : '#3a4757'};background:${on ? '#13315c' : 'transparent'};color:${on ? '#69A8FF' : '#6b7785'};border-radius:12px;padding:2px 10px;font-size:11px;margin:0 3px 3px 0;">${label}</button>`;
  }).join('');
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = window.KD_GEOMDIFF.geomDiffSummary(d)
    .filter(l => _geomCats[l.cat])
    .map(l => `<div style="color:${l.color};">${esc(l.text)}</div>`);

  containerEl.innerHTML = `
    <div style="position:absolute; top:10px; left:10px; background:rgba(0,0,0,0.78); padding:10px 12px; border-radius:6px; z-index:10; font-size:13px; line-height:1.6; max-width:46%;">
      <div style="color:#c9d1d9; font-weight:bold; margin-bottom:6px;">Geometry Diff</div>
      <div style="margin-bottom:8px;">${chips}</div>
      ${lines.join('') || '<div style="color:#6b7785;">No categories selected</div>'}
    </div>`;
  containerEl.style.position = 'relative';
  containerEl.style.display = 'flex';
  containerEl.style.alignItems = 'center';
  containerEl.style.justifyContent = 'center';
  containerEl.style.background = '#0d1117';
  containerEl.appendChild(canvas);

  containerEl.querySelectorAll('.geomcat-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      _geomCats[chip.dataset.cat] = !_geomCats[chip.dataset.cat];
      _paintGeomDiff();
    });
  });
}

// Human-facing display name for a code (admin display_override) — the raw code stays
// the machine identity (option VALUE, pdfUrlForCode lookups). (RD 02 2026-06-09)
function _disp(code) {
  try { return (typeof displayCodeFor === 'function') ? displayCodeFor(code) : code; }
  catch (e) { return code; }
}

// Override Compare Similar Drawings Modal
// defaultMode (optional): 'pdfdiff' | 'dxfdiff' opens the modal directly on that
// tab (DRAWING-tab "Diff" entry opens on Visual PDF Diff). Omitted → Side-by-Side.
function _openSimilarCompareModal(baseCode, fam, defaultMode) {
  // RD 02 2026-06-09: เอ๋ picks ANY drawing to compare — not just same-family+suffix.
  // "Suggested" (same fam + same size, with a PDF) shows first as a shortcut; the full
  // searchable list covers every drawing that has a PDF. No abort, no auto-commit.
  const parts = baseCode.split('-');
  const suffix = parts.length >= 2 ? parts[parts.length - 1] : '';
  const allInFam = partsByFamily()[fam] || [];
  const suggested = allInFam
    .filter(p => p.code !== baseCode && suffix && p.code.endsWith('-' + suffix) && resolvePartPdfUrl(p.code))
    .map(p => p.code);
  const suggestedSet = new Set(suggested);
  const allCodes = (() => {
    const seen = new Set(); const out = [];
    const by = partsByFamily();
    for (const f of Object.keys(by)) for (const p of (by[f] || [])) {
      if (p.code && p.code !== baseCode && !seen.has(p.code) && resolvePartPdfUrl(p.code)) { seen.add(p.code); out.push(p.code); }
    }
    out.sort((a, b) => a.localeCompare(b));
    return out;
  })();

  const ov = document.createElement('div');
  ov.className = 'bt-overlay';
  ov.style.zIndex = '99999';

  const basePdf = resolvePartPdfUrl(baseCode) || '';
  let currentCompareCode = null;   // no auto-commit — เอ๋ picks
  let currentMode = (defaultMode === 'pdfdiff' || defaultMode === 'dxfdiff') ? defaultMode : 'sidebyside';
  const pickPrompt = '<div style="margin:auto; color:#6b7785; font-size:14px; text-align:center; padding:30px;">&#8593; Pick a drawing to compare<br><span style="font-size:12px;">(type any code in the search box above)</span></div>';

  ov.innerHTML = `
    <div class="bt-modal" role="dialog" style="width: 95vw; height: 90vh; max-width: none; display: flex; flex-direction: column;">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #2b3340; padding-bottom: 10px; margin-bottom: 10px;">
        <div style="display: flex; align-items: center; gap: 15px;">
          <h2 style="margin: 0; font-size: 18px; color: #58a6ff;">&#128269; Compare Drawings</h2>
          <div class="bt-modal-tabs" style="display: flex; gap: 5px; background: #0d1117; padding: 4px; border-radius: 6px; border: 1px solid #30363d;">
            <button id="cmp-btn-sidebyside" class="action-btn active" style="padding: 4px 10px; font-size: 12px; background: #238636; color: #fff;">Side-by-Side PDF</button>
            <button id="cmp-btn-pdfdiff" class="action-btn" style="padding: 4px 10px; font-size: 12px; background: transparent; color: #c9d1d9;">Visual PDF Diff</button>
            <button id="cmp-btn-dxfdiff" class="action-btn" style="padding: 4px 10px; font-size: 12px; background: transparent; color: #c9d1d9;">Geometry Diff</button>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <button id="cmp-btn-export" class="action-btn" title="Render the drawing PDF with the differences drawn on as dashed markers, and download it" style="padding: 5px 12px; font-size: 12px; background: #1f6f3a; color: #fff; border: none; border-radius: 5px; cursor: pointer;">&#11015; PDF with diff</button>
          <button class="bt-close" aria-label="Close" style="background: transparent; border: none; font-size: 24px; color: #8b949e; cursor: pointer;">&times;</button>
        </div>
      </div>

      <!-- Compare picker bar (always visible, searchable across ALL drawings) -->
      <div style="position: relative; display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
        <strong style="white-space: nowrap; color: #c9d1d9;">Compare with:</strong>
        <input id="cmp-search" type="text" autocomplete="off" placeholder="Type any drawing code…"
          style="flex: 1; padding: 6px 10px; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 5px; font-size: 13px;">
        <div id="cmp-results" style="display: none; position: absolute; top: 100%; left: 0; right: 0; z-index: 10; margin-top: 2px; max-height: 340px; overflow: auto; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; box-shadow: 0 8px 28px rgba(0,0,0,.55);"></div>
      </div>

      <!-- Split View Container -->
      <div id="cmp-split-view" style="display: flex; flex: 1; gap: 10px; overflow: hidden;">
        <div style="flex: 1; display: flex; flex-direction: column; background: #0d1117; border: 1px solid #30363d; border-radius: 6px;">
          <div style="padding: 8px 12px; background: #161b22; border-bottom: 1px solid #30363d; font-weight: bold; color: #c9d1d9;">
            Base: ${escapeHtml(_disp(baseCode))}
          </div>
          <iframe src="${escapeHtml(basePdf)}#toolbar=0&navpanes=0" style="flex: 1; border: none; width: 100%;"></iframe>
        </div>
        <div style="flex: 1; display: flex; flex-direction: column; background: #0d1117; border: 1px solid #30363d; border-radius: 6px;">
          <div id="cmp-right-head" style="padding: 8px 12px; background: #161b22; border-bottom: 1px solid #30363d; font-weight: bold; color: #c9d1d9;">
            Compare: (pick a drawing)
          </div>
          <div id="cmp-right-body" style="flex: 1; display: flex; overflow: hidden;"></div>
        </div>
      </div>

      <!-- Single View Container (for diffs) -->
      <div id="cmp-single-view" style="display: none; flex: 1; flex-direction: column; border: 1px solid #30363d; border-radius: 6px; overflow: hidden;">
         <div style="padding: 8px 12px; background: #161b22; border-bottom: 1px solid #30363d; color: #c9d1d9;">
            <strong style="white-space: nowrap;">Base:</strong> ${escapeHtml(_disp(baseCode))}
            <strong id="cmp-single-cmp" style="white-space: nowrap; margin-left: 20px;">&nbsp;</strong>
          </div>
          <div id="cmp-canvas-container" style="flex: 1; background: #0d1117; position: relative; overflow: auto; display: flex;"></div>
      </div>
    </div>
  `;
  document.body.appendChild(ov);

  ov.addEventListener('click', e => {
    if (e.target === ov || e.target.closest('.bt-close')) ov.remove();
  });

  const splitView = ov.querySelector('#cmp-split-view');
  const singleView = ov.querySelector('#cmp-single-view');
  const canvasContainer = ov.querySelector('#cmp-canvas-container');
  const rightHead = ov.querySelector('#cmp-right-head');
  const rightBody = ov.querySelector('#cmp-right-body');
  const singleCmpLbl = ov.querySelector('#cmp-single-cmp');
  const searchInput = ov.querySelector('#cmp-search');
  const resultsBox = ov.querySelector('#cmp-results');

  const btnSideBySide = ov.querySelector('#cmp-btn-sidebyside');
  const btnPdfDiff = ov.querySelector('#cmp-btn-pdfdiff');
  const btnDxfDiff = ov.querySelector('#cmp-btn-dxfdiff');

  function updateView() {
    [btnSideBySide, btnPdfDiff, btnDxfDiff].forEach(b => {
      b.style.background = 'transparent';
      b.style.color = '#c9d1d9';
    });

    if (currentMode === 'sidebyside') {
      btnSideBySide.style.background = '#238636';
      btnSideBySide.style.color = '#fff';
      singleView.style.display = 'none';
      splitView.style.display = 'flex';
      if (!currentCompareCode) {
        rightHead.textContent = 'Compare: (pick a drawing)';
        rightBody.innerHTML = pickPrompt;
      } else {
        rightHead.textContent = 'Compare: ' + _disp(currentCompareCode);
        const url = resolvePartPdfUrl(currentCompareCode) || '';
        rightBody.innerHTML = '<iframe src="' + escapeHtml(url) + '#toolbar=0&navpanes=0" style="flex:1; border:none; width:100%;"></iframe>';
      }
      return;
    }

    splitView.style.display = 'none';
    singleView.style.display = 'flex';
    if (currentMode === 'pdfdiff') { btnPdfDiff.style.background = '#238636'; btnPdfDiff.style.color = '#fff'; }
    else if (currentMode === 'dxfdiff') { btnDxfDiff.style.background = '#238636'; btnDxfDiff.style.color = '#fff'; }
    singleCmpLbl.innerHTML = currentCompareCode
      ? 'Compare with: ' + escapeHtml(_disp(currentCompareCode))
      : '&nbsp;';
    if (!currentCompareCode) { canvasContainer.innerHTML = pickPrompt; return; }
    if (currentMode === 'pdfdiff') _runPdfVisualDiff(baseCode, currentCompareCode, canvasContainer);
    else if (currentMode === 'dxfdiff') _renderGeomDiff(baseCode, currentCompareCode, canvasContainer);
  }

  function setCompareCode(code) {
    currentCompareCode = code;
    searchInput.value = _disp(code);
    resultsBox.style.display = 'none';
    updateView();
  }

  // Searchable picker: "Suggested" (same family + same size, has a PDF) first as a
  // shortcut, then EVERY drawing with a PDF. Matches on raw code OR display name.
  function renderResults(query) {
    const q = (query || '').trim().toLowerCase();
    const match = c => !q || c.toLowerCase().includes(q) || _disp(c).toLowerCase().includes(q);
    const sugg = suggested.filter(match);
    const rest = allCodes.filter(c => !suggestedSet.has(c) && match(c));
    const groupHead = t => '<div style="padding:6px 12px; font-size:11px; letter-spacing:.5px; text-transform:uppercase; color:#8b949e; background:#161b22; position:sticky; top:0;">' + t + '</div>';
    const item = c => {
      const disp = _disp(c);
      const sub = (disp !== c) ? '<span style="color:#6b7785; font-size:11px; margin-left:8px;">' + escapeHtml(c) + '</span>' : '';
      return '<div class="cmp-result-item" data-code="' + escapeHtml(c) + '" title="' + escapeHtml(c) + '" style="padding:7px 12px; cursor:pointer; color:#c9d1d9; font-size:13px; border-top:1px solid #1b2027;">' + escapeHtml(disp) + sub + '</div>';
    };
    let html = '';
    if (sugg.length) html += groupHead('Suggested (same size)') + sugg.map(item).join('');
    if (rest.length) html += groupHead('All drawings') + rest.map(item).join('');
    if (!html) html = '<div style="padding:14px 12px; color:#6b7785; font-size:13px;">No drawings match.</div>';
    resultsBox.innerHTML = html;
    resultsBox.style.display = 'block';
  }

  searchInput.addEventListener('focus', () => renderResults(searchInput.value));
  searchInput.addEventListener('input', () => renderResults(searchInput.value));
  resultsBox.addEventListener('click', e => {
    const it = e.target.closest('.cmp-result-item');
    if (it && it.dataset.code) setCompareCode(it.dataset.code);
  });
  // Close the dropdown on clicks elsewhere inside the modal (overlay click closes the modal itself).
  ov.addEventListener('mousedown', e => {
    if (!e.target.closest('#cmp-search') && !e.target.closest('#cmp-results')) resultsBox.style.display = 'none';
  });

  btnSideBySide.addEventListener('click', () => { currentMode = 'sidebyside'; updateView(); });
  btnPdfDiff.addEventListener('click', () => { currentMode = 'pdfdiff'; updateView(); });
  btnDxfDiff.addEventListener('click', () => { currentMode = 'dxfdiff'; updateView(); });

  const btnExport = ov.querySelector('#cmp-btn-export');
  if (btnExport) btnExport.addEventListener('click', () => {
    if (!currentCompareCode) { alert('Pick a drawing to compare first.'); return; }
    _exportDiffPdf(baseCode, currentCompareCode, btnExport);
  });

  updateView();
}
