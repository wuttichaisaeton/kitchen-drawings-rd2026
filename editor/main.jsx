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
  const { label, code, projectKey, collapsed, admin } = data;
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
  const cls = ['kme-center'];
  if (selected) cls.push('kme-selected');
  if (collapsed) cls.push('kme-center-collapsed');
  if (dragOver) cls.push('kme-center-drag-over');
  if (uploading) cls.push('kme-center-uploading');
  return (
    <div
      className={cls.join(' ')}
      title={admin
        ? `Click: ${collapsed ? 'expand' : 'collapse'} · Double-click: open project PDF · Drop PDF here to upload as ${displayCode}.pdf`
        : `Click: ${collapsed ? 'expand' : 'collapse'} · Double-click: open project PDF (${displayCode})`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <svg className="kme-center-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3 L18 6.5 L12 10 L6 6.5 Z"/>
        <path d="M6 11.5 L12 15 L6 18.5 L0.5 15 Z" transform="translate(2.5 0)"/>
        <path d="M12 11.5 L18 15 L12 18.5 L6.5 15 Z" transform="translate(3 0)"/>
      </svg>
      <div className="kme-center-code">{displayCode}</div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

// ── BOM / Custom node ───────────────────────────────────────────────
function MindmapNode({ id, data, selected }) {
  const { label, fusion_link, kind, qty, admin, color, tint, projectKey, missing, family,
          isLeaf, isWrapper, status, urn, drawing_urn,
          isCollapsedParent, hasChildren,
          isVariantRoot, inChecklistMode, faded } = data;
  const isBom = kind === 'bom';
  const linked = !!fusion_link;
  const code = isBom ? label : null;
  const labelRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Bump on workshop-op state changes so re-renders read fresh.
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick(t => t + 1), []);

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
    window.__kmeStatus?.(`tap asm: ${code}`);
    if (!code || !projectKey) return;
    api.markAssembled?.(projectKey, code, !assembled);
    bump();
  }, [code, projectKey, assembled, api, bump]);

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
    window.__kmeStatus?.(`tap pdf: ${code}`);
    if (!code) return;
    const url = api.pdfUrlForCode?.(code);
    if (url) (api.openInNewTab || ((u) => window.open(u, '_blank', 'noopener')))(url);
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

  // Checklist-mode fade: applied when (a) the editor flagged this node
  // hidden because its variant is collapsed, or (b) the part has been
  // marked assembled. Variant-root nodes themselves never fade — they
  // are the click target that brings the kids back in.
  // `assembled` was already read above (line ~150) for the existing
  // green-tint indicator; reuse it here so a tap on 🧩 fades the node
  // out on the next local re-render via bump().
  const isFadedNode = isBom && !isVariantRoot &&
    (faded || (inChecklistMode && assembled));

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

  // Family color drives border + bottom tint
  const style = isBom && color ? {
    borderColor: color,
    background: `linear-gradient(180deg, #161b22 60%, ${tint || '#161b22'} 100%)`,
  } : undefined;

  return (
    <div
      className={cls.join(' ')}
      style={style}
      onDoubleClick={startEdit}
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
        >
          {label}
        </div>
        {isBom && qty != null && (
          <span className="kme-node-qty">x<span className="kme-node-qty-num">{qty}</span></span>
        )}
        {missing && isBom && (
          <span
            className="kme-missing-badge nodrag nopan"
            title="Open in Library to inspect or drop a PDF"
            onClick={(e) => {
              e.stopPropagation();
              if (code && api.openInLibrary) api.openInLibrary(code);
            }}
            onPointerDown={(e) => {
              if (e.pointerType === 'touch') {
                e.stopPropagation();
                if (code && api.openInLibrary) api.openInLibrary(code);
              }
            }}
          >
            ⚠ NO PDF 🔗
          </span>
        )}
        {uploading && (
          <span className="kme-missing-badge nodrag nopan" style={{ background: '#1f6feb', color: '#fff' }}>uploading…</span>
        )}
        {comments.length > 0 && (
          <span className="kme-comment-count" title={`${comments.length} comments`}>💬{comments.length}</span>
        )}
      </div>
      {isBom && (
        <div className="kme-row kme-row-actions nodrag nopan">
          <button
            className={`kme-mini kme-timer ${timerRunning ? 'kme-on' : ''}`}
            onClick={onTimer}
            onPointerDown={(e) => { if (e.pointerType === 'touch') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); onTimer(e); } }}
            title={timerRunning ? 'Stop timer' : 'Start timer'}
          >
            {timerRunning ? '⏸' : '▶'}
            {timerSec > 0 && <span className="kme-timer-elapsed">{api.formatDuration?.(timerSec)}</span>}
          </button>
          {admin && timerSec > 0 && (
            <button
              className="kme-mini kme-timer-reset"
              onClick={onResetTimer}
              onPointerDown={(e) => { if (e.pointerType === 'touch') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); onResetTimer(e); } }}
              title="Edit / reset timer"
            >↺</button>
          )}
          <span className="kme-spacer-mini" />
          <button
            className={`kme-mini kme-bent ${bent ? 'kme-on' : ''}`}
            onClick={onBent}
            onPointerDown={(e) => { if (e.pointerType === 'touch') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); onBent(e); } }}
            title={bent ? 'Mark as not bent' : 'Mark bent'}
          >
            <img src="icons/bending.svg" alt="bend" />
          </button>
          <button
            className={`kme-mini kme-assembled ${assembled ? 'kme-on' : ''}`}
            onClick={onAssembled}
            onPointerDown={(e) => { if (e.pointerType === 'touch') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); onAssembled(e); } }}
            title={assembled ? 'Mark as not assembled' : 'Mark assembled'}
          >
            🧩
          </button>
          {code && api.pdfUrlForCode?.(code) && (
            <button
              className="kme-mini kme-pdf"
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

// ── Main editor ─────────────────────────────────────────────────────
// Collapsed state per project — persisted in localStorage so reopening
// the project view remembers what was collapsed last time.
//
// LS shape: { projectKey: { center?: true, nodes?: ['bom:foo', 'bom:bar', ...] } }
// - center=true means the project center is collapsed (everything hidden).
// - nodes=[...] are individual parent nodes whose subtrees are hidden.
const LS_COLLAPSED = 'kme_collapsed_v2';

function _readCollapsedState(pk) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_COLLAPSED) || '{}');
    const entry = all[pk] || {};
    return {
      center: !!entry.center,
      nodes: new Set(Array.isArray(entry.nodes) ? entry.nodes : []),
    };
  } catch {
    return { center: false, nodes: new Set() };
  }
}
function _writeCollapsedState(pk, state) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_COLLAPSED) || '{}');
    const center = !!state.center;
    const nodes = [...(state.nodes || new Set())];
    if (center || nodes.length) all[pk] = { ...(center ? { center: true } : {}), ...(nodes.length ? { nodes } : {}) };
    else delete all[pk];
    localStorage.setItem(LS_COLLAPSED, JSON.stringify(all));
  } catch {}
}

