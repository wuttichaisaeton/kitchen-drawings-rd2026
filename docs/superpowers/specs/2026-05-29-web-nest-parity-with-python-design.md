# Web Nest ↔ Python "Nesting by Rough Design" parity — design

**Date:** 2026-05-29
**Owner:** Fusion session implemented Phase 1+1b (commit `48f871a`, deployed).
Phase 2 (remnants) remains for session web 02.
**Goal:** ทำให้ web nest (`drawings-ui/nest.js`) ออกผลลัพธ์เท่ากับ desktop tool
Python "Nesting by Rough Design" (`NestingTool/nest_gui.py`).

## STATUS (2026-05-29)
- ✅ **Phase 1 (parser) + Phase 1b (fill-stitch) DONE** — commit `48f871a`, live.
  Verified vs all 17 Bung 01 parts: every size within ±1mm of Python
  (SD0SUP exactly 87×60), every part fills (closed outline). Extra bug found
  during impl: this dxf lib (`dxf@5.1.1`) gives ARC/ELLIPSE angles in
  **RADIANS** (old code ×π/180 = wrong → arcs collapsed to nubs); OCS
  extrusion=-1 needs **per-point** X mirror (not centre-only); fill stitch
  needs **nearest**-endpoint match (not first-match → dead-ends).
- ⏳ **Phase 2 (remnants)** — still TODO (session 02). See below.

---

## Problem

DXF ทั้งหมดโหลดมาจากโฟลเดอร์เดียวกัน (`OneDrive/เดสก์ท็อป/Work/Stainless Kitchen/Laser`)
input เหมือนกันเป๊ะ แต่ผล nest ต่างกัน:

- จำนวนชิ้น **เท่ากัน** — ทั้งสอง UI ขึ้น `17 UNIQUE · 50 PCS · 17/17 DXF LOADED`.
- การกระจายลงแผ่น **ต่างกัน** — web = 39+11 ชิ้น/แผ่น, Python = 21+29.
- web มี **เส้นขอบขาด + ไม่ fill** บางชิ้น (FN2BNX ฯลฯ).

สาเหตุ **ไม่ใช่ algorithm แพ็ค** — ตัวแพ็ค (MaxRects / Skyline / BL / Auto) ของสองตัว
แทบ copy กัน (web `nest.js` MaxRectsPacker ~L445 ≈ Python `nest_gui.py` MaxRectsPacker
~L1724). ปัญหาอยู่ที่ **DXF parser**: web อ่าน geometry ไม่ครบเท่า Python → ได้ bbox/ขนาด
ต่าง → ป้อนเข้า packer ต่าง → วางต่าง.

## Evidence — ขนาด W×H ที่สองตัวคำนวณจาก DXF เดียวกัน

| Part | web (nest.js) | Python (nest_gui.py) | สาเหตุต่าง |
|---|---|---|---|
| SD0SUP-000000 | **75 × 52** | **87 × 60** | LWPOLYLINE มี **bulge** มุมมน — web ข้าม |
| FN0F00-080000 | 811 × 590 | 810 × 589 | bulge |
| BM1NO0-080000 | 793 × 59 | 792 × 58 | bulge |
| SD00NA-080000 | 807 × 606 | 807 × 605 | tessellation |
| FN2BNX-120000 | (เส้นขาด, ไม่ fill) | เต็มรูป | **ELLIPSE 4 ตัว** — web ข้าม |
| BK1DN1-080000 | 789 × 789 | 789 × 789 | ตรง (ไม่มี bulge/ellipse) |

