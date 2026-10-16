/**
 * Dhaaga — A Thread Between Generations
 * Express backend.
 *
 * Flow:  browser records/uploads audio
 *        -> POST /api/transcribe  -> Sarvam Saaras (speech-to-text)
 *        -> POST /api/translate   -> Sarvam Translate (+ a generated title)
 *
 * The Sarvam API key lives ONLY here, read from .env. It never reaches the browser.
 *
 * Network calls use Node's built-in http/https (no external HTTP dependency),
 * so the app runs on any Node 18+ with nothing but express + multer + dotenv.
 */

require('dotenv').config();

const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Configuration -------------------------------------------------------
const SARVAM_API_KEY = (process.env.SARVAM_API_KEY || '').trim();
const STT_MODEL = (process.env.SARVAM_STT_MODEL || 'saaras:v3').trim();
const TRANSLATE_MODEL = (process.env.SARVAM_TRANSLATE_MODEL || 'sarvam-translate:v1').trim();
const TITLE_MODEL = (process.env.SARVAM_TITLE_MODEL || '').trim();
// Base URL is overridable so the test harness can point at a local fake server.
const SARVAM_BASE = (process.env.SARVAM_BASE_URL || 'https://api.sarvam.ai').replace(/\/+$/, '');

const SARVAM_STT_URL = SARVAM_BASE + '/speech-to-text';
const SARVAM_TRANSLATE_URL = SARVAM_BASE + '/translate';
const SARVAM_CHAT_URL = SARVAM_BASE + '/v1/chat/completions';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_TEXT_CHARS = 1900; // sarvam-translate:v1 allows 2000; leave headroom
const REQUEST_TIMEOUT_MS = 120000;

// Languages accepted by sarvam-translate:v1 (all 22 scheduled + English),
// plus `unknown` for STT auto-detection.
const SUPPORTED_LANGUAGES = new Set([
  'hi-IN', 'bn-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'od-IN', 'pa-IN', 'ta-IN', 'te-IN',
  'as-IN', 'brx-IN', 'doi-IN', 'kok-IN', 'ks-IN', 'mai-IN', 'mni-IN', 'ne-IN', 'sa-IN',
  'sat-IN', 'sd-IN', 'ur-IN', 'en-IN',
]);

// ---- Middleware ----------------------------------------------------------
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const mt = (file.mimetype || '').toLowerCase();
    const ok =
      mt.startsWith('audio/') ||
      mt === 'application/octet-stream' ||
      mt === 'video/webm'; // some browsers label audio-only recordings as video/webm
    if (ok) return cb(null, true);
    cb(new Error('UNSUPPORTED_TYPE'));
  },
});

// ---- HTTP helper (native http/https, no undici) --------------------------
function httpRequest(urlStr, method, headers, bodyBuffer) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(new Error('Bad URL: ' + urlStr));
    }
    const mod = u.protocol === 'http:' ? http : https;
    const body = bodyBuffer || Buffer.alloc(0);
    const reqHeaders = Object.assign({}, headers);
    if (body.length) reqHeaders['Content-Length'] = Buffer.byteLength(body);

    const req = mod.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = {};
          try {
            json = JSON.parse(text);
          } catch (e) {
            json = {};
          }
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            json,
            text,
          });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('Request timed out')));
    if (body.length) req.write(body);
    req.end();
  });
}

function postJson(url, obj) {
  return httpRequest(
    url,
    'POST',
    { 'Content-Type': 'application/json', 'api-subscription-key': SARVAM_API_KEY },
    Buffer.from(JSON.stringify(obj), 'utf8')
  );
}

function buildMultipart(fields, file) {
  const boundary =
    '----Dhaaga' + Date.now().toString(16) + Math.random().toString(16).slice(2);
  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, 'utf8'));

  for (const [name, value] of Object.entries(fields)) {
    push('--' + boundary + '\r\n');
    push('Content-Disposition: form-data; name="' + name + '"\r\n\r\n');
    push(String(value) + '\r\n');
  }
  if (file) {
    push('--' + boundary + '\r\n');
    push(
      'Content-Disposition: form-data; name="' + file.field + '"; filename="' +
        file.filename + '"\r\n'
    );
    push('Content-Type: ' + file.contentType + '\r\n\r\n');
    parts.push(file.buffer);
    push('\r\n');
  }
  push('--' + boundary + '--\r\n');
  return { boundary, body: Buffer.concat(parts) };
}

