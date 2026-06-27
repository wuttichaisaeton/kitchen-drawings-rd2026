# Stock Part S3 — AI image-match Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a worker submits a leftover-part photo (Stock Part S1), an AI vision model (Haiku 4.5, on the existing LINE-bot Render backend) suggests the 13-char code; the suggestion appears in เอ๋'s review card for one-tap use.

**Architecture:** Web fires a fire-and-forget POST to a new Render endpoint at intake; the backend reads the `uploaded_dxfs` catalog, narrows by the remarks length, asks Haiku 4.5 vision to rank candidate codes, and PATCHes the result to `stock_parts/<id>/ai_suggestion` (RTDB REST). The web review card's live listener renders that into the reserved `.kdsp-ai-slot`. AI suggests; เอ๋ confirms. Fully additive — if the backend is down, the row gets no `ai_suggestion` and the existing dimension auto-match shows unchanged.

**Tech Stack:** Web = vanilla JS (`drawings-ui/stockpart.js`), `node --test` + jsdom. Backend = Python 3.11 / Flask (`LINE_System/webhook_server.py` + new `LINE_System/stock_match.py`), `anthropic` SDK, standalone `python` assert test.

**Spec:** `drawings-ui/docs/superpowers/specs/2026-06-27-stock-part-ai-match-design.md` (read first).

**Two repos:** Phase A in `drawings-ui` (web). Phase B in `LINE_System` (backend). They integrate only through RTDB, so Phase A ships and is testable on its own (renders a synthetic `ai_suggestion`); Phase B then produces real ones. Commit in the repo each task names.

