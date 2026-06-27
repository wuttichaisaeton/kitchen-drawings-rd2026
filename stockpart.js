;(function () {
  'use strict';

  // ── constants ───────────────────────────────────────────────
  var RTDB_PATH = 'stock_parts';
  var LS_CACHE  = 'kd_stock_parts_v1';     // metadata-only mirror (no photos)
  var LS_SUBMIT = 'kd_sp_submit_times';    // per-device intake rate cap
  var QTY_MIN = 1, QTY_MAX = 99;
  var TARGET_BYTES = 700000;               // compress target (RTDB-friendly)
  var MAX_BYTES = 1500000;                 // hard reject ceiling
  var CAP_WARN = 10, CAP_BLOCK = 20;       // intakes / 24h / device

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
    var list = Object.keys(byCode).map(function (k) { return byCode[k]; });
    if (q) list = list.filter(function (m) { return m.master_code.toLowerCase().indexOf(q) !== -1; });
    list.sort(function (a, b) { return a.master_code.localeCompare(b.master_code); });
    return list;
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
  async function assignCode(id, code, meta) {
    meta = meta || {};
    await _updateStock(id, { status: 'awaiting_worker_confirm', code: code, thickness_mm: (meta.thickness_mm == null ? null : meta.thickness_mm), material: meta.material || '', grain: meta.grain || '', reviewed_at: Date.now(), reviewed_by_role: 'admin', bounced_from: '', bounced_at: null });
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
    for (var id in rows) { var c = Object.assign({}, rows[id]); delete c.photo_data; out[id] = c; }
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
      '<label class="kdsp-photo" id="kdsp-photo-label"><input type="file" accept="image/*" id="kdsp-photo" hidden>' +
      '<span class="kdsp-photo-hint">Take / choose a photo</span></label>' +
      '<img class="kdsp-preview" id="kdsp-preview" alt="" hidden>' +
      '<div class="kdsp-row"><span>Quantity</span><div class="kdsp-qty">' +
        '<button type="button" id="kdsp-qminus">−</button><b id="kdsp-qval">1</b><button type="button" id="kdsp-qplus">+</button>' +
      '</div></div>' +
      '<input type="text" id="kdsp-note" class="kdsp-input kdsp-th" placeholder="Remarks (optional, Thai OK)">' +
      '<button type="button" id="kdsp-submit" class="kdsp-btn kdsp-btn-primary" disabled>Send to review</button>';

    var u = el.querySelector('#kdsp-undo'); if (u) u.onclick = _undoLastIntake;
    var qty = 1, photoB64 = null;
    var qval = el.querySelector('#kdsp-qval'), submit = el.querySelector('#kdsp-submit');
    function setQty(n) { qty = Math.min(QTY_MAX, Math.max(QTY_MIN, n)); qval.textContent = String(qty); }
    el.querySelector('#kdsp-qminus').onclick = function () { setQty(qty - 1); };
    el.querySelector('#kdsp-qplus').onclick = function () { setQty(qty + 1); };
    el.querySelector('#kdsp-photo').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      submit.disabled = true; el.querySelector('.kdsp-photo-hint').textContent = 'Compressing…';
      compressImage(f).then(function (b64) {
        photoB64 = b64;
        var pv = el.querySelector('#kdsp-preview'); pv.src = 'data:image/jpeg;base64,' + b64; pv.hidden = false;
        el.querySelector('.kdsp-photo-hint').textContent = 'Change photo';
        submit.disabled = false;
      }).catch(function (err) {
        photoB64 = null; submit.disabled = true;
        el.querySelector('.kdsp-photo-hint').textContent = 'Take / choose a photo';
        _kdToast(err && err.message === 'too-large' ? 'Image too large — try again' : 'Invalid image — try again');
      });
    });
    submit.addEventListener('click', async function () {
      if (!photoB64) return;
      if (_submitCount24h() >= CAP_BLOCK) { _kdToast('Too many added today — try tomorrow'); return; }
      var row = { status: 'pending', code: '', qty: qty, note: el.querySelector('#kdsp-note').value || '', photo_data: photoB64, created_at: Date.now(), created_by_role: (typeof getRole === 'function' ? getRole() : 'workshop') };
      submit.disabled = true;
      try {
        if (JSON.stringify(row).length > MAX_BYTES) throw new Error('too-large');
        _undoLast = await saveIntake(row);
        var _n = _recordSubmit();
        _kdToast('Sent — waiting for review · you can undo');
        if (_n > CAP_WARN) _kdToast('A lot added today');
        renderHome();
      } catch (e) { submit.disabled = false; _kdToast('Save failed — try again'); }
    });
    return el;
  }

  async function _undoLastIntake() {
    if (!_undoLast) return;
    var id = _undoLast; _undoLast = null;
    try { await _deleteStock(id); _kdToast('Undone'); renderHome(); } catch (e) { _kdToast('Undo failed'); }
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
      var bounce = r.bounced_from ? '<div class="kdsp-flag">Worker said not' + escapeHtml(r.bounced_from) + '</div>' : '';
      card.innerHTML =
        '<div class="kdsp-revrow">' +
          '<img class="kdsp-thumb" src="data:image/jpeg;base64,' + (r.photo_data || '') + '" alt="">' +
          '<div class="kdsp-revmeta">' +
            '<p class="kdsp-muted">Qty ' + (r.qty || 0) + ' · by ' + escapeHtml(r.created_by_role || '') + ' · ' + relativeTime(now, r.created_at) + '</p>' +
            bounce +
            '<input type="text" class="kdsp-input kdsp-pick-q" placeholder="Find part code…" data-id="' + escapeHtml(r.id) + '">' +
            '<div class="kdsp-pick-results" data-id="' + escapeHtml(r.id) + '"></div>' +
            '<p class="kdsp-ai-slot kdsp-muted">AI suggestion — coming soon</p>' +
            '<div class="kdsp-actions">' +
              '<button type="button" class="kdsp-btn kdsp-btn-primary kdsp-assign" data-id="' + escapeHtml(r.id) + '" disabled>Assign code → send to worker</button>' +
              '<button type="button" class="kdsp-btn kdsp-btn-danger kdsp-reject" data-id="' + escapeHtml(r.id) + '">Reject</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      el.appendChild(card);

      var chosen = { code: '', meta: {} };
      var input = card.querySelector('.kdsp-pick-q');
      var results = card.querySelector('.kdsp-pick-results');
      var assignBtn = card.querySelector('.kdsp-assign');
      function paintResults() {
        var list = codePickerFilter(_uploadedDxfsCache || {}, input.value).slice(0, 30);
        if (!list.length) { results.innerHTML = '<p class="kdsp-muted">No matching code</p>'; return; }
        results.innerHTML = list.map(function (m) {
          return '<div class="kdsp-cand" data-code="' + escapeHtml(m.master_code) + '">' +
            '<code>' + escapeHtml(m.master_code) + '</code>' +
            '<span class="kdsp-muted">' + (m.thickness_mm != null ? m.thickness_mm + 'mm' : '') + ' ' + escapeHtml(m.material || '') + ' ' + escapeHtml(m.grain || '') + '</span>' +
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
      assignBtn.addEventListener('click', async function () {
        if (!chosen.code) return; assignBtn.disabled = true;
        try { await assignCode(r.id, chosen.code, chosen.meta); _kdToast('Sent to worker to confirm'); } catch (e) { assignBtn.disabled = false; _kdToast('Save failed'); }
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
        '<p class="kdsp-cmp-cap">Photo ↔ 3D model — do they match?</p>' +
        '<div class="kdsp-compare">' +
          '<figure class="kdsp-cmp"><img src="data:image/jpeg;base64,' + (r.photo_data || '') + '" alt=""><figcaption>Photo</figcaption></figure>' +
          '<figure class="kdsp-cmp">' + (glb ? '<model-viewer src="' + glb + '" camera-controls auto-rotate interaction-prompt="none" reveal="auto"></model-viewer>' : '<div class="kdsp-noimg"></div>') + '<figcaption>3D model</figcaption></figure>' +
        '</div>' +
        '<button type="button" class="kdsp-btn kdsp-btn-ghost kdsp-see3d" data-code="' + escapeHtml(r.code || '') + '">Open 3D</button>' +
        '<div class="kdsp-actions">' +
          '<button type="button" class="kdsp-btn kdsp-btn-primary kdsp-ok" data-id="' + escapeHtml(r.id) + '">✓ Correct</button>' +
          '<button type="button" class="kdsp-btn kdsp-btn-danger kdsp-no" data-id="' + escapeHtml(r.id) + '">✗ Not this</button>' +
        '</div>';
      el.appendChild(card);
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
    if (_listQuery) { var q = _listQuery.toLowerCase(); codes = codes.filter(function (c) { return c.toLowerCase().indexOf(q) !== -1; }); }
    el.innerHTML = '<div class="kdsp-listhead"><h3 class="kdsp-h">Stock parts</h3>' +
      '<input type="text" id="kdsp-search" class="kdsp-input" placeholder="Search code…" value="' + escapeHtml(_listQuery) + '"></div>';
    var grid = document.createElement('div'); grid.className = 'kdsp-grid'; el.appendChild(grid);
    if (!codes.length) { grid.innerHTML = '<p class="kdsp-empty">' + (_listQuery ? 'No matching code' : 'No stock yet') + '</p>'; }
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
              '<span class="kdsp-muted">' + (m.thickness_mm != null ? m.thickness_mm + 'mm' : '') + ' ' + escapeHtml(m.material || '') + ' ' + escapeHtml(m.grain || '') + '</span>' +
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
    var search = el.querySelector('#kdsp-search');
    search.addEventListener('input', function () { _listQuery = search.value; renderHome(); setTimeout(function () { var s = ROOT.querySelector('#kdsp-search'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }, 0); });
    return el;
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
