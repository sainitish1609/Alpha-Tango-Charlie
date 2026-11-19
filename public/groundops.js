'use strict';
/* ==========================================================================
   Ground operations: stop bars at the holding points of the runways in use (red until you clear an
   aircraft onto or across, then green lead-on lights), de-icing in snow and freezing weather (with
   holdover time), and the follow-me car for crews who don't know the airport.
   ========================================================================== */
(() => {
  const Gops = {
    // de-icing is needed in falling or lying snow, freezing precipitation, or freezing fog
    needDeice() {
      const w = window.Env && Env.wx; if (!w) return false;
      return w.snow > 0 || (w.temp != null && w.temp <= 0 && (w.rain > 0 || (w.vis != null && w.vis < 1500))) || (w.temp != null && w.temp <= 3 && /FZ/.test(w.raw || ''));
    },
    // how long the fluid protects the wings: shorter in heavier snow
    holdover() { const w = window.Env && Env.wx; const sn = w ? w.snow : 0; return sn > 0.6 ? 600 : sn > 0.2 ? 900 : 1500; },
    deiceStart(ac) { ac.deiceUntil = S.t + rnd(200, 300); ac.deiced = null; },
    step(ac) {
      if (ac.deiceUntil && S.t >= ac.deiceUntil) {
        ac.deiceUntil = null; ac.deiced = S.t;
        if (S.aircraft.includes(ac) && ac.phase === 'gate') { ac.flags.deicedCall = true; setRequest(ac, 'push', true); }
      }
      // waiting at the runway with the holdover time running out
      if (ac.deiced && ac.kind === 'dep' && ['holdshort', 'lineup', 'taxiing'].includes(ac.phase) && !ac.flags.hot) {
        const left = this.holdover() - (S.t - ac.deiced);
        if (left < 120 && left > 0 && !ac.flags.hotWarn) { ac.flags.hotWarn = true; pilotSay(ac, `${ac.cs}, our holdover time runs out in two minutes.`); }
        if (left <= 0) {
          ac.flags.hot = true; award(-150, `${ac.cs}: de-icing holdover time ran out`);
          UI.log('SYS', `${ac.cs} waited too long after de-icing: the fluid no longer protects the wings, so it has to go back and de-ice again.`, 'alert');
          pilotSay(ac, `${ac.cs}, holdover time has expired, we need to return for de-icing.`);
          schedule(8, () => { if (S.aircraft.includes(ac) && onGround(ac) && ac.phase !== 'takeoff') removeAc(ac); });
        }
      }
    },
    // crews new to the airport ask for help after their taxi clearance (more at night and in low visibility)
    maybeLost(ac) {
      const dark = window.Env && Env.light && Env.light().lights > 0.5;
      const p = 0.05 + (dark ? 0.04 : 0) + (S.lvp ? 0.08 : 0);
      if (ac.live || Math.random() > p || ac.flags.askedFollow) return;
      ac.flags.askedFollow = true;
      schedule(rnd(5, 12), () => { if (S.aircraft.includes(ac) && ['taxiing', 'taxiing_in'].includes(ac.phase) && !ac.request) { ac.held = true; setRequest(ac, 'followme', true); } });
    },
    // where the stop bar for a holding point goes: across the taxiway, facing away from the runway
    barOf(id) {
      const h = NODES[id]; if (!h) return null;
      const a = h.adj.find(x => !x.e.pave && !x.e.rwy && NODES[x.to].kind !== 'rwy') || h.adj[0]; if (!a) return null;
      const p = NODES[a.to], L = dist(h.x, h.y, p.x, p.y) || 1e-6;
      return { x: h.x, y: h.y, ux: (p.x - h.x) / L, uy: (p.y - h.y) / L };
    },
    cleared(id) {
      return S.aircraft.some(a => onGround(a) && dist(a.x, a.y, NODES[id].x, NODES[id].y) < 0.06 &&
        ((a.phase === 'lineup_move') || (a.xs && a.xs[0] && a.xs[0].node === id && a.xs[0].clr)));
    },
    bars: null, barsFor: '',
    draw(c, X, Y, M, now) {
      if (M < 0.15) return;
      const key = LAYOUT.icao + S.flow + S.rwyDep + S.rwyArr;
      if (this.barsFor !== key) { // the holding points of the runways in use
        const act = new Set([S.rwyDep, S.rwyArr]);
        this.bars = Object.values(NODES).filter(n => n.kind === 'hold' && act.has(n.rwy)).map(n => ({ id: n.id, g: this.barOf(n.id) })).filter(b => b.g);
        this.barsFor = key;
      }
      const z = clamp(M * 1852 / 900, 0.6, 2.2), dark = window.Env && Env.light ? Env.light().lights : 0;
      c.save();
      for (const b of (window.Lay && !Lay('gBars') ? [] : this.bars)) {
        const g = b.g, off = this.cleared(b.id), vx = -g.uy, vy = g.ux;
        // the bar: five lights across the taxiway at the holding point
        for (let k = -2; k <= 2; k++) {
          const x = X(g.x + vx * k * 4.5 / 1852), y = Y(g.y + vy * k * 4.5 / 1852);
          c.fillStyle = off ? 'rgba(60,20,20,0.6)' : `rgba(255,${40 + 20 * dark | 0},40,${0.75 + 0.25 * dark})`;
          c.beginPath(); c.arc(x, y, 1.3 * z, 0, Math.PI * 2); c.fill();
          if (!off && dark > 0.2) { c.fillStyle = `rgba(255,60,40,${0.18 * dark})`; c.beginPath(); c.arc(x, y, 4 * z, 0, Math.PI * 2); c.fill(); }
        }
        // lead-on lights toward the runway once it's cleared
        if (off) for (let m = 8; m <= 48; m += 8) {
          const x = X(g.x - g.ux * m / 1852), y = Y(g.y - g.uy * m / 1852);
          c.fillStyle = 'rgba(90,255,140,0.9)'; c.beginPath(); c.arc(x, y, 1.2 * z, 0, Math.PI * 2); c.fill();
        }
      }
      // the follow-me car, a little ahead along the route; de-icing trucks at work
      for (const ac of S.aircraft) {
        if (ac.followMe && ac.path && ac.path.length) {
          const q = pointAlong(ac, 0.035), q2 = pointAlong(ac, 0.04);
          if (q) {
            const h = dist(q.x, q.y, q2.x, q2.y) > 1e-6 ? brg(q.x, q.y, q2.x, q2.y) : ac.hdg;
            const x = X(q.x), y = Y(q.y), r = h * Math.PI / 180, s = Math.max(2.5, M * 2.3); // a 4.6 m car
            c.save(); c.translate(x, y); c.rotate(r);
            c.fillStyle = '#F2C200'; c.fillRect(-s * 0.45, -s, s * 0.9, s * 2);
            c.fillStyle = '#20262E'; c.fillRect(-s * 0.4, -s * 0.35, s * 0.8, s * 0.5);
            const on = Math.floor(now / 350) % 2 === 0;
            c.fillStyle = on ? '#FFB020' : '#7A5410'; c.fillRect(-s * 0.3, -s * 0.15, s * 0.6, s * 0.18);
            c.restore();
            c.fillStyle = 'rgba(242,194,0,0.95)'; c.font = '600 10px Inconsolata, monospace'; c.fillText('FOLLOW ME', x + 8, y - 6);
          }
        }
        if (ac.deiceUntil && ac.deiceUntil > S.t) {
          const d = dimsOf(ac.type), r = ac.hdg * Math.PI / 180, ax = Math.cos(r), ay = -Math.sin(r);
          for (const side of [-1, 1]) {
            const wx = ac.x + ax * side * d[1] * 0.42 / 1852, wy = ac.y + ay * side * d[1] * 0.42 / 1852, x = X(wx), y = Y(wy), s = Math.max(2, M * 3.2);
            c.fillStyle = '#E8792E'; c.fillRect(x - s, y - s * 0.6, s * 2, s * 1.2);
            c.fillStyle = `rgba(255,170,90,${0.25 + 0.15 * Math.sin(now / 120 + side)})`; c.beginPath(); c.arc(X(ac.x + ax * side * d[1] * 0.25 / 1852), Y(ac.y + ay * side * d[1] * 0.25 / 1852), s * 2.4, 0, Math.PI * 2); c.fill();
          }
        }
      }
      c.restore();
    },
  };
  /* ---------- a runway change in the middle of the shift ----------
     The live weather is read again every few minutes. When the wind swings round so the runway in use has more
     tailwind than allowed (5 kt; 10 kt on an airport's preferred runway, like Salzburg 15), the change is announced
     with a new ATIS letter, and made once nobody is rolling, lined up or on short final. */
  Object.assign(Gops, {
    change: null,
    tail(flow) { const w = S.wind || {}; if (w.vrb || !w.spd) return 0; return -w.spd * Math.cos(((w.dir || 0) - (flow === 'W' ? 270 : 90)) * Math.PI / 180); },
    windCheck() {
      if (!S.running || S.flowPref !== 'auto' || this.change) return;
      const cur = S.flow, other = cur === 'W' ? 'E' : 'W', pf = LAYOUT.prefFlow;
      const lim = f => f === pf ? 10 : 5;
      let to = null;
      if (this.tail(cur) > lim(cur) && this.tail(other) <= lim(other)) to = other;
      else if (pf && cur !== pf && this.tail(pf) <= lim(pf)) to = pf; // back to the preferred runway when it allows
      if (!to) return;
      this.change = { to, at: S.t + 480, first: S.t + 480 };
      S.atis = String.fromCharCode(((S.atis || 'A').charCodeAt(0) - 64) % 26 + 65);
      const names = f => { const o = S.flow; S.flow = f; const n = mixedOps() ? depRwyName() : `${depRwyName()}/${arrRwyName()}`; S.flow = o; return n; };
      Radio.alert && Radio.alert('ca');
      UI.log('SYS', `Wind now ${window.Env ? Env.windSay() : S.wind.dir + ' at ' + S.wind.spd}: runway change from ${names(cur)} to ${names(to)} in about 8 minutes. Information ${S.atis} is current. Plan your sequence for the new runway.`, 'alert');
    },
    tick() {
      // how long landings really take to clear the runway here: the approach spaces arrivals by it
      for (const ac of S.aircraft) if (ac.tdT && !ac.occDone && ac.phase !== 'rollout' && (ac.phase !== 'exiting' || Math.abs(ac.y - ARRR().y) > 0.03)) { ac.occDone = true; const o = S.t - ac.tdT; S.occAvg = S.occAvg ? S.occAvg * 0.6 + o * 0.4 : o; }
      const ch = this.change; if (!ch || S.t < ch.at) return;
      const busy = S.aircraft.some(a => ['takeoff', 'lineup', 'lineup_move', 'rollout', 'landing'].includes(a.phase) || (a.kind === 'arr' && !onGround(a) && a.loc && locGeom(a.x, a.y).d < 5));
      if (busy && S.t - ch.first < 240) { ch.at = S.t + 15; return; } // wait for the runway to be empty
      this.change = null;
      S.flow = ch.to; applyRunways(); R.sceneFor = null;
      let dep = 0, arr = 0;
      for (const ac of S.aircraft) {
        if (ac.kind === 'arr' && !onGround(ac)) {
          if (ac.ils || ac.loc || ac.freq === 'TWR') { ac.ils = ac.loc = ac.gs = false; ac.landClr = false; ac.vectored = true; ac.tgtHdg = ac.hdg; ac.turnDir = null; arr++; }
          if (ac.freq === 'TWR') setRequest(ac, 'handoff_ga', true); // Tower sends it back to radar for the new final
          ac.aiNext = S.t + 4;
        }
        if (ac.kind === 'dep' && ['taxiing', 'holdshort'].includes(ac.phase) && ac.node) {
          const p = findPath(ac.node, S.depEntry.hs, null);
          if (p) { ac.path = p; ac.xs = []; ac.phase = p.length ? 'taxiing' : 'holdshort'; ac.toClr = false; ac.luawPending = false; ac.request = null; ac.held = false; dep++; if (!p.length) arrivedAtNode(ac); }
        }
      }
      UI.log('SYS', `Runway change done: departures ${depRwyName()}, arrivals ${arrRwyName()}. ${arr ? arr + ' arrival' + (arr > 1 ? 's' : '') + ' taken off the old approach: vector them round to the new final. ' : ''}${dep ? dep + ' departure' + (dep > 1 ? 's' : '') + ' re-routed to the new runway.' : ''}`, 'alert');
      UI.renderStrips && UI.renderStrips();
    },
  });
  window.Gops = Gops;
})();