// ---- Helpers -------------------------------------------------------------
function normalizeLanguage(code) {
  const c = String(code || '').trim();
  if (c === 'unknown' || c === 'auto') return c;
  if (SUPPORTED_LANGUAGES.has(c)) return c;
  return 'unknown'; // fall back to auto-detection rather than sending a bad code
}

function upstreamMessage(data) {
  if (!data) return '';
  return (
    data.message ||
    (data.error && (data.error.message || data.error.code)) ||
    data.detail ||
    ''
  );
}

function describeError(status, data, phase) {
  const detail = upstreamMessage(data);
  if (status === 401 || status === 403) {
    return 'The Sarvam API key was rejected. Check SARVAM_API_KEY in your .env file.';
  }
  if (status === 429) {
    return 'Sarvam is rate-limiting requests right now. Please wait a moment and try again.';
  }
  if (status === 422) {
    return phase === 'translation'
      ? 'That text could not be translated — it may be too long or the language pair is unsupported.'
      : 'The audio could not be processed. Try a shorter, clearer recording.';
  }
  if (status === 400) {
    return detail
      ? 'Sarvam rejected the request: ' + detail
      : 'Sarvam rejected the request. Please try again.';
  }
  if (status >= 500) {
    return "Sarvam's " + phase + ' service had a temporary problem. Please try again in a moment.';
  }
  return detail || 'The ' + phase + ' request failed. Please try again.';
}

// Map an upstream status to a status we return to the client.
function clientStatus(status) {
  if (status === 401 || status === 403) return 401;
  if (status === 429) return 429;
  if (status === 422) return 422;
  if (status === 400) return 400;
  return 502;
}

function chunkText(text, max) {
  const sentences = text.split(/(?<=[.!?।॥])\s+/);
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    if ((current + ' ' + s).trim().length > max && current) {
      chunks.push(current.trim());
      current = s;
    } else {
      current = (current + ' ' + s).trim();
    }
  }
  if (current.trim()) chunks.push(current.trim());

  const out = [];
  for (const c of chunks) {
    if (c.length <= max) out.push(c);
    else for (let i = 0; i < c.length; i += max) out.push(c.slice(i, i + max));
  }
  return out;
}

// ---- Title generation ----------------------------------------------------
const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'in', 'on', 'to', 'for', 'at', 'by', 'with',
  'my', 'our', 'as', 'but', 'or', 'nor', 'from', 'into', 'over',
]);

function cleanTitle(raw) {
  let t = String(raw || '')
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
    .replace(/[.;:,!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.split(' ').filter(Boolean).slice(0, 8).join(' ');
  return t;
}

// A reasonable, honest title derived from the story itself — no fabricated content.
function localTitle(englishText) {
  const clean = String(englishText || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'A Memory to Keep';

  const firstSentence = clean.split(/(?<=[.!?])\s+/)[0] || clean;
  let words = firstSentence.split(/\s+/).filter(Boolean);
  if (words.length > 7) words = words.slice(0, 7);

  let title = words
    .join(' ')
    .replace(/["'“”‘’]+/g, '')
    .replace(/[.,;:!?]+$/g, '')
    .trim();

  title = title
    .split(' ')
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');

  if (title.length > 70) title = title.slice(0, 67).trim() + '…';
  return title || 'A Memory to Keep';
}

// Try a Sarvam text-generation model first (only if configured); always fall
// back to the local generator so the demo never breaks on a title.
async function generateTitle(englishText) {
  if (TITLE_MODEL && SARVAM_API_KEY) {
    try {
      const r = await postJson(SARVAM_CHAT_URL, {
        model: TITLE_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You name personal family memories. Reply with ONLY a short, warm, evocative title of at most 6 words. No quotation marks, no trailing punctuation.',
          },
          {
            role: 'user',
            content: 'Give a title for this memory:\n\n' + englishText.slice(0, 2000),
          },
        ],
        temperature: 0.5,
      });
      const choice = r.json && r.json.choices && r.json.choices[0];
      const candidate = choice && choice.message && choice.message.content;
      const title = cleanTitle(candidate);
      if (r.ok && title) return title;
    } catch (e) {
      // fall through to the local title
    }
  }
  return localTitle(englishText);
}

// ---- Routes --------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    configured: Boolean(SARVAM_API_KEY),
    sttModel: STT_MODEL,
    translateModel: TRANSLATE_MODEL,
    titleModel: TITLE_MODEL || null,
  });
});

