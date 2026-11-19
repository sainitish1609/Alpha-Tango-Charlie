// Free, local, open-source voices: Piper (https://github.com/rhasspy/piper) run in-process with
// onnxruntime. One model file holds many real speakers; espeak-ng (WebAssembly) turns text into
// phonemes. Fast enough for live radio on a small CPU, and nothing leaves the PC.
import { readFileSync, existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'models');
const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
export const PIPER_MODELS = {
  'en_GB-vctk-medium': 'en/en_GB/vctk/medium/',
};

let ort, phonemize;
const loaded = {};

async function download(name) {
  mkdirSync(DIR, { recursive: true });
  for (const f of [name + '.onnx.json', name + '.onnx']) {
    const dest = join(DIR, f);
    if (existsSync(dest)) continue;
    console.log(`[voices] downloading ${f} (once)…`);
    const r = await fetch(HF + PIPER_MODELS[name] + f);
    if (!r.ok) throw new Error(`download ${f}: ${r.status}`);
    const tmp = dest + '.part';
    await finished(Readable.fromWeb(r.body).pipe(createWriteStream(tmp)));
    (await import('node:fs')).renameSync(tmp, dest);
  }
}

export async function loadPiper(name = 'en_GB-vctk-medium') {
  if (loaded[name]) return loaded[name];
  return (loaded[name] = (async () => {
    ort = ort || (await import('onnxruntime-node')).default;
    phonemize = phonemize || (await import('phonemizer')).phonemize;
    await download(name);
    const cfg = JSON.parse(readFileSync(join(DIR, name + '.onnx.json'), 'utf8'));
    const session = await ort.InferenceSession.create(join(DIR, name + '.onnx'), { intraOpNumThreads: Math.max(1, Math.floor((await import('node:os')).cpus().length / 2)) /* leave cores for the browser's speech recognition */, graphOptimizationLevel: 'all' });
    return { cfg, session };
  })().catch(e => { delete loaded[name]; throw e; }));
}

// Piper's input: phoneme ids with a pad after each, between a start and an end marker
function ids(cfg, phonemes) {
  const map = cfg.phoneme_id_map, pad = map['_'][0], out = [map['^'][0], pad];
  for (const ch of phonemes) { const id = map[ch]; if (id) { out.push(id[0], pad); } }
  out.push(map['$'][0]);
  return out;
}

let chain = Promise.resolve(); // one sentence at a time: a small CPU can't do two at once any faster
export function piperSpeak(opts) {
  const job = chain.then(() => synth(opts));
  chain = job.catch(() => { });
  return job;
}
async function synth({ text, speaker = 0, speed = 1, model = 'en_GB-vctk-medium', variation = 1 }) {
  const { cfg, session } = await loadPiper(model);
  const ph = (await phonemize(text, cfg.espeak.voice)).join(' ');
  const input = ids(cfg, ph);
  const inf = cfg.inference || {};
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(input.map(BigInt)), [1, input.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(input.length)]), [1]),
    // noise and timing randomness are what make it sound spoken rather than read
    scales: new ort.Tensor('float32', Float32Array.from([(inf.noise_scale ?? 0.667) * variation, (inf.length_scale ?? 1) / speed, (inf.noise_w ?? 0.8) * variation]), [3]),
  };
  if (cfg.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(speaker)]), [1]);
  const out = await session.run(feeds);
  return wav(out.output.data, cfg.audio.sample_rate);
}

function wav(f32, sr) {
  const n = f32.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(f32[i]));
  const g = peak > 0 ? 0.9 / peak : 1;
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(f32[i] * g * 32767))), 44 + i * 2);
  return buf;
}
