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
      const msg = `แก้เวลา / Reset\n\n` +
        `ปัจจุบัน (current): ${formatDuration(cur) || '0s'}\n\n` +
        `พิมพ์เวลาใหม่เป็น "วินาที" (seconds):\n` +
        `• 0 หรือว่าง = reset เป็น 0\n` +
        `• 600 = 10 นาที\n` +
        `• 3600 = 1 ชั่วโมง\n` +
        `• 5400 = 1h 30m`;
      const input = prompt(msg, String(cur));
      if (input === null) return;  // user cancelled
      const n = parseInt(String(input).trim(), 10);
      if (isNaN(n)) {
        if (input.trim() === '') {
          resetTimer(pk, code, 0);
        } else {
          alert('ค่าไม่ถูกต้อง / Invalid input');
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

// Persisted expanded-node state (which tree nodes have their children shown)
const LS_TREE_EXPANDED = 'kd_tree_expanded_v1';
function getTreeExpandedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(LS_TREE_EXPANDED) || '[]')); }
  catch { return new Set(); }
}
function saveTreeExpandedSet(set) {
  try { localStorage.setItem(LS_TREE_EXPANDED, JSON.stringify([...set])); } catch {}
}

// Filter toggle (all / missing only)
const LS_TREE_FILTER = 'kd_tree_filter_v1';
function getTreeFilter() {
  try { return localStorage.getItem(LS_TREE_FILTER) || 'all'; } catch { return 'all'; }
}
function setTreeFilter(v) {
  try { localStorage.setItem(LS_TREE_FILTER, v); } catch {}
}

