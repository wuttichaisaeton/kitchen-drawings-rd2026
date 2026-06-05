#!/usr/bin/env node
// เอ๋: PDF-stamp — paint the bend sequence table (from Firebase bend_sim) onto the
// TOP-RIGHT corner of each part's drawing PDF, so the workshop sees the press-brake
// plan on the printed sheet (not only the web 🔧 chip).
//
//   node scripts/stamp_bends.mjs   (or: npm run stamp)
//
// Re-stampable any time: the table is drawn on a white box that fully covers any
// previous stamp, so running it again just repaints the current data. Only stamps a
// PDF whose filename matches
// the code (Drawings/manual/<code>.pdf or Drawings/<code>.pdf) — never a shared
// master PDF (one .pdf for many configs), which would mislabel the other configs.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRAWINGS = path.join(ROOT, 'Drawings');
const RTDB = 'https://kitchen-drawings-default-rtdb.asia-southeast1.firebasedatabase.app';
const FORCE = process.argv.includes('--force');

function punchShort(pid) {
  if (!pid) return 'AUTO';
  const m = String(pid).match(/KYOKKO-([^-]+)/i);
  if (m) return '#' + m[1];
  if (/HEM/i.test(pid)) return 'HEM';
  return String(pid).replace(/^P-/, '');
}

// Resolve a code's UNIQUE pdf (filename == code). Returns abs path or null.
function pdfPathForCode(code) {
  const a = path.join(DRAWINGS, 'manual', code + '.pdf');
  if (fs.existsSync(a)) return a;
  const b = path.join(DRAWINGS, code + '.pdf');
  if (fs.existsSync(b)) return b;
  return null;
}

async function stampOne(code, rec) {
  const pdfPath = pdfPathForCode(code);
  if (!pdfPath) return { code, status: 'skip-no-unique-pdf' };
  const rows = (rec.per_bend || []).slice().sort((x, y) => (x.step || 0) - (y.step || 0));
  if (!rows.length) return { code, status: 'skip-no-bends' };

  const bytes = fs.readFileSync(pdfPath);
  const pdf = await PDFDocument.load(bytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontB = await pdf.embedFont(StandardFonts.HelveticaBold);
  // Re-stamping is safe — the white cover box below paints over any previous table,
  // so we always draw the current data (no fragile metadata marker needed).
  const page = pdf.getPages()[0];
  const { width: pw, height: ph } = page.getSize();

  // ── layout (points) ──────────────────────────────────────────────
  const cols = [
    { k: 'ST', w: 20, get: b => (b.step != null ? String(b.step) : '') },
    { k: 'BEND', w: 34, get: b => b.bend || '' },
    { k: 'PUNCH', w: 46, get: b => punchShort(b.punch_id) },
    { k: 'DIE', w: 30, get: b => (b.v_mm != null ? 'V' + b.v_mm : '') },
    { k: 'ANG', w: 28, get: b => (b.angle_deg != null ? Math.round(b.angle_deg) + '°' : '') },
    { k: 'TON', w: 38, get: b => (b.tonnage_kN != null ? Math.round(b.tonnage_kN) + 'kN' : '') },
  ];
  const tw = cols.reduce((s, c) => s + c.w, 0);
  const rh = 12, titleH = 14, headH = 12;
  const pad = 6;
  const boxW = tw + pad * 2;
  // cover up to 12 rows so a re-stamp always paints over the old one
  const coverRows = Math.max(rows.length, 12);
  const boxH = titleH + headH + coverRows * rh + pad * 2;
  const margin = 14;
  const x0 = pw - boxW - margin;
  const yTop = ph - margin;

  const ink = rgb(0.08, 0.09, 0.11);
  const faint = rgb(0.75, 0.75, 0.75);
  const headBg = rgb(0.90, 0.90, 0.90);
  const red = rgb(0.78, 0.18, 0.16);

  // white cover box + border
  page.drawRectangle({ x: x0, y: yTop - boxH, width: boxW, height: boxH, color: rgb(1, 1, 1), borderColor: ink, borderWidth: 1 });

  // title (StandardFonts use WinAnsi — no ticks/emoji)
  const bendable = rec.bendable !== false;
  page.drawText('BEND SEQUENCE', { x: x0 + pad, y: yTop - pad - 9, size: 8, font: fontB, color: ink });
  const verdict = bendable ? (rows.length + ' bends') : 'NOT BENDABLE';
  page.drawText(verdict, { x: x0 + pad, y: yTop - pad - titleH - 9, size: 7, font: fontB, color: bendable ? ink : red });

  // header row
  let hy = yTop - pad - titleH - headH;
  page.drawRectangle({ x: x0 + pad, y: hy, width: tw, height: headH, color: headBg });
  let cx = x0 + pad;
  for (const c of cols) {
    page.drawText(c.k, { x: cx + 2, y: hy + 3, size: 6, font: fontB, color: ink });
    cx += c.w;
  }
  // rows
  let ry = hy;
  for (const b of rows) {
    ry -= rh;
    cx = x0 + pad;
    for (const c of cols) {
      const t = String(c.get(b));
      page.drawText(t, { x: cx + 2, y: ry + 3, size: 7, font: (c.k === 'BEND' ? fontB : font), color: ink });
      cx += c.w;
    }
    page.drawLine({ start: { x: x0 + pad, y: ry }, end: { x: x0 + pad + tw, y: ry }, thickness: 0.4, color: faint });
  }
  // column separators
  cx = x0 + pad;
  for (const c of cols) {
    cx += c.w;
    page.drawLine({ start: { x: cx, y: ry }, end: { x: cx, y: hy + headH }, thickness: 0.4, color: faint });
  }

  const out = await pdf.save();
  fs.writeFileSync(pdfPath, out);
  return { code, status: 'stamped', pdf: path.relative(ROOT, pdfPath) };
}

async function main() {
  console.log('Fetching bend_sim from RTDB…');
  const res = await fetch(RTDB + '/bend_sim.json');
  const all = (await res.json()) || {};
  const codes = Object.keys(all).filter(c => Array.isArray(all[c].per_bend) && all[c].per_bend.length);
  console.log('bend_sim parts:', codes.length, FORCE ? '(--force)' : '');

  const summary = {};
  for (const code of codes) {
    try {
      const r = await stampOne(code, all[code]);
      summary[r.status] = (summary[r.status] || 0) + 1;
      console.log(' ', r.status.padEnd(20), code, r.pdf ? '-> ' + r.pdf : '');
    } catch (e) {
      summary.error = (summary.error || 0) + 1;
      console.log('  ERROR               ', code, e.message);
    }
  }
  console.log('\nDone:', JSON.stringify(summary));
}
main().catch(e => { console.error(e); process.exit(1); });
