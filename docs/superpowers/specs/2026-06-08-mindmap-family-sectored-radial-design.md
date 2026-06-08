# Mindmap family-sectored radial layout (no overlap, all nodes visible)

**Date:** 2026-06-08
**Owner:** drawings-ui (web) — project mindmap layout
**Status:** Design approved (เอ๋ chose "Radial แบ่งโซน family", approved the design).

## 1. Problem

The project mindmap (React Flow editor, layout computed in `app.js _buildBomNodes`)
places **every leaf on one outer ring** around the project center and caps the
outer radius:

```js
const Router = Math.min(2600, Math.max(340, MIN_SPACING / slot));
```

With ~90 leaves the required radius is ~2771 px but the **2600 cap** kicks in →
adjacent leaf chord spacing falls to ~182 px < the 194 px (`CARD_W + 26`) needed
→ **cards overlap**. A single 90-node ring also reads as one undifferentiated fan
rather than per-family "ก้อน" (clusters).

เอ๋ wants: **no node hidden behind another**, every node reachable, and parts
grouped into readable family clusters (concept-map style, ref
venngage.com/blog/concept-map-templates radial-cluster + tidy spacing).

## 2. Goal / non-goals

- **In:** a family-sectored radial layout where (a) leaves never overlap
  (guaranteed by geometry), (b) each family is a compact cluster ("ก้อน") in its
  own angular sector with a gap to neighbours, (c) pan/zoom + admin drag
  overrides + fitView keep working.
- **Out (non-goals):** changing the editor render (`editor/main.jsx` only reads
  `node.position`), changing node card content, changing the BOM tree builder
  (`buildProjectTree`), or other mindmap views (Laser cut list / Bend list).
  No new layout library — pure geometry in `_buildBomNodes`.

## 3. Approach (chosen: family-sectored radial)

