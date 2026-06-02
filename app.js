// drawings-ui/app.js — vanilla JS mobile/iPad UI with Projects + Library tabs.

const ROOT = document.getElementById('root');
const SEARCH = document.getElementById('search');
const SEARCH_CLEAR = document.getElementById('search-clear');
const UPDATED = document.getElementById('updated');
const COUNT_EL = document.getElementById('count');

let manifest = null;
let families = null;
let missingData = null;  // { scanned_at, project_name, count, missing: [{name,urn,family,folder_path,open_url}] }

let view = 'projects';   // 'projects' | 'library' | 'nest' | 'missing'
let stack = [];          // navigation stack ('home' | {kind:'family', name} | {kind:'project', name})

const LS_COMPLETED_KEY = 'kd_completed_projects_v1';
const LS_BENT_KEY = 'kd_bent_parts_v1';            // bent / งานพับ (per project::code)
const LS_ASSEMBLED_KEY = 'kd_assembled_parts_v1';  // assembled / งานประกอบ (per project::code)
const LS_COMMENTS_KEY = 'kd_comments_v1';        // { partCode: [{text, time}] }
const LS_COMMENTS_OPEN_KEY = 'kd_comments_open_v1';  // Set<partCode>: which rows have comments panel expanded
const LS_TIMERS_KEY = 'kd_timers_v1';             // { projectKey: { partCode: { sessions, active_start } } }
const LS_DELETED_KEY = 'kd_deleted_drawings_v1';  // { partCode: epoch_ms }  — soft-deleted drawings (workshop "redo this")
const LS_DELETED_PROJECTS_KEY = 'kd_deleted_projects_v1';  // { projectKey: { time } } — soft-deleted projects (admin hides from list; parts stay visible in Library)
const LS_ADMIN_KEY = 'kd_admin_v1';               // '1' if this device is owner (เอ๋); only owner sees delete/edit buttons
const LS_ROLE_KEY = 'kd_role_v1';                 // workshop|laser|bend|assemble — role tints what's visible (orthogonal to admin overlay)
const LS_PINNED_KEY = 'kd_pinned_projects_v1';    // Set<projectKey> — pinned projects float to top
const LS_PROJECT_ORDER_KEY = 'kd_project_order_v1'; // Array<projectKey> — manual drag order (truthy projects come first in this order)
const LS_FAMILY_LABELS_KEY = 'kd_family_labels_v1';  // {familyKey: customLabel} — admin-edited chip labels
const LS_DISPLAY_OVERRIDES_KEY = 'kd_display_overrides_v1';  // {originalCode: customLabel} — admin-edited part code display in Library (e.g. fix Fusion-side typos)
const LS_FAMILY_OVERRIDES_KEY = 'kd_family_overrides_v1';    // {code: customFamilyName} — admin-moved parts to custom folders. Overrides Fusion-side family assignment per code.
const LS_CUSTOM_FOLDERS_KEY = 'kd_custom_folders_v1';        // [folderName] — admin-created empty folders that should appear in Library home even with 0 parts.
const LS_FAMILY_ORDER_KEY = 'kd_family_order_v1';    // Array<familyKey> — admin-set chip order

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
  // Per user (2026-05-27): close admin features from workshop again —
  // worried workshop users would accidentally break shared state
  // (delete project, move parts to wrong folder, etc.). Workshop sees
  // only read + the queue-management ops that were explicitly opened
  // (pin/favorite, drag-reorder projects, drag BOM nodes, mini buttons
  // for timer/bent/asm/PDF).
  try { return localStorage.getItem(LS_ADMIN_KEY) === '1'; } catch { return false; }
}

function setAdmin(on) {
  try {
    if (on) localStorage.setItem(LS_ADMIN_KEY, '1');
    else localStorage.removeItem(LS_ADMIN_KEY);
  } catch {}
  updateAdminBadge();
  // Show / hide the admin-only role switcher.
  try { _renderAdminRoleSwitcher(); } catch {}
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
  // Workshop users don't manage Library taxonomy — hide the tab so they
  // can't accidentally drill in and start uploading PDFs / re-filing
  // parts. Admin (and PWA in admin mode) still sees it.
  const libTab = document.getElementById('tab-library');
  if (libTab) {
    libTab.style.display = isAdmin() ? '' : 'none';
  }
  // Nest tab — admin-only too (user 2026-05-28: 'nest ให้ย้ายไปต่อ
  // library admin ใช้ได้คนเดียว'). The Nest workspace itself can be
  // demanding (browser-side DXF parse + pack) and producing wrong
  // nests has real cost, so we keep it gated behind the admin flag.
  const nestTab = document.getElementById('tab-nest');
  if (nestTab) {
    nestTab.style.display = isAdmin() ? '' : 'none';
  }
  // If a workshop user somehow lands on a gated view (e.g. legacy URL
  // or auto-switch when no projects yet), bounce them back to Projects
  // so the empty hidden tab can't trap them.
  if (!isAdmin() && typeof view !== 'undefined' && (view === 'library' || view === 'nest')) {
    view = 'projects';
    stack = [];
    const projTab = document.getElementById('tab-projects');
    if (projTab) projTab.classList.add('active');
    if (libTab) libTab.classList.remove('active');
    if (nestTab) nestTab.classList.remove('active');
    try { render(); } catch {}
  }
}

// ──────────────────────────────────────────────────────────────────────
// Role system — orthogonal to the admin flag (2026-05-28).
// Default = 'workshop' (current view-only behavior). Other roles tint
// what each user sees:
//   • 'laser'    — งานตัด Laser. Focus on DXFs + nesting status.
//   • 'bend'     — งานพับ. Focus on Bending kanban.
//   • 'assemble' — งานประกอบ. Focus on Assembly kanban + comments.
//   • 'admin'    — separate overlay flag (LS_ADMIN_KEY) that adds edit
//                  buttons on top of any role.
//
// Toggle:
//   • Visit  ?role=laser    → enable on this device (persists)
//   • Visit  ?role=workshop → reset to default
//   • Type   :laser         in search box → enable
//   • Type   :laser off     in search box → reset to workshop
//
// Each role's actual UI differences are implemented per-feature — this
// section only provides the plumbing (state + helpers + chip + URL
// + search hooks). User-driven per-role visibility rules slot in later.
// ──────────────────────────────────────────────────────────────────────

// Role chip palette — each entry mirrors the .admin-badge visual
// (gradient pill + drop shadow) so role status is just as glanceable
// as the admin flag. gradStart / gradEnd flow through to a 135°
// linear-gradient; shadow is the gradEnd at ~40% alpha.
//
// Icon: pass `iconClass` when the role has a dedicated SVG icon
// (rendered via a CSS background-image on a <span>). Otherwise the
// plain `emoji` field renders as a unicode glyph. Bending uses the
// project's existing press-brake icon (icons/bending.svg) per the
// user request 2026-05-28 — same icon already shown on the bent
// kanban buttons and the Bending pill summary.
const ROLES = {
  workshop: { label: 'Workshop', emoji: '👁',  color: '#888',    gradStart: '#888',    gradEnd: '#666'    },
  laser:    { label: 'Laser',    emoji: '🔥', color: '#d29922', gradStart: '#ffa726', gradEnd: '#d29922' },
  bend:     { label: 'Bending',  iconClass: 'icon-bend', color: '#5dbb63', gradStart: '#7ed87b', gradEnd: '#3f9447' },
  assemble: { label: 'Assembly', emoji: '🧩', color: '#e07a5f', gradStart: '#ff8a65', gradEnd: '#c24d32' },
};
const ROLE_KEYS = Object.keys(ROLES);
const DEFAULT_ROLE = 'workshop';

function getRole() {
  try {
    const v = localStorage.getItem(LS_ROLE_KEY) || DEFAULT_ROLE;
    return ROLES[v] ? v : DEFAULT_ROLE;
  } catch { return DEFAULT_ROLE; }
}

function setRole(role) {
  if (!ROLES[role]) role = DEFAULT_ROLE;
  try {
    if (role === DEFAULT_ROLE) localStorage.removeItem(LS_ROLE_KEY);
    else localStorage.setItem(LS_ROLE_KEY, role);
  } catch {}
  updateRoleBadge();
}

function isLaserUser()    { return getRole() === 'laser'; }
function isBendUser()     { return getRole() === 'bend'; }
function isAssembleUser() { return getRole() === 'assemble'; }
function isWorkshopRole() { return getRole() === 'workshop'; }

function updateRoleBadge() {
  let badge = document.getElementById('role-badge');
  const headerRow = document.querySelector('.header-row');
  const role = getRole();
  // When admin mode is on the dedicated role switcher already highlights
  // the active role with its gradient — showing the chip too produced a
  // duplicate (user noted on 2026-05-28: 'มีปุ่ม ASSEMBLY 2 อัน').
  // Drop the redundant chip in admin mode; non-admin users still get
  // the chip as their only role indicator.
  if (isAdmin()) {
    if (badge) badge.remove();
    _renderAdminRoleSwitcher();
    return;
  }
  if (role !== DEFAULT_ROLE) {
    const r = ROLES[role];
    if (!badge && headerRow) {
      badge = document.createElement('span');
      badge.id = 'role-badge';
      badge.className = 'role-badge';
      headerRow.appendChild(badge);
    }
    if (badge) {
      // Render text in uppercase to mirror "🔓 ADMIN" — same chunky
      // visual weight so the user instantly recognizes "I'm in <X>
      // mode" without parsing the label.
      //
      // Two icon styles supported: an inline <span class="icon-...">
      // (CSS-backed SVG, used for Bending) or a plain unicode emoji.
      const iconHtml = r.iconClass
        ? `<span class="${r.iconClass}" aria-hidden="true"></span>`
        : (r.emoji || '');
      badge.innerHTML = `${iconHtml} ${escapeHtml(r.label.toUpperCase())}`;
      badge.style.background = `linear-gradient(135deg, ${r.gradStart}, ${r.gradEnd})`;
      badge.style.color = '#fff';
      badge.style.borderColor = 'transparent';
      badge.style.boxShadow = `0 1px 4px ${r.gradEnd}66`;
      badge.title = `Role: ${r.label} — type ":${role} off" in search box to reset.`;
    }
  } else if (badge) {
    badge.remove();
  }
  // Render the admin role switcher: 4 mini buttons that let the admin
  // preview each role without typing magic words. Shown only when
  // admin mode is on; auto-hides otherwise.
  _renderAdminRoleSwitcher();
}

// Admin-only role switcher — appears in the header row when isAdmin()
// is true. Lets the admin preview each role's view by clicking a
// button instead of typing ":<role>" in the search box.
function _renderAdminRoleSwitcher() {
  let bar = document.getElementById('role-switcher');
  const headerRow = document.querySelector('.header-row');
  if (!isAdmin()) {
    if (bar) bar.remove();
    return;
  }
  if (!bar && headerRow) {
    bar = document.createElement('div');
    bar.id = 'role-switcher';
    bar.className = 'role-switcher';
    headerRow.appendChild(bar);
  }
  if (!bar) return;
  const active = getRole();
  // Workshop is the implicit "no chip pressed" default — user 2026-05-29
  // 'เอา workshop ออก ไม่ได้ใช้ทำอะไร'. We only render chips for the
  // explicit roles (Laser / Bending / Assembly). To still let admin flip
  // back to Workshop, the click handler treats a second click on the
  // already-active chip as a toggle-off to DEFAULT_ROLE. URL ?role=workshop
  // + the ":laser off" search-box magic word still work as before.
  const chipKeys = ROLE_KEYS.filter(rk => rk !== DEFAULT_ROLE);
  bar.innerHTML = chipKeys.map(rk => {
    const r = ROLES[rk];
    const iconHtml = r.iconClass
      ? `<span class="${r.iconClass}" aria-hidden="true"></span>`
      : (r.emoji || '');
    const isActive = rk === active;
    const style = isActive
      ? `background: linear-gradient(135deg, ${r.gradStart}, ${r.gradEnd}); color: #fff; border-color: transparent; box-shadow: 0 1px 4px ${r.gradEnd}66;`
      : '';
    const title = isActive
      ? `${r.label} active — click again to return to default (Workshop)`
      : `Preview ${r.label} role`;
    return `<button class="role-switch-btn ${isActive ? 'active' : ''}" data-role="${rk}" style="${style}" title="${escapeHtml(title)}">${iconHtml} ${escapeHtml(r.label.toUpperCase())}</button>`;
  }).join('');
  bar.querySelectorAll('.role-switch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const clicked = btn.dataset.role;
      // Second click on the already-active chip toggles back to Workshop
      // (the default view) since the standalone Workshop chip is gone.
      const next = clicked === getRole() ? DEFAULT_ROLE : clicked;
      setRole(next);
      render();
    });
  });
}

// Apply URL flags on page load (admin + role). Clean URL after toggling
// so flags don't persist in browser history.
(function applyUrlFlags() {
  try {
    const params = new URLSearchParams(window.location.search);
    let dirty = false;
    if (params.has('admin')) {
      const v = params.get('admin');
      if (v === '1' || v === 'on' || v === 'true') setAdmin(true);
      else if (v === '0' || v === 'off' || v === 'false') setAdmin(false);
      params.delete('admin');
      dirty = true;
    }
    if (params.has('role')) {
      const v = (params.get('role') || '').toLowerCase();
      setRole(v);
      params.delete('role');
      dirty = true;
    }
    // Deep-link `?p=Bung+01` auto-navigates straight into that project
    // once the manifest loads. Combined with ?role=assemble this gives
    // the admin a single URL to send each cabinet team — they tap it
    // and land in the right project's assembly view without scrolling
    // a project list. Stashed in window so the manifest-load handler
    // can pick it up after data arrives (the project may not exist
    // yet at flag-parse time).
    if (params.has('p')) {
      window.__kdInitialProject = params.get('p') || '';
      params.delete('p');
      dirty = true;
    }
    if (dirty) {
      const qs = params.toString();
      const cleanUrl = window.location.origin + window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
    }
  } catch (e) { console.warn('flag parse failed:', e); }
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

// ──────────────────────────────────────────────────────────────────────
// Drawing aliases — groups / prefix-shares of part codes that share one
// workshop drawing. Source: drawings-ui/Drawings/drawing_aliases.json.
//
// Two mechanisms:
//   1. "groups" — explicit arrays of codes. Any code in a group with a
//      manifest entry covers the others. e.g. ["FN1BLA-110000",
//      "FN2BNX-110000"] → both share whichever has the entry.
//   2. "prefix_shares" — list of code prefixes. Any code starting with
//      "<prefix>-" shares drawings with every other code that has the
//      same prefix. Useful for parametric masters with many config rows
//      that all derive from one drawing (e.g. BK1DN1-* all share the
//      BK1DN1 master's drawing).
// ──────────────────────────────────────────────────────────────────────
let _drawingAliasIndex = new Map();      // code → group array
let _drawingAliasPrefixes = new Set();   // prefixes that share drawings

function _buildDrawingAliasIndex(aliasData) {
  _drawingAliasIndex = new Map();
  _drawingAliasPrefixes = new Set();
  if (!aliasData) return;
  if (Array.isArray(aliasData.groups)) {
    for (const group of aliasData.groups) {
      if (!Array.isArray(group) || group.length < 2) continue;
      for (const code of group) {
        _drawingAliasIndex.set(code, group);
      }
    }
  }
  if (Array.isArray(aliasData.prefix_shares)) {
    for (const prefix of aliasData.prefix_shares) {
      if (typeof prefix === 'string' && prefix) {
        _drawingAliasPrefixes.add(prefix);
      }
    }
  }
}

// Return the code whose manifest entry should represent `code`'s drawing.
// Falls back to `code` itself if no alias has a manifest entry either.
// Pattern-based wrapper alias for shared drawings. Codes matching
// FN_B__-___000 (any FN-family drawer wrapper ending in -???000) all
// reuse the canonical drawing of FN0B00-000000 — drawer-front geometry
// only varies in derived dimensions, so one master drawing covers
// every wrapper. User 2026-05-29: 'ถ้าเป็น FN_B__-___000 ให้ใช้
// file pdf ของ FN0B00-000000 เลย'. Self-mapping (FN0B00-000000 itself
// matches the pattern but returns its own code) keeps _effectiveDrawing
// Code's fallthrough safe.
function _patternAliasForDrawing(code) {
  if (/^FN.B..-...000$/.test(code) && code !== 'FN0B00-000000') {
    return 'FN0B00-000000';
  }
  return code;
}

function _effectiveDrawingCode(code) {
  const auto = (manifest && manifest.auto_generated) || {};
  if (auto[code]) return code;  // self has the drawing — use as-is
  // 1. Explicit group — first sibling with a manifest entry wins.
  const group = _drawingAliasIndex.get(code);
  if (group) {
    for (const sibling of group) {
      if (sibling !== code && auto[sibling]) return sibling;
    }
  }
  // 2. Prefix share — only checked if the code's prefix is in the
  // share list. First other code with the same prefix that has an
  // entry wins. Iteration order isn't guaranteed; for our use case
  // (all same-prefix codes share one drawing) any match is correct.
  const prefix = code.split('-')[0];
  if (prefix && _drawingAliasPrefixes.has(prefix)) {
    for (const otherCode of Object.keys(auto)) {
      if (otherCode === code) continue;
      if (otherCode.startsWith(prefix + '-')) return otherCode;
    }
  }
  // 3. Pattern alias (last resort). Returns the alias even when it has
  //    no auto entry so downstream upload-cache lookups in
  //    pdfUrlForCode can still match the alias target.
  const patternAlias = _patternAliasForDrawing(code);
  if (patternAlias !== code) return patternAlias;
  return code;
}

// Open a URL "in a new tab" — but handle the iPad PWA standalone case
// where target="_blank" silently opens the link in an off-screen
// webview the user never sees. In standalone mode we navigate the
// current window instead; iOS swipe-back / back-button gestures
// return the user to the app.
//
// Detection covers both the modern matchMedia signal and the legacy
// Apple-specific `navigator.standalone` flag (still present in iOS
// Safari PWA in 2026).
function _isStandalonePwa() {
  try {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch {}
  return window.navigator && window.navigator.standalone === true;
}

function _openInNewTab(url) {
  if (!url) return;
  console.log('[open]', url, _isStandalonePwa() ? '(standalone PWA → same window)' : '(browser → new tab)');
  if (_isStandalonePwa()) {
    // Navigate inside the PWA — PDF replaces the app view; back gesture
    // returns to the app. Avoids the invisible-tab problem on iOS.
    try { window.location.href = url; return; } catch {}
  }
  try {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    try { window.location.href = url; } catch {}
  }
}

// Trigger a browser download for a remote URL. Uses an anchor element
// with the `download` attribute so .dxf files (which Pages serves as
// application/octet-stream) land in the user's Downloads folder rather
// than rendering inline as text.
async function _downloadFile(url, suggestedName) {
  if (!url) { console.warn('[dxf] _downloadFile called with empty url'); return; }
  // The DXF `url` field uses the synthetic kitchen-drawings-rd2026.github.io
  // host (see _githubPagesToJsdelivr) — that host doesn't exist, so hitting it
  // directly 404s, and a cross-origin <a download> ignores the suggested name
  // anyway. For those, fetch the jsdelivr mirror (returns 200, CORS-enabled,
  // same trick the preview path uses) as a blob and download via an object URL
  // so the file actually lands with the right name. Any non-github.io URL
  // (raw.githubusercontent PDFs etc.) keeps the plain-anchor path unchanged.
  // Always fetch as a blob. For the synthetic *.github.io host this hits the
  // jsdelivr mirror; for Cut Sheets (raw.githubusercontent.com) the URL is
  // unchanged — but raw serves DXF as text/plain, so a plain cross-origin
  // <a download> would open it inline instead of downloading. Both hosts send
  // CORS headers, so the blob + object-URL path forces a real download with
  // the right filename in every case. Plain anchor remains the fallback.
  const mirror = _githubPagesToJsdelivr(url);
  {
    try {
      const resp = await fetch(mirror, { cache: 'force-cache' });
      if (!resp.ok) throw new Error('fetch ' + resp.status);
      const blob = await resp.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = suggestedName || mirror.split('/').pop() || '';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
      return;
    } catch (e) {
      console.warn('[dxf] blob download failed, falling back to direct link:', e);
      // fall through to the plain anchor below (best-effort)
    }
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName || '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
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

// Project-master PDF lookup. The project KEY is the master file's
// part code, but CC_DrawingPDF doesn't emit a manifest entry keyed by
// that code — it emits one entry per config row, all pointing at the
// same `<masterCode>.pdf` file. So pdfUrlForCode(projectKey) returns
// '' even when the file exists.
//
// Strategy:
//   1. Direct lookup via pdfUrlForCode — covers uploads + the rare
//      case where a manifest entry IS keyed by the project code.
//   2. Scan auto_generated for any entry whose `pdf` field is
//      `<projectKey>.pdf` — use that. Page is left at 1 (the master
//      view is conventionally the first page; per-config navigation
//      goes through pdfUrlForCode of the specific child code).
function projectPdfUrl(projectKey) {
  if (!projectKey) return '';
  const direct = pdfUrlForCode(projectKey);
  if (direct) return direct;
  const auto = (manifest && manifest.auto_generated) || {};
  const target = `${projectKey}.pdf`;
  for (const entry of Object.values(auto)) {
    if (entry && entry.pdf === target) {
      return pdfUrl({ pdf: target, page_number: 1 });
    }
  }
  return '';
}

function pdfUrlForCode(code) {
  // Soft-deleted drawings act as if missing (until re-exported)
  if (isDrawingSoftDeleted(code)) return '';
  // Honor drawing aliases — fall back to a group sibling's drawing if
  // this code doesn't have its own entry.
  const effective = _effectiveDrawingCode(code);
  const e = (manifest.auto_generated || {})[effective];
  if (e) return pdfUrl(e);
  // Then check web-uploaded PDFs (admin drag-drop, served by GitHub
  // Pages). Direct match by effective or original code, then — for
  // prefix-shared families — by any sibling with the same prefix.
  let upload = _uploadedPdfsCache[effective] || _uploadedPdfsCache[code];
  if (!upload) {
    const prefix = code.split('-')[0];
    if (prefix && _drawingAliasPrefixes.has(prefix)) {
      for (const otherCode of Object.keys(_uploadedPdfsCache || {})) {
        if (otherCode === code) continue;
        if (otherCode.startsWith(prefix + '-')) {
          upload = _uploadedPdfsCache[otherCode];
          break;
        }
      }
    }
    // Explicit groups too, in case a future upload covers a group sibling.
    if (!upload) {
      const group = _drawingAliasIndex.get(code);
      if (group) {
        for (const sibling of group) {
          if (sibling !== code && _uploadedPdfsCache[sibling]) {
            upload = _uploadedPdfsCache[sibling];
            break;
          }
        }
      }
    }
  }
  if (upload && upload.url) return upload.url;
  return '';
}

// Return all uploaded DXFs whose master_code matches the given Library
// row code. Returns an array (possibly empty) sorted by filename so the
// popover ordering is stable across re-renders.
function dxfsForMasterCode(masterCode) {
  if (!masterCode || !_uploadedDxfsCache) return [];
  const out = [];
  for (const [stem, meta] of Object.entries(_uploadedDxfsCache)) {
    if (meta && meta.master_code === masterCode) {
      out.push({ stem, ...meta });
    }
  }
  out.sort((a, b) => (a.filename || a.stem).localeCompare(b.filename || b.stem));
  return out;
}

// Return all uploaded DXFs tagged with the given project key. NestingTool
// stamps ``project: <key>`` into the RTDB metadata when it uploads via
// the "📤 Save to Project" button, so each DXF can be looked up by either
// its master_code (Library view) or its source project (Project view).
function dxfsForProject(projectKey) {
  if (!projectKey || !_uploadedDxfsCache) return [];
  const out = [];
  for (const [stem, meta] of Object.entries(_uploadedDxfsCache)) {
    if (meta && meta.project === projectKey) {
      out.push({ stem, ...meta });
    }
  }
  out.sort((a, b) => (a.filename || a.stem).localeCompare(b.filename || b.stem));
  return out;
}

// Project-level DXF rollup modal. Built fresh each click so it always
// reflects the latest uploaded_dxfs cache. Shows:
//   - Project name + summary line (parts to cut, DXFs uploaded)
//   - One row per BOM part: code · qty · DXF status (📐 N or ⚠ none)
//   - Row click downloads the DXF (single) or opens a sub-popover (N>1)
// Dismissed by outside-click, Escape, or scroll — same teardown contract
// as _renderDxfPopover so no orphan document listeners are left behind.
// Convert a kitchen-drawings-rd2026.github.io URL to its jsdelivr
// equivalent so XHR fetches succeed under CORS. github.io doesn't
// emit Access-Control-Allow-Origin for raw files; jsdelivr does.
// Falls through unchanged for non-Pages URLs.
function _githubPagesToJsdelivr(url) {
  if (!url) return url;
  const m = url.match(/^https?:\/\/([^./]+)\.github\.io\/(.*)$/);
  if (!m) return url;
  const repoName = m[1];
  const path = m[2];
  // Hard-coded owner — every project URL routes through wuttichaisaeton.
  return `https://cdn.jsdelivr.net/gh/wuttichaisaeton/${repoName}@main/${path}`;
}

// ── DXF preview modal ────────────────────────────────────────────────
// Lazy-loaded JS DXF parser/renderer. ~200 KB; loaded only when the
// user clicks a DXF row to preview (saves data on workshop iPads that
// never preview). Once loaded the script attaches `window.Dxf` (the
// `dxf` npm package's UMD build).
let _dxfLibPromise = null;
function ensureDxfLib() {
  if (window.dxf) return Promise.resolve();
  if (_dxfLibPromise) return _dxfLibPromise;
  _dxfLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    // jsdelivr serves the bundled UMD build; unpkg occasionally
    // refuses cross-origin script loads from sandboxed preview
    // environments, jsdelivr is more permissive. The library
    // exposes the global `dxf` (lowercase).
    s.src = 'https://cdn.jsdelivr.net/npm/dxf@5.1.1/dist/dxf.min.js';
    s.async = true;
    s.onload = resolve;
    s.onerror = (e) => {
      _dxfLibPromise = null;
      reject(new Error('DXF library failed to load (network / CDN issue)'));
    };
    document.head.appendChild(s);
  });
  return _dxfLibPromise;
}

// Open a modal showing the DXF rendered as inline SVG, plus metadata
// (thickness, grain, material) and a download button. Closed on
// Escape, outside-click, or the ✕ button.
// Exposed on window so sibling modules (nest.js) can open the DXF
// preview without duplicating the modal code.
window._renderDxfPreviewModal = _renderDxfPreviewModal;
// Per user 2026-05-28: 'PDF/DXF กดดูได้ทุก role แต่ดาวน์โหลด admin
// เท่านั้น; เลเซอร์ดาวน์โหลดได้เฉพาะ Cut Sheets'. The DXF preview
// modal here is for per-PART DXFs (uploaded_dxfs/) — laser does not
// get a download button. Cut Sheets modal is a separate code path
// and keeps its laser-accessible download.
function _canDownloadPartDxf() {
  return isAdmin();
}
function _canDownloadCutSheet() {
  return isAdmin() || isLaserUser();
}
// Per-part DXF preview modal. Renders the part on a <canvas> using the
// SAME pipeline as the Nest's single-part preview (window.kdNest) so the
// Laser worker sees an identical clean cut-path (bend layers stripped,
// holes shown) instead of the old cluttered toSVG dump. User 2026-05-30:
// 'view ใน Part ของ Laser ก็ให้เหมือน view ที่ Nest และใช้ keyboard ขึ้นลง'.
//
// `nav` (optional) = { codes:[...orderedCodes], code:'<current>' } enables
// ↑/↓ (and ‹/›) cycling between sibling parts without closing the modal —
// each step loads dxfsForMasterCode(code)[0].
async function _renderDxfPreviewModal(dxf, nav) {
  if (!dxf || !dxf.url) return;
  const navCodes = (nav && Array.isArray(nav.codes) && nav.codes.length) ? nav.codes : null;
  let navCode = (nav && nav.code) || dxf.code || dxf.master_code || null;

  const modal = document.createElement('div');
  modal.className = 'dxf-preview-modal';
  modal.innerHTML = `
    <div class="dxf-preview-backdrop"></div>
    <div class="dxf-preview-frame" role="dialog" aria-label="DXF preview">
      <div class="dxf-preview-header">
        <span class="dxf-preview-title"></span>
        <button class="dxf-preview-close" aria-label="Close">✕</button>
      </div>
      <div class="dxf-preview-meta"></div>
      <div class="dxf-preview-body">
        <canvas class="dxf-preview-canvas"></canvas>
      </div>
      <div class="dxf-preview-footer"></div>
    </div>`;
  document.body.appendChild(modal);

  const titleEl = modal.querySelector('.dxf-preview-title');
  const metaEl  = modal.querySelector('.dxf-preview-meta');
  const footEl  = modal.querySelector('.dxf-preview-footer');
  const canvas  = modal.querySelector('.dxf-preview-canvas');

  // Size the canvas to the part's aspect ratio so the silhouette fills the
  // box tightly and the download button sits right beneath the part instead
  // of floating far below an oversized frame (เอ๋ 2026-06-01 'ให้ปุ่มดาวน์โหลด
  // อยู่ใกล้กับ part'). The frame is height:auto in transparent mode, so the
  // canvas height we set here drives where the footer lands. Falls back to a
  // default box before the bbox is known (the 'loading…' placeholder).
  // Small padding so the canvas hugs the part and the download button sits
  // right against the silhouette (เอ๋ 2026-06-01 'ปุ่มดาวน์โหลดให้อยู่ชิด Part
  // เลย'). Passed to drawPart AND used by sizeCanvas so both agree on the box.
  const PREVIEW_PAD = 8;
  function sizeCanvas(bbox) {
    const availW = canvas.clientWidth || Math.min(window.innerWidth - 48, 900);
    const maxH = Math.max(160, window.innerHeight - 150); // leave room for ✕ + button
    let h;
    if (bbox && bbox.length === 4) {
      const pw = (bbox[2] - bbox[0]) || 1, ph = (bbox[3] - bbox[1]) || 1;
      const scale = (availW - 2 * PREVIEW_PAD) / pw;
      h = ph * scale + 2 * PREVIEW_PAD; // matches _drawPartPreview's pad → no dead space
    } else {
      h = maxH * 0.6;
    }
    // Floor very low so a thin strip's box collapses to the part itself
    // (drawPart centers within ph*scale+2·pad → only PREVIEW_PAD of dead space,
    // button hugs the part) instead of a tall box with the part floating
    // mid-height. The natural h already hugs; the floor is only a degenerate
    // guard for near-zero-height parts.
    canvas.style.height = Math.round(Math.max(24, Math.min(maxH, h))) + 'px';
  }

  const close = () => { modal.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (ev) => {
    if (ev.key === 'Escape') { close(); return; }
    if (!navCodes) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') { ev.preventDefault(); step(1); }
    else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') { ev.preventDefault(); step(-1); }
  };
  modal.querySelector('.dxf-preview-close').addEventListener('click', close);
  modal.querySelector('.dxf-preview-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  function step(delta) {
    if (!navCodes) return;
    let idx = navCodes.indexOf(navCode);
    if (idx < 0) idx = 0;
    idx = Math.max(0, Math.min(navCodes.length - 1, idx + delta));
    if (navCodes[idx] === navCode) return;
    navCode = navCodes[idx];
    const dxfs = (typeof dxfsForMasterCode === 'function') ? dxfsForMasterCode(navCode) : [];
    if (dxfs.length) load(dxfs[0]);
  }

  async function load(d) {
    const filename = d.filename || `${d.stem || 'file'}.dxf`;
    const thMm = d.thickness_mm ? `${d.thickness_mm}mm` : '?';
    const grain = d.grain || '-';
    const material = d.material || 'ALPF';
    const ago = _formatTimeAgo(d.uploaded_at) || '';
    const sizeKb = d.size_bytes ? `${Math.round(d.size_bytes / 1024)} KB` : '';

    titleEl.textContent = `📐 ${filename}`;
    metaEl.innerHTML = `
      Thickness: <strong>${escapeHtml(thMm)}</strong> ·
      Material: <strong>${escapeHtml(material)}</strong> ·
      Grain: <strong>${escapeHtml(grain)}</strong>
      ${sizeKb ? ` · <span class="dxf-preview-size">${escapeHtml(sizeKb)}</span>` : ''}
      ${ago ? ` · uploaded ${escapeHtml(ago)}` : ''}`;

    const navIdx = navCodes ? navCodes.indexOf(navCode) : -1;
    footEl.innerHTML = `
      ${navCodes ? `
        <span class="dxf-preview-nav">
          <button class="dxf-nav-prev" aria-label="Previous part" title="Previous part (↑)" ${navIdx <= 0 ? 'disabled' : ''}>‹</button>
          <span class="dxf-nav-pos">${navIdx + 1} / ${navCodes.length}</span>
          <button class="dxf-nav-next" aria-label="Next part" title="Next part (↓)" ${navIdx >= navCodes.length - 1 ? 'disabled' : ''}>›</button>
          <span class="dxf-nav-hint">↑ / ↓ to browse</span>
        </span>` : ''}
      ${_canDownloadPartDxf()
        ? `<button class="dxf-preview-download-btn">⬇ Download ${escapeHtml(filename)}</button>`
        : `<span class="dxf-preview-view-only">View only — download disabled for this role</span>`}`;
    footEl.querySelector('.dxf-nav-prev')?.addEventListener('click', () => step(-1));
    footEl.querySelector('.dxf-nav-next')?.addEventListener('click', () => step(1));
    footEl.querySelector('.dxf-preview-download-btn')?.addEventListener('click', () => _downloadFile(d.url, filename));

    // Draw via the shared Nest preview renderer. The part starts with no
    // polys → drawPart paints a "DXF not loaded yet…" placeholder; once
    // the fetch+parse resolves we fill polys/bbox and redraw.
    const part = { code: navCode, polys: null, bbox: null };
    const drawNow = () => { try { window.kdNest && window.kdNest.drawPart(canvas, part, { transparent: true, pad: PREVIEW_PAD }); } catch (e) {} };
    sizeCanvas(null);
    drawNow();
    try {
      if (!window.kdNest || typeof window.kdNest.loadPartPreview !== 'function') {
        throw new Error('preview engine unavailable');
      }
      const r = await window.kdNest.loadPartPreview(d.url);
      part.polys = r.polys; part.bbox = r.bbox;
      if (!r.bbox) part.dxfError = 'No cut geometry found';
      sizeCanvas(part.bbox);
      drawNow();
      // Second paint next frame in case the canvas hadn't been laid out
      // (clientWidth 0) on the synchronous first draw.
      requestAnimationFrame(drawNow);
    } catch (e) {
      part.dxfError = String(e.message || e);
      drawNow();
    }
  }

  await load(dxf);
}

// ── Role-specific project views ─────────────────────────────────────
// Laser-cut workers + bending workers don't need the hierarchical
// mindmap — they need a flat aggregate of "how many of code X to
// cut/bend". These helpers replace the React Flow editor body for
// their respective roles. See updateRoleBadge for how role state
// switches what renderProject renders.

// Aggregate parts list across variants — sums qty when the same code
// appears multiple times. Returns objects keyed by code with summed
// qty and the family copied from the first occurrence.
function _aggregatePartsByCode(parts) {
  const m = new Map();
  for (const p of parts || []) {
    if (!p || !p.code) continue;
    const existing = m.get(p.code);
    if (existing) {
      existing.qty += (p.qty || 0);
    } else {
      m.set(p.code, { code: p.code, qty: p.qty || 0, family: p.family || 'Other', urn: p.urn || null });
    }
  }
  return [...m.values()];
}

function _renderCutList(parts, projectKey) {
  const aggregated = _aggregatePartsByCode(parts);

  // Merge the latest nest snapshot: override grain/qty on matching codes and
  // append nest-only codes (manual rectangles) the manifest doesn't know about.
  // (user 2026-05-30 'sync รายละเอียด Part ไปด้วย')
  const _nestParts = (typeof nestPartsForProject === 'function')
    ? nestPartsForProject(projectKey) : [];
  const _aggByCode = new Map(aggregated.map(a => [a.code, a]));
  for (const np of _nestParts) {
    const row = _aggByCode.get(np.code);
    if (row) {
      if (np.qty) row.qty = np.qty;          // nest qty wins (latest truth)
      row._nestGrain = np.grain || null;     // grain override consumed below
    } else {
      aggregated.push({
        code: np.code, qty: np.qty || 0,
        family: 'Other', urn: null,
        _nestGrain: np.grain || null, _nestOnly: true,
      });
    }
  }

  // Nesting part number (#N): 1-based rank of the code in the alphabetically
  // sorted unique-code list — the SAME rule the Nest workspace uses
  // (nest.js:572 sorts S.parts by code.localeCompare, labels rows #i+1), so
  // these numbers match the nest without coupling to it. Sort a COPY so the
  // family grouping/order below is untouched. (user 2026-05-30 'cutlist ต้อง
  // sync number มาจาก nesting')
  const _nestNumberByCode = new Map();
  [...aggregated]
    .sort((a, b) => a.code.localeCompare(b.code))
    .forEach((p, i) => _nestNumberByCode.set(p.code, i + 1));

  // Group by remapped family — same chip taxonomy the Library uses, so
  // a laser worker sees parts the way they navigate the library.
  const byFamily = new Map();
  for (const p of aggregated) {
    const fam = _remapFamilyForCode(p.code, p.family) || 'Other';
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam).push(p);
  }

  const sectionsHtml = [...byFamily.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([fam, ps]) => {
      ps.sort((a, b) => a.code.localeCompare(b.code));
      const famDxfCount = ps.filter(p => dxfsForMasterCode(p.code).length > 0).length;
      const famQty = ps.reduce((s, p) => s + (p.qty || 0), 0);
      const rows = ps.map(p => {
        const dxfs = dxfsForMasterCode(p.code);
        const ready = dxfs.length > 0;
        // Merged status pill — was two cells (👁 button + readiness
        // span). User 2026-05-29 asked to combine them: ready rows
        // become a clickable <button> that opens the preview, dropping
        // the separate eye affordance. The 📐 glyph already conveys
        // "this is the DXF". Row click still works as a backup target;
        // the button's click bubbles up to the row handler.
        const status = ready
          ? `<button type="button" class="cut-status cut-ok" title="View DXF preview${dxfs.length > 1 ? ` (${dxfs.length} files)` : ''}">📐 ready${dxfs.length > 1 ? ` ×${dxfs.length}` : ''}</button>`
          : `<span class="cut-status cut-none" title="No DXF uploaded yet — run NestingTool's Save to Project">⚠ no DXF</span>`;
        // Shared grain badge — pulled from grain.json via kdNest so
        // workers see the same H/V/ANY mark here as in the Nesting
        // workspace (user 2026-05-28: 'part view ให้ sync ข้อมูล
        // ระหว่าง Laser & Nesting').
        let grainCell = '';
        if (window.kdNest && typeof window.kdNest.grainGlyph === 'function') {
          const g = p._nestGrain
            || (typeof window.kdNest.lookupGrain === 'function' ? window.kdNest.lookupGrain(p.code) : null)
            || '?';
          const gly = window.kdNest.grainGlyph(g);
          grainCell = `<span class="cut-grain ${gly.cls}" title="${gly.title}">${gly.ch}</span>`;
        }
        return `
          <div class="cut-row ${ready ? '' : 'cut-row-missing'}" data-code="${escapeHtml(p.code)}" ${ready ? '' : 'aria-disabled="true"'}>
            <span class="cut-num">#${_nestNumberByCode.get(p.code)}</span>
            <span class="cut-code">${escapeHtml(p.code)}</span>
            <span class="cut-qty">× ${p.qty || 0}</span>
            ${grainCell}
            <button type="button" class="cut-sheet-btn" data-code="${escapeHtml(p.code)}" title="Show where this part sits on the nest sheet">📍</button>
            ${status}
          </div>`;
      }).join('');
      return `
        <details class="cut-section" open>
          <summary class="cut-section-header">
            <span class="cut-section-title">${familyIcon(fam)} ${escapeHtml(fam)}</span>
            <span class="cut-section-stats">${ps.length} parts · ${famQty} pcs · 📐 ${famDxfCount}/${ps.length}</span>
          </summary>
          <div class="cut-rows">${rows}</div>
        </details>`;
    }).join('');

  const totalQty = aggregated.reduce((s, p) => s + (p.qty || 0), 0);
  const totalDxfs = dxfsForProject(projectKey).length;
  const totalReady = aggregated.filter(p => dxfsForMasterCode(p.code).length > 0).length;

  // Waiting-for-DXF banner — Laser worker opens the project and sees
  // either '📐 ready' rows (can download + cut) or '⚠ no DXF' rows
  // (must wait). When NOTHING is ready yet, surface the upstream step
  // explicitly so they're not left wondering what to do. Inspired by
  // user 2026-05-28: 'งานเลเซอร์ ที่ยังไม่ได้มี file dxf ต้องทำยังไง'.
  const waitingBanner = totalDxfs === 0 ? `
    <div class="cut-waiting">
      <div class="cut-waiting-icon">⏳</div>
      <div class="cut-waiting-body">
        <div class="cut-waiting-title">Waiting for DXFs</div>
        <div class="cut-waiting-text">
          The designer hasn't uploaded the laser-cut files for this project yet.
          You can see what's coming below — but you can't download or cut until DXFs land.
        </div>
        <div class="cut-waiting-hint">
          <strong>For the designer:</strong> open the Fusion file, run CC_Laser,
          then click <strong>📤 Save to Project</strong> in NestingTool to publish here.
        </div>
      </div>
    </div>` : (totalReady < aggregated.length ? `
    <div class="cut-waiting cut-waiting-partial">
      <div class="cut-waiting-icon">⏳</div>
      <div class="cut-waiting-body">
        <div class="cut-waiting-title">${aggregated.length - totalReady} of ${aggregated.length} parts still missing DXFs</div>
        <div class="cut-waiting-text">
          ${totalReady} parts are ready to cut — the rest are pending upload.
        </div>
      </div>
    </div>` : '');

  return `
    <div class="cut-list">
      <div class="cut-list-banner">
        <span class="cut-list-title">🔥 Cut List</span>
        <span class="cut-list-summary">${aggregated.length} unique · ${totalQty} pcs · 📐 ${totalReady}/${aggregated.length} parts have DXFs · ${totalDxfs} files uploaded</span>
      </div>
      ${waitingBanner}
      <div class="cut-sections">${sectionsHtml || '<div class="cut-empty">No parts in this project</div>'}</div>
      <div class="cut-list-actions">
        ${_canDownloadPartDxf()
          ? `<button id="cut-download-all-btn" class="action-btn cut-action" ${totalDxfs === 0 ? 'disabled' : ''}>⬇ Download all ${totalDxfs} DXFs</button>`
          : '<span class="cut-action-hint">View only — for laser cuts download from 📐 Cut Sheets above</span>'}
        <button id="cut-remnants-btn" class="action-btn cut-action">📦 Remnants Stock</button>
      </div>
    </div>`;
}

function _wireCutList(parts, projectKey) {
  // Row click → open DXF preview modal (single file) or per-part
  // popover (multi-file). Was 'immediate download' before; user
  // 2026-05-28 'กดเข้าไปแล้ว ดู dxf ไม่ได้' — they expect a preview.
  // Ordered list of codes with ≥1 DXF, in the on-screen row order — feeds
  // the preview modal's ↑/↓ part-cycling so the laser worker can browse
  // the whole cut list without re-clicking each row.
  const navCodes = [...ROOT.querySelectorAll('.cut-row')]
    .map(r => r.dataset.code)
    .filter(code => dxfsForMasterCode(code).length > 0);
  ROOT.querySelectorAll('.cut-row').forEach(row => {
    row.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const code = row.dataset.code;
      const dxfs = dxfsForMasterCode(code);
      if (dxfs.length === 0) {
        row.classList.add('cut-row-shake');
        setTimeout(() => row.classList.remove('cut-row-shake'), 400);
        return;
      }
      const navCtx = { codes: navCodes, code };
      if (dxfs.length === 1) {
        _renderDxfPreviewModal(dxfs[0], navCtx);
      } else {
        // Multi-DXF: still use the existing popover-of-files; user
        // picks one → that one opens in the preview modal (with nav).
        _renderDxfPopover(row, dxfs, (item) => _renderDxfPreviewModal(item, navCtx));
      }
    });
  });
  // 📍 part@sheet — locate this part on its saved nest sheet in a small
  // popup with a pulsing ring (user 2026-05-31 'cut list เพิ่ม icon part@sheet
  // สามารถกดดูได้ พร้อม effect'). stopPropagation so the row's DXF-preview
  // handler doesn't also fire.
  ROOT.querySelectorAll('.cut-sheet-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _renderSheetLocatorModal(btn.dataset.code, projectKey);
    });
  });
  // Status-pill click handler removed: the merged <button.cut-status.cut-ok>
  // is rendered inside the row, so its click bubbles up to the row's
  // handler above — same _renderDxfPreviewModal path, no duplicated logic.
  // The separate 👁 cut-view-btn was retired here too; one click target
  // per row.

  // If kdNest's grain.json fetch was still in flight when this row
  // batch rendered, the grain cells will all be ? — repaint once the
  // map lands so the badges flip to H/V/ANY. Bound ONCE per page
  // lifetime (flag never resets) so the callback can't chain into
  // an infinite render loop.
  if (window.kdNest && window.kdNest.grainReady && !window.__kdNestGrainBound) {
    window.__kdNestGrainBound = true;
    window.kdNest.grainReady.then(() => {
      try { render(); } catch (e) {}
    });
  }

  // Admin drag-drop for "NO DXF" rows. When Fusion's DXF Creator
  // exports under a leaf name (e.g. FN2BN0-000000.dxf) but the BOM
  // walk promotes the part to the wrapper code (FN2BNX-120000), the
  // wrapper row shows ⚠ NO DXF even though a DXF exists on disk. Admin
  // can drag the file straight onto the row to fix it without going
  // back into Fusion. Per user 2026-05-28: 'ให้ผมลากเข้ามาได้ไหม'.
  // We DON'T call getGitHubPat() here — it would prompt on every page
  // load. The prompt only fires when the user actually drops a file
  // (deferred to _uploadPartDxf). The affordance is offered regardless
  // of PAT state; first drop triggers the one-time setup prompt.
  if (isAdmin()) {
    ROOT.querySelectorAll('.cut-row.cut-row-missing').forEach(row => {
      row.classList.add('cut-row-droppable');
      const code = row.dataset.code;
      row.addEventListener('dragenter', ev => {
        ev.preventDefault();
        row.classList.add('cut-row-drag-over');
      });
      row.addEventListener('dragover', ev => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
      });
      row.addEventListener('dragleave', () => {
        row.classList.remove('cut-row-drag-over');
      });
      row.addEventListener('drop', async ev => {
        ev.preventDefault();
        ev.stopPropagation();
        row.classList.remove('cut-row-drag-over');
        const files = [...(ev.dataTransfer?.files || [])]
          .filter(f => /\.dxf$/i.test(f.name));
        if (files.length === 0) {
          alert('Drop a .dxf file onto this row.');
          return;
        }
        if (files.length > 1) {
          alert('Drop only one .dxf at a time.');
          return;
        }
        const file = files[0];
        const status = row.querySelector('.cut-status');
        const prevHtml = status ? status.outerHTML : '';
        if (status) {
          status.outerHTML = `<span class="cut-status cut-uploading">⏫ uploading…</span>`;
        }
        try {
          await _uploadPartDxf(projectKey, code, file);
          // RTDB listener will refresh the row on next render; show a
          // confirmation in place until that lands so user sees it
          // worked immediately. Use the same <button> shape as the main
          // render path so the placeholder looks/behaves consistently
          // until the listener-driven repaint lands.
          const fresh = row.querySelector('.cut-status');
          if (fresh) {
            fresh.outerHTML = `<button type="button" class="cut-status cut-ok" title="View DXF preview">📐 ready</button>`;
          }
          row.classList.remove('cut-row-missing', 'cut-row-droppable');
        } catch (e) {
          console.error('[cut-row drop] upload failed:', e);
          alert(`Upload failed for ${code}: ${e.message || e}`);
          const fresh = row.querySelector('.cut-status');
          if (fresh && prevHtml) fresh.outerHTML = prevHtml;
        }
      });
    });
  }

  // Remnants Stock — same shared modal the Nest workspace uses, reachable
  // here so the Laser worker can see + record offcuts without admin/nest
  // access (เอ๋ 2026-05-31 'ให้แสดงที่ User Laser ด้วย').
  ROOT.querySelector('#cut-remnants-btn')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (window.kdNest && typeof window.kdNest.openStock === 'function') {
      window.kdNest.openStock();
    } else {
      alert('Remnants stock unavailable — nest module not loaded.');
    }
  });

  // Download-all: fire one download per DXF, spaced 250 ms so the
  // browser doesn't dedupe.
  ROOT.querySelector('#cut-download-all-btn')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const dxfList = dxfsForProject(projectKey);
    dxfList.forEach((item, i) => {
      setTimeout(() => {
        _downloadFile(item.url, item.filename || `${item.stem}.dxf`);
      }, i * 250);
    });
  });
}

