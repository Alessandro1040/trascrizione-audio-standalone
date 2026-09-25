'use strict';

/**
 * Test del motore di "index.html" eseguito in Node.
 *
 * Il codice dell'app viene estratto dal file HTML e caricato in un contesto
 * isolato (vm) senza DOM: si verificano così le funzioni di analisi audio,
 * il chunking WAV/MP3, la composizione di testo/SRT e la pipeline completa
 * (con l'endpoint simulato: nessuna chiave reale, nessun costo).
 *
 *   node test/unit.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync, spawnSync } = require('child_process');

const RADICE = path.join(__dirname, '..');
const TEMP = path.join(__dirname, 'tmp');
const FileEsplicito = globalThis.File || require('node:buffer').File;

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
  if (Object.is(ricevuto, atteso)) {
    superati += 1;
    console.log(`  \u2713 ${descrizione}`);
    return;
  }
  falliti += 1;
  console.error(`  \u2717 ${descrizione}\n      atteso: ${JSON.stringify(atteso)}\n      ricevuto: ${JSON.stringify(ricevuto)}`);
}

function verificaVicino(descrizione, ricevuto, atteso, tolleranza = 0.01) {
  verifica(descrizione, Math.abs(ricevuto - atteso) <= tolleranza, `ricevuto ${ricevuto}, atteso ~${atteso}`);
}

/* ------------------------------------------------------------------ */
/* Caricamento del motore dall'HTML                                    */
/* ------------------------------------------------------------------ */

function caricaMotore() {
  const html = fs.readFileSync(path.join(RADICE, 'index.html'), 'utf8');
  const trovato = /<script id="motore">([\s\S]*?)<\/script>/.exec(html);
  if (!trovato) throw new Error('blocco <script id="motore"> non trovato in index.html');

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Blob,
    FormData,
    URL,
    TextDecoder,
    TextEncoder,
    performance,
    fetch: null,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(trovato[1], sandbox, { filename: 'motore.js' });
  return sandbox;
}

/* ------------------------------------------------------------------ */
/* Aiutanti                                                            */
/* ------------------------------------------------------------------ */

/** Costruisce un WAV in memoria (PCM 8/16 bit) per i test. */
function costruisciWav({ canali = 1, frequenza = 44100, bit = 16, secondi = 1, generatore = (t) => Math.sin(2 * Math.PI * 440 * t) }) {
  const campioni = Math.round(frequenza * secondi);
  const byteCampione = bit / 8;
  const dati = new ArrayBuffer(44 + campioni * canali * byteCampione);
  const vista = new DataView(dati);
  const scrivi = (offset, testo) => {
    for (let i = 0; i < testo.length; i += 1) vista.setUint8(offset + i, testo.charCodeAt(i));
  };

  scrivi(0, 'RIFF');
  vista.setUint32(4, 36 + campioni * canali * byteCampione, true);
  scrivi(8, 'WAVE');
  scrivi(12, 'fmt ');
  vista.setUint32(16, 16, true);
  vista.setUint16(20, 1, true);
  vista.setUint16(22, canali, true);
  vista.setUint32(24, frequenza, true);
  vista.setUint32(28, frequenza * canali * byteCampione, true);
  vista.setUint16(32, canali * byteCampione, true);
  vista.setUint16(34, bit, true);
  scrivi(36, 'data');
  vista.setUint32(40, campioni * canali * byteCampione, true);

  for (let i = 0; i < campioni; i += 1) {
    const t = i / frequenza;
    for (let canale = 0; canale < canali; canale += 1) {
      const valore = Math.max(-1, Math.min(1, generatore(t, canale)));
      const offset = 44 + (i * canali + canale) * byteCampione;
      if (bit === 16) vista.setInt16(offset, Math.round(valore * 32767), true);
      else vista.setUint8(offset, Math.round(valore * 127) + 128);
    }
  }

  return dati;
}

