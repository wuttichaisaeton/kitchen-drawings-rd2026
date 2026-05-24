// drawings-ui/app.js — vanilla JS mobile/iPad UI with Projects + Library tabs.

const ROOT = document.getElementById('root');
const SEARCH = document.getElementById('search');
const SEARCH_CLEAR = document.getElementById('search-clear');
const UPDATED = document.getElementById('updated');
const COUNT_EL = document.getElementById('count');

let manifest = null;
let families = null;
let missingData = null;  // { scanned_at, project_name, count, missing: [{name,urn,family,folder_path,open_url}] }

let view = 'projects';   // 'projects' | 'library' | 'missing'
let stack = [];          // navigation stack ('home' | {kind:'family', name} | {kind:'project', name})

const LS_COMPLETED_KEY = 'kd_completed_projects_v1';
const LS_BENT_KEY = 'kd_bent_parts_v1';
const LS_COMMENTS_KEY = 'kd_comments_v1';        // { partCode: [{text, time}] }
const LS_COMMENTS_OPEN_KEY = 'kd_comments_open_v1';  // Set<partCode>: which rows have comments panel expanded
const LS_TIMERS_KEY = 'kd_timers_v1';             // { projectKey: { partCode: { sessions, active_start } } }
const LS_DELETED_KEY = 'kd_deleted_drawings_v1';  // { partCode: epoch_ms }  — soft-deleted drawings (workshop "redo this")
const LS_ADMIN_KEY = 'kd_admin_v1';               // '1' if this device is owner (เอ๋); only owner sees delete/edit buttons

// ──────────────────────────────────────────────────────────────────────
// Admin mode — only owner (เอ๋) can delete/restore/reset/edit data.
// Workshop staff (Jack, Noom, น้อง, iPad) see read+add only.
//
// Toggle:
//   • Visit  ?admin=1  → enable on this device (persists via localStorage)
//   • Visit  ?admin=0  → disable on this device
//   • Type   :admin    in search box → enable
//   • Type   :admin off in search box → disable
//
// Gated UI:
//   • ✕  Soft-delete drawing
//   • ↻  Restore drawing
//   • ↻  Timer reset / edit
//   • ✕  Delete individual comment
// (Adding comments, start/stop timer, mark bent — open to everyone)
// ──────────────────────────────────────────────────────────────────────

function isAdmin() {
  try { return localStorage.getItem(LS_ADMIN_KEY) === '1'; } catch { return false; }
}

function setAdmin(on) {
  try {
    if (on) localStorage.setItem(LS_ADMIN_KEY, '1');
    else localStorage.removeItem(LS_ADMIN_KEY);
  } catch {}
  updateAdminBadge();
}

function updateAdminBadge() {
  let badge = document.getElementById('admin-badge');
  const headerRow = document.querySelector('.header-row');
  if (isAdmin()) {
    if (!badge && headerRow) {
      badge = document.createElement('span');
      badge.id = 'admin-badge';
      badge.className = 'admin-badge';
      badge.textContent = '🔓 Admin';
      badge.title = 'Admin mode — delete/edit enabled. Type ":admin off" in search to disable.';
      headerRow.appendChild(badge);
    }
  } else if (badge) {
    badge.remove();
  }
}

// Apply URL flag on page load (clean URL after toggling so it doesn't
// stay around in browser history with the admin flag).
(function applyUrlAdminFlag() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has('admin')) {
      const v = params.get('admin');
      if (v === '1' || v === 'on' || v === 'true') setAdmin(true);
      else if (v === '0' || v === 'off' || v === 'false') setAdmin(false);
      params.delete('admin');
      const qs = params.toString();
      const cleanUrl = window.location.origin + window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
    }
  } catch (e) { console.warn('admin flag parse failed:', e); }
})();

// ──────────────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  return r.json();
}

function pdfUrl(entry) {
  if (entry.isManual) {
    return window.APP_CONFIG.MANUAL_BASE_URL + encodeURIComponent(entry.filename);
  }
  const base = window.APP_CONFIG.PDF_BASE_URL;
  const filename = entry.pdf;
  if (!filename) return '';
  const page = entry.page_number || 1;
  return base + encodeURIComponent(filename) + '#page=' + page;
}

function pdfUrlForCode(code) {
  // Soft-deleted drawings act as if missing (until re-exported)
  if (isDrawingSoftDeleted(code)) return '';
  const e = (manifest.auto_generated || {})[code];
  return e ? pdfUrl(e) : '';
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  } catch { return ''; }
}

function familyIcon(name) {
  const f = families[name];
  if (f && f.image) {
    // CSS mask-image: SVG = mask shape, background-color = --fam-color
    // (cascaded from parent row/card). Width/height = 1em scales the icon
    // with the parent's font-size — no per-container sizing needed.
    return `<span class="fam-icon" style="--icon-mask:url('${f.image}')" aria-hidden="true"></span>`;
  }
  return (f && f.icon) || '📄';
}

function famVars(name) {
  const f = families[name] || {};
  const color = f.color || '#4a90e2';
  const tint  = f.tint  || '#1a1f24';
  return `--fam-color:${color};--fam-tint:${tint}`;
}

function familyOrder(a, b) {
  const fa = families[a] || { order: 999 };
  const fb = families[b] || { order: 999 };
  return fa.order - fb.order;
}

// ──────────────────────────────────────────────────────────────────────
// Family remap — Fusion side classifies parts into broad families
// (Drawer, Back-Down, Floor, ...), but for UI display we want a finer
// split. Applied once at data-load time so the rest of the code sees
// only the remapped names.
//
// Rules:
//   • Old "Drawer" family + code prefix DSV1xx → DW-S1 (Slide type 1)
//   • Old "Drawer" family + code prefix DSV2xx → DW-S2 (Slide type 2)
//   • Old "Drawer" family + anything else      → DW-S1 (default bucket)
//   • Old "Back-Down" → DW-BK
//   • Old "Floor"     → DW-FL
//   • Everything else: keep as-is
// ──────────────────────────────────────────────────────────────────────

function _remapFamilyForCode(code, originalFamily) {
  if (originalFamily === 'Back-Down') return 'DW-BK';
  if (originalFamily === 'Floor')     return 'DW-FL';
  if (originalFamily === 'Drawer') {
    const prefix4 = (code || '').slice(0, 4).toUpperCase();
    if (prefix4 === 'DSV1') return 'DW-S1';
    if (prefix4 === 'DSV2') return 'DW-S2';
    return 'DW-S1';  // default bucket for any other Drawer-family code
  }
  return originalFamily;
}

