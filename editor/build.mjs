// Editor bundler — esbuild wraps React + React Flow into a single IIFE
// loaded by editor.html (and later by main app.js when toggled to Custom).
//
// Output: ../editor.bundle.js + ../editor.bundle.css at drawings-ui root,
// so the existing static server / GH Pages serves them as plain assets.
//
// Run: npm run build:editor   (or npm run watch:editor for dev loop)

import esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const watch = process.argv.includes('--watch');

const opts = {
  entryPoints: [resolve(__dirname, 'main.jsx')],
  bundle: true,
  format: 'iife',
  globalName: 'KitchenMindmapEditor',
  outfile: resolve(root, 'editor.bundle.js'),
  loader: { '.jsx': 'jsx', '.js': 'jsx', '.css': 'css' },
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  target: ['es2020'],
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': watch ? '"development"' : '"production"',
    // Visible build stamp in the editor toolbar — lets the workshop iPad
    // tell at a glance whether it got the new bundle after a deploy. Build
    // time is per-process so a watch session keeps the same stamp until
    // restart; CI/prod builds get a fresh stamp every push.
    '__KME_BUILD__': JSON.stringify(new Date().toISOString().slice(5, 16).replace('T', ' ')),
  },
};

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log('[editor] watching for changes...');
} else {
  await esbuild.build(opts);
  console.log('[editor] built editor.bundle.js + editor.bundle.css');
}
