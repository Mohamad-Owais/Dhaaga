# Dhaaga — A Thread Between Generations

Dhaaga preserves oral histories. An elder speaks naturally in Hindi, Kashmiri, Urdu, or
another supported Indian language. Dhaaga transcribes their voice with **Sarvam Saaras**,
translates it into English with **Sarvam Translate**, and weaves it into a warm,
printable story card.

## How it works

```
Browser (record / upload)
      │  POST /api/transcribe   (multipart audio + language_code)
      ▼
Express backend  ──►  Sarvam Speech-to-Text  (POST https://api.sarvam.ai/speech-to-text, model saaras:v3)
      │  returns { transcript, language_code }
      │  POST /api/translate    (JSON: text + source_language_code)
      ▼
Express backend  ──►  Sarvam Translate        (POST https://api.sarvam.ai/translate, model sarvam-translate:v1)
      │  returns { translated_text, title }
      ▼
Story card (title + English story) with copy / print / preserve-another
```

The API key is used **only** on the server, read from `.env`. It never reaches the browser.

## Requirements

- Node.js 18 or newer (uses the built-in `fetch`, `FormData` and `Blob`; tested on Node 20)
- A Sarvam AI API subscription key — create one at <https://dashboard.sarvam.ai>

## Setup and run

```bash
# 1. Move into the project
cd dhaaga

# 2. Install dependencies
npm install

# 3. Create your environment file from the template
cp .env.example .env

# 4. Open .env and paste your key into SARVAM_API_KEY
#    SARVAM_API_KEY=sk_xxxxxxxxxxxxxxxxxxxxxxxx

# 5. Start the server
npm start
```

Then open **http://localhost:3000** in your browser.

For development with auto-restart on file changes:

```bash
npm run dev
```

> Use **Chrome or Edge** for in-browser microphone recording (they record WebM/Opus).
> Safari records MP4 — both are accepted. If a browser blocks the mic, upload a
> WAV/MP3/M4A file instead.

## Environment variables (`.env`)

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SARVAM_API_KEY` | yes | — | Your Sarvam subscription key (server-side only). |
| `PORT` | no | `3000` | Port the server listens on. |
| `SARVAM_STT_MODEL` | no | `saaras:v3` | Speech-to-text model (`saaras:v3` or `saaras:v4`). |
| `SARVAM_TRANSLATE_MODEL` | no | `sarvam-translate:v1` | Translation model. `sarvam-translate:v1` covers all 22 scheduled languages (incl. Kashmiri, Urdu); `mayura:v1` covers 11. |
| `SARVAM_TITLE_MODEL` | no | *(empty)* | Leave empty to name stories **locally** (no extra API call — always works). Set to e.g. `sarvam-m` to try Sarvam text-generation first, with an automatic local fallback. |

## API endpoints (this server)

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | `{ ok, configured, sttModel, translateModel, titleModel }` |
| `POST` | `/api/transcribe` | multipart: `audio` (file), `language_code` | `{ transcript, language_code }` |
| `POST` | `/api/translate` | JSON: `{ text, source_language_code }` | `{ translated_text, source_language_code, title }` |

## Behaviour and limits

- The Sarvam **real-time** speech-to-text endpoint accepts audio up to **30 seconds**.
  The recorder stops itself at ~30 s and the UI tells the user to keep clips short.
- Uploads are capped at **25 MB** (configurable via `MAX_UPLOAD_BYTES` in `server.js`).
- Only audio files are accepted (WAV, MP3, M4A, OGG, WebM). Anything else returns a
  friendly message.
- Missing key → clear message. Empty transcript → "we could not hear any speech".
  Sarvam 403/429/422/5xx → mapped to plain-language errors.
- Titles are generated **from the translated story itself** by default, so the title is
  never fabricated and the demo never depends on a second model being available.

## Verifying without an API key

A self-contained test boots a fake Sarvam server and checks routing, validation,
error mapping, and the **exact** multipart/JSON payloads the backend sends:

```bash
node test-smoke.js
```

## Project layout

```
dhaaga/
├── server.js            # Express backend + Sarvam calls + title generation
├── package.json
├── .env.example         # template — no real secrets
├── .gitignore
├── test-smoke.js        # offline test: fake Sarvam server + payload assertions
├── README.md
└── public/
    ├── index.html       # landing page, studio, story card
    ├── styles.css       # warm ivory / terracotta / sage editorial design
    └── app.js           # recording, upload, API calls, story card actions
```

## Quick demo script (hackathon)

1. `npm install && cp .env.example .env` → paste key → `npm start`.
2. Open `http://localhost:3000`.
3. Pick **Hindi**, press **Start recording**, speak a short memory in Hindi, press **Stop**.
4. Press **Weave the thread** — watch it transcribe, then translate.
5. Show the original transcript and the English story card side by side.
6. **Copy story** or **Print / Save as PDF**, then **Preserve another memory**.
