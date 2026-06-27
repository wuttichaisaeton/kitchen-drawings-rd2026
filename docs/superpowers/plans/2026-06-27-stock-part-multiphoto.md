# Stock Part multi-photo (1-3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a worker attach 1-3 photos to one Stock Part intake; store `photos[]` (with `photo_data=photos[0]` for back-compat); show all photos in review/confirm + a multi-image lightbox; send all photos to the S3 AI.

**Architecture:** A `_rowPhotos(r)` shim makes every render read a photo list (`r.photos` or `[r.photo_data]`), so old single-photo rows keep working. Capture becomes a 1-3 photo tray. The lightbox cycles. The AI endpoint accepts `photos[]` and sends one image block per photo to Haiku.

**Tech Stack:** vanilla JS (`drawings-ui/stockpart.js`), `node --test`; Python/Flask (`LINE_System/stock_match.py`, `webhook_server.py`), `python test_stock_match.py`.

**Spec:** `drawings-ui/docs/superpowers/specs/2026-06-27-stock-part-multiphoto-design.md`.

**Order:** Phase A web (Tasks 1-6) ships first and is back-compat (old rows fine, AI keeps sending `photo` too). Phase B backend (Task 7) then accepts `photos[]`. Commit only the files each task names (other sessions share the folders).

---

## Task 1: `_rowPhotos(r)` shim (TDD)

**Files:** Modify `stockpart.js`; Test `test/stockpart-logic.test.mjs`.

- [ ] **Step 1: Failing test** — append to `test/stockpart-logic.test.mjs`

```javascript
test('_rowPhotos returns the photo list (photos[] | [photo_data] | [])', () => {
  const { T } = boot();
  assert.deepEqual(T._rowPhotos({ photos: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(T._rowPhotos({ photo_data: 'a' }), ['a']);          // old single-photo row
  assert.deepEqual(T._rowPhotos({ photos: [], photo_data: 'a' }), ['a']); // empty array → fall back
  assert.deepEqual(T._rowPhotos({}), []);
  assert.deepEqual(T._rowPhotos(null), []);
});
```

- [ ] **Step 2: Run → fail** — `node --test test/stockpart-logic.test.mjs` → `T._rowPhotos is not a function`.

- [ ] **Step 3: Implement** — in `stockpart.js`, add near the pure helpers (after `_noteHtml`):

```javascript
  // 1-3 photos per row; old rows have only photo_data. Every render reads through this.
  function _rowPhotos(r) {
    if (r && Array.isArray(r.photos) && r.photos.length) return r.photos;
    if (r && r.photo_data) return [r.photo_data];
    return [];
  }
```

- [ ] **Step 4: Expose on `_test`** — add `_rowPhotos: _rowPhotos,` to the `_test` object.

- [ ] **Step 5: Run → pass.** `node --test test/stockpart-logic.test.mjs`.

- [ ] **Step 6: Commit** — `git add stockpart.js test/stockpart-logic.test.mjs && git commit -m "feat(stock-part): _rowPhotos shim (photos[] | photo_data) + test"`

---

## Task 2: Multi-image lightbox `_openPhoto(photos, index)`

**Files:** Modify `stockpart.js`.

- [ ] **Step 1: Replace `_openPhoto`** — change the signature to accept a single b64 OR an array, with ‹ › nav + a counter. Replace the whole function:

