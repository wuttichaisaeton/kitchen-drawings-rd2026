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
    window.open(fallbackUrl, '_blank', 'noopener');
    return { ok: true, via: 'web' };
  }
  return { ok: false };
}

// ── Project center node ─────────────────────────────────────────────
// Circle with 3D cubes icon + PROJECT label INSIDE the circle + project
// code below. Click opens the project's master PDF (same as the SVG
// .mm-center click used to). Admin can drag it; workshop view-only.
function ProjectCenterNode({ id, data, selected }) {
  const { label, code, projectKey, collapsed, onToggleCollapsed } = data;
  const displayCode = code || label || projectKey;
  // Defer single-click action so a double-click can pre-empt it. UX:
  //   single click → toggle expand/collapse (balls in / balls out)
  //   double click → open the project's master PDF
  const clickTimerRef = useRef(null);
  const onClickCenter = useCallback((e) => {
    e.stopPropagation();
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      onToggleCollapsed?.();
    }, 220);
  }, [onToggleCollapsed]);
  const onDoubleClickCenter = useCallback((e) => {
    e.stopPropagation();
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    const pk = projectKey || code || label;
    if (!pk) return;
    const api = window.kdAPI || {};
    const url = api.projectPdfUrl?.(pk) || api.pdfUrlForCode?.(pk);
    if (url) window.open(url, '_blank', 'noopener');
    else window.alert(`No project PDF found for ${pk}`);
  }, [projectKey, code, label]);
  const cls = ['kme-center'];
  if (selected) cls.push('kme-selected');
  if (collapsed) cls.push('kme-center-collapsed');
  return (
    <div
      className={cls.join(' ')}
      onClick={onClickCenter}
      onDoubleClick={onDoubleClickCenter}
      title={`Click: ${collapsed ? 'expand' : 'collapse'} · Double-click: open project PDF (${displayCode})`}
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
          isLeaf, isWrapper, status, urn, drawing_urn } = data;
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
    if (!code || !projectKey) return;
    api.markBent?.(projectKey, code, !bent);
    bump();
  }, [code, projectKey, bent, api, bump]);

  const onAssembled = useCallback((e) => {
    e.stopPropagation();
    if (!code || !projectKey) return;
    api.markAssembled?.(projectKey, code, !assembled);
    bump();
  }, [code, projectKey, assembled, api, bump]);

  const onTimer = useCallback((e) => {
    e.stopPropagation();
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
    if (!code) return;
    const url = api.pdfUrlForCode?.(code);
    if (url) window.open(url, '_blank', 'noopener');
  }, [code, api]);

  // Leaf-click routing — for nodes with no children + a drawing.
  // Routes per feedback_leaf_click_routing: status=missing → Fusion 3D,
  // drawn/stale/deleted → drawing .f2d, fallback to PDF.
  const onClickBody = useCallback((e) => {
    if (!isLeaf || !isBom || isWrapper) return;
    if (e.target.closest('.kme-mini, .kme-link-badge, [contenteditable="true"]')) return;
    if (e.detail !== 1) return;  // single click only (dbl-click = edit)
    if (api.routeLeaf) {
      api.routeLeaf({ code, status, urn, drawing_urn });
    } else if (code) {
      const url = api.pdfUrlForCode?.(code);
      if (url) window.open(url, '_blank', 'noopener');
    }
  }, [isLeaf, isBom, isWrapper, code, status, urn, drawing_urn, api]);

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

  // Family color drives border + bottom tint
  const style = isBom && color ? {
    borderColor: color,
    background: `linear-gradient(180deg, #161b22 60%, ${tint || '#161b22'} 100%)`,
  } : undefined;

  return (
    <div
      className={cls.join(' ')}
      style={style}
      onClick={onClickBody}
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
          <span className="kme-node-qty">x{qty}</span>
        )}
        {missing && isBom && (
          <span className="kme-missing-badge" title="No PDF yet — drag a PDF onto this node to upload">⚠ NO PDF</span>
        )}
        {uploading && (
          <span className="kme-missing-badge" style={{ background: '#1f6feb', color: '#fff' }}>uploading…</span>
        )}
        {comments.length > 0 && (
          <span className="kme-comment-count" title={`${comments.length} comments`}>💬{comments.length}</span>
        )}
      </div>
      {isBom && (
        <div className="kme-row kme-row-actions">
          <button
            className={`kme-mini kme-timer ${timerRunning ? 'kme-on' : ''}`}
            onClick={onTimer}
            title={timerRunning ? 'Stop timer' : 'Start timer'}
          >
            {timerRunning ? '⏸' : '▶'}
            {timerSec > 0 && <span className="kme-timer-elapsed">{api.formatDuration?.(timerSec)}</span>}
          </button>
          {admin && timerSec > 0 && (
            <button className="kme-mini kme-timer-reset" onClick={onResetTimer} title="Edit / reset timer">↺</button>
          )}
          <span className="kme-spacer-mini" />
          <button
            className={`kme-mini kme-bent ${bent ? 'kme-on' : ''}`}
            onClick={onBent}
            title={bent ? 'Mark as not bent' : 'Mark bent'}
          >
            <img src="icons/bending.svg" alt="bend" />
          </button>
          <button
            className={`kme-mini kme-assembled ${assembled ? 'kme-on' : ''}`}
            onClick={onAssembled}
            title={assembled ? 'Mark as not assembled' : 'Mark assembled'}
          >
            🧩
          </button>
          {code && api.pdfUrlForCode?.(code) && (
            <button className="kme-mini kme-pdf" onClick={onOpenPdf} title="Open PDF">📄</button>
          )}
        </div>
      )}
      {linked && (
        <div
          className="kme-link-badge"
          title={`Open ${fusion_link.master_code || 'file'} in Fusion`}
          onClick={openLink}
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

function _nodeIntersect(intersect, target) {
  // Where does the line from `target.center` to `intersect.center` cross
  // `intersect`'s bounding box? Solved analytically — no per-frame DOM.
  const w = intersect.measured?.width || intersect.width || 140;
  const h = intersect.measured?.height || intersect.height || 60;
  const cx = intersect.internals.positionAbsolute.x + w / 2;
  const cy = intersect.internals.positionAbsolute.y + h / 2;
  const tw = target.measured?.width || target.width || 140;
  const th = target.measured?.height || target.height || 60;
  const tcx = target.internals.positionAbsolute.x + tw / 2;
  const tcy = target.internals.positionAbsolute.y + th / 2;
  const w2 = w / 2;
  const h2 = h / 2;
  const dx = tcx - cx;
  const dy = tcy - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  // Scale so we hit the box edge exactly
  const scale = Math.max(absDx / w2, absDy / h2);
  return { x: cx + dx / scale, y: cy + dy / scale };
}

function _edgeEnds(source, target) {
  return {
    sx: _nodeIntersect(source, target).x,
    sy: _nodeIntersect(source, target).y,
    tx: _nodeIntersect(target, source).x,
    ty: _nodeIntersect(target, source).y,
  };
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
// the project view remembers whether it was last expanded or collapsed.
const LS_COLLAPSED = 'kme_collapsed_v1';
function _getCollapsed(pk) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_COLLAPSED) || '{}');
    return !!all[pk];
  } catch { return false; }
}
function _setCollapsed(pk, val) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_COLLAPSED) || '{}');
    if (val) all[pk] = true; else delete all[pk];
    localStorage.setItem(LS_COLLAPSED, JSON.stringify(all));
  } catch {}
}