// 📍 Part@sheet locator — small popup that draws the saved nest sheet the
// part landed on, with a pulsing ring around its placement(s). Data comes
// from nest_jobs/<pk>/<jobId> (the only record that keeps per-sheet
// placements — nest_parts has just the parts list). Self-contained modal:
// backdrop click / ✕ / Escape all close it. (user 2026-05-31)
async function _renderSheetLocatorModal(code, projectKey) {
  // Build the shell first so the user gets instant feedback while we fetch.
  const back = document.createElement('div');
  back.className = 'cut-loc-back';
  back.innerHTML = `
    <div class="cut-loc-panel" role="dialog" aria-label="Part on sheet">
      <div class="cut-loc-head">
        <span class="cut-loc-title">📍 ${escapeHtml(code)}</span>
        <button type="button" class="cut-loc-close" title="Close">✕</button>
      </div>
      <div class="cut-loc-body"><div class="cut-loc-status">Loading sheet…</div></div>
    </div>`;
  document.body.appendChild(back);

  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { document.removeEventListener('keydown', onKey); back.remove(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  back.querySelector('.cut-loc-close').addEventListener('click', close);

  const body = back.querySelector('.cut-loc-body');
  const fail = (msg) => { body.innerHTML = `<div class="cut-loc-status">${escapeHtml(msg)}</div>`; };

  if (!window.firebaseDB) { fail('Not connected — nest data unavailable.'); return; }

  // Resolve the latest saved job → its per-sheet placements.
  let sheets = null;
  try {
    const partsSnap = await window.firebaseDB.ref(`nest_parts/${projectKey}`).once('value');
    const jobId = partsSnap.val() && partsSnap.val().jobId;
    if (jobId) {
      const jSnap = await window.firebaseDB.ref(`nest_jobs/${projectKey}/${jobId}`).once('value');
      sheets = jSnap.val() && jSnap.val().sheets;
    }
    if (!sheets) {
      // Fallback: newest job by saved_at.
      const allSnap = await window.firebaseDB.ref(`nest_jobs/${projectKey}`).once('value');
      const jobs = allSnap.val() || {};
      let best = null;
      Object.keys(jobs).forEach(k => {
        const j = jobs[k];
        if (j && j.sheets && (!best || (j.saved_at || '') > (best.saved_at || ''))) best = j;
      });
      sheets = best && best.sheets;
    }
  } catch (e) {
    fail('Could not load nest data: ' + (e.message || e));
    return;
  }

  if (!sheets || !sheets.length) {
    fail('No saved nest yet — run Nesting → Save Project first.');
    return;
  }

  // Which sheet is this part on?
  let sheetIdx = -1;
  for (let i = 0; i < sheets.length; i++) {
    if ((sheets[i].placements || []).some(pl => pl.code === code)) { sheetIdx = i; break; }
  }
  if (sheetIdx < 0) {
    fail('This part is not placed on any saved sheet (unplaced, or added after the last save).');
    return;
  }

  const sheet = sheets[sheetIdx];
  body.innerHTML = `
    <div class="cut-loc-meta">Sheet ${sheetIdx + 1} / ${sheets.length} · ${Math.round(sheet.sw)}×${Math.round(sheet.sh)} mm${sheet.thick ? ' · ' + sheet.thick + 'mm' : ''}</div>
    <div class="cut-loc-canvas-wrap"><canvas class="cut-loc-canvas"></canvas></div>`;
  const wrap = body.querySelector('.cut-loc-canvas-wrap');
  const canvas = body.querySelector('.cut-loc-canvas');
  // Defer a frame so the wrap has measured its width before we size+draw.
  requestAnimationFrame(() => _drawSheetLocator(wrap, canvas, sheet, code));
}

// Draws one sheet's placements as rectangles (bottom-left origin → canvas
// top-left, y-flipped to match the Nesting preview) and drops a pulsing CSS
// ring over every placement of `code`. Theme-aware fills like the Nest canvas.
function _drawSheetLocator(wrap, canvas, sheet, code) {
  const theme = document.documentElement.getAttribute('data-theme');
  const BG    = theme === 'sketch' ? '#efe7d6' : theme === 'chalk' ? '#26302e' : theme === 'obsidian' ? '#08090d' : '#0f1419';
  const INK   = theme === 'sketch' ? '#1b1815' : theme === 'chalk' ? '#f4f1e8' : theme === 'obsidian' ? '#e5c158' : '#cdd6e0';
  const FAINT = theme === 'sketch' ? 'rgba(27,24,21,0.30)' : theme === 'chalk' ? 'rgba(244,241,232,0.32)' : theme === 'obsidian' ? 'rgba(229,193,88,0.25)' : 'rgba(205,214,224,0.30)';
  const HOT   = theme === 'sketch' ? '#c0392b' : theme === 'chalk' ? '#ffd166' : theme === 'obsidian' ? '#ffffff' : '#4ecca3';

  const dpr = window.devicePixelRatio || 1;
  const cw = wrap.clientWidth || 320;
  const aspect = (sheet.sh || 1) / (sheet.sw || 1);
  const maxH = Math.min(window.innerHeight * 0.5, 460);
  let drawW = cw, drawH = cw * aspect;
  if (drawH > maxH) { drawH = maxH; drawW = maxH / aspect; }

  canvas.style.width = drawW + 'px';
  canvas.style.height = drawH + 'px';
  canvas.width = drawW * dpr;
  canvas.height = drawH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  ctx.fillStyle = BG; ctx.fillRect(0, 0, drawW, drawH);
  ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
  ctx.strokeRect(1, 1, drawW - 2, drawH - 2);

  const sx = drawW / (sheet.sw || 1);
  const sy = drawH / (sheet.sh || 1);
  const map = (x, y, w, h) => [x * sx, drawH - (y + h) * sy, w * sx, h * sy];  // flip Y

  const hotRects = [];
  (sheet.placements || []).forEach(pl => {
    // Footprint on the sheet swaps W/H for 90°/270° placements — same rule
    // _drawSheet uses, so the locator rect matches the Nesting preview.
    const rotated = (pl.rot === 90 || pl.rot === 270);
    const pw = rotated ? (pl.h || 0) : (pl.w || 0);
    const ph = rotated ? (pl.w || 0) : (pl.h || 0);
    const [rx, ry, rw, rh] = map(pl.x || 0, pl.y || 0, pw, ph);
    const isHot = pl.code === code;
    if (isHot) { ctx.fillStyle = HOT + '33'; ctx.fillRect(rx, ry, rw, rh); }
    ctx.strokeStyle = isHot ? HOT : FAINT;
    ctx.lineWidth = isHot ? 2 : 1;
    ctx.strokeRect(rx, ry, rw, rh);
    if (isHot) hotRects.push([rx, ry, rw, rh]);
  });

  // Pulsing ring(s) — CSS-animated divs positioned over the canvas, 3 pulses
  // then they settle invisible (the filled rect stays as the lasting marker).
  const ox = canvas.offsetLeft, oy = canvas.offsetTop;
  hotRects.forEach(([rx, ry, rw, rh]) => {
    const ring = document.createElement('div');
    ring.className = 'cut-loc-ring';
    const d = Math.max(rw, rh) + 16;
    ring.style.left = (ox + rx + rw / 2 - d / 2) + 'px';
    ring.style.top = (oy + ry + rh / 2 - d / 2) + 'px';
    ring.style.width = d + 'px';
    ring.style.height = d + 'px';
    ring.style.borderColor = HOT;
    wrap.appendChild(ring);
  });
}

// Upload a single per-part DXF the same way CC_Laser's dxf_uploader.py
// does: PUT to GitHub at Drawings/dxf/<code>/<code>.dxf (the path the
// drawings-ui Pages site resolves DXF URLs from) and set
// uploaded_dxfs/<code> in RTDB so the cut-list row flips to ✓ ready.
// Reuses the admin PAT, fileToBase64, and _ghContentsRequest helpers
// already used by the project-level cut-sheet drop zone.
async function _uploadPartDxf(projectKey, code, file) {
  const pat = getGitHubPat();
  if (!pat) throw new Error('GitHub PAT not set — open admin settings');
  const safeCode = encodeURIComponent(code);
  const repoPath = `Drawings/dxf/${safeCode}/${safeCode}.dxf`;
  const content = await fileToBase64(file);
  const resp = await _ghContentsRequest(repoPath, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Admin drop: upload DXF for ${code}`,
      content,
      branch: 'main',
    }),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`GitHub PUT ${resp.status}: ${errBody.slice(0, 200)}`);
  }
  const url = `${_CUT_SHEETS_GH_PUBLIC}/${repoPath}`;
  const metadata = {
    url,
    filename: `${code}.dxf`,
    master_code: code,
    project: projectKey,
    size_bytes: file.size,
    thickness_mm: 0,
    material: 'ALPF',
    grain: '',
    uploaded_at: Date.now(),
    uploaded_via: 'admin-drop',
    original_filename: file.name,
  };
  await window.firebaseDB.ref(`uploaded_dxfs/${code}`).set(metadata);
  return { code, url, metadata };
}

function _renderBendList(parts, projectKey) {
  const aggregated = _aggregatePartsByCode(parts);
  aggregated.sort((a, b) => a.code.localeCompare(b.code));
  const total = aggregated.length;
  const bentList = aggregated.filter(p => isBent(projectKey, p.code));
  const pct = total ? Math.round(bentList.length * 100 / total) : 0;

  const admin = isAdmin();
  const rows = aggregated.map(p => {
    const bent = isBent(projectKey, p.code);
    const fam = _remapFamilyForCode(p.code, p.family) || 'Other';
    // Bending workers need the part DRAWING (PDF) to read bend dims —
    // not the DXF. Resolve via pdfUrlForCode (auto_generated +
    // uploaded_pdfs cache + alias-prefix fallback). User 2026-05-28:
    // 'bending กดดู view pdf แต่ละ Part ได้'.
    const pdfHref = pdfUrlForCode(p.code) || '';
    const viewBtn = pdfHref
      ? `<button class="bend-view-btn" data-url="${escapeHtml(pdfHref)}" title="View bending drawing PDF">👁</button>`
      : `<button class="bend-view-btn" disabled title="No drawing PDF for this part yet">👁</button>`;
    // 💬 comments — reuse the shared per-part comment system (same as the
    // BOM row). Comments are global per part code (comments/<code>), so a
    // note left in bending is the same thread the assembler/admin sees.
    // (user 2026-05-29: 'เพิ่ม icon comments สำหรับงานพับ แต่ละตัว')
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
              ${admin ? `<button class="comment-del" data-code="${escapeHtml(p.code)}" data-id="${escapeHtml(c._key || String(c.time))}" aria-label="Delete">✕</button>` : ''}
            </li>`).join('') : '<li class="comment-empty">No comments yet</li>'}
        </ul>
        <form class="comment-input-wrap" data-code="${escapeHtml(p.code)}">
          <input class="comment-input" type="text" placeholder="พิมพ์ comment / type a note…" autocomplete="off">
          <button type="submit" class="comment-add">+ Add</button>
        </form>
      </div>` : '';
    return `
      <div class="bend-row ${bent ? 'is-bent' : ''} ${cOpen ? 'comments-open' : ''}" data-code="${escapeHtml(p.code)}" style="${famVars(fam)}">
        <span class="bend-icon">${familyIcon(fam)}</span>
        <span class="bend-code">${escapeHtml(p.code)}</span>
        <span class="bend-qty">× ${p.qty || 0}</span>
        ${viewBtn}
        <button class="comment-btn ${comments.length ? 'has-comments' : ''}" data-code="${escapeHtml(p.code)}" aria-label="Comments" title="Comments">💬${cBadgeHtml}</button>
        <button class="bend-toggle ${bent ? 'on' : ''}" data-code="${escapeHtml(p.code)}" aria-label="${bent ? 'Mark not bent' : 'Mark bent'}" title="${bent ? 'Mark not bent' : 'Mark bent'}">
          <span class="icon-bend"></span>
        </button>
      </div>
      ${commentsPanel}`;
  }).join('');

  return `
    <div class="bend-list">
      <div class="bend-list-banner">
        <span class="bend-list-title"><span class="icon-bend"></span> Bend List</span>
        <span class="bend-list-summary">${bentList.length}/${total} done · ${pct}%</span>
      </div>
      <div class="bend-rows">${rows || '<div class="bend-empty">No parts in this project</div>'}</div>
    </div>`;
}

function _wireBendList(parts, projectKey) {
  ROOT.querySelectorAll('.bend-toggle').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const code = btn.dataset.code;
      const currently = isBent(projectKey, code);
      markBent(projectKey, code, !currently);
      // Re-render so the row + banner counter update.
      render();
    });
  });
  // 👁 view bending drawing PDF — opens via _openInNewTab so iPad PWA
  // standalone gets same-window nav (window.open '_blank' silently
  // opens off-screen on standalone), browser gets a new tab.
  ROOT.querySelectorAll('.bend-view-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const url = btn.dataset.url;
      if (url) _openInNewTab(url);
    });
  });
  // 💬 Comment handlers — the bend path returns before renderProject's
  // shared comment wiring (~L5861), so wire the same 3 actions here.
  // Reuses the global comment helpers; render() re-renders the bend list.
  ROOT.querySelectorAll('.comment-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleCommentsOpen(btn.dataset.code);
      render();
    });
  });
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
}


// ── Cut Sheets modal ─────────────────────────────────────────────────
// Top-level project DXFs are NESTED cut layouts, not per-part files.
// Modal shows: list of sheets (filename, thickness, parts_count,
// uploaded_at), per-row download. Admin extras: drag-drop area to
// add new sheets + per-row delete.

const _CUT_SHEETS_REPO_PATH = 'CutSheets';   // GitHub path prefix
const _CUT_SHEETS_GH_PUBLIC = 'https://raw.githubusercontent.com/wuttichaisaeton/kitchen-drawings-rd2026/main';

function _renderCutSheetsModal(triggerBtn, projectKey, project) {
  document.querySelectorAll('.part-dxf-popover').forEach(p => p.remove());

  const sheets = cutSheetsForProject(projectKey);
  const projectName = (project && project.name) || projectKey;
  const adminMode = isAdmin();

  const rowsHtml = sheets.length
    ? sheets.map(s => {
        const filename = s.filename || `${s.id}.dxf`;
        const thMm = s.thickness_mm ? `${s.thickness_mm}mm` : '?mm';
        const parts = s.parts_count ? `${s.parts_count} parts` : '?';
        const sz = (s.sheet_w_mm && s.sheet_h_mm) ? `${s.sheet_w_mm}×${s.sheet_h_mm}mm` : '';
        const ago = _formatTimeAgo(s.uploaded_at) || '';
        const via = s.uploaded_via ? ` · via ${escapeHtml(s.uploaded_via)}` : '';
        const partsSummary = Array.isArray(s.parts) && s.parts.length
          ? s.parts.map(pt => `${escapeHtml(pt.code)}×${pt.qty || 1}`).join(', ')
          : '';
        return `
          <div class="cs-row" data-id="${escapeHtml(s.id)}" data-url="${escapeHtml(s.url || '')}" data-filename="${escapeHtml(filename)}">
            <div class="cs-row-main">
              <span class="cs-filename">${escapeHtml(filename)}</span>
              <span class="cs-meta">${thMm} · ${parts}${sz ? ' · ' + sz : ''}</span>
              <span class="cs-sub">${escapeHtml(ago)}${via}</span>
              ${partsSummary ? `<span class="cs-parts" title="Parts on this sheet">${partsSummary}</span>` : ''}
            </div>
            <button class="cs-download-btn" data-action="download">⬇</button>
            ${adminMode ? `<button class="cs-delete-btn" data-action="delete" title="Delete cut sheet">✕</button>` : ''}
          </div>`;
      }).join('')
    : '<div class="cs-empty">No cut sheets uploaded yet. ' +
      (adminMode
        ? 'Drag a .dxf file into the area below — or run NestingTool → Save sheets to Laser.'
        : 'Waiting for the designer to upload nested cut sheets.') +
      '</div>';

  const pop = document.createElement('div');
  pop.className = 'part-dxf-popover cs-modal';
  pop.setAttribute('role', 'menu');
  pop.innerHTML = `
    <div class="pdxf-header">
      <div class="pdxf-title">📐 Cut Sheets — ${escapeHtml(projectName)}</div>
      <div class="pdxf-sub">${sheets.length} sheet${sheets.length === 1 ? '' : 's'} uploaded</div>
    </div>
    <div class="cs-body">${rowsHtml}</div>
    ${adminMode ? `
    <div class="cs-dropzone" id="cs-dropzone">
      <span class="cs-dropzone-icon">📥</span>
      <span class="cs-dropzone-text">Drop .dxf files here to add a cut sheet</span>
      <input type="file" id="cs-file-input" accept=".dxf" multiple style="display:none">
      <button class="cs-browse-btn" id="cs-browse-btn">or browse…</button>
    </div>` : ''}
  `;
  document.body.appendChild(pop);

  const r = triggerBtn.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top    = (r.bottom + 4) + 'px';
  pop.style.right  = (window.innerWidth - r.right) + 'px';
  pop.style.maxHeight = `${Math.max(360, window.innerHeight - r.bottom - 20)}px`;
  pop.style.overflowY = 'auto';

  let close;

  // Row click → download (anywhere except buttons)
  pop.querySelectorAll('.cs-row').forEach(row => {
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('.cs-delete-btn')) return;  // delete handled separately
      ev.stopPropagation();
      _downloadFile(row.dataset.url, row.dataset.filename);
    });
  });

  // Admin: delete handler
  if (adminMode) {
    pop.querySelectorAll('.cs-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const row = btn.closest('.cs-row');
        if (!row) return;
        if (!confirm(`Delete cut sheet "${row.dataset.filename}"?\n\nThis removes the RTDB entry; the GitHub file is left in the repo as an archive.`)) return;
        const id = row.dataset.id;
        try {
          await window.firebaseDB.ref(`cut_sheets/${projectKey}/${id}`).remove();
          row.remove();
        } catch (e) {
          alert(`Delete failed: ${e.message || e}`);
        }
      });
    });

    // Drag-drop + browse
    const zone = pop.querySelector('#cs-dropzone');
    const fileInput = pop.querySelector('#cs-file-input');
    const browseBtn = pop.querySelector('#cs-browse-btn');
    if (zone && fileInput) {
      const onFiles = async (files) => {
        for (const f of files) {
          if (!/\.dxf$/i.test(f.name)) {
            alert(`Skipped "${f.name}" — only .dxf files accepted.`);
            continue;
          }
          zone.classList.add('cs-uploading');
          zone.querySelector('.cs-dropzone-text').textContent = `Uploading ${f.name}…`;
          try {
            await _uploadCutSheet(projectKey, f);
          } catch (e) {
            alert(`Upload failed for ${f.name}: ${e.message || e}`);
          }
          zone.classList.remove('cs-uploading');
          zone.querySelector('.cs-dropzone-text').textContent = 'Drop .dxf files here to add a cut sheet';
        }
        // Re-open modal to reflect new sheets
        if (close) close();
        setTimeout(() => triggerBtn.click(), 100);
      };
      zone.addEventListener('dragover', (ev) => { ev.preventDefault(); zone.classList.add('cs-drag-over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('cs-drag-over'));
      zone.addEventListener('drop', (ev) => {
        ev.preventDefault();
        zone.classList.remove('cs-drag-over');
        onFiles(ev.dataTransfer.files);
      });
      browseBtn?.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => onFiles(fileInput.files));
    }
  }

  setTimeout(() => {
    close = () => {
      pop.remove();
      document.removeEventListener('click',   dismiss, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll',    onScroll, true);
    };
    const dismiss  = (ev) => {
      // Don't dismiss when interacting with drag/drop or file picker.
      if (!pop.contains(ev.target)) close();
    };
    const onKey    = (ev) => { if (ev.key === 'Escape') close(); };
    const onScroll = () => {};   // don't auto-close on scroll inside modal
    document.addEventListener('click',   dismiss, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll',    onScroll, true);
  }, 0);

  return pop;
}

// Upload a single cut sheet — GitHub Contents API + RTDB metadata.
// Naming: timestamped path so re-uploading same name doesn't collide.
async function _uploadCutSheet(projectKey, file) {
  const pat = getGitHubPat();
  if (!pat) throw new Error('GitHub PAT not set');

  // Timestamp-based id + filename. Format: 2026-05-28_15-30-45
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const safeProject = projectKey.replace(/[^A-Za-z0-9._-]+/g, '_');
  const id = `${safeProject}_${ts}`;
  const filename = `${safeProject}_${ts}.dxf`;
  const path = `${_CUT_SHEETS_REPO_PATH}/${encodeURIComponent(safeProject)}/${id}.dxf`;

  const content = await fileToBase64(file);
  const resp = await _ghContentsRequest(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Cut sheet: ${filename}`,
      content,
      branch: 'main',
    }),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`GitHub PUT failed ${resp.status}: ${errBody.slice(0, 200)}`);
  }
  const url = `${_CUT_SHEETS_GH_PUBLIC}/${path}`;
  const meta = {
    url,
    filename,
    thickness_mm: 0,        // unknown for admin drops; NestingTool sets this
    parts_count: 0,         // ditto
    sheet_w_mm: 0,
    sheet_h_mm: 0,
    uploaded_at: Date.now(),
    uploaded_via: 'admin-drop',
    original_filename: file.name,
    size_bytes: file.size,
  };
  await window.firebaseDB.ref(`cut_sheets/${projectKey}/${id}`).set(meta);
  return { id, url, meta };
}

