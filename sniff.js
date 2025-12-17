import { chromium } from 'playwright';
import fs from 'fs';
import { execSync } from 'child_process';

const url = process.argv[2];
if (!url) {
  console.log("Use: node sniff.js <URL>");
  process.exit(1);
}

let drm = false;
const candidatos = [];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

let playTimestamp = 0;

// === DETECÇÃO DE DRM ===
page.on('request', req => {
  if (/widevine|drm|license/i.test(req.url())) {
    drm = true;
  }
});

// === CAPTURA DE MÍDIA ===
page.on('response', async res => {
  try {
    const url = res.url();
    const headers = res.headers();
    const ct = headers['content-type'] || '';
    const length = Number(headers['content-length'] || 0);

    if (
      playTimestamp &&
      Date.now() > playTimestamp &&
      (
        ct.includes('video') ||
        ct.includes('mpegurl') ||
        url.match(/\.(mp4|m3u8)(\?|$)/i)
      ) &&
      length > 2_000_000 // ignora GIFs / mini vídeos
    ) {
      candidatos.push({ url, length });
    }
  } catch {}
});

await page.goto(url, { waitUntil: 'domcontentloaded' });

// === ACIONA PLAYER PRINCIPAL ===
await page.evaluate(() => {
  const v = document.querySelector('video');
  if (v) {
    v.muted = true;
    v.play().catch(()=>{});
  }
});

playTimestamp = Date.now();
await page.waitForTimeout(15000);
await browser.close();

// === DECISÃO FINAL ===
if (drm) {
  fs.writeFileSync(
    'resultado.txt',
    '❌ DRM detectado. Download bloqueado por design.'
  );
  console.log('❌ DRM detectado. Encerrando.');
  process.exit(0);
}

if (!candidatos.length) {
  console.log('❌ Nenhum vídeo principal encontrado.');
  process.exit(0);
}

// escolhe o MAIOR (normalmente o principal)
const principal = candidatos.sort((a, b) => b.length - a.length)[0];

console.log('🎯 Vídeo principal:', principal.url);

// === DOWNLOAD AUTOMÁTICO ===
if (principal.url.endsWith('.m3u8')) {
  execSync(`ffmpeg -y -i "${principal.url}" -c copy video.mp4`, { stdio: 'inherit' });
} else {
  execSync(`ffmpeg -y -i "${principal.url}" -c copy video.mp4`, { stdio: 'inherit' });
}

console.log('✅ Download concluído: video.mp4');
