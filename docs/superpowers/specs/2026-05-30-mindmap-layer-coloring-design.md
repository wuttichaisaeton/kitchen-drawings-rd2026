# Mindmap layer coloring (canvas colored by depth)

**Date:** 2026-05-30
**Group:** 2 (Web) — `drawings-ui/`
**Status:** design approved, pre-implementation

## Goal

In the React Flow mindmap editor, color nodes (and their incoming edges) by
**depth layer** — how far each node sits from the Project center. The ring
closest to the Project is layer 1, the next ring out is layer 2, and so on.
This makes the tree's structure readable at a glance: each concentric ring is
one color, deepening outward.

User intent (เอ๋, 2026-05-29/30): "canvas แบ่งสีเป็นชั้น — ชั้นที่ 1 ส่วนที่อยู่
ใกล้ Project, ชั้นที่ 2 ส่วนที่ไกลออกไป, เป็นแบบนี้ไปเรื่อยๆ … อยากไล่สีแต่ละชั้น
ไปเรื่อยๆ … อยากให้เส้นไล่สีตามชั้นด้วย."

## Decisions (locked during brainstorming)

- **Approach B** — color the *node itself* by its layer (border + fill).
  Family color no longer drives node chrome in the editor. (Options A =
  background ring-zones, C = hybrid, were rejected.)
- **Layer = real ring count, including structural nodes.** Depth is the number
  of tree hops from the Project node, counting wrapper / variant-root
  (cluster) nodes as their own layer. Every node — including wrappers — gets
  its layer color. No node stays neutral. (This intentionally supersedes the
  2026-05-28 "containers stay neutral" look for node *chrome*; the separate
  qty badge that was removed on 2026-05-28 stays removed.)
- **No layer cap.** Colors continue progressively for arbitrarily deep trees.
- **Edges are colored too** — the edge leading into a layer-N node uses
  layer-N's color.
- **Project center** keeps its existing blue (`#4a90e2`) as the layer-0 anchor.

## Definitions

- **Layer / depth:** shortest hop count from the center node
  `project:<projectKey>` to a node, following the directed (center-outward)
  edges. Center = 0, its direct children = 1, etc.
- **Color source of truth:** a pure function `_layerColor(depth)` returning
  `{ color, tint }` (border color + dark fill tint), driven by an HSL ramp so
  any depth resolves to a color.

## Architecture & data flow

All mindmap layout paths (variant-cluster layout + legacy concentric-ring
layout) converge on a single `return { nodes, edges }` (app.js ~line 4273),
where every edge already carries React Flow `source` / `target` ids and the
center node id is `project:<projectKey>`. So depth is computed in **one
post-build pass**, independent of how nodes were placed — no layout logic
changes.

### New: `_layerColor(depth)` — app.js

Pure helper. For `depth >= 1`:

```
hue   = (38 + (depth - 1) * 48) mod 360   // gold → blue → green → purple → …
color = hsl(hue, 62%, 60%)                // border / edge stroke
tint  = hsl(hue, 40%, 18%)                // dark fill endpoint over #161b22
```

`depth === 0` (the center) is not recolored — the center keeps `#4a90e2`.
Constants (`baseHue`, `hueStep`, `S`, `L`) live at the top of the helper so the
palette is tweakable in one place.

### New: `_applyLayerColors(nodes, edges, centerId)` — app.js

1. Build a directed adjacency map from `edges` (`source → [target, …]`).
2. BFS from `centerId`, recording `layerOf[nodeId]` = hop count. (Tree graph;
   each node has one parent, so BFS depth is well-defined. Any node not
   reachable from center — shouldn't happen — is left at its current color.)
3. For each **BOM node** with `layerOf >= 1`: overwrite `data.color` and
   `data.tint` with `_layerColor(layer)`. The center node is skipped.
4. For each **edge**: set `edge.style.stroke = _layerColor(layerOf[target]).color`,
   preserving the existing `strokeWidth` / `opacity`.

Called once, just before `return { nodes, edges }` (line ~4273). Scope: the
auto-generated graph only. The custom-RTDB admin mindmap path (separate
`return { nodes, edges }` ~line 3987) is **out of scope for v1** — admins may
have set node colors there manually.

### Editor change — editor/main.jsx (1 gate)

Today `skipFamilyChrome = isVariantRoot || isWrapper` suppresses the colored
border+fill on container cards (line ~368). For layer coloring, **all** BOM
nodes must show their layer color, so the node `style` applies whenever
`isBom && color` is present — drop the `!skipFamilyChrome` condition for the
border+background style.

- The qty badge and family stripe removed on 2026-05-28 are governed by other
  code and are NOT re-introduced — only the card border + bottom-tint gradient
  change here.
- `kme-variant-root` class still applies, so cluster cards keep any
  shape/size distinction; only their color now follows the layer.

This is the only editor source change → requires `npm run build:editor` and a
committed `editor.bundle.js`.

## Non-goals / unaffected

- Library family view, family chips, family grouping, `families.json` — all
  untouched. Family is still used everywhere except the editor node chrome.
- Node status indicators (drawn / missing / stale / deleted), role tinting
  (workshop/laser/bend/assemble), dashed-leaf rendering, collapse/expand,
  checklist mode — all unchanged.
- Applies in all roles (it describes structure, not workshop assignment).
- Custom-RTDB admin mindmap coloring — future follow-up.

## Testing / verification

Manual on `localhost:3030` (preview), Bung 01 + at least one deeper project:

- Each concentric ring renders a single, distinct color; deeper rings continue
  the ramp (verify a project with ≥4 layers if available).
- Wrapper / variant-root cards carry their ring's color (not neutral).
- Edges into a ring match that ring's color.
- Center stays blue.
- No console errors; collapse/expand + checklist mode still work; status
  badges still visible.
- `preview_eval` to read computed `data.color` / `layer` per node and assert
  BFS depth matches the visual ring (screenshots are unreliable in this env;
  assert via DOM/data instead).

## Files touched

- `app.js` — add `_layerColor`, add `_applyLayerColors`, call it before the
  auto-graph return. (loads directly, no build)
- `editor/main.jsx` — relax the chrome gate. → `npm run build:editor`, commit
  `editor.bundle.js` (+ `.css` if changed).
