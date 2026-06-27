# Stock Part — reuse already-cut/bent leftover parts (S1: registry + photo intake + owner review) — design

**Owner:** G2 / WEB · RD 13 · **Date:** 2026-06-27 · **Status:** approved (build order A — S1 first); revised after a 5-lens adversarial spec review; + worker GLB-confirm stage (เอ๋ 2026-06-27)
**Builds on:** the Remnants Stock modal (`nest.js` `_openStockModal` / `_saveRemnant` / `nest_remnants`), the role/admin system (`app.js` `_visibleTabsForRole` / `_TAB_IDS` / `applyTabVisibility` / `isAdmin` / `getRole`), the `uploaded_dxfs` cache (`dxfsForMasterCode` / `_uploadedDxfsCache` / `initUploadedDxfsSync`), the 3D viewer (`_kdOpen3D` / `_kd3dGlbUrl`), the shared helpers `escapeHtml` / `_kdToast`, the existing Comments Thai-font fallback (system Thai fonts), the theme system (dark / sketch / chalk / obsidian), and the jsdom test harness (`node --test test/*.mjs`, precedent `test/nestStockEnable.test.mjs`). **No Fusion / manifest schema change. No GitHub PAT used in S1** (photos live in RTDB; GitHub migration is deferred to S2).

## Goal

Some parts were laser-cut **and bent** for an old job but never used. เอ๋ wants those
physical leftovers registered so a new job does not re-cut what already exists on the
shelf — *"มี part ที่เป็นงานเก่า ซื้อถูกตัดและพับแล้ว ... อยากให้ตอนฟิวชั่นส่งไฟล์มาที่เว็บเพื่อจะตัด
แล้วคุณสามารถรับรู้ได้เอง ไม่ต้องตัด part ที่มีอยู่แล้ว ... ให้ช่างถ่ายรูปแล้ว matching กับ glb ที่มี
เพราะ code ยาว 13 หลัก ช่างใส่เองยาก ... เก็บรูปที่ช่างถ่ายไว้ เพื่อผมจะเข้ามาตรวจสอบอีกครั้ง
ถ้าไม่ใช่ผมแก้หรือลบได้ ... เพิ่มหัวข้อว่าเป็น stock part."*

The full vision is three independent subsystems. **This spec is S1 only** — the data
backbone + capture + review loop. The hard/novel parts ship later and plug into S1's data:

| Sub | What | This spec |
|---|---|---|
| **S1** | Stock registry: worker photo+qty intake → owner review assigns the 13-char code → **worker confirms the GLB matches the physical part** → confirmed stock list, with photos kept for audit + edit/delete | **SHIP** |
| **S2** | Nest "don't re-cut": subtract confirmed stock qty from a new job, badge + link to the stock part; **photo migration to GitHub** (RTDB → repo) as a storage optimization | defer |
| **S3** | AI matching: render GLBs → vision-match the worker photo → pre-suggest code + nearest candidates + confidence | defer |

S1 deliberately leaves a labelled empty slot in the review UI where S3's AI suggestion
will land, so S3 is an enhancement, not a rebuild. S1 exposes `stockQtyByCode(code)` so S2
can subtract without re-querying RTDB.

## Locked decisions (from เอ๋ + spec-review resolutions)

