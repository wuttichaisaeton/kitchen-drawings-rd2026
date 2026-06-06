# Nest "Run Temp" — ad-hoc one-off cut, no persistence

**Date:** 2026-06-07
**Area:** `drawings-ui/nest.js` (Web Nest workspace, Group 2)
**Requested by:** เอ๋ — *"Nesting ต้องการมีปุ่ม run temp ใช้ในกรณีต้องการ part บางตัวที่ขาด หรือตกหล่น รันเพื่อส่งไปตัดแค่นั้น ไม่ต้องจำอะไร รัน เสร็จมีปุ่มให้ download temp ถ้าไม่ download ก็ลบ เป็นปุ่มเดียวกัน"*

## Problem

When a part is missing or got dropped from a cut run, เอ๋ needs to nest **just that part (or a few)** and send the DXF straight to the laser — without it touching any saved project data (no `nest_jobs`, no `nest_parts`, no GitHub `cut_sheets`, no remnant pool). The regular `▶ Run Nesting` + `💾 Save Project` flow always persists and works off the loaded project parts list, which is the wrong tool for a quick one-off.

## Goal

A self-contained **`⚡ Run Temp`** button that:
1. Lets เอ๋ type ad-hoc `code` + `qty` rows (independent of the project parts list).
2. Nests them (reusing the existing packer + current sheet stock).
3. Shows a per-sheet preview to verify before cutting.
4. Offers a one-click **`⬇ Download Temp`** that downloads the cut-sheet DXF(s) locally.
5. Persists **nothing** — if not downloaded, the result is simply discarded.

## Non-goals

- No upload to GitHub / no RTDB writes / no remnant auto-save.
- Does not read or modify the project parts list (`S.parts`) or the main nest result (`S.flatSheets`).
- No "saved temp jobs" history (the whole point is ephemerality).
- No new stock entry UI — temp reuses the stock rows already configured in the workspace.

## Approach (chosen: A — isolated modal)

A dedicated modal owns the entire temp lifecycle. All temp state lives in **modal-local variables**, never in `S`. Closing the modal garbage-collects everything ⇒ "ไม่ต้องจำอะไร" is satisfied structurally, not by cleanup code.

Rejected alternatives:
- **B. Inline temp mode on the main canvas** — would reuse `S.flatSheets` and risk accidental Save / clobbering a prior normal run; more state-flag plumbing.
- **C. Run → download immediately** — no preview to verify before cutting; doesn't match the requested toggle button.

## UI

New button in the nest toolbar (near `#kdnest-run` / Save Project):

```
⚡ Run Temp
```

Clicking opens a modal (`.kdtemp-*`, reusing the `.kdstock-*` / `.kdjobs-*` frame + backdrop/✕/Esc/backdrop-click close conventions already in nest.js).

**Modal body:**
- **Entry table** — rows of `[ code ]  [ qty ]  [✕]`, starting with one empty row, plus a `+ Add` button. Blank qty defaults to 1. Pasting multiple lines into the code field is acceptable (best-effort split), but the structured rows are the primary input. No-Thai rule applies to all rendered labels.
- **Primary button (single, toggles state):**
  - **State 1 — `⚡ Run`**
  - **State 2 — `⬇ Download Temp`** (shown only after a successful run)
- **Result area** (appears after Run): a `<canvas>` preview drawn by the existing `_drawSheet(canvas, sheet)`, with prev/next sheet controls when there is more than one sheet, plus a summary line.

## Data flow

### State 1 — Run
1. Read entry rows → `[{code, qty}]`, drop blank-code rows, qty→`parseInt||1`.
2. For each unique code, resolve metadata from `uploaded_dxfs/<code>` (RTDB `firebaseDB.ref('uploaded_dxfs/'+code).once('value')`, or a single `uploaded_dxfs` read then index). Build a temp part shell `{code, qty, dxfUrl, thickness, grain, selected:true, manual:false, polys:null, bbox:null, w:0, h:0}`.
3. Resolve grain via the same grain.json rules the main list uses (reuse the existing grain-rule lookup helper; fall back to meta grain / `ANY`).
4. **Fetch + parse geometry** with the extracted helper `_loadDxfInto(part)` (see Refactor). Sets `polys`, `bbox`, `w`, `h`, `dxfLoaded`/`dxfError`.
5. Classify codes:
   - **not-found** — no `uploaded_dxfs` entry / no `dxfUrl`.
   - **no-geometry** — fetch/parse failed (`dxfError`).
   - **ok** — has bbox + w/h.
