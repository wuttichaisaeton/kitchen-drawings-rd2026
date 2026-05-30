# Save Project — nest job persistence + part sync — design

**Date:** 2026-05-30
**Group:** 2 (Web) — `drawings-ui/` · `nest.js` + `app.js`
**Status:** APPROVED design (brainstormed)

## Why

Today the Nest workspace's only persistence is `📤 Save sheets to Laser`: it
builds one DXF per nested sheet, uploads to GitHub, and writes
`cut_sheets/<pk>/<id>` (sheet-level meta only — thickness, parts_count, sheet
size). It does **not** save the nest layout, the part edits, the selected stock,
or the manual rectangles. Re-opening a project always re-runs from the manifest,
so any manual work (added rect parts, grain toggles, qty edits, chosen layout)
is lost. Manual rect parts never reach the Laser role at all (the Cut List reads
the manifest + `uploaded_dxfs`, which don't know about them).

เอ๋: "ที่ Nest ให้บันทึกงานด้วย แล้ว sync ไปที่ Laser โดยเปลี่ยนจากปุ่ม save
sheet to laser เป็น save Project แล้วให้บันทึกเก็บไว้เป็นของตัวเอง และ sync ไป
ยัง cut sheet รวมถึง sync รายละเอียด Part ไปด้วย".

## Decisions (from brainstorm)

1. **Re-open behaviour** → always start fresh (re-run from manifest), but add a
   `📂 Saved Jobs` button to load a previously saved job on demand. No auto-restore.
2. **Part sync target** → both: per-cut-sheet (`parts[]` inside each
   `cut_sheets` entry) AND project-level (a `nest_parts/<pk>` snapshot the Laser
   Cut List reads).
3. **Repeat saves** → keep history (multiple jobs under `nest_jobs/<pk>/`), each
   deletable.
4. **Local copy** → both localStorage (latest job per project) AND a JSON file
   export — but the JSON export is a **separate `⬇ Export JSON` button**, NOT an
   auto-download on every save (เอ๋: keep the save action uncluttered).
5. **Restore UI (v1)** → Saved Jobs popover only (reads Firebase). The exported
   JSON is insurance; **no import button in v1**.
6. **Cut List merge** → the Laser Cut List uses the manifest as its base and
   augments from `nest_parts/<pk>`: append nest codes absent from the manifest
   (manual rects), and override grain/qty on rows whose code matches. No
   separate section.

## Architecture

All changes additive, two directly-loaded files (`nest.js`, `app.js`) — no build
step. `git add nest.js app.js` only (shared working dir; never `git add -A`).

### New / changed RTDB paths (all additive)

```
nest_jobs/<pk>/<jobId> = {
  saved_at:   <ms>,
  name:       "<YYYY-MM-DD HH:MM>",      // human label (local time)
  mode, gap, skipRemnants, dontRemember, // run settings
  sheetStock: [{w,h,qty,thickness,label}],
  parts:      [{code, qty, selected, grain, thickness, w, h, manual, dxfUrl}],
  sheets:     [{thick, sw, sh, placements:[{code, x, y, w, h, rot}]}]   // NO polys
}
nest_parts/<pk> = {                       // mirror of the LATEST job (overwritten)
  saved_at, jobId,
  parts: [ ... same shape as nest_jobs.parts ... ]
}
cut_sheets/<pk>/<id> = { ...existing fields...,
  parts: [{code, qty, w, h, grain, thickness, rot}]   // NEW field on each sheet
}
```

- `placements`/`parts` store **no polygons** (polys come from the DXF parse and
  would bloat RTDB). On restore, parts are re-fetched + re-parsed via the
  existing `_loadAllDxfs()`, then polys/bbox re-attached to placements by `code`.
- `jobId` = the save timestamp slug (`<YYYYMMDD_HHMMSS>`), unique per save.
- `nest_parts/<pk>` is a single overwritten node = "what the latest nest run
  produced", which is what the Laser Cut List wants (latest truth).

### nest.js changes

**State:** add `S.lastSavedJobId = null` (informational only; not required for
correctness).

**`_saveSheetsToLaser` → `_saveProject`** (rename + extend). Sequence:
1. Guard `S.flatSheets.length` (as today) + PAT (as today).
2. **Cut sheets** (as today) — build DXF per sheet, GitHub PUT, write
   `cut_sheets/<pk>/<id>`. **New:** attach `parts[]` to each sheet's meta by
   reading that sheet's `placements` (group by code → `{code,qty,w,h,grain,
   thickness,rot}`; grain/thickness from the matching `S.parts` entry).
3. **Nest job** — assemble the job object from `S` (mode, gap, flags, sheetStock,
   parts stripped to the documented fields, sheets stripped to placements
   without polys) and `set('nest_jobs/<pk>/<jobId>')`.
4. **Project snapshot** — `set('nest_parts/<pk>', {saved_at, jobId, parts})`.
5. **Local copy** — `localStorage['kd_nest_job_' + pk] = JSON.stringify(job)`
   (wrapped in try/catch; quota failure is non-fatal).
6. Completion alert: cut sheets uploaded N/fail + "Saved nest job <name>".

**`_exportJobJson`** (new, wired to `⬇ Export JSON`): build the same job object
(does not require a prior save) plus the current `cut_sheets` meta for the
project, then trigger a JSON blob download named `<pk>_nest_<timestamp>.json`
via an object URL (same anchor pattern as `_downloadFile`).

**`_openSavedJobsModal` / `_renderSavedJobsModal`** (new, wired to `📂 Saved
Jobs`): read `nest_jobs/<pk>` once; list rows newest→oldest with
`name · N sheets · M parts`, a load button, and a 🗑 delete (admin-gated like the
Stock/Cut-Sheets deletes). Load → `_restoreJob(job)`. Delete →
`remove('nest_jobs/<pk>/<jobId>')` + re-render the list. Reuses the
`.kdstock-modal` / popover styling already in nest.js.

**`_restoreJob(job)`** (new): set `S.mode/gap/skipRemnants/dontRemember/
sheetStock`; rebuild `S.parts` from `job.parts` (via `_newPart`/`_newManualPart`
then overlay saved fields); `_refreshView()`; then `_loadAllDxfs()` to re-parse
DXFs; then rebuild `S.flatSheets` from `job.sheets`, re-attaching `polys`/`bbox`
to each placement from the now-loaded part of the same `code` (manual rects have
none — drawn as plain rects, as today); `_refreshView()`. Restoring shows the
saved layout without a re-run.

**Buttons** in the actions row (`_viewHtml`): rename `kdnest-save-sheets` label
to `💾 Save Project`; add `📂 Saved Jobs` and `⬇ Export JSON` (admin-gated to
match the existing save/PAT-driven actions). Wire all three in `_wireEvents`.

### app.js changes

**Cut List merge (`_renderCutList`):** after aggregating manifest parts, read
`window.kdNest.nestPartsForProject(projectKey)` (new tiny accessor on the kdNest
public API that returns the cached `nest_parts/<pk>` parts, or `[]`). Then:
- For a nest part whose `code` matches an aggregated row → override that row's
  grain (and qty if the nest qty differs) with the nest value.
- For a nest `code` not in the manifest aggregate (manual rects) → append it as a
  normal cut row (family via `_remapFamilyForCode`, no DXF → shows `⚠ no DXF`
  unless one exists).
Keep everything else (status, download gating) unchanged.

**Cut Sheets popover (`_renderCutSheetsModal`):** if a sheet's meta has `parts[]`,
render a small one-line summary under that sheet row — e.g.
`pieces: CODE×N, CODE×N …` (truncated) — so opening the popover shows which parts
are on each uploaded sheet. Read-only; no layout.

**Sync caches:** `nest_parts` is **owned by app.js** (the Cut List lives there).
Add a `nest_parts` Firebase listener in app.js's `initCutSheetsSync` area
(mirrors the existing `cut_sheets`/`uploaded_dxfs` listeners) → `_nestPartsCache`,
with a local `nestPartsForProject(pk)` accessor used by `_renderCutList`. nest.js
only **writes** the node (step 4 of `_saveProject`); it never reads it. Both
modules share the `window.firebaseDB` handle, so no cross-module call is needed.

### Restore correctness notes

- A saved job references parts by `code`. If a code was removed from the project
  manifest since the save, its DXF re-fetch may fail → that part restores with
  `dxfError` and draws the placeholder, exactly like a live missing DXF. The
  layout placement still renders (rect from saved w/h). Non-fatal.
- Manual rects restore fully from saved `w/h/qty/grain` (no DXF needed).
- `nest_parts/<pk>` overwrite means the Cut List always reflects the most recent
  Save Project, not whichever historical job. That matches "latest truth".

## Out of scope (YAGNI)

- No JSON **import** / restore-from-file (v1 export is insurance only).
- No auto-restore on project open (always fresh + manual load).
- No editing of a saved job in place (load → edit → save = new job).
- No changes to the packers, grain editor, remnant stock, or DXF builder.
- No Group 1 (Fusion) changes; CC_Laser's own `cut_sheets` writes are unaffected
  (the new `parts[]` field is optional — absent on Fusion-written sheets, which
  simply show no per-sheet parts summary).

## Testing / verification

- `node --check nest.js && node --check app.js` after edits.
- Logic review of `_restoreJob` re-attach against the placement/part shapes
  documented above.
- Preview MCP is avoided (crashes prior sessions). เอ๋ to eyeball on Bung 01:
  Save Project → reload page → Saved Jobs → load → confirm layout + manual rects
  return; open Laser Cut List → confirm manual rect rows appear + grain matches;
  open 📐 Cut Sheets popover → confirm per-sheet parts summary; ⬇ Export JSON →
  confirm a `.json` lands in Downloads.

## Files

- `nest.js` — `_saveProject` (rename+extend `_saveSheetsToLaser`), `_exportJobJson`,
  `_openSavedJobsModal`/`_renderSavedJobsModal`, `_restoreJob`; button label +
  two new buttons in `_viewHtml`; wiring in `_wireEvents`; `S.lastSavedJobId`.
- `app.js` — `nest_parts` listener + `_nestPartsCache` + `nestPartsForProject`;
  Cut List merge in `_renderCutList`; per-sheet parts summary in
  `_renderCutSheetsModal`.
