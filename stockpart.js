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

  // ── (store, render added in later tasks) ────────────────────

  function renderHome() {
    if (typeof ROOT === 'undefined' || !ROOT) return;
    ROOT.innerHTML = '<div class="kdsp-home"><p class="kdsp-empty">Stock Part — coming up.</p></div>';
  }

  function init() { /* listener wired in Task 2 */ }

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
      _setCache: function (c) { _stockCache = c || {}; }
    }
  };
})();
