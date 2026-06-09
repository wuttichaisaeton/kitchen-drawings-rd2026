// Custom mindmap editor — React Flow OSS (MIT).
// Phase A1: standalone canvas with add/drag/connect/rename/delete.
// RTDB persistence + linked-node visuals land in A3/A4.
//
// Exported as `KitchenMindmapEditor.mount(rootEl, options)` so main app.js
// can lazy-load this bundle and mount into any div.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  Handle,
  Position,
  useReactFlow,
  BaseEdge,
  getStraightPath,
  useInternalNode,
} from '@xyflow/react';
import './style.css';

// Fusion bridge: same endpoint the Auto mindmap uses to open .f3d / .f2d.
// Bridge is CC_DrawingWatcher's HTTP server (see _MASTERS/fusion_scripts).
async function openInFusion(urn, fallbackUrl) {
  if (urn) {
    try {
      const r = await fetch(
        `http://127.0.0.1:8765/open?urn=${encodeURIComponent(urn)}`,
        { method: 'GET', mode: 'cors' }
      );
      if (r.ok) return { ok: true, via: 'bridge' };
    } catch (e) { /* bridge down → fall through */ }
  }
  if (fallbackUrl) {
    (window.kdAPI?.openInNewTab || ((u) => window.open(u, '_blank', 'noopener')))(fallbackUrl);
    return { ok: true, via: 'web' };
  }
  return { ok: false };
}

