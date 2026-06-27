# Stock Part S3 — AI image-match (photo → suggested code) — design

**Owner:** G2 / WEB · RD 13 · **Date:** 2026-06-27 · **Status:** approved (เอ๋ 2026-06-27)
**Builds on:** Stock Part S1 (`stockpart.js` / `window.kdStockPart`, RTDB `stock_parts/<id>`, the review queue + the reserved `.kdsp-ai-slot` "AI image-match — coming soon" placeholder, `codePickerFilter` / `_parseLen` / `_codeDims`, `uploaded_dxfs`), and the LINE bot backend `LINE_System/webhook_server.py` (Flask + gunicorn on Render, `anthropic.Anthropic` client already configured with `ANTHROPIC_API_KEY`, Haiku 4.5 `claude-haiku-4-5-20251001` already used, the `_check_anthropic_credit_error` LINE alert). See [[project_stock_part]], [[project_line_bot]].

## Goal

When a worker photographs a leftover part and submits it (S1 intake), have an AI vision model **pre-suggest the 13-char code** so เอ๋ doesn't hand-search every time — *"ให้ช่างถ่ายรูปแล้ว matching กับ glb ที่มี เพราะ code ยาว 13 หลัก ช่างใส่เองยาก"*. S1 deliberately left a labelled empty slot (`.kdsp-ai-slot`) in the review card for exactly this. The AI **suggests, เอ๋ confirms** — it never auto-assigns (flat stainless parts look alike, so a wrong auto-pick is worse than a ranked hint).

## Locked decisions (เอ๋ 2026-06-27)

| Fork | Decision | Why |
|---|---|---|
| **Inference path** | Reuse the **LINE bot Render backend** (add an endpoint); Anthropic key stays server-side | static GitHub Pages can't hold an API key; the backend already has the client + key + credit alerting |
| **Model** | **Haiku 4.5** vision (`claude-haiku-4-5-20251001`) | already used by the bot; cheap (~สตางค์/รูป) for a few intakes/day |
| **Trigger** | **Async at intake** — fire-and-forget when the worker submits; result stored on the row | neither the worker nor เอ๋ ever waits on Render's ~40s cold start |
| **Match basis (MVP)** | photo + worker remarks + catalog metadata (code, W×H from suffix, material) + a **code-prefix→family legend** | the backend has no GLB renders; rendering client-side at intake is heavy. Image-to-GLB comparison is deferred |
| **Output** | top-3 ranked `{code, confidence, reason}`, written to `stock_parts/<id>/ai_suggestion` | เอ๋ sees it live in the review card; one tap to use |
| **Failure** | no `ai_suggestion` written → review card shows the existing dimension auto-match unchanged | AI is purely additive; never blocks S1 |

## Architecture / flow

```
worker submits (S1)                          เอ๋ opens review (live)
   │ saveIntake → pushId                          │
   ▼                                              ▼
 web: fetch POST  ────────────────►  Render backend  /api/stock-match
   {id, photo, remarks}                  │ 1. read uploaded_dxfs (RTDB REST GET)
   (fire-and-forget, .catch noop)        │ 2. build candidate list (dedupe; narrow by remarks length if any)
                                         │ 3. Haiku 4.5 vision → ranked JSON
                                         │ 4. PATCH stock_parts/<id>/ai_suggestion (RTDB REST)
                                         ▼
                          RTDB stock_parts/<id>/ai_suggestion  ──listener──►  web review card
                                                                              renders .kdsp-ai-slot
```

The web posts and forgets; the **backend** writes the result to RTDB (not the web), so it's independent of the worker's page staying open. The review card's existing `.on('value')` listener repaints when `ai_suggestion` lands.

## Backend — `LINE_System/webhook_server.py`

