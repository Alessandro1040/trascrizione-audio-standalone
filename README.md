# 🎧 Trascrizione Audio — versione "tutto in un solo file"

**Un unico file `index.html`**: lo scarichi, fai doppio clic e trascrivi audio.
Nessun server, nessuna installazione, nessuna dipendenza. Il file viene diviso in
segmenti automaticamente (chunking nel browser) così puoi trascrivere anche
registrazioni di **ore**, superando il limite di 25 MB per richiesta dell'API OpenAI.

👉 **Prova subito:** <https://alessandro1040.github.io/trascrizione-audio-standalone/>
👉 **Scarica il file:** [index.html](https://raw.githubusercontent.com/Alessandro1040/trascrizione-audio-standalone/main/index.html)
(tasto destro → *Salva link con nome…*, poi doppio clic)

![tema](https://img.shields.io/badge/tema-nero%20%2F%20celeste-00b4d8)
![dipendenze](https://img.shields.io/badge/dipendenze-zero-0a0a0f)
![test](https://img.shields.io/badge/test-142%20verifiche-0077b6)

---

## 🚀 Come si usa

1. **Scarica** `index.html` e aprilo con doppio clic, oppure usa la pagina online
   di GitHub Pages.
2. Incolla la tua **chiave API OpenAI** (`sk-…`) nel campo della chiave: resta
   **solo nel tuo browser** (in `localStorage`, se lasci attiva la spunta).
3. Trascina il file audio (o incollalo con <kbd>Ctrl/⌘</kbd>+<kbd>V</kbd>).
4. Premi **Avvia trascrizione**.
5. Copia il testo o scarica **`.txt`**, **`.srt`** (sottotitoli) e **`.json`**.

Nessun server intermedio riceve l'audio: i segmenti vengono inviati esclusivamente
all'endpoint configurato (per impostazione predefinita OpenAI).

Puoi sostituire l'endpoint con **qualsiasi servizio compatibile OpenAI**
(`.../v1/audio/transcriptions`): ad esempio un proxy aziendale, `whisper.cpp server`,
`faster-whisper-server`, LM Studio o un endpoint self-hosted — in quel caso spesso
non serve nemmeno la chiave.

## ✨ Cosa fa

| Funzione | Dettaglio |
|---|---|
| Chunking automatico nel browser | i file grandi vengono divisi in segmenti sotto il limite di 25 MB e ricomposti nell'ordine corretto |
| Strategia adattiva per formato | **WAV** → estrazione PCM mono 16 kHz senza decodifica; **MP3** → taglio ai confini dei frame, byte originali, nessuna ricodifica; **altri formati** (M4A, MP4, FLAC, OGG, WEBM, OPUS, AAC…) → decodifica con `OfflineAudioContext` e ricampionamento a 16 kHz |
| Qualsiasi durata | la memoria usata dipende dal formato: per WAV e MP3 resta minima anche con file di più ore |
| Selezione lingua | 30 lingue disponibili oppure rilevamento automatico |
| Continuità fra i segmenti | il testo precedente viene passato come `prompt` al segmento successivo |
| Timestamp e sottotitoli | anteprima `[mm:ss]` ed export `.srt` con tempi cumulativi corretti |
| Progresso e annullamento | barra di avanzamento, tempo stimato rimanente e pulsante **Annulla** |
| Riepilogo | durata, lingua, modello, numero di segmenti, parole, costo stimato e tempo impiegato |
| Errori comprensibili | messaggi in italiano per 401/402/413/429/5xx, problemi di rete o CORS |
| Privacy | nessun upload verso server di terzi, nessun tracciamento, nessuna dipendenza esterna |

## 🧠 Come funziona il chunking (senza ffmpeg)

L'API di OpenAI accetta al massimo **25 MB per richiesta**, quindi il file viene
diviso. La divisione avviene **interamente nel browser**:

```
file audio
   │
   ├─ ≤ limite (default 20 MB) ──────────────► inviato così com'è (1 richiesta)
   │
   ├─ WAV grande ─► PCM mono 16 kHz (32 KB/s) ─► segmenti .wav da ~1,5 MB ogni 10 min
   │
   ├─ MP3 grande ─► taglio ai confini dei frame MPEG ─► segmenti .mp3 originali
   │
   └─ altro formato grande ─► decodifica OfflineAudioContext ─► 16 kHz mono ─► .wav
                                   │
                    ogni segmento ─┴─► POST /audio/transcriptions (whisper-1)
                                   │
        testo + timestamp ricomposti (offset cumulativi) ─► .txt / .srt / .json
```

Perché è efficiente: i due formati più comuni (WAV e MP3) vengono divisi **senza
decodificare l'intero file**, quindi un podcast di 3 ore occupa in memoria solo la
dimensione del file, non l'audio espanso in float a 44,1 kHz. Gli altri formati
richiedono la decodifica completa: l'app mostra una stima della memoria necessaria
e consiglia di convertire in MP3/WAV se il file è molto lungo.

## 🔒 Note su sicurezza e privacy

* La chiave resta nel browser: **non** viene inviata a nessun server diverso da
  quello configurato.
* Chiunque abbia accesso a quel browser (o un'estensione malevola) può leggerla da
  `localStorage`: su computer condivisi lascia **disattivata** la voce
  "Ricorda la configurazione".
* L'API OpenAI **consente** le chiamate dal browser (`Access-Control-Allow-Origin`
  riflesso e `authorization` ammesso negli header), quindi funziona sia da `file://`
  sia da GitHub Pages; se usi un proxy che blocca il CORS l'app te lo segnala con un
  messaggio esplicito.

## 💰 Costi (indicativi, `whisper-1`)

| Durata audio | Costo stimato |
|---|---|
| 10 minuti | ~$0,06 |
| 1 ora | ~$0,36 |
| 5 ore | ~$1,80 |

## 🧪 Sviluppo e test

```bash
npm install            # solo puppeteer-core, per i test nel browser
npm test               # 89 verifiche unitarie + 53 verifiche in Chrome headless
npm run test:unit      # il motore estratto da index.html, eseguito in Node
npm run test:browser   # Chrome headless che apre il file da file://
```

I test **non usano la rete**: `fetch` viene sostituito da uno stub che risponde come
Whisper e gli audio di prova sono generati con FFmpeg. Vengono verificati lettura
WAV/MP3, ricampionamento a 16 kHz, taglio ai confini dei frame, limiti di byte,
timestamp cumulativi, SRT, nuovi tentativi ed errori. Nessuna chiave API reale e
nessun costo.

Durante lo sviluppo i test hanno individuato due bug reali, entrambi corretti:

1. **Maschera bit a bit dei frame MP3**: `header & 0xffe00000` in JavaScript produce
   un intero a 32 bit *con segno*, quindi il confronto non era mai vero e nessun MP3
   veniva riconosciuto (risolto con `header >>> 21` confrontato con `0x7ff`).
2. **Limite di segmento non applicato**: il valore minimo del campo "Limite MB per
   segmento" veniva forzato a 1 MB, vanificando limiti più piccoli.

## ⚙️ Impostazioni avanzate

| Campo | Default | Note |
|---|---|---|
| `Secondi per segmento` | 600 | durata massima di ogni segmento (meno, se si supera il limite di MB) |
| `Limite MB per segmento` | 20 | margine di sicurezza rispetto ai 25 MB dell'API (minimo 0,05 MB) |
| `Formato risposta` | `verbose_json` | necessario per i timestamp; `json` restituisce solo il testo |
| `Endpoint API` | `https://api.openai.com/v1` | qualsiasi servizio compatibile OpenAI |
| `Modello` | `whisper-1` | modificabile (es. un modello self-hosted) |

## 🌐 Pubblicare su GitHub Pages

`index.html` alla radice è sufficiente: *Settings → Pages → Deploy from a branch →
main / root*. L'app è già online su
<https://alessandro1040.github.io/trascrizione-audio-standalone/>.

## 🆚 Quale versione usare

| | Questo file unico | [trascrizione-audio](https://github.com/Alessandro1040/trascrizione-audio) (Node) |
|---|---|---|
| Installazione | nessuna (doppio clic) | Node + FFmpeg |
| Chiave API | nel browser | sul server, mai esposta |
| Adatto a | uso personale, demo, file fino a qualche ora | servizio pubblico con più utenti e file enormi |
| Formati | tutti quelli supportati dal browser | tutti (conversione con FFmpeg) |

## 📄 Licenza

MIT.

