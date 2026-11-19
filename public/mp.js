'use strict';
/* ==========================================================================
   Multiplayer: a shared shift. One player hosts: their game runs the airport. Others join with the
   four-letter code and take the positions nobody has (Clearance, Ground, Tower, Approach); the AI keeps
   the rest. Everyone sees the same traffic; each player talks on their own positions, and the pilots
   answer them. Relayed by the game server (/api/mp/…).
   ========================================================================== */
(() => {
  const POS = ['DEL', 'GND', 'TWR', 'APP'];
  const SKIP = new Set(['blockedBy', 'waitFor', 'towBack', 'push', 'xs', 'ma', 'hist', 'hold', '_b', 'perf', 'al', 'trail', 'path', 'exit', 'dlNext', 'msaw', 'wake', 'sitStop', 'ra', 'emg']);
  const MP = {
    role: null, room: null, sent: new Set(), id: Math.random().toString(36).slice(2, 10), name: '', claims: {}, es: null, lastSend: 0, outLog: [],
    mine() { return POS.filter(p => this.claims[p] && this.claims[p].id === this.id); },
    post(path, d) { return fetch('api/mp/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...d, id: this.id, name: this.name, room: this.room }) }).then(r => r.json()); },
    listen() {
      if (this.es) this.es.close();
      const es = this.es = new EventSource(`api/mp/stream?room=${this.room}&id=${this.id}`);
      es.addEventListener('room', e => { const r = JSON.parse(e.data); this.claims = r.claims || {}; this.applyClaims(); this.hud(); });
      es.addEventListener('state', e => this.client && this.apply(JSON.parse(e.data)));
      es.addEventListener('tx', e => { if (this.role !== 'host') return; const t = JSON.parse(e.data); processTransmission(t.text, { mp: t.name }); });
      es.onerror = () => { if (this.role) this.hud('reconnecting…'); };
    },
    get client() { return this.role === 'client'; },
    // who works what: the host's game counts every claimed position as staffed (no AI there)
    applyClaims() {
      if (this.role === 'host') POS.forEach(p => S.staffed[p] = !!this.claims[p]);
      if (this.role === 'client') POS.forEach(p => S.staffed[p] = !!(this.claims[p] && this.claims[p].id === this.id));
      if (window.UI && UI.renderStrips) UI.renderStrips();
    },

    // ---------- hosting ----------
    async host(pos) {
      this.name = (Profile.d.name || 'Host').slice(0, 24);
      const r = await this.post('create', { pos, setup: { airport: S.airport, density: S.density } });
      if (!r.code) throw new Error(r.error || 'could not start');
      this.room = r.code; this.role = 'host'; this.listen();
      UI.log('SYS', `Multiplayer: your shift code is ${r.code}. Others join from the menu (Multiplayer → Join) and take free positions.`, 'tip');
    },
    // a few times a second the host sends the picture to everyone
    tick() {
      if (this.role !== 'host' || !S.running || performance.now() - this.lastSend < 450) return;
      this.lastSend = performance.now();
      const ac = S.aircraft.map(a => {
        const o = {}; for (const k in a) { const v = a[k]; if (SKIP.has(k)) continue; if (v == null || typeof v !== 'object') o[k] = v; else if (k === 'request' || k === 'dest' || k === 'orig' || k === 'flags') o[k] = JSON.parse(JSON.stringify(v)); }
        o.code = a.al.code; o.path = (a.path || []).slice(0, 40); o.emg = a.emg ? { t: a.emg.t, pan: a.emg.pan } : null; o.msaw = !!a.msaw; o.wake = !!a.wake;
        return o;
      });
      const st = { t: S.t, flow: S.flow, rwyDep: S.rwyDep, rwyArr: S.rwyArr, wind: S.wind, metar: S.metar, atis: S.atis, altim: S.altim, airport: S.airport, lvp: S.lvp, ac, log: this.outLog.splice(0) };
      this.post('state', { state: st }).catch(() => { });
    },

    // ---------- joining ----------
    async join(code, pos) {
      this.name = (Profile.d.name || 'Controller').slice(0, 24); this.room = code.toUpperCase().trim();
      const c = await this.post('claim', { pos });
      if (c.error) throw new Error(c.error);
      this.role = 'client'; this.claims = c.claims; this.joined = false; this.listen();
    },
    apply(st) {
      if (!this.joined) { // first picture: set the airport up like the host's
        this.joined = true; S.airport = st.airport; S.flowPref = st.flow; Mission.cur = null; S.srcLive = false;
        startSession(); S.aircraft.length = 0; this.applyClaims();
        UI.log('SYS', `Joined shift ${this.room} at ${APT.name}. You work ${this.mine().map(p => POSNAME[p]).join(', ') || 'nothing yet'}.`, 'tip');
      }
      Object.assign(S, { t: st.t, wind: st.wind, metar: st.metar, atis: st.atis, altim: st.altim, lvp: st.lvp });
      if (S.flow !== st.flow || S.rwyDep !== st.rwyDep) { S.flow = st.flow; applyRunways(); R.sceneFor = null; }
      const by = new Map(S.aircraft.map(a => [a.id, a])), keep = [];
      for (const o of st.ac) {
        const a = by.get(o.id) || { trail: [], flags: {}, trailT: 0 };
        for (const k in a) if (!(k in o) && !['trail', 'trailT', 'al', 'perf', 'px', 'py', 'ph'].includes(k)) delete a[k];
        Object.assign(a, o); a.al = airlineFor(o.code); a.perf = perfFor(o.type); a.trail = a.trail || [];
        if (!onGround(a)) { a.trailT = (a.trailT || 0) + 0.45; if (a.trailT > 4) { a.trailT = 0; a.trail.push({ x: a.x, y: a.y }); if (a.trail.length > 7) a.trail.shift(); } }
        keep.push(a);
      }
      S.aircraft.length = 0; S.aircraft.push(...keep);
      if (S.sel && !keep.includes(S.sel)) S.sel = keep.find(a => a.id === S.sel.id) || null;
      for (const l of st.log || []) {
        if (l.cls === 'atc' && this.sent.delete(l.text)) continue; // my own call, already in my log
        UI.log(l.who, l.text, l.cls);
        // pilots on my frequencies speak to me
        const ac = /pilot/.test(l.cls || '') && S.aircraft.find(a => a.cs === l.who);
        if (ac && this.mine().includes(ac.freq) && window.speechSynthesis) { try { const u = new SpeechSynthesisUtterance(l.text); u.rate = 1.08; speechSynthesis.speak(u); } catch (e) { } }
      }
    },
    leave() { if (this.es) this.es.close(); this.es = null; this.role = null; this.room = null; this.hud(); },
    hud(note) {
      let el = document.querySelector('#mpHud');
      if (!this.role) { if (el) el.remove(); return; }
      if (!el) { el = document.createElement('div'); el.id = 'mpHud'; document.body.appendChild(el); }
      el.innerHTML = `<b>Shift ${this.room}</b> ${POS.map(p => `<span class="${this.claims[p] ? (this.claims[p].id === this.id ? 'me' : 'them') : ''}" title="${this.claims[p] ? esc(this.claims[p].name) : 'AI'}">${p}${this.claims[p] && this.claims[p].id !== this.id ? ' · ' + esc(this.claims[p].name) : ''}</span>`).join('')}${note ? `<em>${note}</em>` : ''}`;
    },

    // ---------- the menu ----------
    show() {
      const P = Profile.d;
      overlay(`<div class="modal" role="dialog" aria-labelledby="mpTitle">
        <div class="hero"><div><div class="wm">MULTIPLAYER</div><h1 id="mpTitle">Work a shift together.</h1><p>One player hosts and runs the airport; the others join with the code and take the positions nobody has. The AI keeps the rest.</p></div></div>
        <div class="vrow"><label for="mpName">Your name</label><input id="mpName" maxlength="24" value="${esc(P.name || '')}" placeholder="Shown to the others"></div>
        <div class="mpcols">
          <div><h2>Host a shift</h2>
            <div class="vrow"><label for="mpApt">Airport</label><select id="mpApt">${Object.values(AIRPORTS).map(a => `<option value="${a.icao}"${a.icao === S.airport ? ' selected' : ''}>${esc(a.name)} (${a.icao})</option>`).join('')}</select></div>
            <p class="sm">Your positions:</p><div class="opts">${POS.map(p => `<label><input type="checkbox" name="mpHostPos" value="${p}" ${p === 'TWR' ? 'checked' : ''}>${POSNAME[p]}</label>`).join('')}</div>
            <button class="go" id="mpHost">Host</button></div>
          <div><h2>Join a shift</h2>
            <div class="vrow"><label for="mpCode">Code</label><input id="mpCode" maxlength="4" autocapitalize="characters" placeholder="ABCD"></div>
            <div class="vrow"><label for="mpPos">Position</label><select id="mpPos">${POS.map(p => `<option value="${p}"${p === 'APP' ? ' selected' : ''}>${POSNAME[p]}</option>`).join('')}</select></div>
            <button class="go" id="mpJoin">Join</button></div>
        </div>
        <p class="sm" id="mpMsg"></p>
        <div class="foot"><button class="cbtn" id="backBtn">Back to menu</button><span></span></div>
      </div>`);
      const msg = t => { document.querySelector('#mpMsg').textContent = t; };
      const nm = () => { P.name = document.querySelector('#mpName').value.trim().slice(0, 24); Profile.save(); };
      document.querySelector('#backBtn').onclick = () => showMenu();
      document.querySelector('#mpHost').onclick = async () => {
        nm(); const pos = [...document.querySelectorAll('input[name=mpHostPos]:checked')].map(i => i.value);
        S.airport = document.querySelector('#mpApt').value; S.flowPref = 'auto'; S.srcLive = false; Mission.cur = null; S.density = S.density || 'medium';
        POS.forEach(p => S.staffed[p] = pos.includes(p));
        try { Radio.audio(); startSession(); await this.host(pos); this.claims = Object.fromEntries(pos.map(p => [p, { id: this.id, name: this.name }])); this.hud(); }
        catch (e) { msg('Could not host: ' + e.message); }
      };
      document.querySelector('#mpJoin').onclick = async () => {
        nm(); const code = document.querySelector('#mpCode').value;
        if (!/^[A-Za-z]{4}$/.test(code)) return msg('The code is four letters.');
        try { Radio.audio(); msg('Joining…'); await this.join(code, document.querySelector('#mpPos').value); document.querySelector('#overlay').classList.add('hide'); this.hud(); }
        catch (e) { msg('Could not join: ' + e.message); }
      };
    },
  };
  window.MP = MP;

  // the host's log goes out with the next picture; a joined game doesn't run its own simulation
  const log0 = UI.log.bind(UI);
  UI.log = (who, text, cls) => { if (MP.role === 'host') MP.outLog.push({ who, text, cls }); return log0(who, text, cls); };
  const sim0 = window.simStep;
  window.simStep = dt => { if (MP.client) { S.t += dt; return; } sim0(dt); MP.tick(); };
  // a joined player's calls go to the host's game, where the pilots are
  const tx0 = window.processTransmission;
  window.processTransmission = (raw, opts) => {
    if (MP.client && !(opts && (opts.ai || opts.mp))) { log0('ATC', raw, 'atc'); MP.sent.add(raw); MP.post('tx', { text: raw }).catch(() => { }); return; }
    return tx0(raw, opts);
  };
})();