function _renderProjectDxfModal(triggerBtn, projectKey, project, parts) {
  document.querySelectorAll('.part-dxf-popover').forEach(p => p.remove());

  const ps = (parts || []).filter(p => p && p.code);
  const totalQty = ps.reduce((s, p) => s + (p.qty || 0), 0);
  const dxfList = dxfsForProject(projectKey);
  const projectName = (project && project.name) || projectKey;

  // Build a per-part lookup of which DXFs cover that master_code so the
  // body rows can show status + ferry a download URL per row.
  const partRows = ps.map(p => {
    const dxfs = dxfsForMasterCode(p.code);
    const status = dxfs.length === 0
      ? `<span class="pdxf-status pdxf-none" title="No DXF uploaded">⚠ no DXF</span>`
      : `<span class="pdxf-status pdxf-ok" title="${dxfs.length} DXF file${dxfs.length === 1 ? '' : 's'} available">📐 ${dxfs.length}</span>`;
    return `
      <button class="pdxf-row" role="menuitem"
              data-code="${escapeHtml(p.code)}"
              ${dxfs.length === 0 ? 'disabled' : ''}>
        <span class="pdxf-code">${escapeHtml(p.code)}</span>
        <span class="pdxf-qty">× ${p.qty || 0}</span>
        ${status}
      </button>`;
  }).join('');

  const pop = document.createElement('div');
  pop.className = 'part-dxf-popover pdxf-project-modal';
  pop.setAttribute('role', 'menu');
  pop.innerHTML = `
    <div class="pdxf-header">
      <div class="pdxf-title">📐 ${escapeHtml(projectName)}</div>
      <div class="pdxf-sub">${ps.length} unique part${ps.length === 1 ? '' : 's'} · ${totalQty} pcs to cut · ${dxfList.length} DXF file${dxfList.length === 1 ? '' : 's'} uploaded</div>
    </div>
    <div class="pdxf-body">${partRows || '<div class="pdxf-empty">No parts in this project</div>'}</div>
    ${dxfList.length > 0 ? `
    <div class="pdxf-footer">
      <button class="pdxf-all-btn" data-action="download-all">⬇ Download all ${dxfList.length} DXF${dxfList.length === 1 ? '' : 's'}</button>
    </div>` : `
    <div class="pdxf-footer pdxf-footer-empty">
      No DXFs uploaded yet — run NestingTool → 📤 Save to Project.
    </div>`}
  `;
  document.body.appendChild(pop);

  // Position below the button, right-aligned. Cap height so long
  // project BOMs don't overflow the viewport.
  const r = triggerBtn.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top    = (r.bottom + 4) + 'px';
  pop.style.right  = (window.innerWidth - r.right) + 'px';
  pop.style.maxHeight = `${Math.max(280, window.innerHeight - r.bottom - 20)}px`;
  pop.style.overflowY = 'auto';

  let close;

  // Per-part row click → download DXF(s) for that master_code.
  pop.querySelectorAll('.pdxf-row').forEach(row => {
    row.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const code = row.dataset.code;
      const dxfs = dxfsForMasterCode(code);
      if (dxfs.length === 0) return;
      if (dxfs.length === 1) {
        _downloadFile(dxfs[0].url, dxfs[0].filename || `${dxfs[0].stem}.dxf`);
      } else {
        // For multi-DXF, kick the existing per-part popover via a
        // temporary anchor — anchor on this row so it appears next to it.
        _renderDxfPopover(row, dxfs);
      }
      if (close) close();
    });
  });

  // Download-all button — iterates project DXFs and triggers a download
  // for each. Browsers may dedupe consecutive downloads, so we space
  // them with a tiny delay to give each one a chance to register.
  const allBtn = pop.querySelector('.pdxf-all-btn');
  if (allBtn) {
    allBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      dxfList.forEach((item, i) => {
        setTimeout(() => {
          _downloadFile(item.url, item.filename || `${item.stem}.dxf`);
        }, i * 250);
      });
      if (close) close();
    });
  }

  setTimeout(() => {
    close = () => {
      pop.remove();
      document.removeEventListener('click',   dismiss, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll',    onScroll, true);
    };
    const dismiss  = (ev) => { if (!pop.contains(ev.target)) close(); };
    const onKey    = (ev) => { if (ev.key === 'Escape') close(); };
    const onScroll = () => close();
    document.addEventListener('click',   dismiss, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll',    onScroll, true);
  }, 0);

  return pop;
}

// Build a DXF popover anchored below the trigger button. Reusable across
// the Library family view (per-master 📐 button) and the Project view
// (project-wide 📐 DXFs button). Auto-dismissed by outside-click,
// Escape, or scroll — every close path runs the same teardown so no
// orphan document listeners are ever left behind.
function _renderDxfPopover(triggerBtn, list, onSelect) {
  // Only one popover open at a time — remove any prior one first.
  document.querySelectorAll('.part-dxf-popover').forEach(p => p.remove());

  // onSelect(item): optional callback fired when a row is clicked.
  // Defaults to immediate download for back-compat with the Library
  // view's per-master 📐 button. Cut List passes a callback that
  // opens the new DXF preview modal instead.
  const handler = typeof onSelect === 'function'
    ? onSelect
    : (item) => _downloadFile(item.url, item.filename || (item.stem + '.dxf'));

  const pop = document.createElement('div');
  pop.className = 'part-dxf-popover';
  pop.setAttribute('role', 'menu');
  pop.innerHTML = list.map((item, idx) => `
    <button class="part-dxf-popover-row" data-idx="${idx}" data-dxf-name="${escapeHtml(item.filename || item.stem + '.dxf')}" role="menuitem">
      <span class="part-dxf-popover-icon">📐</span>
      <span class="part-dxf-popover-name">${escapeHtml(item.filename || item.stem + '.dxf')}</span>
    </button>
  `).join('');

  document.body.appendChild(pop);

  // Position below the button, right-aligned to the trigger.
  const r = triggerBtn.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top   = (r.bottom + 4) + 'px';
  pop.style.right = (window.innerWidth - r.right) + 'px';

  // Shared teardown — declared up-front so the row-click closure can
  // call it before the setTimeout-bound dismiss handlers ever run.
  let close;

  pop.querySelectorAll('.part-dxf-popover-row').forEach(row => {
    row.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const item = list[parseInt(row.dataset.idx, 10)];
      if (item) handler(item);
      if (close) close(); else pop.remove();
    });
  });

  // Attach dismiss handlers on next tick so the opening click doesn't
  // bubble up and immediately close the popover it just opened.
  setTimeout(() => {
    close = () => {
      pop.remove();
      document.removeEventListener('click',   dismiss, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll',    onScroll, true);
    };
    const dismiss  = (ev) => { if (!pop.contains(ev.target)) close(); };
    const onKey    = (ev) => { if (ev.key === 'Escape') close(); };
    const onScroll = () => close();
    document.addEventListener('click',   dismiss, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll',    onScroll, true);
  }, 0);

  return pop;
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
//   • Old "Drawer" family + code prefix DSV1xx → DW-S1
//   • Old "Drawer" family + code prefix DSV2xx → DW-S2
//   • Old "Drawer" family + anything else      → DW-S1 (default bucket)
//   • Old "Back-Down" → DW-BK
//   • Old "Floor"     → DW-FL
//   • Everything else: keep as-is
// ──────────────────────────────────────────────────────────────────────

function _remapFamilyForCode(code, originalFamily) {
  const upper = (code || '').toUpperCase();
  const prefix2 = upper.slice(0, 2);

  // ─── Prefix-first hard rules (override Fusion's family classifier) ──
  // Some prefixes ALWAYS belong to a specific Library chip regardless
  // of how the Fusion-side family classifier tagged them.
  //
  // FN / FC → "FL" (standalone floor beams / rails)
  //   Per user 2026-05-24: "FN FC ให้ อยู่ในโฟลเดอร์นี้"
  if (prefix2 === 'FN' || prefix2 === 'FC') return 'FL';

  // BK → standalone "BK" chip (mirrors the FN/FC → FL precedent)
  //   Per user 2026-05-25: BK1DN1, BK2TR1, BK0DN0, BK-XXXX legacy etc.
  //   all want their own Library chip instead of being lumped under DW-BK.
  if (prefix2 === 'BK') return 'BK';

  // ─── Family-based rules ──────────────────────────────────────────
  if (originalFamily === 'Back-Down') return 'DW-BK';
  if (originalFamily === 'Floor')     return 'DW-FL';  // DSB0F-* etc.
  if (originalFamily === 'Drawer') {
    const prefix4 = upper.slice(0, 4);
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

// ── Pinned projects + manual order (Firebase-synced) ───────────────
// Pinned projects float to the top of the projects list (above non-
// pinned active projects). Manual order from drag-and-drop overrides
// default updated_at sort within each pinned/active/completed band.
//
// Both pieces of state are SHARED across devices via Firebase Realtime
// Database — that way the workshop iPad (non-admin) sees the same
// favourites & queue order the owner curated on the laptop. Falls back
// to localStorage when Firebase is unavailable.
//
// Firebase shapes:
//   pinned_projects/<projectKey> = true
//   project_order = ["key1", "key2", ...]
let _pinnedCache = new Set();
let _projectOrderCache = [];

function initPinnedSync() {
  // Seed from localStorage so first paint isn't empty.
  try {
    const raw = localStorage.getItem(LS_PINNED_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) _pinnedCache = new Set(arr);
    }
  } catch {}
  try {
    const raw = localStorage.getItem(LS_PROJECT_ORDER_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) _projectOrderCache = arr;
    }
  } catch {}
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('pinned_projects').on('value', snap => {
      const raw = snap.val() || {};
      _pinnedCache = new Set(Object.keys(raw).filter(k => !!raw[k]));
      try { localStorage.setItem(LS_PINNED_KEY, JSON.stringify([..._pinnedCache])); } catch {}
      try { render(); } catch {}
    });
    window.firebaseDB.ref('project_order').on('value', snap => {
      const arr = snap.val();
      _projectOrderCache = Array.isArray(arr) ? arr : [];
      try { localStorage.setItem(LS_PROJECT_ORDER_KEY, JSON.stringify(_projectOrderCache)); } catch {}
      try { render(); } catch {}
    });
  } catch (e) {
    console.warn('Firebase pinned/order listener failed:', e);
  }
}

function loadPinnedSet() { return new Set(_pinnedCache); }
function isPinned(key) { return _pinnedCache.has(key); }

function togglePinned(key) {
  if (_pinnedCache.has(key)) _pinnedCache.delete(key);
  else _pinnedCache.add(key);
  // Persist locally + push to Firebase if available.
  try { localStorage.setItem(LS_PINNED_KEY, JSON.stringify([..._pinnedCache])); } catch {}
  if (window.firebaseDB) {
    try {
      window.firebaseDB.ref('pinned_projects/' + key)
        .set(_pinnedCache.has(key) ? true : null);
    } catch (e) { console.warn('Firebase pin write failed:', e); }
  }
}

function loadProjectOrder() { return _projectOrderCache.slice(); }

function saveProjectOrder(arr) {
  _projectOrderCache = Array.isArray(arr) ? arr.slice() : [];
  try { localStorage.setItem(LS_PROJECT_ORDER_KEY, JSON.stringify(_projectOrderCache)); } catch {}
  if (window.firebaseDB) {
    try { window.firebaseDB.ref('project_order').set(_projectOrderCache); }
    catch (e) { console.warn('Firebase order write failed:', e); }
  }
}

// ── Library family chips: custom labels + order (Firebase-synced) ──
// Admin renames + drags chips. Everyone (workshop iPad too) sees the
// shared state via Firebase listener. Pattern mirrors pin/order.
let _familyLabelsCache = {};
let _familyOrderCache = [];
// display_overrides — admin-edited display label per part code. Use case:
// Fusion side emitted "BM0IN0-080000" but admin typed it wrong; should
// read "BM1N00-080000" in Library. The original code stays as the data
// key (so PDF lookup / RTDB references continue to work); only what the
// user SEES changes. RTDB-synced so all devices share the same fixes.
let _displayOverridesCache = {};
// family_overrides — admin-moved parts to custom folders. Use case:
// Fusion classifier dumps unknown codes into the "Other" bucket, but
// admin (who knows what they actually are) wants to file them into a
// custom folder. Typing a new folder name creates it on the fly —
// renderLibraryHome groups by family, so any family with ≥1 part shows
// as a chip in the home grid. RTDB-synced so workshop sees the same.
let _familyOverridesCache = {};
// custom_folders — admin-created empty folders. Without this list, an
// empty folder would disappear from the Library home grid as soon as
// the last part is moved out. Admin can pre-create folder names so the
// taxonomy is fixed before parts arrive.
let _customFoldersCache = [];

function initFamilyChipSync() {
  try {
    const r = localStorage.getItem(LS_FAMILY_LABELS_KEY);
    if (r) { const o = JSON.parse(r); if (o && typeof o === 'object') _familyLabelsCache = o; }
  } catch {}
  try {
    const r = localStorage.getItem(LS_FAMILY_ORDER_KEY);
    if (r) { const a = JSON.parse(r); if (Array.isArray(a)) _familyOrderCache = a; }
  } catch {}
  try {
    const r = localStorage.getItem(LS_DISPLAY_OVERRIDES_KEY);
    if (r) { const o = JSON.parse(r); if (o && typeof o === 'object') _displayOverridesCache = o; }
  } catch {}
  try {
    const r = localStorage.getItem(LS_FAMILY_OVERRIDES_KEY);
    if (r) { const o = JSON.parse(r); if (o && typeof o === 'object') _familyOverridesCache = o; }
  } catch {}
  try {
    const r = localStorage.getItem(LS_CUSTOM_FOLDERS_KEY);
    if (r) { const a = JSON.parse(r); if (Array.isArray(a)) _customFoldersCache = a; }
  } catch {}
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('family_labels').on('value', snap => {
      const raw = snap.val();
      _familyLabelsCache = (raw && typeof raw === 'object') ? raw : {};
      try { localStorage.setItem(LS_FAMILY_LABELS_KEY, JSON.stringify(_familyLabelsCache)); } catch {}
      try { render(); } catch {}
    });
    window.firebaseDB.ref('family_order').on('value', snap => {
      const arr = snap.val();
      _familyOrderCache = Array.isArray(arr) ? arr : [];
      try { localStorage.setItem(LS_FAMILY_ORDER_KEY, JSON.stringify(_familyOrderCache)); } catch {}
      try { render(); } catch {}
    });
    window.firebaseDB.ref('display_overrides').on('value', snap => {
      const raw = snap.val();
      _displayOverridesCache = (raw && typeof raw === 'object') ? raw : {};
      try { localStorage.setItem(LS_DISPLAY_OVERRIDES_KEY, JSON.stringify(_displayOverridesCache)); } catch {}
      try { render(); } catch {}
    });
    window.firebaseDB.ref('family_overrides').on('value', snap => {
      const raw = snap.val();
      _familyOverridesCache = (raw && typeof raw === 'object') ? raw : {};
      try { localStorage.setItem(LS_FAMILY_OVERRIDES_KEY, JSON.stringify(_familyOverridesCache)); } catch {}
      try { render(); } catch {}
    });
    window.firebaseDB.ref('custom_folders').on('value', snap => {
      const raw = snap.val();
      _customFoldersCache = Array.isArray(raw) ? raw : [];
      try { localStorage.setItem(LS_CUSTOM_FOLDERS_KEY, JSON.stringify(_customFoldersCache)); } catch {}
      try { render(); } catch {}
    });
  } catch (e) {
    console.warn('Firebase family-chip listener failed:', e);
  }
}

function familyDisplayLabel(famKey) {
  return _familyLabelsCache[famKey] || famKey;
}

function setFamilyLabel(famKey, label) {
  const trimmed = (label || '').trim();
  if (trimmed) _familyLabelsCache[famKey] = trimmed;
  else delete _familyLabelsCache[famKey];
  try { localStorage.setItem(LS_FAMILY_LABELS_KEY, JSON.stringify(_familyLabelsCache)); } catch {}
  if (window.firebaseDB) {
    try {
      window.firebaseDB.ref('family_labels/' + famKey)
        .set(trimmed ? trimmed : null);
    } catch (e) { console.warn('Firebase label write failed:', e); }
  }
}

// displayCodeFor — admin's display-override for a part code. The original
// code remains the underlying data key (PDF lookup, RTDB, BOM cross-refs);
// only the user-visible label changes. Returns the original code when no
// override is set. See _displayOverridesCache for the storage rationale.
function displayCodeFor(code) {
  if (!code) return code;
  return _displayOverridesCache[code] || code;
}

function setDisplayOverride(code, label) {
  if (!code) return;
  const trimmed = (label || '').trim();
  // Empty label OR a label that matches the original = remove the override
  // (workshop sees the original code again).
  const useOverride = trimmed && trimmed !== code;
  if (useOverride) _displayOverridesCache[code] = trimmed;
  else delete _displayOverridesCache[code];
  try { localStorage.setItem(LS_DISPLAY_OVERRIDES_KEY, JSON.stringify(_displayOverridesCache)); } catch {}
  if (window.firebaseDB) {
    try {
      window.firebaseDB.ref('display_overrides/' + code)
        .set(useOverride ? trimmed : null);
    } catch (e) { console.warn('Firebase display_override write failed:', e); }
  }
}

// effectiveFamily — admin's per-code folder assignment overrides
// whatever Fusion + _remapFamilyForCode decided. If no override set,
// returns the fallback (caller passes the post-remap family).
function effectiveFamily(code, fallback) {
  if (code && _familyOverridesCache[code]) return _familyOverridesCache[code];
  return fallback || 'Other';
}

function setFamilyOverride(code, family) {
  if (!code) return;
  const trimmed = (family || '').trim();
  if (trimmed) _familyOverridesCache[code] = trimmed;
  else delete _familyOverridesCache[code];
  try { localStorage.setItem(LS_FAMILY_OVERRIDES_KEY, JSON.stringify(_familyOverridesCache)); } catch {}
  if (window.firebaseDB) {
    try {
      window.firebaseDB.ref('family_overrides/' + code).set(trimmed ? trimmed : null);
    } catch (e) { console.warn('Firebase family_override write failed:', e); }
  }
}

// addCustomFolder / removeCustomFolder — manage the pre-created empty
// folder list. renderLibraryHome merges this list with the parts-derived
// family keys so admin can establish a folder taxonomy before any parts
// land in those folders. Folder names are case-preserving and unique.
function addCustomFolder(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return;
  if (_customFoldersCache.includes(trimmed)) return;  // already exists
  _customFoldersCache = [..._customFoldersCache, trimmed];
  try { localStorage.setItem(LS_CUSTOM_FOLDERS_KEY, JSON.stringify(_customFoldersCache)); } catch {}
  if (window.firebaseDB) {
    try { window.firebaseDB.ref('custom_folders').set(_customFoldersCache); }
    catch (e) { console.warn('Firebase custom_folders write failed:', e); }
  }
}

function removeCustomFolder(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return;
  const before = _customFoldersCache.length;
  _customFoldersCache = _customFoldersCache.filter(f => f !== trimmed);
  if (_customFoldersCache.length === before) return;
  try { localStorage.setItem(LS_CUSTOM_FOLDERS_KEY, JSON.stringify(_customFoldersCache)); } catch {}
  if (window.firebaseDB) {
    try { window.firebaseDB.ref('custom_folders').set(_customFoldersCache); }
    catch (e) { console.warn('Firebase custom_folders write failed:', e); }
  }
}

function loadFamilyOrder() { return _familyOrderCache.slice(); }

function saveFamilyOrder(arr) {
  _familyOrderCache = Array.isArray(arr) ? arr.slice() : [];
  try { localStorage.setItem(LS_FAMILY_ORDER_KEY, JSON.stringify(_familyOrderCache)); } catch {}
  if (window.firebaseDB) {
    try { window.firebaseDB.ref('family_order').set(_familyOrderCache); }
    catch (e) { console.warn('Firebase family_order write failed:', e); }
  }
}

// ── Uploaded PDFs (GitHub commits + Realtime DB metadata) ───────────
// Admin drag-drops a PDF onto a family chip → committed via the GitHub
// Contents API to drawings-ui/Drawings/manual/<code>.pdf on main, then a
// metadata entry pushed to uploaded_pdfs/<code> in Realtime DB so every
// device picks it up. The committed file is served by GitHub Pages
// (~1 min after commit) at the corresponding public URL.
//
// Read shape: uploaded_pdfs/<code> = { url, family, filename, size, uploaded_at }
// pdfUrlForCode and partsByFamily honour this cache so uploaded PDFs
// render as drawn parts alongside the CC_DrawingPDF-exported ones.
//
// Auth: a fine-grained PAT (repo: kitchen-drawings-rd2026, Contents:
// Read+Write) is stored per-device in localStorage["kd_github_pat_v1"].
// First upload prompts for it. Reset with `:reset-pat` in the search bar.

const GH_OWNER = 'wuttichaisaeton';
const GH_REPO = 'kitchen-drawings-rd2026';
const GH_BRANCH = 'main';
const GH_UPLOAD_PATH = 'Drawings/manual';  // repo-relative; Pages serves from repo root
const GH_PUBLIC_BASE = `https://${GH_OWNER}.github.io/${GH_REPO}/Drawings/manual/`;
const LS_GITHUB_PAT_KEY = 'kd_github_pat_v1';

let _uploadedPdfsCache = {};

// ── Uploaded DXF cache (admin-only, mirrors uploaded_pdfs pattern) ──
// Keyed by <dxf_stem> (per-panel). Each value carries a `master_code`
// field that ties it to a Library row's data-code. Multi-panel masters
// have N entries — see dxfsForMasterCode() below for the lookup.
let _uploadedDxfsCache = {};

// ── Active configuration rows mirrored from Fusion ──────────────────
// Pushed by CC_SyncOccNames add-in every time the user clicks a row in
// a wrapper file's Configuration table. Shape:
//   active_rows/<projectKey>/current = "<row_name>"   (string)
// The web UI shows a small "Active in Fusion" badge on the project
// view when there's a matching entry — handy for the workshop to see
// what variant the designer is currently working on.
let _activeRowsCache = {};

function initActiveRowsSync() {
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('active_rows').on('value', snap => {
      _activeRowsCache = snap.val() || {};
      // Only repaint the active-variant badge — full re-render is
      // overkill for what's a tiny indicator change.
      try { updateActiveVariantBadge(); } catch {}
    });
  } catch (e) {
    console.warn('Firebase active_rows listener failed:', e);
  }
}

function getActiveRowForProject(projectKey) {
  if (!projectKey) return '';
  const entry = _activeRowsCache[projectKey];
  if (!entry) return '';
  // Stored as { current: "<row>" } OR directly as a string for back-compat.
  if (typeof entry === 'string') return entry;
  return entry.current || '';
}

// Full RTDB object for a project key — { current, urn, dataFileName,
// row_changed_at, last_saved_at, last_saved_row, ... } or {} when
// nothing's been pushed. Used by the badge for click-to-open (needs
// urn) + saved-ago footer (needs last_saved_at).
function getActiveRowDataForProject(projectKey) {
  if (!projectKey) return {};
  const entry = _activeRowsCache[projectKey];
  if (!entry) return {};
  if (typeof entry === 'string') return { current: entry };
  return entry;
}

// Human-readable "Nm ago" formatter for last_saved_at. Kept short so
// the badge stays compact in the action row.
function _formatTimeAgo(msEpoch) {
  if (!msEpoch) return '';
  const diff = Date.now() - msEpoch;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

// Click handler — fires the local Fusion bridge to open the wrapper
// file behind the active row. Same /open?urn= endpoint the mindmap
// leaf-click flow uses.
async function _onActiveVariantBadgeClick(ev) {
  ev.stopPropagation();
  const badge = ev.currentTarget;
  const urn = badge.getAttribute('data-urn') || '';
  if (!urn) {
    badge.classList.add('badge-shake');
    setTimeout(() => badge.classList.remove('badge-shake'), 400);
    return;
  }
  try {
    const r = await fetch(
      `http://127.0.0.1:8765/open?urn=${encodeURIComponent(urn)}`,
      { method: 'GET', mode: 'cors' });
    if (!r.ok) throw new Error(`bridge HTTP ${r.status}`);
  } catch (e) {
    badge.classList.add('badge-shake');
    setTimeout(() => badge.classList.remove('badge-shake'), 400);
    console.warn('Active-in-Fusion bridge open failed:', e);
  }
}

function updateActiveVariantBadge() {
  const badge = document.getElementById('active-variant-badge');
  if (!badge) return;
  const top = stack[stack.length - 1] || {};
  if (top.kind !== 'project') {
    badge.style.display = 'none';
    return;
  }

  // Two-level lookup so an active row pushed under a SUB-PROJECT
  // (variant_root, e.g. '10WVON-08OLOR') still surfaces on the umbrella
  // project's page (e.g. 'Bung 01'). Why this exists: the user observed
  // 2026-05-28 that the badge worked when viewing 10WVON-08OLOR but
  // didn't appear on Bung 01 because CC_SyncOccNames pushes under the
  // open document's name, not the umbrella file's. Falling back to the
  // project's parts[].variant_root set bridges the two views.
  let data = getActiveRowDataForProject(top.name);
  if (!data.current) {
    const project = (manifest.projects || {})[top.name];
    if (project && Array.isArray(project.parts)) {
      const variants = [];
      const seen = new Set();
      for (const p of project.parts) {
        if (p && p.variant_root && !seen.has(p.variant_root)) {
          seen.add(p.variant_root);
          variants.push(p.variant_root);
        }
      }
      // First variant with an active row wins (insertion order, stable
      // across reloads since parts[] order is stable).
      for (const vr of variants) {
        const vd = getActiveRowDataForProject(vr);
        if (vd.current) { data = vd; break; }
      }
    }
  }

  const active = data.current || '';
  if (!active) {
    badge.style.display = 'none';
    return;
  }

  let label = `● Active in Fusion: ${active}`;
  const savedAgo = _formatTimeAgo(data.last_saved_at);
  if (savedAgo) label += ` · saved ${savedAgo}`;
  badge.textContent = label;
  badge.style.display = '';
  badge.setAttribute('data-urn', data.urn || '');
  badge.title = data.dataFileName
    ? `Click to open ${data.dataFileName} in Fusion`
    : 'Click to open in Fusion';
  if (!badge.getAttribute('data-click-bound')) {
    badge.addEventListener('click', _onActiveVariantBadgeClick);
    badge.setAttribute('data-click-bound', '1');
  }
}

// Refresh the relative "saved Nm ago" suffix every 30 s. The underlying
// timestamp doesn't change but the relative phrase ticks forward.
setInterval(() => {
  try { updateActiveVariantBadge(); } catch {}
}, 30 * 1000);

function initUploadedPdfsSync() {
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('uploaded_pdfs').on('value', snap => {
      _uploadedPdfsCache = snap.val() || {};
      try { render(); } catch {}
    });
  } catch (e) {
    console.warn('Firebase uploaded_pdfs listener failed:', e);
  }
}

// ── Cut Sheets (nested cut layouts) ────────────────────────────────
// Separate concept from per-part DXFs (uploaded_dxfs). A cut sheet
// is a NESTED layout — multiple parts arranged on one stock sheet,
// ready for the laser machine. Source: NestingTool's "Save Sheets
// to Project" button (one upload per output sheet) OR admin drag-
// drop on the web. Per user 2026-05-28: 'ปุ่ม dxfs ด้านบน ให้เป็น
// การรวมชิ้นงานเพื่อการตัด ที่ส่งมาจาก nesting หรือ admin นำมาวาง'.
//
// RTDB schema: cut_sheets/<projectKey>/<id> = {
//   url, filename, thickness_mm, parts_count, sheet_w_mm, sheet_h_mm,
//   uploaded_at, uploaded_via
// }
let _cutSheetsCache = {};

function initCutSheetsSync() {
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('cut_sheets').on('value', snap => {
      _cutSheetsCache = snap.val() || {};
      try { render(); } catch {}
    });
  } catch (e) {
    console.warn('Firebase cut_sheets listener failed:', e);
  }
}

function cutSheetsForProject(projectKey) {
  if (!projectKey || !_cutSheetsCache) return [];
  const bucket = _cutSheetsCache[projectKey];
  if (!bucket) return [];
  const out = [];
  for (const [id, meta] of Object.entries(bucket)) {
    if (meta) out.push({ id, ...meta });
  }
  // Latest upload first — workshop wants the freshest nest at top.
  out.sort((a, b) => (b.uploaded_at || 0) - (a.uploaded_at || 0));
  return out;
}

// ── Nest parts snapshot (latest Save Project per project) ──────────────
// Written by nest.js _saveProject to nest_parts/<pk>. The Laser Cut List
// merges this so manual rects + grain/qty edits made in the Nest workspace
// reach the laser worker. app.js only READS this node.
let _nestPartsCache = {};
function initNestPartsSync() {
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('nest_parts').on('value', snap => {
      _nestPartsCache = snap.val() || {};
      if (typeof render === 'function') render();
    });
  } catch (e) {
    console.warn('Firebase nest_parts listener failed:', e);
  }
}
function nestPartsForProject(projectKey) {
  if (!projectKey || !_nestPartsCache) return [];
  const node = _nestPartsCache[projectKey];
  return (node && Array.isArray(node.parts)) ? node.parts : [];
}

function initUploadedDxfsSync() {
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('uploaded_dxfs').on('value', snap => {
      _uploadedDxfsCache = snap.val() || {};
      // Workshop never sees the 📐 button — skip the full render so a
      // burst of uploads doesn't repaint the workshop iPad needlessly.
      if (isAdmin()) {
        try { render(); } catch {}
      }
    });
  } catch (e) {
    console.warn('Firebase uploaded_dxfs listener failed:', e);
  }
}

function getGitHubPat() {
  let pat = '';
  try { pat = localStorage.getItem(LS_GITHUB_PAT_KEY) || ''; } catch {}
  if (pat) return pat;
  const entered = prompt(
    'GitHub PAT needed for upload (one-time setup).\n\n' +
    '1. Open https://github.com/settings/personal-access-tokens/new\n' +
    '2. Resource owner: your account\n' +
    '3. Repository access: only "kitchen-drawings-rd2026"\n' +
    '4. Permission → Repository → Contents: Read and write\n' +
    '5. Expiry: 90 days (or longer)\n' +
    '6. Generate → copy the token (starts with github_pat_…)\n\n' +
    'Paste the token here:'
  );
  if (!entered) return null;
  const trimmed = entered.trim();
  if (!/^github_pat_|^ghp_/.test(trimmed)) {
    alert('That doesn\'t look like a GitHub PAT. Cancel + try again.');
    return null;
  }
  try { localStorage.setItem(LS_GITHUB_PAT_KEY, trimmed); } catch {}
  return trimmed;
}

function resetGitHubPat() {
  try { localStorage.removeItem(LS_GITHUB_PAT_KEY); } catch {}
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function _ghContentsRequest(path, init = {}) {
  const pat = getGitHubPat();
  if (!pat) throw new Error('No PAT — upload cancelled');
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(init.headers || {}),
  };
  return fetch(url, { ...init, headers });
}

async function _ghGetFileSha(path) {
  const resp = await _ghContentsRequest(`${path}?ref=${GH_BRANCH}`);
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub GET ${path} → ${resp.status}: ${body}`);
  }
  const json = await resp.json();
  return json.sha || null;
}

async function uploadPdfFromDrop(file, code, family) {
  console.log('[upload] start — code=%s family=%s file=%s size=%d',
    code, family, file && file.name, file && file.size);
  if (!file || (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name))) {
    alert('Please drop a PDF file (.pdf).');
    return false;
  }
  if (!code) return false;

  const path = `${GH_UPLOAD_PATH}/${code}.pdf`;
  try {
    console.log('[upload] reading file as base64');
    const content = await fileToBase64(file);

    console.log('[upload] checking for existing file SHA');
    const existingSha = await _ghGetFileSha(path);

    console.log('[upload] PUT', path, existingSha ? `(replacing ${existingSha.slice(0,7)})` : '(new)');
    const resp = await _ghContentsRequest(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Upload drawing ${code}` + (existingSha ? ' (replace)' : ''),
        content,
        branch: GH_BRANCH,
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    });
    if (!resp.ok) {
      const errBody = await resp.text();
      console.error('[upload] GitHub PUT failed:', resp.status, errBody);
      if (resp.status === 401 || resp.status === 403) {
        resetGitHubPat();
        alert(`GitHub auth failed (${resp.status}). PAT cleared — try again with a fresh token.`);
      } else {
        alert(`Upload failed (${resp.status}):\n\n${errBody.slice(0, 500)}`);
      }
      return false;
    }
    const json = await resp.json();
    const commitSha = json.commit && json.commit.sha;
    console.log('[upload] committed', commitSha);

    // Cache-buster on the public URL so the admin's own UI bypasses any
    // stale Pages cache on next render.
    const publicUrl = `${GH_PUBLIC_BASE}${encodeURIComponent(code)}.pdf?v=${Date.now()}`;

    if (window.firebaseDB) {
      await window.firebaseDB.ref('uploaded_pdfs/' + code).set({
        url: publicUrl,
        family: family || '',
        filename: file.name,
        size: file.size,
        uploaded_at: Date.now(),
        commit_sha: commitSha || '',
      });
    }
    console.log('[upload] DONE');
    alert(
      `Uploaded ${code} (${Math.round(file.size / 1024)} KB)\n\n` +
      `GitHub commit: ${commitSha ? commitSha.slice(0, 7) : 'OK'}\n` +
      `Workshop URL fresh in ~1 min (GitHub Pages rebuild).`
    );
    return true;
  } catch (e) {
    console.error('[upload] FAILED:', e);
    alert('Upload failed:\n\n' + (e.message || e));
    return false;
  }
}

async function deleteUploadedPdf(code) {
  if (!code) return false;
  const path = `${GH_UPLOAD_PATH}/${code}.pdf`;
  try {
    const sha = await _ghGetFileSha(path);
    if (sha) {
      const resp = await _ghContentsRequest(path, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Delete drawing ${code}`,
          sha,
          branch: GH_BRANCH,
        }),
      });
      if (!resp.ok) {
        const errBody = await resp.text();
        console.error('[delete] GitHub DELETE failed:', resp.status, errBody);
        // Fall through and still clear the RTDB entry — the file may have
        // been deleted out of band.
      }
    }
    if (window.firebaseDB) {
      await window.firebaseDB.ref('uploaded_pdfs/' + code).set(null);
    }
    return true;
  } catch (e) {
    console.error('PDF delete failed:', e);
    return false;
  }
}

// ── Merge all project PDFs into one (with deep-link back-refs) ─────
// Click "📑 All PDF" on a project → produce a single navigable PDF:
//
//   [Page 1 .. M]  Project master PDF (always first, if it exists).
//                  Each page links back to #project=<pk> (project view).
//   [Page M+1 .. N] Per-part drawings in BOM order. Each page links
//                  back to #project=<pk>&code=<code> (that part's spoke).
//
// Skips parts that have no resolvable drawing. Sequential fetch keeps
// memory bounded for large projects; the button shows current/total
// while fetching so workshop sees progress.

async function buildAllProjectPdf(projectKey) {
  if (!window.PDFLib) {
    alert('PDF library not loaded yet — wait a moment and try again.');
    return;
  }
  const project = (manifest.projects || {})[projectKey];
  if (!project) { alert('Project not found.'); return; }

  // The project master PDF (if any) always goes first. Skip the part
  // loop's regular item if a part shares the same code as the project
  // — its drawing is already covered by the master section.
  const projectUrl = projectPdfUrl(projectKey);
  const items = [];
  if (projectUrl) {
    items.push({
      kind: 'project',
      code: projectKey,
      url: projectUrl,
      deepUrl: `${location.origin}${location.pathname}` +
        `#project=${encodeURIComponent(projectKey)}`,
    });
  }
  // Unique part codes in BOM order with a resolvable drawing.
  const seen = new Set([projectKey]);  // dedupe vs the project section
  for (const p of (project.parts || [])) {
    if (seen.has(p.code)) continue;
    seen.add(p.code);
    const url = pdfUrlForCode(p.code);
    if (!url) continue;
    items.push({
      kind: 'part',
      code: p.code,
      qty: p.qty || 1,
      url,
      deepUrl: `${location.origin}${location.pathname}` +
        `#project=${encodeURIComponent(projectKey)}` +
        `&code=${encodeURIComponent(p.code)}`,
    });
  }
  if (!items.length) {
    alert(`No drawings available for "${projectKey}".`);
    return;
  }

  const btn = document.getElementById('all-pdf-btn');
  const origLabel = btn ? btn.textContent : '';
  const setLabel = (s) => { if (btn) btn.textContent = s; };
  if (btn) btn.disabled = true;
  setLabel(`⏳ 0/${items.length}…`);

  const { PDFDocument, PDFString, PDFName } = window.PDFLib;
  const merged = await PDFDocument.create();
  const partCount = items.filter(i => i.kind === 'part').length;
  merged.setTitle(`${projectKey} — All Drawings`);
  merged.setSubject(`Generated from drawings-ui · ${partCount} parts` +
    (projectUrl ? ' + master' : ''));

  let done = 0, fail = 0;
  for (const item of items) {
    try {
      // Cache-bust the URL slightly so we don't get a stale CDN copy
      // right after an upload, but keep it cheap (browser caches still
      // help across pages).
      const src = await fetch(item.url, { cache: 'no-cache' });
      if (!src.ok) throw new Error(`HTTP ${src.status}`);
      const bytes = await src.arrayBuffer();
      const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = await merged.copyPages(srcDoc, srcDoc.getPageIndices());

      for (const page of pages) {
        merged.addPage(page);
        // Annotate the bottom strip of each page with a URI link back
        // to the relevant web-UI view (project for master pages, the
        // specific spoke for part pages). Workshop staff taps the strip
        // → web UI focuses on the right place for status / comments.
        const { width } = page.getSize();
        const linkAnnot = merged.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [0, 0, width, 32],
          Border: [0, 0, 0],
          A: {
            Type: 'Action',
            S: 'URI',
            URI: PDFString.of(item.deepUrl),
          },
        });
        const linkRef = merged.context.register(linkAnnot);
        const existing = page.node.lookup(PDFName.of('Annots'));
        if (existing && typeof existing.push === 'function') {
          existing.push(linkRef);
        } else {
          page.node.set(PDFName.of('Annots'), merged.context.obj([linkRef]));
        }
      }
    } catch (e) {
      console.warn(`[all-pdf] failed ${item.kind} ${item.code}:`, e);
      fail++;
    }
    done++;
    setLabel(`⏳ ${done}/${items.length}…`);
  }

  setLabel('💾 Saving…');
  const pdfBytes = await merged.save();
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const objUrl = URL.createObjectURL(blob);

  if (btn) { btn.disabled = false; }
  setLabel(origLabel);

  const win = window.open(objUrl, '_blank');
  if (!win) {
    // Popup blocked — fall back to download
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = `${projectKey}-all.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
  }
  if (fail > 0) {
    setTimeout(() => alert(`Done — ${done - fail} merged, ${fail} failed (see console).`), 200);
  }
}

// ── Deep-link router — open straight to a project + spoke ──────────
// `#project=<pk>` → navigates to that project view.
// `#project=<pk>&code=<code>` → navigates + highlights the spoke.
// Used by the "All PDF" merged-document link annotations (and any
// QR-code / shared URL that points at a specific part).

function _applyDeepLinkFromHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return;
  let params;
  try { params = new URLSearchParams(raw); }
  catch { return; }
  // #nest=<pk> → jump straight into a project's web Nesting workspace.
  // CC_Laser opens `?admin=1#nest=<pk>` after pushing the run's DXFs to the
  // web, so the laser pipeline lands directly on the nest (replaces the
  // desktop NestingTool launch — user 2026-05-29). kdNest.openProject is
  // self-contained (sets up the full-screen nest overlay regardless of the
  // current view), so no view switch is needed first.
  const nestPk = params.get('nest');
  if (nestPk) {
    if (!manifest || !manifest.projects || !manifest.projects[nestPk]) {
      console.warn('[deeplink] nest project not in manifest:', nestPk);
    } else if (window.kdNest && typeof window.kdNest.openProject === 'function') {
      window.kdNest.openProject(nestPk);
    }
    try { history.replaceState({}, '', location.pathname + location.search); } catch {}
    return;
  }
  const proj = params.get('project');
  const code = params.get('code');
  if (!proj) return;
  if (!manifest || !manifest.projects || !manifest.projects[proj]) {
    console.warn('[deeplink] project not in manifest:', proj);
    return;
  }
  // Push the project view onto the stack. If we're already inside
  // this project skip the push so back-button still works naturally.
  const top = stack[stack.length - 1];
  if (!top || top.kind !== 'project' || top.name !== proj) {
    stack.push({ kind: 'project', name: proj });
    render();
  }
  if (code) {
    // Wait for the SVG to land in the DOM, then ping the spoke.
    setTimeout(() => _highlightSpoke(code), 350);
  }
  // Clear the hash so a refresh doesn't re-navigate.
  try { history.replaceState({}, '', location.pathname + location.search); } catch {}
}

