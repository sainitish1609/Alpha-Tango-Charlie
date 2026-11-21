'use strict';
/* ==========================================================================
   Runway control: the Tower supervisor's panel (the RWY button in the top bar).
   - Each runway: use it for departures, arrivals or both; close it (5, 10, 20 minutes, or until you
     reopen it); reopen it.
   - Closing a runway in use sends its traffic to the other runway (arrivals off the old approach for
     vectors to the new one, departures re-routed to the new holding point) and puts the old setup back
     when it reopens. With one runway, arrivals go into the hold, and you can divert them to their alternates.
   - Auto: a runway blocked by an aircraft that has stopped on it (a burst tyre, a rejected takeoff)
     closes by itself and traffic moves to the other runway until it's towed clear.
   - Turn the runways around (land and depart the other way), announced with a new ATIS letter.
   ========================================================================== */
(() => {
  const RC = {
    auto: true, restore: null, open: false,
    pair(rid) { const r = RWY[rid]; return r ? `${r.names.E}/${r.names.W}` : rid; },
    now(rid) { return RWY[rid] ? RWY[rid].names[S.flow] : rid; },
    isClosed(rid) { return !!(window.Sit && Sit.closed(rid)); },
    use(rid) {
      if (this.isClosed(rid)) return 'closed';
      const d = S.rwyDep === rid, a = S.rwyArr === rid;
      return d && a ? 'both' : d ? 'dep' : a ? 'arr' : 'off';
    },
    nextAtis() { S.atis = String.fromCharCode(((S.atis || 'A').charCodeAt(0) - 64) % 26 + 65); },
    // a new runway setup, and everyone moved onto it
    setCfg(cfg, why) {
      const od = S.rwyDep, oa = S.rwyArr;
      S.rwyCfg = cfg; applyRunways(); R.sceneFor = null; if (window.Gops) Gops.barsFor = '';
      this.nextAtis();
      let arr = 0, dep = 0;
      for (const ac of S.aircraft) {
        if (ac.kind === 'arr' && !onGround(ac) && S.rwyArr !== oa) {
          if (ac.ils || ac.loc || ac.freq === 'TWR') { ac.ils = ac.loc = ac.gs = false; ac.landClr = false; ac.vectored = true; ac.tgtHdg = ac.hdg; ac.turnDir = null; arr++; }
          if (ac.freq === 'TWR') setRequest(ac, 'handoff_ga', true);
          ac.aiNext = S.t + 3;
        }
        if (ac.kind === 'dep' && S.rwyDep !== od && ['taxiing', 'holdshort'].includes(ac.phase) && ac.node) {
          const p = findPath(ac.node, S.depEntry.hs, null);
          if (p) { ac.path = p; ac.xs = []; ac.phase = p.length ? 'taxiing' : 'holdshort'; ac.toClr = false; ac.luawPending = false; ac.request = null; ac.held = false; dep++; if (!p.length) arrivedAtNode(ac); }
        }
      }
      Radio.alert && Radio.alert('ca');
      UI.log('SYS', `${why}. Now ${mixedOps() ? `departing and landing ${depRwyName()}` : `departures ${depRwyName()}, arrivals ${arrRwyName()}`}. Information ${S.atis}.${arr ? ` ${arr} arrival${arr > 1 ? 's' : ''} taken off the old approach: vector them to the new final.` : ''}${dep ? ` ${dep} departure${dep > 1 ? 's' : ''} re-routed to the new runway.` : ''}`, 'alert');
      UI.renderStrips && UI.renderStrips(); this.render();
    },
    // which setup puts this runway to this use, keeping the other where it can be
    cfgFor(rid, use) {
      const other = rid === 'N' ? 'S' : 'N';
      if (!RWY[other] || use === 'both') return rid;
      if (use === 'dep') return rid === 'N' ? 'split' : 'swap';      // split: N departs, S lands
      if (use === 'arr') return rid === 'S' ? 'split' : 'swap';
      return S.rwyCfg;
    },
    setUse(rid, use) {
      if (this.isClosed(rid)) return UI.log('SYS', `Runway ${this.pair(rid)} is closed: reopen it first.`, 'tip');
      const other = rid === 'N' ? 'S' : 'N';
      if (use !== 'both' && RWY[other] && this.isClosed(other)) return UI.log('SYS', `Runway ${this.pair(other)} is closed, so ${this.pair(rid)} has to take both arrivals and departures.`, 'tip');
      const cfg = this.cfgFor(rid, use); if (cfg === S.rwyCfg) return;
      this.restore = null;
      this.setCfg(cfg, `Runway ${this.pair(rid)} now for ${use === 'both' ? 'arrivals and departures' : use === 'dep' ? 'departures' : 'arrivals'}`);
    },
    close(rid, mins, why, auto) {
      const rw = RWY[rid]; if (!rw || !window.Sit) return;
      Sit.closures[rid] = { seen: true, until: mins ? S.t + mins * 60 : S.t + 1e9, why: why || 'closed by Tower', manual: !auto, auto: !!auto, veh: { x: S.flow === 'W' ? rw.x1 : rw.x2, dir: S.flow === 'W' ? 1 : -1 } };
      this.nextAtis();
      const other = rid === 'N' ? 'S' : 'N', used = S.rwyDep === rid || S.rwyArr === rid;
      UI.log('SYS', `Runway ${this.pair(rid)} closed${mins ? ` for ${mins} minutes` : ''}: ${why || 'closed by Tower'}.`, 'alert');
      if (used && RWY[other] && !this.isClosed(other)) { // the other one takes everything until this one reopens
        if (!this.restore) this.restore = { cfg: S.rwyCfg, rid };
        this.setCfg(other, `Traffic moved to runway ${this.pair(other)} while ${this.pair(rid)} is closed`);
      } else if (used) {
        UI.log('SYS', `No other runway: arrivals hold (or divert them from the Runways panel), departures wait at the holding point.`, 'tip');
      }
      this.render();
    },
    reopen(rid) {
      if (!window.Sit || !Sit.closures[rid]) return;
      delete Sit.closures[rid]; this.nextAtis();
      UI.log('SYS', `Runway ${this.pair(rid)} is open again. Information ${S.atis}.`, 'tip');
      if (this.restore && this.restore.rid === rid) { const c = this.restore.cfg; this.restore = null; if (c !== S.rwyCfg) this.setCfg(c, `Back to the usual runways`); }
      this.render();
    },
    // with no runway to land on: the airborne arrivals go to their alternates
    divert() {
      let n = 0;
      for (const ac of S.aircraft.slice()) {
        if (ac.kind !== 'arr' || onGround(ac) || (ac.loc && locGeom(ac.x, ac.y).d < 3)) continue;
        UI.log(ac.cs, `${ac.cs}, diverting to our alternate.`, 'pilot'); S.stats.diverts = (S.stats.diverts || 0) + 1; removeAc(ac); n++;
      }
      UI.log('SYS', n ? `${n} arrival${n > 1 ? 's' : ''} diverted to their alternates.` : 'No arrivals to divert.', 'tip');
      this.render();
    },
    turnAround() {
      const to = S.flow === 'W' ? 'E' : 'W', od = S.rwyDep, oa = S.rwyArr;
      if (window.Gops) { Gops.change = { to, at: S.t, first: S.t - 300 }; Gops.tick(); }
      else { S.flow = to; applyRunways(); }
      this.nextAtis(); this.render();
    },

    // on the sim clock, once a second: blocked runways, closures ending
    acc: 0,
    step(dt) { this.acc += dt; if (this.acc >= 1) { this.acc = 0; this.tick(); } },
    tick() {
      if (!S.running) return;
      for (const rid of [S.rwyDep, S.rwyArr].filter((v, i, a) => a.indexOf(v) === i)) {
        const R0 = RWY[rid]; if (!R0) continue;
        const stuck = S.aircraft.find(o => onGround(o) && ['rollout', 'takeoff', 'lineup', 'exiting'].includes(o.phase) && Math.abs(o.y - R0.y) < 0.02 && o.x > R0.x1 && o.x < R0.x2 && (o.spd || 0) < 1 && o.stopSince != null && S.t - o.stopSince > 45 && !(o.phase === 'lineup'));
        if (stuck && this.auto && !this.isClosed(rid)) this.close(rid, 0, `${stuck.cs} has stopped on it`, true);
      }
      for (const o of S.aircraft) { if (onGround(o) && (o.spd || 0) < 1 && ['rollout', 'takeoff', 'exiting'].includes(o.phase)) { if (o.stopSince == null) o.stopSince = S.t; } else o.stopSince = null; }
      // a closure from a situation (debris, an inspection): with auto on, traffic moves to the other runway too
      if (window.Sit) for (const rid in Sit.closures) {
        const c = Sit.closures[rid]; if (c.seen) continue; c.seen = true;
        const other = rid === 'N' ? 'S' : 'N';
        if (this.auto && (S.rwyDep === rid || S.rwyArr === rid) && RWY[other] && !this.isClosed(other) && !this.restore) { this.restore = { cfg: S.rwyCfg, rid }; this.setCfg(other, `Runway ${this.pair(rid)} closed (${c.why}): traffic moved to ${this.pair(other)}`); }
      }
      // an automatic closure ends once nothing is stopped on the runway any more
      if (window.Sit) for (const rid in Sit.closures) {
        const c = Sit.closures[rid], R0 = RWY[rid]; if (!c.auto || !R0) continue;
        const still = S.aircraft.some(o => onGround(o) && ['rollout', 'takeoff', 'exiting'].includes(o.phase) && Math.abs(o.y - R0.y) < 0.02 && o.x > R0.x1 && o.x < R0.x2 && (o.spd || 0) < 1);
        if (!still) { c.clearT = c.clearT || S.t; if (S.t - c.clearT > 20) this.reopen(rid); } else c.clearT = null;
      }
      // a closure that ended by itself (an inspection finished): back to the usual runways
      const finals = S.aircraft.some(a => a.kind === 'arr' && !onGround(a) && a.loc && locGeom(a.x, a.y).d < 10);
      if (this.restore && !this.isClosed(this.restore.rid) && finals && S.t - (this.restore.waitT ??= S.t) < 240) return; // let the ones on final land first
      if (this.restore && !this.isClosed(this.restore.rid)) { const { cfg, rid } = this.restore; this.restore = null; if (cfg !== S.rwyCfg) this.setCfg(cfg, `Runway ${this.pair(rid)} open again: back to the usual runways`); }
    },

    // ---------- the panel ----------
    toggle() { this.open = !this.open; this.render(); },
    render() {
      let el = document.querySelector('#rwyPanel');
      if (!this.open || !S.running) { if (el) el.remove(); return; }
      if (!el) { el = document.createElement('div'); el.id = 'rwyPanel'; document.body.appendChild(el); el.addEventListener('click', e => this.click(e)); }
      const ids = Object.keys(RWY), LBL = { dep: 'Departures', arr: 'Arrivals', both: 'Arrivals and departures', off: 'Not in use', closed: 'Closed' };
      const single = ids.length === 1, anyArrRwy = ids.some(r => !this.isClosed(r));
      const key = JSON.stringify([ids.map(r => [this.use(r), this.isClosed(r) && Math.round((Sit.closures[r].until - S.t) / 60)]), this.auto, S.flow]);
      if (el.dataset.key === key) return; el.dataset.key = key;
      el.innerHTML = `<div class="rph"><b>Runways</b><button class="cbtn" data-a="x" aria-label="Close">✕</button></div>
        ${ids.map(r => { const u = this.use(r), cl = this.isClosed(r) && Sit.closures[r], left = cl && cl.until - S.t < 1e8 ? Math.max(1, Math.round((cl.until - S.t) / 60)) + ' min' : cl ? 'until reopened' : '';
          return `<div class="rpr"><div class="rpn"><b>${this.now(r)}</b><span>${this.pair(r)}</span><em class="u-${u}">${LBL[u]}${left ? ' · ' + left : ''}${cl && cl.why ? ' · ' + esc(cl.why) : ''}</em></div>
          <div class="rpb">${u === 'closed' ? `<button class="cbtn" data-a="open" data-r="${r}">Reopen</button>` : `${single ? '' : `<button class="cbtn${u === 'dep' ? ' on' : ''}" data-a="dep" data-r="${r}">Departures</button><button class="cbtn${u === 'arr' ? ' on' : ''}" data-a="arr" data-r="${r}">Arrivals</button>`}<button class="cbtn${u === 'both' ? ' on' : ''}" data-a="both" data-r="${r}">Both</button>
            <select class="cbtn" data-a="close" data-r="${r}" aria-label="Close runway ${this.now(r)}"><option value="">Close…</option><option value="5">5 min</option><option value="10">10 min</option><option value="20">20 min</option><option value="0">Until reopened</option></select>`}</div></div>`; }).join('')}
        <div class="rpo"><label><input type="checkbox" data-a="auto" ${this.auto ? 'checked' : ''}> Close a blocked runway by itself and move traffic to the other</label></div>
        <div class="rpb"><button class="cbtn" data-a="turn">Turn the runways around</button>${!anyArrRwy || single ? `<button class="cbtn" data-a="divert">Divert arrivals</button>` : ''}</div>`;
      el.querySelectorAll('select[data-a=close]').forEach(s => s.onchange = () => { if (s.value !== '') this.close(s.dataset.r, +s.value, 'closed by Tower'); });
      const au = el.querySelector('input[data-a=auto]'); if (au) au.onchange = () => { this.auto = au.checked; };
    },
    click(e) {
      const b = e.target.closest('button[data-a]'); if (!b) return;
      const a = b.dataset.a, r = b.dataset.r;
      if (a === 'x') return this.toggle();
      if (a === 'open') return this.reopen(r);
      if (a === 'turn') return this.turnAround();
      if (a === 'divert') return this.divert();
      if (['dep', 'arr', 'both'].includes(a)) return this.setUse(r, a);
    },
    reset() { this.restore = null; this.open = false; this.render(); },
  };
  window.RC = RC;
  setInterval(() => { try { if (RC.open && typeof S !== 'undefined' && S.running) RC.render(); } catch (e) { } }, 1000); // the panel's countdowns
})();
