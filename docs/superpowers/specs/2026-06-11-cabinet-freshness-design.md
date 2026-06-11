# Cabinet Freshness — per-role "NEW / CHANGED" cabinet markers — design

**Owner:** G2 / WEB 14 · **Date:** 2026-06-11 · **Status:** approved (Approach B, web-only)
**Builds on:** the 2026-06-11 cabinet capsules feature (`nest.js` `contrib` / `variant_root` / `_cabinetGroups`, commit 9376a84) and the existing `bent_status` / `completed_projects` / `isNewProject` patterns. **No Fusion / manifest schema change.**

## Goal

When a project is still being designed (e.g. "02 Ruth", with cabinet group F2 still
arriving alongside groups already cut/bent/assembled), every workshop role must be able
to tell, **per cabinet**, what just **arrived** or **changed** vs what is old/already
handled — so the คนตัด-Laser, คนพับ, and คนประกอบ don't mix new work into finished
groups or miss a new arrival. เอ๋: *"คนประกอบ คนพับ คนตัด Laser ก็ต้องรู้ว่าอะไรใหม่เข้ามา
อะไรเก่า จะได้ไม่งง ถึงบอกต้อง Sync กัน."*

The Nest "cabinet capsules" feature solved the *cut-side* mixing (pick which cabinets
join a run). This feature adds the *awareness* layer — NEW/CHANGED markers — across all
three roles, and keeps them in sync per department via RTDB.

## Locked decisions (from เอ๋)

| Fork | Decision | Consequence |
|---|---|---|
| **Unit** | whole cabinet = `variant_root` (1 marker/cabinet, not per part) | low noise, reuses capsule grouping |
| **Relative to** | per **role/department** ("new since THIS role last acknowledged it") | per-role RTDB snapshot, NOT absolute, NOT per-person |
| **Re-export** | an already-seen cabinet that is re-exported shows **CHANGED / "แก้ไข"** | must detect a fingerprint change, not only first-appearance |
| **Cross-role** | **Phase 1 = each role sees only its OWN** new/changed | no cross-role lifecycle; `bent_status`/`assembled_status` untouched |
| **Acknowledge** | explicit `✓` tap per cabinet **+** a per-surface "mark all seen" button | NOT auto-cleared on mere open (avoids the silent-reset gap) |
| **"No cabinet" bucket** | show as ONE card "No cabinet / (shared)" that can go NEW/CHANGED | 02 Ruth's 5 shared parts (`variant_root=''`) |
| **OFF cabinets (Nest)** | a capsule toggled OFF still shows its NEW/CHANGED badge, **dimmed** | laser still sees what changed even when excluded from this run |
| **Completed projects** | freshness computes **as normal** when a 📦-Complete project is re-opened | no special-case; status rules just run |

## Data model

### Unit & "No cabinet" bucket
A **cabinet** is a `variant_root` string. The empty `variant_root` (`''`) is the
synthetic **"No cabinet / (shared)"** cabinet — in 02 Ruth: `BTHL00-140100`×2,
`BTHL00-170100`, `CVIL00-205093`, `FTI000-145095`×2, `FTI000-183095`. In RTDB paths the
`''` key is written as the literal **`__NO_CAB__`** to avoid an empty path segment.

### Fingerprint (computed in `nest.js`, from `contrib` — NOT from the manifest)
Per cabinet, independent of role:

```
fp = hash(
  sorted([ `${code}:${qty}` for each code in this cabinet's contrib where qty > 0 ])
  + '|' + String( max( uploaded_dxfs[code].uploaded_at ) over those codes )
)
```

- **Source = `contrib`**, the per-cabinet `{pk, cab, qty}` list already built by
  `_addContrib` during `_loadProjectParts` (`nest.js`). This is the ONLY place
  per-cabinet `code→qty` exists — `app.js buildProjectTree` carries `node.qty = full
  project qty` (cross-cabinet summed), so the fingerprint MUST be computed where
  `contrib` lives. Sim.Bending and the mindmap reuse the same helper (see Integration).
- **`qty > 0` only** — a code whose contribution to this cabinet is 0 (shared with an
  OFF/other cabinet) is excluded, so a change in another cabinet can't perturb this one.
- **`uploaded_at` scoped to THIS cabinet's codes** — NOT `manifest.generated_at`
  (top-level, bumps on every re-export → would flip the whole project CHANGED). A cabinet
  flips CHANGED only when a DXF *it actually uses* is re-uploaded.