function applyFamilyRemap() {
  if (manifest && manifest.auto_generated) {
    for (const [code, entry] of Object.entries(manifest.auto_generated)) {
      entry.family = _remapFamilyForCode(code, entry.family);
    }
  }
  if (missingData && Array.isArray(missingData.missing)) {
    for (const m of missingData.missing) {
      m.family = _remapFamilyForCode(m.name, m.family);
    }
  }
  if (manifest && manifest.projects) {
    for (const p of Object.values(manifest.projects)) {
      for (const part of (p.parts || [])) {
        part.family = _remapFamilyForCode(part.code, part.family);
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Completed projects (localStorage)
// ──────────────────────────────────────────────────────────────────────

function loadCompletedSet() {
  try {
    const raw = localStorage.getItem(LS_COMPLETED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function saveCompletedSet(set) {
  try { localStorage.setItem(LS_COMPLETED_KEY, JSON.stringify([...set])); } catch {}
}

function isCompleted(name) { return loadCompletedSet().has(name); }

function markCompleted(name, done) {
  const s = loadCompletedSet();
  if (done) s.add(name); else s.delete(name);
  saveCompletedSet(s);
}

// ── Bent parts (per-part workshop tracking) ─────────────────────────

function loadBentSet() {
  try {
    const raw = localStorage.getItem(LS_BENT_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function saveBentSet(set) {
  try { localStorage.setItem(LS_BENT_KEY, JSON.stringify([...set])); } catch {}
}

function bentKey(projectKey, code) { return `${projectKey}::${code}`; }

function isBent(projectKey, code) { return loadBentSet().has(bentKey(projectKey, code)); }

function markBent(projectKey, code, done) {
  const s = loadBentSet();
  const k = bentKey(projectKey, code);
  if (done) s.add(k); else s.delete(k);
  saveBentSet(s);
}

function bentCountForProject(projectKey, parts) {
  const set = loadBentSet();
  return parts.filter(p => set.has(bentKey(projectKey, p.code))).length;
}

// ──────────────────────────────────────────────────────────────────────
// Comments — per part code, SHARED across devices via Firebase Realtime DB.
// localStorage acts as offline cache + fallback if Firebase fails.
//
// Workshop staff (iPad) and designer (laptop) see the same comments
// in real-time. Thai text uses system Thai font (CSS .comment-text).
//
// Schema in Firebase RTDB:
//   comments/<partCode>/<pushId>: { text: "...", time: <epoch_ms> }
// ──────────────────────────────────────────────────────────────────────

let commentsCache = {};  // { partCode: [{text, time, _key}] } — synced from Firebase

function loadCachedComments() {
  try {
    const raw = localStorage.getItem(LS_COMMENTS_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch { return {}; }
}
function saveCachedComments(all) {
  try { localStorage.setItem(LS_COMMENTS_KEY, JSON.stringify(all)); } catch {}
}

// Initialize cache from localStorage; will be replaced when Firebase syncs.
commentsCache = loadCachedComments();

// Attach Firebase real-time listener on startup.
function initCommentsSync() {
  if (!window.firebaseDB) {
    console.warn('Firebase not available — comments are localStorage-only');
    return;
  }
  try {
    window.firebaseDB.ref('comments').on('value', snapshot => {
      const raw = snapshot.val() || {};
      // Normalize Firebase shape → our cache shape (array per code)
      const next = {};
      for (const [code, entries] of Object.entries(raw)) {
        const arr = [];
        for (const [key, val] of Object.entries(entries || {})) {
          if (val && val.text) {
            arr.push({ text: val.text, time: val.time || 0, _key: key });
          }
        }
        // Sort oldest → newest
        arr.sort((a, b) => (a.time || 0) - (b.time || 0));
        next[code] = arr;
      }
      commentsCache = next;
      saveCachedComments(commentsCache);
      // Re-render to reflect new comments from other devices
      try { render(); } catch {}
    }, err => {
      console.warn('Firebase comments listener error:', err);
    });
  } catch (e) {
    console.warn('Failed to attach Firebase listener:', e);
  }
}

function getComments(code) {
  return Array.isArray(commentsCache[code]) ? commentsCache[code] : [];
}

function addComment(code, text) {
  text = (text || '').trim();
  if (!text || !code) return false;
  const entry = { text: text, time: Date.now() };
  // Push to Firebase (gets push key + propagates to all clients via listener)
  if (window.firebaseDB) {
    try {
      window.firebaseDB.ref('comments/' + code).push(entry);
      return true;
    } catch (e) {
      console.warn('Firebase push failed, falling back to localStorage:', e);
    }
  }
  // Fallback — localStorage only
  if (!Array.isArray(commentsCache[code])) commentsCache[code] = [];
  commentsCache[code].push(entry);
  saveCachedComments(commentsCache);
  return true;
}

function removeComment(code, timeOrKey) {
  if (!code) return false;
  const arr = commentsCache[code] || [];
  const entry = arr.find(c => c.time === timeOrKey || c._key === timeOrKey);
  // Firebase removal (by push key, if we have it)
  if (window.firebaseDB && entry && entry._key) {
    try {
      window.firebaseDB.ref('comments/' + code + '/' + entry._key).remove();
      return true;
    } catch (e) {
      console.warn('Firebase remove failed, falling back to localStorage:', e);
    }
  }
  // Fallback
  const before = arr.length;
  commentsCache[code] = arr.filter(c => c.time !== timeOrKey);
  if (commentsCache[code].length === 0) delete commentsCache[code];
  saveCachedComments(commentsCache);
  return commentsCache[code] ? commentsCache[code].length < before : true;
}
function fmtCommentTime(ts) {
  try {
    const d = new Date(ts);
    const yy = String(d.getFullYear()).slice(2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yy}-${mm}-${dd} ${hh}:${mi}`;
  } catch { return ''; }
}

// Comment panel open state — keyed by part code
function loadCommentsOpenSet() {
  try {
    const raw = localStorage.getItem(LS_COMMENTS_OPEN_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}
function saveCommentsOpenSet(set) {
  try { localStorage.setItem(LS_COMMENTS_OPEN_KEY, JSON.stringify([...set])); }
  catch {}
}
function isCommentsOpen(code) { return loadCommentsOpenSet().has(code); }
function toggleCommentsOpen(code) {
  const set = loadCommentsOpenSet();
  if (set.has(code)) set.delete(code); else set.add(code);
  saveCommentsOpenSet(set);
}

// ──────────────────────────────────────────────────────────────────────
// Timers — per (project, part code). Workshop start/stop to track how
// long each part takes to bend. Multiple sessions accumulate.
//
// Schema in Firebase RTDB:
//   timers/<projectKey>/<partCode>:
//     active_start: epoch_ms  // null/missing when stopped
//     sessions/<pushId>: { start: epoch_ms, end: epoch_ms }
// ──────────────────────────────────────────────────────────────────────

let timersCache = {};   // synced from Firebase
let _tickInterval = null;

function loadCachedTimers() {
  try {
    const raw = localStorage.getItem(LS_TIMERS_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch { return {}; }
}
function saveCachedTimers(all) {
  try { localStorage.setItem(LS_TIMERS_KEY, JSON.stringify(all)); } catch {}
}
timersCache = loadCachedTimers();

function initTimersSync() {
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('timers').on('value', snapshot => {
      timersCache = snapshot.val() || {};
      saveCachedTimers(timersCache);
      _updateTickerState();
      try { render(); } catch {}
    }, err => console.warn('Firebase timers listener error:', err));
  } catch (e) {
    console.warn('Failed to attach timers listener:', e);
  }
}

function _getTimer(pk, code) {
  return (timersCache[pk] && timersCache[pk][code]) || {};
}
function isTimerRunning(pk, code) {
  return !!(_getTimer(pk, code).active_start);
}
function getTimerTotalSeconds(pk, code) {
  const t = _getTimer(pk, code);
  let total = 0;
  if (t.sessions) {
    for (const k in t.sessions) {
      const s = t.sessions[k];
      if (s && s.end && s.start) total += (s.end - s.start) / 1000;
    }
  }
  if (t.active_start) {
    total += (Date.now() - t.active_start) / 1000;
  }
  return Math.max(0, Math.round(total));
}

function formatDuration(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  if (seconds === 0) return '';
  if (seconds < 60) return seconds + 's';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

function startTimer(pk, code) {
  if (!pk || !code) return;
  if (!window.firebaseDB) {
    // localStorage-only fallback
    if (!timersCache[pk]) timersCache[pk] = {};
    if (!timersCache[pk][code]) timersCache[pk][code] = { sessions: {} };
    timersCache[pk][code].active_start = Date.now();
    saveCachedTimers(timersCache);
    _updateTickerState();
    render();
    return;
  }
  try {
    window.firebaseDB.ref(`timers/${pk}/${code}/active_start`).set(Date.now());
  } catch (e) { console.warn('startTimer failed:', e); }
}

function stopTimer(pk, code) {
  if (!pk || !code) return;
  const t = _getTimer(pk, code);
  if (!t.active_start) return;
  const session = { start: t.active_start, end: Date.now() };
  if (!window.firebaseDB) {
    if (!timersCache[pk]) timersCache[pk] = {};
    if (!timersCache[pk][code]) timersCache[pk][code] = { sessions: {} };
    if (!timersCache[pk][code].sessions) timersCache[pk][code].sessions = {};
    const localKey = 'local_' + session.end;
    timersCache[pk][code].sessions[localKey] = session;
    timersCache[pk][code].active_start = null;
    saveCachedTimers(timersCache);
    _updateTickerState();
    render();
    return;
  }
  try {
    window.firebaseDB.ref(`timers/${pk}/${code}/sessions`).push(session);
    window.firebaseDB.ref(`timers/${pk}/${code}/active_start`).set(null);
  } catch (e) { console.warn('stopTimer failed:', e); }
}

function resetTimer(pk, code, totalSeconds) {
  // Set timer to totalSeconds (0 = wipe everything). Stops any running session.
  if (!pk || !code) return;
  totalSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (!window.firebaseDB) {
    if (!timersCache[pk]) timersCache[pk] = {};
    timersCache[pk][code] = {
      active_start: null,
      sessions: {}
    };
    if (totalSeconds > 0) {
      const now = Date.now();
      timersCache[pk][code].sessions['manual_' + now] = {
        start: now - totalSeconds * 1000,
        end: now,
        manual: true
      };
    }
    saveCachedTimers(timersCache);
    _updateTickerState();
    render();
    return;
  }
  try {
    const updates = {};
    updates[`timers/${pk}/${code}/active_start`] = null;
    updates[`timers/${pk}/${code}/sessions`] = null;
    if (totalSeconds > 0) {
      const now = Date.now();
      const sessionKey = window.firebaseDB.ref(`timers/${pk}/${code}/sessions`).push().key;
      updates[`timers/${pk}/${code}/sessions/${sessionKey}`] = {
        start: now - totalSeconds * 1000,
        end: now,
        manual: true
      };
    }
    window.firebaseDB.ref().update(updates);
  } catch (e) { console.warn('resetTimer failed:', e); }
}

// ──────────────────────────────────────────────────────────────────────
// Soft-delete drawings — mark a part's drawing as "needs redo" without
// touching manifest.json (which is regenerated by Fusion). Firebase-synced
// so workshop + designer see same state. Auto-clears if manifest entry is
// updated AFTER the delete timestamp (e.g., user re-exports drawing).
//
// Schema in Firebase RTDB:
//   deleted_drawings/<partCode>: { time: epoch_ms, reason?: text }
// ──────────────────────────────────────────────────────────────────────

let deletedDrawingsCache = {};

function loadCachedDeleted() {
  try {
    const raw = localStorage.getItem(LS_DELETED_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch { return {}; }
}
function saveCachedDeleted(all) {
  try { localStorage.setItem(LS_DELETED_KEY, JSON.stringify(all)); } catch {}
}
deletedDrawingsCache = loadCachedDeleted();

function initDeletedDrawingsSync() {
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('deleted_drawings').on('value', snap => {
      deletedDrawingsCache = snap.val() || {};
      saveCachedDeleted(deletedDrawingsCache);
      try { render(); } catch {}
    }, err => console.warn('Firebase deleted_drawings listener error:', err));
  } catch (e) {
    console.warn('Failed to attach deleted_drawings listener:', e);
  }
}

function isDrawingSoftDeleted(code) {
  const del = deletedDrawingsCache[code];
  if (!del || !del.time) return false;
  // Auto-clear: if manifest entry has an "exported_at" newer than the
  // delete timestamp, treat as un-deleted (user re-exported a fresh one).
  const entry = (manifest && manifest.auto_generated && manifest.auto_generated[code]) || null;
  if (entry && entry.exported_at) {
    try {
      const expTime = new Date(entry.exported_at).getTime();
      if (expTime > del.time) return false;
    } catch {}
  }
  return true;
}

function softDeleteDrawing(code) {
  if (!code) return;
  const payload = { time: Date.now() };
  if (window.firebaseDB) {
    try {
      window.firebaseDB.ref('deleted_drawings/' + code).set(payload);
      return;
    } catch (e) { console.warn('softDelete failed:', e); }
  }
  deletedDrawingsCache[code] = payload;
  saveCachedDeleted(deletedDrawingsCache);
  render();
}

function restoreDrawing(code) {
  if (!code) return;
  if (window.firebaseDB) {
    try {
      window.firebaseDB.ref('deleted_drawings/' + code).remove();
      return;
    } catch (e) { console.warn('restore failed:', e); }
  }
  delete deletedDrawingsCache[code];
  saveCachedDeleted(deletedDrawingsCache);
  render();
}

function _updateTickerState() {
  // Start/stop the 1s tick interval based on whether any timer is running.
  let anyRunning = false;
  for (const pk in timersCache) {
    for (const code in (timersCache[pk] || {})) {
      if (timersCache[pk][code] && timersCache[pk][code].active_start) {
        anyRunning = true; break;
      }
    }
    if (anyRunning) break;
  }
  if (anyRunning && !_tickInterval) {
    _tickInterval = setInterval(() => {
      // Update only live-elapsed text nodes — no full re-render every second
      document.querySelectorAll('.timer-elapsed.running').forEach(el => {
        const pk = el.dataset.pk;
        const code = el.dataset.code;
        if (pk && code) el.textContent = formatDuration(getTimerTotalSeconds(pk, code));
      });
    }, 1000);
  } else if (!anyRunning && _tickInterval) {
    clearInterval(_tickInterval);
    _tickInterval = null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Data shaping
// ──────────────────────────────────────────────────────────────────────

function partsByFamily() {
  const out = {};
  const auto = manifest.auto_generated || {};
  for (const [code, entry] of Object.entries(auto)) {
    const fam = entry.family || 'Other';
    if (!out[fam]) out[fam] = [];
    out[fam].push({ code, ...entry });
  }
  for (const fam of Object.keys(out)) {
    out[fam].sort((a, b) => a.code.localeCompare(b.code));
  }
  const manual = manifest.manual_uploads || [];
  if (manual.length) {
    out['Custom'] = manual.map(u => ({
      code: u.caption || u.filename,
      filename: u.filename,
      isManual: true,
      added_at: u.added_at,
    }));
  }
  return out;
}

function projectList() {
  const projects = manifest.projects || {};
  const auto = manifest.auto_generated || {};
  const bentSet = loadBentSet();
  const items = Object.entries(projects).map(([key, p]) => {
    const parts = p.parts || [];
    // A part is "drawn" only if it has a manifest entry AND isn't soft-deleted.
    // Soft-deleted = workshop flagged "redo this drawing" (wrong title block etc.)
    const drawnCount = parts.filter(part => !!auto[part.code] && !isDrawingSoftDeleted(part.code)).length;
    const bentCount = parts.filter(part => bentSet.has(bentKey(key, part.code))).length;
    return {
      key,
      ...p,
      completed: isCompleted(key),
      drawn_count: drawnCount,
      missing_count: parts.length - drawnCount,
      bent_count: bentCount,
      bent_pct: parts.length ? Math.round((bentCount * 100) / parts.length) : 0,
    };
  });
  // Sort: active first by updated_at desc, then completed by updated_at desc
  items.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    const ta = a.updated_at || a.created_at || '';
    const tb = b.updated_at || b.created_at || '';
    return tb.localeCompare(ta);
  });
  return items;
}

// ──────────────────────────────────────────────────────────────────────
// Rendering — top-level dispatch
// ──────────────────────────────────────────────────────────────────────

function render() {
  if (stack.length === 0) {
    if (view === 'projects') return renderProjectsHome();
    if (view === 'missing')  return renderMissingHome();
    return renderLibraryHome();
  }
  const top = stack[stack.length - 1];
  if (top.kind === 'family') return renderFamily(top.name);
  if (top.kind === 'project') return renderProject(top.name);
}

function navTo(node) {
  stack.push(node);
  ROOT.classList.remove('transit-back');
  render();
  // Restart fade-in animation
  ROOT.style.animation = 'none';
  void ROOT.offsetWidth;
  ROOT.style.animation = '';
}

function navBack() {
  stack.pop();
  ROOT.classList.add('transit-back');
  render();
  ROOT.style.animation = 'none';
  void ROOT.offsetWidth;
  ROOT.style.animation = '';
}

// ──────────────────────────────────────────────────────────────────────
// Projects view
// ──────────────────────────────────────────────────────────────────────

function renderProjectsHome() {
  const items = projectList();

  if (!items.length) {
    ROOT.innerHTML = `
      <p class="loading">No projects yet<br><br>
      Open a project assembly in Fusion and run <code>CC_ProjectBOM</code></p>`;
    COUNT_EL.textContent = '';
    return;
  }

  const html = items.map((p, idx) => {
    const isTop = idx === 0 && !p.completed;
    const cls = [
      'project-card',
      p.completed ? 'completed' : '',
      isTop ? 'active-today' : '',
    ].filter(Boolean).join(' ');
    const statusBadge = p.completed
      ? '<span class="project-badge done">DONE</span>'
      : (isTop ? '<span class="project-badge">TODAY</span>' : '');
    const missing = p.missing_count;
    const drawingBadge = missing > 0
      ? `<span class="project-badge missing">⚠️ ${missing} no drawing</span>`
      : `<span class="project-badge complete">✓ all drawn</span>`;
    const updated = fmtDate(p.updated_at || p.created_at);
    const totalQty = p.total_qty != null ? p.total_qty : (p.parts || []).reduce((s, x) => s + (x.qty || 0), 0);
    const uniq = p.total_unique_parts != null ? p.total_unique_parts : (p.parts || []).length;
    const bentBadge = p.bent_count > 0
      ? `<span class="project-badge bent">🔨 ${p.bent_count}/${uniq} bent (${p.bent_pct}%)</span>`
      : '';
    const progressBar = `<div class="progress-bar"><div class="progress-fill" style="width:${p.bent_pct}%"></div></div>`;
    return `
      <div class="${cls}" data-project="${escapeHtml(p.key)}">
        <div class="project-name">${escapeHtml(p.name || p.key)}${statusBadge}</div>
        <div class="project-meta">${escapeHtml(updated)} · ${uniq} unique · ${totalQty} pcs · ${p.drawn_count}/${uniq} drawn</div>
        ${progressBar}
        <div class="project-badges">${drawingBadge}${bentBadge}</div>
      </div>`;
  }).join('');

  ROOT.innerHTML = `<div class="project-list">${html}</div>`;

  ROOT.querySelectorAll('.project-card').forEach(el => {
    el.addEventListener('click', () => navTo({ kind: 'project', name: el.dataset.project }));
  });

  COUNT_EL.textContent = `${items.length} projects · ${items.filter(p => !p.completed).length} active`;
}

function masterForCode(code, auto) {
  // Soft-deleted drawings: treat as if no master so the part falls into
  // the "(no drawing yet)" group (so workshop knows it needs redoing).
  if (isDrawingSoftDeleted(code)) return null;
  const entry = (auto || manifest.auto_generated || {})[code];
  if (!entry || !entry.pdf) return null;
  return entry.pdf.replace(/\.pdf$/i, '');
}

function groupPartsByMaster(parts, auto) {
  // Ordered map: master_name -> [parts] (insertion order from input parts)
  const groups = new Map();
  for (const p of parts) {
    const master = masterForCode(p.code, auto) || '(no drawing yet)';
    if (!groups.has(master)) groups.set(master, []);
    groups.get(master).push(p);
  }
  return groups;
}

const LS_COLLAPSED_KEY = 'kd_collapsed_groups_v1';

function loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem(LS_COLLAPSED_KEY)) || []); }
  catch { return new Set(); }
}
function saveCollapsed(set) {
  try { localStorage.setItem(LS_COLLAPSED_KEY, JSON.stringify([...set])); } catch {}
}

function renderBomRow(p, projectKey) {
  const fam = p.family || 'Other';
  const url = pdfUrlForCode(p.code);
  const hasDrawing = !!url;
  const bent = projectKey ? isBent(projectKey, p.code) : false;
  const comments = getComments(p.code);
  const cOpen = isCommentsOpen(p.code);
  const cBadgeHtml = comments.length > 0
    ? `<span class="comment-count">${comments.length}</span>`
    : '';
  const admin = isAdmin();
  const commentsPanel = cOpen ? `
    <div class="comments-panel" data-code="${escapeHtml(p.code)}">
      <ul class="comments-list">
        ${comments.length ? comments.map(c => `
          <li class="comment-item">
            <span class="comment-time">${escapeHtml(fmtCommentTime(c.time))}</span>
            <span class="comment-text">${escapeHtml(c.text)}</span>
            ${admin ? `<button class="comment-del" data-code="${escapeHtml(p.code)}" data-id="${escapeHtml(c._key || String(c.time))}" aria-label="Delete">✕</button>` : ''}
          </li>`).join('') : '<li class="comment-empty">No comments yet</li>'}
      </ul>
      <form class="comment-input-wrap" data-code="${escapeHtml(p.code)}">
        <input class="comment-input" type="text" placeholder="พิมพ์ comment / type a note…" autocomplete="off">
        <button type="submit" class="comment-add">+ Add</button>
      </form>
    </div>` : '';
  // Soft-delete state — entry in manifest BUT marked as needs-redo
  const hasManifestEntry = !!((manifest.auto_generated || {})[p.code]);
  const softDeleted = isDrawingSoftDeleted(p.code);
  // ✕ button — show only when drawing physically exists AND not soft-deleted (admin only)
  const deleteBtnHtml = (admin && hasManifestEntry && !softDeleted) ? `
    <button class="part-delete" data-code="${escapeHtml(p.code)}" aria-label="Mark drawing for redo" title="Mark drawing as needs redo (wrong title block etc.)">✕</button>
  ` : '';
  // ↻ restore button — show only when soft-deleted (so user can undo, admin only)
  const restoreBtnHtml = (admin && softDeleted) ? `
    <button class="part-restore" data-code="${escapeHtml(p.code)}" aria-label="Restore drawing" title="Undo delete — restore drawing">↻</button>
  ` : '';

  const tRunning = projectKey ? isTimerRunning(projectKey, p.code) : false;
  const tSeconds = projectKey ? getTimerTotalSeconds(projectKey, p.code) : 0;
  const tText = formatDuration(tSeconds);
  // Reset button shown when has any accumulated time (running or stopped) AND admin
  const showReset = projectKey && tSeconds > 0 && admin;
  const timerHtml = projectKey ? `
    <span class="timer-elapsed ${tRunning ? 'running' : ''}" data-pk="${escapeHtml(projectKey)}" data-code="${escapeHtml(p.code)}">${escapeHtml(tText)}</span>
    <button class="timer-btn ${tRunning ? 'running' : ''}" data-pk="${escapeHtml(projectKey)}" data-code="${escapeHtml(p.code)}" aria-label="${tRunning ? 'Stop' : 'Start'} timer" title="${tRunning ? 'Stop timer' : 'Start timer'}">${tRunning ? '⏸' : '▶'}</button>
    ${showReset ? `<button class="timer-reset" data-pk="${escapeHtml(projectKey)}" data-code="${escapeHtml(p.code)}" aria-label="Edit / Reset timer" title="Edit or reset timer">↻</button>` : ''}
  ` : '';
  return `
    <div class="bom-row ${bent ? 'bent' : ''} ${cOpen ? 'comments-open' : ''}" data-code="${escapeHtml(p.code)}" style="${famVars(fam)}">
      <div class="bom-row-main" data-url="${escapeHtml(url)}" data-has="${hasDrawing}">
        <span class="bom-icon">${familyIcon(fam)}</span>
        <span class="bom-code">${escapeHtml(p.code)}${softDeleted ? '<span class="part-deleted-tag">DEL</span>' : ''}</span>
        <span class="bom-qty">×${p.qty}</span>
        ${timerHtml}
        <button class="comment-btn ${comments.length ? 'has-comments' : ''}" data-code="${escapeHtml(p.code)}" aria-label="Comments" title="Comments">💬${cBadgeHtml}</button>
        ${deleteBtnHtml}
        ${restoreBtnHtml}
        <button class="bent-btn" data-code="${escapeHtml(p.code)}" aria-label="Toggle bent">${bent ? '✓' : '○'}</button>
      </div>
      ${commentsPanel}
    </div>`;
}

function renderProject(key) {
  const project = (manifest.projects || {})[key];
  if (!project) {
    ROOT.innerHTML = `<p class="loading">Project not found: ${escapeHtml(key)}</p>`;
    return;
  }
  const completed = isCompleted(key);
  const parts = project.parts || [];
  const auto = manifest.auto_generated || {};

  const top = stack[stack.length - 1] || {};
  const filter = top.filter || 'all';

  // "Missing" includes both: no manifest entry AND soft-deleted (flagged for redo)
  const isMissing = (p) => !auto[p.code] || isDrawingSoftDeleted(p.code);
  const visibleParts = filter === 'missing' ? parts.filter(isMissing) : parts;
  const missingCount = parts.filter(isMissing).length;

  // Group by source master file
  const groups = groupPartsByMaster(visibleParts, auto);
  const collapsed = loadCollapsed();

  const groupsHtml = [...groups.entries()].map(([master, items]) => {
    const groupId = `${key}::${master}`;
    const isCollapsed = collapsed.has(groupId);
    const totalQty = items.reduce((s, x) => s + (x.qty || 0), 0);
    const isOrphan = master === '(no drawing yet)';
    const rowsHtml = items.map(p => renderBomRow(p, key)).join('');
    return `
      <div class="master-group ${isCollapsed ? 'collapsed' : ''} ${isOrphan ? 'orphan' : ''}" data-group="${escapeHtml(groupId)}">
        <div class="master-header">
          <span class="master-toggle">▼</span>
          <span class="master-name">${escapeHtml(master)}</span>
          <span class="master-meta">${items.length} parts · ${totalQty} pcs</span>
        </div>
        <div class="master-rows">${rowsHtml}</div>
      </div>`;
  }).join('');

  const totalQtyAll = project.total_qty != null
    ? project.total_qty
    : parts.reduce((s, x) => s + (x.qty || 0), 0);

  const bentCount = bentCountForProject(key, parts);
  const bentPct = parts.length ? Math.round((bentCount * 100) / parts.length) : 0;

  ROOT.innerHTML = `
    <button class="back-btn">← Back</button>
    <h2 class="section-title">${escapeHtml(project.name || key)}<span class="count">${parts.length} unique · ${totalQtyAll} pcs · ${groups.size} masters</span></h2>
    <div class="bent-summary">
      <div class="bent-row">
        <span class="bent-label">🔨 Bending progress</span>
        <span class="bent-stat">${bentCount}/${parts.length} parts done · ${bentPct}%</span>
      </div>
      <div class="progress-bar large"><div class="progress-fill" style="width:${bentPct}%"></div></div>
    </div>
    <div class="project-actions">
      <button class="action-btn ${completed ? '' : 'danger'}" id="toggle-complete">
        ${completed ? '↺ Re-activate' : '✓ Mark Completed'}
      </button>
      <div class="filter-group">
        <button class="filter-btn ${filter === 'all' ? 'active' : ''}" data-filter="all">All (${parts.length})</button>
        <button class="filter-btn ${filter === 'missing' ? 'active' : ''}" data-filter="missing">⚠️ Missing (${missingCount})</button>
      </div>
      <button class="action-btn" id="toggle-all" data-state="collapsed"><span class="toggle-arrow">▶</span> <span class="toggle-label">Expand all</span></button>
    </div>
    <div class="master-list">${groupsHtml || '<p class="loading">All parts have drawings ✓</p>'}</div>
  `;

  ROOT.querySelector('.back-btn').addEventListener('click', navBack);
  ROOT.querySelector('#toggle-complete').addEventListener('click', () => {
    markCompleted(key, !completed);
    render();
  });
  ROOT.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      top.filter = btn.dataset.filter;
      render();
    });
  });

  // Master-group collapsible
  ROOT.querySelectorAll('.master-header').forEach(h => {
    h.addEventListener('click', () => {
      const group = h.parentElement;
      const id = group.dataset.group;
      const set = loadCollapsed();
      if (group.classList.contains('collapsed')) {
        group.classList.remove('collapsed');
        set.delete(id);
      } else {
        group.classList.add('collapsed');
        set.add(id);
      }
      saveCollapsed(set);
    });
  });

  // Single toggle button — expands all if any collapsed, otherwise collapses all
  const toggleBtn = ROOT.querySelector('#toggle-all');
  function refreshToggleLabel() {
    if (!toggleBtn) return;
    const groups = ROOT.querySelectorAll('.master-group');
    if (groups.length === 0) return;
    let anyCollapsed = false;
    groups.forEach(g => { if (g.classList.contains('collapsed')) anyCollapsed = true; });
    // If any group is collapsed → next click will expand → show ▶ Expand all
    // If all expanded → next click will collapse → show ▼ Collapse all
    if (anyCollapsed) {
      toggleBtn.dataset.state = 'collapsed';
      toggleBtn.querySelector('.toggle-arrow').textContent = '▶';
      toggleBtn.querySelector('.toggle-label').textContent = 'Expand all';
    } else {
      toggleBtn.dataset.state = 'expanded';
      toggleBtn.querySelector('.toggle-arrow').textContent = '▼';
      toggleBtn.querySelector('.toggle-label').textContent = 'Collapse all';
    }
  }
  refreshToggleLabel();
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const set = loadCollapsed();
      const isCurrentlyCollapsed = toggleBtn.dataset.state === 'collapsed';
      ROOT.querySelectorAll('.master-group').forEach(g => {
        if (isCurrentlyCollapsed) {
          g.classList.remove('collapsed');
          set.delete(g.dataset.group);
        } else {
          g.classList.add('collapsed');
          set.add(g.dataset.group);
        }
      });
      saveCollapsed(set);
      refreshToggleLabel();
    });
  }
  // Also refresh label when user toggles individual groups
  ROOT.querySelectorAll('.master-header').forEach(h => {
    h.addEventListener('click', () => setTimeout(refreshToggleLabel, 0));
  });

  ROOT.querySelectorAll('.bent-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const code = btn.dataset.code;
      markBent(key, code, !isBent(key, code));
      render();
    });
  });

  // Click bom-row-main → open PDF (don't trigger from comment panel area)
  ROOT.querySelectorAll('.bom-row-main').forEach(el => {
    el.addEventListener('click', (ev) => {
      // Don't open PDF if user clicked a button inside the row
      if (ev.target.closest('button')) return;
      if (el.dataset.has === 'true') window.open(el.dataset.url, '_blank', 'noopener');
    });
  });

  // Comment button → toggle panel + re-render
  ROOT.querySelectorAll('.comment-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleCommentsOpen(btn.dataset.code);
      render();  // re-render current view
    });
  });

  // Comment input form → submit adds comment
  ROOT.querySelectorAll('.comment-input-wrap').forEach(form => {
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const input = form.querySelector('.comment-input');
      const code = form.dataset.code;
      if (input && code && input.value.trim()) {
        addComment(code, input.value);
        input.value = '';
        render();
      }
    });
  });

  // Delete comment — id may be a Firebase push key (string) or epoch ms (number-as-string)
  ROOT.querySelectorAll('.comment-del').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const code = btn.dataset.code;
      const id = btn.dataset.id;
      if (code && id) {
        const asNum = Number(id);
        removeComment(code, !isNaN(asNum) && /^\d+$/.test(id) ? asNum : id);
        render();
      }
    });
  });

  // Timer Start/Stop button — toggle based on current state, sync to Firebase
  ROOT.querySelectorAll('.timer-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const pk = btn.dataset.pk;
      const code = btn.dataset.code;
      if (!pk || !code) return;
      if (isTimerRunning(pk, code)) {
        stopTimer(pk, code);
      } else {
        startTimer(pk, code);
      }
      // Firebase listener will re-render. For localStorage-only fallback,
      // start/stopTimer already calls render() itself.
    });
  });

  // Soft-delete drawing — mark for redo (e.g., wrong title block)
  ROOT.querySelectorAll('.part-delete').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const code = btn.dataset.code;
      if (!code) return;
      if (confirm(`Mark drawing "${code}" as needs redo?\n\nIt will move to "(no drawing yet)" group until re-exported with CC_DrawingPDFExport.`)) {
        softDeleteDrawing(code);
      }
    });
  });

  // Restore soft-deleted drawing — undo the delete
  ROOT.querySelectorAll('.part-restore').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const code = btn.dataset.code;
      if (!code) return;
      restoreDrawing(code);
    });
  });

  // Timer Reset / Edit button — prompt for new total time (0 = wipe)
  ROOT.querySelectorAll('.timer-reset').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const pk = btn.dataset.pk;
      const code = btn.dataset.code;
      if (!pk || !code) return;
      const cur = getTimerTotalSeconds(pk, code);
      const msg = `Edit / Reset timer\n\n` +
        `Current: ${formatDuration(cur) || '0s'}\n\n` +
        `Enter new total in seconds:\n` +
        `  0 (or empty) = reset to 0\n` +
        `  600 = 10 minutes\n` +
        `  3600 = 1 hour\n` +
        `  5400 = 1h 30m`;
      const input = prompt(msg, String(cur));
      if (input === null) return;  // user cancelled
      const n = parseInt(String(input).trim(), 10);
      if (isNaN(n)) {
        if (input.trim() === '') {
          resetTimer(pk, code, 0);
        } else {
          alert('Invalid input — must be a number of seconds');
        }
        return;
      }
      resetTimer(pk, code, n);
    });
  });
}

// ──────────────────────────────────────────────────────────────────────
// Tree view — full library hierarchy (ปู่ → พ่อ → ลูก → หลาน)
// Replaces the old flat Missing tab. Combines:
//   • manifest.auto_generated  — drawn parts (status: drawn / deleted)
//   • missingData.missing      — missing/stale masters
// Builds parent-child relations via wildcard prefix matching (0 / X
// positions in the 6-char prefix-before-dash). Renders as a nested
// indented list with expand/collapse + per-node action buttons.
// ──────────────────────────────────────────────────────────────────────

// ─── Hierarchy detection (also used by tree view) ──────────────────
// Stainless Kitchen naming rule (per user):
//   Parent/umbrella files use "0" or "X" at variant positions.
//   So if name A has "0" or "X" where B has a specific letter at the
//   same position, A is an ANCESTOR of B (parent or higher).
//
// Example:
//   DSB00X-... is ancestor of DSB0B0-... (0/X→B/0 ok, both wildcards)
//   DSB0B0-... is ancestor of DSB0BA-... (closer parent than DSB00X)
//   Tree: DSB00X → DSB0B0 → DSB0BA
//                → DSB0F0 → DSB0FA
//
// Closest-parent picked by highest "specificity" (fewest 0/X in prefix).

function _missingPrefix(name) {
  return (name || '').split('-')[0];
}

function _isAncestorPrefix(ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  if (ancestor.length !== descendant.length) return false;
  if (ancestor === descendant) return false;
  for (let i = 0; i < ancestor.length; i++) {
    if (ancestor[i] === descendant[i]) continue;
    if (ancestor[i] === '0' || ancestor[i] === 'X') continue; // wildcard
    return false;
  }
  return true;
}

function _specificity(prefix) {
  let n = 0;
  for (const c of prefix) if (c !== '0' && c !== 'X') n++;
  return n;
}

function buildMissingTree(entries) {
  const nodes = entries.map(e => ({
    ...e,
    _prefix: _missingPrefix(e.name),
    children: [],
    parent: null,
  }));
  for (const node of nodes) {
    let best = null, bestSpec = -1;
    for (const cand of nodes) {
      if (cand === node) continue;
      if (!_isAncestorPrefix(cand._prefix, node._prefix)) continue;
      const s = _specificity(cand._prefix);
      if (s > bestSpec) { bestSpec = s; best = cand; }
    }
    if (best) {
      node.parent = best;
      best.children.push(node);
    }
  }
  return nodes.filter(n => !n.parent);
}

// Radial mindmap navigation state — persisted across reloads so the
// user comes back to where they were. Two levels of state:
//   • radialFamily  — which family is selected (null = family overview)
//   • radialCenter  — which node is at the center (null = family-level
//                     mindmap with roots around). When set, this node
//                     becomes the center and its children radiate out.
const LS_RADIAL_STATE = 'kd_radial_state_v1';
let radialFamily = null;
let radialCenter = null;
(function _loadRadial() {
  try {
    const raw = localStorage.getItem(LS_RADIAL_STATE);
    if (raw) {
      const o = JSON.parse(raw);
      radialFamily = o.family || null;
      radialCenter = o.center || null;
    }
  } catch {}
})();
function saveRadialState() {
  try {
    localStorage.setItem(LS_RADIAL_STATE,
      JSON.stringify({ family: radialFamily, center: radialCenter }));
  } catch {}
}

// Filter toggle (all / missing only)
const LS_TREE_FILTER = 'kd_tree_filter_v1';
function getTreeFilter() {
  try { return localStorage.getItem(LS_TREE_FILTER) || 'all'; } catch { return 'all'; }
}
function setTreeFilter(v) {
  try { localStorage.setItem(LS_TREE_FILTER, v); } catch {}
}

// Per-mindmap drag overrides — each spoke can be dragged to a custom
// position; the offset (dx, dy) from the auto-computed location is
// persisted so the layout sticks across reloads + tab switches.
//
// Schema:
//   { "<centerKey>": { "<spokeCode>": { dx, dy }, ... }, ... }
//   centerKey = node.code when drilled in, or `family:<name>` at family level.
const LS_MINDMAP_POSITIONS = 'kd_mindmap_positions_v1';
function getPositionOverrides() {
  try { return JSON.parse(localStorage.getItem(LS_MINDMAP_POSITIONS) || '{}'); }
  catch { return {}; }
}
function savePositionOverrides(all) {
  try { localStorage.setItem(LS_MINDMAP_POSITIONS, JSON.stringify(all)); } catch {}
}
function setSpokeOverride(centerKey, spokeCode, dx, dy) {
  const all = getPositionOverrides();
  if (!all[centerKey]) all[centerKey] = {};
  all[centerKey][spokeCode] = { dx, dy };
  savePositionOverrides(all);
}
function clearOverridesForCenter(centerKey) {
  const all = getPositionOverrides();
  delete all[centerKey];
  savePositionOverrides(all);
}
function _centerKey(centerNode, currentFamily) {
  return centerNode ? centerNode.code : `family:${currentFamily}`;
}
function _svgPoint(svg, evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

// ─── Unified node list (manifest drawn parts + missing.json) ──────
// "Other" family is excluded — those are usually junk that the watcher
// picked up by mistake (logos, hybrid templates, test files, RD Logo,
// Beauty Panel, etc.). Kitchen parts always belong to a real family
// (Drawer / Back-Down / Floor / Top Sup / Side Panel / Beam / Cover).
function buildLibraryTreeNodes() {
  const nodes = new Map();
  const isJunkFamily = (f) => !f || f === 'Other';

  // Add drawn parts from manifest
  const auto = manifest.auto_generated || {};
  for (const [code, entry] of Object.entries(auto)) {
    const fam = entry.family;
    if (isJunkFamily(fam)) continue;  // skip Other / unknown
    const softDeleted = isDrawingSoftDeleted(code);
    nodes.set(code, {
      code,
      _prefix: code.split('-')[0],
      family: fam,
      pdf: entry.pdf,
      page: entry.page_number || 1,
      exported_at: entry.exported_at,
      status: softDeleted ? 'deleted' : 'drawn',
      urn: null,
      drawing_urn: null,
      open_url: null,
    });
  }

  // Overlay missing.json (missing / stale masters). Same Other-skip rule.
  if (missingData && Array.isArray(missingData.missing)) {
    for (const e of missingData.missing) {
      const fam = e.family;
      if (isJunkFamily(fam)) continue;  // skip Other / unknown
      const existing = nodes.get(e.name) || {};
      nodes.set(e.name, {
        ...existing,
        code: e.name,
        _prefix: e.name.split('-')[0],
        family: fam,
        status: e.status || 'missing',
        urn: e.urn,
        drawing_urn: e.drawing_urn,
        open_url: e.open_url,
        covers: e.covers || [],
        folder_name: e.folder_name,
        drawing_name: e.drawing_name,
      });
    }
  }

  return [...nodes.values()];
}

function buildLibraryTree() {
  const nodes = buildLibraryTreeNodes();
  for (const n of nodes) { n.children = []; n.parent = null; }
  for (const node of nodes) {
    let best = null, bestSpec = -1;
    for (const cand of nodes) {
      if (cand === node) continue;
      if (!_isAncestorPrefix(cand._prefix, node._prefix)) continue;
      const s = _specificity(cand._prefix);
      if (s > bestSpec) { bestSpec = s; best = cand; }
    }
    if (best) {
      node.parent = best;
      best.children.push(node);
    }
  }
  function sortKids(n) {
    n.children.sort((a, b) => a.code.localeCompare(b.code));
    n.children.forEach(sortKids);
  }
  const roots = nodes.filter(n => !n.parent);
  roots.sort((a, b) => {
    const fcmp = familyOrder(a.family || 'zz', b.family || 'zz');
    if (fcmp !== 0) return fcmp;
    return a.code.localeCompare(b.code);
  });
  roots.forEach(sortKids);
  return { roots, all: nodes };
}

// ─── Radial mindmap helpers ────────────────────────────────────────

function _findNodeByCode(roots, code) {
  for (const r of roots) {
    if (r.code === code) return r;
    const found = _findNodeByCode(r.children || [], code);
    if (found) return found;
  }
  return null;
}

function _statusBadgeChar(status) {
  return ({ drawn: '✓', missing: '⚠️', stale: '⏰', deleted: 'DEL' })[status] || '';
}
function _statusBadgeColor(status) {
  return ({
    drawn:   '#4dd06a',
    missing: '#f85149',
    stale:   '#ffc107',
    deleted: '#dc3545',
  })[status] || '#888';
}

// Decide what to do when user clicks a leaf (no children) node:
//   1. If has drawing → open PDF
//   2. Else if has urn → try Fusion bridge → fallback web
//   3. Else nothing
async function _doLeafAction(node) {
  const url = pdfUrlForCode(node.code);
  if (url) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  if (node.urn) {
    const openUrn = (node.status === 'stale' && node.drawing_urn) ? node.drawing_urn : node.urn;
    try {
      const r = await fetch(
        `http://127.0.0.1:8765/open?urn=${encodeURIComponent(openUrn)}`,
        { method: 'GET', mode: 'cors' });
      if (r.ok) return;
    } catch {}
    // Fallback — open web hub
    if (node.open_url) window.open(node.open_url, '_blank', 'noopener');
  }
}

// Card geometry — kept here so layout math + SVG renderer agree.
const SPOKE_CARD_W = 140;
const SPOKE_CARD_H = 40;
const SPOKE_CHORD_PADDING = 18;  // gap between adjacent cards along the ring

// Compute radial positions for N neighbors. Uses chord-based spacing
// (the real overlap constraint) instead of arc-based. Splits into 2
// rings when a single ring would force the radius to grow huge.
//
// Returns: [{ node, x, y, angle, ring }]
function _radialLayout(neighbors, cx, cy, baseR) {
  const n = neighbors.length;
  if (n === 0) return [];
  if (n === 1) {
    return [{ node: neighbors[0], x: cx, y: cy - baseR, angle: -Math.PI / 2, ring: 0 }];
  }
  const minChord = SPOKE_CARD_W + SPOKE_CHORD_PADDING;

  // Radius required for N evenly-spaced cards in a single ring to not overlap:
  //   chord = 2·r·sin(π/n) ≥ minChord  →  r ≥ minChord / (2·sin(π/n))
  const singleR = minChord / (2 * Math.sin(Math.PI / n));

  // Threshold: switch to 2 rings if single-ring radius is too large
  // (keeps the mindmap reasonably compact for many siblings).
  const SINGLE_RING_MAX = baseR * 1.8;
  if (singleR <= SINGLE_RING_MAX) {
    const r = Math.max(baseR, singleR);
    return neighbors.map((node, i) => {
      const angle = (2 * Math.PI * i / n) - Math.PI / 2;
      return {
        node,
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
        angle, ring: 0,
      };
    });
  }

  // Two-ring layout — split roughly in half. Outer ring rotated by
  // half-angle so cards interleave (don't sit directly on radial spokes
  // of inner cards, keeping the connector lines readable).
  const innerN = Math.ceil(n / 2);
  const outerN = n - innerN;
  const innerR = Math.max(baseR, minChord / (2 * Math.sin(Math.PI / Math.max(innerN, 2))));
  const ringGap = SPOKE_CARD_H + 24;
  const outerR = innerR + ringGap + SPOKE_CARD_H;

  const result = [];
  for (let i = 0; i < innerN; i++) {
    const angle = (2 * Math.PI * i / innerN) - Math.PI / 2;
    result.push({
      node: neighbors[i],
      x: cx + innerR * Math.cos(angle),
      y: cy + innerR * Math.sin(angle),
      angle, ring: 0,
    });
  }
  for (let i = 0; i < outerN; i++) {
    // Offset by half a slot to stagger outer ring between inner spokes
    const angle = (2 * Math.PI * i / outerN) - Math.PI / 2 + (Math.PI / outerN);
    result.push({
      node: neighbors[innerN + i],
      x: cx + outerR * Math.cos(angle),
      y: cy + outerR * Math.sin(angle),
      angle, ring: 1,
    });
  }
  return result;
}

// Build crumbs path: [ {kind: 'all'}, {kind: 'family', name}, {kind: 'node', code}, ... ]
function _buildBreadcrumb(currentNode, currentFamily) {
  const path = [{ kind: 'all', label: '🏠 Families' }];
  if (!currentNode && !currentFamily) return path;
  const fam = currentNode ? currentNode.family : currentFamily;
  path.push({ kind: 'family', label: fam, family: fam });
  if (!currentNode) return path;
  // Walk ancestors from root down to current
  const chain = [];
  let n = currentNode;
  while (n) { chain.unshift(n); n = n.parent; }
  for (let i = 0; i < chain.length; i++) {
    const node = chain[i];
    path.push({
      kind: i === chain.length - 1 ? 'current' : 'node',
      label: node.code,
      code: node.code,
    });
  }
  return path;
}

// ─── Family overview (top-level when no family selected) ──────────
function renderFamilyOverview(roots, all) {
  // Group by family + count statuses
  const byFam = new Map();
  for (const n of all) {
    const f = n.family;
    if (!f) continue;
    if (!byFam.has(f)) byFam.set(f, {
      roots: 0, drawn: 0, missing: 0, stale: 0, deleted: 0, total: 0,
      rootNodes: [],   // collected for the chip preview list
    });
    const s = byFam.get(f);
    s.total++;
    s[n.status] = (s[n.status] || 0) + 1;
  }
  // Collect roots per family (for the in-chip preview)
  for (const r of roots) {
    const f = r.family;
    if (byFam.has(f)) {
      byFam.get(f).roots++;
      byFam.get(f).rootNodes.push(r);
    }
  }
  const sortedFams = [...byFam.keys()].sort(familyOrder);

  const cards = sortedFams.map(fam => {
    const s = byFam.get(fam);
    // Preview list — top N parents (sorted by child count desc, then code).
    // Each row clickable → jumps directly into that parent's mindmap.
    const PREVIEW_MAX = 6;
    const previewParents = s.rootNodes.slice().sort((a, b) => {
      const ac = (a.children || []).length;
      const bc = (b.children || []).length;
      if (ac !== bc) return bc - ac;
      return a.code.localeCompare(b.code);
    });
    const shown = previewParents.slice(0, PREVIEW_MAX);
    const overflow = Math.max(0, previewParents.length - PREVIEW_MAX);
    const parentsHtml = shown.map(p => {
      const childN = (p.children || []).length;
      const stBadge = p.status === 'missing' ? '<span class="mfc-pp-st missing">⚠️</span>'
                    : p.status === 'stale'   ? '<span class="mfc-pp-st stale">⏰</span>'
                    : p.status === 'deleted' ? '<span class="mfc-pp-st deleted">DEL</span>'
                    : '<span class="mfc-pp-st drawn">✓</span>';
      const cnt = childN > 0 ? `<span class="mfc-pp-cnt">[${childN}]</span>` : '';
      return `<div class="mfc-pp-row" data-code="${escapeHtml(p.code)}">
        ${stBadge}<span class="mfc-pp-code">${escapeHtml(p.code)}</span>${cnt}
      </div>`;
    }).join('');
    const overflowHtml = overflow > 0
      ? `<div class="mfc-pp-more">+ ${overflow} more parent${overflow === 1 ? '' : 's'}</div>`
      : '';

    return `
      <div class="mindmap-family-card" data-family="${escapeHtml(fam)}" style="${famVars(fam)}">
        <div class="mfc-head">
          <div class="mfc-icon">${familyIcon(fam)}</div>
          <div class="mfc-name">${escapeHtml(fam)}</div>
          <div class="mfc-stats">${s.roots} roots · ${s.total} total</div>
          <div class="mfc-badges">
            ${s.drawn > 0   ? `<span class="mfc-badge drawn">✓ ${s.drawn}</span>` : ''}
            ${s.missing > 0 ? `<span class="mfc-badge missing">⚠️ ${s.missing}</span>` : ''}
            ${s.stale > 0   ? `<span class="mfc-badge stale">⏰ ${s.stale}</span>` : ''}
            ${s.deleted > 0 ? `<span class="mfc-badge deleted">DEL ${s.deleted}</span>` : ''}
          </div>
        </div>
        <div class="mfc-parents">
          <div class="mfc-pp-title">Parents (top ${shown.length})</div>
          ${parentsHtml}
          ${overflowHtml}
        </div>
      </div>`;
  }).join('');

  ROOT.innerHTML = `
    <p class="hint">🌳 <strong>Pick a family</strong> to open its mindmap, or click a parent below to jump in directly. Status: ✓ drawn · ⚠️ missing · ⏰ outdated · <span class="del-inline">DEL</span> needs redo</p>
    <div class="mindmap-family-grid">${cards}</div>
  `;

  // Card body → open family mindmap (legacy click target)
  ROOT.querySelectorAll('.mindmap-family-card').forEach(el => {
    el.addEventListener('click', (ev) => {
      // If a parent-row was clicked, that handler takes over (stopPropagation).
      radialFamily = el.dataset.family;
      radialCenter = null;
      saveRadialState();
      renderTreeHome();
    });
  });

  // Parent-row click → jump straight into THAT parent's mindmap
  ROOT.querySelectorAll('.mfc-pp-row').forEach(row => {
    row.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const code = row.dataset.code;
      const card = row.closest('.mindmap-family-card');
      radialFamily = card ? card.dataset.family : null;
      radialCenter = code;
      saveRadialState();
      renderTreeHome();
    });
  });

  COUNT_EL.textContent = `${all.length} parts across ${sortedFams.length} families`;
}

// ─── Radial mindmap renderer (family-center OR node-center) ───────
function renderRadialMindmap(roots) {
  let centerNode, centerLabel, neighbors, currentFamily;
  if (radialCenter) {
    centerNode = _findNodeByCode(roots, radialCenter);
    if (!centerNode) {
      // Lost reference — fall back to family level
      radialCenter = null;
      saveRadialState();
      return renderRadialMindmap(roots);
    }
    currentFamily = centerNode.family;
    centerLabel = centerNode.code;
    neighbors = centerNode.children || [];
  } else {
    // Family-level mindmap — family name in center, roots around
    currentFamily = radialFamily;
    centerLabel = radialFamily;
    centerNode = null;
    neighbors = roots.filter(r => r.family === radialFamily);
  }

  const breadcrumb = _buildBreadcrumb(centerNode, currentFamily);
  const fam = currentFamily || 'Other';

  // Compute SVG canvas + layout
  const baseR = 220;
  const positioned = _radialLayout(neighbors, 0, 0, baseR);

  // Apply user drag overrides (offsets from auto position) so a
  // hand-arranged mindmap survives reloads + tab switches.
  const centerKey = _centerKey(centerNode, currentFamily);
  const overrides = getPositionOverrides()[centerKey] || {};
  let hasAnyOverride = false;
  for (const p of positioned) {
    const ov = overrides[p.node.code];
    p._autoX = p.x;
    p._autoY = p.y;
    if (ov) {
      p.x += ov.dx;
      p.y += ov.dy;
      p._moved = true;
      hasAnyOverride = true;
    }
  }

  const maxR = positioned.length
    ? Math.max(...positioned.map(p => Math.hypot(p.x, p.y)))
    : baseR;
  // Padding = half card width + a little headroom for status/comment chips
  const padding = (SPOKE_CARD_W / 2) + 28;
  const half = maxR + padding;
  const W = 2 * half;
  const H = 2 * half;
  const cx = half, cy = half;

  // Translate positioned coords from (0,0)-relative to canvas-relative
  for (const p of positioned) {
    p.x += cx; p.y += cy;
    p._autoX += cx; p._autoY += cy;
  }

  // Edges (curves from center to each neighbor) — quadratic Bezier.
  // data-target wires each edge to its spoke so we can update the path
  // live during drag without re-rendering the whole SVG.
  const edges = positioned.map(p => {
    const mx = (cx + p.x) / 2, my = (cy + p.y) / 2;
    const dx = p.x - cx, dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const bulge = 22;
    const ctrlX = mx + nx * bulge;
    const ctrlY = my + ny * bulge;
    return `<path class="mm-edge" data-target="${escapeHtml(p.node.code)}" d="M ${cx} ${cy} Q ${ctrlX} ${ctrlY} ${p.x} ${p.y}" />`;
  }).join('');

  // Center node (big circle for family / rounded rect for node)
  let centerSvg;
  if (centerNode) {
    // Drilled into a specific node — show that node as center, plus an
    // "up arrow" affordance (click center → go up).
    centerSvg = `
      <g class="mm-center mm-center-node" transform="translate(${cx}, ${cy})">
        <rect x="-110" y="-36" width="220" height="72" rx="36"
              fill="var(--fam-color)" stroke="#fff" stroke-width="3" />
        <text class="mm-center-icon" text-anchor="middle" y="-6" font-size="14" fill="#fff" opacity="0.85">↑ click to go back</text>
        <text class="mm-center-label" text-anchor="middle" y="18" font-size="15" font-weight="700" fill="#fff">${escapeHtml(centerLabel)}</text>
      </g>`;
  } else {
    // Family center
    centerSvg = `
      <g class="mm-center mm-center-family" transform="translate(${cx}, ${cy})">
        <circle r="80" fill="var(--fam-color)" stroke="#fff" stroke-width="4" opacity="0.95" />
        <text text-anchor="middle" y="-6" font-size="22" fill="#fff">${familyIcon(fam).replace(/<[^>]+>/g, '')}</text>
        <text text-anchor="middle" y="22" font-size="14" font-weight="700" fill="#fff">${escapeHtml(centerLabel)}</text>
      </g>`;
  }

  // Spoke nodes — clickable cards
  const halfW = SPOKE_CARD_W / 2;     // 70
  const halfH = SPOKE_CARD_H / 2;     // 20
  const spokes = positioned.map(p => {
    const n = p.node;
    const hasChildren = n.children && n.children.length > 0;
    const badge = _statusBadgeChar(n.status);
    const badgeColor = _statusBadgeColor(n.status);
    const comments = getComments(n.code);
    const cBadge = comments.length
      ? `<g class="mm-mini-badge" transform="translate(${halfW - 10}, ${-halfH - 2})">
           <circle r="9" fill="#ffc107" />
           <text text-anchor="middle" dy="3" font-size="9" font-weight="700" fill="#000">${comments.length}</text>
         </g>` : '';
    const childCountBadge = hasChildren
      ? `<g class="mm-mini-badge" transform="translate(${-halfW + 10}, ${-halfH - 2})">
           <circle r="10" fill="#1f3450" stroke="#fff" stroke-width="1.5" />
           <text text-anchor="middle" dy="3" font-size="9" font-weight="700" fill="#fff">${n.children.length}</text>
         </g>` : '';
    const drillHint = hasChildren ? '▶' : (pdfUrlForCode(n.code) ? '📄' : (n.urn ? '↗' : ''));

    return `
      <g class="mm-spoke ${hasChildren ? 'has-children' : 'is-leaf'} ${p._moved ? 'moved' : ''}" data-code="${escapeHtml(n.code)}"
         transform="translate(${p.x}, ${p.y})" style="${famVars(n.family || fam)}">
        <rect x="${-halfW}" y="${-halfH}" width="${SPOKE_CARD_W}" height="${SPOKE_CARD_H}" rx="${halfH}"
              fill="var(--fam-tint)" stroke="var(--fam-color)" stroke-width="2"
              class="mm-spoke-bg" />
        <text class="mm-spoke-code" text-anchor="middle" dy="-3" font-size="10" font-weight="600" fill="#e4e4e4">${escapeHtml(n.code)}</text>
        <text class="mm-spoke-hint" text-anchor="middle" dy="10" font-size="8" fill="var(--fam-color)" opacity="0.8">${drillHint}</text>
        ${badge ? `<g transform="translate(${halfW - 14}, ${halfH - 4})">
            <rect x="-13" y="-6" width="26" height="12" rx="6" fill="${badgeColor}" />
            <text text-anchor="middle" dy="3" font-size="7" font-weight="700" fill="#fff">${badge}</text>
          </g>` : ''}
        ${childCountBadge}
        ${cBadge}
      </g>`;
  }).join('');

  const breadcrumbHtml = breadcrumb.map((b, i) => {
    const sep = i > 0 ? '<span class="mm-bc-sep">›</span>' : '';
    const cls = b.kind + (b.kind === 'current' ? ' current' : '');
    return `${sep}<span class="mm-bc-item ${cls}" data-kind="${b.kind}" data-code="${escapeHtml(b.code || '')}" data-family="${escapeHtml(b.family || '')}">${escapeHtml(b.label || '')}</span>`;
  }).join('');

  ROOT.innerHTML = `
    <div class="mindmap-wrapper" style="${famVars(fam)}">
      <div class="mindmap-breadcrumb">
        <div class="mm-bc-trail">${breadcrumbHtml}</div>
        ${hasAnyOverride ? `<button class="mm-reset-layout" id="mm-reset-layout" title="Restore auto-positions for this view">↻ Reset layout</button>` : ''}
      </div>
      <div class="mindmap-canvas">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="mindmap-svg">
          ${edges}
          ${centerSvg}
          ${spokes}
        </svg>
      </div>
      <p class="hint">
        Click a node with ▶ → drill down · leaf (📄/↗) → open PDF/Fusion · click center → go up 1 level
        · <strong>drag any node to move it</strong> (position is saved per view)
        ${neighbors.length === 0 ? '<br><strong>⚠️ No children here</strong> — click center to go back' : ''}
      </p>
    </div>
  `;

  COUNT_EL.textContent = `${neighbors.length} ${neighbors.length === 1 ? 'child' : 'children'} of ${centerLabel}`;

  // Wire breadcrumb
  ROOT.querySelectorAll('.mm-bc-item').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const kind = el.dataset.kind;
      if (kind === 'all') {
        radialFamily = null;
        radialCenter = null;
      } else if (kind === 'family') {
        radialFamily = el.dataset.family;
        radialCenter = null;
      } else if (kind === 'node') {
        radialCenter = el.dataset.code;
      } else { return; }  // 'current' = no-op
      saveRadialState();
      renderTreeHome();
    });
  });

  // Wire center node — go up 1 level (parent or family)
  ROOT.querySelector('.mm-center')?.addEventListener('click', () => {
    if (centerNode) {
      // Go to parent, or back to family level
      if (centerNode.parent) {
        radialCenter = centerNode.parent.code;
      } else {
        radialCenter = null;  // back to family
      }
    } else {
      // We're at family level — back to family overview
      radialFamily = null;
    }
    saveRadialState();
    renderTreeHome();
  });

  // Wire Reset layout button
  ROOT.querySelector('#mm-reset-layout')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (confirm('Restore auto-layout for this view?\n(Custom positions will be lost — other views are not affected.)')) {
      clearOverridesForCenter(centerKey);
      renderTreeHome();
    }
  });

  // ─── Drag-and-click handling for spoke nodes ─────────────────────
  // Use document-level pointermove/pointerup listeners (rather than
  // setPointerCapture on the SVG <g>) for cross-browser reliability —
  // setPointerCapture on SVG elements has uneven support, while
  // document-level listeners work everywhere.
  const svgEl = ROOT.querySelector('.mindmap-svg');
  let activeDrag = null;

  function onDragMove(ev) {
    if (!activeDrag || ev.pointerId !== activeDrag.pointerId) return;
    ev.preventDefault();
    const pt = _svgPoint(svgEl, ev);
    const dx = pt.x - activeDrag.startSvgX;
    const dy = pt.y - activeDrag.startSvgY;
    if (!activeDrag.moved && Math.hypot(dx, dy) > 4) {
      activeDrag.moved = true;
      activeDrag.spoke.classList.add('dragging');
    }
    if (activeDrag.moved) {
      const nx = activeDrag.curX + dx;
      const ny = activeDrag.curY + dy;
      activeDrag.spoke.setAttribute('transform', `translate(${nx}, ${ny})`);
      // Live-update connector edge
      const edge = svgEl.querySelector(`.mm-edge[data-target="${CSS.escape(activeDrag.code)}"]`);
      if (edge) {
        const mx = (cx + nx) / 2, my = (cy + ny) / 2;
        const ddx = nx - cx, ddy = ny - cy;
        const len = Math.hypot(ddx, ddy) || 1;
        const bx = -ddy / len * 22, by = ddx / len * 22;
        edge.setAttribute('d', `M ${cx} ${cy} Q ${mx + bx} ${my + by} ${nx} ${ny}`);
      }
    }
  }

  function onDragEnd(ev) {
    if (!activeDrag || ev.pointerId !== activeDrag.pointerId) return;
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', onDragEnd);
    document.removeEventListener('pointercancel', onDragEnd);
    const drag = activeDrag;
    activeDrag = null;
    drag.spoke.classList.remove('dragging');
    if (drag.moved) {
      const pt = _svgPoint(svgEl, ev);
      const dx = pt.x - drag.startSvgX;
      const dy = pt.y - drag.startSvgY;
      const finalX = drag.curX + dx;
      const finalY = drag.curY + dy;
      const dxFromAuto = finalX - drag.positionedNode._autoX;
      const dyFromAuto = finalY - drag.positionedNode._autoY;
      setSpokeOverride(centerKey, drag.code, dxFromAuto, dyFromAuto);
      drag.positionedNode.x = finalX;
      drag.positionedNode.y = finalY;
      drag.spoke.classList.add('moved');
      if (!hasAnyOverride) renderTreeHome();
    } else {
      // Click — drill in or leaf action
      const node = _findNodeByCode(roots, drag.code);
      if (node) {
        if (node.children && node.children.length > 0) {
          radialCenter = drag.code;
          saveRadialState();
          renderTreeHome();
        } else {
          _doLeafAction(node);
        }
      }
    }
  }

  ROOT.querySelectorAll('.mm-spoke').forEach(spoke => {
    const code = spoke.dataset.code;
    const positionedNode = positioned.find(pp => pp.node.code === code);
    if (!positionedNode) return;

    spoke.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      // Prevent text selection + iOS callout
      ev.preventDefault();
      ev.stopPropagation();
      const pt = _svgPoint(svgEl, ev);
      activeDrag = {
        spoke,
        code,
        positionedNode,
        startSvgX: pt.x,
        startSvgY: pt.y,
        curX: positionedNode.x,
        curY: positionedNode.y,
        moved: false,
        pointerId: ev.pointerId,
      };
      document.addEventListener('pointermove', onDragMove);
      document.addEventListener('pointerup', onDragEnd);
      document.addEventListener('pointercancel', onDragEnd);
    });
  });
}

