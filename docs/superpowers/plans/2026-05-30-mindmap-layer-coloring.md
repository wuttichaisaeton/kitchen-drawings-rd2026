# Mindmap Layer Coloring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Color React Flow mindmap nodes and their incoming edges by depth layer (hops from the Project center), so each concentric ring is one color, deepening outward.

**Architecture:** One post-build BFS pass in `app.js` (`_applyLayerColors`) assigns each node a depth from the center node and overwrites `data.color`/`data.tint` (and each edge's stroke) using a `_layerColor(depth)` HSL ramp. The editor (`editor/main.jsx`) is relaxed by one condition so container cards (wrappers / variant roots) also show their layer color.

**Tech Stack:** Vanilla JS (`app.js`, loads directly — no build), React Flow editor bundled with esbuild (`editor/main.jsx` → `npm run build:editor`). No JS unit-test runner; `app.js` top-level functions are global on `window`, so verification is done via `preview_eval` against the running dev server at `localhost:3030`.

**Spec:** `docs/superpowers/specs/2026-05-30-mindmap-layer-coloring-design.md`

---

## Preconditions

- Dev server running at `localhost:3030` (preview MCP `serverId` from `preview_list`).
- For editor checks, set admin + open a project: in `preview_eval`,
  `localStorage.setItem('kd_admin_v1','1')`, reload, navigate Projects → open "Bung 01".
- Screenshots are unreliable in this environment — assert via DOM/`window` calls, not images.

## File Structure

- `app.js` — add two functions near the other editor-graph helpers (`_familyColors` is at ~line 4022; the graph builder returns `{ nodes, edges }` at ~line 4273):
  - `_layerColor(depth)` — pure palette function (border `color` + dark `tint`).
  - `_applyLayerColors(nodes, edges, centerId)` — BFS depth + recolor nodes & edges.
  - one call site before the auto-graph `return { nodes, edges }`.
- `editor/main.jsx` — relax the node-chrome gate (~line 368) so all BOM nodes get the colored border+tint; rebuild bundle.

---

### Task 1: `_layerColor(depth)` palette helper

**Files:**
- Modify: `app.js` (add helper just above `function _familyColors(` ~line 4022)

- [ ] **Step 1: Add the helper**

Insert immediately above `function _familyColors(famKey) {`:

```js
// Layer palette — node + edge color by depth from the Project center.
// HSL ramp so ANY depth resolves to a color (no cap); deeper layers keep
// rotating hue. Tweak these four constants to restyle every layer at once.
const _LAYER_BASE_HUE = 38;   // layer 1 ≈ gold
const _LAYER_HUE_STEP = 48;   // degrees added per deeper layer
const _LAYER_SAT = 62;        // border/edge saturation %
const _LAYER_LIGHT = 60;      // border/edge lightness %
function _layerColor(depth) {
  const hue = ((_LAYER_BASE_HUE + (depth - 1) * _LAYER_HUE_STEP) % 360 + 360) % 360;
  return {
    color: `hsl(${hue}, ${_LAYER_SAT}%, ${_LAYER_LIGHT}%)`,  // border + edge stroke
    tint:  `hsl(${hue}, 40%, 18%)`,                          // dark fill endpoint over #161b22
  };
}
```

- [ ] **Step 2: Verify in the page (reload first to load the new app.js)**

`preview_eval`:
```js
(() => { location.reload(); return 'reloading'; })()
```
then `preview_eval`:
```js
({
  isFn: typeof window._layerColor,
  l1: window._layerColor(1),
  l2: window._layerColor(2),
  l8: window._layerColor(8),
})
```
Expected: `isFn:"function"`, `l1.color:"hsl(38, 62%, 60%)"`, `l2.color:"hsl(86, 62%, 60%)"`, `l8.color` a valid `hsl(...)` (hue wrapped into 0–359). No console errors (`preview_console_logs level:error`).

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat(editor): add _layerColor depth palette helper"
```

---

### Task 2: `_applyLayerColors` — BFS depth + recolor nodes & edges

**Files:**
- Modify: `app.js` (add function just above the graph builder's `return { nodes, edges };` at ~line 4273, then call it)

- [ ] **Step 1: Add the function**

Insert just above the `return { nodes, edges };` that follows the `emitEdge`/`placeSubtree`/legacy-ring layout (the auto-generated graph builder, ~line 4273):

```js
  // Post-build pass: depth = hops from the Project center along the directed
  // center→child edges. Recolor every BOM node (incl wrapper / variant-root
  // containers) and each incoming edge by layer. Center stays its blue anchor.
  function _applyLayerColors(nodes, edges, centerId) {
    const adj = new Map();
    for (const e of edges) {
      if (!adj.has(e.source)) adj.set(e.source, []);
      adj.get(e.source).push(e.target);
    }
    const layerOf = new Map([[centerId, 0]]);
    const queue = [centerId];
    while (queue.length) {
      const id = queue.shift();
      const d = layerOf.get(id);
      for (const t of (adj.get(id) || [])) {
        if (!layerOf.has(t)) { layerOf.set(t, d + 1); queue.push(t); }
      }
    }
    const byId = new Map(nodes.map(n => [n.id, n]));
    for (const [id, depth] of layerOf) {
      if (depth < 1) continue;                       // skip center (layer 0)
      const node = byId.get(id);
      if (!node || node.data?.kind !== 'bom') continue;
      const { color, tint } = _layerColor(depth);
      node.data.color = color;
      node.data.tint = tint;
      node.data.layer = depth;                        // exposed for verification/debug
    }
    for (const e of edges) {
      const depth = layerOf.get(e.target);
      if (depth == null || depth < 1) continue;
      e.style = { ...(e.style || {}), stroke: _layerColor(depth).color };
    }
  }
```

- [ ] **Step 2: Call it before the return**

Change:
```js
  return { nodes, edges };
```
to:
```js
  _applyLayerColors(nodes, edges, `project:${projectKey}`);
  return { nodes, edges };
```
(This is the auto-graph builder's return ~line 4273 — NOT the custom-RTDB return ~line 3987, which stays untouched per spec.)

- [ ] **Step 3: Unit-verify the pass on a synthetic graph**

Reload, then `preview_eval`:
```js
(() => {
  const nodes = [
    { id:'project:x', data:{ kind:'project' } },
    { id:'bom:a',     data:{ kind:'bom', color:'#888', tint:'#222' } },  // layer 1
    { id:'bom:b',     data:{ kind:'bom', color:'#888', tint:'#222' } },  // layer 2
    { id:'bom:c',     data:{ kind:'bom', color:'#888', tint:'#222' } },  // layer 3
  ];
  const edges = [
    { id:'e1', source:'project:x', target:'bom:a', style:{ stroke:'#000', opacity:0.5 } },
    { id:'e2', source:'bom:a',     target:'bom:b', style:{ stroke:'#000', opacity:0.5 } },
    { id:'e3', source:'bom:b',     target:'bom:c', style:{ stroke:'#000', opacity:0.5 } },
  ];
  window._applyLayerColors(nodes, edges, 'project:x');
  return {
    layers: nodes.map(n => n.data.layer ?? 'none'),
    aColor: nodes[1].data.color, bColor: nodes[2].data.color,
    e1stroke: edges[0].style.stroke, e1opacityKept: edges[0].style.opacity,
    e3stroke: edges[2].style.stroke,
  };
})()
```
Expected: `layers:["none",1,2,3]` (project untouched), `aColor:"hsl(38, 62%, 60%)"`, `bColor:"hsl(86, 62%, 60%)"`, `e1stroke:"hsl(38, 62%, 60%)"`, `e1opacityKept:0.5` (existing edge style preserved), `e3stroke:"hsl(134, 62%, 60%)"`.

- [ ] **Step 4: Integration-verify on Bung 01**

Set admin, reload, open Bung 01 (see Preconditions). Then `preview_eval`:
```js
(() => {
  const borders = [...document.querySelectorAll('.kme-node')]
    .map(el => getComputedStyle(el).borderColor)
    .filter(Boolean);
  const distinct = [...new Set(borders)];
  return { nodeCount: borders.length, distinctBorderColors: distinct.length, sample: distinct.slice(0,6) };
})()
```
Expected: `nodeCount` ≈ 28 (BOM nodes), `distinctBorderColors` ≥ 2 (multiple layers present), no console errors. (Leaf BOM nodes carry the colored border now.)

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "feat(editor): color mindmap nodes + edges by depth layer (BFS from Project)"
```

---

### Task 3: Editor chrome gate — color all BOM nodes incl wrappers

**Files:**
- Modify: `editor/main.jsx` (~line 368)
- Build: `editor.bundle.js` via `npm run build:editor`

- [ ] **Step 1: Relax the gate**

At ~line 368, change:
```js
  const skipFamilyChrome = isVariantRoot || isWrapper;
  const style = isBom && color && !skipFamilyChrome ? {
    borderColor: color,
    background: `linear-gradient(180deg, #161b22 60%, ${tint || '#161b22'} 100%)`,
  } : undefined;
```
to:
```js
  // Layer coloring (2026-05-30): every BOM node — including wrapper / variant-
  // root containers — shows its depth-layer color. (The qty badge + family
  // stripe removed on 2026-05-28 are separate elements and stay removed.)
  const style = isBom && color ? {
    borderColor: color,
    background: `linear-gradient(180deg, #161b22 60%, ${tint || '#161b22'} 100%)`,
  } : undefined;
```
If `skipFamilyChrome` is now unused (grep `skipFamilyChrome` in `editor/main.jsx` — it should only appear here), delete its declaration line. If it is referenced elsewhere, leave the declaration and only change the `style` condition.

- [ ] **Step 2: Build the bundle**

Run: `npm run build:editor`
Expected: `editor.bundle.js` + `editor.bundle.css` written, "Done in NNms".

- [ ] **Step 3: Verify wrappers are colored**

Reload, open Bung 01. `preview_eval`:
```js
(() => {
  const roots = [...document.querySelectorAll('.kme-node.kme-variant-root')];
  return {
    variantRoots: roots.length,
    borders: roots.map(el => getComputedStyle(el).borderColor).slice(0,4),
    allColored: roots.length === 0 ? 'n/a' : roots.every(el => {
      const b = getComputedStyle(el).borderColor;
      return b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent';
    }),
  };
})()
```
Expected: if `variantRoots > 0`, `allColored:true` (each container card has a non-transparent layer-colored border). No console errors. Confirm collapse/expand a cluster still works (`preview_click` a variant-root, then re-snapshot node count changes).

- [ ] **Step 4: Commit**

```bash
git add editor/main.jsx editor.bundle.js editor.bundle.css
git commit -m "feat(editor): show layer color on container cards (wrappers + variant roots)"
```

---

### Task 4: Final verification, deploy, cleanup

**Files:**
- Delete: `_mock_layers.html` (scratch mockup, never committed)

- [ ] **Step 1: Remove the scratch mockup**

Run: `rm _mock_layers.html`
(Confirm it was never tracked: `git status --short _mock_layers.html` shows nothing tracked.)

- [ ] **Step 2: Full reload sanity pass**

Reload Bung 01. `preview_eval` for the center anchor + status preserved:
```js
(() => {
  const center = document.querySelector('.kme-node'); // project center renders first
  const missing = document.querySelectorAll('.kme-missing-badge, [class*="missing"]').length;
  return {
    hasNodes: document.querySelectorAll('.kme-node').length,
    consoleClean: 'check preview_console_logs separately',
    statusBadgesPresent: missing,
  };
})()
```
Expected: nodes present, status badges still rendered, `preview_console_logs level:error` empty.

- [ ] **Step 3: Push + watch deploy**

```bash
git pull --rebase origin main
git push origin main
```
Then watch the latest run to `completed / success` (`gh run list --limit 1 --json databaseId -q '.[0].databaseId'` → `gh run watch <id> --exit-status`) and confirm the live bundle at the REAL Pages host carries the change:
```bash
curl -s "https://wuttichaisaeton.github.io/kitchen-drawings-rd2026/app.js" | grep -c "_applyLayerColors"
```
Expected: `>= 1`. (Note: the real Pages host is `wuttichaisaeton.github.io/kitchen-drawings-rd2026`, NOT `kitchen-drawings-rd2026.github.io` — see `reference_pages_url_and_dxf_download` memory.)

- [ ] **Step 4: No board entry needed**

This is a Web-only visual feature — no shared schema/contract/path change, no question for Group 1. Skip `group-sync.md` per the append-only "status/contract-only" protocol.

---

## Self-Review

**Spec coverage:**
- Approach B (node colored by layer) → Task 2 (node `data.color`/`tint`) + Task 3 (editor applies it). ✓
- Layer = real ring incl wrappers → Task 2 BFS counts all nodes; Task 3 un-skips containers. ✓
- No cap → `_layerColor` hue-wraps for any depth (Task 1, verified at depth 8). ✓
- Edges colored by target layer → Task 2 Step 1 edge loop + Step 3 assertion. ✓
- Center stays blue → Task 2 skips `depth < 1`; center node never recolored. ✓
- Family chrome removed from editor nodes only → Task 3 swaps the color source; Library/chips untouched (not modified). ✓
- Custom-RTDB mindmap out of scope → Task 2 Step 2 explicitly targets the auto-graph return only. ✓
- Status/role/collapse unchanged → Task 4 Step 2 checks status badges; Task 3 Step 3 checks collapse. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every check has an expected result. ✓

**Type consistency:** `_layerColor(depth)` returns `{ color, tint }` and is consumed identically in Task 2 (`const { color, tint } = _layerColor(depth)`) and the edge loop (`_layerColor(depth).color`). `_applyLayerColors(nodes, edges, centerId)` signature matches the call `_applyLayerColors(nodes, edges, \`project:${projectKey}\`)`. Node fields used (`n.id`, `n.data.kind`, `n.data.color/tint`) and edge fields (`e.source`, `e.target`, `e.style.stroke`) match the structures confirmed in the spec (emitEdge sets `source`/`target`/`style.stroke`; emitNode sets `data.kind`/`color`/`tint`). ✓
