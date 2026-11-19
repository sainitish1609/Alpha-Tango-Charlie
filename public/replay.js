'use strict';
/* ==========================================================================
   Replay and debrief. The whole shift is recorded (every aircraft every two seconds, every penalty and
   alert, every transmission). At the end: play it back on a radar at up to 32× speed, with the moments
   that cost points marked on the timeline, and a debrief list: each mistake, when, and what to do next
   time. Click one to jump there.
   ========================================================================== */
(() => {
  const ADVICE = [
    [/no landing clearance/i, 'Clear each arrival to land by about 4 NM out; with no clearance at the minimums the crew must go around.'],
    [/went around: runway not clear/i, 'Land clearance only when the runway will be clear: hold the departure, or clear it for an immediate takeoff earlier.'],
    [/went around/i, 'Get the arrival established and stable earlier: lower and slower before the turn onto final.'],
    [/loss of separation|LOS/i, 'Keep 3 NM or 1,000 ft: give one of them an altitude early, or turn one away before they converge (watch the conflict probe).'],
    [/runway conflict|cleared across/i, 'One aircraft on the runway at a time: check it is empty, and nobody is on short final, before any clearance onto it.'],
    [/late handoff|without a handoff/i, 'Hand off before the boundary: Tower to Departure by 3,000 ft, Approach to Center by 10,000 ft or 20 NM.'],
    [/low altitude|terrain/i, 'Check the terrain heights on the radar before a descent: never below the minimum vectoring altitude.'],
    [/wake/i, 'Behind a heavy: 5 NM for a medium, 6–7 behind an A380. Slow the follower down or space it on the base turn.'],
    [/holdover/i, 'After de-icing, get the aircraft moving: the fluid only protects the wings for 10–25 minutes.'],
    [/readback/i, 'Listen to every readback and correct anything wrong straight away.'],
    [/waited|delay/i, 'Answer requests sooner: amber strips are crews waiting for you.'],
  ];
  const Replay = {
    frames: [], events: [], t: 0, rec: 0,
    reset() { this.frames = []; this.events = []; this.rec = 0; },
    step() {
      if (!S.running) return;
      if (S.t - this.rec < 2 && this.frames.length) return;
      this.rec = S.t;
      this.frames.push({ t: S.t, ac: S.aircraft.map(a => [a.id, a.cs, +a.x.toFixed(3), +a.y.toFixed(3), Math.round(a.alt), Math.round(a.hdg), Math.round(a.spd), a.kind === 'arr' ? 1 : 0, onGround(a) ? 1 : 0, a.los ? 2 : a.ca ? 1 : 0]) });
      if (this.frames.length > 4000) this.frames.splice(0, this.frames.length - 4000);
    },
    note(pts, why) { if (pts < 0 && why && S.running) this.events.push({ t: S.t, pts, why }); },
    advice(why) { const a = ADVICE.find(([re]) => re.test(why)); return a ? a[1] : ''; },

    open(back) {
      if (!this.frames.length) return;
      const f0 = this.frames[0].t, f1 = this.frames[this.frames.length - 1].t, ev = this.events;
      const tm = t => { const s = Math.max(0, Math.round(t)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
      const lost = ev.reduce((n, e) => n + e.pts, 0);
      overlay(`<div class="modal rp" role="dialog" aria-labelledby="rpTitle">
        <div class="hero"><div><div class="wm">REPLAY AND DEBRIEF</div><h1 id="rpTitle">${ev.length ? `${ev.length} moment${ev.length > 1 ? 's' : ''} to look at.` : 'A clean shift.'}</h1><p>${ev.length ? `They cost ${Math.abs(lost).toLocaleString()} points. Click one to watch it happen.` : 'Nothing cost points. Watch it back anyway.'}</p></div></div>
        <div class="rpw"><canvas id="rpCv" width="640" height="420"></canvas>
          <div class="rpd">${ev.length ? ev.map((e, i) => `<button class="rpe" data-i="${i}"><b>${tm(e.t)}</b><span>${esc(e.why)}</span><em>${e.pts}</em>${this.advice(e.why) ? `<i>${esc(this.advice(e.why))}</i>` : ''}</button>`).join('') : '<p class="sm">No penalties, no alerts.</p>'}</div></div>
        <div class="rpc"><button class="cbtn" id="rpPlay">Pause</button><select id="rpSpd" class="cbtn">${[1, 4, 8, 16, 32].map(v => `<option value="${v}"${v === 8 ? ' selected' : ''}>${v}×</option>`).join('')}</select>
          <div class="rptl"><input type="range" id="rpT" min="${f0}" max="${f1}" step="1" value="${f0}">${ev.map(e => `<i style="left:${((e.t - f0) / Math.max(1, f1 - f0) * 100).toFixed(2)}%"></i>`).join('')}</div><span id="rpClock" class="rpk">${tm(f0)}</span></div>
        <div class="foot"><button class="cbtn" id="rpBack">Back</button><span></span></div>
      </div>`);
      const cv = document.querySelector('#rpCv'), c = cv.getContext('2d'), sl = document.querySelector('#rpT');
      let t = f0, play = true, last = performance.now(), raf = 0;
      const spd = () => +document.querySelector('#rpSpd').value;
      const draw = () => {
        const W = cv.width, H = cv.height, sc = Math.min(W, H) / 64, ox = W / 2, oy = H / 2, X = x => ox + x * sc, Y = y => oy - y * sc;
        c.fillStyle = '#050B11'; c.fillRect(0, 0, W, H);
        c.strokeStyle = '#123744'; for (let d = 10; d <= 30; d += 10) { c.beginPath(); c.arc(ox, oy, d * sc, 0, 7); c.stroke(); }
        c.strokeStyle = '#B5C7D6'; c.lineWidth = 2.5; for (const k in RWY) { const r = RWY[k]; c.beginPath(); c.moveTo(X(r.x1), Y(r.y)); c.lineTo(X(r.x2), Y(r.y)); c.stroke(); } c.lineWidth = 1;
        c.font = '10px Inconsolata, monospace'; c.fillStyle = '#4E8090';
        for (const k in FIXES) { const f = FIXES[k]; c.fillText('△ ' + k, X(f.x) - 4, Y(f.y) + 3); }
        // the frame at t, and a short trail from the ones before
        let i = this.frames.findIndex(f => f.t >= t); if (i < 0) i = this.frames.length - 1;
        const fr = this.frames[i];
        for (let k = Math.max(0, i - 6); k < i; k++) for (const a of this.frames[k].ac) { if (a[8]) continue; c.fillStyle = 'rgba(141,235,180,.25)'; c.fillRect(X(a[2]) - 1, Y(a[3]) - 1, 2, 2); }
        c.font = '600 10.5px Inconsolata, monospace';
        for (const a of fr.ac) {
          const x = X(a[2]), y = Y(a[3]), col = a[9] === 2 ? '#FF5A4F' : a[9] === 1 ? '#FFB020' : a[7] ? '#8DEBB4' : '#E7EEF7';
          c.fillStyle = col; c.strokeStyle = col;
          if (a[8]) { c.fillRect(x - 1.5, y - 1.5, 3, 3); continue; }
          c.beginPath(); c.arc(x, y, 3.5, 0, 7); c.stroke();
          const h = a[5] * Math.PI / 180; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.sin(h) * a[6] / 60 * sc, y - Math.cos(h) * a[6] / 60 * sc); c.stroke();
          c.fillText(a[1], x + 7, y - 6); c.fillText(`${String(Math.round(a[4] / 100)).padStart(3, '0')} ${Math.round(a[6] / 10)}`, x + 7, y + 6);
        }
        // the event that is happening now
        const now = ev.filter(e => e.t <= t && e.t > t - 25);
        now.forEach((e, k) => { c.fillStyle = 'rgba(40,10,10,.85)'; c.fillRect(10, 10 + k * 22, W - 20, 20); c.fillStyle = '#FF8A80'; c.fillText(`${tm(e.t)}  ${e.why}`, 16, 24 + k * 22); });
        document.querySelector('#rpClock').textContent = tm(t);
      };
      const loop = now => {
        if (!document.querySelector('#rpCv')) return;
        const dt = (now - last) / 1000; last = now;
        if (play) { t = Math.min(f1, t + dt * spd()); sl.value = t; if (t >= f1) { play = false; document.querySelector('#rpPlay').textContent = 'Play'; } }
        draw(); raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      sl.oninput = () => { t = +sl.value; draw(); };
      document.querySelector('#rpPlay').onclick = e => { play = !play; if (play && t >= f1) t = f0; e.target.textContent = play ? 'Pause' : 'Play'; };
      document.querySelectorAll('.rpe').forEach(b => b.onclick = () => { const e = ev[+b.dataset.i]; t = Math.max(f0, e.t - 25); sl.value = t; play = true; document.querySelector('#rpPlay').textContent = 'Pause'; });
      document.querySelector('#rpBack').onclick = () => { cancelAnimationFrame(raf); back(); };
    },
  };
  window.Replay = Replay;
  // every penalty goes into the debrief
  const award0 = window.award;
  if (award0) window.award = function (pts, why) { Replay.note(pts, why); return award0.apply(this, arguments); };
})();