// ─── Main tree-tab dispatcher ──────────────────────────────────────
function renderTreeHome() {
  if (!manifest || (!manifest.auto_generated && !missingData)) {
    ROOT.innerHTML = `
      <div class="empty-state">
        <h2>🌳 No data yet</h2>
        <p>Run <code>CC_DrawingPDFExport</code> + <code>CC_ScanMissingDrawings</code> in Fusion</p>
      </div>`;
    COUNT_EL.textContent = '';
    return;
  }

  const { roots, all } = buildLibraryTree();
  if (!roots.length) {
    ROOT.innerHTML = `
      <div class="empty-state">
        <h2>🌳 Tree is empty</h2>
        <p>No kitchen parts found</p>
      </div>`;
    COUNT_EL.textContent = '';
    return;
  }

  if (!radialFamily) {
    return renderFamilyOverview(roots, all);
  }
  return renderRadialMindmap(roots);
}

// Legacy alias so older callsites (render() dispatch) keep working.
const renderMissingHome = renderTreeHome;

// ──────────────────────────────────────────────────────────────────────
// Library view (existing — family grid + drill-down)
// ──────────────────────────────────────────────────────────────────────

function renderLibraryHome() {
  const by = partsByFamily();
  const visible = Object.keys(by).filter(f => by[f].length).sort(familyOrder);

  if (!visible.length) {
    ROOT.innerHTML = '<p class="loading">No drawings yet — run CC_DrawingPDFExport in Fusion first</p>';
    COUNT_EL.textContent = '';
    return;
  }

  const cards = visible.map(fam => `
    <div class="family-card" data-family="${escapeHtml(fam)}" style="${famVars(fam)}">
      <div class="family-icon">${familyIcon(fam)}</div>
      <div class="family-name">${escapeHtml(fam)}</div>
      <div class="family-count">${by[fam].length} parts</div>
    </div>
  `).join('');

  ROOT.innerHTML = `<div class="family-grid">${cards}</div>`;

  ROOT.querySelectorAll('.family-card').forEach(el => {
    el.addEventListener('click', () => navTo({ kind: 'family', name: el.dataset.family }));
  });

  const total = Object.values(by).reduce((s, arr) => s + arr.length, 0);
  COUNT_EL.textContent = `${visible.length} families · ${total} parts`;
}

