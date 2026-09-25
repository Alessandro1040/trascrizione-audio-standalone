'use strict';

/**
 * Test end-to-end in un browser reale (Chrome + puppeteer-core).
 *
 * Il file index.html viene aperto da disco (file://, come quando lo si
 * scarica e si fa doppio clic) e la rete è simulata: al posto di fetch viene
 * installato uno stub che risponde come Whisper. Nessuna chiave API reale e
 * nessun costo: si verificano interfaccia, chunking e ricomposizione.
 *
 *   node test/browser.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const RADICE = path.join(__dirname, '..');
const TEMP = path.join(__dirname, 'tmp');
/* Per impostazione predefinita si testa il file locale aperto da file://
   (lo scenario "scarico e apro"); con PAGINA_URL si testa una pagina online. */
const PAGINA = process.env.PAGINA_URL || `file://${path.join(RADICE, 'index.html')}`;

let superati = 0;
let falliti = 0;
let browser = null;
let pagina = null;

function verifica(descrizione, condizione, dettaglio = '') {
  if (condizione) {
    superati += 1;
    console.log(`  \u2713 ${descrizione}`);
    return;
  }
  falliti += 1;
  console.error(`  \u2717 ${descrizione}${dettaglio ? `\n      ${dettaglio}` : ''}`);
}

function verificaUguale(descrizione, ricevuto, atteso) {
  verifica(descrizione, Object.is(ricevuto, atteso), `ricevuto ${JSON.stringify(ricevuto)}, atteso ${JSON.stringify(atteso)}`);
}

/* ------------------------------------------------------------------ */
/* Ambiente                                                            */
/* ------------------------------------------------------------------ */

function trovaChrome() {
  const candidati = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  return candidati.find((percorso) => {
    try {
      return fs.existsSync(percorso);
    } catch (ignorato) {
      return false;
    }
  }) || null;
}

const ffmpegDisponibile = () => spawnSync('ffmpeg', ['-version']).status === 0;

