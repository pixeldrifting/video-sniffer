import { chromium } from 'playwright';
import fs from 'fs';

const url = process.argv[2];
if (!url) {
  console.log("Use: node sniff.js <URL>");
  process.exit(1);
}

const encontrados = new Set();

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on('response', async (res) => {
  try {
    const url = res.url();
    const headers = res.headers();

    const isVideo =
      headers['content-type']?.includes('video') ||
      headers['content-type']?.includes('application/vnd.apple.mpegurl') ||
      url.match(/\.(mp4|m3u8|ts|m4s|webm)(\?|$)/i);

    if (isVideo) {
      encontrados.add(url);
      console.log("🎥", url);
    }
  } catch {}
});

await page.goto(url, { waitUntil: 'domcontentloaded' });

// tenta clicar no play automaticamente
await page.evaluate(() => {
  const video = document.querySelector('video');
  if (video) {
    video.muted = true;
    video.play().catch(() => {});
  }
});

// rola a página (ativa lazy load)
await page.evaluate(() => {
  window.scrollTo(0, document.body.scrollHeight);
});

await page.waitForTimeout(30000);

await browser.close();

fs.writeFileSync('videos.txt', [...encontrados].join('\n'));

console.log("\n✅ Finalizado. Links salvos em videos.txt");
