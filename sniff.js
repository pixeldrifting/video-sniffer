import { chromium } from 'playwright';
import fs from 'fs';
import { execSync } from 'child_process';

const targetUrl = process.argv[2];
if (!targetUrl) {
  console.log('Use: node sniff.js <URL>');
  process.exit(1);
}

let drmDetectado = false;
const candidatos = [];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // ================= USER AGENT =================
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  );

  // ================= BLOQUEIO DE LIXO =================
  await page.route('**/*', route => {
    const type = route.request().resourceType();
    if (['image', 'font'].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  let playTimestamp = 0;

  // ================= DETECÇÃO DE DRM (CONSERVADORA) =================
  page.on('request', req => {
    const u = req.url();
    if (
      /widevine|license|eme|drm/i.test(u) &&
      !u.endsWith('.mp4') &&
      !u.endsWith('.m3u8')
    ) {
      drmDetectado = true;
    }
  });

  // ================= CAPTURA DE MÍDIA =================
  page.on('response', async res => {
    try {
      const u = res.url();
      const headers = res.headers();
      const ct = headers['content-type'] || '';
      const length = Number(headers['content-length'] || 0);

      if (
        playTimestamp &&
        Date.now() > playTimestamp &&
        (
          ct.includes('video') ||
          ct.includes('mpegurl') ||
          /\.(mp4|m3u8)(\?|$)/i.test(u)
        ) &&
        length > 2_000_000
      ) {
        candidatos.push({ url: u, length });
      }
    } catch {}
  });

  // ================= NAVEGAÇÃO (ANTI-TIMEOUT) =================
  try {
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
  } catch {
    console.log('⚠️ Timeout ao carregar a página, continuando...');
  }

  // ================= ACIONA PLAYER =================
  try {
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        v.muted = true;
        v.play().catch(() => {});
      }
    });
  } catch {}

  playTimestamp = Date.now();

  // espera tráfego de mídia
  await page.waitForTimeout(20000);

  await browser.close();

  // ================= DECISÃO FINAL =================
  if (drmDetectado) {
    fs.writeFileSync(
      'resultado.txt',
      '❌ DRM detectado. O player utiliza proteção de conteúdo.'
    );
    console.log('❌ DRM detectado. Encerrando.');
    process.exit(0);
  }

  if (!candidatos.length) {
    fs.writeFileSync(
      'resultado.txt',
      '❌ Nenhum vídeo principal encontrado.'
    );
    console.log('❌ Nenhum vídeo principal encontrado.');
    process.exit(0);
  }

  // escolhe o MAIOR arquivo (mais confiável)
  const principal = candidatos.sort((a, b) => b.length - a.length)[0];

  fs.writeFileSync(
    'videos.txt',
    candidatos.map(v => v.url).join('\n')
  );

  console.log('🎯 Vídeo principal:', principal.url);

  // ================= DOWNLOAD =================
  try {
    execSync(
      `ffmpeg -y -i "${principal.url}" -c copy video.mp4`,
      { stdio: 'inherit' }
    );
    console.log('✅ Download concluído: video.mp4');
  } catch {
    fs.writeFileSync(
      'resultado.txt',
      '⚠️ Link encontrado, mas o download falhou.'
    );
    console.log('⚠️ Download falhou.');
  }
})();
