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
  var THAI = '"Flux Architect","IBM Plex Sans Thai","Noto Sans Thai","Leelawadee UI","Sukhumvit Set","Thonburi",Tahoma,-apple-system,sans-serif';

  // ── state ───────────────────────────────────────────────────
  var _stockCache = {};   // pushId -> row
  var _undoLast = null;   // pushId of this session's last intake (undo-last)
  var _pickQuery = {};    // per-pending-row code-search text (review screen)

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
    await _updateStock(id, { status: 'awaiting_worker_confirm', code: code, thickness_mm: (meta.thickness_mm == null ? null : meta.thickness_mm), material: meta.material || '', grain: meta.grain || '', reviewed_at: Date.now(), reviewed_by_role: 'admin' });
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
    el.className = 'kdsp-card kdsp-th';
    el.innerHTML =
      (_undoLast ? '<button type="button" id="kdsp-undo" class="kdsp-btn kdsp-btn-ghost">เลิกล่าสุด</button>' : '') +
      '<h3 class="kdsp-h">เพิ่มของเข้าคลัง</h3>' +
      '<label class="kdsp-photo" id="kdsp-photo-label"><input type="file" accept="image/*" capture="environment" id="kdsp-photo" hidden>' +
      '<span class="kdsp-photo-hint">ถ่ายรูป part</span></label>' +
      '<img class="kdsp-preview" id="kdsp-preview" alt="" hidden>' +
      '<div class="kdsp-row"><span>จำนวน</span><div class="kdsp-qty">' +
        '<button type="button" id="kdsp-qminus">−</button><b id="kdsp-qval">1</b><button type="button" id="kdsp-qplus">+</button>' +
      '</div></div>' +
      '<input type="text" id="kdsp-note" class="kdsp-input" placeholder="หมายเหตุ (ไม่บังคับ)">' +
      '<button type="button" id="kdsp-submit" class="kdsp-btn kdsp-btn-primary" disabled>ส่งเข้าคิวตรวจ</button>';

    var u = el.querySelector('#kdsp-undo'); if (u) u.onclick = _undoLastIntake;
    var qty = 1, photoB64 = null;
    var qval = el.querySelector('#kdsp-qval'), submit = el.querySelector('#kdsp-submit');
    function setQty(n) { qty = Math.min(QTY_MAX, Math.max(QTY_MIN, n)); qval.textContent = String(qty); }
    el.querySelector('#kdsp-qminus').onclick = function () { setQty(qty - 1); };
    el.querySelector('#kdsp-qplus').onclick = function () { setQty(qty + 1); };
    el.querySelector('#kdsp-photo').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      submit.disabled = true; el.querySelector('.kdsp-photo-hint').textContent = 'กำลังย่อรูป…';
      compressImage(f).then(function (b64) {
        photoB64 = b64;
        var pv = el.querySelector('#kdsp-preview'); pv.src = 'data:image/jpeg;base64,' + b64; pv.hidden = false;
        el.querySelector('.kdsp-photo-hint').textContent = 'ถ่ายใหม่';
        submit.disabled = false;
      }).catch(function (err) {
        photoB64 = null; submit.disabled = true;
        el.querySelector('.kdsp-photo-hint').textContent = 'ถ่ายรูป part';
        _kdToast(err && err.message === 'too-large' ? 'รูปใหญ่เกินไป ลองถ่ายใหม่' : 'ไฟล์รูปไม่ถูกต้อง ลองใหม่');
      });
    });
    submit.addEventListener('click', async function () {
      if (!photoB64) return;
      if (_submitCount24h() >= CAP_BLOCK) { _kdToast('วันนี้เพิ่มของเยอะเกินไปแล้ว ลองพรุ่งนี้'); return; }
      var row = { status: 'pending', code: '', qty: qty, note: el.querySelector('#kdsp-note').value || '', photo_data: photoB64, created_at: Date.now(), created_by_role: (typeof getRole === 'function' ? getRole() : 'workshop') };
      submit.disabled = true;
      try {
        if (JSON.stringify(row).length > MAX_BYTES) throw new Error('too-large');
        _undoLast = await saveIntake(row);
        _recordSubmit();
        _kdToast('ส่งแล้ว รอเอ๋ตรวจ · กดเลิกได้');
        renderHome();
      } catch (e) { submit.disabled = false; _kdToast('บันทึกไม่สำเร็จ ลองใหม่'); }
    });
    return el;
  }

  async function _undoLastIntake() {
    if (!_undoLast) return;
    var id = _undoLast; _undoLast = null;
    try { await _deleteStock(id); _kdToast('ยกเลิกแล้ว'); renderHome(); } catch (e) { _kdToast('ยกเลิกไม่สำเร็จ'); }
  }

  // ── (render added in later tasks) ───────────────────────────

  function renderHome() {
    if (typeof ROOT === 'undefined' || !ROOT) return;
    ROOT.innerHTML = '<div class="kdsp-home"><p class="kdsp-empty">Stock Part — coming up.</p></div>';
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
