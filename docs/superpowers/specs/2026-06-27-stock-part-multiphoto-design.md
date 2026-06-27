# Stock Part — multi-photo intake (1-3 photos per part) — design

**Owner:** G2 / WEB · RD 13 · **Date:** 2026-06-27 · **Status:** approved (เอ๋ 2026-06-27 — AI uses all photos)
**Builds on:** Stock Part S1/S3 (`stockpart.js`, RTDB `stock_parts/<id>.photo_data`, `compressImage`, the capture/review/worker-confirm/list renders + `_openPhoto` lightbox, the LS mirror `_stripPhotos`, and the S3 AI endpoint `LINE_System/stock_match.py` `/api/stock-match`). See [[project_stock_part]].

## Goal

Let a worker attach **1-3 photos** to one Stock Part intake (เอ๋: *"รูปถ่ายสามารถใส่ได้ 1-3 รูป"*) — different angles read the part better for เอ๋'s review and for the S3 AI match (which uses **all** the photos). Single-photo today; this generalises to 1-3 while keeping every existing single-photo row working unchanged.

## Locked decisions (เอ๋ 2026-06-27)

| Fork | Decision |
|---|---|
| **Count** | 1-3 photos per intake (min 1, max 3) |
| **AI** | sends **all** 1-3 photos to Haiku vision (better match) |
| **Storage** | `photos: [b64,…]` (1-3) on the row; keep `photo_data = photos[0]` for back-compat (old render paths, list thumb, LS-mirror strip) |
| **Back-compat** | existing rows (only `photo_data`) render + AI-match unchanged via a `_rowPhotos(r)` shim |
| **Defer** | reordering photos, 4+ photos, per-photo captions |

## Data model — `stock_parts/<id>`
```
photos      : ['<b64 jpeg>', …]   // 1-3, the canonical store going forward
photo_data  : '<b64 jpeg>'        // == photos[0]; kept for back-compat + list thumb + AI single-photo fallback
```
- **Shim (single source of truth for reads):** `_rowPhotos(r)` → `r.photos && r.photos.length ? r.photos : (r.photo_data ? [r.photo_data] : [])`. Every render reads through this; nothing reads `r.photo_data`/`r.photos` directly.
- **Write (intake):** `photos = [b64,…]`, `photo_data = photos[0]`.
- **LS mirror:** `_stripPhotos` deletes **both** `photo_data` and `photos` (metadata-only mirror — base64 never cached).

## New unit — `_rowPhotos(r)` (pure, testable)
```js
function _rowPhotos(r) {
  if (r && Array.isArray(r.photos) && r.photos.length) return r.photos;
  if (r && r.photo_data) return [r.photo_data];
  return [];
}
```
The only new pure logic; everything else is capture UI + swapping `r.photo_data` reads for `_rowPhotos(r)[0]` / a strip.

## Capture (`_buildCapture`)
- Replace the single hidden file input + single preview with a **photo tray**: the picked photos render as up to 3 small thumbnails, each with a ✕ remove; while `< 3` photos, an **"+ add photo"** tile is shown. The file input carries `accept="image/*" capture="environment" multiple`.
- On `change`: take up to `(3 − current)` files, `compressImage` each, append the b64 to an in-memory `photos` array, re-render the tray. The hint text shows "Compressing…" per add.
- **Submit** enabled when `photos.length ≥ 1`; writes `{ …, photos: photos.slice(0,3), photo_data: photos[0] }`.
- **Payload guard:** per photo keeps the existing ~700 KB compress target; the row reject ceiling rises to **~2.6 MB** (covers 3 photos + meta) — reject the write if `JSON.stringify(row).length` exceeds it (Thai toast "รูปใหญ่เกินไป ลองลดรูป"). Per-device daily cap unchanged.
- Undo-last unchanged (removes the whole pushed row).

## Render (read via `_rowPhotos(r)`)
- **Review (`_buildReview`):** the left thumb + each auto-match "Photo" cell use `_rowPhotos(r)[0]`; add a small **photo strip** (the 1-3 thumbnails) at the top of the review card so เอ๋ sees every angle; clicking any opens the lightbox at that index.
- **Worker-confirm (`_buildWorkerConfirm`):** the "Photo" figure beside the GLB shows `_rowPhotos(r)[0]` + a strip of the rest; tap → lightbox.
- **Stock list (`_buildList`):** card thumb = `_rowPhotos(g.rows[0])[0]` (first photo of the representative row). No strip (keep cards compact).
- **Lightbox (`_openPhoto`):** accept `(photos, startIndex)`; if `photos.length > 1` show **‹ ›** prev/next (+ keyboard ←/→) and a count "2/3"; single photo behaves as today. Existing single-arg callers still work (wrap a lone b64 into `[b64]`).

## AI / backend (`LINE_System/stock_match.py` + route)
- **Web `_fireAiMatch(id, photos, remarks, endpoint)`** posts `{ id, photos, remarks }` (array). Keep also sending `photo: photos[0]` for one release of back-compat.
- **Route `/api/stock-match`:** `photos = data.get('photos') or ([data['photo']] if data.get('photo') else [])`; size-guard the **sum** of photo lengths (≤ ~5 MB). Pass the list to `run_match`.
- **`run_match(client, rtdb, id, photos, remarks)` + `call_model(client, photos, prompt)`:** build **one image block per photo** (1-3) in the user message, then the text prompt. Everything else (narrow, parse, write `ai_suggestion`) unchanged.
- Back-compat: a caller sending a single `photo` still works (wrapped to a 1-element list). Redeploy `stainless-kitchen-line-bot` (เอ๋ already greenlit deploys).

## Edge cases / compat
- Old rows (`photo_data`, no `photos`) → `_rowPhotos` returns `[photo_data]` → all renders + AI unchanged.
- 0 photos blocked at submit (min 1).
- A failed `compressImage` (one file) → that file is skipped with a toast; others still add.
- `_openPhoto` with an out-of-range index clamps to 0.
- LS mirror with `photos` stripped → instant first-paint shows no image until RTDB resolves (same as today for `photo_data`).

## Testing
- **Tier-1 (`node --test`):** `_rowPhotos` — `{photos:[a,b]}`→`[a,b]`; `{photo_data:a}`→`[a]`; `{}`→`[]`; `{photos:[],photo_data:a}`→`[a]`. (extend `test/stockpart-logic.test.mjs`.)
- **Tier-1 (backend):** route/`run_match` accept `photos` (and fall back to `photo`); `call_model` emits N image blocks (assert the message content shape with a mocked client).
- **Tier-3 (live, Chrome):** add 2-3 photos on a phone → tray shows thumbnails + remove works → submit → review shows the strip + lightbox ‹ › cycles → AI suggestion returns (all photos sent) → single-photo old row still renders. Console clean.

## Scope
**SHIP:** `_rowPhotos` shim; capture photo-tray (add/remove up to 3, multiple-aware, payload guard ~2.6 MB); `photos[]` + `photo_data=photos[0]` write; strip + multi-image `_openPhoto`; LS-mirror strip `photos`; backend `photos[]` (all images to Haiku) + redeploy; tests.

**DEFER:** photo reordering; >3 photos; per-photo notes/captions; the S2 nest work (separate, already specced); GitHub photo migration.
