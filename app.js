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

// ── Live manifest auto-refresh (RD 02 2026-06-09) — newly-exported drawings
// self-appear without a reload. Cheap HEAD-diff first; only on change do a full
// GET + re-render. Triggered on focus/visibility (debounced) + a light poll while a
// data tab is open. (index.html itself is still max-age=600, so the FIRST adoption
// of the no-store loader still needs one cache clear; after that this keeps it live.)
let _manifestSig = null;     // last-seen HTTP signature (ETag / Content-Length)
let _manifestGenAt = null;   // last-applied manifest.generated_at
let _manifestRefreshTimer = null;

// Cheap HEAD-diff, then full GET only if the manifest actually changed; on a real
// content change (generated_at differs) re-apply + re-render the current tab + pulse.
async function _refreshManifest() {
  const url = window.APP_CONFIG && window.APP_CONFIG.MANIFEST_URL;
  if (!url) return;
  try {
    // 1) cheap HEAD — ETag/Content-Length flags a change without pulling the whole file
    let sig = null;
    try {
      const h = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { method: 'HEAD', cache: 'no-store' });
      if (h.ok) sig = h.headers.get('etag') || h.headers.get('content-length') || h.headers.get('last-modified');
    } catch {}
    if (sig && _manifestSig && sig === _manifestSig) return;   // unchanged → skip the GET
    // 2) full GET (no-store) + guard on generated_at so a spurious ETag doesn't re-render
    const m = await fetchJson(_cacheBust(url));
    _manifestSig = sig || _manifestSig;
    if (!m || !m.generated_at || m.generated_at === _manifestGenAt) return;
    _manifestGenAt = m.generated_at;
    manifest = m;
    window.kdManifest = manifest;
    try { UPDATED.textContent = fmtDate(manifest.generated_at); } catch {}
    try { missingData = await fetchJson(_cacheBust(url.replace(/[^/]+$/, 'missing.json'))); } catch {}
    try { _buildDrawingAliasIndex(await fetchJson(_cacheBust(url.replace(/[^/]+$/, 'drawing_aliases.json')))); } catch {}
    applyFamilyRemap();
    try { updateMissingBadge(); } catch {}
    // _refreshAssemblyUI: when the mindmap editor is live it pulses kme:extsync
    // (nodes re-render in place — NO-PDF badges flip via the live pdfUrlForCode
    // check) instead of a full render() remount (canvas flash + viewport reset).
    // On list views it falls back to render() itself. Note: a brand-NEW part
    // (not yet a node) still needs the next full render to appear.
    try { _refreshAssemblyUI(); } catch { _backgroundRender(); }
    _manifestPulse();
  } catch (e) { /* network hiccup — next trigger retries */ }
}
function _scheduleManifestRefresh() {
  if (_manifestRefreshTimer) clearTimeout(_manifestRefreshTimer);
  _manifestRefreshTimer = setTimeout(() => { _manifestRefreshTimer = null; _refreshManifest(); }, 2000);
}
// Shared transient toast (auto-fades via CSS .show). Text is set EVERY call so
// different callers (manifest refresh / Fusion-open) don't show each other's stale text.
function _kdToast(msg) {
  try {
    let t = document.getElementById('kd-refresh-toast');
    if (!t) { t = document.createElement('div'); t.id = 'kd-refresh-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
  } catch {}
}
// Subtle 'updated' toast — auto-fades (CSS). Confirms a live refresh landed.
function _manifestPulse() { _kdToast('↻ Updated — new drawings'); }
// Confirm a Fusion-open click REGISTERED — the file opens BEHIND the browser, so without
// this the click looks like "nothing happened" (the exact symptom เอ๋ hit). (RD 02 2026-06-09)
function _toastOpening(code) { _kdToast('⧉ Opening ' + (code || 'file') + ' in Fusion…'); }
// Wire the triggers once: focus / tab-visible (debounced) + a light 60s poll while a
// data tab is open (paused when hidden, to save quota/battery).
function _initManifestAutoRefresh() {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) _scheduleManifestRefresh(); });
  window.addEventListener('focus', () => _scheduleManifestRefresh());
  setInterval(() => {
    if (document.hidden) return;
    // Mindmap/editor keeps view==='projects' — include it via #kme-mount, else the
    // poll never fires on เอ๋'s primary screen and a new export only shows after an
    // alt-tab focus cycle (never, on a second monitor). (2026-06-09 latency audit)
    // Projects HOME list included too (RD 02 2026-06-11 — เอ๋ ran Assembly and the
    // new project card never appeared until manual reload). Home only: a drilled-in
    // project view may have a comment box mid-typing; nest stays excluded (a poll
    // render() would clobber an open nesting workspace).
    if (view === 'library' || view === 'drawing'
        || (view === 'projects' && !stack.length)
        || document.getElementById('kme-mount')) _refreshManifest();
  }, 60000);
}

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
const LS_DRAWING_LINKS_KEY = 'kd_drawing_links_v1';          // {code: targetCode} — admin "Edit Link": a NO-PDF node borrows another code's drawing.
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
  // Per-role tab visibility (rules in applyTabVisibility). Drives which of
  // the 5 header tabs each role sees + bounces off a now-hidden tab.
  applyTabVisibility();
}

// ── Per-role tab visibility (เอ๋ 2026-06-07) ──────────────────────────
// Each workshop role sees only its own work (Projects, role-tinted into
// the cut/bend/assembly list) plus the ONE extra tab its job needs:
//   laser    → Projects + Nest          (ช่างตัด: nest then cut)
//   bend     → Projects + Sim.Bending   (ช่างพับ: bend simulation)
//   assemble → Projects + Drawing       (ช่างประกอบ: assembly drawings)
//   workshop → Projects + Drawing (generic viewer).
// Library is part-taxonomy management — admin only (workshop viewer doesn't see it).
// ADMIN overrides everything: the owner ALWAYS sees all 5 tabs in any role (เอ๋ 2026-06-08
// 'admin เห็นครบ 5 เสมอ' — an admin who'd switched into a worker role used to get trapped in
// that role's 2-tab view). The role still tints the lists/colours for the admin; to preview a
// worker's hidden-tab experience, turn admin OFF first, then the per-role gating below applies.
// (Supersedes the 2026-06-07 'admin on a worker link sees the worker view' rule.)
function _visibleTabsForRole() {
  // Admin ALWAYS sees all 5 tabs (เอ๋ 2026-06-08 'admin เห็นครบ 5 เสมอ'). The role still tints the
  // lists/colours, but it no longer HIDES tabs for the owner — an admin who had switched into a
  // worker role (or opened a worker link) used to get trapped in that role's 2-tab view. To preview
  // a worker's hidden-tab experience, turn admin OFF first (then the role gating below applies).
  if (isAdmin()) return { projects: true, library: true, drawing: true, nest: true, simbend: true };
  switch (getRole()) {
    case 'laser':    return { projects: true, library: false, drawing: false, nest: true,  simbend: false };
    case 'bend':     return { projects: true, library: false, drawing: false, nest: false, simbend: true  };
    case 'assemble': return { projects: true, library: false, drawing: true,  nest: false, simbend: false };
    default:         return { projects: true, library: false, drawing: true,  nest: false, simbend: false };  // generic viewer
  }
}

const _TAB_IDS = { projects: 'tab-projects', library: 'tab-library', drawing: 'tab-drawing', nest: 'tab-nest', simbend: 'tab-simbend' };

function applyTabVisibility() {
  const vis = _visibleTabsForRole();
  for (const [key, id] of Object.entries(_TAB_IDS)) {
    const el = document.getElementById(id);
    if (el) el.style.display = vis[key] ? '' : 'none';
  }
  // If the current view is now hidden (worker link landing on a gated tab,
  // legacy URL, or a role switch), bounce back to Projects so the hidden
  // tab can't trap the user.
  if (typeof view !== 'undefined' && _TAB_IDS[view] && !vis[view]) {
    view = 'projects';
    stack = [];
    document.getElementById('tab-projects')?.classList.add('active');
    for (const [key, id] of Object.entries(_TAB_IDS)) {
      if (key !== 'projects') document.getElementById(id)?.classList.remove('active');
    }
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
//   • In-app role chips (header) — the ONLY supported switch since 2026-06-09
//     (?role= URL links retired per เอ๋; the param is now stripped + ignored)
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
  // The role now gates the Library/Nest tabs (bend role hides them), so
  // re-run the tab/badge logic when the role switches at runtime.
  try { updateAdminBadge(); } catch {}
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
  // already-active chip as a toggle-off to DEFAULT_ROLE. The ":laser off"
  // search-box magic word still works (?role= URL links retired 2026-06-09).
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
    // ?role= URL links RETIRED per เอ๋ (2026-06-09 — shared role-links surfacing in
    // LINE chats made it unclear who had what; roles are now switched ONLY via the
    // in-app role buttons). The param is still stripped from the URL so old shared
    // links degrade gracefully to the plain site instead of carrying a dead flag.
    if (params.has('role')) {
      params.delete('role');
      dirty = true;
    }
    // Deep-link `?p=Bung+01` auto-navigates straight into that project
    // once the manifest loads — a single URL lands a team in the right
    // project without scrolling the list. Stashed in window so the
    // manifest-load handler can pick it up after data arrives (the
    // project may not exist yet at flag-parse time).
    if (params.has('p')) {
      window.__kdInitialProject = params.get('p') || '';
      params.delete('p');
      dirty = true;
    }
    // Deep-link `?asm` = SHARED ASSEMBLER LINK (เอ๋ 2026-06-22 "link ต้องเข้าไป
    // ในส่วน assembly" + "ควรให้เขาเห็น งาน assembly ทั้งหมด"). Two flavours
    // depending on the value, both safe replacements for the retired ?role=:
    //   `?asm` (no value) or `?asm=all` — GENERIC entry. Just bakes
    //     role=assemble onto this device + lands on Projects home so the
    //     assembler sees ALL projects (one LINE share for life — เอ๋'s ask).
    //   `?asm=<project>` — PER-PROJECT entry. Bakes role + drops straight into
    //     that project's Assembly view (Kanban+Checklist+Mindmap = the project
    //     page).
    // Either way the URL is stripped post-apply so a re-share doesn't carry
    // role/view info.
    if (params.has('asm')) {
      const v = params.get('asm') || '';
      if (v === '' || v.toLowerCase() === 'all') {
        // Generic. Direct LS write — applyUrlFlags runs at script-init time
        // before the DOM is fully ready, and setRole() has DOM side effects;
        // the first render() reads kd_role_v1 from LS so we're correct without
        // needing the badge re-paint here.
        try { localStorage.setItem(LS_ROLE_KEY, 'assemble'); } catch {}
      } else {
        window.__kdInitialProject = v;
        window.__kdAsmBakeRole = true;
      }
      params.delete('asm');
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

// Append a unique cache-bust param. GitHub Pages serves Drawings/*.json with
// Cache-Control: max-age=600 (10 min) via the Fastly CDN, and the app has a
// network-first service worker — so after a publish (CC_SimplePDF → sync.bat)
// the part is live on the host but a NORMAL reload keeps showing the stale
// manifest for up to 10 min → "I exported the PDF but the web still says NO
// PDF". cache:'no-store' only bypasses the BROWSER cache, not the CDN edge.
// A unique ?t= makes every load a CDN cache-miss = always fresh. (เอ๋ 2026-06-09)
function _cacheBust(url) {
  return url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
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
  // FN3 family → FN3BLA-110000, the dedicated FN3 drawing (เอ๋ 2026-06-13
  // "PDF FN3 ทั้งหมด ให้ใช้ FN3BLA-110000"). GATED on FN3BLA-110000 actually
  // having its own manifest drawing: until เอ๋ exports it, FN3 codes fall
  // THROUGH to the generic FN_B__→FN0B00 rule below — so no dead eye / no
  // regression in the meantime. The MOMENT FN3BLA-110000 is drawn, every FN3*
  // (incl. future FN3 subtypes) switches to it automatically. Must precede the
  // FN_B__ rule, which would otherwise capture FN3* into the generic FN0B00.
  // (FN3BLA-080000/110000 were also removed from the FN0B00 group in
  // drawing_aliases.json so the group can't override this once it's drawn.)
  if (/^FN3/i.test(code) && code.toUpperCase() !== 'FN3BLA-110000'
      && manifest && manifest.auto_generated
      && manifest.auto_generated['FN3BLA-110000']) {
    return 'FN3BLA-110000';
  }
  if (/^FN.B..-...000$/.test(code) && code !== 'FN0B00-000000') {
    return 'FN0B00-000000';
  }
  // FTI____-__BUNG → canonical drawing FTI0997-00BUNG (เอ๋ 2026-06-11:
  // 'งาน FTI____-__Bung ให้ใช้ PDF FTI0997-00Bung ทั้งหมด') — covers
  // FTI1332-00BUNG / FTI1359-00BUNG / FTI1850-00BUNG and any future
  // same-shape code. Case-insensitive match; self maps to itself.
  if (/^FTI....-..BUNG$/i.test(code) && code.toUpperCase() !== 'FTI0997-00BUNG') {
    return 'FTI0997-00BUNG';
  }
  return code;
}

// Family-wide FORCE drawing aliases — every code matching the pattern shows the
// TARGET's drawing, OVERRIDING the code's own native too (เอ๋ explicit "ทั้งหมด
// ให้ใช้ PDF X"). [regex, targetCode]; target maps to itself (excluded). Resolved
// in _effectiveDrawingCode ABOVE the native check but BELOW a per-code relink, so
// a deliberate per-code 🔗 relink can still override the family default. Distinct
// from _patternAliasForDrawing, which is a tier-LAST fallback for NO-drawing codes.
const _FORCE_DRAWING_ALIASES = [
  [/^BTHL..-......$/i, 'BTHL00-140025'],   // เอ๋ 2026-06-14: all BTHL__-______ → BTHL00-140025
  // เอ๋ 2026-06-21 (Option A): all 2CF*-______ → 2CF000-000000 (one master; the
  // per-height 2CF drawings are intentionally hidden). FORCE (not prefix_shares):
  // the family spans 3 pre-dash prefixes (2CF000 / 2CFL00 / 2CFR00). 3rd element
  // `true` = SELF-ACTIVATING guard: only redirect once the TARGET has a real
  // published drawing, so if 2CF000-000000 is ever empty this stays DORMANT (every
  // 2CF* keeps its own drawing — never wipes) and auto-fires the instant
  // 2CF000-000000's drawing is on the web (published 2026-06-21, so live now).
  [/^2CF...-......$/i, '2CF000-000000', true],
  // เอ๋ 2026-06-21: the whole 2BK004 family → 2BK000-000000. The single RTDB
  // drawing_links/2BK004-000000 covers ONLY the base code; the project parts are
  // the variants 2BK004-060120 / -070120 / -085120 (no manifest entry) → were
  // NO-PDF. This FORCE alias covers the whole family + future suffixes. 3rd
  // element `true` = SELF-ACTIVATING: redirects only while 2BK000-000000 has a
  // real published drawing (it does now), else DORMANT — never wipes. NB: literal
  // 6-char prefix "2BK004" (one prefix, unlike 2CF's 3) → no inner wildcards; any
  // L/R-position variant (e.g. 2BK0L4) would need its own entry.
  [/^2BK004-......$/i, '2BK000-000000', true],
];

function _effectiveDrawingCode(code, _depth) {
  _depth = _depth || 0;
  const auto = (manifest && manifest.auto_generated) || {};
  // Admin "Edit Link" / pick-PDF override WINS — even over the code's OWN native
  // drawing. เอ๋ 2026-06-14 ("Relink ที่เลือกเอง ชนะ"): relinking a part that
  // already has a drawing (e.g. a config row that shows the shared master PDF)
  // MUST take effect. This intentionally reverses the 2026-06-12 "native wins"
  // order for EXPLICITLY-LINKED codes only — un-linked codes still use their own
  // drawing. Safety: the link only wins if it resolves to a REAL drawing (native
  // OR uploaded); a stale / dead-end link falls back to the code's own drawing so
  // the eye never goes blank. To restore the native drawing, Unlink (picker ✕).
  // Resolved recursively (target may itself be aliased) with a cycle depth guard.
  const linked = _drawingLinksCache[code];
  if (linked && linked !== code && _depth < 8) {
    const eff = _effectiveDrawingCode(linked, _depth + 1);
    if (eff && (auto[eff] || (_uploadedPdfsCache && _uploadedPdfsCache[eff]))) return eff;
  }
  // Family-wide FORCE alias (wins over this code's own native; see _FORCE_DRAWING_ALIASES).
  for (const [re, target, requireTargetDrawing] of _FORCE_DRAWING_ALIASES) {
    if (re.test(code) && code.toUpperCase() !== target.toUpperCase() && _depth < 8) {
      // SELF-ACTIVATING guard: when flagged, redirect ONLY if the target actually
      // has a drawing (native auto OR uploaded) — else fall through so the code
      // keeps its OWN drawing (never wipe a live family on an empty target).
      if (requireTargetDrawing && !(auto[target] || (_uploadedPdfsCache && _uploadedPdfsCache[target]))) continue;
      return _effectiveDrawingCode(target, _depth + 1);
    }
  }
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
  // ?v=<manifest generated_at> busts the BROWSER http cache (max-age=600) so a
  // just-exported/re-exported PDF opens fresh instead of a cached 404/old bytes
  // for up to 10 min. (The Fastly EDGE ignores query strings, but every deploy
  // purges the edge — the browser cache was the lingering stale layer.) เอ๋
  // 2026-06-09 "ส่ง PDF เข้าเว็บช้ากว่าเมื่อก่อนมาก".
  const ver = (typeof manifest === 'object' && manifest && manifest.generated_at)
    ? ('?v=' + encodeURIComponent(manifest.generated_at)) : '';
  if (entry.isManual) {
    return window.APP_CONFIG.MANUAL_BASE_URL + encodeURIComponent(entry.filename) + ver;
  }
  const base = window.APP_CONFIG.PDF_BASE_URL;
  const filename = entry.pdf;
  if (!filename) return '';
  const page = entry.page_number || 1;
  return base + encodeURIComponent(filename) + ver + '#page=' + page;
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

// Resolve a code's drawing-PDF URL the SAME way the gallery/Library row does:
// the part's own url (manifest-entry url / admin upload) first, then pdfUrlForCode.
// pdfUrlForCode alone returns '' for upload/url-only parts (e.g. DSV0F0-020080), so
// the Diff tools use THIS instead — both the modal iframes and _runPdfVisualDiff —
// so any part that shows in the gallery can be diffed. (เอ๋ coverage fix 2026-06-09)
function resolvePartPdfUrl(code) {
  if (!code) return '';
  const by = partsByFamily();
  for (const fam of Object.keys(by)) {
    const p = by[fam].find(x => x.code === code);
    if (p) return p.url || pdfUrlForCode(code) || '';
  }
  return pdfUrlForCode(code) || '';
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
    // CC_Assembly now emits intermediate containers (cabinets/sub-assemblies/
    // wrappers) as parts[] entries (is_wrapper, qty 0) to carry the deep tree.
    // They are NOT laser/BOM parts — keep them out of cut-list / checklist /
    // nesting aggregates (they still render in the mindmap/tree via buildProjectTree).
    if (p.is_wrapper) continue;
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
            <span class="cut-code" title="${escapeHtml(p.code)}">${escapeHtml(displayCodeFor(p.code))}</span>
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

  // Admin drag-drop on EVERY cut row (เอ๋ 2026-05-28 'ให้ผมลากเข้ามาได้ไหม' +
  // 2026-06-10 'แก้ไข dxf … ลากมาวางทับของเดิมได้'):
  //   • ⚠ NO DXF row → drop a .dxf to fill it (e.g. a wrapper code whose DXF
  //     Fusion exported under a leaf name, so the row shows missing).
  //   • 📐 ready row → drop an EDITED .dxf to REPLACE the existing one (confirm
  //     first; _uploadPartDxf fetches the file's sha to overwrite in place).
  // We DON'T call getGitHubPat() here — it would prompt on every page load. The
  // prompt only fires on an actual drop (deferred to _uploadPartDxf).
  if (isAdmin()) {
    ROOT.querySelectorAll('.cut-row').forEach(row => {
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
        // Dropping onto a 📐 ready row overwrites the existing DXF DIRECTLY — no
        // confirm (เอ๋ 2026-06-10 'ไม่ interactive ให้มีการทับเลย'). A NO-DXF row
        // just fills in. Either way the old file stays in git history if needed.
        const isReplace = !row.classList.contains('cut-row-missing');
        const status = row.querySelector('.cut-status');
        const prevHtml = status ? status.outerHTML : '';
        if (status) {
          status.outerHTML = `<span class="cut-status cut-uploading">⏫ ${isReplace ? 'replacing' : 'uploading'}…</span>`;
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
            fresh.outerHTML = `<button type="button" class="cut-status cut-ok" title="View DXF preview">${isReplace ? '✓ replaced' : '📐 ready'}</button>`;
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
  // If a DXF already exists at this path, GitHub's Contents API requires its
  // blob sha to overwrite it (PUT without sha → 422). Fetch it first; null =
  // brand-new file. This lets an edited DXF be dragged straight OVER the old
  // one to replace it (เอ๋ 2026-06-10 'แก้ไข dxf … ลากมาวางทับของเดิมได้').
  let sha = null;
  try { sha = await _ghGetFileSha(repoPath); } catch (e) { /* treat as a new file */ }
  const body = {
    message: `Admin drop: ${sha ? 'replace' : 'upload'} DXF for ${code}`,
    content,
    branch: 'main',
  };
  if (sha) body.sha = sha;
  const resp = await _ghContentsRequest(repoPath, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

// Exposed for nest.js (the Nest review-list ⚠ drag-drop, เอ๋ 2026-06-20): upload a
// part DXF via the SAME laser pipeline (_uploadPartDxf → Drawings/dxf/<code>/<code>.dxf
// + uploaded_dxfs/<code>, code CASE-PRESERVED). Returns {ok, url, metadata} or
// {ok:false, error, noPat?/authFailed?}; clears the PAT on a 401/403 (same as the
// Library drop). nest.js does the row UX + parses the result so ⚠ flips to ✓.
window.kdUploadPartDxf = async function (projectKey, code, file) {
  if (!file || !/\.dxf$/i.test(file.name)) return { ok: false, error: 'Please drop a .dxf file.' };
  if (!code) return { ok: false, error: 'No part code.' };
  if (!getGitHubPat()) return { ok: false, error: 'GitHub PAT not set — open admin settings (🔓) to add it, then retry.', noPat: true };
  try {
    const r = await _uploadPartDxf(projectKey || '', code, file);
    return { ok: true, url: r.url, metadata: r.metadata };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/\b(401|403)\b/.test(msg)) { try { resetGitHubPat(); } catch (_) {} return { ok: false, error: 'GitHub auth failed — PAT cleared. Re-add it (🔓) and retry.', authFailed: true }; }
    return { ok: false, error: msg };
  }
};

// Global FILE-drop guard (เอ๋ 2026-06-20 "อยู่หน้าเดิม ไม่กระโดดไปที่อื่น"): a .dxf/.pdf
// dropped slightly OFF a valid drop target would otherwise make the browser NAVIGATE
// to open the file (the page "jumps away"). Real drop targets call stopPropagation, so
// this document-level listener only catches the MISSES → preventDefault = no navigation,
// the app stays put. Gated to FILE drags ('Files' in types) so internal HTML5 drag-drop
// (sortable rows/cards) is untouched. Registered once at load.
(function _installFileDropGuard() {
  const isFileDrag = e => e && e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1;
  document.addEventListener('dragover', e => { if (isFileDrag(e)) e.preventDefault(); });
  document.addEventListener('drop', e => { if (isFileDrag(e)) e.preventDefault(); });
})();

// Every code in the system that has a viewable drawing PDF (manifest
// auto_generated + admin uploads), each scored by how "near" its code is to
// `forCode` (longest shared code-prefix — so BM2LI1 surfaces BM2LI0/BM1000…
// first). Self is excluded. Used by the bend Pick-PDF picker. (เอ๋ 2026-06-12)
function _bendPdfCandidates(forCode) {
  const auto = (manifest && manifest.auto_generated) || {};
  const seen = new Set();
  const out = [];
  const add = (code) => {
    if (!code || code === forCode || seen.has(code)) return;
    const url = pdfUrlForCode(code);
    if (!url) return;
    seen.add(code);
    out.push({ code, url });
  };
  for (const c of Object.keys(auto)) add(c);
  for (const c of Object.keys(_uploadedPdfsCache || {})) add(c);
  const myPrefix = String(forCode || '').split('-')[0];
  const score = (code) => {
    const p = String(code).split('-')[0];
    let n = 0; const L = Math.min(p.length, myPrefix.length);
    while (n < L && p[n] === myPrefix[n]) n++;
    return n;
  };
  out.forEach(o => { o.score = score(o.code); });
  out.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  return out;
}

// Admin "Pick a drawing PDF" modal for a NO-PDF (or relinking) bend part. Lists
// every code that has a PDF, nearest first, each previewable; choosing one sets
// drawing_links/<code> (RTDB-synced) so the part borrows that drawing on EVERY
// surface. Unlink restores NO-PDF. English-only; reuses the opaque .kdstock
// modal shell (works across all 3 themes). (เอ๋ 2026-06-12)
function _openBendPdfPicker(code) {
  if (!isAdmin() || !code) return;
  document.querySelectorAll('.bendpdf-modal').forEach(m => m.remove());
  const cands = _bendPdfCandidates(code);
  const curLink = getDrawingLink(code);
  // "nearby" = same family letters (the alpha prefix, e.g. BM2LI1 → every BM*),
  // which is what RD/เอ๋ asked to surface first. The candidate sort already puts
  // the longest shared prefix on top (BM2LI0 above BM1000), so the badge just
  // marks the whole family.
  const myFam = (String(code).match(/^[A-Za-z]+/) || [''])[0];
  const rowHtml = (c) => {
    const near = !!myFam && String(c.code).toUpperCase().startsWith(myFam.toUpperCase());
    return `<div class="bendpdf-row${c.code === curLink ? ' is-current' : ''}" data-code="${escapeHtml(c.code)}">
        <span class="bendpdf-code" title="${escapeHtml(c.code)}">${escapeHtml(displayCodeFor(c.code))}${near ? ' <span class="bendpdf-near">nearby</span>' : ''}${c.code === curLink ? ' <span class="bendpdf-cur">current</span>' : ''}</span>
        <span class="bendpdf-acts">
          <button class="bendpdf-preview" data-url="${escapeHtml(c.url)}" title="Preview this PDF">👁</button>
          <button class="bendpdf-use" data-code="${escapeHtml(c.code)}" title="Use this drawing for ${escapeHtml(code)}">Use</button>
        </span>
      </div>`;
  };
  const modal = document.createElement('div');
  modal.className = 'kdstock-modal bendpdf-modal';
  modal.innerHTML = '<div class="kdstock-backdrop"></div>'
    + `<div class="kdstock-frame" role="dialog" aria-label="Pick a drawing PDF">
         <div class="kdstock-head">Pick a drawing PDF
           <span class="kdstock-sub">for ${escapeHtml(displayCodeFor(code))}${curLink ? ' · linked to ' + escapeHtml(curLink) : ''}</span>
           <button class="kdstock-close" aria-label="Close">✕</button>
         </div>
         <div class="bendpdf-tools">
           <input class="bendpdf-search" type="text" placeholder="Search code…" autocomplete="off">
           ${curLink ? '<button class="bendpdf-clear" title="Remove the link — this part goes back to NO PDF">✕ Unlink</button>' : ''}
         </div>
         <div class="bendpdf-list">${cands.length ? cands.map(rowHtml).join('') : '<div class="bendpdf-empty">No drawing PDFs exist in the system yet.</div>'}</div>
       </div>`;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('.kdstock-backdrop').addEventListener('click', close);
  modal.querySelector('.kdstock-close').addEventListener('click', close);
  const search = modal.querySelector('.bendpdf-search');
  search.addEventListener('input', () => {
    const q = search.value.trim().toUpperCase();
    modal.querySelectorAll('.bendpdf-row').forEach(r => {
      r.style.display = (!q || r.dataset.code.toUpperCase().includes(q)) ? '' : 'none';
    });
  });
  try { search.focus(); } catch (e) {}
  modal.querySelectorAll('.bendpdf-preview').forEach(b => b.addEventListener('click', (ev) => {
    ev.stopPropagation(); if (b.dataset.url) _openInNewTab(b.dataset.url);
  }));
  modal.querySelectorAll('.bendpdf-use').forEach(b => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    setDrawingLink(code, b.dataset.code);   // RTDB drawing_links/<code> — syncs everywhere
    close();
    // _backgroundRender (NOT raw render) — when the mindmap editor is live this
    // does the in-place kme:extsync delta instead of rebuilding ROOT, so picking a
    // PDF from a node deep in the canvas keeps the editor's pan/zoom (เอ๋ 2026-06-21
    // standing rule: LINK must not jump). Off the editor it's a scroll-preserving render.
    _backgroundRender();
  }));
  const clearBtn = modal.querySelector('.bendpdf-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => { setDrawingLink(code, ''); close(); _backgroundRender(); });
}

// F2 wall-cabinet 13-char code reference (เอ๋ 2026-06-13). Spec:
// _MASTERS/standards/f2_wall_cabinet_naming.md. English + code + icons only —
// Flux Architect can't render Thai (CLAUDE.md rule); the full Thai cheat sheet
// is a separate downloadable image. Reuses the opaque .kdstock modal shell so
// it stays readable on every theme; all colours are explicit (theme-proof, same
// approach as the bend PDF picker).
// Cube-icon engine for the F2 wall-cabinet codes (เอ๋ 2026-06-14) — extracted to
// module scope so BOTH _openF2Reference (the code cheat-sheet) and _openConfigBrowser
// (the visual config browser) reuse the SAME icons, never redrawn. Isometric-cube
// language: periwinkle = box panel / door · red = cover · visible face = solid ·
// hidden face = 50% + dashed; a hand door is ONE front face split L / R / D.
// cube(key,size) / fnIcon(size) / fcIcon(size) take an optional pixel size (default 20).
function _f2CubeKit() {
  const SUB='#9fb0c0', AMBER='#f2a93b';
  const ic = (d, col, extra='') => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none">${extra}<path d="${d}"/></svg>`;
  const bulbOn = ic('M9 18h6M10 21h4M12 3a6 6 0 0 1 4 10.5c-.7.6-1 1.3-1 2.5H9c0-1.2-.3-1.9-1-2.5A6 6 0 0 1 12 3z', AMBER);
  const bulbOff = ic('M9 18h6M12 3a6 6 0 0 1 4 10.5c-.7.6-1 1.3-1 2.5H9c0-1.2-.3-1.9-1-2.5A6 6 0 0 1 12 3z', SUB, '<line x1="4" y1="4" x2="20" y2="20" stroke="'+SUB+'"/>');
  const dash = ic('M5 12h14', SUB);
  const VX = { TB:[50,16],TR:[84,34],TF:[50,52],TL:[16,34], BB:[50,56],BR:[84,74],BF:[50,92],BL:[16,74], MT:[33,43],MB:[33,83] };
  const _pt=k=>VX[k].join(','), _poly=ks=>ks.map(_pt).join(' ');
  const _TOP=['TB','TR','TF','TL'], _FRONT=['TL','TF','BF','BL'], _RIGHT=['TF','TR','BR','BF'], _LL=['TL','MT','MB','BL'], _LR=['MT','TF','BF','MB'];
  const _HID={ BACK:{pts:['TB','TR','BR','BB'],dash:[['BB','TB'],['BB','BR']],sol:[['TB','TR'],['TR','BR']]},
               BOTTOM:{pts:['BB','BR','BF','BL'],dash:[['BB','BR'],['BB','BL']],sol:[['BR','BF'],['BF','BL']]} };
  // bT/bS/bL = the box/door blue (top-light → side → accent). เอ๋ 2026-06-15:
  // periwinkle → deeper royal/cobalt blue (single source → applies to the F2
  // reference, config browser, AND Library family-folder cubes). Red cover + gray
  // unhighlighted faces + Fusion top-light shading unchanged — hue only.
  const CB={ gT:'#45484d',gL:'#6a6e75',gR:'#5f636b', bT:'#4f7bef',bS:'#2563eb',bL:'#86a6f4', rS:'#e24b4a',rL:'#f2807f', ed:'#eef1f4', rd:'#e24b4a' };
  const _face=(pts,col)=>`<polygon points="${_poly(pts)}" fill="${col}" stroke="${CB.ed}" stroke-width="2.6" stroke-linejoin="round"/>`;
  const _vcube=rc=>{rc=rc||{};return _face(_TOP,rc.TOP||CB.gT)+_face(_FRONT,rc.FRONT||CB.gL)+_face(_RIGHT,rc.RIGHT||CB.gR);};
  const _door=(lB,rB)=>_face(_TOP,CB.gT)+_face(_RIGHT,CB.gR)+_face(_LL,lB?CB.bS:CB.gL)+_face(_LR,rB?CB.bS:CB.gL);
  const _ln=(a,b,col,d)=>`<line x1="${VX[a][0]}" y1="${VX[a][1]}" x2="${VX[b][0]}" y2="${VX[b][1]}" stroke="${col}" stroke-width="3" stroke-linecap="round"${d?' stroke-dasharray="4 3.5"':''}/>`;
  const _hover=(n,f,l)=>{const h=_HID[n];let s=`<polygon points="${_poly(h.pts)}" fill="${f}" fill-opacity="0.5"/>`;h.sol.forEach(e=>s+=_ln(e[0],e[1],l,false));h.dash.forEach(e=>s+=_ln(e[0],e[1],l,true));return s;};
  const _strip=()=>`<line x1="16" y1="34" x2="50" y2="52" stroke="${CB.rd}" stroke-width="8" stroke-linecap="round"/>`;
  const _csvg=(inner,size)=>`<svg width="${size||20}" height="${size||20}" viewBox="0 0 100 100" style="flex:none">${inner}</svg>`;
  // front-face horizontal seam at parameter t (0 = top edge TL→TF, 1 = bottom edge BL→BF)
  const _fln=(t,col,w)=>`<line x1="16" y1="${(34+40*t).toFixed(1)}" x2="50" y2="${(52+40*t).toFixed(1)}" stroke="${col}" stroke-width="${w||4}" stroke-linecap="round"/>`;
  const cube = (key, size) => {
    const M = {
      BK:_vcube()+_hover('BACK',CB.bS,CB.bL), SD:_vcube({RIGHT:CB.bS}), UP:_vcube({TOP:CB.bT}), DN:_vcube()+_hover('BOTTOM',CB.bS,CB.bL),
      CF:_vcube({FRONT:CB.bS})+_strip(), CH:_vcube()+_hover('BOTTOM',CB.rS,CB.rL), CV:_vcube({RIGHT:CB.rS}),
      L:_door(true,false), R:_door(false,true), D:_door(true,true), O:_vcube(),
      F2:_vcube({TOP:CB.bT,FRONT:CB.bS,RIGHT:CB.bS}),
      // family-folder glyphs (เอ๋ 2026-06-15): FT = front panel (front face blue);
      // DW = drawer (blue front + 2 white seams = 3 drawer fronts); SH = shelf
      // (gray box + 2 blue shelves).
      FT:_vcube({FRONT:CB.bS}),
      DW:_vcube({FRONT:CB.bS})+_fln(0.36,CB.ed,3.5)+_fln(0.68,CB.ed,3.5),
      SH:_vcube()+_fln(0.4,CB.bS,5)+_fln(0.72,CB.bS,5)
    };
    return _csvg(M[key] || M.O, size);
  };
  const fnIcon = (size) => _csvg(`<polygon points="${_poly(_TOP)}" fill="none" stroke="${CB.bS}" stroke-width="5" stroke-linejoin="round"/><polygon points="${_poly(_FRONT)}" fill="none" stroke="${CB.bS}" stroke-width="5" stroke-linejoin="round"/><polygon points="${_poly(_RIGHT)}" fill="none" stroke="${CB.bS}" stroke-width="5" stroke-linejoin="round"/>`, size);
  const fcIcon = (size) => { const s=size||20; const c=16,d=8,e=24,cx=66,cy=46; const pt=(X,Y,Z)=>[(cx+(X-Y)*c).toFixed(1),(cy+(X+Y)*d-Z*e).toFixed(1)]; const pol=a=>a.map(p=>p.join(',')).join(' '); const GR={T:CB.gT,L:CB.gL,R:CB.gR},BU={T:CB.bT,L:CB.bS,R:CB.bS}; const bx=(i,j,col)=>{const tp=[pt(i,j,1),pt(i+1,j,1),pt(i+1,j+1,1),pt(i,j+1,1)],rt=[pt(i+1,j,0),pt(i+1,j+1,0),pt(i+1,j+1,1),pt(i+1,j,1)],lf=[pt(i,j+1,0),pt(i+1,j+1,0),pt(i+1,j+1,1),pt(i,j+1,1)];const f=(p,fl)=>`<polygon points="${pol(p)}" fill="${fl}" stroke="${CB.ed}" stroke-width="2.4" stroke-linejoin="round"/>`;return f(lf,col.L)+f(rt,col.R)+f(tp,col.T);}; return `<svg width="${(s*1.3).toFixed(0)}" height="${s}" viewBox="0 0 132 100" style="flex:none">${bx(0,1,GR)+bx(1,0,GR)+bx(1,1,BU)}</svg>`; };
  // "Rough Design logo" — S/Ƨ form (เอ๋ 4-view Fusion ref 2026-06-16): a 3-tall
  // column on the RIGHT + a top bar and a bottom bar extending LEFT, the middle-left
  // left OPEN (the S-notch). highlight: 'full'=all blue (Project) · 'top'=F2 top bar ·
  // 'col'=F3 column · 'lower'=F1 bottom bar. Royal blue + cube-language shading.
  const rdBlocks = (highlight, size) => {
    const s = size || 20;
    const ux=15.5, uy=8.7, hz=20.5, BL=2.2;   // iso units + bar length (units)
    const tx = 50 - (BL*ux)/2, ty = 50 - (((BL+2)*uy) - 3*hz)/2;
    const P=(X,Y,Z)=>[ tx + (X-Y)*ux, ty + (X+Y)*uy - Z*hz ];
    const poly=(pts,col)=>`<polygon points="${pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ')}" fill="${col}" stroke="${CB.ed}" stroke-width="2.2" stroke-linejoin="round"/>`;
    const box=(x0,z0,dx,dz,blue)=>{
      const C = blue?{T:CB.bT,L:CB.bS,R:CB.bS}:{T:CB.gT,L:CB.gL,R:CB.gR};
      const x1=x0+dx, z1=z0+dz, y0=0, y1=1;
      const top=[P(x0,y0,z1),P(x1,y0,z1),P(x1,y1,z1),P(x0,y1,z1)];
      const left=[P(x0,y1,z0),P(x1,y1,z0),P(x1,y1,z1),P(x0,y1,z1)];
      const right=[P(x1,y0,z0),P(x1,y1,z0),P(x1,y1,z1),P(x1,y0,z1)];
      return poly(left,C.L)+poly(right,C.R)+poly(top,C.T);
    };
    const F=(h)=>highlight==='full'||highlight===h;
    // draw back→front: bars (low X, up-left) first, then the column (high X, front)
    const out = box(0, 0, BL, 1, F('lower'))    // bottom bar (left)  z 0..1
              + box(0, 2, BL, 1, F('top'))      // top bar (left)     z 2..3
              + box(BL, 0, 1, 3, F('col'));     // column (right)     z 0..3
    return `<svg width="${s}" height="${s}" viewBox="0 0 100 100" style="flex:none">${out}</svg>`;
  };
  // CL = corner cover panel (เอ๋ ref 2026-06-16): an L-corner of two GRAY cabinet
  // boxes + a thin TALL BLUE vertical cover post at the front inner-corner joint.
  const clIcon = (size) => {
    const s = size || 20;
    const u=15, v=8, h=23;
    const P=(X,Y,Z)=>[ 50 + (X-Y)*u, 52 + (X+Y)*v - Z*h ];
    const poly=(p,c)=>`<polygon points="${p.map(q=>q[0].toFixed(1)+','+q[1].toFixed(1)).join(' ')}" fill="${c}" stroke="${CB.ed}" stroke-width="2.2" stroke-linejoin="round"/>`;
    const cub=(x0,y0,z0,dx,dy,dz,C)=>{const x1=x0+dx,y1=y0+dy,z1=z0+dz;
      return poly([P(x0,y1,z0),P(x1,y1,z0),P(x1,y1,z1),P(x0,y1,z1)],C.L)
           + poly([P(x1,y0,z0),P(x1,y1,z0),P(x1,y1,z1),P(x1,y0,z1)],C.R)
           + poly([P(x0,y0,z1),P(x1,y0,z1),P(x1,y1,z1),P(x0,y1,z1)],C.T);};
    const G={T:CB.gT,L:CB.gL,R:CB.gR}, B={T:CB.bT,L:CB.bS,R:CB.bS};
    // two gray arms (left + right) + a thin tall blue post at the centre-front joint
    const out = cub(0,1, 0, 1,1,1, G)            // left arm (back-left)
              + cub(1,0, 0, 1,1,1, G)            // right arm (back-right)
              + cub(0.86,0.86, 0, 0.28,0.28,1.32, B);  // thin tall blue cover post
    return `<svg width="${s}" height="${s}" viewBox="0 0 100 100" style="flex:none">${out}</svg>`;
  };
  return { cube, fnIcon, fcIcon, bulbOn, bulbOff, dash, rdBlocks, clIcon };
}

function _openF2Reference() {
  document.querySelectorAll('.f2ref-modal').forEach(m => m.remove());
  const K = _f2CubeKit();
  const INK='#e8edf2', SUB='#9fb0c0', STEEL='#7fb0ff', AMBER='#f2a93b',
        CARD='#1b2430', LINE='rgba(255,255,255,0.10)', MONO="ui-monospace,'SF Mono',Menlo,Consolas,monospace";

  const tmpl = [['2','d','1'],['T','d','2'],['T','d','3'],['L','d','4'],['H','d','5'],['V','d','6'],['-','x',''],['W','s','8'],['W','s','9'],['W','s','10'],['H','s','11'],['H','s','12'],['H','s','13']];
  const cells = tmpl.map(c => c[1]==='x'
    ? `<div style="width:14px;text-align:center;font:500 18px ${MONO};color:${SUB};align-self:flex-end;padding-bottom:8px">–</div>`
    : `<div style="text-align:center"><div style="font:500 9px ${MONO};color:${c[1]==='d'?STEEL:AMBER};height:13px">${c[2]}</div><div style="width:27px;height:35px;display:flex;align-items:center;justify-content:center;border:1px solid ${c[1]==='d'?STEEL:AMBER};border-radius:5px;font:500 16px ${MONO};color:${INK};background:${CARD}">${c[0]}</div></div>`
  ).join('');

  const row = (icon, code, txt) => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">${icon||'<span style="width:17px"></span>'}<span style="font:500 13px ${MONO};color:${INK};min-width:26px">${code}</span><span style="font-size:12.5px;color:${SUB}">${txt}</span></div>`;
  const card = (title, rows) => `<div style="background:${CARD};border:1px solid ${LINE};border-radius:9px;padding:11px 13px"><div style="font-size:12px;color:${SUB};margin-bottom:9px">${title}</div>${rows}</div>`;

  const legend = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:14px">`
    + card('Cabinet (2–3)', row(K.fnIcon(), 'FN', 'straight') + row(K.fcIcon(), 'FC', 'corner'))
    + card('Panel (2–3)', row(K.cube('BK'), 'BK', 'back') + row(K.cube('SD'), 'SD', 'side') + row(K.cube('UP'), 'UP', 'top') + row(K.cube('DN'), 'DN', 'bottom') + row(K.cube('CF'), 'CF', 'cover front') + row(K.cube('CH'), 'CH', 'cover horizontal') + row(K.cube('CV'), 'CV', 'cover vertical'))
    + card('Light (4)', row(K.bulbOn, 'L', 'on') + row(K.bulbOff, 'N', 'off') + row(K.dash, '0', 'n/a'))
    + card('Hand (5)', row(K.cube('L'), 'L', 'left') + row(K.cube('R'), 'R', 'right') + row(K.cube('D'), 'D', 'double') + row(K.cube('O'), '0', 'none'))
    + card('Size (8–13)', row('', 'WWW', 'width · 060 = 600') + row('', 'HHH', 'height · 072 = 720'))
    + card('Other', row(K.cube('F2'), '2', 'F2 wall cabinet') + row('', 'V', 'version 0–9'))
    + `</div>`;

  const ex = (codeStr, txt, hot, icons='') => `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap"><span style="font:500 13px ${MONO};color:${hot?'#0f1419':INK};background:${hot?AMBER:CARD};border:1px solid ${hot?AMBER:LINE};padding:3px 9px;border-radius:6px">${codeStr}</span>${icons?`<span style="display:flex;gap:5px;align-items:center">${icons}</span>`:''}<span style="font-size:12.5px;color:${SUB}">${txt}</span></div>`;
  const examples = `<div style="border-top:1px solid ${LINE};padding-top:12px">`
    + ex('2FNLL0-060072', 'straight · light on · left door · 600×720', true, K.fnIcon() + K.bulbOn + K.cube('L'))
    + ex('2FCND0-060060', 'corner · no light · double · 600×600', true, K.fcIcon() + K.bulbOff + K.cube('D'))
    + ex('2CF0R0-060072', 'cover front · right · 600×720 (panels have hand too)', false, K.cube('CF') + K.cube('R'))
    + `</div>`;

  const over = `<div style="background:rgba(242,169,59,0.12);border:1px solid rgba(242,169,59,0.3);border-radius:7px;padding:9px 12px;margin-bottom:14px;font-size:12px;color:${INK}"><b style="font-weight:500;color:${AMBER}">overflow</b> — if slots 1–6 run out and a dimension is constant, borrow WWW/HHH for sub-detail (e.g. 090XXX)</div>`;

  const modal = document.createElement('div');
  modal.className = 'kdstock-modal f2ref-modal';
  modal.innerHTML = '<div class="kdstock-backdrop"></div>'
    + `<div class="kdstock-frame" role="dialog" aria-label="F2 code reference" style="max-width:660px;width:92vw">
         <div class="kdstock-head">F2 wall cabinet — code reference<button class="kdstock-close" aria-label="Close">✕</button></div>
         <div style="padding:16px 18px 18px;background:#0f1419;font-family:var(--font-sans,-apple-system,sans-serif)">
           <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:18px">${cells}</div>
           ${legend}${over}${examples}
         </div>
       </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('.kdstock-backdrop').addEventListener('click', close);
  modal.querySelector('.kdstock-close').addEventListener('click', close);
}

// ── Visual Config Browser (เอ๋ visual-first) ─────────────────────────────────
// Decode a 13-char F2 code into its cube icon + a short English description.
// Logic only (the ICONS come from _f2CubeKit — reused, never redrawn). Positions
// (F2 scheme 2[TT][L][H][V]-WWWHHH): idx1-2 type, idx3 light, idx4 hand, idx5
// version, idx7-9 width×10, idx10-12 height×10.
const _F2_TYPE_LABEL = { FN:'straight', FC:'corner', BK:'back', SD:'side', UP:'top', DN:'bottom', CF:'cover front', CH:'cover horizontal', CV:'cover vertical' };
const _F2_HAND_LABEL = { L:'left', R:'right', D:'double' };
const _F2_PANELS = ['BK','SD','UP','DN','CF','CH','CV'];
function _decodeF2Code(code, kit) {
  if (!/^2[A-Z0-9]{5}-\d{6}$/.test(code)) return { valid: false };
  const K = kit || _f2CubeKit();
  const type = code.slice(1, 3), light = code[3], hand = code[4], version = code[5];
  const w = parseInt(code.slice(7, 10), 10) * 10, h = parseInt(code.slice(10, 13), 10) * 10;
  let icon;
  if (type === 'FN') icon = K.fnIcon;
  else if (type === 'FC') icon = K.fcIcon;
  else if (_F2_PANELS.includes(type)) icon = (sz) => K.cube(type, sz);
  else icon = (sz) => K.cube('F2', sz);
  const base = [_F2_TYPE_LABEL[type] || ('type ' + type)];
  if (hand && hand !== '0' && _F2_HAND_LABEL[hand]) base.push(_F2_HAND_LABEL[hand]);
  const size = w + '×' + h;
  const descNoLight = base.join(' · ') + ' · ' + size;   // light shown as a bulb glyph, not text
  const withLight = base.slice();
  if (light === 'L') withLight.push('light on'); else if (light === 'N') withLight.push('light off');
  return { valid: true, type, icon, light, hand, version, w, h, desc: withLight.join(' · ') + ' · ' + size, descNoLight };
}

// Card grid of REAL F2 configs (never fabricated — empty data → clearly-badged
// SAMPLE cards). Click a card → Fusion (.f2d if drawn, else 3D) via the shared
// router. Reuses the kdstock modal shell; styles inline (no style.css edit).
function _openConfigBrowser() {
  document.querySelectorAll('.cfgbrowse-modal').forEach(m => m.remove());
  const K = _f2CubeKit();
  const F2_RE = /^2[A-Z0-9]{5}-\d{6}$/;
  // Gather REAL F2 codes from data the web already has.
  const seen = new Set();
  const auto = (manifest && manifest.auto_generated) || {};
  Object.keys(auto).forEach(c => { if (F2_RE.test(c)) seen.add(c); });
  const projects = (manifest && manifest.projects) || {};
  for (const p of Object.values(projects)) for (const part of (p.parts || [])) { if (part && F2_RE.test(part.code)) seen.add(part.code); }
  let codes = [...seen].sort();
  const isSample = codes.length === 0;
  if (isSample) codes = ['2FNLL0-060072', '2FCND0-060060', '2CF0R0-060072'];
  // Group by the design KIND (idx1-2: BK/CF/CN/FN/…) — the useful mid-level
  // "family". (_remapFamilyForCode collapses every F2 code into one 'F2' bucket,
  // too coarse for browsing.)
  const groupOf = (code) => code.slice(1, 3);
  const groups = {};
  codes.forEach(c => { const g = groupOf(c); (groups[g] = groups[g] || []).push(c); });
  const groupKeys = Object.keys(groups).sort();

  const cardHtml = (code) => {
    const d = _decodeF2Code(code, K);
    const icon = d.valid ? d.icon(54) : K.cube('F2', 54);
    const desc = d.valid ? d.descNoLight : code;
    // Light status as a foreground bulb glyph over the cube (เอ๋ 2026-06-16) —
    // reuse the Light-legend bulbs from _f2CubeKit (never redrawn). Only cabinets
    // with a light slot (L/N) show one; light='0'/panels show nothing.
    const bulb = (d.valid && d.light === 'L') ? `<div class="cfg-card-bulb on" title="light on">${K.bulbOn}</div>`
               : (d.valid && d.light === 'N') ? `<div class="cfg-card-bulb off" title="light off">${K.bulbOff}</div>` : '';
    return `<div class="cfg-card${isSample ? ' is-sample' : ''}" data-code="${escapeHtml(code)}" title="${isSample ? 'Sample — not in the data' : 'Open in Fusion (.f2d if drawn, else 3D master)'}">
        <div class="cfg-card-icon">${icon}${bulb}</div>
        <div class="cfg-card-desc">${escapeHtml(desc)}</div>
        <div class="cfg-card-code">${escapeHtml(displayCodeFor(code))}</div>
        ${isSample ? '<div class="cfg-card-sample">SAMPLE</div>' : ''}
      </div>`;
  };
  const sections = groupKeys.map(g =>
    `<div class="cfg-section"><div class="cfg-section-head">${escapeHtml(g)}${_F2_TYPE_LABEL[g] ? ' · ' + _F2_TYPE_LABEL[g] : ''} <span class="cfg-section-n">${groups[g].length}</span></div>`
    + `<div class="cfg-grid">${groups[g].map(cardHtml).join('')}</div></div>`
  ).join('');
  const banner = isSample
    ? `<div class="cfg-banner">No real F2 configs in the data yet — showing samples (these won't open in Fusion).</div>`
    : `<div class="cfg-count">${codes.length} F2 config${codes.length === 1 ? '' : 's'} · ${groupKeys.length} group${groupKeys.length === 1 ? '' : 's'}</div>`;

  const STYLE = `<style>
    .cfgbrowse-modal .cfg-tools{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid #2a4a52;flex-wrap:wrap}
    .cfgbrowse-modal .cfg-search{flex:1 1 180px;min-width:140px;background:#0f1620;border:1px solid #2a3a44;border-radius:7px;padding:7px 11px;color:#e8edf2;font:500 13px ui-monospace,Menlo,monospace;outline:none}
    .cfgbrowse-modal .cfg-count{font-size:12px;color:#9fb0c0}
    .cfgbrowse-modal .cfg-banner{font-size:12px;color:#f2a93b}
    .cfgbrowse-modal .cfg-body{flex:1 1 auto;overflow-y:auto;padding:14px 16px 18px;background:#0f1419}
    .cfgbrowse-modal .cfg-section{margin-bottom:18px}
    .cfgbrowse-modal .cfg-section-head{font:600 13px ui-monospace,Menlo,monospace;color:#7fb0ff;margin-bottom:10px;display:flex;align-items:center;gap:8px}
    .cfgbrowse-modal .cfg-section-n{font-size:11px;color:#9fb0c0;background:#1b2430;border-radius:10px;padding:1px 8px}
    .cfgbrowse-modal .cfg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(124px,1fr));gap:10px}
    .cfgbrowse-modal .cfg-card{background:#1b2430;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px 10px 10px;display:flex;flex-direction:column;align-items:center;gap:7px;cursor:pointer;transition:border-color .12s,transform .12s,background .12s;position:relative}
    .cfgbrowse-modal .cfg-card:hover{border-color:#7fb0ff;background:#202a38;transform:translateY(-1px)}
    .cfgbrowse-modal .cfg-card.is-sample{cursor:default;opacity:.85}
    .cfgbrowse-modal .cfg-card.is-sample:hover{border-color:rgba(255,255,255,0.08);background:#1b2430;transform:none}
    .cfgbrowse-modal .cfg-card-icon{height:56px;display:flex;align-items:center;justify-content:center;position:relative}
    .cfgbrowse-modal .cfg-card-bulb{position:absolute;top:-3px;right:14px;display:flex;align-items:center;justify-content:center;transform:scale(1.4);transform-origin:center;pointer-events:none}
    .cfgbrowse-modal .cfg-card-bulb.on{filter:drop-shadow(0 0 4px rgba(242,169,59,0.9))}
    .cfgbrowse-modal .cfg-card-bulb.off{opacity:.8}
    .cfgbrowse-modal .cfg-card-desc{font-size:11px;line-height:1.35;color:#cdd6e0;text-align:center;min-height:30px}
    .cfgbrowse-modal .cfg-card-code{font:500 11px ui-monospace,Menlo,monospace;color:#8794a4;letter-spacing:.3px}
    .cfgbrowse-modal .cfg-card-sample{position:absolute;top:6px;right:6px;font:600 8px ui-monospace,monospace;color:#0f1419;background:#f2a93b;border-radius:4px;padding:1px 4px;letter-spacing:.5px}
    .cfgbrowse-modal .cfg-empty{color:#9fb0c0;text-align:center;padding:30px}
  </style>`;

  const modal = document.createElement('div');
  modal.className = 'kdstock-modal cfgbrowse-modal';
  modal.innerHTML = STYLE + '<div class="kdstock-backdrop"></div>'
    + `<div class="kdstock-frame" role="dialog" aria-label="Visual config browser" style="max-width:980px;width:94vw;max-height:90vh">
         <div class="kdstock-head">Visual config browser<button class="kdstock-close" aria-label="Close">✕</button></div>
         <div class="cfg-tools"><input class="cfg-search" type="text" placeholder="Search code…" autocomplete="off">${banner}</div>
         <div class="cfg-body">${sections || '<div class="cfg-empty">No F2 configs.</div>'}</div>
       </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('.kdstock-backdrop').addEventListener('click', close);
  modal.querySelector('.kdstock-close').addEventListener('click', close);

  const search = modal.querySelector('.cfg-search');
  search.addEventListener('input', () => {
    const q = search.value.trim().toUpperCase();
    modal.querySelectorAll('.cfg-card').forEach(c => { c.style.display = (!q || c.dataset.code.toUpperCase().includes(q)) ? '' : 'none'; });
    modal.querySelectorAll('.cfg-section').forEach(sec => { sec.style.display = [...sec.querySelectorAll('.cfg-card')].some(c => c.style.display !== 'none') ? '' : 'none'; });
  });
  try { search.focus(); } catch (e) {}

  if (!isSample) {
    modal.querySelectorAll('.cfg-card').forEach(card => {
      card.addEventListener('click', () => {
        const code = card.dataset.code;
        const eff = _effectiveDrawingCode(code);
        const entry = ((manifest && manifest.auto_generated) || {})[eff] || null;
        _routeLeafToFusion({ code, urn: _urnForCode(code), drawing_urn: entry ? (entry.drawing_urn || null) : null, status: 'stale' }, { fusionOnly: true });
      });
    });
  }
}

// ── 3D viewer (เอ๋ 2026-06-22) ──────────────────────────────────────────────
// Phase 1: a 🧊 icon on each Assembly mindmap cabinet → modal with Google
// <model-viewer> (orbit/zoom/touch, iPad-friendly) loading the part's GLB
// from the jsdelivr mirror of Drawings/3d/<code>.glb. 404 → placeholder
// ("3D not exported yet"). Phase 2 (Fusion lane) will produce the GLBs.
// A demo flag wires ONE sample GLB so the UX is testable BEFORE any real
// export — pass code 'DEMO' or click with no GLB available + ?demo3d=1.
const _KD3D_MV_CDN = 'https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js';
const _KD3D_DEMO_GLB = 'https://modelviewer.dev/shared-assets/models/Astronaut.glb';
// THREE.js as an ES module — model-viewer bundles its own copy under a private
// Symbol, but its classes are minified ($n, Ml, …) so we can't reach
// EdgesGeometry / LineSegments / LineDashedMaterial by name. Loading our own
// instance is fine: we only construct geometry/materials with it; the actual
// render walk is still done by model-viewer's renderer (it traverses the scene
// and renders any Object3D it finds, regardless of which THREE built it).
const _KD3D_THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.166.1/build/three.module.js';
// Workshop / aircraft-workshop HDRI from the modelviewer.dev shared assets —
// gives stainless cabinets warm, directional bounce light (vs the flat
// "neutral" preset). Used by Realistic mode.
const _KD3D_HDRI_REALISTIC = 'https://modelviewer.dev/shared-assets/environments/aircraft_workshop_01_1k.hdr';

function _kd3dGlbUrl(code) {
  const v = window.__KD_CACHE_V || Math.floor(Date.now() / 60000);
  return `https://cdn.jsdelivr.net/gh/wuttichaisaeton/kitchen-drawings-rd2026@main/Drawings/3d/${encodeURIComponent(code)}.glb?v=${v}`;
}
function _kd3dPartsGlbUrl(code) {
  const v = window.__KD_CACHE_V || Math.floor(Date.now() / 60000);
  return `https://cdn.jsdelivr.net/gh/wuttichaisaeton/kitchen-drawings-rd2026@main/Drawings/3d/${encodeURIComponent(code)}_parts.glb?v=${v}`;
}

// ── 🧊 outdated chip (WEB 21, 2026-06-22) ────────────────────────────────────
// Round 14 (Fusion 31, 2026-06-22) rewrote main `.glb` as per-leaf assembled
// (commit f555a1e landed 10:54 BKK = 03:54 UTC). Cabinets exported BEFORE
// the cutoff are still the old welded single-node file (web Mode 5 looks
// flat, Explode 0% can't separate leaves). The chip nudges เอ๋ to re-fire
// 🧊 in CC_Auto on that cabinet — the chip disappears the moment the new
// commit lands and the mtime probe refreshes.
//
// Mtime source: GitHub Commits API
// (`/repos/:owner/:repo/commits?path=Drawings/3d/<code>.glb&per_page=1`).
// GH Pages was the first try (one HEAD per file, CORS-open) but every file's
// Last-Modified comes back as the most recent SITE deploy time, not the
// file's own commit time → all GLBs look fresh forever. jsdelivr was the
// second try but its CDN strips Last-Modified on cache HITs. The Commits API
// returns the actual commit date (the timestamp we want to compare against
// the round cutoff) and is unauth-rate-limited to 60 req/hr — fine for a
// project view with ≤30 cabinets, especially with sessionStorage caching.
// On rate-limit (403) we cache `unknown` so the chip stays dormant rather
// than nagging incorrectly.
//
// Lazy — only probes a code on first ask, caches per-tab in sessionStorage
// so a project re-render doesn't refire N requests. On resolve, calls
// `_backgroundRender()` so the chip materialises without yanking เอ๋'s
// scroll / editor viewport.
//
// Cutoff: 11:00 ICT (= 04:00 UTC), 6 min after the r14 batch commit
// f555a1e landed at 03:54 UTC and 3 min before `adfa22e` "Update drawings
// 11:03". An earlier draft used 10:40 BKK / 03:40 UTC but เอ๋ bumped it
// to 11:00 ICT so cabinets exported in the first wave of r14 still get
// flagged if any drift since — re-fire 🧊 once more to clear them.
const KD3D_R14_CUTOFF_MS = Date.parse('2026-06-22T04:00:00Z');   // 11:00 ICT
const _KD3D_MTIME_LS_KEY = 'kd_glb3d_mtime_v3';                  // v3 = commits API (v1=jsdelivr, v2=ghpages — both broken for mtime)
const _KD3D_COMMITS_API = 'https://api.github.com/repos/wuttichaisaeton/kitchen-drawings-rd2026/commits';
let _kd3dMtimeCache = (() => {
  try { return JSON.parse(sessionStorage.getItem(_KD3D_MTIME_LS_KEY) || '{}') || {}; }
  catch { return {}; }
})();
const _kd3dMtimeProbing = new Set();
function _saveKd3dMtimeCache() {
  try { sessionStorage.setItem(_KD3D_MTIME_LS_KEY, JSON.stringify(_kd3dMtimeCache)); } catch {}
}
function _probeKd3dMtime(code) {
  if (!code || _kd3dMtimeProbing.has(code) || _kd3dMtimeCache[code]) return;
  _kd3dMtimeProbing.add(code);
  const path = 'Drawings/3d/' + code + '.glb';
  const url = `${_KD3D_COMMITS_API}?path=${encodeURIComponent(path)}&per_page=1`;
  fetch(url, { headers: { Accept: 'application/vnd.github+json' } })
    .then(r => r.ok ? r.json().then(j => ({ ok: true, j })) : { ok: false, status: r.status })
    .then(res => {
      if (!res.ok) {
        // 403 = rate-limited; 404 / 422 = unknown — never nag.
        _kd3dMtimeCache[code] = { unknown: true };
        return;
      }
      const top = Array.isArray(res.j) ? res.j[0] : null;
      const date = top && top.commit && top.commit.committer && top.commit.committer.date;
      if (!date) { _kd3dMtimeCache[code] = { missing: true }; return; }
      const ms = Date.parse(date);
      _kd3dMtimeCache[code] = isNaN(ms) ? { unknown: true } : { mtimeMs: ms };
    })
    .catch(() => { _kd3dMtimeCache[code] = { unknown: true }; })
    .finally(() => {
      _kd3dMtimeProbing.delete(code);
      _saveKd3dMtimeCache();
      try { _backgroundRender(); } catch {}
    });
}
// Tri-state: true (stale, .glb pre-cutoff), false (fresh), null (unknown —
// missing GLB, in-flight probe, or no Last-Modified header). Schedules a probe
// when the code is first asked about.
function _glb3dStale(code) {
  if (!code) return null;
  const ent = _kd3dMtimeCache[code];
  if (!ent) { _probeKd3dMtime(code); return null; }
  if (!ent.mtimeMs) return null;          // missing / unknown → don't nag
  return ent.mtimeMs < KD3D_R14_CUTOFF_MS;
}
function _glb3dStaleChip(code, opts) {
  if (_glb3dStale(code) !== true) return '';
  const cls = (opts && opts.clickable) ? 'sb-recheck sb-recheck-act' : 'sb-recheck';
  const data = (opts && opts.clickable) ? ` data-code="${escapeHtml(code)}" data-act="glb3d"` : '';
  const tip = `3D model (Drawings/3d/${code}.glb) was last exported before the ROUND 14 cutoff (2026-06-22 11:00 ICT / 04:00 UTC) — re-fire 🧊 Export 3D in Fusion (CC_Auto) on this cabinet to refresh it.`;
  return `<span class="${cls}"${data} title="${escapeHtml(tip)}">🧊 3D outdated</span>`;
}

let _kd3dThreePromise = null;
function _kd3dEnsureThree() {
  if (_kd3dThreePromise) return _kd3dThreePromise;
  _kd3dThreePromise = import(_KD3D_THREE_CDN).catch(err => {
    _kd3dThreePromise = null;
    throw err;
  });
  return _kd3dThreePromise;
}

let _kd3dMvPromise = null;
function _kd3dEnsureModelViewer() {
  if (window.customElements && window.customElements.get('model-viewer')) return Promise.resolve();
  if (_kd3dMvPromise) return _kd3dMvPromise;
  _kd3dMvPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.type = 'module';
    s.src = _KD3D_MV_CDN;
    s.onload = () => resolve();
    s.onerror = () => { _kd3dMvPromise = null; reject(new Error('Failed to load model-viewer')); };
    document.head.appendChild(s);
  });
  return _kd3dMvPromise;
}

// Quick HEAD probe — true if the GLB exists at the jsdelivr URL. jsdelivr
// answers 404 cleanly for missing files; we never fall back to GH Pages
// for misses (no point — Pages would also 404).
async function _kd3dGlbExists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return r.ok;
  } catch (e) { return false; }
}

// Open the 3D viewer modal for a part code. Reuses the .kdstock-modal /
// .kdstock-frame shell (3-theme safe, opaque). All extra styling inline so
// style.css isn't touched (WEB 15's lane). Closes on backdrop click, ✕, Esc.
async function _kdOpen3D(code, opts) {
  if (!code) return;
  // Replace any existing instance (one viewer at a time).
  document.querySelectorAll('.kd3d-modal').forEach(m => m.remove());
  // Part view (เอ๋ 2026-06-22 "3d part ยังไม่ load"): the part-row 🧊 passes
  // {cabinetCode} alongside the part code. The modal then loads the PARENT
  // cabinet's `<cabinetCode>_parts.glb` and filters the scene to show only
  // the matching mesh — Fusion doesn't write per-part GLBs, but the
  // _parts.glb already contains the part as one of its named leaves.
  const partView = !!(opts && opts.cabinetCode && opts.cabinetCode !== code);
  const cabinetCode = partView ? opts.cabinetCode : code;
  const partCode = partView ? code : null;
  // Project view (RD 07 2026-06-22): the project-page 🧊 opens a "Full Kitchen"
  // GLB written by CC_BatchExport3D at `Drawings/3d/<projectKey>.glb`. Just a
  // label flag — the GLB path is the same as a per-cabinet main GLB.
  const projectView = !!(opts && opts.asProject) && !partView;
  const display = (typeof displayCodeFor === 'function') ? displayCodeFor(code) : code;
  // Demo mode: a) ?demo3d=1 query flag forces the sample GLB; b) literal
  // code 'DEMO' shows it (used by the editor's hidden debug entry). Real
  // codes still go to the jsdelivr URL.
  const wantDemo = code === 'DEMO' || /[?&]demo3d=1\b/.test(location.search);
  const glbUrl = wantDemo
    ? _KD3D_DEMO_GLB
    : partView ? _kd3dPartsGlbUrl(cabinetCode) : _kd3dGlbUrl(code);

  const STYLE = `<style>
    .kd3d-modal .kd3d-body{padding:0;background:#0f1419;display:flex;flex-direction:column;min-height:0}
    .kd3d-modal .kd3d-viewer{flex:1 1 auto;width:100%;height:60vh;min-height:320px;background:#0b0f14;display:block;position:relative}
    .kd3d-modal model-viewer{width:100%;height:100%;background:#0b0f14;--poster-color:#0b0f14;transition:filter .15s ease}
    /* Hidden Line (เอ๋ "ทำเป็น Hidden line แบบเดิมดีกว่า" — revert from Outline):
       white SOLID visible-edge + dashed hidden-edge on a DARK background — the
       2e4f6bc CAD look. No CSS filter; THREE-side material + edges do the work. */
    .kd3d-modal model-viewer.kd3d-mode-hidden,
    .kd3d-modal model-viewer.kd3d-mode-hiddenshade{filter:none}
    /* Component Color (Fusion Shift+N) — light-grey bg so the per-leaf hues
       pop without harsh contrast and edges still read at 70% opacity. */
    .kd3d-modal model-viewer.kd3d-mode-compcolor{background:#f3f4f6;--poster-color:#f3f4f6;filter:none}
    /* Realistic + Explode: dark background like a viewer chrome, model-viewer's
       PBR + shadow does the rest. */
    .kd3d-modal model-viewer.kd3d-mode-realistic,
    .kd3d-modal model-viewer.kd3d-mode-explode{filter:none}
    /* Mode picker — 4 buttons across the top of the modal body (visible the
       moment the modal opens, even before the GLB loads). */
    .kd3d-modal .kd3d-modebar{display:flex;align-items:center;gap:2px;padding:6px 8px;background:#0b0f14;border-bottom:1px solid #1c2530;font-family:"Flux Architect",ui-monospace,monospace}
    .kd3d-modal .kd3d-modebar button{flex:1 1 0;background:transparent;border:1px solid transparent;color:#9fb0c0;font:inherit;font-size:11.5px;padding:6px 4px;border-radius:6px;cursor:pointer;letter-spacing:.2px;display:flex;align-items:center;justify-content:center;gap:5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .kd3d-modal .kd3d-modebar button .kd3d-mode-ico{font-size:13px}
    .kd3d-modal .kd3d-modebar button:hover{background:#0f1620;color:#e6edf4}
    .kd3d-modal .kd3d-modebar button.is-on{background:#1c2530;border-color:#2b3a4d;color:#e6edf4}
    .kd3d-modal .kd3d-explodebar{display:none;align-items:center;gap:10px;padding:6px 12px 8px;background:#0b0f14;border-bottom:1px solid #1c2530;font-family:"Flux Architect",ui-monospace,monospace;font-size:11px;color:#9fb0c0}
    .kd3d-modal.kd3d-modal-explode .kd3d-explodebar{display:flex}
    .kd3d-modal .kd3d-explodebar input[type=range]{flex:1 1 auto;min-width:0;accent-color:#f2a93b}
    .kd3d-modal .kd3d-explodebar .kd3d-explode-val{flex:0 0 36px;text-align:right;color:#e6edf4;font-weight:600}
    .kd3d-modal .kd3d-foot{padding:8px 14px;color:#9fb0c0;font-size:11px;font-family:ui-monospace,monospace;letter-spacing:.3px;border-top:1px solid #1c2530}
    .kd3d-modal .kd3d-placeholder{flex:1 1 auto;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:#9fb0c0;padding:48px 20px;text-align:center;font-family:"Flux Architect",ui-monospace,monospace}
    .kd3d-modal .kd3d-placeholder .kd3d-ph-icon{font-size:48px;opacity:.55}
    .kd3d-modal .kd3d-placeholder .kd3d-ph-title{font-size:15px;color:#e6edf4}
    .kd3d-modal .kd3d-placeholder .kd3d-ph-sub{font-size:12px;opacity:.7;max-width:380px;line-height:1.5}
    .kd3d-modal .kd3d-loading{flex:1 1 auto;display:flex;align-items:center;justify-content:center;color:#9fb0c0;font-family:"Flux Architect",ui-monospace,monospace;font-size:13px}
    /* FULLSCREEN sizing override (RD 07 2026-06-22: เอ๋ "full screen คือเต็มจอ
       ไม่ใช่ครึ่งจอ"). The inline width:94vw + max-height:88vh on the
       .kdstock-frame fight the browser's fullscreen layout — without these
       :fullscreen rules the element stays capped inside an otherwise-fullscreen
       viewport, producing big black bands. !important wins over the inline
       styles. position:fixed + top/left:0 forces the frame to actually fill
       the fullscreen surface even when some browsers don't enforce position
       on the fullscreen child (RD 07 diff). */
    .kd3d-modal .kdstock-frame:fullscreen,
    .kd3d-modal .kdstock-frame:-webkit-full-screen {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      max-width: none !important;
      max-height: none !important;
      margin: 0 !important;
      padding: 0 !important;
      border-radius: 0 !important;
      box-sizing: border-box !important;
      background: #0f1419 !important;
    }
    /* The body / viewer / model-viewer all need to stretch into the new
       full-viewport frame. The .kd3d-viewer's inline height:60vh hard-caps
       it in fullscreen — drop the cap; explicit 100%/100% on model-viewer. */
    .kd3d-modal .kdstock-frame:fullscreen .kd3d-body,
    .kd3d-modal .kdstock-frame:-webkit-full-screen .kd3d-body {
      flex: 1 1 auto !important;
      min-height: 0 !important;
    }
    .kd3d-modal .kdstock-frame:fullscreen .kd3d-viewer,
    .kd3d-modal .kdstock-frame:-webkit-full-screen .kd3d-viewer {
      height: auto !important;
      max-height: none !important;
      flex: 1 1 auto !important;
      min-height: 0 !important;
    }
    .kd3d-modal .kdstock-frame:fullscreen model-viewer,
    .kd3d-modal .kdstock-frame:-webkit-full-screen model-viewer {
      width: 100% !important;
      height: 100% !important;
    }
    .kd3d-modal .kdstock-frame:fullscreen .kd3d-modebar,
    .kd3d-modal .kdstock-frame:-webkit-full-screen .kd3d-modebar,
    .kd3d-modal .kdstock-frame:fullscreen .kd3d-explodebar,
    .kd3d-modal .kdstock-frame:-webkit-full-screen .kd3d-explodebar {
      width: 100% !important;
      box-sizing: border-box !important;
    }
    /* Close button in fullscreen — bigger, contrast circle, away from the
       iOS status bar (RD 07 + เอ๋ "ออกมาแล้วปุ่มปิดหน้าจอนี้ทำให้เห็นชัดเจน
       หน่อย"). Applies in both real + pseudo fullscreen. The header-row
       layout doesn't change in non-FS — only in FS does the close button
       break out to a floating circle. */
    .kd3d-modal .kdstock-frame:fullscreen .kdstock-close,
    .kd3d-modal .kdstock-frame:-webkit-full-screen .kdstock-close,
    .kd3d-modal.kd3d-pseudo-fs .kdstock-frame .kdstock-close {
      position: fixed !important;
      top: calc(env(safe-area-inset-top, 0px) + 14px) !important;
      right: calc(env(safe-area-inset-right, 0px) + 14px) !important;
      width: 52px !important;
      height: 52px !important;
      min-width: 52px !important;
      min-height: 52px !important;
      padding: 0 !important;
      margin: 0 !important;
      border: 1px solid #2b3340 !important;
      border-radius: 50% !important;
      background: rgba(15, 20, 25, 0.92) !important;
      color: #ffffff !important;
      font-size: 22px !important;
      font-weight: 700 !important;
      line-height: 1 !important;
      cursor: pointer !important;
      z-index: 2147483647 !important;
      box-shadow: 0 6px 22px rgba(0,0,0,0.5) !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      -webkit-tap-highlight-color: transparent;
    }
    /* The ⛶ fullscreen-toggle in the header is redundant in fullscreen
       (the floating close button + double-tap both exit). Hide it so the
       enlarged close has the top-right alone. */
    .kd3d-modal .kdstock-frame:fullscreen .kd3d-fs,
    .kd3d-modal .kdstock-frame:-webkit-full-screen .kd3d-fs,
    .kd3d-modal.kd3d-pseudo-fs .kdstock-frame .kd3d-fs {
      display: none !important;
    }
    /* PSEUDO-FULLSCREEN fallback (RD 07 2026-06-22) for browsers that don't
       support the Fullscreen API (notably iPhone Safari). Mirrors the
       :fullscreen rules but driven by a class toggle. Double-tap on the
       model-viewer activates this when requestFullscreen() rejects. */
    .kd3d-modal.kd3d-pseudo-fs .kdstock-frame {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      max-width: none !important;
      max-height: none !important;
      margin: 0 !important;
      padding: 0 !important;
      border-radius: 0 !important;
      box-sizing: border-box !important;
      background: #0f1419 !important;
      z-index: 2147483646 !important;
    }
    .kd3d-modal.kd3d-pseudo-fs .kdstock-frame .kd3d-body {
      flex: 1 1 auto !important;
      min-height: 0 !important;
    }
    .kd3d-modal.kd3d-pseudo-fs .kdstock-frame .kd3d-viewer {
      height: auto !important;
      max-height: none !important;
      flex: 1 1 auto !important;
      min-height: 0 !important;
    }
    .kd3d-modal.kd3d-pseudo-fs .kdstock-frame model-viewer {
      width: 100% !important;
      height: 100% !important;
    }
    .kd3d-modal.kd3d-pseudo-fs .kdstock-frame .kd3d-modebar,
    .kd3d-modal.kd3d-pseudo-fs .kdstock-frame .kd3d-explodebar {
      width: 100% !important;
      box-sizing: border-box !important;
    }
  </style>`;

  const modal = document.createElement('div');
  modal.className = 'kdstock-modal kd3d-modal';
  modal.innerHTML = STYLE
    + '<div class="kdstock-backdrop"></div>'
    + `<div class="kdstock-frame" role="dialog" aria-label="3D viewer" style="max-width:880px;width:94vw;max-height:88vh;display:flex;flex-direction:column">
         <div class="kdstock-head">${projectView ? `Project: ${escapeHtml(display)} — Full Kitchen 3D` : `${escapeHtml(display)}${wantDemo ? ' <span style="font-size:10px;color:#f2a93b;font-weight:700;margin-left:8px">DEMO</span>' : ''}${partView ? ` <span style="font-size:10px;color:#9fb0c0;font-weight:500;margin-left:6px;letter-spacing:.3px">in ${escapeHtml(cabinetCode)}</span>` : ''} — 3D view`}<span class="kd3d-dims" style="font-size:11px;color:#9fb0c0;font-weight:500;margin-left:10px;letter-spacing:.3px"></span><button class="kd3d-fs" aria-label="Fullscreen" title="Fullscreen (toggle)" style="background:transparent;border:0;color:#9fb0c0;font-size:14px;cursor:pointer;padding:4px 8px;margin-right:2px;border-radius:4px">⛶</button><button class="kdstock-close" aria-label="Close">✕</button></div>
         <div class="kd3d-body">
           <div class="kd3d-loading">Loading 3D model…</div>
         </div>
       </div>`;
  document.body.appendChild(modal);

  const close = () => { modal.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  modal.querySelector('.kdstock-backdrop').addEventListener('click', close);
  modal.querySelector('.kdstock-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  // Fullscreen button (เอ๋ 2026-06-22 "เพิ่ม โหมด Full Screen") — toggles the
  // browser Fullscreen API on the modal frame. Hide if unsupported.
  const fsBtn = modal.querySelector('.kd3d-fs');
  const fsTarget = modal.querySelector('.kdstock-frame');
  const canFs = !!(fsTarget && (fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen));
  if (!canFs && fsBtn) fsBtn.style.display = 'none';
  // Floating exit button (RD 07 2026-06-22 "เมื่อกดเข้า fullscreen ขอปุ่ม back")
  // — when in fullscreen the modal header sits inside the fullscreened
  // .kdstock-frame, but workers asked for a more discoverable always-on-top
  // back affordance. Render a fixed-position chip at top-right that only
  // shows when document.fullscreenElement is set.
  let fsExitBtn = null;
  if (canFs) {
    fsExitBtn = document.createElement('button');
    fsExitBtn.className = 'kd3d-fs-exit';
    fsExitBtn.setAttribute('aria-label', 'Exit fullscreen');
    fsExitBtn.title = 'Exit fullscreen';
    fsExitBtn.innerHTML = '🔙 Exit fullscreen';
    fsExitBtn.style.cssText = 'position:fixed;top:14px;right:14px;z-index:2147483647;display:none;background:rgba(15,20,25,0.92);color:#e6edf4;border:1px solid #2b3340;border-radius:8px;padding:8px 14px;font-family:"Flux Architect",ui-monospace,monospace;font-size:13px;letter-spacing:.3px;cursor:pointer;box-shadow:0 6px 22px rgba(0,0,0,0.5)';
    document.body.appendChild(fsExitBtn);
    fsExitBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {}
    });
  }
  // Unified fullscreen toggle (RD 07 2026-06-22 — เอ๋ "คลิ๊กบนพื้นที่ว่างคุณ
  // ก็เปิด full screen เดี๋ยวกว่า"). Tries the real Fullscreen API first; on
  // failure (iPhone Safari doesn't expose it) drops to a CSS pseudo state via
  // a class toggle on the modal. The two paths are interchangeable from the
  // user's perspective.
  const _isAnyFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement || modal.classList.contains('kd3d-pseudo-fs'));
  const _enterPseudo = () => {
    modal.classList.add('kd3d-pseudo-fs');
    if (fsExitBtn) fsExitBtn.style.display = 'inline-block';
    if (fsBtn) fsBtn.title = 'Exit fullscreen';
  };
  const _exitPseudo = () => {
    modal.classList.remove('kd3d-pseudo-fs');
    if (fsExitBtn) fsExitBtn.style.display = 'none';
    if (fsBtn) fsBtn.title = 'Fullscreen (toggle)';
  };
  const _toggleFs = async () => {
    if (_isAnyFs()) {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        try { await (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {}
      }
      _exitPseudo();
      return;
    }
    if (canFs && fsTarget) {
      try {
        await (fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen).call(fsTarget);
        return;   // fullscreenchange handler updates UI
      } catch (e) { /* fall through to pseudo */ }
    }
    _enterPseudo();
  };
  // De-bounce: dblclick + manual touch-end double-tap can both fire on the
  // same gesture in some browsers. Guard with a 350ms window.
  let _lastToggleAt = 0;
  const _guardedToggle = () => {
    const now = Date.now();
    if (now - _lastToggleAt < 350) return;
    _lastToggleAt = now;
    _toggleFs();
  };
  // ⛶ button shares the same toggle.
  if (fsBtn) {
    fsBtn.addEventListener('click', (ev) => { ev.stopPropagation(); _guardedToggle(); });
  }
  // Reflect REAL fullscreen state in the UI (the pseudo path updates its own UI).
  const _onFsChange = () => {
    const inRealFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (fsBtn) fsBtn.title = (inRealFs || modal.classList.contains('kd3d-pseudo-fs')) ? 'Exit fullscreen' : 'Fullscreen (toggle)';
    if (fsExitBtn) fsExitBtn.style.display = (inRealFs || modal.classList.contains('kd3d-pseudo-fs')) ? 'inline-block' : 'none';
  };
  document.addEventListener('fullscreenchange', _onFsChange);
  document.addEventListener('webkitfullscreenchange', _onFsChange);
  // Floating 🔙 exit also goes through the unified toggle (covers both real
  // FS exit and pseudo-FS removal — the original implementation only handled
  // real FS).
  if (fsExitBtn) {
    fsExitBtn.onclick = (ev) => { ev.stopPropagation(); _guardedToggle(); };
  }
  // Close handler must also remove the floating exit button when the modal closes.
  const _origClose = close;
  // (close already removes the modal; we just need to also remove fsExitBtn)
  // Replace by augmenting via a separate observer.
  const _cleanupFs = () => { if (fsExitBtn && fsExitBtn.parentNode) fsExitBtn.parentNode.removeChild(fsExitBtn); };
  try {
    const mo = new MutationObserver(() => { if (!document.contains(modal)) { mo.disconnect(); _cleanupFs(); } });
    mo.observe(document.body, { childList: true, subtree: false });
  } catch (e) {}

  const body = modal.querySelector('.kd3d-body');
  const showPlaceholder = (title, sub) => {
    body.innerHTML = `<div class="kd3d-placeholder">
      <div class="kd3d-ph-icon">🧊</div>
      <div class="kd3d-ph-title">${escapeHtml(title)}</div>
      <div class="kd3d-ph-sub">${escapeHtml(sub)}</div>
    </div>`;
  };

  // For DEMO mode skip the HEAD probe (modelviewer.dev sample is known-good).
  // For real codes: HEAD-check first so a missing GLB shows the placeholder
  // immediately instead of a model-viewer error blip.
  if (!wantDemo) {
    const exists = await _kd3dGlbExists(glbUrl);
    if (!exists) {
      if (partView) {
        showPlaceholder('Cabinet not exported yet',
          `No per-leaf GLB at Drawings/3d/${cabinetCode}_parts.glb. Run CC_Export3D on ${cabinetCode} in Fusion to enable part-level 3D, or 🧊 the cabinet header to see the assembled view.`);
      } else if (projectView) {
        showPlaceholder('Project not exported yet',
          `No whole-kitchen GLB at Drawings/3d/${code}.glb. Run CC_BatchExport3D for project "${code}" in Fusion to enable this view.`);
      } else {
        showPlaceholder('3D not exported yet',
          `No GLB found at Drawings/3d/${code}.glb. The Fusion lane will export it (Phase 2). Append ?demo3d=1 to the URL to preview the viewer with a sample model.`);
      }
      return;
    }
  }

  try {
    await _kd3dEnsureModelViewer();
  } catch (e) {
    showPlaceholder('Viewer unavailable', 'Could not load the 3D viewer library (network/CDN issue). Try again or check the connection.');
    return;
  }

  // FIVE view modes (เอ๋ 2026-06-22 "ให้คนประกอบเลือกเอง"):
  //   hidden      — True Hidden Line CAD: WHITE solid visible-edges + DASHED
  //                 hidden-edges on a dark background. Mesh fill suppressed via
  //                 material.colorWrite=false so only edges show (depth buffer
  //                 still drives the dashed-pass occlusion). 2e4f6bc style.
  //   hiddenshade — Same edge overlay treatment on top of a flat-shaded white
  //                 surface — keeps the CAD look but with surface depth.
  //   compcolor   — "Display Component Colors" (Fusion Shift+N): each per-leaf
  //                 node painted a distinct deterministic colour from a name
  //                 hash → golden-ratio hue → setHSL. DEFAULT.
  //   realistic   — Astronaut-demo treatment: env="neutral", shadow=1,
  //                 softness=0.5, exposure=1. Materials authored colours kept.
  //   explode     — Push each per-leaf node outward via slider 0-100%,
  //                 centroid-based for trimesh-baked GLBs.
  // BLACK semi-transparent visible-edge overlay (0.7 opacity) is present in
  // compcolor / realistic / explode (เอ๋ "realistic explode ให้เพิ่มเส้นเข้าไปด้วย");
  // Hidden Line modes swap to WHITE solid (1.0) + a DASHED hidden-edge pass.
  // Persist mode + last explode % per device (kd_3d_mode_v6 / kd_3d_explode_v1).
  // Migrates v5 (outline/outlineshade) + earlier keys transparently.
  const MODE_KEY = 'kd_3d_mode_v6';
  const EXPLODE_KEY = 'kd_3d_explode_v1';
  const VALID = ['hidden', 'hiddenshade', 'compcolor', 'realistic', 'explode'];
  let mode = (() => {
    try {
      const m = localStorage.getItem(MODE_KEY);
      if (VALID.includes(m)) return m;
      const v5 = localStorage.getItem('kd_3d_mode_v5');
      if (v5 === 'outline') return 'hidden';
      if (v5 === 'outlineshade') return 'hiddenshade';
      if (v5 && VALID.includes(v5)) return v5;
      const v4 = localStorage.getItem('kd_3d_mode_v4');
      if (v4 === 'outline') return 'hidden';
      if (v4 === 'outlineshade') return 'hiddenshade';
      if (v4 && VALID.includes(v4)) return v4;
      const v3 = localStorage.getItem('kd_3d_mode_v3');
      if (v3 && VALID.includes(v3)) return v3;
      const v2 = localStorage.getItem('kd_3d_mode_v2');
      if (v2 === 'lines') return 'hidden';
      if (v2 === 'linesshade') return 'hiddenshade';
      if (v2 === 'realistic' || v2 === 'explode') return v2;
      return 'compcolor';
    } catch { return 'compcolor'; }
  })();
  let explodePct = (() => {
    try { const v = parseInt(localStorage.getItem(EXPLODE_KEY) || '40', 10); return Math.max(0, Math.min(100, isNaN(v) ? 40 : v)); }
    catch { return 40; }
  })();

  const modeBtn = (id, ico, label, title) => `<button data-mode="${id}" class="${mode === id ? 'is-on' : ''}" title="${escapeHtml(title)}"><span class="kd3d-mode-ico">${ico}</span><span>${escapeHtml(label)}</span></button>`;
  // mv attrs for the INITIAL paint (so first-frame is correct even before load).
  // Per-mode attribute set is also re-applied in applyMode() on every switch.
  const initShadow = (mode === 'realistic') ? '1' : '0';
  const initSoft = (mode === 'realistic') ? '0.5' : '0.3';
  const initExp = (mode === 'realistic') ? '1' : (mode === 'explode' ? '1.1' : '1');
  const initTone = (mode === 'realistic' || mode === 'explode') ? 'aces' : 'neutral';
  const initEnv = 'neutral';   // built-in for all four modes (Astronaut-demo default)
  body.innerHTML = `<div class="kd3d-modebar">
        ${modeBtn('hidden', '📐', 'Hidden Line', 'CAD technical drawing: solid lines for visible edges + dashed lines for hidden edges. No fill.')}
        ${modeBtn('hiddenshade', '🎨', 'Hidden Line + Shade', 'Hidden-line overlay on top of a flat-shaded surface.')}
        ${modeBtn('compcolor', '🌈', 'Component Color', 'Fusion Shift+N look: each cabinet part painted a distinct deterministic colour for instant assembly read (default).')}
        ${modeBtn('realistic', '💎', 'Realistic', 'model-viewer Astronaut-demo treatment: neutral env IBL + soft shadow + exposure 1.')}
        ${modeBtn('explode', '💥', 'Explode', 'Spread each cabinet part outward by a percentage.')}
      </div>
      <div class="kd3d-explodebar">
        <span>Explode</span>
        <input type="range" min="0" max="100" step="1" value="${explodePct}" aria-label="Explode percentage">
        <span class="kd3d-explode-val">${explodePct}%</span>
        <span class="kd3d-explode-info" title="How many independent pieces this GLB has"></span>
      </div>
      <div class="kd3d-viewer">
        <model-viewer
          class="kd3d-mode-${mode}"
          src="${escapeHtml(glbUrl)}"
          orientation="0deg -90deg 0deg"
          touch-action="none"
          interaction-prompt="none"
          camera-orbit="20deg 70deg 105%"
          field-of-view="10deg"
          min-field-of-view="3deg"
          max-field-of-view="50deg"
          shadow-intensity="${initShadow}"
          shadow-softness="${initSoft}"
          exposure="${initExp}"
          tone-mapping="${initTone}"
          environment-image="${escapeHtml(initEnv)}"
          ar="false"
          reveal="auto"
        ></model-viewer>
      </div>
      <div class="kd3d-foot">Touch — 1 finger: orbit · 2 fingers: pinch + pan · Mouse — Left: orbit · Middle: pan · Wheel: zoom</div>`;
  const mv = body.querySelector('model-viewer');
  const modal2 = body.closest('.kd3d-modal');
  if (mode === 'explode') modal2 && modal2.classList.add('kd3d-modal-explode');
  // model-viewer's error event fires when src fails to load — swap to the
  // placeholder (covers the rare HEAD-200 but parse-fail case).
  mv && mv.addEventListener('error', () => {
    showPlaceholder('Failed to load 3D model', 'The GLB at Drawings/3d/' + code + '.glb returned an error during load (possibly a stale CDN cache or corrupt file).');
  });

  // ── Custom gesture handlers (เอ๋ 2026-06-22 "ทำให้ใช้ 2 นิ้ว หมุน และ zoom ได้") ─
  // model-viewer's default 1-finger=orbit conflicted with workshop iPads where
  // a casual touch would yank the camera mid-scroll. Now: 2 fingers do BOTH
  // pinch-zoom AND drag-rotate (DOLLY_ROTATE-style — one gesture for both),
  // 1 finger does nothing (page scrolls naturally), mouse drag = orbit, wheel
  // = zoom. Camera-controls is removed from the model-viewer attrs so its
  // built-in handlers don't conflict with these custom ones.
  if (mv) {
    // Rotate uses cameraOrbit (theta/phi); zoom uses field-of-view because
    // model-viewer's auto-bounds for `auto` radius lock the radius once the
    // narrow ortho-fake FOV is set. Narrower FOV = zoomed in, wider = zoomed
    // out, clamped to the 3°-50° bounds we already set on the element.
    const _setOrbit = (theta, phi) => {
      try { mv.cameraOrbit = `${theta}rad ${phi}rad auto`; } catch (e) {}
    };
    const _setFov = (fov) => {
      const next = Math.max(3, Math.min(50, fov));
      try { mv.fieldOfView = `${next}deg`; } catch (e) {}
    };
    // Constrained polar clamp — keeps the model upright (CAD convention,
    // เอ๋ "constrained orbit"): clamp φ to [15°, 165°] so the camera can
    // never look straight down or invert through the top/bottom poles.
    const PHI_MIN = 15 * Math.PI / 180;
    const PHI_MAX = (180 - 15) * Math.PI / 180;
    const clampPhi = (p) => Math.max(PHI_MIN, Math.min(PHI_MAX, p));

    // Camera right/up vectors in world space for the given orbit + the model-
    // viewer-canonical convention (Y-up). Used by 2-finger pan to translate
    // cameraTarget in screen space coordinates.
    const _camBasis = (theta, phi) => ({
      right: { x: Math.cos(theta), y: 0, z: -Math.sin(theta) },
      up: {
        x: -Math.sin(theta) * Math.cos(phi),
        y: Math.sin(phi),
        z: -Math.cos(theta) * Math.cos(phi),
      },
    });
    // Pixels-to-world scale: the visible vertical field is 2·dist·tan(fov/2).
    const _panScale = (orbit, fovDeg) => {
      const fov = fovDeg * Math.PI / 180;
      const fh = 2 * orbit.radius * Math.tan(fov / 2);
      return fh / Math.max(1, mv.clientHeight);
    };

    // Touch model (เอ๋ 2026-06-22 final):
    //   1 finger  = constrained ORBIT (polar clamped 15°-165° so no flip)
    //   2 fingers = pinch ZOOM + drag PAN (cameraTarget shifts on midpoint move)
    // Mouse drag = orbit; wheel = zoom (unchanged).
    let twoF = null;
    let oneOrbit = null;
    mv.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const t1 = e.touches[0], t2 = e.touches[1];
        const dx = t2.clientX - t1.clientX, dy = t2.clientY - t1.clientY;
        const orbit = mv.getCameraOrbit();
        const tgt = mv.getCameraTarget();
        twoF = {
          cx: (t1.clientX + t2.clientX) / 2,
          cy: (t1.clientY + t2.clientY) / 2,
          dist: Math.sqrt(dx * dx + dy * dy),
          fov: mv.getFieldOfView(),
          target: { x: tgt.x, y: tgt.y, z: tgt.z },
          scale: _panScale(orbit, mv.getFieldOfView()),
          basis: _camBasis(orbit.theta, orbit.phi),
        };
        oneOrbit = null;
      } else if (e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        const orbit = mv.getCameraOrbit();
        oneOrbit = { x: t.clientX, y: t.clientY, theta: orbit.theta, phi: orbit.phi };
        twoF = null;
      }
    }, { passive: false });
    mv.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && twoF) {
        e.preventDefault();
        const t1 = e.touches[0], t2 = e.touches[1];
        const dx = t2.clientX - t1.clientX, dy = t2.clientY - t1.clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const cx = (t1.clientX + t2.clientX) / 2, cy = (t1.clientY + t2.clientY) / 2;
        // PINCH → zoom via FOV (consistent with the ortho-fake design).
        const scale = dist / Math.max(20, twoF.dist);
        _setFov(twoF.fov / Math.max(0.2, scale));
        // MIDPOINT drag → pan cameraTarget. Drag right → target left so the
        // model appears to follow the fingers.
        const moveDX = cx - twoF.cx, moveDY = cy - twoF.cy;
        const s = twoF.scale;
        const { right, up } = twoF.basis;
        const T = twoF.target;
        const nx = T.x - moveDX * s * right.x + moveDY * s * up.x;
        const ny = T.y - moveDX * s * right.y + moveDY * s * up.y;
        const nz = T.z - moveDX * s * right.z + moveDY * s * up.z;
        try { mv.cameraTarget = `${nx}m ${ny}m ${nz}m`; } catch (e) {}
      } else if (e.touches.length === 1 && oneOrbit) {
        e.preventDefault();
        const t = e.touches[0];
        const ROT = 0.006;
        const newTheta = oneOrbit.theta - (t.clientX - oneOrbit.x) * ROT;
        const newPhi = clampPhi(oneOrbit.phi - (t.clientY - oneOrbit.y) * ROT);
        _setOrbit(newTheta, newPhi);
      }
    }, { passive: false });
    mv.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) twoF = null;
      if (e.touches.length === 0) oneOrbit = null;
    }, { passive: false });

    // Mouse — mirrors the touch semantics (เอ๋ 2026-06-22 "click ซ้ายเป็น
    // constrained orbit คลิ๊กปุ่มกลางคือ 2 นิ้ว"):
    //   LEFT (button 0)  drag = constrained orbit (= 1-finger touch)
    //   MIDDLE (button 1) drag = pan (= 2-finger drag pan)
    //   WHEEL = zoom (= 2-finger pinch)
    // Right click intentionally left to browser default.
    let mouseDrag = null;    // { mode: 'orbit'|'pan', ... }
    mv.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        const orbit = mv.getCameraOrbit();
        mouseDrag = { mode: 'orbit', x: e.clientX, y: e.clientY, theta: orbit.theta, phi: orbit.phi };
      } else if (e.button === 1) {
        // Stop the browser's middle-click auto-scroll start.
        e.preventDefault();
        const orbit = mv.getCameraOrbit();
        const tgt = mv.getCameraTarget();
        mouseDrag = {
          mode: 'pan', x: e.clientX, y: e.clientY,
          target: { x: tgt.x, y: tgt.y, z: tgt.z },
          scale: _panScale(orbit, mv.getFieldOfView()),
          basis: _camBasis(orbit.theta, orbit.phi),
        };
      }
    });
    const onMove = (e) => {
      if (!mouseDrag) return;
      if (mouseDrag.mode === 'orbit') {
        const ROT = 0.006;
        const newTheta = mouseDrag.theta - (e.clientX - mouseDrag.x) * ROT;
        const newPhi = clampPhi(mouseDrag.phi - (e.clientY - mouseDrag.y) * ROT);
        _setOrbit(newTheta, newPhi);
      } else if (mouseDrag.mode === 'pan') {
        const dx = e.clientX - mouseDrag.x, dy = e.clientY - mouseDrag.y;
        const s = mouseDrag.scale;
        const { right, up } = mouseDrag.basis;
        const T = mouseDrag.target;
        const nx = T.x - dx * s * right.x + dy * s * up.x;
        const ny = T.y - dx * s * right.y + dy * s * up.y;
        const nz = T.z - dx * s * right.z + dy * s * up.z;
        try { mv.cameraTarget = `${nx}m ${ny}m ${nz}m`; } catch (err) {}
      }
    };
    const onUp = () => { mouseDrag = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // Cleanup window listeners when the modal closes — modal removal kills mv
    // but the closures still hold refs. MutationObserver catches removal.
    const detach = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    try {
      const mo = new MutationObserver(() => {
        if (!document.contains(modal2)) { mo.disconnect(); detach(); }
      });
      mo.observe(document.body, { childList: true, subtree: false });
    } catch (e) {}

    mv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.12 : 0.89;
      _setFov(mv.getFieldOfView() * factor);
    }, { passive: false });

    // Double-tap / double-click toggles fullscreen (RD 07 2026-06-22 — "คลิ๊ก
    // บนพื้นที่ว่างคุณก็เปิด full screen เดี๋ยวกว่า"). dblclick covers desktop
    // mouse + most modern touch browsers; iOS Safari's quirky tap delay also
    // gets a manual touchend-timing fallback (350ms window). Both share the
    // 350ms debounced _guardedToggle so the same gesture can't fire twice.
    mv.addEventListener('dblclick', (e) => { e.preventDefault(); _guardedToggle(); });
    let _lastTapEnd = 0;
    mv.addEventListener('touchend', (e) => {
      // Only act on a clean single-finger lift (no fingers left on screen).
      if (e.touches.length !== 0 || e.changedTouches.length !== 1) return;
      const now = Date.now();
      const dt = now - _lastTapEnd;
      // 30ms < dt < 320ms = double-tap window (avoid rapid spurious events,
      // and slightly tighter than 350ms guard so manual + dblclick don't race).
      if (dt > 30 && dt < 320) { _lastTapEnd = 0; _guardedToggle(); }
      else { _lastTapEnd = now; }
    });
  }

  // ── THREE.js scene access + per-mesh edge overlays ──────────────────────
  // model-viewer keeps its real THREE.Scene on a private Symbol-keyed prop.
  // The wrapper API (mv.model.materials) only exposes PBR — not wireframe, not
  // node positions, not arbitrary geometry — so for hidden-line overlays + true
  // centroid-based explode we MUST go through the THREE side.
  let threeScene = null;          // THREE.Scene (mv[Symbol(scene)])
  let materialSnap = [];          // [{mat, color, metalness, roughness, wireframe, colorWrite}]
  let meshOrigMat = [];           // [{mesh, mat: orig material(or array)}] — used to restore shared-mat refs after compcolor cloning
  let explodeRoot = null;         // THREE.Object3D whose children are explode units
  let explodeUnits = [];          // [{node, baseX/Y/Z (node.position), gx/y/z (geom centroid in node-local space)}]
  let explodeCenter = { x: 0, y: 0, z: 0 };   // mean of gx/y/z across units
  let edgeOverlays = [];          // [{mesh, lineVis, lineHid}] — per-mesh LineSegments overlays
  // Dual-GLB switcher state (Fusion 31 2026-06-22). The MAIN .glb is assembled
  // (1 node, fits Hidden Line / Realistic). The `_parts.glb` is per-leaf
  // (multi-node, fits Component Color / Explode). The web probes for _parts on
  // first need; falls back to main on 404 for legacy cabinets.
  let partsExistsKnown = wantDemo ? false : (partView ? true : null);
  // Initial camera-fit guard for the outlier-filter mitigation (RD 07 2026-06-22):
  // 1CSVB2's _parts.glb has 5-6 orphan leaves at the world origin from a Fusion
  // deep-nested-occurrence export bug. The fit-to-cluster runs once per modal
  // open so the user's manual pan/zoom isn't reset on subsequent mode swaps.
  let _initialFitDone = false;
  let _orphanCount = 0;
  let partsProbePromise = null;
  let currentLoadedSrc = null;    // last URL model-viewer fetched; gates dim-recompute
  let dimsCached = false;         // dims read from MAIN .glb only — never from _parts (scattered bbox is wrong)
  // REVERTED 2026-06-22 (RD 07 + เอ๋ "ให้กลับไปตอนนั้น"): the dual-export
  // swap (504e84b) routed Component Color + Explode to `<code>_parts.glb`,
  // but the round-11+ Fusion export has scattered/orphan node transforms
  // that destroy the assembled look. Empty set = every mode now stays on
  // the main `.glb` (state 856dc31 — verified 54/59 distinct colors in
  // Component Color, slider=0 = assembled, slider>0 = spread). Part view
  // and Project view still bypass this via opts.cabinetCode / opts.asProject
  // straight through `_wantSrcFor`.
  const PARTS_MODES = new Set();
  const _wantSrcFor = (m) => {
    if (wantDemo) return _KD3D_DEMO_GLB;
    // Part view ALWAYS uses the cabinet's _parts.glb (need per-leaf nodes to
    // filter by part code; the main .glb has only 1 collapsed node).
    if (partView) return _kd3dPartsGlbUrl(cabinetCode);
    if (PARTS_MODES.has(m) && partsExistsKnown === true) return _kd3dPartsGlbUrl(code);
    return _kd3dGlbUrl(code);
  };
  const _maybeProbeParts = async () => {
    if (wantDemo || partsExistsKnown !== null) return partsExistsKnown;
    if (partsProbePromise) return partsProbePromise;
    partsProbePromise = _kd3dGlbExists(_kd3dPartsGlbUrl(code)).then(ok => {
      partsExistsKnown = !!ok;
      return ok;
    });
    return partsProbePromise;
  };

  const _getScene = () => {
    if (!mv) return null;
    try {
      const sym = Object.getOwnPropertySymbols(mv).find(s => s.toString() === 'Symbol(scene)');
      return sym ? mv[sym] : null;
    } catch (e) { return null; }
  };

  // Compute the geometric centroid (bbox midpoint) of a node's mesh subtree
  // *in the node's local space* — i.e. exactly what we need to add to its
  // position to shift it outward. Critical for trimesh-baked GLBs where every
  // node sits at position (0,0,0) but the geometry has real world coords.
  const _localCentroid = (node) => {
    let mnX=Infinity,mnY=Infinity,mnZ=Infinity, mxX=-Infinity,mxY=-Infinity,mxZ=-Infinity;
    let count = 0;
    node.traverse(n => {
      if (!n.isMesh || !n.geometry || !n.geometry.attributes || !n.geometry.attributes.position) return;
      if (!n.geometry.boundingBox) try { n.geometry.computeBoundingBox(); } catch (e) {}
      const bb = n.geometry.boundingBox;
      if (!bb) return;
      count++;
      if (bb.min.x < mnX) mnX = bb.min.x; if (bb.min.y < mnY) mnY = bb.min.y; if (bb.min.z < mnZ) mnZ = bb.min.z;
      if (bb.max.x > mxX) mxX = bb.max.x; if (bb.max.y > mxY) mxY = bb.max.y; if (bb.max.z > mxZ) mxZ = bb.max.z;
    });
    if (!count) return null;
    return { x: (mnX + mxX) / 2, y: (mnY + mxY) / 2, z: (mnZ + mxZ) / 2 };
  };

  const snapshotScene = () => {
    threeScene = _getScene();
    if (!threeScene) return false;
    // Materials — snapshot so 'realistic' restores the GLB's authored look exactly.
    // Also remember each MESH's original material reference so compcolor (which
    // clones per mesh to break shared-material colour collisions) can restore.
    materialSnap = []; meshOrigMat = [];
    threeScene.traverse(n => {
      if (n.isMesh && n.material) {
        meshOrigMat.push({ mesh: n, mat: Array.isArray(n.material) ? n.material.slice() : n.material });
        const mats = Array.isArray(n.material) ? n.material : [n.material];
        for (const m of mats) {
          materialSnap.push({
            mat: m,
            color: m.color && m.color.clone ? m.color.clone() : null,
            metalness: (typeof m.metalness === 'number') ? m.metalness : null,
            roughness: (typeof m.roughness === 'number') ? m.roughness : null,
            wireframe: !!m.wireframe,
            colorWrite: m.colorWrite !== false,
          });
        }
      }
    });
    // Explode root: pick the candidate with the MOST direct children among nodes
    // whose subtree contains ≥ 2 meshes — that's the natural "list of parts".
    // (Earlier deepest-ancestor heuristic missed the right node in real GLBs
    // where 'world' at depth 4 had 57 children but a deeper 'Target' at depth 2
    // tied on depth-test but only had 2 kids.)
    let best = null, bestKids = 0;
    threeScene.traverse(n => {
      if (!n.children || n.children.length < 2) return;
      let m = 0;
      n.traverse(d => { if (d.isMesh) m++; });
      if (m < 2) return;
      if (n.children.length > bestKids) { best = n; bestKids = n.children.length; }
    });
    // Fallback: if no node has ≥ 2 children with mesh content, treat individual
    // meshes as units (each mesh is an explode unit; their parent becomes root).
    if (!best) {
      const meshes = [];
      threeScene.traverse(n => { if (n.isMesh) meshes.push(n); });
      if (meshes.length >= 2) {
        // Use the first mesh's parent as the root and translate per-mesh.
        best = meshes[0].parent || threeScene;
      }
    }
    explodeRoot = best;
    explodeUnits = [];
    if (explodeRoot) {
      for (const ch of explodeRoot.children) {
        const ctr = _localCentroid(ch);
        if (!ctr) continue;
        explodeUnits.push({
          node: ch,
          baseX: ch.position.x, baseY: ch.position.y, baseZ: ch.position.z,
          gx: ctr.x, gy: ctr.y, gz: ctr.z,
        });
      }
      let sx = 0, sy = 0, sz = 0;
      for (const u of explodeUnits) { sx += u.gx; sy += u.gy; sz += u.gz; }
      const n = explodeUnits.length || 1;
      explodeCenter = { x: sx / n, y: sy / n, z: sz / n };
    }
    // Count meshes via a fresh deep traverse — the diagnostic chip must
    // distinguish "GLB has only 1 mesh" (Fusion issue) from "GLB has many
    // meshes but the explode walk found 0 units" (web bug). RD 07 hit the
    // false-positive on 1CSVBL-120000 (85 meshes, web reported "0 piece —
    // single-mesh GLB"). Diagnostic console line surfaces every relevant
    // count so a future report has actionable data immediately.
    let deepMeshCount = 0;
    const sampleNames = [];
    threeScene.traverse(n => {
      if (n.isMesh) {
        deepMeshCount++;
        if (sampleNames.length < 6) sampleNames.push({ name: n.name, parent: n.parent?.name });
      }
    });
    console.info(`[kd3d snapshotScene] deepMeshCount=${deepMeshCount} materialSnap=${materialSnap.length} explodeRoot=${explodeRoot?.name || '(unnamed)'} explodeRootChildren=${explodeRoot?.children?.length || 0} explodeUnits=${explodeUnits.length}`, sampleNames);

    // Hide Fusion-imported axis/origin construction lines (RD 07 + เอ๋
    // "ปรับแกน Z ของ Fusion ให้เหมือนแกน Z ของคุณ"). The "red diagonal Z" เอ๋
    // sees is a Fusion construction axis exported as a LineSegments/Line/Mesh
    // in the GLB. Match by name (axis-like keywords) and toggle visibility off.
    // My own EdgesGeometry overlays are children of meshes (not the scene root)
    // and have empty names, so they're not affected. Skip true meshes — only
    // hide helpers / decorative lines matched by name.
    const AXIS_NAME_RE = /(^|_| )(axis|axes|origin|construction|coord|datum|gizmo|helper|world_?[xyz])([_ ]|$)/i;
    let axisHits = 0;
    const axisSample = [];
    threeScene.traverse(n => {
      if (n.isMesh) return;
      if (!n.name) return;
      if (AXIS_NAME_RE.test(n.name)) {
        n.visible = false;
        axisHits++;
        if (axisSample.length < 4) axisSample.push({ type: n.type, name: n.name });
      }
    });
    if (axisHits > 0) {
      console.info(`[kd3d snapshotScene] hid ${axisHits} Fusion axis/construction node(s)`, axisSample);
    }
    // Also log a sample of NAMED non-mesh objects so RD/เอ๋ can see what
    // axis-like things are in the scene if the filter above doesn't catch
    // the offender (Fusion might use a name pattern we don't know yet).
    const nonMeshSample = [];
    threeScene.traverse(n => {
      if (n.isMesh) return;
      if (!n.name) return;
      if (nonMeshSample.length < 8) nonMeshSample.push({ type: n.type, name: n.name, visible: n.visible });
    });
    if (nonMeshSample.length) {
      console.info('[kd3d snapshotScene] named non-mesh sample:', nonMeshSample);
    }

    const info = body.querySelector('.kd3d-explode-info');
    if (info) {
      if (explodeUnits.length >= 2) {
        info.textContent = `· ${explodeUnits.length} pieces`;
      } else if (deepMeshCount >= 2) {
        // Mesh count says multi-leaf but explode walk failed — web bug.
        info.textContent = `· ${deepMeshCount} meshes — explode walk found 0 units (check console)`;
      } else {
        info.textContent = `· ${explodeUnits.length} piece (single-mesh GLB — needs per-leaf export)`;
      }
    }

    // PART VIEW filter (เอ๋ "3d part ยังไม่ load"): hide every mesh in the
    // cabinet's _parts.glb except the one(s) whose name matches the part
    // code. Exact-name match first (Fusion's per-leaf node names usually ARE
    // the part code), substring fallback. Recompute dims from visible only.
    if (partView && partCode) {
      let exactMatches = 0, substringMatches = 0, totalMeshes = 0;
      const sampleNames = [];
      threeScene.traverse(n => {
        if (!n.isMesh) return;
        totalMeshes++;
        if (sampleNames.length < 6) sampleNames.push(n.name);
        if (n.name === partCode) exactMatches++;
        else if (n.name && n.name.includes(partCode)) substringMatches++;
      });
      const useSubstring = exactMatches === 0 && substringMatches > 0;
      let kept = 0;
      threeScene.traverse(n => {
        if (!n.isMesh) return;
        const hit = useSubstring
          ? (n.name && n.name.includes(partCode))
          : (n.name === partCode);
        n.visible = !!hit;
        if (hit) kept++;
      });
      // RD 07 diagnostic — surface the match counts to the console so anyone
      // debugging "part 🧊 not loading" can see immediately whether the
      // cabinetCode arrived, the names look right, and how many matched.
      console.info(`[kd3d part-row] cab=${cabinetCode} part=${partCode} matched=${kept}/${totalMeshes} (exact=${exactMatches}, substring=${substringMatches}, mode=${useSubstring ? 'substring' : 'exact'}) sample=`, sampleNames);
      if (kept === 0) {
        showPlaceholder('Part not in cabinet GLB',
          `No node named "${partCode}" inside ${cabinetCode}_parts.glb (${totalMeshes} meshes total). Fusion may have used a different name — re-export the cabinet, or 🧊 the cabinet header to see the assembled view.`);
        return false;
      }
    }

    // Overall W × H × D (เอ๋ 2026-06-22 "เพิ่มการบอกขนาดรวมด้วย"). Fusion
    // designs ship in mm; STL → trimesh → GLB preserves units, and node
    // transforms are baked into vertex coords so a plain geometry bbox sweep
    // is already in world space. Round to nearest mm. Cached for the modal —
    // doesn't recompute on mode-switch.
    let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
    let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
    threeScene.traverse(n => {
      if (!n.isMesh || !n.geometry || !n.geometry.attributes || !n.geometry.attributes.position) return;
      // In part view, count only the visible mesh(es) so dims describe the
      // selected part, not the whole cabinet's _parts scatter.
      if (partView && !n.visible) return;
      if (!n.geometry.boundingBox) try { n.geometry.computeBoundingBox(); } catch (e) {}
      const bb = n.geometry.boundingBox;
      if (!bb) return;
      if (bb.min.x < mnX) mnX = bb.min.x; if (bb.min.y < mnY) mnY = bb.min.y; if (bb.min.z < mnZ) mnZ = bb.min.z;
      if (bb.max.x > mxX) mxX = bb.max.x; if (bb.max.y > mxY) mxY = bb.max.y; if (bb.max.z > mxZ) mxZ = bb.max.z;
    });
    const dimsEl = modal2 && modal2.querySelector('.kd3d-dims');
    // Dims must come from the ASSEMBLED .glb only — a `_parts.glb` scatter
    // gives wrong overall extents. Skip the recompute on parts loads + skip
    // re-computing once cached. Exception: in PART view we DO want dims from
    // _parts.glb because we already filtered to a single mesh (so its bbox is
    // the part's real bbox, not the scattered cabinet).
    const isPartsLoad = !!currentLoadedSrc && /_parts\.glb(\?|$)/.test(currentLoadedSrc);
    if (dimsEl && !dimsCached && (!isPartsLoad || partView) && mnX < Infinity) {
      // Axis mapping: Fusion exports Z-up (STL → trimesh → GLB), so the GLB's
      // axes are X=width, Y=depth, Z=height. (เอ๋ caught the swap 2026-06-22:
      // "บอกระยะผิด ต้อง w 1050 d 611 h 891" on 1CSVB2 = 1050×611×891 cabinet.)
      // Unit autodetect: Fusion ships mm directly, but glTF's default unit is
      // METERS (Astronaut DEMO et al.) — if the largest extent is < 10, ×1000.
      let W = mxX - mnX, D = mxY - mnY, H = mxZ - mnZ;
      const scale = Math.max(W, D, H) < 10 ? 1000 : 1;
      W = Math.round(W * scale); D = Math.round(D * scale); H = Math.round(H * scale);
      dimsEl.textContent = `· W ${W} · D ${D} · H ${H} mm`;
      dimsCached = true;
    }

    // ── Outlier filter (RD 07 2026-06-22) ───────────────────────────────────
    // Fusion 31's _parts.glb sometimes ships a few orphan leaf nodes parked at
    // (0,0,0) instead of their assembled world transform (deep-nested
    // occurrence bug). Those outliers blow up the auto-framing bbox so the
    // main cluster looks tiny. Workaround: per-mesh centroids → median
    // distance → meshes >3× median = orphan → camera fits the NON-orphan
    // cluster. Orphans stay VISIBLE (so เอ๋ can see they exist) but don't
    // drag the camera framing.
    // Only runs on multi-leaf scenes (at least 4 meshes) so the main GLB
    // (1-leaf assembled) and part view (filtered to 1 part) aren't affected.
    if (!partView && !_initialFitDone) {
      const meshList = [];
      threeScene.traverse(n => {
        if (!n.isMesh || !n.visible) return;
        if (!n.geometry || !n.geometry.boundingBox) return;
        const bb = n.geometry.boundingBox;
        meshList.push({
          mesh: n,
          cx: (bb.min.x + bb.max.x) / 2,
          cy: (bb.min.y + bb.max.y) / 2,
          cz: (bb.min.z + bb.max.z) / 2,
          bb,
        });
      });
      if (meshList.length >= 4) {
        let sx = 0, sy = 0, sz = 0;
        for (const m of meshList) { sx += m.cx; sy += m.cy; sz += m.cz; }
        const k = meshList.length;
        const sceneCx = sx / k, sceneCy = sy / k, sceneCz = sz / k;
        const dists = meshList.map(m => {
          const dx = m.cx - sceneCx, dy = m.cy - sceneCy, dz = m.cz - sceneCz;
          return Math.sqrt(dx * dx + dy * dy + dz * dz);
        });
        const sorted = [...dists].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] || 0;
        _orphanCount = 0;
        let cnX = Infinity, cnY = Infinity, cnZ = Infinity;
        let cxX = -Infinity, cxY = -Infinity, cxZ = -Infinity;
        let cSumX = 0, cSumY = 0, cSumZ = 0, cN = 0;
        for (let i = 0; i < meshList.length; i++) {
          const isOrphan = median > 0 && dists[i] > 3 * median;
          meshList[i].mesh.userData.isOrphan = isOrphan;
          if (isOrphan) { _orphanCount++; continue; }
          const bb = meshList[i].bb;
          if (bb.min.x < cnX) cnX = bb.min.x; if (bb.min.y < cnY) cnY = bb.min.y; if (bb.min.z < cnZ) cnZ = bb.min.z;
          if (bb.max.x > cxX) cxX = bb.max.x; if (bb.max.y > cxY) cxY = bb.max.y; if (bb.max.z > cxZ) cxZ = bb.max.z;
          cSumX += meshList[i].cx; cSumY += meshList[i].cy; cSumZ += meshList[i].cz; cN++;
        }
        const _reframeTo = (tcx, tcy, tcz, maxExt, reason) => {
          try {
            mv.cameraTarget = `${tcx}m ${tcy}m ${tcz}m`;
            const fovRad = mv.getFieldOfView() * Math.PI / 180;
            const radius = Math.max(0.1, (maxExt / 2) / Math.tan(fovRad / 2) * 1.35);
            const orbit = mv.getCameraOrbit();
            mv.cameraOrbit = `${orbit.theta}rad ${orbit.phi}rad ${radius}m`;
            console.info(`[kd3d] ${reason}`);
          } catch (e) { console.warn('[kd3d] camera-fit failed', e); }
        };
        if (_orphanCount > 0 && cN > 0) {
          const tcx = cSumX / cN, tcy = cSumY / cN, tcz = cSumZ / cN;
          const maxExt = Math.max(cxX - cnX, cxY - cnY, cxZ - cnZ);
          _reframeTo(tcx, tcy, tcz, maxExt,
            `outlier filter: ${_orphanCount}/${meshList.length} orphan(s) — camera fit to cluster`);
        } else if (_orphanCount === 0 && meshList.length >= 8) {
          const P85_IDX = Math.floor(sorted.length * 0.85) - 1;
          const pThresh = sorted[Math.max(0, P85_IDX)];
          let pnX = Infinity, pnY = Infinity, pnZ = Infinity;
          let pxX = -Infinity, pxY = -Infinity, pxZ = -Infinity;
          let pSumX = 0, pSumY = 0, pSumZ = 0, pN = 0;
          for (let i = 0; i < meshList.length; i++) {
            if (dists[i] <= pThresh) {
              const pbb = meshList[i].bb;
              if (pbb.min.x < pnX) pnX = pbb.min.x; if (pbb.min.y < pnY) pnY = pbb.min.y; if (pbb.min.z < pnZ) pnZ = pbb.min.z;
              if (pbb.max.x > pxX) pxX = pbb.max.x; if (pbb.max.y > pxY) pxY = pbb.max.y; if (pbb.max.z > pxZ) pxZ = pbb.max.z;
              pSumX += meshList[i].cx; pSumY += meshList[i].cy; pSumZ += meshList[i].cz; pN++;
            }
          }
          if (pN > 0) {
            const fullMax = Math.max(cxX - cnX, cxY - cnY, cxZ - cnZ);
            const innerMax = Math.max(pxX - pnX, pxY - pnY, pxZ - pnZ);
            if (innerMax > 0 && innerMax < 0.75 * fullMax) {
              _reframeTo(pSumX / pN, pSumY / pN, pSumZ / pN, innerMax,
                `percentile fit: inner 85% bbox ${Math.round(innerMax)}mm vs full ${Math.round(fullMax)}mm — camera tightened`);
            }
          }
        }
        // One-shot per modal session (don't snap camera on every mode swap).
        _initialFitDone = true;
        // Optional debug chip — surface the orphan count on the explode bar
        // (reuses the existing slot so workers see it in mode 5).
        const info = body.querySelector('.kd3d-explode-info');
        if (info && _orphanCount > 0) {
          const existing = info.textContent || '';
          if (!existing.includes('orphan')) {
            info.textContent = `${existing} · ⚠ ${_orphanCount} orphan${_orphanCount === 1 ? '' : 's'}`;
          }
        }
      }
    }
    return true;
  };

  // Build EdgesGeometry overlays. Each mesh gets TWO LineSegments children:
  // a solid visible-edge (always drawn where in front via depthTest) and a
  // dashed hidden-edge (drawn only where occluded via depthFunc=GreaterDepth
  // — used only in Hidden Line modes). Both are transparent so opacity flips
  // per mode. Children inherit parent transforms → explode translations
  // automatically carry edges with them.
  let _edgesAttempted = false;
  const buildEdgeOverlays = async () => {
    if (_edgesAttempted) return;
    _edgesAttempted = true;
    if (!threeScene) return;
    let THREE;
    try { THREE = await _kd3dEnsureThree(); }
    catch (e) { console.warn('[kd3d] THREE module failed to load — edges disabled', e); return; }
    edgeOverlays = [];
    threeScene.traverse(n => {
      if (!n.isMesh || !n.geometry || !n.geometry.attributes || !n.geometry.attributes.position) return;
      let underWorld = false;
      for (let p = n.parent; p; p = p.parent) { if (p.name === 'world') { underWorld = true; break; } }
      if (!underWorld) return;
      try {
        const eg = new THREE.EdgesGeometry(n.geometry, 22);
        const matVis = new THREE.LineBasicMaterial({
          color: 0x111317,
          transparent: true, opacity: 1.0,
          depthTest: true, depthWrite: false,
        });
        const lineVis = new THREE.LineSegments(eg, matVis);
        lineVis.renderOrder = 2;
        lineVis.visible = false;
        n.add(lineVis);
        // Dashed hidden-edge pass (Hidden Line modes only) — depthFunc=Greater
        // draws ONLY where line is behind existing depth, i.e. occluded.
        const matHid = new THREE.LineDashedMaterial({
          color: 0xc8d4e0, dashSize: 6, gapSize: 4,
          transparent: true, opacity: 0.55,
          depthTest: true, depthWrite: false,
        });
        matHid.depthFunc = THREE.GreaterDepth || 4;
        const lineHid = new THREE.LineSegments(eg, matHid);
        lineHid.renderOrder = 1;
        lineHid.computeLineDistances && lineHid.computeLineDistances();
        lineHid.visible = false;
        n.add(lineHid);
        edgeOverlays.push({ mesh: n, lineVis, lineHid });
      } catch (e) {}
    });
  };

  // Per-mode visual config of the edge overlays. `solidColor` flips the solid
  // pass between white (Hidden Line modes — reads on dark bg) and dark
  // (everywhere else — reads on light/colour bg). `dashed` toggles the
  // hidden-edge pass on Hidden Line modes only.
  const setEdgesStyle = (style) => {
    const solidColor = style.solidColor != null ? style.solidColor : 0x111317;
    const solidOpacity = style.solidOpacity != null ? style.solidOpacity : 0.7;
    const showDashed = !!style.showDashed;
    for (const o of edgeOverlays) {
      const m = o.lineVis.material;
      if (m) {
        if (m.color && m.color.setHex) m.color.setHex(solidColor);
        m.opacity = solidOpacity;
        m.needsUpdate = true;
      }
      o.lineVis.visible = true;
      if (o.lineHid) o.lineHid.visible = showDashed;
    }
  };
  const setEdgesAllHidden = () => {
    for (const o of edgeOverlays) {
      o.lineVis.visible = false;
      if (o.lineHid) o.lineHid.visible = false;
    }
  };

  // material.colorWrite=false lets the mesh write to depth but draw nothing
  // visible — what Hidden Line mode wants (so the dashed-hidden pass can detect
  // occlusion while the surface itself is invisible). Hidden+Shade keeps fill on.
  const setMeshFillVisible = (show) => {
    for (const s of materialSnap) {
      const m = s.mat;
      if (!m) continue;
      try { m.colorWrite = !!show; m.needsUpdate = true; } catch (e) {}
    }
    // Same for cloned compcolor mats (best-effort, ignored if mode isn't compcolor)
    for (const e of meshOrigMat) {
      const mm = e.mesh.material;
      if (!mm) continue;
      const list = Array.isArray(mm) ? mm : [mm];
      for (const m of list) { try { m.colorWrite = !!show; m.needsUpdate = true; } catch (err) {} }
    }
  };

  // Component Color (Fusion Shift+N): each per-leaf node gets a distinct,
  // deterministic colour from a name hash → golden-ratio hue. Same leaf name →
  // same hue across reloads, no per-load shuffle. All sub-meshes under a single
  // leaf share the leaf's colour so multi-mesh parts read as one piece.
  const _kd3dHashStr = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h >>> 0;
  };
  const _GOLDEN = 0.61803398875;
  const applyComponentColors = () => {
    if (!threeScene || !meshOrigMat.length) return;
    // Fusion's trimesh-exported GLB uses ONE shared material across all 57 per-
    // leaf meshes — setHSL on a shared instance overwrites itself on every
    // iteration so every mesh ends up the same colour (the last one assigned).
    // CLONE per mesh so each leaf actually gets its own colour. The cloned
    // material has its own colour/PBR factors but reuses the same texture
    // references → cheap, no GPU re-upload.
    const colorByOwner = new Map();
    for (let i = 0; i < meshOrigMat.length; i++) {
      const mesh = meshOrigMat[i].mesh;
      // Owner identity priority (RD 07 2026-06-22 fix): check the mesh's OWN
      // name first; if empty, the IMMEDIATE parent's name; otherwise a unique
      // mesh-index fallback. The earlier "walk up to nearest named ancestor"
      // collapsed 85 meshes onto a single "world" ancestor → all same colour.
      // Stopping at the immediate parent + per-mesh fallback guarantees each
      // mesh gets a distinct ownerKey when the structure is flat.
      let ownerKey = (mesh.name && mesh.name.length) ? mesh.name
        : (mesh.parent && mesh.parent.name && mesh.parent !== threeScene && mesh.parent.name.length) ? mesh.parent.name
        : ('mesh-' + i);
      let hsl = colorByOwner.get(ownerKey);
      if (!hsl) {
        const seed = _kd3dHashStr(ownerKey);
        const hue = ((seed * _GOLDEN) % 1 + 1) % 1;
        hsl = { h: hue, s: 0.45, l: 0.62 };
        colorByOwner.set(ownerKey, hsl);
      }
      const origMat = meshOrigMat[i].mat;
      const newMat = Array.isArray(origMat)
        ? origMat.map(m => (m && m.clone ? m.clone() : m))
        : (origMat && origMat.clone ? origMat.clone() : origMat);
      const mats = Array.isArray(newMat) ? newMat : [newMat];
      for (const m of mats) {
        try {
          if (m.color && m.color.setHSL) m.color.setHSL(hsl.h, hsl.s, hsl.l);
          if (m.emissive && m.emissive.setRGB) m.emissive.setRGB(0, 0, 0);
          if (typeof m.emissiveIntensity === 'number') m.emissiveIntensity = 0;
          if (typeof m.metalness === 'number') m.metalness = 0;
          if (typeof m.roughness === 'number') m.roughness = 0.85;
          m.wireframe = false;
          m.needsUpdate = true;
        } catch (e) {}
      }
      mesh.material = newMat;
    }
  };

  // Restore each mesh's original material reference — undoes the per-mesh
  // cloning applyComponentColors performs. Called from applyMode when leaving
  // 'compcolor'. The original material's per-property snapshot (materialSnap)
  // handles the colour/metalness restore — this just re-points mesh.material.
  const restoreOriginalMaterials = () => {
    for (const e of meshOrigMat) {
      try { e.mesh.material = e.mat; } catch (err) {}
    }
  };

  const applyMaterials = (m) => {
    if (!materialSnap.length) return;
    // Component Color has its own per-leaf logic — defer to it.
    if (m === 'compcolor') { applyComponentColors(); return; }
    // Leaving compcolor → restore each mesh's original material ref before
    // editing the snap'd materials (safe no-op if we weren't in compcolor).
    restoreOriginalMaterials();
    for (const s of materialSnap) {
      const mat = s.mat;
      try {
        if (m === 'hidden' || m === 'hiddenshade') {
          // Flat near-white fill behind the edge lines. 'hidden' suppresses the
          // fill itself via setMeshFillVisible(false) (colorWrite=false) so
          // only edges appear; 'hiddenshade' keeps the fill on for surface
          // depth. Either way the fill colour stays light.
          mat.wireframe = false;
          if (mat.color && mat.color.setRGB) mat.color.setRGB(0.94, 0.94, 0.94);
          if (mat.emissive && mat.emissive.setRGB) mat.emissive.setRGB(0, 0, 0);
          if (typeof mat.emissiveIntensity === 'number') mat.emissiveIntensity = 0;
          if (typeof mat.metalness === 'number') mat.metalness = 0;
          if (typeof mat.roughness === 'number') mat.roughness = 1;
        } else {
          // realistic + explode — restore the GLB's authored colors/PBR so the
          // model looks like model-viewer's Astronaut demo (เอ๋ benchmark).
          mat.wireframe = false;
          if (s.color && mat.color && mat.color.copy) mat.color.copy(s.color);
          if (mat.emissive && mat.emissive.setRGB) mat.emissive.setRGB(0, 0, 0);
          if (typeof mat.emissiveIntensity === 'number') mat.emissiveIntensity = 0;
          if (s.metalness != null && typeof mat.metalness === 'number') mat.metalness = s.metalness;
          if (s.roughness != null && typeof mat.roughness === 'number') mat.roughness = s.roughness;
        }
        mat.needsUpdate = true;
      } catch (e) {}
    }
  };

  const applyExplode = (pct) => {
    if (!explodeUnits.length) return;
    // 100% → push each unit so its geometric centroid is at 1.5× its original
    // offset from the scene centroid. For trimesh-baked GLBs the node's
    // position is irrelevant (it's (0,0,0)); the delta = (geom_centroid -
    // scene_centroid) * factor moves each unit outward in WORLD coords by
    // changing node.position.
    const factor = (pct / 100) * 1.5;
    for (const u of explodeUnits) {
      const dx = (u.gx - explodeCenter.x) * factor;
      const dy = (u.gy - explodeCenter.y) * factor;
      const dz = (u.gz - explodeCenter.z) * factor;
      u.node.position.set(u.baseX + dx, u.baseY + dy, u.baseZ + dz);
    }
  };
  const resetExplode = () => {
    for (const u of explodeUnits) u.node.position.set(u.baseX, u.baseY, u.baseZ);
  };

  const applyMode = (next) => {
    if (!mv || !VALID.includes(next)) return;
    mode = next;
    try { localStorage.setItem(MODE_KEY, mode); } catch {}
    VALID.forEach(v => mv.classList.toggle('kd3d-mode-' + v, v === mode));
    // model-viewer attrs per mode. All use 'neutral' (built-in IBL), matching
    // the Astronaut demo's lighting baseline; modes vary only on shadow,
    // exposure, tone for the look they want.
    mv.setAttribute('environment-image', 'neutral');
    // shadow-intensity > 0 renders model-viewer's soft contact shadow on a
    // textured plane — which on light backgrounds reads as a visible WHITE
    // GROUND RECTANGLE under the cabinet (เอ๋ 2026-06-22 "เอา 4 เหลี่ยมนี้ออก,
    // เข้าใจว่าเป็นพื้น แต่ไม่ควรมี"). Only Realistic keeps the shadow (where
    // the dark BG hides the plane and the shadow itself adds the showroom
    // contact cue).
    if (mode === 'hidden' || mode === 'hiddenshade') {
      mv.setAttribute('shadow-intensity', '0');
      mv.setAttribute('shadow-softness', '0.5');
      mv.setAttribute('exposure', '1.3');
      mv.setAttribute('tone-mapping', 'neutral');
    } else if (mode === 'compcolor') {
      mv.setAttribute('shadow-intensity', '0');
      mv.setAttribute('shadow-softness', '0.5');
      mv.setAttribute('exposure', '1.08');
      mv.setAttribute('tone-mapping', 'neutral');
    } else if (mode === 'realistic') {
      // Astronaut-demo treatment — exactly what model-viewer ships by default.
      mv.setAttribute('shadow-intensity', '1');
      mv.setAttribute('shadow-softness', '0.5');
      mv.setAttribute('exposure', '1');
      mv.setAttribute('tone-mapping', 'neutral');
    } else if (mode === 'explode') {
      mv.setAttribute('shadow-intensity', '0');
      mv.setAttribute('shadow-softness', '0.5');
      mv.setAttribute('exposure', '1');
      mv.setAttribute('tone-mapping', 'neutral');
    }
    // Dual-GLB src swap (Fusion 31 2026-06-22). Modes 4/5 want `_parts.glb`
    // (per-leaf for distinct colours + visible explode); modes 1/2/3 want the
    // assembled `.glb`. Probe parts on first need; fall back to main on 404.
    // The 'load' listener (below) re-runs snapshotScene + applyMode when src
    // changes, so this function returns early after queuing a swap — the
    // remaining state writes will happen on the post-load re-entry.
    const wantSrc = _wantSrcFor(mode);
    if (PARTS_MODES.has(mode) && partsExistsKnown === null) {
      _maybeProbeParts().then(() => {
        const next = _wantSrcFor(mode);
        if (next !== currentLoadedSrc) { currentLoadedSrc = next; mv.src = next; }
        else applyMode(mode);
      });
      return;
    }
    if (wantSrc !== currentLoadedSrc) {
      currentLoadedSrc = wantSrc;
      mv.src = wantSrc;
      return;
    }
    applyMaterials(mode);
    // Edges in EVERY mode (เอ๋ "realistic explode ให้เพิ่มเส้นเข้าไปด้วย").
    buildEdgeOverlays().then(() => {
      const isSketch = document.documentElement.getAttribute('data-theme') === 'sketch';
      if (mode === 'hidden') {
        setMeshFillVisible(false);
        setEdgesStyle({ solidColor: isSketch ? 0x000000 : 0xffffff, solidOpacity: 1.0, showDashed: true });
      } else if (mode === 'hiddenshade') {
        setMeshFillVisible(true);
        setEdgesStyle({ solidColor: 0x000000, solidOpacity: 1.0, showDashed: true });
      } else if (mode === 'compcolor') {
        setMeshFillVisible(true);
        setEdgesStyle({ solidColor: 0x000000, solidOpacity: 1.0, showDashed: false });
      } else {
        setMeshFillVisible(true);
        setEdgesStyle({ solidColor: 0x111317, solidOpacity: 0.7, showDashed: false });
      }
    });
    if (mode === 'explode') applyExplode(explodePct);
    else resetExplode();
    modal2 && modal2.classList.toggle('kd3d-modal-explode', mode === 'explode');
    body.querySelectorAll('.kd3d-modebar button').forEach(btn => {
      btn.classList.toggle('is-on', btn.getAttribute('data-mode') === mode);
    });
  };

  // After EACH GLB load (initial + every src swap for the dual-GLB switcher),
  // re-snapshot the scene + re-apply the current mode. _edgesAttempted needs
  // resetting so the overlay rebuilds against the new geometry; ditto for the
  // material clone snapshot in compcolor mode.
  if (mv) {
    mv.addEventListener('load', () => {
      _edgesAttempted = false;
      edgeOverlays = [];
      if (snapshotScene()) applyMode(mode);
    });
  }
  // Track which src loaded so snapshotScene knows whether to update dims (main
  // only — never from _parts). The initial src in the HTML is the assembled
  // main URL, so the first load is the dims-eligible one.
  if (mv) currentLoadedSrc = mv.src || _wantSrcFor(mode);

  // Wire mode buttons.
  body.querySelectorAll('.kd3d-modebar button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = btn.getAttribute('data-mode');
      if (next && next !== mode) applyMode(next);
    });
  });

  // Wire explode slider (live, debounced through requestAnimationFrame).
  const slider = body.querySelector('.kd3d-explodebar input[type=range]');
  const sliderVal = body.querySelector('.kd3d-explode-val');
  if (slider) {
    let raf = 0;
    slider.addEventListener('input', () => {
      explodePct = parseInt(slider.value, 10) || 0;
      sliderVal && (sliderVal.textContent = explodePct + '%');
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = 0; if (mode === 'explode') applyExplode(explodePct); });
    });
    slider.addEventListener('change', () => {
      try { localStorage.setItem(EXPLODE_KEY, String(explodePct)); } catch {}
    });
  }
}

// Global handle for console / direct callers (เอ๋'s scripts also use this).
window.kdOpen3D = _kdOpen3D;

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
    // When a part has NO drawing PDF, the dead 👁 becomes a 🔗 "Pick PDF" button
    // for admins (เอ๋ 2026-06-12): borrow a nearby part's drawing so the eye lights
    // up here and everywhere (drawing_links/<code>, synced). A part already
    // borrowing one keeps its 👁 plus a small 🔗 to re-pick / unlink.
    const dl = getDrawingLink(p.code);   // admin link target ('' if none)
    let viewBtn;
    if (pdfHref) {
      viewBtn = `<button class="bend-view-btn" data-url="${escapeHtml(pdfHref)}" title="View bending drawing PDF">👁</button>`
        + (admin && dl ? `<button class="bend-link-btn is-linked" data-code="${escapeHtml(p.code)}" title="Borrowed from ${escapeHtml(dl)} — pick a different PDF or unlink">🔗</button>` : '');
    } else if (admin) {
      viewBtn = `<button class="bend-link-btn" data-code="${escapeHtml(p.code)}" title="No drawing PDF — pick a nearby part's PDF (admin)">🔗</button>`;
    } else {
      viewBtn = `<button class="bend-view-btn" disabled title="No drawing PDF for this part yet">👁</button>`;
    }
    // Open-in-Fusion — เอ๋ 2026-06-11 'เพิ่มปุ่มให้ผมกลับไปดูที่ฟิวชั่น': jump from
    // a bend row back to the part's 3D master in Fusion. Reuses the mindmap
    // leaf-click router (_routeLeafToFusion → bridge :8765 with retry + the
    // friendly bridge-down / no-URN alerts) — NOT reimplemented. fusionOnly
    // because the 👁 button next door is already the PDF affordance; a dead
    // bridge must say so, not silently open a PDF (same rule as the nest ⚠).
    const fusionBtn = `<button class="bend-fusion-btn" data-code="${escapeHtml(p.code)}" aria-label="Open in Fusion" title="Open this part in Fusion"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8 L20.2 7.4 V16.6 L12 21.2 L3.8 16.6 V7.4 Z"/><path d="M3.8 7.4 L12 12 L20.2 7.4"/><line x1="12" y1="12" x2="12" y2="21.2"/></svg></button>`;
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
        <span class="bend-code" title="${escapeHtml(p.code)}">${escapeHtml(displayCodeFor(p.code))}</span>
        <span class="bend-qty">× ${p.qty || 0}</span>
        ${_bendRecheckChip(p.code, null, { clickable: true })}
        ${_outdatedChips(p.code, { clickable: true })}
        ${viewBtn}
        ${fusionBtn}
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
  // 🔗 Pick-PDF — admin only; appears on NO-PDF rows (and as a re-pick chip on
  // linked rows). Opens the picker that sets drawing_links/<code> (syncs).
  ROOT.querySelectorAll('.bend-link-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _openBendPdfPicker(btn.dataset.code);
    });
  });
  // Open-in-Fusion — delegate to the shared leaf router (bridge :8765, retry,
  // friendly alerts). urn comes from the aggregated manifest part; a missing
  // urn falls through to the router's instructive no-URN alert (re-run
  // CC_Assembly / pair via 🔗), which is the designed UX — keep the button live.
  const _bendPartByCode = new Map(_aggregatePartsByCode(parts).map(p => [p.code, p]));
  ROOT.querySelectorAll('.bend-fusion-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const p = _bendPartByCode.get(btn.dataset.code) || { code: btn.dataset.code };
      _routeLeafToFusion({ code: p.code, urn: p.urn || null }, { fusionOnly: true });
    });
  });
  // Outdated / re-check chips are wired GLOBALLY via _wireOutdatedChipDelegation
  // (one capture-phase document listener handling every surface — bend list,
  // sb-cards, BOM, Library — keyed on data-act). Nothing per-render here.
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
            <button class="cs-preview-btn" data-action="preview" title="Preview the nested sheet">👁</button>
            <button class="cs-download-btn" data-action="download" title="Download DXF">⬇</button>
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
      ${sheets.length ? `<button class="cs-download-all-btn" id="cs-download-all" title="Download every cut-sheet DXF (one file at a time)">⬇ Download all (${sheets.length})</button>` : ''}
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

  let _csBackdrop = null;
  pop.style.position = 'fixed';
  pop.style.overflowY = 'auto';
  // Mobile: the desktop top-right anchor pushed the modal off the left edge,
  // so the dialog was invisible (เอ๋ 2026-06-07 'บนมือถือมองไม่เห็น Dialog box').
  // On narrow screens centre it as a near-full-width sheet + dim the page
  // behind it so it reads as a real dialog instead of bleeding into the list.
  if (window.innerWidth < 640) {
    _csBackdrop = document.createElement('div');
    _csBackdrop.className = 'cs-backdrop';
    _csBackdrop.id = 'kd-cs-backdrop';   // ID so the dim beats the Sketch/Chalk
                                         // theme's high-specificity bg reset.
    document.body.appendChild(_csBackdrop);
    pop.style.left = '3vw';
    pop.style.right = '3vw';
    pop.style.top = '6vh';
    pop.style.width = 'auto';
    pop.style.maxHeight = '88vh';
  } else {
    const r = triggerBtn.getBoundingClientRect();
    pop.style.top    = (r.bottom + 4) + 'px';
    pop.style.right  = (window.innerWidth - r.right) + 'px';
    pop.style.maxHeight = `${Math.max(360, window.innerHeight - r.bottom - 20)}px`;
  }

  let close;

  // Preview the nested sheet — renders the DXF to a canvas (works on mobile
  // + desktop). Row click + 👁 button both preview; ⬇ still downloads the
  // DXF for CAD. (เอ๋ 2026-06-07 'DXF ใน Folder cut sheet ให้แสดงรูปได้ …
  // Preview จากมือถือ หรือ desktop'.)
  const _sheetById = new Map(sheets.map(s => [s.id, s]));
  const _previewSheet = (row) => {
    if (!row) return;
    const s = _sheetById.get(row.dataset.id);
    if (s && s.url) _renderDxfPreviewModal({ ...s, filename: row.dataset.filename });
  };

  pop.querySelectorAll('.cs-row').forEach(row => {
    row.addEventListener('click', (ev) => {
      // Buttons handle themselves (stopPropagation); row body → preview.
      if (ev.target.closest('button')) return;
      ev.stopPropagation();
      _previewSheet(row);
    });
  });
  pop.querySelectorAll('.cs-preview-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); _previewSheet(btn.closest('.cs-row')); });
  });
  pop.querySelectorAll('.cs-download-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const row = btn.closest('.cs-row');
      if (row) _downloadFile(row.dataset.url, row.dataset.filename);
    });
  });

  // ⬇ Download all (เอ๋ 2026-06-11) — fetch every sheet's DXF one at a time, with
  // a short stagger so the browser doesn't block the multi-file download.
  pop.querySelector('#cs-download-all')?.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const btn = ev.currentTarget;
    const orig = btn.textContent;
    btn.disabled = true;
    let ok = 0;
    for (const s of sheets) {
      if (!s.url) continue;
      btn.textContent = `⬇ ${ok + 1}/${sheets.length}…`;
      try { await _downloadFile(s.url, s.filename || `${s.id}.dxf`); ok++; }
      catch (e) { /* keep going — one bad file shouldn't stop the rest */ }
      await new Promise(r => setTimeout(r, 350));
    }
    btn.disabled = false;
    btn.textContent = `✓ ${ok}/${sheets.length}`;
    setTimeout(() => { btn.textContent = orig; }, 2500);
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
      if (_csBackdrop) _csBackdrop.remove();
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
        <span class="pdxf-code" title="${escapeHtml(p.code)}">${escapeHtml(displayCodeFor(p.code))}</span>
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

// Isometric-cube glyph per family for the LIBRARY folder cards (เอ๋ 2026-06-15,
// visual-first): map each family to a cube variant from _f2CubeKit (reused, never
// redrawn) — by WHICH FACE/feature the part is. Multi-colour (periwinkle box / red
// cover / Fusion shading); the family colour stays on the card border/tint. Keyed
// by the families.json key AND the remapped display label (both forms appear).
const _FAMILY_CUBE = {
  'BK':'BK', 'DW-BK':'BK',
  'SD':'SD', 'Side Panel':'SD',
  'CV':'CV',
  'CL':'UP', 'TS':'UP', 'Top Sup':'UP',
  'BT':'DN', 'FL':'DN', 'DW-FL':'DN',
  'FT':'FT',
  'DW-S1':'DW', 'DW-S2':'DW',
  'SH':'SH', 'BM':'SH',
  'Door':'D',
  'F0':'F2', 'PROJECT':'F2', 'F1':'F2', 'F2':'F2', 'F3':'F2',
  'Beam':'O', 'Custom':'O', 'Other':'O', 'OTHER':'O'
};
// Cabinet families use the interlocking-blocks "RD logo" form instead of a single
// cube — same assembly, each family highlights a different block (Project=full).
const _FAMILY_RDBLOCK = { 'F0':'full', 'PROJECT':'full', 'F1':'lower', 'F2':'top', 'F3':'col' };
function _familyCubeIcon(fam, size) {
  const K = _f2CubeKit();
  const f = String(fam || '');
  const hl = _FAMILY_RDBLOCK[fam] || _FAMILY_RDBLOCK[f.toUpperCase()];
  if (hl) return K.rdBlocks(hl, size || 30);
  if (f.toUpperCase() === 'CL') return K.clIcon(size || 30);   // corner cover post
  const key = _FAMILY_CUBE[fam] || _FAMILY_CUBE[f.toUpperCase()] || 'O';
  return K.cube(key, size || 30);
}

function familyOrder(a, b) {
  const fa = families[a] || { order: 999 };
  const fb = families[b] || { order: 999 };
  return fa.order - fb.order;
}

// ── "New file" emphasis (เอ๋ 2026-06-09): glow + amber NEW badge on recently-added
// parts/drawings, and an "N new" count + ring on each Library folder so the workshop
// can scan Library home and spot which folders have new drawings to look at. "New" =
// the part's date is AFTER the family's last-seen time (per-family, localStorage); with
// no last-seen recorded yet, fall back to "added within the last 24h" so a fresh device
// doesn't flag everything. Opening a folder marks it seen → resets its NEW. ──
const LS_SEEN_FAMILIES_KEY = 'kd_seen_families_v1';
let _seenFamiliesCache = null;
function _seenFamilies() {
  if (_seenFamiliesCache) return _seenFamiliesCache;
  _seenFamiliesCache = {};
  try {
    const r = localStorage.getItem(LS_SEEN_FAMILIES_KEY);
    if (r) { const o = JSON.parse(r); if (o && typeof o === 'object') _seenFamiliesCache = o; }
  } catch {}
  return _seenFamiliesCache;
}
function _partDateMs(p) {
  if (!p) return 0;
  if (p.uploaded_at) return +p.uploaded_at || 0;
  if (p.generated_at) return Date.parse(p.generated_at) || 0;
  if (p.dateMs) return +p.dateMs || 0;
  return 0;
}
function isNewPart(p, fam) {
  const d = _partDateMs(p);
  if (!d) return false;
  const seen = _seenFamilies()[fam];
  if (seen != null) return d > seen;
  return d >= (Date.now() - 24 * 3600 * 1000);   // fallback: added in the last 24h
}
function newCountForFamily(fam, parts) {
  let n = 0;
  for (const p of (parts || [])) if (isNewPart(p, fam)) n++;
  return n;
}
function markFamilySeen(fam) {
  if (!fam) return;
  const c = _seenFamilies();
  c[fam] = Date.now();
  try { localStorage.setItem(LS_SEEN_FAMILIES_KEY, JSON.stringify(c)); } catch {}
}

// ── "NEW" on PROJECT lists (เอ๋ 2026-06-10 'ให้มีตัวอักษร NEW … ทั้งที่ Nest,
// Sim.bending, project'): flag a project as NEW per SURFACE (Nest picker /
// Sim.Bending picker / Projects tab) until เอ๋ opens it THERE — per-surface keys
// so e.g. opening a project in Projects doesn't clear its NEW in Nest. "New" =
// the project's freshest activity (manifest updated_at/created_at from
// CC_Assembly, or the newest laser DXF uploaded under it) is AFTER that
// surface's last-seen; never seen → fallback "active within the last 24h". ──
const LS_SEEN_PROJECTS_KEY = 'kd_seen_projects_v1';
let _seenProjectsCache = null;
function _seenProjects() {
  if (_seenProjectsCache) return _seenProjectsCache;
  _seenProjectsCache = {};
  try {
    const r = localStorage.getItem(LS_SEEN_PROJECTS_KEY);
    if (r) { const o = JSON.parse(r); if (o && typeof o === 'object') _seenProjectsCache = o; }
  } catch {}
  return _seenProjectsCache;
}
function projectActivityMs(key, p) {
  let ms = 0;
  if (p) {
    if (p.updated_at) ms = Math.max(ms, Date.parse(p.updated_at) || 0);
    if (p.created_at) ms = Math.max(ms, Date.parse(p.created_at) || 0);
  }
  if (typeof dxfsForProject === 'function') {
    for (const d of dxfsForProject(key)) ms = Math.max(ms, +d.uploaded_at || 0);
  }
  return ms;
}
function isNewProject(surface, key, p) {
  const d = projectActivityMs(key, p);
  if (!d) return false;
  const seen = _seenProjects()[surface + ':' + key];
  if (seen != null) return d > seen;
  return d >= (Date.now() - 24 * 3600 * 1000);   // fallback: active in the last 24h
}
function markProjectSeen(surface, key) {
  if (!surface || !key) return;
  const c = _seenProjects();
  c[surface + ':' + key] = Date.now();
  try { localStorage.setItem(LS_SEEN_PROJECTS_KEY, JSON.stringify(c)); } catch {}
}
// Delayed NEW reset (เอ๋ 2026-06-09): the folder currently being viewed is NOT marked
// seen on open — its NEW row badges must stay visible. We mark it seen only when the
// user LEAVES it (opens another folder → renderFamily; or returns home →
// renderLibraryHome). Holds the folder whose NEW is still pending a reset.
let _pendingSeenFamily = null;

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

  // ─── Digit-led codes → folder "F<leading digit>" ──────────────────
  // เอ๋ 2026-06-09 (permanent RULE): cabinet codes that START WITH A DIGIT
  // (1LLVB4, 100VFRR, 1CSVB2, 1NNVB2, 2.., 3..) were all dumping into the
  // "OTHER" folder. Split them into F1 / F2 / F3 … by their leading digit.
  // Applies to every current AND future code; letter-led codes keep their
  // own chips (handled below). This is checked FIRST so it wins outright.
  const c0 = upper.charCodeAt(0);
  if (c0 >= 48 && c0 <= 57) return 'F' + upper[0];   // '0'..'9' → F0..F9

  // ─── Prefix-first hard rules (override Fusion's family classifier) ──
  // Some prefixes ALWAYS belong to a specific Library chip regardless
  // of how the Fusion-side family classifier tagged them.
  //
  // FN / FC → "FL" (standalone floor beams / rails)
  //   Per user 2026-05-24: "FN FC ให้ อยู่ในโฟลเดอร์นี้"
  if (prefix2 === 'FN' || prefix2 === 'FC') return 'FL';

  // FT → standalone "FT" chip (เอ๋ 2026-06-11, board 75b0c34): every
  //   FT-prefixed code gets its own folder, regardless of the Fusion-side
  //   family tag. (Letter-led, so the digit-led F1/F2/F3 rule above never
  //   catches these; FN/FC→FL stays untouched.)
  if (prefix2 === 'FT') return 'FT';

  // เอ๋'s 2026-06-11 prefix sweep (boards 59a1edc → 5bbff2a): "OTHER ต้องเหลือ
  // เฉพาะของที่ระบบไม่รู้จักจริงๆ". Routes land on the SAME family names the
  // custom folders / built-in chips already use, so cards merge — no dupes.
  if (prefix2 === 'BT') return 'BT';
  if (prefix2 === 'TS') return 'TS';   // TS1BHH/TS2TRX/TS0BV0/TS0000… (absorbs the old "Top Sup" family)
  if (prefix2 === 'CV') return 'CV';
  if (prefix2 === 'C1') return 'CV';   // C10002/C1H101 → same CV folder (letter-led; digit-led rule can't catch)
  if (prefix2 === 'SH') return 'SH';
  if (prefix2 === 'BM') return 'BM';   // BMSPFW/BM01LI/BM1LCL strays join the BM chip

  // BK → standalone "BK" chip (mirrors the FN/FC → FL precedent)
  //   Per user 2026-05-25: BK1DN1, BK2TR1, BK0DN0, BK-XXXX legacy etc.
  //   all want their own Library chip instead of being lumped under DW-BK.
  if (prefix2 === 'BK') return 'BK';
  if (upper.startsWith('BXX')) return 'BK';   // BXXTR0 → BK too (เอ๋ 5bbff2a)
  if (upper.startsWith('CLL')) return 'CL';   // CLL000 → "CL" folder

  // SD → "Side Panel" (เอ๋ 2026-06-09): SD0CN0 / SDLCN / SDRCN etc. are side
  //   panels but Fusion often dumps them into "Other" — pin them to the chip.
  if (prefix2 === 'SD') return 'Side Panel';

  // Drawer prefixes — PREFIX-first (not gated on the Fusion family tag: that
  // gate is exactly why DSV2F0-020080 leaked into OTHER — its family wasn't
  // 'Drawer'). Order: most specific first (DSVF before DSV1/DSV2; DST1 before
  // the broad DST catch-all).
  if (upper.startsWith('DSVF')) return 'DW-S2';   // เอ๋ ef0cde8
  if (upper.startsWith('DSV1')) return 'DW-S1';
  if (upper.startsWith('DSV2')) return 'DW-S2';
  if (upper.startsWith('DSV'))  return 'DW-S1';   // DSVBD1/DSVBD3… — same DW-S1 bucket the Drawer family always defaulted to
  if (upper.startsWith('DST1')) return 'DW-S1';   // เอ๋ 5bbff2a
  if (upper.startsWith('DST'))  return 'DW-S2';   // DST2* + every other DST*

  // ─── Family-based rules ──────────────────────────────────────────
  if (originalFamily === 'Back-Down') return 'DW-BK';
  if (originalFamily === 'Floor')     return 'DW-FL';  // DSB0F-* etc.
  if (originalFamily === 'Drawer') {
    return 'DW-S1';  // default bucket for non-DSV/DST Drawer-family codes
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
  _applyProjectNames();
}

// ── Project display names (เอ๋ 2026-06-10 'ชื่อ Project คือชื่อนี้', pointing at
// the ACTIVE CONFIG ROW in Fusion — e.g. file 100VO0-050000 whose real cabinet
// config is 1LLVO4-05000L): RTDB project_names/<key> = display name override.
// Applied straight onto manifest.projects[].name (same once-at-load pattern as
// the family remap) so EVERY consumer — Projects tab, Nest picker, nest.js
// workspace title, breadcrumbs, Sim.Bending labels — sees the override with no
// per-render work. The project KEY (manifest/RTDB paths) never changes. ──
let _projectNamesCache = {};
function _applyProjectNames() {
  if (!manifest || !manifest.projects) return;
  for (const [key, p] of Object.entries(manifest.projects)) {
    if (p._origName == null) p._origName = p.name || key;   // keep Fusion's name
    p.name = _projectNamesCache[key] || p._origName;
  }
}
function initProjectNamesSync() {
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('project_names').on('value', snap => {
      _projectNamesCache = snap.val() || {};
      _applyProjectNames();
      _backgroundRender();
    }, err => console.warn('Firebase project_names listener error:', err));
  } catch (e) {
    console.warn('Failed to attach project_names listener:', e);
  }
}
function renameProject(key) {
  const p = manifest && manifest.projects && manifest.projects[key];
  const cur = (_projectNamesCache[key] || '');
  const v = prompt(
    `Display name for project "${key}"\n(empty = back to the original "${(p && p._origName) || key}")`, cur);
  if (v == null) return;   // cancelled
  const name = v.trim();
  try {
    if (name) window.firebaseDB.ref('project_names/' + key).set(name);
    else window.firebaseDB.ref('project_names/' + key).remove();
  } catch (e) { alert('Rename failed: ' + (e.message || e)); }
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

// Completed projects — RTDB-synced (เอ๋ 2026-06-11 'เพิ่ม Folder Complete ที่
// Project และ nest โดยให้ Sync กัน'): completed_projects/<key> = {time}. Was
// localStorage-only (per device, no cross-view push); now every device + the
// Projects tab AND the Nest picker share one live set. localStorage stays as
// the instant-paint seed / offline fallback; legacy local entries migrate to
// RTDB once on init.
let completedProjectsCache = null;   // null = sync not started → fall back to LS

function initCompletedSync() {
  completedProjectsCache = {};
  for (const k of loadCompletedSet()) completedProjectsCache[k] = { time: 0 };
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('completed_projects').on('value', snap => {
      completedProjectsCache = snap.val() || {};
      saveCompletedSet(new Set(Object.keys(completedProjectsCache)));
      _backgroundRender();
    }, err => console.warn('Firebase completed_projects listener error:', err));
    // one-shot migration of pre-sync local entries
    window.firebaseDB.ref('completed_projects').once('value').then(s => {
      const cur = s.val() || {};
      for (const k of loadCompletedSet()) {
        if (!cur[k]) {
          try { window.firebaseDB.ref('completed_projects/' + k).set({ time: Date.now() }); } catch {}
        }
      }
    });
  } catch (e) {
    console.warn('Failed to attach completed_projects listener:', e);
  }
}

function isCompleted(name) {
  if (completedProjectsCache) return !!completedProjectsCache[name];
  return loadCompletedSet().has(name);
}

function markCompleted(name, done) {
  if (!name) return;
  if (completedProjectsCache) {
    if (done) completedProjectsCache[name] = { time: Date.now() };
    else delete completedProjectsCache[name];
  }
  const s = loadCompletedSet();
  if (done) s.add(name); else s.delete(name);
  saveCompletedSet(s);
  if (window.firebaseDB) {
    try {
      if (done) window.firebaseDB.ref('completed_projects/' + name).set({ time: Date.now() });
      else window.firebaseDB.ref('completed_projects/' + name).remove();
    } catch (e) { console.warn('completed_projects write failed:', e); }
  }
}

// Shared open/closed state of the 📦 Complete folder (both views use it).
function _completeFolderOpen() {
  try { return localStorage.getItem('kd_complete_open_v1') === '1'; } catch { return false; }
}
function _toggleCompleteFolder() {
  try { localStorage.setItem('kd_complete_open_v1', _completeFolderOpen() ? '0' : '1'); } catch {}
  render();
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
      _backgroundRender();
    });
    window.firebaseDB.ref('project_order').on('value', snap => {
      const arr = snap.val();
      _projectOrderCache = Array.isArray(arr) ? arr : [];
      try { localStorage.setItem(LS_PROJECT_ORDER_KEY, JSON.stringify(_projectOrderCache)); } catch {}
      _backgroundRender();
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
// drawing_links — admin "Edit Link" on a NO-PDF mindmap node: maps a code to a
// TARGET code whose drawing it should borrow (e.g. SD0CN0-080083 -> SD0CN0-080000).
// Resolved FIRST in _effectiveDrawingCode so the node's PDF/NO-PDF flag flips live.
// RTDB-synced (drawing_links/<code> = targetCode) so every device shares the link.
let _drawingLinksCache = {};
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
  try {
    const r = localStorage.getItem(LS_DRAWING_LINKS_KEY);
    if (r) { const o = JSON.parse(r); if (o && typeof o === 'object') _drawingLinksCache = o; }
  } catch {}
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('family_labels').on('value', snap => {
      const raw = snap.val();
      _familyLabelsCache = (raw && typeof raw === 'object') ? raw : {};
      try { localStorage.setItem(LS_FAMILY_LABELS_KEY, JSON.stringify(_familyLabelsCache)); } catch {}
      _backgroundRender();
    });
    window.firebaseDB.ref('family_order').on('value', snap => {
      const arr = snap.val();
      _familyOrderCache = Array.isArray(arr) ? arr : [];
      try { localStorage.setItem(LS_FAMILY_ORDER_KEY, JSON.stringify(_familyOrderCache)); } catch {}
      _backgroundRender();
    });
    window.firebaseDB.ref('display_overrides').on('value', snap => {
      const raw = snap.val();
      _displayOverridesCache = (raw && typeof raw === 'object') ? raw : {};
      try { localStorage.setItem(LS_DISPLAY_OVERRIDES_KEY, JSON.stringify(_displayOverridesCache)); } catch {}
      _backgroundRender();
    });
    window.firebaseDB.ref('family_overrides').on('value', snap => {
      const raw = snap.val();
      _familyOverridesCache = (raw && typeof raw === 'object') ? raw : {};
      try { localStorage.setItem(LS_FAMILY_OVERRIDES_KEY, JSON.stringify(_familyOverridesCache)); } catch {}
      _backgroundRender();
    });
    window.firebaseDB.ref('custom_folders').on('value', snap => {
      const raw = snap.val();
      _customFoldersCache = Array.isArray(raw) ? raw : [];
      try { localStorage.setItem(LS_CUSTOM_FOLDERS_KEY, JSON.stringify(_customFoldersCache)); } catch {}
      _backgroundRender();
    });
    window.firebaseDB.ref('drawing_links').on('value', snap => {
      const raw = snap.val();
      _drawingLinksCache = (raw && typeof raw === 'object') ? raw : {};
      try { localStorage.setItem(LS_DRAWING_LINKS_KEY, JSON.stringify(_drawingLinksCache)); } catch {}
      _backgroundRender();
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
  const ov = code && _familyOverridesCache[code];
  if (ov) {
    // Legacy "F1,2,3" combined-cabinet override is superseded by the per-digit
    // F1/F2/F3 rule (เอ๋ 2026-06-09). Re-route it to F<leading digit> so old
    // admin overrides land in the right per-digit folder, not a dead one.
    if (ov === 'F1,2,3') {
      const c0 = (code || '').charCodeAt(0);
      if (c0 >= 48 && c0 <= 57) return 'F' + code[0];
    }
    return ov;
  }
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

// getDrawingLink / setDrawingLink — admin "Edit Link" on a NO-PDF mindmap node.
// setDrawingLink(code, target) makes `code` borrow `target`'s drawing (resolved in
// _effectiveDrawingCode → pdfUrlForCode), so the node's NO-PDF flag flips to a PDF
// node live. Empty/equal/cyclic target clears the link. RTDB-synced (admin only).
function getDrawingLink(code) { return (code && _drawingLinksCache[code]) || ''; }
// Suggest a sensible Edit-Link target: a part sharing this code's prefix whose drawing
// PDF actually EXISTS (HEAD 200), so the example/default we show the admin is a real,
// openable code. pdfUrlForCode alone is optimistic — it returns a URL for a manifest
// key even when the file 404s — so we HEAD-check candidates. Async; '' if none. (เอ๋)
async function suggestDrawingTarget(code) {
  if (!code) return '';
  const prefix = code.split('-')[0];
  if (!prefix) return '';
  const by = partsByFamily();
  const seen = new Set();
  const candidates = [];
  for (const f of Object.keys(by)) {
    for (const p of by[f]) {
      if (p.code && p.code !== code && !seen.has(p.code) && p.code.split('-')[0] === prefix) {
        seen.add(p.code);
        const url = pdfUrlForCode(p.code);
        if (url) candidates.push({ code: p.code, url });
      }
    }
  }
  for (const c of candidates.slice(0, 12)) {
    if (await _pdfFileExists(c.url)) return c.code;
  }
  return candidates.length ? candidates[0].code : '';   // fallback: a URL even if unverified
}
// HEAD-check that a resolved drawing URL actually returns a file (200). Strips the
// #page fragment + no-store so a stale CDN copy doesn't lie. Returns false on any error.
async function _pdfFileExists(url) {
  if (!url) return false;
  try {
    const r = await fetch(url.split('#')[0], { method: 'HEAD', cache: 'no-store' });
    return r.ok;
  } catch { return false; }
}
function setDrawingLink(code, target) {
  if (!code) return;
  // Preserve the target's ORIGINAL case. manifest auto_generated keys are
  // case-SENSITIVE and mixed-case codes exist (project variants e.g. "…-Ruth",
  // "…-Bung"), so an UPPERCASED target can't match → pdfUrlForCode returns ''
  // → the borrowed PDF never shows ("กด Relink แล้วไม่เห็นเปลี่ยน", เอ๋ 2026-06-14).
  // The self-link / 2-cycle guards compare case-INSENSITIVELY (a code is the same
  // part regardless of case) so they still reject cycles without mangling the value.
  const t = (target || '').trim();
  const ci = s => (s || '').toUpperCase();
  // guard: clearing, self-link, or a direct 2-cycle (a→b while b→a) is rejected
  if (t && ci(t) !== ci(code) && ci(_drawingLinksCache[t]) !== ci(code)) _drawingLinksCache[code] = t;
  else delete _drawingLinksCache[code];
  try { localStorage.setItem(LS_DRAWING_LINKS_KEY, JSON.stringify(_drawingLinksCache)); } catch {}
  if (window.firebaseDB) {
    try {
      window.firebaseDB.ref('drawing_links/' + code).set(_drawingLinksCache[code] || null);
    } catch (e) { console.warn('Firebase drawing_link write failed:', e); }
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
      _backgroundRender();
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
      _backgroundRender();
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
      if (typeof render === 'function') _backgroundRender();
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
        _backgroundRender();
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
    // Common confusion (เอ๋ 2026-06-09): people type the PART CODE into this box,
    // thinking it asks for a name. It asks for a one-time GitHub TOKEN. If the entry
    // looks like a part code, point them at the easier no-token paths instead.
    if (/^[A-Za-z0-9]{3,}-\d{3,}$/.test(trimmed)) {
      alert('"' + trimmed + '" looks like a PART CODE, not a GitHub token.\n\n' +
        'This box wants a one-time GitHub token, only needed to UPLOAD a PDF file.\n\n' +
        'Easier ways to give this part a drawing (no token):\n' +
        '  • 🔗 LINK button on the node — borrow another part\'s drawing PDF\n' +
        '  • Export it from Fusion (CC_DrawingPDF) — it auto-appears in ~1 min');
    } else {
      alert('That doesn\'t look like a GitHub token (it should start with github_pat_… ). Cancel + try again.');
    }
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

// เอ๋ 2026-06-08: upload a part's FLAT-PATTERN DXF (for the DXF-driven Sim.Bending) via the
// same GitHub-PAT Contents API as the PDF upload, to Drawings/flat/<code>.dxf. The sim fetches
// it on open and renders the real folded geometry; absent → falls back to box_geom.
async function uploadDxfFromDrop(file, code, opts) {
  if (!file || !/\.dxf$/i.test(file.name)) { alert('Please drop a DXF file (.dxf).'); return false; }
  if (!code) return false;
  const path = `Drawings/flat/${code}.dxf`;
  try {
    const content = await fileToBase64(file);
    const existingSha = await _ghGetFileSha(path);
    const resp = await _ghContentsRequest(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Upload flat DXF ${code}` + (existingSha ? ' (replace)' : ''),
        content, branch: GH_BRANCH,
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    });
    if (!resp.ok) {
      const errBody = await resp.text();
      if (resp.status === 401 || resp.status === 403) { resetGitHubPat(); alert(`GitHub auth failed (${resp.status}). PAT cleared — try again.`); }
      else alert(`DXF upload failed (${resp.status}):\n\n${errBody.slice(0, 500)}`);
      return false;
    }
    const json = await resp.json();
    const commitSha = json.commit && json.commit.sha;
    if (!(opts && opts.quiet)) {
      alert(`Uploaded flat DXF ${code} (${Math.round(file.size / 1024)} KB)\nGitHub commit: ${commitSha ? commitSha.slice(0, 7) : 'OK'}\nSim.Bending uses it in ~1 min (Pages rebuild).`);
    }
    return true;
  } catch (e) {
    console.error('[dxf-upload] FAILED:', e);
    alert('DXF upload failed:\n\n' + (e.message || e));
    return false;
  }
}

// Replace a part's DXF in BOTH places at once (เอ๋ 2026-06-10 'ทั้งสองไฟล์'):
// the laser-cut DXF (Drawings/dxf/<code> + uploaded_dxfs, what the cutter reads)
// and the flat DXF (Drawings/flat/<code>, what Sim.Bending reads). Both
// sha-overwrite. Silent success (_kdToast); only errors alert. Preserves the
// laser DXF's existing `project` so the part stays in its project cut list.
// Shared by the part-row drag-drop AND the tap-to-pick "Replace DXF" button.
async function _replacePartDxfBoth(code, file) {
  if (!code || !file) return false;
  if (!/\.dxf$/i.test(file.name)) { alert('Pick a .dxf file.'); return false; }
  let proj = '';
  try {
    const snap = await window.firebaseDB.ref('uploaded_dxfs/' + code).once('value');
    proj = (snap.val() && snap.val().project) || '';
  } catch (e) { /* no existing entry — treat as new */ }
  const okFlat = await uploadDxfFromDrop(file, code, { quiet: true });
  let okLaser = false;
  try { await _uploadPartDxf(proj, code, file); okLaser = true; }
  catch (e) { console.error('[replace dxf laser]', e); alert(`Laser DXF upload failed for ${code}: ${e.message || e}`); }
  const ok = okFlat || okLaser;
  if (ok) { try { _kdToast(`✓ DXF replaced (laser + flat) — ${displayCodeFor(code)}`); } catch (e) {} }
  return ok;
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
  // MOUNT IN FLIGHT → skip entirely. A reload fires init-time RTDB listeners here while the
  // editor's async mount (bundle+RTDB reads) is still pending; falling through to
  // _backgroundRender→render() would rebuild ROOT and CLOBBER the in-flight #kme-mount → the
  // blank-on-reload race. Let the mount finish (the watchdog repopulates if it ends empty).
  if (top && top.kind === 'project' && (window.__kmeMountSeq || 0) !== (window.__kmeMountDone || 0)) return;
  // Require the editor to be POPULATED (has nodes), not just mounted: on a reload
  // the editor can mount EMPTY — then this must fall through to _backgroundRender →
  // render() to REPOPULATE it (and restore its viewport via _vpGet), instead of an
  // extsync that delta-syncs nothing and leaves a blank canvas (เอ๋ 2026-06-21).
  const editorLive = !!window.__kmeInstance && !!document.getElementById('kme-mount')
    && !!document.querySelector('.react-flow__node');
  if (top && top.kind === 'project' && editorLive) {
    _updateProgressPills(top.name);
    try { window.dispatchEvent(new Event('kme:extsync')); } catch {}
    return;
  }
  _backgroundRender();   // scroll-preserving + defers while เอ๋ types / a dialog is open
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

// ──────────────────────────────────────────────────────────────────────
// Cabinet Freshness (เอ๋ 2026-06-11: "คนประกอบ คนพับ คนตัด Laser ก็ต้องรู้ว่า
// อะไรใหม่เข้ามา อะไรเก่า ... ต้อง Sync กัน"). Per-ROLE NEW/CHANGED markers per
// cabinet (variant_root). Standalone — computes per-cabinet code→qty straight
// from the manifest so Nest, Sim.Bending and the mindmap all get the SAME
// fingerprint without any of them needing the nest session's `contrib`.
// Mirrors the bent_status sync verbatim, +1 role level. Spec:
// docs/superpowers/specs/2026-06-11-cabinet-freshness-design.md
// ──────────────────────────────────────────────────────────────────────
const LS_CAB_SEEN_KEY = 'kd_cabinet_seen_v1';
const NO_CAB = '__NO_CAB__';                       // RTDB-safe key for variant_root ''
const CAB_NEW_WINDOW_MS = 24 * 3600 * 1000;        // first-render baseline, mirrors isNewProject

let _cabSeenCache = {};   // { "role|pk|cab": { fp, seen_at } }

function cabSeenKey(role, pk, cab) { return `${role}|${pk}|${cab || NO_CAB}`; }

// Resolve a leaf part's owning cabinet (the top variant_root). Robust to BOTH
// manifest schemas: (a) pre-2026-06-11-17:06 leaves carried variant_root
// directly; (b) the 17:06 re-scan moved it — leaves carry NONE and instead link
// to a top wrapper via parent_code that carries variant_root=its-own-code.
// Climbs parent_code to that top wrapper. A standalone leaf (no parent, no vr) =
// '' (the shared/no-cabinet bucket). byCode must include wrappers so the climb
// resolves. (เอ๋ cabinet capsules + freshness both depend on this.)
function _resolveCabinet(part, byCode) {
  if (!part) return '';
  if (part.variant_root) return String(part.variant_root).trim();
  if (!part.parent_code) return '';
  let cur = part; const seen = new Set();
  while (cur && cur.parent_code && !seen.has(cur.code)) {
    seen.add(cur.code);
    const par = byCode.get(cur.parent_code);
    if (!par) break;
    cur = par;
  }
  return String((cur && (cur.variant_root || (cur !== part ? cur.code : ''))) || '').trim();
}

// Per-cabinet { code -> summed qty } for a project, from the manifest. Skips
// wrappers (qty-0 containers). Cabinet derived via _resolveCabinet (tree climb).
// '' = the shared/no-cabinet bucket. Returns Map<cab, Map<code, qty>>.
function _cabinetCodeQty(projectKey) {
  const out = new Map();
  const proj = manifest && manifest.projects && manifest.projects[projectKey];
  if (!proj || !Array.isArray(proj.parts)) return out;
  const byCode = new Map();
  for (const p of proj.parts) if (p && p.code) byCode.set(p.code, p);
  for (const p of proj.parts) {
    if (!p || !p.code || p.is_wrapper) continue;
    const cab = _resolveCabinet(p, byCode);
    let codes = out.get(cab);
    if (!codes) { codes = new Map(); out.set(cab, codes); }
    codes.set(p.code, (codes.get(p.code) || 0) + (p.qty || 0));
  }
  return out;
}

// Cheap stable string hash (djb2) → base36. Order-independent inputs are
// sorted by the caller before hashing.
function _fnvHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Freshest signal (ms) for a cabinet = newest uploaded_at over its codes.
// Used both in the fingerprint and in the 24h baseline. _uploadedDxfsCache is
// the module-level map populated by initUploadedDxfsSync (declared ~app.js:2789).
function _cabinetFreshestMs(codeQty) {
  let ms = 0;
  const dxfs = (typeof _uploadedDxfsCache === 'object' && _uploadedDxfsCache) ? _uploadedDxfsCache : {};
  for (const code of codeQty.keys()) {
    const meta = dxfs[code];
    if (meta && +meta.uploaded_at) ms = Math.max(ms, +meta.uploaded_at);
  }
  return ms;
}

// Fingerprint of ONE cabinet. codeQty = Map<code, qty> for that cabinet.
// fp = hash( sorted "code:qty" (qty>0)  +  '|' + maxUploadedAt ). Version
// component intentionally omitted in phase 1 (last_drawn_version 0/0 dormant
// until Fusion F29). Returns '' for an empty cabinet (no qty>0 codes).
function _cabinetFingerprint(codeQty) {
  const parts = [];
  for (const [code, qty] of codeQty) if (qty > 0) parts.push(`${code}:${qty}`);
  if (!parts.length) return '';
  parts.sort();
  return _fnvHash(parts.join(',') + '|' + String(_cabinetFreshestMs(codeQty)));
}

// Status for one cabinet for one role: 'new' | 'changed' | 'old'.
function cabinetFreshness(role, projectKey, cab, codeQty) {
  const fp = _cabinetFingerprint(codeQty);
  const snap = _cabSeenCache[cabSeenKey(role, projectKey, cab)];
  if (!snap) {
    return (_cabinetFreshestMs(codeQty) >= Date.now() - CAB_NEW_WINDOW_MS) ? 'new' : 'old';
  }
  return (snap.fp !== fp) ? 'changed' : 'old';
}

// Status for every cabinet of a project, for one role. Returns
// Map<cab, {status, fp, codeQty}>. Orphan snapshot keys (cabinets no longer in
// the manifest, e.g. after a rename) are simply not produced here.
function cabinetFreshnessAll(role, projectKey) {
  const res = new Map();
  for (const [cab, codeQty] of _cabinetCodeQty(projectKey)) {
    res.set(cab, { status: cabinetFreshness(role, projectKey, cab, codeQty),
                   fp: _cabinetFingerprint(codeQty), codeQty });
  }
  return res;
}

function _mirrorCabSeenToLocal() {
  // Nest { role: { pk: { cab: {fp,seen_at} } } } for compactness + offline seed.
  const nested = {};
  for (const [k, v] of Object.entries(_cabSeenCache)) {
    const [role, pk, cab] = k.split('|');
    (((nested[role] = nested[role] || {})[pk] = nested[role][pk] || {}))[cab] = v;
  }
  try { localStorage.setItem(LS_CAB_SEEN_KEY, JSON.stringify(nested)); } catch {}
}
function _seedCabSeenFromLocal() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_CAB_SEEN_KEY) || '{}');
    _cabSeenCache = {};
    for (const [role, pks] of Object.entries(o || {}))
      for (const [pk, cabs] of Object.entries(pks || {}))
        for (const [cab, v] of Object.entries(cabs || {}))
          _cabSeenCache[cabSeenKey(role, pk, cab)] = v;
  } catch {}
}
_seedCabSeenFromLocal();

// Mark ONE cabinet seen for a role = store its CURRENT fingerprint.
function markCabinetSeen(role, projectKey, cab, fp) {
  const k = cabSeenKey(role, projectKey, cab);
  const payload = { fp: fp || '', seen_at: Date.now() };
  _cabSeenCache[k] = payload;
  if (window.firebaseDB) {
    try { window.firebaseDB.ref(`cabinet_seen/${role}/${projectKey}/${cab || NO_CAB}`).set(payload); }
    catch (e) { console.warn('Firebase cabinet_seen write failed:', e); }
  }
  _mirrorCabSeenToLocal();
}

// Mark ALL of a project's cabinets seen for ONE role (the "เห็นทั้งหมด" button).
function markAllCabinetsSeen(role, projectKey) {
  const all = cabinetFreshnessAll(role, projectKey);
  const updates = {};
  for (const [cab, info] of all) {
    const payload = { fp: info.fp, seen_at: Date.now() };
    _cabSeenCache[cabSeenKey(role, projectKey, cab)] = payload;
    updates[`cabinet_seen/${role}/${projectKey}/${cab || NO_CAB}`] = payload;
  }
  if (window.firebaseDB && Object.keys(updates).length) {
    try { window.firebaseDB.ref().update(updates); }
    catch (e) { console.warn('Firebase cabinet_seen bulk failed:', e); }
  }
  _mirrorCabSeenToLocal();
}

function initCabinetSeenSync() {
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('cabinet_seen').on('value', snap => {
      const data = snap.val() || {};
      _cabSeenCache = {};
      for (const [role, pks] of Object.entries(data))
        for (const [pk, cabs] of Object.entries(pks || {}))
          for (const [cab, payload] of Object.entries(cabs || {}))
            _cabSeenCache[`${role}|${pk}|${cab}`] = payload;
      _mirrorCabSeenToLocal();
      if (typeof render === 'function') { _backgroundRender(); }
    }, err => console.warn('Firebase cabinet_seen listener error:', err));
  } catch (e) { console.warn('Failed to attach cabinet_seen listener:', e); }
}

// Per-render bridge so buildSbCard (a nested fn in the Sim.Bending render) can
// see the dashboard's cabinet freshness. Set in the project-dashboard branch,
// emptied otherwise. cabFresh: Map<cab,{status,...}>, codeCab: Map<code,[cab]>.
let _sbFreshCtx = { cabFresh: new Map(), codeCab: new Map() };

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
      _backgroundRender();
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
      _backgroundRender();
    }, err => console.warn('Firebase deleted_projects listener error:', err));
  } catch (e) {
    console.warn('Failed to attach deleted_projects listener:', e);
  }
}

function isProjectSoftDeleted(pk) {
  const tomb = pk && deletedProjectsCache[pk];
  if (!tomb || !tomb.time) return false;
  // AUTO-UNDELETE on fresh data (RD 02 2026-06-11): a new CC_Assembly scan can
  // reuse a soft-deleted key — เอ๋ deleted old junk cards, re-scanned
  // 1LLV04-06000L, and the fresh project stayed invisible ("กด assembly หลายครั้ง
  // ทำไมไม่ขึ้น"). If the manifest project is NEWER than the tombstone, the
  // delete referred to a stale incarnation — drop it (RTDB too, so every device
  // agrees) and let the card render. No render() here: callers ARE render paths.
  const p = manifest && manifest.projects && manifest.projects[pk];
  const fresh = p ? Math.max(Date.parse(p.updated_at || '') || 0, Date.parse(p.created_at || '') || 0) : 0;
  if (fresh > tomb.time) {
    delete deletedProjectsCache[pk];
    _saveDeletedProjects(deletedProjectsCache);
    if (window.firebaseDB) {
      try { window.firebaseDB.ref('deleted_projects/' + pk).remove(); }
      catch (e) { console.warn('auto-undelete RTDB clear failed:', e); }
    }
    console.info('[projects] auto-undeleted "' + pk + '" — a newer scan superseded the delete');
    return false;
  }
  return true;
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
    // Run the prefix remap on web-uploaded PDFs too — they carry the family
    // tag picked at upload time, which bypassed applyFamilyRemap and left
    // BM*/TS* uploads stranded in Beam/Top Sup (เอ๋'s OTHER sweep 2026-06-11).
    const fam = effectiveFamily(code, _remapFamilyForCode(code, up.family || 'Custom'));
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
    // LEAF parts only — the same _aggregatePartsByCode chokepoint the cut list /
    // bend list / nest / simbend sync all use. CC_Assembly emits container rows
    // (is_wrapper, qty 0) to carry the deep tree; they are NOT drawable parts.
    // Counting them here gave เอ๋'s contradiction: 100VFRR-075D60 card said
    // "⚠ 3 NO DRAWING" (= exactly its 3 wrappers) while the card's own 5/5
    // drawn and the inner MISSING(0) were correct. (RD 03 board f57b3ea)
    const parts = _aggregatePartsByCode(p.parts || []);
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
      leaf_unique: parts.length,
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
  _subscribeBendSim();   // keep _bendSimCache live so 🔧 bend chips show in the library [เอ๋]
  _saveActiveTab();      // persist the live tab+drill (kd_active_tab) for a new-tab/restart reopen
  if (stack.length === 0) {
    if (view === 'projects') return renderProjectsHome();
    if (view === 'nest')     return renderNestHome();
    if (view === 'simbend')  return renderSimBendHome();
    if (view === 'drawing')  return renderDrawingGallery();
    return renderLibraryHome();
  }
  const top = stack[stack.length - 1];
  if (top.kind === 'family') return renderFamily(top.name, top.highlight);
  if (top.kind === 'project') return renderProject(top.name);
}

// ── Background re-render guard (เอ๋ 2026-06-12) ───────────────────────────────
// A manifest auto-refresh or an RTDB push must NEVER yank เอ๋'s place: she sits
// in a project (e.g. the bend list) and saves in Fusion over and over, and a
// full render() rebuilds ROOT.innerHTML — which throws away a focused input +
// its unsaved text and can shift the scroll. So every BACKGROUND trigger routes
// through here instead of calling render() directly:
//   (1) if เอ๋ is mid-interaction — a focused text field OR an open modal — DEFER
//       (set a pending flag; it flushes the moment she's done), so typing / a
//       dialog is never interrupted;
//   (2) otherwise preserve the window scroll across the render (restored on the
//       same tick + next frame + a short timeout, to survive async content fill).
// Navigation (navTo / tab clicks) still calls render() directly, so opening a
// view still resets scroll as intended. The mindmap editor has its own in-place
// path (_refreshAssemblyUI → kme:extsync) and never reaches here.
let _bgRenderPending = false;
function _userIsInteracting() {
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return true;
  // any open modal / overlay (bend PDF picker, stock, saved jobs, bend table,
  // add-project, cut sheets, dxf preview, similar-compare, generic dialog)
  if (document.querySelector(
      '.kdstock-modal, .bendpdf-modal, .bt-overlay, .cs-modal, .kdng-modal, .pdxf-project-modal, .dxf-preview-modal, .sb-modal-backdrop, [role="dialog"]'))
    return true;
  return false;
}
function _backgroundRender() {
  if (_userIsInteracting()) { _bgRenderPending = true; return; }
  // The React Flow mindmap editor must NEVER be remounted by a background tick:
  // render() rebuilds ROOT.innerHTML → destroys #kme-mount → the canvas remounts,
  // which re-runs the radial layout AND re-applies fitView/defaultViewport, so
  // เอ๋'s pan/zoom + dragged node positions JUMP back (เอ๋ 2026-06-21: 'ถ้ามีการ
  // update/refresh ให้คงหน้า+ตำแหน่งเดิม ไม่กระโดดไปมา'). When the editor is live,
  // do the SAME in-place delta the 🧩/complete ticks use (progress pills +
  // kme:extsync, which re-reads badge/chip/assembled state on the EXISTING nodes
  // without touching the viewport) and skip the rebuild entirely. This is the
  // safety net for EVERY direct _backgroundRender() caller (RTDB listeners, the
  // NEW-badge poll, Fusion-save sync, NO-PDF chip flips), not just the ones that
  // already route through _refreshAssemblyUI.
  // Only take the in-place path when the editor is live AND POPULATED (has nodes).
  // If it mounted EMPTY (e.g. on a reload the manifest wasn't ready at first mount),
  // fall through to a real render() so this tick REPOPULATES it (and restores its
  // viewport via _vpGet/defaultViewport) — otherwise the extsync path would leave
  // a blank canvas forever (no nodes to delta-sync). (เอ๋ 2026-06-21)
  const _top = stack[stack.length - 1];
  if (_top && _top.kind === 'project' && window.__kmeInstance
      && document.getElementById('kme-mount') && document.querySelector('.react-flow__node')) {
    _bgRenderPending = false;
    try { _updateProgressPills(_top.name); } catch {}
    try { window.dispatchEvent(new Event('kme:extsync')); } catch {}
    return;
  }
  // MOUNT IN FLIGHT → skip the rebuild. An async editor mount (bundle + RTDB reads) is
  // pending; a render() here would destroy the in-flight #kme-mount and start a competing
  // mount → the blank-on-reload race. Let it finish (the renderProject watchdog repopulates
  // if the mount ends up empty). (เอ๋ 2026-06-21)
  if (_top && _top.kind === 'project' && (window.__kmeMountSeq || 0) !== (window.__kmeMountDone || 0)) return;
  _bgRenderPending = false;
  const se = document.scrollingElement || document.documentElement;
  const y = window.scrollY || (se && se.scrollTop) || 0;
  try { render(); } catch {}
  const restore = () => { try { window.scrollTo(0, y); } catch {} };
  restore();
  try { requestAnimationFrame(restore); } catch {}
  setTimeout(restore, 60);
}
// Flush a deferred background render once เอ๋ stops interacting (blur a field /
// close a dialog). Capture phase + a tick so focus moving between two inputs
// doesn't trigger a mid-edit flush.
function _flushPendingBgRender() {
  if (_bgRenderPending && !_userIsInteracting()) _backgroundRender();
}
if (typeof document !== 'undefined') {
  document.addEventListener('focusout', () => setTimeout(_flushPendingBgRender, 0), true);
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
// Color palette for bend point dots — each B1,B2,B3... gets a distinct hue
const BEND_COLORS = [
  '#e0574a', // B1 — red
  '#4ecca3', // B2 — green
  '#4a90e2', // B3 — blue
  '#f2b84e', // B4 — amber
  '#c471ed', // B5 — purple
  '#2ecc71', // B6 — emerald
  '#e67e22', // B7 — orange
  '#1abc9c', // B8 — teal
  '#e84393', // B9 — pink
  '#6c5ce7', // B10 — indigo
];
function getBendColor(idx) { return BEND_COLORS[idx % BEND_COLORS.length]; }

// ── Bend-table popup (เอ๋: show the step/punch sequence next to the drawing) ──
// Tapping the 🔧 chip on a part-row opens a compact table pulled from bend_sim.
function _bendPunchShort(pid) {
  if (!pid) return 'AUTO';
  const m = String(pid).match(/KYOKKO-([^-]+)/i);
  if (m) return '#' + m[1];
  if (/HEM/i.test(pid)) return 'HEM';
  return String(pid).replace(/^P-/, '');
}
function _bendSimTableHtml(code) {
  const rec = _bendSimCache && _bendSimCache[code];
  if (!rec || !Array.isArray(rec.per_bend) || !rec.per_bend.length) return null;
  const rows = rec.per_bend.slice().sort((a, b) => (a.step || 0) - (b.step || 0));
  const trs = rows.map(b => `<tr>
      <td>${b.step != null ? b.step : ''}</td>
      <td>${escapeHtml(b.bend || '')}</td>
      <td>${escapeHtml(_bendPunchShort(b.punch_id))}</td>
      <td>V${b.v_mm != null ? b.v_mm : ''}</td>
      <td>${b.angle_deg != null ? Math.round(b.angle_deg) + '°' : ''}</td>
      <td>${b.tonnage_kN != null ? Math.round(b.tonnage_kN) + 'kN' : ''}</td>
    </tr>`).join('');
  const ord = (rec.order || []).join(' → ');
  const verdict = rec.bendable ? '✓ BENDABLE' : '✗ ' + ((rec.reason || 'problem').toUpperCase());
  return `<div class="bt-head">${escapeHtml(displayCodeFor(code))} · ${rows.length} BENDS · <span class="${rec.bendable ? 'bt-ok' : 'bt-bad'}">${escapeHtml(verdict)}</span></div>
    <table class="bt-table"><thead><tr><th>ST</th><th>BEND</th><th>PUNCH</th><th>DIE</th><th>ANG</th><th>TON</th></tr></thead><tbody>${trs}</tbody></table>
    ${ord ? `<div class="bt-order">ORDER: ${escapeHtml(ord)}</div>` : ''}
    <div class="bt-foot">from CC_CheckBend${rec.checked_at ? ' · ' + escapeHtml(rec.checked_at) : ''}</div>`;
}
function _openBendTable(code) {
  const html = _bendSimTableHtml(code);
  if (!html) { alert('No bend data for "' + code + '".\nRun CC_CheckBend on it in Fusion first.'); return; }
  const ov = document.createElement('div');
  ov.className = 'bt-overlay';
  ov.innerHTML = `<div class="bt-modal" role="dialog"><button class="bt-close" aria-label="Close">✕</button>${html}</div>`;
  ov.addEventListener('click', e => { if (e.target === ov || e.target.classList.contains('bt-close')) ov.remove(); });
  document.body.appendChild(ov);
  // The sketch/chalk themes reset surfaces+text to transparent/ink with high-specificity
  // !important rules. Inline !important is the only thing that always beats them, so force
  // the dark popup look here (works on every theme). [เอ๋]
  const setP = (el, k, v) => el && el.style.setProperty(k, v, 'important');
  setP(ov, 'background-color', 'rgba(8,12,18,0.66)');
  const modal = ov.querySelector('.bt-modal');
  setP(modal, 'background-color', '#11181f');
  setP(modal, 'border-color', '#2b3340');
  ov.querySelectorAll('.bt-modal, .bt-head, .bt-table th, .bt-table td, .bt-close')
    .forEach(e => setP(e, 'color', '#e6edf4'));
  ov.querySelectorAll('.bt-order, .bt-foot').forEach(e => setP(e, 'color', 'rgba(230,237,244,0.6)'));
  ov.querySelectorAll('.bt-ok').forEach(e => setP(e, 'color', '#4ecca3'));
  ov.querySelectorAll('.bt-bad').forEach(e => setP(e, 'color', '#e0574a'));
  ov.querySelectorAll('.bt-table th, .bt-table td').forEach(e => setP(e, 'border-bottom-color', '#1c2530'));
}

// ── DRAWING gallery (เอ๋: flat grid of EVERY part's drawing PDF, no folders) ──
// Tab next to Library. Workshop browses/opens any drawing in one place; the 🔧
// bend chip rides along on parts that have a bend_sim record.
function renderDrawingGallery() {
  _subscribeBendSim();
  document.getElementById('tab-drawing') && document.getElementById('tab-drawing').classList.add('active');
  const sortMode = localStorage.getItem('kd_dwg_sort') === 'date' ? 'date' : 'az';
  const by = partsByFamily();
  const seen = new Set();
  let all = [];
  Object.values(by).forEach(list => list.forEach(p => {
    const url = p.url || pdfUrlForCode(p.code);
    if (!url || seen.has(p.code)) return;
    seen.add(p.code);
    const dateMs = p.uploaded_at ? +p.uploaded_at
      : (p.generated_at ? (Date.parse(p.generated_at) || 0) : 0);
    all.push({ code: p.code, family: p.family, url, dateMs });
  }));
  if (sortMode === 'date') all.sort((a, b) => (b.dateMs - a.dateMs) || a.code.localeCompare(b.code));
  else all.sort((a, b) => a.code.localeCompare(b.code));
  // เอ๋: the top search box filters THIS gallery (live) instead of a global jump
  const q = (SEARCH.value || '').trim().toLowerCase();
  if (q) all = all.filter(p => p.code.toLowerCase().includes(q) || displayCodeFor(p.code).toLowerCase().includes(q));
  if (typeof COUNT_EL !== 'undefined' && COUNT_EL) COUNT_EL.textContent = all.length + ' drawings';
  const fmtDate = ms => { try { return ms ? new Date(ms).toISOString().slice(0, 10) : ''; } catch (e) { return ''; } };
  const rows = all.map(p => {
    const fam = p.family;
    const display = displayCodeFor(p.code);
    const _bend = _bendSimCache && _bendSimCache[p.code];
    const bendChip = (_bend && Array.isArray(_bend.per_bend) && _bend.per_bend.length)
      ? `<button class="part-bend-btn${_bend.bendable === false ? ' part-bend-bad' : ''}" data-bend-code="${escapeHtml(p.code)}" aria-label="Bend sequence" title="Bend sequence & tooling">🔧</button>`
      : '';
    // always render the date span (empty if none) so it right-aligns the chip
    const dateLbl = `<span class="dwg-date">${fmtDate(p.dateMs)}</span>`;
    const isNew = isNewPart(p, fam);
    return `<div class="part-row${isNew ? ' is-new' : ''}" data-url="${escapeHtml(p.url)}" data-code="${escapeHtml(p.code)}" style="${famVars(fam)}">
        <span class="part-icon${p.url ? ' part-icon-clickable' : ' part-icon-nopdf'}" title="${p.url ? 'Open drawing PDF' : 'No PDF yet'}" ${p.url ? `data-url="${escapeHtml(p.url)}"` : ''}>${familyIcon(fam)}</span>
        <span class="part-code">${escapeHtml(display)}</span>
        ${isNew ? '<span class="part-new-badge">NEW</span>' : ''}
        ${dateLbl}
        ${bendChip}
        <button class="part-compare-btn" data-compare-code="${escapeHtml(p.code)}" data-compare-fam="${escapeHtml(fam)}" aria-label="Compare / Diff" title="Compare with a similar drawing — visual diff overlay">🔍</button>
      </div>`;
  }).join('');
  ROOT.innerHTML = `
    <div class="dwg-gallery">
      <div class="dwg-bar">
        <div class="dwg-head">📐 DRAWINGS · ${all.length}${q ? ` matching "${escapeHtml(q)}"` : ' parts'}</div>
        <div class="dwg-sort">
          <button class="dwg-sort-btn${sortMode === 'az' ? ' active' : ''}" data-sort="az">A–Z</button>
          <button class="dwg-sort-btn${sortMode === 'date' ? ' active' : ''}" data-sort="date">Date</button>
        </div>
      </div>
      <div class="dwg-grid">${rows || (q
        ? `<div class="pdxf-empty">No drawing matches "${escapeHtml(q)}"</div>`
        : '<div class="pdxf-empty">No drawings yet — upload a PDF in Library, or run CC_DrawingPDF in Fusion.</div>')}</div>
    </div>`;
  ROOT.querySelectorAll('.part-row').forEach(el => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.part-bend-btn, .part-icon-clickable, .part-compare-btn')) return;
      _openInNewTab(el.dataset.url);
    });
  });

  // DRAWING-tab Diff: 🔍 opens the Compare modal on Side-by-Side (two PDFs to
  // eyeball) — reliable, and consistent with the Library 🔍 entry. We no longer
  // default straight to Visual PDF Diff: that tab is a raw PIXEL overlay of two
  // independently-laid-out drawings, so it floods red on any scale/position
  // mismatch ("compare มั่ว", เอ๋ 2026-06-09). The CLEAN auto-diff is the
  // Geometry Diff tab (DXF-based), which needs Drawings/flat/<code>.dxf —
  // populate those via the "Export Flat→Web" (CC_ExportFlat) button. Both diff
  // tabs remain available inside the modal.
  ROOT.querySelectorAll('.part-compare-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _openSimilarCompareModal(btn.dataset.compareCode, btn.dataset.compareFam);
    });
  });

  ROOT.querySelectorAll('.part-icon-clickable').forEach(icon => {
    icon.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _openInNewTab(icon.dataset.url);
    });
  });
  ROOT.querySelectorAll('.part-bend-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); _openBendTable(btn.dataset.bendCode); });
  });
  ROOT.querySelectorAll('.dwg-sort-btn').forEach(b => {
    b.addEventListener('click', () => { localStorage.setItem('kd_dwg_sort', b.dataset.sort); renderDrawingGallery(); });
  });
}

let _bendSimSubscribed = false;
let _simBendExpanded = null;       // code currently expanded inline
let _simController = null;         // active sim controller (3-D for box, else 2-D)
let _simController2D = null;       // box only: the 2-D press sim shown beside the 3-D iso (เอ๋ wants both, 2 cols)

function _subscribeBendSim() {
  if (_bendSimSubscribed) return;
  _bendSimSubscribed = true;
  try {
    window.firebaseDB.ref('bend_sim').on('value', snap => {
      _bendSimCache = snap.val() || {};
      // re-render so the 🔧 bend chips appear/update in the library too (skip while
      // the mindmap editor is mounted — it manages its own state). [เอ๋]
      if (!document.getElementById('kme-mount') &&
          ((view === 'simbend' && stack.length === 0) || view === 'library')) render();
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

// ── Bend re-check staleness (RD 02 spec / เอ๋ "ทุกอย่างต้องตรงกันเสมอ") ──
// The bend verdict was computed in Fusion at bend_sim.checked_at; if the
// part's laser DXF was re-uploaded AFTER that, the geometry may have moved →
// hint (non-blocking) to re-run CC_CheckBend. checked_at is a local-time
// string ("2026-06-03 08:36" or ISO) → Date.parse after space→T = local ms.
// DXF side = newest uploaded_dxfs entry for the code (live cache, no fetch).
function _bendRecheckNeeded(code) {
  const rec = _bendSimCache && _bendSimCache[code];
  if (!rec || !rec.checked_at) return null;
  const checked = Date.parse(String(rec.checked_at).trim().replace(' ', 'T')) || 0;
  if (!checked) return null;
  let newest = 0;
  for (const d of dxfsForMasterCode(code)) {
    if (+d.uploaded_at > newest) newest = +d.uploaded_at;
  }
  if (!newest || newest <= checked) return null;
  return { dxfAt: newest, checkedAt: checked };
}
// ── "เอ๋ต้องทำอะไร" outdated chips (RD 03 board d2e7877) ───────────────────
// The model moved past a downstream artifact → amber HINT (English-only, no
// writes, self-clears when fresh data lands). Same stale rule the mindmap
// already uses (fusion_version vs last_drawn_version in buildProjectTree).
// NB 2026-06-11: Fusion currently stamps 0/0 for every entry, so these chips
// stay DORMANT until F29 writes real versions (board NEEDS posted):
//   drawing chip needs auto_generated.<code>.fusion_version / last_drawn_version
//   DXF chip additionally needs uploaded_dxfs.<stem>.model_version (at export)
function _drawingOutdated(code) {
  const eff = (typeof _effectiveDrawingCode === 'function') ? _effectiveDrawingCode(code) : code;
  const entry = manifest && manifest.auto_generated && manifest.auto_generated[eff];
  if (!entry) return null;
  const fv = +entry.fusion_version || 0;
  const lv = +entry.last_drawn_version || 0;
  return (fv > 0 && fv > lv) ? { fv, lv } : null;
}
function _dxfOutdated(code) {
  const entry = manifest && manifest.auto_generated && manifest.auto_generated[code];
  const fv = entry ? (+entry.fusion_version || 0) : 0;
  if (!fv) return null;
  let newestMv = -1;
  for (const d of dxfsForMasterCode(code)) {
    // model_version 0 OR missing = UNKNOWN (a DXF can upload with a 0 stamp) —
    // honest-unknown rule: don't treat it as "very old", only count real (>0)
    // stamps. Otherwise a 0-stamped upload pins the chip ON forever (เอ๋ 2026-06-12,
    // BM1LI0-020000). F29 is fixing the 0-stamp at the source; this clears the
    // stuck chips now without a re-upload.
    const mv = +d.model_version || 0;
    if (mv > 0) newestMv = Math.max(newestMv, mv);
  }
  if (newestMv < 0) return null;   // no KNOWN model_version (all 0/missing) → dormant
  return fv > newestMv ? { fv, mv: newestMv } : null;
}
// opts.clickable (เอ๋ 2026-06-12, bend list): make each chip a one-tap Fusion
// jump — "drawing outdated" opens the part's .f2d drawing, "DXF outdated" opens
// the 3D master (fusionOnly). Routed through _routeLeafToFusion (the bend
// row/cube precedent). เอ๋ updates in Fusion → the version stamp moves → the
// chip clears itself. Default (other surfaces) stays a plain non-clickable tag.
function _outdatedChips(code, opts) {
  const act = !!(opts && opts.clickable);
  const cls = act ? 'sb-recheck sb-recheck-act' : 'sb-recheck';
  const data = act ? ` data-code="${escapeHtml(code)}"` : '';
  let out = '';
  const d = _drawingOutdated(code);
  if (d) out += `<span class="${cls}"${data}${act ? ' data-act="drawing"' : ''} title="Model is v${d.fv} but the drawing was exported at v${d.lv}${act ? ' — click to open this part in Fusion and fix the drawing; Update + Save and this clears itself' : ' — update the drawing in Fusion'}">⚠ drawing outdated</span>`;
  const x = _dxfOutdated(code);
  if (x) out += `<span class="${cls}"${data}${act ? ' data-act="dxf"' : ''} title="Model is v${x.fv} but the laser DXF came from v${x.mv}${act ? ' — click to open the 3D master in Fusion, then run 🔥 (CC_Laser); this clears itself' : ' — run 🔥 (CC_Laser) again'}">⚠ DXF outdated — run 🔥</span>`;
  return out;
}

function _bendRecheckChip(code, extraStyle, opts) {
  const st = _bendRecheckNeeded(code);
  if (!st) return '';
  const t = ms => {   // local date, not UTC — เอ๋ is +07:00, toISOString shifts a day
    const d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  // opts.clickable (เอ๋ 2026-06-12, bend list only): a 🔥 DXF update raised the
  // re-check flag but the chip was a dead label — make it a one-tap jump to the
  // part's 3D MASTER (re-check is a model→bend action, NOT the drawing) so เอ๋
  // re-runs CC_CheckBend; _bendRecheckNeeded clears it once the new check lands.
  const act = !!(opts && opts.clickable);
  const cls = act ? 'sb-recheck sb-recheck-act' : 'sb-recheck';
  const data = act ? ` data-code="${escapeHtml(code)}" data-act="recheck"` : '';
  const tip = `DXF updated ${t(st.dxfAt)} — after this bend check (${t(st.checkedAt)}).`
    + (act ? ' Click to open the 3D master in Fusion, then re-run CC_CheckBend; this clears itself.'
           : ' Re-run CC_CheckBend in Fusion.');
  // เอ๋ 2026-06-13: label says WHAT TO DO ("check bend" = go run Check Bend),
  // not "re-check" — the chip means "not checked since the DXF changed".
  return `<span class="${cls}" style="${extraStyle || ''}"${data} title="${tip}">↻ check bend</span>`;
}

// ── Sim.Bending Favorites (⭐) + Sync-from-Project ────────────────────────
// RD 02 / เอ๋ 2026-06-09: a per-project bending dashboard + pinned favorites.
// Favorites are shared state (localStorage + RTDB simbend_favs/<code>=true),
// open to EVERYONE (not admin-gated) — same pattern as display_overrides.
const LS_FAVS_KEY = 'kd_simbend_favs_v1';
let _favsCache = {};
let _favsSubscribed = false;
let _simBendProject = null;        // null = "All checked parts"; else a project key → dashboard
let _simBendSync = null;           // { key, total, done, byCode:{code:{status,...}}, running }
let _syncRenderTimer = null;

function isFav(code) { return !!(code && _favsCache[code]); }

function toggleFav(code) {
  if (!code) return;
  if (_favsCache[code]) delete _favsCache[code];
  else _favsCache[code] = true;
  try { localStorage.setItem(LS_FAVS_KEY, JSON.stringify(_favsCache)); } catch {}
  if (window.firebaseDB) {
    try { window.firebaseDB.ref('simbend_favs/' + code).set(_favsCache[code] ? true : null); }
    catch (e) { console.warn('Firebase fav write failed:', e); }
  }
}

function _subscribeSimbendFavs() {
  if (_favsSubscribed) return;
  _favsSubscribed = true;
  try {
    const r = localStorage.getItem(LS_FAVS_KEY);
    if (r) { const o = JSON.parse(r); if (o && typeof o === 'object') _favsCache = o; }
  } catch {}
  if (!window.firebaseDB) return;
  try {
    window.firebaseDB.ref('simbend_favs').on('value', snap => {
      const raw = snap.val();
      _favsCache = (raw && typeof raw === 'object') ? raw : {};
      try { localStorage.setItem(LS_FAVS_KEY, JSON.stringify(_favsCache)); } catch {}
      if (!document.getElementById('kme-mount') && view === 'simbend' && stack.length === 0) {
        _backgroundRender();
      }
    });
  } catch (e) { _favsCache = {}; }
}

// Fetch the flat-pattern DXF TEXT for a code — fallback chain (RD 02 2026-06-11,
// เอ๋ "ทำไมขึ้น no data ในเมื่อกด Laser ทุกครั้งเราก็ส่ง flat dxf มาด้วย"):
//   1. Drawings/flat/<code>.dxf            (CC_ExportFlat — canonical)
//   2. Drawings/dxf/<stem>/<stem>.dxf      (CC_Laser copy — SAME flat pattern:
//      validated that the laser export carries the same OUTER_PROFILES/BEND
//      layers; SD00NA-080000 parses IDENTICALLY from both files, and the
//      despike ezdxf pass preserves layers)
// The laser probe is gated by uploaded_dxfs (live cache) — an entry present
// means the repo file exists, so we never 404-spam. cache:'no-store' on both
// (re-exports must not serve a stale CDN/browser copy).
async function _fetchFlatDxfText(code) {
  const tryUrl = async (url) => {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      return r.ok ? await r.text() : null;
    } catch (e) { return null; }
  };
  const t = await tryUrl('Drawings/flat/' + encodeURIComponent(code) + '.dxf');
  if (t != null) return t;
  for (const d of dxfsForMasterCode(code)) {
    const stem = d.stem || code;
    const t2 = await tryUrl('Drawings/dxf/' + encodeURIComponent(stem) + '/' + encodeURIComponent(stem) + '.dxf');
    if (t2 != null) return t2;
  }
  return null;
}
// Load + parse a flat-pattern DXF by code (flat/ first, laser copy fallback).
// Returns the parsed flat object, or null if nothing exists / fails to parse.
async function _loadFlatDxf(code) {
  try {
    const text = await _fetchFlatDxfText(code);
    if (text == null) return null;
    if (!window.KD_DXFFLAT || !window.KD_DXFFLAT.parseFlatDxf) return null;
    return window.KD_DXFFLAT.parseFlatDxf(text) || null;
  } catch (e) { return null; }
}

function _scheduleSyncRender() {
  if (_syncRenderTimer) return;
  _syncRenderTimer = setTimeout(() => {
    _syncRenderTimer = null;
    if (view === 'simbend' && stack.length === 0 && !document.getElementById('kme-mount')) {
      _backgroundRender();
    }
  }, 200);
}

// Sync from Project: for every NON-WRAPPER part in <key>, classify by bend status.
//   verified → already has a Fusion CC_CheckBend record (bend_sim/<code>)
//   dxf      → no record but a flat-pattern DXF exists WITH bends (preview, NOT a
//              verdict) — Drawings/flat/<code>.dxf OR the CC_Laser copy
//              Drawings/dxf/<stem>/ (same geometry; see _fetchFlatDxfText)
//   flat     → flat-pattern DXF exists with 0 bends (flat panel)
//   none     → no record + no flat-pattern DXF anywhere (export needed)
// DXF cards are informational only — the web cannot decide feasibility (that's
// Fusion's job; เอ๋ removed web auto-tooling 2026-06-03). We do NOT write a fake
// verdict into bend_sim. Probes run with bounded concurrency; progress re-renders.
async function _runProjectSync(key) {
  _simBendProject = key || null;
  if (!key) { _simBendSync = null; if (view === 'simbend') { _backgroundRender(); } return; }
  const proj = manifest && manifest.projects && manifest.projects[key];
  const codes = proj ? _aggregatePartsByCode(proj.parts || []).map(p => p.code).filter(Boolean) : [];
  _simBendSync = { key, total: codes.length, done: 0, byCode: {}, running: true };
  const toProbe = [];
  codes.forEach(c => {
    if (_bendSimCache && _bendSimCache[c]) { _simBendSync.byCode[c] = { status: 'verified' }; _simBendSync.done++; }
    else { _simBendSync.byCode[c] = { status: 'checking' }; toProbe.push(c); }
  });
  if (view === 'simbend' && stack.length === 0) { try { render(); } catch {} }
  let idx = 0;
  const CONC = Math.min(8, toProbe.length);
  async function worker() {
    while (idx < toProbe.length) {
      const c = toProbe[idx++];
      // a record may have arrived between scheduling and now (live CC_CheckBend)
      if (_bendSimCache && _bendSimCache[c]) { _simBendSync.byCode[c] = { status: 'verified' }; _simBendSync.done++; _scheduleSyncRender(); continue; }
      const flat = await _loadFlatDxf(c);
      if (!flat) {
        _simBendSync.byCode[c] = { status: 'none' };
      } else {
        const nb = (flat.bends || []).length;
        const bb = flat.bbox || {};
        const dims = (bb.w != null && bb.h != null) ? [+bb.w, +bb.h].sort((a, b) => b - a) : null;
        _simBendSync.byCode[c] = {
          status: nb > 0 ? 'dxf' : 'flat',
          nBends: nb,
          w: dims ? dims[0] : null,
          h: dims ? dims[1] : null,
        };
      }
      _simBendSync.done++;
      _scheduleSyncRender();
    }
  }
  if (toProbe.length) await Promise.all(Array.from({ length: CONC }, worker));
  _simBendSync.running = false;
  if (view === 'simbend' && stack.length === 0) { try { render(); } catch {} }
}

// ── Interactive leg what-if (เอ๋: ปรับขา → ขาอื่น+flat คำนวณใหม่) ──────────
// Fusion sends legs[] (FLAT segment lengths, N+1) + flat_length. The blank is
// fixed; moving a bend line trades length between adjacent sides. Convert flat
// legs → BENT outer dims (what เอ๋ sees: 40/40/40) via bend deduction:
//   bent = flat + (adjacent bend count × BD/2)   [end side: 1 bend, middle: 2]
// Verified: legs [44.13,38.26,34.13] + BD≈1.74 → [45,40,35] (เอ๋'s example).
function _bendDeductionMM(R, T, angleDeg, K) {
  const rad = Math.PI / 180, A = angleDeg || 90;
  const BA = rad * A * (R + K * T);
  const OSSB = Math.tan(rad * A / 2) * (R + T);
  return 2 * OSSB - BA;
}
function _bentSidesFromLegs(rec) {
  const legs = rec && rec.legs;
  if (!Array.isArray(legs) || legs.length < 2) return null;
  const T = rec.thickness != null ? +rec.thickness : 1.0;
  const per = (rec.per_bend || []);
  const R = (per[0] && per[0].radius_mm != null) ? +per[0].radius_mm : 1.0;
  const A = (per[0] && per[0].angle_deg != null) ? +per[0].angle_deg : 90;
  const BD = _bendDeductionMM(R, T, A, 0.44);
  const last = legs.length - 1;
  const bent = legs.map((L, i) => +L + ((i === 0 || i === last) ? 1 : 2) * (BD / 2));
  const flatTotal = rec.flat_length != null ? +rec.flat_length
    : legs.reduce((s, x) => s + (+x), 0);
  return { bent: bent.map(x => Math.round(x * 100) / 100), flatTotal, BD, T };
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

const KYOKKO_CATALOG_SERIES = {
  punches: [
    {
      series: "452",
      name: "Gooseneck #452 (overall hardening)",
      type: "gooseneck",
      height_mm: 90,
      radii: [0.2, 0.6, 0.8, 1.5, 3.0],
      angles: [88, 90],
      note: "Standard small gooseneck punch. Great for channels and boxes."
    },
    {
      series: "453",
      name: "Gooseneck #453 (Thin Tip)",
      type: "gooseneck",
      height_mm: 90,
      radii: [0.2, 0.6, 0.8, 1.5, 3.0],
      angles: [88, 90],
      note: "Thin tip small gooseneck punch. Clears narrow channel returns."
    },
    {
      series: "045",
      name: "Middle Gooseneck #045",
      type: "gooseneck",
      height_mm: 105,
      radii: [0.2, 0.6, 0.8, 1.5, 3.0],
      angles: [88, 90],
      note: "Middle-sized gooseneck punch. 105mm height for deeper bends."
    },
    {
      series: "200",
      name: "Sash Punch #200 (Short H70)",
      type: "gooseneck",
      height_mm: 70,
      radii: [0.2, 0.6],
      angles: [88, 90],
      note: "Sash punch (short H70) for shallow profiles and returns."
    },
    {
      series: "202",
      name: "Sash Punch #202 (H130)",
      type: "sash",
      height_mm: 130,
      tang_w_mm: 26.17,
      body_w_mm: 11.31,
      tip_w_mm: 18,
      bevel_angle: 135,
      neck_w_mm: 11.56,
      radii: [0.2, 0.6],
      angles: [88, 90],
      note: "Sash punch (H130) for standard return flanges."
    },
    {
      series: "109",
      name: "Straight Punch #109",
      type: "standard",
      height_mm: 95,
      radii: [0.2, 0.6, 0.8],
      angles: [88, 90],
      note: "Straight punch H95. Ideal for flat sheets and standard 90° bends."
    },
    {
      series: "004",
      name: "Gooseneck #004 (H67)",
      type: "gooseneck",
      height_mm: 67,
      radii: [0.2, 0.6, 0.8, 1.5, 3.0],
      angles: [88, 90],
      note: "Gooseneck punch. 67mm standard height."
    },
    {
      series: "117",
      name: "Straight Punch #117 (H67)",
      type: "standard",
      height_mm: 67,
      radii: [0.2, 0.6, 0.8],
      angles: [88, 90],
      note: "Straight punch. 67mm standard height."
    },
    {
      series: "047",
      name: "Big Gooseneck #047 (H120)",
      type: "gooseneck",
      height_mm: 120,
      radii: [0.2, 0.6, 0.8, 1.5, 3.0],
      angles: [88, 90],
      note: "Large gooseneck punch. 120mm height for deep box bending."
    },
    {
      series: "103",
      name: "Acute 30° Gooseneck #103 (H67)",
      type: "gooseneck",
      height_mm: 67,
      radii: [0.2, 0.6],
      angles: [30],
      note: "Acute 30° gooseneck punch. 67mm height."
    },
    {
      series: "210",
      name: "Acute 30° Sash #210 (H104)",
      type: "gooseneck",
      height_mm: 104,
      radii: [0.2, 0.6],
      angles: [30],
      note: "Acute 30° sash punch. 104mm height."
    },
    {
      series: "211",
      name: "Acute 30° Sash #211 (H90)",
      type: "gooseneck",
      height_mm: 90,
      radii: [0.2, 0.6],
      angles: [30],
      note: "Acute 30° sash punch. 90mm height."
    },
    {
      series: "10870",
      name: "Acute 30° Straight #10870 (H90)",
      type: "standard",
      height_mm: 90,
      radii: [0.2, 0.6],
      angles: [30],
      note: "Straight-type acute 30° punch. 90mm height."
    },
    {
      series: "008",
      name: "Acute 45° Straight #008 (H67)",
      type: "standard",
      height_mm: 67,
      radii: [0.2, 0.4, 0.6],
      angles: [45],
      note: "Acute 45° punch. 67mm height."
    },
    {
      series: "003",
      name: "Acute 60° Straight #003 (H65)",
      type: "standard",
      height_mm: 65,
      radii: [0.2, 0.6, 6.0],
      angles: [60],
      note: "Acute 60° punch. 65mm height, includes R6.0."
    }
  ],
  dies: [
    {
      series: "1V-H60",
      name: "Single V Die H60",
      type: "1V",
      height_mm: 60,
      vOpenings: [3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 25],
      angles: [88, 90],
      note: "Kyokko Single V Die H60 (V3-V25)."
    },
    {
      series: "1V-H80",
      name: "Single V Die H80",
      type: "1V",
      height_mm: 80,
      vOpenings: [6, 8, 10, 12, 16, 20, 25],
      angles: [88, 90],
      note: "Kyokko Single V Die H80 (V6-V25)."
    },
    {
      series: "1V-Large",
      name: "Large Single V Die (H60-H140)",
      type: "1V",
      height_mm: 60,
      vOpenings: [32, 40, 50, 63, 80, 100, 125, 160],
      vHeights: { 32: 60, 40: 60, 50: 60, 63: 75, 80: 95, 100: 110, 125: 123, 160: 140 },
      angles: [80, 85],
      note: "Large Single V Die (V32-V160). H60-H140."
    },
    {
      series: "2V-H46",
      name: "Reversible 2V Die H46",
      type: "2V",
      height_mm: 46,
      vPairs: [[4, 7], [5, 9], [6, 10], [8, 12], [12, 20], [16, 25]],
      vHeights: { "4,7": 45.5, "5,9": 45.5, "6,10": 45.5, "8,12": 45.5, "12,20": 46, "16,25": 50 },
      angles: [88, 90],
      note: "Kyokko Reversible 2V Die H46."
    },
    {
      series: "2V-H80",
      name: "Double V Die H80",
      type: "2V",
      height_mm: 80,
      vPairs: [[6, 8], [8, 12], [12, 20]],
      angles: [88, 90],
      note: "Kyokko Double V reversible die H80."
    },
    {
      series: "2V-Acute-30",
      name: "Acute 2V Die 30° (H38-H46)",
      type: "2V",
      height_mm: 38,
      vPairs: [[6, 10], [8, 12]],
      vHeights: { "6,10": 46, "8,12": 38 },
      angles: [30],
      note: "Kyokko Acute 30° Reversible 2V Die."
    },
    {
      series: "1V-Acute-30",
      name: "Acute 1V Die 30° H60",
      type: "1V",
      height_mm: 60,
      vOpenings: [8, 10, 12, 16],
      angles: [30],
      note: "Kyokko Acute 30° Single V Die H60."
    }
  ]
};

function _showImportCatalogForm() {
  const existing = document.getElementById('sb-add-tool-modal');
  if (existing) existing.remove();

  const punchesHtml = KYOKKO_CATALOG_SERIES.punches.map(item => {
    const anglePills = item.angles.map((ang, idx) => {
      const checked = idx === 0 ? 'checked' : '';
      return `<label class="sb-catalog-pill-group-item">
        <input type="radio" name="punch-ang-${item.series}" value="${ang}" class="sb-catalog-pill-input punch-ang-radio" data-series="${item.series}" ${checked}>
        <span class="sb-catalog-pill">${ang}°</span>
      </label>`;
    }).join('');

    const radiusPills = item.radii.map((r, idx) => {
      const checked = idx === 0 ? 'checked' : '';
      return `<label class="sb-catalog-pill-group-item">
        <input type="radio" name="punch-r-${item.series}" value="${r}" class="sb-catalog-pill-input punch-r-radio" data-series="${item.series}" ${checked}>
        <span class="sb-catalog-pill">R${r}</span>
      </label>`;
    }).join('');

    return `
      <div class="sb-catalog-card" id="punch-card-${item.series}" data-series="${item.series}">
        <div class="sb-catalog-card-header">
          <span class="sb-catalog-card-title">${escapeHtml(item.name)}</span>
          <span class="sb-catalog-card-height">H${item.height_mm}mm</span>
        </div>
        <div class="sb-catalog-card-body">
          <div class="sb-catalog-card-preview" id="punch-preview-${item.series}"></div>
          <div class="sb-catalog-card-controls">
            <div class="sb-catalog-card-control-group">
              <span class="sb-catalog-card-control-label">Angle:</span>
              <div class="sb-catalog-pill-group">${anglePills}</div>
            </div>
            <div class="sb-catalog-card-control-group">
              <span class="sb-catalog-card-control-label">Radius:</span>
              <div class="sb-catalog-pill-group">${radiusPills}</div>
            </div>
            <div class="sb-catalog-card-note">${escapeHtml(item.note)}</div>
          </div>
        </div>
        <div class="sb-catalog-card-footer">
          <span class="sb-catalog-card-model" id="punch-model-${item.series}">-</span>
          <button type="button" class="sb-modal-btn sb-submit sb-catalog-import-action" data-kind="punch" data-series="${item.series}" style="font-size: 11px; padding: 4px 10px; border-radius: 4px; border: none;">Import</button>
        </div>
      </div>
    `;
  }).join('');

  const diesHtml = KYOKKO_CATALOG_SERIES.dies.map(item => {
    const anglePills = item.angles.map((ang, idx) => {
      const checked = idx === 0 ? 'checked' : '';
      return `<label class="sb-catalog-pill-group-item">
        <input type="radio" name="die-ang-${item.series}" value="${ang}" class="sb-catalog-pill-input die-ang-radio" data-series="${item.series}" ${checked}>
        <span class="sb-catalog-pill">${ang}°</span>
      </label>`;
    }).join('');

    let vPills = '';
    if (item.type === '1V') {
      vPills = item.vOpenings.map((v, idx) => {
        const checked = idx === 0 ? 'checked' : '';
        return `<label class="sb-catalog-pill-group-item">
          <input type="radio" name="die-v-${item.series}" value="${v}" class="sb-catalog-pill-input die-v-radio" data-series="${item.series}" ${checked}>
          <span class="sb-catalog-pill">V${v}</span>
        </label>`;
      }).join('');
    } else {
      vPills = item.vPairs.map((pair, idx) => {
        const val = pair.join(',');
        const labelText = `V${pair[0]}/V${pair[1]}`;
        const checked = idx === 0 ? 'checked' : '';
        return `<label class="sb-catalog-pill-group-item">
          <input type="radio" name="die-v-${item.series}" value="${val}" class="sb-catalog-pill-input die-v-radio" data-series="${item.series}" ${checked}>
          <span class="sb-catalog-pill">${labelText}</span>
        </label>`;
      }).join('');
    }

    const heightLabel = item.vHeights
      ? `H${Math.min(...Object.values(item.vHeights))}-H${Math.max(...Object.values(item.vHeights))}mm`
      : `H${item.height_mm}mm`;

    return `
      <div class="sb-catalog-card" id="die-card-${item.series}" data-series="${item.series}">
        <div class="sb-catalog-card-header">
          <span class="sb-catalog-card-title">${escapeHtml(item.name)}</span>
          <span class="sb-catalog-card-height" id="die-height-label-${item.series}">${heightLabel}</span>
        </div>
        <div class="sb-catalog-card-body">
          <div class="sb-catalog-card-preview" id="die-preview-${item.series}"></div>
          <div class="sb-catalog-card-controls">
            <div class="sb-catalog-card-control-group">
              <span class="sb-catalog-card-control-label">Angle:</span>
              <div class="sb-catalog-pill-group">${anglePills}</div>
            </div>
            <div class="sb-catalog-card-control-group">
              <span class="sb-catalog-card-control-label">V Size:</span>
              <div class="sb-catalog-pill-group">${vPills}</div>
            </div>
            <div class="sb-catalog-card-note">${escapeHtml(item.note)}</div>
          </div>
        </div>
        <div class="sb-catalog-card-footer">
          <span class="sb-catalog-card-model" id="die-model-${item.series}">-</span>
          <button type="button" class="sb-modal-btn sb-submit sb-catalog-import-action" data-kind="die" data-series="${item.series}" style="font-size: 11px; padding: 4px 10px; border-radius: 4px; border: none;">Import</button>
        </div>
      </div>
    `;
  }).join('');

  const modal = document.createElement('div');
  modal.id = 'sb-add-tool-modal';
  modal.className = 'sb-modal-backdrop';
  
  modal.innerHTML = `
    <div class="sb-modal-card" style="width: min(840px, 96vw); background: #161b22; color: #cad6e6; border: 2px solid #2b3340; border-radius: 12px; padding: 20px;" onclick="event.stopPropagation()">
      <div class="sb-modal-head" style="color: #4ecca3; font-weight: bold; border-bottom: 1px solid #2b3340; padding-bottom: 8px; font-size: 16px; display: flex; justify-content: space-between; align-items: center;">
        <span>Import Tools from Kyokko Catalog (เลือกนำเข้ามีด/ร่องพับ)</span>
        <span style="font-size: 11px; color: #889bb3; font-weight: normal;">* Click parameters to configure and preview *</span>
      </div>
      <div class="sb-modal-body" style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; max-height: 65vh; overflow-y: auto; margin-top: 10px; margin-bottom: 14px; padding-right: 4px;">
        <div style="display: flex; flex-direction: column; border-right: 1px solid #2b3340; padding-right: 12px; min-width: 0;">
          <h4 style="margin-top: 0; color: #4ecca3; font-size: 13.5px; border-bottom: 1px solid #2b3340; padding-bottom: 6px; font-weight: bold;">Punches (มีดพับ)</h4>
          <div style="display: flex; flex-direction: column;">${punchesHtml}</div>
        </div>
        <div style="display: flex; flex-direction: column; min-width: 0;">
          <h4 style="margin-top: 0; color: #4ecca3; font-size: 13.5px; border-bottom: 1px solid #2b3340; padding-bottom: 6px; font-weight: bold;">Dies (ร่องพับ)</h4>
          <div style="display: flex; flex-direction: column;">${diesHtml}</div>
        </div>
      </div>
      <div class="sb-modal-foot" style="border-top: 1px solid #2b3340; padding-top: 12px;">
        <button class="sb-modal-btn sb-cancel" type="button" style="padding: 6px 16px;">Close</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('.sb-cancel').addEventListener('click', () => modal.remove());

  KYOKKO_CATALOG_SERIES.punches.forEach(item => {
    const cardEl = document.getElementById(`punch-card-${item.series}`);
    if (!cardEl) return;
    const updatePreview = () => {
      const selectedAngle = Number(cardEl.querySelector(`.punch-ang-radio:checked`).value);
      const selectedRadius = Number(cardEl.querySelector(`.punch-r-radio:checked`).value);
      
      const modelMapping = {
        "452": { 88: "452", 90: "462" },
        "453": { 88: "453", 90: "463" },
        "045": { 88: "045", 90: "046" },
        "200": { 88: "200", 90: "201" },
        "202": { 88: "202", 90: "203" },
        "109": { 88: "109", 90: "108" },
        "004": { 88: "004", 90: "016" },
        "117": { 88: "117", 90: "116" },
        "047": { 88: "047", 90: "048" }
      };
      const modelNum = (modelMapping[item.series] && modelMapping[item.series][selectedAngle]) || item.series;
      const label = `#${modelNum}-R${selectedRadius} (${selectedAngle}°)`;
      const radiusStr = String(selectedRadius).replace('.', '');
      const id = `P-KYOKKO-${modelNum}-R${radiusStr}`;

      const modelLabelEl = document.getElementById(`punch-model-${item.series}`);
      if (modelLabelEl) modelLabelEl.textContent = label;

      const previewEl = document.getElementById(`punch-preview-${item.series}`);
      if (previewEl && window.KD_TOOLART) {
        previewEl.innerHTML = window.KD_TOOLART.punch({
          type: item.type,
          series: item.series,
          angle_deg: selectedAngle,
          tip_radius_mm: selectedRadius,
          height_mm: item.height_mm
        }, { w: 64, h: 76 });
      }

      const imported = (window.KD_TOOLING.punches || []).some(t => t.id === id);
      const btn = cardEl.querySelector('.sb-catalog-import-action') || cardEl.querySelector('button[data-kind]');
      if (btn) {
        if (imported) {
          btn.disabled = true;
          btn.textContent = '✓ Imported';
          btn.className = 'sb-modal-btn';
          btn.style.background = '#1c2330';
          btn.style.border = '1px solid #2b3340';
          btn.style.color = '#4ecca3';
          btn.style.cursor = 'not-allowed';
        } else {
          btn.disabled = false;
          btn.textContent = 'Import';
          btn.className = 'sb-modal-btn sb-submit sb-catalog-import-action';
          btn.style.background = '';
          btn.style.border = '';
          btn.style.color = '';
          btn.style.cursor = '';
        }
      }
    };

    cardEl.querySelectorAll('input[type="radio"]').forEach(radio => {
      radio.addEventListener('change', updatePreview);
    });

    updatePreview();
  });

  KYOKKO_CATALOG_SERIES.dies.forEach(item => {
    const cardEl = document.getElementById(`die-card-${item.series}`);
    if (!cardEl) return;
    const updatePreview = () => {
      const selectedAngle = Number(cardEl.querySelector(`.die-ang-radio:checked`).value);
      const vVal = cardEl.querySelector(`.die-v-radio:checked`).value;
      const vList = vVal.split(',').map(Number);
      
      const height = item.vHeights ? (item.vHeights[vVal] || item.height_mm) : item.height_mm;
      const heightLabelEl = document.getElementById(`die-height-label-${item.series}`);
      if (heightLabelEl) heightLabelEl.textContent = `H${height}mm`;

      let label = '';
      let id = '';
      if (item.type === '1V') {
        const V = vList[0];
        label = `1V-V${V} H${height} (${selectedAngle}°)`;
        if (item.series === '1V-H80') {
          id = `D-KYOKKO-1V-V${V}-A${selectedAngle}`;
        } else {
          id = `D-KYOKKO-${item.series}-V${V}-A${selectedAngle}`;
        }
      } else {
        const V1 = vList[0];
        const V2 = vList[1];
        label = `2V-V${V1}/${V2} H${height} (${selectedAngle}°)`;
        if (item.series === '2V-H80') {
          id = `D-KYOKKO-2V-V${V1}_${V2}-A${selectedAngle}`;
        } else {
          id = `D-KYOKKO-${item.series}-V${V1}_${V2}-A${selectedAngle}`;
        }
      }

      const modelLabelEl = document.getElementById(`die-model-${item.series}`);
      if (modelLabelEl) modelLabelEl.textContent = label;

      const previewEl = document.getElementById(`die-preview-${item.series}`);
      if (previewEl && window.KD_TOOLART) {
        previewEl.innerHTML = window.KD_TOOLART.die({
          type: item.type,
          angle_deg: selectedAngle,
          v_list: vList,
          height_mm: height
        }, { w: 70, h: 50 });
      }

      const imported = (window.KD_TOOLING.dies || []).some(t => t.id === id);
      const btn = cardEl.querySelector('.sb-catalog-import-action') || cardEl.querySelector('button[data-kind]');
      if (btn) {
        if (imported) {
          btn.disabled = true;
          btn.textContent = '✓ Imported';
          btn.className = 'sb-modal-btn';
          btn.style.background = '#1c2330';
          btn.style.border = '1px solid #2b3340';
          btn.style.color = '#4ecca3';
          btn.style.cursor = 'not-allowed';
        } else {
          btn.disabled = false;
          btn.textContent = 'Import';
          btn.className = 'sb-modal-btn sb-submit sb-catalog-import-action';
          btn.style.background = '';
          btn.style.border = '';
          btn.style.color = '';
          btn.style.cursor = '';
        }
      }
    };

    cardEl.querySelectorAll('input[type="radio"]').forEach(radio => {
      radio.addEventListener('change', updatePreview);
    });

    updatePreview();
  });

  modal.querySelectorAll('.sb-catalog-import-action').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.getAttribute('data-kind');
      const series = btn.getAttribute('data-series');
      const cardEl = document.getElementById(`${kind}-card-${series}`);
      
      const angle = Number(cardEl.querySelector(`.${kind}-ang-radio:checked`).value);
      let valOrRadius;
      if (kind === 'punch') {
        valOrRadius = Number(cardEl.querySelector(`.punch-r-radio:checked`).value);
      } else {
        valOrRadius = cardEl.querySelector(`.die-v-radio:checked`).value;
      }
      
      _importPresetTool(kind, series, angle, valOrRadius, btn);
    });
  });
}

function _importPresetTool(kind, series, angle, valOrRadius, btn) {
  let id = '';
  let toolData = {};

  if (kind === 'punch') {
    const item = KYOKKO_CATALOG_SERIES.punches.find(p => p.series === series);
    if (!item) return;

    const modelMapping = {
      "452": { 88: "452", 90: "462" },
      "453": { 88: "453", 90: "463" },
      "045": { 88: "045", 90: "046" },
      "200": { 88: "200", 90: "201" },
      "202": { 88: "202", 90: "203" },
      "109": { 88: "109", 90: "108" },
      "004": { 88: "004", 90: "016" },
      "117": { 88: "117", 90: "116" },
      "047": { 88: "047", 90: "048" }
    };
    const modelNum = (modelMapping[item.series] && modelMapping[item.series][angle]) || item.series;
    const radiusStr = String(valOrRadius).replace('.', '');
    id = `P-KYOKKO-${modelNum}-R${radiusStr}`;

    toolData = {
      label: `Kyokko #${modelNum} Gooseneck ${angle}° · R${valOrRadius} H${item.height_mm}`,
      type: item.type,
      angle_deg: angle,
      tip_radius_mm: valOrRadius,
      height_mm: item.height_mm,
      note: item.note
    };
    // Pass through sash-specific dimensions from catalog
    if (item.tang_w_mm) toolData.tang_w_mm = item.tang_w_mm;
    if (item.body_w_mm) toolData.body_w_mm = item.body_w_mm;
    if (item.tip_w_mm) toolData.tip_w_mm = item.tip_w_mm;
    if (item.bevel_angle) toolData.bevel_angle = item.bevel_angle;
    if (item.neck_w_mm) toolData.neck_w_mm = item.neck_w_mm;

    if (item.type === 'standard') {
      toolData.label = `Kyokko #${modelNum} Straight ${angle}° · R${valOrRadius} H${item.height_mm}`;
    } else if (item.type === 'sash' || modelNum === '200' || modelNum === '201' || modelNum === '202' || modelNum === '203' || modelNum === '210' || modelNum === '211') {
      toolData.label = `Kyokko #${modelNum} Sash ${angle}° · R${valOrRadius} H${item.height_mm}`;
    }
  } else {
    const item = KYOKKO_CATALOG_SERIES.dies.find(d => d.series === series);
    if (!item) return;

    const vList = String(valOrRadius).split(',').map(Number);
    const height = item.vHeights ? (item.vHeights[valOrRadius] || item.height_mm) : item.height_mm;

    if (item.type === '1V') {
      const V = vList[0];
      if (item.series === '1V-H80') {
        id = `D-KYOKKO-1V-V${V}-A${angle}`;
      } else {
        id = `D-KYOKKO-${item.series}-V${V}-A${angle}`;
      }
      toolData = {
        label: `Kyokko 1V · V${V} · ${angle}° H${height}`,
        type: '1V',
        angle_deg: angle,
        v_list: vList,
        height_mm: height,
        note: item.note
      };
    } else {
      const V1 = vList[0];
      const V2 = vList[1];
      if (item.series === '2V-H80') {
        id = `D-KYOKKO-2V-V${V1}_${V2}-A${angle}`;
      } else {
        id = `D-KYOKKO-${item.series}-V${V1}_${V2}-A${angle}`;
      }
      toolData = {
        label: `Kyokko 2V · V${V1}/V${V2} · ${angle}° H${height}`,
        type: '2V',
        angle_deg: angle,
        v_list: vList,
        height_mm: height,
        note: item.note
      };
    }
  }

  const pathSegment = kind === 'punch' ? 'punches' : 'dies';
  const refPath = `bend_tools_custom/${pathSegment}/${id}`;
  try {
    window.firebaseDB.ref(refPath).set(toolData).then(() => {
      _setOwnedTool(id, true);
      
      btn.disabled = true;
      btn.className = "sb-modal-btn";
      btn.style.background = "#1c2330";
      btn.style.border = "1px solid #2b3340";
      btn.style.color = "#4ecca3";
      btn.style.cursor = "not-allowed";
      btn.textContent = "✓ Imported";
      
      render();
    }).catch(e => {
      alert('Error importing tool: ' + e.message);
    });
  } catch (e) {
    alert('Database error: ' + e.message);
  }
}

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
      
      const punches = val.punches || val.punchs || {};
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
      // One-time migrate legacy `true` ticks → physical spec (see _toolSpecForOwned)
      // so Fusion honours เอ๋'s ticked tools regardless of id scheme. Idempotent:
      // after the batched write echoes back, values are specs → nothing to migrate.
      const upd = {};
      Object.keys(_ownedToolsCache).forEach(id => {
        if (_ownedToolsCache[id] === true) {
          const spec = _toolSpecForOwned(id);
          if (spec && spec !== true) { _ownedToolsCache[id] = spec; upd[id] = spec; }
        }
      });
      if (Object.keys(upd).length) { try { window.firebaseDB.ref('bend_tools_owned').update(upd); } catch (e) {} }
      if (view === 'simbend' && stack.length === 0) render();
    });
  } catch (e) { _ownedToolsCache = {}; }
}

// Owned-tool SPEC (เอ๋'s ticked inventory) — written to bend_tools_owned/<id> as a
// physical spec so Fusion's CC_CheckBend matches its catalog tools by SPEC, not by
// id (G2 stores KYOKKO part-no ids, Fusion uses generic ids → id coupling broke the
// owned filter = false NOT-BENDABLE; G1 found 2026-06-03). Legacy `true` = Fusion
// falls back to all-tools. Spec object is still truthy → web owned-checks unchanged.
function _toolSpecForOwned(id) {
  let cat; try { cat = getFlattenedCatalog(false); } catch (e) { cat = { punches: [], dies: [] }; }
  const p = (cat.punches || []).find(x => x.id === id);
  const d = (cat.dies || []).find(x => x.id === id);
  const t = p || d;
  if (!t) return true; // unknown id → plain true (Fusion fallback)
  const spec = { type: t.type, angle_deg: t.angle_deg, height_mm: t.height_mm };
  if (p) spec.tip_radius_mm = t.tip_radius_mm;
  else spec.v_list = t.v_list || (t.v_mm != null ? [t.v_mm] : undefined);
  return spec;
}
function _setOwnedTool(id, on) {
  _ownedToolsCache = _ownedToolsCache || {};
  const val = on ? _toolSpecForOwned(id) : null;
  if (on) _ownedToolsCache[id] = val; else delete _ownedToolsCache[id];
  try { window.firebaseDB.ref('bend_tools_owned/' + id).set(val); }
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

  const pathSegment = kind === 'punch' ? 'punches' : 'dies';
  const refPath = `bend_tools_custom/${pathSegment}/${id}`;
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

  const pathSegment = kind === 'punch' ? 'punches' : 'dies';
  const refPath = `bend_tools_custom/${pathSegment}/${id}`;
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

// ── Edit tool form ─────────────────────────────────────────────────
function _showEditToolForm(tool, kind, isCustom) {
  const existing = document.getElementById('sb-add-tool-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'sb-add-tool-modal';
  modal.className = 'sb-modal-backdrop';
  
  const title = kind === 'punch'
    ? `Edit Punch (แก้ไขมีด): ${tool.label}`
    : `Edit Die (แก้ไขร่อง): ${tool.label}`;

  // Pre-fill form values from existing tool
  const content = kind === 'punch' ? `
    <div class="sb-form-group">
      <label>Name / Label</label>
      <input type="text" id="tool-label" value="${escapeHtml(tool.label || '')}" required>
    </div>
    <div class="sb-form-group">
      <label>Type (รูปทรง)</label>
      <select id="tool-type">
        <option value="standard" ${tool.type === 'standard' ? 'selected' : ''}>Standard (ทรงตรง)</option>
        <option value="gooseneck" ${tool.type === 'gooseneck' ? 'selected' : ''}>Gooseneck (ทรงหงส์)</option>
        <option value="acute" ${tool.type === 'acute' ? 'selected' : ''}>Acute (มุมแหลม)</option>
        <option value="hemming" ${tool.type === 'hemming' ? 'selected' : ''}>Hemming (พับแบน)</option>
        <option value="sash" ${tool.type === 'sash' ? 'selected' : ''}>Sash (ทรงตั้ง)</option>
      </select>
    </div>
    <div class="sb-form-group">
      <label>Angle (องศา)</label>
      <input type="number" id="tool-angle" value="${tool.angle_deg != null ? tool.angle_deg : 88}" step="1" min="0" max="180" required>
    </div>
    <div class="sb-form-group">
      <label>Tip Radius (รัศมีปลาย R, มม.)</label>
      <input type="number" id="tool-radius" value="${tool.tip_radius_mm != null ? tool.tip_radius_mm : 0.8}" step="0.1" min="0" max="10" required>
    </div>
    <div class="sb-form-group">
      <label>Height (ความสูง H, มม.)</label>
      <input type="number" id="tool-height" value="${tool.height_mm != null ? tool.height_mm : 120}" step="1" min="10" max="300" required>
    </div>
    <div class="sb-form-group">
      <label>Note (หมายเหตุ)</label>
      <input type="text" id="tool-note" value="${escapeHtml(tool.note || '')}">
    </div>
  ` : `
    <div class="sb-form-group">
      <label>Name / Label</label>
      <input type="text" id="tool-label" value="${escapeHtml(tool.label || '')}" required>
    </div>
    <div class="sb-form-group">
      <label>Type (ประเภท)</label>
      <select id="tool-type">
        <option value="1V" ${tool.type === '1V' ? 'selected' : ''}>1V (ร่องเดี่ยว)</option>
        <option value="2V" ${tool.type === '2V' ? 'selected' : ''}>2V (ร่องคู่กลับด้าน)</option>
        <option value="acute" ${tool.type === 'acute' ? 'selected' : ''}>Acute / 1V Acute</option>
      </select>
    </div>
    <div class="sb-form-group">
      <label>Angle (องศาร่อง)</label>
      <input type="number" id="tool-angle" value="${tool.angle_deg != null ? tool.angle_deg : 88}" step="1" min="0" max="180" required>
    </div>
    <div class="sb-form-group">
      <label>V Openings (มม., สำหรับ 2V ใส่คั่นด้วยจุลภาค เช่น 6,8)</label>
      <input type="text" id="tool-vlist" value="${(tool.v_list || []).join(',')}" required>
    </div>
    <div class="sb-form-group">
      <label>Height (ความสูงร่อง H, มม.)</label>
      <input type="number" id="tool-height" value="${tool.height_mm != null ? tool.height_mm : 60}" step="1" min="10" max="300" required>
    </div>
    <div class="sb-form-group">
      <label>Note (หมายเหตุ)</label>
      <input type="text" id="tool-note" value="${escapeHtml(tool.note || '')}">
    </div>
  `;

  // Preview SVG of current tool
  const art = window.KD_TOOLART;
  const previewSvg = art
    ? (kind === 'punch' ? art.punch(tool, { w: 120, h: 160, showDimensions: true }) : art.die(tool, { w: 160, h: 120, showDimensions: true }))
    : '';

  modal.innerHTML = `
    <div class="sb-modal-card" onclick="event.stopPropagation()" style="max-width: 520px;">
      <div class="sb-modal-head">${escapeHtml(title)}</div>
      <form id="sb-edit-tool-form">
        <div class="sb-modal-body" style="display: flex; gap: 16px;">
          <div style="flex: 1;">${content}</div>
          <div id="tool-edit-preview" style="flex: 0 0 140px; display: flex; align-items: center; justify-content: center; background: #070b10; border-radius: 8px; padding: 10px; min-height: 160px;">
            ${previewSvg}
          </div>
        </div>
        <div style="font-size: 11px; color: #8899aa; padding: 0 16px 8px; font-style: italic;">
          ID: ${escapeHtml(tool.id)} · ${isCustom ? 'Custom' : 'Preset'}
        </div>
        <div class="sb-modal-foot">
          <button class="sb-modal-btn sb-cancel" type="button">Cancel</button>
          <button class="sb-modal-btn sb-submit" type="submit">💾 Save Changes</button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);

  const focusInput = modal.querySelector('#tool-label');
  if (focusInput) focusInput.focus();

  modal.querySelector('.sb-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  
  // Live preview update
  const previewEl = modal.querySelector('#tool-edit-preview');
  function updatePreview() {
    try {
      const previewTool = _readToolFormValues(kind, modal);
      if (previewTool && art) {
        previewEl.innerHTML = kind === 'punch'
          ? art.punch(previewTool, { w: 120, h: 160, showDimensions: true })
          : art.die(previewTool, { w: 160, h: 120, showDimensions: true });
      }
    } catch(e) { /* ignore parse errors while typing */ }
  }
  modal.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('input', updatePreview);
    el.addEventListener('change', updatePreview);
  });

  modal.querySelector('#sb-edit-tool-form').addEventListener('submit', (e) => {
    e.preventDefault();
    _saveEditTool(tool.id, kind, isCustom, modal);
  });
}

function _readToolFormValues(kind, modal) {
  const label = modal.querySelector('#tool-label').value.trim();
  const type = modal.querySelector('#tool-type').value;
  const angle_deg = parseFloat(modal.querySelector('#tool-angle').value);
  const height_mm = parseFloat(modal.querySelector('#tool-height').value);
  const note = modal.querySelector('#tool-note').value.trim();
  let toolData = { label, type, angle_deg, height_mm, note };
  if (kind === 'punch') {
    toolData.tip_radius_mm = parseFloat(modal.querySelector('#tool-radius').value);
  } else {
    const vlistStr = modal.querySelector('#tool-vlist').value;
    toolData.v_list = vlistStr.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
  }
  return toolData;
}

function _saveEditTool(id, kind, isCustom, modal) {
  const toolData = _readToolFormValues(kind, modal);
  if (!toolData.label) { alert('Please enter a name/label.'); return; }
  if (kind === 'die' && (!toolData.v_list || toolData.v_list.length === 0)) {
    alert('Please specify at least one valid V opening size.');
    return;
  }

  if (isCustom) {
    // Custom tools: update directly in bend_tools_custom
    const pathSegment = kind === 'punch' ? 'punches' : 'dies';
    const refPath = `bend_tools_custom/${pathSegment}/${id}`;
    try {
      window.firebaseDB.ref(refPath).update(toolData).then(() => {
        modal.remove();
        render();
      }).catch(e => alert('Error saving edit: ' + e.message));
    } catch (e) { alert('Database reference error: ' + e.message); }
  } else {
    // Default/Kyokko tools: save override to bend_tools_edits/<id>
    const refPath = `bend_tools_edits/${id}`;
    try {
      window.firebaseDB.ref(refPath).set(toolData).then(() => {
        // Also update the in-memory catalog immediately
        const cat = window.KD_TOOLING;
        const list = kind === 'punch' ? cat.punches : cat.dies;
        const existing = (list || []).find(t => t.id === id);
        if (existing) Object.assign(existing, toolData);
        modal.remove();
        render();
      }).catch(e => alert('Error saving edit: ' + e.message));
    } catch (e) { alert('Database reference error: ' + e.message); }
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
      // 3-state marker: ★ = recommended, · = common/ทั่วไป, ○ = none.
      // Clickable by all roles.
      const star = t.fit1mm ? '★' : (t.common ? '·' : '○');
      const starClickable = `<span class="tl-star tl-star-btn" data-id="${escapeHtml(t.id)}" data-fit1mm="${t.fit1mm ? '1' : '0'}" data-common="${t.common ? '1' : '0'}" style="cursor: pointer;" title="Click to cycle: ★ recommended / · common / ○ none">${star}</span>`;
      const pic = art ? `<span class="tl-pic">${kind === 'punch' ? art.punch(t, { w: 30, h: 40 }) : art.die(t, { w: 44, h: 30 })}</span>` : '';
      const expanded = _toolingExpandedId === t.id;
      const editBtn = (admin)
        ? `<button class="tl-edit-btn" type="button" data-id="${escapeHtml(t.id)}" data-kind="${kind}" data-custom="${t.isCustom ? '1' : '0'}" style="background: none; border: none; color: #4ecca3; cursor: pointer; padding: 0 4px; font-size: 13px; margin-left: 4px;" title="Edit tool">✏️</button>`
        : '';
      const deleteBtn = (admin)
        ? `<button class="tl-del-btn" type="button" data-id="${escapeHtml(t.id)}" data-kind="${kind}" data-custom="${t.isCustom ? '1' : '0'}" style="background: none; border: none; color: #e0574a; cursor: pointer; padding: 0 4px; font-size: 14px; margin-left: 4px;" title="Delete tool">🗑</button>`
        : '';
      return `<div class="tl-row ${on ? 'tl-on' : ''} ${expanded ? 'tl-expanded' : ''}" data-id="${escapeHtml(t.id)}">
        <input type="checkbox" class="tl-cb" data-id="${escapeHtml(t.id)}" ${on ? 'checked' : ''} ${admin ? '' : 'disabled'}>
        ${starClickable}
        ${pic}
        <span class="tl-label">${escapeHtml(t.label)}</span>
        <span class="tl-spec" style="display: flex; align-items: center; gap: 8px;">${escapeHtml(spec)}${editBtn}${deleteBtn}</span>
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
        ${admin ? `<button class="tl-catalog-import-btn" type="button" style="font-family: inherit; font-size: 11px; cursor: pointer; color: #0c131b; background: #4ecca3; border: none; border-radius: 6px; padding: 6px 12px; font-weight: 700;">＋ Import from Kyokko Catalog</button>` : ''}
        <a href="https://www.kyokko-thai.com/17311020/catalog-%E3%82%AB%E3%82%BF%E3%83%AD%E3%82%B0" target="_blank" class="tl-catalog-link" style="color: #4ecca3; text-decoration: none; font-size: 11.5px; font-weight: bold;">
          📖 Kyokko Catalog Webpage ↗
        </a>
        <span class="tl-hint" style="margin-left: auto;">★ = recommended · · = common · ○ = none · saved automatically</span>
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
      if (e.target.classList.contains('tl-cb') || e.target.closest('.tl-detail-row') || e.target.classList.contains('tl-del-btn') || e.target.classList.contains('tl-edit-btn') || e.target.classList.contains('tl-star-btn')) return;
      e.stopPropagation();
      const id = row.getAttribute('data-id');
      _toolingExpandedId = (_toolingExpandedId === id) ? null : id;
      render();
    });
  });
  // Star cycle: ★ recommended -> · common -> ○ none -> ★ recommended.
  // Clickable by all roles.
  ROOT.querySelectorAll('.tl-star-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      const wasFit = btn.getAttribute('data-fit1mm') === '1';
      const wasCommon = btn.getAttribute('data-common') === '1';
      
      let newFit = false;
      let newCommon = false;
      if (wasFit) {
        // ★ -> ·
        newFit = false;
        newCommon = true;
      } else if (wasCommon) {
        // · -> ○
        newFit = false;
        newCommon = false;
      } else {
        // ○ -> ★
        newFit = true;
        newCommon = true;
      }
      _saveToolStarFlag(id, newFit, newCommon);
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
      const isCustom = btn.getAttribute('data-custom') === '1';
      _deleteTool(id, kind, isCustom);
    });
  });
  ROOT.querySelectorAll('.tl-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      const kind = btn.getAttribute('data-kind');
      const isCustom = btn.getAttribute('data-custom') === '1';
      const cat = window.KD_TOOLING;
      const list = kind === 'punch' ? cat.punches : cat.dies;
      const tool = (list || []).find(t => t.id === id);
      if (tool) _showEditToolForm(tool, kind, isCustom);
    });
  });
  const importBtn = ROOT.querySelector('.tl-catalog-import-btn');
  if (importBtn) {
    importBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _showImportCatalogForm();
    });
  }
  const quick = ROOT.querySelector('.tl-quick');
  if (quick) quick.addEventListener('click', () => {
    const cat = window.KD_TOOLING || { punches: [], dies: [] };
    [].concat(cat.punches, cat.dies).forEach(t => { if (t.fit1mm) _setOwnedTool(t.id, true); });
    render();
  });
}

// ──────────────────────────────────────────────────────────────────────
// Auto-sequencing & Overrides helpers (Requirements 1, 2, 3, 4, 6)
// ──────────────────────────────────────────────────────────────────────

let _deletedDefaultsCache = null;
let _deletedDefaultsSubscribed = false;
let _toolEditsCache = null;

function _subscribeDeletedDefaults() {
  if (_deletedDefaultsSubscribed) return;
  _deletedDefaultsSubscribed = true;
  try {
    window.firebaseDB.ref('bend_tools_deleted_defaults').on('value', s => {
      _deletedDefaultsCache = s.val() || {};
      _rebuildKDTooling();
      if (view === 'simbend' && stack.length === 0) render();
    });
    // Also subscribe to tool edits (overrides for default/Kyokko tools)
    window.firebaseDB.ref('bend_tools_edits').on('value', s => {
      _toolEditsCache = s.val() || {};
      _rebuildKDTooling();
      if (view === 'simbend' && stack.length === 0) render();
    });
  } catch (e) {
    _deletedDefaultsCache = {};
    _toolEditsCache = {};
  }
}

function _rebuildKDTooling() {
  if (!window._masterKDTooling) {
    window._masterKDTooling = JSON.parse(JSON.stringify(window.KD_TOOLING || { punches: [], dies: [] }));
  }
  const custom = _customToolsCache || {};
  const deleted = _deletedDefaultsCache || {};
  
  let punches = window._masterKDTooling.punches.filter(p => !deleted[p.id]);
  let dies = window._masterKDTooling.dies.filter(d => !deleted[d.id]);
  
  const customPunches = custom.punches || custom.punchs || {};
  Object.keys(customPunches).forEach(key => {
    const item = JSON.parse(JSON.stringify(customPunches[key]));
    item.id = key;
    item.isCustom = true;
    if (!punches.find(p => p.id === key)) {
      punches.push(item);
    }
  });
  
  const customDies = custom.dies || {};
  Object.keys(customDies).forEach(key => {
    const item = JSON.parse(JSON.stringify(customDies[key]));
    item.id = key;
    item.isCustom = true;
    if (!dies.find(d => d.id === key)) {
      dies.push(item);
    }
  });
  
  // Apply stored edits (overrides) to all default/Kyokko/custom tools
  const edits = _toolEditsCache || {};
  punches.forEach(p => {
    if (edits[p.id]) Object.assign(p, edits[p.id]);
  });
  dies.forEach(d => {
    if (edits[d.id]) Object.assign(d, edits[d.id]);
  });
  
  window.KD_TOOLING.punches = punches;
  window.KD_TOOLING.dies = dies;
}

function _saveToolStarFlag(id, fit1mm, common) {
  const updates = { fit1mm: !!fit1mm, common: !!common };
  // Optimistic: update the local edits cache + rebuild + render IMMEDIATELY,
  // so the marker sticks even if a rebuild from another Firebase listener
  // (deleted-defaults / owned-tools) fires before bend_tools_edits echoes
  // back. Without this the saved ★/·/○ flashed back to the catalog default
  // ("เลือกแล้วหาย" — เอ๋ 2026-06-03). The cache is also where _rebuildKDTooling
  // reads overrides, so this makes the choice survive every rebuild + reload.
  _toolEditsCache = _toolEditsCache || {};
  _toolEditsCache[id] = Object.assign({}, _toolEditsCache[id], updates);
  _rebuildKDTooling();
  render();
  // Persist to Firebase (cross-device + reload). The listener will echo the
  // same value, which is now a no-op for the cache.
  try {
    window.firebaseDB.ref(`bend_tools_edits/${id}`).update(updates)
      .catch(e => console.warn('Star flag save failed:', e));
  } catch (e) { console.warn('Star flag error:', e); }
}

function _deleteTool(id, kind, isCustom) {
  const msg = isCustom 
    ? `Are you sure you want to delete this custom tool: ${id}?`
    : `Are you sure you want to delete this default preset tool: ${id}? (This will remove it from the catalog for all projects)`;
  if (!confirm(msg)) return;

  if (isCustom) {
    const pathSegment = kind === 'punch' ? 'punches' : 'dies';
    const refPath = `bend_tools_custom/${pathSegment}/${id}`;
    try {
      window.firebaseDB.ref(refPath).set(null).then(() => {
        _setOwnedTool(id, null);
        render();
      }).catch(e => alert('Error deleting tool: ' + e.message));
    } catch (e) { alert('Database reference error: ' + e.message); }
  } else {
    try {
      window.firebaseDB.ref(`bend_tools_deleted_defaults/${id}`).set(true).then(() => {
        _setOwnedTool(id, null);
        render();
      }).catch(e => alert('Error deleting preset: ' + e.message));
    } catch (e) { alert('Database reference error: ' + e.message); }
  }
}

function getFlattenedCatalog(ownedOnly) {
  const owned = _ownedToolsCache || {};
  let punches = (window.KD_TOOLING.punches || []).map(p => ({ ...p, isKyokkoPreset: false }));
  let dies = (window.KD_TOOLING.dies || []).map(d => ({ ...d, isKyokkoPreset: false }));

  if (ownedOnly) {
    punches = punches.filter(p => owned[p.id]);
    dies = dies.filter(d => owned[d.id]);
  } else {
    (KYOKKO_CATALOG_SERIES.punches || []).forEach(item => {
      item.angles.forEach(angle => {
        item.radii.forEach(r => {
          const modelMapping = {
            "452": { 88: "452", 90: "462" },
            "453": { 88: "453", 90: "463" },
            "045": { 88: "045", 90: "046" },
            "200": { 88: "200", 90: "201" },
            "202": { 88: "202", 90: "203" },
            "109": { 88: "109", 90: "108" },
            "004": { 88: "004", 90: "016" },
            "117": { 88: "117", 90: "116" },
            "047": { 88: "047", 90: "048" }
          };
          const modelNum = (modelMapping[item.series] && modelMapping[item.series][angle]) || item.series;
          const radiusStr = String(r).replace('.', '');
          const id = `P-KYOKKO-${modelNum}-R${radiusStr}`;
          
          if (!punches.find(p => p.id === id)) {
            let label = `Kyokko #${modelNum} Gooseneck ${angle}° · R${r} H${item.height_mm}`;
            if (item.type === 'standard') {
              label = `Kyokko #${modelNum} Straight ${angle}° · R${r} H${item.height_mm}`;
            } else if (item.type === 'sash' || ['200', '201', '202', '203', '210', '211'].includes(modelNum)) {
              label = `Kyokko #${modelNum} Sash ${angle}° · R${r} H${item.height_mm}`;
            }
            const entry = {
              id,
              label,
              type: item.type,
              angle_deg: angle,
              tip_radius_mm: r,
              height_mm: item.height_mm,
              isKyokkoPreset: true
            };
            // Pass through sash dimensions
            if (item.tang_w_mm) entry.tang_w_mm = item.tang_w_mm;
            if (item.body_w_mm) entry.body_w_mm = item.body_w_mm;
            if (item.tip_w_mm) entry.tip_w_mm = item.tip_w_mm;
            if (item.bevel_angle) entry.bevel_angle = item.bevel_angle;
            if (item.neck_w_mm) entry.neck_w_mm = item.neck_w_mm;
            punches.push(entry);
          }
        });
      });
    });

    (KYOKKO_CATALOG_SERIES.dies || []).forEach(item => {
      item.angles.forEach(angle => {
        const vOps = item.type === '1V' ? item.vOpenings.map(v => [v]) : item.vPairs;
        vOps.forEach(vList => {
          const vVal = vList.join(',');
          const height = item.vHeights ? (item.vHeights[vVal] || item.height_mm) : item.height_mm;
          let id = '';
          let label = '';
          if (item.type === '1V') {
            const V = vList[0];
            id = item.series === '1V-H80' ? `D-KYOKKO-1V-V${V}-A${angle}` : `D-KYOKKO-${item.series}-V${V}-A${angle}`;
            label = `Kyokko 1V · V${V} · ${angle}° H${height}`;
          } else {
            const V1 = vList[0], V2 = vList[1];
            id = item.series === '2V-H80' ? `D-KYOKKO-2V-V${V1}_${V2}-A${angle}` : `D-KYOKKO-${item.series}-V${V1}_${V2}-A${angle}`;
            label = `Kyokko 2V · V${V1}/V${V2} · ${angle}° H${height}`;
          }

          if (!dies.find(d => d.id === id)) {
            dies.push({
              id,
              label,
              type: item.type,
              angle_deg: angle,
              v_list: vList,
              height_mm: height,
              isKyokkoPreset: true
            });
          }
        });
      });
    });
  }

  return { punches, dies };
}

function getRecordWithAuto(code, rec) {
  // Web auto-tooling REMOVED (เอ๋ 2026-06-03 'เอามีดและร่องที่ทำไว้ในระบบออโต้ออกให้หมด'):
  // the 2D collision model could not reliably decide bendability or pick owned
  // tools, so the SIM shows Fusion's authoritative result AS-IS and เอ๋ picks
  // punches manually. (searchAutoSequence / runAutoToolingSearch history lives
  // in git ≤ bc86546 if we resume auto once the model is good enough.)
  return rec || null;
}

function renderSimBendHome() {
  _subscribeBendSim();
  _subscribeOwnedTools();
  _subscribeCustomTools();
  _subscribeDeletedDefaults();
  _subscribeSimbendFavs();
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
  
  // Expose the FULL flattened catalog (owned + Kyokko presets) so the SIM's
  // resolvePunch/resolveDie can look up auto-assigned P-KYOKKO-* tools. Without
  // this the sim only saw window.KD_TOOLING (no Kyokko) → fell back to a string
  // heuristic → mislabelled needs-purchase punches as STANDARD and fed wrong
  // geometry to the dynamic collision check (เอ๋ DST200 'PUNCH STANDARD vs table
  // HEMMING' + 'พับได้แต่ขึ้นแดง' for parts only bendable via not-owned tools).
  window.KD_TOOLING_FULL = getFlattenedCatalog(false);

  const processedCache = {};
  codes.forEach(c => {
    processedCache[c] = getRecordWithAuto(c, _bendSimCache[c]);
  });
  
  const q = (SEARCH.value || '').trim().toLowerCase();
  const shown = (q ? codes.filter(c => c.toLowerCase().includes(q)) : codes).sort();

  // Reusable card builder for any code that HAS a processed bend_sim record.
  // Used by the all-parts grid, the ⭐ Favorites strip, and the project dashboard.
  function buildSbCard(code) {
    const rec = processedCache[code] || {};
    const v = _simVerdict(rec);
    const order = Array.isArray(rec.order) && rec.order.length
      ? rec.order.join(' → ') : '—';
    const nb = rec.n_bends != null ? rec.n_bends : (rec.per_bend || []).length;
    const np = rec.n_problems != null ? rec.n_problems : 0;
    const when = rec.checked_at ? String(rec.checked_at).slice(0, 16).replace('T', ' ') : '';
    // Developed (flat) length — shown only once Fusion (CC_CheckBend) exports it
    // (เอ๋ 'ขึ้น Flat: 116.52 mm @ 1.0mm'). Absent → nothing shown (no regression).
    let flatDims = [];
    if (rec.box_geom && rec.box_geom.flat_w != null && rec.box_geom.flat_h != null) {
      let sorted = [+rec.box_geom.flat_w, +rec.box_geom.flat_h].sort(function(a, b) { return b - a; });
      flatDims = [sorted[0].toFixed(2), sorted[1].toFixed(2)];
    } else if (rec.flat_width != null && !isNaN(+rec.flat_width)) {
      let sorted = [+rec.flat_length, +rec.flat_width].sort(function(a, b) { return b - a; });
      flatDims = [sorted[0].toFixed(2), sorted[1].toFixed(2)];
    } else {
      let uniqueFlats = [];
      if (rec.flat_length != null && !isNaN(+rec.flat_length)) uniqueFlats.push(+rec.flat_length);
      if (rec.per_bend && Array.isArray(rec.per_bend)) {
        rec.per_bend.forEach(function(b) {
          if (b.flat_len != null && !isNaN(+b.flat_len)) {
            let val = +b.flat_len;
            if (!uniqueFlats.some(function(existing) { return Math.abs(existing - val) < 0.1; })) {
              uniqueFlats.push(val);
            }
          }
        });
      }
      uniqueFlats.sort(function(a, b) { return b - a; });
      if (uniqueFlats.length > 2) uniqueFlats = [uniqueFlats[0], uniqueFlats[1]]; // Keep max 2 dimensions (W x H)
      flatDims = uniqueFlats.map(function(n) { return n.toFixed(2); });
    }
    
    const flatStr = flatDims.length > 0
      ? ` · <strong style="text-transform:uppercase;">Flat: ${flatDims.join(' x ')} mm</strong>${rec.thickness != null ? ` @ ${(+rec.thickness).toFixed(1)}mm` : ''}`
      : '';
    
    let hasNotOwnedTools = false;
    (rec.per_bend || []).forEach(b => {
      if (b.needs_purchase) hasNotOwnedTools = true;
    });

    let detail = '';
    if (_simBendExpanded === code) {
      // Punch/Die pickers list only tools we OWN (เอ๋ 2026-06-03 'ให้แสดง
      // เฉพาะข้อมูลที่เรามี') — not the whole Kyokko catalog with [NOT OWNED].
      const catalog = getFlattenedCatalog(true);
      const canEdit = isAdmin() || getRole() === 'bend';

      const punchOptsHtml = `<option value="AUTO" selected>Auto (from library)</option>` +
        (catalog.punches || []).map(p => {
          return `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`;
        }).join('');

      const dieOptsHtml = `<option value="AUTO" selected>Auto (from library)</option>` +
        (catalog.dies || []).map(d => {
          return `<option value="${escapeHtml(d.id)}">${escapeHtml(d.label)}</option>`;
        }).join('');

      const orderMap = {};
      (rec.order || []).forEach((id, idx) => { orderMap[id] = idx; });
      const sortedBends = (rec.per_bend || []).slice().sort((a, b_b) => {
        const idxA = orderMap[a.bend] !== undefined ? orderMap[a.bend] : 999;
        const idxB = orderMap[b_b.bend] !== undefined ? orderMap[b_b.bend] : 999;
        return idxA - idxB;
      });

      const rows = sortedBends.map((b, seqIdx) => {
        // Over the punch's flange limit (Fusion's per-bend max_flange): the leg
        // is longer than this punch can clear → collides (เอ๋ 'เกิน...วงแดง';
        // at-or-below = OK). Only active once Fusion exports max_flange.
        const overLimit = b.max_flange != null && b.flange_mm != null && b.flange_mm > b.max_flange;
        const bad = b.ok === false || b.collides || overLimit;
        const why = overLimit
          ? `flange ${b.flange_mm} > max ${(+b.max_flange).toFixed(1)} — change punch`
          : b.collides
          ? `hits ${b.hits || '?'}${b.at_angle != null ? ' @' + Math.round(b.at_angle) + '°' : ''}`
          : (b.reason || (b.ok === false ? 'fail' : 'formable'));
          
        let stepText = `Step ${seqIdx + 1}: ${b.bend}`;
        // Colored dot matching the simulation canvas — uses original bend index
        const bendOrigIdx = (rec.per_bend || []).indexOf(b);
        const dotColor = getBendColor(bendOrigIdx >= 0 ? bendOrigIdx : seqIdx);
        // !important so the bend-colour survives the sketch/chalk theme resets,
        // which override inline backgrounds and left the dots blank (เอ๋ 2026-06-03
        // 'theme อื่นก็ต้องทำสีให้ตรง'). Canvas dots use getBendColor directly so
        // they already match in every theme; this keeps the step-table dots in sync.
        const dotHtml = `<span class="sb-bend-dot" style="background:${dotColor} !important;" title="${escapeHtml(b.bend)}"></span>`;
        if (canEdit) {
          const isFirst = seqIdx === 0;
          const isLast = seqIdx === sortedBends.length - 1;
          stepText = `
            <div style="display: inline-flex; align-items: center; gap: 4px;">
              <span class="nest-move" style="display: inline-flex; flex-direction: column; margin-right: 4px;">
                <button class="sb-step-move-btn sb-step-up" data-bend="${escapeHtml(b.bend)}" aria-label="Move up" title="Move up" style="font-size: 8px; padding: 1px 3px; line-height: 1;" ${isFirst ? 'disabled' : ''}>▲</button>
                <button class="sb-step-move-btn sb-step-down" data-bend="${escapeHtml(b.bend)}" aria-label="Move down" title="Move down" style="font-size: 8px; padding: 1px 3px; line-height: 1;" ${isLast ? 'disabled' : ''}>▼</button>
              </span>
              ${dotHtml}
              <span>Step ${seqIdx + 1}: <strong>${escapeHtml(b.bend)}</strong></span>
            </div>`;
        } else {
          stepText = `<div style="display: inline-flex; align-items: center; gap: 4px;">${dotHtml}<span>Step ${seqIdx + 1}: ${escapeHtml(b.bend)}</span></div>`;
        }

        const warningBadge = b.needs_purchase
          ? `<span class="project-badge missing" style="padding: 1px 4px; font-size: 9px; margin-left: 4px;">Not Owned</span>`
          : '';

        let dieCell = escapeHtml(b.die || '—') + warningBadge;
        let punchCell = escapeHtml(b.punch || '—') + warningBadge;
        let angleCell = `${b.angle_deg != null ? Math.round(b.angle_deg) : ''}°`;
        let flangeCell = `${b.flange_mm != null ? b.flange_mm : ''}`;
        let vCell = `V${b.v_mm != null ? Math.round(b.v_mm) : ''}`;

        if (canEdit) {
          // Problem steps default to ⚙ Auto so the system re-searches a
          // working tool, instead of locking in the failing one (เอ๋ 2026-06-03
          // 'step ไหนพับไม่ได้ ... เปลี่ยนมีด/die เป็น Auto ... เป็น Default').
          punchCell = `<div style="display: flex; align-items: center; gap: 4px;">
            <select class="sb-edit-punch" data-bend="${escapeHtml(b.bend)}" style="background: #16202c; color: #cad6e6; border: 1px solid #2a3744; border-radius: 4px; padding: 2px 4px; font-size: 11px; cursor: pointer;">` +
            `<option value="AUTO" ${bad ? 'selected' : ''}>⚙ Auto</option>` +
            catalog.punches.map(p => {
              const isOwned = _ownedToolsCache && _ownedToolsCache[p.id];
              const ownedLabel = isOwned ? '' : ' [Not Owned]';
              const sel = (!bad && p.id === b.punch) ? 'selected' : '';
              return `<option value="${escapeHtml(p.id)}" ${sel}>${escapeHtml(p.label)}${ownedLabel}</option>`;
            }).join('') +
            `</select>${warningBadge}</div>`;

          dieCell = `<div style="display: flex; align-items: center; gap: 4px;">
            <select class="sb-edit-die" data-bend="${escapeHtml(b.bend)}" style="background: #16202c; color: #cad6e6; border: 1px solid #2a3744; border-radius: 4px; padding: 2px 4px; font-size: 11px; cursor: pointer;">` +
            `<option value="AUTO" ${bad ? 'selected' : ''}>⚙ Auto</option>` +
            catalog.dies.map(d => {
              const isOwned = _ownedToolsCache && _ownedToolsCache[d.id];
              const ownedLabel = isOwned ? '' : ' [Not Owned]';
              const sel = (!bad && d.id === b.die) ? 'selected' : '';
              return `<option value="${escapeHtml(d.id)}" ${sel}>${escapeHtml(d.label)}${ownedLabel}</option>`;
            }).join('') +
            `</select>${warningBadge}</div>`;

          angleCell = `<input type="number" class="sb-edit-angle" data-bend="${escapeHtml(b.bend)}" value="${b.angle_deg != null ? Math.round(b.angle_deg) : 90}" step="1" style="width: 45px; background: #16202c; color: #cad6e6; border: 1px solid #2a3744; border-radius: 4px; padding: 2px; font-size: 11px; text-align: center;">`;
          flangeCell = `<input type="number" class="sb-edit-flange" data-bend="${escapeHtml(b.bend)}" value="${b.flange_mm != null ? b.flange_mm : 35}" step="0.5" style="width: 45px; background: #16202c; color: #cad6e6; border: 1px solid #2a3744; border-radius: 4px; padding: 2px; font-size: 11px; text-align: center;">`;
          vCell = `<input type="number" class="sb-edit-v" data-bend="${escapeHtml(b.bend)}" value="${b.v_mm != null ? Math.round(b.v_mm) : 8}" step="1" style="width: 40px; background: #16202c; color: #cad6e6; border: 1px solid #2a3744; border-radius: 4px; padding: 2px; font-size: 11px; text-align: center;">`;
        }

        return `<tr class="${bad ? 'sb-row-bad' : ''}" data-bend="${escapeHtml(b.bend)}">
          <td>${stepText}</td>
          <td>${punchCell}</td>
          <td>${dieCell}</td>
          <td>${angleCell}</td>
          <td>${flangeCell}</td>
          <td>${vCell}</td>
          <td>${b.tonnage_kN != null ? Math.round(b.tonnage_kN) + 'kN' : ''}</td>
          <td class="sb-note-cell">${escapeHtml(why)}</td></tr>`;
      }).join('');
      
      const saveControlsHtml = canEdit ? `
        <div class="sb-save-container" style="display: flex; gap: 12px; align-items: center; margin-top: 14px;" onclick="event.stopPropagation()">
          <button class="sb-save-btn" style="font-family: inherit; font-size: 12px; font-weight: bold; background: #4ecca3; color: #0c131b; border: none; border-radius: 6px; padding: 8px 16px; cursor: pointer; transition: opacity 0.2s;">Save Config & Step Mapping</button>
          <button class="sb-reset-auto-btn" style="font-family: inherit; font-size: 12px; background: transparent; color: #cad6e6; border: 1px solid #2b3340; border-radius: 6px; padding: 8px 16px; cursor: pointer; transition: opacity 0.2s;">Reset to Auto Plan</button>
          <span class="sb-save-status" style="font-size: 12px; font-weight: bold;"></span>
        </div>` : '';

      const purchaseWarningBanner = hasNotOwnedTools ? `
        <div class="sb-purchase-banner" style="background: rgba(210, 153, 34, 0.15); border: 1px solid #d29922; border-radius: 8px; padding: 10px; margin-bottom: 12px; color: #ffa726; font-size: 12.5px; display: flex; align-items: center; gap: 8px;">
          <span>⚠️</span>
          <span><strong>Not Owned / Needs Purchase:</strong> Some tools in this bend plan are not in your library. Purchase required for production.</span>
        </div>` : '';

      const _wif = _bentSidesFromLegs(rec);
      const whatIfHtml = (_wif && canEdit) ? `
        <div class="sb-whatif" onclick="event.stopPropagation()" style="border-top:1px solid #2b3340; padding-top:10px; margin-top:12px;">
          <div style="font-size:11px; opacity:0.8; margin-bottom:6px;">Leg what-if · <strong>Flat: ${_wif.flatTotal.toFixed(2)} mm</strong> (fixed @ ${_wif.T.toFixed(1)}mm) — change a side, the opposite end adjusts to keep the blank length</div>
          <div class="sb-wif-row" style="display:flex; flex-wrap:wrap; gap:10px; align-items:center;">
            ${_wif.bent.map((b, i) => `<label style="font-size:11px; display:flex; align-items:center; gap:4px;">Side ${i + 1} <input type="number" class="sb-wif-leg" data-idx="${i}" value="${b}" step="0.5" style="width:64px; background:#16202c; color:#cad6e6; border:1px solid #2a3744; border-radius:4px; padding:2px; font-size:11px; text-align:center;"></label>`).join('')}
          </div>
        </div>` : '';

      detail = `
        <div class="sb-detail">
          ${purchaseWarningBanner}
          <div class="sb-sim-wrap">
            ${rec.kind === 'box' ? `
            <div class="sb-sim-cols">
              <div class="sb-sim-col"><div class="sb-sim-col-lbl">2D press</div><div class="sb-2d-canvas-wrap"><button class="sb-fs-btn" type="button" style="background:#18c08c !important;color:#06281f !important;border-color:#0b121a !important">⛶ Full Screen</button><canvas class="sb-sim-canvas-2d"></canvas></div></div>
              <div class="sb-sim-col"><div class="sb-sim-col-lbl">3D isometric</div><canvas class="sb-sim-canvas"></canvas></div>
            </div>` : `<canvas class="sb-sim-canvas"></canvas>`}
            <div class="sb-sim-ctrls" style="flex-wrap: wrap; gap: 10px;">
              <button class="sb-sim-btn sb-sim-play" type="button">⏸ Pause</button>
              <button class="sb-sim-btn sb-sim-rec" type="button">⬇ Clip (.webm)</button>
              <span class="sb-sim-status muted"></span>
            </div>
            <div class="sb-sim-selects-container" style="display: flex; flex-direction: column; gap: 6px; width: 100%; border-top: 1px solid #2b3340; padding-top: 8px; margin-top: 4px;" onclick="event.stopPropagation()">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 11px; opacity: 0.7; font-family: 'Flux Architect', sans-serif; width: 85px; flex-shrink: 0; text-align: left;">Punch:</span>
                <select class="sb-sim-punch-select" style="background: #16202c; color: #cad6e6; border: 1px solid #2a3744; border-radius: 6px; padding: 4px 6px; font-size: 11px; font-family: inherit; cursor: pointer; flex-grow: 1;">
                  ${punchOptsHtml}
                </select>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 11px; opacity: 0.7; font-family: 'Flux Architect', sans-serif; width: 85px; flex-shrink: 0; text-align: left;">Die:</span>
                <select class="sb-sim-die-select" style="background: #16202c; color: #cad6e6; border: 1px solid #2a3744; border-radius: 6px; padding: 4px 6px; font-size: 11px; font-family: inherit; cursor: pointer; flex-grow: 1;">
                  ${dieOptsHtml}
                </select>
              </div>
            </div>
          </div>
          ${rec.reason ? `<div class="sb-reason">${escapeHtml(rec.reason)}</div>` : ''}
          <div class="sb-table-wrap">
          <table class="sb-table">
            <thead><tr><th>step / bend</th><th>punch</th><th>die</th><th>ang</th>
              <th>flange</th><th>V</th><th>ton</th><th>note</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="8" class="muted">no per-bend data</td></tr>'}</tbody>
          </table>
          </div>
          ${whatIfHtml}
          ${saveControlsHtml}
          ${when ? `<div class="sb-when" style="margin-top: 10px;">checked ${escapeHtml(when)}${rec.checked_by ? ' · ' + escapeHtml(rec.checked_by) : ''}</div>` : ''}
        </div>`;
    }

    const warningBadge = hasNotOwnedTools
      ? `<span class="project-badge missing" style="margin-left: 6px; font-size: 10px;">Needs Purchase</span>`
      : '';

    const fav = isFav(code);
    const favBtn = `<button class="sb-fav-btn${fav ? ' is-fav' : ''}" data-code="${escapeHtml(code)}" title="${fav ? 'Remove from favorites' : 'Add to favorites'}" aria-label="Favorite" style="margin-left:auto; background:transparent; border:none; font-size:15px; line-height:1; cursor:pointer; padding:2px 6px; flex-shrink:0; color:${fav ? '#f2a93b' : '#5a6675'};">${fav ? '★' : '☆'}</button>`;

    return `
      <div class="sb-card ${v.cls}${(_simBendExpanded === code && rec.kind === 'box') ? ' sb-card-wide' : ''}" data-code="${escapeHtml(code)}" role="button" tabindex="0">
        <div class="sb-card-head">
          <span class="sb-code" title="${escapeHtml(code)}">${escapeHtml(displayCodeFor(code))}</span>
          <span class="sb-chip ${v.cls}">${v.txt}</span>
          ${(() => { const cabs = _sbFreshCtx.codeCab.get(code) || []; const fresh = cabs.some(c => { const f = _sbFreshCtx.cabFresh.get(c); return f && (f.status === 'new' || f.status === 'changed'); }); return fresh ? '<span class="part-new-badge" title="belongs to a new/changed cabinet">●</span>' : ''; })()}
          ${warningBadge}
          ${_bendRecheckChip(code)}
          ${_outdatedChips(code, { clickable: true })}
          ${_sbFusionBtnHtml(code)}
          ${favBtn}
          ${isAdmin() ? `<button class="sb-del-btn" data-code="${escapeHtml(code)}" title="Delete this bend record" aria-label="Delete" style="background:transparent; border:none; color:#e0574a; font-size:15px; line-height:1; cursor:pointer; padding:2px 8px; flex-shrink:0;">✕</button>` : ''}
        </div>
        <div class="sb-meta">${nb} bend${nb === 1 ? '' : 's'}${np ? ` · ${np} problem${np === 1 ? '' : 's'}` : ''} · order: ${escapeHtml(order)}${flatStr}</div>
        ${detail}
      </div>`;
  }

  // Compact card for a part with a flat DXF but NO Fusion verdict yet — preview
  // only (bend count + flat dims), NOT a feasibility claim. Non-expandable.
  function buildDxfPreviewCard(code, info) {
    const fav = isFav(code);
    const favBtn = `<button class="sb-fav-btn${fav ? ' is-fav' : ''}" data-code="${escapeHtml(code)}" title="${fav ? 'Remove from favorites' : 'Add to favorites'}" aria-label="Favorite" style="margin-left:auto; background:transparent; border:none; font-size:15px; line-height:1; cursor:pointer; padding:2px 6px; flex-shrink:0; color:${fav ? '#f2a93b' : '#5a6675'};">${fav ? '★' : '☆'}</button>`;
    const dims = (info.w != null && info.h != null) ? ` · <strong style="text-transform:uppercase;">Flat: ${(+info.w).toFixed(1)} x ${(+info.h).toFixed(1)} mm</strong>` : '';
    const nb = info.nBends || 0;
    return `
      <div class="sb-card sb-warn sb-card-dxf" data-code="${escapeHtml(code)}">
        <div class="sb-card-head">
          <span class="sb-code" title="${escapeHtml(code)}">${escapeHtml(displayCodeFor(code))}</span>
          <span class="sb-chip sb-warn" title="Geometry from flat DXF — not yet verified in Fusion (run CC_CheckBend)">◍ DXF · not checked</span>
          ${_sbFusionBtnHtml(code)}
          ${favBtn}
        </div>
        <div class="sb-meta">${nb} bend${nb === 1 ? '' : 's'} (from flat DXF)${dims} · <span class="muted">export to Fusion to verify feasibility</span></div>
      </div>`;
  }

  // Tiny one-line row (flat panels with 0 bends, or parts with no data at all).
  function buildSbMiniRow(code, kind) {
    const fav = isFav(code);
    const favBtn = `<button class="sb-fav-btn${fav ? ' is-fav' : ''}" data-code="${escapeHtml(code)}" title="${fav ? 'Remove from favorites' : 'Add to favorites'}" aria-label="Favorite" style="background:transparent; border:none; font-size:13px; line-height:1; cursor:pointer; padding:0 4px; flex-shrink:0; color:${fav ? '#f2a93b' : '#5a6675'};">${fav ? '★' : '☆'}</button>`;
    const label = kind === 'flat'
      ? `<span class="muted">0 bends (flat panel)</span>`
      : `<span class="muted">no data — export flat DXF</span>`;
    return `
      <div class="sb-mini-row" data-code="${escapeHtml(code)}" style="display:flex; align-items:center; gap:8px; padding:5px 10px; border-bottom:1px solid rgba(128,140,160,0.12); font-size:12px;">
        ${favBtn}
        <span class="sb-code" title="${escapeHtml(code)}" style="font-weight:600;">${escapeHtml(displayCodeFor(code))}</span>
        ${label}
        ${_sbFusionBtnHtml(code)}
      </div>`;
  }

  // ── Favorites strip (pinned, always on top) ───────────────────────────────
  const favCodes = Object.keys(_favsCache).filter(c => c && _favsCache[c]).sort();
  let favsHtml = '';
  if (favCodes.length) {
    const favCards = favCodes.map(c => {
      if (processedCache[c]) return buildSbCard(c);
      const probe = _simBendSync && _simBendSync.byCode && _simBendSync.byCode[c];
      if (probe && probe.status === 'dxf') return buildDxfPreviewCard(c, probe);
      if (probe && (probe.status === 'flat' || probe.status === 'none')) return buildSbMiniRow(c, probe.status === 'flat' ? 'flat' : 'none');
      return buildSbMiniRow(c, 'none');
    }).join('');
    favsHtml = `
      <div class="sb-fav-section">
        <div class="sb-section-head">⭐ Favorites <span class="muted" style="font-weight:normal;">(${favCodes.length})</span></div>
        <div class="sb-grid">${favCards}</div>
      </div>`;
  }

  // ── Project sync bar ──────────────────────────────────────────────────────
  // NEW marking (เอ๋ 2026-06-10): options carry "· NEW"; since a closed <select>
  // hides them, the bar ALSO shows an amber "N NEW" pill naming the projects.
  const sbProjs = (typeof projectList === 'function' ? projectList() : []);
  const sbNewKeys = sbProjs.filter(p => isNewProject('sim', p.key, p)).map(p => p.key);
  const projOpts = sbProjs
    .map(p => `<option value="${escapeHtml(p.key)}"${_simBendProject === p.key ? ' selected' : ''}>${escapeHtml(p.name || p.key)}${sbNewKeys.includes(p.key) ? ' · NEW' : ''}</option>`)
    .join('');
  const sbNewPill = sbNewKeys.length
    ? `<span class="part-new-badge" title="${escapeHtml(sbNewKeys.join(', '))}">${sbNewKeys.length} NEW</span>` : '';
  const syncBar = `
    <div class="sb-sync-bar" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:10px 0;">
      <strong style="font-size:12px;">Sync from project:</strong>
      <select class="sb-proj-select" style="background:#16202c; color:#cad6e6; border:1px solid #2a3744; border-radius:6px; padding:5px 8px; font-size:12px; font-family:inherit; cursor:pointer; min-width:160px;">
        <option value=""${!_simBendProject ? ' selected' : ''}>All checked parts</option>
        ${projOpts}
      </select>
      <button class="sb-sync-btn" style="font-family:inherit; font-size:12px; font-weight:bold; background:#18c08c; color:#06281f; border:none; border-radius:6px; padding:6px 14px; cursor:pointer;">↻ Sync</button>
      ${sbNewPill}
      <span class="sb-sync-status muted" style="font-size:12px;"></span>
    </div>`;

  let mainHtml;
  if (_simBendProject && _simBendSync && _simBendSync.key === _simBendProject) {
    // ── Project dashboard ──
    const by = _simBendSync.byCode || {};
    let allCodes = Object.keys(by);
    if (q) allCodes = allCodes.filter(c => c.toLowerCase().includes(q) || displayCodeFor(c).toLowerCase().includes(q));
    allCodes.sort();
    const verified = allCodes.filter(c => by[c].status === 'verified');
    const dxf = allCodes.filter(c => by[c].status === 'dxf');
    const flat = allCodes.filter(c => by[c].status === 'flat');
    const none = allCodes.filter(c => by[c].status === 'none');
    const checking = allCodes.filter(c => by[c].status === 'checking');
    // Cabinet freshness (bend role) — banner of new/changed cabinets + per-card
    // dot for codes that belong to one (เอ๋ 2026-06-11). Engine is global.
    const _cabFresh = (typeof cabinetFreshnessAll === 'function') ? cabinetFreshnessAll('bend', _simBendProject) : new Map();
    const _codeCab = new Map();
    if (typeof _cabinetCodeQty === 'function') {
      for (const [cab, codes] of _cabinetCodeQty(_simBendProject)) for (const code of codes.keys()) {
        if (!_codeCab.has(code)) _codeCab.set(code, []);
        _codeCab.get(code).push(cab);
      }
    }
    _sbFreshCtx = { cabFresh: _cabFresh, codeCab: _codeCab };
    const _freshCabs = [..._cabFresh].filter(([, i]) => i.status === 'new' || i.status === 'changed');
    const _freshBanner = _freshCabs.length ? `
      <div class="sb-dash-section sb-fresh-banner">
        <div class="sb-section-head">New / changed cabinets to bend (${_freshCabs.length})
          <button class="sb-cabs-seen" title="Mark every cabinet seen for the bend role">Mark all seen</button></div>
        <div class="sb-fresh-cabs">${_freshCabs.map(([cab, i]) =>
          `<span class="sb-fresh-cab ${i.status}" data-cab="${escapeHtml(cab || NO_CAB)}" title="double-click = seen">${escapeHtml(cab ? displayCodeFor(cab) : 'No cabinet / shared')} ${i.status === 'new' ? 'NEW' : '↻'}${cab ? _glb3dStaleChip(cab) : ''}</span>`
        ).join('')}</div>
      </div>` : '';
    COUNT_EL.textContent = `${verified.length}/${_simBendSync.total} verified`;
    const pct = _simBendSync.total ? Math.round(100 * _simBendSync.done / _simBendSync.total) : 100;
    const progressHtml = `
      <div style="margin:4px 0 12px;">
        <div style="font-size:12px; margin-bottom:4px;">📁 <strong>${escapeHtml((manifest.projects[_simBendProject] && manifest.projects[_simBendProject].name) || _simBendProject)}</strong> — ${verified.length}/${_simBendSync.total} verified${_simBendSync.running ? ` · checking ${_simBendSync.done}/${_simBendSync.total}…` : ''}</div>
        <div style="height:6px; background:rgba(128,140,160,0.2); border-radius:3px; overflow:hidden;"><div style="height:100%; width:${pct}%; background:#18c08c; transition:width .2s;"></div></div>
      </div>`;
    const section = (title, body) => body ? `<div class="sb-dash-section"><div class="sb-section-head">${title}</div>${body}</div>` : '';
    mainHtml = `
      ${_freshBanner}
      ${progressHtml}
      ${section(`✓ Verified <span class="muted" style="font-weight:normal;">(${verified.length})</span>`, verified.length ? `<div class="sb-grid">${verified.map(buildSbCard).join('')}</div>` : '')}
      ${section(`◍ From flat DXF — not checked in Fusion <span class="muted" style="font-weight:normal;">(${dxf.length})</span>`, dxf.length ? `<div class="sb-grid">${dxf.map(c => buildDxfPreviewCard(c, by[c])).join('')}</div>` : '')}
      ${section(`▭ Flat panels — 0 bends <span class="muted" style="font-weight:normal;">(${flat.length})</span>`, flat.length ? `<div class="sb-mini-list">${flat.map(c => buildSbMiniRow(c, 'flat')).join('')}</div>` : '')}
      ${section(`✕ No data — export flat DXF <span class="muted" style="font-weight:normal;">(${none.length})</span>`, none.length ? `<div class="sb-mini-list">${none.map(c => buildSbMiniRow(c, 'none')).join('')}</div>` : '')}
      ${checking.length ? `<div class="muted" style="padding:8px; font-size:12px;">checking ${checking.length} more…</div>` : ''}`;
  } else {
    // ── All checked parts (default) ── no project context → no cabinet freshness
    _sbFreshCtx = { cabFresh: new Map(), codeCab: new Map() };
    COUNT_EL.textContent = `${shown.length} part${shown.length === 1 ? '' : 's'} checked`;
    mainHtml = `<div class="sb-grid">${shown.map(buildSbCard).join('')}</div>`;
  }

  ROOT.innerHTML = `
    <div class="sb-home">
      ${picker}
      ${syncBar}
      ${favsHtml}
      <div class="sb-banner">🔩 Sim.Bending — press-brake feasibility per part</div>
      ${mainHtml}
    </div>`;

  _wireToolingPicker();
  // Cabinet freshness controls (bend role): banner "Mark all seen" + per-chip
  // double-click acknowledge.
  ROOT.querySelector('.sb-cabs-seen')?.addEventListener('click', () => {
    if (typeof markAllCabinetsSeen === 'function' && _simBendProject) { markAllCabinetsSeen('bend', _simBendProject); render(); }
  });
  ROOT.querySelectorAll('.sb-fresh-cab').forEach(el => el.addEventListener('dblclick', () => {
    if (typeof markCabinetSeen !== 'function' || !_simBendProject) return;
    const cab = el.dataset.cab === NO_CAB ? '' : el.dataset.cab;
    const cq = _cabinetCodeQty(_simBendProject).get(cab) || new Map();
    markCabinetSeen('bend', _simBendProject, cab, _cabinetFingerprint(cq));
    render();
  }));
  ROOT.querySelectorAll('.sb-card:not(.sb-card-dxf)').forEach(el => {
    const toggle = () => {
      const c = el.getAttribute('data-code');
      _simBendExpanded = (_simBendExpanded === c) ? null : c;
      render();
    };
    el.addEventListener('click', (e) => {
      if (e.target.closest && (e.target.closest('.sb-sim-wrap') || e.target.closest('.sb-table') || e.target.closest('.sb-save-container') || e.target.closest('.sb-del-btn') || e.target.closest('.sb-fav-btn') || e.target.closest('.sb-fusion-btn'))) return;
      toggle();
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });

  // ⭐ Favorite toggle (every card + mini-row) — open to everyone, persists to
  // RTDB simbend_favs/<code>. The .on('value') listener re-renders.
  ROOT.querySelectorAll('.sb-fav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = btn.getAttribute('data-code');
      if (c) toggleFav(c);
    });
  });

  // Open-in-Fusion (every card + mini-row) — same shared leaf router as the
  // bend-list button (bridge :8765, retry, friendly alerts). stopPropagation
  // so the click never expands/collapses the card — works on a COLLAPSED card
  // (เอ๋ 2026-06-11, RD extension 25c3d86). urn resolved across all manifest
  // projects (_urnForCode); missing urn -> the router's instructive alert.
  ROOT.querySelectorAll('.sb-fusion-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = btn.getAttribute('data-code');
      if (c) _routeLeafToFusion({ code: c, urn: _urnForCode(c) }, { fusionOnly: true });
    });
  });

  // Project picker + Sync — turns the home into a per-project bending dashboard.
  const projSel = ROOT.querySelector('.sb-proj-select');
  const syncBtn = ROOT.querySelector('.sb-sync-btn');
  const syncStatus = ROOT.querySelector('.sb-sync-status');
  if (syncStatus && _simBendSync && _simBendSync.key === _simBendProject) {
    syncStatus.textContent = _simBendSync.running
      ? `checking ${_simBendSync.done}/${_simBendSync.total}…`
      : `${_simBendSync.done}/${_simBendSync.total} parts scanned`;
  }
  if (projSel) {
    projSel.addEventListener('change', () => {
      const key = projSel.value || '';
      _simBendExpanded = null;
      if (key) { markProjectSeen('sim', key); _runProjectSync(key); }   // async; renders progressively
      else { _simBendProject = null; _simBendSync = null; render(); }
    });
  }
  if (syncBtn) {
    syncBtn.addEventListener('click', () => {
      const key = (projSel && projSel.value) || _simBendProject || '';
      _simBendExpanded = null;
      if (key) { markProjectSeen('sim', key); _runProjectSync(key); }
      else { _simBendProject = null; _simBendSync = null; render(); }
    });
  }

  // Delete a bend record (admin only) — เอ๋ 'เพิ่มปุ่มให้ลบงานที่ไม่ต้องการทิ้งได้'.
  // Hard-removes bend_sim/<code>; the listener re-renders. (Re-running Check Bend
  // in Fusion re-creates it, so no soft-delete needed.)
  ROOT.querySelectorAll('.sb-del-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = btn.getAttribute('data-code');
      if (!c) return;
      if (!confirm(`Delete bend record "${c}"? This removes it from the list (re-run Check Bend in Fusion to bring it back).`)) return;
      if (_simBendExpanded === c) _simBendExpanded = null;
      try { window.firebaseDB.ref('bend_sim/' + c).remove(); } catch (err) { alert('Delete failed: ' + err.message); }
    });
  });

  // เอ๋ 2026-06-07: reusable destroy + re-mount of the bend sim so a live FLAN
  // edit can re-extrude the flange / refresh the on-part number / re-run collision
  // (a what-if). Mounts the 3-D iso for box parts, the 2-D press sim otherwise,
  // plus the side 2-D column for box parts. Returns the `.sb-card` element (or
  // null when nothing is expanded) so callers can keep wiring `card`/`rec`.
  function _remountSimBend() {
    if (_simController) { try { _simController.destroy(); } catch (e) {} _simController = null; }
    if (_simController2D) { try { _simController2D.destroy(); } catch (e) {} _simController2D = null; }
    if (!_simBendExpanded || !window.kdSimBend) return null;
    const card = ROOT.querySelector(`.sb-card[data-code="${_simBendExpanded.replace(/"/g, '')}"]`);
    const canvas = card && card.querySelector('.sb-sim-canvas');
    const canvas2d = card && card.querySelector('.sb-sim-canvas-2d');   // box only
    const rec = processedCache[_simBendExpanded];
    if (!canvas || !rec) return card;
    // Box parts (kind:"box") → 3-D isometric pan fold (simbend-3d.js); linear → 2-D press sim.
    _simController = (rec.kind === 'box' && window.kdSimBend3D)
      ? window.kdSimBend3D.mount(canvas, rec, _simBendExpanded)
      : window.kdSimBend.mount(canvas, rec, _simBendExpanded);
    // For box parts also mount the original 2-D press sim beside it (left column)
    // — เอ๋ 'แบบเดิมถูกแล้ว' (the original 2-D view was correct).
    if (canvas2d) {
      _simController2D = (rec.kind === 'box' && window.kdSimBend3D)
        ? window.kdSimBend3D.mount2d(canvas2d, rec, _simBendExpanded)
        : (window.kdSimBend ? window.kdSimBend.mount(canvas2d, rec, _simBendExpanded) : null);
    }
    // เอ๋ 2026-06-08: if a flat-pattern DXF was uploaded for this part, UPGRADE the 3-D pane to the
    // accurate DXF-folded render (box_geom above shows instantly; this swaps in when the fetch
    // resolves). Async + non-breaking — _remountSimBend stays sync. 404/parse-fail → keep box_geom.
    // (2-D press stays box_geom for now — true DXF cross-section is a follow-up.)
    if (rec.kind === 'box' && window.kdSimBend3D_AI && window.kdSimBend3D_AI.mountFromFlat &&
        window.KD_DXFFLAT && rec.box_geom) {
      const _code = _simBendExpanded;
      // flat/ first, laser-copy fallback (same chain as the sync probe) + no-store
      _fetchFlatDxfText(_code).then(text => {
        if (!text || _simBendExpanded !== _code) return;                    // expanded card changed/closed
        const flat = window.KD_DXFFLAT.parseFlatDxf(text); if (!flat || !flat.bends.length) return;
        // 3-D fold order from wallsFromFlat (เอ๋ 2026-06-08) — the SAME clean heuristic the 2-D press
        // uses, so 2-D/3-D tell one story (lip→return→wall, every step folds + shows the clip). Falls
        // back to mergeBends (box_geom-garbage steps) only if the heuristic can't derive walls.
        const bends = window.KD_DXFFLAT.foldBendsFromFlat(flat)
          || window.KD_DXFFLAT.mergeBends(flat, rec.per_bend || [], (rec.box_geom.walls) || []);
        const card2 = ROOT.querySelector(`.sb-card[data-code="${_code.replace(/"/g, '')}"]`);
        const cv3 = card2 && card2.querySelector('.sb-sim-canvas');
        const cv2 = card2 && card2.querySelector('.sb-sim-canvas-2d');
        if (!cv3) return;
        if (_simController && _simController.destroy) { try { _simController.destroy(); } catch (e) {} }
        _simController = window.kdSimBend3D_AI.mountFromFlat(cv3, flat, bends, rec, _code);
        // 2-D press REBUILT (เอ๋ 2026-06-08 "ทำใหม่ — DXF ล้วน + เดา step เอง"): the previous
        // mount2dFromFlat drew raw cross-section segments = "เพี้ยนมากว่าเดิม". Fusion's box_geom is
        // mis-derived for this tray, so derive REAL walls from the DXF (KD_DXFFLAT.wallsFromFlat —
        // full-span flanges, heuristic fold order + gooseneck) and feed the MATURE mount2d, which
        // brings collision/freeze/dim-labels/clearance/per-step-punch but now at DXF-true sizes.
        if (cv2 && window.kdSimBend3D_AI.mount2d && window.KD_DXFFLAT.wallsFromFlat) {
          const wf = window.KD_DXFFLAT.wallsFromFlat(flat);
          if (wf && wf.walls && wf.walls.length) {
            const synthetic = { kind: 'box', box_geom: { base: wf.base, walls: wf.walls, flat_w: wf.flat_w, flat_h: wf.flat_h }, per_bend: wf.per_bend };
            if (_simController2D && _simController2D.destroy) { try { _simController2D.destroy(); } catch (e) {} }
            _simController2D = window.kdSimBend3D_AI.mount2d(cv2, synthetic, _code);
          }
        }
      }).catch(() => {});
    }
    return card;
  }

  const card = _remountSimBend();
  if (_simBendExpanded && window.kdSimBend && card) {
    const rec = processedCache[_simBendExpanded];
    if (card.querySelector('.sb-sim-canvas') && rec) {
      const playBtn = card.querySelector('.sb-sim-play');
      const recBtn = card.querySelector('.sb-sim-rec');
      const status = card.querySelector('.sb-sim-status');
      // เอ๋ 2026-06-07: Full-Screen toggle for the 2D press (button top-left → CSS pseudo-fullscreen
      // → label becomes '← Back'). CSS-class based so it works on iPad too. The canvas's own
      // ResizeObserver re-fits it to the new box; a resize event nudges it as a backup.
      const fsBtn = card.querySelector('.sb-fs-btn');
      const fsWrap = card.querySelector('.sb-2d-canvas-wrap');
      if (fsBtn && fsWrap) {
        fsBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const on = fsWrap.classList.toggle('sb-fs-on');
          document.body.classList.toggle('sb-fs-lock', on);
          fsBtn.textContent = on ? '← Back' : '⛶ Full Screen';
          try { window.dispatchEvent(new Event('resize')); } catch (err) {}
        });
      }
      // เอ๋: highlight the bend-table row for the step currently being folded.
      const highlightActiveRow = (bendId) => {
        const table = card.querySelector('.sb-table');
        if (!table) return;
        table.querySelectorAll('tbody tr.sb-row-active').forEach(r => {
          r.classList.remove('sb-row-active');
          r.style.removeProperty('--sb-active-col');
        });
        if (bendId == null) return;
        const row = table.querySelector(`tbody tr[data-bend="${String(bendId).replace(/"/g, '')}"]`);
        if (row) {
          // Colour the active-row frame to MATCH this step's own colour — read the row's
          // bend dot so the box 'ตรงกับ Step ที่พับ' in every theme (เอ๋), not a fixed red.
          const dot = row.querySelector('.sb-bend-dot');
          const col = dot ? getComputedStyle(dot).backgroundColor : '';
          if (col) row.style.setProperty('--sb-active-col', col);
          row.classList.add('sb-row-active');
        }
      };

      const punchSel = card.querySelector('.sb-sim-punch-select');
      const dieSel = card.querySelector('.sb-sim-die-select');
      
      const updateToolOverrides = () => {
        const cat = getFlattenedCatalog(false);
        const pId = punchSel ? punchSel.value : 'AUTO';
        const dId = dieSel ? dieSel.value : 'AUTO';
        if (pId === 'AUTO') {
          if (_simController && _simController.setPunchOverride) {
            _simController.setPunchOverride('AUTO', 'AUTO');
          }
          if (_simController2D && _simController2D.setPunchOverride) {
            _simController2D.setPunchOverride('AUTO', 'AUTO');
          }
        } else {
          const pObj = cat.punches.find(p => p.id === pId);
          if (pObj) {
            if (_simController && _simController.setPunchOverride) {
              _simController.setPunchOverride(pObj.id, pObj.type);
            }
            if (_simController2D && _simController2D.setPunchOverride) {
              _simController2D.setPunchOverride(pObj.id, pObj.type);
            }
          }
        }
        if (dId === 'AUTO') {
          if (_simController && _simController.setDieOverride) {
            _simController.setDieOverride('AUTO', 'AUTO', 'AUTO', 'AUTO', 'AUTO');
          }
          if (_simController2D && _simController2D.setDieOverride) {
            _simController2D.setDieOverride('AUTO', 'AUTO', 'AUTO', 'AUTO', 'AUTO');
          }
        } else {
          const dObj = cat.dies.find(d => d.id === dId);
          if (dObj) {
            const v = dObj.v_list ? dObj.v_list[0] : 8;
            if (_simController && _simController.setDieOverride) {
              _simController.setDieOverride(dObj.id, v, dObj.angle_deg || 88, dObj.type, dObj.v_list);
            }
            if (_simController2D && _simController2D.setDieOverride) {
              _simController2D.setDieOverride(dObj.id, v, dObj.angle_deg || 88, dObj.type, dObj.v_list);
            }
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
      }

      _simController.onstatus = (t) => { if (status) status.textContent = t; };
      _simController.onactive = (bendId) => highlightActiveRow(bendId);
      if (_simController2D) _simController2D.onactive = (bendId) => highlightActiveRow(bendId);

      if (playBtn) playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _simController.toggle();
        if (_simController2D) { try { _simController2D.toggle(); } catch (e2) {} }   // keep both columns in sync
        playBtn.textContent = _simController.isPlaying() ? '⏸ Pause' : '▶ Play';
      });
      if (recBtn) recBtn.addEventListener('click', (e) => {
        e.stopPropagation(); _simController.recordClip();
      });

      const onOverrideChange = () => {
        const table = card.querySelector('.sb-table');
        if (!table) return;
        
        rec.checked_by = 'web_override';
        
        table.querySelectorAll('tbody tr').forEach(row => {
          const bendId = row.getAttribute('data-bend');
          const b = rec.per_bend.find(x => x.bend === bendId);
          if (!b) return;
          
          b.is_override = true;
          
          const pSel = row.querySelector('.sb-edit-punch');
          if (pSel) {
            b.punch = pSel.value;
            b.punch_out = pSel.value;
          }
          
          const dSel = row.querySelector('.sb-edit-die');
          if (dSel) {
            b.die = dSel.value;
            b.die_out = dSel.value;
          }
          
          const aInput = row.querySelector('.sb-edit-angle');
          if (aInput) {
            const vVal = parseFloat(aInput.value);
            if (!isNaN(vVal)) {
              b.angle_deg = vVal;
              b.angle_deg_out = vVal;
            }
          }
          
          const fInput = row.querySelector('.sb-edit-flange');
          if (fInput) {
            const vVal = parseFloat(fInput.value);
            if (!isNaN(vVal)) {
              b.flange_mm = vVal;
              b.flange_mm_out = vVal;
            }
          }
          
          const vInput = row.querySelector('.sb-edit-v');
          if (vInput) {
            const vVal = parseFloat(vInput.value);
            if (!isNaN(vVal)) {
              b.v_mm = vVal;
              b.v_mm_out = vVal;
            }
          }
          if (rec.box_geom && rec.box_geom.walls) {
            const wObj = rec.box_geom.walls.find(w => w.id === b.bend);
            if (wObj) {
              wObj.punch = b.punch;
              wObj.die = b.die;
              wObj.angle_deg = b.angle_deg;
              wObj.flat_len = b.flange_mm;
              wObj.height = b.flange_mm;   // drive 2D label + 2D/3D length + collision (เอ๋ 2026-06-07)
              if (b.punch === 'gooseneck' || b.punch === 'GN-453-AUTO' || b.punch === 'P-KYOKKO-453-R02') {
                wObj.needs_gooseneck = true;
              }
            }
          }
        });

        const N = rec.per_bend.length;
        const catalog = getFlattenedCatalog(false);
        const model = window.kdSimBend.buildModel(rec);
        
        let nProblems = 0;
        
        rec.per_bend.forEach((b, i) => {
          let pId = b.punch;
          if (!pId || pId === 'AUTO') {
            const useGoose = !!(rec.box_geom && (rec.box_geom.walls || []).some(w => w.needs_gooseneck || w.punch === 'gooseneck'));
            pId = useGoose ? 'GN-453-AUTO' : 'P-KYOKKO-202-R02';
          }
          const punchObj = catalog.punches.find(p => p.id === pId);
          
          let dId = b.die;
          if (!dId || dId === 'AUTO') {
            dId = 'D-1V-V08-88';
          }
          const dieObj = catalog.dies.find(d => d.id === dId);
          
          let pType = 'standard', pAngle = 88, pRadius = 0.8, pHeight = 120;
          if (punchObj) {
            pType = punchObj.type || 'standard';
            pAngle = punchObj.angle_deg != null ? punchObj.angle_deg : 88;
            pRadius = punchObj.tip_radius_mm != null ? punchObj.tip_radius_mm : 0.8;
            pHeight = punchObj.height_mm != null ? punchObj.height_mm : 120;
          } else {
            const typeStr = (pId || '').toLowerCase();
            if (typeStr.indexOf('gn') >= 0 || typeStr.indexOf('gooseneck') >= 0 || typeStr.indexOf('453') >= 0) {
              pType = 'gooseneck'; pHeight = 150;
            } else if (typeStr.indexOf('acute') >= 0) {
              pType = 'acute'; pHeight = 120;
            } else if (typeStr.indexOf('sash') >= 0 || typeStr.indexOf('202') >= 0) {
              pType = 'sash'; pHeight = 130;
            }
          }
          const punch = { type: pType, angle: pAngle, radius: pRadius, height: pHeight };
          
          let dType = '1V', dAngle = 88, dV = b.v_mm || 8, dHeight = 60, dVList = [b.v_mm || 8];
          if (dieObj) {
            dType = dieObj.type || '1V';
            dAngle = dieObj.angle_deg != null ? dieObj.angle_deg : 88;
            dHeight = dieObj.height_mm != null ? dieObj.height_mm : 60;
            dVList = dieObj.v_list || [b.v_mm || 8];
            dV = dVList[0] || 8;
          } else {
            const typeStr = (dId || '').toLowerCase();
            if (typeStr.indexOf('acute') >= 0) dType = 'acute';
            else if (typeStr.indexOf('2v') >= 0) dType = '2V';
          }
          const die = { type: dType, angle: dAngle, v: dV, height: dHeight, vList: dVList };
          
          const V = die.vList ? die.vList[0] : (die.v || 8);
          const angleOk = die.angle <= b.angle_deg + 2.0;
          const flangeOk = b.flange_mm >= 0.67 * V;
          
          let ok = angleOk && flangeOk;
          let reasons = [];
          if (!angleOk) reasons.push("die angle too obtuse");
          if (!flangeOk) reasons.push("flange too short for V");
          
          const a = new Array(N).fill(0);
          const currentSeqIdx = rec.order.indexOf(b.bend);
          if (currentSeqIdx !== -1) {
            rec.order.forEach((idxName, orderIdx) => {
              if (orderIdx <= currentSeqIdx) {
                const bendIndex = rec.per_bend.findIndex(x => x.bend === idxName);
                if (bendIndex >= 0) {
                  a[bendIndex] = rec.per_bend[bendIndex].angle_deg;
                }
              }
            });
          } else {
            const bendIndex = rec.per_bend.findIndex(x => x.bend === b.bend);
            if (bendIndex >= 0) {
              a[bendIndex] = b.angle_deg;
            }
          }
          const currentBendIdx = rec.per_bend.findIndex(x => x.bend === b.bend);
          
          // เอ๋ 'อย่าเตือนมั่ว ไม่ชนก็เตือน': do NOT run the 2D collision model on a tool
          // override — checkCollisionAt false-flags 'hits @0°' (a collision on the FLAT
          // sheet). Web auto-collision was already dropped as unreliable; real press
          // collisions are shown live in the SIM (geometry-based stacked-wall check).
          // Trust the die-angle / flange-vs-V checks + Fusion's result only.
          b.ok = ok;
          b.collides = false;
          b.hits = null;
          b.at_angle = null;
          b.reason = reasons.join('; ') || 'formable';
          b.needs_purchase = (punchObj && punchObj.isKyokkoPreset) || (dieObj && dieObj.isKyokkoPreset);

          if (rec.box_geom && rec.box_geom.walls) {
            const wObj = rec.box_geom.walls.find(w => w.id === b.bend);
            if (wObj) {
              wObj.collides = false;
              wObj.collides_with = null;
            }
          }
          
          if (!b.ok) {
            nProblems++;
          }
          
          const rowEl = table.querySelector(`tbody tr[data-bend="${escapeHtml(b.bend)}"]`);
          if (rowEl) {
            rowEl.className = b.ok ? '' : 'sb-row-bad';
            const noteEl = rowEl.querySelector('.sb-note-cell');
            if (noteEl) noteEl.textContent = b.reason;
            
            const badges = rowEl.querySelectorAll('.project-badge.missing');
            if (b.needs_purchase) {
              if (badges.length === 0) {
                const pSelWrap = rowEl.querySelector('.sb-edit-punch')?.parentNode;
                const dSelWrap = rowEl.querySelector('.sb-edit-die')?.parentNode;
                pSelWrap?.appendChild(document.createRange().createContextualFragment(`<span class="project-badge missing" style="padding: 1px 4px; font-size: 9px; margin-left: 4px;">Not Owned</span>`));
                dSelWrap?.appendChild(document.createRange().createContextualFragment(`<span class="project-badge missing" style="padding: 1px 4px; font-size: 9px; margin-left: 4px;">Not Owned</span>`));
              }
            } else {
              badges.forEach(badge => badge.remove());
            }
          }
        });
        
        rec.n_problems = nProblems;
        rec.bendable = nProblems === 0;
        // keep box parts as kind:"box" so the 3-D isometric stays mounted after a
        // tool change (เอ๋: right column must stay isometric) — only linear parts flip.
        if (rec.kind !== 'box') rec.kind = rec.bendable ? 'found' : 'impossible';
        rec.reason = rec.bendable ? '' : 'one or more bends have problems';
        
        if (_simController) {
          _simController.destroy();
          if (_simController2D) { try { _simController2D.destroy(); } catch (e2) {} _simController2D = null; }
          // Box parts (kind:"box") → 3-D isometric pan fold (simbend-3d.js); linear → 2-D press sim.
          _simController = (rec.kind === 'box' && window.kdSimBend3D)
            ? window.kdSimBend3D.mount(canvas, rec, _simBendExpanded)
            : window.kdSimBend.mount(canvas, rec, _simBendExpanded);
          const canvas2d = card.querySelector('.sb-sim-canvas-2d');
          if (canvas2d) {
            _simController2D = (rec.kind === 'box' && window.kdSimBend3D)
              ? window.kdSimBend3D.mount2d(canvas2d, rec, _simBendExpanded)
              : (window.kdSimBend ? window.kdSimBend.mount(canvas2d, rec, _simBendExpanded) : null);
          }
          _simController.onstatus = (t) => { if (status) status.textContent = t; };
      _simController.onactive = (bendId) => highlightActiveRow(bendId);
      if (_simController2D) _simController2D.onactive = (bendId) => highlightActiveRow(bendId);
          
          updateToolOverrides();
          
          const playBtn = card.querySelector('.sb-sim-play');
          if (playBtn) playBtn.textContent = '⏸ Pause';
        }
      };

      card.querySelectorAll('.sb-edit-punch, .sb-edit-die').forEach(sel => {
        sel.addEventListener('change', onOverrideChange);
      });
      card.querySelectorAll('.sb-edit-angle, .sb-edit-flange, .sb-edit-v').forEach(inp => {
        inp.addEventListener('input', onOverrideChange);
      });

      // เอ๋ 2026-06-07: live FLAN what-if. Editing a flange cell mutates the
      // in-memory `rec` only (flange_mm + box wall flat_len/height → drives the
      // 2-D label, the on-part number, the 2-D/3-D length and collision) and
      // re-mounts the sim so the flange visibly grows / shrinks. Does NOT touch
      // Firebase — SAVE CONFIG still persists separately.
      ROOT.querySelectorAll('.sb-edit-flange').forEach(inp => {
        inp.addEventListener('change', () => {
          const code = _simBendExpanded;
          const rec2 = code && processedCache[code];
          if (!rec2) return;
          const bendId = inp.dataset.bend;
          const v = parseFloat(inp.value);
          if (isNaN(v)) return;
          const b = (rec2.per_bend || []).find(x => x.bend === bendId);
          if (b) { b.flange_mm = v; b.flange_mm_out = v; }
          if (rec2.box_geom && rec2.box_geom.walls) {
            const w = rec2.box_geom.walls.find(x => x.id === bendId);
            if (w) { w.flat_len = v; w.height = v; }   // one value → label + length + collision
          }
          _remountSimBend();   // re-extrudes flange, redraws the number, re-runs collision
        });
      });

      // Leg what-if: editing a side trades length with the OPPOSITE END so the
      // flat blank stays constant (เอ๋ 'ปรับขา1 → ขา2 ปรับตาม, flat คงที่'). Pure
      // in-place DOM update (no re-render → keeps focus). Collision red lands
      // when Fusion's max_flange arrives (consumer already wired).
      const wifInputs = [].slice.call(card.querySelectorAll('.sb-wif-leg'));
      if (wifInputs.length >= 2) {
        const prevW = wifInputs.map(x => +x.value);
        wifInputs.forEach((inp, i) => {
          inp.addEventListener('input', () => {
            const v = +inp.value; if (isNaN(v)) return;
            const d = v - prevW[i];
            const j = (i === wifInputs.length - 1) ? 0 : wifInputs.length - 1;
            const nv = Math.round((+wifInputs[j].value - d) * 100) / 100;
            wifInputs[j].value = nv;
            prevW[i] = v; prevW[j] = nv;
          });
        });
      }

      card.querySelectorAll('.sb-step-move-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const bendId = btn.getAttribute('data-bend');
          const isUp = btn.classList.contains('sb-step-up');
          const curOrder = rec.order.slice();
          const idx = curOrder.indexOf(bendId);
          const nextIdx = idx + (isUp ? -1 : 1);
          
          if (idx >= 0 && nextIdx >= 0 && nextIdx < curOrder.length) {
            [curOrder[idx], curOrder[nextIdx]] = [curOrder[nextIdx], curOrder[idx]];
            rec.order = curOrder;
            rec.checked_by = 'web_override';
            render();
          }
        });
      });

      card.querySelector('.sb-save-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const stepMapping = {};
        rec.order.forEach((bendId, idx) => {
          stepMapping[bendId] = idx + 1;
        });
        
        const saveStatus = card.querySelector('.sb-save-status');
        if (saveStatus) saveStatus.textContent = 'Saving…';
        
        const refPath = `bend_sim/${_simBendExpanded}`;
        window.firebaseDB.ref(refPath).update({
          order: rec.order,
          per_bend: rec.per_bend,
          bendable: rec.bendable,
          kind: rec.kind,
          reason: rec.reason,
          n_problems: rec.n_problems,
          step_mapping: stepMapping,
          checked_by: 'web_override',
          checked_at: new Date().toISOString().slice(0, 16).replace('T', ' ')
        }).then(() => {
          if (saveStatus) {
            saveStatus.textContent = '✓ Saved successfully!';
            saveStatus.style.color = '#4ecca3';
            setTimeout(() => { saveStatus.textContent = ''; }, 3000);
          }
        }).catch(err => {
          if (saveStatus) {
            saveStatus.textContent = '✗ Error: ' + err.message;
            saveStatus.style.color = '#e0574a';
          }
        });
      });

      card.querySelector('.sb-reset-auto-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm('Reset all overrides to the automatic plan?')) return;
        
        const refPath = `bend_sim/${_simBendExpanded}`;
        window.firebaseDB.ref(refPath).child('checked_by').set(null).then(() => {
          render();
        });
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
      isNew: isNewProject('nest', key, p),
      completed: isCompleted(key),   // 📦 Complete folder — same RTDB set as Projects
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

  // 📦 Complete folder — same RTDB-synced set as the Projects tab; finished
  // projects collapse out of the picker (เอ๋ 2026-06-11 'จะได้ไม่เกะกะ').
  const activeEntries = filtered.filter(e => !e.completed);
  const doneEntries = filtered.filter(e => e.completed);

  const orderedKeys = activeEntries.map(e => e.key);   // visual order for ▲/▼
  const rows = activeEntries.map((e, i) => {
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
    const isFirst = i === 0, isLast = i === activeEntries.length - 1;
    return `
    <div class="${cls}" data-key="${escapeHtml(e.key)}" role="button" tabindex="0"
         ${e.ready ? '' : 'aria-disabled="true"'}>
      <span class="nest-move">
        <button class="nest-move-btn nest-up" data-key="${escapeHtml(e.key)}" aria-label="Move up" title="Move up" ${isFirst ? 'disabled' : ''}>▲</button>
        <button class="nest-move-btn nest-down" data-key="${escapeHtml(e.key)}" aria-label="Move down" title="Move down" ${isLast ? 'disabled' : ''}>▼</button>
      </span>
      <div class="nest-home-body">
        <span class="nest-home-name">${escapeHtml(e.name)}${e.isNew ? ' <span class="part-new-badge" title="New activity since you last opened this project here">NEW</span>' : ''}</span>
        <span class="nest-home-stats">${e.uniqueParts} unique · ${e.totalQty} pcs · 📐 ${e.dxfCount}/${e.uniqueParts} DXFs</span>
      </div>
      <span class="nest-home-actions">
        <span class="nest-home-cta">${e.ready ? '▶ Nest' : '⚠ no DXFs'}</span>
        <button class="pin-btn ${e.pinned ? 'on' : ''}" data-project="${escapeHtml(e.key)}"
                aria-label="${pinTitle}" title="${pinTitle}">${e.pinned ? '★' : '☆'}</button>
        <button class="nest-del-btn" data-key="${escapeHtml(e.key)}" aria-label="Hide project" title="Hide from list (also hides in Projects)">🗑</button>
      </span>
    </div>`;
  }).join('');

  // 📦 Complete section — same collapsible folder + shared open-state as the
  // Projects tab. Rows keep ▶ Nest / pin / 🗑 (handlers below pick them up by
  // class) but no ▲▼ reordering inside the folder.
  const doneRows = doneEntries.map(e => `
    <div class="nest-home-row completed${e.ready ? '' : ' no-dxf'}" data-key="${escapeHtml(e.key)}" role="button" tabindex="0"
         ${e.ready ? '' : 'aria-disabled="true"'}>
      <div class="nest-home-body">
        <span class="nest-home-name">${escapeHtml(e.name)}</span>
        <span class="nest-home-stats">${e.uniqueParts} unique · ${e.totalQty} pcs · 📐 ${e.dxfCount}/${e.uniqueParts} DXFs</span>
      </div>
      <span class="nest-home-actions">
        <span class="nest-home-cta">${e.ready ? '▶ Nest' : '⚠ no DXFs'}</span>
        <button class="pin-btn ${e.pinned ? 'on' : ''}" data-project="${escapeHtml(e.key)}" aria-label="Pin" title="Pin to top">${e.pinned ? '★' : '☆'}</button>
        <button class="nest-del-btn" data-key="${escapeHtml(e.key)}" aria-label="Hide project" title="Hide from list (also hides in Projects)">🗑</button>
      </span>
    </div>`).join('');
  const doneOpen = _completeFolderOpen();
  const completeSection = doneEntries.length ? `
    <div class="complete-folder${doneOpen ? ' open' : ''}">
      <button class="complete-folder-head" id="kd-complete-toggle" title="Finished projects — synced with the Projects tab">
        ${doneOpen ? '▾' : '▸'} 📦 Complete <span class="complete-folder-count">(${doneEntries.length})</span>
      </button>
      ${doneOpen ? `<div class="nest-home-rows">${doneRows}</div>` : ''}
    </div>` : '';

  ROOT.innerHTML = `
    <div class="nest-home">
      <div class="nest-home-banner">
        ▶ Nesting Workspace
        <span class="nest-home-sub">Pick a project — workspace opens in-browser. Admin only.</span>
      </div>
      <div class="nest-home-rows">${rows}</div>
      ${completeSection}
    </div>`;
  COUNT_EL.textContent = `${filtered.length} project${filtered.length === 1 ? '' : 's'}${doneEntries.length ? ` · ${doneEntries.length} complete` : ''}`;

  ROOT.querySelector('#kd-complete-toggle')?.addEventListener('click', _toggleCompleteFolder);

  // Row open — skip if the click was on the pin button (pin has its own
  // handler below). aria-disabled rows (no DXFs) don't open. Keyboard
  // Enter/Space activates the same as click since the row is a div now.
  const _openRow = (row) => {
    if (row.getAttribute('aria-disabled') === 'true') return;
    const key = row.dataset.key;
    if (!key) return;
    markProjectSeen('nest', key);   // opening clears this surface's NEW badge
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
  const allItems = projectList();

  if (!allItems.length) {
    ROOT.innerHTML = `
      <p class="loading">No projects yet<br><br>
      Open a project assembly in Fusion and run <code>CC_Assembly</code></p>`;
    COUNT_EL.textContent = '';
    return;
  }

  // 📦 Complete folder (เอ๋ 2026-06-11): finished projects file away into a
  // collapsed section below the active list — same set the Nest picker shows.
  const items = allItems.filter(p => !p.completed);
  const doneItems = allItems.filter(p => p.completed);

  const cardHtml = (p, idx) => {
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
    const newBadge = isNewProject('proj', p.key, p)
      ? ' <span class="part-new-badge" title="New activity since you last opened this project here">NEW</span>' : '';
    const missing = p.missing_count;
    const drawingBadge = missing > 0
      ? `<span class="project-badge missing">⚠️ ${missing} no drawing</span>`
      : `<span class="project-badge complete">✓ all drawn</span>`;
    const updated = fmtDate(p.updated_at || p.created_at);
    const totalQty = p.total_qty != null ? p.total_qty : (p.parts || []).reduce((s, x) => s + (x.qty || 0), 0);
    // LEAF count fallback (not raw parts.length — raw includes is_wrapper rows)
    const uniq = p.total_unique_parts != null ? p.total_unique_parts
      : (p.leaf_unique != null ? p.leaf_unique : (p.parts || []).length);
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
    // Admin rename — display-name override (RTDB project_names); shows the real
    // cabinet/config name while the manifest key stays the file code.
    const renameBtn = adminMode
      ? `<button class="project-rename-btn" data-rename-project="${escapeHtml(p.key)}" aria-label="Rename project" title="Edit the display name (e.g. the cabinet's config code)"><svg class="proj-act-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M16.4 3.5 a1.9 1.9 0 0 1 2.7 2.7 L7.8 18 3.5 19.3 4.8 15 Z"/><line x1="14.2" y1="5.7" x2="17" y2="8.5"/><line x1="4" y1="21.3" x2="16.5" y2="21.3"/></svg></button>`
      : '';
    // 📦 file away / ↩ bring back (เอ๋ 2026-06-11 'เอางานที่ทำแล้วไปเก็บ
    // จะได้ไม่เกะกะ') — writes the RTDB-synced completed set.
    const completeBtn = adminMode
      ? (p.completed
        ? `<button class="project-complete-btn on" data-uncomplete-project="${escapeHtml(p.key)}" aria-label="Restore project" title="Move back to the active list">↩</button>`
        : `<button class="project-complete-btn" data-complete-project="${escapeHtml(p.key)}" aria-label="Mark complete" title="Move to the Complete folder">📦</button>`)
      : '';
    // 📋 Copy assembler link (เอ๋ 2026-06-22): admin one-click copies
    // `…/?asm=<projectKey>` → paste to LINE → assembler taps it once = lands
    // straight in this project's Kanban + role=assemble baked on their device.
    // Future taps on the now-clean URL still work (role stays in LS).
    const asmLinkBtn = adminMode
      ? `<button class="project-asmlink-btn" data-asmlink-project="${escapeHtml(p.key)}" aria-label="Copy assembler link" title="Copy assembler link — share via LINE so the worker lands straight in this project's Assembly view">📋</button>`
      : '';
    // 🧊 Full-Kitchen 3D (RD 07 2026-06-22) — opens the project's whole-kitchen
    // GLB written by CC_BatchExport3D at Drawings/3d/<projectKey>.glb. Visible
    // when the user could plausibly want it (admin OR assemble role); HEAD-
    // probe runs inside the modal so missing GLBs show a "Run CC_BatchExport3D"
    // placeholder rather than gating the button.
    const proj3dBtn = `<button class="project-3d-btn" data-3d-project="${escapeHtml(p.key)}" aria-label="View full-kitchen 3D" title="View the whole kitchen in 3D — opens ${escapeHtml(p.key)}.glb">🧊</button>`;
    // WEB 21 2026-06-22: 🧊 outdated chip for whole-kitchen .glb (project key
    // matches Drawings/3d/<projectKey>.glb). Chip stays absent on never-exported
    // projects (missing GLB = null state, not stale).
    const proj3dStaleChip = _glb3dStaleChip(p.key);
    return `
      <div class="${cls}" data-project="${escapeHtml(p.key)}">
        ${dragHandle}
        <div class="project-body">
          <div class="project-name">${escapeHtml(p.name || p.key)}${newBadge}${statusBadge}</div>
          <div class="project-meta">${escapeHtml(updated)} · ${uniq} unique · ${totalQty} pcs · ${p.drawn_count}/${uniq} drawn</div>
          ${progressBars}
          <div class="project-badges">${drawingBadge}${bentBadge}${assembledBadge}${proj3dStaleChip}</div>
        </div>
        ${pinBtn}
        ${proj3dBtn}
        ${asmLinkBtn}
        ${completeBtn}
        ${renameBtn}
        ${deleteBtn}
      </div>`;
  };
  const html = items.map(cardHtml).join('');
  const doneHtml = doneItems.map((p) => cardHtml(p, -1)).join('');
  const doneOpen = _completeFolderOpen();
  const completeSection = doneItems.length ? `
    <div class="complete-folder${doneOpen ? ' open' : ''}">
      <button class="complete-folder-head" id="kd-complete-toggle" title="Finished projects — kept out of the active list (synced with the Nest picker)">
        ${doneOpen ? '▾' : '▸'} 📦 Complete <span class="complete-folder-count">(${doneItems.length})</span>
      </button>
      ${doneOpen ? `<div class="project-list project-list-complete">${doneHtml}</div>` : ''}
    </div>` : '';

  // Admin-only "📋 Copy Assembler Link" header — เอ๋ 2026-06-22: the GENERIC
  // link (`?asm`) is the one-shot LINE share — assembler taps once, bakes
  // role=assemble, lands here on Projects, picks their cabinet themselves.
  // Lives at the top of the projects list so it's discoverable but small.
  // (Note: `adminMode` is declared inside cardHtml, not the outer scope —
  // use isAdmin() directly here.)
  const asmGenericBar = isAdmin()
    ? `<div class="projects-adminbar" style="display:flex;align-items:center;gap:10px;padding:8px 12px;margin:0 0 10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:8px;font-family:'Flux Architect',ui-monospace,monospace">
         <button class="projects-adminbar-btn" id="asmlink-generic-btn" title="Copy the generic assembler link — share to LINE so workers can bake role + see ALL projects with one tap" style="background:#1c2530;color:#e6edf4;border:1px solid #2b3a4d;border-radius:6px;padding:6px 10px;font:inherit;font-size:12px;cursor:pointer;letter-spacing:.3px">📋 Copy Assembler Link</button>
         <span class="projects-adminbar-hint" style="font-size:11px;color:#9fb0c0;letter-spacing:.3px">One link for LINE — bakes role, shows all projects</span>
       </div>`
    : '';

  ROOT.innerHTML = `${asmGenericBar}<div class="project-list">${html}</div>${completeSection}`;

  // Global "Copy Assembler Link" — writes `<origin><path>?asm` (no value =
  // generic entry) to clipboard. The applyUrlFlags handler bakes role +
  // strips the param when the worker opens it.
  ROOT.querySelector('#asmlink-generic-btn')?.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const url = window.location.origin + window.location.pathname + '?asm';
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch (e) {}
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = url; ta.style.position = 'fixed'; ta.style.top = '-1000px';
        document.body.appendChild(ta); ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e) {}
    }
    _kdToast(ok ? '📋 Assembler link copied — paste to LINE' : '✗ Copy failed — long-press URL to copy manually');
  });

  // 📦 folder open/close — shared state with the Nest picker.
  ROOT.querySelector('#kd-complete-toggle')?.addEventListener('click', _toggleCompleteFolder);
  // 📦 / ↩ — move projects in and out of the Complete folder (RTDB-synced).
  ROOT.querySelectorAll('[data-complete-project]').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      markCompleted(btn.dataset.completeProject, true);
      render();
    });
  });
  ROOT.querySelectorAll('[data-uncomplete-project]').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      markCompleted(btn.dataset.uncompleteProject, false);
      render();
    });
  });

  // 📋 Copy assembler link — admin-only. Writes `…/?asm=<key>` to clipboard;
  // worker pastes into LINE → assembler taps = lands in Assembly + role baked.
  ROOT.querySelectorAll('[data-asmlink-project]').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const key = btn.dataset.asmlinkProject;
      const url = window.location.origin + window.location.pathname + '?asm=' + encodeURIComponent(key);
      let ok = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(url);
          ok = true;
        }
      } catch (e) {}
      if (!ok) {
        // Fallback for browsers that block async clipboard outside a secure
        // context — use a hidden textarea + execCommand('copy').
        try {
          const ta = document.createElement('textarea');
          ta.value = url; ta.style.position = 'fixed'; ta.style.top = '-1000px';
          document.body.appendChild(ta); ta.select();
          ok = document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (e) {}
      }
      _kdToast(ok ? '📋 Assembler link copied' : '✗ Copy failed — long-press URL to copy manually');
    });
  });

  // 🧊 Full-Kitchen 3D — opens <projectKey>.glb in the modal. The opener
  // HEAD-probes the URL and shows a "Run CC_BatchExport3D" placeholder for
  // missing GLBs, so we never need to gate the button itself.
  ROOT.querySelectorAll('[data-3d-project]').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const key = btn.dataset['3dProject'] || btn.getAttribute('data-3d-project');
      if (key && typeof _kdOpen3D === 'function') {
        _kdOpen3D(key, { asProject: true });
      }
    });
  });

  // Card click → drill into project (but ignore clicks on pin, drag, rename, delete, asmlink, or 3d).
  ROOT.querySelectorAll('.project-card').forEach(el => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.pin-btn, .drag-handle, .project-delete-btn, .project-rename-btn, .project-complete-btn, .project-asmlink-btn, .project-3d-btn')) return;
      markProjectSeen('proj', el.dataset.project);   // opening clears this surface's NEW badge
      navTo({ kind: 'project', name: el.dataset.project });
    });
  });

  // ✏ rename (admin) — prompt → RTDB project_names override; listener re-renders.
  ROOT.querySelectorAll('.project-rename-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      renameProject(btn.dataset.renameProject);
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

  COUNT_EL.textContent = `${allItems.length} projects · ${items.length} active${doneItems.length ? ` · ${doneItems.length} complete` : ''}`;
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
  // Load the editor bundle + CSS with cache:'no-store' (NOT a cache-subject
  // <script src="...?v=">). GitHub Pages' CDN ignores ?v= query cache-busting, so a
  // browser-cached OLD editor.bundle.js used to persist and bring BACK removed UI —
  // the recurring "pink X" exit-button regression in the mindmap (เอ๋ 2026-06-09).
  // no-store = always fresh, same lever as the index.html app-script bootstrap.
  // Falls back to a classic <script src> if the fetch fails so the editor still loads.
  _editorBundlePromise = (async () => {
    const v = window.__KD_CACHE_V || Math.floor(Date.now() / 60000);
    try {
      const [css, js] = await Promise.all([
        fetch('editor.bundle.css?v=' + v, { cache: 'no-store' }).then(r => r.ok ? r.text() : Promise.reject(r.status)),
        fetch('editor.bundle.js?v=' + v, { cache: 'no-store' }).then(r => r.ok ? r.text() : Promise.reject(r.status)),
      ]);
      const style = document.createElement('style');
      style.setAttribute('data-kme-bundle', '1');
      style.textContent = css;
      document.head.appendChild(style);
      const s = document.createElement('script');
      s.textContent = js + '\n//# sourceURL=editor.bundle.js';
      document.body.appendChild(s);   // IIFE runs synchronously → sets window.KitchenMindmapEditor
      if (!window.KitchenMindmapEditor) throw new Error('editor bundle loaded but did not register');
    } catch (e) {
      // fallback: classic cache-subject load (a network hiccup shouldn't kill the editor)
      await new Promise((resolve, reject) => {
        const cssLink = document.createElement('link');
        cssLink.rel = 'stylesheet';
        cssLink.href = 'editor.bundle.css?v=' + v;
        document.head.appendChild(cssLink);
        const s = document.createElement('script');
        s.src = 'editor.bundle.js?v=' + v;
        s.onload = () => resolve();
        s.onerror = (err) => reject(err);
        document.body.appendChild(s);
      });
    }
  })();
  _editorBundlePromise.catch(() => { _editorBundlePromise = null; });   // allow retry after failure
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
  const ref = window.firebaseDB.ref('custom_mindmaps/' + projectKey);
  const _parse = (snap) => {
    const data = snap.val() || {};
    const nodes = data.nodes
      ? Object.entries(data.nodes).map(([id, raw]) => _rtdbToRfNode(id, raw))
      : [];
    const edges = data.edges
      ? Object.entries(data.edges).map(([id, raw]) => ({ id, source: raw.source, target: raw.target }))
      : [];
    // Mirror to LS so next first-paint has data without a Firebase round trip.
    _saveCustomMindmapLocal(projectKey, { nodes, edges });
    return { nodes, edges };
  };
  try {
    // Time-bound the read: on a COLD hard-reload the RTDB socket is still connecting and
    // .once() PENDS forever (never resolves/rejects). The editor mount() AWAITS this, so a
    // pend HANGS the mount → BLANK canvas (เอ๋ 2026-06-21 "จอว่าง"). Race a 1.5s timeout →
    // fall back to the LS cache so mount() ALWAYS runs; mirror the live value when it lands.
    const TO = Symbol('to');
    const snap = await Promise.race([ ref.once('value'), new Promise(r => setTimeout(() => r(TO), 1500)) ]);
    if (snap === TO) {
      ref.once('value').then(s => { try { _parse(s); } catch (_) {} }).catch(() => {});
      return cached;
    }
    return _parse(snap);
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
  // ── Concept-Map Grid Layout (Hierarchical Flow) ───────────
  // Goal (เอ๋): NEVER overlapping + every node visible + parts grouped into
  // readable family "ก้อน" (concept-map style).
  //
  // Project Center at the top. Families wrapped in rows below.
  // Within a family, leaves are placed in a tight grid. Deep trees use hierarchical tree.
  const ps = (parts || project?.parts || []).filter(p => p && p.code);
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

  const { roots, all } = buildProjectTree(ps, projectKey);
  const nodes = [center];
  const edges = [];

  function emitNode(node, x, y, opts) {
    opts = opts || {};
    const famKey = _remapFamilyForCode(node.code, node.family);
    const colors = _familyColors(famKey);
    const isLeaf = !node.children?.length;
    const isWrapper = !!node._is_wrapper;
    const partMissing = !isWrapper && !pdfUrlForCode(node.code);
    const nodeKey = node._id || `${node.code}::`;
    const isVariantRoot = opts.forceIsAnchor != null ? !!opts.forceIsAnchor : !!node._is_variant_root;
    let variantNodeId;
    if (isVariantRoot) variantNodeId = null;
    else if (opts.anchorNodeId) variantNodeId = opts.anchorNodeId;
    else if (node._variant_root) variantNodeId = `bom:${node._variant_root}::`;
    else variantNodeId = null;

    nodes.push({
      id: `bom:${nodeKey}`,
      type: 'mindmap',
      position: { x, y },
      data: {
        // label = DISPLAY name (admin display_override or the code); `code` keeps the
        // immutable part code for all logic (routing/pdf/done/comments/rename key) so a
        // mindmap rename and a Library rename share display_overrides. (RD 02 2026-06-09)
        label: displayCodeFor(node.code),
        code: node.code,
        kind: 'bom',
        qty: node.qty || 0,
        family: famKey,
        color: colors.color,
        tint: colors.tint,
        projectKey,
        isLeaf,
        isWrapper,
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
      style: { stroke: color, strokeWidth: strong ? 1.6 : 1.2, opacity: strong ? 0.65 : 0.5 },
      selectable: false,
    });
  }

  // The rendered card is up to ~314px wide (measured live: long code + a "NO PDF" pill).
  const CARD_W = 314;                 // measured max rendered card width  (px)
  const CARD_H = 121;                 // measured max rendered card height (px)
  const MIN_SPACING = 350;            // ≥ diagonal(314,121)=337 → clears the widest card at every angle
  const ROW_STEP = MIN_SPACING;       // radial gap between rings
  const TWO_PI = 2 * Math.PI;
  const centerId = `project:${projectKey}`;

  // DEEP = a real assembly hierarchy (≤30 top-level cabinets, some with children —
  // e.g. 02 Ruth after CC_Assembly's deep export). Use the 16-cabinet ring layout.
  // Otherwise (shallow project = parts straight off the center) fall back to the
  // compact staggered annulus.
  const isDeep = roots.length <= 30 && roots.some(r => r.children && r.children.length);

  if (isDeep) {
    // ── 16-CABINET RING (เอ๋ 2026-06-09 'โลโก้ขยายเกือบเต็ม + 16 ตู้อยู่ในนั้น') ──
    // Cabinets sit on an INNER RING (inside the big logo circle); each cabinet's
    // whole subtree fans OUTWARD beyond the circle in the cabinet's own angular
    // WEDGE. Wedge width = an equal FLOOR (so even 0-descendant cabinets clear
    // their neighbours on the inner ring) + a PROPORTIONAL share (so a 36-desc
    // cabinet gets a wide fan, a 0-desc one stays thin). Sums to 2π → tiles, no
    // gaps/overlap. Provably 0-overlap: cabinets clear on the ring; within a
    // wedge it's a staggered annulus (same-ring K-apart ≥ MIN_SPACING, rings
    // ROW_STEP apart); across wedges an angPad gap keeps boundaries clear.
    function _descCount(node) { let n = 0; for (const c of (node.children || [])) n += 1 + _descCount(c); return n; }
    const cabs = roots.map(r => ({ node: r, desc: _descCount(r) }));
    const NC = cabs.length;
    const totalDesc = Math.max(1, cabs.reduce((s, c) => s + c.desc, 0));
    const FLOOR_FRAC = 0.5, PROP_FRAC = 0.5;
    const wedge = cabs.map(c => TWO_PI * (FLOOR_FRAC / NC + PROP_FRAC * (c.desc / totalDesc)));
    let minSep = Infinity;
    for (let i = 0; i < NC; i++) { const sep = (wedge[i] + wedge[(i + 1) % NC]) / 2; if (sep < minSep) minSep = sep; }
    const R_CAB = Math.max(900, MIN_SPACING / (2 * Math.sin(Math.min(Math.PI / 2, minSep / 2))));
    const R_LOGO = R_CAB + CARD_W * 0.5 + 140;   // big "logo" circle encloses the cabinet ring
    const R_PARTS = R_LOGO + ROW_STEP;           // descendants begin just OUTSIDE the circle
    const angPad = Math.asin(Math.min(0.9, MIN_SPACING / (2 * R_PARTS)));

    // Big "logo" circle: enlarge the project center to the circle radius so it
    // fills the middle with the 15-16 cabinets sitting on it (เอ๋ 'โลโก้ขยาย
    // เกือบเต็ม + 16 ตู้อยู่ในนั้น'). Re-centre it on the origin (its top-left
    // must be (−R_LOGO,−R_LOGO) so the circle's centre = the cabinet ring's
    // centre). The editor reads logoRadius to render the big ring + a small
    // interactive hub. parts fan OUTSIDE this circle (R_PARTS > R_LOGO).
    center.data.logoRadius = R_LOGO;
    center.data.cabRadius = R_CAB;
    center.position = { x: -R_LOGO, y: -R_LOGO };
    // Keep the giant disc BEHIND every part node (React Flow honours node.zIndex)
    // — belt for the CSS wrapper rule; without it a selected disc jumps to the
    // top layer and its wrapper eats the NO-PDF badge clicks (เอ๋ 2026-06-10).
    center.zIndex = -1;

    let phi = -Math.PI / 2 - wedge[0] / 2;        // cabinet 0 centred at the top (−90°)
    for (let i = 0; i < NC; i++) {
      const c = cabs[i];
      const wStart = phi, wMid = phi + wedge[i] / 2;
      phi += wedge[i];
      const hasKids = !!(c.node.children && c.node.children.length);
      const { nodeKey: cabKey, color: cabColor } = emitNode(
        c.node, R_CAB * Math.cos(wMid), R_CAB * Math.sin(wMid),
        { forceIsAnchor: (!!c.node._is_variant_root || hasKids) });
      const cabId = `bom:${cabKey}`;
      emitEdge(centerId, cabKey, cabColor, true);
      if (!hasKids) continue;

      // Subtree in DFS pre-order (contiguous = readable group), packed into a
      // staggered annulus confined to this cabinet's wedge, outside the circle.
      const desc = [];
      (function collect(node, parentId) {
        for (const ch of (node.children || [])) {
          desc.push({ node: ch, parentId });
          collect(ch, `bom:${ch._id || ch.code + '::'}`);
        }
      })(c.node, cabId);
      const M = desc.length;
      const usable = Math.max(0.0001, wedge[i] - 2 * angPad);
      const slotAng = usable / M;
      let K = 1;  // rings: same-ring nodes (K slots apart) must clear MIN_SPACING at R_PARTS
      for (let k = 1; k <= 16; k++) { K = k; if (2 * R_PARTS * Math.sin(Math.min(Math.PI / 2, k * slotAng / 2)) >= MIN_SPACING) break; }
      desc.forEach((d, s) => {
        const a = wStart + angPad + (s + 0.5) * slotAng;
        const r = R_PARTS + (s % K) * ROW_STEP;
        emitNode(d.node, r * Math.cos(a), r * Math.sin(a), { anchorNodeId: cabId });
        emitEdge(d.parentId, d.node._id || (d.node.code + '::'), cabColor, false);
      });
    }
  } else {
    // ── FLAT fallback: compact staggered annulus (2026-06-08, G2) — unchanged. ──
    // ALL nodes pack into a tight ANNULUS of K rings in DFS pre-order (each
    // family contiguous). angle = pre-order slot; radius = R0 + (g mod K)·ROW_STEP
    // (consecutive alternate rings → ROW_STEP apart radially; same-ring K apart →
    // chord ≥ MIN_SPACING). K minimises the outer radius. Provably 0-overlap.
    let N = 0;
    (function count(list) { for (const n of list) { N++; if (n.children?.length) count(n.children); } })(roots);
    N = Math.max(1, N);
    const SLOT_ANG = TWO_PI / N;
    let K = 1, R0 = 360, bestOuter = Infinity;
    for (let k = 1; k <= 8; k++) {
      const r = Math.max(360, MIN_SPACING / (2 * Math.sin(Math.min(Math.PI / 2, (k * Math.PI) / N))));
      const outer = r + (k - 1) * ROW_STEP;
      if (outer < bestOuter) { bestOuter = outer; K = k; R0 = r; }
    }
    let _g = 0;
    function emitTree(node, parentSourceId, anchorId, isTop) {
      const g = _g++;
      const a = -Math.PI / 2 + (g + 0.5) * SLOT_ANG;
      const r = R0 + (g % K) * ROW_STEP;
      const hasKids = !!node.children?.length;
      const { nodeKey, color } = emitNode(node, r * Math.cos(a), r * Math.sin(a),
        isTop ? { forceIsAnchor: (!!node._is_variant_root || hasKids) } : { anchorNodeId: anchorId });
      const myId = `bom:${nodeKey}`;
      emitEdge(parentSourceId, nodeKey, color, isTop);
      if (hasKids) { const childAnchor = isTop ? myId : anchorId; for (const ch of node.children) emitTree(ch, myId, childAnchor, false); }
    }
    for (const root of roots) emitTree(root, centerId, null, true);
  }

  // Post-build pass: depth = hops from the Project center along the directed
  // center→child edges. Recolor every BOM node (incl wrapper / variant-root
  // containers) and each incoming edge by layer. Center stays its blue anchor.
  const depthMap = {};
  depthMap[`project:${projectKey}`] = 0;
  let q = [`project:${projectKey}`];
  while (q.length) {
    const curr = q.shift();
    const currD = depthMap[curr];
    const outs = edges.filter(e => e.source === curr);
    for (const e of outs) {
      if (depthMap[e.target] === undefined) {
        depthMap[e.target] = currD + 1;
        q.push(e.target);
      }
    }
  }

  for (const n of nodes) {
    if (n.data.kind === 'bom') {
      const d = depthMap[n.id];
      n.data.layer = (d !== undefined) ? d : 1;
    }
  }

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
    // Cabinet freshness (assemble role) — NEW/CHANGED status for a cabinet
    // (variant_root). The mindmap variant-root nodes call this to draw an amber
    // frame/badge; markAll acknowledges every cabinet for the assemble role
    // (เอ๋ 2026-06-11 "คนประกอบต้องรู้ว่าอะไรใหม่อะไรเก่า").
    cabinetFreshness: (pk, cab) => {
      try { const f = cabinetFreshnessAll('assemble', pk).get(cab); return f ? f.status : null; }
      catch (e) { return null; }
    },
    cabinetFreshCount: (pk) => {
      try { return [...cabinetFreshnessAll('assemble', pk).values()].filter(i => i.status === 'new' || i.status === 'changed').length; }
      catch (e) { return 0; }
    },
    // WEB 21 2026-06-22: 🧊 outdated chip for the mindmap variant-root nodes
    // (cabinet-level). Tri-state — true means .glb was last exported before
    // the ROUND 14 cutoff (2026-06-22 10:40 UTC); false = fresh; null =
    // unknown (mtime probe still in flight, or no GLB at all). Probe lazily
    // populates per-tab in sessionStorage and pulses _backgroundRender on
    // resolve, so the chip appears in-place without a viewport jump.
    glb3dStale: (code) => { try { return _glb3dStale(code); } catch (e) { return null; } },
    markAllCabinetsSeen: (pk) => { try { markAllCabinetsSeen('assemble', pk); render(); } catch (e) {} },
    // Admin "Edit Link": point a NO-PDF node at another code's drawing (live).
    isAdmin,
    getDrawingLink,
    suggestDrawingTarget,
    pdfFileExists: _pdfFileExists,
    // Shared display-rename: a mindmap node rename + a Library rename both write here.
    displayLabelForCode: displayCodeFor,
    // Editor-bridge user-edits (rename / link) use _backgroundRender, NOT raw
    // render(): when the mindmap editor is live it does the in-place kme:extsync
    // delta and RETURNS before the ROOT rebuild, so a node rename / re-link keeps
    // the editor's pan/zoom + node positions exactly in place (เอ๋ 2026-06-21
    // standing rule — no jump on ANY update/action). Off the editor it falls back
    // to a scroll-preserving render.
    setDisplayOverride: (code, label) => {
      if (!isAdmin()) return;
      setDisplayOverride(code, label);
      try { _backgroundRender(); } catch {}
    },
    setDrawingLink: (code, target) => {
      if (!isAdmin()) return;
      setDrawingLink(code, target);
      try { _backgroundRender(); } catch {}
    },
    // Open the Pick-PDF PICKER for a NO-PDF mindmap node (เอ๋ 2026-06-21: the
    // node 🔗 Link had regressed to a bare window.prompt — restore the same
    // searchable list/preview/Use/Unlink modal the bend rows use). The modal
    // sets drawing_links/<code> itself (case-preserved) + re-renders.
    openPdfPicker: (code) => {
      if (!isAdmin() || !code) return;
      try { _openBendPdfPicker(code); } catch (e) { console.error('[kdAPI] openPdfPicker', e); }
    },
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
    // 3D viewer (เอ๋ 2026-06-22 Phase 1). The editor mindmap cabinet/leaf
    // calls this from its 🧊 button. Loads model-viewer lazily + a GLB from
    // jsdelivr Drawings/3d/<code>.glb; 404 → placeholder. Workshop-safe.
    // PART VIEW: pass {cabinetCode} when calling from a part row so the modal
    // loads the cabinet's _parts.glb and filters to the matching mesh.
    open3D: (c, opts) => _kdOpen3D(c, opts),
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
  const ref = window.firebaseDB.ref(`custom_mindmaps/${projectKey}/overrides`);
  const _merge = (snap) => {
    const remote = snap.val() || {};
    // Remote wins for any key it has — but LS keeps in-flight drags that
    // haven't been flushed yet (those keys live only in LS until the
    // 500ms debounce fires).
    const merged = { ...lsCopy, ...remote };
    _saveOverridesLocal(projectKey, merged);
    return merged;
  };
  try {
    // Same cold-socket timeout as _loadCustomMindmap — a pending .once() here would also
    // hang the editor mount() that awaits it. Fall back to LS on timeout; mirror late value.
    const TO = Symbol('to');
    const snap = await Promise.race([ ref.once('value'), new Promise(r => setTimeout(() => r(TO), 1500)) ]);
    if (snap === TO) {
      ref.once('value').then(s => { try { _merge(s); } catch (_) {} }).catch(() => {});
      return lsCopy;
    }
    return _merge(snap);
  } catch (e) {
    console.warn('[kme] load overrides failed:', e);
    return lsCopy;
  }
}

function _applyOverrides(nodes, overrides) {
  if (!overrides || !Object.keys(overrides).length) return nodes;
  // ⚠ Legacy auto-save artifact (เอ๋ 2026-06-08): onChange used to persist EVERY node's
  // position on each render, so any project that was ever VIEWED ends up with a "blanket"
  // of position overrides covering ~all nodes. That blanket FROZE the layout and made every
  // _buildBomNodes change (G1/G3/G2) invisible — re-deploys never reached the user. If the
  // position overrides blanket most of the nodes it's that bug, not a handful of real admin
  // drags → IGNORE the positions (keep label/rename overrides) so the fresh layout wins.
  const posCount = nodes.reduce((c, n) => { const o = overrides[n.id]; return c + (o && o.x != null && o.y != null ? 1 : 0); }, 0);
  // The blanket also misfires when the TREE changes (the 2026-06-09 deep
  // CC_Assembly export changed node ids) → few overrides match the new nodes,
  // so posCount alone falls under 60% and the stale positions leak back. A real
  // admin never hand-drags dozens of nodes, so a large TOTAL count of position
  // overrides is itself the blanket signal regardless of how many still match.
  const totalPosOverrides = Object.keys(overrides).reduce((c, k) => { const o = overrides[k]; return c + (o && o.x != null && o.y != null ? 1 : 0); }, 0);
  const blanketFreeze = nodes.length >= 8 && (posCount >= 0.6 * nodes.length || totalPosOverrides >= 30);
  return nodes.map(n => {
    const o = overrides[n.id];
    if (!o) return n;
    // The project center is the layout ORIGIN — never honour a saved position
    // for it; a stale center override shifts the whole big-logo circle off the
    // cabinet ring (เอ๋ 2026-06-09). label/rename overrides still apply.
    const isCenter = typeof n.id === 'string' && n.id.startsWith('project:');
    const hasPosOverride = !blanketFreeze && !isCenter && o.x != null && o.y != null;
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
      // CC_Assembly emits intermediate containers (cabinets / sub-assemblies /
      // wrappers along the deep occurrence chain) with is_wrapper:true so the
      // tree can render the full Fusion-Browser hierarchy. Treat them as
      // wrappers (anchor nodes, no NO-PDF flag, excluded from BOM/laser).
      status: p.is_wrapper ? 'wrapper' : status,
      _is_wrapper: !!p.is_wrapper,
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
        <span class="bom-code" title="${escapeHtml(p.code)}">${escapeHtml(displayCodeFor(p.code))}${softDeleted ? '<span class="part-deleted-tag">DEL</span>' : ''}</span>
        <span class="bom-qty">×${p.qty}</span>
        ${_outdatedChips(p.code, { clickable: true })}
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
        label: displayCodeFor(chain[i].code),
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
          <span class="mm-comment-title" title="${escapeHtml(code)}">💬 <strong>${escapeHtml(displayCodeFor(code))}</strong> · ${cList.length} comment${cList.length === 1 ? '' : 's'}</span>
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
      <text class="pm-code" x="${-halfW + 12}" y="${-halfH + 18}" font-size="12" font-weight="700" fill="#e4e4e4">${escapeHtml(displayCodeFor(code))}</text>
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
  // WRAPPERS excluded (เอ๋ 2026-06-10): container/cabinet codes never have
  // their own PDF by design, so counting them inflated Missing to ~71 while
  // the real undrawn parts were a handful — and the Missing filter fed the
  // bend/cut lists a wrapper-only set that aggregates to ZERO rows
  // ("No parts in this project" on a 204-part project).
  const isMissing = (p) => !p.is_wrapper && !pdfUrlForCode(p.code);
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
        <button class="filter-btn project-cut-sheets-btn" id="project-cut-sheets-btn" data-project-key="${escapeHtml(key)}" title="Nested cut sheets uploaded for this project — from NestingTool's Save sheets to Laser or admin drag-drop"><span class="cs-btn-ico" aria-hidden="true">📐</span> Cut Sheets (${cutSheetsForProject(key).length})</button>` : ''}
        ${(_adminAll || _isAsm) ? (() => {
          let n = 0; try { n = [...cabinetFreshnessAll('assemble', key).values()].filter(i => i.status === 'new' || i.status === 'changed').length; } catch (e) {}
          return n ? `<button class="filter-btn cab-seen-btn" id="cab-seen-btn" data-key="${escapeHtml(key)}" title="Mark every cabinet seen for the assemble role — clears the amber NEW/CHANGED frames">🆕 ${n} new/changed · Mark all seen</button>` : '';
        })() : ''}
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
  // Cabinet freshness — acknowledge every cabinet for the ASSEMBLE role; clears
  // the amber NEW/CHANGED frames on the mindmap variant-root nodes (เอ๋ 2026-06-11).
  ROOT.querySelector('#cab-seen-btn')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const pk = ev.currentTarget.dataset.key;
    if (typeof markAllCabinetsSeen === 'function' && pk) { markAllCabinetsSeen('assemble', pk); render(); }
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
  // RACE GUARD (เอ๋ 2026-06-21 blank-on-reload): this mount is async (bundle fetch + RTDB
  // reads). On a reload, init-time RTDB listeners fire _refreshAssemblyUI→_backgroundRender→
  // render() DURING that window, which rebuilds ROOT (destroying the in-flight #kme-mount) and
  // starts a SECOND mount → the two race → 0 nodes. A monotonic token makes only the LATEST
  // render's mount win (stale continuations bail); __kmeMountDone lets _backgroundRender/
  // _refreshAssemblyUI SKIP the destructive render while a mount is in flight (see those fns).
  const _myMountSeq = (window.__kmeMountSeq = (window.__kmeMountSeq || 0) + 1);
  const _finishMount = () => { if (_myMountSeq === window.__kmeMountSeq) window.__kmeMountDone = _myMountSeq; };
  ensureEditorBundle().then(async () => {
    if (_myMountSeq !== window.__kmeMountSeq) return;          // superseded before we started — don't clobber
    const host = document.getElementById('kme-mount');
    if (!host) { _finishMount(); return; }
    const [fresh, overrides] = await Promise.all([
      _loadCustomMindmap(key),
      _loadOverrides(key),
    ]);
    if (_myMountSeq !== window.__kmeMountSeq) return;          // a newer render started during the reads — bail
    const bom = _buildBomNodes(project, visibleParts, key);
    const bomNodes = _applyOverrides(bom.nodes, overrides);
    // Custom nodes layer overrides too so renames live in one place.
    const customNodes = _applyOverrides(fresh.nodes || [], overrides);
    // Fresh DEFAULT positions (pre-override) so onChange only persists a node that the
    // admin actually MOVED — not every node on every render (the blanket-freeze bug). เอ๋.
    const _defaultPos = new Map();
    for (const n of bom.nodes) _defaultPos.set(n.id, { x: n.position.x, y: n.position.y });
    for (const n of (fresh.nodes || [])) _defaultPos.set(n.id, { x: n.position?.x, y: n.position?.y });
    const _defaultLabel = new Map();
    for (const n of bom.nodes) _defaultLabel.set(n.id, n.data?.label);
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
            // Only persist a node the admin actually MOVED (or renamed) — NOT every node on
            // every render. The old unconditional save froze all positions into a "blanket"
            // override that made future layout changes invisible. เอ๋ 2026-06-08.
            const dp = _defaultPos.get(n.id);
            const nx = n.position?.x, ny = n.position?.y;
            const moved = !dp || dp.x == null || Math.abs((nx ?? 0) - dp.x) > 1 || Math.abs((ny ?? 0) - dp.y) > 1;
            const renamed = n.data?.label != null && n.data.label !== _defaultLabel.get(n.id);
            if (moved || renamed) {
              _saveOverride(key, n.id, { x: nx, y: ny, label: n.data?.label });
            }
          } else {
            customOnly.nodes.push(n);
          }
        }
        _saveCustomMindmap(key, customOnly);
      },
    });
    _finishMount();
    // Watchdog: if the mount didn't paint a node within ~2.5s (residual stall), repopulate
    // ONCE (capped at 2) so the canvas can't sit blank. Resets the cap when it paints healthy.
    setTimeout(() => {
      if (_myMountSeq !== window.__kmeMountSeq || !document.getElementById('kme-mount')) return;
      if (document.querySelector('.react-flow__node')) { window.__kmeMountRetry = 0; return; }
      if ((window.__kmeMountRetry || 0) < 2) { window.__kmeMountRetry = (window.__kmeMountRetry || 0) + 1; try { render(); } catch (e) {} }
    }, 2500);
  }).catch(err => {
    _finishMount();   // never wedge the background-render skip if the mount failed
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
// opts.fusionOnly (เอ๋ 2026-06-10): the nest ⚠ button means "take me to Fusion
// to FIX this part" — falling back to a PDF there masks a dead bridge as
// success ("กด ⚠ แล้วไม่เปิด Fusion เปิด pdf แทน"). With fusionOnly the PDF
// branches are skipped: bridge works or the explanatory alert shows.
// urn lookup by part code for surfaces with no project context (Sim.Bending
// cards). urns live on manifest project parts[] (auto_generated has none) —
// first project carrying the code wins. Cheap linear scan; called per click.
function _urnForCode(code) {
  const projects = (window.kdManifest && window.kdManifest.projects) || {};
  for (const p of Object.values(projects)) {
    for (const part of (p.parts || [])) {
      if (part.code === code && part.urn) return part.urn;
    }
  }
  return null;
}

// Shared open-in-Fusion chip for the Sim.Bending card surfaces (sb-card head /
// DXF-preview card / mini row) — same cube glyph + router contract as the
// bend-list button (เอ๋ 2026-06-11, RD extension 25c3d86).
function _sbFusionBtnHtml(code) {
  return `<button class="sb-fusion-btn" data-code="${escapeHtml(code)}" aria-label="Open in Fusion" title="Open this part in Fusion"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8 L20.2 7.4 V16.6 L12 21.2 L3.8 16.6 V7.4 Z"/><path d="M3.8 7.4 L12 12 L20.2 7.4"/><line x1="12" y1="12" x2="12" y2="21.2"/></svg></button>`;
}

async function _routeLeafToFusion(node, opts) {
  const fusionOnly = !!(opts && opts.fusionOnly);
  // urn sources: the manifest/BOM urn first, then a CC_LinkNode pairing (fusion_link).
  // A node paired via Edit-in-Fusion can have NO manifest urn but a fusion_link.urn —
  // use it so the click still opens Fusion. (RD 2026-06-09)
  const fl = node.fusion_link || null;
  const urn = node.urn || (fl && fl.urn) || null;
  const drawingUrn = node.drawing_urn || (fl && fl.drawing_urn) || null;
  // Bridge GET with no-store so a stale localhost cache can't swallow the open.
  // One auto-retry after 2s: the common transient is "Fusion just (re)started and
  // CC_Auto's :8765 server isn't up yet" — a single retry rides out that window
  // instead of alarming เอ๋ (2026-06-09 "Failed to fetch" right after a restart).
  const bridgeOpen = async (u, kind) => {
    const hit = async () => {
      const kindParam = kind ? `&kind=${encodeURIComponent(kind)}` : '';
      const r = await fetch(`http://127.0.0.1:8765/open?urn=${encodeURIComponent(u)}${kindParam}&t=${Date.now()}`,
        { method: 'GET', mode: 'cors', cache: 'no-store' });
      return r.ok;
    };
    try { return await hit(); }
    catch (e) {
      await new Promise(res => setTimeout(res, 2000));
      return hit();   // second throw propagates to the caller's catch
    }
  };
  // Drawn + current → open the PDF, but ONLY if the file actually EXISTS. A manifest
  // key can resolve a URL that 404s (file not deployed) — in that case fall THROUGH to
  // Fusion instead of opening a broken/blank PDF tab. (RD 2026-06-09)
  if (node.status === 'drawn' && !fusionOnly) {
    const url = pdfUrlForCode(node.code);
    if (url && await _pdfFileExists(url)) { _openInNewTab(url); return; }
  }
  let bridgeAttempted = false;
  let bridgeError = null;
  // Stale (drawing exists but out of date) → open the Fusion .f2d drawing.
  // Fast path: a literal .f2d lineage urn (drawing_urn from F30's stamp) → open
  // it directly. No drawing_urn yet (master not re-exported since the stamp) →
  // hand the MASTER urn to the bridge with kind=drawing so CC_Auto resolves the
  // linked .f2d itself (/open?urn=<master>&kind=drawing). Bridge can't find one →
  // it opens the 3D master, an acceptable "got เอ๋ to Fusion" fallback.
  // (RD 04 2026-06-12 e67c8b0 — on-demand resolve, NO manifest backfill.)
  if (node.status === 'stale' && (drawingUrn || urn)) {
    bridgeAttempted = true;
    const target = drawingUrn || urn;
    const kind = drawingUrn ? null : 'drawing';
    try { if (await bridgeOpen(target, kind)) { _toastOpening(node.code); return; } bridgeError = 'bridge declined'; }
    catch (e) { bridgeError = e?.message || 'fetch failed'; }
  }
  // Missing / deleted / drawn-but-404 / fallback → open Fusion 3D master
  if (urn) {
    bridgeAttempted = true;
    try { if (await bridgeOpen(urn)) { _toastOpening(node.code); return; } bridgeError = 'bridge declined'; }
    catch (e) { bridgeError = e?.message || 'fetch failed'; }
  }
  // Last-resort fallback — a PDF that actually exists (handles stale w/o drawing_urn
  // etc.). Skipped under fusionOnly: a PDF tab there reads as "wrong thing opened".
  if (!fusionOnly) {
    const url = pdfUrlForCode(node.code);
    if (url && await _pdfFileExists(url)) { _openInNewTab(url); return; }
    // Web fallback — a CC_LinkNode open_url (Fusion Teams link) if the local bridge isn't reachable
    if (fl && fl.open_url) { _openInNewTab(fl.open_url); return; }
  }

  // Nothing worked — tell the user WHY instead of failing silently.
  if (bridgeAttempted) {
    alert(
      `Couldn't open "${node.code || 'this part'}" in Fusion.\n\n` +
      `The local bridge at http://127.0.0.1:8765 didn't respond:\n` +
      `  ${bridgeError}\n\n` +
      `Checks:\n` +
      `1. Is Fusion OPEN on this PC? If it just started, wait ~30s\n` +
      `   for CC_Auto to load, then click again. (No page reload needed.)\n` +
      `2. Are you on the same PC as Fusion?\n` +
      `   (the bridge only listens on localhost — iPad can't reach it)\n` +
      `3. Is the CC_Auto add-in Running? Utilities → Add-ins → CC_Auto → Run.`
    );
  } else if (!urn) {
    alert(
      `"${node.code || 'this part'}" has no Fusion URN saved (and no linked file).\n\n` +
      `Re-run CC_Assembly in Fusion for this project so the URN is\n` +
      `written into the manifest, then refresh this page — or use the\n` +
      `🔗 Link / Edit-in-Fusion path to pair it.`
    );
  }
}

// Global handle for non-editor surfaces (the Nest workspace's ⚠ no-DXF
// button) — kdAPI only exists after the mindmap editor mounts, so expose
// the router directly too. (เอ๋ 2026-06-10 "Link กลับไปทำที่ Fusion เหมือน NO PDF")
window.kdRouteLeaf = _routeLeafToFusion;

// Clickable outdated / re-check chips on EVERY surface (bend list, sb-cards,
// project BOM, Library). ONE delegated listener in the CAPTURE phase so it fires
// BEFORE the container handlers (sb-card expand, bom-row PDF open, part-row PDF
// open) and stopPropagation suppresses them — no per-surface ignore-list edits.
// (RD 04 2026-06-12 e67c8b0 "clickable on ALL surfaces".)
//   data-act='drawing' → the part's .f2d (router stale-path; drawing_urn fast
//                        path, else master urn + kind=drawing so Fusion finds it)
//   data-act='dxf'     → 3D master (run 🔥 / CC_Laser)
//   data-act='recheck' → 3D master (re-run CC_CheckBend)
// Chips are opt-in (data-act present only when {clickable}); passive chips never match.
let _outdatedChipDelegated = false;
function _wireOutdatedChipDelegation() {
  if (_outdatedChipDelegated) return;
  _outdatedChipDelegated = true;
  document.addEventListener('click', (ev) => {
    const chip = ev.target.closest && ev.target.closest('.sb-recheck-act[data-act]');
    if (!chip) return;
    ev.stopPropagation();   // capture phase → beats the container's own click
    const code = chip.dataset.code;
    if (!code) return;
    const act = chip.dataset.act;
    const urn = _urnForCode(code) || null;
    if (act === 'dxf' || act === 'recheck') {
      // DXF-outdated + ↻ re-check are model→bend actions → open the 3D master.
      _routeLeafToFusion({ code, urn }, { fusionOnly: true });
    } else {
      // drawing-outdated → the part's .f2d. drawing_urn (when stamped) is the fast
      // path; otherwise the router asks the bridge to resolve the master's linked
      // .f2d via kind=drawing. fusionOnly so it never opens the OLD pdf.
      const eff = _effectiveDrawingCode(code);
      const entry = ((manifest && manifest.auto_generated) || {})[eff] || null;
      _routeLeafToFusion(
        { code, urn, drawing_urn: entry ? (entry.drawing_urn || null) : null, status: 'stale' },
        { fusionOnly: true });
    }
  }, true);   // ← capture phase
}
_wireOutdatedChipDelegation();

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
      label: displayCodeFor(node.code),
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
        ${stBadge}<span class="mfc-pp-code" title="${escapeHtml(p.code)}">${escapeHtml(displayCodeFor(p.code))}</span>${cnt}
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

// ─── Compare Similar Drawings Modal ───────────────────────────────
function _openSimilarCompareModal(baseCode, fam) {
  const parts = baseCode.split('-');
  if (parts.length < 2) {
    alert(`Cannot determine WWWHHH size suffix for code "${baseCode}".`);
    return;
  }
  const suffix = parts.pop(); // The part after the last hyphen (e.g. '105003')

  // Find candidates in the same family sharing the same suffix
  const allInFam = partsByFamily()[fam] || [];
  const candidates = allInFam.filter(p => p.code !== baseCode && p.code.endsWith('-' + suffix));

  if (candidates.length === 0) {
    alert(`No similar drawings found in family "${fam}" with suffix "-${suffix}".`);
    return;
  }

  // Build the modal UI
  const ov = document.createElement('div');
  ov.className = 'bt-overlay';
  ov.style.zIndex = '99999';
  
  const basePdf = pdfUrlForCode(baseCode) || '';
  const initialComparePdf = pdfUrlForCode(candidates[0].code) || '';

  const candidateOptions = candidates.map((c, i) => 
    `<option value="${escapeHtml(c.code)}" ${i === 0 ? 'selected' : ''}>${escapeHtml(displayCodeFor(c.code))}</option>`
  ).join('');

  ov.innerHTML = `
    <div class="bt-modal" role="dialog" style="width: 95vw; height: 90vh; max-width: none; display: flex; flex-direction: column;">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #2b3340; padding-bottom: 10px; margin-bottom: 10px;">
        <h2 style="margin: 0; font-size: 18px; color: #58a6ff;">🔍 Compare Drawings</h2>
        <button class="bt-close" aria-label="Close" style="background: transparent; border: none; font-size: 24px; color: #8b949e; cursor: pointer;">×</button>
      </div>
      <div style="display: flex; flex: 1; gap: 10px; overflow: hidden;">
        <!-- Left Pane: Base Code -->
        <div style="flex: 1; display: flex; flex-direction: column; background: #0d1117; border: 1px solid #30363d; border-radius: 6px;">
          <div style="padding: 8px 12px; background: #161b22; border-bottom: 1px solid #30363d; font-weight: bold; color: #c9d1d9;">
            Base: ${escapeHtml(baseCode)}
          </div>
          <iframe src="${escapeHtml(basePdf)}#toolbar=0&navpanes=0" style="flex: 1; border: none; width: 100%;"></iframe>
        </div>
        <!-- Right Pane: Compare Code -->
        <div style="flex: 1; display: flex; flex-direction: column; background: #0d1117; border: 1px solid #30363d; border-radius: 6px;">
          <div style="padding: 8px 12px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; align-items: center; gap: 10px; color: #c9d1d9;">
            <strong style="white-space: nowrap;">Compare with:</strong>
            <select id="compare-select" style="flex: 1; padding: 4px; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 4px;">
              ${candidateOptions}
            </select>
          </div>
          <iframe id="compare-iframe" src="${escapeHtml(initialComparePdf)}#toolbar=0&navpanes=0" style="flex: 1; border: none; width: 100%;"></iframe>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(ov);

  ov.addEventListener('click', e => {
    if (e.target === ov || e.target.closest('.bt-close')) ov.remove();
  });

  const selectEl = ov.querySelector('#compare-select');
  const iframeEl = ov.querySelector('#compare-iframe');
  selectEl.addEventListener('change', () => {
    const selectedCode = selectEl.value;
    iframeEl.src = (pdfUrlForCode(selectedCode) || '') + '#toolbar=0&navpanes=0';
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
  // Returning to Library home = the user left whatever folder they were in →
  // mark it seen now (delayed NEW reset), so its card stops glowing but the row
  // badges were visible the whole time they were inside it.
  if (_pendingSeenFamily) { markFamilySeen(_pendingSeenFamily); _pendingSeenFamily = null; }
  const by = partsByFamily();
  const adminMode = isAdmin();
  // Empty admin-created folders should still appear so the taxonomy is
  // visible even before any parts land in them. Workshop view also sees
  // these folders (consistency) but they show "0 parts".
  const visible = Array.from(new Set([
    ...Object.keys(by).filter(f => by[f].length),
    // Drop the legacy "F1,2,3" combined-cabinet folder — superseded by the
    // per-digit F1/F2/F3 rule (เอ๋ 2026-06-09); its parts now live in F1/F2/F3.
    ..._customFoldersCache.filter(f => f !== 'F1,2,3'),
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

  // Sort modes (เอ๋ 2026-06-11, board 64052e5): Default (manual drag order,
  // above) · A-Z (display label) · Latest (folder freshness = newest part
  // date, the SAME _partDateMs source the NEW badge uses). Persisted per
  // device in localStorage.
  let libSort = 'default';
  try { libSort = localStorage.getItem('kd_lib_sort_v1') || 'default'; } catch {}
  if (libSort === 'az') {
    visible.sort((a, b) => familyDisplayLabel(a).localeCompare(familyDisplayLabel(b)));
  } else if (libSort === 'latest') {
    const latest = fam => (by[fam] || []).reduce((m, p) => Math.max(m, _partDateMs(p)), 0);
    const cache = new Map(visible.map(f => [f, latest(f)]));
    visible.sort((a, b) => (cache.get(b) - cache.get(a)) || familyOrder(a, b));
  }

  const cards = visible.map(fam => {
    const label = familyDisplayLabel(fam);
    const partsInFam = (by[fam] || []).length;
    const newCount = newCountForFamily(fam, by[fam] || []);   // folders with new drawings glow + show "N new"
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
    <div class="family-card${newCount > 0 ? ' family-card-has-new' : ''}" data-family="${escapeHtml(fam)}" style="${famVars(fam)}" ${adminMode ? 'title="Tap ✎ to rename · 🗑 to delete (empty only) · long-press to rename · drag to reorder"' : ''}>
      ${renameBtn}
      ${deleteBtn}
      ${newCount > 0 ? `<div class="family-new-badge" title="${newCount} new drawing${newCount === 1 ? '' : 's'} since you last opened this folder">${newCount} new</div>` : ''}
      <div class="family-icon family-icon-cube">${_familyCubeIcon(fam, 34)}</div>
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

  const sortRow = `
    <div class="lib-sort-row">
      <span class="lib-sort-label">Sort</span>
      ${[['default', 'Default'], ['az', 'A-Z'], ['latest', 'Latest']].map(([k, lbl]) =>
        `<button class="lib-sort-btn${libSort === k ? ' on' : ''}" data-lib-sort="${k}">${lbl}</button>`).join('')}
    </div>`;
  ROOT.innerHTML = `${sortRow}<div class="family-grid">${cards}${newFamilyCard}</div>`;

  ROOT.querySelectorAll('.lib-sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      try { localStorage.setItem('kd_lib_sort_v1', btn.dataset.libSort); } catch {}
      render();
    });
  });

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
      navTo({ kind: 'family', name: el.dataset.family });   // NEW is reset on LEAVE, not open (see _pendingSeenFamily)
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
        const isDxf = /\.dxf$/i.test(file.name);
        if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name) && !isDxf) {
          alert('PDF or DXF only — got ' + (file.type || file.name));
          return;
        }
        const fam = el.dataset.family;
        const guess = file.name.replace(/\.(pdf|dxf)$/i, '');
        const code = prompt(
          `Upload ${isDxf ? 'flat DXF (Sim.Bending)' : 'PDF drawing'} to family "${fam}":\n\n` +
          `Enter the part CODE this file covers ` +
          `(prefix-shares means any other config of the same prefix will inherit too):`,
          guess);
        if (!code) return;
        const ok = isDxf ? await uploadDxfFromDrop(file, code.trim()) : await uploadPdfFromDrop(file, code.trim(), fam);
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
  const items = (partsByFamily()[fam] || []).slice();
  const adminMode = isAdmin();
  // Sort toggle (A–Z by code / Date newest-first) — mirrors the DRAWING tab.
  const famSort = localStorage.getItem('kd_fam_sort') === 'date' ? 'date' : 'az';
  if (famSort === 'date') items.sort((a, b) => (_partDateMs(b) - _partDateMs(a)) || (a.code || '').localeCompare(b.code || ''));
  else items.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
  // Delayed NEW reset: mark the PREVIOUS folder seen when switching to a different
  // one; the folder you're viewing stays unseen so its NEW row badges stay visible.
  if (_pendingSeenFamily && _pendingSeenFamily !== fam) markFamilySeen(_pendingSeenFamily);
  _pendingSeenFamily = fam;
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
      // To REPLACE a part's DXF, just drag an edited .dxf onto the row — it
      // imports immediately (laser + flat), no button (เอ๋ 2026-06-10 'ไม่ต้อง
      // ทำปุ่ม ⤓DXF … ลากไปทับที่บรรทัดนั้น ก็ให้อิมพอร์ตเลย').
      adminBtns = `<div class="part-actions">
        <button class="part-rename-btn" data-rename-code="${escapeHtml(p.code)}" aria-label="Rename display" title="Rename display (does not change the Fusion-side code)">✎</button>
        <button class="part-folder-btn" data-folder-code="${escapeHtml(p.code)}" aria-label="Move to folder" title="Move to a different folder / create new folder">📁</button>
        <button class="part-compare-btn" data-compare-code="${escapeHtml(p.code)}" data-compare-fam="${escapeHtml(fam)}" aria-label="Compare" title="Compare with similar drawings">🔍</button>
        ${dxfBtn}
      </div>`;
    }
    // 🔧 bend chip — only for parts that have a bend_sim record (เอ๋: show the
    // step/punch table next to the drawing). Tapping opens the popup, not the PDF.
    const _bend = _bendSimCache && _bendSimCache[p.code];
    const bendChip = (_bend && Array.isArray(_bend.per_bend) && _bend.per_bend.length)
      ? `<button class="part-bend-btn${_bend.bendable === false ? ' part-bend-bad' : ''}" data-bend-code="${escapeHtml(p.code)}" aria-label="Bend sequence" title="Bend sequence & tooling">🔧</button>`
      : '';
    const isNew = isNewPart(p, fam);
    return `
      <div class="part-row${isNew ? ' is-new' : ''}" data-url="${escapeHtml(url)}" data-code="${escapeHtml(p.code)}" style="${famVars(fam)}">
        <span class="part-icon${url ? ' part-icon-clickable' : ' part-icon-nopdf'}" title="${url ? 'Open drawing PDF' : 'No PDF yet'}" ${url ? `data-url="${escapeHtml(url)}"` : ''}>${familyIcon(fam)}</span>
        <span class="part-code"${codeTitle}>${escapeHtml(display)}</span>
        ${isNew ? '<span class="part-new-badge">NEW</span>' : ''}
        ${ver}
        ${_outdatedChips(p.code, { clickable: true })}
        ${bendChip}
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

  const sortBar = items.length > 1 ? `
    <div class="dwg-sort fam-sort">
      <button class="dwg-sort-btn${famSort === 'az' ? ' active' : ''}" data-fam-sort="az">A–Z</button>
      <button class="dwg-sort-btn${famSort === 'date' ? ' active' : ''}" data-fam-sort="date">Date</button>
    </div>` : '';
  ROOT.innerHTML = `
    <h2 class="section-title section-title-family" style="${famVars(fam)};color:var(--fam-color)">${familyIcon(fam)} ${escapeHtml(fam)}<span class="count">${items.length} parts</span></h2>
    ${breadcrumb}
    ${sortBar}
    <div class="part-list">${list}</div>
    ${emptyHint}
  `;
  ROOT.querySelectorAll('.fam-sort .dwg-sort-btn').forEach(b => {
    b.addEventListener('click', () => { localStorage.setItem('kd_fam_sort', b.dataset.famSort); render(); });
  });

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
      // Ignore clicks on admin buttons + the bend chip — each has its own handler.
      if (ev.target.closest('.part-rename-btn, .part-folder-btn, .part-dxf-btn, .part-bend-btn, .part-compare-btn, .part-icon-clickable')) return;
      if (!el.dataset.url) return;   // no PDF for this part → don't open a blank tab (เอ๋ 2026-06-09)
      // _openInNewTab handles the iPad PWA standalone case (same-window
      // navigation) vs browser (new tab). Plain window.open '_blank'
      // opens an invisible off-screen webview on standalone PWAs —
      // workshop sees "nothing happens" when tapping the row.
      _openInNewTab(el.dataset.url);
    });
  });

  // De-dupe (เอ๋/RD 2026-06-09): the leading-icon -> PDF binding lives in the
  // `.part-icon-clickable` handler below (GA's 793ee23 merged that class into
  // both render blocks). The earlier G2 `.part-row .part-icon` handler here was
  // a SECOND listener on the same span -> clicking opened the PDF in two tabs;
  // removed. The row handler above already ignores `.part-icon-clickable`.

  // 🔧 bend chip → open the bend-sequence table popup (not the PDF). [เอ๋]
  ROOT.querySelectorAll('.part-bend-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _openBendTable(btn.dataset.bendCode);
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
      // Allow a FILE drop. NB: dataTransfer.items is EMPTY during dragover in
      // most browsers (security) — the old `items.some(kind==='file')` gate
      // therefore failed and the browser rejected the drop before it could fire
      // (เอ๋ 'ลากไม่ได้'). dataTransfer.types reliably contains 'Files' during a
      // file drag, so gate on that and preventDefault on BOTH dragenter+dragover.
      const _hasFiles = (ev) => {
        const dt = ev.dataTransfer;
        return !!(dt && dt.types && Array.prototype.indexOf.call(dt.types, 'Files') !== -1);
      };
      rowEl.addEventListener('dragenter', (ev) => { if (_hasFiles(ev)) ev.preventDefault(); });
      rowEl.addEventListener('dragover', (ev) => {
        if (_hasFiles(ev)) {
          ev.preventDefault();
          try { ev.dataTransfer.dropEffect = 'copy'; } catch (e) {}
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
        const isDxf = /\.dxf$/i.test(file.name);
        if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name) && !isDxf) {
          alert('PDF or DXF only — got ' + (file.type || file.name));
          return;
        }
        const code = rowEl.dataset.code;
        if (!code) return;
        // เอ๋ 2026-06-10 'วางทับที่ Part … ไม่ interactive ให้มีการทับเลย': the drop
        // overwrites DIRECTLY, no confirm. A .dxf replaces BOTH of this part's
        // files (เอ๋ chose 'ทั้งสองไฟล์') — the laser-cut DXF (Drawings/dxf/, what
        // the cutter reads) AND the flat DXF (Drawings/flat/, what Sim.Bending
        // reads). Both sha-overwrite in place; success is silent (a toast +
        // re-render), only errors pop an alert.
        // PDF drop keeps its confirm (เอ๋ only asked for the DXF to be direct).
        if (!isDxf && !confirm(`Upload "${file.name}" as the drawing PDF for "${code}"?\n\n(Replaces any existing PDF for this code.)`)) return;
        rowEl.classList.add('part-row-uploading');
        let ok = false;
        if (isDxf) {
          ok = await _replacePartDxfBoth(code, file);   // laser + flat, shared helper
        } else {
          ok = await uploadPdfFromDrop(file, code, fam);
        }
        rowEl.classList.remove('part-row-uploading');
        if (ok) {
          // Firebase listener triggers render — force one in case of timing.
          setTimeout(() => render(), 400);
        }
      });
    });
  }

  ROOT.querySelectorAll('.part-compare-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const code = btn.dataset.compareCode;
      const fam = btn.dataset.compareFam;
      _openSimilarCompareModal(code, fam);
    });
  });

  ROOT.querySelectorAll('.part-icon-clickable').forEach(icon => {
    icon.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _openInNewTab(icon.dataset.url);
    });
  });

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
            <span class="part-code" title="${escapeHtml(m.code)}">${escapeHtml(displayCodeFor(m.code))}</span>
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
          <span class="part-code" title="${escapeHtml(m.part.code)}">${escapeHtml(displayCodeFor(m.part.code))} ×${m.part.qty}</span>
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
    // Belt-and-braces: block navigation to any tab the current role can't
    // see (devtools / scripted click on a hidden tab). Same source of
    // truth as applyTabVisibility so the rule can't drift.
    const _vis = _visibleTabsForRole();
    if (_TAB_IDS[v] && !_vis[v]) return;
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
  // In the DRAWING gallery the search box filters the grid in place (เอ๋), not a
  // global jump.
  if (view === 'drawing' && stack.length === 0) {
    renderDrawingGallery();
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
  initProjectNamesSync();
  initCompletedSync();
  initPinnedSync();
  initFamilyChipSync();
  initUploadedPdfsSync();
  initUploadedDxfsSync();
  initCutSheetsSync();
  initNestPartsSync();
  initActiveRowsSync();
  initBentSync();
  initAssembledSync();
  initCabinetSeenSync();
  // One-shot push of any pre-existing localStorage bent/assembled
  // entries to RTDB so old per-device state surfaces on every device.
  _migrateLocalToFirebase();

  try {
    const [m, f] = await Promise.all([
      fetchJson(_cacheBust(window.APP_CONFIG.MANIFEST_URL)),
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
      missingData = await fetchJson(_cacheBust(missingPath));
    } catch (e) {
      missingData = null;
    }
    // Load drawing_aliases.json — groups of codes that share one drawing.
    // Per feedback_leaf_click_routing + user's "shared drawing" rule.
    // Empty if file absent (no aliases configured yet).
    try {
      const mu = window.APP_CONFIG.MANIFEST_URL || 'Drawings/manifest.json';
      const aliasesPath = mu.replace(/[^/]+$/, 'drawing_aliases.json');
      const aliasData = await fetchJson(_cacheBust(aliasesPath));
      _buildDrawingAliasIndex(aliasData);
    } catch (e) {
      _buildDrawingAliasIndex(null);
    }
    // Rewrite family names (Drawer split, Back-Down → DW-BK, Floor → DW-FL)
    // so everything downstream sees only the new names.
    applyFamilyRemap();
    updateMissingBadge();
    // Baseline for the live auto-refresh + wire the focus/visibility/poll triggers (once).
    _manifestGenAt = manifest.generated_at;
    _initManifestAutoRefresh();

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

    // F2 code reference button (header, next to the theme picker) — เอ๋ 2026-06-13.
    const refBtn = document.getElementById('ref-btn');
    if (refBtn) {
      refBtn.addEventListener('click', _openF2Reference);
      // Visual config browser (เอ๋ 2026-06-14, visual-first) — inject a sibling
      // header button (cube glyph) additively, no index.html edit. Idempotent.
      if (!document.getElementById('cfg-browse-btn')) {
        const b = document.createElement('button');
        b.id = 'cfg-browse-btn';
        b.className = refBtn.className;
        b.title = 'Visual config browser';
        b.setAttribute('aria-label', 'Visual config browser');
        b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.6 L20 7 V17 L12 21.4 L4 17 V7 Z"/><path d="M4 7 L12 11.4 L20 7"/><line x1="12" y1="11.4" x2="12" y2="21.4"/></svg>';
        refBtn.parentNode.insertBefore(b, refBtn.nextSibling);
        b.addEventListener('click', _openConfigBrowser);
      }
    }

    // Tap-to-reload ("NEW VERSION" pill) / F5 must keep เอ๋ where she was — a hard
    // reload otherwise boots to the projects home and she has to navigate back in
    // (เอ๋ 2026-06-13 "กดอัพเดท หน้าต้องอยู่ที่เดิม"). __kdBeforeReload stashed the
    // live view+stack+scroll just before the reload; restore it BEFORE the first
    // render so there's no projects-home flash. Guarded to a fresh reload (< 30s)
    // so reopening the tab much later still starts clean; a now-hidden tab or a
    // deleted project is dropped.
    let _navRestored = false, _restoreScrollY = 0, _restoreAssemblyScroll = 0, _restoreNestProject = null;
    // Capture kd_active_tab BEFORE the first render() — render() calls
    // _saveActiveTab() which would otherwise overwrite it with the default view.
    let _savedActiveTab = null;
    try { _savedActiveTab = JSON.parse(localStorage.getItem('kd_active_tab') || 'null'); } catch (e) {}
    try {
      const rawR = sessionStorage.getItem('kd_nav_restore');
      if (rawR) {
        sessionStorage.removeItem('kd_nav_restore');
        // An explicit deep-link (?p= / ?asm= / #code=) is an intentional entry
        // point — it must WIN over any stashed restore state from a prior reload
        // (otherwise the LINE-shared assembler link would silently drop the user
        // back where they last were instead of into the project).
        const _hasDeepLink = !!window.__kdInitialProject || /[#&]code=/.test(location.hash);
        const s = JSON.parse(rawR);
        if (!_hasDeepLink
            && s && s.view && (Date.now() - (s.t || 0)) < 30000
            && (!_TAB_IDS[s.view] || _visibleTabsForRole()[s.view])) {
          view = s.view;
          document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
          stack = Array.isArray(s.stack)
            ? s.stack.filter(n => n && (n.kind !== 'project' || (manifest.projects && manifest.projects[n.name])))
            : [];
          _restoreScrollY = +s.scrollY || 0;
          _restoreAssemblyScroll = +s.assemblyScroll || 0;
          if (s.view === 'nest' && s.nestProject) _restoreNestProject = s.nestProject;
          _navRestored = true;
        }
      }
    } catch (e) {}

    render();

    if (_navRestored) {
      // Land back at the same scroll, surviving async content fill.
      if (_restoreScrollY) {
        const r = () => { try { window.scrollTo(0, _restoreScrollY); } catch (e) {} };
        r(); requestAnimationFrame(r); setTimeout(r, 80);
      }
      // The Assembly/Mindmap page scrolls INSIDE .kme-assembly-shell (overflow container),
      // NOT the window — so the window restore above is a no-op there (window.scrollY is
      // always 0). Restore the SHELL's scrollTop once the editor has lazy-mounted + grown
      // tall enough to reach the saved spot, so a reload scrolled to §3 Mindmap STAYS at the
      // Mindmap, not §1 Kanban. Keep re-applying while below target (covers the mount + a late
      // re-render) for ~9s, then เอ๋ owns the scroll. (เอ๋ "Ctrl+Shift+R คงรูปแรก"; safe now the
      // editor reliably populates — 1ac4ae9 fixed the blank this used to expose.)
      if (_restoreAssemblyScroll) {
        const _aTarget = _restoreAssemblyScroll;
        let _an = 0;
        const _aiv = setInterval(() => {
          const sh = document.querySelector('.kme-assembly-shell');
          if (sh) {
            const maxT = Math.max(0, sh.scrollHeight - sh.clientHeight);
            if (maxT >= _aTarget - 4 && sh.scrollTop < _aTarget - 4) { try { sh.scrollTop = _aTarget; } catch (e) {} }
          }
          if (++_an > 90) clearInterval(_aiv);
        }, 100);
      }
      // Re-enter the Nest WORKSPACE that was open before the reload (deep sub-state
      // not held in `stack`) — else view='nest' lands on the picker (เอ๋ "ไปหน้าอื่น").
      // kdNest loads as a separate script; wait for it if it isn't ready yet.
      if (_restoreNestProject && manifest.projects && manifest.projects[_restoreNestProject]) {
        const _reopenNest = () => { try { if (window.kdNest && typeof window.kdNest.openProject === 'function') window.kdNest.openProject(_restoreNestProject); } catch (e) {} };
        if (window.kdNest && window.kdNest.openProject) _reopenNest();
        else { let _t = 0; const _iv = setInterval(() => { if ((window.kdNest && window.kdNest.openProject) || ++_t > 50) { clearInterval(_iv); _reopenNest(); } }, 100); }
      }
    } else {
      // No exact same-tab reload state (sessionStorage). Try the persisted active
      // TAB (localStorage kd_active_tab) so a NEW tab / browser restart reopens the
      // tab เอ๋ was on (spec 84f916b). An explicit ?p= / #code deep-link is an
      // intentional entry point and still wins; role-gated + missing-project drilled
      // entries dropped.
      let _tabRestored = false;
      if (!(/[#&]code=/.test(location.hash) || window.__kdInitialProject)) {
        try {
          const at = _savedActiveTab;   // captured before render() clobbered it
          if (at && at.view && at.view !== view
              && (!_TAB_IDS[at.view] || _visibleTabsForRole()[at.view])) {
            view = at.view;
            document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
            stack = Array.isArray(at.stack)
              ? at.stack.filter(n => n && (n.kind !== 'project' || (manifest.projects && manifest.projects[n.name])))
              : [];
            render();
            if (at.view === 'nest' && at.nestProject && manifest.projects && manifest.projects[at.nestProject]) {
              const _reopen = () => { try { if (window.kdNest && window.kdNest.openProject) window.kdNest.openProject(at.nestProject); } catch (e) {} };
              if (window.kdNest && window.kdNest.openProject) _reopen();
              else { let _t = 0; const _iv = setInterval(() => { if ((window.kdNest && window.kdNest.openProject) || ++_t > 50) { clearInterval(_iv); _reopen(); } }, 100); }
            }
            _tabRestored = true;
          }
        } catch (e) {}
      }
      if (!_tabRestored) {
        // Deep-link from a merged-PDF link / shared URL — only when NOT restoring a
        // reload/tab, so a stale #code hash can't override the saved view.
        _applyDeepLinkFromHash();
        // ?p=<projectKey> / ?asm=<projectKey> auto-navigate. For ?asm= the
        // role is also baked to 'assemble' on this device BEFORE the project
        // mounts so role-gated chrome (role chip, tab visibility) is correct
        // on the first paint. Missing project → toast + stay on home.
        const initialProject = window.__kdInitialProject;
        const bakeAsm = !!window.__kdAsmBakeRole;
        if (initialProject) {
          if (manifest.projects && manifest.projects[initialProject]) {
            if (bakeAsm) {
              try { setRole('assemble'); } catch (e) {}
            }
            stack.push({ kind: 'project', name: initialProject });
            window.__kdInitialProject = null;
            window.__kdAsmBakeRole = false;
            render();
          } else {
            try { _kdToast('✗ Project not found: ' + initialProject); } catch (e) {}
            window.__kdInitialProject = null;
            window.__kdAsmBakeRole = false;
          }
        }
      }
    }
    window.addEventListener('hashchange', _applyDeepLinkFromHash);
  } catch (e) {
    ROOT.innerHTML = `<div class="error">Failed to load data: ${escapeHtml(e.message)}<br><br>Check MANIFEST_URL in config.js</div>`;
  }
}

// Stash the live view + stack + scroll just before a reload so init() can put เอ๋
// back where she was. The "NEW VERSION" pill (index.html) calls this explicitly;
// the pagehide listener also covers F5 / a tab reopened within the 30s window.
function __kdBeforeReload() {
  try {
    const se = document.scrollingElement || document.documentElement;
    // Deep sub-state: the Nest TAB's open workspace (kdNest owns its own DOM, so
    // it isn't in `stack`) — stash which project's nest is open so reload re-enters
    // it instead of bouncing to the picker (เอ๋ 2026-06-20 "reload แล้วไปหน้าอื่น").
    let nestProject = null;
    try { nestProject = (window.kdNest && typeof window.kdNest.currentProject === 'function') ? window.kdNest.currentProject() : null; } catch (e) {}
    // The Assembly/Mindmap page scrolls inside .kme-assembly-shell (overflow), NOT the
    // window — window.scrollY is 0 there, so stash the shell's scrollTop too so reload can
    // keep เอ๋ at §3 Mindmap, not §1 Kanban. (เอ๋ "Ctrl+Shift+R คงรูปแรก".)
    let assemblyScroll = 0;
    try { const sh = document.querySelector('.kme-assembly-shell'); if (sh) assemblyScroll = sh.scrollTop || 0; } catch (e) {}
    sessionStorage.setItem('kd_nav_restore', JSON.stringify({
      view, stack, scrollY: window.scrollY || (se && se.scrollTop) || 0, assemblyScroll, nestProject, t: Date.now(),
    }));
  } catch (e) {}
}
window.__kdBeforeReload = __kdBeforeReload;
window.addEventListener('pagehide', __kdBeforeReload);

// Persist the live tab + drill to localStorage `kd_active_tab` (เอ๋ spec 84f916b)
// so a brand-NEW tab / a browser restart reopens the tab เอ๋ was on — the
// sessionStorage `kd_nav_restore` path only survives a same-tab reload. Called
// from render() so it always mirrors the current nav; restored on init only when
// there's no exact-reload state and no explicit ?p=/deep-link entry.
function _saveActiveTab() {
  try {
    let nestProject = null;
    try { nestProject = (window.kdNest && typeof window.kdNest.currentProject === 'function') ? window.kdNest.currentProject() : null; } catch (e) {}
    localStorage.setItem('kd_active_tab', JSON.stringify({ view, stack, nestProject, t: Date.now() }));
  } catch (e) {}
}

init();