```javascript
  // photo lightbox — accepts one b64 or an array (+ startIndex); ‹ › / arrow keys cycle.
  function _openPhoto(photos, startIndex) {
    var list = Array.isArray(photos) ? photos.slice() : (photos ? [photos] : []);
    if (!list.length) return;
    var i = Math.min(Math.max(0, startIndex | 0), list.length - 1);
    var ov = document.createElement('div');
    ov.setAttribute('style', 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.88) !important;cursor:zoom-out;padding:16px;');
    var img = document.createElement('img');
    img.setAttribute('style', 'max-width:96vw;max-height:96vh;border-radius:8px;box-shadow:0 6px 40px rgba(0,0,0,.6);');
    function show() { img.src = 'data:image/jpeg;base64,' + list[i]; if (cnt) cnt.textContent = (i + 1) + '/' + list.length; }
    ov.appendChild(img);
    var prev, next, cnt;
    if (list.length > 1) {
      var navCss = 'position:fixed;top:50%;transform:translateY(-50%);font-size:40px;color:#fff;cursor:pointer;padding:8px 16px;user-select:none;';
      prev = document.createElement('div'); prev.textContent = '‹'; prev.setAttribute('style', navCss + 'left:8px;');
      next = document.createElement('div'); next.textContent = '›'; next.setAttribute('style', navCss + 'right:8px;');
      cnt = document.createElement('div'); cnt.setAttribute('style', 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);color:#fff;font-size:14px;');
      prev.addEventListener('click', function (e) { e.stopPropagation(); i = (i - 1 + list.length) % list.length; show(); });
      next.addEventListener('click', function (e) { e.stopPropagation(); i = (i + 1) % list.length; show(); });
      ov.appendChild(prev); ov.appendChild(next); ov.appendChild(cnt);
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft' && list.length > 1) { i = (i - 1 + list.length) % list.length; show(); }
      else if (e.key === 'ArrowRight' && list.length > 1) { i = (i + 1) % list.length; show(); }
    }
    function close() { try { ov.remove(); } catch (e) {} document.removeEventListener('keydown', onKey); }
    ov.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
    show();
  }
```

> All existing callers pass a single b64 — still works (wrapped to `[b64]`). New callers pass `(_rowPhotos(r), index)`.

- [ ] **Step 2: Syntax** — `node --check stockpart.js`.
- [ ] **Step 3: Commit** — `git add stockpart.js && git commit -m "feat(stock-part): multi-image lightbox (array + ‹ › nav + counter)"`

---

## Task 3: Capture photo-tray (1-3 add/remove)

**Files:** Modify `stockpart.js` (`_buildCapture`); Modify `stockpart.js` constant `MAX_BYTES` usage — add a row ceiling for multi.

- [ ] **Step 1: Add a multi-photo row ceiling constant** — near the constants, after `MAX_BYTES`:

```javascript
  var ROW_MAX_BYTES = 2600000;             // 1-3 photos + meta hard reject (per row)
```

- [ ] **Step 2: Replace the capture photo UI + handlers** — in `_buildCapture`, replace the single-photo `<label>…</label><img preview>` markup with a tray, and the `photoB64` single-var logic with a `photos` array.

Replace the `el.innerHTML = … 'Send to review'` block's photo line:
```javascript
      '<label class="kdsp-photo" id="kdsp-photo-label"><input type="file" accept="image/*" id="kdsp-photo" hidden>' +
      '<span class="kdsp-photo-hint">Take / choose a photo</span></label>' +
      '<img class="kdsp-preview" id="kdsp-preview" alt="" hidden>' +
```
with:
```javascript
      '<div class="kdsp-phototray" id="kdsp-phototray"></div>' +
      '<label class="kdsp-photo" id="kdsp-photo-label"><input type="file" accept="image/*" capture="environment" multiple id="kdsp-photo" hidden>' +
      '<span class="kdsp-photo-hint">Add photo (1-3)</span></label>' +
```

Replace `var qty = 1, photoB64 = null;` with `var qty = 1, photos = [];` and replace the photo `change` handler + submit guard:

```javascript
    var tray = el.querySelector('#kdsp-phototray');
    var label = el.querySelector('#kdsp-photo-label');
    function renderTray() {
      tray.innerHTML = photos.map(function (b64, idx) {
        return '<span class="kdsp-traythumb"><img src="data:image/jpeg;base64,' + b64 + '" alt=""><button type="button" class="kdsp-trayx" data-i="' + idx + '">✕</button></span>';
      }).join('');
      tray.querySelectorAll('.kdsp-trayx').forEach(function (b) {
        b.addEventListener('click', function () { photos.splice(Number(b.getAttribute('data-i')), 1); renderTray(); });
      });
      label.style.display = (photos.length >= 3) ? 'none' : '';
      submit.disabled = photos.length < 1;
      el.querySelector('.kdsp-photo-hint').textContent = 'Add photo (' + photos.length + '/3)';
    }
    el.querySelector('#kdsp-photo').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []).slice(0, 3 - photos.length);
      e.target.value = '';                 // allow re-picking the same file
      if (!files.length) return;
      el.querySelector('.kdsp-photo-hint').textContent = 'Compressing…';
      Promise.all(files.map(function (f) { return compressImage(f).then(function (b64) { return b64; }).catch(function () { return null; }); }))
        .then(function (results) {
          var added = 0;
          results.forEach(function (b64) { if (b64 && photos.length < 3) { photos.push(b64); added++; } });
          if (added < results.length) _kdToast('Some photos were skipped (invalid / too large)');
          renderTray();
        });
    });
```

