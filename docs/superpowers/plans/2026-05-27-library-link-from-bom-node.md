# Library Link From BOM Node — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tapping the `⚠ NO PDF` chip on a BOM mindmap node opens the Library tab, drills into the part's family, and scroll-highlights the matching part row for 2.5 s.

**Architecture:** Add `openInLibrary(code)` to `window.kdAPI`. The chip handler in the React Flow node (`editor/main.jsx`) calls it with `stopPropagation` so neither the node-level Fusion router nor the drag layer steal the tap. The vanilla shell (`app.js`) replaces the nav stack with `{ kind:'family', name, highlight }` and `renderFamily` reads `highlight` to scroll + flash the matching `.part-row[data-code=…]`. Existing Fusion paths (`⧉ kme-link-badge`, leaf body click → `_routeLeafToFusion`) are untouched.

**Tech Stack:** Vanilla JS shell (`app.js`), React Flow editor bundled via esbuild (`editor/main.jsx` → `editor.bundle.js` + `editor.bundle.css`), plain CSS. No unit test framework; verification uses the Claude Preview MCP (`preview_eval`, `preview_snapshot`) against the dev server on port 3030.

**Spec:** `docs/superpowers/specs/2026-05-27-library-link-from-bom-node-design.md`

---

## File Structure

| File | Role | Change type |
|---|---|---|
| `app.js` | Vanilla shell, navigation, `window.kdAPI` | Modify |
| `editor/main.jsx` | React Flow BOM node — chip JSX + click handler | Modify |
| `editor/style.css` | Compiled into `editor.bundle.css` — chip clickable styles | Modify |
| `style.css` | Root stylesheet — `.part-row-highlight` + keyframes | Modify |
| `editor.bundle.js` | Build artifact | Regenerate (commit) |
| `editor.bundle.css` | Build artifact | Regenerate (commit) |

No new files. All changes additive — existing call sites continue to work.

---

## Pre-flight: start dev server + iPad-sim viewport

- [ ] **Step 0.1: Ensure preview server is running**

```
mcp__Claude_Preview__preview_list
```

Expected: a server named `drawings-ui` on port 3030. If not, start it:

```
mcp__Claude_Preview__preview_start { name: "drawings-ui" }
```

- [ ] **Step 0.2: Set iPad Pro 12.9 Gen 1 portrait viewport**

```
mcp__Claude_Preview__preview_resize { serverId, width: 1024, height: 1366 }
```

Expected: `Viewport set to 1024x1366.`

Note: each verification step assumes you have `serverId` from `preview_list`. Replace `<sid>` in commands.

---

## Task 1: Add `data-code` attribute to `.part-row` in Library

**Files:**
- Modify: `app.js:4683` (inside `renderFamily`)

**Why first:** This is the hook the highlight logic in Task 2 will use to find the right row. Adding the attribute first means we can verify Task 2 without partial state.

- [ ] **Step 1.1: Read current state of part-row HTML template**

The existing block at `app.js:4682-4687`:

```js
return `
  <div class="part-row" data-url="${escapeHtml(url)}" style="${famVars(fam)}">
    <span class="part-icon">${familyIcon(fam)}</span>
    <span class="part-code">${escapeHtml(p.code)}</span>
    ${ver}
  </div>`;
```

- [ ] **Step 1.2: Verify (FAIL): part-row has no data-code today**

Navigate to a family in the Library, then run:

```
preview_eval { serverId, expression: `
  (() => {
    // Force Library home, then drill into 'DW-FL' (Floor)
    location.hash = '';
    const tab = document.getElementById('tab-library');
    tab && tab.click();
    const fam = document.querySelector('.family-card[data-family="DW-FL"], .family-card[data-family="FL"]');
    if (fam) fam.click();
    const row = document.querySelector('.part-row');
    return {
      hasDataCode: row ? row.hasAttribute('data-code') : null,
      sample: row ? row.outerHTML.slice(0, 200) : 'no row'
    };
  })()
` }
```

Expected: `hasDataCode: false` (or `null` if no row visible — pick another family that has parts).

- [ ] **Step 1.3: Add `data-code` attribute**

Edit `app.js:4683`. Change:

