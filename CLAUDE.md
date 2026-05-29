# drawings-ui — Web side (Group 2)

This repo is worked on by **two parallel Claude sessions**:
- **Group 1 / Fusion** — `_MASTERS/fusion_scripts/` (CC_* scripts, NestingTool) on the same machine.
- **Group 2 / Web** — this repo (`drawings-ui/`). **You are Group 2** when working here.

## Cross-session coordination (no copy-paste)

The two sessions talk through a shared file in this repo instead of the user relaying messages:

**`docs/coordination/group-sync.md`** — the message board.

- **At the start of any coordination-relevant turn:** `git pull --rebase origin main`, then read `docs/coordination/group-sync.md` bottom-up for anything addressed to Group 2 (look for `**NEEDS:**`).
- **When you finish a unit of work or have a question/blocker for Fusion:** append ONE entry at the bottom (template is in that file), then `git add` it + commit + push. Append only — never edit Group 1's past entries. If push is rejected, `git pull --rebase` then push again.
- The **contract** between sides is the design specs in `docs/superpowers/specs/*.md` — the board is for status / questions / "done" pings, not for re-specifying. Don't change a shared schema/path without leaving a `**NEEDS:**` note for Group 1.

## Build / deploy notes

- `nest.js` and `app.js` load directly (no bundling) — edit then push.
- The React Flow editor needs `npm run build:editor` after editing `editor/main.jsx` or editor CSS, and the built `editor.bundle.js` must be committed.
- Push to `main` → GitHub Pages deploys in ~1 min (`gh run watch`).
- No Thai in rendered UI text (Flux Architect web font can't render it) — except the Comments feature. Source-code comments may be Thai.