function renderFamily(fam) {
  const items = partsByFamily()[fam] || [];
  const list = items.map(p => {
    const url = pdfUrl(p);
    const ver = p.isManual ? '' :
      (p.last_drawn_version > 0 ? `<span class="part-version">v${p.last_drawn_version}</span>` : '');
    return `
      <div class="part-row" data-url="${escapeHtml(url)}" style="${famVars(fam)}">
        <span class="part-icon">${familyIcon(fam)}</span>
        <span class="part-code">${escapeHtml(p.code)}</span>
        ${ver}
      </div>`;
  }).join('');

  ROOT.innerHTML = `
    <button class="back-btn">← Back</button>
    <h2 class="section-title" style="${famVars(fam)};color:var(--fam-color)">${familyIcon(fam)} ${escapeHtml(fam)}<span class="count">${items.length} parts</span></h2>
    <div class="part-list">${list}</div>
  `;

  ROOT.querySelector('.back-btn').addEventListener('click', navBack);
  ROOT.querySelectorAll('.part-row').forEach(el => {
    el.addEventListener('click', () => window.open(el.dataset.url, '_blank', 'noopener'));
  });
}

// ──────────────────────────────────────────────────────────────────────
// Search
// ──────────────────────────────────────────────────────────────────────

function renderSearch(q) {
  const matches = [];
  if (view === 'library') {
    const by = partsByFamily();
    for (const [fam, items] of Object.entries(by)) {
      for (const p of items) {
        const haystack = (p.code + ' ' + (p.caption || '') + ' ' + fam).toLowerCase();
        if (haystack.includes(q)) matches.push({ kind: 'part', _family: fam, ...p });
      }
    }
  } else {
    const projects = projectList();
    for (const p of projects) {
      if ((p.name || '').toLowerCase().includes(q) || (p.key || '').toLowerCase().includes(q)) {
        matches.push({ kind: 'project', ...p });
      }
      for (const part of (p.parts || [])) {
        if (part.code.toLowerCase().includes(q)) {
          matches.push({ kind: 'project-part', project: p, part });
        }
      }
    }
  }

  if (!matches.length) {
    ROOT.innerHTML = `<p class="loading">No results for "${escapeHtml(q)}"</p>`;
    COUNT_EL.textContent = '0 results';
    return;
  }

  const rows = matches.map(m => {
    if (m.kind === 'part') {
      const url = pdfUrl(m);
      const ver = m.isManual ? '' : (m.last_drawn_version > 0 ? `<span class="part-version">v${m.last_drawn_version}</span>` : '');
      return `
        <div class="search-row" data-url="${escapeHtml(url)}">
          <div class="row-top">
            <span class="part-code">${escapeHtml(m.code)}</span>
            ${ver}
          </div>
          <div class="row-fam">${familyIcon(m._family)} ${escapeHtml(m._family)}</div>
        </div>`;
    }
    if (m.kind === 'project') {
      return `
        <div class="search-row" data-project="${escapeHtml(m.key)}">
          <div class="row-top">
            <span class="part-code">📋 ${escapeHtml(m.name)}</span>
          </div>
          <div class="row-fam">${(m.parts || []).length} unique parts</div>
        </div>`;
    }
    // project-part
    const url = pdfUrlForCode(m.part.code);
    return `
      <div class="search-row" data-url="${escapeHtml(url)}">
        <div class="row-top">
          <span class="part-code">${escapeHtml(m.part.code)} ×${m.part.qty}</span>
        </div>
        <div class="row-fam">📋 ${escapeHtml(m.project.name)} · ${familyIcon(m.part.family)} ${escapeHtml(m.part.family || '')}</div>
      </div>`;
  }).join('');

  ROOT.innerHTML = rows;
  ROOT.querySelectorAll('.search-row').forEach(el => {
    const url = el.dataset.url;
    const project = el.dataset.project;
    el.addEventListener('click', () => {
      if (project) {
        SEARCH.value = '';
        stack = [{ kind: 'project', name: project }];
        render();
      } else if (url) {
        window.open(url, '_blank', 'noopener');
      }
    });
  });
  COUNT_EL.textContent = `${matches.length} results`;
}