```js
<div class="part-row" data-url="${escapeHtml(url)}" style="${famVars(fam)}">
```

to:

```js
<div class="part-row" data-url="${escapeHtml(url)}" data-code="${escapeHtml(p.code)}" style="${famVars(fam)}">
```

- [ ] **Step 1.4: Verify (PASS): data-code present**

Reload the page (`preview_eval { expression: 'location.reload()' }`), navigate back into a family, then:

```
preview_eval { serverId, expression: `
  (() => {
    const rows = document.querySelectorAll('.part-row[data-code]');
    return {
      count: rows.length,
      first: rows[0] ? rows[0].getAttribute('data-code') : null
    };
  })()
` }
```

Expected: `count > 0`, `first` is a part code like `"FN0000-080000"`.

- [ ] **Step 1.5: Commit**

```bash
git add app.js
git commit -m "feat(library): add data-code attr to part-row for deep-link targeting"
```

---

## Task 2: Extend `renderFamily` to honour `highlight`

**Files:**
- Modify: `app.js:1769` (renderFamily call site)
- Modify: `app.js:4673` (renderFamily definition — signature + body)

- [ ] **Step 2.1: Verify (FAIL) — renderFamily currently ignores extra args**

```
preview_eval { serverId, expression: `
  (() => {
    // Navigate to Library home + push a family with a fake highlight
    location.hash = '';
    document.getElementById('tab-library').click();
    // Mutate the module-private 'stack' via the global render() path:
    // we can't reach 'stack' directly but we can simulate by calling
    // navTo with the extra prop and confirming it's IGNORED today.
    if (typeof navTo === 'function') {
      navTo({ kind:'family', name:'DW-FL', highlight:'FN0000-080000' });
    }
    setTimeout(() => {}, 50);
    const hl = document.querySelector('.part-row-highlight');
    return { hasHighlight: !!hl };
  })()
` }
```

Expected: `hasHighlight: false`.

- [ ] **Step 2.2: Update the dispatcher to pass `highlight`**

Edit `app.js:1769`. Change:

```js
if (top.kind === 'family') return renderFamily(top.name);
```

to:

```js
if (top.kind === 'family') return renderFamily(top.name, top.highlight);
```

- [ ] **Step 2.3: Extend `renderFamily` signature + add highlight logic**

Edit `app.js:4673`. Change the function signature:

```js
function renderFamily(fam) {
```

to:

```js
function renderFamily(fam, highlight) {
```

Then, at the end of `renderFamily` (after the `ROOT.querySelectorAll('.part-row').forEach(...)` block at `app.js:4697-4699`), append:

```js
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
```

- [ ] **Step 2.4: Verify (PASS) — highlight class appears + clears**

```
preview_eval { serverId, expression: `
  (() => {
    location.hash = '';
    document.getElementById('tab-library').click();
    navTo({ kind:'family', name:'DW-FL', highlight:'FN0000-080000' });
    return new Promise(resolve => setTimeout(() => {
      const hl = document.querySelector('.part-row-highlight');
      const target = document.querySelector('.part-row[data-code="FN0000-080000"]');
      resolve({
        immediateHighlight: !!hl,
        targetFound: !!target,
        targetIsHighlighted: target ? target.classList.contains('part-row-highlight') : false
      });
    }, 200));
  })()
` }
```

Expected: `immediateHighlight: true`, `targetFound: true`, `targetIsHighlighted: true`.

Then wait and re-check:

```
preview_eval { serverId, expression: `
  new Promise(resolve => setTimeout(() => {
    resolve({ stillHighlighted: !!document.querySelector('.part-row-highlight') });
  }, 2800))
` }
```

Expected: `stillHighlighted: false`.

If the part code `FN0000-080000` doesn't exist in your data, substitute any code that does — the rendered Library home shows family counts; pick a family and grab a real code from `.part-row` in the DOM first.

- [ ] **Step 2.5: Commit**

```bash
git add app.js
git commit -m "feat(library): renderFamily honours highlight prop with scroll + 2.5s flash"
```

---

## Task 3: Add `openInLibrary(code)` to `window.kdAPI`

