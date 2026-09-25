// Renders the Chrome Web Store promo images from HTML (no design tool needed):
//   docs/promo/small-tile-440x280.png   (small promo tile)
//   docs/promo/marquee-1400x560.png     (marquee, only used for featured placement)
//
//   node tests/e2e/promo.mjs

import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.E2E_OUT || path.join(ROOT, 'docs/promo');
mkdirSync(OUT, { recursive: true });
const icon = `data:image/png;base64,${readFileSync(path.join(ROOT, 'icons/icon128.png')).toString('base64')}`;

const css = `
  * { box-sizing: border-box; margin: 0; }
  body { font: 16px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; background: #f6f6f3; color: #1c1c1a; overflow: hidden; }
  .wrap { display: flex; align-items: center; height: 100vh; }
  .brand { display: flex; align-items: center; gap: 16px; }
  h1 { font-size: 1em; font-weight: 700; letter-spacing: -0.02em; }
  .tag { color: #6b6b66; }
  .board { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .col { border-radius: 12px; padding: 10px; background: #efefeb; }
  .col.deep { background: #e3f3ea; }
  .col b { display: block; font-size: 12px; margin-bottom: 8px; }
  .card { background: #fff; border: 1px solid #e2e2dc; border-radius: 9px; padding: 8px 9px; margin-bottom: 7px; font-size: 11px; }
  .card i { display: block; height: 6px; width: 70%; background: #ddddd6; border-radius: 3px; margin-top: 6px; }
  .card i + i { width: 45%; }
  .chip { display: inline-block; margin-top: 6px; padding: 1px 7px; border-radius: 6px; background: #efefeb; font-size: 10px; }
`;

const board = (scale) => `
  <div class="board" style="zoom:${scale}">
    <div class="col"><b>👁️ Just Glanced</b><div class="card">10 pasta recipes<i></i><i></i></div></div>
    <div class="col"><b>📖 Partially Read</b><div class="card">Why Rust async is hard<i></i><i></i><span class="chip">↓ 60%</span></div></div>
    <div class="col deep"><b>🎯 Deep Focus</b><div class="card">Stripe API: Authentication<i></i><i></i><span class="chip">⏱ 4m</span> <span class="chip">📋 1</span></div></div>
    <div class="col"><b>👻 Ghost Tabs</b><div class="card">Forum thread<i></i><i></i></div><div class="card">Newsletter #142<i></i><i></i></div></div>
  </div>`;

const pages = {
  'small-tile-440x280.png': {
    size: { width: 440, height: 280 },
    html: `<div class="wrap" style="flex-direction:column;justify-content:center;gap:18px;padding:0 28px">
      <div class="brand"><img src="${icon}" width="64" height="64" alt=""><div>
        <h1 style="font-size:34px">Tab State</h1><div class="tag" style="font-size:15px">Remember where you stopped.</div></div></div>
      ${board(0.62)}</div>`,
  },
  'marquee-1400x560.png': {
    size: { width: 1400, height: 560 },
    html: `<div class="wrap" style="gap:64px;padding:0 80px">
      <div style="flex:0 0 460px"><div class="brand"><img src="${icon}" width="88" height="88" alt=""><h1 style="font-size:60px">Tab State</h1></div>
        <p style="font-size:30px;line-height:1.25;margin-top:22px;font-weight:600;letter-spacing:-0.01em">Your tabs, sorted by how you actually used them.</p>
        <p class="tag" style="font-size:19px;margin-top:14px">Glanced, skimmed, deep focus, never opened — and exactly where you stopped.</p></div>
      <div style="flex:1">${board(1.25)}</div></div>`,
  },
};

const browser = await chromium.launch({
  channel: 'chromium',
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
for (const [file, { size, html }] of Object.entries(pages)) {
  const page = await browser.newPage({ viewport: size });
  await page.setContent(`<style>${css}</style>${html}`);
  await page.screenshot({ path: path.join(OUT, file) });
  console.log(`saved ${file}`);
}
await browser.close();
