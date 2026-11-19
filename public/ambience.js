'use strict';
/* ==========================================================================
   The airfield you hear from the tower cab: wind on the glass, rain, the rumble of engines taxiing,
   the roar of a takeoff roll, all made live from noise (no sound files), following the weather and the
   traffic. Louder in the airport view, faint behind the radar. Its own volume in Settings > Audio.
   ========================================================================== */
(() => {
  const Amb = {
    on: false, n: {},
    start() {
      const R = (typeof Radio !== 'undefined' ? Radio : null);
      if (this.on || !R || !R.ctx || !R.noiseBuf) return;
      const ctx = R.ctx, out = ctx.createGain(); out.gain.value = 0;
      out.connect(window.Settings ? Settings.bus('amb') : R.master);
      const layer = (type, f, q) => {
        const src = ctx.createBufferSource(); src.buffer = R.noiseBuf; src.loop = true; src.playbackRate.value = 0.5 + Math.random() * 0.2;
        const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q || 0.7;
        const g = ctx.createGain(); g.gain.value = 0;
        src.connect(fl); fl.connect(g); g.connect(out); src.start();
        return { g, fl };
      };
      this.n = { out, wind: layer('bandpass', 420, 0.5), rain: layer('highpass', 2600, 0.3), taxi: layer('lowpass', 160, 0.9), roar: layer('bandpass', 700, 0.6), whine: layer('bandpass', 3200, 6) };
      this.on = true;
    },
    // a few times a second: follow the weather, the traffic and which view is open
    update() {
      if (!this.on) { if (S.running && typeof Radio !== 'undefined' && Radio.ctx) this.start(); if (!this.on) return; }
      const ctx = Radio.ctx, t = ctx.currentTime, n = this.n, set = (p, v, k) => p.setTargetAtTime(v, t, k || 0.6);
      const live = S.running && !S.paused && !(window.Settings && Settings.p.amb === false);
      const view = R.mode === 'radar' ? 0.18 : R.mode === 'split' ? 0.6 : 1;
      set(n.out.gain, live ? 0.55 * view : 0, 0.4);
      if (!live) return;
      const w = window.Env && Env.wx, spd = S.wind ? (S.wind.gust || S.wind.spd || 0) : 0;
      set(n.wind.g.gain, Math.min(0.5, spd / 45) * (0.7 + 0.3 * Math.sin(t / 3.1)), 1.5);
      set(n.wind.fl.frequency, 300 + spd * 14, 2);
      set(n.rain.g.gain, w ? Math.min(0.5, (w.rain || 0) * 0.45 + (w.snow || 0) * 0.08) : 0, 2);
      // engines: taxiing and pushing aircraft rumble; a takeoff roll roars, loudest as it passes the tower
      let taxi = 0, roar = 0;
      for (const a of S.aircraft) {
        const d = Math.max(0.15, dist(a.x, a.y, 0, 0));
        if (['taxiing', 'taxiing_in', 'pushing', 'lineup_move', 'exiting'].includes(a.phase)) taxi += (a.perf.heavy ? 1.6 : 1) / (1 + d * 3);
        if (a.phase === 'takeoff' || (a.phase === 'climb' && a.alt < 1500)) roar += (a.perf.heavy ? 1.8 : 1.2) * Math.min(1, (a.spd || 60) / 120) / (1 + d * 1.5);
        if (a.phase === 'rollout') roar += 0.7 / (1 + d * 1.5); // reversers
      }
      set(n.taxi.g.gain, Math.min(0.45, taxi * 0.22), 0.8);
      set(n.whine.g.gain, Math.min(0.06, taxi * 0.02), 0.8);
      set(n.roar.g.gain, Math.min(0.7, roar * 0.5), 0.5);
      set(n.roar.fl.frequency, 500 + roar * 300, 0.5);
    },
  };
  window.Amb = Amb;
  setInterval(() => { try { Amb.update(); } catch (e) { } }, 250);
})();