Revive the per-cluster **local fan** idea (the pre-2026-05-29 "Option A · local
radial per variant" that produced visible ก้อน) but with **computed spacing** so
clusters and their leaves can never overlap, and **no global radius cap**.

Three mechanisms:

1. **Family sectors.** Group the top-level clusters (the `roots` from
   `buildProjectTree` — variant roots / top-level family parents, which already
   align with families) into angular sectors. Each sector gets a gap to its
   neighbours so families read as separate ก้อน.

2. **Per-family multi-row fan (compact blob).** A family's leaves are NOT strung
   along one thin arc. They are laid out in a small **grid of sub-rings** (rows,
   radial) × **angular slots** (columns) local to the family's sector, fanning
   outward from the family's sub-center. A 20-part family becomes a tight blob,
   not a 120° arc. This shrinks the overall radius and makes clusters legible.

3. **No overlap, by construction (uncap).** Radii and per-row slot counts are
   derived so: every angular gap between two cards on the same sub-ring yields a
   **chord ≥ `MIN_SPACING` (194 px)**, and every sub-ring step is **≥ `CARD_H +
   gap`**. Sector widths are sized from each family's blob footprint so adjacent
   families clear each other. The hard 2600 cap is removed (a large sanity cap,
   e.g. 12000, remains only to avoid pathological values).

## 4. Algorithm (in `_buildBomNodes`, replacing the radial block ~7161–7237)

Constants (kept/derived): `CARD_W=168`, `CARD_H=70`, `MIN_SPACING=CARD_W+26=194`,
`ROW_STEP = CARD_H + 40 = 110` (radial gap between a family's sub-rings),
`SECTOR_GAP_FRAC = 0.18` (fraction of each family's arc added as inter-family gap).

```
roots = buildProjectTree(...).roots         // top-level clusters ≈ families
For each cluster C:
  L = leafCount(C)                            // its leaf parts
  // choose how many leaves per sub-ring so the blob is roughly square-ish
  perRow = max(1, round(sqrt(L)))             // tune; small families stay 1 row
  rows   = ceil(L / perRow)

// 1) angular footprint each family needs, at a working leaf radius R_leaf0:
//    a row of `perRow` leaves needs (perRow-1) chords of MIN_SPACING → an arc
//    of width   w(C) = (perRow-1) * (MIN_SPACING / R_leaf0) + slotPad
//    (computed iteratively: R grows until every family's required arc fits in
//     2π minus the inter-family gaps; closed-form below.)

totalLeavesWide = Σ over C of perRow(C)       // widest row across families
gaps            = nFamilies * SECTOR_GAP_FRAC * (avg family arc)
R_leaf0 = max(360, MIN_SPACING * (totalLeavesWide + gapSlots) / (2π))   // uncapped*

// 2) walk families around the circle:
cursorAng = -π/2                              // 12 o'clock
For each cluster C (stable order, e.g. by family name then leaf count):
  famArc = (perRow(C)) * (MIN_SPACING / R_leaf0)         // angular width of its widest row
  famMid = cursorAng + famArc/2
  place family/variant-root node at (R_fam, famMid)      // R_fam = R_leaf0 - ROW_STEP
  // 3) lay leaves in rows × cols inside [cursorAng, cursorAng+famArc]:
  for i, leaf in enumerate(C.leaves):
     row = floor(i / perRow); col = i % perRow
     colsThisRow = (row == lastRow) ? (L - row*perRow) : perRow
     // center each row's columns within famArc
     a = cursorAng + (famArc/2) + (col - (colsThisRow-1)/2) * (MIN_SPACING / Rrow)
     Rrow = R_leaf0 + row * ROW_STEP
     x = Rrow*cos(a);  y = Rrow*sin(a)
     emitNode(leaf, x, y); emitEdge(family → leaf)
  cursorAng += famArc + SECTOR_GAP_FRAC * famArc          // gap to next family
emitEdge(project center → each family node)
```

*`R_leaf0` has no 2600 cap; only a high sanity cap (12000). Because each row holds
only `perRow ≈ √L` leaves (not all L), the required radius is far smaller than the
old single-ring radius, so the map stays compact even uncapped.

Deeper/atypical trees (a cluster with grandchildren, not just leaves): fall back
to the existing recursive radial **with the cap removed** so they still never
overlap (rare; logged).

## 5. Components & isolation

| Unit | Change | Interface |
|------|--------|-----------|
| `app.js _buildBomNodes` (radial block ~7161–7237) | replace radial-tree block with family-sectored fan; keep `emitNode`/`emitEdge`/`leafCount` | inputs unchanged (project, parts, projectKey) → returns `{nodes, edges}` with `position` set |
| `editor/main.jsx` | **none** (reads `node.position`) | — |
| override / pan-zoom / fitView | **none** (admin drag still overrides auto `position`; fitView frames the new bbox) | — |

## 6. Testing / verification

- **Live, image-first** (เอ๋'s rule): run on **"02 Ruth"** (90 nodes) via the
  Claude Preview tool or deploy + screenshot; confirm (a) zero overlap, (b)
  families are distinct blobs with gaps, (c) fitView frames the whole map, (d)
  zoom into a blob reads each card.
- **Regression:** a small project (few nodes) must still look tidy + centered;
  Laser/Bend views untouched; admin drag still sticks.
- **Geometry assertion (offline-ish):** for the 02 Ruth node set, verify no two
  emitted positions are < `MIN_SPACING` apart and no two rows < `ROW_STEP`.

## 7. Open questions (tune during impl, against the live 90-node map)

- `perRow = round(√L)` vs a fixed max-per-row (e.g. 6) — pick whichever blobs
  look best on 02 Ruth.
- Family order around the circle: by family name (stable) vs by leaf count
  (biggest blobs spread out). Default: family name (stable, predictable).
- `SECTOR_GAP_FRAC` / `ROW_STEP` exact values — tune visually.
