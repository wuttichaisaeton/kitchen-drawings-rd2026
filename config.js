// drawings-ui/config.js — wire endpoints here.
//
// For LOCAL development (running `npx serve` in this folder):
//   MANIFEST_URL: '../Drawings/manifest.json'
//   PDF_BASE_URL: '../Drawings/'
//
// For PRODUCTION (Railway hosting this UI, OneDrive hosting PDFs):
//   MANIFEST_URL: 'https://onedrive.live.com/download?resid=...'
//   PDF_BASE_URL: 'https://onedrive.live.com/download?resid=...&filename='
//
// Switch by uncommenting the block you want.

window.APP_CONFIG = {
  // ─── LOCAL DEV (default) ──────────────────────────────────────────
  // For local dev we use a Windows junction "drawings-ui/Drawings -> ../Drawings"
  // so the served `serve` root sees the manifest + PDFs alongside the UI.
  // Recreate the junction if missing:
  //   New-Item -ItemType Junction -Path drawings-ui/Drawings -Target ../Drawings
  MANIFEST_URL: 'Drawings/manifest.json',
  PDF_BASE_URL: 'Drawings/',
  MANUAL_BASE_URL: 'Drawings/manual/',

  // ─── PRODUCTION (uncomment + fill in when ready) ──────────────────
  // MANIFEST_URL: 'https://onedrive.live.com/download?resid=<RESID>',
  // PDF_BASE_URL: 'https://onedrive.live.com/download?resid=<FOLDER_RESID>&filename=',
  // MANUAL_BASE_URL: 'https://onedrive.live.com/download?resid=<FOLDER_RESID>&filename=manual/',

  CACHE_TTL_SECONDS: 60,
};
