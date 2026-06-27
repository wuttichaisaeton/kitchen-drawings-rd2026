# Role-access links (`?role=`) + per-role view lockdown — design

**Date:** 2026-06-28
**Author:** RD 13 (Group 2 / Web)
**Status:** approved by เอ๋ 2026-06-28

## Goal

เอ๋ wants one shareable link per channel, where **the link alone decides exactly
what the visitor sees** — "กดเข้าช่องทางไหน ก็เห็นแค่ช่องทางนั้น":

| Link | Who | Sees |
|------|-----|------|
| `…/?admin=1` | admin (เอ๋) | everything — all 6 tabs, every project view |
| `…/?role=assemble` | เอ๋ or ช่างประกอบ | Projects + Stock Part only; each project opens the **Assembly** view |
| `…/?role=laser` | เอ๋ or ช่างตัด | Projects + Stock Part only; each project opens **Cut List** + **📐 Cut Sheets** download |
| `…/?role=bend` | เอ๋ or ช่างพับ | Projects + Stock Part only; each project opens **Bend List** + **📑 All PDF** |

The per-project role views ALREADY work today (see "Unchanged"). This change is only
about (1) the URL handler and (2) which top-level tabs each role sees.

## Background / why now

- `?role=` URL links were **retired 2026-06-09** (shared role-links in LINE chats made
  it unclear who had which view). They were partially re-introduced 2026-06-22 as
  `?asm` / `?laser` (role-baking deep links). เอ๋ now (2026-06-28) explicitly wants the
  clean `?role=<role>` scheme back, plus `?bend`, and wants the link to fully scope the
  view. This supersedes the 2026-06-09 retirement.

## Design

### 1. URL handler — `applyUrlFlags()` (app.js ~390)

Add a unified `?role=` handler and a `?bend` alias. Behavior:

- `?role=assemble | laser | bend` (and aliases `?asm`, `?laser`, `?bend`):
  - **Validate** the value against the known roles. Unknown/empty → ignore (no-op),
    so a typo can't bake a junk role.
  - **Bake** the role into `localStorage[kd_role_v1]` (one-link-for-life, same as the
    existing `?asm`/`?laser`).
  - **Clear admin** (`localStorage.removeItem(kd_admin_v1)`) so the link always renders
    the true worker view — even on เอ๋'s own admin device. (เอ๋: "ผมกดเข้าช่องทางไหน
    ก็เห็นแค่ช่องทางนั้น".) `?admin=1` is the only way to (re)gain the full view.
  - **Strip** the param from the URL afterward (existing `dirty`/`replaceState` path),
    so a re-shared link never carries role/admin/view state.
- `?role=` is generic (lands on Projects home → visitor sees all projects). The existing
  per-project deep links (`?asm=<project>`, `?laser=<project>`, `?p=<project>`) are kept
  unchanged for "drop straight into a project" shares.
- `?asm` / `?laser` keep working verbatim (aliases). `?asm` retains its `=all` / `=<project>`
  flavours. `?bend` is added mirroring `?laser` (generic + `=<project>`), and ALSO clears admin.

Canonical role list for validation: `assemble`, `laser`, `bend` (and `workshop` accepted
but it is the default/no-op). Implemented as a small set so adding a future role is one edit.

> **Admin + role precedence note:** `?admin=1` and `?role=X` are mutually exclusive intents.
> If a single URL somehow carried both, `?role=` runs after `?admin` in `applyUrlFlags` and
> clears admin → the role view wins. This is acceptable (a link should be one or the other).

### 2. Tab visibility — `_visibleTabsForRole()` (app.js ~188)

Tighten the three named worker roles to **Projects + Stock Part only**:

| Role | projects | library | drawing | nest | simbend | stockpart |
|------|:--:|:--:|:--:|:--:|:--:|:--:|
| admin (override) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **laser** | ✓ | ✗ | ✗ | ✗ (was ✓) | ✗ | ✓ |
| **bend** | ✓ | ✗ | ✗ | ✗ | ✗ (was ✓) | ✓ |
| **assemble** | ✓ | ✗ | ✗ (was ✓) | ✗ | ✗ | ✓ |
| workshop (default) | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ | *(unchanged — generic viewer)* |

Dropping Nest (laser) / SimBend (bend) / Drawing (assemble) is safe because each role's key
action lives **inside the project detail**, not in those tabs:
- laser's **📐 Cut Sheets** download → project action bar (`_showDxfsBtn`, gated `_canDownloadCutSheet` = admin||laser).
- bend's **📑 All PDF** → project action bar (`_showAllPdf` = admin||bend).
- assemble's Assembly mindmap → project body default.

`applyTabVisibility()` already bounces a user off a now-hidden tab back to Projects, so a
stale URL/state can't trap them on a hidden tab.

## Unchanged (explicitly out of scope)

- **Per-project role rendering** (`renderProject` ~13524): `_isLaser`→`_renderCutList`,
  `_isBend`→`_renderBendList`, else Assembly mindmap; and the `_showAllPdf` / `_showDxfsBtn` /
  pill/filter gates. These already implement exactly the per-role in-project view เอ๋ described.
- The top-left status indicator (`#header-status`, shipped 4b3b675) — a worker sees their
  own role-badge there; admin sees the 🔓 Admin badge + role switcher.
- Role switching UI: only admin has the in-app role switcher; workers have no switch control,
  so a `?role=` link effectively locks them to that role until a different link is opened.
- `kd_role_v1` / `kd_admin_v1` localStorage keys, `getRole`/`setRole`/`setAdmin`.

## Edge cases

- **Unknown role value** (`?role=foo`): ignored — neither role nor admin changes.
- **เอ๋ is admin, clicks `?role=laser`**: admin is cleared, role=laser → เอ๋ sees the laser
  worker view only. To return to full admin: `?admin=1`.
- **Worker on a hidden tab via old URL/hash** (`#nest=…`): `applyTabVisibility()` bounces to Projects.
- **Backward-compat**: previously-shared `?asm` / `?laser` LINE links keep working (now also clear admin).
- **Stock Part for workers**: intentionally visible (เอ๋'s choice) so a worker can check stock.

## Testing / verification

- **Unit (node --test):** a small pure helper `_resolveRoleFlag(params)` (or equivalent) that,
  given URL params, returns `{role, clearAdmin}` — assert: `role=laser`→laser+clearAdmin;
  `asm=all`→assemble; `bend=Bung 01`→bend+project; `role=foo`→null; no role param→null.
  And `_visibleTabsForRole()` returns the table above for each role (mirror the pure logic in
  a test file, same pattern as `nestStockDontRecut.test.mjs`).
- **Live (Chrome MCP, per [[feedback_verify_visual_before_claim]]):** open each of
  `?admin=1`, `?role=assemble`, `?role=laser`, `?role=bend` on a fresh tab; assert the visible
  tab set, that admin was cleared for the `?role=` ones, that the URL was stripped, and that
  opening a project shows the right body + key button (Cut Sheets for laser, All PDF for bend,
  Assembly for assemble). Verify the top-left status badge shows the right role. Spot-check a
  paper theme (sketch) and a phone-ish width.

## Files touched

- `app.js` — `applyUrlFlags()` (add `?role=` + `?bend`, clear admin), `_visibleTabsForRole()`
  (tighten laser/bend/assemble to projects+stockpart). Possibly extract `_resolveRoleFlag` for testability.
- `test/roleAccessLinks.test.mjs` (new) — pure-logic tests.
- No HTML/CSS changes required.

## Rollback

Single-commit revert restores `?role=` stripping + the prior tab map. No data migration.