- **Version component (`last_drawn_version`) OMITTED in phase 1** — `last_drawn_version`
  / `fusion_version` are `0/0` and stay DORMANT until Fusion F29 writes real values
  (`app.js` outdated-chip logic). Add `max(last_drawn_version)` later behind an
  "if any nonzero" guard (forward-compatible).

**Documented phase-1 limitation (accepted):** a code SHARED across cabinets, re-uploaded
for cabinet B, will also flip cabinet A to CHANGED (A and B share that code's single
`uploaded_dxfs/<code>.uploaded_at`). False-positive only, never a false-negative. The
`qty>0` scoping keeps the blast radius small.

### RTDB schema (mirrors `bent_status`, +1 role level)

```
cabinet_seen/<role>/<projectKey>/<cab> = { fp: "<hash>", seen_at: <epoch_ms> }
  role ∈ { laser, bend, assemble }
  cab  = variant_root string, or "__NO_CAB__" for the '' bucket
  projectKey scopes it (single-project surfaces only in phase 1)
```

- **Write:** `markCabinetSeen(role, pk, cab, fp)` →
  `ref('cabinet_seen/'+role+'/'+pk+'/'+cab).set({ fp, seen_at: Date.now() })`
  — the exact `markBent` upsert shape.
- **"Mark all seen"** = a batched `.update()` of every currently-visible cabinet, for
  **that surface's role only**.
- **Sync:** one `initCabinetSeenSync()` listener on `ref('cabinet_seen')` `.on('value')`,
  flattening the subtree into `_cabSeenCache` keyed `` `${role}|${pk}|${cab}` `` — exactly
  `initBentSync` (`app.js`). Cross-device within a role for free (RTDB last-write-wins;
  no per-user identity — "per department" by construction).
- **localStorage mirror:** `kd_cabinet_seen_v1 = { <role>: { <pk>: { <cab>: {fp,seen_at} } } }`
  — instant-paint seed + offline fallback, same dual-write as `completed_projects`. (grep
  confirms no existing `kd_cabinet_*` key — no collision.)

### Role from the SURFACE, never `getRole()`
`markCabinetSeen` takes `role` HARD-CODED at the call site — Nest pill → `'laser'`,
Sim.Bending card → `'bend'`, mindmap spoke → `'assemble'` — exactly how
`markProjectSeen('nest'/'sim'/'proj', …)` hard-codes its surface. An admin (who sees all
tabs and whose `getRole()` may be `'workshop'`/`'admin'`) thus writes the correct
department's snapshot from any device.

### Status rules (per cabinet, per role, evaluated at render)

```
snapshot = cabinet_seen[role][pk][cab]            // RTDB cache wins; LS fallback; guard null
NEW     = no snapshot AND the cabinet's freshest signal
          ( max uploaded_at of its codes, or per-part generated_at ) is within 24h
          ( else baseline OLD )                    // reuses the isNewProject 24h fallback
CHANGED = snapshot exists AND snapshot.fp !== currentFp
OLD     = snapshot exists AND snapshot.fp === currentFp   // no badge
```

The **24h baseline** kills the "everything shows NEW on first render" spike with zero
friction and mirrors the project-level pattern เอ๋ already lives with (`isNewProject`).

## UI (reuse the amber `.part-new-badge` / glow CSS — theme-safe across dark/sketch/chalk)

- **laser / Nest** (`nest.js`): each capsule pill gets a NEW dot or a **⟳ "แก้ไข"** mark;
  a summary line *"2 ตู้ใหม่ · 1 แก้ไข"*; a `✓` acknowledge affordance per pill + a
  per-surface "เห็นทั้งหมด" button. A pill toggled OFF still shows its badge, **dimmed**.
  `contrib` / `_cabinetGroups()` / `S.cabinetsOff` are already in scope.
- **bend / Sim.Bending** (`app.js` project dashboard): NEW + CHANGED cabinets sort to the
  top with a badge; a "ตู้ใหม่ที่ต้องพับ" grouping. Requires adding an optional
  `includeVariant` flag to `_aggregatePartsByCode` so `byCode` entries carry
  `_variant_root` (currently stripped) — then group by cabinet.
- **assemble / Projects mindmap** (`app.js`): the `variant_root` spoke node
  (`_is_variant_root`) takes a NEW/CHANGED frame+badge, reusing the existing
  missing/stale **warning-frame infra** (`_renderProjectSpoke`).

