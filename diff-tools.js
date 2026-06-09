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
    const baseUrl = pdfUrlForCode(baseCode);
    const compUrl = pdfUrlForCode(compareCode);
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

async function _runDxfHoleDiff(baseCode, compCode, containerEl) {
  containerEl.innerHTML = '<div style="color:#8b949e; padding: 20px;">Fetching flat DXFs and computing holes...</div>';
  try {
    if (!window.KD_DXFFLAT) throw new Error("KD_DXFFLAT parser not loaded");
    
    const baseResp = await fetch('Drawings/flat/' + encodeURIComponent(baseCode) + '.dxf');
    const compResp = await fetch('Drawings/flat/' + encodeURIComponent(compCode) + '.dxf');
    
    if (!baseResp.ok || !compResp.ok) throw new Error("Could not load flat DXF for one or both parts.");
    
    const baseText = await baseResp.text();
    const compText = await compResp.text();
    
    const baseDxf = window.KD_DXFFLAT.parseFlatDxf(baseText);
    const compDxf = window.KD_DXFFLAT.parseFlatDxf(compText);
    
    if (!baseDxf || !compDxf) throw new Error("Failed to parse DXF geometries.");
    
    const bHoles = (baseDxf.holes || []).filter(h => h.type === 'circle').map(h => ({
      cx: h.c[0] - baseDxf.bbox.minX,
      cy: h.c[1] - baseDxf.bbox.minY,
      r: h.r
    }));
    
    const cHoles = (compDxf.holes || []).filter(h => h.type === 'circle').map(h => ({
      cx: h.c[0] - compDxf.bbox.minX,
      cy: h.c[1] - compDxf.bbox.minY,
      r: h.r
    }));
    
    const T = 0.5;
    const added = [];
    const removed = [];
    
    bHoles.forEach(bh => {
      const match = cHoles.find(ch => Math.hypot(ch.cx - bh.cx, ch.cy - bh.cy) <= T);
      if (!match) removed.push(bh);
    });
    
    cHoles.forEach(ch => {
      const match = bHoles.find(bh => Math.hypot(bh.cx - ch.cx, bh.cy - ch.cy) <= T);
      if (!match) added.push(ch);
    });
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    const W = compDxf.bbox.w || (compDxf.bbox.maxX - compDxf.bbox.minX);
    const H = compDxf.bbox.h || (compDxf.bbox.maxY - compDxf.bbox.minY);
    const margin = 20;
    
    const cWidth = containerEl.clientWidth || 800;
    const cHeight = containerEl.clientHeight || 600;
    canvas.width = cWidth;
    canvas.height = cHeight;
    canvas.style.maxWidth = '100%';
    canvas.style.maxHeight = '100%';
    
    const scale = Math.min((cWidth - margin*2) / W, (cHeight - margin*2) / H);
    
    // Clear and translate
    ctx.clearRect(0, 0, cWidth, cHeight);
    ctx.translate(margin, cHeight - margin);
    ctx.scale(scale, -scale);
    
    // Draw outline
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = '#c9d1d9';
    if (compDxf.outline && compDxf.outline.segments) {
      compDxf.outline.segments.forEach(seg => {
        ctx.beginPath();
        ctx.moveTo(seg[0][0] - compDxf.bbox.minX, seg[0][1] - compDxf.bbox.minY);
        ctx.lineTo(seg[1][0] - compDxf.bbox.minX, seg[1][1] - compDxf.bbox.minY);
        ctx.stroke();
      });
    }
    
    // Draw normal holes
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    cHoles.forEach(h => {
      ctx.beginPath();
      ctx.arc(h.cx, h.cy, h.r, 0, Math.PI*2);
      ctx.stroke();
    });
    
    // Draw Added
    ctx.strokeStyle = '#3fb950';
    ctx.fillStyle = 'rgba(63, 185, 80, 0.2)';
    ctx.lineWidth = 2 / scale;
    added.forEach(h => {
      ctx.beginPath();
      ctx.arc(h.cx, h.cy, h.r + 5, 0, Math.PI*2);
      ctx.fill();
      ctx.stroke();
    });
    
    // Draw Removed
    ctx.strokeStyle = '#f85149';
    ctx.fillStyle = 'rgba(248, 81, 73, 0.2)';
    ctx.lineWidth = 2 / scale;
    removed.forEach(h => {
      ctx.beginPath();
      ctx.arc(h.cx, h.cy, h.r + 5, 0, Math.PI*2);
      ctx.fill();
      ctx.stroke();
      
      ctx.beginPath();
      ctx.moveTo(h.cx - h.r, h.cy - h.r);
      ctx.lineTo(h.cx + h.r, h.cy + h.r);
      ctx.moveTo(h.cx + h.r, h.cy - h.r);
      ctx.lineTo(h.cx - h.r, h.cy + h.r);
      ctx.stroke();
    });
    
    containerEl.innerHTML = `
      <div style="position:absolute; top: 10px; left: 10px; background: rgba(0,0,0,0.7); padding: 10px; border-radius: 6px; pointer-events: none; z-index: 10;">
        <div style="color: #c9d1d9; font-weight: bold; margin-bottom: 8px;">DXF Geometric Hole-Diff</div>
        <div style="color: #3fb950; margin-bottom: 4px;">&#9679; ${added.length} Holes Added</div>
        <div style="color: #f85149;">&#10006; ${removed.length} Holes Removed</div>
      </div>
    `;
    containerEl.style.position = 'relative';
    containerEl.style.display = 'flex';
    containerEl.style.alignItems = 'center';
    containerEl.style.justifyContent = 'center';
    containerEl.style.background = '#0d1117';
    containerEl.appendChild(canvas);
    
  } catch (err) {
    containerEl.innerHTML = `<div style="color:#f85149; padding: 20px;">Error: ${err.message}</div>`;
  }
}

