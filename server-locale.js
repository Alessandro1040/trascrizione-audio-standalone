'use strict';

/**
 * Server locale di trascrizione — nessuna API, nessuna chiave, nessun costo.
 * ---------------------------------------------------------------------
 * Espone l'endpoint /v1/audio/transcriptions con lo stesso formato dell'API
 * OpenAI, ma la trascrizione viene eseguita in locale da whisper.cpp
 * (binario `whisper-cli`) sul tuo computer.
 *
 * Serve a usare l'app HTML scegliendo il motore "API" e impostando come
 * endpoint http://localhost:8090/v1 (la chiave non è necessaria).
 *
 *   node server-locale.js                 # modello ./modelli/ggml-base.bin
 *   MODELLO=small node server-locale.js   # scarica e usa un altro modello
 *   PORTA=8090 LINGUA=it node server-locale.js
 *
 * Il modello ggml (75–1500 MB secondo la dimensione) viene scaricato una sola
 * volta da Hugging Face e poi tutto funziona anche senza connessione.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

/* ------------------------------------------------------------------ */
/* Configurazione                                                      */
/* ------------------------------------------------------------------ */

const PORTA = Number(process.env.PORTA || process.env.PORT || 8090);
const CARTELLA_MODELLI = path.resolve(process.env.CARTELLA_MODELLI || path.join(__dirname, 'modelli'));
const NOME_MODELLO = process.env.MODELLO || 'base';
const PERCORSO_MODELLO = process.env.PERCORSO_MODELLO
  || (/[\\/]/.test(NOME_MODELLO) ? path.resolve(NOME_MODELLO) : path.join(CARTELLA_MODELLI, `ggml-${NOME_MODELLO}.bin`));
const WHISPER_CLI = process.env.WHISPER_CLI || 'whisper-cli';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const LINGUA = process.env.LINGUA || 'auto';
const THREADS = Number(process.env.THREADS || Math.max(2, Math.floor(os.cpus().length / 2)));
const CARTELLA_TEMP = path.resolve(process.env.CARTELLA_TEMP || path.join(os.tmpdir(), 'trascrizione-locale'));
const LIMITE_UPLOAD = Number(process.env.LIMITE_UPLOAD_MB || 1024) * 1024 * 1024;

const MODELLI_VALIDI = ['tiny', 'tiny.en', 'base', 'base.en', 'small', 'small.en', 'medium', 'medium.en', 'large-v3-turbo', 'large-v3'];

/* ------------------------------------------------------------------ */
/* Utilità                                                             */
/* ------------------------------------------------------------------ */

const esisteBinario = (binario) => {
  try {
    execFileSync(binario, ['--help'], { stdio: 'ignore' });
    return true;
  } catch (errore) {
    return errore.code !== 'ENOENT';
  }
};

const scarica = (url, destinazione, onAvanzamento) => new Promise((risolvi, rifiuta) => {
  const richiesta = (indirizzo, tentativi = 0) => {
    https.get(indirizzo, (risposta) => {
      if ([301, 302, 303, 307, 308].includes(risposta.statusCode) && risposta.headers.location) {
        risposta.resume();
        if (tentativi > 5) return rifiuta(new Error('Troppi reindirizzamenti nello scaricare il modello.'));
        return richiesta(new URL(risposta.headers.location, indirizzo).toString(), tentativi + 1);
      }
      if (risposta.statusCode !== 200) {
        risposta.resume();
        return rifiuta(new Error(`Download del modello non riuscito (HTTP ${risposta.statusCode}).`));
      }

      const totale = Number(risposta.headers['content-length'] || 0);
      let scaricati = 0;
      const file = fs.createWriteStream(destinazione);

      risposta.on('data', (blocco) => {
        scaricati += blocco.length;
        if (onAvanzamento) onAvanzamento(scaricati, totale);
      });
      risposta.pipe(file);
      file.on('finish', () => file.close(() => risolvi(destinazione)));
      file.on('error', rifiuta);
      return undefined;
    }).on('error', rifiuta);
  };

  richiesta(url);
});

