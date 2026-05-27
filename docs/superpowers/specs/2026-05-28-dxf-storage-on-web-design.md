# DXF Storage on Web — Design

**Date:** 2026-05-28
**Scope:** `drawings-ui` (kitchen-drawings-rd2026) + `_MASTERS/fusion_scripts/CC_Laser/` on the design admin's PC
**Approach:** A — Direct Fusion upload after Sheet Metal DXF Creator finishes; web is a passive RTDB consumer

## Problem

When CC_Laser runs, it triggers Autodesk's "Sheet Metal DXF Creator" to dump one `.dxf` per ALPF part into a user-picked folder on the admin's local disk. Those DXFs are the laser-cut source files — they live and die on that PC. There is currently no path for them to:

- Be visible to the workshop iPad (which only sees PDFs from GitHub Pages)
- Feed a future web → Nesting trigger workflow
- Feed an AI assembler that needs to know each part's flat-pattern geometry

This spec is **sub-project 1 of 3** in the larger DXF-on-web vision:

1. ★ **DXF storage on web** ← this spec
2. Web → Nesting trigger (later)
3. AI chat / LINE bot → BOM assembler (later)

Sub-project 1 is purely "get the DXFs onto the web with a per-code lookup so later sub-projects can consume them." It does NOT include any consumer UI on the web beyond a single admin download affordance, and does NOT change the Nesting Tool workflow.

## UX Flow

### Fusion side (admin PC only)

