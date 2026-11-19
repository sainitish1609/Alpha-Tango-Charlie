// Voices for the radio. Two engines:
//  - local (default, free): Piper, open source, runs on this PC. One 77 MB model holds 109 real
//    speakers from the VCTK corpus, each with their own accent (English, Scottish, Irish, American,
//    Canadian, South African, Indian, Australian…).
//  - elevenlabs (when ELEVENLABS_API_KEY is set): the most human-sounding, paid.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPiper, piperSpeak } from './piper.mjs';

const KEY = process.env.ELEVENLABS_API_KEY || '';
export const ENGINE = (process.env.VOICE_ENGINE || (KEY ? 'elevenlabs' : 'local')).toLowerCase();
const API = 'https://api.elevenlabs.io';
export const TTS_MODEL = ENGINE === 'local' ? 'Piper VCTK (local)' : process.env.ELEVEN_MODEL || 'eleven_v4_turbo';
const TAGS = ENGINE !== 'local' && /v3|v4/.test(TTS_MODEL) && process.env.AUDIO_TAGS !== '0';

let localOk = null, localErr = '';
export const voiceReady = () => (ENGINE === 'local' ? localOk !== false : !!KEY);
export const voiceProblem = () => localErr;

// Load the local model at startup so the first transmission isn't slow
export async function warmUp() {
  if (ENGINE !== 'local') return;
  try { await loadPiper(); await piperSpeak({ text: 'Radio check.', speaker: 0 }); localOk = true; }
  catch (e) { localOk = false; localErr = 'local voices failed to load: ' + e.message; console.error('[voices]', localErr); }
}

/* ---------- the cast ---------- */
const ACC = { NorthernIrish: 'northern irish', SouthAfrican: 'south african', NewZealand: 'new zealand' };
function localCast() {
  const dir = dirname(fileURLToPath(import.meta.url));
  const info = JSON.parse(readFileSync(join(dir, 'vctk-speakers.json'), 'utf8'));
  const cfg = JSON.parse(readFileSync(join(dir, '..', 'models', 'en_GB-vctk-medium.onnx.json'), 'utf8'));
  return Object.entries(cfg.speaker_id_map).map(([p, sid]) => {
    const [age, g, accent, region] = info[p] || ['', '', '', ''];
    const a = +age || 25;
    return { id: 'piper:' + sid, name: p, accent: (ACC[accent] || accent || '').toLowerCase(), gender: g === 'F' ? 'female' : g === 'M' ? 'male' : '', age: a < 30 ? 'young' : a < 50 ? 'middle aged' : 'old', use: 'conversational', desc: (region || '').toLowerCase(), mine: false };
  }).filter(v => v.accent && v.accent !== 'unknown');
}

let cast = null, castAt = 0;
export async function voices() {
  if (ENGINE === 'local') { if (!cast) { await loadPiper(); cast = localCast(); } return cast; }
  if (!KEY) return [];
  if (cast && Date.now() - castAt < 30 * 60e3) return cast;
  const out = [], seen = new Set();
  for (const type of ['saved', 'default']) {
    let token = null;
    for (let page = 0; page < 5; page++) {
      const u = new URL(API + '/v2/voices');
      u.searchParams.set('page_size', '100'); u.searchParams.set('voice_type', type); u.searchParams.set('include_total_count', 'false');
      if (token) u.searchParams.set('next_page_token', token);
      const r = await fetch(u, { headers: { 'xi-api-key': KEY } });
      if (!r.ok) throw new Error(`ElevenLabs voices ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      for (const v of j.voices || []) {
        if (seen.has(v.voice_id)) continue; seen.add(v.voice_id);
        const l = v.labels || {};
        out.push({ id: v.voice_id, name: v.name, accent: (l.accent || '').toLowerCase(), gender: (l.gender || '').toLowerCase(), age: (l.age || '').toLowerCase(), use: (l.use_case || l['use case'] || '').toLowerCase(), desc: (l.description || v.description || '').toLowerCase().slice(0, 120), mine: type === 'saved' });
      }
      if (!j.has_more || !j.next_page_token) break;
      token = j.next_page_token;
    }
  }
  cast = out; castAt = Date.now();
  return cast;
}

const TAG = { tired: '[tired]', stressed: '[stressed]', urgent: '[urgent]', hurried: '[rushed]', amused: '[amused]', apologetic: '[apologetic]', confused: '[confused]', friendly: '[warm]', terse: '', calm: '', neutral: '' };

// Local: returns a WAV Buffer. ElevenLabs: returns the streaming fetch Response.
export async function speak({ text, voice, delivery, stability, style, speed }) {
  if (cast && !cast.some(v => v.id === voice)) throw new Error('unknown voice');
  if (ENGINE === 'local') {
    const sid = +String(voice).replace('piper:', '');
    // radio talk is brisk; less stable, more expressive moods get more natural variation
    const variation = clamp(1 + (0.5 - (stability ?? 0.45)) * 2.2 + (style ?? 0.2) * 0.6, 0.7, 1.8);
    return piperSpeak({ text, speaker: sid, speed: clamp(speed ?? 1.05, 0.8, 1.3) * 1.28, variation });
  }
  const tag = TAGS && TAG[delivery] ? TAG[delivery] + ' ' : '';
  const r = await fetch(`${API}/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text: tag + text,
      model_id: TTS_MODEL,
      voice_settings: { stability: clamp(stability ?? 0.45, 0, 1), similarity_boost: 0.8, style: clamp(style ?? 0.2, 0, 1), use_speaker_boost: true, speed: clamp(speed ?? 1.05, 0.7, 1.2) },
    }),
  });
  if (!r.ok) throw new Error(`ElevenLabs TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, +v || 0));