**Fixed values (no placeholders except the one marked):**
- RTDB base: `https://kitchen-drawings-default-rtdb.asia-southeast1.firebasedatabase.app`
- Web origin (for CORS): `https://wuttichaisaeton.github.io`
- Model: `claude-haiku-4-5-20251001`
- **Render base URL: OBTAIN from เอ๋ / the Render dashboard** (the host LINE's webhook points to, ends `.onrender.com`). Used only to set `KDSP_AI_ENDPOINT`. Until set, the web POST no-ops and the feature stays dormant (graceful) — everything else is testable without it.

---

## File structure

| File | Repo | Action | Responsibility |
|---|---|---|---|
| `stockpart.js` | drawings-ui | Modify | `_aiSuggestHtml` (render the slot), `_fireAiMatch` (intake POST), `KDSP_AI_ENDPOINT`; wire both into `_buildReview` + `_buildCapture`. |
| `test/stockpart-logic.test.mjs` | drawings-ui | Modify | Unit tests for `_aiSuggestHtml` + `_fireAiMatch`. |
| `stock_match.py` | LINE_System | Create | Pure helpers + orchestration: `parse_len`, `code_dims`, `narrow_candidates`, `build_prompt`, `parse_ranked`, `read_catalog`, `write_suggestion`, `call_model`, `run_match`, `FAMILY_LEGEND`, `SM_MODEL`. |
| `test_stock_match.py` | LINE_System | Create | Standalone asserts for the pure helpers (`python test_stock_match.py`). |
| `webhook_server.py` | LINE_System | Modify | New route `POST/OPTIONS /api/stock-match` + CORS helper; imports `stock_match`. |
| `requirements.txt` | LINE_System | Modify | (only if using `flask-cors`; this plan uses manual CORS headers → no change). |

---

# PHASE A — Web (`drawings-ui`)

## Task 1: `_aiSuggestHtml` pure renderer

**Files:**
- Modify: `stockpart.js` (add `_aiSuggestHtml` + expose on `_test`)
- Test: `test/stockpart-logic.test.mjs`

- [ ] **Step 1: Write the failing tests** — append to `test/stockpart-logic.test.mjs`

```javascript
test('_aiSuggestHtml: ok+ranked renders code/%/reason + a use button per pick', () => {
  const { T } = boot();
  const sug = { status: 'ok', ranked: [
    { code: 'FN2BNX-095000', confidence: 0.8, reason: 'long floor rail' },
    { code: 'FN2BLA-060000', confidence: 0.4, reason: 'similar width' },
  ] };
  const html = T._aiSuggestHtml(sug);
  assert.match(html, /kdsp-ai-has/);
  assert.match(html, /FN2BNX-095000/);
  assert.match(html, /80%/);
  assert.match(html, /long floor rail/);
  assert.equal((html.match(/kdsp-ai-use/g) || []).length, 2);  // one use button per pick
  assert.match(html, /kdsp-ai-top/);                            // first pick flagged
});

test('_aiSuggestHtml: error/absent/empty falls back to the coming-soon placeholder', () => {
  const { T } = boot();
  const placeholder = /AI image-match — coming soon/;
  assert.match(T._aiSuggestHtml(undefined), placeholder);
  assert.match(T._aiSuggestHtml({ status: 'error', error: 'x' }), placeholder);
  assert.match(T._aiSuggestHtml({ status: 'ok', ranked: [] }), placeholder);
});

test('_aiSuggestHtml: escapes code and reason (inert against injection)', () => {
  const { T } = boot();
  const html = T._aiSuggestHtml({ status: 'ok', ranked: [{ code: '<img src=x>', confidence: 1, reason: '<script>z</script>' }] });
  assert.ok(html.indexOf('<img src=x>') === -1, 'raw code tag must be escaped');
  assert.ok(html.indexOf('<script>z</script>') === -1, 'raw reason tag must be escaped');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/stockpart-logic.test.mjs`
Expected: FAIL — `T._aiSuggestHtml is not a function`.

- [ ] **Step 3: Implement `_aiSuggestHtml`** — in `stockpart.js`, add right BEFORE the `// ── role router ──` comment (anywhere at module scope works; this keeps it near the review code):

```javascript
  // ── AI image-match suggestion (S3) — render the reserved review slot ──
  // Pure: ai_suggestion object -> markup. Falls back to the original "coming
  // soon" placeholder for error/absent/empty so the review card is unchanged
  // when there's no AI result. The "use" button carries only the code; the
  // review handler resolves thickness/material/grain at click time.
  var _AI_SLOT_EMPTY = '<p class="kdsp-ai-slot kdsp-muted">AI image-match — coming soon</p>';
  function _aiSuggestHtml(sug) {
    if (!sug || sug.status !== 'ok' || !sug.ranked || !sug.ranked.length) return _AI_SLOT_EMPTY;
    var picks = sug.ranked.slice(0, 3).map(function (s, i) {
      var pct = Math.round((Number(s.confidence) || 0) * 100);
      return '<div class="kdsp-ai-pick' + (i === 0 ? ' kdsp-ai-top' : '') + '">' +
        '<code>' + escapeHtml(s.code) + '</code>' +
        '<span class="kdsp-muted">' + pct + '% · ' + escapeHtml(s.reason || '') + '</span>' +
        '<button type="button" class="kdsp-ai-use" data-code="' + escapeHtml(s.code) + '">use</button>' +
      '</div>';
    }).join('');
    return '<div class="kdsp-ai-slot kdsp-ai-has"><p class="kdsp-muted">✨ AI suggestion</p>' + picks + '</div>';
  }
```

- [ ] **Step 4: Expose on `_test`** — in `window.kdStockPart._test`, add after `catalogNotInStock: catalogNotInStock,`:

```javascript
      _aiSuggestHtml: _aiSuggestHtml,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/stockpart-logic.test.mjs`
Expected: all pass.

- [ ] **Step 6: Commit (in `drawings-ui`)**

```bash
git add stockpart.js test/stockpart-logic.test.mjs
git commit -m "feat(stock-part): _aiSuggestHtml renders the AI suggestion slot (+ tests)"
```

---

## Task 2: `_fireAiMatch` + endpoint const

**Files:**
- Modify: `stockpart.js`
- Test: `test/stockpart-logic.test.mjs`

- [ ] **Step 1: Write the failing tests** — append to `test/stockpart-logic.test.mjs`

```javascript
test('_fireAiMatch POSTs {id,photo,remarks} to the endpoint and swallows rejection', async () => {
  const { T, window } = boot();
  const calls = [];
  window.fetch = (url, opts) => { calls.push({ url, opts }); return Promise.reject(new Error('network')); };
  // must not throw even though fetch rejects
  T._fireAiMatch('ID1', 'BASE64', 'ยาว 946', 'https://x.onrender.com/api/stock-match');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://x.onrender.com/api/stock-match');
  assert.equal(calls[0].opts.method, 'POST');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body, { id: 'ID1', photo: 'BASE64', remarks: 'ยาว 946' });
});

test('_fireAiMatch no-ops without id/photo/endpoint', () => {
  const { T, window } = boot();
  let n = 0; window.fetch = () => { n++; return Promise.resolve(); };
  T._fireAiMatch('', 'B64', 'r', 'https://x/api');     // no id
  T._fireAiMatch('ID', '', 'r', 'https://x/api');       // no photo
  T._fireAiMatch('ID', 'B64', 'r', '');                 // no endpoint
  assert.equal(n, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/stockpart-logic.test.mjs`
Expected: FAIL — `T._fireAiMatch is not a function`.

- [ ] **Step 3: Implement the const + `_fireAiMatch`** — in `stockpart.js`, add to the constants block (after the `_CUBE_SVG` line):

```javascript
  // AI image-match endpoint (S3). Set to the LINE-bot Render base + /api/stock-match.
  // Empty until configured → _fireAiMatch no-ops (feature dormant, graceful).
  var KDSP_AI_ENDPOINT = '';   // e.g. 'https://<line-bot>.onrender.com/api/stock-match'
```

and add the function near `_aiSuggestHtml`:

```javascript
  // Fire-and-forget the AI match request at intake. endpoint defaults to the
  // module const (param exists so tests inject without depending on the const).
  function _fireAiMatch(id, photo, remarks, endpoint) {
    endpoint = endpoint || KDSP_AI_ENDPOINT;
    if (!id || !photo || !endpoint) return;
    try {
      var f = (typeof fetch === 'function') ? fetch : (typeof window !== 'undefined' && window.fetch);
      if (!f) return;
      f(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, photo: photo, remarks: remarks || '' })
      }).catch(function () {});
    } catch (e) {}
  }
```

- [ ] **Step 4: Expose on `_test`** — add after `_aiSuggestHtml: _aiSuggestHtml,`:

```javascript
      _fireAiMatch: _fireAiMatch,
```

- [ ] **Step 5: Run the tests (expect PASS)**

Run: `node --test test/stockpart-logic.test.mjs`
Expected: all pass.

- [ ] **Step 6: Commit (in `drawings-ui`)**

```bash
git add stockpart.js test/stockpart-logic.test.mjs
git commit -m "feat(stock-part): _fireAiMatch intake POST + KDSP_AI_ENDPOINT const (+ tests)"
```

---

## Task 3: Wire into review + capture

**Files:**
- Modify: `stockpart.js` (`_buildReview` slot + use-handler; `_buildCapture` submit)
- Modify: `style.css` (`.kdsp-ai-*` styles)

- [ ] **Step 1: Render the slot** — in `stockpart.js` `_buildReview`, the card `innerHTML` currently contains this exact line:

```javascript
            '<p class="kdsp-ai-slot kdsp-muted">AI image-match — coming soon</p>' +
```

Replace it with:

```javascript
            _aiSuggestHtml(r.ai_suggestion) +
```

- [ ] **Step 2: Wire the AI "use" buttons** — in `_buildReview`, the existing `results.addEventListener('click', …)` block handles `.kdsp-use`. Immediately AFTER the existing `card.querySelectorAll('.kdsp-auto3d').forEach(...)` line, add a handler that reuses the same `chosen`/`assignBtn` the manual picker uses (resolve meta from the catalog at click):

```javascript
      card.querySelectorAll('.kdsp-ai-use').forEach(function (b) {
        b.addEventListener('click', function () {
          var code = b.getAttribute('data-code');
          var m = codePickerFilter(_uploadedDxfsCache || {}, code).filter(function (x) { return x.master_code === code; })[0] || {};
          chosen = { code: code, meta: { thickness_mm: (m.thickness_mm == null ? null : m.thickness_mm), material: m.material || '', grain: m.grain || '' } };
          if (input) input.value = code;
          if (assignBtn) assignBtn.disabled = false;
        });
      });
```

> Note: `chosen`, `input`, `assignBtn` are the same vars the manual picker declares earlier in this `rows.forEach` body, so the AI pick flows through the identical `assignBtn` → `assignCode(r.id, chosen.code, chosen.meta, revQty())` path. No new assign logic.

- [ ] **Step 3: Fire the match at intake** — in `_buildCapture`'s submit handler, the success path currently reads:

```javascript
        _undoLast = await saveIntake(row);
        var _n = _recordSubmit();
```

Insert the fire-and-forget call between those two lines:

```javascript
        _undoLast = await saveIntake(row);
        _fireAiMatch(_undoLast, photoB64, row.note);
        var _n = _recordSubmit();
```

- [ ] **Step 4: Add styles** — in `style.css`, after the `.kdsp-catcard` rule (near the other `.kdsp-*` rules), add:

```css
.kdsp-ai-slot.kdsp-ai-has { border: 1px solid #3a4a60; border-radius: 10px; padding: 8px; margin: 6px 0; }
.kdsp-ai-pick { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 4px 0; }
.kdsp-ai-pick code { font-size: 13px; }
.kdsp-ai-pick .kdsp-muted { flex: 1 1 120px; min-width: 0; font-size: 12px; }
.kdsp-ai-top code { color: #e8c069; }
.kdsp-ai-use { padding: 4px 10px; border-radius: 8px; border: 1px solid #2c3a4e; background: #d29922; color: #1b2330; font-weight: 600; cursor: pointer; flex-shrink: 0; }
```

- [ ] **Step 5: Syntax + full unit suite**

Run: `node --check stockpart.js && node --test`
Expected: syntax OK; all tests pass (existing + the new `_aiSuggestHtml`/`_fireAiMatch`).

- [ ] **Step 6: Commit (in `drawings-ui`)**

```bash
git add stockpart.js style.css
git commit -m "feat(stock-part): render AI suggestion in review slot + fire match at intake + styles"
```

---

## Task 4: Web deploy + verify (renders from a synthetic ai_suggestion)

**Files:** none (deploy + live verify).

- [ ] **Step 1: Push + watch deploy**

```bash
git push origin main
```
Then find the run for THIS HEAD and watch it:
```bash
sha=$(git rev-parse HEAD); rid=$(gh run list --commit "$sha" --limit 1 --json databaseId --jq '.[0].databaseId'); gh run watch "$rid" --exit-status
```

- [ ] **Step 2: Confirm live file carries the symbols**

Run: `curl -s -H 'Cache-Control: no-store' "https://wuttichaisaeton.github.io/kitchen-drawings-rd2026/stockpart.js?n=$RANDOM" | grep -c "_aiSuggestHtml"`
Expected: ≥ 1.

- [ ] **Step 3: Live verify in Chrome (NOT Edge), via Chrome MCP**

Navigate `https://wuttichaisaeton.github.io/kitchen-drawings-rd2026/?admin=1`, open the Stock Part tab, then in the console write a synthetic suggestion onto a real pending row and confirm the slot renders + "use" enables Assign:
```javascript
// pick a pending row id, then:
await firebaseDB.ref('stock_parts/<PENDING_ID>/ai_suggestion').set({status:'ok',at:Date.now(),model:'claude-haiku-4-5-20251001',ranked:[{code:'FN2BNX-095000',confidence:0.8,reason:'long floor rail'}]});
// review card repaints → expect .kdsp-ai-has with FN2BNX-095000 80% + a use button; click it → Assign button enables
```
Clean up: `await firebaseDB.ref('stock_parts/<PENDING_ID>/ai_suggestion').remove();`
Expected: slot shows the pick; clicking **use** enables **Assign code → send to worker**; console clean.

- [ ] **Step 4: Board log (in `drawings-ui`)** — append one entry to `docs/coordination/group-sync.md` (web half shipped; backend next), commit + push.

---

# PHASE B — Backend (`LINE_System`)

## Task 5: Pure helpers — `stock_match.py`

**Files:**
- Create: `LINE_System/stock_match.py`
- Test: `LINE_System/test_stock_match.py`

- [ ] **Step 1: Write the failing test** — create `LINE_System/test_stock_match.py`

```python
import stock_match as sm

def test_parse_len():
    assert sm.parse_len("ยาว 946") == 946
    assert sm.parse_len("946 mm, w 50") == 946
    assert sm.parse_len("no number") is None
    assert sm.parse_len("") is None

def test_code_dims():
    assert sm.code_dims("FN2BNX-095000") == (95, 0)
    assert sm.code_dims("BK1DN1-060946") == (60, 946)
    assert sm.code_dims("SHORT") is None

def test_narrow_by_length_pm50():
    cat = [
        {"code": "FN2BNX-095000", "w": 95, "h": 0, "material": "ALPF"},   # 950mm -> 4 off 946
        {"code": "BK1DN1-060946", "w": 60, "h": 946, "material": "ALPF"}, # raw 946 -> 0 off
        {"code": "SD0SUP-040030", "w": 40, "h": 30, "material": "ALPF"},  # far
    ]
    out = sm.narrow_candidates(cat, "ยาว 946", max_n=60)
    codes = [c["code"] for c in out]
    assert "SD0SUP-040030" not in codes
    assert set(codes) == {"FN2BNX-095000", "BK1DN1-060946"}
    assert codes[0] == "BK1DN1-060946"   # nearest first (0mm)

def test_narrow_no_length_caps_all():
    cat = [{"code": f"AAA000-00000{i}", "w": i, "h": 0, "material": "ALPF"} for i in range(200)]
    out = sm.narrow_candidates(cat, "", max_n=60)
    assert len(out) == 120   # no-length cap

def test_parse_ranked_keeps_only_valid_codes_max3():
    valid = {"FN2BNX-095000", "BK1DN1-060946"}
    text = '```json\n{"ranked":[{"code":"FN2BNX-095000","confidence":0.8,"reason":"rail"},{"code":"NOPE-000000","confidence":0.9,"reason":"x"},{"code":"BK1DN1-060946","confidence":0.3,"reason":"y"}]}\n```'
    out = sm.parse_ranked(text, valid)
    codes = [r["code"] for r in out]
    assert codes == ["FN2BNX-095000", "BK1DN1-060946"]   # NOPE dropped
    assert all(0.0 <= r["confidence"] <= 1.0 for r in out)

def test_parse_ranked_bad_json_returns_empty():
    assert sm.parse_ranked("not json at all", {"X"}) == []

if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn(); print("ok", name)
    print("ALL PASS")
```

- [ ] **Step 2: Run to verify failure**

Run: `cd LINE_System && python test_stock_match.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'stock_match'`.

- [ ] **Step 3: Implement the pure helpers** — create `LINE_System/stock_match.py`

```python
"""Stock Part S3 — AI image-match helpers + orchestration.
Pure helpers (parse_len/code_dims/narrow_candidates/build_prompt/parse_ranked)
are unit-tested in test_stock_match.py; the model call + RTDB I/O are verified
live. Imported by webhook_server.py's /api/stock-match route.
"""
import json
import re
import time
import urllib.request

SM_MODEL = "claude-haiku-4-5-20251001"

# code-prefix -> part family, so the model can map a photo's shape to a family.
FAMILY_LEGEND = (
    "Code-prefix families: FN=floor rail/base; SD=side panel; BK=back or down panel; "
    "TS=top support bar; BM=bottom/beam member; DS/DW/DA=door leaf; 2..=wall-cabinet (F2) panel; "
    "BA/BX=wrapper/box; TI/FTI=long trim/rail. The first 6 chars are the code family+variant; "
    "the 6 digits after the dash are WWWHHH in centimetres (x10 = mm)."
)

def parse_len(remarks):
    nums = re.findall(r"\d+", remarks or "")
    if not nums:
        return None
    m = max(int(n) for n in nums)
    return m if m >= 10 else None

def code_dims(code):
    suf = re.sub(r"\D", "", (str(code or "").split("-", 1)[1] if "-" in str(code or "") else ""))
    if len(suf) < 6:
        return None
    return (int(suf[0:3]), int(suf[3:6]))

def narrow_candidates(catalog, remarks, max_n=60):
    """catalog: list of {code,w,h,material}. If remarks has a length L(mm), keep
    candidates within +-50mm of W*10/H*10/W/H, nearest first, cap max_n; else
    return the first 120 (A->Z)."""
    L = parse_len(remarks)
    if L is None:
        return sorted(catalog, key=lambda c: c["code"])[:120]
    scored = []
    for c in catalog:
        w, h = c.get("w", 0), c.get("h", 0)
        best = min(abs(w * 10 - L), abs(h * 10 - L), abs(w - L), abs(h - L))
        if best <= 50:
            scored.append((best, c))
    scored.sort(key=lambda t: (t[0], t[1]["code"]))
    return [c for _, c in scored[:max_n]]

def build_prompt(remarks, candidates):
    lines = [f'{c["code"]} | {c.get("w",0)*10}x{c.get("h",0)*10} mm | {c.get("material","")}' for c in candidates]
    return (
        "You match a photo of ONE leftover sheet-metal part to its 13-char part code.\n"
        "Choose ONLY from the CANDIDATES below. The photo may have a cluttered background.\n"
        f"{FAMILY_LEGEND}\n"
        f'Worker remarks (Thai ok, may state the measured length): "{remarks or ""}"\n'
        "CANDIDATES (code | WxH mm | material):\n" + "\n".join(lines) + "\n\n"
        'Reply with JSON ONLY, no prose: {"ranked":[{"code":"<one CANDIDATE>","confidence":<0..1>,"reason":"<=12 words"}]} '
        "— at most 3, most likely first; [] if none plausible."
    )

def parse_ranked(text, valid_codes):
    """Extract the JSON object from the model text; keep only valid codes,
    clamp confidence to [0,1], cap 3. Returns [] on any parse failure."""
    if not text:
        return []
    s = text
    a, b = s.find("{"), s.rfind("}")
    if a == -1 or b == -1 or b < a:
        return []
    try:
        obj = json.loads(s[a:b + 1])
    except Exception:
        return []
    out = []
    for r in (obj.get("ranked") or [])[:10]:
        code = r.get("code")
        if code not in valid_codes:
            continue
        try:
            conf = float(r.get("confidence", 0))
        except Exception:
            conf = 0.0
        conf = max(0.0, min(1.0, conf))
        out.append({"code": code, "confidence": conf, "reason": str(r.get("reason", ""))[:80]})
        if len(out) == 3:
            break
    return out
```

- [ ] **Step 4: Run the tests (expect PASS)**

Run: `cd LINE_System && python test_stock_match.py`
Expected: `ALL PASS`.

- [ ] **Step 5: Commit (in `LINE_System`)**

```bash
git add stock_match.py test_stock_match.py
git commit -m "feat(stock-match): pure helpers (parse_len/code_dims/narrow/build_prompt/parse_ranked) + tests"
```

---

## Task 6: RTDB I/O + model call + orchestration

**Files:**
- Modify: `LINE_System/stock_match.py`

- [ ] **Step 1: Add RTDB read/write + model call + `run_match`** — append to `LINE_System/stock_match.py`

```python
def _now_ms():
    return int(time.time() * 1000)

def read_catalog(rtdb_url, timeout=15):
    """GET uploaded_dxfs.json; dedupe to one row per master_code (newest
    uploaded_at); return [{code,w,h,material}]."""
    url = rtdb_url.rstrip("/") + "/uploaded_dxfs.json"
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8")) or {}
    by_code = {}
    for _, m in data.items():
        if not m or not m.get("master_code"):
            continue
        code = m["master_code"]
        prev = by_code.get(code)
        if not prev or (m.get("uploaded_at", 0) > prev.get("uploaded_at", 0)):
            by_code[code] = m
    out = []
    for code, m in by_code.items():
        d = code_dims(code)
        out.append({"code": code, "w": (d[0] if d else 0), "h": (d[1] if d else 0),
                    "material": m.get("material", ""), "uploaded_at": m.get("uploaded_at", 0)})
    return out

def write_suggestion(rtdb_url, row_id, obj, timeout=15):
    """PATCH stock_parts/<id>/ai_suggestion.json (RTDB is open-write today)."""
    url = rtdb_url.rstrip("/") + f"/stock_parts/{row_id}/ai_suggestion.json"
    body = json.dumps(obj).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="PATCH",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status

def call_model(client, photo_b64, prompt, model=SM_MODEL, max_tokens=400):
    """Anthropic vision call. Returns the text of the first content block."""
    msg = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        temperature=0,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": photo_b64}},
            {"type": "text", "text": prompt},
        ]}],
    )
    parts = [b.text for b in msg.content if getattr(b, "type", "") == "text"]
    return "".join(parts)

def run_match(client, rtdb_url, row_id, photo_b64, remarks):
    """Orchestrate: read catalog -> narrow -> model -> parse -> write. Returns ranked."""
    catalog = read_catalog(rtdb_url)
    candidates = narrow_candidates(catalog, remarks)
    valid = {c["code"] for c in candidates}
    prompt = build_prompt(remarks, candidates)
    text = call_model(client, photo_b64, prompt)
    ranked = parse_ranked(text, valid)
    write_suggestion(rtdb_url, row_id, {
        "status": "ok", "ranked": ranked, "model": SM_MODEL, "at": _now_ms(),
    })
    return ranked
```

- [ ] **Step 2: Verify the module still imports + pure tests pass**

Run: `cd LINE_System && python -c "import stock_match" && python test_stock_match.py`
Expected: `ALL PASS` (the new functions don't break the pure tests).

- [ ] **Step 3: Commit (in `LINE_System`)**

```bash
git add stock_match.py
git commit -m "feat(stock-match): RTDB read/write + Haiku vision call + run_match orchestration"
```

---

## Task 7: Flask route + CORS

**Files:**
- Modify: `LINE_System/webhook_server.py`

- [ ] **Step 1: Add the CORS helper + route** — in `webhook_server.py`, near the other `@app.route("/api/...")` handlers (e.g. after the `/api/health` route), add:

```python
import stock_match as _sm

_SM_ORIGIN = "https://wuttichaisaeton.github.io"
RTDB_URL = os.environ.get(
    "RTDB_URL",
    "https://kitchen-drawings-default-rtdb.asia-southeast1.firebasedatabase.app",
)

def _sm_cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = _SM_ORIGIN
    resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp

@app.route("/api/stock-match", methods=["POST", "OPTIONS"])
def api_stock_match():
    if request.method == "OPTIONS":
        return _sm_cors(make_response("", 204))
    data = request.get_json(silent=True) or {}
    row_id = data.get("id")
    photo = data.get("photo")
    remarks = data.get("remarks", "")
    if not row_id or not photo:
        return _sm_cors(jsonify({"ok": False, "error": "missing id/photo"})), 400
    if len(photo) > 1_600_000:
        return _sm_cors(jsonify({"ok": False, "error": "too-large"})), 400
    try:
        ranked = _sm.run_match(_client_for_context, RTDB_URL, row_id, photo, remarks)
        return _sm_cors(jsonify({"ok": True, "ranked": ranked}))
    except Exception as e:
        log.warning(f"/api/stock-match failed: {e}")
        _check_anthropic_credit_error(e)
        try:
            _sm.write_suggestion(RTDB_URL, row_id, {
                "status": "error", "error": str(e)[:120], "model": _sm.SM_MODEL, "at": _sm._now_ms(),
            })
        except Exception:
            pass
        return _sm_cors(jsonify({"ok": False}))
```

> Verify `make_response`, `jsonify`, `request` are imported at the top of `webhook_server.py` (Flask app already uses them for other routes; add to the `from flask import ...` line if any is missing). `_client_for_context`, `_check_anthropic_credit_error`, `log`, and `os` already exist (lines 31/67/68/73).

- [ ] **Step 2: Syntax check**

Run: `cd LINE_System && python -c "import ast; ast.parse(open('webhook_server.py',encoding='utf-8').read()); print('OK')"`
Expected: `OK`.

- [ ] **Step 3: Local smoke (route registered, OPTIONS returns CORS)** — without calling the model:

```bash
cd LINE_System && python -c "
import webhook_server as w
c = w.app.test_client()
r = c.options('/api/stock-match')
assert r.status_code == 204, r.status_code
assert r.headers.get('Access-Control-Allow-Origin') == 'https://wuttichaisaeton.github.io'
r2 = c.post('/api/stock-match', json={})
assert r2.status_code == 400, r2.status_code
print('ROUTE OK')
"
```
Expected: `ROUTE OK` (imports webhook_server; if it requires env vars to import, set dummy ones inline or skip to Step 4 and verify on Render).

- [ ] **Step 4: Commit (in `LINE_System`)**

```bash
git add webhook_server.py
git commit -m "feat(stock-match): POST /api/stock-match route + CORS for the web origin"
```

---

## Task 8: Configure + deploy backend, set the web endpoint

**Files:**
- Modify: `drawings-ui/stockpart.js` (set `KDSP_AI_ENDPOINT`)

- [ ] **Step 1: Deploy the backend** — push `LINE_System` to its remote so Render redeploys:

```bash
cd LINE_System && git push
```
Confirm in the Render dashboard that the deploy is live (the service that serves the LINE webhook). Note its base URL (`https://<service>.onrender.com`).

- [ ] **Step 2: Warm + smoke the live endpoint** — first call wakes Render (~40s):

```bash
curl -s -X OPTIONS "https://<service>.onrender.com/api/stock-match" -i | grep -i "access-control-allow-origin"
```
Expected: header `access-control-allow-origin: https://wuttichaisaeton.github.io`.

- [ ] **Step 3: Set `KDSP_AI_ENDPOINT` in the web** — in `drawings-ui/stockpart.js`, set:

```javascript
  var KDSP_AI_ENDPOINT = 'https://<service>.onrender.com/api/stock-match';
```
(Use the real Render base from Step 1.)

- [ ] **Step 4: Syntax + tests + commit + deploy (in `drawings-ui`)**

```bash
node --check stockpart.js && node --test
git add stockpart.js
git commit -m "feat(stock-part): point KDSP_AI_ENDPOINT at the live Render match endpoint"
git push origin main
```
Then `gh run watch` the run for this HEAD and `curl -s -H 'Cache-Control: no-store' .../stockpart.js | grep onrender` to confirm the endpoint is live.

---

## Task 9: Live end-to-end verification + board log

**Files:** none.

- [ ] **Step 1: End-to-end on real devices (Chrome only, NOT Edge)**

1. Worker phone: open Stock Part, photograph a part whose code is in `uploaded_dxfs` (e.g. type a length in remarks like `946`), submit.
2. Within a few seconds (after Render warms) confirm `stock_parts/<newId>/ai_suggestion` appears (Chrome MCP: `await firebaseDB.ref('stock_parts/<id>').once('value')`).
3. เอ๋ device: the review card shows "✨ AI suggestion" with a sensible top pick; tap **use** → **Assign** enables → assign → worker Confirm-GLB round-trip unchanged.
4. Verify cold-start path: after the service idles, the first submit still lands (just later).
5. Console clean through the round-trip.

- [ ] **Step 2: Verify graceful failure** — temporarily point `KDSP_AI_ENDPOINT` at a bad path (or test a row with no `ai_suggestion`): the review card shows the dimension auto-match + the "AI image-match — coming soon" placeholder, no errors.

- [ ] **Step 3: Board log** — append ONE entry to `drawings-ui/docs/coordination/group-sync.md` (per [[feedback_log_changes_to_sync]]): S3 AI image-match shipped, both repos + commits, live-verified note, that the backend lives in `LINE_System` (cross-lane). Commit + push the board.

---

## Self-review checklist (run after implementing)

- **Spec coverage:** endpoint + CORS (T7), narrow±50/cap (T5), Haiku vision + family legend (T5/T6), RTDB read/write (T6), web intake POST (T2/T3), review slot render + use (T1/T3), ai_suggestion schema (T6), failure fallback (T1/T9), tests (T1/T2/T5). ✓
- **Type/name consistency:** `ai_suggestion.{status,ranked[{code,confidence,reason}],model,at,error}` used identically in `_aiSuggestHtml`, `run_match`, `write_suggestion`, and the error path; `_fireAiMatch(id,photo,remarks,endpoint)` body `{id,photo,remarks}` matches the route's `data.get("id"/"photo"/"remarks")`. ✓
- **No placeholders:** the only deferred value is the Render base URL, obtained in T8 Step 1 and set in T8 Step 3 (real action, not vague). ✓
- **Escaping:** `_aiSuggestHtml` escapes `code`/`reason`; `data-code` via `escapeHtml`; backend drops non-candidate codes. ✓
