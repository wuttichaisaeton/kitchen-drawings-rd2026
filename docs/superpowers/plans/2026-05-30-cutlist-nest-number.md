# Cut List Nesting Number (#N) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each Laser cut-list row the nesting part number (#N), matching the Nest workspace's numbering, at the front of the row.

**Architecture:** Decoupled — `_renderCutList` in `app.js` computes #N with the SAME rule the nest uses (`nest.js:572`: 1-based rank of the code in the alphabetically-sorted unique-code list). A leading `.cut-num` cell is added to each row; `.cut-row`'s CSS grid gains a leading column. No `nest.js` change, no coupling.

**Tech Stack:** Vanilla JS (`app.js`) + CSS (`style.css`), both load directly — NO build. No JS unit runner; verify via `preview_eval` against `localhost:3030`.

**Spec:** `docs/superpowers/specs/2026-05-30-cutlist-nest-number-design.md`

---

## Preconditions

- Dev server at `localhost:3030` (preview MCP `serverId` from `preview_list`).
- To reach the cut list: it renders in the **Laser** role project view. In `preview_eval` set `localStorage.setItem('kd_role_v1','laser')` and `localStorage.setItem('kd_admin_v1','1')`, reload to `/`, then open a project (exit Nest via `.kdnest-header button` if shown, click "📋 Projects", click the leaf whose exact text is "Bung 01"). The cut list (`.cut-row` elements) renders in that view.
- Screenshots unreliable — assert via DOM/`preview_eval`.

## File Structure

- `app.js` — `_renderCutList(parts, projectKey)` (~line 810): build a `code→#N` map, prepend a `.cut-num` cell to each `.cut-row` template.
- `style.css` — `.cut-row` (line ~2872) is `display:grid` with `grid-template-columns: 1fr auto 28px auto`; add a leading `auto` column for the number, and add a `.cut-num` rule.

---

### Task 1: app.js — compute #N + render the cell

**Files:**
- Modify: `app.js` — `_renderCutList`, the line after `const aggregated = _aggregatePartsByCode(parts);` (~811) and the row template (~851-856).

- [ ] **Step 1: Build the number map**

Immediately after `const aggregated = _aggregatePartsByCode(parts);` (~line 811), add:
```js
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
```

- [ ] **Step 2: Prepend the #N cell in the row template**

In the row template, add the `.cut-num` span as the FIRST child of `.cut-row`, before `.cut-code`. Change:
```js
          <div class="cut-row ${ready ? '' : 'cut-row-missing'}" data-code="${escapeHtml(p.code)}" ${ready ? '' : 'aria-disabled="true"'}>
            <span class="cut-code">${escapeHtml(p.code)}</span>
```
to:
```js
          <div class="cut-row ${ready ? '' : 'cut-row-missing'}" data-code="${escapeHtml(p.code)}" ${ready ? '' : 'aria-disabled="true"'}>
            <span class="cut-num">#${_nestNumberByCode.get(p.code)}</span>
            <span class="cut-code">${escapeHtml(p.code)}</span>
```

- [ ] **Step 3: Verify the map + cell render (DOM)**

Reload + open the Laser cut list (see Preconditions). `preview_eval`:
```js
(() => {
  const rows = [...document.querySelectorAll('.cut-row')];
  const pairs = rows.map(r => ({ num: r.querySelector('.cut-num')?.textContent, code: r.querySelector('.cut-code')?.textContent }));
  // independently compute expected rank by sorting the codes alphabetically
  const codes = pairs.map(p => p.code).sort((a, b) => a.localeCompare(b));
  const ok = pairs.every(p => p.num === '#' + (codes.indexOf(p.code) + 1));
  return { rowCount: rows.length, allNumsPresent: pairs.every(p => /^#\d+$/.test(p.num || '')), ranksMatch: ok, sample: pairs.slice(0, 4) };
})()
```
Expected: `rowCount` = unique part count (17 for Bung 01), `allNumsPresent: true`, `ranksMatch: true` (each row's #N equals its code's 1-based alphabetical rank). No console errors.

- [ ] **Step 4: Commit**
```bash
git add app.js
git commit -m "feat(cutlist): show nesting #N (alphabetical rank) at front of each row"
```

---

### Task 2: style.css — grid column + .cut-num

**Files:**
- Modify: `style.css` — `.cut-row` (~line 2872) and add `.cut-num`.

- [ ] **Step 1: Add the leading grid column**