function _highlightSpoke(code, attempt = 0) {
  // SVG render can take a beat after the project navigates in; poll
  // for up to ~3s before giving up. Without polling, large projects
  // miss the highlight on the very first paint.
  const spoke = document.querySelector(`.pm-spoke[data-code="${CSS.escape(code)}"]`);
  if (!spoke) {
    if (attempt < 15) {
      setTimeout(() => _highlightSpoke(code, attempt + 1), 200);
    } else {
      console.warn('[deeplink] spoke not found after wait:', code);
    }
    return;
  }
  try { spoke.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
  // Inject a bright halo <rect> as a sibling of the spoke's background.
  // SVG filter / drop-shadow animations can be invisible on some iOS
  // versions, but a plain stroked rect that fades in/out is universal.
  const bg = spoke.querySelector('.pm-spoke-bg');
  if (bg) {
    const x = parseFloat(bg.getAttribute('x')) - 6;
    const y = parseFloat(bg.getAttribute('y')) - 6;
    const w = parseFloat(bg.getAttribute('width')) + 12;
    const h = parseFloat(bg.getAttribute('height')) + 12;
    const ns = 'http://www.w3.org/2000/svg';
    const halo = document.createElementNS(ns, 'rect');
    halo.setAttribute('class', 'pm-deeplink-halo');
    halo.setAttribute('x', x); halo.setAttribute('y', y);
    halo.setAttribute('width', w); halo.setAttribute('height', h);
    halo.setAttribute('rx', '14');
    halo.setAttribute('fill', 'none');
    halo.setAttribute('stroke', '#4dd06a');
    halo.setAttribute('stroke-width', '5');
    halo.setAttribute('pointer-events', 'none');
    bg.parentNode.insertBefore(halo, bg);
    setTimeout(() => { try { halo.remove(); } catch {} }, 4000);
  }
  spoke.classList.add('deep-link-highlight');
  setTimeout(() => spoke.classList.remove('deep-link-highlight'), 4000);
}

// ── Bent + Assembled parts (per-part workshop tracking) ────────────
//
// SHARED across devices via Firebase Realtime DB (was per-device
// localStorage before 2026-05-25). localStorage now acts as offline
// cache + initial-load mirror so the UI has data before Firebase
// fires. Both also feed CC_WebSync on the Fusion side — it reads
// `bent_status/<projectKey>/<code>` and `assembled_status/...` to
// show workshop progress next to the master file.
//
// Schema in Firebase RTDB:
//   bent_status/<projectKey>/<code> = { time: epoch_ms }
//   assembled_status/<projectKey>/<code> = { time: epoch_ms }
//
// In-memory cache keyed by "projectKey::code" so existing call sites
// (Set-based, see bentKey()) keep working without refactor.

let _bentCache = {};       // { "pk::code": { time } }
let _assembledCache = {};  // same shape

function bentKey(projectKey, code) { return `${projectKey}::${code}`; }

// Seed the in-memory caches from localStorage on script load — covers
// the case where the page renders before Firebase fires its first
// snapshot. The Firebase listener will overwrite this once it fires.
function _seedBentFromLocal() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_BENT_KEY) || '[]');
    if (Array.isArray(arr)) {
      const now = Date.now();
      _bentCache = {};
      for (const k of arr) _bentCache[k] = { time: now };
    }
  } catch {}
}
function _seedAssembledFromLocal() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_ASSEMBLED_KEY) || '[]');
    if (Array.isArray(arr)) {
      const now = Date.now();
      _assembledCache = {};
      for (const k of arr) _assembledCache[k] = { time: now };
    }
  } catch {}
}
_seedBentFromLocal();
_seedAssembledFromLocal();

function _mirrorBentToLocal() {
  try { localStorage.setItem(LS_BENT_KEY, JSON.stringify(Object.keys(_bentCache))); } catch {}
}
function _mirrorAssembledToLocal() {
  try { localStorage.setItem(LS_ASSEMBLED_KEY, JSON.stringify(Object.keys(_assembledCache))); } catch {}
}

// Legacy Set-returning helpers — still used by a few call sites that
// loop over the whole set. Build from cache on demand.
function loadBentSet() { return new Set(Object.keys(_bentCache)); }
function saveBentSet(set) {
  // Used only by _propagateBentUp now. Reconcile cache + localStorage
  // + Firebase from the passed set.
  const newCache = {};
  const now = Date.now();
  for (const k of set) {
    newCache[k] = _bentCache[k] || { time: now };
  }
  // Compute diff vs current cache so we only touch Firebase for changes.
  if (window.firebaseDB) {
    const updates = {};
    for (const k of Object.keys(newCache)) {
      if (!_bentCache[k]) {
        const [pk, code] = k.split('::');
        updates[`bent_status/${pk}/${code}`] = newCache[k];
      }
    }
    for (const k of Object.keys(_bentCache)) {
      if (!newCache[k]) {
        const [pk, code] = k.split('::');
        updates[`bent_status/${pk}/${code}`] = null;
      }
    }
    if (Object.keys(updates).length) {
      try { window.firebaseDB.ref().update(updates); }
      catch (e) { console.warn('Firebase bent batch update failed:', e); }
    }
  }
  _bentCache = newCache;
  _mirrorBentToLocal();
}
function loadAssembledSet() { return new Set(Object.keys(_assembledCache)); }
function saveAssembledSet(set) {
  // Assembled has no auto-propagate so this is rarely called directly;
  // included for API parity with bent.
  const newCache = {};
  const now = Date.now();
  for (const k of set) newCache[k] = _assembledCache[k] || { time: now };
  if (window.firebaseDB) {
    const updates = {};
    for (const k of Object.keys(newCache)) {
      if (!_assembledCache[k]) {
        const [pk, code] = k.split('::');
        updates[`assembled_status/${pk}/${code}`] = newCache[k];
      }
    }
    for (const k of Object.keys(_assembledCache)) {
      if (!newCache[k]) {
        const [pk, code] = k.split('::');
        updates[`assembled_status/${pk}/${code}`] = null;
      }
    }
    if (Object.keys(updates).length) {
      try { window.firebaseDB.ref().update(updates); }
      catch (e) { console.warn('Firebase assembled batch update failed:', e); }
    }
  }
  _assembledCache = newCache;
  _mirrorAssembledToLocal();
}

function isBent(projectKey, code) { return !!_bentCache[bentKey(projectKey, code)]; }
function isAssembled(projectKey, code) { return !!_assembledCache[bentKey(projectKey, code)]; }

function markBent(projectKey, code, done) {
  const k = bentKey(projectKey, code);
  if (done) {
    _bentCache[k] = { time: Date.now() };
    if (window.firebaseDB) {
      try { window.firebaseDB.ref(`bent_status/${projectKey}/${code}`).set(_bentCache[k]); }
      catch (e) { console.warn('Firebase bent write failed:', e); }
    }
  } else {
    delete _bentCache[k];
    if (window.firebaseDB) {
      try { window.firebaseDB.ref(`bent_status/${projectKey}/${code}`).remove(); }
      catch (e) { console.warn('Firebase bent remove failed:', e); }
    }
  }
  _mirrorBentToLocal();
  // Auto-propagate up: when every child of a parent is bent, the parent
  // itself becomes bent automatically. When ANY child gets un-bent, the
  // parent un-bends too. (Assembled does NOT auto-propagate.)
  try { _propagateBentUp(projectKey, code); } catch {}
}

function markAssembled(projectKey, code, done) {
  const k = bentKey(projectKey, code);
  if (done) {
    _assembledCache[k] = { time: Date.now() };
    if (window.firebaseDB) {
      try { window.firebaseDB.ref(`assembled_status/${projectKey}/${code}`).set(_assembledCache[k]); }
      catch (e) { console.warn('Firebase assembled write failed:', e); }
    }
  } else {
    delete _assembledCache[k];
    if (window.firebaseDB) {
      try { window.firebaseDB.ref(`assembled_status/${projectKey}/${code}`).remove(); }
      catch (e) { console.warn('Firebase assembled remove failed:', e); }
    }
  }
  _mirrorAssembledToLocal();
}

// Bulk reset helpers for the "↻ Reset" buttons in each role's project
// view (user 2026-05-28: 'ในช่วงแรก ผมจะให้แต่ละฝ่าย ทดลอง จะได้กด มี
// reset ได้'). Clears every per-(project, part) entry for the given
// projectKey from both the in-memory cache and the RTDB mirror so the
// progress bar snaps back to 0/N.
function resetBentForProject(projectKey) {
  if (!projectKey) return 0;
  const prefix = `${projectKey}::`;
  const keys = Object.keys(_bentCache).filter(k => k.startsWith(prefix));
  for (const k of keys) delete _bentCache[k];
  _mirrorBentToLocal();
  if (window.firebaseDB) {
    try { window.firebaseDB.ref(`bent_status/${projectKey}`).remove(); }
    catch (e) { console.warn('Firebase bent reset failed:', e); }
  }
  return keys.length;
}

function resetAssembledForProject(projectKey) {
  if (!projectKey) return 0;
  const prefix = `${projectKey}::`;
  const keys = Object.keys(_assembledCache).filter(k => k.startsWith(prefix));
  for (const k of keys) delete _assembledCache[k];
  _mirrorAssembledToLocal();
  if (window.firebaseDB) {
    try { window.firebaseDB.ref(`assembled_status/${projectKey}`).remove(); }
    catch (e) { console.warn('Firebase assembled reset failed:', e); }
  }
  // Wipe timers for this project too — assembly time tracking is part
  // of the same workflow, and a 'fresh start' for the team should
  // include accumulated time.
  if (timersCache[projectKey]) {
    delete timersCache[projectKey];
    saveCachedTimers(timersCache);
  }
  if (window.firebaseDB) {
    try { window.firebaseDB.ref(`timers/${projectKey}`).remove(); }
    catch (e) { console.warn('Firebase timers reset failed:', e); }
  }
  return keys.length;
}

function _propagateBentUp(projectKey, startCode) {
  // Walk every project the part appears in (usually just one) and find
  // the parent of `startCode` via buildProjectTree. Recurse up while
  // each ancestor's bent state matches its children's collective state.
  const project = manifest && manifest.projects && manifest.projects[projectKey];
  if (!project || !Array.isArray(project.parts)) return;
  const { all } = buildProjectTree(project.parts, projectKey);
  const node = all.find(n => n.code === startCode);
  if (!node) return;
  let cur = node.parent;
  while (cur) {
    const kids = cur.children || [];
    if (!kids.length) break;
    const allKidsBent = kids.every(k => isBent(projectKey, k.code));
    const parentIsBent = isBent(projectKey, cur.code);
    if (allKidsBent && !parentIsBent) {
      markBent(projectKey, cur.code, true);  // recurses (the markBent call propagates further)
      return;
    }
    if (!allKidsBent && parentIsBent) {
      markBent(projectKey, cur.code, false);
      return;
    }
    break;  // no change at this level → stop
  }
}

function bentCountForProject(projectKey, parts) {
  return parts.filter(p => isBent(projectKey, p.code)).length;
}
function assembledCountForProject(projectKey, parts) {
  return parts.filter(p => isAssembled(projectKey, p.code)).length;
}

// ── In-place assembly/bending refresh ──────────────────────────────────
// A full render() rebuilds ROOT.innerHTML, which destroys #kme-mount and
// forces the React Flow editor to remount — a visible canvas flash on every
// tick. The 🧩/tab-3 gestures feel still because they only mutate in-editor
// state and never call render(). To give 'complete' (and bending ticks) the
// same stillness (user 2026-05-29: 'กด complete ... ไม่ให้จอกระพริบ เหมือน
// tab 3'), when a project view with a live editor is on screen we refresh in
// place: patch the progress pills' width/text directly and ping the editor
// to re-read assembled/bent state (kme:extsync). NO remount, NO viewport
// reset. Off the editor view we fall back to a normal render().
function _updateProgressPills(key) {
  const project = (manifest.projects || {})[key];
  if (!project) return;
  const parts = project.parts || [];
  const total = parts.length || 0;
  const setPill = (sel, count) => {
    const root = document.querySelector(sel);
    if (!root) return;
    const pct = total ? Math.round((count * 100) / total) : 0;
    const fill = root.querySelector('.progress-fill');
    const stat = root.querySelector('.bent-stat');
    if (fill) fill.style.width = pct + '%';
    if (stat) stat.textContent = `${count}/${total} · ${pct}%`;
  };
  setPill('.assembled-mini', assembledCountForProject(key, parts));
  setPill('.bent-mini', bentCountForProject(key, parts));
}

function _refreshAssemblyUI() {
  const top = stack[stack.length - 1];
  const editorLive = !!window.__kmeInstance && !!document.getElementById('kme-mount');
  if (top && top.kind === 'project' && editorLive) {
    _updateProgressPills(top.name);
    try { window.dispatchEvent(new Event('kme:extsync')); } catch {}
    return;
  }
  try { render(); } catch {}
}

function initBentSync() {
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('bent_status').on('value', snap => {
      const data = snap.val() || {};
      _bentCache = {};
      for (const [pk, codes] of Object.entries(data)) {
        for (const [code, payload] of Object.entries(codes || {})) {
          _bentCache[bentKey(pk, code)] = payload;
        }
      }
      _mirrorBentToLocal();
      _refreshAssemblyUI();
    }, err => console.warn('Firebase bent listener error:', err));
  } catch (e) {
    console.warn('Failed to attach bent listener:', e);
  }
}
function initAssembledSync() {
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('assembled_status').on('value', snap => {
      const data = snap.val() || {};
      _assembledCache = {};
      for (const [pk, codes] of Object.entries(data)) {
        for (const [code, payload] of Object.entries(codes || {})) {
          _assembledCache[bentKey(pk, code)] = payload;
        }
      }
      _mirrorAssembledToLocal();
      _refreshAssemblyUI();
    }, err => console.warn('Firebase assembled listener error:', err));
  } catch (e) {
    console.warn('Failed to attach assembled listener:', e);
  }
}

// One-shot push of any localStorage entries that don't yet exist in
// RTDB. Runs after both listeners have fired at least once so we have
// a baseline. Marks each migrated entry with { migrated: true } so it's
// distinguishable from native RTDB writes in audit.
async function _migrateLocalToFirebase() {
  if (!window.firebaseDB) return;
  // Wait one tick so the listener has a chance to fire first.
  await new Promise(r => setTimeout(r, 1500));
  try {
    const localBent = JSON.parse(localStorage.getItem(LS_BENT_KEY) || '[]');
    const localAss  = JSON.parse(localStorage.getItem(LS_ASSEMBLED_KEY) || '[]');
    const updates = {};
    const now = Date.now();
    for (const k of localBent) {
      if (_bentCache[k]) continue;
      const [pk, code] = k.split('::');
      if (!pk || !code) continue;
      updates[`bent_status/${pk}/${code}`] = { time: now, migrated: true };
    }
    for (const k of localAss) {
      if (_assembledCache[k]) continue;
      const [pk, code] = k.split('::');
      if (!pk || !code) continue;
      updates[`assembled_status/${pk}/${code}`] = { time: now, migrated: true };
    }
    if (Object.keys(updates).length) {
      console.log(`[migrate] pushing ${Object.keys(updates).length} localStorage entries to RTDB`);
      await window.firebaseDB.ref().update(updates);
    }
  } catch (e) {
    console.warn('Local→Firebase migration failed:', e);
  }
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
      // Reflect new comments from other devices. In-place refresh so a remote
      // comment landing while the mindmap editor is open doesn't remount it
      // (canvas flash); off the editor (where comment panels show) this falls
      // through to a full render(). Same fix as the assembled/bent listeners.
      _refreshAssemblyUI();
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
      // In-place refresh so a timer write landing while the mindmap editor is
      // open doesn't remount it (canvas flash); off the editor (cut list /
      // project view, where timers actually show) this falls through to a full
      // render(). Same fix as the assembled/bent listeners. (2026-05-29)
      _refreshAssemblyUI();
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

// deleted_projects — admin hides whole projects from the Projects list.
// Parts in the project's BOM STAY in their Library families (the user
// asked: "admin can delete project, but parts stay — admin removes
// parts manually"). Soft-delete pattern mirrors deleted_drawings so
// the project can be restored later if needed.
let deletedProjectsCache = {};

function _loadDeletedProjects() {
  try {
    const raw = localStorage.getItem(LS_DELETED_PROJECTS_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch { return {}; }
}
function _saveDeletedProjects(all) {
  try { localStorage.setItem(LS_DELETED_PROJECTS_KEY, JSON.stringify(all)); } catch {}
}
deletedProjectsCache = _loadDeletedProjects();

function initDeletedProjectsSync() {
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('deleted_projects').on('value', snap => {
      deletedProjectsCache = snap.val() || {};
      _saveDeletedProjects(deletedProjectsCache);
      try { render(); } catch {}
    }, err => console.warn('Firebase deleted_projects listener error:', err));
  } catch (e) {
    console.warn('Failed to attach deleted_projects listener:', e);
  }
}

function isProjectSoftDeleted(pk) {
  return !!(pk && deletedProjectsCache[pk] && deletedProjectsCache[pk].time);
}

function softDeleteProject(pk) {
  if (!pk) return;
  const payload = { time: Date.now() };
  deletedProjectsCache[pk] = payload;
  _saveDeletedProjects(deletedProjectsCache);
  if (window.firebaseDB) {
    try { window.firebaseDB.ref('deleted_projects/' + pk).set(payload); }
    catch (e) { console.warn('softDeleteProject failed:', e); }
  }
  render();
}

function restoreProject(pk) {
  if (!pk) return;
  delete deletedProjectsCache[pk];
  _saveDeletedProjects(deletedProjectsCache);
  if (window.firebaseDB) {
    try { window.firebaseDB.ref('deleted_projects/' + pk).remove(); }
    catch (e) { console.warn('restoreProject failed:', e); }
  }
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
  const seen = new Set();
  const auto = manifest.auto_generated || {};
  for (const [code, entry] of Object.entries(auto)) {
    // Admin's per-code folder override wins over Fusion-emitted family.
    const fam = effectiveFamily(code, entry.family || 'Other');
    if (!out[fam]) out[fam] = [];
    out[fam].push({ code, ...entry, family: fam });
    seen.add(code);
  }
  // Surface Firebase-uploaded PDFs (admin drag-drop). Render under the
  // family the upload was tagged to (or 'Custom' if unknown).
  for (const [code, up] of Object.entries(_uploadedPdfsCache || {})) {
    if (seen.has(code)) continue;
    const fam = effectiveFamily(code, up.family || 'Custom');
    if (!out[fam]) out[fam] = [];
    out[fam].push({
      code,
      family: fam,
      pdf: up.filename || (code + '.pdf'),
      url: up.url,
      uploaded_at: up.uploaded_at,
      isUploaded: true,
      status: 'drawn',
    });
    seen.add(code);
  }

  // Also surface parts from every project BOM (CC_Assembly output) — even
  // those without a PDF exported yet. Workshop browsing by family in
  // Library shouldn't require the part to have a manifest entry first.
  // Status defaults to 'missing'; gets upgraded by the manifest pass above
  // when the PDF eventually lands.
  if (manifest.projects) {
    for (const project of Object.values(manifest.projects)) {
      if (!Array.isArray(project.parts)) continue;
      for (const p of project.parts) {
        if (seen.has(p.code)) continue;
        const fam = effectiveFamily(p.code, p.family || 'Other');
        if (!out[fam]) out[fam] = [];
        // If a sibling upload covers this code via prefix-share or an
        // explicit group, pdfUrlForCode returns a non-empty URL — mark
        // as drawn so workshop sees the part is ready.
        const resolved = pdfUrlForCode(p.code);
        out[fam].push({
          code: p.code,
          family: fam,
          pdf: null,
          url: resolved || undefined,
          status: resolved ? 'drawn' : 'missing',
          isUploaded: !!resolved,
          urn: p.urn || null,
          drawing_urn: p.drawing_urn || null,
        });
        seen.add(p.code);
      }
    }
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
  const assembledSet = loadAssembledSet();
  const pinnedSet = loadPinnedSet();
  // Soft-deleted projects are hidden from the list (admin still sees
  // them if we render them with a "restore" affordance — not yet wired;
  // for now, simple hide). Parts in the project's BOM continue to
  // appear in Library families unchanged.
  const items = Object.entries(projects)
    .filter(([key]) => !isProjectSoftDeleted(key))
    .map(([key, p]) => {
    const parts = p.parts || [];
    // A part is "drawn" if pdfUrlForCode resolves to a URL — covers
    // manifest entries (Fusion-exported), direct web uploads, and
    // prefix-share / group siblings of uploads. Returns '' if soft-
    // deleted, so workshop-flagged-redo parts still count as missing.
    const drawnCount = parts.filter(part => !!pdfUrlForCode(part.code)).length;
    const bentCount = parts.filter(part => bentSet.has(bentKey(key, part.code))).length;
    const assembledCount = parts.filter(part => assembledSet.has(bentKey(key, part.code))).length;
    return {
      key,
      ...p,
      completed: isCompleted(key),
      pinned: pinnedSet.has(key),
      drawn_count: drawnCount,
      missing_count: parts.length - drawnCount,
      bent_count: bentCount,
      bent_pct: parts.length ? Math.round((bentCount * 100) / parts.length) : 0,
      assembled_count: assembledCount,
      assembled_pct: parts.length ? Math.round((assembledCount * 100) / parts.length) : 0,
    };
  });

  // Sort priority:
  //   1. Pinned active projects first (manual order > updated_at)
  //   2. Non-pinned active projects (manual order > updated_at)
  //   3. Completed projects (manual order > updated_at)
  // Manual order from drag-and-drop is honored within each band; projects
  // not yet ranked manually fall back to updated_at desc and sort after
  // the ranked ones in the same band.
  const manualOrder = loadProjectOrder();
  const rankMap = new Map(manualOrder.map((k, i) => [k, i]));

  function bandRank(p) {
    if (p.completed) return 2;
    if (p.pinned) return 0;
    return 1;
  }

  items.sort((a, b) => {
    const bandDiff = bandRank(a) - bandRank(b);
    if (bandDiff !== 0) return bandDiff;
    const ra = rankMap.has(a.key) ? rankMap.get(a.key) : Infinity;
    const rb = rankMap.has(b.key) ? rankMap.get(b.key) : Infinity;
    if (ra !== rb) return ra - rb;
    const ta = a.updated_at || a.created_at || '';
    const tb = b.updated_at || b.created_at || '';
    return tb.localeCompare(ta);
  });
  return items;
}

// ──────────────────────────────────────────────────────────────────────
// Rendering — top-level dispatch
// ──────────────────────────────────────────────────────────────────────

// Toggle the header Back button based on whether the user has drilled
// into any view. The button lives inline in the single .header-controls
// row alongside the tabs + search box (2026-05-28 layout: one row, not
// four). Hidden via inline display:none until stack.length > 0.
function _updateHeaderBack() {
  const btn = document.getElementById('header-back-btn');
  if (!btn) return;
  btn.style.display = stack.length > 0 ? '' : 'none';
}

function render() {
  // Migrate legacy 'missing' view (Tree tab — removed 2026-05-24) → projects
  if (view === 'missing') view = 'projects';
  // Always sync the header Back button visibility before painting the
  // view — every render either reveals or hides it based on stack depth.
  _updateHeaderBack();
  if (stack.length === 0) {
    if (view === 'projects') return renderProjectsHome();
    if (view === 'nest')     return renderNestHome();
    if (view === 'simbend')  return renderSimBendHome();
    return renderLibraryHome();
  }
  const top = stack[stack.length - 1];
  if (top.kind === 'family') return renderFamily(top.name, top.highlight);
  if (top.kind === 'project') return renderProject(top.name);
}

// Sim.Bending — press-brake bend feasibility per PART, published by
// CC_CheckBend (Fusion) to RTDB bend_sim/<code>. Keyed by part code (not
// project): bend feasibility is a property of the part geometry, shared
// across every project that uses it. Record shape (Fusion web_push.py /
// this view / the seed all agree):
//   bend_sim/<code> = {
//     bendable, kind: 'found'|'impossible'|'not_found_budget',
//     order: [bendId...], n_bends, n_problems, reason,
//     per_bend: [{bend, die, radius_mm, angle_deg, flange_mm, v_mm,
//                 tonnage_kN, ok, collides, hits, at_angle, reason}],
//     checked_at (iso), checked_by }
// See _MASTERS/fusion_scripts/CC_CheckBend/design.md module 7. 2026-06-02.
let _bendSimCache = null;          // null = not loaded yet
let _bendSimSubscribed = false;
let _simBendExpanded = null;       // code currently expanded inline
let _simController = null;         // active simbend-sim.js animation controller

function _subscribeBendSim() {
  if (_bendSimSubscribed) return;
  _bendSimSubscribed = true;
  try {
    window.firebaseDB.ref('bend_sim').on('value', snap => {
      _bendSimCache = snap.val() || {};
      if (view === 'simbend' && stack.length === 0) render();
    });
  } catch (e) {
    _bendSimCache = {};
  }
}

function _simVerdict(rec) {
  if (rec && rec.bendable) return { cls: 'sb-ok', txt: '✓ BENDABLE' };
  if (rec && rec.kind === 'not_found_budget')
    return { cls: 'sb-warn', txt: '⚠ NOT FOUND (budget)' };
  return { cls: 'sb-bad', txt: '✗ NOT BENDABLE' };
}

// ── My Tooling picker (which Amada punches/dies เอ๋ owns) ──────────────
// Catalog = window.KD_TOOLING (tooling-catalog.js). Ownership persists to RTDB
// bend_tools_owned/<toolId>=true; CC_CheckBend reads it to pick only owned tools.
let _ownedToolsCache = null;
let _ownedToolsSubscribed = false;
let _toolingPanelOpen = false;
let _toolingExpandedId = null;

let _customToolsCache = null;
let _customToolsSubscribed = false;

function _subscribeCustomTools() {
  if (_customToolsSubscribed) return;
  _customToolsSubscribed = true;
  
  if (!window._masterKDTooling) {
    window._masterKDTooling = JSON.parse(JSON.stringify(window.KD_TOOLING || { punches: [], dies: [] }));
  }
  
  try {
    window.firebaseDB.ref('bend_tools_custom').on('value', s => {
      const val = s.val() || {};
      _customToolsCache = val;
      
      const punches = val.punches || {};
      const dies = val.dies || {};
      
      window.KD_TOOLING.punches = JSON.parse(JSON.stringify(window._masterKDTooling.punches));
      window.KD_TOOLING.dies = JSON.parse(JSON.stringify(window._masterKDTooling.dies));
      
      Object.keys(punches).forEach(key => {
        const item = punches[key];
        item.id = key;
        item.isCustom = true;
        if (!window.KD_TOOLING.punches.find(p => p.id === key)) {
          window.KD_TOOLING.punches.push(item);
        }
      });
      
      Object.keys(dies).forEach(key => {
        const item = dies[key];
        item.id = key;
        item.isCustom = true;
        if (!window.KD_TOOLING.dies.find(d => d.id === key)) {
          window.KD_TOOLING.dies.push(item);
        }
      });
      
      if (view === 'simbend' && stack.length === 0) render();
    });
  } catch (e) {
    console.error("Failed to subscribe to custom tools", e);
  }
}

function _subscribeOwnedTools() {
  if (_ownedToolsSubscribed) return;
  _ownedToolsSubscribed = true;
  try {
    window.firebaseDB.ref('bend_tools_owned').on('value', s => {
      _ownedToolsCache = s.val() || {};
      if (view === 'simbend' && stack.length === 0) render();
    });
  } catch (e) { _ownedToolsCache = {}; }
}

function _setOwnedTool(id, on) {
  _ownedToolsCache = _ownedToolsCache || {};
  if (on) _ownedToolsCache[id] = true; else delete _ownedToolsCache[id];
  try { window.firebaseDB.ref('bend_tools_owned/' + id).set(on ? true : null); }
  catch (e) {}
}

function _showAddToolForm(kind) {
  const existing = document.getElementById('sb-add-tool-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'sb-add-tool-modal';
  modal.className = 'sb-modal-backdrop';
  
  const title = kind === 'punch' ? 'Add Custom Punch (เพิ่มมีด)' : 'Add Custom Die (เพิ่มร่อง)';
  
  const content = kind === 'punch' ? `
    <div class="sb-form-group">
      <label>Name / Label (เช่น GooseNeck 88 R0.8)</label>
      <input type="text" id="tool-label" placeholder="GooseNeck 88° · R0.8 Custom" required>
    </div>
    <div class="sb-form-group">
      <label>Type (รูปทรง)</label>
      <select id="tool-type">
        <option value="standard">Standard (ทรงตรง)</option>
        <option value="gooseneck">Gooseneck (ทรงหงส์)</option>
        <option value="acute">Acute (มุมแหลม)</option>
        <option value="hemming">Hemming (พับแบน)</option>
      </select>
    </div>
    <div class="sb-form-group">
      <label>Angle (องศา, เช่น 88 หรือ 30)</label>
      <input type="number" id="tool-angle" value="88" step="1" min="0" max="180" required>
    </div>
    <div class="sb-form-group">
      <label>Tip Radius (รัศมีปลายมีด R, มม.)</label>
      <input type="number" id="tool-radius" value="0.8" step="0.1" min="0" max="10" required>
    </div>
    <div class="sb-form-group">
      <label>Height (ความสูงมีด H, มม.)</label>
      <input type="number" id="tool-height" value="120" step="1" min="10" max="300" required>
    </div>
    <div class="sb-form-group">
      <label>Note (หมายเหตุ)</label>
      <input type="text" id="tool-note" placeholder="รายละเอียดเพิ่มเติม">
    </div>
  ` : `
    <div class="sb-form-group">
      <label>Name / Label (เช่น 1V V8 88°)</label>
      <input type="text" id="tool-label" placeholder="1V · V8 · 88° Custom" required>
    </div>
    <div class="sb-form-group">
      <label>Type (ประเภท)</label>
      <select id="tool-type">
        <option value="1V">1V (ร่องเดี่ยว)</option>
        <option value="2V">2V (ร่องคู่กลับด้าน)</option>
        <option value="acute">Acute / 1V Acute</option>
      </select>
    </div>
    <div class="sb-form-group">
      <label>Angle (องศาร่อง, เช่น 88 หรือ 30)</label>
      <input type="number" id="tool-angle" value="88" step="1" min="0" max="180" required>
    </div>
    <div class="sb-form-group">
      <label>V Openings (มม., สำหรับ 2V ใส่คั่นด้วยจุลภาค เช่น 6,8)</label>
      <input type="text" id="tool-vlist" value="8" required>
    </div>
    <div class="sb-form-group">
      <label>Height (ความสูงร่อง H, มม.)</label>
      <input type="number" id="tool-height" value="60" step="1" min="10" max="300" required>
    </div>
    <div class="sb-form-group">
      <label>Note (หมายเหตุ)</label>
      <input type="text" id="tool-note" placeholder="รายละเอียดเพิ่มเติม">
    </div>
  `;

  modal.innerHTML = `
    <div class="sb-modal-card" onclick="event.stopPropagation()">
      <div class="sb-modal-head">${escapeHtml(title)}</div>
      <form id="sb-add-tool-form">
        <div class="sb-modal-body">
          ${content}
        </div>
        <div class="sb-modal-foot">
          <button class="sb-modal-btn sb-cancel" type="button">Cancel</button>
          <button class="sb-modal-btn sb-submit" type="submit">Save Tool</button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);

  const focusInput = modal.querySelector('#tool-label');
  if (focusInput) focusInput.focus();

  modal.querySelector('.sb-cancel').addEventListener('click', () => modal.remove());
  modal.querySelector('#sb-add-tool-form').addEventListener('submit', (e) => {
    e.preventDefault();
    _saveCustomTool(kind, modal);
  });
}

function _saveCustomTool(kind, modal) {
  const label = modal.querySelector('#tool-label').value.trim();
  const type = modal.querySelector('#tool-type').value;
  const angle_deg = parseFloat(modal.querySelector('#tool-angle').value);
  const height_mm = parseFloat(modal.querySelector('#tool-height').value);
  const note = modal.querySelector('#tool-note').value.trim();

  if (!label) return;

  let toolData = {
    label,
    type,
    angle_deg,
    height_mm,
    note
  };

  let id = '';

  if (kind === 'punch') {
    const tip_radius_mm = parseFloat(modal.querySelector('#tool-radius').value);
    toolData.tip_radius_mm = tip_radius_mm;
    const cleanLabel = label.replace(/[^a-zA-Z0-9]/g, '-').toUpperCase();
    id = `P-CUSTOM-${cleanLabel}-${Date.now().toString().slice(-4)}`;
  } else {
    const vlistStr = modal.querySelector('#tool-vlist').value;
    const v_list = vlistStr.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
    if (v_list.length === 0) {
      alert('Please specify at least one valid V opening size.');
      return;
    }
    toolData.v_list = v_list;
    const cleanLabel = label.replace(/[^a-zA-Z0-9]/g, '-').toUpperCase();
    id = `D-CUSTOM-${cleanLabel}-${Date.now().toString().slice(-4)}`;
  }

  const refPath = `bend_tools_custom/${kind}s/${id}`;
  try {
    window.firebaseDB.ref(refPath).set(toolData).then(() => {
      _setOwnedTool(id, true);
      modal.remove();
      render();
    }).catch(e => {
      alert('Error saving custom tool: ' + e.message);
    });
  } catch (e) {
    alert('Database reference error: ' + e.message);
  }
}

function _deleteCustomTool(id, kind) {
  if (!confirm(`Are you sure you want to delete this custom tool: ${id}?`)) return;

  const refPath = `bend_tools_custom/${kind}s/${id}`;
  try {
    window.firebaseDB.ref(refPath).set(null).then(() => {
      _setOwnedTool(id, null);
      render();
    }).catch(e => {
      alert('Error deleting tool: ' + e.message);
    });
  } catch (e) {
    alert('Database reference error: ' + e.message);
  }
}

function _toolingPickerHtml() {
  const cat = window.KD_TOOLING;
  if (!cat) return '';
  const owned = _ownedToolsCache || {};
  const nP = (cat.punches || []).filter(t => owned[t.id]).length;
  const nD = (cat.dies || []).filter(t => owned[t.id]).length;
  const admin = isAdmin();
  let body = '';
  if (_toolingPanelOpen) {
    const art = window.KD_TOOLART;
    const row = (t, kind) => {
      const on = !!owned[t.id];
      const spec = kind === 'punch'
        ? `${t.angle_deg}° · R${t.tip_radius_mm}`
        : `${t.angle_deg}° · V${(t.v_list || []).join('/')}`;
      const star = t.fit1mm ? '★' : (t.common ? '·' : '');
      const pic = art ? `<span class="tl-pic">${kind === 'punch' ? art.punch(t, { w: 30, h: 40 }) : art.die(t, { w: 44, h: 30 })}</span>` : '';
      const expanded = _toolingExpandedId === t.id;
      const deleteBtn = (admin && t.isCustom)
        ? `<button class="tl-del-btn" type="button" data-id="${escapeHtml(t.id)}" data-kind="${kind}" style="background: none; border: none; color: #e0574a; cursor: pointer; padding: 0 4px; font-size: 14px; margin-left: 8px;" title="Delete custom tool">🗑</button>`
        : '';
      return `<div class="tl-row ${on ? 'tl-on' : ''} ${expanded ? 'tl-expanded' : ''}" data-id="${escapeHtml(t.id)}">
        <input type="checkbox" class="tl-cb" data-id="${escapeHtml(t.id)}" ${on ? 'checked' : ''} ${admin ? '' : 'disabled'}>
        <span class="tl-star">${star}</span>
        ${pic}
        <span class="tl-label">${escapeHtml(t.label)}</span>
        <span class="tl-spec" style="display: flex; align-items: center; gap: 8px;">${escapeHtml(spec)}${deleteBtn}</span>
        <span class="tl-note">${escapeHtml(t.note || '')}</span>
        ${expanded ? `
        <div class="tl-detail-row" style="grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 16px; background: #070b10; border-top: 1px solid #1c2530; margin-top: 6px; border-radius: 6px; cursor: default;" onclick="event.stopPropagation()">
          ${kind === 'punch'
            ? art.punch(t, { w: 200, h: 240, showDimensions: true })
            : art.die(t, { w: 240, h: 180, showDimensions: true })}
        </div>
        ` : ''}
      </div>`;
    };
    body = `<div class="tl-panel">
      <div class="tl-col">
        <div class="tl-h" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span>Punches</span>
          ${admin ? `<button class="tl-add-btn" type="button" data-kind="punch" style="font-size: 11px; padding: 2px 6px; cursor: pointer;">＋ Add Punch</button>` : ''}
        </div>
        ${(cat.punches || []).map(t => row(t, 'punch')).join('')}
      </div>
      <div class="tl-col">
        <div class="tl-h" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span>Dies</span>
          ${admin ? `<button class="tl-add-btn" type="button" data-kind="die" style="font-size: 11px; padding: 2px 6px; cursor: pointer;">＋ Add Die</button>` : ''}
        </div>
        ${(cat.dies || []).map(t => row(t, 'die')).join('')}
      </div>
      <div class="tl-actions" style="display: flex; justify-content: space-between; align-items: center; width: 100%; gap: 10px; margin-top: 8px;">
        ${admin ? `<button class="tl-quick" type="button">Select 1mm set</button>` : ''}
        <a href="https://www.amada.co.jp/en/products/sheetmetal/pressbrake/tooling/" target="_blank" class="tl-catalog-link" style="color: #4ecca3; text-decoration: none; font-size: 11.5px; font-weight: bold;">
          📖 Amada Tooling Catalog ↗
        </a>
        ${admin ? `<span class="tl-hint" style="margin-left: auto;">★ = good for 1mm · saved automatically</span>` : ''}
      </div>
    </div>`;
  }
  const caret = admin ? (_toolingPanelOpen ? ' ▲' : ' ▼') : '';
  return `<div class="tl-wrap">
    <button class="tl-bar" type="button">⚙ My Amada Tooling — ${nP} punch · ${nD} die${caret}</button>
    ${body}
  </div>`;
}

function _wireToolingPicker() {
  const bar = ROOT.querySelector('.tl-bar');
  if (bar) bar.addEventListener('click', () => { _toolingPanelOpen = !_toolingPanelOpen; render(); });
  ROOT.querySelectorAll('.tl-cb').forEach(cb => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      _setOwnedTool(cb.getAttribute('data-id'), cb.checked);
      render();
    });
  });
  ROOT.querySelectorAll('.tl-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('tl-cb') || e.target.closest('.tl-detail-row') || e.target.classList.contains('tl-del-btn')) return;
      e.stopPropagation();
      const id = row.getAttribute('data-id');
      _toolingExpandedId = (_toolingExpandedId === id) ? null : id;
      render();
    });
  });
  ROOT.querySelectorAll('.tl-add-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const kind = btn.getAttribute('data-kind');
      _showAddToolForm(kind);
    });
  });
  ROOT.querySelectorAll('.tl-del-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      const kind = btn.getAttribute('data-kind');
      _deleteCustomTool(id, kind);
    });
  });
  const quick = ROOT.querySelector('.tl-quick');
  if (quick) quick.addEventListener('click', () => {
    const cat = window.KD_TOOLING || { punches: [], dies: [] };
    [].concat(cat.punches, cat.dies).forEach(t => { if (t.fit1mm) _setOwnedTool(t.id, true); });
    render();
  });
}

function renderSimBendHome() {
  _subscribeBendSim();
  _subscribeOwnedTools();
  _subscribeCustomTools();
  COUNT_EL.textContent = '';
  if (_bendSimCache === null) {
    ROOT.innerHTML = `<div class="empty-state"><h2>🔩 Sim.Bending</h2>
      <p class="muted">Loading…</p></div>`;
    return;
  }
  const picker = _toolingPickerHtml();
  const codes = Object.keys(_bendSimCache).filter(c => c && c[0] !== '_');
  if (!codes.length) {
    ROOT.innerHTML = `
      <div class="sb-home">
        ${picker}
        <div class="empty-state">
          <h2>🔩 Sim.Bending</h2>
          <p>Press-brake bend feasibility per part.</p>
          <p>Run <code>CC_CheckBend</code> on a part in Fusion to publish results here.</p>
          <p class="muted">No bend-sim data yet.</p>
        </div>
      </div>`;
    _wireToolingPicker();
    return;
  }
  const q = (SEARCH.value || '').trim().toLowerCase();
  const shown = (q ? codes.filter(c => c.toLowerCase().includes(q)) : codes).sort();
  COUNT_EL.textContent = `${shown.length} part${shown.length === 1 ? '' : 's'} checked`;

  const cards = shown.map(code => {
    const rec = _bendSimCache[code] || {};
    const v = _simVerdict(rec);
    const order = Array.isArray(rec.order) && rec.order.length
      ? rec.order.join(' → ') : '—';
    const nb = rec.n_bends != null ? rec.n_bends : (rec.per_bend || []).length;
    const np = rec.n_problems != null ? rec.n_problems : 0;
    const when = rec.checked_at ? String(rec.checked_at).slice(0, 16).replace('T', ' ') : '';
    let detail = '';
    if (_simBendExpanded === code) {
      const cat = window.KD_TOOLING || { punches: [], dies: [] };
      const defaultPunchId = (rec.per_bend && rec.per_bend[0] && rec.per_bend[0].punch) || 'P-STD-R08-88';
      const defaultDieId = (rec.per_bend && rec.per_bend[0] && rec.per_bend[0].die) || 'D-1V-V08-88';

      const punchOptsHtml = `<option value="AUTO" selected>Auto (ตามข้อมูลจริง)</option>` +
        (cat.punches || []).map(p => {
          return `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`;
        }).join('');

      const dieOptsHtml = `<option value="AUTO" selected>Auto (ตามข้อมูลจริง)</option>` +
        (cat.dies || []).map(d => {
          return `<option value="${escapeHtml(d.id)}">${escapeHtml(d.label)}</option>`;
        }).join('');

      const rows = (rec.per_bend || []).map(b => {
        const bad = b.ok === false || b.collides;
        const why = b.collides
          ? `hits ${b.hits || '?'}${b.at_angle != null ? ' @' + Math.round(b.at_angle) + '°' : ''}`
          : (b.reason || (b.ok === false ? 'fail' : 'formable'));
        return `<tr class="${bad ? 'sb-row-bad' : ''}">
          <td>${escapeHtml(b.bend || '')}</td>
          <td>${escapeHtml(b.die || '—')}</td>
          <td>${b.radius_mm != null ? 'r' + b.radius_mm : ''}</td>
          <td>${b.angle_deg != null ? Math.round(b.angle_deg) + '°' : ''}</td>
          <td>${b.flange_mm != null ? b.flange_mm : ''}</td>
          <td>${b.v_mm != null ? 'V' + Math.round(b.v_mm) : ''}</td>
          <td>${b.tonnage_kN != null ? Math.round(b.tonnage_kN) + 'kN' : ''}</td>
          <td>${escapeHtml(why)}</td></tr>`;
      }).join('');
      
      detail = `
        <div class="sb-detail">
          <div class="sb-sim-wrap">
            <canvas class="sb-sim-canvas"></canvas>
            <div class="sb-sim-ctrls" style="flex-wrap: wrap; gap: 10px;">
              <button class="sb-sim-btn sb-sim-play" type="button">⏸ Pause</button>
              <button class="sb-sim-btn sb-sim-rec" type="button">⬇ Clip (.webm)</button>
              <span class="sb-sim-status muted"></span>
              
              <div class="sb-sim-selects" style="margin-left: auto; display: flex; gap: 8px; align-items: center;" onclick="event.stopPropagation()">
                <span style="font-size: 11px; opacity: 0.7; font-family: 'Flux Architect', sans-serif;">มีด (Punch):</span>
                <select class="sb-sim-punch-select" style="background: #16202c; color: #cad6e6; border: 1px solid #2a3744; border-radius: 6px; padding: 4px 6px; font-size: 11px; font-family: inherit; cursor: pointer;">
                  ${punchOptsHtml}
                </select>
                <span style="font-size: 11px; opacity: 0.7; font-family: 'Flux Architect', sans-serif; margin-left: 4px;">ร่อง (Die):</span>
                <select class="sb-sim-die-select" style="background: #16202c; color: #cad6e6; border: 1px solid #2a3744; border-radius: 6px; padding: 4px 6px; font-size: 11px; font-family: inherit; cursor: pointer;">
                  ${dieOptsHtml}
                </select>
              </div>
            </div>
          </div>
          ${rec.reason ? `<div class="sb-reason">${escapeHtml(rec.reason)}</div>` : ''}
          <table class="sb-table">
            <thead><tr><th>bend</th><th>die</th><th>r</th><th>ang</th>
              <th>flange</th><th>V</th><th>ton</th><th>note</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="8" class="muted">no per-bend data</td></tr>'}</tbody>
          </table>
          ${when ? `<div class="sb-when">checked ${escapeHtml(when)}${rec.checked_by ? ' · ' + escapeHtml(rec.checked_by) : ''}</div>` : ''}
        </div>`;
    }
    return `
      <div class="sb-card ${v.cls}" data-code="${escapeHtml(code)}" role="button" tabindex="0">
        <div class="sb-card-head">
          <span class="sb-code">${escapeHtml(code)}</span>
          <span class="sb-chip ${v.cls}">${v.txt}</span>
        </div>
        <div class="sb-meta">${nb} bend${nb === 1 ? '' : 's'}${np ? ` · ${np} problem${np === 1 ? '' : 's'}` : ''} · order: ${escapeHtml(order)}</div>
        ${detail}
      </div>`;
  }).join('');

  ROOT.innerHTML = `
    <div class="sb-home">
      ${picker}
      <div class="sb-banner">🔩 Sim.Bending — press-brake feasibility per part</div>
      <div class="sb-grid">${cards}</div>
    </div>`;

  _wireToolingPicker();
  ROOT.querySelectorAll('.sb-card').forEach(el => {
    const toggle = () => {
      const c = el.getAttribute('data-code');
      _simBendExpanded = (_simBendExpanded === c) ? null : c;
      render();
    };
    el.addEventListener('click', (e) => {
      // don't collapse the card when interacting with the simulation/controls
      if (e.target.closest && e.target.closest('.sb-sim-wrap')) return;
      toggle();
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });

  // (Re)mount the bend animation for the expanded card.
  if (_simController) { try { _simController.destroy(); } catch (e) {} _simController = null; }
  if (_simBendExpanded && window.kdSimBend) {
    const card = ROOT.querySelector(`.sb-card[data-code="${_simBendExpanded.replace(/"/g, '')}"]`);
    const canvas = card && card.querySelector('.sb-sim-canvas');
    const rec = _bendSimCache[_simBendExpanded];
    if (canvas && rec) {
      _simController = window.kdSimBend.mount(canvas, rec, _simBendExpanded);
      const playBtn = card.querySelector('.sb-sim-play');
      const recBtn = card.querySelector('.sb-sim-rec');
      const status = card.querySelector('.sb-sim-status');
      const punchSel = card.querySelector('.sb-sim-punch-select');
      const dieSel = card.querySelector('.sb-sim-die-select');
      
      _simController.onstatus = (t) => { if (status) status.textContent = t; };

      const updateToolOverrides = () => {
        const cat = window.KD_TOOLING || { punches: [], dies: [] };
        const pId = punchSel.value;
        const dId = dieSel.value;
        if (pId === 'AUTO') {
          if (_simController.setPunchOverride) {
            _simController.setPunchOverride('AUTO', 'AUTO');
          }
        } else {
          const pObj = cat.punches.find(p => p.id === pId);
          if (pObj && _simController.setPunchOverride) {
            _simController.setPunchOverride(pObj.id, pObj.type);
          }
        }
        if (dId === 'AUTO') {
          if (_simController.setDieOverride) {
            _simController.setDieOverride('AUTO', 'AUTO', 'AUTO', 'AUTO', 'AUTO');
          }
        } else {
          const dObj = cat.dies.find(d => d.id === dId);
          if (dObj && _simController.setDieOverride) {
            const v = dObj.v_list ? dObj.v_list[0] : 8;
            _simController.setDieOverride(dObj.id, v, dObj.angle_deg || 88, dObj.type, dObj.v_list);
          }
        }
      };

      if (punchSel && dieSel) {
        punchSel.addEventListener('change', (e) => {
          e.stopPropagation();
          updateToolOverrides();
        });
        dieSel.addEventListener('change', (e) => {
          e.stopPropagation();
          updateToolOverrides();
        });
        updateToolOverrides();
      }

      if (playBtn) playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _simController.toggle();
        playBtn.textContent = _simController.isPlaying() ? '⏸ Pause' : '▶ Play';
      });
      if (recBtn) recBtn.addEventListener('click', (e) => {
        e.stopPropagation(); _simController.recordClip();
      });
    }
  }
}

