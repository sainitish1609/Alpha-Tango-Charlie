// Speech recognition on the game server: Whisper (whisper.cpp's server, on the GPU) turns the controller's
// recorded call into text. The game sends a short hint with the words it expects (the callsigns on
// frequency, the airport's taxiways, runways and fixes), which Whisper uses to spell them right.
const ASR_URL = (process.env.ASR_URL || 'http://127.0.0.1:8178').replace(/\/$/, '');
let ok = false, checked = 0;

async function probe() {
  checked = Date.now();
  try { const r = await fetch(ASR_URL + '/', { signal: AbortSignal.timeout(1500) }); ok = r.status < 500; } catch { ok = false; }
  return ok;
}
probe();
setInterval(probe, 30e3).unref();

export const asrReady = () => ok;
// a fresh look when the last answer was no (Whisper may have started after the game server)
export async function asrCheck() { if (!ok && Date.now() - checked > 2000) await probe(); return ok; }
export const asrModel = () => process.env.ASR_MODEL_NAME || 'Whisper large-v3-turbo (GPU)';

// Words Whisper makes up on silence or noise; a call that is only this is nothing
const GHOSTS = /^(?:thank you\.?|thanks for watching[.!]?|you\.?|bye\.?|\.+|\[blank_audio\]|\(.*\)|\[.*\])$/i;

export async function transcribe(wav, prompt) {
  if (!ok && Date.now() - checked > 3000) await probe();
  if (!ok) throw new Error('speech recognition is not running');
  const fd = new FormData();
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'call.wav');
  fd.append('response_format', 'json');
  fd.append('temperature', '0');
  fd.append('temperature_inc', '0');
  if (prompt) fd.append('prompt', String(prompt).slice(0, 900));
  const t = performance.now();
  const r = await fetch(ASR_URL + '/inference', { method: 'POST', body: fd, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('speech recognition failed (' + r.status + ')');
  const j = await r.json();
  let text = String(j.text || '').replace(/\s+/g, ' ').trim();
  text = text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(); // sound tags like [BLANK_AUDIO]
  if (GHOSTS.test(text)) text = '';
  return { text, ms: Math.round(performance.now() - t) };
}
