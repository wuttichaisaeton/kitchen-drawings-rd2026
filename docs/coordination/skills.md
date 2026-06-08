# Agent skills registry

Working model (เอ๋ 2026-06-09): เอ๋ sends work mainly to **G1**, who is the
**default reporting channel** back to เอ๋ (so เอ๋ doesn't check multiple channels).
**Exception:** if เอ๋ gives a task DIRECTLY to a specific agent, **that agent
reports back to เอ๋ itself** (it owns its own reporting — don't route through G1).
Every agent has its own skills below; if a task fits another agent better, that
agent may **pull it** (claim on the board); under heavy load, agents **help each
other**. **Each agent maintains its own section here** — keep it current so
routing is informed.

---

## G1 — Fusion (`_MASTERS/`) + hub/reporter
- **Fusion CC_* tooling:** CC_Assembly (deep occurrence-hierarchy export), CC_SimplePDF / CC_DrawingPDF (drawing export + auto-publish via sync.bat), CC_Switch, CC_TierShift, CC_FillWidths, CC_Convert_NewCode (mass rename), CC_RenameTo13Digits, CC_FillDescriptions, CC_CheckHoles, CC_CheckBend (press-brake bend feasibility), CC_Laser, CC_GrainSync, CC_ExportDXF, CC_Auto (palette + UTILITIES ribbon mirror, Design+Drawing workspaces).
- **Fusion API / MCP**, sheet-metal & bend math (K-factor, bend allowance, mould-line legs, box-bending), naming schemes (Door/Floor/BK/SD/TS/BM/13-digit), BOM/assembly data.
- **Publish pipeline & web data plumbing:** stamp → commit → push → deploy-verify; app.js data-loader (manifest fetch, `_cacheBust`), manifest/aliases, GitHub Pages/CDN behavior.
- **Icon generation** (PIL ribbon icons), git/_MASTERS management.
- **Orchestration:** triage incoming work, route via board `NEEDS`, collect results, give เอ๋ ONE consolidated report (with ⏱ elapsed).

## G2 — Web (`drawings-ui/`)
- (G2 to confirm/expand.) Known: `app.js` `_buildBomNodes` mindmap layout (radial / 16-cabinet ring), `editor/main.jsx` React Flow editor — §1 assembly kanban/tree, §3 mindmap, collapse/Show-all, node comments; `nest.js` web nesting; Sim.Bending view; CSS/themes; Library/GitHub-PAT upload.

## GA — Antigravity
- (GA to fill in — lane TBD by เอ๋.)

## G3 — Canva
- (G3 to fill in.) Expected: Canva design / presentations (cover→iso→plan→section→price-list layouts), brand assets, render decks.
