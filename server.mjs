// VECTOR local server
// - serves the game from ./public on http://localhost (a secure context, so the microphone works)
// - keeps your API keys here, never in the web page
// - /api/brain  -> Claude writes pilot speech     (ANTHROPIC_API_KEY)
// - /api/tts    -> ElevenLabs speaks it           (ELEVENLABS_API_KEY)
// Run with --mock to test everything without keys or cost.
import { createServer } from 'node:http';
import * as os_ from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const ROOT = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));
const MOCK = process.argv.includes('--mock') || process.env.VECTOR_MOCK === '1';
// The server (and the voice engine inside it) runs below the browser, so your microphone always comes first
try { const os = await import('node:os'); os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { }
const PORT = +process.env.PORT || 8787;

const { think, mockThink, brainReady, brainModel, brainBackend, brainProblem, stopBrain } = await import('./lib/brain.mjs');
const { voices, speak, voiceReady, voiceProblem, warmUp, TTS_MODEL, ENGINE } = await import('./lib/voices.mjs');

const PUB = join(ROOT, 'public');
const AUTH = (await import('./lib/auth.mjs')).makeAuth(ROOT); // VECTOR_PASSWORD in .env turns on the sign-in page
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

// Budget guard: a runaway loop in the page can never run up a bill.
const LIMIT = { brain: +process.env.BRAIN_PER_MIN || 40, tts: +process.env.TTS_PER_MIN || (ENGINE === 'local' ? 120 : 40), asr: +process.env.ASR_PER_MIN || 240 };
const hits = { brain: [], tts: [], asr: [] };
const { asrReady, asrCheck, asrModel, transcribe } = await import('./lib/asr.mjs');
function allow(kind) { const now = Date.now(), h = hits[kind]; while (h.length && now - h[0] > 60e3) h.shift(); if (h.length >= LIMIT[kind]) return false; h.push(now); return true; }

const usage = { calls: 0, in: 0, out: 0, chars: 0, rejected: 0 };

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
async function body(req) { let s = ''; for await (const c of req) { s += c; if (s.length > 64e3) throw new Error('too large'); } return JSON.parse(s || '{}'); }

// Mock speech: a short burst of voice-like tones so the radio chain can be tested with no key.
function mockWav(text) {
  const sr = 22050, dur = Math.min(4, 0.6 + text.length / 28), n = Math.floor(sr * dur), buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const t = i / sr, f = 140 + 40 * Math.sin(t * 3), env = Math.abs(Math.sin(t * Math.PI * 4.2)); buf.writeInt16LE(Math.round(9000 * env * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t))), 44 + i * 2); }
  return buf;
}
const MOCK_CAST = [
  ['mock-us-m', 'Brian', 'american', 'male', 'middle aged'], ['mock-us-f', 'Sarah', 'american', 'female', 'young'], ['mock-gb-m', 'George', 'british', 'male', 'middle aged'],
  ['mock-au-m', 'Charlie', 'australian', 'male', 'young'], ['mock-gb-f', 'Alice', 'british', 'female', 'middle aged'], ['mock-us-m2', 'Bill', 'american', 'male', 'old'],
].map(([id, name, accent, gender, age]) => ({ id, name, accent, gender, age, use: '', desc: '', mine: false }));

