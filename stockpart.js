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

  // ── (helpers, store, render added in later tasks) ───────────

  function renderHome() {
    if (typeof ROOT === 'undefined' || !ROOT) return;
    ROOT.innerHTML = '<div class="kdsp-home"><p class="kdsp-empty">Stock Part — coming up.</p></div>';
  }

  function init() { /* listener wired in Task 2 */ }

  window.kdStockPart = {
    renderHome: renderHome,
    init: init,
    stockQtyByCode: function () { return 0; },   // real impl Task 1
    confirmedByCode: function () { return {}; }, // real impl Task 1
    _test: {}
  };
})();