/** Endpoint finto: raccoglie le richieste e risponde come farebbe Whisper. */
function creaFetchFinto(registro, opzioni = {}) {
  let numero = 0;
  return async (url, opzioniFetch) => {
    numero += 1;
    const modulo = opzioniFetch.body;
    const file = modulo.get('file');
    registro.push({
      numero,
      url,
      modello: modulo.get('model'),
      lingua: modulo.get('language'),
      formato: modulo.get('response_format'),
      prompt: modulo.get('prompt'),
      nomeFile: file ? file.name : null,
      byte: file ? file.size : 0,
    });

    if (opzioni.stato && numero <= (opzioni.volte || 1)) {
      return {
        ok: false,
        status: opzioni.stato,
        json: async () => ({ error: { message: 'errore simulato dal test', type: 'test' } }),
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        text: ` segmento ${numero} di prova`,
        language: 'it',
        duration: 3,
        segments: [
          { start: 0, end: 1.5, text: `Segmento ${numero} parte A.` },
          { start: 1.5, end: 3, text: `Segmento ${numero} parte B.` },
        ],
      }),
    };
  };
}

const CONFIG_TEST = {
  chiave: 'sk-chiave-finta',
  endpoint: 'https://endpoint.finto/v1',
  modello: 'whisper-1',
  lingua: 'auto',
  secondiChunk: 600,
  limiteMb: 20,
  formatoRisposta: 'verbose',
  timestamp: true,
  continuita: true,
};

/* ------------------------------------------------------------------ */
/* 1) Formattazione, timestamp e messaggi                              */
/* ------------------------------------------------------------------ */

function testFormattazione(M) {
  console.log('\n1) Formattazione, timestamp e messaggi');

  verificaUguale('formattaSubRip a zero', M.formattaSubRip(0), '00:00:00,000');
  verificaUguale('formattaSubRip con millisecondi', M.formattaSubRip(3661.25), '01:01:01,250');
  verificaUguale('formattaBreve (mm:ss)', M.formattaBreve(125.9), '02:05');
  verificaUguale('formattaDurata (secondi)', M.formattaDurata(75), '1m 15s');
  verificaUguale('formattaDurata (ore)', M.formattaDurata(3725), '1h 02m 05s');
  verificaUguale('formattaDimensione (MB)', M.formattaDimensione(2.5 * 1024 * 1024), '2.50 MB');
  verificaUguale('stimaCosto (1 ora)', M.stimaCosto(3600), 0.36);
  verificaUguale('endpoint normalizzato', M.normalizzaEndpoint(' https://api.openai.com/v1/// '), 'https://api.openai.com/v1');
  verificaUguale('endpoint predefinito', M.normalizzaEndpoint(''), 'https://api.openai.com/v1');
  verifica('stima memoria decodifica', M.stimaMemoriaDecodifica(10 * 1024 * 1024) > 100 * 1024 * 1024);

  const segmenti = [
    { inizio: 0, fine: 1.5, testo: 'Primo.' },
    { inizio: 61.25, fine: 63, testo: 'Secondo.' },
  ];
  verificaUguale('costruisciSrt (intestazione)', M.costruisciSrt(segmenti).split('\n').slice(0, 2).join(' | '), '1 | 00:00:00,000 --> 00:00:01,500');
  verifica('costruisciSrt (secondo blocco)', M.costruisciSrt(segmenti).includes('2\n00:01:01,250 --> 00:01:03,000\nSecondo.'));
  verificaUguale('testo con timestamp', M.testoConTimestamp(segmenti), '[00:00] Primo.\n[01:01] Secondo.');

  verifica('errore 401 tradotto', M.messaggioErrore(401, null).includes('Chiave API'));
  verifica('errore 413 tradotto', M.messaggioErrore(413, null).includes('Limite MB'));
  verifica('dettaglio del servizio incluso', M.messaggioErrore(400, { error: { message: 'modello inesistente' } }).includes('modello inesistente'));
  verifica('errore sconosciuto generico', M.messaggioErrore(418, null).includes('418'));
}

/* ------------------------------------------------------------------ */
/* 2) WAV                                                              */
/* ------------------------------------------------------------------ */