### Badge precedence — CHANGED outranks the existing "Outdated" hints
A cabinet can simultaneously carry the new **CHANGED ⟳** mark AND the existing
`_drawingOutdated` / `_dxfOutdated` / `_bendRecheck` amber hints. Render **CHANGED as the
primary pill**; demote the outdated/recheck chips to a dimmed secondary hint (opacity
~0.6) so two amber signals don't compete. (The project-level `isNewProject` "NEW" pill is
whole-project and lives in a different spot — no collision.)

### Orphan handling (rename robustness, lightweight)
When reading/rendering `cabinet_seen` for a project, **ignore** snapshot keys whose `cab`
is no longer in the current `_cabinetGroups()` set (handles the `DSVF00→DSV2F0` rename
class: old key orphaned, new key shows NEW). Stale keys that never match are harmless and
invisible. A real delete/GC is optional phase-2.

## Components & isolation

| Unit | Purpose | Depends on |
|---|---|---|
| `_cabinetFingerprint(cab)` (`nest.js`) | one cabinet's fp from `contrib` + scoped `uploaded_at` | `_cabinetGroups`, `S.dxfsAll` |
| `cabinetSeenStore` (`app.js`) | RTDB+LS read/write/sync of `cabinet_seen`; `markCabinetSeen` / `markAllCabinetsSeen` | `firebaseDB`, `kd_cabinet_seen_v1` |
| `isNewCabinet(role, pk, cab, fp)` / `cabinetStatus(...)` | NEW / CHANGED / OLD decision + 24h baseline | `cabinetSeenStore`, 24h fallback |
| Nest pill renderer (`nest.js`) | badge + ✓ + summary on capsule pills | fingerprint + status, `'laser'` |
| Sim.Bending dashboard (`app.js`) | per-cabinet grouping + badge | `_aggregatePartsByCode(includeVariant)`, `'bend'` |
| Mindmap spoke (`app.js`) | NEW/CHANGED frame on variant_root node | warning-frame infra, `'assemble'` |

The fingerprint + status engine is computed once and shared; each surface only supplies
its hard-coded role and its own render hook.

## Phase 1 scope

**SHIP:** per-role (laser/bend/assemble) **NEW + CHANGED** cabinet badges on the 3
single-project surfaces; fingerprint = `code→qty` (contrib) + scoped `max uploaded_at`,
computed in `nest.js`; RTDB `cabinet_seen/<role>/<pk>/<cab>` mirroring `bent_status`; LS
fallback `kd_cabinet_seen_v1`; 24h baseline; explicit `✓` per cabinet + "mark all seen";
`.part-new-badge` CSS reused; CHANGED outranks outdated/recheck; orphan keys ignored.

**DEFER to phase 2:**
- per-cabinet version tracking (blocked on Fusion F29 writing real `last_drawn_version` —
  `0/0` today)
- role-gated Firebase `.rules` (consistent with today's unsecured `bent`/`assembled`
  writes — the shop runs on trust; hardening, not a ship gate)
- cross-project merge-run key namespacing (board 7eeb151 multi-project nest)
- orphan-key GC / explicit delete
- rollback anomaly detection (uploaded_at went backward)
- **cross-role lifecycle** (laser-saw-it → bend-sees-old) — matches เอ๋'s "แยกก่อน"

## Testing

- **Fingerprint correctness:** in preview on real 02 Ruth — toggle a cabinet's qty
  (synthetic manifest tweak), confirm only that cabinet's fp changes; re-upload a shared
  DXF, confirm the documented multi-cabinet flip is the only false-positive.
- **Status engine:** seed `cabinet_seen` synthetic snapshots in RTDB (self-cleaning),
  verify NEW (no key + <24h), CHANGED (key + fp diff), OLD (key + fp match); first-render
  baseline shows no NEW spike for >24h-old cabinets.
- **Acknowledge:** `✓` per cabinet writes current fp → badge clears; "mark all seen"
  clears all visible for that role only; another role still shows them.
- **Sync:** two preview contexts (or RTDB-injected) — ack on one, badge clears on the
  other within a role; other roles unaffected.
- **Surfaces:** Nest pill badge + dimmed-when-OFF; Sim.Bending grouping; mindmap spoke
  frame. 0 console errors; node --check; live curl markers after deploy.
- Headless caveat: Save-with-PAT not needed (RTDB writes only) — use the synthetic-inject
  + self-clean pattern.