// Project picker for the Nest tab (admin only). Lists every project
// that has ≥1 uploaded DXF, shows uploaded-DXF count + total parts,
// click → kdNest.openProject(key). User 2026-05-28: 'nest ให้ย้าย
// ไปต่อ library admin ใช้ได้คนเดียว'.
function renderNestHome() {
  if (!isAdmin()) {
    ROOT.innerHTML = '<div class="error">Nesting workspace is admin-only.</div>';
    return;
  }
  const projects = manifest?.projects || {};
  const entries = Object.entries(projects)
    // Sync with the Projects tab: a project hidden there (soft-delete,
    // RTDB deleted_projects) must not show here either. User 2026-05-30:
    // 'ที่ลบโปรเจกต์งานทิ้งไปแล้ว ที่ nest ลบด้วย'.
    .filter(([key]) => !isProjectSoftDeleted(key))
    .map(([key, p]) => {
    const parts = Array.isArray(p.parts) ? p.parts : [];
    const totalQty = parts.reduce((s, x) => s + (x.qty || 0), 0);
    const dxfCount = parts.filter(x => x && x.code && dxfsForMasterCode(x.code).length > 0).length;
    return {
      key,
      name: p.name || key,
      uniqueParts: parts.length,
      totalQty,
      dxfCount,
      ready: dxfCount > 0,
      pinned: isPinned(key),   // shared with Projects view (_pinnedCache)
    };
  });
  // Order mirrors the Projects tab so reordering syncs BOTH ways: pinned
  // band first, then the shared manual rank (project_order — what the
  // ▲/▼ buttons and the Projects drag write), then ready (has DXFs), then
  // name for anything still unranked.
  const manualOrder = loadProjectOrder();
  const rankMap = new Map(manualOrder.map((k, i) => [k, i]));
  entries.sort((a, b) => {
    if (a.pinned !== b.pinned) return b.pinned - a.pinned;
    const ra = rankMap.has(a.key) ? rankMap.get(a.key) : Infinity;
    const rb = rankMap.has(b.key) ? rankMap.get(b.key) : Infinity;
    if (ra !== rb) return ra - rb;
    if (a.ready !== b.ready) return b.ready - a.ready;
    return a.name.localeCompare(b.name);
  });
  // Apply search filter if user typed.
  const q = (SEARCH.value || '').trim().toLowerCase();
  const filtered = q
    ? entries.filter(e => e.name.toLowerCase().includes(q) || e.key.toLowerCase().includes(q))
    : entries;

  if (!filtered.length) {
    ROOT.innerHTML = `
      <div class="nest-home">
        <div class="nest-home-banner">▶ Nesting Workspace</div>
        <div class="nest-home-empty">No projects to nest yet${q ? ` matching "${escapeHtml(q)}"` : ''}.</div>
      </div>`;
    COUNT_EL.textContent = '';
    return;
  }

  const orderedKeys = filtered.map(e => e.key);   // visual order for ▲/▼
  const rows = filtered.map((e, i) => {
    // Row is a <div role="button"> instead of a real <button> so we can
    // nest a clickable .pin-btn inside it (button-in-button is invalid
    // HTML). Click + keydown handlers wire it up below; aria-disabled
    // gates the open action when there are no DXFs, but the pin button
    // still works (admin may want to favorite a project that hasn't
    // exported yet).
    const cls = [
      'nest-home-row',
      e.ready ? '' : 'no-dxf',
      e.pinned ? 'pinned' : '',
    ].filter(Boolean).join(' ');
    const pinTitle = e.pinned ? 'Unpin from top' : 'Pin to top';
    const isFirst = i === 0, isLast = i === filtered.length - 1;
    return `
    <div class="${cls}" data-key="${escapeHtml(e.key)}" role="button" tabindex="0"
         ${e.ready ? '' : 'aria-disabled="true"'}>
      <span class="nest-move">
        <button class="nest-move-btn nest-up" data-key="${escapeHtml(e.key)}" aria-label="Move up" title="Move up" ${isFirst ? 'disabled' : ''}>▲</button>
        <button class="nest-move-btn nest-down" data-key="${escapeHtml(e.key)}" aria-label="Move down" title="Move down" ${isLast ? 'disabled' : ''}>▼</button>
      </span>
      <span class="nest-home-name">${escapeHtml(e.name)}</span>
      <span class="nest-home-stats">${e.uniqueParts} unique · ${e.totalQty} pcs · 📐 ${e.dxfCount}/${e.uniqueParts} DXFs</span>
      <span class="nest-home-cta">${e.ready ? '▶ Nest' : '⚠ no DXFs'}</span>
      <button class="pin-btn ${e.pinned ? 'on' : ''}" data-project="${escapeHtml(e.key)}"
              aria-label="${pinTitle}" title="${pinTitle}">${e.pinned ? '★' : '☆'}</button>
      <button class="nest-del-btn" data-key="${escapeHtml(e.key)}" aria-label="Hide project" title="Hide from list (also hides in Projects)">🗑</button>
    </div>`;
  }).join('');

  ROOT.innerHTML = `
    <div class="nest-home">
      <div class="nest-home-banner">
        ▶ Nesting Workspace
        <span class="nest-home-sub">Pick a project — workspace opens in-browser. Admin only.</span>
      </div>
      <div class="nest-home-rows">${rows}</div>
    </div>`;
  COUNT_EL.textContent = `${filtered.length} project${filtered.length === 1 ? '' : 's'}`;

  // Row open — skip if the click was on the pin button (pin has its own
  // handler below). aria-disabled rows (no DXFs) don't open. Keyboard
  // Enter/Space activates the same as click since the row is a div now.
  const _openRow = (row) => {
    if (row.getAttribute('aria-disabled') === 'true') return;
    const key = row.dataset.key;
    if (!key) return;
    if (window.kdNest && typeof window.kdNest.openProject === 'function') {
      window.kdNest.openProject(key);
    } else {
      alert('Nesting workspace not loaded — refresh the page.');
    }
  };
  const _ignoreSel = '.pin-btn, .nest-move-btn, .nest-del-btn';
  ROOT.querySelectorAll('.nest-home-row').forEach(row => {
    row.addEventListener('click', (ev) => {
      if (ev.target.closest(_ignoreSel)) return;
      _openRow(row);
    });
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        if (ev.target.closest(_ignoreSel)) return;
        ev.preventDefault();
        _openRow(row);
      }
    });
  });

  // Pin / unpin — toggles the shared _pinnedCache (same Firebase path as
  // the Projects-tab star). Re-render so the row jumps to the new sort
  // position immediately.
  ROOT.querySelectorAll('.nest-home-row .pin-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      togglePinned(btn.dataset.project);
      render();
    });
  });

  // ▲ / ▼ move — writes the shared manual order (project_order), so a row
  // moved here ALSO moves in the Projects tab (and vice-versa). We merge
  // the reordered visible keys with any keys filtered out by search so a
  // search-active reorder doesn't wipe the hidden rows' ranks.
  const _moveProject = (key, dir) => {
    const cur = orderedKeys.slice();
    const i = cur.indexOf(key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= cur.length) return;
    [cur[i], cur[j]] = [cur[j], cur[i]];
    const rest = loadProjectOrder().filter(k => !cur.includes(k));
    saveProjectOrder([...cur, ...rest]);
    render();
  };
  ROOT.querySelectorAll('.nest-move-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _moveProject(btn.dataset.key, btn.classList.contains('nest-up') ? -1 : 1);
    });
  });

  // 🗑 hide — same soft-delete as the Projects tab (RTDB deleted_projects),
  // so hiding here removes the project from BOTH lists. Parts stay in Library.
  ROOT.querySelectorAll('.nest-del-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const pk = btn.dataset.key;
      if (!confirm(`Hide project "${pk}" from the Nest AND Projects lists?\n\nParts stay in the Library. Reversible via RTDB deleted_projects/${pk}.`)) return;
      softDeleteProject(pk);
    });
  });
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
      Open a project assembly in Fusion and run <code>CC_Assembly</code></p>`;
    COUNT_EL.textContent = '';
    return;
  }

  const html = items.map((p, idx) => {
    const isTop = idx === 0 && !p.completed && !p.pinned;
    const cls = [
      'project-card',
      p.completed ? 'completed' : '',
      p.pinned ? 'pinned' : '',
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
      ? `<span class="project-badge bent"><span class="icon-bend"></span> ${p.bent_count}/${uniq} bent (${p.bent_pct}%)</span>`
      : '';
    const assembledBadge = p.assembled_count > 0
      ? `<span class="project-badge assembled">🧩 ${p.assembled_count}/${uniq} assembled (${p.assembled_pct}%)</span>`
      : '';
    const progressBars = `
      <div class="progress-bar bent-bar" title="Bending"><div class="progress-fill" style="width:${p.bent_pct}%"></div></div>
      <div class="progress-bar assembled-bar" title="🧩 Assembly"><div class="progress-fill" style="width:${p.assembled_pct}%"></div></div>
    `;
    // Workshop + admin both get pin/drag now — queue-management ops
    // every user benefits from. Delete stays admin-only (destructive
    // and reversible only via the RTDB console).
    const adminMode = isAdmin();
    const pinTitle = p.pinned ? 'Unpin from top' : 'Pin to top';
    const pinBtn = `<button class="pin-btn ${p.pinned ? 'on' : ''}" data-project="${escapeHtml(p.key)}" aria-label="${pinTitle}" title="${pinTitle}">${p.pinned ? '★' : '☆'}</button>`;
    const dragHandle = `<span class="drag-handle" aria-hidden="true" title="Drag to reorder">⋮⋮</span>`;
    // Admin delete project — soft-delete only. Parts in Library stay;
    // admin can re-add the project later (currently no UI for restore,
    // but the data is preserved under deleted_projects/<pk> for manual
    // restore via RTDB).
    const deleteBtn = adminMode
      ? `<button class="project-delete-btn" data-delete-project="${escapeHtml(p.key)}" aria-label="Delete project" title="Hide this project from the list (parts stay in Library)">🗑</button>`
      : '';
    return `
      <div class="${cls}" data-project="${escapeHtml(p.key)}">
        ${dragHandle}
        <div class="project-body">
          <div class="project-name">${escapeHtml(p.name || p.key)}${statusBadge}</div>
          <div class="project-meta">${escapeHtml(updated)} · ${uniq} unique · ${totalQty} pcs · ${p.drawn_count}/${uniq} drawn</div>
          ${progressBars}
          <div class="project-badges">${drawingBadge}${bentBadge}${assembledBadge}</div>
        </div>
        ${pinBtn}
        ${deleteBtn}
      </div>`;
  }).join('');

  ROOT.innerHTML = `<div class="project-list">${html}</div>`;

  // Card click → drill into project (but ignore clicks on pin, drag, or delete).
  ROOT.querySelectorAll('.project-card').forEach(el => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.pin-btn, .drag-handle, .project-delete-btn')) return;
      navTo({ kind: 'project', name: el.dataset.project });
    });
  });

  // Pin/unpin button — re-render to reflect new sort position.
  ROOT.querySelectorAll('.pin-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      togglePinned(btn.dataset.project);
      render();
    });
  });

  // Admin: 🗑 hide project from list (soft-delete). Parts in the
  // project's BOM stay in Library — the user explicitly asked for this
  // ("admin removes parts manually"). Restore is RTDB-only for now.
  ROOT.querySelectorAll('.project-delete-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const pk = btn.dataset.deleteProject;
      if (!confirm(`Hide project "${pk}" from the list?\n\nParts in the BOM will STAY in their Library folders — you can remove individual parts later if needed.\n\n(This is reversible from the RTDB at deleted_projects/${pk}.)`)) return;
      softDeleteProject(pk);
    });
  });

  // Drag-and-drop reorder (Sortable.js — touch-friendly for iPad).
  // Records the new visual order into localStorage, then re-renders so
  // the sort logic in projectList() reflects the manual order. Open to
  // everyone (including workshop iPad) per user request — workshop sorts
  // by bending order; the manual rank persists via saveProjectOrder.
  const listEl = ROOT.querySelector('.project-list');
  if (listEl && window.Sortable) {
    Sortable.create(listEl, {
      animation: 150,
      handle: '.drag-handle',
      ghostClass: 'project-card-ghost',
      chosenClass: 'project-card-chosen',
      dragClass: 'project-card-drag',
      forceFallback: true,  // consistent behavior across desktop + iPad
      fallbackTolerance: 4,
      onEnd: () => {
        const newOrder = [...listEl.querySelectorAll('.project-card')]
          .map(el => el.dataset.project);
        saveProjectOrder(newOrder);
        render();
      },
    });
  }

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

// ─── Project view mode (Bending workflow vs Assembly workflow) ─────
// Both are Kanban-style radial mindmaps; differ only in which checkbox
// is shown on each spoke (bend vs assembled). Workshop staff toggle
// to focus on one task at a time.
const LS_PROJECT_VIEW = 'kd_project_view_v1';
function getProjectViewMode() {
  try {
    const v = localStorage.getItem(LS_PROJECT_VIEW);
    // Migrate legacy 'list' / 'mindmap' → 'bending' (mindmap-by-default)
    if (v === 'bending' || v === 'assembly') return v;
    return 'bending';
  } catch { return 'bending'; }
}
function setProjectViewMode(v) {
  try { localStorage.setItem(LS_PROJECT_VIEW, v); } catch {}
}

// Project mindmap drill-down center (one per project, persisted)
const LS_PROJECT_CENTER = 'kd_project_center_v1';
const LS_PROJECT_LAYOUT = 'kd_project_layout_v1';  // per-project: 'tree' | 'flat' | 'expand'
const LS_PROJECT_EXPANDED = 'kd_project_expanded_v1';  // per-project: { code: true, ... } — which parents have their children visible (Expand mode)
// LS_MINDMAP_MODE removed 2026-05-26 — unified editor replaces the
// Auto|Custom toggle. Single React Flow view shows BOM + Custom nodes
// together; admin edits, workshop views.

// Lazy-load the React Flow editor bundle for the unified mindmap view.
// Bundle is ~317 KB minified — not worth shipping to workshop iPads that
// only ever use Auto mode. Returns a Promise that resolves once
// window.KitchenMindmapEditor.mount is callable.
let _editorBundlePromise = null;
function ensureEditorBundle() {
  if (window.KitchenMindmapEditor) return Promise.resolve();
  if (_editorBundlePromise) return _editorBundlePromise;
  _editorBundlePromise = new Promise((resolve, reject) => {
    const v = window.__KD_CACHE_V || Math.floor(Date.now() / 60000);
    const cssLink = document.createElement('link');
    cssLink.rel = 'stylesheet';
    cssLink.href = 'editor.bundle.css?v=' + v;
    document.head.appendChild(cssLink);
    const s = document.createElement('script');
    s.src = 'editor.bundle.js?v=' + v;
    s.onload = () => resolve();
    s.onerror = (e) => { _editorBundlePromise = null; reject(e); };
    document.body.appendChild(s);
  });
  return _editorBundlePromise;
}

// ── Custom mindmap persistence ───────────────────────────────────────
// Schema: custom_mindmaps/<projectKey>/{ nodes: {nid: {...}}, edges: {eid: {...}} }
// Pattern mirrors bent/assembled sync: localStorage cache for offline + first
// paint, debounced RTDB write, listener overwrites cache on remote change.
const LS_CUSTOM_MINDMAP = 'kd_custom_mindmap_v1';   // { projectKey: { nodes, edges } }

function _loadCustomMindmapLocal(projectKey) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_CUSTOM_MINDMAP) || '{}');
    const data = all[projectKey] || {};
    return {
      nodes: Array.isArray(data.nodes) ? data.nodes : [],
      edges: Array.isArray(data.edges) ? data.edges : [],
    };
  } catch { return { nodes: [], edges: [] }; }
}
function _saveCustomMindmapLocal(projectKey, { nodes, edges }) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_CUSTOM_MINDMAP) || '{}');
    if ((nodes && nodes.length) || (edges && edges.length)) {
      all[projectKey] = { nodes: nodes || [], edges: edges || [] };
    } else {
      delete all[projectKey];
    }
    localStorage.setItem(LS_CUSTOM_MINDMAP, JSON.stringify(all));
  } catch {}
}

// Convert React Flow node → RTDB-friendly (strip functions, keep position)
function _rfNodeToRtdb(n) {
  return {
    label: (n.data && n.data.label) || '',
    x: n.position?.x ?? 0,
    y: n.position?.y ?? 0,
    fusion_link: n.data?.fusion_link || null,
  };
}
function _rtdbToRfNode(id, raw) {
  return {
    id,
    type: 'mindmap',
    position: { x: Number(raw.x) || 0, y: Number(raw.y) || 0 },
    data: {
      label: raw.label || 'untitled',
      ...(raw.fusion_link ? { fusion_link: raw.fusion_link } : {}),
    },
  };
}

async function _loadCustomMindmap(projectKey) {
  const cached = _loadCustomMindmapLocal(projectKey);
  if (!window.firebaseDB) return cached;
  try {
    const snap = await window.firebaseDB
      .ref('custom_mindmaps/' + projectKey).once('value');
    const data = snap.val() || {};
    const nodes = data.nodes
      ? Object.entries(data.nodes).map(([id, raw]) => _rtdbToRfNode(id, raw))
      : [];
    const edges = data.edges
      ? Object.entries(data.edges).map(([id, raw]) => ({
          id, source: raw.source, target: raw.target,
        }))
      : [];
    // Mirror to LS so next first-paint has data without a Firebase round trip.
    _saveCustomMindmapLocal(projectKey, { nodes, edges });
    return { nodes, edges };
  } catch (e) {
    console.warn('[kme] load RTDB failed, using LS cache:', e);
    return cached;
  }
}

// ── BOM nodes + overrides ────────────────────────────────────────────
// Unified editor combines BOM-derived nodes (id = bom:<code>) with
// user-added Custom nodes (id = n_xxx). BOM nodes can't be deleted but
// admin can drag them (position) + rename (label) — these edits live
// in custom_mindmaps/<pk>/overrides/<id>/{x,y,label} so reloading
// a project always rebuilds the BOM defaults first, then re-applies
// per-user overrides on top.

function _radialLayout(count, centerX, centerY, radius) {
  // Evenly distribute count items on a circle. centerX/Y default to 0;
  // radius scales with count so larger BOMs don't crowd.
  const r = Math.max(radius || 0, 240 + count * 12);
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 - Math.PI / 2;  // start at top
    out.push({
      x: (centerX || 0) + r * Math.cos(a),
      y: (centerY || 0) + r * Math.sin(a),
    });
  }
  return out;
}

function _familyForCode(code) {
  const auto = manifest?.auto_generated || {};
  const fam = auto[code]?.family || 'Other';
  return _remapFamilyForCode(code, fam);
}
// Layer palette — node + edge color by depth from the Project center.
// Curated, maximally-distinct hues for the first several layers so adjacent
// rings never look alike (gold → blue → green → purple → pink). The old even
// hue ramp put layer 2 (yellow-green) right next to layer 3 (green) and they
// were hard to tell apart (user 2026-05-30). Beyond the curated set, fall back
// to a wide hue rotation so ANY depth still resolves to a color (no cap).
const _LAYER_HUES = [38, 205, 140, 275, 330];  // L1 gold · L2 blue · L3 green · L4 purple · L5 pink
const _LAYER_FALLBACK_STEP = 72;               // degrees per layer beyond the curated set
const _LAYER_SAT = 62;        // border/edge saturation %
const _LAYER_LIGHT = 60;      // border/edge lightness %
// Leaf parts (the dashed tip nodes — actual workshop parts) all share ONE
// colour regardless of depth, so the final layer reads uniformly instead of
// some leaves blue (depth 2) and others green (depth 3). Layer colours then
// only mark the structural/sub-assembly nodes. (user 2026-05-30)
const _LAYER_LEAF_HUE = 140;  // green
function _hslPair(hue) {
  return {
    color: `hsl(${hue}, ${_LAYER_SAT}%, ${_LAYER_LIGHT}%)`,  // border + edge stroke
    tint:  `hsl(${hue}, 40%, 18%)`,                          // dark fill endpoint over #161b22
  };
}
function _layerColor(depth) {
  const i = depth - 1;
  const hue = i < _LAYER_HUES.length
    ? _LAYER_HUES[i]
    : ((_LAYER_HUES[0] + i * _LAYER_FALLBACK_STEP) % 360 + 360) % 360;
  return _hslPair(hue);
}
function _leafColor() { return _hslPair(_LAYER_LEAF_HUE); }
function _familyColors(famKey) {
  const f = (families || {})[famKey] || (families || {})['Other'] || {};
  return { color: f.color || '#888', tint: f.tint || '#262626' };
}

function _buildBomNodes(project, parts, projectKey) {
  // Layout — two modes, picked by tree shape:
  //
  // 1. Option A · local radial per variant (default when buildProjectTree
  //    emits any _is_variant_root node). Each variant becomes its own
  //    sub-center sitting on a circle of radius VARIANT_RING around the
  //    project center. The variant's descendants orbit AROUND THE VARIANT
  //    at sub-radii [subR0, ~1.5x, ~1.95x] by depth, in a sub-arc centred
  //    on the outward direction (away from project center). This produces
  //    visible "ก้อนใหญ่" per variant instead of one big radial fan.
  //    Per spec docs/superpowers/specs/2026-05-28-assembly-cluster-and-
  //    project-favorites-design.md §2. Constants table is hard-coded by
  //    variant count so adjacent clusters don't collide.
  //
  // 2. Legacy global-ring (when no _is_variant_root in the tree — older
  //    Fusion projects whose CC_Assembly export pre-dates the
  //    variant_root field). Places everything on concentric rings around
  //    the project center, dividing the full 360° among root subtrees by
  //    leaf count.
  //
  // Leaves (no children) flag isLeaf so the editor renders them dashed
  // and routes click → leaf-to-Fusion. Center "project" node sits at
  // (0,0) and is the click target for the project PDF (same as the old
  // SVG mindmap's .mm-center).
  const ps = (parts || project?.parts || []).filter(p => p && p.code);
  // Offset by half the circle size so the circle's VISUAL center sits
  // at (0, 0) — that's where every spoke line points to. React Flow's
  // position.x/y is the node's top-left corner, not its center.
  const CENTER_DIAM = 140;
  const center = {
    id: `project:${projectKey}`,
    type: 'mindmap',
    position: { x: -CENTER_DIAM / 2, y: -CENTER_DIAM / 2 },
    draggable: true,
    data: {
      label: project?.name || projectKey,
      code: projectKey,
      kind: 'project',
      projectKey,
    },
  };
  if (!ps.length) return { nodes: [center], edges: [] };

  // Build hierarchical tree using existing logic (handles parent_code +
  // virtual wrappers + prefix fallback + Pass 4 variant grouping). Same
  // source the SVG mindmap used.
  const { roots, all } = buildProjectTree(ps, projectKey);

  const nodes = [center];
  const edges = [];

  function leafCount(n) {
    if (!n.children?.length) return 1;
    return n.children.reduce((s, c) => s + leafCount(c), 0);
  }

  // Emit a BOM node at (x, y). Returns the node's compound key so callers
  // can wire edges. Both real variant roots (from CC_Assembly's Pass 4)
  // and top-level legacy parents with children get marked as anchors
  // via opts.forceIsAnchor so checklist mode treats them identically.
  // opts.anchorNodeId lets recursive placeSubtree calls thread the
  // ancestor anchor id down so kids carry the right variantNodeId.
  function emitNode(node, x, y, opts) {
    opts = opts || {};
    const famKey = _remapFamilyForCode(node.code, node.family);
    const colors = _familyColors(famKey);
    const isLeaf = !node.children?.length;
    const isWrapper = !!node._is_wrapper;
    const partMissing = !isWrapper && !pdfUrlForCode(node.code);
    // React Flow ID uses the COMPOUND code+variant_root key so a part
    // that appears in multiple variants gets distinct nodes (per user
    // 2026-05-28 'ชื่อจะซ้ำไม่เป็นไร'). Falls back to plain code when
    // the project has no variants — preserves stale-link compatibility.
    const nodeKey = node._id || `${node.code}::`;
    // isVariantRoot flag — true for real variant roots AND for any
    // top-level parent that the layout is treating as a cluster anchor
    // (user 2026-05-28: 'Auto-cluster ตาม parent_code: ทุก top-level
    // master ที่มี children = ก้อน (collapsible)').
    const isVariantRoot = opts.forceIsAnchor != null
      ? !!opts.forceIsAnchor
      : !!node._is_variant_root;
    // variantNodeId points at the cluster anchor this node descends
    // from. For an anchor itself: null. For a descendant: the anchor's
    // React Flow id, passed in via opts.anchorNodeId. Falls back to the
    // legacy variant_root code-derived id when no anchor is threaded.
    let variantNodeId;
    if (isVariantRoot) {
      variantNodeId = null;
    } else if (opts.anchorNodeId) {
      variantNodeId = opts.anchorNodeId;
    } else if (node._variant_root) {
      variantNodeId = `bom:${node._variant_root}::`;
    } else {
      variantNodeId = null;
    }
    nodes.push({
      id: `bom:${nodeKey}`,
      type: 'mindmap',
      position: { x, y },
      data: {
        label: node.code,
        kind: 'bom',
        qty: node.qty || 0,
        family: famKey,
        color: colors.color,
        tint: colors.tint,
        projectKey,
        isLeaf,
        isWrapper,
        // Mark variant-root nodes so the editor's checklist mode can:
        //   (a) seed them into the initially-collapsed set on first
        //       open of an assembly view, and
        //   (b) recognise clicks on them as expand/collapse toggles.
        isVariantRoot,
        variantNodeId,
        missing: partMissing && isLeaf,
        status: node.status,
        urn: node.urn || null,
        drawing_urn: node.drawing_urn || null,
      },
    });
    return { nodeKey, color: colors.color };
  }

  function emitEdge(sourceId, targetKey, color, strong) {
    edges.push({
      id: `e:${sourceId}:${targetKey}`,
      type: 'floating',
      source: sourceId,
      target: `bom:${targetKey}`,
      style: {
        stroke: color,
        strokeWidth: strong ? 1.6 : 1.2,
        opacity: strong ? 0.65 : 0.5,
      },
      selectable: false,
    });
  }

  // Recursive subtree placer — drops `node` at distance `rings[depth-1]`
  // from (cx, cy), then recurses children inside arcStart..arcEnd. `depth`
  // is 1-indexed: a direct child of the cluster anchor is depth 1, its
  // grandchild depth 2, etc. The anchor itself must be emitted by the
  // caller before calling this.
  // anchorNodeId threads the cluster anchor's React Flow id down through
  // the recursion so every descendant carries variantNodeId pointing at
  // the right anchor. Lets compact mode stack the whole subtree on the
  // anchor when it's collapsed.
  function placeSubtree(node, cx, cy, rings, depth, arcStart, arcEnd, anchorNodeId) {
    const angle = (arcStart + arcEnd) / 2;
    const r = rings[Math.min(depth - 1, rings.length - 1)];
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    const { nodeKey, color } = emitNode(node, x, y, { anchorNodeId });
    if (node.children?.length) {
      const totalLeaves = leafCount(node);
      let cursor = arcStart;
      for (const child of node.children) {
        const w = leafCount(child) / totalLeaves;
        const childArcEnd = cursor + (arcEnd - arcStart) * w;
        const childKey = child._id || `${child.code}::`;
        emitEdge(`bom:${nodeKey}`, childKey, color, false);
        placeSubtree(child, cx, cy, rings, depth + 1, cursor, childArcEnd, anchorNodeId);
        cursor = childArcEnd;
      }
    }
  }

  // ── Radial tree layout (2026-05-29 rewrite) ──────────────────────
  // Goals (user 2026-05-29): tidy, even gaps, as CLOSE to the project
  // center as possible, and NEVER overlapping. Standard radial tree:
  //   • every leaf gets an equal angular slot (plus a small gap between
  //     top-level clusters so variants read as separate "ก้อน");
  //   • an internal node sits at the angular MIDPOINT of its subtree
  //     (parents inner / children outer = clear hierarchy);
  //   • ring radius grows one even step per depth;
  //   • the outer ring radius is scaled to the leaf count so adjacent
  //     leaf cards always clear MIN_SPACING center-to-center — this is
  //     what guarantees no overlap, while keeping the whole map as
  //     compact as that constraint allows.
  // Node moves stay admin-only (onNodesChange drops non-admin position
  // changes), so this auto-layout is the canonical arrangement.
  const CARD_W = 168;                 // ~node card width
  const CARD_H = 70;                  // ~node card height
  const MIN_SPACING = CARD_W + 26;    // min center-to-center on a ring

  function maxDepthOf(node, d) {
    if (!node.children?.length) return d;
    return Math.max(...node.children.map((c) => maxDepthOf(c, d + 1)));
  }
  const maxDepth = Math.max(1, ...roots.map((r) => maxDepthOf(r, 1)));
  const totalLeaves = roots.reduce((s, r) => s + leafCount(r), 0) || 1;

  // Gap between top-level clusters, in leaf-slot widths (0 for a single
  // cluster so it isn't pushed off-center).
  const CLUSTER_GAP = roots.length > 1 ? 0.7 : 0;
  const effLeaves = totalLeaves + CLUSTER_GAP * roots.length;
  const slot = (2 * Math.PI) / effLeaves;   // radians per leaf

  // Outer radius so leaf slots clear MIN_SPACING; floored so a tiny tree
  // isn't cramped, capped so a huge one stays sane.
  const Router = Math.min(2600, Math.max(340, MIN_SPACING / slot));
  // One even ring step per depth — never tighter than a card height + gap
  // so stacked rings can't overlap vertically either.
  const RING_STEP = Math.max(Router / maxDepth, CARD_H + 85);

  // Pass 1 — assign every node an angle. Post-order: place a leaf into the
  // next slot, an internal node at the midpoint of its subtree's span.
  let leafCursor = -Math.PI / 2;   // start at 12 o'clock
  function assignAngles(node) {
    if (!node.children?.length) {
      node._ang = leafCursor + slot / 2;
      leafCursor += slot;
      return;
    }
    const start = leafCursor;
    for (const c of node.children) assignAngles(c);
    node._ang = (start + leafCursor) / 2;
  }
  for (const root of roots) {
    assignAngles(root);
    leafCursor += CLUSTER_GAP * slot;   // breathing room before next cluster
  }

  // Pass 2 — place each node on its depth ring at its assigned angle and
  // wire the edges. Top roots (depth 1) connect to the project center.
  function placeRadial(node, depth, anchorNodeId, parentSourceId, parentColor, isTopRoot) {
    const r = RING_STEP * depth;
    const x = r * Math.cos(node._ang);
    const y = r * Math.sin(node._ang);
    const isAnchor = !!node._is_variant_root || !!node.children?.length;
    const { nodeKey, color } = emitNode(node, x, y,
      isTopRoot ? { forceIsAnchor: isAnchor } : { anchorNodeId });
    if (isTopRoot) emitEdge(`project:${projectKey}`, nodeKey, color, true);
    else emitEdge(parentSourceId, nodeKey, parentColor || color, false);
    const myAnchor = isTopRoot ? `bom:${nodeKey}` : anchorNodeId;
    if (node.children?.length) {
      for (const c of node.children) {
        placeRadial(c, depth + 1, myAnchor, `bom:${nodeKey}`, color, false);
      }
    }
  }
  for (const root of roots) {
    placeRadial(root, 1, null, null, null, true);
  }

  // Post-build pass: depth = hops from the Project center along the directed
  // center→child edges. Recolor every BOM node (incl wrapper / variant-root
  // containers) and each incoming edge by layer. Center stays its blue anchor.
  function _applyLayerColors(nodes, edges, centerId) {
    const adj = new Map();
    for (const e of edges) {
      if (!adj.has(e.source)) adj.set(e.source, []);
      adj.get(e.source).push(e.target);
    }
    const layerOf = new Map([[centerId, 0]]);
    const queue = [centerId];
    while (queue.length) {
      const id = queue.shift();
      const d = layerOf.get(id);
      for (const t of (adj.get(id) || [])) {
        if (!layerOf.has(t)) { layerOf.set(t, d + 1); queue.push(t); }
      }
    }
    const byId = new Map(nodes.map(n => [n.id, n]));
    for (const [id, depth] of layerOf) {
      if (depth < 1) continue;                       // skip center (layer 0)
      const node = byId.get(id);
      if (!node || node.data?.kind !== 'bom') continue;
      // Leaf tips all share the leaf colour; structural nodes take their layer.
      const { color, tint } = node.data.isLeaf ? _leafColor() : _layerColor(depth);
      node.data.color = color;
      node.data.tint = tint;
      node.data.layer = depth;                        // exposed for verification/debug
    }
    for (const e of edges) {
      const depth = layerOf.get(e.target);
      if (depth == null || depth < 1) continue;
      const tnode = byId.get(e.target);
      const stroke = (tnode && tnode.data?.isLeaf ? _leafColor() : _layerColor(depth)).color;
      e.style = { ...(e.style || {}), stroke };
    }
  }

  _applyLayerColors(nodes, edges, `project:${projectKey}`);
  return { nodes, edges };
}

// Expose project-scoped APIs the editor's rich node card needs. The
// editor bundle is an IIFE, not an ES module — easiest cross-boundary
// hand-off is a single window object. Keep this small + stable.
function _exposeKdApi() {
  window.kdAPI = {
    // Navigate back to the project list — same as the header ← arrow. The
    // fullscreen mindmap hides that header, so its in-canvas Back button
    // calls this. (2026-05-29)
    back: navBack,
    isBent, markBent, isAssembled, markAssembled,
    isTimerRunning, startTimer, stopTimer, resetTimer,
    getTimerTotalSeconds, formatDuration,
    getComments,
    // Per-code comment write (read side getComments already exposed). Used by
    // the assembly checklist panel's inline comment thread. (2026-05-30)
    addComment,
    // Delete a comment (checklist thread 🗑). (2026-05-30)
    deleteComment: removeComment,
    // Aggregated parts for the project: unique code + summed qty across
    // variants (real parts only — wrappers aren't in project.parts). Drives
    // the assembly checklist list. (2026-05-30)
    assemblyParts: (pk) => _aggregatePartsByCode((manifest.projects?.[pk]?.parts) || []),
    pdfUrlForCode,
    projectPdfUrl,   // direct match + scan auto_generated for <pk>.pdf
    routeLeaf: _routeLeafToFusion,
    uploadPdfFromDrop,
    // Open URL using PWA-standalone-aware logic (navigate same window
    // on standalone, open new tab in browser). Without this, taps on
    // PDF in standalone PWA open an invisible off-screen webview.
    openInNewTab: _openInNewTab,
    // Workshop ops should re-render the project header (bent/assembled
    // counters update) without remounting the editor — preserves the
    // user's in-progress drag positions. Editor reads its own state via
    // bump() for cell-level updates.
    rerender: () => { try { render(); } catch {} },
    // Deep-link from a mindmap BOM node's NO PDF chip to the matching
    // part row in the Library tab. Replaces the nav stack (not push)
    // so Back goes to Library home, not project mindmap — see spec
    // 2026-05-27-library-link-from-bom-node-design.md §UX Flow.
    openInLibrary(code) {
      if (!code) return;
      // Workshop can't access Library — chip is informational only.
      if (!isAdmin()) return;
      // Resolve the destination folder in this order so the chip lands
      // where the user expects:
      //   1. Admin's per-code family_override (Library "📁 move part" set it)
      //   2. Fusion-side family + UI remap (_remapFamilyForCode)
      // Without step 1, a part that the admin moved to "MyCustomFolder"
      // would still open the original Fusion-assigned folder when the
      // chip is tapped — confusing because the part isn't there anymore.
      const fusionFam = _remapFamilyForCode(code,
        (manifest?.auto_generated?.[code]?.family) ||
        (manifest?.projects && Object.values(manifest.projects)
          .flatMap(p => p.parts || [])
          .find(p => p.code === code)?.family));
      const fam = effectiveFamily(code, fusionFam);
      if (!fam) return;
      // Stash the CURRENT stack top as the "source" so the family
      // breadcrumb in renderFamily can offer a one-tap return path.
      // Only carries 'project' / 'projects' shapes — falling through to
      // 'library' or 'family' would loop back to ourselves. User
      // 2026-05-29: 'เป็นปุ่มให้กดกลับไปที่ๆมาได้'.
      const prevTop = stack[stack.length - 1] || null;
      const source = (prevTop && (prevTop.kind === 'project' || prevTop.kind === 'projects'))
        ? { kind: prevTop.kind, name: prevTop.name }
        : null;
      view = 'library';
      document.getElementById('tab-projects')?.classList.remove('active');
      document.getElementById('tab-library')?.classList.add('active');
      stack = [{ kind: 'family', name: fam, highlight: code, source }];
      render();
    },
  };
}

const LS_OVERRIDES = 'kd_mindmap_overrides_v1';   // { projectKey: { nodeId: { x?, y?, label? } } }

function _loadOverridesLocal(projectKey) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_OVERRIDES) || '{}');
    return all[projectKey] || {};
  } catch { return {}; }
}
function _saveOverridesLocal(projectKey, overrides) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_OVERRIDES) || '{}');
    all[projectKey] = overrides;
    localStorage.setItem(LS_OVERRIDES, JSON.stringify(all));
  } catch {}
}

async function _loadOverrides(projectKey) {
  // First-paint comes from LS so a re-render mid-drag (e.g. from a
  // bent/timer toggle calling render()) doesn't snap nodes back to
  // their default radial positions. RTDB read upgrades after.
  const lsCopy = _loadOverridesLocal(projectKey);
  if (!window.firebaseDB) return lsCopy;
  try {
    const snap = await window.firebaseDB
      .ref(`custom_mindmaps/${projectKey}/overrides`).once('value');
    const remote = snap.val() || {};
    // Remote wins for any key it has — but LS keeps in-flight drags that
    // haven't been flushed yet (those keys live only in LS until the
    // 500ms debounce fires).
    const merged = { ...lsCopy, ...remote };
    _saveOverridesLocal(projectKey, merged);
    return merged;
  } catch (e) {
    console.warn('[kme] load overrides failed:', e);
    return lsCopy;
  }
}

function _applyOverrides(nodes, overrides) {
  if (!overrides || !Object.keys(overrides).length) return nodes;
  return nodes.map(n => {
    const o = overrides[n.id];
    if (!o) return n;
    const hasPosOverride = o.x != null && o.y != null;
    return {
      ...n,
      position: hasPosOverride
        ? { x: Number(o.x), y: Number(o.y) }
        : n.position,
      data: {
        ...n.data,
        ...(o.label != null ? { label: o.label } : {}),
        // Flag so the editor's checklist-mode compact-position override
        // knows to step aside — user 2026-05-28: 'ให้ แอดมิน ย้าย node
        // ได้'. Without this, a drag persisted via _saveOverride would
        // be undone on the next render by the compactByVariantId pull.
        ...(hasPosOverride ? { hasPosOverride: true } : {}),
      },
    };
  });
}

const _overrideWriteTimers = new Map();
function _saveOverride(projectKey, nodeId, patch) {
  // LS write first — synchronous, so a re-render triggered by an
  // unrelated workshop op (bent/timer) reads the in-flight drag
  // positions back instead of snapping to defaults.
  const ls = _loadOverridesLocal(projectKey);
  ls[nodeId] = { ...(ls[nodeId] || {}), ...patch };
  _saveOverridesLocal(projectKey, ls);
  if (!window.firebaseDB) return;
  // RTDB write debounced per project so a fast drag doesn't spam.
  const key = projectKey;
  const pending = _overrideWriteTimers.get(key) || { patches: {}, t: null };
  pending.patches[nodeId] = { ...(pending.patches[nodeId] || {}), ...patch };
  if (pending.t) clearTimeout(pending.t);
  pending.t = setTimeout(() => {
    const updates = {};
    for (const [nid, p] of Object.entries(pending.patches)) {
      for (const [k, v] of Object.entries(p)) {
        updates[`custom_mindmaps/${projectKey}/overrides/${nid}/${k}`] = v;
      }
    }
    window.firebaseDB.ref().update(updates).catch(err =>
      console.warn('[kme] save override failed:', err));
    _overrideWriteTimers.delete(key);
  }, 500);
  _overrideWriteTimers.set(key, pending);
}

// Debounced write — coalesces rapid drag-drop events into one RTDB roundtrip.
const _customMindmapWriteTimers = new Map();
function _saveCustomMindmap(projectKey, { nodes, edges }) {
  // Local first — never lose data even if Firebase is offline.
  _saveCustomMindmapLocal(projectKey, { nodes, edges });
  if (!window.firebaseDB) return;
  clearTimeout(_customMindmapWriteTimers.get(projectKey));
  _customMindmapWriteTimers.set(projectKey, setTimeout(() => {
    const payload = {
      nodes: {},
      edges: {},
      updated_at: Date.now(),
    };
    (nodes || []).forEach(n => { payload.nodes[n.id] = _rfNodeToRtdb(n); });
    (edges || []).forEach(e => {
      payload.edges[e.id] = { source: e.source, target: e.target };
    });
    // If empty mindmap, wipe the RTDB key entirely so listeners don't see ghosts.
    const ref = window.firebaseDB.ref('custom_mindmaps/' + projectKey);
    const op = (!nodes?.length && !edges?.length) ? ref.set(null) : ref.set(payload);
    op.catch(err => console.warn('[kme] save RTDB failed:', err));
  }, 500));
}

function getExpandedSet(projectKey) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_PROJECT_EXPANDED) || '{}');
    return new Set(Array.isArray(all[projectKey]) ? all[projectKey] : []);
  } catch { return new Set(); }
}
function setExpandedSet(projectKey, set) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_PROJECT_EXPANDED) || '{}');
    if (set.size) all[projectKey] = [...set];
    else delete all[projectKey];
    localStorage.setItem(LS_PROJECT_EXPANDED, JSON.stringify(all));
  } catch {}
}
function toggleExpandedNode(projectKey, code) {
  const s = getExpandedSet(projectKey);
  if (s.has(code)) s.delete(code); else s.add(code);
  setExpandedSet(projectKey, s);
}

function getProjectLayout(/* projectKey */) {
  // Layout toggle removed — always Expand. Kept as a function so any
  // legacy callers still resolve cleanly.
  return 'expand';
}
function setProjectLayout(projectKey, layout) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_PROJECT_LAYOUT) || '{}');
    if (layout && layout !== 'tree') all[projectKey] = layout;
    else delete all[projectKey];
    localStorage.setItem(LS_PROJECT_LAYOUT, JSON.stringify(all));
  } catch {}
}
// Back-compat shim — anywhere still asking "is flat" still works.
function isProjectFlat(projectKey) { return getProjectLayout(projectKey) === 'flat'; }
function setProjectFlat(projectKey, flat) { setProjectLayout(projectKey, flat ? 'flat' : 'tree'); }
function getProjectMindmapCenter(projectKey) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_PROJECT_CENTER) || '{}');
    return all[projectKey] || null;
  } catch { return null; }
}
function setProjectMindmapCenter(projectKey, code) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_PROJECT_CENTER) || '{}');
    if (code) all[projectKey] = code; else delete all[projectKey];
    localStorage.setItem(LS_PROJECT_CENTER, JSON.stringify(all));
  } catch {}
}

// Build hierarchy tree from project parts using same wildcard prefix
// rules as the Library Tree tab (0/X positions = wildcards). Returns
// { roots, all } same as buildLibraryTree, but preserves qty + project
// context. Soft-deleted parts use status 'deleted'.
// Build a unique-per-(code, variant_root) tree node identity.
// Plain code can repeat across variants (e.g. SD00NA-080000 lives in
// both 10WVON-08OLOR and 10WVON-12OLOR per Fusion's tree). Keying
// nodes by ``${code}::${variant_root}`` lets the mindmap show the
// part twice, once under each variant's subtree, with its own qty.
function _nodeId(code, variantRoot) {
  return `${code}::${variantRoot || ''}`;
}

function buildProjectTree(parts, projectKey) {
  const auto = manifest.auto_generated || {};
  const nodes = parts.map(p => {
    // Drawing status uses the EFFECTIVE code (own entry, else group sibling
    // with one). Per the shared-drawing rule, multiple part codes can map
    // to one workshop drawing — see _drawingAliasIndex.
    const drawingCode = _effectiveDrawingCode(p.code);
    const entry = auto[drawingCode];
    const softDeleted = isDrawingSoftDeleted(p.code);  // soft-delete is per-code
    let status = 'missing';
    if (entry) {
      if (softDeleted) {
        status = 'deleted';
      } else {
        // Stale = master has been saved AFTER the drawing was last exported.
        // Detected by comparing fusion_version (master version at last scan)
        // vs last_drawn_version (master version when PDF was exported).
        const fv = entry.fusion_version || 0;
        const lv = entry.last_drawn_version || 0;
        status = (fv > lv) ? 'stale' : 'drawn';
      }
    } else if (!softDeleted && pdfUrlForCode(p.code)) {
      // No manifest entry, but a web-uploaded sibling covers this code
      // via prefix-share or an explicit group alias. Treat as drawn so
      // the project mindmap stops flagging it as ⚠ NO DRAWING.
      status = 'drawn';
    }
    return {
      code: p.code,
      qty: p.qty || 1,
      _prefix: p.code.split('-')[0],
      _parent_code: p.parent_code || null,  // from CC_Assembly hierarchy
      _variant_root: p.variant_root || null,  // from CC_Assembly (since 2026-05-28) — immediate child of project root
      family: p.family || 'Other',
      pdf: entry ? entry.pdf : null,
      page: entry ? (entry.page_number || 1) : 1,
      // URN of the master .f3d (from CC_Assembly) and of the linked drawing
      // (from manifest auto_generated). Used by leaf-click routing per
      // feedback_leaf_click_routing rule: missing→open 3D, otherwise→drawing.
      // Master URN stays per-code (separate .f3d). Drawing URN follows the
      // effective code (shared drawing).
      urn: p.urn || null,
      drawing_urn: entry ? (entry.drawing_urn || null) : null,
      status,
      _is_wrapper: false,
      _is_variant_root: false,
      children: [],
      parent: null,
    };
  });

  // Hierarchy resolution — THREE sources:
  //   (a) Explicit parent_code from CC_Assembly JSON (the new shape, from
  //       Fusion occurrence chain). Authoritative when present.
  //   (b) Virtual wrapper nodes — when parent_code points to a code NOT in
  //       parts[] (typical case: wrapper config rows like FN0FL2-110004
  //       which are containers, not ALPF leaves), create a synthetic node
  //       so the hierarchy is visible. Wrappers have qty=0, status='wrapper',
  //       no PDF, and are excluded from the BOM total — they exist purely
  //       to anchor the tree.
  //   (c) Prefix/wildcard matching on code (legacy fallback for projects
  //       built before parent_code was emitted).
  // Index by COMPOUND key (code + variant_root) so the same code can
  // appear twice in the parts list (once per variant) without one
  // overwriting the other. Wrappers live under the same variant as
  // their child leaves — created in Pass 1, one per (parent_code,
  // variant_root) pair.
  for (const n of nodes) {
    n._id = _nodeId(n.code, n._variant_root);
  }
  const byId = new Map(nodes.map(n => [n._id, n]));

  // Pass 1 — auto-create virtual wrappers per (parent_code, variant_root)
  // so the wrapper count matches the variant structure. BK0DN0-080000
  // belongs under 10WVON-08OLOR; BK0DN0-120000 under 10WVON-12OLOR.
  // Without per-variant wrapper IDs, both leaves would collapse to the
  // same wrapper node.
  const wrapperKeys = new Set();
  for (const node of nodes) {
    if (!node._parent_code) continue;
    const parentId = _nodeId(node._parent_code, node._variant_root);
    if (!byId.has(parentId)) wrapperKeys.add(parentId + '\0' + (node._variant_root || ''));
  }
  for (const wkey of wrapperKeys) {
    const [parentId, vr] = wkey.split('\0');
    // parentId is `${code}::${vr}` — split back to retrieve code
    const wc = parentId.slice(0, parentId.lastIndexOf('::'));
    const wrapper = {
      code: wc,
      // qty=1: a virtual wrapper represents ONE sub-assembly instance
      // in this project. CC_Assembly only counts ALPF leaves, so the
      // wrapper itself isn't in the BOM and qty is otherwise unknown.
      // 1 is the right default — sub-assemblies that appear N times
      // in a Fusion tree don't currently come through this codepath.
      // (User flagged on 2026-05-28 that 0 was confusing — "ประกอบแล้ว
      // ก็ต้องได้เท่ากับหนึ่งชิ้นงาน").
      qty: 1,
      _prefix: wc.split('-')[0],
      _parent_code: null,
      _variant_root: vr || null,
      family: _remapFamilyForCode(wc, 'Other'),
      pdf: null,
      page: 1,
      status: 'wrapper',
      _is_wrapper: true,
      _is_variant_root: false,
      _id: parentId,
      children: [],
      parent: null,
    };
    nodes.push(wrapper);
    byId.set(parentId, wrapper);
  }

  // Pass 2 — explicit parent_code links scoped by variant_root, so
  // BK1DN1-080000 (variant 08) attaches to BK0DN0-080000@08, not to
  // BK0DN0-080000@12 if such existed.
  for (const node of nodes) {
    if (node.parent) continue;
    if (!node._parent_code) continue;
    const parentId = _nodeId(node._parent_code, node._variant_root);
    if (byId.has(parentId)) {
      const par = byId.get(parentId);
      node.parent = par;
      par.children.push(node);
    }
  }

  // Pass 3 — prefix/wildcard for nodes still without a parent (legacy
  // projects with no parent_code in their JSON).
  //
  // Two important skips here:
  //  • Wrappers are never made children. They're authoritative roots
  //    (or children of higher-level wrappers if/when those exist). The
  //    prefix matcher treats '0' / 'X' as wildcards, so a leaf like
  //    FN0F00 looks like the "ancestor" of FN0FL2 — wrong direction
  //    for the wrapper relationship CC_Assembly already emitted.
  //  • A node that has _parent_code (but parent wasn't found) is also
  //    skipped — its hierarchy is meant to be from CC_Assembly, not
  //    legacy prefix inference.
  for (const node of nodes) {
    if (node.parent) continue;
    if (node._is_wrapper) continue;
    if (node._parent_code) continue;
    let best = null, bestSpec = -1;
    for (const cand of nodes) {
      if (cand === node) continue;
      if (cand._is_wrapper) continue;  // don't use wrapper as prefix ancestor
      if (!_isAncestorPrefix(cand._prefix, node._prefix)) continue;
      const s = _specificity(cand._prefix);
      if (s > bestSpec) { bestSpec = s; best = cand; }
    }
    if (best) {
      node.parent = best;
      best.children.push(node);
    }
  }

  // Pass 4 — virtual variant_root nodes. CC_Assembly (2026-05-28+)
  // stamps each leaf with the immediate-child-of-project-root code
  // (e.g. all parts under "10WVON-08OLOR:1" get
  // _variant_root='10WVON-08OLOR'). For every still-rootless node we
  // resolve a variant_root and attach it under a synthetic variant
  // node. Final shape:
  //
  //   project center
  //     ├─ 10WVON-08OLOR (variant)
  //     │   ├─ FN0FN3-080005 (wrapper) → parts…
  //     │   └─ BK0DN0-080000 (wrapper) → parts…
  //     └─ 10WVON-12OLOR (variant)
  //         └─ … similar subtree …
  //
  // The tricky case is virtual WRAPPERS (created in Pass 1). They
  // don't carry _variant_root themselves — they're synthesized from
  // a parent_code reference — so we walk their descendants depth-first
  // to find the first leaf with one. First-seen wins; for a wrapper
  // whose descendants split across variants (rare in practice) this
  // attaches it to whichever variant the walk visited first.
  //
  // Older JSONs without variant_root flow through unchanged: this
  // pass simply finds no variant_root anywhere and does nothing.
  function _resolveVariantRoot(node) {
    if (node._variant_root) return node._variant_root;
    // DFS over descendants. Iterative so a deep wrapper chain doesn't
    // blow the stack — guarded by an explicit visited set in case of
    // cycles in malformed data.
    const visited = new Set();
    const stack = [...node.children];
    while (stack.length) {
      const n = stack.pop();
      if (visited.has(n.code)) continue;
      visited.add(n.code);
      if (n._variant_root) return n._variant_root;
      for (const c of (n.children || [])) stack.push(c);
    }
    return null;
  }

  const variantNodes = new Map();
  // Snapshot nodes array — the loop mutates nodes/byCode when it
  // creates new variant nodes, and we don't want to iterate over them
  // (they're handled separately as the new roots).
  const rootlessSnapshot = nodes.filter(n => !n.parent);
  for (const node of rootlessSnapshot) {
    const vr = _resolveVariantRoot(node);
    if (!vr) continue;
    if (node.code === vr) continue;  // would self-reference
    let vNode = variantNodes.get(vr);
    if (!vNode) {
      vNode = {
        code: vr,
        // qty=1 for the same reason wrappers get it (see Pass 1
        // comment). A variant node represents ONE instance of the
        // top-level sub-assembly under the project root.
        qty: 1,
        _prefix: vr.split('-')[0],
        _parent_code: null,
        _variant_root: null,
        family: _remapFamilyForCode(vr, 'Other'),
        pdf: null,
        page: 1,
        urn: null,
        drawing_urn: null,
        status: 'wrapper',
        _is_wrapper: true,
        _is_variant_root: true,
        children: [],
        parent: null,
      };
      vNode._id = _nodeId(vNode.code, null);  // variants live above any variant context
      nodes.push(vNode);
      byId.set(vNode._id, vNode);
      variantNodes.set(vr, vNode);
    }
    node.parent = vNode;
    vNode.children.push(node);
  }

  function sortKids(n) {
    n.children.sort((a, b) => a.code.localeCompare(b.code));
    n.children.forEach(sortKids);
  }
  const roots = nodes.filter(n => !n.parent);
  roots.sort((a, b) => a.code.localeCompare(b.code));
  roots.forEach(sortKids);
  return { roots, all: nodes };
}

function renderBomRow(p, projectKey) {
  const fam = p.family || 'Other';
  const url = pdfUrlForCode(p.code);
  const hasDrawing = !!url;
  const bent = projectKey ? isBent(projectKey, p.code) : false;
  const assembled = projectKey ? isAssembled(projectKey, p.code) : false;
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
    <div class="bom-row ${bent ? 'bent' : ''} ${assembled ? 'assembled' : ''} ${cOpen ? 'comments-open' : ''}" data-code="${escapeHtml(p.code)}" style="${famVars(fam)}">
      <div class="bom-row-main" data-url="${escapeHtml(url)}" data-has="${hasDrawing}">
        <span class="bom-icon">${familyIcon(fam)}</span>
        <span class="bom-code">${escapeHtml(p.code)}${softDeleted ? '<span class="part-deleted-tag">DEL</span>' : ''}</span>
        <span class="bom-qty">×${p.qty}</span>
        ${timerHtml}
        <button class="comment-btn ${comments.length ? 'has-comments' : ''}" data-code="${escapeHtml(p.code)}" aria-label="Comments" title="Comments">💬${cBadgeHtml}</button>
        ${deleteBtnHtml}
        ${restoreBtnHtml}
        <button class="bent-btn" data-code="${escapeHtml(p.code)}" aria-label="Toggle bent" title="${bent ? 'Bent — click to undo' : 'Mark as bent (folded)'}"><span class="icon-bend"></span></button>
        <button class="assembled-btn" data-code="${escapeHtml(p.code)}" aria-label="Toggle assembled" title="${assembled ? 'Assembled — click to undo' : 'Mark as assembled'}">🧩</button>
      </div>
      ${commentsPanel}
    </div>`;
}