### New route `POST /api/stock-match`
- **Request** JSON: `{ "id": "<pushId>", "photo": "<base64 jpeg, no data: prefix>", "remarks": "<string, Thai ok>" }`.
- **Behaviour:**
  1. Validate `id` + `photo` present; reject oversize photo (> ~1.6 MB base64) with `400`.
  2. `GET <RTDB_URL>/uploaded_dxfs.json` → dedupe to one row per `master_code` (newest `uploaded_at`), keep `{code, w, h (from 6-digit suffix ×10 mm), material}`.
  3. **Narrow:** parse the largest integer in `remarks` as a length `L` (mm); if `L≥10`, keep candidates whose `W*10`, `H*10`, `W`, or `H` is within **±50 mm** of `L`, nearest first, cap **60**; else keep all (cap 120, A→Z). Log the count kept.
  4. Call Haiku 4.5 vision (prompt below) → parse strict JSON `ranked`.
  5. `PATCH <RTDB_URL>/stock_parts/<id>/ai_suggestion.json` with the result object.
  6. Return `{ "ok": true, "ranked": [...] }` (the web ignores the body — RTDB is the source of truth).
- **On any error** (model, parse, credit): `PATCH` `ai_suggestion = {status:'error', error:<short>, at:<ms>, model:<id>}` and call `_check_anthropic_credit_error(e)`; return `200 {ok:false}` (never 500 — it's best-effort).
- **CORS:** the page origin is `https://wuttichaisaeton.github.io`. Add CORS for `/api/stock-match` (and its `OPTIONS` preflight): `Access-Control-Allow-Origin: https://wuttichaisaeton.github.io`, `-Methods: POST, OPTIONS`, `-Headers: Content-Type`. (Prefer `flask-cors` scoped to this route; add to `requirements.txt`. Manual headers + an `OPTIONS` handler are an acceptable equivalent.) No other route changes.
- **Config:** `RTDB_URL` env (the project's `…firebaseio.com` base; same DB the web uses). The RTDB is open-write today (S1), so the REST `PATCH` needs no auth — **if/when rules are hardened, this endpoint joins that pass** (use a DB secret/token).

### AI prompt (Haiku 4.5, vision)
- **Instruction:** "You match a photo of ONE leftover sheet-metal part to its 13-char part code, choosing only from the CANDIDATES list. Reply with JSON only."
- **Inputs in the user message:** the photo (image block); the worker's `remarks` (verbatim, Thai ok — may contain the measured length); the CANDIDATES as compact lines `CODE | W×H mm | material`; and a **family legend** derived from the code prefix so the model can map visual shape → family (from the naming memories: `FN`=floor rail, `SD`=side panel, `BK`=back/down, `TS`=top support, `BM`=…, `DS*/DW*`=door, `2…`=wall-cabinet F2, etc. — the legend is a fixed string in the backend).
- **Output schema (strict):** `{"ranked":[{"code":"<one of CANDIDATES>","confidence":<0..1>,"reason":"<≤12 words>"}]}` — at most 3, highest first; `[]` if none plausible. Reject/repair any code not in CANDIDATES.
- Keep `max_tokens` small (~400); temperature 0.

## Data model — `stock_parts/<id>/ai_suggestion`
```
ai_suggestion: {
  status   : 'ok' | 'error',
  ranked   : [ { code: '<master_code>', confidence: <0..1>, reason: '<short>' } ],  // ≤3, omitted on error
  model    : 'claude-haiku-4-5-20251001',
  at       : <epoch_ms>,
  error    : '<short>'   // only when status==='error'
}
```
Additive; never read by S1's aggregation/lifecycle. A row may never get one (backend down) — that's fine.

## Web — `stockpart.js`

1. **Endpoint const:** `var KDSP_AI_ENDPOINT = '<Render base URL>/api/stock-match';` (filled with the LINE bot's Render URL; one place).
2. **Fire at intake:** in `_buildCapture`'s submit handler, right after `_undoLast = await saveIntake(row);`, fire (do NOT await the UI on it):
   ```
   try { fetch(KDSP_AI_ENDPOINT, { method:'POST', headers:{'Content-Type':'application/json'},
     body: JSON.stringify({ id:_undoLast, photo:photoB64, remarks:row.note }) }).catch(function(){}); } catch(e){}
   ```
   The worker's flow (toast, render) is unchanged; the call is best-effort.
3. **Render in review:** add `_aiSuggestHtml(r.ai_suggestion)` (pure, testable) returning the `.kdsp-ai-slot` markup:
   - `status==='ok'` + `ranked.length`: a "✨ AI suggestion" block — top pick prominent (`<code>`, `confidence` as %, `reason`) with a **use** button, then up to 2 alternatives (smaller). Each **use** carries `data-code/-th/-mat/-grn` (looked up from `_uploadedDxfsCache[code]`) and reuses the existing review **use → assign** path (same handler as the manual picker / auto-match), so picking an AI suggestion = the same assign flow.
   - `status==='error'` or absent: the current "AI image-match — coming soon" text (no behaviour change).
   - All `code`/`reason` rendered via `escapeHtml`; `data-*` via `escapeHtml` (mirror the existing candidate rows).
4. Wire the AI block's **use** buttons in `_buildReview` exactly like `.kdsp-use` (set `chosen`, enable Assign) — no new assign logic.

## Security / cost / quota
- **Anon endpoint** (matches the app's open model). Light guards: payload-size reject (~1.6 MB), and a per-process simple rate cap (e.g. ≤N calls/min) to bound a runaway; the existing credit-error → LINE alert already backstops cost. Proportionate to a trust-based shop; not a ship blocker.
- **Cost:** 1 image (~1–2K tok) + a short candidate list, Haiku 4.5, only at intake (a few/day) ≈ สตางค์/รูป → ~บาท/เดือน.
- **No key on the web** (stays in Render env). **CORS scoped** to the Pages origin.
- **RTDB write from backend** uses the open path (S1); joins any future rules-hardening pass.

## Failure / edge cases
- Backend asleep/cold/credit-out/network → no `ai_suggestion` (or `status:'error'`) → review shows the dimension auto-match unchanged.
- AI returns a non-candidate code or bad JSON → backend drops it / repairs to candidates-only; if nothing valid → `ranked: []` (review shows auto-match).
- Worker edits via undo-last then re-adds → a fresh intake/POST; the stale row is deleted (its `ai_suggestion` goes with it).
- `remarks` empty → no length narrowing; AI ranks from the broader (capped) catalog by shape/family.
- Code suggested has no GLB → the existing review "3D"/View opens the no-model state (unchanged).

## Testing
- **Web (Tier-1, `node --test`):** `_aiSuggestHtml` — `ok` with ranked renders code/%/reason + a `.kdsp-use` per pick; `error`/absent → falls back to the "coming soon" text; `escapeHtml` on a `<script>` in `reason`/`code` renders inert. A unit that the intake submit calls `fetch(KDSP_AI_ENDPOINT,…)` with `{id,photo,remarks}` (fetch mocked) and that a `fetch` rejection doesn't break the submit flow.
- **Backend (Python):** candidate-narrowing (length parse + ±50 mm, cap) and the JSON-parse/repair (drop non-candidate codes) as pure functions; a mocked Anthropic client returns canned JSON → assert the RTDB `PATCH` payload shape; CORS headers present on `OPTIONS`.
- **Live (Tier-3, real devices):** worker submits on a phone → within a few seconds `ai_suggestion` appears on the row → เอ๋'s review card shows the "✨ AI suggestion" with a sensible top pick → **use** assigns it (same as manual) → worker-confirm round-trip unchanged. Verify cold-start path (first call after idle still lands, just later). Chrome only.

## Phase scope
**SHIP (S3 MVP):** the `/api/stock-match` endpoint (CORS, narrow, Haiku vision, RTDB write, credit-alert reuse); the web intake POST + `_aiSuggestHtml` in the review slot with one-tap **use**; graceful no-AI fallback; tests above.

**DEFER:**
- **Image-to-GLB comparison** — render candidate GLBs (client-side or a render service) and send them so the model compares the photo to actual part shapes (more accurate for look-alikes; heavier/costlier).
- Confidence calibration / a min-confidence gate before showing.
- Multi-photo intake; re-run AI on a bounced row with เอ๋'s hint.
- Hardened RTDB rules (app-wide deferral; this endpoint joins it).
