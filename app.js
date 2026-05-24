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
    const drawnCount = parts.filter(part => !!auto[part.code]).length;
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
  const commentsPanel = cOpen ? `
    <div class="comments-panel" data-code="${escapeHtml(p.code)}">
      <ul class="comments-list">
        ${comments.length ? comments.map(c => `
          <li class="comment-item">
            <span class="comment-time">${escapeHtml(fmtCommentTime(c.time))}</span>
            <span class="comment-text">${escapeHtml(c.text)}</span>
            <button class="comment-del" data-code="${escapeHtml(p.code)}" data-id="${escapeHtml(c._key || String(c.time))}" aria-label="Delete">✕</button>
          </li>`).join('') : '<li class="comment-empty">No comments yet</li>'}
      </ul>
      <form class="comment-input-wrap" data-code="${escapeHtml(p.code)}">
        <input class="comment-input" type="text" placeholder="พิมพ์ comment / type a note…" autocomplete="off">
        <button type="submit" class="comment-add">+ Add</button>
      </form>
    </div>` : '';
  const tRunning = projectKey ? isTimerRunning(projectKey, p.code) : false;
  const tSeconds = projectKey ? getTimerTotalSeconds(projectKey, p.code) : 0;
  const tText = formatDuration(tSeconds);
  const timerHtml = projectKey ? `
    <span class="timer-elapsed ${tRunning ? 'running' : ''}" data-pk="${escapeHtml(projectKey)}" data-code="${escapeHtml(p.code)}">${escapeHtml(tText)}</span>
    <button class="timer-btn ${tRunning ? 'running' : ''}" data-pk="${escapeHtml(projectKey)}" data-code="${escapeHtml(p.code)}" aria-label="${tRunning ? 'Stop' : 'Start'} timer" title="${tRunning ? 'Stop timer' : 'Start timer'}">${tRunning ? '⏸' : '▶'}</button>
  ` : '';
  return `
    <div class="bom-row ${bent ? 'bent' : ''} ${cOpen ? 'comments-open' : ''}" data-code="${escapeHtml(p.code)}" style="${famVars(fam)}">
      <div class="bom-row-main" data-url="${escapeHtml(url)}" data-has="${hasDrawing}">
        <span class="bom-icon">${familyIcon(fam)}</span>
        <span class="bom-code">${escapeHtml(p.code)}</span>
        <span class="bom-qty">×${p.qty}</span>
        ${timerHtml}
        <button class="comment-btn ${comments.length ? 'has-comments' : ''}" data-code="${escapeHtml(p.code)}" aria-label="Comments" title="Comments">💬${cBadgeHtml}</button>
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

  const visibleParts = filter === 'missing'
    ? parts.filter(p => !auto[p.code])
    : parts;
  const missingCount = parts.filter(p => !auto[p.code]).length;

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
}

// ──────────────────────────────────────────────────────────────────────
// Missing view — masters that need a drawing.
// Data source: drawings-ui/Drawings/missing.json
//   (populated by CC_ScanMissingDrawings Fusion script)
// Each row has an "Open in Fusion" deep link → browser → Fusion launches.
// ──────────────────────────────────────────────────────────────────────

// ─── Hierarchy tree for Missing tab ────────────────────────────────
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

// Persisted collapsed-group state (keyed by group ID, e.g. "family::Drawer")
const LS_MISSING_COLLAPSED = 'kd_missing_collapsed_v2';
function getMissingCollapsedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(LS_MISSING_COLLAPSED) || '[]'));
  } catch { return new Set(); }
}
function saveMissingCollapsedSet(set) {
  try { localStorage.setItem(LS_MISSING_COLLAPSED, JSON.stringify([...set])); }
  catch {}
}

// Persisted per-card expand state (which cards have their details panel shown)
const LS_MISSING_CARD_EXPANDED = 'kd_missing_card_expanded_v1';
function getMissingCardExpandedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(LS_MISSING_CARD_EXPANDED) || '[]'));
  } catch { return new Set(); }
}
function saveMissingCardExpandedSet(set) {
  try { localStorage.setItem(LS_MISSING_CARD_EXPANDED, JSON.stringify([...set])); }
  catch {}
}

function renderMissingHome() {
  if (!missingData || !Array.isArray(missingData.missing)) {
    ROOT.innerHTML = `
      <div class="empty-state">
        <h2>⚠️ No missing data</h2>
        <p>Run <code>CC_ScanMissingDrawings</code> in Fusion to scan
        the Cloud project and create <code>missing.json</code></p>
        <p>After sync (~1 min), refresh this page to see the list</p>
      </div>`;
    COUNT_EL.textContent = '';
    return;
  }

  const items = missingData.missing.slice();
  if (!items.length) {
    ROOT.innerHTML = `
      <div class="empty-state">
        <h2>🎉 No missing drawings</h2>
        <p>All masters in "${escapeHtml(missingData.project_name || 'project')}" have paired drawings</p>
        <p class="muted">Last scan: ${escapeHtml(fmtDate(missingData.scanned_at))}</p>
      </div>`;
    COUNT_EL.textContent = '0 missing';
    return;
  }

  // Group by family (Drawer / Back-Down / Floor / Top Sup / Other / ...)
  const groups = new Map();
  for (const e of items) {
    const fam = e.family || 'Other';
    if (!groups.has(fam)) groups.set(fam, []);
    groups.get(fam).push(e);
  }
  const sortedFams = [...groups.keys()].sort(familyOrder);
  const collapsed = getMissingCollapsedSet();

  const groupsHtml = sortedFams.map(fam => {
    const entries = groups.get(fam).slice().sort((a, b) =>
      a.name.localeCompare(b.name));
    const groupId = `family::${fam}`;
    const isCollapsed = collapsed.has(groupId);
    const cardExpanded = getMissingCardExpandedSet();
    const cards = entries.map(e => {
      const status = e.status || 'missing';
      const isStale = status === 'stale';
      const badge = isStale
        ? `<span class="missing-badge stale" title="Master saved after drawing — re-export needed">⏰ outdated</span>`
        : '';
      // For stale: open the DRAWING file (user needs to update drawing, not master)
      // For missing: open the MASTER file (user needs to create a drawing from it)
      const openUrn = isStale && e.drawing_urn ? e.drawing_urn : (e.urn || '');
      const openLabel = isStale ? 'Update ↗' : 'Open ↗';
      const openTitle = isStale
        ? `Open drawing "${e.drawing_name || ''}" to re-export`
        : `Open master "${e.name}" to create drawing`;
      const covers = Array.isArray(e.covers) ? e.covers : [];
      const folderName = e.folder_name || '';
      const drawingName = e.drawing_name || '';
      const hasDetails = covers.length > 0 || folderName || drawingName;
      const isExp = cardExpanded.has(e.name);
      const togglerHtml = hasDetails
        ? `<button class="card-toggle ${isExp ? 'open' : ''}" data-name="${escapeHtml(e.name)}" aria-label="Toggle details">${isExp ? '▼' : '▶'}</button>`
        : `<span class="card-toggle-spacer"></span>`;
      const detailsHtml = hasDetails && isExp ? `
        <div class="card-details">
          ${folderName ? `<div class="cd-row">📂 <span class="cd-label">Folder:</span> ${escapeHtml(folderName)}</div>` : ''}
          ${drawingName ? `<div class="cd-row">📄 <span class="cd-label">Drawing:</span> ${escapeHtml(drawingName)}</div>` : ''}
          ${covers.length ? `<div class="cd-row"><span class="cd-label">Covers (${covers.length}):</span> ${covers.map(c => `<span class="cover-chip">${escapeHtml(c)}</span>`).join('')}</div>` : ''}
        </div>` : '';
      return `
      <div class="missing-card ${isStale ? 'stale' : ''} ${isExp ? 'expanded' : ''}" style="${famVars(fam)}">
        <div class="card-row">
          ${togglerHtml}
          <span class="missing-card-icon">${familyIcon(fam)}</span>
          <span class="missing-card-name">${escapeHtml(e.name)}${badge}</span>
          <button class="missing-open" data-urn="${escapeHtml(openUrn)}" data-weburl="${escapeHtml(e.open_url || '#')}" title="${escapeHtml(openTitle)}">${openLabel}</button>
        </div>
        ${detailsHtml}
      </div>`;
    }).join('');
    return `
      <div class="master-group ${isCollapsed ? 'collapsed' : ''}" data-group="${escapeHtml(groupId)}" style="${famVars(fam)}">
        <div class="master-header">
          <span class="master-toggle">▼</span>
          <span class="master-name" style="color:var(--fam-color)">${familyIcon(fam)} ${escapeHtml(fam)}</span>
          <span class="master-meta">${entries.length} ${entries.length === 1 ? 'part' : 'parts'}</span>
        </div>
        <div class="master-rows missing-grid">${cards}</div>
      </div>`;
  }).join('');

  const scanInfo = missingData.scanned_at
    ? `Scanned ${escapeHtml(fmtDate(missingData.scanned_at))} · ${missingData.pairs_count || 0} pairs OK`
    : '';

  // Count statuses
  const noDrawingCount = items.filter(e => (e.status || 'missing') === 'missing').length;
  const staleCount = items.filter(e => e.status === 'stale').length;
  const statusSummary = staleCount > 0
    ? ` · <span class="stat-stale">⏰ ${staleCount} outdated</span> · <span class="stat-missing">🚫 ${noDrawingCount} no drawing</span>`
    : '';

  // Detect: are ALL groups collapsed? → next click = expand all
  const allCollapsed = sortedFams.every(f => collapsed.has(`family::${f}`));

  ROOT.innerHTML = `
    <div class="missing-header">
      <div class="missing-toolbar">
        <p class="muted">${scanInfo}${statusSummary}</p>
        <button class="action-btn" id="missing-toggle-all">
          <span class="toggle-arrow">${allCollapsed ? '▶' : '▼'}</span>
          <span class="toggle-label">${allCollapsed ? 'Expand all' : 'Collapse all'}</span>
        </button>
      </div>
      <p class="hint">⏰ <strong>outdated</strong> = master saved after drawing — needs re-export. 🚫 <strong>no drawing</strong> = not yet drawn</p>
    </div>
    ${groupsHtml}`;
  COUNT_EL.textContent = `${items.length} missing`;

  // Wire per-group collapse/expand
  ROOT.querySelectorAll('.master-header').forEach(h => {
    h.addEventListener('click', () => {
      const group = h.closest('.master-group');
      const id = group.dataset.group;
      const set = getMissingCollapsedSet();
      if (group.classList.contains('collapsed')) {
        group.classList.remove('collapsed');
        set.delete(id);
      } else {
        group.classList.add('collapsed');
        set.add(id);
      }
      saveMissingCollapsedSet(set);
    });
  });

  // Wire per-card details toggle (▶/▼ chevron at left of each card)
  ROOT.querySelectorAll('.card-toggle').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const name = btn.dataset.name;
      const set = getMissingCardExpandedSet();
      if (set.has(name)) set.delete(name); else set.add(name);
      saveMissingCardExpandedSet(set);
      renderMissingHome();
    });
  });

  // Wire global toggle-all
  const globalBtn = ROOT.querySelector('#missing-toggle-all');
  if (globalBtn) {
    globalBtn.addEventListener('click', () => {
      const set = getMissingCollapsedSet();
      if (allCollapsed) {
        set.clear();
      } else {
        sortedFams.forEach(f => set.add(`family::${f}`));
      }
      saveMissingCollapsedSet(set);
      renderMissingHome();
    });
  }

  // Wire Open buttons — try localhost bridge first (1-click direct open),
  // fallback to web hub if add-in/bridge not running.
  ROOT.querySelectorAll('.missing-open').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
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
          btn.textContent = '✓ Sent';
          setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1200);
          return;
        }
        throw new Error('bridge returned ' + r.status);
      } catch (e) {
        // Fallback — open web hub in new tab
        if (webUrl && webUrl !== '#') {
          window.open(webUrl, '_blank', 'noopener');
          btn.textContent = '↗ Web';
        } else {
          btn.textContent = 'ERR';
        }
        setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1500);
      }
    });
  });
}

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
      view === 'missing'  ? 'Search missing master…' :
                            'Search part code…';
    render();
  });
});

// Update Missing tab badge with count
function updateMissingBadge() {
  const badge = document.getElementById('missing-badge');
  if (!badge) return;
  const n = (missingData && Array.isArray(missingData.missing)) ? missingData.missing.length : 0;
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
  const q = SEARCH.value.trim().toLowerCase();
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
  // Connect to Firebase Realtime DB for shared comments + timers (real-time
  // sync across devices). Falls back to localStorage if Firebase unavailable.
  initCommentsSync();
  initTimersSync();

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
