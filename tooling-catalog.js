/* tooling-catalog.js — curated popular Amada-style press-brake tooling for the
 * "My Tooling" picker. Punches (มีด) + dies (ร่อง) are SEPARATE inventories
 * (any punch pairs with any die). Standard Amada/Promecam angle = 88° (forms a
 * 90° bend with springback compensation). Focused on thin-gauge stainless
 * kitchen work (~0.8–3mm; the 1mm sweet spot is flagged `fit1mm`).
 *
 * Specs are the popular generic values — exact Amada part numbers depend on the
 * machine's tooling generation (Promecam / AFH / New Standard); map them later.
 * Inner radius ≈ 0.16×V and min flange ≈ 0.67×V are computed by the consumer
 * (drawings-ui shows them; CC_CheckBend uses the same constants).
 *
 * Mirror of _MASTERS/standards/bend_tools/amada_catalog.json — keep in sync.
 * 2026-06-02 (Group 1). window.KD_TOOLING = { punches, dies }.
 */
window.KD_TOOLING = {
  meta: { brand: "Amada", style: "popular / generic 88°", angle_deg: 88 },
  punches: [
    { id: "P-STD-R02-88",  type: "standard",  label: "Standard 88° · R0.2",  angle_deg: 88, tip_radius_mm: 0.2, height_mm: 120, common: true,  fit1mm: true,  note: "sharp tip, thin gauge" },
    { id: "P-STD-R08-88",  type: "standard",  label: "Standard 88° · R0.8",  angle_deg: 88, tip_radius_mm: 0.8, height_mm: 120, common: true,  fit1mm: true,  note: "all-round daily punch" },
    { id: "P-STD-R15-88",  type: "standard",  label: "Standard 88° · R1.5",  angle_deg: 88, tip_radius_mm: 1.5, height_mm: 120, common: true,  fit1mm: false, note: "larger radius / thicker" },
    { id: "P-GN-R08-88",   type: "gooseneck", label: "Gooseneck 88° · R0.8", angle_deg: 88, tip_radius_mm: 0.8, height_mm: 150, common: true,  fit1mm: true,  note: "channels/boxes, clears formed flanges" },
    { id: "P-GN-R10-88",   type: "gooseneck", label: "Gooseneck 88° · R1.0", angle_deg: 88, tip_radius_mm: 1.0, height_mm: 150, common: true,  fit1mm: false, note: "deeper channels" },
    { id: "P-ACUTE-30-R04",type: "acute",     label: "Acute 30° · R0.4",     angle_deg: 30, tip_radius_mm: 0.4, height_mm: 130, common: false, fit1mm: false, note: "acute bends + hem pre-bend" },
    { id: "P-HEM",         type: "hemming",   label: "Hemming / Flattening", angle_deg: 0,  tip_radius_mm: 0.0, height_mm: 100, common: false, fit1mm: false, note: "closes/flattens hems" }
  ],
  dies: [
    { id: "D-1V-V05-88",  type: "1V",    label: "1V · V5 · 88°",   angle_deg: 88, v_list: [5],     height_mm: 60, common: false, fit1mm: false, t_range: "0.5–0.8", note: "very thin" },
    { id: "D-1V-V06-88",  type: "1V",    label: "1V · V6 · 88°",   angle_deg: 88, v_list: [6],     height_mm: 60, common: true,  fit1mm: true,  t_range: "0.7–1.0", note: "thin gauge" },
    { id: "D-1V-V08-88",  type: "1V",    label: "1V · V8 · 88°",   angle_deg: 88, v_list: [8],     height_mm: 60, common: true,  fit1mm: true,  t_range: "0.9–1.3", note: "★ best for 1mm (V≈8t)" },
    { id: "D-1V-V10-88",  type: "1V",    label: "1V · V10 · 88°",  angle_deg: 88, v_list: [10],    height_mm: 60, common: true,  fit1mm: true,  t_range: "1.1–1.6", note: "" },
    { id: "D-1V-V12-88",  type: "1V",    label: "1V · V12 · 88°",  angle_deg: 88, v_list: [12],    height_mm: 60, common: true,  fit1mm: false, t_range: "1.4–2.0", note: "" },
    { id: "D-1V-V16-88",  type: "1V",    label: "1V · V16 · 88°",  angle_deg: 88, v_list: [16],    height_mm: 60, common: true,  fit1mm: false, t_range: "1.8–2.6", note: "" },
    { id: "D-1V-V20-88",  type: "1V",    label: "1V · V20 · 88°",  angle_deg: 88, v_list: [20],    height_mm: 70, common: false, fit1mm: false, t_range: "2.3–3.2", note: "" },
    { id: "D-1V-V25-88",  type: "1V",    label: "1V · V25 · 88°",  angle_deg: 88, v_list: [25],    height_mm: 70, common: false, fit1mm: false, t_range: "2.8–4.0", note: "" },
    { id: "D-2V-0608-88", type: "2V",    label: "2V · V6/V8 · 88° (reversible)",  angle_deg: 88, v_list: [6, 8],   height_mm: 60, common: true,  fit1mm: true,  t_range: "0.7–1.3", note: "self-centering, thin" },
    { id: "D-2V-0812-88", type: "2V",    label: "2V · V8/V12 · 88° (reversible)", angle_deg: 88, v_list: [8, 12],  height_mm: 60, common: true,  fit1mm: true,  t_range: "0.9–2.0", note: "self-centering" },
    { id: "D-2V-1220-88", type: "2V",    label: "2V · V12/V20 · 88° (reversible)",angle_deg: 88, v_list: [12, 20], height_mm: 70, common: false, fit1mm: false, t_range: "1.4–3.2", note: "self-centering" },
    { id: "D-1V-V12-30",  type: "acute", label: "Acute 30° · V12",  angle_deg: 30, v_list: [12],    height_mm: 70, common: false, fit1mm: false, t_range: "1.4–2.0", note: "acute / hem pre-bend" }
  ]
};