Entity scan (จาก Laser/*.dxf):

```
SD0SUP-000000  LWPOLYLINE:1 + CIRCLE:4              [BULGE]
BM1NO0-080000  LWPOLYLINE:2 + CIRCLE:32             [BULGE]
FN0F00-080000  LWPOLYLINE:2 + CIRCLE:43             [BULGE]
FN2BNX-120000  ARC:35 LINE:8 ELLIPSE:4 SPLINE:27 CIRCLE:35  [ELLIPSE][BULGE]
BK1DN1-080000  LINE:24 + SPLINE:16                  (ok)
```

## Root cause

`nest.js` → `_extractPolygons` → `entityPoints` (~L151-197) อ่านไม่ครบเทียบ Python `_bbox`:

1. **LWPOLYLINE bulge ถูกข้าม** — web อ่านแค่ `vertices` (L154). DXF เก็บ bulge ที่ group
   code 42 ของแต่ละ vertex; มุมมน/ส่วนโค้งจึงถูกตัดเป็นเส้นตรง (chord) → bbox เล็กลง/เพี้ยน.
2. **ELLIPSE ไม่รองรับ** — `entityPoints` คืน `null` สำหรับ ELLIPSE → ชิ้นที่มี ellipse
   (FN2BNX) ขอบขาด → stitch loop ไม่ได้ → ไม่ fill + extent คลาด.
3. **SPLINE** — web ใช้ fitPoints/controlPoints ดิบ; Python flatten ด้วย tolerance ~0.5.

→ DXF เดียวกัน parse ต่าง → bbox ต่าง → nest ต่าง.

## Reference (Python ต้นแบบที่จะ port)

`NestingTool/nest_gui.py`:
- `_bbox` (L301) — รวม extent ทุก entity + OCS flip
- `_bulge_arc_bbox` (L249) — สูตร bulge → arc bbox
- `_ellipse_points` (L357)
- `_spline_points` (L391, flatten tolerance 0.5)
- `_ocs_flip` (L229)

## Plan

### Phase 1 — port DXF parser ให้ครบ (แก้ขนาดเพี้ยน + เส้นขาด + เตรียม fill)
แก้ `drawings-ui/nest.js` → `entityPoints` ใน `_extractPolygons` (~L151-197):

1. **LWPOLYLINE bulge**: เมื่อ vertex มี bulge != 0 ให้ sample arc ระหว่าง vertex i→i+1.
   included angle = `4 * atan(|bulge|)` (ดู `_bulge_arc_bbox`). ⚠ ตรวจก่อนว่า dxf JS lib
   ที่ใช้ส่ง `v.bulge` มาให้หรือไม่ — ถ้าไม่ ต้องเปลี่ยน lib หรือ parse code 42 เอง.
2. **ELLIPSE**: เพิ่ม case — sample เป็นจุด (center + majorAxis vector + ratio + start/end
   param, n_pts ~72) พร้อม OCS flip. ดู `_ellipse_points`.
3. **SPLINE**: flatten แบบ tolerance ~0.5 ให้ตรง Python.

**เป้า:** W×H ที่ web คำนวณ == Python ทุกชิ้น (±1mm); SD0SUP ต้องได้ **87×60**.

### Phase 1b — stitch เส้นขอบที่แยกเป็น segment → fill
หลัง parser ครบ ขอบจะครบ → เย็บ `outerStrokes` เป็น closed loop ใน `_extractPolygons`
(กิ่ง `outerStrokes.length > 1`, ~L259-270): greedy join ปลายต่อปลาย tolerance ~0.1-1mm
(อนุญาต reverse segment) → ถ้าปิด ใช้เป็น `outer` (fill ได้); ปิดไม่ได้ → fallback
longest+strokes เดิม. **เป้า:** FN2BNX / BK1DN1 / SD00NA มี fill เหมือน Python.

### Phase 2 — remnant system (ปัจจุบัน web เป็น no-op)
ตอนนี้ทั้ง web+Python ติ๊ก SKIP remnants → ไม่ใช่สาเหตุผลต่างรอบนี้ แต่ port เพื่อ parity เต็ม:
- `_compute_remnant_polygons` (L120, Shapely)
- `_save_remnants` / `_load_remnants` (L102)
- `_remnant_stock_for_thickness` (L3844 — filter grain/material/thickness, reuse เป็น
  bbox virtual sheet)
- `GRAIN MAY NEED FLIP` warning panel (เห็นใน Python UI)

## Non-goal (สำคัญ — set expectation)
ทั้ง web และ Python **ไม่มี true-shape / NFP nesting** (วาง part ในรู หรือประกบรูปทรงจริง) —
ทั้งคู่แพ็คเป็น bbox สี่เหลี่ยม. "เหมือน Nesting by Rough Design" = parser ครบ + fill +
remnant. ถ้าต้องการ interlock รูปทรงจริง (เช่นสามเหลี่ยมประกบกัน) = งานใหม่ (NFP) ต้อง
brainstorm/plan แยกต่างหาก — ต้นฉบับก็ทำไม่ได้.

## Acceptance criteria
- [ ] ขนาด W×H ที่ web อ่านได้ == Python ทุกชิ้น (โดยเฉพาะ SD0SUP = 87×60)
- [ ] FN2BNX / BK1DN1 / SD00NA render มี fill (ขอบปิดครบ)
- [ ] การกระจายลงแผ่นเข้าใกล้ Python (~21+29)
- [ ] FN0F00 = 810×589, BM1NO0 = 792×58 (ภายใน ±1mm)
- build:editor ไม่เกี่ยว (nest.js โหลดตรงจาก app, ไม่ bundle) — แก้แล้ว push ได้เลย

## Files
- แก้: `drawings-ui/nest.js` (`_extractPolygons` / `entityPoints` / fill-stitch / remnant)
- ต้นแบบ: `NestingTool/nest_gui.py` (`_bbox`, `_bulge_arc_bbox`, `_ellipse_points`,
  `_spline_points`, remnant fns)