**Files:**
- Modify: `app.js:2211-2225` (the `window.kdAPI = { ... }` block)

- [ ] **Step 3.1: Verify (FAIL) — method does not exist yet**

```
preview_eval { serverId, expression: `({ has: typeof window.kdAPI?.openInLibrary })` }
```

Expected: `has: "undefined"`.

- [ ] **Step 3.2: Add the method**

Inside the `window.kdAPI = { ... }` object literal at `app.js:2211`, append a new method just before the closing `};` at line 2225:

```js
    // Deep-link from a mindmap BOM node's NO PDF chip to the matching
    // part row in the Library tab. Replaces the nav stack (not push)
    // so Back goes to Library home, not project mindmap — see spec
    // 2026-05-27-library-link-from-bom-node-design.md §UX Flow.
    openInLibrary(code) {
      if (!code) return;
      const fam = _remapFamilyForCode(code,
        (manifest.auto_generated?.[code]?.family) ||
        (manifest.projects && Object.values(manifest.projects)
          .flatMap(p => p.parts || [])
          .find(p => p.code === code)?.family));
      if (!fam) return;
      view = 'library';
      document.getElementById('tab-projects')?.classList.remove('active');
      document.getElementById('tab-library')?.classList.add('active');
      stack = [{ kind: 'family', name: fam, highlight: code }];
      render();
    },
```

Place it right after the `rerender: () => { ... }` line and before the closing `};`.

- [ ] **Step 3.3: Verify (PASS) — full happy path**