const wxCache = new Map();
async function metarOf(icao) {
  const hit = wxCache.get(icao);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.data;
  try {
    const r = await fetch(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=json&hours=2`, { headers: { 'User-Agent': 'VECTOR-ATC/1.0 (weather for a voice ATC game)' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const list = await r.json(), m = Array.isArray(list) && list[0];
    if (!m || !m.rawOb) throw new Error('no report for ' + icao);
    const data = { icao, raw: m.rawOb, time: m.obsTime ? m.obsTime * 1000 : Date.parse(m.reportTime || '') || Date.now(), name: m.name || '', lat: m.lat, lon: m.lon };
    wxCache.set(icao, { at: Date.now(), data });
    return data;
  } catch (e) { if (hit) return { ...hit.data, stale: true }; throw e; }
}

// Real traffic: ADS-B positions around the airport from the OpenSky Network, shared by every player and kept for
// a minute (anonymous use allows about 400 requests a day; OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET in .env
// raise that to 4000). Only aircraft states come back: callsign, position, altitude, speed, track, climb rate.
const adsbCache = new Map(); let oskTok = null, oskBackoff = 0;
async function openskyToken() {
  const id = process.env.OPENSKY_CLIENT_ID, sec = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !sec) return null;
  if (oskTok && Date.now() < oskTok.exp) return oskTok.t;
  const r = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: sec }), signal: AbortSignal.timeout(10000) });
  if (!r.ok) return null;
  const j = await r.json(); oskTok = { t: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 }; return oskTok.t;
}
async function adsbOf(icao) {
  const hit = adsbCache.get(icao);
  if (hit && (Date.now() - hit.at < 60e3 || Date.now() < oskBackoff)) return hit.data;
  if (Date.now() < oskBackoff) throw new Error('rate limited, try again later');
  const f = join(ROOT, 'public', 'airports', icao + '.json');
  if (!existsSync(f)) throw new Error('unknown airport');
  const { lat, lon } = JSON.parse(await readFile(f, 'utf8')).origin;
  const dLat = 1.1, dLon = 1.1 / Math.cos(lat * Math.PI / 180); // about 65 NM each way
  const u = `https://opensky-network.org/api/states/all?lamin=${(lat - dLat).toFixed(3)}&lomin=${(lon - dLon).toFixed(3)}&lamax=${(lat + dLat).toFixed(3)}&lomax=${(lon + dLon).toFixed(3)}`;
  try {
    const tok = await openskyToken().catch(() => null);
    const r = await fetch(u, { headers: { 'User-Agent': 'VECTOR-ATC/1.0 (real traffic for a voice ATC game)', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, signal: AbortSignal.timeout(15000) });
    if (r.status === 429) { oskBackoff = Date.now() + 10 * 60e3; throw new Error('rate limited'); }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    // [callsign, lat, lon, altitude ft, ground speed kt, track, vertical rate fpm, on ground, squawk]
    const ac = (j.states || []).filter(s => s[5] != null && s[6] != null && (s[1] || '').trim()).map(s => [s[1].trim(), +s[6].toFixed(4), +s[5].toFixed(4), Math.round((s[7] ?? s[13] ?? 0) * 3.28084), Math.round((s[9] || 0) * 1.94384), Math.round(s[10] || 0), Math.round((s[11] || 0) * 196.85), !!s[8], s[14] || null]);
    const data = { icao, time: (j.time || Date.now() / 1000) * 1000, origin: { lat, lon }, ac };
    adsbCache.set(icao, { at: Date.now(), data });
    return data;
  } catch (e) { if (hit) return { ...hit.data, stale: true }; throw e; }
}

// The leaderboard: each player's best score per mission or checkride, kept in data/leaderboard.json
const BOARD = join(ROOT, 'data', 'leaderboard.json'); let board = null;
async function boardLoad() { if (board) return board; try { board = JSON.parse(await readFile(BOARD, 'utf8')); } catch { board = {}; } return board; }
async function boardPost(req) {
  let body = ''; for await (const c of req) { body += c; if (body.length > 2000) break; }
  const d = JSON.parse(body || '{}'), id = String(d.id || ''), name = String(d.name || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 24);
  const score = Math.round(+d.score), stars = Math.round(+d.stars || 0);
  if (!/^[A-Za-z0-9_]{2,40}$/.test(id) || !name || !(score >= 0 && score < 1e7) || !(stars >= 0 && stars <= 3)) throw new Error('bad entry');
  const b = await boardLoad(), list = (b[id] = b[id] || []), mine = list.find(e => e.name === name);
  if (mine) { if (score > mine.score) Object.assign(mine, { score, stars, t: Date.now() }); } else list.push({ name, score, stars, t: Date.now() });
  list.sort((a, c) => c.score - a.score); b[id] = list.slice(0, 50);
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dirname(BOARD), { recursive: true }); await writeFile(BOARD, JSON.stringify(b));
}

/* Multiplayer: one player hosts and runs the shift; others join with a four-letter code and work positions.
   The server only relays: the host's state to everyone (a live event stream), everyone's transmissions to the host. */
const ROOMS = new Map();
const roomCode = () => { let c; do c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join(''); while (ROOMS.has(c)); return c; };
const mpSend = (sub, ev, data) => { try { sub.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch { } };
setInterval(() => { const now = Date.now(); for (const [k, r] of ROOMS) { if (now - r.seen > 3600e3) { for (const s of r.subs.values()) try { s.end(); } catch { } ROOMS.delete(k); } else for (const s of r.subs.values()) try { s.write(': ping\n\n'); } catch { } } }, 15000).unref();
async function mp(req, res, path) {
  const u = new URL(req.url, 'http://x');
  if (path === '/api/mp/stream') { // the live feed for one player
    const r = ROOMS.get(u.searchParams.get('room') || ''), id = (u.searchParams.get('id') || '').slice(0, 40);
    if (!r || !id) return json(res, 404, { error: 'no such shift' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.write(': hello\n\n'); r.subs.set(id, res); r.seen = Date.now();
    mpSend(res, 'room', { code: r.code, host: r.host, claims: r.claims, setup: r.setup });
    req.on('close', () => { if (r.subs.get(id) === res) r.subs.delete(id); for (const p in r.claims) if (r.claims[p].id === id && id !== r.host) delete r.claims[p]; for (const s of r.subs.values()) mpSend(s, 'room', { code: r.code, host: r.host, claims: r.claims, setup: r.setup }); });
    return;
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  let body = ''; for await (const c of req) { body += c; if (body.length > 400000) return json(res, 413, { error: 'too big' }); }
  let d; try { d = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
  const id = String(d.id || '').slice(0, 40), name = String(d.name || 'Controller').replace(/[<>]/g, '').slice(0, 24);
  if (path === '/api/mp/create') {
    if (ROOMS.size > 50) return json(res, 503, { error: 'too many shifts running' });
    const code = roomCode(), claims = {};
    for (const p of (d.pos || [])) if (['DEL', 'GND', 'TWR', 'APP'].includes(p)) claims[p] = { id, name };
    ROOMS.set(code, { code, host: id, claims, setup: d.setup || {}, subs: new Map(), seen: Date.now() });
    return json(res, 200, { code });
  }
  const r = ROOMS.get(String(d.room || '').toUpperCase()); if (!r) return json(res, 404, { error: 'no such shift' });
  r.seen = Date.now();
  const roomMsg = () => { for (const s of r.subs.values()) mpSend(s, 'room', { code: r.code, host: r.host, claims: r.claims, setup: r.setup }); };
  if (path === '/api/mp/claim') { // take or release a position
    const p = String(d.pos || ''); if (!['DEL', 'GND', 'TWR', 'APP'].includes(p)) return json(res, 400, { error: 'bad position' });
    if (d.release) { if (r.claims[p] && r.claims[p].id === id) delete r.claims[p]; }
    else if (r.claims[p] && r.claims[p].id !== id) return json(res, 409, { error: `${r.claims[p].name} has ${p}` });
    else r.claims[p] = { id, name };
    roomMsg(); return json(res, 200, { claims: r.claims });
  }
  if (path === '/api/mp/state') { if (id !== r.host) return json(res, 403, { error: 'host only' }); for (const [sid, s] of r.subs) if (sid !== id) mpSend(s, 'state', d.state); return json(res, 200, { ok: true }); }
  if (path === '/api/mp/tx') { const h = r.subs.get(r.host); if (h) mpSend(h, 'tx', { id, name, text: String(d.text || '').slice(0, 400) }); return json(res, 200, { ok: !!h }); }
  return json(res, 404, { error: 'unknown' });
}

async function api(req, res, path) {
  if (path.startsWith('/api/mp/')) return mp(req, res, path);
  if (path === '/api/board') {
    try { if (req.method === 'POST') await boardPost(req); return json(res, 200, await boardLoad()); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (path.startsWith('/api/adsb/')) {
    const icao = path.slice(10).toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(icao)) return json(res, 400, { error: 'bad airport code' });
    try { return json(res, 200, await adsbOf(icao)); }
    catch (e) { return json(res, 502, { error: 'live traffic unavailable: ' + e.message }); }
  }
  if (path === '/api/health') {
    if (!MOCK) await asrCheck();
    return json(res, 200, { asr: !MOCK && asrReady(), asrModel: asrModel(), brain: MOCK || brainReady(), backend: MOCK ? 'mock' : brainBackend(), problem: MOCK ? '' : brainProblem(), voice: MOCK || voiceReady(), voiceEngine: MOCK ? 'mock' : ENGINE, voiceProblem: MOCK ? '' : voiceProblem(), mock: MOCK, model: brainModel, ttsModel: TTS_MODEL, usage });
  }
  // the airport's real weather: its latest METAR from aviationweather.gov, kept for 5 minutes
  if (path.startsWith('/api/wx/')) {
    const icao = path.slice(8).toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(icao)) return json(res, 400, { error: 'bad airport code' });
    try { return json(res, 200, await metarOf(icao)); }
    catch (e) { return json(res, 502, { error: 'weather unavailable: ' + e.message }); }
  }
  if (path === '/api/voices') {
    if (MOCK) return json(res, 200, { voices: MOCK_CAST });
    try { return json(res, 200, { voices: await voices() }); }
    catch (e) { console.error(e.message); return json(res, 502, { error: e.message, voices: [] }); }
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  // the controller's recorded call (16 kHz WAV) -> text, by Whisper on the GPU
  if (path === '/api/asr') {
    if (!allow('asr')) return json(res, 429, { error: 'speech budget per minute reached' });
    const parts = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > 3e6) return json(res, 413, { error: 'call too long' }); parts.push(c); }
    let prompt = ''; try { prompt = decodeURIComponent(req.headers['x-asr-prompt'] || ''); } catch { }
    try { return json(res, 200, await transcribe(Buffer.concat(parts), prompt)); }
    catch (e) { return json(res, 503, { error: e.message }); }
  }
  let b; try { b = await body(req); } catch (e) { return json(res, 400, { error: 'bad body' }); }

  if (path === '/api/brain') {
    if (!MOCK && !brainReady()) return json(res, 503, { error: brainProblem() || 'no Claude connection' });
    if (!allow('brain')) return json(res, 429, { error: 'brain budget per minute reached' });
    try {
      if (MOCK) { await new Promise(r => setTimeout(r, 250 + Math.random() * 400)); return json(res, 200, mockThink(b.task, b)); }
      const out = await think(b.task, b);
      usage.calls++; usage.in += out.usage?.input_tokens || 0; usage.out += out.usage?.output_tokens || 0; if (out.rejected) usage.rejected++;
      if (out.rejected) console.log(`[brain] ${b.task} rejected (${out.rejected}) -> game's own words`);
      delete out.usage;
      return json(res, 200, out);
    } catch (e) {
      console.error('[brain]', e.status || '', e.message);
      return json(res, 502, { error: e.message });
    }
  }
  if (path === '/api/tts') {
    if (!MOCK && !voiceReady()) return json(res, 503, { error: 'ELEVENLABS_API_KEY is not set' });
    if (!allow('tts')) return json(res, 429, { error: 'voice budget per minute reached' });
    const text = String(b.text || '').slice(0, 600);
    if (!text) return json(res, 400, { error: 'no text' });
    try {
      if (MOCK) { await new Promise(r => setTimeout(r, 200)); res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end(mockWav(text)); }
      if (!b.voice) return json(res, 400, { error: 'no voice' });
      await voices();
      const r = await speak({ ...b, text });
      usage.chars += text.length;
      if (Buffer.isBuffer(r)) { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }); return res.end(r); }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
      Readable.fromWeb(r.body).pipe(res);
    } catch (e) {
      console.error('[tts]', e.message);
      if (!res.headersSent) json(res, 502, { error: e.message });
    }
    return;
  }
  json(res, 404, { error: 'not found' });
}

// OpenStreetMap tiles for the real-map view. Each tile is fetched from OSM once, then kept on disk,
// and no more than two downloads run at a time, as the OSM tile usage policy asks.
const TILES = join(ROOT, 'cache', 'tiles');
const tileQ = []; let tileBusy = 0;
function tileFetch(url) {
  return new Promise((resolve, reject) => {
    tileQ.push({ url, resolve, reject });
    const next = () => {
      while (tileBusy < 2 && tileQ.length) {
        const j = tileQ.shift(); tileBusy++;
        fetch(j.url, { headers: { 'User-Agent': 'VECTOR-ATC/1.0 (local voice ATC game, tiles cached on disk)' }, signal: AbortSignal.timeout(15000) })
          .then(async r => { if (!r.ok) throw new Error('tile ' + r.status); return Buffer.from(await r.arrayBuffer()); })
          .then(j.resolve, j.reject).finally(() => { tileBusy--; next(); });
      }
    };
    next();
  });
}
const tileWait = new Map();
async function tile(res, z, x, y) {
  if (z < 0 || z > 19 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) { res.writeHead(404); return res.end(); }
  const file = join(TILES, String(z), String(x), y + '.png');
  try { const b = await readFile(file); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=604800' }); return res.end(b); } catch { }
  const key = `${z}/${x}/${y}`;
  try {
    if (!tileWait.has(key)) tileWait.set(key, tileFetch(`https://tile.openstreetmap.org/${key}.png`).finally(() => setTimeout(() => tileWait.delete(key), 1000)));
    const b = await tileWait.get(key);
    const { mkdir, writeFile } = await import('node:fs/promises');
    mkdir(dirname(file), { recursive: true }).then(() => writeFile(file, b)).catch(() => { });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=604800' }); res.end(b);
  } catch (e) { res.writeHead(502); res.end(); }
}

// The Windows app: a page at /download (behind the same password as the game) and the installer itself.
// Put installers in ./downloads; the newest VECTOR-ATC-Setup-*.exe is offered.
const DL = join(ROOT, 'downloads');
async function download(req, res, path) {
  const { readdir } = await import('node:fs/promises');
  const files = existsSync(DL) ? (await readdir(DL)).filter(f => /^VECTOR-ATC-Setup-[\d.]+\.exe$/.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) : [];
  const latest = files[files.length - 1];
  // the app's update feed: latest.yml (written by electron-builder), the installer and its blockmap
  if (path.startsWith('/download/update/')) {
    const name = decodeURIComponent(path.slice(17));
    if (!(name === 'latest.yml' || /^VECTOR-ATC-Setup-[\d.]+\.exe(\.blockmap)?$/.test(name)) || !existsSync(join(DL, name))) { res.writeHead(404); return res.end('Not found'); }
    const file = join(DL, name), st = await stat(file);
    res.writeHead(200, { 'Content-Type': name.endsWith('.yml') ? 'text/yaml; charset=utf-8' : 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'Accept-Ranges': 'none' });
    const { createReadStream } = await import('node:fs');
    return createReadStream(file).pipe(res);
  }
  if (path.startsWith('/download/')) {
    const name = decodeURIComponent(path.slice(10));
    if (!files.includes(name)) { res.writeHead(404); return res.end('Not found'); }
    const file = join(DL, name), st = await stat(file);
    res.writeHead(200, { 'Content-Type': 'application/vnd.microsoft.portable-executable', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    const { createReadStream } = await import('node:fs');
    return createReadStream(file).pipe(res);
  }
  const size = latest ? ((await stat(join(DL, latest))).size / 1048576).toFixed(0) + ' MB' : '';
  const ver = latest ? latest.match(/Setup-([\d.]+)\.exe/)[1] : '';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>VECTOR ATC — Download</title>
<style>:root{--ink:#0A0E13;--card:#10151C;--rule:#2D3846;--text:#E7EBF0;--text2:#B4BDC9;--dim:#8A95A3;--acc:#2F7CF6}*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--ink);color:var(--text);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}body{display:grid;place-items:center;padding:16px;min-height:100vh}
main{width:min(560px,100%);background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:30px;display:flex;flex-direction:column;gap:16px}
.wm{font-weight:700;font-size:12px;letter-spacing:.22em;color:#5AA2FF}h1{margin:0;font-size:28px}p,li{color:var(--text2);line-height:1.55;font-size:15px;margin:0}ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px}
a.btn{display:inline-flex;align-items:center;justify-content:center;height:48px;padding:0 24px;border-radius:8px;background:var(--acc);color:#fff;font-weight:700;text-decoration:none;align-self:flex-start}a.btn:hover{background:#4A8FF8}
.sm{font-size:13px;color:var(--dim)}a{color:#5AA2FF}</style></head><body><main>
<div class="wm">VECTOR ATC</div><h1>Download for Windows</h1>
<p>The game in its own window, connected to this server. Same game as the web version; your voice is recognised by the server's speech model.</p>
${latest ? `<a class="btn" href="/download/${encodeURIComponent(latest)}">Download VECTOR ATC ${ver} (${size})</a>` : '<p>The Windows app is not available yet.</p>'}
<ol><li>Run the downloaded file. It installs for your Windows user only, no administrator needed, and adds a VECTOR ATC shortcut to the desktop.</li>
<li>Windows may show “Windows protected your PC”, because the app isn't signed by a paid publisher certificate yet: choose <b>More info</b> → <b>Run anyway</b>.</li>
<li>Sign in with the same password as here, and allow the microphone when asked.</li></ol>
<p class="sm">Windows 10 or 11, 64-bit. Needs an internet connection to the game server. <a href="/">Play in the browser instead</a>.</p>
</main></body></html>`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (AUTH.on && await AUTH.gate(req, res, url.pathname)) return;
  if (url.pathname === '/download' || url.pathname.startsWith('/download/')) return download(req, res, url.pathname);
  if (url.pathname.startsWith('/api/')) return api(req, res, url.pathname);
  const tm = url.pathname.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (tm) return tile(res, +tm[1], +tm[2], +tm[3]);
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (!p || p.endsWith('/') || p.endsWith('\\')) p = join(p, 'index.html');
  const file = join(PUB, p);
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  try {
    if (!(await stat(file)).isFile()) throw 0;
    res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('Not found'); }
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopBrain(); process.exit(0); });

// Across the home network: HTTPS, because browsers only allow the microphone on https or localhost.
// Runs when certs/server.crt exists (tools/make-certs.sh). /ca.crt hands out the home certificate
// authority, so a device can trust the game once and never see a warning.
const CERTS = join(ROOT, 'certs'), HTTPS_PORT = +process.env.HTTPS_PORT || 8443;
if (existsSync(join(CERTS, 'server.crt')) && existsSync(join(CERTS, 'server.key')) && process.env.HTTPS !== '0') {
  const { createServer: createHttps } = await import('node:https');
  const opts = { key: await readFile(join(CERTS, 'server.key')), cert: await readFile(join(CERTS, 'server.crt')) };
  const secure = createHttps(opts, async (req, res) => {
    if (req.url === '/ca.crt' && existsSync(join(CERTS, 'ca.crt'))) {
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="VECTOR-home-CA.crt"' });
      return res.end(await readFile(join(CERTS, 'ca.crt')));
    }
    server.emit('request', req, res);
  });
  secure.on('error', e => console.error('  HTTPS could not start:', e.message));
  secure.listen(HTTPS_PORT, process.env.HTTPS_HOST || '0.0.0.0', () => {
    const { networkInterfaces } = os_;
    const ips = Object.values(networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a.address)).map(a => a.address);
    console.log(`  On your network:    ${ips.map(ip => `https://${ip}:${HTTPS_PORT}`).join('   ') || `https://<this machine>:${HTTPS_PORT}`}`);
  });
}

server.listen(PORT, '127.0.0.1', () => {
  if (!MOCK) warmUp().then(() => console.log(voiceReady() ? '  Radio voices loaded.' : '  ' + voiceProblem()));
  const on = (ok, what) => (ok ? 'on ' : 'OFF') + '  ' + what;
  console.log(`\n  VECTOR is running:  http://localhost:${PORT}${AUTH.on ? '   (password protected)' : ''}\n`);
  if (MOCK) console.log('  MOCK MODE: stand-in pilots and test tones, no API calls, no cost.\n');
  else {
    const how = brainBackend() === 'api' ? 'API key' : brainBackend() === 'cli' ? 'Claude Code, your login' : '';
    console.log('  ' + on(brainBackend() !== 'none' && !brainProblem(), `AI pilots (Claude ${brainModel}${how ? ', ' + how : ''})${brainProblem() ? ': ' + brainProblem() : brainBackend() === 'none' ? ': install Claude Code or add ANTHROPIC_API_KEY to .env' : ''}`));
    console.log('  ' + on(voiceReady(), ENGINE === 'local' ? 'Radio voices: free local Piper voices, 109 speakers' : `Radio voices: ElevenLabs ${TTS_MODEL}`));
    console.log('\n  Keep this window open while you play. Close it to stop the game.\n');
  }
});
