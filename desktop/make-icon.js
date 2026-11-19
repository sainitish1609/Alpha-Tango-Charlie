// Draws the app icon (build/icon.png, 512×512): a radar scope in the game's colours.
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const N = 512, px = Buffer.alloc(N * N * 4);
const mix = (i, r, g, b, a) => { const k = a; px[i] = px[i] * (1 - k) + r * k; px[i + 1] = px[i + 1] * (1 - k) + g * k; px[i + 2] = px[i + 2] * (1 - k) + b * k; px[i + 3] = Math.min(255, px[i + 3] + 255 * k); };
const cov = d => Math.max(0, Math.min(1, 0.5 - d)); // anti-aliased edge from a signed distance in pixels
const c = N / 2, R = 200;
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const i = (y * N + x) * 4, dx = x + 0.5 - c, dy = y + 0.5 - c, r = Math.hypot(dx, dy);
  // rounded square plate
  const q = Math.max(Math.abs(dx) - 196, Math.abs(dy) - 196, 0), sq = Math.hypot(Math.max(Math.abs(dx) - 196, 0), Math.max(Math.abs(dy) - 196, 0)) - 60 + Math.min(Math.max(Math.abs(dx) - 196, Math.abs(dy) - 196), 0);
  const plate = cov(sq); if (!plate) continue;
  mix(i, 13, 21, 32, plate);
  if (r < R) {
    const g = 1 - r / R; mix(i, 16, 44, 70, 0.55 * g * cov(r - R)); // scope glow-free gradient
    for (const rr of [R, R * 0.66, R * 0.33]) mix(i, 90, 162, 255, (rr === R ? 0.9 : 0.45) * cov(Math.abs(r - rr) - (rr === R ? 3 : 1.6)));
    mix(i, 90, 162, 255, 0.35 * cov(Math.abs(dx) - 1.2) * cov(r - R)); mix(i, 90, 162, 255, 0.35 * cov(Math.abs(dy) - 1.2) * cov(r - R));
    // sweep: a soft wedge behind a bright line toward the upper right
    const ang = Math.atan2(dy, dx), lead = -Math.PI / 4, diff = ((lead - ang) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    if (diff < 1.1) mix(i, 90, 162, 255, 0.3 * (1 - diff / 1.1) * cov(r - R));
    const lx = Math.cos(lead), ly = Math.sin(lead), along = dx * lx + dy * ly, perp = Math.abs(-dx * ly + dy * lx);
    if (along > 0) mix(i, 190, 220, 255, cov(perp - 2.5) * cov(r - R));
  }
  // two targets
  for (const [tx, ty, col] of [[c + 92, c - 40, [255, 255, 255]], [c - 70, c + 88, [227, 163, 58]]]) mix(i, ...col, cov(Math.hypot(x + 0.5 - tx, y + 0.5 - ty) - 11));
}
// PNG encode
const raw = Buffer.alloc((N * 4 + 1) * N); for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4); }
const crc = b => { let c2 = ~0; for (const v of b) { c2 ^= v; for (let k = 0; k < 8; k++) c2 = (c2 >>> 1) ^ (0xEDB88320 & -(c2 & 1)); } return ~c2 >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([l, td, cr]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'build', 'icon.png'), png);
console.log('build/icon.png', png.length, 'bytes');