function Editor({ projectKey, initialNodes, initialEdges, onChange, admin, deepLinkCode }) {
  const [nodes, setNodes] = useState(initialNodes || []);
  const [edges, setEdges] = useState(initialEdges || []);
  const [selectedId, setSelectedId] = useState(null);
  const [status, setStatus] = useState(admin ? 'ready (admin)' : 'view only');
  const [collapsed, setCollapsedState] = useState(() => _getCollapsed(projectKey));
  const toggleCollapsed = useCallback(() => {
    setCollapsedState(c => {
      const next = !c;
      _setCollapsed(projectKey, next);
      return next;
    });
  }, [projectKey]);
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

  // Inject onLabelChange + admin flag into every node's data so the
  // node components can react. admin gating happens at the node level
  // too because contentEditable + double-click-to-edit are per-node UX.
  // Pick component type from data.kind — 'project' → ProjectCenterNode,
  // anything else → MindmapNode (handles BOM + Custom).
  const nodesWithHandlers = useMemo(() => nodes.map((n) => ({
    ...n,
    type: n.data?.kind === 'project' ? 'project' : 'mindmap',
    data: {
      ...n.data,
      onLabelChange, admin,
      // ProjectCenterNode uses these for the click toggle UX.
      ...(n.data?.kind === 'project' ? { collapsed, onToggleCollapsed: toggleCollapsed } : {}),
    },
    draggable: admin,
  })), [nodes, onLabelChange, admin, collapsed, toggleCollapsed]);

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
    setEdges((eds) => addEdge({ ...conn, id: `e_${Date.now().toString(36)}` }, eds));
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
          project: <b>{projectKey || '—'}</b> · {nodes.length} nodes · {edges.length} edges · {status}
        </div>
      </div>
      <div className="kme-canvas">
        <ReactFlow
          nodes={nodesWithHandlers}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onSelectionChange={onSelectionChange}
          nodesDraggable={admin}
          nodesConnectable={admin}
          edgesUpdatable={admin}
          elementsSelectable={true}
          fitView
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
