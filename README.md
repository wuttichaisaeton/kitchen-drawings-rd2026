# Kitchen Drawings UI

Mobile/iPad-friendly web UI for the Stainless Kitchen workshop drawing pipeline.

## Local development

```bash
cd drawings-ui
npx serve -s . -l 3000
```

Open `http://localhost:3000` on your computer, or scan a QR for your phone/iPad on the same Wi-Fi network (replace localhost with your machine's LAN IP).

The default `config.js` points at `../Drawings/manifest.json` (relative path) so it reads the locally-generated manifest immediately.

## Stack

- Vanilla JS (no build step)
- CSS Grid + media queries (responsive: 2-col mobile, 3-col iPad portrait, 4-col landscape)
- `serve` for static hosting

## Files

- `index.html` — single-page shell + header + search bar
- `style.css` — dark theme + responsive media queries
- `app.js` — fetch manifest + render index grid + drill-down + search
- `config.js` — endpoint URLs (swap local ↔ OneDrive/Railway)
- `families.json` — family icon + display order
- `package.json` — `serve` for Railway deploy

## Production deploy

1. Share the project's `Drawings/` folder on OneDrive (Anyone-with-link read access)
2. Extract direct URLs for `manifest.json` and the PDF folder
3. Update `config.js` to point at those URLs (uncomment production block)
4. Deploy to Railway: `railway up` (uses `npm start` from `package.json`)