6. Build pieces from ok parts exactly as `_runNesting` does (qty copies, rotations gated by grain).
7. Group pieces by thickness (`thickKey`); for each group run `_nestMultiSheet(group, stockForThick, S.gap, S.mode)` where `stockForThick` = active `S.sheetStock` rows of that thickness. **Remnants are never added** (temp = skipRemnants forced true).
8. Collect `tempSheets` (each `{thick, sw, sh, placements, fromRemnant:null}`) and `tempUnplaced` into **modal-local vars**.
9. Render: draw sheet 0 via `_drawSheet`, enable sheet nav, show summary:
   `N sheets · placed P · unplaced [codes] · not found [codes] · no DXF [codes]`.
10. Toggle primary button to **`⬇ Download Temp`**. If `tempSheets` is empty (nothing packed), keep button as `⚡ Run` and show only the error summary (nothing to download).

### State 2 — Download Temp
1. For each `tempSheet`: `dxf = _buildSheetDxf(sheet)` → `Blob([dxf], {type:'application/dxf'})` → object URL → trigger download named `TEMP_<YYYYMMDD_HHMMSS>_s<N>.dxf` (timestamp from `_jobStamp()`), spacing multiple downloads ~250 ms apart (same anti-dedupe trick as Cut List "Download all").
2. Revoke object URLs after use.
3. Close the modal (download = done). Re-opening starts fresh.

### Discard
- Closing the modal (✕ / backdrop / Esc) at any point without downloading: modal DOM removed, modal-local vars dropped. Nothing was ever written anywhere.
- Running again inside the modal recomputes and replaces the local result.

## Refactor (targeted, low-risk)

Extract a single-part loader from `_loadAllDxfs`:

```js
async function _loadDxfInto(p) {
  if (!p.dxfUrl) { p.dxfError = 'No DXF uploaded yet'; return; }
  try {
    const resp = await fetch(_toJsdelivrUrl(p.dxfUrl), { cache: 'force-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const ex = _extractPolygons(window.dxf.parseString(await resp.text()));
    p.polys = { outer: ex.outer, strokes: ex.strokes || [], holes: ex.holes };
    p.bbox = ex.bbox;
    if (ex.bbox) { p.w = Math.round(ex.bbox[2]-ex.bbox[0]); p.h = Math.round(ex.bbox[3]-ex.bbox[1]); }
    p.dxfLoaded = true;
  } catch (e) { p.dxfError = String(e.message || e); }
}
```

`_loadAllDxfs` becomes `await Promise.all(S.parts.map(p => _loadDxfInto(p)))` after `_ensureDxfLib()`. Run Temp calls `await _ensureDxfLib()` then `_loadDxfInto(part)` per temp code. Behaviour of the normal load path is unchanged.

## Reused building blocks

| Need | Existing fn | Notes |
|------|-------------|-------|
| Core packer | `_nestMultiSheet(pieces, stock, gap, mode)` | already param-driven |
| DXF fetch+parse | `_loadDxfInto` (new, from `_loadAllDxfs`) | |
| Sheet preview | `_drawSheet(canvas, sheet)` | |
| Cut-sheet DXF | `_buildSheetDxf(sheet)` | |
| Timestamp | `_jobStamp()` | filename |
| Modal frame/CSS | `.kdstock-*` / `.kdjobs-*` patterns | + new `.kdtemp-*` |

## Error handling

- Empty entry (no valid code rows) → inline message, no run.
- No usable stock (`S.sheetStock` all blank) → reuse the same guard text as `_runNesting`.
- Per-code failures surfaced in the summary (not-found / no-DXF), never thrown.
- Unplaced pieces listed in the summary; sheets that DID pack are still downloadable.
- Download of a sheet that fails to build → skip + note; don't abort the batch.

## Testing

- **Pure-logic check (node):** the piece-building + thickness-grouping for a temp set produces the same shape as `_runNesting` for the same inputs (compare against a hand-built expectation; no DOM).
- **Manual (live, admin):** enter one valid missing code → Run → preview shows → Download → DXF opens in a viewer; confirm `nest_jobs`/`nest_parts`/`cut_sheets` in RTDB + GitHub are unchanged (Firebase console / repo). Enter a bogus code → shows "not found", no crash. Close without download → nothing persisted.
- **No-regression:** `▶ Run Nesting` + `💾 Save Project` still behave as before (the `_loadAllDxfs` refactor is behaviour-preserving).

## Files touched

- `drawings-ui/nest.js` — new `⚡ Run Temp` button + handler, temp modal render, `_runTemp*` helpers, `_loadDxfInto` extraction.
- `drawings-ui/style.css` — `.kdtemp-*` (or reuse `.kdstock-*`; add only what differs).
- No bundling step (nest.js loads directly). Push → Pages deploy.