async function testWav(M) {
  console.log('\n2) WAV: lettura, estrazione mono 16 kHz, scrittura');

  const wavMono = costruisciWav({ canali: 1, frequenza: 44100, bit: 16, secondi: 2, generatore: () => 0.5 });
  const analisi = M.analizzaWav(wavMono);
  verifica('WAV riconosciuto', Boolean(analisi));
  verificaUguale('canali rilevati', analisi.canali, 1);
  verificaUguale('frequenza rilevata', analisi.frequenza, 44100);
  verificaUguale('bit rilevati', analisi.bit, 16);
  verificaVicino('durata calcolata', analisi.durata, 2, 0.001);

  const mono16 = M.estraiMono16Wav(analisi, 0, 2);
  verificaVicino('campioni a 16 kHz', mono16.length, 32000, 4);
  verificaVicino('ampiezza conservata', mono16[1000] / 32767, 0.5, 0.01);

  const wavStereo = costruisciWav({
    canali: 2,
    frequenza: 44100,
    bit: 16,
    secondi: 1,
    generatore: (t, canale) => (canale === 0 ? 0.8 : -0.8),
  });
  const analisiStereo = M.analizzaWav(wavStereo);
  verificaUguale('canali del file stereo', analisiStereo.canali, 2);
  verificaVicino('downmix dei due canali opposti', M.estraiMono16Wav(analisiStereo, 0, 1)[500] / 32767, 0, 0.01);

  const blob = M.creaBlobWav(mono16);
  const riletto = M.analizzaWav(await blob.arrayBuffer());
  verifica('WAV scritto e riletto', Boolean(riletto));
  verificaUguale('frequenza del WAV generato', riletto.frequenza, 16000);
  verificaUguale('canali del WAV generato', riletto.canali, 1);
  verificaVicino('campioni conservati', riletto.campioni, 32000, 4);

  verifica('WAV a 8 bit supportato', Boolean(M.analizzaWav(costruisciWav({ frequenza: 8000, bit: 8, secondi: 1 }))));
  verificaUguale('file non WAV scartato', M.analizzaWav(new TextEncoder().encode('questo non è un file audio').buffer), null);
  verificaUguale('file troppo piccolo scartato', M.analizzaWav(new ArrayBuffer(16)), null);
}

/* ------------------------------------------------------------------ */
/* 3) MP3: scansione dei frame e suddivisione                          */
/* ------------------------------------------------------------------ */

const ffmpegDisponibile = () => spawnSync('ffmpeg', ['-version']).status === 0;