`.cut-row` is `display:grid`. Adding a 5th cell at the front needs a leading column or all cells shift. Change:
```css
  /* code · qty · grain · status (status doubles as the view button) */
  grid-template-columns: 1fr auto 28px auto;
```
to:
```css
  /* #N · code · qty · grain · status (status doubles as the view button) */
  grid-template-columns: auto 1fr auto 28px auto;
```

- [ ] **Step 2: Add the `.cut-num` rule**

Add (e.g. right after the `.cut-row-drag-over` block, or near `.cut-code` at ~2932):
```css
/* Nesting part number (#N) — leading cell, matches the Nest workspace's
   numbering so a worker can cross-reference a part between the two views. */
.cut-num {
  color: #6e7b8a;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  min-width: 2.4em;
  text-align: right;
}
```

- [ ] **Step 3: Verify alignment + style**

Reload the Laser cut list. `preview_eval`:
```js
(() => {
  const row = document.querySelector('.cut-row');
  const cs = row && getComputedStyle(row);
  const num = document.querySelector('.cut-num');
  return {
    gridCols: cs && cs.gridTemplateColumns,           // should resolve to 5 tracks
    numColor: num && getComputedStyle(num).color,
    numFont: num && getComputedStyle(num).fontFamily,
    childCount: row ? row.children.length : 0,         // 5 (num, code, qty, grain, status)
  };
})()
```
Expected: `gridTemplateColumns` resolves to 5 space-separated track sizes, `childCount: 5`, `numFont` includes monospace. No console errors.

- [ ] **Step 4: Commit**
```bash
git add style.css
git commit -m "style(cutlist): leading #N column + .cut-num styling"
```

---

### Task 3: Final verification + deploy

- [ ] **Step 1: Cross-check against the nest's actual numbers**

With the Laser cut list open, spot-check known codes against the nest's alphabetical order. `preview_eval`:
```js
(() => {
  const map = {};
  document.querySelectorAll('.cut-row').forEach(r => {
    map[r.querySelector('.cut-code')?.textContent] = r.querySelector('.cut-num')?.textContent;
  });
  return {
    'BK1DN1-080000': map['BK1DN1-080000'],   // expect #1
    'BM1NO0-080000': map['BM1NO0-080000'],   // expect #3
    'TS2TRX-000000': map['TS2TRX-000000'],   // expect #17 (last)
  };
})()
```
Expected: `#1`, `#3`, `#17` respectively (matches the nest screenshot). Confirm `preview_console_logs level:error` empty.

- [ ] **Step 2: Push + watch deploy**
```bash
git pull --rebase origin main
git push origin main
```
Watch the latest run to `completed / success` (`gh run list --limit 1 --json databaseId -q '.[0].databaseId'` → `gh run watch <id> --exit-status`), then confirm live:
```bash
curl -s "https://wuttichaisaeton.github.io/kitchen-drawings-rd2026/app.js" | grep -c "_nestNumberByCode"
```
Expected: `>= 1`. (Real Pages host is `wuttichaisaeton.github.io/kitchen-drawings-rd2026` — see `reference_pages_url_and_dxf_download` memory.)
NOTE: the shared working tree may carry unrelated Group 1 changes; if `git pull --rebase` complains about unstaged changes, do NOT discard them — `git stash push -- <their file>`, pull/push, then `git stash pop`. Use `git add <specific file>` only, never `git add -A`.

- [ ] **Step 3: No board entry**

Decoupled, app.js/style.css only, no nest.js touch, no schema change, no question for Group 1. Skip `group-sync.md`.

---

## Self-Review

**Spec coverage:**
- #N = alphabetical rank of unique codes (nest.js:572 rule) → Task 1 Step 1. ✓
- #N at front of row → Task 1 Step 2 (first child) + Task 2 grid leading column. ✓
- Decoupled, app.js + style.css only, no nest.js → all tasks; Task 3 Step 3 confirms no board/nest change. ✓
- Numbers non-contiguous within a family (global) → inherent (map is global; family grouping unchanged). ✓
- No change to grouping/grain/status/row-click → Task 1 only prepends a cell; Task 2 only adds a column + rule. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every check has an expected result. ✓

**Type consistency:** `_nestNumberByCode` (Map) is defined in Task 1 Step 1 and read in Step 2 via `.get(p.code)`. Class name `.cut-num` is identical across Task 1 (JSX), Task 2 (CSS + grid column count), and Task 3 (assertions). Grid goes from 4→5 tracks (Task 2) matching the 5 row children (num+code+qty+grain+status) — consistent with Task 1 adding exactly one leading cell. ✓