| Fork | Decision | Consequence |
|---|---|---|
| **Build order** | S1 first, standalone + usable; S2/S3 later | เอ๋ can start logging shelf stock today; hardest part (S3) de-risked |
| **Intake flow** | worker photo+qty (no code) → "pending" → เอ๋ assigns code → **"awaiting worker confirm"** → worker verifies GLB vs the real part → confirmed | two-sided check; splits work; S3 just pre-fills the code |
| **Worker GLB confirm** | after เอ๋ assigns a code, the **GLB is sent back to the worker** (who holds the physical part) to tap ✓ correct / ✗ not-it; ✗ bounces to เอ๋ to re-pick | ground-truth verification by the person with the part; works in S1 (no AI needed) |
| **Code entry (S1)** | **manual** — เอ๋ searches/picks the 13-char code from `uploaded_dxfs` while looking at the photo; 3D compare is the primary disambiguator | AI suggestion is S3; S1 picker is search + eyeball + View 3D |
| **Placement** | a **new top-level "Stock" tab**, role-aware (not a Nest modal) | workers reach capture without entering Nest; own render module |
| **Worker-screen language** | **English + Flux everywhere** (เอ๋ FINAL 2026-06-27: *"เปลี่ยนเป็นภาษาอังกฤษ font flux ทั้งหมด เฉพาะช่อง remarks ให้ช่างพิมพ์ภาษาไทยได้"*). The ONLY Thai is what the worker **types into the remarks/note field** | all labels/buttons/toasts/errors English; only `#kdsp-note` carries `.kdsp-th` so typed Thai renders ([[feedback_drawings_ui_no_thai]]) |
| **Photo store (S1)** | compressed **base64 in RTDB only** — no GitHub, no PAT, by anyone | simplest path; removes PAT/SHA/atomicity/orphan-file complexity; GitHub migration → S2 |
| **Stock unit** | **1 row = 1 intake event** (photo+qty+date+who); available qty per code = sum of confirmed rows for that code | เอ๋ deletes a wrong row individually; mirrors `nest_remnants` |
| **Edit/delete** | admin-only (confirm / set+edit code / edit qty / delete / reject); workers add-only + in-session undo-last | matches remnants admin-gating (`isAdmin()`) |
| **S1 ≠ nest** | S1 does **not** change any nesting behaviour | the "don't re-cut" subtraction is S2 |

## Architecture / surfaces

New module **`stockpart.js`** (own IIFE exposing `window.kdStockPart`, like `nest.js`'s
`window.kdNest` — no bundler), owning the whole "Stock Part" tab. Kept out of `app.js`
(already large): the surface is orthogonal (no nest/library/drawing entanglement), has its
own role gating, and S2/S3 will add weight — so the module boundary unblocks parallel future
work and keeps S1 independently reviewable. It reuses, never forks: `window.firebaseDB`,
`isAdmin`, `getRole`, `escapeHtml`, `_kdToast`, `dxfsForMasterCode` / `_uploadedDxfsCache`,
and `_kdOpen3D` — all defined in `app.js`, so `stockpart.js` only calls them at runtime.

**Naming — avoid the Remnants collision:** the existing Remnants Stock modal already owns the
`.kdstock-*` CSS prefix, the `nest_remnants` RTDB node, and `_loadRemnants`/`_saveRemnant` on
`kdNest`. This feature is distinct: CSS prefix **`.kdsp-*`**, RTDB **`stock_parts`**, module
**`window.kdStockPart`**, localStorage **`kd_stock_parts_v1`** / **`kd_sp_submit_times`**.

### Tab registration (touch-points, mirrors the existing tabs)
1. `index.html` **loader array** (`index.html:231`, `var names = [...]`) — add `'stockpart.js'`
   **before `'app.js'`** so `window.kdStockPart` exists when app.js boots. (Scripts load via a
   cache-busting `Promise.all` loader, NOT static `<script src>` tags.)
2. `index.html` `.tabs` (≈line 112) — add `<button id="tab-stockpart" class="tab"
   data-view="stockpart">…Stock Part</button>` (English label + box/package icon, see Icon).
3. `app.js` `_TAB_IDS` (line 202) — add `stockpart: 'tab-stockpart'`.
4. `app.js` `_visibleTabsForRole()` (lines 188-200) — add `stockpart: true` to the admin
   return AND every `switch(getRole())` branch (all roles see it, like a universal tab);
   `applyTabVisibility()` + the `.tab` click handler already gate/show using `_TAB_IDS`.
5. `app.js` `render()` (line 8148) — in the `stack.length === 0` block add
   `if (view === 'stockpart') return window.kdStockPart.renderHome();`.
6. `app.js` boot init (near `initUploadedDxfsSync();` at line 15931) — add
   `if (window.kdStockPart) window.kdStockPart.init();` to attach the live listener.

### Role visibility (within the tab, branch on `isAdmin()`)
| Role | Sees |
|---|---|
| workshop / laser / bend / assemble | **Capture screen** (Thai) + **Confirm-GLB list** (Thai — awaiting rows) + **Stock list** (read-only) |
| admin (เอ๋) | **Review queue** (assign code; sees worker-bounced rows flagged) + **Stock list** (edit/delete) |

