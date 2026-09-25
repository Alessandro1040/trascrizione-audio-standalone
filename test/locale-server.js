'use strict';

/**
 * Test del server locale (whisper.cpp) — nessuna API, nessuna chiave.
 *
 * Avvia `server-locale.js` e invia un audio con voce italiana reale
 * (sintetizzata con il comando `say` di macOS): il testo viene prodotto
 * interamente sul computer, senza inviare nulla a servizi esterni.
 *
 *   node test/locale-server.js
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const RADICE = path.join(__dirname, '..');
const TEMP = path.join(__dirname, 'tmp-locale');
const PORTA = Number(process.env.TEST_PORTA_LOCALE || 8099);
const BASE = `http://127.0.0.1:${PORTA}`;

let superati = 0;
let falliti = 0;

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
/* Preparazione                                                        */
/* ------------------------------------------------------------------ */

function generaVoce(percorsoWav, testo) {
  const aiff = `${percorsoWav}.aiff`;
  const esito = spawnSync('say', ['-v', 'Alice', '-o', aiff, testo]);
  if (esito.status !== 0) return false;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiff, '-ac', '1', '-ar', '16000', percorsoWav], { stdio: 'inherit' });
  fs.rmSync(aiff, { force: true });
  return true;
}

function percorsoModello() {
  if (process.env.PERCORSO_MODELLO) return process.env.PERCORSO_MODELLO;
  const nome = process.env.MODELLO || 'base';
  return path.join(RADICE, 'modelli', `ggml-${nome}.bin`);
}

function avviaServer() {
  const processo = spawn(process.execPath, [path.join(RADICE, 'server-locale.js')], {
    cwd: RADICE,
    env: Object.assign({}, process.env, { PORTA: String(PORTA) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let uscita = '';
  const avviato = new Promise((risolvi, rifiuta) => {
    const timer = setTimeout(() => rifiuta(new Error(`Timeout nell'avvio del server locale\n${uscita}`)), 30000);
    const osserva = (dato) => {
      uscita += dato.toString();
      if (/attiva su http/.test(uscita)) {
        clearTimeout(timer);
        risolvi();
      }
    };
    processo.stdout.on('data', osserva);
    processo.stderr.on('data', osserva);
    processo.once('exit', (codice) => {
      clearTimeout(timer);
      rifiuta(new Error(`server-locale.js terminato con codice ${codice}\n${uscita}`));
    });
  });

  return { processo, avviato, uscita: () => uscita };
}

/** Invia un file al server locale, senza alcuna intestazione di autenticazione. */
async function invia(percorsoFile, campi = {}) {
  const modulo = new FormData();
  modulo.append('file', new Blob([fs.readFileSync(percorsoFile)], { type: 'audio/wav' }), path.basename(percorsoFile));
  modulo.append('model', 'whisper-locale');
  Object.entries(campi).forEach(([chiave, valore]) => modulo.append(chiave, valore));

  const risposta = await fetch(`${BASE}/v1/audio/transcriptions`, {
    method: 'POST',
    body: modulo,
    signal: AbortSignal.timeout(300000),
  });

  const tipo = risposta.headers.get('content-type') || '';
  const corpo = tipo.includes('json') ? await risposta.json() : await risposta.text();
  return { stato: risposta.status, corpo, tipo };
}

/* ------------------------------------------------------------------ */
/* Esecuzione                                                          */
/* ------------------------------------------------------------------ */

(async function esegui() {
  console.log('=== Test server locale (whisper.cpp) — nessuna API ===');

  const binario = spawnSync('whisper-cli', ['--help'], { stdio: 'ignore' }).status !== null;
  const modello = percorsoModello();

  if (!binario) {
    console.log('whisper-cli non trovato: installa con "brew install whisper.cpp". Test saltati.');
    process.exit(0);
  }
  if (!fs.existsSync(modello)) {
    console.log(`Modello non trovato (${modello}). Esegui "npm run start:locale" per scaricarlo. Test saltati.`);
    process.exit(0);
  }

  fs.rmSync(TEMP, { recursive: true, force: true });
  fs.mkdirSync(TEMP, { recursive: true });

  const voce = path.join(TEMP, 'voce-italiana.wav');
  if (!generaVoce(voce, 'Ciao, questa è una prova di trascrizione automatica con il modello locale.')) {
    console.log('Voce italiana sintetica non disponibile: test saltati.');
    process.exit(0);
  }
  console.log(`Fixture: voce-italiana.wav (${fs.statSync(voce).size} byte) · modello ${path.basename(modello)}`);

  const server = avviaServer();
  try {
    await server.avviato;

    // Salute del servizio
    const salute = await fetch(`${BASE}/salute`).then((r) => r.json());
    verificaUguale('modello caricato dal server locale', salute.modello, path.basename(modello));
    verifica('ffmpeg rilevato per le conversioni', salute.ffmpeg === true);

    // Trascrizione con formato verboso (come lo usa l'app)
    const risposta = await invia(voce, { language: 'it', response_format: 'verbose_json' });
    verificaUguale('risposta HTTP 200 senza chiave API', risposta.stato, 200);

    const testo = String(risposta.corpo.text || '');
    console.log(`      trascrizione locale: «${testo.trim()}»`);

    verifica('testo trascritto non vuoto', testo.trim().length > 10, testo);
    verifica('contiene la parola "trascrizione"', /trascrizion/i.test(testo), testo);
    verifica('contiene "modello locale"', /modello local/i.test(testo), testo);
    verificaUguale('lingua rilevata', risposta.corpo.language, 'it');
    verifica('segmenti temporizzati presenti', Array.isArray(risposta.corpo.segments) && risposta.corpo.segments.length >= 1);
    verifica(
      'tempi dei segmenti coerenti',
      Array.isArray(risposta.corpo.segments)
        && risposta.corpo.segments.every((s) => s.end >= s.start && s.start >= 0),
      JSON.stringify(risposta.corpo.segments)
    );
    verifica('durata calcolata', risposta.corpo.duration > 3 && risposta.corpo.duration < 6, String(risposta.corpo.duration));

    // Formato SRT
    const srt = await invia(voce, { language: 'it', response_format: 'srt' });
    verifica('SRT generato dal server locale', srt.stato === 200 && /^1\r?\n00:00:00,000 --> /.test(srt.corpo), String(srt.corpo).slice(0, 60));

    // Formato json semplice
    const json = await invia(voce, { language: 'it', response_format: 'json' });
    verifica('formato json minimale', json.stato === 200 && typeof json.corpo.text === 'string' && json.corpo.segments === undefined);

    // File non audio: il server deve rispondere con un errore chiaro, non bloccarsi
    const documento = path.join(TEMP, 'documento.txt');
    fs.writeFileSync(documento, 'questo non è audio');
    const errore = await invia(documento, { response_format: 'verbose_json' });
    verifica('file non audio gestito con errore', errore.stato === 500 || errore.stato === 400, `stato ${errore.stato}`);
    verifica('il server resta in vita dopo un errore', (await fetch(`${BASE}/salute`)).status === 200);
  } catch (errore) {
    falliti += 1;
    console.error(`\nErrore imprevisto: ${errore.stack || errore.message}`);
    console.error(server.uscita().split('\n').slice(-5).join('\n'));
  } finally {
    server.processo.kill('SIGTERM');
    fs.rmSync(TEMP, { recursive: true, force: true });
  }

  console.log(`\n=== Risultato: ${superati} verifiche superate, ${falliti} fallite ===`);
  process.exit(falliti === 0 ? 0 : 1);
})();