Replace the submit handler's row build + guard:
```javascript
    submit.addEventListener('click', async function () {
      if (!photos.length) return;
      if (_submitCount24h() >= CAP_BLOCK) { _kdToast('Too many added today — try tomorrow'); return; }
      var pics = photos.slice(0, 3);
      var row = { status: 'pending', code: '', qty: qty, note: el.querySelector('#kdsp-note').value || '', photos: pics, photo_data: pics[0], created_at: Date.now(), created_by_role: (typeof getRole === 'function' ? getRole() : 'workshop') };
      submit.disabled = true;
      try {
        if (JSON.stringify(row).length > ROW_MAX_BYTES) throw new Error('too-large');
        _undoLast = await saveIntake(row);
        _fireAiMatch(_undoLast, pics, row.note);
        var _n = _recordSubmit();
        _kdToast('Sent — waiting for review · you can undo');
        if (_n > CAP_WARN) _kdToast('A lot added today');
        renderHome();
      } catch (e) { submit.disabled = false; _kdToast(e && e.message === 'too-large' ? 'Photos too large — use fewer' : 'Save failed — try again'); }
    });
    renderTray();
```

- [ ] **Step 3: Tray CSS** — append to `style.css` (after the `.kdsp-photo` rules):

```css
.kdsp-phototray { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.kdsp-traythumb { position: relative; display: inline-block; }
.kdsp-traythumb img { width: 84px; height: 84px; object-fit: cover; border-radius: 10px; background: #0f1419; }
.kdsp-trayx { position: absolute; top: -6px; right: -6px; width: 22px; height: 22px; border-radius: 50%; border: none; background: #b3261e; color: #fff; cursor: pointer; font-size: 12px; line-height: 1; }
```

- [ ] **Step 4: Syntax** — `node --check stockpart.js`.
- [ ] **Step 5: Commit** — `git add stockpart.js style.css && git commit -m "feat(stock-part): capture photo-tray (add/remove up to 3, multiple, 2.6MB row guard)"`

---

## Task 4: Render swaps (review / worker-confirm / list use `_rowPhotos`)

**Files:** Modify `stockpart.js`.

- [ ] **Step 1: Review (`_buildReview`)** — at the top of the `rows.forEach(function (r) {` body, add `var _pics = _rowPhotos(r);`. Replace each `(r.photo_data || '')` in this card with `(_pics[0] || '')`. Add a photo strip right after the card opens (inside `.kdsp-revmeta`, before the meta `<p>`): build it in JS after `card.innerHTML = …`:

```javascript
      // photo strip (1-3) — click any to open the lightbox at that index
      if (_pics.length > 1) {
        var strip = document.createElement('div'); strip.className = 'kdsp-phototray';
        strip.innerHTML = _pics.map(function (b, idx) { return '<span class="kdsp-traythumb"><img src="data:image/jpeg;base64,' + b + '" data-i="' + idx + '" alt=""></span>'; }).join('');
        var meta = card.querySelector('.kdsp-revmeta'); if (meta) meta.insertBefore(strip, meta.firstChild);
        strip.querySelectorAll('img').forEach(function (im) { im.style.cursor = 'zoom-in'; im.addEventListener('click', function () { _openPhoto(_pics, Number(im.getAttribute('data-i'))); }); });
      }
```
Update the existing thumb click handler to open the list: change `_openPhoto(r.photo_data)` → `_openPhoto(_pics, 0)`.

- [ ] **Step 2: Worker-confirm (`_buildWorkerConfirm`)** — add `var _pics = _rowPhotos(r);` in its `rows.forEach`. Replace `(r.photo_data || '')` in the figure with `(_pics[0] || '')`. Change the photo click handler `_openPhoto(r.photo_data)` → `_openPhoto(_pics, 0)`. After the card builds, if `_pics.length > 1` insert the same strip before the compare block (mirror Step 1; clicks → `_openPhoto(_pics, idx)`).