function generaAudio(percorso, secondi, extra = []) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secondi}`,
    ...extra, percorso,
  ], { stdio: 'inherit' });
}

/** Stub di fetch installato nella pagina prima del caricamento. */
function installaStub() {
  window.__richieste = [];
  window.__erroreForzato = null;

  window.fetch = async (url, opzioni = {}) => {
    const modulo = opzioni.body;
    const file = modulo && modulo.get ? modulo.get('file') : null;

    window.__richieste.push({
      url: String(url),
      autorizzazione: (opzioni.headers && opzioni.headers.Authorization) || null,
      modello: modulo && modulo.get ? modulo.get('model') : null,
      lingua: modulo && modulo.get ? modulo.get('language') : null,
      formato: modulo && modulo.get ? modulo.get('response_format') : null,
      prompt: modulo && modulo.get ? modulo.get('prompt') : null,
      nomeFile: file ? file.name : null,
      byte: file ? file.size : 0,
    });

    if (window.__erroreForzato && window.__erroreForzato.volte > 0) {
      window.__erroreForzato.volte -= 1;
      const stato = window.__erroreForzato.stato;
      return new Response(
        JSON.stringify({ error: { message: `errore simulato ${stato}` } }),
        { status: stato, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const numero = window.__richieste.length;
    return new Response(JSON.stringify({
      text: ` segmento ${numero} di prova`,
      language: 'it',
      duration: 3,
      segments: [
        { start: 0, end: 1.5, text: `Segmento ${numero} parte A.` },
        { start: 1.5, end: 3, text: `Segmento ${numero} parte B.` },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

/* ------------------------------------------------------------------ */
/* Azioni sulla pagina                                                 */
/* ------------------------------------------------------------------ */

async function caricaPagina(opzioni = {}) {
  pagina = await browser.newPage();
  await pagina.evaluateOnNewDocument(installaStub);

  const errori = [];
  pagina.on('pageerror', (errore) => errori.push(errore.message));

  await pagina.goto(PAGINA, { waitUntil: 'domcontentloaded' });
  await pagina.waitForSelector('#btnAvvia');
  // Profilo persistente (facoltativo): si azzera la configurazione salvata per
  // partire sempre dagli stessi valori.
  await pagina.evaluate(() => { try { window.localStorage.removeItem('trascrizioneAudioStandalone.v1'); } catch (ignorato) { /* niente */ } });

  await pagina.$eval('#chiave', (el) => { el.value = 'sk-chiave-di-test'; });
  await pagina.$eval('#endpoint', (el) => { el.value = 'https://endpoint.finto/v1'; });
  await pagina.$eval('#lingua', (el) => { el.value = 'it'; });
  await pagina.$eval('#timestamp', (el) => { el.checked = true; });
  await pagina.$eval('#salvaChiave', (el) => { el.checked = false; });
  await pagina.$eval('#limiteMb', (el, valore) => { el.value = valore; }, String(opzioni.limiteMb || 20));
  await pagina.$eval('#secondiChunk', (el, valore) => { el.value = valore; }, String(opzioni.secondiChunk || 600));

  return { errori };
}

async function trascrivi(percorsoFile, opzioni = {}) {
  const input = await pagina.$('#fileInput');
  await input.uploadFile(percorsoFile);

  const selettore = opzioni.erroreAtteso ? '#errore' : '#sezioneRisultato';
  await pagina.click('#btnAvvia');

  await pagina.waitForFunction(
    (sel) => !document.querySelector(sel).classList.contains('hidden'),
    { timeout: 60000 },
    selettore
  );

  return pagina.evaluate(() => ({
    testo: document.getElementById('testo').value,
    meta: document.getElementById('meta').textContent,
    errore: document.getElementById('errore').classList.contains('hidden')
      ? ''
      : document.getElementById('errore').textContent,
    nomeFile: document.getElementById('nomeFile').textContent,
    avviso: document.getElementById('avvisoFile').classList.contains('hidden')
      ? ''
      : document.getElementById('avvisoFile').textContent,
    srtVisibile: !document.getElementById('btnSrt').classList.contains('hidden'),
    barra: document.getElementById('barraFill').style.width,
    progressoTesto: document.getElementById('progressoTesto').textContent,
    richieste: window.__richieste,
  }));
}

const leggiRichieste = () => pagina.evaluate(() => window.__richieste);
const azzeraRichieste = () => pagina.evaluate(() => { window.__richieste.length = 0; });

const forzaErrore = (stato, volte) => pagina.evaluate(
  (s, v) => { window.__erroreForzato = { stato: s, volte: v }; },
  stato,
  volte
);

/* ------------------------------------------------------------------ */
/* Scenari                                                             */
/* ------------------------------------------------------------------ */

async function scenarioInterfaccia(breve) {
  console.log('\n1) Pagina caricata da file:// e stato iniziale');
  const { errori } = await caricaPagina();

  const stato = await pagina.evaluate(() => ({
    titolo: document.title,
    avviaDisabilitato: document.getElementById('btnAvvia').disabled,
    risultatoNascosto: document.getElementById('sezioneRisultato').classList.contains('hidden'),
    motore: typeof window.TrascrizioneAudio,
    versione: window.TrascrizioneAudio && window.TrascrizioneAudio.VERSIONE,
  }));

  verifica('la pagina si carica aprendo il file', stato.titolo.includes('Trascrizione Audio'));
  verifica('pulsante disattivato senza file', stato.avviaDisabilitato === true);
  verifica('risultato inizialmente nascosto', stato.risultatoNascosto === true);
  verifica('nessun errore JavaScript al caricamento', errori.length === 0, errori.join(' | '));
  verificaUguale('motore esposto per i test', stato.motore, 'object');
  verificaUguale('versione del motore', stato.versione, '1.1.0');

  const finto = path.join(TEMP, 'documento.txt');
  fs.writeFileSync(finto, 'non sono un file audio');
  const input = await pagina.$('#fileInput');
  await input.uploadFile(finto);
  await pagina.waitForFunction(
    () => !document.getElementById('errore').classList.contains('hidden'),
    { timeout: 5000 }
  );
  const messaggio = await pagina.$eval('#errore', (el) => el.textContent);
  verifica('file non audio rifiutato con messaggio', /non sembra un file audio/.test(messaggio), messaggio);
  verifica('pulsante ancora disattivato', await pagina.$eval('#btnAvvia', (el) => el.disabled));

  await input.uploadFile(breve);
  const info = await pagina.evaluate(() => ({
    nome: document.getElementById('nomeFile').textContent,
    dettagli: document.getElementById('dettagliFile').textContent,
    avviso: document.getElementById('avvisoFile').textContent,
    attivo: !document.getElementById('btnAvvia').disabled,
    erroreNascosto: document.getElementById('errore').classList.contains('hidden'),
  }));
  verifica('nome del file mostrato', info.nome.includes('breve.wav'), info.nome);
  verifica('dettagli del file mostrati', /KB|MB/.test(info.dettagli), info.dettagli);
  verifica('avviso sulla modalità di invio', info.avviso.length > 20, info.avviso);
  verifica('pulsante attivato', info.attivo === true);
  verifica('errore precedente nascosto', info.erroreNascosto === true);
  verifica('nessun errore JavaScript dopo le interazioni', errori.length === 0, errori.join(' | '));
}

async function scenarioFilePiccolo(breve) {
  console.log('\n2) File piccolo: una sola richiesta');
  await caricaPagina({ limiteMb: 20 });
  const esito = await trascrivi(breve);

  verificaUguale('una sola richiesta', esito.richieste.length, 1);
  verificaUguale('nome del file inviato', esito.richieste[0].nomeFile, 'breve.wav');
  verificaUguale('endpoint usato', esito.richieste[0].url, 'https://endpoint.finto/v1/audio/transcriptions');
  verificaUguale('intestazione di autorizzazione', esito.richieste[0].autorizzazione, 'Bearer sk-chiave-di-test');
  verificaUguale('modello inviato', esito.richieste[0].modello, 'whisper-1');
  verificaUguale('lingua inviata', esito.richieste[0].lingua, 'it');
  verificaUguale('formato verboso', esito.richieste[0].formato, 'verbose_json');
  verifica('testo nel risultato', esito.testo.includes('segmento 1 di prova'), esito.testo);
  verifica('riepilogo con strategia "intero"', esito.meta.includes('strategia: intero'), esito.meta);
  verifica('barra di avanzamento al 95%', esito.barra === '95%', esito.barra);
  verifica('nessun messaggio di errore', esito.errore === '', esito.errore);
  verifica('pulsante .srt visibile', esito.srtVisibile === true);

  await pagina.click('#mostraTimestamp');
  const conTimestamp = await pagina.$eval('#testo', (el) => el.value);
  verifica(
    'selettore timestamp funzionante',
    conTimestamp.startsWith('[00:00] Segmento 1 parte A.'),
    conTimestamp.slice(0, 60)
  );
}

async function scenarioWavGrande(lungo) {
  console.log('\n3) WAV grande: suddivisione in segmenti mono 16 kHz');
  await caricaPagina({ limiteMb: 0.1 });
  const esito = await trascrivi(lungo);
  const richieste = esito.richieste;

  verifica('suddiviso in più richieste', richieste.length >= 3, `richieste: ${richieste.length}`);
  verifica('segmenti con estensione .wav', richieste.every((r) => r.nomeFile.endsWith('.wav')), richieste.map((r) => r.nomeFile).join(', '));
  verifica(
    'ogni segmento entro il limite di byte',
    richieste.every((r) => r.byte <= 0.1 * 1024 * 1024 + 4096),
    richieste.map((r) => r.byte).join(', ')
  );
  verifica(
    'continuità: il testo precedente viene riutilizzato',
    Boolean(richieste[1].prompt) && richieste[1].prompt.includes('segmento 1 di prova'),
    String(richieste[1].prompt)
  );
  verifica('riepilogo con strategia "wav"', esito.meta.includes('strategia: wav'), esito.meta);
  verifica('riepilogo con la durata', /durata 0m 2[45]s/.test(esito.meta), esito.meta);
  verifica('barra al 95%', esito.barra === '95%', esito.barra);
  verifica('registro dei segmenti compilato', /completato in/.test(esito.progressoTesto), esito.progressoTesto);

  await pagina.click('#mostraTimestamp');
  const conTimestamp = await pagina.$eval('#testo', (el) => el.value);
  verifica('timestamp cumulativi fra i segmenti', /\[00:03\]/.test(conTimestamp), conTimestamp.split('\n').slice(0, 4).join(' | '));
}

async function scenarioMp3Grande(mp3) {
  console.log('\n4) MP3 grande: divisione ai confini dei frame');
  await caricaPagina({ limiteMb: 0.1 });
  const esito = await trascrivi(mp3);

  verifica('riepilogo con strategia "mp3"', esito.meta.includes('strategia: mp3'), esito.meta);
  verifica('più richieste', esito.richieste.length >= 2, `richieste: ${esito.richieste.length}`);
  verifica('segmenti con estensione .mp3', esito.richieste.every((r) => r.nomeFile.endsWith('.mp3')), esito.richieste.map((r) => r.nomeFile).join(', '));
  verifica(
    'ogni segmento entro il limite di byte',
    esito.richieste.every((r) => r.byte <= 0.1 * 1024 * 1024 + 2048),
    esito.richieste.map((r) => r.byte).join(', ')
  );
  verifica('riepilogo con la durata', /durata 0m 2[45]s/.test(esito.meta), esito.meta);
  verifica('testo presente', /segmento \d+ di prova/.test(esito.testo), esito.testo);
}

async function scenarioDecodifica(m4a) {
  console.log('\n5) Formato compresso (M4A): decodifica nel browser');
  await caricaPagina({ limiteMb: 0.1 });
  const esito = await trascrivi(m4a);

  verifica('nessun errore di decodifica', esito.errore === '', esito.errore);
  verifica('riepilogo con strategia "decodifica"', esito.meta.includes('strategia: decodifica'), esito.meta);
  verifica('più richieste', esito.richieste.length >= 3, `richieste: ${esito.richieste.length}`);
  verifica('segmenti .wav a 16 kHz generati', esito.richieste.every((r) => r.nomeFile.endsWith('.wav')), esito.richieste.map((r) => r.nomeFile).join(', '));
  verifica(
    'ogni segmento entro il limite di byte',
    esito.richieste.every((r) => r.byte <= 0.1 * 1024 * 1024 + 4096),
    esito.richieste.map((r) => r.byte).join(', ')
  );
  verifica('riepilogo con la durata', /durata 0m 2[45]s/.test(esito.meta), esito.meta);
}

async function scenarioErrori(breve) {
  console.log('\n6) Errori dell\'endpoint e nuovi tentativi');
  await caricaPagina({ limiteMb: 20 });

  await forzaErrore(401, 1);
  const esito = await trascrivi(breve, { erroreAtteso: true });
  verifica('errore 401 mostrato con messaggio chiaro', /Chiave API/.test(esito.errore), esito.errore);
  verificaUguale('nessun risultato in caso di errore', esito.testo, '');
  verifica('nessun nuovo tentativo sul 401', esito.richieste.length === 1, `richieste: ${esito.richieste.length}`);

  await pagina.reload({ waitUntil: 'domcontentloaded' });
  await pagina.waitForSelector('#btnAvvia');
  await pagina.$eval('#chiave', (el) => { el.value = 'sk-chiave-di-test'; });
  await forzaErrore(500, 1);
  const esito2 = await trascrivi(breve);
  verifica('retry automatico dopo errore 500', /segmento \d+ di prova/.test(esito2.testo), esito2.testo);
  verifica('due richieste registrate (prima fallita, poi riuscita)', esito2.richieste.length === 2, `richieste: ${esito2.richieste.length}`);
}

/** Genera un file audio con voce italiana reale usando il sintetizzatore di macOS. */
function generaVoce(percorsoWav, testo) {
  const aiff = `${percorsoWav}.aiff`;
  const esito = spawnSync('say', ['-v', 'Alice', '-o', aiff, testo]);
  if (esito.status !== 0) return false;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiff, '-ac', '1', '-ar', '16000', percorsoWav], { stdio: 'inherit' });
  fs.rmSync(aiff, { force: true });
  return true;
}

/** Normalizza il testo per il confronto (minuscole, senza punteggiatura). */
const normalizzaTesto = (testo) => String(testo || '')
  .toLowerCase()
  .replace(/[^a-zàèéìòùü\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Errore parola (WER) = distanza di Levenshtein fra le parole. */
function calcolaWer(riferimento, ipotesi) {
  const attese = normalizzaTesto(riferimento).split(' ').filter(Boolean);
  const ottenute = normalizzaTesto(ipotesi).split(' ').filter(Boolean);
  if (attese.length === 0) return 0;

  let precedente = new Array(ottenute.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= attese.length; i += 1) {
    const corrente = [i];
    for (let j = 1; j <= ottenute.length; j += 1) {
      corrente[j] = Math.min(
        precedente[j] + 1,
        corrente[j - 1] + 1,
        precedente[j - 1] + (attese[i - 1] === ottenute[j - 1] ? 0 : 1)
      );
    }
    precedente = corrente;
  }
  return precedente[ottenute.length] / attese.length;
}

/* ------------------------------------------------------------------ */
/* Motore locale (nessuna API)                                         */
/* ------------------------------------------------------------------ */

const TESTO_VOCE = 'Buongiorno a tutti e benvenuti a questa prova di trascrizione automatica. '
  + 'La riunione di giovedì è stata rinviata perché servono ancora alcune verifiche tecniche. '
  + 'Nel frattempo abbiamo pubblicato il nuovo documento con tutte le istruzioni aggiornate per la configurazione del sistema. '
  + 'Vi ricordo che i dati vengono trattati in modo conforme al regolamento europeo sulla protezione dei dati personali. '
  + 'Grazie per l\'attenzione e alla prossima settimana.';

/** Frasi che devono comparire per intero: coprono inizio, centro e fine audio. */
const ANCORE_VOCE = [
  /benvenuti a questa prova/i,
  /riunione di gioved/i,
  /protezione dei dati personali/i,
  /alla prossima settimana/i,
];

async function scenarioLocale(voce, modello) {
  console.log(`\n7) Motore locale nel browser — modello ${modello} (nessuna API)`);
  await caricaPagina();
  await pagina.$eval('#motore', (el) => { el.value = 'locale'; el.dispatchEvent(new Event('change')); });
  await pagina.$eval('#modelloLocale', (el, valore) => { el.value = valore; }, modello);
  await pagina.$eval('#dispositivo', (el) => { el.value = 'wasm'; });
  await pagina.$eval('#lingua', (el) => { el.value = 'it'; });
  await pagina.$eval('#timestamp', (el) => { el.checked = true; });
  await pagina.$eval('#secondiBlocco', (el) => { el.value = '30'; });   // verifica anche i confini fra blocchi

  const campi = await pagina.evaluate(() => ({
    apiNascosto: document.getElementById('gruppoApi').classList.contains('hidden'),
    localeVisibile: !document.getElementById('gruppoLocale').classList.contains('hidden'),
    nota: document.getElementById('notaMotore').textContent,
    chiaveNascosta: document.getElementById('rigaSalvaChiave').classList.contains('hidden'),
  }));
  verifica('i campi API sono nascosti', campi.apiNascosto === true);
  verifica('i campi del motore locale sono visibili', campi.localeVisibile === true);
  verifica('nota che spiega il motore locale', /Nessuna chiave API/.test(campi.nota), campi.nota);
  verifica('nessun campo relativo alla chiave', campi.chiaveNascosta === true);

  const input = await pagina.$('#fileInput');
  await input.uploadFile(voce);
  const avviso = await pagina.$eval('#avvisoFile', (el) => el.textContent);
  verifica('avviso specifico del motore locale', /Motore locale/.test(avviso), avviso);

  await pagina.click('#btnAvvia');
  await pagina.waitForFunction(
    () => !document.getElementById('sezioneRisultato').classList.contains('hidden')
      || !document.getElementById('errore').classList.contains('hidden'),
    { timeout: 420000, polling: 1000 }
  );

  const esito = await pagina.evaluate(() => ({
    testo: document.getElementById('testo').value,
    meta: document.getElementById('meta').textContent,
    errore: document.getElementById('errore').classList.contains('hidden')
      ? ''
      : document.getElementById('errore').textContent,
    richiesteApi: window.__richieste.length,
    srtVisibile: !document.getElementById('btnSrt').classList.contains('hidden'),
    barra: document.getElementById('barraFill').style.width,
  }));

  console.log(`      testo prodotto dal modello locale: «${esito.testo.trim()}»`);

  const wer = calcolaWer(TESTO_VOCE, esito.testo);
  console.log(`      errore parola (WER): ${(wer * 100).toFixed(1)}%`);

  verifica('nessun errore dal motore locale', esito.errore === '', esito.errore);
  verifica('nessuna chiamata di rete effettuata', esito.richiesteApi === 0, `richieste: ${esito.richiesteApi}`);
  verifica('trascrizione non vuota', esito.testo.trim().length > 10, esito.testo);
  verifica(
    'qualità del testo sufficiente (WER < 25%)',
    wer < 0.25,
    `WER ${(wer * 100).toFixed(1)}% — testo: ${esito.testo}`
  );
  verifica(
    'nessuna frase persa ai confini fra blocchi',
    ANCORE_VOCE.every((ancora) => ancora.test(esito.testo)),
    `ancore mancanti: ${ANCORE_VOCE.filter((a) => !a.test(esito.testo)).join(', ')} — testo: ${esito.testo}`
  );
  verifica('riepilogo con motore locale', /motore locale/.test(esito.meta), esito.meta);
  verifica('velocità dichiarata nel riepilogo', /tempo reale/.test(esito.meta), esito.meta);
  verifica('barra di avanzamento completata', esito.barra === '95%', esito.barra);
  verifica('pulsante .srt disponibile', esito.srtVisibile === true);
}

/* ------------------------------------------------------------------ */
/* Esecuzione                                                          */
/* ------------------------------------------------------------------ */

(async function esegui() {
  console.log('=== Test browser (Chrome headless) — Trascrizione Audio standalone ===');

  const chrome = trovaChrome();
  if (!chrome) {
    console.log('Chrome non trovato: test browser saltati (imposta CHROME_PATH per indicarlo).');
    process.exit(0);
  }
  if (!ffmpegDisponibile()) {
    console.log('FFmpeg non disponibile: impossibile generare gli audio di prova. Test saltati.');
    process.exit(0);
  }

  let puppeteer = null;
  try {
    puppeteer = require('puppeteer-core');
  } catch (ignorato) {
    console.log('puppeteer-core non installato: esegui "npm install". Test saltati.');
    process.exit(0);
  }

  fs.rmSync(TEMP, { recursive: true, force: true });
  fs.mkdirSync(TEMP, { recursive: true });

  const breve = path.join(TEMP, 'breve.wav');
  const lungo = path.join(TEMP, 'lungo.wav');
  const lungoMp3 = path.join(TEMP, 'lungo.mp3');
  const lungoM4a = path.join(TEMP, 'lungo.m4a');
  const voce = path.join(TEMP, 'voce-italiana.wav');
  generaAudio(breve, 2, ['-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le']);
  generaAudio(lungo, 25, ['-ac', '2', '-ar', '44100', '-acodec', 'pcm_s16le']);
  generaAudio(lungoMp3, 25, ['-ac', '1', '-ar', '44100', '-b:a', '128k']);
  generaAudio(lungoM4a, 25, ['-ac', '1', '-ar', '44100', '-c:a', 'aac', '-b:a', '64k']);
  const voceDisponibile = generaVoce(voce, TESTO_VOCE);
  console.log(`Fixture: breve.wav ${fs.statSync(breve).size} B · lungo.wav ${fs.statSync(lungo).size} B`
    + ` · lungo.mp3 ${fs.statSync(lungoMp3).size} B · lungo.m4a ${fs.statSync(lungoM4a).size} B`
    + (voceDisponibile ? ` · voce-italiana.wav ${fs.statSync(voce).size} B` : ' · (voce sintetica non disponibile)'));

  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    // Con PROFILO_BROWSER i modelli locali restano in cache fra un'esecuzione e l'altra
    userDataDir: process.env.PROFILO_BROWSER || undefined,
    args: ['--no-first-run', '--no-default-browser-check', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  });

  try {
    await scenarioInterfaccia(breve);
    await scenarioFilePiccolo(breve);
    await scenarioWavGrande(lungo);
    await scenarioMp3Grande(lungoMp3);
    await scenarioDecodifica(lungoM4a);
    await scenarioErrori(breve);

    if (process.env.TEST_LOCALE === '1') {
      if (voceDisponibile) {
        await scenarioLocale(voce, process.env.TEST_LOCALE_MODELLO || 'Xenova/whisper-small');
      } else {
        console.log('\n7) Motore locale: saltato (voce italiana sintetica non disponibile)');
      }
    } else {
      console.log('\n7) Motore locale: saltato (imposta TEST_LOCALE=1 per includerlo: scarica il modello)');
    }
  } catch (errore) {
    falliti += 1;
    console.error(`\nErrore imprevisto: ${errore.stack || errore.message}`);
  } finally {
    await browser.close();
    fs.rmSync(TEMP, { recursive: true, force: true });
  }

  console.log(`\n=== Risultato: ${superati} verifiche superate, ${falliti} fallite ===`);
  process.exit(falliti === 0 ? 0 : 1);
})();



