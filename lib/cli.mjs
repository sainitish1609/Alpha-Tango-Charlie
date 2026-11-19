// Claude Code as the crews' brain, using your own Claude login (no API key).
// Starting `claude` takes a few seconds, far too slow for a radio readback, so the server keeps
// a small pool of claude processes open in streaming mode and hands each request to a free one.
// Each process is retired after a dozen requests so its conversation never grows long or slow.
import { spawn, spawnSync } from 'node:child_process';
import { setPriority, constants as osc } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

export function findClaude() {
  const cands = [
    process.env.CLAUDE_PATH,
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    join(homedir(), '.claude', 'local', 'claude'),
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  if (process.platform === 'win32') {
    const w = spawnSync('where', ['claude.exe'], { encoding: 'utf8' });
    const hit = (w.stdout || '').split(/\r?\n/).find(l => l.trim());
    if (hit) return hit.trim();
    return null;
  }
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? 'claude' : null;
}

const RECYCLE_AFTER = +process.env.CLI_TURNS || 20; // a fresh claude costs a few seconds of CPU, so not too often
const TIMEOUT = 15000;

class Worker {
  constructor(pool, id) {
    this.pool = pool; this.id = id; this.turns = 0; this.busy = null; this.ready = false; this.dead = false; this.buf = '';
    const cwd = join(tmpdir(), 'vector-crew'); mkdirSync(cwd, { recursive: true }); // a blank folder: no CLAUDE.md, no project settings
    this.p = spawn(pool.exe, [
      '-p', '--model', pool.model, '--effort', 'low',
      '--system-prompt', pool.system,
      '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'local',
      '--json-schema', JSON.stringify(pool.schema),
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence',
    ], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // below the browser: Chrome's speech recognition must never wait for a pilot's words
    try { setPriority(this.p.pid, osc.priority.PRIORITY_BELOW_NORMAL); } catch { }
    this.p.stdout.on('data', d => this.read(d));
    this.p.stderr.on('data', d => { const s = String(d).trim(); if (s && !/unrecognized_model/.test(s)) pool.note(s); });
    this.p.on('exit', () => { this.dead = true; if (this.busy) { this.busy.reject(new Error('claude exited')); this.busy = null; } pool.replace(this); });
    this.p.on('error', e => { this.dead = true; pool.note('could not start claude: ' + e.message); });
  }
  read(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'system' && m.subtype === 'init') this.ready = true;
      if (m.type !== 'result' || !this.busy) continue;
      const job = this.busy; this.busy = null; clearTimeout(job.tm);
      if (m.is_error || !m.structured_output) {
        const why = m.result || m.subtype || 'error';
        if (/log ?in|auth|credential|401|403/i.test(why)) this.pool.authFailed = why;
        job.reject(new Error(String(why).slice(0, 200)));
      } else {
        this.pool.authFailed = '';
        job.resolve({ out: m.structured_output, usage: m.usage || {} });
      }
      if (++this.turns >= RECYCLE_AFTER) this.retire(); else this.pool.pump();
    }
  }
  send(job) {
    this.busy = job;
    job.tm = setTimeout(() => { if (this.busy === job) { this.busy = null; job.reject(new Error('claude timed out')); this.retire(); } }, TIMEOUT);
    this.p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: job.prompt } }) + '\n');
  }
  retire() { if (this.dead) return; this.dead = true; try { this.p.stdin.end(); } catch { } setTimeout(() => { try { this.p.kill(); } catch { } }, 3000); this.pool.replace(this); }
}

export class ClaudePool {
  constructor({ exe, model, system, schema, size }) {
    Object.assign(this, { exe, model, system, schema, size: size || 2, queue: [], workers: [], n: 0, authFailed: '', lastNote: '' });
    for (let i = 0; i < this.size; i++) this.workers.push(new Worker(this, ++this.n));
  }
  note(s) { if (s !== this.lastNote) { this.lastNote = s; console.log('[claude]', s.slice(0, 300)); } }
  replace(w) {
    const i = this.workers.indexOf(w);
    if (i < 0) return;
    if (this.stopping) { this.workers.splice(i, 1); return; }
    // a crash loop (not logged in, bad flags) must not spawn forever
    this.spawnTimes = (this.spawnTimes || []).filter(t => Date.now() - t < 60e3);
    if (this.spawnTimes.length > 10) { this.workers.splice(i, 1); this.note('claude keeps exiting; AI crews paused. Check that `claude` works in a terminal.'); return; }
    this.spawnTimes.push(Date.now());
    this.workers[i] = new Worker(this, ++this.n);
    this.pump();
  }
  ask(prompt) {
    return new Promise((resolve, reject) => { this.queue.push({ prompt, resolve, reject, at: Date.now() }); this.pump(); });
  }
  pump() {
    // stale requests are useless on a radio: the moment has passed
    while (this.queue.length && Date.now() - this.queue[0].at > 8000) this.queue.shift().reject(new Error('too late'));
    for (const w of this.workers) {
      if (!this.queue.length) return;
      if (!w.dead && !w.busy) w.send(this.queue.shift());
    }
  }
  stop() { this.stopping = true; for (const w of this.workers) { try { w.p.kill(); } catch { } } }
}