// ─── Unified node list (manifest drawn parts + missing.json) ──────
function buildLibraryTreeNodes() {
  const nodes = new Map();

  // Add drawn parts from manifest
  const auto = manifest.auto_generated || {};
  for (const [code, entry] of Object.entries(auto)) {
    const softDeleted = isDrawingSoftDeleted(code);
    nodes.set(code, {
      code,
      _prefix: code.split('-')[0],
      family: entry.family || 'Other',
      pdf: entry.pdf,
      page: entry.page_number || 1,
      exported_at: entry.exported_at,
      status: softDeleted ? 'deleted' : 'drawn',
      urn: null,
      drawing_urn: null,
      open_url: null,
    });
  }

  // Overlay missing.json (missing / stale masters). For 'stale', keep the
  // existing 'drawn' status info but mark status='stale' so user sees it.
  if (missingData && Array.isArray(missingData.missing)) {
    for (const e of missingData.missing) {
      const existing = nodes.get(e.name) || {};
      nodes.set(e.name, {
        ...existing,
        code: e.name,
        _prefix: e.name.split('-')[0],
        family: e.family || existing.family || 'Other',
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

// ─── Tree node renderer (recursive) ────────────────────────────────
function renderTreeNode(node, depth, expanded, filterMode) {
  // Skip filter: if 'missing' filter active and this subtree has no missing
  // descendants AND this node itself is not missing/stale → hide entirely.
  if (filterMode === 'missing') {
    const hasMissingInSubtree = (n) =>
      n.status === 'missing' || n.status === 'stale' ||
      (n.children && n.children.some(hasMissingInSubtree));
    if (!hasMissingInSubtree(node)) return '';
  }

  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = expanded.has(node.code);
  const fam = node.family || 'Other';
  const url = pdfUrlForCode(node.code);
  const hasDrawing = !!url;

  // Status badge
  const statusInfo = {
    drawn: { cls: 'drawn', text: '✓', title: 'Drawing exists' },
    missing: { cls: 'missing', text: '⚠️', title: 'No drawing yet' },
    stale: { cls: 'stale', text: '⏰', title: 'Master saved after drawing — outdated' },
    deleted: { cls: 'deleted', text: 'DEL', title: 'Soft-deleted — needs redo' },
  }[node.status || 'missing'] || { cls: '', text: '', title: '' };
  const statusBadge = statusInfo.text
    ? `<span class="tree-status ${statusInfo.cls}" title="${escapeHtml(statusInfo.title)}">${statusInfo.text}</span>`
    : '';

  // Comments + bent badges
  const comments = getComments(node.code);
  const commentBadge = comments.length
    ? `<span class="tree-meta-badge comments" title="${comments.length} comment(s)">💬${comments.length}</span>`
    : '';

  // Action buttons
  const buttons = [];
  if (hasDrawing) {
    buttons.push(`<button class="tree-btn open-pdf" data-url="${escapeHtml(url)}" title="Open PDF drawing" aria-label="Open PDF">📄</button>`);
  }
  if (node.urn) {
    const openUrn = (node.status === 'stale' && node.drawing_urn) ? node.drawing_urn : node.urn;
    const openTitle = node.status === 'stale'
      ? `Open drawing "${node.drawing_name || ''}" to re-export`
      : `Open master "${node.code}" in Fusion`;
    buttons.push(`<button class="tree-btn open-fusion" data-urn="${escapeHtml(openUrn)}" data-weburl="${escapeHtml(node.open_url || '#')}" title="${escapeHtml(openTitle)}" aria-label="Open in Fusion">↗</button>`);
  }

  const toggler = hasChildren
    ? `<button class="tree-toggle ${isExpanded ? 'open' : ''}" data-code="${escapeHtml(node.code)}" aria-label="Toggle">${isExpanded ? '▼' : '▶'}</button>`
    : `<span class="tree-toggle-spacer"></span>`;
  const childrenCount = hasChildren
    ? `<span class="tree-children-count">${node.children.length}</span>` : '';

  // Recursive children rendering
  const childrenHtml = (isExpanded && hasChildren)
    ? `<div class="tree-children">${node.children.map(c => renderTreeNode(c, depth + 1, expanded, filterMode)).join('')}</div>`
    : '';

  return `
    <div class="tree-node depth-${depth}" data-code="${escapeHtml(node.code)}" style="${famVars(fam)}; --depth: ${depth};">
      <div class="tree-node-row">
        ${toggler}
        <span class="tree-icon">${familyIcon(fam)}</span>
        <span class="tree-code">${escapeHtml(node.code)}</span>
        ${statusBadge}
        ${childrenCount}
        ${commentBadge}
        ${buttons.join('')}
      </div>
      ${childrenHtml}
    </div>`;
}

function renderTreeHome() {
  // Empty state — no data yet
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
        <p>No parts found in manifest or missing data</p>
      </div>`;
    COUNT_EL.textContent = '';
    return;
  }

  const expanded = getTreeExpandedSet();
  const filterMode = getTreeFilter();

  // Group roots by family for headers (keeps the family-color cue)
  const byFam = new Map();
  for (const r of roots) {
    const f = r.family || 'Other';
    if (!byFam.has(f)) byFam.set(f, []);
    byFam.get(f).push(r);
  }
  const sortedFams = [...byFam.keys()].sort(familyOrder);

  const famsHtml = sortedFams.map(fam => {
    const rs = byFam.get(fam);
    const rendered = rs.map(r => renderTreeNode(r, 0, expanded, filterMode)).filter(s => s).join('');
    if (!rendered) return '';  // entire family filtered out
    return `
      <div class="tree-family" style="${famVars(fam)}">
        <h3 class="tree-family-title" style="color:var(--fam-color)">
          ${familyIcon(fam)} ${escapeHtml(fam)}
          <span class="tree-family-count">${rs.length} ${rs.length === 1 ? 'root' : 'roots'}</span>
        </h3>
        ${rendered}
      </div>`;
  }).filter(s => s).join('');

  // Count statuses
  const counts = { drawn: 0, missing: 0, stale: 0, deleted: 0 };
  for (const n of all) counts[n.status] = (counts[n.status] || 0) + 1;

  ROOT.innerHTML = `
    <div class="tree-toolbar">
      <div class="tree-filter-group">
        <button class="filter-btn ${filterMode === 'all' ? 'active' : ''}" data-filter="all">All (${all.length})</button>
        <button class="filter-btn ${filterMode === 'missing' ? 'active' : ''}" data-filter="missing">⚠️ Missing only (${counts.missing + counts.stale})</button>
      </div>
      <div class="tree-actions">
        <button class="action-btn" id="tree-expand-all">▼ Expand all</button>
        <button class="action-btn" id="tree-collapse-all">▶ Collapse all</button>
      </div>
    </div>
    <p class="hint">🌳 <strong>Hierarchy:</strong> ปู่ → พ่อ → ลูก → หลาน via wildcard prefix (0/X). Click ▶ to expand.
    Status: ✓ drawn · ⚠️ missing · ⏰ outdated · <span class="del-inline">DEL</span> needs redo</p>
    <div class="tree-content">${famsHtml || '<p class="loading">No nodes match the current filter</p>'}</div>
  `;

  COUNT_EL.textContent = `${all.length} parts · ${counts.drawn} drawn · ${counts.missing + counts.stale} need work${counts.deleted ? ` · ${counts.deleted} DEL` : ''}`;

  // Wire filter buttons
  ROOT.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setTreeFilter(btn.dataset.filter);
      renderTreeHome();
    });
  });

  // Wire expand/collapse togglers
  ROOT.querySelectorAll('.tree-toggle').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const code = btn.dataset.code;
      const set = getTreeExpandedSet();
      if (set.has(code)) set.delete(code); else set.add(code);
      saveTreeExpandedSet(set);
      renderTreeHome();
    });
  });

  // Expand all / Collapse all
  ROOT.querySelector('#tree-expand-all').addEventListener('click', () => {
    const allCodes = [];
    function collect(nodes) {
      for (const n of nodes) {
        if (n.children && n.children.length) {
          allCodes.push(n.code);
          collect(n.children);
        }
      }
    }
    collect(roots);
    saveTreeExpandedSet(new Set(allCodes));
    renderTreeHome();
  });
  ROOT.querySelector('#tree-collapse-all').addEventListener('click', () => {
    saveTreeExpandedSet(new Set());
    renderTreeHome();
  });

  // Wire Open PDF buttons
  ROOT.querySelectorAll('.open-pdf').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const url = btn.dataset.url;
      if (url) window.open(url, '_blank', 'noopener');
    });
  });

  // Wire Open in Fusion (localhost bridge → fallback to web hub)
  ROOT.querySelectorAll('.open-fusion').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const urn = btn.dataset.urn;
      const webUrl = btn.dataset.weburl;
      if (!urn) return;
      const original = btn.textContent;
      btn.textContent = '...';
      btn.disabled = true;
      try {
        const r = await fetch(
          `http://127.0.0.1:8765/open?urn=${encodeURIComponent(urn)}`,
          { method: 'GET', mode: 'cors' });
        if (r.ok) {
          btn.textContent = '✓';
          setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1200);
          return;
        }
        throw new Error('bridge returned ' + r.status);
      } catch (e) {
        if (webUrl && webUrl !== '#') {
          window.open(webUrl, '_blank', 'noopener');
          btn.textContent = '↗';
        } else {
          btn.textContent = 'ERR';
        }
        setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1500);
      }
    });
  });
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
    if (v === view) return;
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
