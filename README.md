# 🎧 Trascrizione Audio — versione "tutto in un solo file"

**Un unico file `index.html`**: lo scarichi, fai doppio clic e trascrivi audio.
Nessun server, nessuna installazione, nessuna dipendenza. Il file viene diviso in
segmenti automaticamente (chunking nel browser) così puoi trascrivere anche
registrazioni di **ore**, superando il limite di 25 MB per richiesta dell'API OpenAI.

Sono disponibili **due motori**, si scelgono dal primo menu dell'app:

| Motore | Serve una chiave? | Dove gira il modello |
|---|---|---|
| **Locale nel browser** | **no** | dentro il browser (transformers.js + Whisper ONNX) |
| **API OpenAI** (o compatibile) | sì, tranne per server locali | sul server di OpenAI (o su un tuo server) |

👉 **Prova subito:** <https://alessandro1040.github.io/trascrizione-audio-standalone/>
👉 **Scarica il file:** [index.html](https://raw.githubusercontent.com/Alessandro1040/trascrizione-audio-standalone/main/index.html)
(tasto destro → *Salva link con nome…*, poi doppio clic)

![tema](https://img.shields.io/badge/tema-nero%20%2F%20celeste-00b4d8)
![dipendenze](https://img.shields.io/badge/dipendenze-zero-0a0a0f)
![test](https://img.shields.io/badge/test-187%20verifiche-0077b6)
![api](https://img.shields.io/badge/api-facoltativa-00e676)

---

## 🚀 Come si usa

1. **Scarica** `index.html` e aprilo con doppio clic, oppure usa la pagina online
   di GitHub Pages.
2. Scegli il **motore**:
   * **Locale nel browser** → non serve né chiave né internet (a parte il primo
     download del modello, poi resta in cache); l'audio non esce dal computer.
   * **API OpenAI** → incolla la tua chiave `sk-…` (resta solo nel tuo browser) e,
     se vuoi, cambia endpoint/modello.
3. Trascina il file audio (o incollalo con <kbd>Ctrl/⌘</kbd>+<kbd>V</kbd>).
4. Premi **Avvia trascrizione**.
5. Copia il testo o scarica **`.txt`**, **`.srt`** (sottotitoli) e **`.json`**.

## 🔌 Funzionare senza API

Sì: la trascrizione può avvenire **senza nessuna API, nessuna chiave e nessun costo**,
in due modi.

> **Nota di chiarezza:** Whisper **non è un LLM**. È un modello **ASR** (speech-to-text):
> riceve l'audio e restituisce il testo, nient'altro — non puoi fargli domande né
> chiedergli riassunti. Un LLM servirebbe solo *dopo*, se volessi riassumere o
> ripulire la trascrizione (passaggio separato, non necessario per trascrivere).

### Modo A — motore locale nel browser (consigliato: zero installazioni)

Nel menu **Motore** scegli *Locale nel browser*: non serve alcuna chiave. La prima
volta il browser scarica il modello (resta nella cache, quindi poi funziona anche
**offline**) e la trascrizione avviene sul tuo computer.

| Modello | Download | Velocità (WASM) | Errore parola misurato* |
|---|---|---|---|
| `whisper-tiny` | ~38 MB | molto veloce | alto (sconsigliato per l'italiano) |
| `whisper-base` | ~73 MB | ~6× il tempo reale | ~17% |
| `whisper-small` | ~237 MB | ~1,8× il tempo reale | **~14%** (predefinito) |

\* misurato su un audio italiano sintetico di 41,8 s con la strategia a blocchi
(parte dell'errore è solo formattazione dei numeri: `1992` invece di "mille
novecento novanta due").

* Con **WebGPU** (Chrome/Edge recenti) l'elaborazione è diverse volte più veloce;
  l'app lo usa in automatico e, se non è disponibile o dà errore, **ripassa da sola
  a WASM** avvisandoti nel registro.
* L'audio viene elaborato in **blocchi** (5 minuti per impostazione predefinita) e
  dentro ogni blocco il modello lavora a finestre di 30 s **con sovrapposizione e
  contesto condiviso**: così non si perdono parole ai confini (vedi la sezione
  "Correzioni" qui sotto, dove questo problema è documentato con le misure).
* I blocchi **completamente silenziosi vengono saltati**: Whisper, quando non c'è
  parlato, tende a inventare testo.
* Nessun limite di 25 MB: il file resta dov'è, nel tuo computer.

### Modo B — server locale con whisper.cpp (qualità massima, offline)

Se vuoi la massima precisione (o usare modelli grandi come `large-v3`), fai girare
Whisper sul computer con [whisper.cpp](https://github.com/ggml-org/whisper.cpp):
questo repository include un server locale che parla la stessa lingua dell'API
OpenAI, quindi l'app funziona senza modifiche e **senza chiave**.

```bash
# 1. whisper.cpp (una volta sola)
brew install whisper.cpp            # macOS
# sudo apt install whisper.cpp      # Debian/Ubuntu (o compila dai sorgenti)

# 2. avvia il server locale: scarica il modello alla prima esecuzione
npm run start:locale                # default: ggml-base (147 MB) su http://localhost:8090
MODELLO=small npm run start:locale  # modelli: tiny, base, small, medium, large-v3
```

Poi, nell'app: **Motore = API**, **Endpoint = `http://localhost:8090/v1`** — la chiave
può restare vuota (l'app riconosce gli indirizzi locali e non la chiede).

Il server espone `/v1/audio/transcriptions`, `/v1/models` e `/salute`, converte
l'audio in 16 kHz mono con FFmpeg, gestisce le trascrizioni in coda (una alla volta)
e restituisce anche i segmenti temporizzati, così `.srt` funziona come con l'API.

### Confronto

| | Locale nel browser | Locale con whisper.cpp | API OpenAI |
|---|---|---|---|
| Chiave API | no | no | sì |
| Costo | zero | zero | ~$0,006/min |
| Internet | solo il primo download | solo il primo download | sempre |
| Privacy | l'audio resta nel computer | l'audio resta nel computer | l'audio va a OpenAI |
| Qualità | buona (modello piccolo) | ottima (modelli grandi) | ottima |
| Velocità | dipende dal computer | veloce (Metal/CPU multi-thread) | veloce e costante |

<!-- MARKER_README_COSA_FA -->


## ✨ Cosa fa

| Funzione | Dettaglio |
|---|---|
| Due motori, un solo file | **locale** (nessuna API, nessun costo, offline) oppure **API** OpenAI e compatibili |
| Chunking automatico nel browser | i file grandi vengono divisi in segmenti sotto il limite di 25 MB e ricomposti nell'ordine corretto |
| Strategia adattiva per formato | **WAV** → estrazione PCM mono 16 kHz senza decodifica; **MP3** → taglio ai confini dei frame, byte originali, nessuna ricodifica; **altri formati** (M4A, MP4, FLAC, OGG, WEBM, OPUS, AAC…) → decodifica con `OfflineAudioContext` e ricampionamento a 16 kHz |
| Motore locale | Whisper ONNX eseguito in un Web Worker (transformers.js), finestre da 30 s, WebGPU quando disponibile, modello in cache (offline dal secondo uso) |
| Qualsiasi durata | la memoria usata dipende dal formato: per WAV e MP3 resta minima anche con file di più ore |
| Selezione lingua | 30 lingue disponibili oppure rilevamento automatico |
| Continuità fra i segmenti | con l'API il testo precedente viene passato come `prompt` al segmento successivo |
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

> Questo schema riguarda il **motore API**. Con il **motore locale nel browser** il
> file non viene inviato da nessuna parte: l'audio viene semplicemente convertito in
> 16 kHz mono e passato al modello a finestre di 30 secondi (una alla volta), quindi
> non esiste alcun limite di 25 MB né di durata.

## 🐛 Correzioni dopo i primi utilizzi reali

Gli utilizzi su audio veri hanno evidenziato — e i test ora coprono — **due
problemi seri nel motore locale**, entrambi risolti:

1. **Testo perso ai confini delle finestre** (qualità). L'app elaborava blocchi da
   30 s indipendenti, senza contesto: su un audio italiano di 41,8 s un'intera frase
   spariva e un altro pezzo veniva inventato. Misure con lo stesso modello:

   | Strategia | Errore parola (WER) | Testo |
   |---|---|---|
   | Finestre da 30 s senza contesto (versione precedente) | 24,4% | frase mancante |
   | Blocchi con sovrapposizione e contesto (versione attuale) | **6,0–16,8%** | completo |

   Ora si usa il meccanismo *long-form* della libreria (`chunk_length_s: 30`,
   `stride_length_s: 5`), che si porta avanti il contesto del testo precedente.

2. **Blocco silenzioso senza messaggi** (robustezza). Se il caricamento del modello
   falliva (per esempio WebGPU non utilizzabile), l'errore non era collegato alla
   richiesta in corso: l'app restava "in elaborazione" all'infinito. Ora l'errore
   viene mostrato, e se il problema è WebGPU si passa automaticamente a WASM.

Inoltre il **test suite ora controlla la qualità**: oltre a verificare che il testo
non sia vuoto, calcola l'errore parola (WER) su un audio italiano reale e pretende
che alcune **frasi chiave** (inizio, centro e fine) siano presenti per intero. È
esattamente il controllo che mancava quando il testo veniva perso.

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
npm test               # 126 verifiche unitarie + 53 in Chrome + 14 sul server locale
                       # (67 in Chrome quando si include il motore locale)
npm run test:unit      # il motore estratto da index.html, eseguito in Node
npm run test:browser   # Chrome headless che apre il file da file://
npm run test:locale-server   # whisper.cpp: trascrizione reale, senza API

# motore locale nel browser incluso nei test (scarica il modello, poi lo tiene in cache):
PROFILO_BROWSER=/tmp/profilo-test TEST_LOCALE=1 npm run test:browser
TEST_LOCALE_MODELLO=Xenova/whisper-base PROFILO_BROWSER=... TEST_LOCALE=1 npm run test:browser

# verifica della versione pubblicata su GitHub Pages:
PAGINA_URL=https://alessandro1040.github.io/trascrizione-audio-standalone/ node test/browser.js
```

I test **non usano la rete**: `fetch` viene sostituito da uno stub che risponde come
Whisper e gli audio di prova sono generati con FFmpeg. Per il motore locale e per
whisper.cpp vengono usate frasi **italiane reali**, sintetizzate con il comando
`say` di macOS, e si verifica che il testo prodotto contenga le parole attese —
senza chiave API e senza costi. Il test del motore locale calcola anche l'**errore
parola (WER)** e pretende che quattro frasi chiave (inizio, centro, fine) compaiano
per intero: è il controllo che mancava quando l'app perdeva testo ai confini.

Durante lo sviluppo i test hanno individuato tre bug reali, tutti corretti:

1. **Maschera bit a bit dei frame MP3**: `header & 0xffe00000` in JavaScript produce
   un intero a 32 bit *con segno*, quindi il confronto non era mai vero e nessun MP3
   veniva riconosciuto (risolto con `header >>> 21` confrontato con `0x7ff`).
2. **Limite di segmento non applicato**: il valore minimo del campo "Limite MB per
   segmento" veniva forzato a 1 MB, vanificando limiti più piccoli.
3. **Conversione audio del server locale**: per i file `.wav` il nome del file di
   uscita coincideva con quello di ingresso e FFmpeg rifiutava di sovrascrivere il
   file in lettura (risolto con un nome distinto per l'uscita a 16 kHz).

## ⚙️ Impostazioni avanzate

| Campo | Default | Note |
|---|---|---|
| `Secondi per segmento` | 600 | durata massima di ogni segmento inviato all'API (meno, se si supera il limite di MB) |
| `Limite MB per segmento` | 20 | margine di sicurezza rispetto ai 25 MB dell'API (minimo 0,05 MB) |
| `Formato risposta` | `verbose_json` | necessario per i timestamp; `json` restituisce solo il testo |
| `Endpoint API` | `https://api.openai.com/v1` | qualsiasi servizio compatibile OpenAI (per `localhost` la chiave non serve) |
| `Modello` | `whisper-1` | modificabile (es. un modello self-hosted) |
| `Blocco audio locale` | 300 s | quanto audio elaborare per volta con il motore locale; blocchi più corti danno progresso più fine |
| `Modello locale` | `Xenova/whisper-small` | `tiny`/`base` più veloci ma meno precisi |
| `Elaborazione` | Auto | WebGPU se disponibile, altrimenti (o in caso di errore) WASM |

## 🌐 Pubblicare su GitHub Pages

`index.html` alla radice è sufficiente: *Settings → Pages → Deploy from a branch →
main / root*. L'app è già online su
<https://alessandro1040.github.io/trascrizione-audio-standalone/>.

## 🆚 Quale versione usare

| | Questo file unico | [trascrizione-audio](https://github.com/Alessandro1040/trascrizione-audio) (Node) |
|---|---|---|
| Installazione | nessuna (doppio clic) | Node + FFmpeg |
| Chiave API | nessuna (motore locale) o nel browser | sul server, mai esposta |
| Adatto a | uso personale, demo, file fino a qualche ora | servizio pubblico con più utenti e file enormi |
| Formati | tutti quelli supportati dal browser | tutti (conversione con FFmpeg) |

## 📄 Licenza

MIT.

