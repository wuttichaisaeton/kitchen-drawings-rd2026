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

// ── Custom node ─────────────────────────────────────────────────────
function MindmapNode({ id, data, selected }) {
  const { label, fusion_link, kind, qty, admin } = data;
  const isBom = kind === 'bom';
  const linked = !!fusion_link;
  const labelRef = useRef(null);
  const [editing, setEditing] = useState(false);

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

  const cls = ['kme-node'];
  if (selected) cls.push('kme-selected');
  if (linked) cls.push('kme-linked');
  if (isBom) cls.push('kme-bom');
  if (!admin) cls.push('kme-view-only');

  return (
    <div className={cls.join(' ')} onDoubleClick={startEdit}>
      <Handle type="target" position={Position.Left} />
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
        <div className="kme-node-qty">x{qty}</div>
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

const nodeTypes = { mindmap: MindmapNode };

// ── Main editor ─────────────────────────────────────────────────────
function Editor({ projectKey, initialNodes, initialEdges, onChange, admin }) {
  const [nodes, setNodes] = useState(initialNodes || []);
  const [edges, setEdges] = useState(initialEdges || []);
  const [selectedId, setSelectedId] = useState(null);
  const [status, setStatus] = useState(admin ? 'ready (admin)' : 'view only');
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

  // Inject onLabelChange + admin flag into every node's data so
  // MindmapNode can react. admin gating happens at the node level too
  // because contentEditable + double-click-to-edit are per-node UX.
  const nodesWithHandlers = useMemo(() => nodes.map((n) => ({
    ...n,
    type: 'mindmap',
    data: { ...n.data, onLabelChange, admin },
    draggable: admin,
    // Selectable always — view-only users can still highlight to read
    // node_id (via clipboard auto-copy below).
  })), [nodes, onLabelChange, admin]);

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

  return (
    <div className={`kme-root${admin ? '' : ' kme-view-only'}`}>
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