function generaMp3(percorso, secondi, bitrate = '128k') {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secondi}`,
    '-ac', '1', '-ar', '44100', '-b:a', bitrate, percorso,
  ], { stdio: 'inherit' });
}

/** Buffer completo (senza il pool condiviso di Node) di un file. */
function bufferDiFile(percorso) {
  const buffer = fs.readFileSync(percorso);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function testMp3(M) {
  console.log('\n3) MP3: scansione dei frame e suddivisione');

  verificaUguale('testa non valida rifiutata', M.testaFrameMp3(new DataView(new ArrayBuffer(16)), 0), null);

  if (!ffmpegDisponibile()) {
    console.log('  ~ FFmpeg non disponibile: verifica MP3 saltata');
    return;
  }

  const percorso = path.join(TEMP, 'prova.mp3');
  generaMp3(percorso, 30);
  const buffer = bufferDiFile(percorso);
  const mp3 = M.scansionaMp3(buffer);

  verifica('MP3 riconosciuto', Boolean(mp3));
  verifica('tag ID3 iniziale saltato', mp3.frame[0].offset >= 10, `offset ${mp3.frame[0].offset}`);
  verifica('molti frame individuati', mp3.frame.length > 500, `frame: ${mp3.frame.length}`);
  verificaVicino('durata complessiva', mp3.durata, 30, 0.2);
  verificaUguale('frequenza di campionamento', mp3.frequenza, 44100);
  verificaUguale('bitrate rilevato (128 kbps)', mp3.bitrate, 128000);

  const ultimo = mp3.frame[mp3.frame.length - 1];
  verifica('i frame stanno dentro il file', ultimo.offset + ultimo.lunghezza <= buffer.byteLength);
  verifica(
    'gli inizi sono cumulativi e crescenti',
    mp3.frame.every((f, i) => i === 0 || f.inizio > mp3.frame[i - 1].inizio)
  );

  const intero = M.raggruppaFrameMp3(mp3.frame, 600, 20 * 1024 * 1024);
  verificaUguale('un solo segmento con limite ampio', intero.length, 1);
  verificaVicino('byte del segmento unico', intero[0].byte, buffer.byteLength - mp3.frame[0].offset, 2048);

  const aCinquantaSecondi = M.raggruppaFrameMp3(mp3.frame, 5, 20 * 1024 * 1024);
  verifica('più segmenti da 5 secondi', aCinquantaSecondi.length >= 5, `segmenti: ${aCinquantaSecondi.length}`);
  verifica(
    'nessun segmento oltre la durata richiesta',
    aCinquantaSecondi.every((s) => s.durata <= 5.05),
    aCinquantaSecondi.map((s) => s.durata.toFixed(2)).join(', ')
  );
  verificaVicino('il secondo segmento inizia dopo ~5 s', aCinquantaSecondi[1].inizio, 5, 0.1);

  const piccolo = M.raggruppaFrameMp3(mp3.frame, 600, 40 * 1024);
  verifica(
    'nessun segmento oltre il limite di byte',
    piccolo.every((s) => s.byte <= 40 * 1024),
    piccolo.map((s) => s.byte).join(', ')
  );
  verifica('molti segmenti con limite piccolo', piccolo.length >= 8, `segmenti: ${piccolo.length}`);
  verifica(
    'la somma dei byte copre il file',
    piccolo.reduce((totale, s) => totale + s.byte, 0) === buffer.byteLength - mp3.frame[0].offset
  );
}

/* ------------------------------------------------------------------ */
/* 4) Pianificazione dei segmenti WAV e PCM                            */
/* ------------------------------------------------------------------ */

function testPianificazione(M) {
  console.log('\n4) Pianificazione dei segmenti');

  const wav = M.analizzaWav(costruisciWav({ secondi: 10 }));
  const segmenti = M.pianificaSegmentiWav(wav, 600, 100 * 1024);
  verifica('il WAV lungo viene suddiviso', segmenti.length >= 4, `segmenti: ${segmenti.length}`);
  verifica(
    'i segmenti WAV rispettano il limite di byte',
    segmenti.every((s) => s.byte <= 100 * 1024 + 64),
    segmenti.map((s) => s.byte).join(', ')
  );
  verificaVicino('copertura completa della durata', segmenti.reduce((t, s) => t + s.durata, 0), wav.durata, 0.1);
  verifica('indici progressivi', segmenti.every((s, i) => s.indice === i && s.tipo === 'wav'));

  const perDurata = M.pianificaSegmentiWav(wav, 2, 20 * 1024 * 1024);
  verificaUguale('segmenti da 2 secondi', perDurata.length, 5);

  const pcm = M.pianificaSegmentiPcm16(16000 * 12, 600, 100 * 1024);
  verifica('PCM suddiviso in più blocchi', pcm.length >= 4, `segmenti: ${pcm.length}`);
  verifica(
    'blocchi PCM entro il limite',
    pcm.every((s) => s.byte <= 100 * 1024 + 64),
    pcm.map((s) => s.byte).join(', ')
  );
  verificaVicino('copertura PCM completa', pcm.reduce((t, s) => t + s.durata, 0), 12, 0.01);
}

/* ------------------------------------------------------------------ */
/* 5) Pipeline completa con endpoint simulato                          */
/* ------------------------------------------------------------------ */

function secondiDaSubRip(riga) {
  const tempo = /(\d{2}):(\d{2}):(\d{2}),(\d{3})/.exec(riga || '');
  if (!tempo) return null;
  return Number(tempo[1]) * 3600 + Number(tempo[2]) * 60 + Number(tempo[3]) + Number(tempo[4]) / 1000;
}

const blocchiSrt = (srt) => srt.trim().split(/\n\s*\n/);

async function testPipeline(sandbox, M) {
  console.log('\n5) Pipeline completa (endpoint simulato)');

  const registro = [];
  sandbox.fetch = creaFetchFinto(registro);

  // 5a) File entro il limite: una sola richiesta, nessuna conversione.
  const piccolo = new FileEsplicito([costruisciWav({ secondi: 1 })], 'breve.wav', { type: 'audio/wav' });
  const esito1 = await M.eseguiTrascrizione(piccolo, Object.assign({}, CONFIG_TEST, { limiteMb: 1 }));

  verificaUguale('file piccolo: strategia "intero"', esito1.strategia, 'intero');
  verificaUguale('file piccolo: una sola richiesta', registro.length, 1);
  verificaUguale('nome del file originale mantenuto', registro[0].nomeFile, 'breve.wav');
  verificaUguale('modello inviato', registro[0].modello, 'whisper-1');
  verificaUguale('formato verboso richiesto', registro[0].formato, 'verbose_json');
  verificaUguale('nessuna lingua se è "auto"', registro[0].lingua, null);
  verificaUguale('nessun prompt sul primo segmento', registro[0].prompt, null);
  verificaUguale('testo ricomposto', esito1.testo, 'segmento 1 di prova');
  verificaUguale("lingua rilevata dall'endpoint", esito1.lingua, 'it');
  verificaUguale('SRT del primo segmento', esito1.srt.split('\n')[1], '00:00:00,000 --> 00:00:01,500');

  // 5b) WAV grande: suddivisione in segmenti mono 16 kHz.
  const registroWav = [];
  sandbox.fetch = creaFetchFinto(registroWav);
  const grande = new FileEsplicito([costruisciWav({ secondi: 10, canali: 2 })], 'lungo.wav', { type: 'audio/wav' });
  const esito2 = await M.eseguiTrascrizione(grande, Object.assign({}, CONFIG_TEST, { limiteMb: 0.1 }));

  verificaUguale('WAV grande: strategia "wav"', esito2.strategia, 'wav');
  verifica('WAV grande: suddiviso in più richieste', registroWav.length >= 3, `richieste: ${registroWav.length}`);
  verifica(
    'WAV grande: ogni segmento entro il limite di byte',
    registroWav.every((r) => r.byte <= 0.1 * 1024 * 1024 + 4096),
    registroWav.map((r) => r.byte).join(', ')
  );
  verificaUguale('WAV grande: nome dei segmenti', registroWav[0].nomeFile, 'lungo.wav');
  verifica(
    'continuità: il testo precedente viene passato al segmento successivo',
    Boolean(registroWav[1].prompt) && registroWav[1].prompt.includes('segmento 1 di prova'),
    String(registroWav[1].prompt)
  );
  verifica(
    'testo composto da tutti i segmenti',
    esito2.testo.includes('segmento 1 di prova')
      && esito2.testo.includes(`segmento ${registroWav.length} di prova`),
    esito2.testo
  );
  verificaUguale('blocchi SRT = 2 per segmento', blocchiSrt(esito2.srt).length, registroWav.length * 2);
  verifica(
    'timestamp cumulativi fra i segmenti',
    secondiDaSubRip(blocchiSrt(esito2.srt)[2].split('\n')[1]) > 2,
    blocchiSrt(esito2.srt)[2]
  );
  verificaVicino('durata complessiva rilevata', esito2.durata, 10, 0.05);
  verifica('costo stimato calcolato', esito2.costoStimato > 0);

  // 5c) Continuità disattivata: nessun prompt inviato.
  const registroSenzaPrompt = [];
  sandbox.fetch = creaFetchFinto(registroSenzaPrompt);
  await M.eseguiTrascrizione(grande, Object.assign({}, CONFIG_TEST, { limiteMb: 0.1, continuita: false }));
  verifica('continuità disattivata: nessun prompt', registroSenzaPrompt.every((r) => r.prompt === null));

  // 5d) MP3 grande: divisione ai confini dei frame, senza ricodifica.
  if (ffmpegDisponibile()) {
    const registroMp3 = [];
    sandbox.fetch = creaFetchFinto(registroMp3);
    const percorsoMp3 = path.join(TEMP, 'pipeline.mp3');
    generaMp3(percorsoMp3, 30);
    const mp3Grande = new FileEsplicito([fs.readFileSync(percorsoMp3)], 'intervista.mp3', { type: 'audio/mpeg' });
    const esito3 = await M.eseguiTrascrizione(mp3Grande, Object.assign({}, CONFIG_TEST, { limiteMb: 0.1 }));

    verificaUguale('MP3 grande: strategia "mp3"', esito3.strategia, 'mp3');
    verifica('MP3 grande: suddiviso in più richieste', registroMp3.length >= 2, `richieste: ${registroMp3.length}`);
    verifica('MP3 grande: segmenti con estensione .mp3', registroMp3.every((r) => r.nomeFile.endsWith('.mp3')));
    verifica(
      'MP3 grande: ogni segmento entro il limite',
      registroMp3.every((r) => r.byte <= 0.1 * 1024 * 1024 + 2048),
      registroMp3.map((r) => r.byte).join(', ')
    );
    verificaVicino('MP3 grande: durata rilevata', esito3.durata, 30, 0.2);
  } else {
    console.log('  ~ FFmpeg non disponibile: verifica pipeline MP3 saltata');
  }

  // 5e) Errori dell'endpoint.
  const registro401 = [];
  sandbox.fetch = creaFetchFinto(registro401, { stato: 401, volte: 1 });
  let errore401 = null;
  try {
    await M.eseguiTrascrizione(piccolo, Object.assign({}, CONFIG_TEST, { limiteMb: 1 }));
  } catch (errore) {
    errore401 = errore;
  }
  verifica('errore 401 propagato con messaggio chiaro', Boolean(errore401) && /Chiave API/.test(errore401.message), errore401 && errore401.message);
  verificaUguale('401: nessun nuovo tentativo', registro401.length, 1);

  const registro500 = [];
  sandbox.fetch = creaFetchFinto(registro500, { stato: 500, volte: 1 });
  const esito4 = await M.eseguiTrascrizione(piccolo, Object.assign({}, CONFIG_TEST, { limiteMb: 1 }));
  verifica('errore 500 transitorio: nuovo tentativo e successo', Boolean(esito4) && esito4.testo.length > 0);
  verificaUguale('500: due richieste registrate', registro500.length, 2);

  sandbox.fetch = async () => { throw new TypeError('Failed to fetch'); };
  let erroreRete = null;
  try {
    await M.eseguiTrascrizione(piccolo, Object.assign({}, CONFIG_TEST, { limiteMb: 1 }));
  } catch (errore) {
    erroreRete = errore;
  }
  verifica(
    "errore di rete spiegato (CORS/endpoint)",
    Boolean(erroreRete) && /Impossibile contattare l'endpoint/.test(erroreRete.message) && /CORS/.test(erroreRete.message),
    erroreRete && erroreRete.message
  );
}

/* ------------------------------------------------------------------ */
/* Esecuzione                                                          */
/* ------------------------------------------------------------------ */

(async function esegui() {
  console.log('=== Test unitari — Trascrizione Audio standalone ===');

  fs.rmSync(TEMP, { recursive: true, force: true });
  fs.mkdirSync(TEMP, { recursive: true });

  const sandbox = caricaMotore();
  const M = sandbox.TrascrizioneAudio;
  if (!M) {
    console.error('Il motore non ha esportato window.TrascrizioneAudio');
    process.exit(1);
  }

  testFormattazione(M);
  await testWav(M);
  testMp3(M);
  testPianificazione(M);
  await testPipeline(sandbox, M);

  console.log(`\n=== Risultato: ${superati} verifiche superate, ${falliti} fallite ===`);
  process.exit(falliti === 0 ? 0 : 1);
})();



