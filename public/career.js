'use strict';
/* ==========================================================================
   Ratings: like a real controller, you are endorsed one position at a time at each airport, Clearance,
   then Ground, then Tower, then Approach, by passing a checkride with an examiner watching. The airports
   go from quiet to busy: Juliana, Salzburg, Vancouver, Heathrow. A position at the next airport needs the
   same position here first. Leaderboard: best scores from everyone playing on this server.
   ========================================================================== */
(() => {
  const ORDER = ['TNCM', 'EGJJ', 'LPMA', 'LFLB', 'LOWS', 'CYVR', 'EGLL'], POS = ['DEL', 'GND', 'TWR', 'APP'];
  const G = (label, get, target, max) => ({ label, get, target, max: !!max });
  const GOALS = {
    DEL: [G('Read 4 IFR clearances', s => s.calls.clearance || 0, 4), G('No more than 1 readback error missed', s => Math.max(0, (s.rbErr || 0) - (s.rbCaught || 0)), 1, true)],
    GND: [G('Push back 3 departures', s => s.calls.push || 0, 3), G('Taxi 4 aircraft', s => (s.calls.taxi || 0) + (s.calls.taxi_in || 0), 4), G('No runway conflicts', s => s.incursions, 0, true)],
    TWR: [G('Clear 4 departures for takeoff', s => s.takeoffs, 4), G('Land 4 arrivals', s => s.landings, 4), G('No runway conflicts', s => s.incursions, 0, true), G('No more than 1 go-around', s => s.ga, 1, true)],
    APP: [G('Establish 5 arrivals on the ILS', s => s.ils, 5), G('No loss of separation', s => s.los, 0, true), G('No low altitude alerts left standing', s => s.msaw || 0, 1, true), G('No more than 1 late handoff', s => s.missedHandoffs, 1, true)],
  };
  const DEN = new Proxy({ CYVR: 'medium', EGLL: 'medium' }, { get: (o, k) => o[k] || 'light' });
  const check = (apt, pos) => ({
    id: `ck_${apt}_${pos}`, check: true, apt, name: `${APT_NAME(apt)} ${POSNAME[pos]} checkride`, pos: [pos], den: DEN[apt] || 'medium', min: pos === 'APP' ? 25 : 18, coach: 'auto',
    finals: pos === 'TWR' ? [8, 15] : null,
    brief: `An examiner sits next to you on ${POSNAME[pos]} at ${APT_NAME(apt)}. Work the position to the standard: the goals below, nothing broken. Pass and you hold the rating.`,
    goals: GOALS[pos],
  });
  const APT_NAME = k => (AIRPORTS[k] && AIRPORTS[k].name) || k;

  const Career = {
    rated(apt, pos) { return !!(Profile.d.ratings || {})[`ck_${apt}_${pos}`]; },
    open(apt, pos) {
      const i = ORDER.indexOf(apt), j = POS.indexOf(pos);
      return (j === 0 || this.rated(apt, POS[j - 1])) && (i <= 0 || this.rated(ORDER[i - 1], pos));
    },
    title() {
      const n = Object.keys(Profile.d.ratings || {}).length;
      return n >= ORDER.length * 4 ? 'Fully rated, every airport' : n >= 12 ? 'Approach rated' : n >= 8 ? 'Tower rated' : n >= 4 ? 'Ground rated' : n >= 1 ? 'Clearance rated' : 'Student';
    },
    show() {
      const P = Profile.d, apts = ORDER.filter(k => AIRPORTS[k]);
      overlay(`<div class="modal" role="dialog" aria-labelledby="kTitle">
        <div class="hero"><div><div class="wm">RATINGS</div><h1 id="kTitle">${this.title()}.</h1><p>Pass a checkride to hold a position at an airport: Clearance, then Ground, Tower and Approach. A position at the next airport needs it here first.</p></div></div>
        <div class="rgrid"><span></span>${POS.map(p => `<b>${POSNAME[p]}</b>`).join('')}
        ${apts.map(a => `<b class="ra">${APT_NAME(a)}<em>${AIRPORTS[a].size}</em></b>${POS.map(p => { const r = this.rated(a, p), o = this.open(a, p);
          return `<button class="rcell${r ? ' got' : o ? '' : ' locked'}" data-a="${a}" data-p="${p}" ${o || r ? '' : 'disabled'}>${r ? '✓ Rated' + (P.best[`ck_${a}_${p}`] ? `<em>${P.best[`ck_${a}_${p}`].toLocaleString()}</em>` : '') : o ? 'Checkride' : 'Locked'}</button>`; }).join('')}`).join('')}</div>
        <div class="foot"><button class="cbtn" id="backBtn">Back to menu</button><button class="cbtn" id="lbBtn">Leaderboard</button></div>
      </div>`);
      document.querySelector('#backBtn').onclick = () => showMenu();
      document.querySelector('#lbBtn').onclick = () => this.board();
      document.querySelectorAll('.rcell:not(.locked)').forEach(b => b.onclick = () => showBrief(check(b.dataset.a, b.dataset.p)));
    },
    // a shift ended: record the rating, and post the score to the board
    done(m, win, stars) {
      const P = Profile.d;
      if (m.check && win) { P.ratings = P.ratings || {}; if (!P.ratings[m.id]) { P.ratings[m.id] = Date.now(); UI.log('SYS', `You now hold the ${POSNAME[m.pos[0]]} rating at ${APT_NAME(m.apt)}.`, 'tip'); } Profile.save(); }
      if (win && P.name) fetch('api/board', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: m.id, name: P.name, score: Math.max(0, Math.round(S.score)), stars }) }).catch(() => { });
    },
    async board() {
      const P = Profile.d;
      let d = {}; try { d = await (await fetch('api/board', { cache: 'no-store' })).json(); } catch (e) { }
      const names = { ...Object.fromEntries(MISSIONS.map(m => [m.id, m.name])) };
      for (const a of ORDER) for (const p of POS) names[`ck_${a}_${p}`] = `${APT_NAME(a)} · ${POSNAME[p]} checkride`;
      const ids = Object.keys(d).filter(k => names[k]).sort((a, b) => Object.keys(names).indexOf(a) - Object.keys(names).indexOf(b));
      overlay(`<div class="modal" role="dialog" aria-labelledby="lbTitle">
        <div class="hero"><div><div class="wm">LEADERBOARD</div><h1 id="lbTitle">Best shifts on this server.</h1><p>Your best score in each mission and checkride is posted when you pass it, under the name below.</p></div></div>
        <div class="vrow"><label for="lbName">Your name on the board</label><input id="lbName" maxlength="24" value="${esc(P.name || '')}" placeholder="Leave empty to stay off the board"></div>
        <div class="lb">${ids.length ? ids.map(k => `<div class="lbt"><h3>${esc(names[k])}</h3><ol>${d[k].slice(0, 10).map(e => `<li${e.name === P.name ? ' class="me"' : ''}><span>${esc(e.name)}</span><b>${e.score.toLocaleString()}</b><em>${'★'.repeat(e.stars || 0)}</em></li>`).join('')}</ol></div>`).join('') : '<p class="sm">No scores yet. Pass a mission or a checkride with a name set to be the first.</p>'}</div>
        <div class="foot"><button class="cbtn" id="backBtn">Back to menu</button><button class="cbtn" id="rtBtn">Ratings</button></div>
      </div>`);
      const nm = document.querySelector('#lbName');
      nm.onchange = () => { P.name = nm.value.trim().slice(0, 24); Profile.save(); };
      document.querySelector('#backBtn').onclick = () => showMenu();
      document.querySelector('#rtBtn').onclick = () => this.show();
    },
  };
  window.Career = Career;
  // the airport picker in the setup: search, region and size
  const pick = { r: 'All', z: null };
  const filter = () => {
    const q = (document.querySelector('#aptQ') || {}).value || '';
    document.querySelectorAll('.apts .apt').forEach(l => {
      const ok = (pick.r === 'All' || l.dataset.region === pick.r) && (!pick.z || l.dataset.size === pick.z) && (!q || l.dataset.q.includes(q.toLowerCase().trim()));
      l.classList.toggle('hidden', !ok);
    });
  };
  document.addEventListener('input', e => { if (e.target.id === 'aptQ') filter(); });
  document.addEventListener('click', e => {
    const r = e.target.closest('.aptr'), z = e.target.closest('.aptz'); if (!r && !z) return;
    e.preventDefault();
    if (r) { pick.r = r.dataset.r; document.querySelectorAll('.aptr').forEach(b => b.classList.toggle('on', b === r)); }
    if (z) { pick.z = pick.z === z.dataset.z ? null : z.dataset.z; document.querySelectorAll('.aptz').forEach(b => b.classList.toggle('on', b.dataset.z === pick.z)); }
    filter();
  });
})();