- [ ] **Step 3: List (`_buildList`)** — the card thumb uses `g.rows[0] && g.rows[0].photo_data`; change to `(_rowPhotos(g.rows[0])[0])`, and the thumb click `_openPhoto(g.rows[0] && g.rows[0].photo_data)` → `_openPhoto(_rowPhotos(g.rows[0]), 0)`.

- [ ] **Step 4: Syntax + tests** — `node --check stockpart.js && node --test` (all green).
- [ ] **Step 5: Commit** — `git add stockpart.js && git commit -m "feat(stock-part): render all photos via _rowPhotos (review strip + confirm strip + list thumb + lightbox)"`

---

## Task 5: LS mirror strips `photos`; `_fireAiMatch` sends `photos`

**Files:** Modify `stockpart.js`.

- [ ] **Step 1: Strip `photos` from the LS mirror** — in `_stripPhotos`, after `delete c.photo_data;` add `delete c.photos;`.

- [ ] **Step 2: `_fireAiMatch` accepts a list** — change the signature + body to send `photos` (and keep `photo` for one release of backend compat):

```javascript
  function _fireAiMatch(id, photos, remarks, endpoint) {
    endpoint = endpoint || KDSP_AI_ENDPOINT;
    var list = Array.isArray(photos) ? photos : (photos ? [photos] : []);
    if (!id || !list.length || !endpoint) return;
    try {
      var w = (typeof window !== 'undefined') ? window : null;
      var f = (w && typeof w.fetch === 'function') ? w.fetch.bind(w) : (typeof fetch === 'function' ? fetch : null);
      if (!f) return;
      f(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, photos: list, photo: list[0], remarks: remarks || '' }) }).catch(function () {});
    } catch (e) {}
  }
```

- [ ] **Step 3: Update the `_fireAiMatch` tests** — in `test/stockpart-logic.test.mjs`, the two `_fireAiMatch` tests now pass a list; update the body assertion to expect `{id, photos:[...], photo:..., remarks}`:

```javascript
  // in the POST test: pass ['B64'] and assert body.photos deep-equals ['B64'] and body.photo === 'B64'
```
(Adjust the existing `_fireAiMatch` POST test: call `T._fireAiMatch('ID1', ['BASE64'], 'ยาว 946', 'https://x.onrender.com/api/stock-match')` and `assert.deepEqual(JSON.parse(calls[0].opts.body), { id:'ID1', photos:['BASE64'], photo:'BASE64', remarks:'ยาว 946' })`. The no-op test: `T._fireAiMatch('ID','B64','r','https://y/api')` still fires once because a bare string wraps to `['B64']` — keep asserting it fires; for the no-op cases use `[]`/missing id.)

- [ ] **Step 4: Run tests** — `node --test test/stockpart-logic.test.mjs` (green).
- [ ] **Step 5: Commit** — `git add stockpart.js test/stockpart-logic.test.mjs && git commit -m "feat(stock-part): LS-mirror strips photos; _fireAiMatch sends photos[] (+ photo compat)"`

---

## Task 6: Web deploy + verify

- [ ] **Step 1:** `git push origin main`; `gh run watch` the run for this HEAD; `curl -s -H 'Cache-Control: no-store' .../stockpart.js | grep -c _rowPhotos` ≥ 1.
- [ ] **Step 2: Live (Chrome, ?admin=1):** on the capture screen, add 2 photos (the tray shows 2 thumbnails + ✕ removes one); submit; the new pending row has `photos.length===2` (check RTDB); the review card shows a 2-photo strip; lightbox ‹ › cycles 1/2↔2/2; an old single-photo row still renders. Console clean.
- [ ] **Step 3: Board** — append one entry to `docs/coordination/group-sync.md` (web half), commit + push.

---

## Task 7: Backend accepts `photos[]` (all images to Haiku)

**Files:** Modify `LINE_System/stock_match.py`, `LINE_System/webhook_server.py`; Test `LINE_System/test_stock_match.py`.

- [ ] **Step 1: Failing test** — append to `test_stock_match.py`