function formattaDimensione(byte) {
  if (byte >= 1024 * 1024 * 1024) return `${(byte / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (byte >= 1024 * 1024) return `${(byte / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(byte / 1024)} KB`;
}

/** Legge il corpo della richiesta in memoria (limite configurabile). */
function leggiCorpo(req, limite) {
  return new Promise((risolvi, rifiuta) => {
    const blocchi = [];
    let totale = 0;
    req.on('data', (blocco) => {
      totale += blocco.length;
      if (totale > limite) {
        rifiuta(new Error(`File troppo grande: il limite è ${formattaDimensione(limite)}.`));
        req.destroy();
        return;
      }
      blocchi.push(blocco);
    });
    req.on('end', () => risolvi(Buffer.concat(blocchi)));
    req.on('error', rifiuta);
  });
}

/** Estrae le parti di un corpo multipart/form-data (senza dipendenze). */
function analizzaMultipart(corpo, confine) {
  const delimitatore = Buffer.from(`--${confine}`);
  const parti = [];
  let posizione = corpo.indexOf(delimitatore);

  while (posizione !== -1) {
    const inizio = posizione + delimitatore.length;
    const fine = corpo.indexOf(delimitatore, inizio);
    if (fine === -1) break;

    let contenuto = corpo.subarray(inizio, fine);
    if (contenuto.subarray(0, 2).toString() === '\r\n') contenuto = contenuto.subarray(2);
    if (contenuto.subarray(-2).toString() === '\r\n') contenuto = contenuto.subarray(0, contenuto.length - 2);

    const separatore = contenuto.indexOf('\r\n\r\n');
    if (separatore !== -1) {
      const intestazioni = contenuto.subarray(0, separatore).toString('utf8');
      const nome = /name="([^"]*)"/.exec(intestazioni);
      const nomeFile = /filename="([^"]*)"/.exec(intestazioni);
      parti.push({
        nome: nome ? nome[1] : '',
        nomeFile: nomeFile ? nomeFile[1] : null,
        contenuto: contenuto.subarray(separatore + 4),
      });
    }

    posizione = fine;
  }

  return parti;
}

/** Converte l'audio in WAV mono 16 kHz (formato richiesto da whisper.cpp). */
async function preparaAudio(percorsoOrigine, cartella, nomeBase) {
  const destinazione = path.join(cartella, `${nomeBase}-16k.wav`);

  if (esisteBinario(FFMPEG)) {
    await new Promise((risolvi, rifiuta) => {
      execFile(FFMPEG, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', percorsoOrigine,
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
        destinazione,
      ], (errore, stdout, stderr) => {
        if (errore) rifiuta(new Error(`Conversione audio non riuscita: ${String(stderr || errore.message).trim().split('\n').pop()}`));
        else risolvi();
      });
    });
    return destinazione;
  }

  return percorsoOrigine; // senza ffmpeg: si prova a passare il file così com'è
}

/** Esegue whisper.cpp e restituisce testo, lingua e segmenti temporizzati. */
async function trascriviConWhisper(percorsoAudio, cartella, nomeBase, lingua) {
  const base = path.join(cartella, `${nomeBase}-out`);
  const argomenti = [
    '-m', PERCORSO_MODELLO,
    '-f', percorsoAudio,
    '-t', String(THREADS),
    '-oj',                       // output JSON
    '-of', base,
    '-np',                       // niente stampe di avanzamento
  ];
  const codiceLingua = (lingua && lingua !== 'auto') ? lingua : LINGUA;
  if (codiceLingua && codiceLingua !== 'auto') argomenti.push('-l', codiceLingua);

  await new Promise((risolvi, rifiuta) => {
    execFile(WHISPER_CLI, argomenti, { maxBuffer: 32 * 1024 * 1024 }, (errore, stdout, stderr) => {
      if (errore) {
        const dettaglio = String(stderr || errore.message).trim().split('\n').slice(-2).join(' | ');
        rifiuta(new Error(`whisper-cli non riuscito: ${dettaglio}`));
      } else {
        risolvi();
      }
    });
  });

  const json = JSON.parse(await fsp.readFile(`${base}.json`, 'utf8'));
  const segmenti = (json.transcription || []).map((riga, indice) => {
    const da = riga.offsets ? riga.offsets.from / 1000 : 0;
    const a = riga.offsets ? riga.offsets.to / 1000 : da;
    return {
      id: indice,
      seek: 0,
      start: da,
      end: a,
      text: String(riga.text || '').replace(/^\s+/, ''),
    };
  });

  const testo = (json.transcription || [])
    .map((riga) => String(riga.text || ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    testo,
    lingua: (json.result && json.result.language) || codiceLingua || 'auto',
    segmenti,
    durata: segmenti.length ? Number(segmenti[segmenti.length - 1].end.toFixed(2)) : 0,
    modello: path.basename(PERCORSO_MODELLO, '.bin'),
  };
}

function formattaSubRip(secondi) {
  const totale = Math.max(0, Number(secondi) || 0);
  const pad = (numero, cifre) => String(numero).padStart(cifre, '0');
  return `${pad(Math.floor(totale / 3600), 2)}:${pad(Math.floor((totale % 3600) / 60), 2)}:`
    + `${pad(Math.floor(totale % 60), 2)},${pad(Math.round((totale - Math.floor(totale)) * 1000), 3)}`;
}

const costruisciSrt = (segmenti) => segmenti
  .map((s, indice) => `${indice + 1}\n${formattaSubRip(s.start)} --> ${formattaSubRip(s.end)}\n${s.text}\n`)
  .join('\n');

/* ------------------------------------------------------------------ */
/* Server HTTP                                                         */
/* ------------------------------------------------------------------ */

let coda = Promise.resolve();
let lavoriAttivi = 0;

/** Serializza le trascrizioni: whisper.cpp usa molta CPU. */
function inCoda(compito) {
  const esito = coda.then(compito, compito);
  coda = esito.then(() => {}, () => {});
  return esito;
}

function rispostaJson(res, stato, corpo) {
  const testo = JSON.stringify(corpo);
  res.writeHead(stato, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(testo),
  });
  res.end(testo);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }

    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && (req.url === '/salute' || req.url === '/health')) {
      return rispostaJson(res, 200, {
        ok: true,
        motore: 'whisper.cpp (esecuzione locale)',
        modello: path.basename(PERCORSO_MODELLO),
        percorso_modello: PERCORSO_MODELLO,
        lingua_predefinita: LINGUA,
        thread: THREADS,
        ffmpeg: esisteBinario(FFMPEG),
        lavori_attivi: lavoriAttivi,
      });
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      return rispostaJson(res, 200, {
        object: 'list',
        data: [{ id: path.basename(PERCORSO_MODELLO, '.bin'), object: 'model', owned_by: 'locale' }],
      });
    }

    if (req.method === 'POST' && (req.url.startsWith('/v1/audio/transcriptions') || req.url.startsWith('/inference'))) {
      const corpo = await leggiCorpo(req, LIMITE_UPLOAD);
      const confine = /boundary=([^;]+)/.exec(req.headers['content-type'] || '');
      if (!confine) return rispostaJson(res, 400, { error: { message: 'La richiesta deve essere multipart/form-data.' } });

      const parti = analizzaMultipart(corpo, confine[1].trim());
      const file = parti.find((parte) => parte.nome === 'file' || parte.nomeFile);
      if (!file) return rispostaJson(res, 400, { error: { message: 'Campo "file" mancante nella richiesta.' } });

      const campo = (nome) => {
        const parte = parti.find((x) => x.nome === nome);
        return parte ? parte.contenuto.toString('utf8').trim() : null;
      };
      const lingua = campo('language');
      const formato = campo('response_format') || 'json';

      const esito = await inCoda(async () => {
        lavoriAttivi += 1;
        const nomeBase = crypto.randomBytes(8).toString('hex');
        const cartella = await fsp.mkdtemp(path.join(CARTELLA_TEMP, 'lavoro-'));
        try {
          const estensione = path.extname(file.nomeFile || '') || '.bin';
          const originale = path.join(cartella, `${nomeBase}${estensione}`);
          await fsp.writeFile(originale, file.contenuto);
          const percorsoWav = await preparaAudio(originale, cartella, nomeBase);
          return await trascriviConWhisper(percorsoWav, cartella, nomeBase, lingua);
        } finally {
          lavoriAttivi -= 1;
          await fsp.rm(cartella, { recursive: true, force: true }).catch(() => {});
        }
      });

      console.log(`[locale] ${file.nomeFile || 'audio'} (${formattaDimensione(file.contenuto.length)})`
        + ` → ${esito.segmenti.length} segmenti, lingua ${esito.lingua}`);

      if (formato === 'text') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(esito.testo);
      }
      if (formato === 'srt') {
        res.writeHead(200, { 'Content-Type': 'application/x-subrip; charset=utf-8' });
        return res.end(costruisciSrt(esito.segmenti));
      }
      if (formato === 'verbose_json') {
        return rispostaJson(res, 200, {
          task: 'transcribe',
          language: esito.lingua,
          duration: esito.durata,
          text: esito.testo,
          segments: esito.segmenti,
          modello_locale: esito.modello,
        });
      }
      return rispostaJson(res, 200, { text: esito.testo });
    }

    return rispostaJson(res, 404, { error: { message: `Rotta ${req.method} ${req.url} non trovata.` } });
  } catch (errore) {
    console.error(`[locale] errore: ${errore.message}`);
    return rispostaJson(res, 500, { error: { message: errore.message } });
  }
});

/* ------------------------------------------------------------------ */
/* Avvio                                                               */
/* ------------------------------------------------------------------ */

async function avvia() {
  await fsp.mkdir(CARTELLA_TEMP, { recursive: true });

  if (!esisteBinario(WHISPER_CLI)) {
    console.error(`\n[locale] Binario "${WHISPER_CLI}" non trovato. Installalo con:\n  brew install whisper.cpp\n`);
    process.exit(1);
  }

  if (!fs.existsSync(PERCORSO_MODELLO)) {
    const nome = path.basename(PERCORSO_MODELLO, '.bin').replace(/^ggml-/, '');
    if (!MODELLI_VALIDI.includes(nome)) {
      console.error(`[locale] Modello non trovato: ${PERCORSO_MODELLO}\nDownload manuale: https://huggingface.co/ggerganov/whisper.cpp/tree/main`);
      process.exit(1);
    }

    console.log(`[locale] Modello assente: scarico ggml-${nome}.bin da Hugging Face (una sola volta)…`);
    await fsp.mkdir(path.dirname(PERCORSO_MODELLO), { recursive: true });
    let ultimaStampa = 0;

    await scarica(
      `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${nome}.bin`,
      PERCORSO_MODELLO,
      (scaricati, totale) => {
        const adesso = Date.now();
        if (adesso - ultimaStampa < 2000) return;
        ultimaStampa = adesso;
        process.stdout.write(`\r[locale] scaricati ${formattaDimensione(scaricati)}${totale ? ` / ${formattaDimensione(totale)}` : ''}   `);
      }
    );
    process.stdout.write('\n');
  }

  server.listen(PORTA, () => {
    console.log('----------------------------------------------------------');
    console.log(`Trascrizione locale (whisper.cpp) attiva su http://localhost:${PORTA}`);
    console.log(`Modello: ${path.basename(PERCORSO_MODELLO)} (${formattaDimensione(fs.statSync(PERCORSO_MODELLO).size)}) | thread: ${THREADS}`);
    console.log(`Endpoint compatibile OpenAI: http://localhost:${PORTA}/v1/audio/transcriptions`);
    console.log("Nessuna chiave: usa questo indirizzo nel campo \"Endpoint API\" dell'app HTML.");
    console.log('----------------------------------------------------------');
  });
}

if (require.main === module) avvia();

module.exports = { avvia, server, analizzaMultipart, formattaDimensione };