// ──────────────────────────────────────────────────────────────────────
// Tab switching
// ──────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.view;
    if (v === view) {
      // Same-tab click — for Tree tab, reset radial state (escape hatch
      // when stuck deep in a mindmap)
      if (v === 'missing') {
        radialFamily = null;
        radialCenter = null;
        saveRadialState();
        render();
      }
      return;
    }
    view = v;
    stack = [];
    SEARCH.value = '';
    updateSearchClear();
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    SEARCH.placeholder =
      view === 'projects' ? 'Search project or part…' :
      view === 'missing'  ? 'Search part code in tree…' :
                            'Search part code…';
    render();
  });
});

// Update Tree tab badge with count of items needing work (missing + stale + DEL).
// Counts from the unified tree node list, not just missing.json.
function updateMissingBadge() {
  const badge = document.getElementById('missing-badge');
  if (!badge) return;
  let n = 0;
  try {
    if (manifest) {
      const { all } = buildLibraryTree();
      n = all.filter(node => node.status === 'missing' || node.status === 'stale' || node.status === 'deleted').length;
    }
  } catch {}
  if (n > 0) {
    badge.textContent = String(n);
    badge.style.display = '';
  } else {
    badge.textContent = '';
    badge.style.display = 'none';
  }
}

// ──────────────────────────────────────────────────────────────────────
// Search input
// ──────────────────────────────────────────────────────────────────────