The tab appears for everyone; admin-only affordances (review queue, edit/delete) are gated
by `isAdmin()` at render, exactly like the remnants delete button. The capture screen UI is
**identical** for workers and admins. (No separate admin "add directly" form in S1 — admins
just confirm their own intake through the queue; a direct-add shortcut is deferred.)

### Icon (Brushed Steel + Amber standard, [[reference_icon_palette]])
A box/package/shelf glyph rendered in the เอ๋-approved standard: steel-100 body, ink
outline, amber-500 (#F2A93B) on the active/highlight element only — matching every other
CC_ / web icon. Final glyph chosen at build; confirm it reads as "stock/shelf" at tab size.

### CSS organization
All `.kdsp-*` rules live in `style.css` under a `/* Stock module (S1) */` section after
the four theme blocks. **Per-theme opaque overrides** for the card/box surfaces go inside
their respective theme blocks (see Theme safety). No separate stylesheet.

## Data model

### RTDB `stock_parts/<pushId>` (1 row per intake event)
```
{
  status          : 'pending' | 'awaiting_worker_confirm' | 'confirmed' | 'rejected',
  code            : ''  →  '<13-char master_code>'    // set when เอ๋ assigns; '' again if worker bounces
  qty             : <int 1..99>,
  note            : '<string>',                        // optional, Thai allowed; ESCAPED on render
  photo_data      : '<base64 jpeg, no data: prefix>',  // the image (S1: stays here; no GitHub)
  thickness_mm    : <num> | null,                      // copied from uploaded_dxfs[code] at assign
  material        : '<ALPF…>' | '',                    // ditto (for list/nest filters)
  grain           : 'H'|'V'|'ANY'|'EDGE'|'' ,          // fibre direction (H=horizontal, V=vertical,
                                                        //   EDGE=grain-on-edge, ANY=no preference)
  created_at      : <epoch_ms>,
  created_by_role : 'laser'|'bend'|'assemble'|'workshop'|'admin',  // department label, audit only
  reviewed_at     : <epoch_ms> | null,                 // when เอ๋ assigned the code
  reviewed_by_role: 'admin' | null,                    // role label, never a person
  worker_confirmed_at : <epoch_ms> | null,             // when a worker verified the GLB → confirmed
  bounced_from    : '<code>' | '',                     // last code a worker rejected (✗); shown in เอ๋'s queue
  bounced_at      : <epoch_ms> | null
}
```

- **Lifecycle:** `pending` (needs เอ๋) → เอ๋ assigns code → `awaiting_worker_confirm` →
  worker **✓** → `confirmed` (counts as stock) · worker **✗** → back to `pending`
  (flagged `bounced_from`, for เอ๋ to re-pick) · เอ๋ **Reject** → `rejected`.
- **Available stock for code X** = `Σ qty` over rows where `status==='confirmed' && code===X`
  (double-verified: เอ๋ picked + worker confirmed) — `stockQtyByCode(code)`, the value S2
  later subtracts from a nest run.
- **No per-user identity** (app-wide): `*_by_role` are department labels, not people.
- Photo is keyed by `<pushId>` because the code is unknown at intake. On **reject**,
  `photo_data` is **kept** (audit) — admin can hard-delete the row to purge it.
- **`note` and `code` are user/data input → escape on every render:** `textContent` (never
  `innerHTML`) for text; `escapeHtml()` / `CSS.escape()` for any `data-*` attribute or DOM id that
  embeds the code (mirror `nest.js`, which already does this). The code passed to
  `_kdOpen3D` → `_kd3dGlbUrl` is `encodeURIComponent`-wrapped (verified `app.js:2059`), and
  the photo `data:image/jpeg;base64,…` URI is parsed as an image MIME (inert, not HTML) — so
  those two surfaces carry no injection.

### Listener + instant paint
`initStockPartsSync()` — one `ref('stock_parts').on('value')` → `_stockCache` (object keyed
by pushId). All devices update live. (grep-confirm `kd_stock_*` is an unused key before
claiming it.)
- **localStorage mirror `kd_stock_parts_v1` stores METADATA ONLY** (status, code, qty,
  created_at, created_by_role, reviewed_at, thickness_mm, material, grain) — **`photo_data`
  is EXCLUDED**. base64 photos (~300 KB each) would blow the ~5 MB localStorage quota within
  a dozen rows; the mirror is only for instant first-paint of the list/cards, and photos
  fill in when the RTDB listener resolves. (`completed_projects` mirrors fine because it has
  no blobs — stock does, so it must strip them.)
- **Parse defensively:** `try { JSON.parse(...) } catch { _stockCache = {} }` — a corrupt
  mirror must never block boot (RTDB is the source of truth).

### RTDB rules
Writes are anonymous/unauthenticated, the same open pattern `nest_remnants` and
`uploaded_dxfs` already use. **Confirm the live rules permit `stock_parts/*` writes** — if
the rules are global `{".write": true}` it already works; if path-scoped, add a `stock_parts`
node (see [[reference_rtdb_rules_expiry]] — rules with a `now <` expiry can silently DENY).

## Photo pipeline (base64-in-RTDB, no PAT)

1. **Capture (worker):** `<input type="file" accept="image/*" capture="environment">` →
   **client-side compress** in a `<canvas>`: scale longest edge to ≤1000px,
   `toDataURL('image/jpeg', q)` from `q=0.7`, step `q` down by 0.1 to a floor of 0.4 until
   the base64 ≤ ~700 KB. If still too large at the floor, drop the dimension cap one step
   (1000→800→640) and retry. If it still exceeds ~900 KB, **reject with a Thai message
   "รูปใหญ่เกินไป ลองถ่ายใหม่"** (no row written). Strip the `data:image/jpeg;base64,` prefix.
2. **Write (worker):** `firebaseDB.ref('stock_parts').push().set({status:'pending', code:'',
   qty, note, photo_data, created_at, created_by_role:getRole()})`. **Anonymous RTDB write**
   — no PAT, no login (same open path `nest_remnants`/`uploaded_dxfs` use). **Hard payload
   guard:** before the write, reject if the serialized row exceeds ~1.5 MB (belt to the
   compress loop's ~700 KB target — stops a crafted/over-size blob).
3. **Assign code (admin):** `_updateStock(id, {status:'awaiting_worker_confirm', code,
   thickness_mm, material, grain, reviewed_at, reviewed_by_role:'admin'})`. No GitHub/PAT/
   photo-move. The row now carries a GLB-able code → surfaces in the worker Confirm-GLB list.
   (S2 will add the optional RTDB→GitHub migration to reclaim space.)
4. **Worker confirms GLB (worker):** `workerConfirmGlb(id)` → `{status:'confirmed',
   worker_confirmed_at}` (now counts as stock) · or `workerRejectGlb(id)` → `{status:'pending',
   bounced_from:code, bounced_at, code:''}` (back to เอ๋, flagged "ช่างบอกไม่ใช่").
5. **Render:** show the photo via `data:image/jpeg;base64,${photo_data}`.

## The flows

### 1. Capture (worker, Thai)
Photo picker → preview thumbnail → qty stepper (default 1, **min 1 / max 99**, qty 0 blocked
at submit) → optional remarks (Thai input OK) → submit button. On submit: compress → push pending row →
success toast with an **undo-last** affordance (removes the just-pushed row by remembered
pushId). No code field, no 3D. Large touch targets. **All worker-facing UI is English/Flux** —
only the **remarks input** accepts Thai (`#kdsp-note` carries `.kdsp-th` so typed Thai renders; placeholder English). After submit the
form resets to empty; the worker cannot edit a submitted row except via undo-last (then
re-add). See [[feedback_communicate_with_images]] — this screen is photo-first.

### 2. Review (admin / เอ๋, English)
Review queue (rows `status==='pending'`, **newest first** by `created_at`), each card:
- the worker photo (`data:image/jpeg;base64,${photo_data}`),
- meta line `Qty N · by <role> · <relative time>` (relative = `now − created_at`, formatted
  `Nm` / `Nh` and switching to an absolute date past 24h; computed at render, no live ticker),
- if the row was bounced, a **"ช่างบอกไม่ใช่ `<bounced_from>`"** flag so เอ๋ picks differently,
- a **code picker** (below) — eyeball photo vs candidate; **qty and code are both editable**
  (qty uses the same 1..99 stepper),
- a labelled **"AI suggestion — coming soon"** slot (S3 mounts here),
- **Assign code → send to worker** (needs a chosen code → sets `awaiting_worker_confirm`) and
  **Reject** (soft, `status:'rejected'`).
- **After assign/reject:** the card leaves the queue immediately, a brief toast confirms; an
  assigned row now appears in the worker Confirm-GLB list (live).

### 3. Worker confirm GLB (worker, Thai)
Confirm-GLB list = rows `status==='awaiting_worker_confirm'` (any worker may act — no per-user
identity; whoever holds the part confirms). Each card shows the worker's **photo** SIDE-BY-SIDE
with the **live inline GLB** of the assigned code (an embedded `<model-viewer src=_kd3dGlbUrl(code)>`
shown automatically — NOT hidden behind a tap; เอ๋'s requirement: the worker must directly
compare "รูปถ่าย ↔ แบบ 3D"), plus the code and `thickness · material`, a caption
"รูปที่ถ่าย ↔ แบบ 3D — เหมือนกันไหม?", an "ขยายดู 3D" button (opens `_kdOpen3D` full viewer as a
fallback), and two big buttons (English):
- **✓ ถูกต้อง** → `workerConfirmGlb(id)` → `confirmed` (enters stock; card leaves the list).
- **✗ ไม่ใช่** → `workerRejectGlb(id)` → back to `pending` flagged `bounced_from` (returns to
  เอ๋'s queue). Optional one-tap Thai reason later (not S1).
- If the assigned code has **no GLB**, the card still shows photo + code + `thickness·material`
  text so the worker can ✓/✗ from those (the no-model state is acceptable, not a blocker).
- Empty list → "ยังไม่มีรายการรอยืนยัน".

### 4. Stock list (everyone reads; admin edits, English)
Confirmed rows grouped by code into cards, **sorted by code (A→Z)**: code (mono), aggregated
qty pill (`×N in stock`), `thickness · material`, the photo, a **View 3D** action
(`_kdOpen3D(code)` — public CDN GLB, **no PAT needed**; missing model shows the viewer's
existing no-model state), and admin-only **edit** (qty / code) + **delete** icons.
- **Delete** removes only that row; if it was the last confirmed row for a code, the code
  drops off the list (aggregate = 0).
- **Edit code** moves that row's qty to the new code (atomic; re-aggregates).
- **Search** box: real-time, case-insensitive, matches the code substring; **empty states** —
  no confirmed stock → "No stock yet", search with no match → "No matching code".

### Code picker (S1, manual)
Search input filters the candidate pool = `Object.values(_uploadedDxfsCache)` (every part
ever cut — exactly the set a leftover could be), **de-duplicated to one row per
`master_code`** (on duplicate records, keep the newest `uploaded_at`). Each result row:
code (mono) + `thickness · material · grain` + a **3D/▶** that opens `_kdOpen3D(code)` so
เอ๋ compares the model to the photo, then "use this code". Empty search → "No matching code".
- **W×H is NOT shown** — true dims need a per-DXF parse (`_uploadedDxfsCache` has
  thickness/material/grain/url, not bbox). The **3D model is the disambiguator** for
  look-alike flat panels; lazy W×H is deferred to S2 (no speculative hook in S1).
- **Direct type/paste** of a code is allowed (admin escape hatch). If the typed code is not
  in `uploaded_dxfs`, confirm still proceeds but warns "no DXF/GLB for this code" and leaves
  thickness/material/grain blank (View 3D shows the no-model state).

## States & validation defaults (consolidated)
| Thing | Default |
|---|---|
| qty | int, min 1, max 99, default 1; 0 blocked |
| pending queue sort | newest `created_at` first |
| stock list sort | code A→Z |
| code-picker dedupe | one row per `master_code`, newest `uploaded_at` wins |
| relative time | `now − created_at` → `Nm`/`Nh`, absolute date >24h, render-time only |
| undo-last | current tab session, single step, in-memory pushId, cleared on reload |
| empty: stock list | "No stock yet" |
| empty: review queue | "Nothing to review" |
| empty: confirm-GLB list | "ยังไม่มีรายการรอยืนยัน" (Thai — worker surface) |
| empty: code search | "No matching code" |
| reject | `status:'rejected'`, hidden from queue+list, `photo_data` kept; admin can hard-delete |

## Remarks-field Thai font (reuse the exact Comments stack)
**All Stock Part UI is English/Flux** (เอ๋ FINAL). The ONE place Thai may appear is the text a
worker **types into the remarks/note field** — so ONLY `#kdsp-note` gets the Comments stack
(`style.css:1034` `.comment-text`) — Flux first (Latin), then the device's **system Thai fonts**
(browser per-glyph fallback, webfont-free):
```
font-family: "Flux Architect", "IBM Plex Sans Thai", "Noto Sans Thai",
             "Leelawadee UI", "Sukhumvit Set", "Thonburi", Tahoma, -apple-system, sans-serif;
```
1. Define class **`.kdsp-th`** with that **exact** stack and apply it **only to the remarks
   `<input id="kdsp-note">`** (placeholder stays English). A plain class selector overrides
   the `font-family` inherited from `body` (the only global `*` rule sets `box-sizing`, not
   fonts). No `@font-face`/`<link>` needed: Thai Windows has Leelawadee UI, iOS/Mac have
   Thonburi/Sukhumvit, Android has Noto — Comments already rely on this and render fine.
2. Every other Stock Part string (capture labels/button, worker-confirm captions + ✓/✗
   buttons, review, list, toasts, errors) is **English / Flux Architect**.
2. Everything else (tab chrome, review queue, stock list, all admin-facing strings) stays
   **English / Flux Architect**.

## Theme safety ([[reference_web_themes]], [[reference_remnants_stock_modal]])
sketch/chalk themes apply a global reset (`html[data-theme] body * { background:transparent
!important }`) that strips backgrounds, borders, and shadows — new surfaces float
see-through unless overridden. So every `.kdsp-*` card/box/queue surface needs
**theme-prefixed opaque overrides**, exactly as the Remnants modal does: e.g.
`html[data-theme="sketch"] .kdsp-box{ background:#f3ecdd !important }`,
`html[data-theme="chalk"] .kdsp-box{ background:#2f3a38 !important }`, plus obsidian +
default dark. The amber NEW/qty pills follow the existing theme-safe `.part-new-badge`
pattern (doubled-class to beat the body-text reset where needed).

## Security & quota (proportionate, trust-based shop)
- **Anonymous writes** match the existing `nest_remnants`/`uploaded_dxfs` model — no new
  exposure. Guards: the ~700 KB compress target + a ~1.5 MB hard payload reject; a
  **per-device daily soft cap** (localStorage `kd_sp_submit_times`: warn >10, block >20
  intakes / 24h) to stop a runaway/fat-finger loop. Not server-enforced — proportionate to a
  trust-based shop.
- **Admin gating is client-side (`isAdmin()`)** — same as the whole app today
  (remnants delete, `bent_status`, etc. are all open RTDB + client-gated; the
  cabinet-freshness spec explicitly defers role-gated rules: *"the shop runs on trust"*).
  This is **not a ship blocker** for S1's threat model. If/when RTDB rules are hardened
  globally, `stock_parts` should join that pass (write-pending-only for anon, mutate
  admin-only) — tracked as the app-wide deferral, not S1 scope.
- **Base64 quota:** compressed photos (~200–400 KB) × a few hundred rows stay well under
  Spark's 1 GB RTDB store; the per-device cap bounds pending growth. **Unconfirmed pending
  rows older than ~30 days** get an optional sweep (S2 housekeeping). S2's GitHub migration
  moves confirmed photos out of RTDB entirely.
- **qty aggregation integrity:** `stockQtyByCode()` is recomputed from the **live
  `_stockCache`** on every listener tick, and each confirm/edit/delete is an atomic per-row
  `update()`/`remove()` (full-value sets, not increments) → no lost-update. **Do NOT wrap the
  whole `stock_parts` node in a `transaction()`** — that would re-download every base64 photo
  on each write (bandwidth anti-pattern). Same-row concurrent edits resolve last-write-wins,
  acceptable for an effectively single-admin shop; if multi-admin ever matters, scope a
  transaction to the *single row*, never the tree.
- **Stored XSS / injection:** see the Data model escaping rules (textContent + `escapeHtml`/
  `CSS.escape`; `_kd3dGlbUrl` already `encodeURIComponent`s; data: URI inert).
- **localStorage mirror** holds metadata only (no `photo_data`) + defensive parse — see Listener.
- **No PAT on any device** (S1 uses no GitHub); admin PAT untouched.
- **List render perf:** if stock grows large, lazy-render base64 thumbnails (defer; not S1).

## Components & isolation

| Unit | Purpose | Depends on |
|---|---|---|
| `stockpart.js` IIFE → `window.kdStockPart = { renderHome, init, stockQtyByCode, confirmedByCode, _test }` | `renderHome()` mounts capture / worker-confirm / review / list per role; `init()` attaches the listener | `isAdmin`, `getRole` |
| `compressImage(file) → base64` | canvas downscale + quality-loop + dimension fallback to ≤~700 KB, else reject | — (pure-ish, testable) |
| `stockStore` (`saveIntake` / `assignCode` / `workerConfirmGlb` / `workerRejectGlb` / `rejectIntake` / `_updateStock` / `_deleteStock`) | RTDB CRUD + the lifecycle transitions on `stock_parts`; on write fail → toast + 1 retry, LS mirror keeps UI painted | `firebaseDB` |
| `initStockPartsSync()` | live `stock_parts` → `_stockCache` + `kd_stock_parts_v1` | `firebaseDB` |
| `stockQtyByCode()` / `confirmedByCode()` (**public on `window.kdStockPart` for S2**) | aggregate confirmed rows by code | `_stockCache` |
| `renderCapture()` (Thai) | worker photo+qty+note+submit, undo-last | `compressImage`, `saveIntake`, `.kdsp-th` |
| `renderReview()` (admin) | review queue + bounced flag + code picker + AI-slot + editable qty/code + assign/reject | `assignCode`, `rejectIntake`, code picker, `_kdOpen3D` |
| `renderWorkerConfirm()` (Thai) | awaiting list: photo beside 3D model + ✓ ถูกต้อง / ✗ ไม่ใช่ | `workerConfirmGlb`, `workerRejectGlb`, `_kdOpen3D`, `.kdsp-th` |
| `renderList()` | grouped stock cards + search + View 3D + admin edit/delete + empty states | `confirmedByCode`, `_kdOpen3D` |
| `renderCodePicker()` | searchable `uploaded_dxfs` candidates (dedupe) + 3D compare + direct type-in | `_uploadedDxfsCache`, `_kdOpen3D` |

## Phase 1 scope

**SHIP:** the "Stock Part" tab (all roles, role-gated affordances); `stockpart.js` module; RTDB
`stock_parts` (1 row/intake) + the 4-state lifecycle + live sync + LS mirror; worker capture
(Thai, camera, compress→base64, anonymous write, undo-last, validation); admin review queue
(manual code picker via `uploaded_dxfs` search + 3D compare + direct type-in, editable
qty/code, bounced-row flag, assign-code/reject, post-action UX); **worker Confirm-GLB list
(Thai — photo beside the 3D model, ✓ ถูกต้อง / ✗ ไม่ใช่ round-trip, bounce-back to เอ๋)**;
stock list grouped by code (qty aggregation, sort, search, empty states, View 3D, admin
edit/delete with correct merge/aggregate semantics); English/Flux UI throughout, only the remarks field accepts Thai input;
theme-safe styling across dark/sketch/chalk/obsidian; textContent escaping.

**DEFER:**
- **S2 — nest "don't re-cut":** subtract `stockQtyByCode()` from a nest run, badge + link;
  **photo migration RTDB→GitHub** (`Drawings/stock-photos/<id>.jpg`, `main` branch, via PAT,
  with the `_uploadPartDxf` SHA-fetch pattern for any overwrite) to reclaim RTDB space;
  pending-row housekeeping sweep; lazy W×H in the code picker; admin "add directly" shortcut.
  **Requires Group 1 coordination** (CC_* nest qty wiring) via `docs/coordination/group-sync.md`.
- **S3 — AI photo→code:** render GLBs to a 2D gallery, vision-match the worker photo,
  pre-fill the review code picker with ranked candidates + confidence + nearest matches.
  The review UI already reserves the slot. (The hard/novel one — flat stainless panels look
  alike, so S3 is "AI suggests, เอ๋ confirms," never auto-accept.)
- per-user identity / role-gated Firebase rules (shop runs on trust today).

## Error handling / edge cases
- **Compress fails / non-image** → reject the file, Thai message; no row written.
- **Still oversized at q-floor + min dimension** → reject "รูปใหญ่เกินไป ลองถ่ายใหม่".
- **Worker ✗ (ไม่ใช่)** → row returns to `pending` with `bounced_from` set; เอ๋'s queue shows
  the "ช่างบอกไม่ใช่ `<code>`" flag so the next pick differs. No data lost.
- **Assigned code has no GLB** → the Confirm-GLB card still shows photo + code +
  `thickness·material` text so the worker can ✓/✗; the 3D pane shows the no-model state.
- **Confirm with a code that has no GLB** → View 3D shows the viewer's existing no-model state.
- **Duplicate code** across confirmed rows → list aggregates (`×N`); each row individually
  deletable (the intended audit trail).
- **RTDB write fails (offline)** → toast + one retry; LS mirror keeps the list painted.
- **Reject** → hidden from queue + list, `photo_data` kept; admin hard-delete purges.
- **Stale/parallel sessions** → live `on('value')` reconciles last-write-wins.
- **Worker edits** → only in-session undo-last (no per-user auth to scope "own"); otherwise re-add.

## Testing

**Harness (already in the repo):** `package.json` → `"test": "node --test test/*.mjs"`, with
`jsdom` available. Name new files `test/stockpart*.test.mjs` (the glob ignores `*.test.js`).
Boot the browser module in jsdom via the `new window.Function(SRC)(...)` pattern from
`test/nestOrientDom.test.mjs`, then drive it through `window.kdStockPart._test`. Precedent for
a stock-table unit test: `test/nestStockEnable.test.mjs`. Run a step's test with
`node --test test/stockpart-logic.test.mjs` (red → green).

**Tier 1 — pure logic (via `window.kdStockPart._test`, real `node --test`):** the compress
**sizing decision** `_decideCompress(w,h,bytes)` (longest-edge scale, quality-loop + dimension
fallback terminate; reject path triggers) — factored out of the canvas so it's pure;
`stockQtyByCode` / `confirmedByCode` aggregation (only `confirmed` counts; pending /
`awaiting_worker_confirm` / rejected excluded; multi-row same code summed); `codePickerFilter`
(substring, case-insensitive, dedupe by master_code newest); `relativeTime` formatter
(`Nm`/`Nh`/date); escaping (`escapeHtml` on a `<script>` in `note` renders inert).

**Tier 2 — RTDB CRUD + lifecycle (jsdom + a firebaseDB mock, or synthetic self-cleaning rows):** push pending → appears in
review queue; assign code → leaves queue, enters Confirm-GLB list (`awaiting_worker_confirm`);
worker ✓ → enters stock list with summed qty (`confirmed`); worker ✗ → returns to review
queue flagged `bounced_from` (and NOT counted in stock); edit qty/code → aggregate updates /
row migrates; reject → vanishes, photo_data retained; delete → gone. Two preview contexts:
act on one, the other view updates (sync).

**Tier 3 — UI / manual on เอ๋'s device + a worker phone (cannot run headless):** phone camera
capture + the Confirm-GLB `<model-viewer>` render only in a real browser. Verify: role gates
(worker sees capture + Confirm-GLB list + read-only stock list, no review/edit; admin sees
review queue + edit/delete; hidden-tab bounce); the **round-trip on real devices** — worker
captures, เอ๋ assigns a code, the item appears in the worker's Confirm-GLB list with the 3D
model beside the photo, ✓ moves it to stock / ✗ bounces it back flagged; Thai font on the
worker screens (computed `font-family` = the Thai stack) while the rest stays Flux; **theme
safety across dark / sketch / chalk / obsidian** (every `.kdsp-*` surface opaque +
readable, pills visible — getComputedStyle in Chrome DevTools).

**Ship discipline ([[feedback_verify_before_done]], [[feedback_check_deploy]],
[[feedback_use_chrome_not_edge]], [[feedback_log_changes_to_sync]]):** Chrome only (never
Edge). After push, `fetch(no-store)` the deployed `stockpart.js` until the new symbol appears
(say "CDN"/"the live file", not "edge"), confirm against the real commit hash, then exercise
on the live host. Log the change to `docs/coordination/group-sync.md` immediately on
completion with the real commit hash (one entry, not batched).
