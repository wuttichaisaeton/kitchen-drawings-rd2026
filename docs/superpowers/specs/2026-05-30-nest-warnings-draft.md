# Nesting workspace warnings (DRAFT — for next session to brainstorm + build)

**Date:** 2026-05-30
**Group:** 2 (Web) — `drawings-ui/` · `nest.js`
**Status:** DRAFT requirements (not yet brainstormed into a final design)

## Why

The Laser **cut list** (app.js) already shows warning sections — "DXF NOT FOUND"
and "GRAIN UNSPECIFIED". The **Nesting workspace** (`nest.js`, screenshot
2026-05-30) shows NONE of these, so a worker can Run Nesting, cut the sheets,
and only later discover a part didn't fit or had an unset grain. เอ๋:
"ควรต้องเตือนเรื่องแนว grain ที่ไม่แน่ใจ + จำนวนขาด อย่างอันนี้งานจะวางไม่ได้
ขาดไปหนึ่งชิ้น ก็ไม่มีการแจ้งเตือน." Also earlier: "ชิ้นนี้ดูแปลกๆ ให้เข้าไป
ดูหน่อย / ชิ้นนี้ไม่มี DXF — แจ้งเตือนในช่อง Grain น่าจะดี."

## Requirements (to refine in brainstorm)

1. **Unplaced / short warning (highest priority — a real cut-the-wrong-sheet
   risk).** After Run Nesting, if `result.unplaced.length > 0`, show a PROMINENT
   banner in the nest workspace: e.g. "⚠ N ชิ้นวางไม่ลง" + the codes/qty.
   Today this is only `console.warn('[kdNest] unplaced pieces:', …)` at
   ~`nest.js:1512` — invisible to the worker.

2. **Grain-unspecified warning.** Aggregate the grain-`?` parts (currently shown
   only as the red `?` glyph per row) into a visible warning, like the cut
   list's "GRAIN UNSPECIFIED (N)" section. Place a per-row marker in/near the
   grain column too (เอ๋: "ในช่อง Grain น่าจะดี").

3. **"Looks weird" / suspicious part (stretch — needs a definition).** Flag parts
   that warrant a manual check. Candidate heuristics to brainstorm:
   - DXF parse error (`p.dxfError`) — already tracked.
   - No DXF (`!p.dxfUrl` / in the "DXF NOT FOUND" set).
   - Parsed bbox vs declared/CSV W×H mismatch beyond a tolerance.
   - Degenerate / tiny / zero-area polygon.
   Show as a per-row warn glyph in the grain/status column + an aggregate.

## Notes for the builder

- `nest.js` is Group 1's engine but additive UI warnings are low-risk. Pull
  first; `git add nest.js` only (shared working dir — their session sweeps broad
  `git add`). nest.js loads directly — no build.
- The nest result lives in `S.flatSheets` + the unplaced set; `window.kdNest._debug()`
  returns `S` for inspection.
- AVOID the local preview MCP for verification (it has been crashing the
  session) — use `node --check` + live-site checks, or a fresh stable session.
- Reuse the cut list's warning styling/markup where possible for consistency.

## Status of the just-shipped work (context)

"Max Remnant" nesting mode shipped + live this session (commits
`4461ed1`/`c697836`/`773de96`, board entry `b43f6e2`). Its overlap-proof gate
was NOT run in-harness (preview died) — เอ๋ to eyeball the first Max Remnant run.
