import { chromium } from 'playwright';
import fs from 'fs';
import { execSync } from 'child_process';

const url = process.argv[2];
if (!url) {
  console.log("Use: node sniff.js <URL>");
  process.exit(1);
}

const candidatos = [];
let drmScore = 0;
const drmEvidencias = [];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

let playTimestamp = 0;

// ================= DRM (APENAS SINAIS FORTES) =================
page.on('request', req => {
  const u = req.url();

  // Widevine / PlayReady reais
  if (/widevine|playready/i.test(u)) {
    drmScore += 3;
    drmEvidencias.push(`Servidor DRM real: ${u}`);
  }
});

page.on('response', res => {
  const u = res.url();
  const ct = res.headers()['content-type'] || '';

  // Segmentos criptografados reais
  if (u.includes('.m4s') && ct.includes('application/octet-stream')) {
    drmScore += 2;
    drmEvidencias.push(`Segmento criptografado: ${u}`);
  }
});

// ================= CAPTURA DE MÍDIA =================
page.on('response', async res => {
  try {
    const mediaUrl = res.url();
    const headers = res.headers();
    const ct = headers['content-type'] || '';
    const length = Number(headers['content-length'] || 0);

    if (
      playTimestamp &&
      Date.now() > playTimestamp &&
      length > 2_000_000 && // ignora GIF / vídeos decorativos
      (
        mediaUrl.match(/\.(mp4|m3u8)(\?|$)/i) ||
        ct.includes('video') ||
        ct.includes('mpegurl')
      )
    ) {
      candidatos.push({ url: mediaUrl, length });
    }
  } catch {}
});

await page.goto(url, { waitUntil: 'domcontentloaded' });

// ================= ACIONA PLAYER =================
await page.evaluate(() => {
  const v = document.querySelector('video');
  if (v) {
    v.muted = true;
    v.play().catch(() => {});
  }
});

playTimestamp = Date.now();
await page.waitForTimeout(15000);
await browser.close();

// ================= DECISÃO INTELIGENTE =================
if (!candidatos.length) {
  console.log('❌ Nenhum vídeo principal encontrado.');
  process.exit(0);
}

// Prioriza MP4 direto
const mp4s = candidatos.filter(c => c.url.includes('.mp4'));

const principal = (mp4s.length ? mp4s : candidatos)
  .sort((a, b) => b.length - a.length)[0];

// Se existe MP4 direto, DRM é descartado
const DRM_REAL = drmScore >= 4 && !principal.url.includes('.mp4');

if (DRM_REAL) {
  const relatorio =
    `❌ DRM REAL detectado\n\n` +
    drmEvidencias.join('\n');

  fs.writeFileSync('relatorio_drm.txt', relatorio);
  console.log(relatorio);
  process.exit(0);
}

console.log('🎯 Vídeo principal:', principal.url);

// ================= DOWNLOAD =================
execSync(
  `ffmpeg -y -i "${principal.url}" -c copy video.mp4`,
  { stdio: 'inherit' }
);

console.log('✅ Download concluído: video.mp4');
