;(function () {
  'use strict';

  // ── constants ───────────────────────────────────────────────
  var RTDB_PATH = 'stock_parts';
  var LS_CACHE  = 'kd_stock_parts_v1';     // metadata-only mirror (no photos)
  var LS_SUBMIT = 'kd_sp_submit_times';    // per-device intake rate cap
  var QTY_MIN = 1, QTY_MAX = 99;
  var TARGET_BYTES = 700000;               // compress target (RTDB-friendly)
  var MAX_BYTES = 1500000;                 // hard reject ceiling (per single photo)
  var ROW_MAX_BYTES = 2600000;             // per-row reject ceiling (1-3 photos + meta)
  var CAP_WARN = 10, CAP_BLOCK = 20;       // intakes / 24h / device
  // cube glyph for the "View 3D" click-to-fullscreen cell (matches the tab icon)
  var _CUBE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5"/><line x1="12" y1="12" x2="12" y2="21"/></svg>';
  // AI image-match endpoint (S3). Set to the LINE-bot Render base + /api/stock-match.
  // Empty until configured → _fireAiMatch no-ops (feature dormant, graceful).
  var KDSP_AI_ENDPOINT = 'https://stainless-line-bot.onrender.com/api/stock-match';
  // เอ๋: auto-match thumbnail model is wrong-axis → rotate 90° about X, CLOCKWISE.
  // model-viewer orientation = "roll(Z) pitch(X) yaw(Y)"; +pitch is counter-clockwise,
  // so clockwise X-90° = pitch -90°. (Flip the sign if it ends up the wrong way.)
  var _THUMB_ORIENT = '0deg -90deg 0deg';

  // ── state ───────────────────────────────────────────────────
  var _stockCache = {};   // pushId -> row
  var _undoLast = null;   // pushId of this session's last intake (undo-last)

  // ── pure helpers ────────────────────────────────────────────
  function _aggregateConfirmed(rows) {
    var out = {};
    for (var id in rows) {
      var r = rows[id];
      if (r && r.status === 'confirmed' && r.code) out[r.code] = (out[r.code] || 0) + (r.qty || 0);
    }
    return out;
  }
  function stockQtyByCode(code) { return _aggregateConfirmed(_stockCache)[code] || 0; }
  function confirmedByCode() {
    var out = {};
    for (var id in _stockCache) {
      var r = _stockCache[id];
      if (!r || r.status !== 'confirmed' || !r.code) continue;
      if (!out[r.code]) out[r.code] = { code: r.code, qty: 0, rows: [], thickness_mm: r.thickness_mm, material: r.material };
      out[r.code].qty += (r.qty || 0);
      out[r.code].rows.push(Object.assign({ id: id }, r));
    }
    return out;
  }
  function codePickerFilter(dxfCache, query) {
    var byCode = {};
    for (var stem in dxfCache) {
      var m = dxfCache[stem];
      if (!m || !m.master_code) continue;
      var prev = byCode[m.master_code];
      if (!prev || (m.uploaded_at || 0) > (prev.uploaded_at || 0)) byCode[m.master_code] = Object.assign({ master_code: m.master_code }, m);
    }
    var q = String(query || '').trim().toLowerCase();
    var qDigits = q.replace(/\D/g, '');
    var list = Object.keys(byCode).map(function (k) { return byCode[k]; });
    var qLen = (qDigits && qDigits === q) ? parseInt(qDigits, 10) : null;   // pure-numeric query = a length in mm
    if (q) list = list.filter(function (m) {
      var code = m.master_code.toLowerCase();
      if (code.indexOf(q) !== -1) return true;                                                    // code substring
      if (qLen != null) {
        if (code.replace(/\D/g, '').indexOf(qDigits) !== -1) return true;                         // digit substring (e.g. cm value)
        var d = _codeDims(m.master_code);                                                         // dimension ±5mm (cm-encoded ×10, or raw)
        if (d && Math.min(Math.abs(d.w * 10 - qLen), Math.abs(d.h * 10 - qLen), Math.abs(d.w - qLen), Math.abs(d.h - qLen)) <= 5) return true;
      }
      return false;
    });
    list.sort(function (a, b) { return a.master_code.localeCompare(b.master_code); });
    return list;
  }
  // catalog codes matching a query that are NOT already in stock. `stock` may be
  // the confirmedByCode() map (object keyed by code) or an array of codes. A blank
  // query returns [] so the list never dumps the whole 269-code catalog unprompted.
  function catalogNotInStock(dxfCache, query, stock) {
    if (!String(query || '').trim()) return [];
    var have = {};
    if (Array.isArray(stock)) stock.forEach(function (c) { have[c] = true; });
    else if (stock) for (var k in stock) have[k] = true;
    return codePickerFilter(dxfCache, query).filter(function (m) { return !have[m.master_code]; });
  }
  // dimension hint parsed from the code suffix (after the dash). 6-digit WWWHHH -> "946×0mm".
  function _codeDim(code) {
    var suf = (String(code || '').split('-')[1] || '').replace(/\D/g, '');
    if (suf.length === 6) return (parseInt(suf.slice(0, 3), 10) * 10) + '×' + (parseInt(suf.slice(3), 10) * 10) + 'mm';
    return suf;
  }
  // numeric W/H parsed from the 6-digit code suffix (WWWHHH), for length auto-match
  function _codeDims(code) {
    var suf = (String(code || '').split('-')[1] || '').replace(/\D/g, '');
    if (suf.length < 6) return null;
    return { w: parseInt(suf.slice(0, 3), 10), h: parseInt(suf.slice(3, 6), 10) };
  }
  // largest integer in the worker's remarks = the length they measured (mm)
  function _parseLen(note) {
    var nums = String(note || '').match(/\d+/g);
    if (!nums) return null;
    var max = 0;
    nums.forEach(function (n) { var v = parseInt(n, 10); if (v > max) max = v; });
    return max >= 10 ? max : null;
  }
  // candidate codes whose width OR height is within ±tol mm of L, nearest first
  function _codesByLength(dxfCache, L, tol) {
    return codePickerFilter(dxfCache, '').map(function (m) {
      var d = _codeDims(m.master_code); if (!d) return null;
      // suffix WWW/HHH are in cm (×10 = mm) for most families; also try the raw value to be safe
      var best = Math.min(Math.abs(d.w * 10 - L), Math.abs(d.h * 10 - L), Math.abs(d.w - L), Math.abs(d.h - L));
      return best <= tol ? Object.assign({ _lenDelta: best }, m) : null;
    }).filter(Boolean).sort(function (a, b) { return a._lenDelta - b._lenDelta || a.master_code.localeCompare(b.master_code); });
  }
  // render a note as Flux for everything; wrap ONLY the Thai glyphs in a Thai-capable font
  function _noteHtml(note) {
    return escapeHtml(note).replace(/[฀-๿]+/g, function (t) {
      return '<span style="font-family:\'IBM Plex Sans Thai\',\'Leelawadee UI\',\'Sukhumvit Set\',\'Thonburi\',Tahoma,sans-serif">' + t + '</span>';
    });
  }
  // 1-3 photos per row; old rows have only photo_data. Every render reads through this.
  function _rowPhotos(r) {
    if (r && Array.isArray(r.photos) && r.photos.length) return r.photos;
    if (r && r.photo_data) return [r.photo_data];
    return [];
  }
  function relativeTime(now, ts) {
    if (!ts) return '';
    var m = Math.floor(Math.max(0, now - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h';
    var dt = new Date(ts);
    return dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) + '-' + ('0' + dt.getDate()).slice(-2);
  }
  function b64Bytes(s) { return Math.floor((String(s || '').length * 3) / 4); }
  function _scaleFor(w, h, maxEdge) {
    var longest = Math.max(w, h);
    if (longest <= maxEdge) return { w: w, h: h };
    var k = maxEdge / longest;
    return { w: Math.round(w * k), h: Math.round(h * k) };
  }
  function _compressLadder() {
    var ladder = [];
    var edges = [1000, 800, 640];
    var qs = [0.7, 0.6, 0.5, 0.4];
    for (var i = 0; i < edges.length; i++) for (var j = 0; j < qs.length; j++) ladder.push({ maxEdge: edges[i], q: qs[j] });
    return ladder;
  }

  // ── store (RTDB stock_parts) ────────────────────────────────
  function _ref(id) { return window.firebaseDB.ref(RTDB_PATH + (id ? '/' + id : '')); }
  async function saveIntake(obj) {
    if (!window.firebaseDB) throw new Error('No database connection');
    var r = _ref().push();
    await r.set(obj);
    return r.key;
  }
  async function _updateStock(id, patch) { if (window.firebaseDB && id) await _ref(id).update(patch); }
  async function _deleteStock(id) { if (window.firebaseDB && id) await _ref(id).remove(); }
  async function assignCode(id, code, meta, qty) {
    meta = meta || {};
    var patch = { status: 'awaiting_worker_confirm', code: code, thickness_mm: (meta.thickness_mm == null ? null : meta.thickness_mm), material: meta.material || '', grain: meta.grain || '', reviewed_at: Date.now(), reviewed_by_role: 'admin', bounced_from: '', bounced_at: null };
    if (qty != null && !isNaN(qty)) patch.qty = Math.min(QTY_MAX, Math.max(QTY_MIN, qty));
    await _updateStock(id, patch);
  }
  async function rejectIntake(id) { await _updateStock(id, { status: 'rejected', reviewed_at: Date.now(), reviewed_by_role: 'admin' }); }
  async function workerConfirmGlb(id) { await _updateStock(id, { status: 'confirmed', worker_confirmed_at: Date.now() }); }
  async function workerRejectGlb(id) {
    var r = _stockCache[id] || {};
    await _updateStock(id, { status: 'pending', bounced_from: r.code || '', bounced_at: Date.now(), code: '' });
  }

  // ── listener + localStorage mirror (metadata only) ──────────
  function _stripPhotos(rows) {
    var out = {};
    for (var id in rows) { var c = Object.assign({}, rows[id]); delete c.photo_data; delete c.photos; out[id] = c; }
    return out;
  }
  function _loadLS() { try { return JSON.parse(localStorage.getItem(LS_CACHE)) || {}; } catch (e) { return {}; } }
  function _saveLS(rows) { try { localStorage.setItem(LS_CACHE, JSON.stringify(_stripPhotos(rows))); } catch (e) {} }

  // ── photo compression: returns a base64 jpeg (no data: prefix) or throws ──
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) { reject(new Error('not-image')); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var ladder = _compressLadder(), best = null;
          for (var i = 0; i < ladder.length; i++) {
            var dim = _scaleFor(img.naturalWidth || img.width, img.naturalHeight || img.height, ladder[i].maxEdge);
            var cv = document.createElement('canvas');
            cv.width = dim.w; cv.height = dim.h;
            cv.getContext('2d').drawImage(img, 0, 0, dim.w, dim.h);
            var b64 = cv.toDataURL('image/jpeg', ladder[i].q).split(',')[1] || '';
            best = b64;
            if (b64Bytes(b64) <= TARGET_BYTES) break;
          }
          URL.revokeObjectURL(url);
          if (!best || b64Bytes(best) > MAX_BYTES) { reject(new Error('too-large')); return; }
          resolve(best);
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode-failed')); };
      img.src = url;
    });
  }

  // ── per-device intake rate cap ──────────────────────────────
  function _submitTimes() { try { return JSON.parse(localStorage.getItem(LS_SUBMIT)) || []; } catch (e) { return []; } }
  function _recordSubmit() {
    var now = Date.now(), arr = _submitTimes().filter(function (t) { return now - t < 86400000; });
    arr.push(now);
    try { localStorage.setItem(LS_SUBMIT, JSON.stringify(arr)); } catch (e) {}
    return arr.length;
  }
  function _submitCount24h() { var now = Date.now(); return _submitTimes().filter(function (t) { return now - t < 86400000; }).length; }

  // ── capture screen (worker, Thai) ───────────────────────────
  function _buildCapture() {
    var el = document.createElement('section');
    el.className = 'kdsp-card';
    el.innerHTML =
      (_undoLast ? '<button type="button" id="kdsp-undo" class="kdsp-btn kdsp-btn-ghost">Undo last</button>' : '') +
      '<h3 class="kdsp-h">Add part to stock</h3>' +
      '<div class="kdsp-phototray" id="kdsp-phototray"></div>' +
      '<label class="kdsp-photo" id="kdsp-photo-label"><input type="file" accept="image/*" capture="environment" multiple id="kdsp-photo" hidden>' +
      '<span class="kdsp-photo-hint">Add photo (1-3)</span></label>' +
      '<div class="kdsp-row"><span>Quantity</span><div class="kdsp-qty">' +
        '<button type="button" id="kdsp-qminus">−</button><b id="kdsp-qval">1</b><button type="button" id="kdsp-qplus">+</button>' +
      '</div></div>' +
      '<input type="text" id="kdsp-note" class="kdsp-input kdsp-th" placeholder="Remarks (optional, Thai OK)">' +
      '<button type="button" id="kdsp-submit" class="kdsp-btn kdsp-btn-primary" disabled>Send to review</button>';

    var u = el.querySelector('#kdsp-undo'); if (u) u.onclick = _undoLastIntake;
    var qty = 1, photos = [];
    var qval = el.querySelector('#kdsp-qval'), submit = el.querySelector('#kdsp-submit');
    var tray = el.querySelector('#kdsp-phototray'), label = el.querySelector('#kdsp-photo-label');
    function setQty(n) { qty = Math.min(QTY_MAX, Math.max(QTY_MIN, n)); qval.textContent = String(qty); }
    el.querySelector('#kdsp-qminus').onclick = function () { setQty(qty - 1); };
    el.querySelector('#kdsp-qplus').onclick = function () { setQty(qty + 1); };
    function renderTray() {
      tray.innerHTML = photos.map(function (b64, idx) {
        return '<span class="kdsp-traythumb"><img src="data:image/jpeg;base64,' + b64 + '" alt=""><button type="button" class="kdsp-trayx" data-i="' + idx + '">✕</button></span>';
      }).join('');
      tray.querySelectorAll('.kdsp-trayx').forEach(function (b) {
        b.addEventListener('click', function () { photos.splice(Number(b.getAttribute('data-i')), 1); renderTray(); });
      });
      if (label) label.style.display = (photos.length >= 3) ? 'none' : '';
      submit.disabled = photos.length < 1;
      var hint = el.querySelector('.kdsp-photo-hint'); if (hint) hint.textContent = 'Add photo (' + photos.length + '/3)';
    }
    el.querySelector('#kdsp-photo').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []).slice(0, 3 - photos.length);
      e.target.value = '';                 // allow re-picking the same file
      if (!files.length) return;
      var hint = el.querySelector('.kdsp-photo-hint'); if (hint) hint.textContent = 'Compressing…';
      Promise.all(files.map(function (f) { return compressImage(f).then(function (b64) { return b64; }).catch(function () { return null; }); }))
        .then(function (results) {
          var ok = 0;
          results.forEach(function (b64) { if (b64 && photos.length < 3) { photos.push(b64); ok++; } });
          if (ok < results.length) _kdToast('Some photos were skipped (invalid / too large)');
          renderTray();
        });
    });
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
    return el;
  }

  async function _undoLastIntake() {
    if (!_undoLast) return;
    var id = _undoLast; _undoLast = null;
    try { await _deleteStock(id); _kdToast('Undone'); renderHome(); } catch (e) { _kdToast('Undo failed'); }
  }

  // ── photo lightbox (tap a photo to enlarge; click / Esc to close) ──
  function _openPhoto(photos, startIndex) {
    var list = Array.isArray(photos) ? photos.slice() : (photos ? [photos] : []);
    if (!list.length) return;
    var i = Math.min(Math.max(0, startIndex | 0), list.length - 1);
    var ov = document.createElement('div');
    ov.setAttribute('style', 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.88) !important;cursor:zoom-out;padding:16px;');
    var img = document.createElement('img');
    img.setAttribute('style', 'max-width:96vw;max-height:96vh;border-radius:8px;box-shadow:0 6px 40px rgba(0,0,0,.6);');
    var prev, next, cnt;
    function show() { img.src = 'data:image/jpeg;base64,' + list[i]; if (cnt) cnt.textContent = (i + 1) + '/' + list.length; }
    ov.appendChild(img);
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
  // on GLB load failure, swap the blank viewer for a clear "no 3D model" note
  function _wireMvErrors(scope) {
    if (!scope || !scope.querySelectorAll) return;
    Array.prototype.forEach.call(scope.querySelectorAll('model-viewer'), function (mv) {
      mv.addEventListener('error', function () {
        var fig = mv.parentNode; if (!fig) return;
        var d = document.createElement('div'); d.className = 'kdsp-noimg';
        d.setAttribute('style', 'display:flex;align-items:center;justify-content:center;color:#8a97a8;font-size:12px;');
        d.textContent = 'no 3D model';
        fig.insertBefore(d, fig.firstChild); mv.remove();
      });
    });
  }

  // ── admin review queue + code picker ────────────────────────
  function _pending() {
    var out = [];
    for (var id in _stockCache) { var r = _stockCache[id]; if (r && r.status === 'pending') out.push(Object.assign({ id: id }, r)); }
    out.sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });
    return out;
  }
  function _buildReview() {
    var el = document.createElement('section'); el.className = 'kdsp-section';
    var rows = _pending();
    var h = '<h3 class="kdsp-h">Review queue <span class="kdsp-count">' + rows.length + '</span></h3>';
    if (!rows.length) h += '<p class="kdsp-empty">Nothing to review</p>';
    el.innerHTML = h;
    var now = Date.now();
    rows.forEach(function (r) {
      var card = document.createElement('div'); card.className = 'kdsp-card';
      var bounce = r.bounced_from ? '<div class="kdsp-flag">Worker said not: ' + escapeHtml(r.bounced_from) + '</div>' : '';
      var _rel = relativeTime(now, r.created_at);
      var _relAgo = /^\d+[mh]$/.test(_rel) ? _rel + ' ago' : _rel;   // "6h" → "6h ago"; "just now"/date unchanged
      var _L = _parseLen(r.note);
      var autos = _L ? _codesByLength(_uploadedDxfsCache || {}, _L, 5).slice(0, 8) : [];
      var autoHtml = '';
      if (autos.length) {
        autoHtml = '<div class="kdsp-automatch" style="margin:6px 0;border-top:1px solid #2c3a4e;padding-top:8px;">' +
          '<p class="kdsp-muted">Auto-match · ±5mm of ' + _L + 'mm · ' + autos.length + ' found</p>' +
          autos.map(function (m) {
            var glb = (typeof _kd3dGlbUrl === 'function') ? _kd3dGlbUrl(m.master_code) : '';
            return '<div class="kdsp-auto" style="margin:8px 0;">' +
              '<div class="kdsp-compare">' +
                '<figure class="kdsp-cmp"><img src="data:image/jpeg;base64,' + (r.photo_data || '') + '" alt=""><figcaption>Photo</figcaption></figure>' +
                '<figure class="kdsp-cmp"><div class="kdsp-cmp-3d kdsp-auto3d" data-code="' + escapeHtml(m.master_code) + '" role="button" tabindex="0" title="View 3D — tap to open full screen">' + (glb ? '<model-viewer src="' + glb + '" loading="eager" interaction-prompt="none" reveal="auto" orientation="' + _THUMB_ORIENT + '" camera-orbit="40deg 68deg 110%" shadow-intensity="0.6" exposure="1.1" style="pointer-events:none;width:100%;height:100%;background:transparent;"></model-viewer>' : (_CUBE_SVG + '<span>View 3D</span>')) + '</div><figcaption>' + escapeHtml(m.master_code) + '</figcaption></figure>' +
              '</div>' +
              '<div class="kdsp-auto-meta">' +
                '<span class="kdsp-muted"><code>' + escapeHtml(m.master_code) + '</code> · ↔' + _codeDim(m.master_code) + ' · ' + (m.thickness_mm != null ? m.thickness_mm + 'mm ' : '') + escapeHtml(m.material || '') + '</span>' +
                '<span class="kdsp-auto-btns">' +
                  '<button type="button" class="kdsp-btn kdsp-auto3d" data-code="' + escapeHtml(m.master_code) + '">3D</button>' +
                  '<button type="button" class="kdsp-btn kdsp-btn-primary kdsp-approve" data-code="' + escapeHtml(m.master_code) + '" data-th="' + (m.thickness_mm == null ? '' : m.thickness_mm) + '" data-mat="' + escapeHtml(m.material || '') + '" data-grn="' + escapeHtml(m.grain || '') + '">Approve</button>' +
                '</span>' +
              '</div>' +
            '</div>';
          }).join('') + '</div>';
      }
      card.innerHTML =
        '<div class="kdsp-revrow">' +
          '<img class="kdsp-thumb" src="data:image/jpeg;base64,' + (r.photo_data || '') + '" alt="">' +
          '<div class="kdsp-revmeta">' +
            '<p class="kdsp-muted">added by ' + escapeHtml(r.created_by_role || '') + ' · ' + _relAgo + '</p>' +
            '<div style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span class="kdsp-muted">Quantity</span><input type="number" class="kdsp-rev-qty" min="1" max="99" value="' + (r.qty || 1) + '" style="width:72px;text-align:center;"></div>' +
            bounce +
            (r.note ? '<p style="font-size:13px;color:#b8a06a;margin:4px 0;">"' + _noteHtml(r.note) + '"</p>' : '') +
            autoHtml +
            '<p class="kdsp-muted" style="margin:8px 0 2px;">' + (autos.length ? 'Or find another code:' : (_L ? 'No code within ±5mm of ' + _L + 'mm — find manually:' : 'Find a code:')) + '</p>' +
            '<input type="text" class="kdsp-input kdsp-pick-q" placeholder="Find code or length (e.g. 946)…" data-id="' + escapeHtml(r.id) + '">' +
            '<div class="kdsp-pick-results" data-id="' + escapeHtml(r.id) + '"></div>' +
            _aiSuggestHtml(r.ai_suggestion) +
            '<button type="button" class="kdsp-btn kdsp-btn-ghost kdsp-airerun" data-id="' + escapeHtml(r.id) + '" title="Re-run AI match (e.g. after a new code was added)">↻ Re-run AI</button>' +
            '<div class="kdsp-actions">' +
              '<button type="button" class="kdsp-btn kdsp-btn-primary kdsp-assign" data-id="' + escapeHtml(r.id) + '" disabled>Assign code → send to worker</button>' +
              '<button type="button" class="kdsp-btn kdsp-btn-danger kdsp-reject" data-id="' + escapeHtml(r.id) + '">Reject</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      el.appendChild(card);
      (function (t) { if (t) { t.style.cursor = 'zoom-in'; t.addEventListener('click', function () { _openPhoto(r.photo_data); }); } })(card.querySelector('.kdsp-thumb'));
      // เอ๋: the auto-match 3D cell shows a SOLID model thumbnail (pointer-events:none)
      // and the .kdsp-auto3d handler below opens the full-screen _kdOpen3D modal on
      // click — for both the thumbnail cell and the 3D button.
      if (autos.length && typeof _ensureModelViewer === 'function') _ensureModelViewer();
      if (autos.length) {
        _wireMvErrors(card);   // swap a failed GLB cell for "no 3D model"
        // เอ๋ #4: overlay dark feature-edges on the SOLID thumbnail for clarity (keeps the fill)
        Array.prototype.forEach.call(card.querySelectorAll('.kdsp-cmp-3d model-viewer'), _applyThumbEdges);
      }
      // เอ๋ #5: re-run the AI match (e.g. after a new code entered the catalog) — fire-and-forget; the listener repaints when the fresh ai_suggestion lands
      (function (b) { if (b) b.addEventListener('click', function () { _fireAiMatch(r.id, r.photo_data, r.note); _kdToast('Re-running AI…'); }); })(card.querySelector('.kdsp-airerun'));
      card.querySelectorAll('.kdsp-approve').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          btn.disabled = true;
          try {
            await assignCode(r.id, btn.getAttribute('data-code'), { thickness_mm: btn.getAttribute('data-th') ? Number(btn.getAttribute('data-th')) : null, material: btn.getAttribute('data-mat'), grain: btn.getAttribute('data-grn') }, revQty());
            _kdToast('Approved → sent to worker');
          } catch (e) { btn.disabled = false; _kdToast('Save failed'); }
        });
      });
      card.querySelectorAll('.kdsp-auto3d').forEach(function (b) { b.addEventListener('click', function () { _kdOpen3D(b.getAttribute('data-code')); }); });

      var chosen = { code: '', meta: {} };
      var revQty = function () { var qv = card.querySelector('.kdsp-rev-qty'); return qv ? Number(qv.value) : null; };
      var input = card.querySelector('.kdsp-pick-q');
      var results = card.querySelector('.kdsp-pick-results');
      var assignBtn = card.querySelector('.kdsp-assign');
      function paintResults() {
        var list = codePickerFilter(_uploadedDxfsCache || {}, input.value).slice(0, 30);
        if (!list.length) { results.innerHTML = '<p class="kdsp-muted">No matching code</p>'; return; }
        results.innerHTML = list.map(function (m) {
          return '<div class="kdsp-cand" data-code="' + escapeHtml(m.master_code) + '">' +
            '<code>' + escapeHtml(m.master_code) + '</code>' +
            '<span class="kdsp-muted">' + (m.thickness_mm != null ? m.thickness_mm + 'mm' : '') + ' ' + escapeHtml(m.material || '') + ' ' + escapeHtml(m.grain || '') + (_codeDim(m.master_code) ? ' · ↔' + _codeDim(m.master_code) : '') + '</span>' +
            '<button type="button" class="kdsp-3d" data-code="' + escapeHtml(m.master_code) + '">3D</button>' +
            '<button type="button" class="kdsp-use" data-code="' + escapeHtml(m.master_code) + '" data-th="' + (m.thickness_mm == null ? '' : m.thickness_mm) + '" data-mat="' + escapeHtml(m.material || '') + '" data-grn="' + escapeHtml(m.grain || '') + '">use</button>' +
          '</div>';
        }).join('');
      }
      input.addEventListener('input', paintResults);
      results.addEventListener('click', function (e) {
        var b3 = e.target.closest('.kdsp-3d'); if (b3) { _kdOpen3D(b3.getAttribute('data-code')); return; }
        var bu = e.target.closest('.kdsp-use'); if (!bu) return;
        chosen = { code: bu.getAttribute('data-code'), meta: { thickness_mm: bu.getAttribute('data-th') ? Number(bu.getAttribute('data-th')) : null, material: bu.getAttribute('data-mat'), grain: bu.getAttribute('data-grn') } };
        input.value = chosen.code; assignBtn.disabled = false; paintResults();
      });
      // AI suggestion "use" → same assign flow; resolve meta from the catalog at click
      card.querySelectorAll('.kdsp-ai-use').forEach(function (b) {
        b.addEventListener('click', function () {
          var code = b.getAttribute('data-code');
          var m = codePickerFilter(_uploadedDxfsCache || {}, code).filter(function (x) { return x.master_code === code; })[0] || {};
          chosen = { code: code, meta: { thickness_mm: (m.thickness_mm == null ? null : m.thickness_mm), material: m.material || '', grain: m.grain || '' } };
          if (input) input.value = code;
          if (assignBtn) assignBtn.disabled = false;
        });
      });
      assignBtn.addEventListener('click', async function () {
        if (!chosen.code) return; assignBtn.disabled = true;
        try { await assignCode(r.id, chosen.code, chosen.meta, revQty()); _kdToast('Sent to worker to confirm'); } catch (e) { assignBtn.disabled = false; _kdToast('Save failed'); }
      });
      card.querySelector('.kdsp-reject').addEventListener('click', async function () {
        try { await rejectIntake(r.id); _kdToast('Rejected'); } catch (e) { _kdToast('Action failed'); }
      });
    });
    return el;
  }

  // ── ensure <model-viewer> is registered (so we can embed it INLINE) ──
  // เอ๋ requirement: the worker must SEE the GLB beside their photo and compare.
  // Matches app.js's _kdOpen3D loader (const _KD3D_MV_CDN, model-viewer 4.0.0)
  // so inline + modal use the same build. Resolves when the element is defined.
  var _mvReady = null;
  function _ensureModelViewer() {
    if (_mvReady) return _mvReady;
    _mvReady = new Promise(function (resolve) {
      if (window.customElements && customElements.get('model-viewer')) { resolve(true); return; }
      var s = document.createElement('script'); s.type = 'module';
      s.src = 'https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js'; // matches _KD3D_MV_CDN
      s.onload = function () { resolve(true); };
      s.onerror = function () { resolve(false); };
      document.head.appendChild(s);
    });
    return _mvReady;
  }

  // ── thumbnail edge overlay (เอ๋ #4) — dark CAD feature-lines ON the solid model ──
  // Overlays THREE.EdgesGeometry lines (≥22° feature edges) on each mesh of an
  // inline <model-viewer>, KEEPING the surface fill (unlike the modal's hidden mode)
  // so the thumbnail reads as a solid part with crisp edges. Uses model-viewer's own
  // scene (mv[Symbol(scene)]) + the app's THREE (window._kd3dEnsureThree). Idempotent;
  // a no-op (silent) if THREE/scene unavailable → the cell stays the plain solid GLB.
  // NOTE: model-viewer is rAF-driven → only paints on a visible tab (verify on a real device).
  function _buildThumbEdges(THREE, scene) {
    if (!THREE || !scene || typeof scene.traverse !== 'function') return 0;
    var n = 0;
    scene.traverse(function (node) {
      if (!node || !node.isMesh || !node.geometry || !node.geometry.attributes || !node.geometry.attributes.position) return;
      // เอ๋: only edge the actual model (meshes under node 'world') — NOT model-viewer's
      // shadow/ground/skybox planes, which otherwise draw a big "floor frame" rectangle.
      var underWorld = false;
      for (var pa = node.parent; pa; pa = pa.parent) { if (pa.name === 'world') { underWorld = true; break; } }
      if (!underWorld) return;
      if (node.__kdspThumbEdged) return;
      try {
        var eg = new THREE.EdgesGeometry(node.geometry, 22);
        var mat = new THREE.LineBasicMaterial({ color: 0x111317, transparent: true, opacity: 0.85, depthTest: true, depthWrite: false });
        var line = new THREE.LineSegments(eg, mat);
        line.renderOrder = 2;
        node.add(line);                 // fill kept → solid model + dark edge lines
        node.__kdspThumbEdged = true;
        n++;
      } catch (e) {}
    });
    return n;
  }
  function _applyThumbEdges(mv) {
    if (!mv || mv.__kdspThumbWired) return;
    mv.__kdspThumbWired = true;
    function apply() {
      var ensure = window._kd3dEnsureThree;
      if (typeof ensure !== 'function') return;
      var scene = null;
      try {
        var sym = Object.getOwnPropertySymbols(mv).find(function (s) { return s.toString() === 'Symbol(scene)'; });
        scene = sym ? mv[sym] : null;
      } catch (e) { return; }
      if (!scene) return;
      ensure().then(function (THREE) {
        try { var k = _buildThumbEdges(THREE, scene); if (k && typeof scene.queueRender === 'function') scene.queueRender(); } catch (e) {}
      }).catch(function () {});
    }
    if (mv.loaded) apply();
    mv.addEventListener('load', apply);
  }

  // ── worker confirm-GLB list (Thai) — photo beside the live 3D model ──
  function _awaiting() {
    var out = [];
    for (var id in _stockCache) { var r = _stockCache[id]; if (r && r.status === 'awaiting_worker_confirm') out.push(Object.assign({ id: id }, r)); }
    out.sort(function (a, b) { return (b.reviewed_at || 0) - (a.reviewed_at || 0); });
    return out;
  }
  function _buildWorkerConfirm() {
    var el = document.createElement('section'); el.className = 'kdsp-section';
    var rows = _awaiting();
    el.innerHTML = '<h3 class="kdsp-h">Confirm: is this the right part?</h3>' + (rows.length ? '' : '<p class="kdsp-empty">Nothing to confirm</p>');
    if (rows.length) _ensureModelViewer();   // load the element so the inline GLB renders
    rows.forEach(function (r) {
      var card = document.createElement('div'); card.className = 'kdsp-card';
      var glb = (typeof _kd3dGlbUrl === 'function' && r.code) ? _kd3dGlbUrl(r.code) : '';
      // SIDE-BY-SIDE compare: the worker's photo next to the live GLB.
      card.innerHTML =
        '<p class="kdsp-muted"><code>' + escapeHtml(r.code || '') + '</code> · ' + (r.thickness_mm != null ? r.thickness_mm + 'mm ' : '') + escapeHtml(r.material || '') + '</p>' +
        (r.note ? '<p style="font-size:13px;color:#b8a06a;margin:4px 0;">"' + _noteHtml(r.note) + '"</p>' : '') +
        '<p class="kdsp-cmp-cap">Photo ↔ 3D model — do they match?</p>' +
        '<div class="kdsp-compare">' +
          '<figure class="kdsp-cmp"><img src="data:image/jpeg;base64,' + (r.photo_data || '') + '" alt=""><figcaption>Photo</figcaption></figure>' +
          '<figure class="kdsp-cmp">' + (glb ? '<model-viewer src="' + glb + '" camera-controls auto-rotate camera-orbit="40deg 68deg 110%" shadow-intensity="0.6" exposure="1.1" interaction-prompt="none" reveal="auto" style="background:#11151c !important;"></model-viewer>' : '<div class="kdsp-noimg"></div>') + '<figcaption>3D model</figcaption></figure>' +
        '</div>' +
        '<button type="button" class="kdsp-btn kdsp-btn-ghost kdsp-see3d" data-code="' + escapeHtml(r.code || '') + '">Open 3D</button>' +
        '<div class="kdsp-actions">' +
          '<button type="button" class="kdsp-btn kdsp-btn-primary kdsp-ok" data-id="' + escapeHtml(r.id) + '">✓ Correct</button>' +
          '<button type="button" class="kdsp-btn kdsp-btn-danger kdsp-no" data-id="' + escapeHtml(r.id) + '">✗ Not this</button>' +
        '</div>';
      el.appendChild(card);
      (function (p) { if (p) { p.style.cursor = 'zoom-in'; p.addEventListener('click', function () { _openPhoto(r.photo_data); }); } })(card.querySelector('.kdsp-cmp img'));
      _wireMvErrors(card);
      card.querySelector('.kdsp-see3d').addEventListener('click', function () { if (r.code) _kdOpen3D(r.code); });
      card.querySelector('.kdsp-ok').addEventListener('click', async function () {
        try { await workerConfirmGlb(r.id); _kdToast('Added to stock — thanks'); } catch (e) { _kdToast('Action failed'); }
      });
      card.querySelector('.kdsp-no').addEventListener('click', async function () {
        try { await workerRejectGlb(r.id); _kdToast('Sent back for re-pick'); } catch (e) { _kdToast('Action failed'); }
      });
    });
    return el;
  }

  // ── stock list ──────────────────────────────────────────────
  var _listQuery = '';
  function _buildList(readOnly) {
    var el = document.createElement('section'); el.className = 'kdsp-section';
    var groups = confirmedByCode();
    var codes = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b); });
    if (_listQuery) {
      var q = _listQuery.toLowerCase(), qn = (/^\d+$/.test(q) ? parseInt(q, 10) : null);
      codes = codes.filter(function (c) {
        if (c.toLowerCase().indexOf(q) !== -1) return true;
        if (qn != null) { var d = _codeDims(c); if (d && Math.min(Math.abs(d.w * 10 - qn), Math.abs(d.h * 10 - qn), Math.abs(d.w - qn), Math.abs(d.h - qn)) <= 5) return true; }
        return false;
      });
    }
    // When a query is typed, also surface catalog codes that match but have NO
    // stock yet (separate section below) so search reaches every part ever cut,
    // not just confirmed stock. Excludes codes already shown in the stock grid.
    var catalog = _listQuery ? catalogNotInStock(_uploadedDxfsCache || {}, _listQuery, groups).slice(0, 40) : [];
    el.innerHTML = '<div class="kdsp-listhead"><h3 class="kdsp-h">Stock parts</h3>' +
      '<input type="text" id="kdsp-search" class="kdsp-input" placeholder="Search code or length…" value="' + escapeHtml(_listQuery) + '"></div>';
    var grid = document.createElement('div'); grid.className = 'kdsp-grid'; el.appendChild(grid);
    if (!codes.length) {
      var emptyMsg = (Object.keys(groups).length === 0) ? 'No stock yet — approve items above first'
        : (!_listQuery ? 'No stock yet'
        : (catalog.length ? 'No stock for this — see catalog below' : 'No matching code'));
      grid.innerHTML = '<p class="kdsp-empty">' + emptyMsg + '</p>';
    }
    codes.forEach(function (code) {
      var g = groups[code];
      var card = document.createElement('div'); card.className = 'kdsp-card kdsp-stockcard';
      var photo = (g.rows[0] && g.rows[0].photo_data) ? '<img class="kdsp-thumb" src="data:image/jpeg;base64,' + g.rows[0].photo_data + '" alt="">' : '<div class="kdsp-thumb kdsp-noimg"></div>';
      var firstQty = (g.rows[0] && g.rows[0].qty != null) ? g.rows[0].qty : 1;
      card.innerHTML = photo +
        '<code class="kdsp-code">' + escapeHtml(code) + '</code>' +
        '<div class="kdsp-meta"><span class="kdsp-pill">×' + g.qty + ' in stock</span>' +
        '<span class="kdsp-muted">' + (g.thickness_mm != null ? g.thickness_mm + 'mm ' : '') + escapeHtml(g.material || '') + '</span></div>' +
        '<div class="kdsp-cardfoot"><button type="button" class="kdsp-link kdsp-view3d" data-code="' + escapeHtml(code) + '">View 3D</button>' +
        (readOnly ? '' :
          '<span class="kdsp-foot-actions">' +
            '<button type="button" class="kdsp-icon kdsp-edit" data-code="' + escapeHtml(code) + '" title="edit qty / code">✎</button>' +
            '<button type="button" class="kdsp-icon kdsp-del" data-code="' + escapeHtml(code) + '" title="delete one row">✕</button>' +
          '</span>') +
        '</div>' +
        (readOnly ? '' :
          '<div class="kdsp-editbox" hidden>' +
            '<div class="kdsp-edit-qty">' +
              '<input type="number" class="kdsp-input kdsp-edit-qval" min="1" max="99" value="' + escapeHtml(String(firstQty)) + '">' +
              '<button type="button" class="kdsp-btn kdsp-edit-qsave">Save</button>' +
            '</div>' +
            '<input type="text" class="kdsp-input kdsp-edit-codeq" placeholder="Change code…">' +
            '<div class="kdsp-edit-results"></div>' +
          '</div>');
      grid.appendChild(card);
      (function (t) { if (t && !t.classList.contains('kdsp-noimg')) { t.style.cursor = 'zoom-in'; t.addEventListener('click', function () { _openPhoto(g.rows[0] && g.rows[0].photo_data); }); } })(card.querySelector('.kdsp-thumb'));
      card.querySelector('.kdsp-view3d').addEventListener('click', function () { _kdOpen3D(code); });
      if (!readOnly) {
        var rid = g.rows[0] && g.rows[0].id;
        card.querySelector('.kdsp-del').addEventListener('click', async function () {
          if (!rid) return;
          try { await _deleteStock(rid); _kdToast('Deleted one row'); } catch (e) { _kdToast('Delete failed'); }
        });
        var editBox = card.querySelector('.kdsp-editbox');
        card.querySelector('.kdsp-edit').addEventListener('click', function () { editBox.hidden = !editBox.hidden; });
        card.querySelector('.kdsp-edit-qsave').addEventListener('click', async function () {
          if (!rid) return;
          var v = card.querySelector('.kdsp-edit-qval').value;
          var qn = Math.min(99, Math.max(1, Number(v) || 1));
          try { await _updateStock(rid, { qty: qn }); _kdToast('Saved'); } catch (e) { _kdToast('Save failed'); }
        });
        var codeQ = card.querySelector('.kdsp-edit-codeq');
        var codeResults = card.querySelector('.kdsp-edit-results');
        function paintEditResults() {
          var list = codePickerFilter(_uploadedDxfsCache || {}, codeQ.value).slice(0, 20);
          if (!list.length) { codeResults.innerHTML = '<p class="kdsp-muted">No matching code</p>'; return; }
          codeResults.innerHTML = list.map(function (m) {
            return '<div class="kdsp-cand" data-code="' + escapeHtml(m.master_code) + '">' +
              '<code>' + escapeHtml(m.master_code) + '</code>' +
              '<span class="kdsp-muted">' + (m.thickness_mm != null ? m.thickness_mm + 'mm' : '') + ' ' + escapeHtml(m.material || '') + ' ' + escapeHtml(m.grain || '') + (_codeDim(m.master_code) ? ' · ↔' + _codeDim(m.master_code) : '') + '</span>' +
              '<button type="button" class="kdsp-use" data-code="' + escapeHtml(m.master_code) + '" data-th="' + (m.thickness_mm == null ? '' : m.thickness_mm) + '" data-mat="' + escapeHtml(m.material || '') + '" data-grn="' + escapeHtml(m.grain || '') + '">use</button>' +
            '</div>';
          }).join('');
        }
        codeQ.addEventListener('input', paintEditResults);
        codeResults.addEventListener('click', async function (e) {
          var bu = e.target.closest('.kdsp-use'); if (!bu || !rid) return;
          var newCode = bu.getAttribute('data-code');
          var th = bu.getAttribute('data-th') ? Number(bu.getAttribute('data-th')) : null;
          try { await _updateStock(rid, { code: newCode, thickness_mm: th, material: bu.getAttribute('data-mat') || '', grain: bu.getAttribute('data-grn') || '' }); _kdToast('Code updated'); }
          catch (err) { _kdToast('Save failed'); }
        });
      }
    });
    // "In catalog · no stock yet" — query matches from uploaded_dxfs that aren't
    // stocked. View 3D opens the model so เอ๋ can confirm it's the part to log.
    if (catalog.length) {
      var cat = document.createElement('div'); cat.className = 'kdsp-catalog';
      cat.innerHTML = '<p class="kdsp-cathead">In catalog · no stock yet · ' + catalog.length + '</p>';
      var cgrid = document.createElement('div'); cgrid.className = 'kdsp-grid';
      catalog.forEach(function (m) {
        var cc = document.createElement('div'); cc.className = 'kdsp-card kdsp-stockcard kdsp-catcard';
        cc.innerHTML = '<div class="kdsp-thumb kdsp-noimg"></div>' +
          '<code class="kdsp-code">' + escapeHtml(m.master_code) + '</code>' +
          '<div class="kdsp-meta"><span class="kdsp-muted">' + (m.thickness_mm != null ? m.thickness_mm + 'mm ' : '') + escapeHtml(m.material || '') + (_codeDim(m.master_code) ? ' · ↔' + _codeDim(m.master_code) : '') + '</span></div>' +
          '<div class="kdsp-cardfoot"><button type="button" class="kdsp-link kdsp-view3d" data-code="' + escapeHtml(m.master_code) + '">View 3D</button></div>';
        cgrid.appendChild(cc);
        cc.querySelector('.kdsp-view3d').addEventListener('click', function () { _kdOpen3D(m.master_code); });
      });
      cat.appendChild(cgrid);
      el.appendChild(cat);
    }
    var search = el.querySelector('#kdsp-search');
    search.addEventListener('input', function () { _listQuery = search.value; renderHome(); setTimeout(function () { var s = ROOT.querySelector('#kdsp-search'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }, 0); });
    return el;
  }

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
  // Fire-and-forget the AI match request at intake. endpoint defaults to the
  // module const (the param exists so tests inject without depending on it).
  // Prefer window.fetch so it's correct in the browser and the test stub wins.
  function _fireAiMatch(id, photos, remarks, endpoint) {
    endpoint = endpoint || KDSP_AI_ENDPOINT;
    var list = Array.isArray(photos) ? photos : (photos ? [photos] : []);
    if (!id || !list.length || !endpoint) return;
    try {
      var w = (typeof window !== 'undefined') ? window : null;
      var f = (w && typeof w.fetch === 'function') ? w.fetch.bind(w) : (typeof fetch === 'function' ? fetch : null);
      if (!f) return;
      f(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, photos: list, photo: list[0], remarks: remarks || '' })
      }).catch(function () {});
    } catch (e) {}
  }

  // ── role router ─────────────────────────────────────────────
  function renderHome() {
    if (typeof ROOT === 'undefined' || !ROOT) return;
    if (ROOT.querySelector && ROOT.querySelector('.kdsp-input:focus') && document.activeElement && document.activeElement.id !== 'kdsp-search') return; // don't yank focus mid-type (except search, handled above)
    var admin = (typeof isAdmin === 'function') && isAdmin();
    ROOT.innerHTML = '';
    var wrap = document.createElement('div'); wrap.className = 'kdsp-home';
    if (admin) { wrap.appendChild(_buildCapture()); wrap.appendChild(_buildReview()); wrap.appendChild(_buildList(false)); }
    else { wrap.appendChild(_buildCapture()); wrap.appendChild(_buildWorkerConfirm()); wrap.appendChild(_buildList(true)); }
    ROOT.appendChild(wrap);
  }

  function init() {
    _stockCache = _loadLS();   // instant paint (no photos yet)
    if (!window.firebaseDB) return;
    try {
      _ref().on('value', function (snap) {
        _stockCache = snap.val() || {};
        _saveLS(_stockCache);
        if (typeof _backgroundRender === 'function') _backgroundRender();
      }, function (err) { console.warn('[kdStockPart] listener error:', err); });
    } catch (e) { console.warn('[kdStockPart] init failed:', e); }
  }

  window.kdStockPart = {
    renderHome: renderHome,
    init: init,
    stockQtyByCode: stockQtyByCode,
    confirmedByCode: confirmedByCode,
    _test: {
      _aggregateConfirmed: _aggregateConfirmed,
      confirmedByCode: confirmedByCode,
      codePickerFilter: codePickerFilter,
      catalogNotInStock: catalogNotInStock,
      _rowPhotos: _rowPhotos,
      _aiSuggestHtml: _aiSuggestHtml,
      _fireAiMatch: _fireAiMatch,
      _buildThumbEdges: _buildThumbEdges,
      _parseLen: _parseLen,
      _codeDims: _codeDims,
      _codesByLength: _codesByLength,
      relativeTime: relativeTime,
      b64Bytes: b64Bytes,
      _scaleFor: _scaleFor,
      _compressLadder: _compressLadder,
      _setCache: function (c) { _stockCache = c || {}; },
      saveIntake: saveIntake, assignCode: assignCode, rejectIntake: rejectIntake,
      workerConfirmGlb: workerConfirmGlb, workerRejectGlb: workerRejectGlb,
      _updateStock: _updateStock, _deleteStock: _deleteStock,
      _snapshot: function () { return _stockCache; }
    }
  };
})();