1. Admin clicks Run on CC_Laser as usual.
2. Sheet Metal DXF Creator dialog appears → admin picks a folder + clicks OK → DXFs land in that folder.
3. CC_Laser continues with BOM CSV + Parts List PNG + Nesting Tool launch as today.
4. **NEW step** between BOM build and completion dialog:
   - CC_Laser asks the admin to point at the DXF folder ("Select the folder you just exported DXFs to") via `ui.createFolderDialog`. If the admin Cancels, skip the upload silently — pipeline continues unchanged.
   - CC_Laser scans the chosen folder for `*.dxf` files. Two filters apply:
     - **mtime filter**: only files modified after `_action_start` (this run's exports, not leftovers from yesterday).
     - **BOM key match**: only files whose stem matches a key in the ALPF-filtered BOM aggregation. Sheet Metal DXF Creator names files by component name; the BOM aggregation key is also `comp.name`. Exact match. Files that pass mtime but fail BOM-key match are reported as `M skipped`.
   - A confirmation MessageBox: `"Upload N DXFs to the web? (M skipped — older / not in BOM)"` with OK/Cancel. Cancel = pipeline continues; OK = upload begins.
5. For each matched DXF, `dxf_uploader.upload(stem, master_code, dxf_path, bom_meta)` does two writes (where `master_code = _project_key_from_doc_name(doc.name)`):
   - **GitHub**: PUT to `Drawings/dxf/<master_code>/<stem>.dxf` on `kitchen-drawings-rd2026` (Contents API, base64 body, same pattern as existing PDF upload).
   - **RTDB**: PUT to `uploaded_dxfs/<stem>` with the metadata blob (see schema below).
6. CC_Laser's completion dialog gains a footer line: `📐 Uploaded N DXFs (M failed)`. The timing header at the top is unchanged.

### Web side (admin browser only)

1. App boots → `initUploadedDxfsSync` subscribes to `uploaded_dxfs` (mirrors `initUploadedPdfsSync` pattern).
2. RTDB pushes from step 5 above land in `_uploadedDxfsCache` within ~1 s.
3. Library family view: each `.part-row` whose master_code has ≥1 entry in `_uploadedDxfsCache` gains a 📐 cyan button next to the existing ✎ 📁 admin chips. If N>1, the button shows the count (e.g. `📐 3`).
4. Click 📐:
   - If N=1 → browser downloads the `.dxf` directly (anchor `download` attribute → user's Downloads folder).
   - If N>1 → a small popover lists each panel filename; click a row → that one downloads. Popover dismisses on outside-click.
5. **Workshop sees nothing.** The button is rendered inside the same admin-gated block as ✎ 📁 — non-admin = no DXF button at all.

No mindmap node ever shows a DXF button. No DXF viewer, no new tab beyond the download. Admin Library only.

## Architecture & Data Flow

```
┌──────────────────────────────────────────────────────────────────┐
│ ADMIN PC — Fusion                                                │
│                                                                  │
│  CC_Laser/CC_Laser.py  (monolithic 713-line script)              │
│   run() pipeline:                                                │
│     ┌──────────────────────────────────────────────────────────┐ │
│     │ Step 0: Trigger Sheet Metal DXF Creator + wait           │ │
│     │ Step 1-3: Traverse → aggregate → ALPF filter             │ │
│     │ Step 4: Save BOM CSV                                     │ │
│     │ Step 5: Generate Parts List PNG                          │ │
│     │ NEW Step 5.5: Upload DXFs (opt-in)  ← this spec          │ │
│     │   1. folderDialog → pick DXF export folder               │ │
│     │   2. scan *.dxf, filter by (mtime > _action_start) AND   │ │
│     │      (stem in BOM aggregation keys)                      │ │
│     │   3. confirmation MessageBox                             │ │
│     │   4. master_code = _project_key_from_doc_name(doc.name)  │ │
│     │      for each: dxf_uploader.upload(                      │ │
│     │        stem, master_code, path, bom_meta)                │ │
│     │ Step 6: Launch Nesting Tool                              │ │
│     │ Step 7: Completion dialog (+ "📐 Uploaded N" footer)     │ │
│     └──────────────────────────────────────────────────────────┘ │
│                                                                  │
│  CC_Laser/dxf_uploader.py  (NEW helper, sibling of CC_Laser.py)  │
│    _load_config()           → reads ~/.cc_laser_config.json      │
│    _gh_put_file(repo_path, bytes) → Contents API to GH           │
│    _rtdb_put_metadata(stem, m)    → urllib PUT (anonymous, like  │
│                                     CC_SyncOccNames/CC_WebSync)  │
│    upload(stem, master_code, dxf_path, bom_meta):                │
│      repo_path = f"Drawings/dxf/{master_code}/{stem}.dxf"        │
│      bytes = Path(dxf_path).read_bytes()                         │
│      _gh_put_file(repo_path, bytes)                              │
│      _rtdb_put_metadata(stem, {                                  │
│        url, filename, master_code, size_bytes,                   │
│        thickness_mm, material, grain,                            │
│        exported_at, uploaded_at                                  │
│      })                                                          │
│                                                                  │
│  ~/.cc_laser_config.json                                         │
│    { github_pat, github_repo, github_branch, dxf_path }          │
│    NO firebase_url, NO firebase_secret  (RTDB is open per the    │
│      same anonymous pattern CC_WebSync + CC_SyncOccNames use)    │
└───────────────────────────┬──────────────────────────────────────┘
                            │
            GitHub Contents API           Firebase RTDB
                  │                            │
                  ▼                            ▼
┌─────────────────────────────────┐  ┌──────────────────────────────┐
│ kitchen-drawings-rd2026 repo    │  │ kitchen-drawings RTDB        │
│   Drawings/dxf/<master>/        │  │   uploaded_dxfs/<dxf_stem>={ │
│     <stem>.dxf                  │  │     url, filename,           │
│   served at:                    │  │     master_code,             │
│   https://kitchen-drawings-     │  │     size_bytes,              │
│     rd2026.github.io/Drawings/  │  │     thickness_mm, material,  │
│     dxf/<master>/<stem>.dxf     │  │     grain, exported_at,      │
│   (~1 min Pages deploy)         │  │     uploaded_at }            │
└─────────────────────────────────┘  └──────────────┬───────────────┘
                                                    │
                                                    ▼
┌──────────────────────────────────────────────────────────────────┐
│ ADMIN BROWSER — drawings-ui                                      │
│                                                                  │
│  app.js                                                          │
│    let _uploadedDxfsCache = {}                                   │
│    initUploadedDxfsSync()                                        │
│      firebaseDB.ref('uploaded_dxfs').on('value', snap => {       │
│        _uploadedDxfsCache = snap.val() || {}                     │
│        if (isAdminMode()) render()                               │
│      })                                                          │
│    dxfsForMasterCode(code) → [{filename, url, ...}, …]           │
│      (filters cache entries by master_code field)                │
│    handleDxfClick(masterCode):                                   │
│      list = dxfsForMasterCode(masterCode)                        │
│      if list.length === 1: trigger anchor download               │
│      else: open <div class="part-dxf-popover"> with list         │
│                                                                  │
│  renderFamily() — part-row rendering                             │
│    list = dxfsForMasterCode(p.code)                              │
│    if (isAdminMode() && list.length) {                           │
│      append <button class="part-dxf-btn">                        │
│        📐{list.length > 1 ? ' ' + list.length : ''}              │
│      </button>                                                   │
│    }                                                             │
│                                                                  │
│  style.css                                                       │
│    .part-dxf-btn — cyan, sized like .part-edit-btn               │
└──────────────────────────────────────────────────────────────────┘
                            │
                            │ (workshop / non-admin: no listener
                            │  fires render, no 📐 button rendered)
                            ▼
                       (no workshop UI changes)
```

### Key contracts

- **RTDB key `uploaded_dxfs/<dxf_stem>`** — `<dxf_stem>` is the filename of the exported `.dxf` minus extension, taken verbatim from what Sheet Metal DXF Creator produced. This is **per-panel**, not per-master — a multi-panel master (e.g. a drawer with front + back + base) yields N entries. The web's Library row groups them by their associated `master_code` field (see schema below). See Open Question #6 about why this is one-entry-per-DXF rather than per-master.
- **GitHub path `Drawings/dxf/<master_code>/<dxf_stem>.dxf`** — subfolder per master to keep the `Drawings/dxf/` directory listing scannable. Mirrors the way each Fusion master assembly produces its own batch of panels.
- **Public URL `https://kitchen-drawings-rd2026.github.io/Drawings/dxf/<master_code>/<dxf_stem>.dxf`** — what's stored in the RTDB `url` field. Pages serves `.dxf` with `Content-Type: application/octet-stream` by default, so a browser anchor with `download` attribute saves rather than renders.
- **Config file path** — `Path.home() / '.cc_laser_config.json'`. Created on first upload run: `dxf_uploader._load_config()` prompts via `ui.inputBox` for the PAT (validated with the same `/^github_pat_|^ghp_/` regex the web side uses) and persists.
- **RTDB anonymous PUT** — `urllib.request.Request(url, data=json.dumps(metadata).encode(), method='PUT')` per the proven CC_SyncOccNames pattern. No auth token, no Firebase secret, no admin SDK.
- **`dxfsForMasterCode(masterCode) → Array<{filename, url, ...}>`** — new public lookup on the web side. Filters `_uploadedDxfsCache` entries by `master_code` field; returns sorted-by-filename list (deterministic UI). Empty array if none.
- **`isAdminMode()`** — already exists in app.js (`localStorage['kd_admin_v1']` per the admin-mode memory). Reuse, do not duplicate.

### Metadata schema

```json
{
  "url":          "https://kitchen-drawings-rd2026.github.io/Drawings/dxf/100VB0-110000/Front-Panel.dxf",
  "filename":     "Front-Panel.dxf",
  "master_code":  "100VB0-110000",
  "size_bytes":   18432,
  "thickness_mm": 1.0,
  "material":     "ALPF",
  "grain":        "lengthwise",
  "exported_at":  1748390000000,
  "uploaded_at":  1748390002000
}
```

- `master_code` ties the entry back to a Library row's `data-code`. The web's `dxfsForMasterCode(masterCode)` filters `_uploadedDxfsCache` by this field — one master can have many DXFs.
- `thickness_mm` is pulled from the BOM aggregation already built in CC_Laser (with the `grain.xlsx` override applied — see `reference_grain_xlsx_thickness` memory).
- `grain` is the per-part value from `grain.xlsx` if present, else empty string. Future Nesting trigger (sub-project 2) will need this.
- `exported_at` = mtime of the `.dxf` file. `uploaded_at` = `time.time() * 1000` at PUT time. The gap shows how long Sheet Metal DXF Creator + admin folder-pick took.
- Field names match what `dxf_uploader.py` produces; no transformation on the web side.

### What stays unchanged

- CC_Laser's existing 6-step pipeline (DXF Creator trigger → traverse → CSV → PNG → Nesting Tool launch → completion dialog). The new step is **additive** between PNG and Nesting Tool launch, gated behind a Cancel/skip.
- All existing PDF upload flow (`uploaded_pdfs` RTDB node, `Drawings/manual/<code>.pdf`, web drag-drop, browser `kd_github_pat_v1` localStorage).
- The "Active in Fusion" badge code currently uncommitted in app.js — see Open Questions #4 below; that is a separate feature, not affected by this spec.
- The `📐 NO PDF` chip from the 2026-05-27 Library-link spec, `_remapFamilyForCode`, the React Flow editor, mindmap routing, workshop UX.
- The Spark-plan Firebase project. RTDB is well within free-tier quotas; adding `uploaded_dxfs` adds maybe a few KB per assembly run.
- No changes to the `kitchen-drawings` storage bucket (which doesn't exist on Spark — per `reference_firebase_spark_limit` memory).

## Edge Cases

| Case | Handling |
|---|---|
| Admin Cancels folder picker after DXF Creator | Skip upload silently; pipeline continues to Nesting Tool launch and completion dialog. No "skipped" warning — Cancel is a normal "not this time" path. |
| DXF folder has files whose stems aren't in the BOM aggregation | Reported as `M skipped` in the confirmation dialog. Not uploaded. (Catches stale files from a previous export AND non-ALPF sheet-metal exports that fell out of the ALPF filter.) |
| DXF older than `_action_start` in the folder | Filtered out before the BOM-key check. Counts toward `M skipped` too, but only logged at debug level — not shown in dialog. (Prevents stale cross-contamination from yesterday's run sitting in the same folder.) |
| BOM has codes with no matching DXF file | Silent. We only upload what was exported; missing DXFs aren't this script's problem. |
| `.cc_laser_config.json` missing on first run | Prompt for PAT via `ui.inputBox`. If user Cancels → entire upload step skips, pipeline continues. |
| `.cc_laser_config.json` PAT expired (401/403) | Show MessageBox `"GitHub PAT rejected. Delete ~/.cc_laser_config.json and run again."` Continue with remaining files? **No** — abort the upload step; partial uploads are worse than none for a single run. RTDB writes already done stay in place (idempotent — they'll be overwritten next successful run). |
| RTDB write succeeds but GitHub PUT fails | Roll back: delete the RTDB entry (`urllib PUT null`). Logged in completion footer as a failure. |
| Re-upload of an existing dxf_stem | Overwrite: GitHub PUT with `sha` of existing file (Contents API requires sha for updates — fetch first); RTDB PUT replaces metadata atomically. `uploaded_at` bumps; `exported_at` reflects the new mtime. |
| Re-upload where a previously-exported panel no longer exists | Stale RTDB entries are NOT cleaned up automatically (would require diffing). The web 📐 still surfaces them. Acceptable for sub-project 1 — flagged for sub-project 2 / cleanup pass. |
| Panel filename collision across two masters | Different masters yielding same `<stem>.dxf` would overwrite. Mitigated by the per-master subfolder on GitHub, but the RTDB is flat — same stem → same RTDB key → collision. Realistically unlikely (Sheet Metal DXF Creator names by component name, which has the master prefix). Caught by Q6. |
| Workshop reloads app while admin is uploading | RTDB listener fires for workshop too, but the `render()` call in the listener is gated by `isAdminMode()` → workshop doesn't repaint. Cache still updates in memory (harmless). |
| Non-ALPF DXFs accidentally in the folder | They don't appear in the BOM aggregation (ALPF filter happens before the upload step) → don't match any code → reported as skipped. |
| `master_code` with `/` or other unsafe filesystem char | Kitchen master codes are `[A-Z0-9-]` only (per all 13-char naming schemes in memory). No special escaping needed for the GitHub subfolder. |
| `dxf_stem` with spaces or special chars | Real risk — Sheet Metal DXF Creator names by `comp.name` which the designer types freely. Mitigation: `urllib.request.quote(stem, safe='-_.')` on both the GitHub repo path and the RTDB key. The `url` field stores the encoded URL so the browser anchor works. The `filename` field stores the original (used as the popover label). See Q7 for the longer-term cleanup option. |

## Testing Plan

### A. Fusion side — manual, on admin PC

1. Setup: delete `~/.cc_laser_config.json` if present; open a known assembly with ≥3 ALPF parts (e.g. `100VB0-110000`).
2. Run CC_Laser → pick export folder → wait for DXF Creator + BOM build.
3. At new prompt, click Cancel → verify pipeline continues + Nesting Tool launches as before. No GH/RTDB writes.
4. Run CC_Laser again → click OK → enter a valid `github_pat_…` token at the inputBox.
5. Verify on GitHub web UI: 3 `.dxf` files appear at `Drawings/dxf/100VB0-110000/<panel_stem>.dxf`.
6. Verify in Firebase console: 3 entries under `uploaded_dxfs/<panel_stem>` with `master_code: "100VB0-110000"` and the schema above.
7. Run CC_Laser a 3rd time on the same assembly → confirm overwrite path works (existing files updated, no duplicate paths, `uploaded_at` increments).
8. Test PAT-rejection path: edit `~/.cc_laser_config.json`, replace PAT with `github_pat_invalid` → run CC_Laser → confirm abort + clean MessageBox.

### B. Web side — browser preview (preview MCP at port 3030)

1. Start drawings-ui dev server via `mcp__Claude_Preview__preview_start({name: 'drawings-ui'})`.
2. Pre-seed RTDB test data in the preview's localStorage emulator (or use a real test project — `100VB0-110000`):
   - Inject via `preview_eval`:
     ```js
     _uploadedDxfsCache = {
       "Front-Panel":  {url:"https://example.com/a.dxf", filename:"Front-Panel.dxf",  master_code:"100VB0-110000", ...},
       "Back-Panel":   {url:"https://example.com/b.dxf", filename:"Back-Panel.dxf",   master_code:"100VB0-110000", ...},
       "Base-Panel":   {url:"https://example.com/c.dxf", filename:"Base-Panel.dxf",   master_code:"100VB0-110000", ...},
     }
     ```
3. Switch to admin mode (`?admin=1`).
4. Navigate to Library → the family containing `100VB0-110000`.
5. `preview_snapshot` → assert `.part-row[data-code="100VB0-110000"]` contains a `.part-dxf-btn` reading `📐 3`.
6. `preview_click` the 📐 button → popover appears with 3 entries; click "Front-Panel.dxf" → assert browser download triggered (check `preview_network` for the GET).
7. Inject a cache with only 1 entry → `📐` button (no count) → click triggers direct download, no popover.
8. Switch to workshop mode (clear admin) → assert NO 📐 button on the row.
9. Clear the cache and re-snapshot → 📐 button disappears (listener-driven render).

### C. Regression checks

These must still work unchanged:

- PDF drag-drop upload to a part row (admin)
- 📐 NO PDF chip → opens in Library (per 2026-05-27 spec)
- ⧉ kme-link-badge → opens Fusion file
- Leaf node click → `_routeLeafToFusion`
- Workshop iPad PWA — no new UI, no errors in console
- CC_Laser without the new upload step (Cancel path) — completion dialog footer absent, no functional change

### D. Integration — full loop, both sides on real admin PC

1. Admin runs CC_Laser on a fresh assembly → exports 5 DXFs → uploads all 5.
2. Web admin (same PC) tab open → within 2 s, 5 📐 buttons appear in Library for that family.
3. Click each 📐 → verify download yields the same bytes as the local DXF (`md5sum` compare).
4. Workshop iPad open in parallel → no 📐 buttons appear, no console errors.

## Build & Deploy

### Fusion side

- Edits go in `_MASTERS/fusion_scripts/CC_Laser/CC_Laser.py` (Step 5.5 insertion) and a new sibling `_MASTERS/fusion_scripts/CC_Laser/dxf_uploader.py`.
- No add-in restart needed — CC_Laser is `type: script`, reloaded on every Run. (No `_action.py` split is involved here.)
- Per the `register_scripts` memory rule: if `dxf_uploader.py` is imported as a module (not run directly), no `JSLoadedScriptsinfo` registration needed. Only CC_Laser.py is registered.

### Web side

- Edits in `drawings-ui/app.js` (cache + listener + helper + render hook) and `drawings-ui/style.css` (`.part-dxf-btn`).
- Editor bundle untouched.
- Commit + push to `main` → GitHub Pages deploys in ~1 min. Verify per the `check_deploy` memory rule.

### Order of operations

1. Land **Fusion side first**. It can be deployed (added to admin PC) without web changes — uploads happen, RTDB and GitHub fill with data, web just doesn't show 📐 yet. This is the safe rollout direction (data first, UI second).
2. Then **web side**. Once merged, 📐 starts appearing for admin in Library.

## Out of Scope (= sub-projects 2 and 3)

- Web → Nesting Tool trigger workflow (sub-project 2)
- AI chat / LINE bot DXF consumer (sub-project 3)
- In-browser DXF preview / viewer (Three.js, dxf-parser, etc.)
- Workshop DXF access — iPad has no laser/nesting use case
- DXF buttons on mindmap nodes — mindmap is design-time; DXF lookup is in Library
- Bulk re-upload UI on the web — overwrite is fine in the Fusion flow
- DXF versioning UI — overwrite, no version history
- Cleanup of orphaned RTDB entries when a part code is renamed — manual GitHub delete + RTDB delete for now
- Storage rules / Firebase Auth — RTDB stays open per existing convention
- The uncommitted "Active in Fusion" badge work in app.js + style.css — that pairs with CC_SyncOccNames as a separate feature; see Open Question #4

## Open Questions

These came out of the reality-check pass against the actual codebase (some handoff assumptions were stale):

### Q1: Handoff path correction — `CC_Laser_action.py` doesn't exist

The handoff prompt lists `_MASTERS/fusion_scripts/CC_Laser_action.py` as a file to modify. Reality: CC_Laser was reverted to a monolithic 713-line script on 2026-05-27 afternoon (per its own docstring). There is no `_action.py` split. **Resolved in this spec** by targeting `CC_Laser/CC_Laser.py` directly. The `reference_cc_laser.md` memory file is also stale and should be updated when the spec lands.

### Q2: How does CC_Laser know which folder the DXFs were exported to?

Autodesk's Sheet Metal DXF Creator picks its own folder via a Fusion-native dialog whose result is not exposed to scripts. Three options:

- **(a) Ask the admin to pick the same folder again** via `ui.createFolderDialog` after DXF Creator finishes. One extra click. **← This spec assumes (a).**
- (b) Hard-code or remember-last-used a default folder in `~/.cc_laser_config.json` and trust the admin always points DXF Creator at it. Brittle.
- (c) Scan a known temp folder (e.g. `Path.home() / 'Documents' / 'Laser'`) for `.dxf` files with mtime newer than `_action_start`. No prompt, but only works if the admin always picks that folder.

If the admin is willing to consistently use one folder, (c) is silent and zero-friction. Otherwise (a) is the safe default. **Decision needed before plan stage.**

### Q3: `firebase_secret` in `~/.cc_laser_config.json` — not needed

The handoff prompt lists `firebase_secret` as a config field. Reality: every other Fusion script that writes RTDB (`CC_SyncOccNames`, `CC_LinkNode`, `CC_WebSync` for reads) uses anonymous HTTPS PUT — the project's RTDB rules are open. **Resolved in this spec** by removing the field. Confirm before plan stage that we don't want to tighten RTDB rules at the same time (that would be a bigger scope change touching every existing script).

### Q4: The uncommitted "Active in Fusion" work in app.js + style.css

The current working tree has 76 unstaged lines that wire up `active_rows` RTDB subscription + `.active-variant-badge` UI. This is the web consumer for the already-shipped CC_SyncOccNames (Phase 3-ish of the Web↔Fusion sync project). It's coherent and complete, but uncommitted.

It's **independent** of this DXF spec — different RTDB node, different feature. **Recommendation:** commit it on its own first, with its own message, before starting DXF work. The spec doc commit should be a clean, small diff (just the new file).

### Q5: Re-upload semantics — overwrite confirmed?

This spec says re-uploading the same `dxf_stem` overwrites both GH file and RTDB metadata, with `uploaded_at` reflecting the new run. No versioning, no soft-delete. That matches the existing PDF upload pattern (drag-drop a new PDF → replaces the old one). Calling it out explicitly because DXFs change with every laser-cut iteration and this could pile up GitHub commit history quickly (every re-upload = a new commit). Acceptable now; might want squashing later. Not in scope.

### Q6: Per-panel keying vs per-master keying — substantive design choice

The handoff schema includes `width_mm`, `height_mm`, `material`, `grain`, `thickness_mm` — clearly **per-panel** metadata. But a Library row's `data-code` is a **master code**, and a single master assembly often produces **multiple .dxf files** (one per panel — Front, Back, Base, etc.). The two don't line up 1:1.

This spec resolves the tension by:
- Keying RTDB by `<dxf_stem>` (per-panel), so each `.dxf` file gets its own metadata blob.
- Adding a `master_code` field that ties each entry back to a Library row.
- Storing files in `Drawings/dxf/<master_code>/<dxf_stem>.dxf` (subfolder per master) so a `Drawings/dxf/` listing isn't a flat flood of panels.
- Exposing `dxfsForMasterCode(masterCode) → list` on the web side instead of `dxfUrlForCode(code) → string`.
- UI: 📐 button shows count when N>1; click opens a popover; N=1 is a direct download.

**Alternative considered**: nest as `uploaded_dxfs/<master_code>/<dxf_stem> = {...}`. Cleaner hierarchy but breaks the symmetry with `uploaded_pdfs/<code>` (which is flat). I chose flat-with-master_code-field because:
- One Firebase `.on('value')` subscription reads the whole tree cheaply.
- Mirrors the existing PDF cache shape, so the web cache + render path stays familiar.
- A future migration to nested layout is straightforward.

If the user prefers nested layout, the spec can be revised in <30 min before plan stage — only the schema + the two lookup functions change.

### Q7: What's `dxf_stem` actually look like?

I assumed `<dxf_stem>` is just `Path(dxf_path).stem`. Sheet Metal DXF Creator names files by **component name** (e.g. `Front Panel.dxf` if the user named the body that). With CC_SyncOccNames syncing top-level occurrences to the active row name (the master code), but NOT touching nested sheet-metal bodies, the panel names are whatever the master file's designer named them.

This means panel filenames are NOT well-controlled. We should either:
- (a) Trust whatever Sheet Metal DXF Creator outputs and live with messy panel names. (Simple, matches reality.)
- (b) Add a sanitization step in `dxf_uploader.py`: strip spaces, force ASCII, etc.
- (c) Force panel naming via a CC_Laser preflight check before DXF Creator runs.

This spec assumes **(a)** for now. (b) is a one-line addition later if any panel produces a broken URL. (c) is out of scope.