// ─── Project mindmap renderer (HTML + SVG) ─────────────────────────
// Spoke design — wider than Tree spokes so we can pack inline actions:
//   row 1: code, qty, status badge, comment count
//   row 2: ▶ timer button + elapsed text + bend-icon bent + 🧩 assembled
// Uses pure SVG (no foreignObject) for cross-browser/iPad reliability.
const PSPOKE_W = 240;
const PSPOKE_H = 64;

function _renderProjectMindmapHtml(projectKey, project, parts, workflow) {
  const tree = buildProjectTree(parts, projectKey);
  const { roots, all } = tree;
  if (!roots.length) {
    return '<p class="loading">No parts to show</p>';
  }

  const layout = getProjectLayout(projectKey);  // 'tree' | 'flat' | 'expand'
  const currentCenterCode = (layout === 'tree') ? getProjectMindmapCenter(projectKey) : null;
  let centerNode = null;
  let neighbors;
  let centerLabel;
  // Children of each wrapper, for expand mode (parent_code → child nodes).
  // Empty for tree/flat — only populated in expand to drive the 2nd ring.
  const expandChildrenByParent = new Map();

  if (layout === 'flat') {
    // Show-all — every node flat around the project.
    neighbors = all;
    centerLabel = project.name || projectKey;
  } else if (layout === 'expand') {
    // Expand — progressive click-to-reveal hierarchy. Initial state shows
    // wrappers only (collapsed). User clicks a wrapper → its children
    // appear around IT (not around project). Click a child that has its
    // own children → those appear too. Everything stays on one canvas;
    // no drill-down navigation.
    neighbors = roots;
    centerLabel = project.name || projectKey;
    const expanded = getExpandedSet(projectKey);
    // Recursively queue children for every EXPANDED parent — at any
    // depth (district → sub-district → village). The renderer uses
    // expandChildrenByParent to lay children next to their parent.
    function queueExpanded(node) {
      if (expanded.has(node.code) && node.children && node.children.length > 0) {
        expandChildrenByParent.set(node.code, node.children);
        for (const c of node.children) queueExpanded(c);
      }
    }
    for (const r of roots) queueExpanded(r);
  } else if (currentCenterCode) {
    centerNode = _findNodeByCode(roots, currentCenterCode);
    if (!centerNode) {
      setProjectMindmapCenter(projectKey, null);
      neighbors = roots;
      centerLabel = project.name || projectKey;
    } else {
      neighbors = centerNode.children || [];
      centerLabel = centerNode.code;
    }
  } else {
    neighbors = roots;
    centerLabel = project.name || projectKey;
  }

  // Breadcrumb path
  const breadcrumb = [{ kind: 'project', label: project.name || projectKey }];
  if (centerNode) {
    const chain = [];
    let n = centerNode;
    while (n) { chain.unshift(n); n = n.parent; }
    for (let i = 0; i < chain.length; i++) {
      breadcrumb.push({
        kind: i === chain.length - 1 ? 'current' : 'node',
        label: chain[i].code,
        code: chain[i].code,
      });
    }
  }

  // Layout — chord-based spacing tuned for the larger spokes
  const minChord = PSPOKE_W + 24;  // wider chord because spokes are wider
  const n = neighbors.length;
  let positioned;
  if (n === 0) {
    positioned = [];
  } else if (n === 1) {
    positioned = [{ node: neighbors[0], x: 0, y: -260, _autoX: 0, _autoY: -260, ring: 0 }];
  } else {
    const singleR = minChord / (2 * Math.sin(Math.PI / n));
    const SINGLE_MAX = 320;  // tighter than tree because spokes are bigger
    if (singleR <= SINGLE_MAX) {
      const r = Math.max(220, singleR);
      positioned = neighbors.map((node, i) => {
        const a = (2 * Math.PI * i / n) - Math.PI / 2;
        const x = r * Math.cos(a), y = r * Math.sin(a);
        return { node, x, y, _autoX: x, _autoY: y, ring: 0 };
      });
    } else {
      // Two-ring layout
      const innerN = Math.ceil(n / 2);
      const outerN = n - innerN;
      const innerR = Math.max(240, minChord / (2 * Math.sin(Math.PI / Math.max(innerN, 2))));
      const outerR = innerR + PSPOKE_H + 50;
      positioned = [];
      for (let i = 0; i < innerN; i++) {
        const a = (2 * Math.PI * i / innerN) - Math.PI / 2;
        const x = innerR * Math.cos(a), y = innerR * Math.sin(a);
        positioned.push({ node: neighbors[i], x, y, _autoX: x, _autoY: y, ring: 0 });
      }
      for (let i = 0; i < outerN; i++) {
        const a = (2 * Math.PI * i / outerN) - Math.PI / 2 + (Math.PI / outerN);
        const x = outerR * Math.cos(a), y = outerR * Math.sin(a);
        positioned.push({ node: neighbors[innerN + i], x, y, _autoX: x, _autoY: y, ring: 1 });
      }
    }
  }

  // Expand mode — true hierarchical layout (country → province →
  // district). Each wrapper's children fan AWAY from project, branching
  // out from the wrapper itself. Edges go wrapper→child (not
  // project→child). Fan width scales gently with child count and is
  // capped, since adjacent wrappers' clusters will inevitably nudge
  // each other on a tight project; the wrapper's family colour on the
  // child edges keeps the grouping legible.
  if (layout === 'expand' && expandChildrenByParent.size > 0) {
    const childDist = 280;
    // Minimum angular separation between adjacent children so their
    // rectangles don't overlap (chord at radius childDist must be at
    // least one spoke-width + a small gap).
    const minChord = PSPOKE_W + 30;  // 270
    const minSep = 2 * Math.asin(Math.min(0.99, (minChord / 2) / childDist));
    const wrappersOnly = positioned.slice();
    for (const wp of wrappersOnly) {
      const kids = expandChildrenByParent.get(wp.node.code);
      if (!kids || !kids.length) continue;
      const k = kids.length;
      const wAngle = Math.atan2(wp.y, wp.x);  // outward direction
      // Fan spans the minimum needed for k children to not overlap each
      // other — and not let a parent→child line clip a sibling rectangle.
      // Capped at ~324° so a very large k doesn't wrap past full circle.
      const fanSpan = k <= 1 ? 0 : Math.min(Math.PI * 1.8, (k - 1) * minSep);
      for (let i = 0; i < k; i++) {
        const t = k > 1 ? (i / (k - 1) - 0.5) : 0;  // -0.5..+0.5
        const a = wAngle + t * fanSpan;
        const cxL = wp.x + childDist * Math.cos(a);
        const cyL = wp.y + childDist * Math.sin(a);
        positioned.push({
          node: kids[i], x: cxL, y: cyL,
          _autoX: cxL, _autoY: cyL, ring: 2,
          _parentSpokePos: { x: wp.x, y: wp.y, code: wp.node.code },
        });
      }
    }
  }

  // Apply user drag overrides
  const centerKey = `project:${projectKey}:${currentCenterCode || ''}`;
  const overrides = getPositionOverrides()[centerKey] || {};
  let hasAnyOverride = false;
  for (const p of positioned) {
    const ov = overrides[p.node.code];
    if (ov) {
      p.x += ov.dx;
      p.y += ov.dy;
      p._moved = true;
      hasAnyOverride = true;
    }
  }

  const maxR = positioned.length
    ? Math.max(...positioned.map(p => Math.hypot(p.x, p.y)))
    : 220;
  const padding = (PSPOKE_W / 2) + 30;
  const half = maxR + padding;
  const W = 2 * half, H = 2 * half;
  const cx = half, cy = half;
  for (const p of positioned) {
    p.x += cx; p.y += cy; p._autoX += cx; p._autoY += cy;
    if (p._parentSpokePos) {
      p._parentSpokePos.x += cx;
      p._parentSpokePos.y += cy;
    }
  }

  // Edges with junction-point anchoring.
  // Each wrapper has ONE anchor on its rectangle boundary — the point
  // where the project→wrapper line enters the box. The project edge
  // ENDS at that anchor; every child edge of that wrapper STARTS at
  // the same anchor. Visually: 1 wire in (project), N wires out
  // (children), all joined at one spot on the wrapper's project-facing
  // edge. Child edges still END trimmed at the child rect boundary.
  const halfW = PSPOKE_W / 2;
  const halfH = PSPOKE_H / 2;
  function trimToRectEdge(fromX, fromY, toX, toY) {
    const dx = toX - fromX, dy = toY - fromY;
    const adx = Math.abs(dx) || 1e-9;
    const ady = Math.abs(dy) || 1e-9;
    const t = Math.min(halfW / adx, halfH / ady);
    return { x: fromX + dx * t, y: fromY + dy * t };
  }
  const wrapperAnchorByCode = new Map();
  for (const p of positioned) {
    if (p._parentSpokePos) continue;  // top-level only
    wrapperAnchorByCode.set(p.node.code, trimToRectEdge(p.x, p.y, cx, cy));
  }
  const edges = positioned.map(p => {
    const isChild = !!p._parentSpokePos;
    if (isChild) {
      const parentCode = p._parentSpokePos.code;
      const start = wrapperAnchorByCode.get(parentCode)
                 || trimToRectEdge(p._parentSpokePos.x, p._parentSpokePos.y, p.x, p.y);
      const end = trimToRectEdge(p.x, p.y, p._parentSpokePos.x, p._parentSpokePos.y);
      const styleAttr = ` style="${famVars(p.node.family || 'Other')}"`;
      return `<path class="mm-edge mm-edge-child" data-target="${escapeHtml(p.node.code)}"${styleAttr} d="M ${start.x} ${start.y} L ${end.x} ${end.y}" />`;
    }
    // Project edge — ends at the wrapper's anchor (not centre) so it
    // visibly stops at the box edge.
    const anchor = wrapperAnchorByCode.get(p.node.code) || { x: p.x, y: p.y };
    const mx = (cx + anchor.x) / 2, my = (cy + anchor.y) / 2;
    const dx = anchor.x - cx, dy = anchor.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const bias = 22;
    const bx = -dy / len * bias, by = dx / len * bias;
    return `<path class="mm-edge" data-target="${escapeHtml(p.node.code)}" d="M ${cx} ${cy} Q ${mx + bx} ${my + by} ${anchor.x} ${anchor.y}" />`;
  }).join('');

  // Center node
  const centerColorVars = centerNode ? famVars(centerNode.family || 'Other') : 'color: #4a90e2';
  const centerSvg = centerNode ? `
    <g class="mm-center mm-center-node" transform="translate(${cx}, ${cy})" style="${centerColorVars}">
      <rect x="-130" y="-36" width="260" height="72" rx="36" fill="var(--fam-color)" stroke="#fff" stroke-width="3" />
      <text text-anchor="middle" y="-6" font-size="12" fill="#fff" opacity="0.85">↑ click to go back</text>
      <text text-anchor="middle" y="18" font-size="14" font-weight="700" fill="#fff">${escapeHtml(centerLabel)}</text>
    </g>` : `
    <g class="mm-center mm-center-project" transform="translate(${cx}, ${cy})">
      <circle r="80" fill="#1e293b" stroke="#4a90e2" stroke-width="4" opacity="0.95" />
      <g transform="translate(0, -20) scale(1.5)">
        <!-- Top Cube -->
        <g transform="translate(0, -10)">
          <polygon points="0,-10 9,-5 0,-1 -9,-5" fill="#f8fafc" stroke="#334155" stroke-width="1"/>
          <polygon points="-9,-5 0,-1 0,8 -9,4" fill="#cbd5e1" stroke="#334155" stroke-width="1"/>
          <polygon points="0,-1 9,-5 9,4 0,8" fill="#94a3b8" stroke="#334155" stroke-width="1"/>
        </g>
        <!-- Bottom Left Cube -->
        <g transform="translate(-8, 3)">
          <polygon points="0,-10 9,-5 0,-1 -9,-5" fill="#f8fafc" stroke="#334155" stroke-width="1"/>
          <polygon points="-9,-5 0,-1 0,8 -9,4" fill="#cbd5e1" stroke="#334155" stroke-width="1"/>
          <polygon points="0,-1 9,-5 9,4 0,8" fill="#94a3b8" stroke="#334155" stroke-width="1"/>
        </g>
        <!-- Bottom Right Cube -->
        <g transform="translate(8, 3)">
          <polygon points="0,-10 9,-5 0,-1 -9,-5" fill="#f8fafc" stroke="#334155" stroke-width="1"/>
          <polygon points="-9,-5 0,-1 0,8 -9,4" fill="#cbd5e1" stroke="#334155" stroke-width="1"/>
          <polygon points="0,-1 9,-5 9,4 0,8" fill="#94a3b8" stroke="#334155" stroke-width="1"/>
        </g>
      </g>
      <text text-anchor="middle" y="24" font-size="13" font-weight="700" fill="#fff" letter-spacing="1">PROJECT</text>
      <text text-anchor="middle" y="44" font-size="11" fill="#cbd5e1" opacity="0.9">${escapeHtml(centerLabel)}</text>
    </g>`;

  // Spokes — large cards with inline buttons (workflow controls which checkbox is shown)
  const expandedSetForSpokes = (layout === 'expand') ? getExpandedSet(projectKey) : null;
  const spokes = positioned.map(p => _renderProjectSpoke(p, projectKey, workflow, expandedSetForSpokes)).join('');

  // Breadcrumb
  const breadcrumbHtml = breadcrumb.map((b, i) => {
    const sep = i > 0 ? '<span class="mm-bc-sep">›</span>' : '';
    const cls = b.kind + (b.kind === 'current' ? ' current' : '');
    return `${sep}<span class="mm-bc-item ${cls}" data-kind="${b.kind}" data-code="${escapeHtml(b.code || '')}">${escapeHtml(b.label || '')}</span>`;
  }).join('');

  // Comments panels — rendered as HTML below the SVG canvas for any
  // parts that have their comments toggled open. (SVG can't host HTML
  // reliably, so a separate HTML overlay region is cleaner than
  // foreignObject and works on iOS Safari without quirks.)
  const partCodes = new Set();
  function _collectCodes(nodes) {
    for (const nn of nodes) { partCodes.add(nn.code); _collectCodes(nn.children || []); }
  }
  _collectCodes(roots);
  const openInProject = [...loadCommentsOpenSet()].filter(c => partCodes.has(c));
  const adminMode = isAdmin();
  const commentPanelsHtml = openInProject.map(code => {
    const cList = getComments(code);
    return `
      <div class="mm-comment-panel" data-code="${escapeHtml(code)}">
        <div class="mm-comment-header">
          <span class="mm-comment-title">💬 <strong>${escapeHtml(code)}</strong> · ${cList.length} comment${cList.length === 1 ? '' : 's'}</span>
          <button class="mm-comment-close" data-code="${escapeHtml(code)}" aria-label="Close">✕</button>
        </div>
        <ul class="comments-list">
          ${cList.length ? cList.map(c => `
            <li class="comment-item">
              <span class="comment-time">${escapeHtml(fmtCommentTime(c.time))}</span>
              <span class="comment-text">${escapeHtml(c.text)}</span>
              ${adminMode ? `<button class="comment-del" data-code="${escapeHtml(code)}" data-id="${escapeHtml(c._key || String(c.time))}" aria-label="Delete">✕</button>` : ''}
            </li>`).join('') : '<li class="comment-empty">No comments yet</li>'}
        </ul>
        <form class="comment-input-wrap" data-code="${escapeHtml(code)}">
          <input class="comment-input" type="text" placeholder="พิมพ์ comment / type a note…" autocomplete="off">
          <button type="submit" class="comment-add">+ Add</button>
        </form>
      </div>`;
  }).join('');

  return `
    <div class="mindmap-wrapper project-mindmap">
      <div class="mindmap-breadcrumb">
        <div class="mm-bc-trail">${breadcrumbHtml}</div>
        ${hasAnyOverride ? `<button class="mm-reset-layout" id="pm-reset-layout" data-key="${escapeHtml(centerKey)}">↻ Reset layout</button>` : ''}
      </div>
      <div class="mindmap-canvas">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="mindmap-svg" data-cx="${cx}" data-cy="${cy}">
          ${edges}
          ${centerSvg}
          ${spokes}
        </svg>
      </div>
      ${commentPanelsHtml ? `<div class="mm-comments-area">${commentPanelsHtml}</div>` : ''}
      <p class="hint">
        Click spoke center → drill in · bend/🧩/▶/💬 buttons act inline · drag spoke to reposition · click center → go back
        ${neighbors.length === 0 ? '<br><strong>⚠️ No children here</strong> — click center to go back' : ''}
      </p>
    </div>
  `;
}