// 1) Transcribe: audio in, transcript out.
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!SARVAM_API_KEY) {
    return res.status(503).json({
      error:
        'The server has no Sarvam API key yet. Add SARVAM_API_KEY to your .env file and restart.',
    });
  }
  if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({
      error: 'No audio received. Record a memory or choose an audio file first.',
    });
  }

  const languageCode = normalizeLanguage(req.body && req.body.language_code);

  try {
    const filename = req.file.originalname || 'memory.webm';
    const mp = buildMultipart(
      { model: STT_MODEL, mode: 'transcribe', language_code: languageCode },
      {
        field: 'file',
        filename,
        contentType: req.file.mimetype || 'audio/webm',
        buffer: req.file.buffer,
      }
    );

    const r = await httpRequest(
      SARVAM_STT_URL,
      'POST',
      {
        'api-subscription-key': SARVAM_API_KEY,
        'Content-Type': 'multipart/form-data; boundary=' + mp.boundary,
      },
      mp.body
    );

    if (!r.ok) {
      return res
        .status(clientStatus(r.status))
        .json({ error: describeError(r.status, r.json, 'transcription') });
    }

    const transcript = String((r.json && r.json.transcript) || '').trim();
    if (!transcript) {
      return res.status(422).json({
        error:
          'We could not hear any speech in that recording. Try again, a little closer to the microphone.',
      });
    }

    res.json({
      transcript,
      language_code: (r.json && r.json.language_code) || languageCode,
    });
  } catch (err) {
    console.error('transcribe failed:', err && err.message);
    res.status(502).json({
      error: 'We could not reach the transcription service. Check your connection and try again.',
    });
  }
});

// 2) Translate: transcript in, English story + title out.
app.post('/api/translate', async (req, res) => {
  if (!SARVAM_API_KEY) {
    return res.status(503).json({
      error:
        'The server has no Sarvam API key yet. Add SARVAM_API_KEY to your .env file and restart.',
    });
  }

  const input = String((req.body && req.body.text) || '').trim();
  if (!input) {
    return res.status(400).json({ error: 'There is no transcript to translate yet.' });
  }

  let source = normalizeLanguage(req.body && req.body.source_language_code);
  if (source === 'unknown') source = 'auto';

  try {
    const chunks = chunkText(input, MAX_TEXT_CHARS);
    const parts = [];

    for (const chunk of chunks) {
      const body = {
        input: chunk,
        source_language_code: source,
        target_language_code: 'en-IN',
        model: TRANSLATE_MODEL,
        numerals_format: 'international',
      };
      // Only mayura:v1 accepts a `mode`; sarvam-translate:v1 is formal-only.
      if (TRANSLATE_MODEL.includes('mayura')) body.mode = 'formal';

      const r = await postJson(SARVAM_TRANSLATE_URL, body);

      if (!r.ok) {
        return res
          .status(clientStatus(r.status))
          .json({ error: describeError(r.status, r.json, 'translation') });
      }
      parts.push(String((r.json && r.json.translated_text) || '').trim());
    }

    const translated = parts.filter(Boolean).join('\n\n').trim();
    if (!translated) {
      return res.status(422).json({
        error: 'The translation came back empty. Please record the memory again.',
      });
    }

    const title = await generateTitle(translated);

    res.json({
      translated_text: translated,
      source_language_code: source,
      title,
    });
  } catch (err) {
    console.error('translate failed:', err && err.message);
    res.status(502).json({
      error: 'We could not reach the translation service. Check your connection and try again.',
    });
  }
});

// ---- Error handler (multer + unexpected) ---------------------------------
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error:
          'That audio file is too large. Please keep it under ' +
          Math.round(MAX_UPLOAD_BYTES / 1024 / 1024) +
          ' MB.',
      });
    }
    return res.status(400).json({ error: 'There was a problem with the uploaded audio.' });
  }
  if (err && err.message === 'UNSUPPORTED_TYPE') {
    return res.status(415).json({
      error: 'That file does not look like audio. Please upload a WAV, MP3, M4A, OGG or WebM file.',
    });
  }
  console.error('unexpected error:', err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

// ---- Start ---------------------------------------------------------------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log('\n  Dhaaga is listening on http://localhost:' + PORT);
    if (!SARVAM_API_KEY) {
      console.warn(
        '  !  SARVAM_API_KEY is not set — copy .env.example to .env and add your key.\n'
      );
    } else {
      console.log('  Speech-to-text: ' + STT_MODEL + '   Translate: ' + TRANSLATE_MODEL + '\n');
    }
  });
}

module.exports = app;