```
preview_eval { serverId, expression: `
  (() => {
    // Pick a real BOM code that exists. Read it from the manifest.
    const codes = Object.keys(window.manifest?.auto_generated || {});
    const sample = codes[0];
    if (!sample) return { error: 'no manifest codes loaded' };
    window.kdAPI.openInLibrary(sample);
    return new Promise(r => setTimeout(() => {
      const libActive = document.getElementById('tab-library')?.classList.contains('active');
      const sectionTitle = document.querySelector('.section-title')?.textContent.trim();
      const target = document.querySelector(\`.part-row[data-code="\${sample}"]\`);
      r({
        sample,
        libActive,
        sectionTitle,
        targetExists: !!target,
        targetHighlighted: target ? target.classList.contains('part-row-highlight') : false,
      });
    }, 250));
  })()
` }
```

Expected: `libActive: true`, `sectionTitle` includes the family chip, `targetExists: true`, `targetHighlighted: true`.

- [ ] **Step 3.4: Verify back-button semantics**

```
preview_eval { serverId, expression: `
  (() => {
    if (typeof navBack === 'function') navBack();
    return {
      sectionExists: !!document.querySelector('.section-title'),
      familyGridExists: !!document.querySelector('.family-grid'),
    };
  })()
` }
```

Expected: `sectionExists: false`, `familyGridExists: true` (i.e., Back lands on Library home, not project mindmap — matches the spec's replace-stack semantics).

- [ ] **Step 3.5: Commit**

```bash
git add app.js
git commit -m "feat(library): expose kdAPI.openInLibrary(code) — replaces nav stack"
```

---

## Task 4: CSS — `.part-row-highlight` + keyframe

**Files:**
- Modify: `style.css` (append a new block near other part-row rules around `style.css:1325`)

- [ ] **Step 4.1: Verify (FAIL) — class has no styles yet**

```
preview_eval { serverId, expression: `
  (() => {
    const div = document.createElement('div');
    div.className = 'part-row-highlight';
    document.body.appendChild(div);
    const cs = getComputedStyle(div);
    const result = {
      outline: cs.outline,
      boxShadow: cs.boxShadow,
      animation: cs.animation
    };
    div.remove();
    return result;
  })()
` }
```

Expected: outline empty/`none`, boxShadow `none`, animation empty.

- [ ] **Step 4.2: Append CSS**

Open `style.css` and append at the end of the file (or right after the existing `.part-row:active` block at line ~1328):

```css
/* Library deep-link highlight — fired by renderFamily when navigated
   from a mindmap "NO PDF" chip. Auto-removed after 2.5s by the JS
   side; the animation is a one-shot fade so even if the class lingers
   the visual cue still subsides. See spec
   docs/superpowers/specs/2026-05-27-library-link-from-bom-node-design.md */
.part-row-highlight {
  outline: 2px solid var(--fam-color, #4a90e2);
  outline-offset: 1px;
  animation: kd-highlight-pulse 2.5s ease-out;
}

@keyframes kd-highlight-pulse {
  0%   { box-shadow: 0 0 0 0    var(--fam-color, #4a90e2),
                     0 0 24px   var(--fam-color, #4a90e2); }
  60%  { box-shadow: 0 0 0 6px  rgba(74, 144, 226, 0.05),
                     0 0 18px   var(--fam-color, #4a90e2); }
  100% { box-shadow: 0 0 0 0px  rgba(74, 144, 226, 0),
                     0 0 0      transparent; }
}
```

- [ ] **Step 4.3: Verify (PASS) — class produces visible styles**

Reload (`location.reload()`), then:

```
preview_eval { serverId, expression: `
  (() => {
    const div = document.createElement('div');
    div.className = 'part-row part-row-highlight';
    div.style.setProperty('--fam-color', '#4a90e2');
    document.body.appendChild(div);
    const cs = getComputedStyle(div);
    const result = {
      outline: cs.outline,
      animation: cs.animation || cs.animationName,
    };
    div.remove();
    return result;
  })()
` }
```

Expected: `outline` contains `solid`, `animation` references `kd-highlight-pulse`.

- [ ] **Step 4.4: Commit**

```bash
git add style.css
git commit -m "feat(library): add .part-row-highlight + kd-highlight-pulse keyframes"
```

---

## Task 5: CSS — make `.kme-missing-badge` a real touch target

**Files:**
- Modify: `editor/style.css:382-390` (existing `.kme-missing-badge` rule)

- [ ] **Step 5.1: Read current state**

Current rule at `editor/style.css:382-390`:

```css
.kme-missing-badge {
  background: rgba(248, 81, 73, 0.18);
  color: #f85149;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 6px;
  white-space: nowrap;
}
```

- [ ] **Step 5.2: Verify (FAIL) — current badge is small + not pointer**

In the preview, open a project with a NO PDF BOM node (e.g. `100VB0-080000` has 3 missing). Then:

```
preview_eval { serverId, expression: `
  (() => {
    const b = document.querySelector('.kme-missing-badge');
    if (!b) return { found: false };
    const cs = getComputedStyle(b);
    const rect = b.getBoundingClientRect();
    return {
      found: true,
      cursor: cs.cursor,
      height: Math.round(rect.height),
      width: Math.round(rect.width),
    };
  })()
` }
```

Expected: `cursor: "auto"` (or similar non-pointer), `height` < 20.

- [ ] **Step 5.3: Update the rule + add interactive states**

Replace the existing `.kme-missing-badge` block in `editor/style.css` with:

```css
.kme-missing-badge {
  background: rgba(248, 81, 73, 0.18);
  color: #f85149;
  font-size: 10px;
  font-weight: 700;
  padding: 6px 10px;
  border-radius: 6px;
  white-space: nowrap;
  min-height: 32px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 120ms ease, border-color 120ms ease;
}
.kme-missing-badge:hover {
  background: rgba(248, 81, 73, 0.28);
  border-color: rgba(248, 81, 73, 0.5);
}
.kme-missing-badge:active {
  background: rgba(248, 81, 73, 0.36);
}
```

The padding bump (6/10 vs 1/6) + min-height: 32px brings the chip to a ~32px hit area, well above the 17 px height measured during the iPad simulator test. Apple HIG's 44pt would consume too much of the node header — 32px is the compromise per spec §Section 3.

- [ ] **Step 5.4: Note: bundle rebuild will be Task 7**

We don't rebuild the editor bundle until both `editor/style.css` and `editor/main.jsx` are updated. Run Task 5 first, then Task 6, then Task 7 rebuilds both.

- [ ] **Step 5.5: Commit (source only — bundle comes later)**

```bash
git add editor/style.css
git commit -m "feat(editor): make NO PDF badge a clickable 32px touch target"
```

---

## Task 6: Wire onClick on the NO PDF badge in `editor/main.jsx`

**Files:**
- Modify: `editor/main.jsx:280` (the badge JSX)
- Modify: `editor/main.jsx:573` (the inner-button passthrough selector — confirm it now also catches the badge so the node-level click doesn't double-fire)

- [ ] **Step 6.1: Read current state**

`editor/main.jsx:279-281`:

```jsx
{missing && isBom && (
  <span className="kme-missing-badge" title="No PDF yet — drag a PDF onto this node to upload">⚠ NO PDF</span>
)}
```

`editor/main.jsx:573`:

```js
if (evt?.target?.closest?.('.kme-mini, .kme-link-badge, [contenteditable="true"]')) return;
```

- [ ] **Step 6.2: Add onClick to the badge**

Replace the existing block at line 279-281 with:

```jsx
{missing && isBom && (
  <span
    className="kme-missing-badge"
    title="Open in Library to inspect or drop a PDF"
    onClick={(e) => {
      e.stopPropagation();
      if (code && api.openInLibrary) api.openInLibrary(code);
    }}
  >
    ⚠ NO PDF 🔗
  </span>
)}
```

The `🔗` suffix is the affordance hint required by spec §Section 2 (style.css text).

- [ ] **Step 6.3: Add `.kme-missing-badge` to the inner-button passthrough at line 573**

Change:

```js
if (evt?.target?.closest?.('.kme-mini, .kme-link-badge, [contenteditable="true"]')) return;
```

to:

```js
if (evt?.target?.closest?.('.kme-mini, .kme-link-badge, .kme-missing-badge, [contenteditable="true"]')) return;
```

This is defence-in-depth: `stopPropagation` already prevents bubbling, but if React Flow handles the event in a separate handler that doesn't see the stop, this selector still keeps `onNodeClick` from routing to Fusion.

- [ ] **Step 6.4: Commit source change (bundle rebuild next)**

```bash
git add editor/main.jsx
git commit -m "feat(editor): NO PDF chip onClick → kdAPI.openInLibrary(code)"
```

---

## Task 7: Rebuild editor bundle + commit artifacts

**Files:**
- Regenerate: `editor.bundle.js`, `editor.bundle.css`

- [ ] **Step 7.1: Build**

```bash
cd drawings-ui
npm run build:editor
```

Expected stdout: `[editor] built editor.bundle.js + editor.bundle.css`.

- [ ] **Step 7.2: Verify bundle contains the new code**

```bash
grep -c "openInLibrary" editor.bundle.js
grep -c "NO PDF 🔗" editor.bundle.js
grep -c "kme-missing-badge" editor.bundle.css
```

Expected: each `grep -c` returns ≥ 1.

(Use the Grep tool, not Bash grep, per workspace conventions.)

- [ ] **Step 7.3: Reload preview and verify chip is interactive**

```
preview_eval { serverId, expression: `location.reload()` }
```

Then navigate into a project with a NO PDF BOM node, and:

```
preview_eval { serverId, expression: `
  (() => {
    const b = document.querySelector('.kme-missing-badge');
    if (!b) return { found: false };
    const cs = getComputedStyle(b);
    return {
      found: true,
      text: b.textContent.trim(),
      cursor: cs.cursor,
      minHeight: cs.minHeight,
      hasOnClick: !!b.onclick,  // React inline onClick attaches via fiber, this may be false
    };
  })()
` }
```

Expected: `text: "⚠ NO PDF 🔗"`, `cursor: "pointer"`, `minHeight: "32px"`. (`hasOnClick` may be false — React uses synthetic events; check by clicking instead.)

- [ ] **Step 7.4: Commit bundles**

```bash
git add editor.bundle.js editor.bundle.css
git commit -m "build(editor): regenerate bundle with NO PDF → Library wiring"
```

---

## Task 8: End-to-end test on the iPad simulator

This task is verification only — no code changes. We verify the full spec testing plan (§A and §B).

- [ ] **Step 8.1: Test 1 — happy path (chip → Library row + highlight)**

```
preview_eval { serverId, expression: `
  (() => {
    location.hash = '';
    document.getElementById('tab-projects').click();
    // Click into a project with NO PDF parts
    const card = [...document.querySelectorAll('.project-card')]
      .find(c => c.textContent.includes('no drawing'));
    if (!card) return { error: 'no project with NO PDF parts in fixtures' };
    card.click();
    return { opened: card.dataset.project };
  })()
` }
```

Then wait for mindmap render, find a NO PDF chip, and click it:

```
preview_eval { serverId, expression: `
  new Promise(resolve => {
    setTimeout(() => {
      const chip = document.querySelector('.kme-missing-badge');
      if (!chip) { resolve({ error: 'no chip in this project' }); return; }
      const nodeCode = chip.closest('.react-flow__node')?.dataset?.id?.replace('bom:','');
      chip.click();
      setTimeout(() => {
        const libActive = document.getElementById('tab-library')?.classList.contains('active');
        const target = document.querySelector('.part-row.part-row-highlight');
        resolve({
          nodeCode,
          libActive,
          highlightedRow: target ? target.querySelector('.part-code')?.textContent : null,
        });
      }, 350);
    }, 600);
  })
` }
```

Expected: `libActive: true`, `highlightedRow` equals `nodeCode`.

- [ ] **Step 8.2: Test 2 — highlight clears after 2.5s**

```
preview_eval { serverId, expression: `
  new Promise(r => setTimeout(() => r({
    stillHighlighted: !!document.querySelector('.part-row-highlight')
  }), 2800))
` }
```

Expected: `stillHighlighted: false`.

- [ ] **Step 8.3: Test 3 — Back goes to Library home, not project mindmap**

```
preview_eval { serverId, expression: `
  (() => {
    document.querySelector('.back-btn')?.click();
    return new Promise(r => setTimeout(() => r({
      onLibraryHome: !!document.querySelector('.family-grid'),
      onProjectMindmap: !!document.querySelector('.react-flow'),
    }), 200));
  })()
` }
```

Expected: `onLibraryHome: true`, `onProjectMindmap: false`.

- [ ] **Step 8.4: Test 4 (regression) — ⧉ link badge still opens Fusion**

```
preview_eval { serverId, expression: `
  (() => {
    // Navigate back to project view, find a node with a Fusion link
    location.hash = '';
    document.getElementById('tab-projects').click();
    const card = document.querySelector('.project-card');
    card?.click();
    return new Promise(r => setTimeout(() => {
      const linkBadge = document.querySelector('.kme-link-badge');
      if (!linkBadge) { r({ skip: 'no linked node in fixtures' }); return; }
      // Stub fetch to the bridge to confirm the call without actually invoking Fusion
      const fetchCalls = [];
      const origFetch = window.fetch;
      window.fetch = (url, ...rest) => { fetchCalls.push(url); return Promise.resolve({ok:true,json:()=>({})}); };
      linkBadge.click();
      setTimeout(() => {
        window.fetch = origFetch;
        r({ fetchCalls });
      }, 200);
    }, 600));
  })()
` }
```

Expected: `fetchCalls` contains a URL targeting `localhost:8765` (the CC bridge per memory `cc_link_node_and_launcher`).

- [ ] **Step 8.5: Test 5 (regression) — leaf body click still routes via `_routeLeafToFusion`**

```
preview_eval { serverId, expression: `
  (() => {
    const orig = window.kdAPI.routeLeaf;
    let called = null;
    window.kdAPI.routeLeaf = (args) => { called = args; };
    // Click a BOM leaf node body (not the chip)
    const node = document.querySelector('.react-flow__node-mindmap .kme-node');
    if (!node) return { error: 'no BOM node' };
    // Click a non-button area
    const head = node.querySelector('.kme-row-head .kme-node-label');
    head?.click();
    setTimeout(() => { window.kdAPI.routeLeaf = orig; }, 0);
    return { routeLeafCalled: called };
  })()
` }
```

Expected: `routeLeafCalled` is an object with `code` set. (Implementation note: the React Flow `onNodeClick` passes via the node element, so the synthetic click on a child element should still bubble through React Flow's wrapper. If this test reads `routeLeafCalled: null`, swap the `head?.click()` for `node.click()`.)

- [ ] **Step 8.6: Test 6 — PDF mini button still opens PDF tab**

```
preview_eval { serverId, expression: `
  (() => {
    const pdfBtn = document.querySelector('.kme-mini.kme-pdf');
    if (!pdfBtn) return { skip: 'no PDF button in current project' };
    const calls = [];
    const orig = window.open;
    window.open = (...a) => { calls.push(a); return { focus: () => {} }; };
    pdfBtn.click();
    window.open = orig;
    return { calls };
  })()
` }
```

Expected: `calls` contains a URL ending in `.pdf`.

- [ ] **Step 8.7: Test 7 — landscape (1366×1024) repeat of Test 1**

```
preview_resize { serverId, width: 1366, height: 1024 }
preview_eval { serverId, expression: 'location.reload()' }
```

Then repeat Step 8.1's click flow. Expected: identical results.

- [ ] **Step 8.8: Console check — no errors / warnings introduced**

```
preview_console_logs { serverId, level: "warn", lines: 50 }
```

Expected: no errors. Warnings only if they predate this work.

---

## Task 9: Push + verify GitHub Pages deploy

- [ ] **Step 9.1: Push to main**

```bash
git push origin main
```

- [ ] **Step 9.2: Wait + verify GH Pages deploy**

Per memory `feedback_check_deploy`: every push must be followed by checking the deploy until the version appears. GH Pages typically serves ~1 minute after push.

```
gh run watch
```

Or visit the live site and confirm the build stamp updates. The editor bundle prints `__KME_BUILD__` (a `MM-DD HH:MM` timestamp) in the toolbar — verify it matches the commit time.

- [ ] **Step 9.3: Report deploy status**

Tell the user the version is live, with the deployed build stamp.

---

## Task 10: User verification on real iPad PWA

This is **not** code work — it's เอ๋ verifying on the actual iPad PWA per the handoff:

- [ ] **Step 10.1: Hand off to เอ๋**

Send a short summary:

> "Library link from NO PDF chip ขึ้นแล้วบน GH Pages (build `<stamp>`). ลองบน iPad PWA ครับ:
> 1. เปิด project ที่มี NO PDF
> 2. แตะ `⚠ NO PDF 🔗` chip
> 3. ควรเด้งไป Library tab + scroll หา part + เรืองแสง 2.5s
> 4. กด Back → กลับ Library home
> 5. เช็ค ⧉ Fusion link เดิมและ leaf click ยังทำงาน"

Wait for confirmation or feedback before declaring done.

---

## Self-Review (run before handoff)

After completing all tasks, run this checklist with fresh eyes:

1. **Spec coverage** — each numbered subsection of the spec maps to a task:
   - Spec §UX Flow → Tasks 3 + 4 (navigation + highlight)
   - Spec §Architecture (kdAPI.openInLibrary) → Task 3
   - Spec §Architecture (renderFamily + data-code) → Tasks 1 + 2
   - Spec §Architecture (style.css) → Task 4
   - Spec §Architecture (editor click + nodrag) → Task 6
   - Spec §Edge cases → Task 3 (early-return for null fam) + Task 2 (querySelector null-safe)
   - Spec §Testing Plan §A → Task 8 steps 1-3, 7
   - Spec §Testing Plan §B → Task 8 steps 4-6
   - Spec §Testing Plan §C → Task 10
   - Spec §Build & Deploy → Tasks 7 + 9
   - Spec §Out of Scope (touch targets on other minis) → explicitly NOT in this plan ✓

2. **Placeholder scan** — search the plan for `TBD`, `TODO`, `implement later`, `appropriate`, `handle edge cases`. There should be none.

3. **Type consistency** — names used across tasks:
   - `openInLibrary` (Task 3) — same identifier used by Task 6's `api.openInLibrary(code)` ✓
   - `.part-row[data-code]` (Task 1) — same selector used by Task 2 ✓
   - `.part-row-highlight` (Task 2 adds class) — same class styled in Task 4 ✓
   - `.kme-missing-badge` — same class in Task 5 (CSS), Task 6 (JSX), Task 8 (selector) ✓
   - `_remapFamilyForCode(code, originalFamily)` — Task 3 passes 2 args matching existing signature at `app.js:340` ✓

Fix any issues inline before handoff.
