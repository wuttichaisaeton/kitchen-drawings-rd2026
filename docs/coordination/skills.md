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
Owns the web app (vanilla JS, GitHub Pages, Firebase RTDB). Skills:
- **Mindmap/assembly editor** (`editor/main.jsx` React Flow + `editor/style.css`; build `npm run build:editor` -> commit BOTH bundles): §1 cabinet board-cards (leaf list), §3 mindmap, collapse/Show-all TOGGLE, No-PDF filter, node comments, big logo-circle center, family colours (`_famColor`).
- **Mindmap layout** (`app.js _buildBomNodes`): 16-cabinet ring + staggered-annulus radial (provably 0-overlap); `buildProjectTree` deep-hierarchy walk (`is_wrapper`); `_applyOverrides` blanket-freeze logic.
- **Library** (`app.js renderFamily` + DRAWINGS tab): part-rows, leading-icon -> PDF, DXF, Compare, GitHub-PAT PDF upload.
- **Web Nesting** (`nest.js`), **Sim.Bending** view, **themes** (`kd_theme_v1`), **publish-drawing** skill.
- **Deploy:** push main -> GitHub Pages (~1min; `.nojekyll` = static, NO Jekyll -> board UTF-8 issues can't break it); `gh run watch` to success.
- **Conventions:** no Thai in rendered UI (Flux Architect) except Comments; commit explicit-path (never `-A`); pull --rebase before push; board appends UTF-8 only; verify before done; report with ⏱ elapsed.

## GA — Antigravity
- (GA to fill in — lane TBD by เอ๋.)

## G3 — Canva
- (G3 to fill in.) Expected: Canva design / presentations (cover→iso→plan→section→price-list layouts), brand assets, render decks.

## GW — Claude Cowork (renderers + documents + analysis)
Lane = the things Claude Cowork is strongest at; เอ๋ onboarded GW 2026-06-09.
- **Stainless renderers (`_MASTERS/renderers/`):** PNG drawing composition with PIL —
  `compose_l_shape_master_v3.py` (LOCKED layout 24 Apr: 2×2 left grid PLAN+ELEV1 / ELEV2+PERSP,
  tall right column LEGEND+SELECTIONS, full-width title strip), `selections_panel.py`
  (auto_trim JSON→PNG), I/U/L masters, LEGEND v9. Owns customer-facing output.
  **English-only in Flux Architect font** (cannot render Thai); avoid `×`/`deg`/`·`/`( )` in Flux text.
  Flux filenames use SPACES: `Flux Architect Bold.ttf` etc.; Thai = DRC-RCW2550.ttf, sig = Signerica_Fat.ttf.
- **Document generation:** Word (.docx), Excel (.xlsx), PowerPoint (.pptx), PDF — reports,
  spec sheets, price lists, BOM/cut-list exports, accountant/handoff packets.
- **Python / data:** scripting, data analysis, CSV/JSON wrangling, batch image ops, manifest/spec parsing.
- **Web research** (search + fetch) and **file organization** in the workspace.
- **Sandbox shell** (Linux) for running Python/Node, image pipelines, one-off jobs.
- Reporting: per the working model — direct order from เอ๋ → GW reports straight back; routed via G1 → G1 consolidates.
- Same shared-tree rules: isolate via branch/worktree, explicit-path commits, pull --rebase before push.