function updateSearchClear() {
  SEARCH_CLEAR.classList.toggle('visible', SEARCH.value.length > 0);
}

SEARCH.addEventListener('input', () => {
  updateSearchClear();
  const raw = SEARCH.value.trim();
  const q = raw.toLowerCase();
  // Admin toggle via magic words in the search box
  if (q === ':admin' || q === ':admin on' || q === ':admin 1') {
    setAdmin(true);
    SEARCH.value = '';
    updateSearchClear();
    render();
    return;
  }
  if (q === ':admin off' || q === ':admin 0') {
    setAdmin(false);
    SEARCH.value = '';
    updateSearchClear();
    render();
    return;
  }
  if (!q) {
    render();
    return;
  }
  renderSearch(q);
});

SEARCH_CLEAR.addEventListener('click', () => {
  SEARCH.value = '';
  updateSearchClear();
  SEARCH.focus();
  render();
});

// ──────────────────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────────────────

async function init() {
  // Show admin badge if this device was previously toggled into admin mode.
  updateAdminBadge();

  // Connect to Firebase Realtime DB for shared comments + timers + soft-
  // deleted drawings (real-time sync across devices). Falls back to
  // localStorage if Firebase unavailable.
  initCommentsSync();
  initTimersSync();
  initDeletedDrawingsSync();

  try {
    const [m, f] = await Promise.all([
      fetchJson(window.APP_CONFIG.MANIFEST_URL),
      fetchJson('families.json'),
    ]);
    manifest = m;
    families = f;
    UPDATED.textContent = fmtDate(manifest.generated_at);

    // Load missing.json (optional — silently absent until first scan).
    // missing.json lives next to manifest.json in the Drawings/ folder.
    try {
      const mu = window.APP_CONFIG.MANIFEST_URL || 'Drawings/manifest.json';
      const missingPath = mu.replace(/[^/]+$/, 'missing.json');
      missingData = await fetchJson(missingPath);
    } catch (e) {
      missingData = null;
    }
    // Rewrite family names (Drawer split, Back-Down → DW-BK, Floor → DW-FL)
    // so everything downstream sees only the new names.
    applyFamilyRemap();
    updateMissingBadge();

    // If no projects yet, default to Library view
    const hasProjects = manifest.projects && Object.keys(manifest.projects).length > 0;
    if (!hasProjects) {
      view = 'library';
      document.getElementById('tab-projects').classList.remove('active');
      document.getElementById('tab-library').classList.add('active');
    }

    render();
  } catch (e) {
    ROOT.innerHTML = `<div class="error">Failed to load data: ${escapeHtml(e.message)}<br><br>Check MANIFEST_URL in config.js</div>`;
  }
}

init();