// Render one spoke (pure SVG). Layout adapts to workflow:
//   • 'bending'  → shows bend checkbox on the right (assembly hidden)
//   • 'assembly' → shows assembly checkbox on the right (bend hidden)
// Missing/outdated parts get a big red WARNING strip across the bottom.
function _renderProjectSpoke(p, projectKey, workflow, expandedSet) {
  const n = p.node;
  const code = n.code;
  const fam = n.family || 'Other';
  const hasChildren = n.children && n.children.length > 0;
  const isExpanded = !!(expandedSet && expandedSet.has(code));
  const halfW = PSPOKE_W / 2;  // 120
  const halfH = PSPOKE_H / 2;  // 32

  // Status info — used for warning strip + small badge
  const statusInfo = {
    drawn:   { color: '#4dd06a', text: '✓ OK',       isWarn: false },
    missing: { color: '#f85149', text: '⚠ NO DRAWING', isWarn: true  },
    stale:   { color: '#ffc107', text: '⏰ OUTDATED',  isWarn: true  },
    deleted: { color: '#dc3545', text: 'DEL — REDO',  isWarn: true  },
  }[n.status] || { color: '#888', text: '?', isWarn: false };

  // Comments
  const comments = getComments(code);
  const cCount = comments.length;

  // Bent / assembled / timer states
  const bent = isBent(projectKey, code);
  const assembled = isAssembled(projectKey, code);
  const tRunning = isTimerRunning(projectKey, code);
  const tSec = getTimerTotalSeconds(projectKey, code);
  const tText = formatDuration(tSec);

  // Drill-in arrow icon
  // ▼ when this parent's children are currently revealed on canvas
  // (Expand mode); ▶ when collapsed or in Tree mode (drill-to-open).
  const drillHint = hasChildren ? (isExpanded ? '▼' : '▶') : '';
  const childCount = hasChildren ? n.children.length : '';

  // Button positions — bottom row of card
  const btnY = halfH - 14;
  const timerX = -halfW + 18;   // far left
  const timerTextX = timerX + 18;
  // Both action checkboxes always visible (bent + assembled) — workflow
  // toggle at the top of the view emphasizes the active one but doesn't
  // hide the other. Workshop can mark either at any time.
  const assembledX = halfW - 22;
  const bentX = halfW - 54;
  // Top-right: comment + small status pill (kept for non-warn states)
  const cmtX = halfW - 18;
  const cmtY = -halfH + 14;

  // Both action buttons rendered equally — workflow toggle removed.
  const bentBtn = `<g class="pm-btn pm-bent ${bent ? 'on' : ''}" data-action="bent" transform="translate(${bentX}, ${btnY})">
       <circle r="14" fill="${bent ? '#5dbb63' : 'rgba(255,255,255,0.06)'}" stroke="${bent ? '#5dbb63' : '#777'}" stroke-width="2" />
       <image href="icons/bending.svg" x="-11" y="-11" width="22" height="22" />
     </g>`;
  const assembledBtn = `<g class="pm-btn pm-assembled ${assembled ? 'on' : ''}" data-action="assembled" transform="translate(${assembledX}, ${btnY})">
       <circle r="13" fill="${assembled ? '#e07a5f' : 'rgba(255,255,255,0.06)'}" stroke="${assembled ? '#e07a5f' : '#777'}" stroke-width="2" />
       <text text-anchor="middle" dy="4" font-size="13">🧩</text>
     </g>`;
  const wfBtn = bentBtn + assembledBtn;

  // Warning strip across the whole card border when missing/stale/deleted —
  // makes the status impossible to miss in either Kanban view
  const warnFrame = statusInfo.isWarn
    ? `<rect class="pm-warn-frame" x="${-halfW - 2}" y="${-halfH - 2}" width="${PSPOKE_W + 4}" height="${PSPOKE_H + 4}" rx="12"
            fill="none" stroke="${statusInfo.color}" stroke-width="3" stroke-dasharray="6 3" opacity="0.9" />
       <g class="pm-warn-badge" transform="translate(${-halfW + 16}, ${-halfH - 8})">
         <rect x="-2" y="-9" width="${(statusInfo.text.length * 6) + 8}" height="16" rx="8" fill="${statusInfo.color}" />
         <text x="2" dy="3" font-size="9" font-weight="700" fill="#fff">${statusInfo.text}</text>
       </g>` : '';

  return `
    <g class="pm-spoke ${hasChildren ? 'has-children' : 'is-leaf'} ${p._moved ? 'moved' : ''} pm-wf-${workflow} ${statusInfo.isWarn ? 'pm-warn' : ''}"
       data-code="${escapeHtml(code)}" data-auto-x="${p._autoX}" data-auto-y="${p._autoY}"
       transform="translate(${p.x}, ${p.y})" style="${famVars(fam)}">

      <!-- Background card -->
      <rect class="pm-spoke-bg" x="${-halfW}" y="${-halfH}" width="${PSPOKE_W}" height="${PSPOKE_H}" rx="10"
            fill="var(--fam-tint)" stroke="var(--fam-color)" stroke-width="2" />

      ${warnFrame}

      <!-- Top-left: code + qty (×N) + drill hint -->
      <text class="pm-code" x="${-halfW + 12}" y="${-halfH + 18}" font-size="12" font-weight="700" fill="#e4e4e4">${escapeHtml(code)}</text>
      <text class="pm-qty" x="${-halfW + 12}" y="${-halfH + 34}" font-size="14" font-weight="700" fill="#e4e4e4">×${n.qty}${drillHint ? `  ${drillHint} ${childCount}` : ''}</text>

      <!-- Top-right: comments button (visible outline even when empty so the
           user can tell it's clickable). Filled yellow when comments exist. -->
      <g class="pm-btn pm-comments" data-action="comments" transform="translate(${cmtX}, ${cmtY})">
        <circle r="12" fill="${cCount ? '#ffc107' : 'rgba(255,193,7,0.12)'}" stroke="${cCount ? '#ffc107' : '#ffc107'}" stroke-width="${cCount ? '0' : '1.6'}" />
        <text text-anchor="middle" dy="3" font-size="12" fill="${cCount ? '#000' : '#ffc107'}">💬</text>
        ${cCount ? `<text text-anchor="middle" dy="3" x="18" font-size="10" font-weight="700" fill="#ffc107">${cCount}</text>` : ''}
      </g>

      <!-- Bottom row: timer + reset (admin, has-time only) + both action checkboxes -->
      <g class="pm-btn pm-timer ${tRunning ? 'on' : ''}" data-action="timer" transform="translate(${timerX}, ${btnY})">
        <circle r="12" fill="${tRunning ? '#4dd06a' : 'rgba(255,255,255,0.08)'}" stroke="${tRunning ? '#4dd06a' : '#666'}" stroke-width="2" />
        <text text-anchor="middle" dy="3" font-size="10" fill="${tRunning ? '#000' : '#aaa'}">${tRunning ? '⏸' : '▶'}</text>
      </g>
      ${tText ? `<text class="pm-timer-text ${tRunning ? 'running' : ''}" data-pk="${escapeHtml(projectKey)}" data-code="${escapeHtml(code)}" x="${timerTextX}" y="${btnY + 3}" font-size="10" fill="${tRunning ? '#4dd06a' : '#aaa'}">${escapeHtml(tText)}</text>` : ''}
      ${(tSec > 0 && isAdmin()) ? `<g class="pm-btn pm-timer-reset" data-action="timer-reset" transform="translate(${timerTextX + 50}, ${btnY})">
        <circle r="9" fill="rgba(212,164,74,0.1)" stroke="#d4a44a" stroke-width="1.4" stroke-dasharray="3 2" />
        <text text-anchor="middle" dy="3" font-size="10" fill="#d4a44a">↻</text>
      </g>` : ''}
      ${wfBtn}
    </g>`;
}

// Wire all interactivity for the project mindmap (drag + button clicks +
// breadcrumb + center navigation). Called after innerHTML is set.
function _wireProjectMindmap(projectKey, visibleParts, workflow) {
  const svgEl = ROOT.querySelector('.mindmap-svg');
  if (!svgEl) return;
  const cx = parseFloat(svgEl.dataset.cx);
  const cy = parseFloat(svgEl.dataset.cy);

  const project = manifest.projects[projectKey];
  const tree = buildProjectTree(visibleParts, projectKey);
  const { roots } = tree;
  const currentCenter = getProjectMindmapCenter(projectKey);
  const centerNode = currentCenter ? _findNodeByCode(roots, currentCenter) : null;

  // Breadcrumb navigation
  ROOT.querySelectorAll('.mm-bc-item').forEach(el => {
    el.addEventListener('click', () => {
      const kind = el.dataset.kind;
      if (kind === 'project') {
        setProjectMindmapCenter(projectKey, null);
      } else if (kind === 'node') {
        setProjectMindmapCenter(projectKey, el.dataset.code);
      }
      render();
    });
  });

  // Center click:
  //   • When drilled into a sub-node → go up one level (existing).
  //   • At the top-level project circle → open the project's master
  //     PDF if one exists. The big "PROJECT 100VB0-110000" circle is
  //     the most natural target for "show me this project's drawing"
  //     and workshop iPad consistently reached for it instead of the
  //     📄 Project PDF button in the filter row.
  const centerEl = ROOT.querySelector('.mm-center');
  if (centerEl) {
    // Style cue so it's discoverable as clickable, but only when a
    // PDF actually exists at the top level (otherwise it'd look broken).
    const topLevelHasPdf = !centerNode && !!projectPdfUrl(projectKey);
    if (topLevelHasPdf) {
      centerEl.style.cursor = 'pointer';
      centerEl.setAttribute('aria-label', `Open ${projectKey}.pdf`);
    }
    centerEl.addEventListener('click', () => {
      if (centerNode) {
        setProjectMindmapCenter(projectKey,
          centerNode.parent ? centerNode.parent.code : null);
        render();
        return;
      }
      const url = projectPdfUrl(projectKey);
      if (url) _openInNewTab(url);
    });
  }

  // Reset layout button
  ROOT.querySelector('#pm-reset-layout')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (confirm('Restore auto-layout for this view?')) {
      const key = ev.target.dataset.key;
      clearOverridesForCenter(key);
      render();
    }
  });

  // Comments panel close — toggles the comments-open state for that code
  ROOT.querySelectorAll('.mm-comment-close').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleCommentsOpen(btn.dataset.code);
      render();
    });
  });

  // Drag + click handling on spokes
  const centerKeyForOverrides = `project:${projectKey}:${currentCenter || ''}`;
  let activeDrag = null;

  function onMove(ev) {
    if (!activeDrag || ev.pointerId !== activeDrag.pointerId) return;
    ev.preventDefault();
    const pt = _svgPoint(svgEl, ev);
    const dx = pt.x - activeDrag.startSvgX;
    const dy = pt.y - activeDrag.startSvgY;
    // Tap-vs-drag threshold — touch fingers wobble 5–10px on a clean tap,
    // mouse cursors don't. Without per-input threshold, taps on iPad got
    // counted as drags and drill-down never fired.
    const dragThreshold = (activeDrag.pointerType === 'touch' || activeDrag.pointerType === 'pen') ? 10 : 4;
    // Non-admin (bending technician) can click spokes but cannot reposition
    // them. Skip the moved/dragging branch so taps still register as clicks
    // (drill-in for wrapper, route to PDF/Fusion for leaves).
    if (!isAdmin()) return;
    if (!activeDrag.moved && Math.hypot(dx, dy) > dragThreshold) {
      activeDrag.moved = true;
      activeDrag.spoke.classList.add('dragging');
    }
    if (activeDrag.moved) {
      const nx = activeDrag.curX + dx;
      const ny = activeDrag.curY + dy;
      activeDrag.spoke.setAttribute('transform', `translate(${nx}, ${ny})`);
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

  function onEnd(ev) {
    if (!activeDrag || ev.pointerId !== activeDrag.pointerId) return;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onEnd);
    document.removeEventListener('pointercancel', onEnd);
    const drag = activeDrag;
    activeDrag = null;
    drag.spoke.classList.remove('dragging');
    if (drag.moved) {
      const pt = _svgPoint(svgEl, ev);
      const dx = pt.x - drag.startSvgX;
      const dy = pt.y - drag.startSvgY;
      const finalX = drag.curX + dx;
      const finalY = drag.curY + dy;
      const dxFromAuto = finalX - drag.autoX;
      const dyFromAuto = finalY - drag.autoY;
      setSpokeOverride(centerKeyForOverrides, drag.code, dxFromAuto, dyFromAuto);
      render();  // re-render to show Reset button
    } else {
      // Click on body — behaviour depends on layout mode:
      //   • Tree   — drill into the wrapper (replaces center)
      //   • Expand — toggle the wrapper's children visible/hidden on
      //              the SAME canvas (no navigation)
      //   • Flat   — no children to drill; leaf path runs below
      // Leaf path is always: route per feedback_leaf_click_routing.
      const node = _findNodeByCode(roots, drag.code);
      if (!node) return;
      if (node.children && node.children.length > 0) {
        const currentLayout = getProjectLayout(projectKey);
        if (currentLayout === 'expand') {
          toggleExpandedNode(projectKey, drag.code);
        } else {
          setProjectMindmapCenter(projectKey, drag.code);
        }
        render();
      } else {
        // Leaf — route per feedback_leaf_click_routing rule:
        //   • status='missing' (no drawing) → open Fusion 3D master
        //   • otherwise (drawn/stale/deleted)  → open Fusion drawing (.f2d)
        //   • Falls back to PDF if no URN, else nothing.
        _routeLeafToFusion(node);
      }
    }
  }

  ROOT.querySelectorAll('.pm-spoke').forEach(spoke => {
    const code = spoke.dataset.code;

    spoke.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      // Was it a button click? Buttons route their own actions.
      const btn = ev.target.closest('.pm-btn');
      if (btn) {
        ev.preventDefault();
        ev.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'timer') {
          if (isTimerRunning(projectKey, code)) stopTimer(projectKey, code);
          else                                   startTimer(projectKey, code);
        } else if (action === 'bent') {
          markBent(projectKey, code, !isBent(projectKey, code));
          render();
        } else if (action === 'assembled') {
          markAssembled(projectKey, code, !isAssembled(projectKey, code));
          render();
        } else if (action === 'timer-reset') {
          // Admin: edit / reset the accumulated timer for this part.
          const cur = getTimerTotalSeconds(projectKey, code);
          const msg = `Edit / Reset timer\n\n` +
            `Current: ${formatDuration(cur) || '0s'}\n\n` +
            `Enter new total in seconds (0 = reset):`;
          const input = prompt(msg, String(cur));
          if (input === null) return;
          const n = parseInt(String(input).trim(), 10);
          const seconds = (!input.trim() || isNaN(n)) ? 0 : Math.max(0, n);
          resetTimer(projectKey, code, seconds);
          render();
        } else if (action === 'comments') {
          toggleCommentsOpen(code);
          render();
          // The panel renders BELOW the SVG canvas — on a tall mindmap it
          // can end up outside the viewport. Scroll it into view and
          // focus the input so the user sees it immediately.
          setTimeout(() => {
            const panel = document.querySelector(
              `.mm-comment-panel[data-code="${CSS.escape(code)}"]`);
            if (panel) {
              panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
              const input = panel.querySelector('.comment-input');
              if (input) {
                // Small extra delay so smooth-scroll doesn't fight the focus
                setTimeout(() => input.focus({ preventScroll: true }), 250);
              }
            }
          }, 30);
        }
        return;
      }
      // Body click — start drag/click tracking
      ev.preventDefault();
      ev.stopPropagation();
      const pt = _svgPoint(svgEl, ev);
      // Find current spoke position from its transform
      const m = spoke.getAttribute('transform').match(/translate\(([-\d.]+),\s*([-\d.]+)\)/);
      const curX = m ? parseFloat(m[1]) : 0;
      const curY = m ? parseFloat(m[2]) : 0;
      // Find auto position by looking up positioned array
      // We recompute it here to avoid dependency on closure scope
      const positioned = _projectSpokesAutoPositions(spoke);
      const autoP = positioned[code];
      const autoX = autoP ? autoP.x : curX;
      const autoY = autoP ? autoP.y : curY;
      activeDrag = {
        spoke, code,
        startSvgX: pt.x, startSvgY: pt.y,
        curX, curY,
        autoX, autoY,
        moved: false,
        pointerId: ev.pointerId,
        pointerType: ev.pointerType,
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onEnd);
      document.addEventListener('pointercancel', onEnd);
    });
  });
}