function Editor({ projectKey, initialNodes, initialEdges, onChange, admin, deepLinkCode }) {
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

  const _persistCollapse = useCallback((c, set) => {
    _writeCollapsedState(projectKey, { center: c, nodes: set });
  }, [projectKey]);

  const toggleCollapsed = useCallback(() => {
    setCollapsedState(c => {
      const next = !c;
      _persistCollapse(next, collapsedNodes);
      return next;
    });
  }, [_persistCollapse, collapsedNodes]);

  const toggleNodeCollapse = useCallback((nodeId) => {
    setCollapsedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      _persistCollapse(collapsed, next);
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

  // hiddenIds = union of descendants of every collapsed parent.
  const hiddenIds = useMemo(() => {
    const out = new Set();
    for (const id of collapsedNodes) {
      const descs = descendantMap.get(id);
      if (descs) for (const d of descs) out.add(d);
    }
    return out;
  }, [collapsedNodes, descendantMap]);

  const idCounterRef = useRef(0);

  const newNodeId = useCallback(() => {
    idCounterRef.current += 1;
    return `n_${Date.now().toString(36)}_${idCounterRef.current}`;
  }, []);

  const onLabelChange = useCallback((id, label) => {
    setNodes((nds) => nds.map((n) => (
      n.id === id ? { ...n, data: { ...n.data, label } } : n
    )));
  }, []);

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
  const seededProjectRef = useRef(null);
  useEffect(() => {
    if (!inChecklistMode) return;
    if (seededProjectRef.current === projectKey) return;
    seededProjectRef.current = projectKey;
    if (collapsedNodes.size > 0) return;
    const variantIds = nodes.filter(n => n.data?.isVariantRoot).map(n => n.id);
    if (!variantIds.length) return;
    const seeded = new Set(variantIds);
    setCollapsedNodes(seeded);
    _persistCollapse(collapsed, seeded);
  }, [inChecklistMode, projectKey, nodes, collapsedNodes, collapsed, _persistCollapse]);

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
    return {
      ...n,
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
        faded: inChecklistMode ? isHidden : false,
        ...(isProject ? { collapsed, onToggleCollapsed: toggleCollapsed } : {}),
      },
      // Workshop also gets to drag nodes — useful for rearranging the
      // mindmap to match how the shift is bending today. Position changes
      // don't persist for workshop (only admin's _saveOverride path persists);
      // workshop's drags are visual-only and reset on reload.
      draggable: true,
    };
  }), [nodes, onLabelChange, admin, collapsed, toggleCollapsed, hiddenIds, collapsedNodes, descendantMap, inChecklistMode]);

  // Edges: in checklist mode keep them in the SVG but fade their stroke
  // when either endpoint is hidden (lets the line shrink with the node).
  // Outside checklist mode keep the existing instant-hide semantics.
  const visibleEdges = useMemo(() => edges.map(e => {
    const endpointHidden = hiddenIds.has(e.source) || hiddenIds.has(e.target);
    if (inChecklistMode) {
      return endpointHidden
        ? { ...e, style: { ...(e.style || {}), opacity: 0, transition: 'opacity 0.6s ease' } }
        : { ...e, style: { ...(e.style || {}), transition: 'opacity 0.8s ease' } };
    }
    return { ...e, hidden: endpointHidden };
  }), [edges, hiddenIds, inChecklistMode]);

  const onNodesChange = useCallback((changes) => {
    // View-only: only allow 'select' changes — block drag/dimension/etc.
    const allowed = admin ? changes : changes.filter(c => c.type === 'select');
    setNodes((nds) => applyNodeChanges(allowed, nds));
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
  const onNodeClick = useCallback((evt, node) => {
    // iPad-diagnostic: surface the tap event in the toolbar so we can
    // tell from the device whether onNodeClick fires at all (workshop
    // iPad PWA was reporting all taps as no-ops).
    setStatus(`tap: ${node?.id || '?'}`);

    // Inner-button taps have their own handlers; don't double-fire here.
    if (evt?.target?.closest?.('.kme-mini, .kme-link-badge, .kme-missing-badge, [contenteditable="true"]')) return;

    if (node?.id?.startsWith('project:')) {
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
      toggleNodeCollapse(node.id);
      return;
    }

    // Leaf BOM — route to PDF / Fusion. Per feedback_leaf_click_routing:
    // status=missing → Fusion 3D, drawn/stale/deleted → drawing .f2d,
    // fallback to PDF. window.kdAPI.routeLeaf encapsulates the rules.
    if (isBom && !hasChildren && !isWrapper) {
      const code = data.label;
      const api = window.kdAPI || {};
      if (api.routeLeaf) {
        api.routeLeaf({ code, status: data.status, urn: data.urn, drawing_urn: data.drawing_urn });
      } else if (code) {
        const url = api.pdfUrlForCode?.(code);
        if (url) (api.openInNewTab || ((u) => window.open(u, '_blank', 'noopener')))(url);
      }
    }
  }, [toggleCollapsed, toggleNodeCollapse]);
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
    <div className={`kme-root${admin ? '' : ' kme-view-only'}${collapsed ? ' kme-collapsed' : ''}`}>
      <div className="kme-toolbar">
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
        <div className="kme-spacer" />
        <div className="kme-status">
          project: <b>{projectKey || '—'}</b> · {nodes.length} nodes · {edges.length} edges · {status} · <span title="Build timestamp — confirms which bundle is live on this device" style={{ opacity: 0.5 }}>b{typeof __KME_BUILD__ !== 'undefined' ? __KME_BUILD__ : '?'}</span>
        </div>
      </div>
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
          fitView
          /* iPad PWA: cap how small RF can shrink nodes when fitting.
             Without this, fit-view often lands around 0.55-0.65 which
             makes 50 px CSS buttons render as ~30 visible px — finger
             contact area exceeds button bounds. minZoom 0.85 keeps
             buttons ~42 visible px so a tap lands cleanly. */
          minZoom={0.85}
          maxZoom={2.5}
          colorMode="dark"
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#30363d" />
          <Controls />
          <MiniMap pannable zoomable maskColor="rgba(13, 17, 23, 0.7)" nodeColor="#30363d" />
        </ReactFlow>
      </div>
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
