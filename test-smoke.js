/* In-process smoke + payload test.
   Boots a FAKE Sarvam server, points the app at it, and verifies:
   - routing, validation and error handling
   - the exact multipart fields sent to /speech-to-text
   - the exact JSON body sent to /translate
   Run: node test-smoke.js   (no real API key or network needed) */

process.env.SARVAM_API_KEY = 'test-key-123';
process.env.SARVAM_BASE_URL = 'http://127.0.0.1:4999';

const http = require('http');
const app = require('./server.js');

const FAKE_PORT = 4999;
const APP_PORT = 3998;

let failures = 0;
let lastStt = null; // captured request to the fake Sarvam server
let lastTranslate = null;

function check(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  -> ' + extra : ''));
  if (!cond) failures++;
}

// ---- fake Sarvam server --------------------------------------------------
function startFakeSarvam() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url;
      // Any endpoint rejects a bad key, like the real API.
      if (req.headers['api-subscription-key'] !== 'test-key-123') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'bad key' } }));
      }
      if (url === '/speech-to-text') {
        lastStt = { headers: req.headers, body: body.toString('utf8') };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ transcript: 'मेरी दादी कहती थीं…', language_code: 'hi-IN' }));
      }
      if (url === '/translate') {
        lastTranslate = { headers: req.headers, body: body.toString('utf8') };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ translated_text: 'My grandmother used to say…', source_language_code: 'hi-IN' }));
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  return server;
}

// ---- tiny http client (global fetch is unavailable in this sandbox) ------
function client(pathname, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const body = opts.body || null;
    const headers = Object.assign({}, opts.headers);
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(
      { host: '127.0.0.1', port: APP_PORT, path: pathname, method: opts.method || 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = {};
          try { json = JSON.parse(text); } catch (e) {}
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function multipart(fields, file) {
  const boundary = '----testboundary1234567890';
  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, 'utf8'));
  for (const [k, v] of Object.entries(fields)) {
    push('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + v + '\r\n');
  }
  if (file) {
    push('--' + boundary + '\r\nContent-Disposition: form-data; name="' + file.field + '"; filename="' + file.name + '"\r\nContent-Type: ' + file.type + '\r\n\r\n');
    parts.push(file.buffer);
    push('\r\n');
  }
  push('--' + boundary + '--\r\n');
  return { boundary, body: Buffer.concat(parts) };
}

(async () => {
  const fake = startFakeSarvam();
  await new Promise((r) => fake.listen(FAKE_PORT, r));
  const server = app.listen(APP_PORT);
  await new Promise((r) => server.once('listening', r));

  try {
    // 1. health
    let r = await client('/api/health');
    check('GET /api/health -> ok & configured', r.status === 200 && r.json.ok === true && r.json.configured === true, JSON.stringify(r.json));

    // 2. landing page served
    r = await client('/');
    check('GET / serves landing page', r.status === 200 && r.text.includes('Dhaaga'), 'status ' + r.status);

    // 3. translate with empty body -> 400
    r = await client('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('translate without text -> 400', r.status === 400 && !!r.json.error, r.status + ' ' + r.json.error);

    // 4. transcribe with no file -> 400
    const empty = multipart({ language_code: 'hi-IN' }, null);
    r = await client('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + empty.boundary }, body: empty.body });
    check('transcribe without audio -> 400', r.status === 400 && !!r.json.error, r.status + ' ' + r.json.error);

    // 5. transcribe with a non-audio file -> 415
    const bad = multipart({ language_code: 'hi-IN' }, { field: 'audio', name: 'notes.txt', type: 'text/plain', buffer: Buffer.from('hello') });
    r = await client('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + bad.boundary }, body: bad.body });
    check('transcribe with non-audio -> 415', r.status === 415 && !!r.json.error, r.status + ' ' + r.json.error);

    // 6. transcribe with audio -> 200, and verify the multipart payload sent upstream
    lastStt = null;
    const ok = multipart(
      { language_code: 'hi-IN' },
      { field: 'audio', name: 'memory.webm', type: 'audio/webm', buffer: Buffer.alloc(128, 1) }
    );
    r = await client('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + ok.boundary }, body: ok.body });
    check('transcribe with audio -> 200 + transcript', r.status === 200 && r.json.transcript === 'मेरी दादी कहती थीं…', JSON.stringify(r.json));
    check('upstream got multipart model=saaras:v3', lastStt && lastStt.body.includes('name="model"') && lastStt.body.includes('saaras:v3'));
    check('upstream got mode=transcribe', lastStt && lastStt.body.includes('name="mode"') && lastStt.body.includes('transcribe'));
    check('upstream got language_code=hi-IN', lastStt && lastStt.body.includes('name="language_code"') && lastStt.body.includes('hi-IN'));
    check('upstream got audio file part with audio mime', lastStt && lastStt.body.includes('filename="memory.webm"') && lastStt.body.includes('Content-Type: audio/webm'));
    check('upstream got api-subscription-key header', lastStt && lastStt.headers['api-subscription-key'] === 'test-key-123');

    // 7. unsupported language code is normalised to "unknown"
    lastStt = null;
    const weird = multipart({ language_code: 'xx-XX' }, { field: 'audio', name: 'a.webm', type: 'audio/webm', buffer: Buffer.alloc(64, 2) });
    r = await client('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + weird.boundary }, body: weird.body });
    check('unknown language normalised to "unknown"', r.status === 200 && lastStt.body.includes('unknown'), r.status + '');

    // 8. translate -> 200 + title, verify the JSON body sent upstream
    lastTranslate = null;
    r = await client('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'मेरी दादी कहती थीं…', source_language_code: 'hi-IN' }),
    });
    check('translate -> 200 + translated_text', r.status === 200 && r.json.translated_text === 'My grandmother used to say…', JSON.stringify(r.json));
    check('translate returns a non-empty title', typeof r.json.title === 'string' && r.json.title.length > 0, r.json.title);
    let tbody = {};
    try { tbody = JSON.parse(lastTranslate.body); } catch (e) {}
    check('upstream translate input correct', tbody.input === 'मेरी दादी कहती थीं…');
    check('upstream translate source_language_code=hi-IN', tbody.source_language_code === 'hi-IN');
    check('upstream translate target_language_code=en-IN', tbody.target_language_code === 'en-IN');
    check('upstream translate model=sarvam-translate:v1', tbody.model === 'sarvam-translate:v1');
    check('upstream translate has NO invalid "mode" field', tbody.mode === undefined);

    // 9. upstream 403 -> client 401 with a friendly message
    process.env.SARVAM_API_KEY = 'wrong';
    // re-require a fresh module instance so the new key is read
    delete require.cache[require.resolve('./server.js')];
    const app2 = require('./server.js');
    const server2 = app2.listen(APP_PORT + 1);
    await new Promise((r2) => server2.once('listening', r2));
    const r2 = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: APP_PORT + 1, path: '/api/translate', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(ch).toString()) }));
      });
      req.on('error', reject);
      req.write(JSON.stringify({ text: 'hi', source_language_code: 'hi-IN' }));
      req.end();
    });
    check('upstream 403 -> client 401 with friendly message', r2.status === 401 && /API key was rejected/.test(r2.json.error), r2.status + ' ' + r2.json.error);
    server2.close();
  } catch (e) {
    check('test harness ran without throwing', false, e.message);
  } finally {
    server.close();
    fake.close();
    console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
    process.exit(failures === 0 ? 0 : 1);
  }
})();