// ── Project center node ─────────────────────────────────────────────
// Circle with 3D cubes icon + PROJECT label INSIDE the circle + project
// code below. Click opens the project's master PDF (same as the SVG
// .mm-center click used to). Admin can drag it; workshop view-only.
function ProjectCenterNode({ id, data, selected }) {
  const { label, code, projectKey, collapsed, admin, logoRadius } = data;
  const displayCode = code || label || projectKey;
  // Admin drag-drop PDF onto the center → uploads as <projectKey>.pdf,
  // i.e. the project master. Same uploadPdfFromDrop path used by BOM
  // nodes + Library family cards / part rows. Workshop view-only:
  // dragOver / drop are no-ops without admin.
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const api = window.kdAPI || {};

  const onDragOver = useCallback((e) => {
    if (!admin) return;
    const items = e.dataTransfer?.items;
    if (!items || ![...items].some(it => it.kind === 'file')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }, [admin]);

  const onDragLeave = useCallback((e) => {
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const onDrop = useCallback(async (e) => {
    if (!admin || !projectKey) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!api.uploadPdfFromDrop) {
      window.alert('Upload API not available — refresh the page.');
      return;
    }
    setUploading(true);
    try {
      // family='' so it lands in 'Custom' family in Library; admin can
      // 📁-move it elsewhere later if a dedicated "Project Masters"
      // folder is desired.
      const ok = await api.uploadPdfFromDrop(file, projectKey, '');
      if (ok) api.rerender?.();
    } finally {
      setUploading(false);
    }
  }, [admin, projectKey, api]);

  // Click handling moved up to ReactFlow.onNodeClick / onNodeDoubleClick
  // because React Flow's drag detection on the node container intercepts
  // bubbled clicks in some browsers (admin draggable nodes). The parent
  // handlers run after RF's own gesture detection so they're reliable.
  // Big "logo" circle (เอ๋ 2026-06-09): when app.js sets data.logoRadius (DEEP
  // assembly), the project center renders as a BIG circle that the cabinet ring
  // sits inside. The big disc is a NON-interactive backdrop (pointer-events:none
  // so it doesn't eat cabinet taps); a small centred .kme-center-hub carries the
  // logo + project name + the click/collapse/drop affordance.
  const big = Number(logoRadius) > 0;
  const sizePx = big ? Math.round(2 * Number(logoRadius)) : null;
  const cls = ['kme-center'];
  if (big) cls.push('kme-center-logo');
  if (selected) cls.push('kme-selected');
  if (collapsed) cls.push('kme-center-collapsed');
  if (dragOver) cls.push('kme-center-drag-over');
  if (uploading) cls.push('kme-center-uploading');
  const logoSvg = (
    <svg className="kme-center-icon" viewBox="0 0 64 64" width="100%" height="100%">
      <rect x="4" y="52" width="56" height="4" rx="1" fill="#7F8C8D"/>
      <rect x="6" y="36" width="52" height="16" rx="1" fill="#BDC3C7"/>
      <rect x="6" y="36" width="52" height="3" fill="#F2A93B"/>
      <rect x="10" y="42" width="12" height="8" rx="0.5" fill="#95A5A6"/><circle cx="20" cy="46" r="1" fill="#7F8C8D"/>
      <rect x="26" y="42" width="12" height="8" rx="0.5" fill="#95A5A6"/><circle cx="28" cy="46" r="1" fill="#7F8C8D"/>
      <rect x="42" y="42" width="12" height="8" rx="0.5" fill="#95A5A6"/><circle cx="44" cy="46" r="1" fill="#7F8C8D"/>
      <rect x="12" y="35" width="16" height="2" fill="#2C3E50"/>
      <circle cx="16" cy="35" r="2" fill="#E74C3C"/><circle cx="24" cy="35" r="1.5" fill="#E74C3C"/>
      <path d="M14 8 L34 8 L32 20 L16 20 Z" fill="#34495E"/>
      <rect x="10" y="20" width="28" height="4" rx="0.5" fill="#2C3E50"/>
      <line x1="44" y1="14" x2="54" y2="14" stroke="#7F8C8D" strokeWidth="1"/>
      <path d="M46 14 L46 22 M46 22 L45 24 L47 24 Z" stroke="#C77F1A" strokeWidth="1" fill="none"/>
      <path d="M50 14 L50 20 A2 2 0 0 0 54 20" stroke="#2980B9" strokeWidth="1" fill="none"/>
    </svg>
  );
  const title = admin
    ? `Click: ${collapsed ? 'expand' : 'collapse'} · Double-click: open project PDF · Drop PDF here to upload as ${displayCode}.pdf`
    : `Click: ${collapsed ? 'expand' : 'collapse'} · Double-click: open project PDF (${displayCode})`;
  return (
    <div
      className={cls.join(' ')}
      style={big ? { width: sizePx + 'px', height: sizePx + 'px' } : undefined}
      title={title}
      onDragOver={big ? undefined : onDragOver}
      onDragLeave={big ? undefined : onDragLeave}
      onDrop={big ? undefined : onDrop}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      {big ? (
        <div className="kme-center-hub" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
          {logoSvg}
          <div className="kme-center-code">{displayCode}</div>
        </div>
      ) : (
        <>
          {logoSvg}
          <div className="kme-center-code">{displayCode}</div>
        </>
      )}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

// ── BOM / Custom node ───────────────────────────────────────────────
function MindmapNode({ id, data, selected }) {
  const { label, fusion_link, kind, qty, admin, color, tint, projectKey, missing, family,
          isLeaf, isWrapper, status, urn, drawing_urn, layer,
          isCollapsedParent, hasChildren,
          isVariantRoot, inChecklistMode, faded, ensureCollapsed, releaseNode, revealAll, nopdfDim } = data;
  const isBom = kind === 'bom';
  const linked = !!fusion_link;
  const code = isBom ? (data.code || label) : null;   // immutable code (label is now the display)
  const labelRef = useRef(null);
  // Guards against a single tap firing an action twice (e.g. onClick AND a
  // synthesized touch event both landing) — for the 🧩 toggle that would
  // toggle on→off and look like "nothing happened". (2026-05-29)
  const lastFireRef = useRef(0);
  // Defers admin's single-click → openInLibrary on the label so a double-
  // click (→ enter edit mode) can cancel us before navigation fires.
  // Cleared by the outer onDoubleClick handler. (2026-05-29)
  const navTimeoutRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Bump on workshop-op state changes so re-renders read fresh.
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick(t => t + 1), []);
  // Inline comment thread on the node (เอ๋ 2026-05-30 'กลุ่มคอมเมนต์ที assembly
  // ต้องกดดูได้'). Reuses the per-code comment system + the checklist thread's
  // .kme-cmt-* markup. Local open/draft state per node card.
  const [cmtOpen, setCmtOpen] = useState(false);
  const [cmtDraft, setCmtDraft] = useState('');
  const isAdminUser = !!(window.isAdmin && window.isAdmin());

  const api = window.kdAPI || {};
  const bent = code ? api.isBent?.(projectKey, code) : false;
  const assembled = code ? api.isAssembled?.(projectKey, code) : false;
  const timerRunning = code ? api.isTimerRunning?.(projectKey, code) : false;
  const timerSec = code ? api.getTimerTotalSeconds?.(projectKey, code) : 0;
  const comments = code ? (api.getComments?.(code) || []) : [];

  // Live tick for running timers so elapsed text updates without parent re-render
  useEffect(() => {
    if (!timerRunning) return;
    const t = setInterval(bump, 1000);
    return () => clearInterval(t);
  }, [timerRunning, bump]);

  const startEdit = useCallback((e) => {
    if (!admin) return;
    e.stopPropagation();
    setEditing(true);
    setTimeout(() => {
      const el = labelRef.current;
      if (el) {
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }, 0);
  }, [admin]);

  const commit = useCallback(() => {
    setEditing(false);
    const next = labelRef.current?.textContent?.trim() || 'untitled';
    if (next !== label) data.onLabelChange?.(id, next);
  }, [id, label, data]);

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      labelRef.current?.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      labelRef.current.textContent = label;
      labelRef.current.blur();
    }
  }, [label]);

  const openLink = useCallback((e) => {
    e.stopPropagation();
    if (!fusion_link) return;
    openInFusion(fusion_link.urn, fusion_link.open_url || null);
  }, [fusion_link]);

  const onBent = useCallback((e) => {
    e.stopPropagation();
    window.__kmeStatus?.(`tap bent: ${code}`);
    if (!code || !projectKey) return;
    api.markBent?.(projectKey, code, !bent);
    bump();
  }, [code, projectKey, bent, api, bump]);

  const onAssembled = useCallback((e) => {
    e.stopPropagation();
    const now = Date.now();
    if (now - lastFireRef.current < 400) { window.__kmeStatus?.(`asm dup-skip: ${code}`); return; }
    lastFireRef.current = now;
    window.__kmeStatus?.(`tap asm: ${code}`);
    if (!code || !projectKey) return;
    api.markAssembled?.(projectKey, code, !assembled);
    // 🧩 toggles the node's visibility through the SAME hiddenAnchors path
    // as the tap-3 home gesture (user 2026-05-29: 'click 3 หรือ Tab 3
    // ทำงานเหมือนกัน'):
    //   • marking complete → ensureCollapsed → hide node + its edge (and
    //     tuck its subtree). Tapping the parent / project-center brings it
    //     back, exactly like a tap-3-hidden node.
    //   • un-marking → releaseNode → bring the node + edge back so the
    //     toggle reverses cleanly.
    if (id) {
      if (!assembled) { ensureCollapsed?.(id); }
      else { releaseNode?.(id); }
    }
    bump();
  }, [code, projectKey, assembled, api, bump, ensureCollapsed, releaseNode, id]);

  const onTimer = useCallback((e) => {
    e.stopPropagation();
    window.__kmeStatus?.(`tap timer: ${code}`);
    if (!code || !projectKey) return;
    if (timerRunning) api.stopTimer?.(projectKey, code);
    else api.startTimer?.(projectKey, code);
    bump();
  }, [code, projectKey, timerRunning, api, bump]);

  const onResetTimer = useCallback((e) => {
    e.stopPropagation();
    if (!code || !projectKey || !admin) return;
    const cur = api.getTimerTotalSeconds?.(projectKey, code) || 0;
    const fmt = api.formatDuration?.(cur) || '0s';
    const input = window.prompt(
      `Edit / reset timer for ${code}\n\nCurrent: ${fmt}\n\nEnter new total in seconds (0 = reset):`,
      String(cur));
    if (input === null) return;
    const n = Math.max(0, parseInt(input, 10) || 0);
    api.resetTimer?.(projectKey, code, n);
    bump();
  }, [code, projectKey, admin, api, bump]);

  const onOpenPdf = useCallback((e) => {
    e.stopPropagation();
    const now = Date.now();
    if (now - lastFireRef.current < 400) return;
    lastFireRef.current = now;
    window.__kmeStatus?.(`tap pdf: ${code}`);
    if (!code) return;
    const url = api.pdfUrlForCode?.(code);
    if (!url) return;
    // On touch, open the PDF in the SAME window. A new-tab / window.open
    // fired from a touch pointerdown is popup-blocked on iOS — that's why
    // 📄 "did nothing" on the phone (the toggle button worked because it
    // opens no window). Same-window navigation isn't blocked; Back returns
    // to the mindmap. Desktop keeps the new-tab behavior.
    const isTouch = (typeof window !== 'undefined') &&
      (('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0);
    if (isTouch) { try { window.location.href = url; return; } catch {} }
    (api.openInNewTab || ((u) => window.open(u, '_blank', 'noopener')))(url);
  }, [code, api]);

  // Leaf-click routing has moved to Editor.onNodeClick — React Flow's
  // node-click callback fires reliably from RF's own pointer-event handler,
  // whereas an inner-div onClick on iPad PWA gets swallowed when
  // `nodesDraggable=false` (RF treats the touch as a pane interaction).
  // Inner div now only handles drag-drop PDF upload + label edit (dblclick).

  // Drag-drop PDF upload — admin only, BOM nodes only (and pragmatically
  // only useful on missing ones, though we accept replacement uploads too).
  const onDragOver = useCallback((e) => {
    if (!admin || !isBom) return;
    const items = e.dataTransfer?.items;
    if (!items || ![...items].some(it => it.kind === 'file')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }, [admin, isBom]);

  const onDragLeave = useCallback((e) => {
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const onDrop = useCallback(async (e) => {
    if (!admin || !isBom || !code) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!api.uploadPdfFromDrop) {
      window.alert('Upload API not available — refresh the page.');
      return;
    }
    setUploading(true);
    try {
      const ok = await api.uploadPdfFromDrop(file, code, family || '');
      if (ok) api.rerender?.();
    } finally {
      setUploading(false);
    }
  }, [admin, isBom, code, family, api]);

  // Checklist-mode fade: applied when
  //   (a) editor flagged this node hidden because its variant is
  //       collapsed (kids of a collapsed parent),
  //   (b) the part has been marked assembled, or
  //   (c) the tap-3 'home' gesture hid this anchor (variant root
  //       itself — user 2026-05-28 'กดครั้งที่ 3 SH0S10 จะหายไป').
  // The first two never apply to variant roots themselves; the third
  // explicitly does. data.faded is the editor's umbrella flag that
  // covers (a) and (c); local `assembled` handles (b) for kids.
  // Fade source = the editor's umbrella `faded` flag only (collapse +
  // tap-3/🧩 hiddenAnchors). The standalone `assembled` fade was removed
  // 2026-05-29: marking 🧩 hides the node via the SAME hiddenAnchors path
  // as tap-3 (see onAssembled → ensureCollapsed), so clicking the parent
  // (which clears hiddenAnchors) brings it back identically. An
  // independent assembled fade kept the node invisible after the parent
  // tap, so 🧩 and tap-3 behaved differently. revealAll (Show all) still
  // overrides everything.
  const isFadedNode = !revealAll && isBom && faded;

  const cls = ['kme-node'];
  if (selected) cls.push('kme-selected');
  if (linked) cls.push('kme-linked');
  if (isBom) cls.push('kme-bom');
  if (isLeaf && isBom) cls.push('kme-leaf');
  if (isWrapper) cls.push('kme-wrapper');
  if (missing && isBom) cls.push('kme-missing');
  if (dragOver) cls.push('kme-drag-over');
  if (uploading) cls.push('kme-uploading');
  if (!admin) cls.push('kme-view-only');
  if (hasChildren && isBom) cls.push('kme-parent');
  if (isCollapsedParent) cls.push('kme-parent-collapsed');
  if (isVariantRoot) cls.push('kme-variant-root');
  if (isFadedNode) cls.push('kme-faded');
  // No-PDF filter dim — a dedicated class (NOT kme-faded) with !important so it
  // beats the wrapper/layer opacity rules that kme-faded loses to on container
  // nodes. Missing parts never get this, so they stay fully visible.
  if (nopdfDim) cls.push('kme-nopdf-dim');
  // Assembled/complete BOM parts get a clear "done" marker on the canvas
  // (green ✓ badge + struck label, styled in editor/style.css → works in every
  // theme). Without this, a checklist-ticked node stays visible but looks
  // identical to a todo node. (เอ๋ 2026-05-31 'ดูไม่ออกว่า assembly Mark complete')
  if (assembled && isBom) cls.push('kme-done');
  // Depth class for graduated shadows (เอ๋ 2026-05-31 'แรเงาที่ Node Level แรก
  // เงาเยอะ Level 2 เงาน้อย และค่อยๆจางไป'). `layer` = hops from the project
  // center (app.js sets node.data.layer). Capped at 5+ → one bucket so the
  // shadow keeps fading but the class count stays bounded. Themed in style.css.
  if (isBom && layer >= 1) cls.push('kme-layer-' + Math.min(layer, 5));

  // Layer coloring (2026-05-30): every BOM node — including wrapper / variant-
  // root containers — shows its depth-layer color. (The qty badge + family
  // stripe removed on 2026-05-28 are separate elements and stay removed.)
  // Colour the node by FAMILY so it matches the §1 Assembly Tree column of the
  // same family (เอ๋ 2026-05-31 'Column Link สีกับ Mindmap … BK เขียวทั้งสองที่').
  // Emits CSS vars the sketch/chalk post-it rules read (var(--fam-soft)) so the
  // match holds in every theme; default theme uses the saturated border + dark
  // gradient tint inline.
  const _fc = isBom && code ? _famColor(_famOf(code)) : null;
  const style = _fc ? {
    '--fam-border': _fc.border,
    '--fam-soft': _fc.soft,
    '--fam-dark': _fc.dark,
    borderColor: _fc.border,
    background: `linear-gradient(180deg, #161b22 60%, ${_fc.dark} 100%)`,
  } : (isBom && color ? {
    borderColor: color,
    background: `linear-gradient(180deg, #161b22 60%, ${tint || '#161b22'} 100%)`,
  } : undefined);

  return (
    <div
      className={cls.join(' ')}
      style={style}
      onDoubleClick={(e) => {
        // Cancel any queued single-click Library navigation on the label
        // (first click of this double-click) — admin wants to edit, not
        // navigate. Then enter edit mode as before.
        if (navTimeoutRef.current) {
          clearTimeout(navTimeoutRef.current);
          navTimeoutRef.current = null;
        }
        startEdit(e);
      }}
      data-code={code || ''}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <Handle type="target" position={Position.Left} />
      <div className="kme-row kme-row-head">
        <div
          ref={labelRef}
          className="kme-node-label"
          contentEditable={editing && admin}
          suppressContentEditableWarning
          onBlur={commit}
          onKeyDown={onKeyDown}
          onClick={(e) => {
            // Click on the code text behaves exactly like a click on the
            // empty card body — it bubbles to React Flow's onNodeClick
            // (expand/collapse). (เอ๋ 2026-05-31 'กดที่ตัวอักษรให้มีค่า
            // เหมือนกดบนพื้นที่ว่าง'.) Only swallow the click while editing,
            // so caret placement in the contentEditable label isn't hijacked
            // by a collapse toggle. Double-click → edit is the outer handler.
            if (editing) { e.stopPropagation(); }
          }}
          onPointerDown={(e) => {
            // Same on touch: let the tap reach onNodeClick (= tap empty space)
            // unless we're editing. Double-tap enters edit mode (outer).
            if (editing) { e.stopPropagation(); }
          }}
        >
          {label}
        </div>
        {/* Visible rename affordance (RD 02 2026-06-09) — double-tap isn't obvious on
            iPad, so admin gets a ✏️ that opens the same inline edit. Persists via
            display_overrides (shows in Library too). */}
        {admin && isBom && !editing && (
          <button
            className="kme-node-edit nodrag nopan"
            title="Rename — edits the display name everywhere (mindmap + Library)"
            onClick={(e) => { e.stopPropagation(); startEdit(e); }}
            onPointerDown={(e) => e.stopPropagation()}
          >✏️</button>
        )}
        {isBom && qty != null && !isVariantRoot && !isWrapper && (
          <span className="kme-node-qty">x<span className="kme-node-qty-num">{qty}</span></span>
        )}
        {missing && isBom && !(api.pdfUrlForCode && api.pdfUrlForCode(code)) && (
          <span
            className="kme-missing-badge nodrag nopan"
            title="No PDF yet — tap to open the 3D master in Fusion"
            onClick={(e) => {
              e.stopPropagation();
              // Route to Fusion 3D via the localhost bridge (same path
              // the leaf-body click uses). Per user 2026-05-28: the
              // 'no PDF, open the model instead' affordance was missing
              // — the chip becomes that affordance now. iPad shows a
              // clear error from _routeLeafToFusion explaining the
              // bridge isn't reachable from there.
              if (api.routeLeaf) {
                api.routeLeaf({ code, status, urn, drawing_urn, fusion_link });
              }
            }}
            onPointerDown={(e) => {
              if (e.pointerType === 'touch') {
                e.preventDefault();
                e.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
                if (api.routeLeaf) {
                  api.routeLeaf({ code, status, urn, drawing_urn, fusion_link });
                }
              }
            }}
          >
            ⚠ NO PDF 🔗
          </span>
        )}
        {/* Admin "Edit Link" (เอ๋ 2026-06-09): a NO-PDF node can borrow another
            code's drawing PDF (e.g. SD0CN0-080083 → SD0CN0-080000). Touch/iPad-
            friendly button → prompt for the target code → api.setDrawingLink
            persists it (RTDB) → pdfUrlForCode resolves → the NO-PDF badge above
            auto-hides + the linked drawing opens. */}
        {missing && isBom && admin && !(api.pdfUrlForCode && api.pdfUrlForCode(code)) && (
          <button
            className="kme-link-edit nodrag nopan"
            title="Edit Link — point this NO-PDF part at another part's drawing PDF"
            onClick={async (e) => {
              e.stopPropagation();
              const cur = api.getDrawingLink ? api.getDrawingLink(code) : '';
              // suggest a REAL same-family code whose drawing file actually exists (HEAD-verified)
              const suggestion = api.suggestDrawingTarget ? await api.suggestDrawingTarget(code) : '';
              const target = window.prompt(
                'Link "' + code + '" to which part\'s drawing PDF?\n' +
                'That part MUST already have a drawing.' +
                (suggestion ? '\n(e.g. ' + suggestion + ')' : '') +
                '\nLeave blank to clear the link.',
                cur || suggestion || ''
              );
              if (target === null) return;   // cancelled
              const t = (target || '').trim().toUpperCase();
              if (t) {
                // Validate the target's drawing FILE actually exists (a manifest key can
                // resolve a URL that 404s) — else the node would silently stay NO-PDF
                // (เอ๋ 2026-06-09). Tell the admin clearly + don't set the link.
                const url = api.pdfUrlForCode && api.pdfUrlForCode(t);
                let exists = false;
                if (url) exists = api.pdfFileExists ? await api.pdfFileExists(url) : true;
                if (!exists) {
                  window.alert('"' + t + '" has no drawing PDF (the file is missing) — pick a part whose drawing actually opens.' +
                    (suggestion ? '\nTry: ' + suggestion : '') + '\n(Link not changed.)');
                  return;
                }
              }
              if (api.setDrawingLink) api.setDrawingLink(code, t);
              bump();
              const url2 = api.pdfUrlForCode && api.pdfUrlForCode(code);
              if (url2 && api.openInNewTab) api.openInNewTab(url2);
            }}
          >🔗 Link</button>
        )}
        {uploading && (
          <span className="kme-missing-badge nodrag nopan" style={{ background: '#1f6feb', color: '#fff' }}>uploading…</span>
        )}
        {comments.length > 0 && (
          <button
            className={'kme-comment-count nodrag nopan' + (cmtOpen ? ' is-open' : '')}
            title={`${comments.length} comment(s) — tap to view`}
            onClick={(e) => { e.stopPropagation(); setCmtOpen(o => !o); }}
            onPointerDown={(e) => { if (e.pointerType === 'touch') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setCmtOpen(o => !o); } }}
          >💬{comments.length}</button>
        )}
      </div>
      {cmtOpen && code && (
        <div className="kme-cmt-thread nodrag nopan" onPointerDown={(e) => e.stopPropagation()}>
          <div className="kme-cmt-head">
            <span>{comments.length} comment{comments.length === 1 ? '' : 's'}</span>
            <button className="kme-cmt-close" title="Close (Esc)" onClick={(e) => { e.stopPropagation(); setCmtOpen(false); setCmtDraft(''); }}>✕ close</button>
          </div>
          {comments.map((c, i) => (
            <div key={c._key || i} className="kme-cmt">
              <span className="kme-cmt-text">{c.text}</span>
              {isAdminUser && (
                <button
                  className="kme-cmt-del"
                  title="Delete comment"
                  onClick={(e) => { e.stopPropagation(); api.deleteComment?.(code, c._key != null ? c._key : c.time); bump(); }}
                >🗑</button>
              )}
            </div>
          ))}
          <div className="kme-cmt-add">
            <input
              className="kme-cmt-input"
              value={cmtDraft}
              autoFocus
              onChange={e => setCmtDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={e => {
                e.stopPropagation();
                if (e.key === 'Enter') { const t = cmtDraft.trim(); if (t) { api.addComment?.(code, t); setCmtDraft(''); bump(); } }
                else if (e.key === 'Escape') { setCmtOpen(false); setCmtDraft(''); }
              }}
              placeholder="Add a comment…"
            />
            <button
              className="kme-cmt-send"
              onClick={(e) => { e.stopPropagation(); const t = cmtDraft.trim(); if (t) { api.addComment?.(code, t); setCmtDraft(''); bump(); } }}
            >Add</button>
          </div>
        </div>
      )}
      {isBom && (
        // `nodrag` removed from the row container so the empty space
        // around the buttons stays draggable — user 2026-05-28:
        // 'ให้สามารถจับบนพื้นที่ว่าง แล้วย้าย ได้'. The buttons
        // themselves still stop propagation in their onPointerDown
        // handlers so tapping 🧩/📄 doesn't accidentally start a
        // drag, and `nopan` stays so finger-pans across the buttons
        // don't pan the canvas.
        <div className="kme-row kme-row-actions nopan">
          {/* Timer ▶ and bent ⬇ buttons removed from the assembly
              mindmap (user 2026-05-28: 'ที assembly ไม่ควรมีปุ่ม งานพับ
              และจับเวลา'). The Bending role has its own dedicated
              bend-list surface; timer was a never-used artifact. The
              remaining buttons are 🧩 assembled + 📄 PDF — the two
              the cabinet team actually needs. Whole-card tap still
              toggles expand/collapse via React Flow's onNodeClick. */}
          {/* `nodrag` is REQUIRED: without it React Flow treats a touch on
              the button as the start of a node drag and swallows the tap on
              iPad/iPhone (worked on desktop because a mouse click with no
              movement still fires). `nopan` stops a finger-press from panning
              the canvas. User 2026-05-29: 'ที่มือถือใช้การไม่ได้'. */}
          <button
            className={`kme-mini kme-assembled nodrag nopan ${assembled ? 'kme-on' : ''}`}
            onClick={onAssembled}
            onPointerDown={(e) => { if (e.pointerType === 'touch') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); onAssembled(e); } }}
            title={assembled ? 'Mark as not assembled' : 'Mark assembled'}
          >
            🧩
          </button>
          {code && api.pdfUrlForCode?.(code) && (
            <button
              className="kme-mini kme-pdf nodrag nopan"
              onClick={onOpenPdf}
              onPointerDown={(e) => { if (e.pointerType === 'touch') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); onOpenPdf(e); } }}
              title="Open PDF"
            >📄</button>
          )}
        </div>
      )}
      {linked && (
        <div
          className="kme-link-badge nodrag nopan"
          title={`Open ${fusion_link.master_code || 'file'} in Fusion`}
          onClick={openLink}
          onPointerDown={(e) => { if (e.pointerType === 'touch') { e.stopPropagation(); openLink(e); } }}
        >
          ⧉ {fusion_link.master_code || 'linked'}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { mindmap: MindmapNode, project: ProjectCenterNode };

// ── Floating edge ───────────────────────────────────────────────────
// Default bezier edges always exit the right Handle of the source and
// enter the left Handle of the target — fine when nodes line up, ugly
// when they don't (curves loop around the outside of the layout).
// FloatingEdge computes the closest point on each node's bounding box
// in the direction of the other node, giving short straight lines that
// look like spokes radiating out from the project center.

function _nodeCenter(node) {
  const w = node.measured?.width || node.width || 140;
  const h = node.measured?.height || node.height || 60;
  return {
    x: node.internals.positionAbsolute.x + w / 2,
    y: node.internals.positionAbsolute.y + h / 2,
  };
}

function _edgeEnds(source, target) {
  // Both ends terminate at the node's geometric center — single
  // anchor point per node. The line passes through whatever chrome
  // sits between the two centers; nodes' z-index puts them over the
  // edge so the line appears to start/end at the node's centroid.
  const s = _nodeCenter(source);
  const t = _nodeCenter(target);
  return { sx: s.x, sy: s.y, tx: t.x, ty: t.y };
}

function FloatingEdge({ id, source, target, markerEnd, style }) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode) return null;
  const { sx, sy, tx, ty } = _edgeEnds(sourceNode, targetNode);
  const [edgePath] = getStraightPath({
    sourceX: sx, sourceY: sy, targetX: tx, targetY: ty,
  });
  return <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />;
}

const edgeTypes = { floating: FloatingEdge };

// ── Assembly checklist panel ────────────────────────────────────────
// Assembly checklist — a flat, tick-as-you-build list mounted bottom-left on
// the canvas. Ticks write the SAME assembled_status the 🧩 node toggle uses;
// comments reuse the per-code comments system. Re-reads whenever `nonce`
// (the editor's extSyncNonce) bumps — which app.js does on every assembled or
// comment Firebase write — so ticks/comments from the mindmap or another
// device show here with no remount. (2026-05-30)
function ChecklistPanel({ projectKey, nonce, asSection }) {
  const api = window.kdAPI || {};
  const [open, setOpen] = useState(false);
  const [openCode, setOpenCode] = useState(null);   // row whose comments are expanded
  const [draft, setDraft] = useState('');

  // Stable aggregated parts list (changes only when the project changes).
  const parts = useMemo(
    () => (api.assemblyParts ? api.assemblyParts(projectKey) : []),
    [projectKey]
  );

  // Touch `nonce` so React re-runs reads of isAssembled/getComments below
  // after a Firebase tick/comment lands. No local mirror needed.
  void nonce;

  // asSection (§2 accordion section, เอ๋ 2026-05-31): always-open, no
  // collapsed launcher button + no panel chrome — the section header owns
  // the title. The floating-panel mode keeps the launcher button.
  if (!asSection && !open) {
    return (
      <button className="kme-checklist-btn" onClick={() => setOpen(true)} title="Assembly checklist">
        <svg className="kme-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 3.5h7.5M6 8h7.5M6 12.5h7.5"/>
          <path d="M2 3.3l1 1 1.6-1.8M2 7.8l1 1 1.6-1.8M2 12.3l1 1 1.6-1.8"/>
        </svg>
        <span>Checklist</span>
      </button>
    );
  }

  const total = parts.length;
  const done = parts.filter(p => api.isAssembled?.(projectKey, p.code)).length;

  const toggle = (code) => {
    const next = !api.isAssembled?.(projectKey, code);
    api.markAssembled?.(projectKey, code, next);
  };
  // Check-all / uncheck-all toggle (เอ๋ 2026-05-31). If every part is already
  // done → uncheck all; otherwise → check all. Writes the SAME assembled_status
  // each row uses, so the tree + mindmap sync.
  const allDone = total > 0 && done === total;
  const toggleAll = () => {
    const target = !allDone;
    for (const p of parts) {
      if (!!api.isAssembled?.(projectKey, p.code) !== target) {
        api.markAssembled?.(projectKey, p.code, target);
      }
    }
  };
  const submitComment = (code) => {
    const t = draft.trim();
    if (!t) return;
    api.addComment?.(code, t);
    setDraft('');
  };

  return (
    <div className={'kme-checklist-panel' + (asSection ? ' kme-checklist-section' : '')}>
      <div className="kme-checklist-head">
        <span className="kme-checklist-title">Checklist</span>
        <span className="kme-checklist-progress">{done}/{total}</span>
        <button
          className="kme-checklist-allbtn"
          onClick={toggleAll}
          disabled={total === 0}
          title={allDone ? 'Uncheck all' : 'Check all'}
        >{allDone ? '☐ Uncheck all' : '☑ Check all'}</button>
        {!asSection && <button className="kme-checklist-close" onClick={() => setOpen(false)} title="Close">✕</button>}
      </div>
      <div className="kme-checklist-list">
        {parts.map(p => {
          const checked = !!api.isAssembled?.(projectKey, p.code);
          const comments = api.getComments?.(p.code) || [];
          const expanded = openCode === p.code;
          return (
            <div key={p.code} className={'kme-checklist-row' + (checked ? ' is-done' : '')}>
              <label className="kme-checklist-main">
                <input type="checkbox" checked={checked} onChange={() => toggle(p.code)} />
                <span className="kme-checklist-code">{p.code}</span>
                <span className="kme-checklist-qty">×{p.qty}</span>
              </label>
              {api.pdfUrlForCode && api.pdfUrlForCode(p.code) && (
                <button
                  className="kme-checklist-pdf"
                  onClick={() => _openPdfForCode(p.code)}
                  title="Open PDF"
                >📄</button>
              )}
              <button
                className={'kme-checklist-cmt-toggle' + (comments.length ? ' has-cmt' : '') + (expanded ? ' is-open' : '')}
                onClick={() => { setOpenCode(expanded ? null : p.code); setDraft(''); }}
                title={comments.length ? comments.length + ' comment(s)' : 'Add comment'}
              >💬{comments.length ? ' ' + comments.length : ''}</button>
              {expanded && (
                <div className="kme-checklist-thread">
                  <div className="kme-cmt-head">
                    <span>{comments.length} comment{comments.length === 1 ? '' : 's'}</span>
                    <button className="kme-cmt-close" title="Close (Esc)" onClick={() => { setOpenCode(null); setDraft(''); }}>✕ close</button>
                  </div>
                  {comments.map((c, i) => (
                    <div key={c._key || i} className="kme-cmt">
                      <span className="kme-cmt-text">{c.text}</span>
                      <button
                        className="kme-cmt-del"
                        title="Delete comment"
                        onClick={() => { api.deleteComment?.(p.code, c._key != null ? c._key : c.time); }}
                      >🗑</button>
                    </div>
                  ))}
                  <div className="kme-cmt-add">
                    <input
                      className="kme-cmt-input"
                      value={draft}
                      autoFocus
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') submitComment(p.code); else if (e.key === 'Escape') { setOpenCode(null); setDraft(''); } }}
                      placeholder="เพิ่ม comment…"
                    />
                    <button className="kme-cmt-send" onClick={() => submitComment(p.code)}>Add</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Shared PDF opener ───────────────────────────────────────────────
// Same touch/desktop behaviour as the node's onOpenPdf: same-tab nav on
// touch (iPad popup-blocks window.open from synthesized handlers), new tab
// on desktop. Reused by the Assembly Tree + Checklist section rows.
function _openPdfForCode(code) {
  const api = window.kdAPI || {};
  if (!code) return;
  const url = api.pdfUrlForCode ? api.pdfUrlForCode(code) : null;
  if (!url) return;
  const isTouch = (typeof window !== 'undefined') && window.matchMedia
    && window.matchMedia('(pointer: coarse)').matches;
  if (isTouch) { window.location.href = url; return; }
  (api.openInNewTab || ((u) => window.open(u, '_blank', 'noopener')))(url);
}

// ── Family colour (shared by §1 Tree columns + §3 Mindmap nodes) ──────
// เอ๋ 2026-05-31: group the Assembly Tree into columns by family (BK/SD/TS…)
// and make the Mindmap node colour MATCH its family column ('Column 1 BK =
// green → BK post-it in the Mindmap also green'). family = the leading
// letters of the code before the first digit (BKIDN1→BK, SD00NA→SD,
// TS002H→TS, FN0F00→FN, BM1N00→BM, BXXTR0→BX, SH0S10→SH …). One palette,
// keyed by the family string so the same family always lands on the same
// hue regardless of how many families a project has.
function _famOf(code) {
  if (!code) return '?';
  const m = String(code).match(/^[A-Za-z]+/);
  return m ? m[0].toUpperCase() : '?';
}
// HYBRID family colour (เอ๋ 2026-06-09, board: chose option 1 over flatten/distinct):
// anchor the well-known families to the "Brushed Steel + Amber" palette tokens
// (G3 spec) so the mindmap reads cohesive with the new icons, while EVERY OTHER
// family still hashes into a (muted) ring so families stay distinct — keeping the
// §1<->§3 family-colour link เอ๋ likes. NOT a flat 5-colour map.
//   FL (floor)  -> steel-400  · DW (door/drawer) -> blue-500
//   BK (back)   -> amber-500  · SD (side panel)  -> steel-700
//   TS (top sup)-> steel-700 (teal lean, distinct from SD)
// Each token = base hue + saturation; `bL` is the border lightness so steel-400
// (light) and steel-700 (dark) read apart while sharing the steel hue. soft/dark/
// head reuse the same lightness ROLES (post-it / gradient / header) per theme.
const _FAM_TOKENS = {
  // G3 "vibrant" SPEC (RD verify 2026-06-09): steels bumped sat+lightness for punchier
  // family colours; blue + amber kept (already saturated).
  steelLight:   { h: 212, s: 34, bL: 63 }, // FL  ~ steel-400 (vibrant)
  blue:         { h: 216, s: 84, bL: 58 }, // DW  ~ blue-500  #2F81F7 (keep)
  amber:        { h: 37,  s: 84, bL: 56 }, // BK  ~ amber-500 #F2A93B (keep)
  steelDark:    { h: 210, s: 30, bL: 50 }, // SD  ~ steel-700 (vibrant)
  steelTeal:    { h: 198, s: 36, bL: 53 }, // TS  ~ steel-700 teal (vibrant)
  steelNeutral: { h: 214, s: 22, bL: 55 }, // ?   digit-led cabinet wrappers (vibrant neutral)
};
// Explicit PREFIX(2) -> token for ambiguous leading letters (BM/SH are NOT back/side,
// so B-/S-led can't be a blanket rule). NOTE: match on the first TWO letters, because
// _famOf returns the WHOLE leading letter-run (SDLCN0->"SDLCN", BKDNC1->"BKDNC",
// BXXTR0->"BXXTR") — an exact-string map would miss every code whose 2-letter family
// is followed by more letters. D-led (doors DSV/DST/DWV/DWT/DAG + drawers DVS/DVSX/
// DSB…) and F-led (floor FN/FC/FL/FB…) use first-letter rules so length never matters.
const _FAM_TOKEN_MAP = {
  BK: 'amber', BX: 'amber',           // back / back-triangle
  SD: 'steelDark',                    // side panel
  TS: 'steelTeal',                    // top support
};
function _famTokenOf(fam) {
  if (!fam || fam === '?') return 'steelNeutral'; // digit-led wrapper codes
  const p2 = fam.slice(0, 2);
  if (_FAM_TOKEN_MAP[p2]) return _FAM_TOKEN_MAP[p2];
  const c0 = fam[0];
  if (c0 === 'D') return 'blue';        // doors + drawers
  if (c0 === 'F') return 'steelLight';  // floors (FN/FC/FL/FB)
  return null;                          // -> cohesive hash fallback (BM/SH/CL…)
}
// Muted ring (was 62% sat) for unmapped families: distinct hues, but desaturated
// so they tonally agree with the steel/amber/blue palette instead of going neon.
const _FAM_HUES = [145, 205, 38, 275, 330, 12, 175, 95, 250, 300];
function _famHue(fam) {
  let h = 0;
  for (let i = 0; i < fam.length; i++) h = (h * 31 + fam.charCodeAt(i)) >>> 0;
  return _FAM_HUES[h % _FAM_HUES.length];
}
// Returns colours for a family: a saturated border/ink + a soft post-it bg.
function _famColor(fam) {
  const tok = _famTokenOf(fam);
  if (tok) {
    const t = _FAM_TOKENS[tok];
    return {
      border: `hsl(${t.h}, ${t.s}%, ${t.bL}%)`,                              // node/capsule border
      soft:   `hsl(${t.h}, ${Math.min(t.s + 4, 82)}%, 86%)`,                 // sketch/chalk post-it fill
      dark:   `hsl(${t.h}, ${Math.max(Math.round(t.s * 0.55), 28)}%, 16%)`,  // default-theme gradient end
      head:   `hsl(${t.h}, ${Math.max(Math.round(t.s * 0.75), 24)}%, 30%)`,  // column header bg
    };
  }
  const hue = _famHue(fam);
  return {
    border: `hsl(${hue}, 70%, 60%)`,   // capsule/node border + edge (G3 vibrant)
    soft:   `hsl(${hue}, 66%, 85%)`,   // sketch/chalk post-it fill (light)
    dark:   `hsl(${hue}, 52%, 18%)`,   // default-theme gradient tint endpoint
    head:   `hsl(${hue}, 60%, 33%)`,   // column header bg
  };
}

// ── Assembly Tree (§1) — capsule list view of the SAME tree the Kanban
// (§3 mindmap) renders. Shares collapsedNodes / hiddenAnchors / assembled
// state, so expand/collapse + complete + Show-all sync both ways (เอ๋
// 2026-05-31 'Assembly Tree เป็น capsule … sync กับ Kanban … 1 และ 3 ย่อ
// ขยายเหมือนกัน'). Auto columns: each row = capsule indented by tree depth,
// with expand chevron (parents), label, qty, 💬 count, 📄 PDF, 🧩 complete.
function AssemblyTree({ nodes, edges, projectKey, admin, nonce,
                        collapsedNodes, hiddenAnchors, revealAll,
                        toggleNodeCollapse, ensureCollapsed, releaseNode }) {
  const api = window.kdAPI || {};
  void nonce;  // touch so reads of isAssembled re-run after a Firebase tick

  // §1 = 15 KANBAN BOARD-CARDS, one per top-level cabinet (เอ๋/G1 2026-06-09:
  // '1 cabinet = 1 board card' — reverses the single expandable tree 6d8497b).
  // Each card lists its FULL subtree, rendered by DEFAULT and INDEPENDENT of
  // collapsedNodes/revealAll, so §1 never shows the "Show all" 204-row wall the
  // §3 mindmap collapse state used to force on it.
  const cards = useMemo(() => {
    const childrenOf = new Map();
    for (const e of edges) {
      if (!e.source || !e.target) continue;
      if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
      childrenOf.get(e.source).push(e.target);
    }
    const byId = new Map(nodes.map(n => [n.id, n]));
    const isBom = (n) => n && n.data && n.data.kind === 'bom';
    // A node that is any BOM's child belongs UNDER that cabinet, never a card.
    const bomChild = new Set();
    for (const [src, kids] of childrenOf) {
      if (isBom(byId.get(src))) for (const k of kids) bomChild.add(k);
    }
    // Cards = BOM nodes with NO bom parent (the top-level cabinets — their parent
    // is the project center) + genuine orphans.
    const roots = nodes.filter(n => isBom(n) && !bomChild.has(n.id));
    const out = [];
    for (const r of roots) {
      const seen = new Set();
      const rowsOut = [];
      const walk = (id, depth) => {
        const n = byId.get(id);
        if (!n || !isBom(n) || seen.has(id)) return;
        seen.add(id);
        const kids = (childrenOf.get(id) || []).filter(k => isBom(byId.get(k)));
        rowsOut.push({ id, node: n, depth, hasKids: kids.length > 0 });
        for (const k of kids) walk(k, depth + 1);   // FULL subtree, always
      };
      walk(r.id, 0);
      // Card body = REAL PARTS (leaf nodes) ONLY — drop the sub-assembly /
      // wrapper CONTAINERS (FN0FL2…, is_wrapper) so the workshop sees just the
      // parts to make (เอ๋ 2026-06-09 trim decision). Badge = leaf count so it
      // matches the body. Sorted by code for a stable, scannable parts list.
      const leafRows = rowsOut
        .filter(rw => rw.depth > 0 && !rw.hasKids && !rw.node.data?.isWrapper)
        .sort((a, b) => (a.node.data?.label || '').localeCompare(b.node.data?.label || ''));
      out.push({ id: r.id, node: r, leafRows, leafCount: leafRows.length });
    }
    return out;
  }, [nodes, edges]);

  // A row is dimmed (assembled/complete) when its code is assembled — same
  // signal the Kanban node + checklist use.
  const isDone = (code) => !!(code && api.isAssembled && api.isAssembled(projectKey, code));

  // Per-card fold (LOCAL — independent of the §3 mindmap collapse state). Tap a
  // card header to fold/unfold just that board. Default = all unfolded (the card
  // lists its parts, which is the whole point of "1 cabinet = 1 board").
  const [foldedCards, setFoldedCards] = useState(() => new Set());
  const toggleCard = useCallback((id) => setFoldedCards(prev => {
    const s = new Set(prev); if (s.has(id)) s.delete(id); else s.add(id); return s;
  }), []);

  const markDone = (code, e) => {
    if (e) e.stopPropagation();
    api.markAssembled?.(projectKey, code, !isDone(code));
  };

  // A part row inside a card body — a REAL part (leaf). Containers are trimmed
  // out (เอ๋ 2026-06-09) so the body is a FLAT parts list: no chevron, no depth
  // indent — just code + qty + 💬 + 📄 + done.
  const renderRow = ({ id, node }) => {
    const code = node.data?.code || node.data?.label || '';   // immutable code for logic
    const display = node.data?.label || code;                 // display name (rename-aware)
    const qty = node.data?.qty;
    const done = isDone(code);
    const comments = api.getComments ? (api.getComments(code) || []) : [];
    const hasPdf = !!(api.pdfUrlForCode && api.pdfUrlForCode(code));
    const fc = _famColor(_famOf(code));
    return (
      <div
        key={id}
        className={'kme-tree-row' + (done ? ' is-done' : '')}
        style={{ paddingLeft: '8px', borderLeft: '3px solid ' + fc.border }}
      >
        <span className="kme-tree-label" title={code}>{display}</span>
        {qty != null && <span className="kme-tree-qty">×{qty}</span>}
        {comments.length > 0 && <span className="kme-tree-cmt" title={comments.length + ' comment(s)'}>💬{comments.length}</span>}
        {hasPdf && (
          <button className="kme-tree-pdf" onClick={() => _openPdfForCode(code)} title="Open PDF">📄</button>
        )}
        <button
          className={'kme-tree-done' + (done ? ' is-on' : '')}
          onClick={() => markDone(code)}
          title={done ? 'Mark not assembled' : 'Mark assembled'}
        >🧩</button>
      </div>
    );
  };

  if (!cards.length) {
    return <div className="kme-tree"><div className="kme-tree-empty">No assembly tree for this project.</div></div>;
  }

  const doneCount = cards.filter(c => isDone(c.node.data?.label || '')).length;
  return (
    <div className="kme-tree kme-tree-boards">
      <div className="kme-tree-hint">{cards.length} cabinet boards · {doneCount}/{cards.length} assembled · tap a header to fold</div>
      <div className="kme-tree-board">
        {cards.map(card => {
          const code = card.node.data?.code || card.node.data?.label || '';   // logic
          const display = card.node.data?.label || code;                      // display (rename-aware)
          const fc = _famColor(_famOf(code));
          const folded = foldedCards.has(card.id);
          const done = isDone(code);
          return (
            <div
              key={card.id}
              className={'kme-tree-col' + (done ? ' is-done' : '')}
              style={{ '--fam-border': fc.border, '--fam-soft': fc.soft }}
            >
              <div
                className="kme-tree-col-head"
                style={{ background: fc.head || fc.dark, cursor: 'pointer' }}
                onClick={() => toggleCard(card.id)}
                title="Tap to fold / unfold this board"
              >
                <span className="kme-tree-col-name" title={code}><span className="kme-tree-chev">{folded ? '▸' : '▾'}</span> {display}</span>
                <span className="kme-tree-col-count">{card.leafCount > 0 ? `🧩 ${card.leafCount}` : 'single'}</span>
                <button
                  className={'kme-tree-done' + (done ? ' is-on' : '')}
                  onClick={(e) => markDone(code, e)}
                  title={done ? 'Mark not assembled' : 'Mark assembled'}
                >🧩</button>
              </div>
              {!folded && (
                <div className="kme-tree-col-body">
                  {card.leafRows.map(renderRow)}
                  {card.leafCount === 0 && (
                    <div className="kme-tree-empty" style={{ padding: '6px 8px', fontSize: '11px' }}>single part — no sub-components</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main editor ─────────────────────────────────────────────────────
// Collapsed state per project — persisted in localStorage so reopening
// the project view remembers what was collapsed last time.
//
// LS shape: { projectKey: { center?: true, nodes?: ['bom:foo', 'bom:bar', ...] } }
// - center=true means the project center is collapsed (everything hidden).
// - nodes=[...] are individual parent nodes whose subtrees are hidden.
// v3 (เอ๋ 2026-06-08): bumped from v2 so the §1 Kanban→expandable-tree rework re-seeds
// COLLAPSED on every device (a device that already opened the project had seeded=true and
// would otherwise show the full 130-row wall instead of "tap an assembly to expand").
const LS_COLLAPSED = 'kme_collapsed_v3';

function _readCollapsedState(pk) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_COLLAPSED) || '{}');
    const entry = all[pk] || {};
    return {
      center: !!entry.center,
      nodes: new Set(Array.isArray(entry.nodes) ? entry.nodes : []),
      hidden: new Set(Array.isArray(entry.hidden) ? entry.hidden : []),
      // `seeded` records that the checklist auto-collapse has run once (or
      // that the user explicitly hit Show all). It distinguishes "fresh
      // project, never seeded" (→ collapse variants) from "user chose to
      // expand everything" (→ leave it expanded). Without it, a Firebase-
      // sync remount with an empty collapse set re-seeds and snaps the
      // variants shut, stranding grandchildren faded. (regression 2026-05-29)
      seeded: !!entry.seeded,
      // `revealAll` = Show all override that also un-hides assembled parts.
      revealAll: !!entry.revealAll,
    };
  } catch {
    return { center: false, nodes: new Set(), hidden: new Set(), seeded: false, revealAll: false };
  }
}
function _writeCollapsedState(pk, state) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_COLLAPSED) || '{}');
    const center = !!state.center;
    const nodes = [...(state.nodes || new Set())];
    const hidden = [...(state.hidden || new Set())];
    const seeded = !!state.seeded;
    const revealAll = !!state.revealAll;
    if (center || nodes.length || hidden.length || seeded || revealAll) {
      all[pk] = {
        ...(center ? { center: true } : {}),
        ...(nodes.length ? { nodes } : {}),
        ...(hidden.length ? { hidden } : {}),
        ...(seeded ? { seeded: true } : {}),
        ...(revealAll ? { revealAll: true } : {}),
      };
    } else {
      delete all[pk];
    }
    localStorage.setItem(LS_COLLAPSED, JSON.stringify(all));
  } catch {}
}

// Per-project viewport cache (module-level so it survives the editor's
// frequent remounts — the Firebase assembled/bent/comment listeners call
// app.js render() which rebuilds #kme-mount). Without this, every remount
// re-ran React Flow's fitView prop and the view jumped back to center every
// time a part was ticked. We fit only on the FIRST open of a project; after
// that the user's own pan/zoom (and the Zoom-fit button) own the viewport.
// User 2026-05-29: 'ไม่ต้องยุ่งเรื่อง pan zoom ... ให้ user จัดการเอง'.
const _vpCache = {};

// Seed (collapse-to-cabinets) guard — module-scoped so the auto-seed runs ONCE
// per PAGE LOAD per project, NOT per mount: a Firebase/timer remount must not
// re-seed (it would snap a deliberate in-session "Show all" shut), but a fresh
// reload re-enters and re-seeds the clean cabinet view (clearing a stuck
// revealAll wall). (เอ๋/G1 2026-06-09)
const _kmeSeededProjects = new Set();
function Editor({ projectKey, initialNodes, initialEdges, onChange, admin, deepLinkCode, autoFullscreen }) {
  const [nodes, setNodes] = useState(initialNodes || []);
  const [edges, setEdges] = useState(initialEdges || []);
  const [selectedId, setSelectedId] = useState(null);
  const [status, setStatus] = useState(admin ? 'ready (admin)' : 'view only');
  // iPad diagnostic: expose setStatus globally so mini-button handlers in
  // MindmapNode (outside this scope) can write to the toolbar status when
  // tapped. Lets workshop techs verify "yes, my tap fired" without dev tools.
  useEffect(() => { window.__kmeStatus = setStatus; return () => { delete window.__kmeStatus; }; }, []);

  // Two flavours of collapse state, persisted in the same LS entry:
  //   collapsed       — the project center toggle (everything-but-center hidden)
  //   collapsedNodes  — Set of BOM parent node ids; each one hides its subtree
  const [collapsed, setCollapsedState] = useState(
    () => _readCollapsedState(projectKey).center);
  const [collapsedNodes, setCollapsedNodes] = useState(
    () => _readCollapsedState(projectKey).nodes);

  // "Reveal all" — Show all also un-hides ASSEMBLED parts (which normally
  // fade to opacity 0 in checklist mode to show progress). Without this,
  // Show all clears collapse/hide but assembled parts stay invisible, so
  // the user sees empty gaps where done parts used to be and reports them
  // as missing (user 2026-05-29: 'Show all คือ โชว์ทั้งหมด'). Persisted so
  // a Firebase-sync remount doesn't re-fade them. Any collapse/hide gesture
  // (or marking a part assembled) turns it back off so normal checklist
  // hiding resumes. (regression 2026-05-29)
  const [revealAll, setRevealAllState] = useState(
    () => _readCollapsedState(projectKey).revealAll);

  // Fullscreen canvas. The Assembly view opens straight into it
  // (autoFullscreen=true, set by role in app.js — user 2026-05-29 'กดจาก
  // Project แล้ว Full screen เลย, มี icon back อยู่แล้ว'); the default/admin
  // editing view opens normal so the toolbar stays in reach. Tapping an empty
  // spot on the canvas toggles it either way. In-memory only.
  const [fullscreen, setFullscreen] = useState(!!autoFullscreen);
  // §3 Mindmap maximize — tap ⛶ to blow the mindmap up to a true fullscreen
  // overlay (position:fixed) and ✕ to drop it back into the accordion section
  // (เอ๋ 2026-05-31 'ต้องเห็น mindmap กดเข้าไปแล้วเป็นแบบ full screen'). Re-fit
  // on enter so the whole map is framed at the new size.
  const [mapMax, setMapMax] = useState(false);

  // "No PDF" filter — เอ๋ 2026-06-09: a top-right toggle in the fullscreen
  // mindmap that isolates the parts still missing a drawing. data.missing =
  // leaf parts with no resolvable PDF (the SAME set as the ⚠ NO PDF badge /
  // the .kme-missing node class). ON → every node WITHOUT that flag (pdf'd
  // parts, wrappers, the cabinet containers) fades out via CSS, leaving only
  // the no-PDF parts + the project center so she sees what's left to draw at
  // a glance. In-memory only (transient view filter, never persisted).
  const [noPdfOnly, setNoPdfOnly] = useState(false);

  // External-sync nonce. app.js dispatches a 'kme:extsync' window event when
  // a Firebase assembled/bent write lands (our own echo OR a remote device's
  // change) INSTEAD of calling its global render() — render() rebuilds
  // ROOT.innerHTML, which destroys #kme-mount and remounts this whole editor,
  // flashing the canvas on every tick. tap-3 feels still precisely because it
  // never leaves React; routing assembled/bent ticks through this nonce gives
  // 'complete' the same stillness (user 2026-05-29: 'กด complete ... ไม่ให้
  // จอกระพริบ เหมือน tab 3'). Bumping it flows into every node's data below so
  // React Flow re-renders the nodes in place — they re-read api.isAssembled /
  // api.isBent — with NO unmount and NO viewport reset.
  const [extSyncNonce, setExtSyncNonce] = useState(0);
  useEffect(() => {
    const h = () => setExtSyncNonce(n => n + 1);
    window.addEventListener('kme:extsync', h);
    return () => window.removeEventListener('kme:extsync', h);
  }, []);

  const _persistCollapse = useCallback((c, set) => {
    // Preserve hidden + seeded + revealAll across collapse toggles —
    // otherwise a single collapse/expand would wipe the tap-3 hide set,
    // the seeded flag (re-arming the auto-seed → variants snap shut), or
    // the reveal-all flag.
    const cur = _readCollapsedState(projectKey);
    _writeCollapsedState(projectKey, { center: c, nodes: set, hidden: cur.hidden, seeded: cur.seeded, revealAll: cur.revealAll });
  }, [projectKey]);

  // Persisting setter for revealAll. Reads the current LS entry so it
  // doesn't clobber center/nodes/hidden/seeded.
  const setRevealAll = useCallback((v) => {
    setRevealAllState(v);
    const cur = _readCollapsedState(projectKey);
    _writeCollapsedState(projectKey, { ...cur, revealAll: !!v });
  }, [projectKey]);

  const toggleCollapsed = useCallback(() => {
    setRevealAll(false);  // a hide gesture exits reveal-all mode
    setCollapsedState(c => {
      const next = !c;
      _persistCollapse(next, collapsedNodes);
      return next;
    });
  }, [_persistCollapse, collapsedNodes, setRevealAll]);

  const toggleNodeCollapse = useCallback((nodeId) => {
    setRevealAll(false);  // tapping a parent to collapse/expand exits reveal-all mode
    setCollapsedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      _persistCollapse(collapsed, next);
      return next;
    });
  }, [_persistCollapse, collapsed, setRevealAll]);

  // Idempotent 'make sure this node is collapsed AND hidden'. Used
  // when the user marks a node as assembled — the node and its spoke
  // should both fade out, mirroring the tap-3 home gesture. User
  // 2026-05-28: 'ย่อเฉพาะ node นั้น (node หาย เส้นหาย) ลักษณะ การ
  // ทำงาน คล้ายปุ่มที่ 3'. Tap project center re-shows them.
  const ensureCollapsed = useCallback((nodeId) => {
    setRevealAll(false);  // marking a part assembled re-enables normal hiding
    setCollapsedNodes(prev => {
      if (prev.has(nodeId)) return prev;
      const next = new Set(prev);
      next.add(nodeId);
      _persistCollapse(collapsed, next);
      return next;
    });
    setHiddenAnchors(prev => {
      if (prev.has(nodeId)) return prev;
      const next = new Set(prev);
      next.add(nodeId);
      return next;
    });
  }, [_persistCollapse, collapsed, setRevealAll]);

  // Inverse of ensureCollapsed — un-hide a node (and re-show its subtree):
  // drop it from BOTH collapsedNodes and hiddenAnchors. Used when the user
  // UN-marks 🧩 so the toggle reverses (node + edge come back), mirroring
  // how tapping the project center clears hiddenAnchors. (2026-05-29)
  const releaseNode = useCallback((nodeId) => {
    setCollapsedNodes(prev => {
      if (!prev.has(nodeId)) return prev;
      const next = new Set(prev);
      next.delete(nodeId);
      _persistCollapse(collapsed, next);
      return next;
    });
    setHiddenAnchors(prev => {
      if (!prev.has(nodeId)) return prev;
      const next = new Set(prev);
      next.delete(nodeId);
      return next;
    });
  }, [_persistCollapse, collapsed]);

  // Children map for the current edge set → subtree descent.
  // Recomputed on every nodes/edges change but cheap (O(E)).
  const descendantMap = useMemo(() => {
    const children = new Map();  // nodeId → [childId, ...]
    for (const e of edges) {
      if (!e.source || !e.target) continue;
      if (!children.has(e.source)) children.set(e.source, []);
      children.get(e.source).push(e.target);
    }
    // Pre-compute descendants per node so the hidden check is O(1).
    const descOf = new Map();
    function descsFor(id, seen = new Set()) {
      if (descOf.has(id)) return descOf.get(id);
      if (seen.has(id)) return new Set();   // cycle guard
      seen.add(id);
      const out = new Set();
      for (const child of (children.get(id) || [])) {
        out.add(child);
        for (const d of descsFor(child, seen)) out.add(d);
      }
      descOf.set(id, out);
      return out;
    }
    for (const id of children.keys()) descsFor(id);
    return descOf;
  }, [edges]);

  // Anchors that have been hidden by the tap-3 'home' gesture OR
  // by ticking the 🧩 button. Persisted in the SAME LS entry as
  // collapsedNodes so a render() triggered by a Firebase listener
  // (initAssembledSync re-renders on every assembled change → would
  // remount the editor + wipe useState if we kept this in memory
  // only) doesn't lose the hide state.
  //
  // MUST be declared before the hiddenIds useMemo below — that memo
  // reads hiddenAnchors, so a later declaration is a temporal-dead-zone
  // crash ("Cannot access 'hiddenAnchors' before initialization") that
  // blanks the whole mindmap. Regression fixed 2026-05-29.
  const [hiddenAnchors, setHiddenAnchorsRaw] = useState(
    () => _readCollapsedState(projectKey).hidden);
  // Wrap to persist to the same LS entry as collapsedNodes — the
  // useEffect that mirrors collapsedNodes uses the latest hidden too.
  const setHiddenAnchors = useCallback((updater) => {
    setHiddenAnchorsRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      try {
        const cur = _readCollapsedState(projectKey);
        _writeCollapsedState(projectKey, { ...cur, hidden: next });
      } catch {}
      return next;
    });
  }, [projectKey]);

  // hiddenIds = union of descendants of every collapsed parent AND
  // every tap-3-hidden anchor. The latter is what makes a hidden
  // parent's whole subtree disappear together (user 2026-05-28:
  // 'tab 3 คือ โชว์พร้อมเส้น หายหรือซ่อน พร้อมเส้น' — hiding the
  // parent should drag its kids' edges along with it).
  const hiddenIds = useMemo(() => {
    const out = new Set();
    for (const id of collapsedNodes) {
      const descs = descendantMap.get(id);
      if (descs) for (const d of descs) out.add(d);
    }
    for (const id of hiddenAnchors) {
      const descs = descendantMap.get(id);
      if (descs) for (const d of descs) out.add(d);
    }
    return out;
  }, [collapsedNodes, descendantMap, hiddenAnchors]);

  const idCounterRef = useRef(0);

  const newNodeId = useCallback(() => {
    idCounterRef.current += 1;
    return `n_${Date.now().toString(36)}_${idCounterRef.current}`;
  }, []);

  const onLabelChange = useCallback((id, label) => {
    // local: show the new display name immediately
    setNodes((nds) => nds.map((n) => (
      n.id === id ? { ...n, data: { ...n.data, label } } : n
    )));
    // persist a CODED-node rename via the shared display_override system (Firebase) so it
    // shows in the Library + survives reload + syncs across devices — identical to the
    // Library rename. Keyed by the immutable CODE (data.code), not the React id. Custom
    // (non-coded) nodes have no code → stay local-only as before. (RD 02 2026-06-09)
    const node = nodes.find((n) => n.id === id);
    const code = node?.data?.code;
    if (code) (window.kdAPI || {}).setDisplayOverride?.(code, label);
  }, [nodes]);

  // Assembly checklist mode is active when the tree carries variant-root
  // nodes (CC_Assembly emits them post-2026-05-28). In checklist mode:
  //   • Variants start collapsed on first open of a project — only the
  //     project center + variant cards show, parts are tucked away.
  //   • Clicking a variant fades its kids in.
  //   • Clicking 🧩 on a part marks assembled AND fades the part out
  //     (still toggleable from any non-checklist view).
  const inChecklistMode = useMemo(
    () => nodes.some(n => n.data?.isVariantRoot),
    [nodes]);

  // First-open seed: if the project has variants and no per-node collapse
  // state has ever been persisted (kd_project_collapse_v1 entry is empty
  // for nodes), preset every variant id into the collapsed set so the
  // initial view is "project + variants only". A user who then expands
  // some variants stores that explicit choice; the seed never runs again
  // for this project unless they hit Reset (which clears the LS entry).
  useEffect(() => {
    if (!inChecklistMode) return;
    // Seed ONCE per PAGE LOAD per project (module-scoped guard above). A
    // Firebase/timer REMOUNT must not re-seed (it would snap a deliberate
    // in-session "Show all" shut); a fresh reload re-enters here and re-seeds
    // the clean cabinet view. This REPLACES the old persisted-`seeded`
    // early-return, which made "Show all" a sticky one-way wall (เอ๋/G1
    // 2026-06-09: revealAll:true persisted → §1+§3 force-expanded all 204 rows
    // with no way back to the 15 cabinet boards).
    if (_kmeSeededProjects.has(projectKey)) return;
    // A real user-authored collapse state (they drilled into some cabinets) has
    // a NON-empty nodes list — never override it. The stuck-wall state has an
    // EMPTY collapse set (Show all wiped it) → fall through and re-seed.
    if (collapsedNodes.size > 0) { _kmeSeededProjects.add(projectKey); return; }
    const variantIds = nodes.filter(n => n.data?.isVariantRoot).map(n => n.id);
    if (!variantIds.length) return;
    _kmeSeededProjects.add(projectKey);
    const seeded = new Set(variantIds);
    setCollapsedNodes(seeded);
    setRevealAllState(false);   // clear any stuck "Show all" so the fade re-applies
    _writeCollapsedState(projectKey, { center: collapsed, nodes: seeded, hidden: new Set(), seeded: true, revealAll: false });
  }, [inChecklistMode, projectKey, nodes, collapsedNodes, collapsed]);

  // Compact-mode positions for collapsed variants: keep them close to the
  // project center so a freshly-opened mindmap fits a phone viewport
  // without zooming out (user 2026-05-28: 'เริ่มต้นไกลบนมือถือจะอ่าน
  // ลำบาก'). When the user expands a variant, its position transitions
  // out to the original Option A radius (~720) and the kids fade in
  // alongside. Kids of a collapsed variant stack on the variant's
  // compact position so they (a) animate outward from the variant on
  // expand and (b) don't bloat React Flow's auto-fit bounding box.
  const COMPACT_RADIUS = 220;
  const compactByVariantId = useMemo(() => {
    if (!inChecklistMode) return new Map();
    const map = new Map();
    for (const n of nodes) {
      if (!n.data?.isVariantRoot) continue;
      if (!collapsedNodes.has(n.id)) continue;
      const x0 = n.position?.x || 0;
      const y0 = n.position?.y || 0;
      // Preserve the variant's angular direction from the project so
      // 2 variants stay on the ±x axis, 3+ stay on their clock-face
      // arrangement — just pulled closer in.
      const angle = (x0 === 0 && y0 === 0) ? 0 : Math.atan2(y0, x0);
      map.set(n.id, {
        x: COMPACT_RADIUS * Math.cos(angle),
        y: COMPACT_RADIUS * Math.sin(angle),
      });
    }
    return map;
  }, [inChecklistMode, nodes, collapsedNodes]);

  // Auto-fit-view on expand/collapse — when the user clicks a variant
  // open, the kids fan out to radius 720+ and the viewport no longer
  // frames everything. User 2026-05-28: 'ย่อก็ไม่ได้ ขยายก็ไม่ได้' on
  // mobile because they couldn't see where the kids went. fitView()
  // smoothly re-frames the current visible nodes whenever the collapse
  // set changes in checklist mode. Skips the initial mount (the
  // <ReactFlow fitView> prop handles that).
  const rf = useReactFlow();

  // fitView, but never zoom out so far that the per-node 🧩/📄 buttons
  // become untappable on a phone. On a 375px iPhone, fitting all 29 Show-all
  // nodes drops the zoom to ~0.25, shrinking the (52px) buttons to ~13px —
  // impossible to hit (iPad's bigger screen fits at a higher zoom, which is
  // why it worked there). Cap the minimum fit-zoom on small screens so the
  // buttons stay ~30px+; the worker pans to reach nodes that don't fit.
  // User 2026-05-29: 'มือถือ ใช้ไม่ได้'.
  const fitNow = useCallback((opts = {}) => {
    const small = typeof window !== 'undefined' && window.innerWidth < 700;
    try {
      rf.fitView({ padding: 0.12, minZoom: small ? 0.6 : 0.1, ...opts });
    } catch {}
  }, [rf]);

  // NO auto-fit on expand/collapse/🧩/tap-3 anymore. The view only moves
  // when the USER pans/zooms or taps the Zoom-fit button. User 2026-05-29:
  // 'ไม่ต้องยุ่งเรื่อง pan zoom ... มีปุ่ม zoom fit แล้ว ให้ user จัดการเอง'.

  // "Show all" — single recoverable handle that brings EVERYTHING back
  // regardless of how it got hidden: clears the center collapse, every
  // collapsed subtree, AND every tap-3 / 🧩 hidden anchor, then wipes the
  // persisted LS entry so a reload stays fully expanded. Added 2026-05-29
  // after the whole mindmap disappeared (variants seeded-collapsed in
  // checklist mode + tap-3 hides stacked up) and the only recovery was the
  // non-obvious "tap the project-center bubble" gesture. setHiddenAnchorsRaw
  // (the unwrapped setter) avoids a redundant LS write — the explicit
  // _writeCollapsedState below is the single source of the cleared state.
  const showAll = useCallback(() => {
    setCollapsedState(false);
    setCollapsedNodes(new Set());
    setHiddenAnchorsRaw(new Set());
    setRevealAllState(true);  // also un-hide ASSEMBLED parts (opacity-0 in checklist mode)
    // seeded:true so the checklist auto-seed treats this as a deliberate
    // "expand everything" — a Firebase-sync remount won't re-collapse.
    // revealAll:true so the assembled-part fade is suppressed and that
    // also survives the remount.
    _writeCollapsedState(projectKey, { center: false, nodes: new Set(), hidden: new Set(), seeded: true, revealAll: true });
    setStatus('show all');
    setTimeout(() => fitNow({ duration: 600 }), 120);
  }, [projectKey, fitNow]);

  // "Collapse all" — the OTHER half of the Show-all toggle (เอ๋/G1 2026-06-09:
  // "Show all" was a STICKY one-way wall — once pressed it persisted
  // revealAll:true and §1 kanban + §3 mindmap force-expanded all 204 rows with
  // no way back to the cabinet boards). Re-seeds every depth-0 cabinet
  // collapsed, clears revealAll, and persists that clean state so reopening
  // stays grouped.
  const collapseAll = useCallback(() => {
    const variantIds = nodes.filter(n => n.data?.isVariantRoot).map(n => n.id);
    const seeded = new Set(variantIds);
    setCollapsedState(false);            // center expanded → the cabinets show
    setCollapsedNodes(seeded);           // every cabinet collapsed → cabinet boards
    setHiddenAnchorsRaw(new Set());
    setRevealAllState(false);
    _writeCollapsedState(projectKey, { center: false, nodes: seeded, hidden: new Set(), seeded: true, revealAll: false });
    setStatus('collapsed to cabinets');
    setTimeout(() => fitNow({ duration: 600 }), 120);
  }, [nodes, projectKey, fitNow]);

  // The Show-all control is a real TOGGLE now: when everything is already shown
  // (revealAll), collapse back to the cabinet boards; otherwise show everything.
  const toggleShowAll = useCallback(() => {
    if (revealAll) collapseAll(); else showAll();
  }, [revealAll, collapseAll, showAll]);

  // Tap empty canvas → toggle fullscreen. The canvas grows/shrinks, so
  // re-fit once the CSS size transition settles. (request 2026-05-29 #3)
  const toggleFullscreen = useCallback(() => {
    setFullscreen(f => !f);
    setTimeout(() => fitNow({ duration: 400 }), 360);
  }, [fitNow]);
  const onPaneClick = useCallback(() => { toggleFullscreen(); }, [toggleFullscreen]);

  // Fullscreen WITHOUT position:fixed. The old fixed-position fullscreen
  // broke React Flow touch hit-testing on iOS (touch clientX/Y and the
  // pane's getBoundingClientRect live in different coordinate spaces inside
  // a fixed element, so taps missed every node — confirmed 2026-05-29: the
  // non-fixed admin view registered taps, the fixed worker view did not).
  // Instead we hide the app chrome via an <html> class and let the editor
  // fill the viewport in NORMAL document flow, where touch works. Cleanup
  // removes the class on unmount so navigating back restores the chrome.
  useEffect(() => {
    const el = document.documentElement;
    if (fullscreen) el.classList.add('kme-fs-on');
    else el.classList.remove('kme-fs-on');
    return () => el.classList.remove('kme-fs-on');
  }, [fullscreen]);

  // No-PDF filter sets: the count for the button label + the ids kept
  // VISIBLE when the filter is on (the project center + every node flagged
  // data.missing). Edges use noPdfKeptIds to drop any spoke that would
  // otherwise dangle to a faded node. Memoised off `nodes` only.
  const noPdfCount = useMemo(
    () => nodes.reduce((acc, n) => acc + (n.data?.missing ? 1 : 0), 0),
    [nodes]
  );
  const noPdfKeptIds = useMemo(() => {
    const s = new Set();
    for (const n of nodes) {
      if (n.data?.kind === 'project' || n.data?.missing) s.add(n.id);
    }
    return s;
  }, [nodes]);

  // Inject onLabelChange + admin flag into every node's data so the
  // node components can react. admin gating happens at the node level
  // too because contentEditable + double-click-to-edit are per-node UX.
  // Pick component type from data.kind — 'project' → ProjectCenterNode,
  // anything else → MindmapNode (handles BOM + Custom).
  //
  // Checklist-mode hiding uses `data.faded` instead of React Flow's
  // `hidden: true` so the node stays in the DOM and the CSS opacity
  // transition can animate it on/off. `hidden: true` removes the node
  // from React Flow's render entirely, which means no exit animation.
  const nodesWithHandlers = useMemo(() => nodes.map((n) => {
    const isProject = n.data?.kind === 'project';
    const isHidden = hiddenIds.has(n.id);
    const isCollapsedParent = collapsedNodes.has(n.id);
    const hasChildren = (descendantMap.get(n.id)?.size || 0) > 0;
    // Compact position override — when in checklist mode AND
    // (the node is a collapsed variant root, or its parent variant is
    // collapsed), stack it at the variant's compact position. CSS
    // transition on .react-flow__node transform animates the slide.
    // SKIPPED when the node carries data.hasPosOverride (admin has
    // dragged it before) — preserves admin layout per user 2026-05-28:
    // 'ให้ แอดมิน ย้าย node ได้'.
    const isMissing = !!n.data?.missing;
    // No-PDF filter (เอ๋ 2026-06-09) owns visibility while active: every no-PDF
    // part shows at its REAL position (un-faded, skipping the compact stack);
    // every other node gets nopdfDim → a `.kme-nopdf-dim` class that fades it
    // out with !important (so it beats the .kme-node.kme-wrapper{opacity:.85} +
    // layer/faded opacity rules). We deliberately DON'T flip React Flow's
    // `hidden` prop for the filter — toggling hidden on dozens of nodes leaves
    // the rest stuck at RF's unmeasured `visibility:hidden`.
    const nopdfDim = noPdfOnly && !isProject && !isMissing;
    let position = n.position;
    if (!noPdfOnly && inChecklistMode && !n.data?.hasPosOverride) {
      if (n.data?.isVariantRoot && compactByVariantId.has(n.id)) {
        position = compactByVariantId.get(n.id);
      } else if (n.data?.variantNodeId && compactByVariantId.has(n.data.variantNodeId)) {
        position = compactByVariantId.get(n.data.variantNodeId);
      }
    }
    // Hidden-by-tap-3: the anchor itself was hidden, OR a descendant
    // of a hidden anchor. Independent of the existing checklist-mode
    // collapse/fade so a normally-visible anchor can still be hidden
    // and a normally-faded kid can still be hidden (no double-faded
    // edge case to worry about — once kme-faded is applied opacity
    // hits 0 either way).
    const hiddenByTap3 = hiddenAnchors.has(n.id)
      || (n.data?.variantNodeId && hiddenAnchors.has(n.data.variantNodeId));
    return {
      ...n,
      position,
      type: isProject ? 'project' : 'mindmap',
      // In checklist mode, keep BOM nodes in the DOM and let CSS handle
      // visibility (smooth fade). Outside checklist mode, fall back to
      // React Flow's hidden mechanism (instant, lower DOM cost).
      hidden: inChecklistMode ? false : isHidden,
      data: {
        ...n.data,
        onLabelChange, admin,
        isCollapsedParent,
        hasChildren,
        inChecklistMode,
        ensureCollapsed,
        releaseNode,
        revealAll,
        // No-PDF filter forces every node un-faded HERE and dims the pdf'd
        // ones via nopdfDim instead (so it works even when revealAll is on).
        // Else revealAll wins over every fade source so Show all truly shows all.
        faded: noPdfOnly ? false : (revealAll ? false : (hiddenByTap3 || (inChecklistMode ? isHidden : false))),
        nopdfDim,
        ...(isProject ? { collapsed, onToggleCollapsed: toggleCollapsed } : {}),
        // Bumped by the kme:extsync event so MindmapNode re-reads
        // api.isAssembled/isBent in place when a Firebase tick lands —
        // see extSyncNonce above (no remount, no viewport reset).
        _sync: extSyncNonce,
      },
      // draggable:true for EVERYONE — this is required for the inner-div
      // button taps (🧩 complete, 📄 PDF) to register on iPad/iPhone: when
      // a node is NOT draggable, React Flow treats the touch as a pane
      // interaction and SWALLOWS the inner onClick (see the note by
      // onOpenPdf). Workers still can't MOVE anything because onNodesChange
      // drops every non-'select' change for non-admin — so the layout is
      // safe. User 2026-05-29: 'ช่างประกอบ ... ยกเว้นย้าย' + 'ต้องให้
      // interactive ทำงานด้วย' (the previous draggable:admin broke the
      // 🧩/📄 button taps for workers).
      draggable: true,
    };
  }), [nodes, onLabelChange, admin, collapsed, toggleCollapsed, hiddenIds, collapsedNodes, descendantMap, inChecklistMode, compactByVariantId, hiddenAnchors, ensureCollapsed, releaseNode, revealAll, extSyncNonce, noPdfOnly]);

  // Edges: in checklist mode keep them in the SVG but fade their stroke
  // when either endpoint is hidden (lets the line shrink with the node).
  // Outside checklist mode keep the existing instant-hide semantics.
  // hiddenAnchors (tap-3 hide) also makes the spoke disappear — user
  // 2026-05-28 'เส้นโยงก็หายไปด้วย'.
  const visibleEdges = useMemo(() => edges.map(e => {
    // No-PDF filter: keep an edge only when BOTH endpoints survive the filter
    // (the project center or a no-PDF part) — otherwise it'd dangle to a
    // CSS-faded node. Takes precedence over the collapse/checklist edge logic.
    if (noPdfOnly) {
      return { ...e, hidden: !(noPdfKeptIds.has(e.source) && noPdfKeptIds.has(e.target)) };
    }
    const endpointHidden = hiddenIds.has(e.source) || hiddenIds.has(e.target)
      || hiddenAnchors.has(e.source) || hiddenAnchors.has(e.target);
    if (inChecklistMode) {
      return endpointHidden
        ? { ...e, style: { ...(e.style || {}), opacity: 0, transition: 'opacity 0.6s ease' } }
        : { ...e, style: { ...(e.style || {}), transition: 'opacity 0.8s ease' } };
    }
    return { ...e, hidden: endpointHidden };
  }), [edges, hiddenIds, inChecklistMode, hiddenAnchors, noPdfOnly, noPdfKeptIds]);

  const onNodesChange = useCallback((changes) => {
    // View-only: only allow 'select' changes — block drag/dimension/etc.
    const allowed = admin ? changes : changes.filter(c => c.type === 'select');
    setNodes((nds) => {
      let next = applyNodeChanges(allowed, nds);
      // Mark any node admin drags as having a position override so the
      // checklist-mode compactByVariantId pull steps aside on next
      // render. Without this, dragging a variant pulls it visually but
      // the next collapsedNodes-triggered recompute snaps it back to
      // ±220. User 2026-05-28: 'admin ย้าย node ได้'.
      if (admin) {
        const moved = new Set(
          allowed.filter(c => c.type === 'position').map(c => c.id)
        );
        if (moved.size) {
          next = next.map(n => moved.has(n.id)
            ? { ...n, data: { ...n.data, hasPosOverride: true } }
            : n);
        }
      }
      return next;
    });
  }, [admin]);

  const onEdgesChange = useCallback((changes) => {
    const allowed = admin ? changes : changes.filter(c => c.type === 'select');
    setEdges((eds) => applyEdgeChanges(allowed, eds));
  }, [admin]);

  const onConnect = useCallback((conn) => {
    if (!admin) return;
    // type: 'floating' = the FloatingEdge component (getStraightPath).
    // Match auto-generated edge style so user-drawn connectors look the
    // same as the spokes/branches built by buildAutoMindmap.
    setEdges((eds) => addEdge({
      ...conn,
      id: `e_${Date.now().toString(36)}`,
      type: 'floating',
      style: { stroke: '#8b949e', strokeWidth: 1.2, opacity: 0.5 },
    }, eds));
  }, [admin]);

  const onSelectionChange = useCallback(({ nodes: selNodes }) => {
    const first = selNodes?.[0];
    setSelectedId(first?.id || null);
    if (first?.id) {
      const payload = `${projectKey || ''}::${first.id}`;
      navigator.clipboard?.writeText(payload).then(
        () => setStatus(`copied: ${payload}`),
        () => setStatus(`selected: ${first.id} (clipboard blocked)`),
      );
    }
  }, [projectKey]);

  // Click handling at the ReactFlow level — fires from RF's own pointer-
  // event handler, which (unlike a React onClick on the inner node div)
  // works reliably on iPad PWA when `nodesDraggable=false`.
  //
  // - Project center: single → toggle global collapse, double → open PDF.
  // - BOM parent (has children, not a leaf): single → toggle that subtree.
  // - BOM leaf: single → routeLeaf via window.kdAPI. Skip when the tap
  //   landed inside a workshop-op button (handled by that button's own
  //   onClick + stopPropagation).
  const centerClickTimer = useRef(null);
  // Per-anchor tap counter for the expand → collapse → home cycle.
  const tapCycleRef = useRef({ id: null, count: 0, last: 0 });
  const onNodeClick = useCallback((evt, node) => {
    // iPad-diagnostic: surface the tap event in the toolbar so we can
    // tell from the device whether onNodeClick fires at all (workshop
    // iPad PWA was reporting all taps as no-ops).
    setStatus(`tap: ${node?.id || '?'}`);

    // Inner-button taps have their own handlers; don't double-fire here.
    if (evt?.target?.closest?.('.kme-mini, .kme-link-badge, .kme-missing-badge, .kme-comment-count, .kme-cmt-thread, [contenteditable="true"]')) return;

    if (node?.id?.startsWith('project:')) {
      // Project center tap also un-hides any anchors that were
      // hidden via the tap-3 'home' gesture — gives the user a
      // single recoverable handle to bring everything back. User
      // 2026-05-28: tap 3 hides the variant; tapping BUNG 01 brings
      // them back.
      if (hiddenAnchors.size) setHiddenAnchors(new Set());
      if (centerClickTimer.current) clearTimeout(centerClickTimer.current);
      centerClickTimer.current = setTimeout(() => {
        centerClickTimer.current = null;
        toggleCollapsed();
      }, 240);
      return;
    }
    const data = node?.data || {};
    const hasChildren = !!data.hasChildren;
    const isBom = data.kind === 'bom';
    const isWrapper = !!data.isWrapper;

    if (isBom && hasChildren) {
      // 3-tap cycle on a parent node (variants + wrappers in
      // checklist mode). User 2026-05-28:
      //   tap 1 = ขยาย (expand)
      //   tap 2 = ย่อ (collapse)
      //   tap 3 = กลับบ้าน (fitView — frame the whole layout)
      // Cycle resets when the user taps a different node, or after
      // 8 seconds of silence on this one.
      const cur = tapCycleRef.current;
      const now = performance.now ? performance.now() : 0;
      const sameNode = cur.id === node.id;
      const fresh = !sameNode || (now - cur.last) > 8000;
      if (fresh) {
        cur.id = node.id;
        cur.count = 1;
        cur.last = now;
        toggleNodeCollapse(node.id);
      } else {
        cur.count += 1;
        cur.last = now;
        if (cur.count % 3 === 0) {
          // 3rd tap: 'กลับบ้าน' = HIDE this node. User 2026-05-28
          // ('ไม่เกี่ยวกับซูมเลย กดครั้งที่ 3 SH0S10-080046 จะหายไป')
          // — literally fade the tapped anchor (and any descendant
          // that was attached to it) out of view. The view doesn't
          // pan. Other anchors keep their position and state per
          // 'Interactive เฉพาะของตัวเอง'.
          //
          // First force the node into the collapsed set so its kids
          // stack on it (or stay tucked), then add it to
          // hiddenAnchors so the CSS kme-faded class applies. To
          // bring it back, tap the project-center bubble — that
          // gesture clears hiddenAnchors.
          setRevealAll(false);  // a hide gesture exits reveal-all mode
          setCollapsedNodes(prev => {
            if (prev.has(node.id)) return prev;
            const next = new Set(prev);
            next.add(node.id);
            _persistCollapse(collapsed, next);
            return next;
          });
          setHiddenAnchors(prev => {
            const next = new Set(prev);
            next.add(node.id);
            return next;
          });
        } else {
          toggleNodeCollapse(node.id);
        }
      }
      return;
    }

    // In checklist mode (assembly view) the user explicitly wants
    // 'กดหน้าจอ กรอบสี่เหลี่ยมใหญ่ หมายถึง ย่อ หรือขยายเท่านั้น' +
    // 'กดดู PDF ได้เฉพาะปุ่ม PDF' (user 2026-05-28). So leaf taps are
    // a no-op here — the 📄 button is the only way to open a PDF, and
    // routeLeaf-to-Fusion is the designer's path which they reach from
    // the workshop role (no checklist mode active there).
    if (data.inChecklistMode) return;

    // Outside checklist mode: leaf BOM → route to PDF / Fusion. Per
    // feedback_leaf_click_routing: status=missing → Fusion 3D,
    // drawn/stale/deleted → drawing .f2d, fallback to PDF.
    // window.kdAPI.routeLeaf encapsulates the rules.
    if (isBom && !hasChildren && !isWrapper) {
      const code = data.code || data.label;
      const api = window.kdAPI || {};
      if (api.routeLeaf) {
        api.routeLeaf({ code, status: data.status, urn: data.urn, drawing_urn: data.drawing_urn, fusion_link: data.fusion_link });
      } else if (code) {
        const url = api.pdfUrlForCode?.(code);
        if (url) (api.openInNewTab || ((u) => window.open(u, '_blank', 'noopener')))(url);
      }
    }
  }, [toggleCollapsed, toggleNodeCollapse, nodes, rf, collapsed, _persistCollapse]);
  const onNodeDoubleClick = useCallback((evt, node) => {
    if (!node?.id?.startsWith('project:')) return;
    if (centerClickTimer.current) {
      clearTimeout(centerClickTimer.current);
      centerClickTimer.current = null;
    }
    const pk = node.data?.projectKey || projectKey;
    if (!pk) return;
    const api = window.kdAPI || {};
    const url = api.projectPdfUrl?.(pk) || api.pdfUrlForCode?.(pk);
    if (url) (api.openInNewTab || ((u) => window.open(u, '_blank', 'noopener')))(url);
    else window.alert(`No project PDF found for ${pk}`);
  }, [projectKey, toggleCollapsed]);

  const addNode = useCallback(() => {
    if (!admin) return;
    const id = newNodeId();
    const next = {
      id,
      type: 'mindmap',
      position: { x: 100 + Math.random() * 300, y: 100 + Math.random() * 200 },
      data: { label: 'new node', kind: 'custom' },
    };
    setNodes((nds) => [...nds, next]);
    setStatus(`added ${id}`);
  }, [newNodeId, admin]);

  const deleteSelected = useCallback(() => {
    if (!admin || !selectedId) return;
    // BOM nodes can't be deleted (per spec — they come from manifest).
    if (selectedId.startsWith('bom:')) {
      setStatus(`cannot delete BOM node ${selectedId}`);
      return;
    }
    setNodes((nds) => nds.filter((n) => n.id !== selectedId));
    setEdges((eds) => eds.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setStatus(`deleted ${selectedId}`);
    setSelectedId(null);
  }, [selectedId, admin]);

  // Delete key handler (only when canvas focused — not inside contentEditable)
  useEffect(() => {
    if (!admin) return;  // workshop iPad never deletes via keyboard
    const onKey = (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const tgt = e.target;
        const editable = tgt?.isContentEditable || ['INPUT', 'TEXTAREA'].includes(tgt?.tagName);
        if (editable) return;
        deleteSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteSelected, admin]);

  // Fire change callback for persistence — admin only (view-only never writes).
  useEffect(() => {
    if (!admin) return;
    onChange?.({ nodes, edges });
  }, [nodes, edges, onChange, admin]);

  // Deep-link highlight — when navigated from PDF with #code=X, flash
  // green halo on the matching node so workshop sees what was clicked.
  useEffect(() => {
    if (!deepLinkCode) return;
    const targetId = `bom:${deepLinkCode}`;
    // Wait for nodes to render into DOM.
    let tries = 0;
    const t = setInterval(() => {
      const el = document.querySelector(`.react-flow__node[data-id="${targetId}"]`);
      tries++;
      if (el) {
        el.classList.add('kme-deeplink-halo');
        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
        setTimeout(() => el.classList.remove('kme-deeplink-halo'), 4200);
        clearInterval(t);
      } else if (tries > 30) {
        clearInterval(t);  // give up after 3s
      }
    }, 100);
    return () => clearInterval(t);
  }, [deepLinkCode]);

  return (
    <div className={`kme-assembly-shell${fullscreen ? ' kme-fs-shell' : ''}`}>
      {/* Sticky shell toolbar — Back + Show all reachable from the top of
          the scroll, so the worker never has to scroll to the Kanban to
          re-frame or leave. Show all calls the SHARED showAll → syncs §1+§3.
          (เอ๋ 2026-05-31 'Show all เหมือนกัน') */}
      <div className="kme-shell-bar">
        <button
          className="kme-shell-back"
          onClick={() => {
            document.documentElement.classList.remove('kme-fs-on');
            setFullscreen(false);
            (window.kdAPI?.back || (() => {}))();
          }}
          title="Back to projects"
        >← Back</button>
        <span className="kme-shell-title">Assembly</span>
        <button className="kme-shell-showall" onClick={toggleShowAll} title={revealAll ? 'Collapse back to the cabinet boards' : 'Show every node — clears all hide/collapse'}>{revealAll ? '⊟ Collapse' : '⊞ Show all'}</button>
      </div>

      {/* §1 Assembly Tree — capsule list, shares state with §3 Kanban */}
      <section className="kme-sec kme-sec-tree">
        <div className="kme-sec-head"><span className="kme-sec-title">1 · Kanban</span></div>
        <div className="kme-sec-body">
          <AssemblyTree
            nodes={nodes} edges={edges} projectKey={projectKey} admin={admin}
            nonce={extSyncNonce}
            collapsedNodes={collapsedNodes} hiddenAnchors={hiddenAnchors} revealAll={revealAll}
            toggleNodeCollapse={toggleNodeCollapse} ensureCollapsed={ensureCollapsed} releaseNode={releaseNode}
          />
        </div>
      </section>

      {/* §2 Checklist — flat tick list + PDF per part */}
      <section className="kme-sec kme-sec-checklist">
        <div className="kme-sec-head"><span className="kme-sec-title">2 · Checklist</span></div>
        <div className="kme-sec-body">
          <ChecklistPanel projectKey={projectKey} nonce={extSyncNonce} asSection />
        </div>
      </section>

      {/* §3 Mindmap — the existing React Flow mindmap, untouched (เอ๋
          2026-05-31 renamed 'Kanban' → 'Mindmap'; class kept for the CSS) */}
      <section className="kme-sec kme-sec-kanban">
        <div className="kme-sec-head">
          <span className="kme-sec-title">3 · Mindmap</span>
          <button
            className="kme-map-max-btn"
            onClick={() => {
              const next = !mapMax;
              setMapMax(next);
              // re-fit after the container resizes so the whole map shows
              setTimeout(() => { try { fitNow({ duration: 0 }); } catch (_) {} }, 60);
            }}
            title={mapMax ? 'Exit fullscreen' : 'Fullscreen mindmap'}
          >{mapMax ? '✕ Close' : '⛶ Fullscreen'}</button>
        </div>
    <div className={`kme-root${admin ? '' : ' kme-view-only'}${collapsed ? ' kme-collapsed' : ''}${inChecklistMode ? ' kme-checklist' : ''}${fullscreen ? ' kme-fullscreen' : ''}${mapMax ? ' kme-map-max' : ''}`}>
      {/* Toolbar is admin-only. Workers get a clean canvas — the floating
          Show all (in the <Panel> below) is their only control, so the
          status line + zoom chrome don't eat their screen. User 2026-05-29:
          'เอาตรงนี้ออก'. */}
      {admin && !fullscreen && <div className="kme-toolbar">
        {admin && (
          <>
            <button className="kme-primary" onClick={addNode} title="Add a new node">
              <svg className="kme-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="8" cy="8" r="6.2"/>
                <line x1="8" y1="5" x2="8" y2="11"/>
                <line x1="5" y1="8" x2="11" y2="8"/>
              </svg>
              <span>Node</span>
            </button>
            <button
              onClick={deleteSelected}
              disabled={!selectedId || selectedId.startsWith('bom:')}
              title={selectedId?.startsWith('bom:') ? 'BOM nodes cannot be deleted' : 'Delete selected (Del)'}
            >
              <svg className="kme-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 4.5h10"/>
                <path d="M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5"/>
                <path d="M4.5 4.5l.7 8.2a1 1 0 0 0 1 .8h3.6a1 1 0 0 0 1-.8l.7-8.2"/>
                <line x1="7" y1="7" x2="7" y2="12"/>
                <line x1="9" y1="7" x2="9" y2="12"/>
              </svg>
              <span>Delete</span>
            </button>
          </>
        )}
        <button className="kme-showall" onClick={toggleShowAll} title={revealAll ? 'Collapse back to the cabinet boards' : 'Show every node — clears all hide/collapse and re-frames the whole map'}>
          <svg className="kme-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="2.1"/>
            <circle cx="3" cy="3" r="1.4"/>
            <circle cx="13" cy="3" r="1.4"/>
            <circle cx="3" cy="13" r="1.4"/>
            <circle cx="13" cy="13" r="1.4"/>
            <line x1="6.4" y1="6.4" x2="4" y2="4"/>
            <line x1="9.6" y1="6.4" x2="12" y2="4"/>
            <line x1="6.4" y1="9.6" x2="4" y2="12"/>
            <line x1="9.6" y1="9.6" x2="12" y2="12"/>
          </svg>
          <span>{revealAll ? 'Collapse' : 'Show all'}</span>
        </button>
        <div className="kme-spacer" />
        <div className="kme-status">
          project: <b>{projectKey || '—'}</b> · {nodes.length} nodes · {edges.length} edges · {status} · <span title="Build timestamp — confirms which bundle is live on this device" style={{ opacity: 0.5 }}>b{typeof __KME_BUILD__ !== 'undefined' ? __KME_BUILD__ : '?'}</span>
        </div>
      </div>}
      <div className="kme-canvas">
        <ReactFlow
          nodes={nodesWithHandlers}
          edges={visibleEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onSelectionChange={onSelectionChange}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          /* No onPaneClick fullscreen toggle — tapping the canvas anywhere
             keeps you in fullscreen; only the Back button leaves (it
             unmounts the editor → the kme-fs-on class is cleared → back to
             the project list). User 2026-05-29: 'กดตรงไหนก็ยังอยู่ full
             screen, ต้องกด Back เท่านั้นถึงจะออก'. */
          /* nodesDraggable=true for all so touch taps on a node's inner
             buttons (🧩/📄) aren't swallowed as pane interactions on iPad.
             Non-admin moves are still blocked in onNodesChange. */
          nodesDraggable={true}
          nodesConnectable={admin}
          edgesUpdatable={admin}
          elementsSelectable={true}
          zoomOnPinch={true}
          panOnDrag={true}
          zoomOnDoubleClick={false}
          selectNodesOnDrag={false}
          nodeDragThreshold={20}
          nodeClickDistance={20}
          paneClickDistance={20}
          defaultEdgeOptions={{ type: 'floating', style: { strokeWidth: 1.2, opacity: 0.5 } }}
          /* Fit ONLY on the first open of a project; on later remounts
             (Firebase sync) restore the cached viewport so the view never
             jumps. After that the user owns pan/zoom (+ the Zoom-fit button).
             onMoveEnd caches every pan/zoom so the restore is up to date. */
          fitView={!_vpCache[projectKey]}
          fitViewOptions={{ padding: 0.12, minZoom: (typeof window !== 'undefined' && window.innerWidth < 700) ? 0.6 : 0.1 }}
          defaultViewport={_vpCache[projectKey] || undefined}
          onMoveEnd={(_e, vp) => { if (projectKey && vp) _vpCache[projectKey] = vp; }}
          /* minZoom needs to be loose enough that a phone can pinch
             out to see both variants (at ±720 in expanded checklist
             mode → 1440 px wide layout vs 375 px iPhone viewport).
             0.85 was the iPad-buttons-stay-tappable limit but blocks
             mobile users from ever seeing the whole expanded picture.
             0.25 lets a phone fit a 1440 px layout into ~360 px and
             still has plenty of room to pinch back in for tapping
             targets. User 2026-05-28: 'ย่อก็ไม่ได้ ขยายก็ไม่ได้'. */
          minZoom={0.25}
          maxZoom={2.5}
          colorMode="dark"
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#30363d" />
          {/* Controls (+/−/fit/lock) and the MiniMap are admin-only. Workers
              (assembly/workshop on phones) get the full canvas — they pinch
              to zoom and use the Show all button to re-frame. User 2026-05-29:
              'เอา 2 อันนี้ออก ให้มองเห็นหน้าจอเต็มๆ'. */}
          {admin && !fullscreen && <Controls />}
          {admin && !fullscreen && <MiniMap pannable zoomable maskColor="rgba(13, 17, 23, 0.7)" nodeColor="#30363d" />}
          {/* Zoom-fit — the only zoom control kept in fullscreen (user
              2026-05-29: 'เหลือไว้แค่ zoom fit'). Pinch handles in/out. */}
          <Panel position="bottom-right">
            <button
              className="kme-fit-btn"
              onClick={(e) => { e.stopPropagation(); fitNow({ duration: 400 }); }}
              title="Zoom to fit"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 5.5V2.5h3M14 5.5V2.5h-3M2 10.5v3h3M14 10.5v3h-3"/>
              </svg>
            </button>
          </Panel>
          {/* Floating Show all — pinned to the canvas viewport via <Panel>,
              so it can't scroll out of reach on a phone (the toolbar above
              the canvas slides under the sticky app header once the worker
              pans). User 2026-05-29: assembly screen MUST keep Show all
              reachable. Always rendered so every role can re-frame. */}
          <Panel position="bottom-left">
            <button
              className="kme-showall kme-showall-float"
              onClick={toggleShowAll}
              title={revealAll ? 'Collapse back to the cabinet boards' : 'Show every node — clears all hide/collapse and re-frames the whole map'}
            >
              <svg className="kme-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="8" cy="8" r="2.1"/>
                <circle cx="3" cy="3" r="1.4"/>
                <circle cx="13" cy="3" r="1.4"/>
                <circle cx="3" cy="13" r="1.4"/>
                <circle cx="13" cy="13" r="1.4"/>
                <line x1="6.4" y1="6.4" x2="4" y2="4"/>
                <line x1="9.6" y1="6.4" x2="12" y2="4"/>
                <line x1="6.4" y1="9.6" x2="4" y2="12"/>
                <line x1="9.6" y1="9.6" x2="12" y2="12"/>
              </svg>
              <span>{revealAll ? 'Collapse' : 'Show all'}</span>
            </button>
          </Panel>
          {/* Checklist panel removed from the fullscreen Mindmap — the §2
              Checklist section in the accordion already covers it, and it was
              overlapping Show all at bottom-left (เอ๋ 2026-05-31 'ที่ Mindmap
              full screen ยกเลิก checklist เพราะมีที่ด้านนอกแล้ว'). */}
          {/* Top-left = Close (เอ๋ 2026-06-09: 'ยกเลิกปุ่ม Back ให้ Close ไป
              แทนที่'). In the maximized mindmap Close drops back to the
              accordion; in the worker auto-fullscreen view it leaves to the
              project list (clearing the <html> class explicitly because app.js
              detaches #kme-mount without unmounting, so the editor's cleanup
              never fires — without this the list renders with its header
              still hidden). Replaces both the old ← Back panel and the
              floating ✕ Close exit. */}
          {(fullscreen || mapMax) && (
            <Panel position="top-left">
              <button
                className="kme-fs-back"
                onClick={(e) => {
                  e.stopPropagation();
                  if (mapMax) { setMapMax(false); return; }
                  document.documentElement.classList.remove('kme-fs-on');
                  setFullscreen(false);
                  (window.kdAPI?.back || (() => {}))();
                }}
                title={mapMax ? 'Close — back to the assembly view' : 'Close — back to projects'}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18"/>
                </svg>
                <span>Close</span>
              </button>
            </Panel>
          )}
          {/* Top-right = No PDF filter toggle (เอ๋ 2026-06-09: 'ด้านขวาบนเป็น
              ปุ่ม No PDF'). Isolates the parts still missing a drawing; label
              carries the live count. */}
          {(fullscreen || mapMax) && (
            <Panel position="top-right">
              <button
                className={'kme-nopdf-btn' + (noPdfOnly ? ' is-active' : '')}
                onClick={(e) => { e.stopPropagation(); setNoPdfOnly(v => !v); }}
                title={noPdfOnly ? 'Show all parts again' : 'Show only the parts with no PDF'}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>
                  <path d="M14 3v5h5"/>
                  <line x1="4" y1="4" x2="20" y2="20"/>
                </svg>
                <span>No PDF{noPdfCount ? ` (${noPdfCount})` : ''}</span>
              </button>
            </Panel>
          )}
        </ReactFlow>
      </div>
    </div>
      </section>
      {/* (The maximized-mindmap exit is now the top-left Close Panel inside
          the canvas — see above; เอ๋ 2026-06-09. The old floating
          .kme-map-max-exit button was removed with the ← Back panel.) */}
    </div>
  );
}

// ── Mount API ───────────────────────────────────────────────────────
// Main app.js does:
//   await import('./editor.bundle.js');   // attaches global KitchenMindmapEditor
//   KitchenMindmapEditor.mount(div, { projectKey, initialNodes, initialEdges, onChange })
function mount(rootEl, options = {}) {
  if (!rootEl) throw new Error('mount: rootEl required');
  const root = createRoot(rootEl);
  root.render(
    <ReactFlowProvider>
      <Editor {...options} />
    </ReactFlowProvider>
  );
  return {
    unmount: () => root.unmount(),
  };
}

export { mount };
// esbuild IIFE format also attaches `mount` to window.KitchenMindmapEditor.
