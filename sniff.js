import { chromium } from 'playwright';
import fs from 'fs';

const url = process.argv[2];
if (!url) {
  console.log("Use: node sniff.js <URL>");
  process.exit(1);
}

const encontrados = new Set();

const browser = await chromium.launch();
const page = await browser.newPage();

page.on('request', req => {
  const u = req.url();
  if (u.match(/\.(mp4|m3u8|ts|webm)(\?|$)/i)) {
    encontrados.add(u);
    console.log("🎥", u);
  }
});

await page.goto(url, { waitUntil: 'networkidle' });

// tempo extra para players carregarem
await page.waitForTimeout(15000);

await browser.close();

fs.writeFileSync(
  'videos.txt',
  [...encontrados].join('\n')
);

console.log("\n✅ Concluído. Links salvos em videos.txt");
