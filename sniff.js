import { chromium } from 'playwright';
import fs from 'fs';

const url = process.argv[2];
if (!url) {
  console.log("Use: node sniff.js <URL>");
  process.exit(1);
}

const encontrados = new Set();
let playTimestamp = 0;

const browser = await chromium.launch({
  headless: true,
  args: [
    '--autoplay-policy=no-user-gesture-required'
  ]
});

const page = await browser.newPage();

// ================= CAPTURA REQUEST =================
page.on('request', req => {
  const u = req.url();

  if (
    playTimestamp &&
    (
      u.includes('.m3u8') ||
      u.includes('.mp4')
    )
  ) {
    encontrados.add(u);
  }
});

// ================= CAPTURA RESPONSE =================
page.on('response', res => {
  const u = res.url();
  const ct = res.headers()['content-type'] || '';

  if (
    playTimestamp &&
    (
      ct.includes('video') ||
      ct.includes('mpegurl') ||
      u.includes('.m3u8') ||
      u.includes('.mp4')
    )
  ) {
    encontrados.add(u);
  }
});

await page.goto(url, { waitUntil: 'networkidle' });

// ================= INTERAÇÃO REAL =================
await page.evaluate(() => {
  const v = document.querySelector('video');
  if (v) {
    v.muted = true;
    v.scrollIntoView();
    v.click();
    v.play().catch(() => {});
  }
});

playTimestamp = Date.now();

// Espera MAIS tempo (xHamster precisa)
await page.waitForTimeout(20000);
await browser.close();

// ================= RESULTADO =================
if (!encontrados.size) {
  fs.writeFileSync('resultado.txt', 'Nenhum vídeo encontrado');
  console.log('❌ Nenhum vídeo encontrado.');
  process.exit(0);
}

const lista = [...encontrados];

// Prioriza MP4
lista.sort(u => u.includes('.mp4') ? -1 : 1);

fs.writeFileSync('videos.txt', lista.join('\n'));

console.log('🎯 Vídeos encontrados:');
lista.forEach(u => console.log(u));
