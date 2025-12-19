// sniff_plus.js
import { chromium } from 'playwright';
import fs from 'fs';
import { execSync } from 'child_process';

const targetUrl = process.argv[2];
if (!targetUrl) {
  console.log('Use: node sniff_plus.js <URL>');
  process.exit(1);
}

// ================= ESTADO GLOBAL =================
let drmDetectado = false;

// candidatos "diretos" (mp4/m3u8)
const candidatosDiretos = [];

// manifests e segmentos
const manifests = []; // { url, type: 'hls'|'dash', length, bodyPath }
const segmentos = []; // { url, length, type: 'video'|'audio'|'desconhecido' }

(async () => {
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  });

  const page = await context.newPage();

  // ================= BLOQUEIO DE RECURSOS INÚTEIS =================
  await page.route('**/*', route => {
    const type = route.request().resourceType();
    if (['image', 'font'].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  let playTimestamp = 0;

  // ================= DETECÇÃO DE DRM (SEM FALSO POSITIVO) =================
  page.on('request', req => {
    const u = req.url();
    if (
      /widevine|license|eme|drm/i.test(u) &&
      !u.endsWith('.mp4') &&
      !u.endsWith('.m3u8') &&
      !u.endsWith('.mpd')
    ) {
      drmDetectado = true;
    }
  });

  // ================= CAPTURA DE RESPOSTAS =================
  page.on('response', async res => {
    try {
      const u = res.url();
      const headers = res.headers();
      const ct = headers['content-type'] || '';
      const length = Number(headers['content-length'] || 0);

      // só consideramos respostas após tentar dar play no vídeo
      if (!playTimestamp || Date.now() < playTimestamp) return;

      const isVideoCt = ct.includes('video');
      const isMpegUrlCt = ct.includes('mpegurl');
      const isMpdCt = ct.includes('mpd+xml') || ct.includes('dash+xml');

      const isMp4Url = /\.(mp4)(\?|$)/i.test(u);
      const isM3u8Url = /\.(m3u8)(\?|$)/i.test(u);
      const isMpdUrl = /\.(mpd)(\?|$)/i.test(u);

      // ================= MANIFESTS (HLS / DASH) =================
      if (isM3u8Url || isMpegUrlCt || isMpdUrl || isMpdCt) {
        const tipo =
          isM3u8Url || isMpegUrlCt ? 'hls' :
          (isMpdUrl || isMpdCt ? 'dash' : 'desconhecido');

        let bodyPath = null;
        try {
          const body = await res.body();
          // salva manifest bruto para análise posterior
          const fileName =
            'manifest_' +
            manifests.length +
            (tipo === 'hls' ? '.m3u8' : tipo === 'dash' ? '.mpd' : '.txt');
          bodyPath = fileName;
          fs.writeFileSync(fileName, body);
        } catch {
          // se não der para ler o body, segue sem salvar
        }

        manifests.push({ url: u, type: tipo, length, bodyPath });
        return;
      }

      // ================= SEGMENTOS (TS, M4S, FMP4, ETC) =================
      // heurística: nomes de segmentos tipicamente contém numeração, .ts, .m4s, .mp4 fragmentado etc.
      const isSegment =
        /\.(ts|m4s|cmf|m4f)(\?|$)/i.test(u) ||
        (isVideoCt && length > 50_000 && !isMp4Url); // vídeo "pedaçado", mas não mp4 direto

      if (isSegment) {
        const lower = u.toLowerCase();
        let tipo = 'desconhecido';

        if (lower.includes('video') || lower.includes('v_') || lower.includes('v-')) {
          tipo = 'video';
        } else if (lower.includes('audio') || lower.includes('a_') || lower.includes('a-')) {
          tipo = 'audio';
        }

        segmentos.push({ url: u, length, type: tipo });
        return;
      }

      // ================= MÍDIA DIRETA (MP4 / HLS SIMPLES) =================
      if (
        (isVideoCt || isMpegUrlCt || isMp4Url || isM3u8Url) &&
        length > 2_000_000
      ) {
        candidatosDiretos.push({ url: u, length, contentType: ct });
      }
    } catch {
      // silencioso
    }
  });

  // ================= NAVEGAÇÃO ANTI-TIMEOUT =================
  try {
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
  } catch {
    console.log('⚠️ Timeout ao carregar a página, continuando...');
  }

  // ================= FORÇA PLAYER =================
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

  // espera um tempo para o player bater na rede
  await page.waitForTimeout(25000);
  await browser.close();

  // ================= DECISÃO SOBRE DRM =================
  if (drmDetectado) {
    fs.writeFileSync(
      'resultado.txt',
      '❌ DRM detectado. Player protegido.'
    );
    console.log('❌ DRM detectado. Encerrando.');
    process.exit(0);
  }

  // ================= LOG BÁSICO =================
  fs.writeFileSync(
    'debug_manifests.json',
    JSON.stringify(manifests, null, 2)
  );
  fs.writeFileSync(
    'debug_segmentos.json',
    JSON.stringify(segmentos, null, 2)
  );
  fs.writeFileSync(
    'videos_diretos.txt',
    candidatosDiretos.map(v => v.url).join('\n')
  );

  // ================= HEURÍSTICA DE "FLUXO PRINCIPAL" =================

  // 1) Se existe MANIFEST, damos preferência a ele (HLS/DASH adaptativo)
  if (manifests.length) {
    // escolhe o manifest mais "promissor"
    // critério simples: maior content-length ou, se tudo for 0, o primeiro HLS
    const ordenados = manifests
      .slice()
      .sort((a, b) => (b.length || 0) - (a.length || 0));

    const principal =
      ordenados.find(m => m.type === 'hls') ||
      ordenados.find(m => m.type === 'dash') ||
      ordenados[0];

    fs.writeFileSync(
      'resultado.txt',
      [
        '🎯 Manifest principal detectado:',
        `Tipo: ${principal.type}`,
        `URL: ${principal.url}`,
        principal.bodyPath
          ? `Arquivo salvo: ${principal.bodyPath}`
          : 'Arquivo do manifest não foi salvo (sem acesso ao body).',
        '',
        'Use ffmpeg diretamente no manifest, por exemplo:',
        principal.type === 'hls'
          ? `ffmpeg -y -i "${principal.url}" -c copy video.mp4`
          : `ffmpeg -y -i "${principal.url}" -c copy video.mp4`
      ].join('\n')
    );

    console.log('🎯 Manifest principal:', principal.url);

    // tenta fazer o download direto pelo manifest
    try {
      execSync(
        `ffmpeg -y -i "${principal.url}" -c copy video.mp4`,
        { stdio: 'inherit' }
      );
      console.log('✅ Download concluído via manifest: video.mp4');
    } catch {
      console.log('⚠️ Download via manifest falhou.');
    }

    process.exit(0);
  }

  // 2) Se não tem manifest, mas tem segmentos, pelo menos deixamos eles listados
  if (!manifests.length && segmentos.length) {
    fs.writeFileSync(
      'resultado.txt',
      [
        '⚠️ Nenhum manifest (.m3u8/.mpd) detectado, mas segmentos foram capturados.',
        'Verifique "debug_segmentos.json" para inspecionar os pedaços.',
        'Você pode precisar construir um manifest local ou puxar os segmentos manualmente com ffmpeg ou script.'
      ].join('\n')
    );
    console.log('⚠️ Sem manifest, mas segmentos encontrados. Veja debug_segmentos.json');
    process.exit(0);
  }

  // 3) Fallback: mídia direta (o que o seu script já fazia)
  if (!candidatosDiretos.length) {
    fs.writeFileSync(
      'resultado.txt',
      '❌ Nenhum vídeo principal encontrado.'
    );
    console.log('❌ Nenhum vídeo principal encontrado.');
    process.exit(0);
  }

  const principalDireto = candidatosDiretos.sort(
    (a, b) => b.length - a.length
  )[0];

  fs.writeFileSync(
    'videos.txt',
    candidatosDiretos.map(v => v.url).join('\n')
  );

  console.log('🎯 Vídeo principal (direto):', principalDireto.url);

  try {
    execSync(
      `ffmpeg -y -i "${principalDireto.url}" -c copy video.mp4`,
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