```python
def test_call_model_sends_one_image_block_per_photo():
    captured = {}
    class FakeMsg:
        content = [type("B", (), {"type": "text", "text": '{"ranked":[]}'})()]
    class FakeClient:
        class messages:
            @staticmethod
            def create(**kw): captured.update(kw); return FakeMsg()
    out = sm.call_model(FakeClient(), ["b1", "b2", "b3"], "PROMPT")
    blocks = captured["messages"][0]["content"]
    imgs = [b for b in blocks if b.get("type") == "image"]
    assert len(imgs) == 3
    assert imgs[0]["source"]["data"] == "b1"
    assert blocks[-1]["type"] == "text"   # text after the images
```

- [ ] **Step 2: Run → fail** — `cd LINE_System && python test_stock_match.py` (call_model still takes a single `photo_b64`).

- [ ] **Step 3: Implement** — in `stock_match.py`, change `call_model` + `run_match` to take a photo **list**:

```python
def call_model(client, photos, prompt, model=SM_MODEL, max_tokens=400):
    """Anthropic vision call with 1-3 images. `photos` = list of base64 jpeg."""
    content = [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": p}} for p in (photos or [])]
    content.append({"type": "text", "text": prompt})
    msg = client.messages.create(model=model, max_tokens=max_tokens, temperature=0,
                                 messages=[{"role": "user", "content": content}])
    parts = [b.text for b in msg.content if getattr(b, "type", "") == "text"]
    return "".join(parts)

def run_match(client, rtdb_url, row_id, photos, remarks):
    catalog = read_catalog(rtdb_url)
    candidates = narrow_candidates(catalog, remarks)
    valid = {c["code"] for c in candidates}
    prompt = build_prompt(remarks, candidates)
    text = call_model(client, photos, prompt)
    ranked = parse_ranked(text, valid)
    write_suggestion(rtdb_url, row_id, {"status": "ok", "ranked": ranked, "model": SM_MODEL, "at": _now_ms()})
    return ranked
```

Update the existing `test_run_match_orchestration_writes_ok_payload` mock: it sets `sm.call_model = lambda client, photos, prompt: ...` (rename the 2nd param to `photos`) and calls `sm.run_match(..., photos=["B64"], remarks="946")`.

- [ ] **Step 4: Route accepts `photos`** — in `webhook_server.py` `api_stock_match`, replace the single-photo extraction + size guard:

```python
    photos = data.get("photos") or ([data["photo"]] if data.get("photo") else [])
    remarks = data.get("remarks", "")
    if not row_id or not photos:
        return _sm_cors(make_response(jsonify({"ok": False, "error": "missing id/photos"}), 400))
    if sum(len(p or "") for p in photos) > 5_000_000:
        return _sm_cors(make_response(jsonify({"ok": False, "error": "too-large"}), 400))
    try:
        ranked = _sm.run_match(_client_for_context, RTDB_URL, row_id, photos, remarks)
```
(remove the old `photo = data.get("photo")` line.)

- [ ] **Step 5: Run tests + compile** — `cd LINE_System && python test_stock_match.py` (ALL PASS) and `python -m py_compile webhook_server.py`.

- [ ] **Step 6: Commit + deploy** — `git add stock_match.py test_stock_match.py webhook_server.py && git commit -m "feat(stock-match): accept photos[] — send all 1-3 images to Haiku (photo compat)" && git push origin master`. Poll `OPTIONS /api/stock-match` → 204; re-run the AI from the web with a 2-photo row → 200 + ranked.

- [ ] **Step 7: Board** — append the backend half to `docs/coordination/group-sync.md`, commit + push.

---

## Self-review
- **Spec coverage:** photos[] + photo_data compat (T1), lightbox multi (T2), capture tray + payload guard (T3), render strips/list (T4), LS strip + AI photos[] (T5), backend all-images (T7) — all present. ✓
- **Type consistency:** `_rowPhotos`, `photos` array, `_fireAiMatch(id, photos, …)`, route `photos`, `call_model(client, photos, prompt)`, `run_match(…, photos, remarks)` consistent across web + backend + tests. ✓
- **No placeholders:** every step has concrete code/edits. ✓
- **Back-compat:** old rows (photo_data) via `_rowPhotos`; backend still accepts `photo`; web still sends `photo`. ✓