// Override Compare Similar Drawings Modal
function _openSimilarCompareModal(baseCode, fam) {
  const parts = baseCode.split('-');
  if (parts.length < 2) {
    alert(`Cannot determine WWWHHH size suffix for code "${baseCode}".`);
    return;
  }
  const suffix = parts.pop();

  const allInFam = partsByFamily()[fam] || [];
  const candidates = allInFam.filter(p => p.code !== baseCode && p.code.endsWith('-' + suffix));

  if (candidates.length === 0) {
    alert(`No similar drawings found in family "${fam}" with suffix "-${suffix}".`);
    return;
  }

  const ov = document.createElement('div');
  ov.className = 'bt-overlay';
  ov.style.zIndex = '99999';
  
  const basePdf = pdfUrlForCode(baseCode) || '';
  let currentCompareCode = candidates[0].code;
  let currentMode = 'sidebyside';
  
  const candidateOptions = candidates.map((c, i) => 
    `<option value="${escapeHtml(c.code)}" ${i === 0 ? 'selected' : ''}>${escapeHtml(c.code)}</option>`
  ).join('');

  ov.innerHTML = `
    <div class="bt-modal" role="dialog" style="width: 95vw; height: 90vh; max-width: none; display: flex; flex-direction: column;">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #2b3340; padding-bottom: 10px; margin-bottom: 10px;">
        <div style="display: flex; align-items: center; gap: 15px;">
          <h2 style="margin: 0; font-size: 18px; color: #58a6ff;">&#128269; Compare Drawings</h2>
          <div class="bt-modal-tabs" style="display: flex; gap: 5px; background: #0d1117; padding: 4px; border-radius: 6px; border: 1px solid #30363d;">
            <button id="cmp-btn-sidebyside" class="action-btn active" style="padding: 4px 10px; font-size: 12px; background: #238636; color: #fff;">Side-by-Side PDF</button>
            <button id="cmp-btn-pdfdiff" class="action-btn" style="padding: 4px 10px; font-size: 12px; background: transparent; color: #c9d1d9;">Visual PDF Diff</button>
            <button id="cmp-btn-dxfdiff" class="action-btn" style="padding: 4px 10px; font-size: 12px; background: transparent; color: #c9d1d9;">DXF Hole Diff</button>
          </div>
        </div>
        <button class="bt-close" aria-label="Close" style="background: transparent; border: none; font-size: 24px; color: #8b949e; cursor: pointer;">&times;</button>
      </div>
      
      <!-- Split View Container -->
      <div id="cmp-split-view" style="display: flex; flex: 1; gap: 10px; overflow: hidden;">
        <div style="flex: 1; display: flex; flex-direction: column; background: #0d1117; border: 1px solid #30363d; border-radius: 6px;">
          <div style="padding: 8px 12px; background: #161b22; border-bottom: 1px solid #30363d; font-weight: bold; color: #c9d1d9;">
            Base: ${escapeHtml(baseCode)}
          </div>
          <iframe src="${escapeHtml(basePdf)}#toolbar=0&navpanes=0" style="flex: 1; border: none; width: 100%;"></iframe>
        </div>
        <div style="flex: 1; display: flex; flex-direction: column; background: #0d1117; border: 1px solid #30363d; border-radius: 6px;">
          <div style="padding: 8px 12px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; align-items: center; gap: 10px; color: #c9d1d9;">
            <strong style="white-space: nowrap;">Compare with:</strong>
            <select id="compare-select" style="flex: 1; padding: 4px; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 4px;">
              ${candidateOptions}
            </select>
          </div>
          <iframe id="compare-iframe" src="${escapeHtml(pdfUrlForCode(currentCompareCode) || '')}#toolbar=0&navpanes=0" style="flex: 1; border: none; width: 100%;"></iframe>
        </div>
      </div>
      
      <!-- Single View Container (for diffs) -->
      <div id="cmp-single-view" style="display: none; flex: 1; flex-direction: column; border: 1px solid #30363d; border-radius: 6px; overflow: hidden;">
         <div style="padding: 8px 12px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; align-items: center; gap: 10px; color: #c9d1d9;">
            <strong style="white-space: nowrap;">Base:</strong> ${escapeHtml(baseCode)}
            <strong style="white-space: nowrap; margin-left: 20px;">Compare with:</strong>
            <select id="compare-select-single" style="flex: 1; padding: 4px; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 4px;">
              ${candidateOptions}
            </select>
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
  const compareIframe = ov.querySelector('#compare-iframe');
  
  const selectSplit = ov.querySelector('#compare-select');
  const selectSingle = ov.querySelector('#compare-select-single');

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
      compareIframe.src = (pdfUrlForCode(currentCompareCode) || '') + '#toolbar=0&navpanes=0';
    } else {
      splitView.style.display = 'none';
      singleView.style.display = 'flex';
      if (currentMode === 'pdfdiff') {
        btnPdfDiff.style.background = '#238636';
        btnPdfDiff.style.color = '#fff';
        _runPdfVisualDiff(baseCode, currentCompareCode, canvasContainer);
      } else if (currentMode === 'dxfdiff') {
        btnDxfDiff.style.background = '#238636';
        btnDxfDiff.style.color = '#fff';
        _runDxfHoleDiff(baseCode, currentCompareCode, canvasContainer);
      }
    }
  }
  
  function setCompareCode(code) {
    currentCompareCode = code;
    selectSplit.value = code;
    selectSingle.value = code;
    updateView();
  }

  selectSplit.addEventListener('change', () => setCompareCode(selectSplit.value));
  selectSingle.addEventListener('change', () => setCompareCode(selectSingle.value));

  btnSideBySide.addEventListener('click', () => { currentMode = 'sidebyside'; updateView(); });
  btnPdfDiff.addEventListener('click', () => { currentMode = 'pdfdiff'; updateView(); });
  btnDxfDiff.addEventListener('click', () => { currentMode = 'dxfdiff'; updateView(); });
}
