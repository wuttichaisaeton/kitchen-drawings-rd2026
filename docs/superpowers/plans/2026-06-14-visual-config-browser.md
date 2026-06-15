# Visual Config Browser — Implementation Plan

> Single-file feature (app.js). Build → screenshot → เอ๋ approves → push. Steps use `- [ ]`.

**Goal:** A visual browser of real F2-family configs as cube-icon cards (big box icon + short English decoded desc + small 13-char code), with search/filter + group by master/family, each card clicking through to Fusion (.f2d if it exists, else 3D) via the existing router.

**Architecture:** Reuse the existing cube engine (currently local to `_openF2Reference`) by extracting it to a module-scope `_f2CubeKit()`; `_openF2Reference` refactors to call it (must render identically). Add `_decodeF2Code(code)` (logic, not icons). Add `_openConfigBrowser()` modal (kdstock shell) rendering cards from REAL F2 codes in `manifest.auto_generated` + project parts; if none → clearly-badged SAMPLE cards. Entry = a header button injected via app.js init (no index.html edit). Click → `_routeLeafToFusion(..., {fusionOnly:true})`.

**Rules:** English-only rendered UI. REAL codes only (`^2[A-Z0-9]{5}-\d{6}$`), never fabricate — samples are badged SAMPLE. pull --rebase; commit pathspec app.js + this plan only. Verify in preview; **screenshot to เอ๋ before push.**

---

### Task 1: Extract the cube engine to module scope `_f2CubeKit()`

**Files:** Modify `app.js` (`_openF2Reference` ~1639).

- [ ] Create module-scope `function _f2CubeKit()` holding the geometry (`VX/_TOP/_FRONT/_RIGHT/_LL/_LR/_HID`), colors (`CB`), and builders (`_face/_vcube/_door/_ln/_hover/_strip/_csvg`), plus light icons (`ic/bulbOn/bulbOff/dash`). Return `{ cube(key,size=20), fnIcon(size=20), fcIcon(size=20), bulbOn, bulbOff, dash }`. `cube/fnIcon/fcIcon` accept an optional pixel size (wrap via `_csvg(inner, size)`); fnIcon/fcIcon become functions.
- [ ] Refactor `_openF2Reference` to `const K = _f2CubeKit();` and replace `cube(x)`→`K.cube(x)`, `fnIcon`→`K.fnIcon()`, `fcIcon`→`K.fcIcon()`, `bulbOn/bulbOff/dash`→`K.bulbOn/...`. Keep its modal-specific bits (tmpl cells, legend, examples, INK/SUB/AMBER/MONO/CARD) unchanged.
- [ ] `node --check`; preview: open F2 reference (`#ref-btn`) → renders IDENTICAL to before (screenshot compare).

### Task 2: `_decodeF2Code(code)` — code → icon + English description

**Files:** Modify `app.js`.

- [ ] Add module-scope `_decodeF2Code(code)`. Validate `^2[A-Z0-9]{5}-\d{6}$`. Positions: `idx1-2`=type, `idx3`=light(L/N/0), `idx4`=hand(L/R/D/0), `idx5`=version, `idx7-9`=W×10, `idx10-12`=H×10. Returns `{valid, type, iconHtml(size), light, hand, version, w, h, desc}` where:
  - main icon: FN→`K.fnIcon`, FC→`K.fcIcon`, BK/SD/UP/DN/CF/CH/CV→`K.cube(type)`, else `K.cube('F2')`.
  - `desc` = `${typeLabel}` + (hand≠0 ` · ${handLabel}`) + (light≠0 ` · ${lightLabel}`) + ` · ${w}×${h}`.
  - labels: FN straight, FC corner, BK back, SD side, UP top, DN bottom, CF cover front, CH cover horizontal, CV cover vertical; hand L left/R right/D double; light L on/N off.

### Task 3: `_openConfigBrowser()` modal — card grid + search + group

**Files:** Modify `app.js`.

- [ ] Gather REAL F2 codes: `Object.keys(manifest.auto_generated||{})` + every `manifest.projects[*].parts[*].code`, dedupe, filter `^2[A-Z0-9]{5}-\d{6}$`. If empty → 3 SAMPLE codes (2FNLL0-060072 / 2FCND0-060060 / 2CF0R0-060072) each card badged `SAMPLE` + a top banner "No real F2 configs in the data yet — showing samples."
- [ ] Group by master/family: group key = `_remapFamilyForCode(code, '')` or the code's type (idx1-2). Render a section per group (sorted), each a responsive card grid.
- [ ] Card = big icon (`iconHtml(56)`) on top, English `desc` (decoded), small mono 13-char `code` (secondary), `data-code`. kdstock modal shell, scrollable, `max-width` wide. Search box filters by code substring (live). 
- [ ] Click a real card → `_routeLeafToFusion({code, urn:_urnForCode(code), drawing_urn:(manifest.auto_generated[_effectiveDrawingCode(code)]||{}).drawing_urn||null, status:'stale'}, {fusionOnly:true})`. SAMPLE cards: no routing (cursor default + title "sample, not in data").

### Task 4: Entry point (header button injected via app.js)

**Files:** Modify `app.js` (init, near `#ref-btn` wiring ~12656).

- [ ] On init, inject a header button (cube glyph, `title="Visual config browser"`) next to `#ref-btn` (or into the header controls) and wire `click → _openConfigBrowser()`. No index.html edit. Idempotent (guard against double-inject).

### Verification
- [ ] `node --check`; `node --test` 24/24.
- [ ] preview: F2 ref unchanged; new button opens browser; cards render with icons+desc+code; search filters; group sections; click a real card → router fires (fetch to 127.0.0.1:8765); SAMPLE path shows badge when no real data; 0 console errors.
- [ ] **Screenshot → เอ๋ for design approval. Do NOT push until approved.**
- [ ] After approval: commit pathspec (app.js + plan), push, watch deploy, verify live, board entry.
