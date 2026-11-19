// Password protection for the game, for when it is reachable from outside (a Cloudflare tunnel, say).
// Set VECTOR_PASSWORD in .env to turn it on; leave it empty for no login.
// Signing in sets a cookie that keeps the browser signed in for 30 days. Changing the password signs
// everyone out. Wrong guesses are limited per address, so the password can't be guessed by brute force.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DAYS = 30, COOKIE = 'vector_session';

export function makeAuth(root) {
  const password = (process.env.VECTOR_PASSWORD || '').trim();
  if (!password) return { on: false, gate: () => false };
  // a random key kept on this machine signs the cookies; the password is mixed in so changing it signs everyone out
  const keyFile = join(root, '.session-key');
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const key = createHmac('sha256', readFileSync(keyFile, 'utf8').trim()).update(password).digest();
  const sign = v => createHmac('sha256', key).update(v).digest('base64url');
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
  const fails = new Map(); // address -> recent wrong guesses
  const who = req => String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const valid = req => {
    const m = /(?:^|;\s*)vector_session=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return false;
    const [exp, sig] = decodeURIComponent(m[1]).split('.');
    return !!sig && +exp > Date.now() && same(sig, sign(exp));
  };
  const secure = req => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' || !!req.headers['cf-visitor'];

  // returns true when it has answered the request itself (login page, refusal); false lets it through
  async function gate(req, res, path) {
    if (path === '/login' && req.method === 'POST') {
      const ip = who(req), now = Date.now(), f = (fails.get(ip) || []).filter(t => now - t < 15 * 60e3);
      if (f.length >= 8) { res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page('Too many wrong passwords. Try again in 15 minutes.')), true; }
      let body = ''; for await (const c of req) { body += c; if (body.length > 4096) break; }
      const given = new URLSearchParams(body).get('password') || '';
      if (!same(given, password)) {
        f.push(now); fails.set(ip, f);
        await new Promise(r => setTimeout(r, 600)); // a beat after a wrong guess
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(page('That password is not right.')), true;
      }
      fails.delete(ip);
      const exp = String(now + DAYS * 864e5), v = encodeURIComponent(exp + '.' + sign(exp));
      res.writeHead(303, { Location: '/', 'Set-Cookie': `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${secure(req) ? '; Secure' : ''}`, 'Cache-Control': 'no-store' });
      return res.end(), true;
    }
    if (path === '/logout') { res.writeHead(303, { Location: '/login', 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0` }); return res.end(), true; }
    if (valid(req)) { if (path === '/login') { res.writeHead(303, { Location: '/' }); return res.end(), true; } return false; }
    if (path.startsWith('/api/') || path.startsWith('/tiles/')) { res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end('{"error":"sign in first"}'), true; }
    if (path !== '/login') { res.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' }); return res.end(), true; } // a page: on to the sign-in page
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(page('')), true;
  }
  return { on: true, gate };
}

// the sign-in page, in the game's own look
function page(msg) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>VECTOR — Sign in</title>
<style>
:root{--ink:#0A0E13;--card:#10151C;--rule:#2D3846;--text:#E7EBF0;--dim:#8A95A3;--acc:#2F7CF6;--bad:#E5534B}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--ink);color:var(--text);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
body{display:grid;place-items:center;padding:16px}
form{width:min(360px,100%);background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:28px;display:flex;flex-direction:column;gap:14px}
.wm{font-weight:700;font-size:12px;letter-spacing:.22em;color:#5AA2FF}h1{margin:0;font-size:24px}p{margin:0;color:var(--dim);font-size:14px;line-height:1.5}
input{height:44px;border-radius:8px;border:1px solid var(--rule);background:#0C1117;color:var(--text);padding:0 12px;font-size:16px}input:focus{outline:2px solid var(--acc);outline-offset:1px;border-color:var(--acc)}
button{height:44px;border:0;border-radius:8px;background:var(--acc);color:#fff;font-size:15px;font-weight:700;cursor:pointer}button:hover{background:#4A8FF8}
.err{color:var(--bad);font-size:14px}
</style></head><body><form method="post" action="/login">
<div class="wm">VECTOR</div><h1>Sign in</h1><p>This game is password protected.</p>
${msg ? `<div class="err" role="alert">${msg}</div>` : ''}
<label for="pw" style="position:absolute;left:-9999px">Password</label><input id="pw" name="password" type="password" placeholder="Password" autocomplete="current-password" autofocus required>
<button type="submit">Sign in</button></form></body></html>`;
}