// Reads the auto positions (before overrides) from data-* attributes on
// the SVG so drag-end can compute the delta to save. Stored as JSON on
// the SVG root for compactness.
function _projectSpokesAutoPositions(spokeEl) {
  const svg = spokeEl.closest('svg');
  if (!svg) return {};
  if (svg._autoPositionsCache) return svg._autoPositionsCache;
  // Walk all spokes and extract their CURRENT transform as a fallback.
  // Auto positions are also stored on each spoke via data-auto-x/y when rendered.
  const out = {};
  svg.querySelectorAll('.pm-spoke').forEach(el => {
    const code = el.dataset.code;
    const ax = parseFloat(el.dataset.autoX);
    const ay = parseFloat(el.dataset.autoY);
    if (!isNaN(ax) && !isNaN(ay)) {
      out[code] = { x: ax, y: ay };
    } else {
      const m = el.getAttribute('transform').match(/translate\(([-\d.]+),\s*([-\d.]+)\)/);
      out[code] = { x: m ? parseFloat(m[1]) : 0, y: m ? parseFloat(m[2]) : 0 };
    }
  });
  svg._autoPositionsCache = out;
  return out;
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
  const viewMode = getProjectViewMode();

  const top = stack[stack.length - 1] || {};
  const filter = top.filter || 'all';

  // "Missing" = no resolvable drawing for this part. pdfUrlForCode
  // returns '' when there's neither a manifest entry nor an upload
  // (own or via prefix-share / group sibling), and also '' when soft-
  // deleted — so workshop-flagged-redo parts still surface as missing.
  const isMissing = (p) => !pdfUrlForCode(p.code);
  const visibleParts = filter === 'missing' ? parts.filter(isMissing) : parts;
  const missingCount = parts.filter(isMissing).length;

  // Group by source master file
  const groups = groupPartsByMaster(visibleParts, auto);
  const collapsed = loadCollapsed();

  // Role-based view gating (2026-05-28 — user said 'แยกหน้ากันไปเลย
  // ให้ชัดเจน'). Each non-admin role sees a curated subset of the
  // project page so workshop staff focus on their task; admin keeps
  // god-mode visibility across every panel.
  //
  // Role 'workshop' (default, no role chip) — the legacy public iPad
  // mode — keeps the full layout MINUS admin-only edit buttons (that
  // gating lives elsewhere). Other roles strip what isn't theirs.
  const _role = getRole();
  const _adminAll = isAdmin();
  const _isLaser  = _role === 'laser';
  const _isBend   = _role === 'bend';
  const _isAsm    = _role === 'assemble';
  // Visibility flags — admin overrides every role-specific gate.
  const _showBendingPill   = _adminAll || _isAsm || _isBend || (!_isLaser && !_isBend && !_isAsm);
  const _showAssemblyPill  = _adminAll || _isAsm || (!_isLaser && !_isBend && !_isAsm);
  const _showMarkComplete  = _adminAll || _isAsm || (!_isLaser && !_isBend && !_isAsm);
  const _showFilters       = _adminAll || _isAsm || (!_isLaser && !_isBend && !_isAsm);
  // All PDF — merges every part's drawing into ONE navigable PDF
  // opened in a new tab (not auto-saved). Per user 2026-05-28:
  //   ✓ admin: full access
  //   ✓ bending: needs the sequential viewer for the day's work
  //     ('ในหัวข้อ bending ให้สามารถ ดู all pdf ได้')
  //   ✗ laser: not relevant — they use Cut Sheets
  //   ✗ workshop / assemble: keep hidden (less clutter; if needed
  //     they ask admin for the merged copy)
  const _showAllPdf        = _adminAll || _isBend;
  const _showDxfsBtn       = _adminAll || _isLaser || (!_isLaser && !_isBend && !_isAsm);

  let bodyHtml;
  if (_isLaser) {
    bodyHtml = _renderCutList(visibleParts, key);
  } else if (_isBend) {
    bodyHtml = _renderBendList(visibleParts, key);
  } else {
    // Assembly role + workshop default + admin → React Flow mindmap.
    bodyHtml = '<div id="kme-mount" class="kme-mount-host"><p class="loading">Loading editor…</p></div>';
  }

  const totalQtyAll = project.total_qty != null
    ? project.total_qty
    : parts.reduce((s, x) => s + (x.qty || 0), 0);

  const bentCount = bentCountForProject(key, parts);
  const bentPct = parts.length ? Math.round((bentCount * 100) / parts.length) : 0;
  const assembledCount = assembledCountForProject(key, parts);
  const assembledPct = parts.length ? Math.round((assembledCount * 100) / parts.length) : 0;

  // Back button moved to the header (#header-back-row) — see
  // _updateHeaderBack() — so it sits above the search box uniformly
  // across views instead of being repeated inside each ROOT layout.
  // Project summary row (2026-05-28 layout consolidation): the title +
  // both progress timelines (Bending + Assembly) share one line instead
  // of stacking. On mobile widths the flex container wraps gracefully.
  // Project summary + actions consolidated into a single row (2026-05-28):
  // title · counts · Bending pill · Assembly pill · Mark Completed ·
  // filter chips · All PDF · DXFs. Wraps gracefully on narrow screens.
  // Drops one full row off the page versus the previous stacked layout.
  ROOT.innerHTML = `
    <div class="project-summary-row">
      <h2 class="section-title">${escapeHtml(project.name || key)}<span class="count">${parts.length} unique · ${totalQtyAll} pcs · ${groups.size} masters</span></h2>
      ${_showBendingPill ? `
      <div class="progress-inline bent-mini">
        <span class="bent-label"><span class="icon-bend"></span> Bending</span>
        <div class="progress-bar bent-bar"><div class="progress-fill" style="width:${bentPct}%"></div></div>
        <span class="bent-stat">${bentCount}/${parts.length} · ${bentPct}%</span>
        ${(_adminAll || _isBend) ? `<button class="reset-progress-btn" id="reset-bent-btn" title="Reset bending progress for this project">↻ Reset</button>` : ''}
      </div>` : ''}
      ${_showAssemblyPill ? `
      <div class="progress-inline assembled-mini">
        <span class="bent-label assembled-label">🧩 Assembly</span>
        <div class="progress-bar assembled-bar"><div class="progress-fill" style="width:${assembledPct}%"></div></div>
        <span class="bent-stat">${assembledCount}/${parts.length} · ${assembledPct}%</span>
        ${(_adminAll || _isAsm) ? `<button class="reset-progress-btn" id="reset-assembled-btn" title="Reset assembly progress + timers for this project">↻ Reset</button>` : ''}
      </div>` : ''}
      ${_showMarkComplete ? `
      <button class="action-btn ${completed ? '' : 'danger'}" id="toggle-complete">
        ${completed ? '↺ Re-activate' : '✓ Mark Completed'}
      </button>` : ''}
      <div class="filter-group">
        ${_showFilters ? `
        <button class="filter-btn ${filter === 'all' ? 'active' : ''}" data-filter="all">All (${parts.length})</button>
        <button class="filter-btn ${filter === 'missing' ? 'active' : ''}" data-filter="missing">⚠️ Missing (${missingCount})</button>` : ''}
        ${_showAllPdf ? `
        <button class="filter-btn all-pdf-btn" id="all-pdf-btn" title="Merge every part drawing into one PDF (each page links back to that part)">📑 All PDF</button>` : ''}
        ${_showDxfsBtn ? `
        <button class="filter-btn project-cut-sheets-btn" id="project-cut-sheets-btn" data-project-key="${escapeHtml(key)}" title="Nested cut sheets uploaded for this project — from NestingTool's Save sheets to Laser or admin drag-drop">📐 Cut Sheets (${cutSheetsForProject(key).length})</button>` : ''}
        ${'' /* ▶ Nest button moved to its own admin-only tab next to
              Library (user 2026-05-28: 'nest ให้ย้ายไปต่อ library admin
              ใช้ได้คนเดียว'). Tab handler in renderNestHome shows a
              project picker + delegates to kdNest.openProject. Leaving
              this placeholder so re-reading the template diff makes the
              move obvious. */}
        <!-- Active-in-Fusion badge moved inline with the action buttons
             per user 2026-05-28. Shown when CC_SyncOccNames has pushed
             an active row for THIS project key — OR for any of its
             variant_roots (sub-assemblies). Hidden via display:none by
             updateActiveVariantBadge() when nothing's active. -->
        <span id="active-variant-badge" class="active-variant-badge filter-btn-inline" style="display:none"></span>
      </div>
    </div>
    ${bodyHtml}
  `;

  // Paint the "Active in Fusion" badge from cached RTDB data. The
  // subscription in initActiveRowsSync re-runs this on every push.
  try { updateActiveVariantBadge(); } catch {}

  // Note: header Back button click is wired ONCE at app init (see the
  // bottom of this file). No per-view rewiring needed.
  // Optional-chain everything since role gating may strip elements.
  ROOT.querySelector('#toggle-complete')?.addEventListener('click', () => {
    markCompleted(key, !completed);
    render();
  });
  // Reset buttons: always show the confirm so workshop staff can clear
  // experimental state freely. The display count is parts-based (matches
  // the progress bar), but the reset itself wipes ALL keys for the
  // project in cache + RTDB — including wrappers (e.g. BK0DN0-080000)
  // that get tapped via the mindmap but aren't in the BOM parts[] list.
  ROOT.querySelector('#reset-bent-btn')?.addEventListener('click', () => {
    const live = bentCountForProject(key, parts);
    const ok = window.confirm(
      `Reset bending progress for "${project.name || key}"?\n\n` +
      `This clears ${live}/${parts.length} bent flags. Cannot be undone.`
    );
    if (!ok) return;
    resetBentForProject(key);
    render();
  });
  ROOT.querySelector('#reset-assembled-btn')?.addEventListener('click', () => {
    const live = assembledCountForProject(key, parts);
    const ok = window.confirm(
      `Reset assembly progress + timers for "${project.name || key}"?\n\n` +
      `This clears ${live}/${parts.length} assembled flags AND all accumulated timer sessions. Cannot be undone.`
    );
    if (!ok) return;
    resetAssembledForProject(key);
    render();
  });
  ROOT.querySelectorAll('.filter-btn').forEach(btn => {
    if (!btn.dataset.filter) return;  // skip the All PDF action button
    btn.addEventListener('click', () => {
      top.filter = btn.dataset.filter;
      render();
    });
  });
  ROOT.querySelector('#all-pdf-btn')?.addEventListener('click', () => {
    buildAllProjectPdf(key);
  });
  // Project-level Cut Sheets modal (2026-05-28): nested cut layouts
  // uploaded for THIS project. Distinct from per-row per-part DXFs.
  // Source: NestingTool's Save Sheets + admin drag-drop.
  ROOT.querySelector('#project-cut-sheets-btn')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    _renderCutSheetsModal(ev.currentTarget, key, project);
  });
  // ▶ Nest moved to its own admin-only tab (renderNestHome). No
  // per-project button handler needed here anymore.
  // Cut List / Bend List get their own wiring + skip the React Flow
  // editor entirely. Mount the role-specific handlers when the body
  // we rendered was that view; otherwise fall through to the editor.
  if (isLaserUser()) {
    _wireCutList(visibleParts, key);
    return;
  }
  if (isBendUser()) {
    _wireBendList(visibleParts, key);
    return;
  }

  // Unified editor mount — always React Flow.
  // Composes: project center pseudo-node + BOM nodes (auto-spoked) +
  // Custom nodes (RTDB). Workshop iPad gets the same view but editing
  // is gated off via admin flag.
  _exposeKdApi();
  ensureEditorBundle().then(async () => {
    const host = document.getElementById('kme-mount');
    if (!host) return;
    const [fresh, overrides] = await Promise.all([
      _loadCustomMindmap(key),
      _loadOverrides(key),
    ]);
    const bom = _buildBomNodes(project, visibleParts, key);
    const bomNodes = _applyOverrides(bom.nodes, overrides);
    // Custom nodes layer overrides too so renames live in one place.
    const customNodes = _applyOverrides(fresh.nodes || [], overrides);
    // `admin` = full editor powers (edit / move / toolbar) — straight off the
    // device admin flag. (The earlier '&& !isAssembleUser()' gate was reverted
    // 2026-05-29 per user: it was suspected of hiding the node buttons.)
    const admin = isAdmin();
    // Auto-fullscreen is a VIEW preference tied to the role, not to
    // permissions: the Assembly view opens straight into fullscreen (Back
    // handles navigation — user 2026-05-29 'กดจาก Project แล้ว Full screen
    // เลย'), while the default/admin editing view opens normal so the toolbar
    // stays in reach. Tapping empty canvas still toggles it either way.
    const autoFullscreen = isAssembleUser();
    host.innerHTML = '';
    try { window.__kmeInstance?.unmount?.(); } catch {}
    // Deep-link highlight — when hash has #project=X&code=Y, find the
    // matching node after mount and flash a green halo so workshop sees
    // exactly which part was opened from the PDF link.
    const deepCode = (() => {
      const m = /[#&]code=([^&]+)/.exec(location.hash);
      return m ? decodeURIComponent(m[1]) : null;
    })();
    // Custom edges with non-prefixed endpoints are LEGACY (saved
    // before the bom:/project: prefix convention). They mostly point
    // at parent_code wrappers that are now auto-generated by
    // _buildBomNodes, so re-applying them creates ghost duplicate
    // lines that bypass the real tree hierarchy. Filter out anything
    // that doesn't carry the right prefix on both endpoints. User
    // 2026-05-28: 'เอาเส้น 2 เส้นนี้ออก 2 ตัวนี้ มีความสัมพันธ์ ผ่าน
    // SH0S10-080046 ไม่ใช่ตรงไปที่ 10WVON-08OLOR'.
    const _isValidEdgeEndpoint = (s) =>
      typeof s === 'string' && (s.startsWith('bom:') || s.startsWith('project:') || s.startsWith('n_'));
    // Only keep TRUE admin-added custom edges (onConnect emits ids that
    // start with 'e_<base36-timestamp>'). Auto-edges have ids that
    // start with 'e:bom:' or 'e:proj:' — those should always be
    // re-derived from _buildBomNodes, not loaded back from RTDB where
    // a previous onChange callback wrongly saved them. User
    // 2026-05-28: 'เอาเส้น 2 เส้นนี้ออก 2 ตัวนี้ มีความสัมพันธ์ ผ่าน
    // SH0S10-080046 ไม่ใช่ตรงไปที่ 10WVON-08OLOR' — those were RTDB
    // entries with id 'e:10WVON-08OLOR:::SH0S11-...' that survived
    // because their source/target endpoints carried valid prefixes.
    const customEdges = (fresh.edges || []).filter(e =>
      _isValidEdgeEndpoint(e.source) &&
      _isValidEdgeEndpoint(e.target) &&
      typeof e.id === 'string' &&
      e.id.startsWith('e_')
    );
    // Dedup BOM auto-edges vs custom — by id first (React Flow
    // requirement: edge ids must be unique).
    const seenEdgeIds = new Set();
    const dedupEdges = [];
    for (const e of [...bom.edges, ...customEdges]) {
      if (seenEdgeIds.has(e.id)) continue;
      seenEdgeIds.add(e.id);
      dedupEdges.push({
        ...e,
        type: e.type || 'floating',
        style: { strokeWidth: 1.2, opacity: 0.5, ...(e.style || {}) },
      });
    }
    // Then dedup by (source, target) pair — covers legacy edges
    // that carry a different id but draw the same line as a fresh
    // auto-generated one.
    const seenPairs = new Set();
    const initialEdges = dedupEdges.filter(e => {
      const k = `${e.source}|${e.target}`;
      if (seenPairs.has(k)) return false;
      seenPairs.add(k);
      return true;
    });
    window.__kmeInstance = window.KitchenMindmapEditor.mount(host, {
      projectKey: key,
      admin,
      autoFullscreen,
      deepLinkCode: deepCode,
      initialNodes: [...bomNodes, ...customNodes],
      initialEdges,
      onChange: (data) => {
        // Split changes: BOM + project center → overrides path;
        // Custom nodes go through the existing _saveCustomMindmap path.
        // Only TRUE admin-added custom edges persist — id starts with
        // 'e_'. The earlier filter only blocked 'e:proj:' but let
        // 'e:bom:' tree edges leak into RTDB, where they came back on
        // the next load as ghost duplicate spokes. See the matching
        // filter on initialEdges above. User 2026-05-28.
        const customOnly = {
          nodes: [],
          edges: (data.edges || []).filter(e =>
            typeof e.id === 'string' && e.id.startsWith('e_')
          ),
        };
        for (const n of (data.nodes || [])) {
          if (n.id.startsWith('bom:') || n.id.startsWith('project:')) {
            _saveOverride(key, n.id, {
              x: n.position?.x,
              y: n.position?.y,
              label: n.data?.label,
            });
          } else {
            customOnly.nodes.push(n);
          }
        }
        _saveCustomMindmap(key, customOnly);
      },
    });
  }).catch(err => {
    const host = document.getElementById('kme-mount');
    if (host) host.innerHTML = '<p class="loading">Editor failed to load. Check console.</p>';
    console.error('[kme] bundle load failed', err);
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

  ROOT.querySelectorAll('.assembled-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const code = btn.dataset.code;
      markAssembled(key, code, !isAssembled(key, code));
      render();
    });
  });

  // Click bom-row-main → open PDF (don't trigger from comment panel area)
  ROOT.querySelectorAll('.bom-row-main').forEach(el => {
    el.addEventListener('click', (ev) => {
      // Don't open PDF if user clicked a button inside the row
      if (ev.target.closest('button')) return;
      if (el.dataset.has === 'true') _openInNewTab(el.dataset.url);
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
      if (confirm(`Mark drawing "${code}" as needs redo?\n\nIt will move to "(no drawing yet)" group until re-exported with CC_DrawingPDF.`)) {
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

  // Overlay parts from every project BOM (CC_Assembly output). Parts that
  // appear in a project but haven't had a PDF exported yet still belong in
  // the Library — workshop staff scanning by family code shouldn't need to
  // know which project a part lives in to find it. New parts that are
  // already in manifest just refresh fam/urn (no override of status).
  if (manifest.projects) {
    for (const project of Object.values(manifest.projects)) {
      if (!Array.isArray(project.parts)) continue;
      for (const p of project.parts) {
        const fam = p.family;
        if (isJunkFamily(fam)) continue;
        const existing = nodes.get(p.code);
        if (existing) {
          // Already covered by manifest or missing.json — just fill blanks.
          if (!existing.urn && p.urn) existing.urn = p.urn;
          if (!existing.drawing_urn && p.drawing_urn) existing.drawing_urn = p.drawing_urn;
          continue;
        }
        // Upgrade to 'drawn' if a web upload covers this code (own upload
        // or via prefix-share / group alias). Otherwise stays 'missing'.
        const covered = !isDrawingSoftDeleted(p.code) && !!pdfUrlForCode(p.code);
        nodes.set(p.code, {
          code: p.code,
          _prefix: p.code.split('-')[0],
          family: fam,
          pdf: null,
          page: 1,
          exported_at: null,
          status: covered ? 'drawn' : 'missing',
          urn: p.urn || null,
          drawing_urn: p.drawing_urn || null,
          open_url: null,
        });
      }
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

// Project mindmap leaf-click routing — 3-way per feedback_leaf_click_routing
// (clarified 2026-05-25):
//
//   ┌────────────────┬──────────────────────────────────────────────────┐
//   │ Status         │ Click action                                     │
//   ├────────────────┼──────────────────────────────────────────────────┤
//   │ drawn (PDF up- │ Open PDF (read-only — what workshop uses)        │
//   │   to-date)     │                                                  │
//   │ stale (PDF     │ Open Fusion drawing (.f2d) — designer updates it │
//   │   out of date) │                                                  │
//   │ missing        │ Open Fusion 3D master — designer makes drawing   │
//   │ deleted        │ Treat as missing — soft-deleted = redo needed    │
//   └────────────────┴──────────────────────────────────────────────────┘
//
// Bridge: http://127.0.0.1:8765/open?urn=<urn>. Fallback to PDF if any.
async function _routeLeafToFusion(node) {
  // Drawn + current → open PDF directly
  if (node.status === 'drawn') {
    const url = pdfUrlForCode(node.code);
    if (url) { _openInNewTab(url); return; }
  }
  // Track bridge attempt outcome so we can surface a useful message
  // when every path fails (the silent `catch {}` was hiding the most
  // common failure mode: CC_DrawingLauncher add-in not running, or
  // user on a device other than the admin PC).
  let bridgeAttempted = false;
  let bridgeError = null;
  // Stale (drawing exists but out of date) → open Fusion drawing
  if (node.status === 'stale' && node.drawing_urn) {
    bridgeAttempted = true;
    try {
      const r = await fetch(
        `http://127.0.0.1:8765/open?urn=${encodeURIComponent(node.drawing_urn)}`,
        { method: 'GET', mode: 'cors' });
      if (r.ok) return;
      bridgeError = `HTTP ${r.status}`;
    } catch (e) { bridgeError = e?.message || 'fetch failed'; }
  }
  // Missing / deleted / fallback → open Fusion 3D master
  if (node.urn) {
    bridgeAttempted = true;
    try {
      const r = await fetch(
        `http://127.0.0.1:8765/open?urn=${encodeURIComponent(node.urn)}`,
        { method: 'GET', mode: 'cors' });
      if (r.ok) return;
      bridgeError = `HTTP ${r.status}`;
    } catch (e) { bridgeError = e?.message || 'fetch failed'; }
  }
  // Last-resort fallback — PDF if any (handles stale w/o drawing_urn etc.)
  const url = pdfUrlForCode(node.code);
  if (url) { _openInNewTab(url); return; }

  // Nothing worked — tell the user WHY instead of failing silently.
  if (bridgeAttempted) {
    alert(
      `Couldn't open "${node.code || 'this part'}" in Fusion.\n\n` +
      `The local bridge at http://127.0.0.1:8765 didn't respond:\n` +
      `  ${bridgeError}\n\n` +
      `Checks:\n` +
      `1. Are you on the same PC as Fusion?\n` +
      `   (the bridge only listens on localhost — iPad can't reach it)\n` +
      `2. Is the CC_DrawingLauncher add-in Running in Fusion?\n` +
      `   Design workspace → Utilities → Add-ins → look for CC_DrawingLauncher\n` +
      `3. No PDF exists for this code yet either — export one via\n` +
      `   CC_DrawingPDF in Fusion so workshop can read it.`
    );
  } else if (!node.urn) {
    alert(
      `"${node.code || 'this part'}" has no Fusion URN saved.\n\n` +
      `Re-run CC_Assembly in Fusion for this project so the URN is\n` +
      `written into the manifest, then refresh this page.`
    );
  }
}

// Decide what to do when user clicks a leaf (no children) node:
//   1. If has drawing → open PDF
//   2. Else if has urn → try Fusion bridge → fallback web
//   3. Else nothing
async function _doLeafAction(node) {
  const url = pdfUrlForCode(node.code);
  if (url) {
    _openInNewTab(url);
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
    if (node.open_url) _openInNewTab(node.open_url);
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
        <p>Run <code>CC_DrawingPDF</code> + <code>CC_ScanMissingDrawings</code> in Fusion</p>
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
  const adminMode = isAdmin();
  // Empty admin-created folders should still appear so the taxonomy is
  // visible even before any parts land in them. Workshop view also sees
  // these folders (consistency) but they show "0 parts".
  const visible = Array.from(new Set([
    ...Object.keys(by).filter(f => by[f].length),
    ..._customFoldersCache,
  ]));

  if (!visible.length && !adminMode) {
    ROOT.innerHTML = '<p class="loading">No drawings yet — run CC_DrawingPDF in Fusion first</p>';
    COUNT_EL.textContent = '';
    return;
  }

  // Custom order from admin drag — manually-ranked families first (in
  // the user's order), then everything else by default family order
  // (alphabetic / families.json `order`).
  const manualOrder = loadFamilyOrder();
  const rank = new Map(manualOrder.map((k, i) => [k, i]));
  visible.sort((a, b) => {
    const ra = rank.has(a) ? rank.get(a) : Infinity;
    const rb = rank.has(b) ? rank.get(b) : Infinity;
    if (ra !== rb) return ra - rb;
    return familyOrder(a, b);
  });

  const cards = visible.map(fam => {
    const label = familyDisplayLabel(fam);
    const partsInFam = (by[fam] || []).length;
    // Admin also gets a visible ✎ button so iPad users don't need to
    // discover the long-press shortcut. Double-click / long-press still
    // work as before for muscle-memory. A 🗑 button appears on empty
    // folders only — non-empty folders need parts moved out first.
    const renameBtn = adminMode
      ? `<button class="family-rename-btn" data-family-rename="${escapeHtml(fam)}" aria-label="Rename folder" title="Rename folder">✎</button>`
      : '';
    const deleteBtn = (adminMode && partsInFam === 0)
      ? `<button class="family-delete-btn" data-family-delete="${escapeHtml(fam)}" aria-label="Delete folder" title="Delete this empty folder">🗑</button>`
      : '';
    return `
    <div class="family-card" data-family="${escapeHtml(fam)}" style="${famVars(fam)}" ${adminMode ? 'title="Tap ✎ to rename · 🗑 to delete (empty only) · long-press to rename · drag to reorder"' : ''}>
      ${renameBtn}
      ${deleteBtn}
      <div class="family-icon">${familyIcon(fam)}</div>
      <div class="family-name">${escapeHtml(label)}</div>
      <div class="family-count">${partsInFam} parts</div>
    </div>`;
  }).join('');

  // Admin gets a trailing "+ New Family" card to create empty folders.
  // Tapping it prompts for a name; the new family lands in custom_folders
  // and shows in the grid next render. Workshop view doesn't see this card.
  const newFamilyCard = adminMode ? `
    <div class="family-card family-card-new" data-new-family="1" title="Create a new folder (admin)">
      <div class="family-icon family-icon-plus">+</div>
      <div class="family-name">New Family</div>
      <div class="family-count">create folder</div>
    </div>` : '';

  ROOT.innerHTML = `<div class="family-grid">${cards}${newFamilyCard}</div>`;

  // Admin "+ New Family" card — separate handler since it doesn't have a
  // data-family attribute and shouldn't trigger the drill-into-family
  // path on the regular family-card loop below.
  const newFamilyEl = ROOT.querySelector('.family-card-new');
  if (newFamilyEl) {
    newFamilyEl.addEventListener('click', () => {
      const name = prompt(
        'Create a new folder:\n\n' +
        `Existing folders: ${visible.join(', ')}\n\n` +
        'Type a folder name. The folder will appear in Library immediately;\n' +
        'use the 📁 button on any part-row to move parts into it.');
      if (!name) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      addCustomFolder(trimmed);
      // Drill straight into the new folder so admin sees the empty state
      // + can start moving parts in via 📁.
      navTo({ kind: 'family', name: trimmed });
    });
  }

  ROOT.querySelectorAll('.family-card:not(.family-card-new)').forEach(el => {
    // Click → drill into family. A long-press in admin (touch-friendly
    // rename) suppresses the click via _suppressClickUntil; a successful
    // double-click rename also suppresses via the same flag. Taps on the
    // ✎ rename button are also ignored (it has its own handler).
    let _suppressClickUntil = 0;
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.family-rename-btn, .family-delete-btn')) return;
      if (Date.now() < _suppressClickUntil) {
        ev.preventDefault(); ev.stopPropagation();
        return;
      }
      navTo({ kind: 'family', name: el.dataset.family });
    });
    // Admin: 🗑 delete button (only rendered when folder is empty).
    const deleteBtn = el.querySelector('.family-delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const fam = deleteBtn.dataset.familyDelete;
        const label = familyDisplayLabel(fam);
        if (!confirm(`Delete folder "${label}"?\n\nThis removes the empty folder from Library. If you renamed it earlier, the rename is also cleared.`)) return;
        removeCustomFolder(fam);
        // Also clear any label rename for this folder — the folder itself
        // is gone, so a stale label would orphan in the cache.
        if (_familyLabelsCache[fam]) setFamilyLabel(fam, '');
        render();
      });
    }
    // Admin: double-click OR long-press OR ✎ button to rename, drag PDF
    // to upload.
    if (adminMode) {
      const triggerRename = () => {
        const fam = el.dataset.family;
        const current = familyDisplayLabel(fam);
        const next = prompt(`Rename folder "${fam}":\n\n(Leave empty to reset to the default name.)`, current);
        _suppressClickUntil = Date.now() + 400;  // swallow the click that follows
        if (next === null) return;  // cancelled
        setFamilyLabel(fam, next);  // empty string resets to default key
        render();
      };
      // Visible ✎ button — explicit rename trigger.
      const renameBtn = el.querySelector('.family-rename-btn');
      if (renameBtn) {
        renameBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          triggerRename();
        });
      }
      el.addEventListener('dblclick', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        triggerRename();
      });
      // Long-press (≥600ms) — touch-friendly path. Cancels if the user
      // lifts, moves, or scrolls before the timer fires.
      let pressTimer = null;
      let startX = 0, startY = 0;
      const cancelPress = () => {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      };
      el.addEventListener('pointerdown', (ev) => {
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        startX = ev.clientX; startY = ev.clientY;
        cancelPress();
        pressTimer = setTimeout(() => {
          pressTimer = null;
          triggerRename();
        }, 600);
      });
      el.addEventListener('pointermove', (ev) => {
        if (!pressTimer) return;
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (dx * dx + dy * dy > 100) cancelPress();  // moved >10px → cancel
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(evt =>
        el.addEventListener(evt, cancelPress));
      // PDF drag-drop upload — preventDefault on dragover to enable drop.
      el.addEventListener('dragover', (ev) => {
        if (ev.dataTransfer && [...ev.dataTransfer.items || []].some(i => i.kind === 'file')) {
          ev.preventDefault();
          el.classList.add('drag-over');
        }
      });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        el.classList.remove('drag-over');
        const file = ev.dataTransfer?.files?.[0];
        if (!file) return;
        if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
          alert('PDF only — got ' + (file.type || file.name));
          return;
        }
        const fam = el.dataset.family;
        const guess = file.name.replace(/\.pdf$/i, '');
        const code = prompt(
          `Upload PDF to family "${fam}":\n\n` +
          `Enter the part CODE this drawing covers ` +
          `(prefix-shares means any other config of the same prefix will inherit too):`,
          guess);
        if (!code) return;
        const ok = await uploadPdfFromDrop(file, code.trim(), fam);
        if (ok) {
          // Firebase listener triggers render — but force one in case
          // of timing.
          setTimeout(() => render(), 400);
        }
      });
    }
  });

  // Admin: drag-reorder via Sortable.js (same library used for projects).
  if (adminMode && window.Sortable) {
    const gridEl = ROOT.querySelector('.family-grid');
    if (gridEl) {
      Sortable.create(gridEl, {
        animation: 150,
        ghostClass: 'family-card-ghost',
        chosenClass: 'family-card-chosen',
        dragClass: 'family-card-drag',
        forceFallback: true,
        fallbackTolerance: 4,
        onEnd: () => {
          const newOrder = [...gridEl.querySelectorAll('.family-card')]
            .map(el => el.dataset.family);
          saveFamilyOrder(newOrder);
          render();
        },
      });
    }
  }

  const total = Object.values(by).reduce((s, arr) => s + arr.length, 0);
  COUNT_EL.textContent = `${visible.length} families · ${total} parts`;
}

function renderFamily(fam, highlight) {
  const items = partsByFamily()[fam] || [];
  const adminMode = isAdmin();
  const list = items.map(p => {
    // pdfUrlForCode handles uploads (full URL) and aliases; pdfUrl is
    // only correct for manifest entries whose filename happens to live
    // next to index.html.
    const url = pdfUrlForCode(p.code) || pdfUrl(p);
    const display = displayCodeFor(p.code);
    const isRenamed = display !== p.code;
    const codeTitle = isRenamed ? ` title="Original: ${escapeHtml(p.code)}"` : '';
    const ver = p.isManual ? '' :
      (p.last_drawn_version > 0 ? `<span class="part-version">v${p.last_drawn_version}</span>` : '');
    // Admin gets a pencil button on the right to rename (display only —
    // the underlying p.code stays as the data key for PDF / RTDB), a
    // folder button to move the part to a different family chip, AND a
    // DXF button to download the laser-cut source files. The DXF button
    // is only present if at least one DXF has been uploaded for this
    // master code (CC_Laser pushed metadata into uploaded_dxfs).
    let adminBtns = '';
    if (adminMode) {
      const dxfList = dxfsForMasterCode(p.code);
      const dxfBtn = dxfList.length > 0
        ? `<button class="part-dxf-btn" data-dxf-code="${escapeHtml(p.code)}" aria-label="${dxfList.length === 1 ? 'Download DXF' : 'Download DXFs'}" title="${dxfList.length === 1 ? 'Download laser-cut DXF' : `Download one of ${dxfList.length} DXFs`}">📐${dxfList.length > 1 ? ' ' + dxfList.length : ''}</button>`
        : '';
      adminBtns = `<div class="part-actions">
        <button class="part-rename-btn" data-rename-code="${escapeHtml(p.code)}" aria-label="Rename display" title="Rename display (does not change the Fusion-side code)">✎</button>
        <button class="part-folder-btn" data-folder-code="${escapeHtml(p.code)}" aria-label="Move to folder" title="Move to a different folder / create new folder">📁</button>${dxfBtn}
      </div>`;
    }
    return `
      <div class="part-row" data-url="${escapeHtml(url)}" data-code="${escapeHtml(p.code)}" style="${famVars(fam)}">
        <span class="part-icon">${familyIcon(fam)}</span>
        <span class="part-code"${codeTitle}>${escapeHtml(display)}</span>
        ${ver}
        ${adminBtns}
      </div>`;
  }).join('');

  // Empty-folder hint — shown when no parts in this folder. Admin gets a
  // tip to use 📁 on a part-row elsewhere to move parts in; workshop sees
  // a neutral "empty" message.
  const emptyHint = items.length === 0
    ? `<div class="empty-folder-hint">
         <div class="empty-folder-icon">📂</div>
         <div class="empty-folder-title">This folder is empty</div>
         ${adminMode
           ? '<div class="empty-folder-tip">Open another folder, tap 📁 on a part to move it here.</div>'
           : ''}
       </div>`
    : '';

  // Back button is in the header (#header-back-row) — see
  // _updateHeaderBack(). No inline button rendered here.
  //
  // Source breadcrumb — when admin drills in via openInLibrary (from a
  // mindmap code-text click or the NO PDF chip), the stack carries a
  // `highlight` field with the originating code. Surface it so the user
  // knows *why* they landed here AND can click to go back to where they
  // came from (the project view that triggered the nav). User
  // 2026-05-29: 'กดเข้า Part แล้วต้องมี title ด้านบนด้วยซิ' →
  // 'เป็นปุ่มให้กดกลับไปที่ๆมาได้'. Source is captured by openInLibrary
  // — falls back to a non-clickable pill when missing (e.g. deep-link
  // entry, NO PDF chip from a context without a stack origin).
  const stackTop = stack[stack.length - 1] || {};
  const source = stackTop.source || null;
  const breadcrumbLabel = source ? 'Back to' : 'from';
  const breadcrumb = highlight
    ? (source
        ? `<button type="button" class="family-breadcrumb family-breadcrumb-btn" title="Go back to ${escapeHtml(source.name || source.kind || 'previous')}">↩ Back to <strong>${escapeHtml(source.name || source.kind)}</strong> · ${escapeHtml(highlight)}</button>`
        : `<div class="family-breadcrumb" title="The part you tapped — scroll for the highlighted row">↩ from <strong>${escapeHtml(highlight)}</strong></div>`)
    : '';

  ROOT.innerHTML = `
    <h2 class="section-title section-title-family" style="${famVars(fam)};color:var(--fam-color)">${familyIcon(fam)} ${escapeHtml(fam)}<span class="count">${items.length} parts</span></h2>
    ${breadcrumb}
    <div class="part-list">${list}</div>
    ${emptyHint}
  `;

  // Wire the breadcrumb back-button (only when source is present).
  // Restores the source view directly — same shape as openInLibrary's
  // own stack write, just in reverse.
  ROOT.querySelector('.family-breadcrumb-btn')?.addEventListener('click', () => {
    if (!source) return;
    view = 'projects';
    document.getElementById('tab-library')?.classList.remove('active');
    document.getElementById('tab-projects')?.classList.add('active');
    if (source.kind === 'project' && source.name) {
      stack = [{ kind: 'projects' }, { kind: 'project', name: source.name }];
    } else {
      stack = [{ kind: 'projects' }];
    }
    render();
  });

  ROOT.querySelectorAll('.part-row').forEach(el => {
    el.addEventListener('click', (ev) => {
      // Ignore clicks on admin buttons — each has its own handler.
      if (ev.target.closest('.part-rename-btn, .part-folder-btn, .part-dxf-btn')) return;
      // _openInNewTab handles the iPad PWA standalone case (same-window
      // navigation) vs browser (new tab). Plain window.open '_blank'
      // opens an invisible off-screen webview on standalone PWAs —
      // workshop sees "nothing happens" when tapping the row.
      _openInNewTab(el.dataset.url);
    });
  });

  // Admin rename: prompt for new display label. Empty / equal-to-original
  // clears the override. Re-render to show the new label.
  ROOT.querySelectorAll('.part-rename-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const code = btn.dataset.renameCode;
      const current = displayCodeFor(code);
      const next = prompt(`Rename display for "${code}":\n\n(Leave empty or match the original to reset.)\n\nThis only changes what shows on screen — Fusion data stays untouched.`, current);
      if (next === null) return;
      setDisplayOverride(code, next);
      render();
    });
  });

  // Admin: drag-drop a PDF onto a specific part-row to upload it for
  // that exact code. Different from family-card drop (which prompts for
  // the code) — here the code is the row's data-code attribute, so no
  // prompt is needed. Workshop view doesn't render this handler.
  if (adminMode) {
    ROOT.querySelectorAll('.part-row').forEach(rowEl => {
      rowEl.addEventListener('dragover', (ev) => {
        if (ev.dataTransfer && [...ev.dataTransfer.items || []].some(i => i.kind === 'file')) {
          ev.preventDefault();
          rowEl.classList.add('part-row-drag-over');
        }
      });
      rowEl.addEventListener('dragleave', (ev) => {
        // Only clear if leaving the row itself (not a child) — dragleave
        // fires when crossing into children otherwise.
        if (!rowEl.contains(ev.relatedTarget)) {
          rowEl.classList.remove('part-row-drag-over');
        }
      });
      rowEl.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();  // prevent the row's "open PDF" click handler from also firing
        rowEl.classList.remove('part-row-drag-over');
        const file = ev.dataTransfer?.files?.[0];
        if (!file) return;
        if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
          alert('PDF only — got ' + (file.type || file.name));
          return;
        }
        const code = rowEl.dataset.code;
        if (!code) return;
        if (!confirm(`Upload "${file.name}" as the drawing for "${code}"?\n\n(Replaces any existing PDF for this code.)`)) return;
        rowEl.classList.add('part-row-uploading');
        const ok = await uploadPdfFromDrop(file, code, fam);
        rowEl.classList.remove('part-row-uploading');
        if (ok) {
          // Firebase listener triggers render — force one in case of timing.
          setTimeout(() => render(), 400);
        }
      });
    });
  }

  // Admin move-to-folder: prompt for target folder name. Typing a new name
  // creates the folder on the fly (renderLibraryHome groups by family, so
  // any family with >=1 part appears as a chip). Empty input clears the
  // override so the part goes back to its Fusion-assigned folder.
  ROOT.querySelectorAll('.part-folder-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const code = btn.dataset.folderCode;
      const allFolders = Object.keys(partsByFamily()).sort();
      const currentFolder = effectiveFamily(code, '');
      const next = prompt(
        `Move "${code}" to folder:\n\n` +
        `Current: ${currentFolder || '(Fusion default)'}\n` +
        `Existing folders: ${allFolders.join(', ')}\n\n` +
        `Type folder name (existing or new — typing a new name creates it).\n` +
        `Leave empty to reset to Fusion's classification.`,
        currentFolder);
      if (next === null) return;
      setFamilyOverride(code, next);
      // After moving, navigate to the new folder so admin sees the result.
      const target = next.trim();
      if (target && target !== fam) {
        // Replace top of stack with the new family
        stack[stack.length - 1] = { kind: 'family', name: target, highlight: code };
      }
      render();
    });
  });

  // Admin DXF button: N=1 triggers direct download, N>1 opens a popover
  // anchored below the button. One row per DXF, filename-sorted (stable
  // ordering across re-renders). Outside-click, Escape, or scroll dismiss.
  ROOT.querySelectorAll('.part-dxf-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const code = btn.dataset.dxfCode;
      const list = dxfsForMasterCode(code);
      if (list.length === 0) return;  // race: render saw N>=1 but cache cleared since
      if (list.length === 1) {
        _downloadFile(list[0].url, list[0].filename || `${list[0].stem}.dxf`);
        return;
      }
      _renderDxfPopover(btn, list);
    });
  });

  // Deep-link from a BOM "NO PDF" chip — scroll + flash the matching row
  // so the user lands on it. Auto-clears the highlight after 2.5s so
  // unrelated subsequent renders aren't styled. See spec
  // docs/superpowers/specs/2026-05-27-library-link-from-bom-node-design.md
  if (highlight) {
    const target = ROOT.querySelector(`.part-row[data-code="${CSS.escape(highlight)}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.classList.add('part-row-highlight');
      setTimeout(() => target.classList.remove('part-row-highlight'), 2500);
    }
  }
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
      const url = pdfUrlForCode(m.code) || pdfUrl(m);
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
        _openInNewTab(url);
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
    // Belt-and-braces: workshop can't navigate to Library OR Nest even
    // if the hidden tab is somehow exposed (devtools, scripted click).
    // Admin unrestricted.
    if ((v === 'library' || v === 'nest') && !isAdmin()) return;
    if (v === view) return;
    view = v;
    stack = [];
    SEARCH.value = '';
    updateSearchClear();
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    SEARCH.placeholder = view === 'projects'
      ? 'Search project or part…'
      : (view === 'nest'
          ? 'Search project to nest…'
          : 'Search part code…');
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
  // Role triggers — :laser, :bend, :assemble, :workshop. Append "off"
  // to reset to default (workshop). Mirrors the admin pattern. The
  // ROLES table is the single source of truth so adding a new role
  // here doesn't need a new branch.
  for (const r of ROLE_KEYS) {
    if (q === `:${r}` || q === `:${r} on`) {
      setRole(r);
      SEARCH.value = '';
      updateSearchClear();
      render();
      return;
    }
    if (q === `:${r} off` || q === `:${r} 0`) {
      setRole(DEFAULT_ROLE);
      SEARCH.value = '';
      updateSearchClear();
      render();
      return;
    }
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
  // Show role chip if this device is set to a non-default role.
  updateRoleBadge();

  // Connect to Firebase Realtime DB for shared comments + timers + soft-
  // deleted drawings (real-time sync across devices). Falls back to
  // localStorage if Firebase unavailable.
  initCommentsSync();
  initTimersSync();
  initDeletedDrawingsSync();
  initDeletedProjectsSync();
  initPinnedSync();
  initFamilyChipSync();
  initUploadedPdfsSync();
  initUploadedDxfsSync();
  initCutSheetsSync();
  initNestPartsSync();
  initActiveRowsSync();
  initBentSync();
  initAssembledSync();
  // One-shot push of any pre-existing localStorage bent/assembled
  // entries to RTDB so old per-device state surfaces on every device.
  _migrateLocalToFirebase();

  try {
    const [m, f] = await Promise.all([
      fetchJson(window.APP_CONFIG.MANIFEST_URL),
      fetchJson('families.json'),
    ]);
    manifest = m;
    // Expose for sibling modules (nest.js etc) that need the same
    // projects + parts data without re-fetching.
    window.kdManifest = manifest;
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
    // Load drawing_aliases.json — groups of codes that share one drawing.
    // Per feedback_leaf_click_routing + user's "shared drawing" rule.
    // Empty if file absent (no aliases configured yet).
    try {
      const mu = window.APP_CONFIG.MANIFEST_URL || 'Drawings/manifest.json';
      const aliasesPath = mu.replace(/[^/]+$/, 'drawing_aliases.json');
      const aliasData = await fetchJson(aliasesPath);
      _buildDrawingAliasIndex(aliasData);
    } catch (e) {
      _buildDrawingAliasIndex(null);
    }
    // Rewrite family names (Drawer split, Back-Down → DW-BK, Floor → DW-FL)
    // so everything downstream sees only the new names.
    applyFamilyRemap();
    updateMissingBadge();

    // If no projects yet AND user is admin, default to Library view so
    // they can manage parts. Workshop never lands on Library (the tab
    // is hidden) — they just see an empty Projects list.
    const hasProjects = manifest.projects && Object.keys(manifest.projects).length > 0;
    if (!hasProjects && isAdmin()) {
      view = 'library';
      document.getElementById('tab-projects').classList.remove('active');
      document.getElementById('tab-library').classList.add('active');
    }

    // Ensure tab visibility matches admin state on boot.
    updateAdminBadge();

    // Header Back button — wired once at init. The inline back-btn
    // inside ROOT views was removed 2026-05-28 in favor of this single
    // header instance shown/hidden via _updateHeaderBack().
    const headerBack = document.getElementById('header-back-btn');
    if (headerBack) headerBack.addEventListener('click', navBack);

    render();

    // Deep-link from a merged-PDF link annotation or shared URL.
    // Manifest is loaded so the project lookup will succeed.
    _applyDeepLinkFromHash();
    window.addEventListener('hashchange', _applyDeepLinkFromHash);

    // ?p=<projectKey> auto-navigate (see applyUrlFlags above for the
    // parse step). Lets admin send each cabinet team a single deep
    // link straight into their project — `?role=assemble&p=Bung+01`.
    const initialProject = window.__kdInitialProject;
    if (initialProject && manifest.projects && manifest.projects[initialProject]) {
      stack.push({ kind: 'project', name: initialProject });
      window.__kdInitialProject = null;
      render();
    }
  } catch (e) {
    ROOT.innerHTML = `<div class="error">Failed to load data: ${escapeHtml(e.message)}<br><br>Check MANIFEST_URL in config.js</div>`;
  }
}

init();
