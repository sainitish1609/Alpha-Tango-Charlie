'use strict';
/* ==========================================================================
   VECTOR — Part 4: living crews
   Every aircraft gets a crew: who is on the radio, where they're from, how their day is going,
   how many souls and how much fuel they have. Claude writes what that crew says (always checked
   against the sim), a real recorded speaker's voice speaks it (free local Piper voices, or ElevenLabs), and the audio goes through a
   VHF radio chain: band-limited, compressed, with the cockpit behind the mic and a weaker
   signal the farther out they are.
   Without the local server (or without keys) the game falls back to its built-in pilots.
   ========================================================================== */
const Crew = (() => {
  const st = { server: false, brain: false, voice: false, mock: false, model: '', ttsModel: '', cast: [], castErr: '' };
  const pref = { brain: true, voice: true };
  try { Object.assign(pref, JSON.parse(localStorage.getItem('vector_crew') || '{}')); } catch (e) { }
  const usedVoices = new Map(); // voice id -> callsign, so two aircraft on frequency don't share a voice
  const ctlVoice = {};
  let cur = null; // the transmission playing now

  /* ---------- server ---------- */
  async function post(path, data, ms, raw) {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: ctl.signal });
      if (!r.ok) return null;
      return raw ? await r.arrayBuffer() : await r.json();
    } catch (e) { return null; } finally { clearTimeout(tm); }
  }
  async function connect() {
    if (location.protocol === 'file:') return;
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (!r.ok) return;
      const h = await r.json();
      Object.assign(st, { server: true, brain: !!h.brain, backend: h.backend, problem: h.problem || '', voice: !!h.voice, engine: h.voiceEngine, voiceProblem: h.voiceProblem || '', mock: !!h.mock, model: h.model, ttsModel: h.ttsModel });
      if (st.voice) {
        const v = await fetch('/api/voices').then(r => r.json()).catch(() => ({ voices: [], error: 'unreachable' }));
        st.cast = (v.voices || []).filter(x => !/asmr|whisper|child|kid|cartoon|animation|meditat|santa/.test(x.desc + ' ' + x.use + ' ' + x.name.toLowerCase()));
        st.castErr = v.error || (st.cast.length ? '' : st.engine === 'local' ? 'local voices did not load' : 'no voices in your ElevenLabs account');
        if (!st.cast.length) st.voice = false;
      }
    } catch (e) { }
    refreshMenu();
  }
  function refreshMenu() { const el = document.getElementById('crewStatus'); if (el) el.outerHTML = statusHtml(); }

  /* ---------- who is flying ---------- */
  const REGION = { BAW: 'gb', VIR: 'gb', EZY: 'gb', EXS: 'gb', TOM: 'gb', SHT: 'gb', EIN: 'ie', RYR: 'ie', QFA: 'au', VOZ: 'au', JST: 'au', ANZ: 'nz', AIC: 'in', IGO: 'in', SAA: 'za', ACA: 'ca', WJA: 'ca', JZA: 'ca', ROU: 'ca', TSC: 'ca', SIA: 'sg', DLH: 'de', EWG: 'de', CFG: 'de', AFR: 'fr', KLM: 'nl', IBE: 'es', VLG: 'es', AZA: 'it', ITY: 'it', SWR: 'ch', AUA: 'at', SAS: 'se', FIN: 'fi', TAP: 'pt', THY: 'tr', JAL: 'jp', ANA: 'jp', KAL: 'kr', AAR: 'kr', CPA: 'hk', SVA: 'sa', AMX: 'mx', VIV: 'mx', AVA: 'co', LAN: 'cl', TAM: 'br', GLO: 'br', ELY: 'il', CES: 'cn', CCA: 'cn', CSN: 'cn', EVA: 'tw', CAL: 'tw', LOT: 'pl', ICE: 'is', AEA: 'es' };
  const INTL = ['gb', 'au', 'za', 'in', 'us', 'nz', 'ie', 'ae']; // Gulf carriers hire everywhere
  const LANG = { de: 'German', at: 'Austrian German', ch: 'Swiss German', fr: 'French', nl: 'Dutch', es: 'Spanish', mx: 'Mexican Spanish', co: 'Colombian Spanish', cl: 'Chilean Spanish', it: 'Italian', se: 'Swedish', fi: 'Finnish', pt: 'Portuguese', br: 'Brazilian Portuguese', tr: 'Turkish', jp: 'Japanese', kr: 'Korean', hk: 'Cantonese', cn: 'Mandarin', tw: 'Mandarin', ae: 'Arabic', sa: 'Arabic', il: 'Hebrew', pl: 'Polish', is: 'Icelandic' };
  const HOME = { us: ['Texas', 'New York', 'the Midwest', 'California', 'the South', 'Boston', 'Colorado', 'the Pacific Northwest'], gb: ['London', 'Manchester', 'Scotland', 'Yorkshire', 'the West Country'], au: ['Sydney', 'Melbourne', 'Queensland'], ie: ['Dublin', 'Cork'], ca: ['Toronto', 'Montreal', 'Calgary'], in: ['Mumbai', 'Delhi', 'Bangalore'], za: ['Johannesburg', 'Cape Town'], nz: ['Auckland'] };
  const ACCENT = { us: ['american'], gb: ['english', 'british', 'scottish', 'welsh', 'northern irish'], ie: ['irish', 'northern irish'], au: ['australian'], nz: ['new zealand', 'australian'], za: ['south african'], ca: ['canadian', 'american'], in: ['indian'], sg: ['singapor', 'asian', 'indian'], de: ['german'], at: ['german', 'austrian'], ch: ['swiss', 'german'], fr: ['french'], nl: ['dutch'], es: ['spanish'], mx: ['mexican', 'latin', 'spanish'], co: ['latin', 'spanish'], cl: ['latin', 'spanish'], it: ['italian'], se: ['swedish', 'scandinavian'], fi: ['finnish', 'swedish', 'scandinavian'], pt: ['portuguese'], br: ['brazilian', 'portuguese'], tr: ['turkish'], jp: ['japanese'], kr: ['korean'], hk: ['chinese', 'asian'], cn: ['chinese', 'asian'], tw: ['chinese', 'asian'], ae: ['arab', 'middle east'], sa: ['arab', 'middle east'], il: ['israeli'], pl: ['polish'], is: ['icelandic', 'scandinavian'] };
  const MOODS = [
    { t: 'calm, experienced captain who has done this ten thousand times', stab: 0.6, style: 0.12, speed: 1.02 },
    { t: 'friendly, chatty first officer who likes a bit of warmth on the radio', stab: 0.38, style: 0.38, speed: 1.06 },
    { t: 'dry, terse veteran who uses the fewest words possible', stab: 0.62, style: 0.08, speed: 1.1 },
    { t: 'tired first officer at the end of a long duty day', stab: 0.5, style: 0.18, speed: 0.97 },
    { t: 'upbeat, polite first officer having a good day', stab: 0.42, style: 0.3, speed: 1.06 },
    { t: 'precise, formal captain who is very by-the-book', stab: 0.6, style: 0.1, speed: 1.0 },
    { t: 'newer first officer, competent but a little careful and quick to confirm', stab: 0.4, style: 0.22, speed: 1.04 },
    { t: 'laid-back, easygoing first officer', stab: 0.45, style: 0.3, speed: 1.0 },
  ];
  const seat = n => Math.floor(Math.random() * n);

  function crew(ac) {
    if (ac.crew) return ac.crew;
    const code = ac.al.code;
    let region = REGION[code] || (['UAE', 'QTR', 'ETD'].includes(code) ? pick(INTL) : US_GROUP.has(code) ? 'us' : ac.al.dyn ? 'us' : 'us');
    let mood = pick(MOODS);
    if (['FDX', 'UPS'].includes(code) && Math.random() < 0.6) mood = pick([MOODS[2], MOODS[3], MOODS[0]]);
    if (['SWA', 'JBU'].includes(code) && Math.random() < 0.5) mood = pick([MOODS[1], MOODS[7], MOODS[4]]);
    const captain = /captain/.test(mood.t);
    const gender = Math.random() < 0.24 ? 'female' : 'male';
    const age = captain ? pick(['middle aged', 'old', 'middle aged']) : pick(['young', 'young', 'middle aged']);
    const cargo = ['FDX', 'UPS'].includes(code), type = ac.type;
    const souls = cargo ? rint(2, 4) : type === 'A388' ? rint(420, 517) : ac.perf.heavy ? rint(210, 360) : /E17|CRJ/.test(type) ? rint(48, 76) : /A22/.test(type) ? rint(95, 135) : rint(120, 189);
    let fuelMin = ac.kind === 'arr' ? rint(70, 165) : 0;
    if (ac.emg && /fuel/.test(ac.emg.t)) fuelMin = rint(24, 34);
    const fuel = ac.kind === 'arr' ? `${Math.floor(fuelMin / 60) ? Math.floor(fuelMin / 60) + ' hour' + (fuelMin >= 120 ? 's' : '') + ' ' : ''}${fuelMin % 60} minutes of fuel` : `full fuel for the trip to ${ac.dest ? ac.dest.name : 'destination'}`;
    const lang = LANG[region];
    const persona = {
      on_the_radio: `${captain ? 'the captain' : 'the first officer'}, ${gender === 'female' ? 'a woman' : 'a man'}, ${age === 'young' ? 'in their late twenties' : age === 'old' ? 'in their late fifties' : 'in their forties'}`,
      temperament: mood.t,
      background: lang ? `${lang} is their first language; fluent aviation English, plainer and slightly formal everyday English` : `native English speaker from ${pick(HOME[region] || HOME.us)}`,
      ...(cargo ? { note: 'cargo flight, crew of ' + souls } : {}),
    };
    ac.crew = { region, mood, gender, age, persona, souls, fuel, convo: [], mic: { lp: rnd(2550, 3350), drive: rnd(1.2, 3.2), noise: rnd(0.6, 1.4) } };
    ac.crew.voice = castVoice(ac);
    return ac.crew;
  }

  // the controller's own accent follows the airport (VATSIM live at EGLL sounds British)
  function localRegion() {
    const i = APT.icao || 'K';
    const m = [[/^K/, 'us'], [/^C/, 'ca'], [/^EG/, 'gb'], [/^EI/, 'ie'], [/^Y/, 'au'], [/^NZ/, 'nz'], [/^V[AEIO]/, 'in'], [/^ED/, 'de'], [/^LF/, 'fr'], [/^EH/, 'nl'], [/^LE/, 'es'], [/^LI/, 'it'], [/^O[MTO]/, 'ae'], [/^FA/, 'za'], [/^WS/, 'sg']].find(([re]) => re.test(i));
    return m ? m[1] : 'us';
  }

  function score(v, region, gender, age) {
    let s = Math.random() * 0.8;
    const acc = ACCENT[region] || ['american'];
    const hay = v.accent + ' ' + v.desc;
    acc.forEach((k, i) => { if (hay.includes(k)) s += 6 - i; });
    if (!s || s < 1) { if (/transatlantic|neutral|standard/.test(hay)) s += 1.5; }
    if (v.gender === gender) s += 3.5; else if (v.gender) s -= 3;
    if (age && v.age && v.age.includes(age.split(' ')[0])) s += 1;
    if (/conversational|narrat|social|informative|news/.test(v.use + ' ' + v.desc)) s += 0.6;
    if (/character|game|villain|dramatic|deep.*trailer/.test(v.use + ' ' + v.desc)) s -= 1.5;
    if (v.mine) s += 0.4;
    return s;
  }
  function castVoice(ac) {
    if (!st.cast.length) return null;
    const c = ac.crew;
    const live = new Set(S.aircraft.filter(a => a !== ac && a.crew && a.crew.voice).map(a => a.crew.voice));
    Object.values(ctlVoice).forEach(v => live.add(v));
    const ranked = st.cast.map(v => ({ v, s: score(v, c.region, c.gender, c.age) - (live.has(v.id) ? 5 : 0) })).sort((a, b) => b.s - a.s);
    return ranked[0].v.id;
  }
  function controllerVoice(pos) {
    if (ctlVoice[pos] || !st.cast.length) return ctlVoice[pos] || null;
    const taken = new Set(Object.values(ctlVoice));
    const g = pos === 'TWR' || pos === 'DEL' ? (Math.random() < 0.5 ? 'female' : 'male') : (Math.random() < 0.3 ? 'female' : 'male');
    const ranked = st.cast.map(v => ({ v, s: score(v, localRegion(), g, 'middle aged') - (taken.has(v.id) ? 8 : 0) })).sort((a, b) => b.s - a.s);
    return (ctlVoice[pos] = ranked[0].v.id);
  }

  /* ---------- what the crew knows ---------- */
  const PHASE = { gate: 'parked at the gate', pushing: 'pushing back from the gate', taxi_wait: 'pushed back, waiting to taxi', taxiing: 'taxiing out to the runway', holdshort: 'holding short of the departure runway', lineup_move: 'lining up on the runway', lineup: 'lined up on the runway', takeoff: 'on the takeoff roll', climb: 'climbing out after takeoff', dep: 'climbing out on departure', arr: 'inbound, descending toward the airport', ga: 'going around (missed approach)', rollout: 'rolling out after landing', exiting: 'exiting the runway', vacated: 'clear of the runway', taxiing_in: 'taxiing in to the gate', parked: 'parked at the gate' };
  function phaseText(ac) {
    let p = PHASE[ac.phase] || ac.phase;
    if (ac.kind === 'arr' && !onGround(ac)) {
      const d = Math.round(locGeom(ac.x, ac.y).d);
      if (ac.loc) p = `established on the ILS runway ${arrRwyName()}, ${Math.max(1, d)} miles out${ac.landClr ? ', cleared to land' : ''}`;
      else if (ac.ils) p += `, cleared for the ILS ${arrRwyName()}`;
    }
    return p;
  }
  function context(ac) {
    const c = crew(ac), air = !onGround(ac) && ac.phase !== 'gate';
    return {
      callsign: ac.cs, said_as: csSpoken(ac), airline: ac.al.tel, aircraft: ac.type + (ac.perf.heavy ? ' (heavy)' : ''),
      flight: ac.kind === 'dep' ? `departing ${APT.name} for ${ac.dest ? ac.dest.name : ''}` : `arriving at ${APT.name} from ${ac.orig ? ac.orig.name : ''}`,
      ...(ac.kind === 'dep' ? { filed_departure: ac.sid + ' departure', initial_altitude_ft: ac.clearedAlt, departure_frequency: FREQ.APP } : { arrival: ac.star + ' arrival' }),
      now: phaseText(ac),
      ...(air ? { altitude_ft: Math.round(ac.alt / 100) * 100, heading: magOf(ac.hdg), speed_kt: Math.round(ac.spd / 10) * 10, assigned: { heading: magOf(ac.tgtHdg), altitude_ft: Math.round(ac.tgtAlt / 100) * 100 } } : { gate: ac.gate }),
      talking_to: `${APT.tel} ${POSNAME[ac.freq] || ac.freq}`,
      souls_on_board: c.souls, fuel: c.fuel,
      emergency: ac.emg ? ac.emg.t + (ac.emg.pan ? ' (PAN, urgency)' : ' (MAYDAY)') : 'none', squawk: ac.squawk,
      situation: ac.sitText || 'normal flight',
      weather: window.Env && Env.wx ? `${Env.plain()} (METAR ${Env.wx.raw})` : (S.lvp ? 'fog, low visibility procedures in force' : 'good visibility') + (window.Sit && Sit.cells.length ? ', thunderstorms in the area' : '') + (S.wind.gust ? `, gusting ${S.wind.gust} knots` : ''),
      airport: { name: APT.name, atis: S.atis, wind: typeof windSay === 'function' ? windSay() : `${pad3(S.wind.dir)} at ${S.wind.spd}`, altimeter: window.Env && Env.wx ? Env.pressureSay(false) : S.altim, departures: depRwyName(), arrivals: arrRwyName() },
      phraseology: typeof REGION !== 'undefined' && REGION.phrase === 'icao' ? `ICAO (UK and European style): "altitude 6000 feet", flight levels above ${REGION.ta} ft, "QNH", units by name (${Object.values(REGION.fac || {}).filter((v, i, a) => a.indexOf(v) === i).join(', ')})` : 'North American (FAA / Transport Canada)',
      time_of_day: dayPart(),
      persona: c.persona,
      recent_exchanges: c.convo.slice(-6),
    };
  }
  function remember(ac, who, text) {
    const c = crew(ac), line = `${who}: ${text}`;
    if (c.convo[c.convo.length - 1] === line) return; // a blocked call said again
    c.convo.push(line); if (c.convo.length > 10) c.convo.splice(0, c.convo.length - 10);
  }

  /* ---------- Claude ---------- */
  const thinking = () => st.brain && pref.brain && S.running;
  const numsOf = s => (String(s).match(/\d+(?:\.\d+)?/g) || []).map(n => n.replace(/^0+(?=\d)/, ''));
  function keeps(text, must, cs) {
    if (!text) return false;
    const said = numsOf(text);
    if (numsOf(must).some(n => !said.includes(n))) return false;
    if (must && cs && must.includes(cs) && !text.includes(cs)) return false;
    return true;
  }
  async function say(ac, b, ms) {
    // the crew already answered while working out what you meant; if that answer misses something
    // the sim needs, they say the sim's exact readback rather than make you wait for a second try
    if (b.task === 'given') return keeps(b.text, b.must_say, ac.cs) ? { text: b.text, delivery: b.delivery } : null;
    const r = await post('/api/brain', { task: b.task, callsign: ac.cs, must_say: b.must_say || '', controller: b.controller || '', reminder: !!b.reminder, idea: b.idea || '', context: context(ac) }, ms || 6500);
    if (!r || !r.text) return null;
    if (b.must_say && !keeps(r.text, b.must_say, ac.cs)) return null;
    return r;
  }

  // The phrase parser couldn't read the controller. Ask who was called and what was meant.
  async function interpret(raw, hint) {
    const list = S.aircraft.filter(a => S.staffed[a.freq] || a === hint);
    if (!list.length) return null;
    const aircraft = list.map(a => ({ callsign: a.cs, said_as: csSpoken(a), type: a.type, flight: a.kind === 'dep' ? 'departure to ' + (a.dest ? a.dest.name : '') : 'arrival from ' + (a.orig ? a.orig.name : ''), now: phaseText(a), on: POSNAME[a.freq], waiting_for: a.request && a.request.called && REQ[a.request.type] ? REQ[a.request.type].label : 'nothing', ...(onGround(a) ? { gate: a.gate } : { altitude_ft: Math.round(a.alt / 100) * 100, heading: Math.round(a.hdg) }) }));
    const focus = hint || S.sel;
    const ctx = { aircraft_on_your_frequencies: aircraft, fixes: Object.keys(FIXES), frequencies: Object.fromEntries(Object.keys(FREQ).map(k => [POSNAME[k], FREQ[k]])), runways: { departures: depRwyName(), arrivals: arrRwyName() }, gates: '1-12' };
    if (focus && S.aircraft.includes(focus)) ctx.addressed_aircraft_details = context(focus);
    const r = await post('/api/brain', { task: 'interpret', controller: raw, selected: S.sel ? S.sel.cs : '', context: ctx }, 7000);
    if (!r) return null;
    const ac = (r.callsign && S.aircraft.find(a => a.cs === r.callsign.toUpperCase().replace(/\s+/g, ''))) || hint || null;
    if (!ac) return null;
    let cmds = (r.commands || []).map(toCmd).filter(Boolean);
    // a squawk said inside a clearance belongs to the clearance (one readback, one code)
    const clr = cmds.find(c => c.k === 'clr'), sq = cmds.find(c => c.k === 'squawk');
    if (clr && sq) { clr.squawk = clr.squawk || sq.code; cmds = cmds.filter(c => c !== sq); }
    const alt = cmds.find(c => c.k === 'alt');
    if (clr && alt) { clr.alt = clr.alt || alt.alt; cmds = cmds.filter(c => c !== alt); }
    return { ac, named: !!r.callsign, cmds, reply: r.reply || '', delivery: r.delivery };
  }
  function toCmd(c) {
    const rwy = /^(0[1-9]|[12]\d|3[0-6])[LRC]?$/.test((c.rwy || '').toUpperCase()) ? c.rwy.toUpperCase() : null;
    switch (c.k) {
      case 'clr': return { k: 'clr', squawk: /^[0-7]{4}$/.test(c.code) ? c.code : null, alt: c.alt >= 1000 && c.alt <= 45000 ? c.alt : null };
      case 'taxi': { const via = (c.via || []).map(v => String(v).toUpperCase()).filter(v => /^[A-Z]\d?$/.test(v)); return { k: 'taxi', rwy, gate: c.gate > 0 ? c.gate : null, ramp: c.gate > 0, via: via.length ? via : null }; }
      case 'luaw': case 'takeoff': case 'land': case 'ils': return { k: c.k, rwy };
      case 'hdg': return c.h >= 1 && c.h <= 360 ? { k: 'hdg', h: c.h, dir: c.dir || null } : null;
      case 'alt': return c.alt >= 1000 && c.alt <= 45000 ? { k: 'alt', alt: c.alt } : null;
      case 'spd': return c.v >= 120 && c.v <= 350 ? { k: 'spd', v: c.v } : null;
      case 'direct': return FIXES[(c.fix || '').toUpperCase()] ? { k: 'direct', fix: c.fix.toUpperCase() } : null;
      case 'contact': return c.to ? { k: 'contact', to: c.to } : null;
      case 'squawk': return /^[0-7]{4}$/.test(c.code) ? { k: 'squawk', code: c.code } : null;
      default: return { k: c.k };
    }
  }

  /* ---------- voices ---------- */
  const DELIVERY_FX = { urgent: { stab: -0.22, speed: 0.06 }, stressed: { stab: -0.18, speed: 0.04 }, hurried: { speed: 0.08 }, tired: { speed: -0.04 }, terse: { speed: 0.04 }, amused: { style: 0.15 }, friendly: { style: 0.1 } };
  function voiceFor(item) {
    if (item.kind === 'pilot') {
      if (!Radio.pilotVoices) return null;
      const c = crew(item.ac);
      if (!c.voice) c.voice = castVoice(item.ac);
      const fx = DELIVERY_FX[item.delivery] || {};
      const emg = item.ac.emg && !item.ac.flags.wentAround;
      return { voice: c.voice, stability: c.mood.stab + (fx.stab || 0) - (emg ? 0.1 : 0), style: c.mood.style + (fx.style || 0), speed: c.mood.speed + (fx.speed || 0) + (S.speed >= 4 ? 0.06 : 0) };
    }
    if (item.kind === 'ai') return { voice: controllerVoice(item.pos), stability: 0.62, style: 0.08, speed: 1.12 };
    if (item.kind === 'atis') return { voice: controllerVoice('ATIS'), stability: 0.85, style: 0, speed: 1.0 };
    return null;
  }
  async function tts(item) {
    if (!(st.voice && pref.voice)) return null;
    const v = voiceFor(item); if (!v || !v.voice) return null;
    const buf = await post('/api/tts', { text: radioText(item), delivery: item.delivery || 'neutral', ...v }, 9000, true);
    if (!buf) return null;
    Radio.audio(); if (!Radio.ctx) return null;
    try { return await Radio.ctx.decodeAudioData(buf); } catch (e) { return null; }
  }

  // Called for every transmission queued on the frequency you hear.
  function prepare(item) {
    const wantsBrain = item.kind === 'pilot' && item.brain && thinking();
    const wantsVoice = st.voice && pref.voice && S.running;
    if (item.kind === 'pilot') {
      const os = item.onStart, ac = item.ac;
      item.onStart = () => { remember(ac, 'you (pilot)', item.text); if (os) os(); };
    }
    if (!wantsBrain && !wantsVoice) return;
    item.prep = (async () => {
      if (wantsBrain) {
        // a readback can't keep the controller waiting: if the crew's words are slow, the sim's words go out
        const r = await say(item.ac, item.brain, item.prio === 0 ? (st.backend === 'cli' ? 3800 : 3000) : 7000).catch(() => null);
        if (r && r.text) { item.text = r.text; item.delivery = r.delivery; }
      }
      if (wantsVoice) item.audio = await tts(item).catch(() => null);
    })().finally(() => { item.prepDone = true; });
  }

  /* ---------- the radio ---------- */
  function shaper(c, drive) {
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; curve[i] = Math.tanh(drive * x) / Math.tanh(drive); }
    const s = c.createWaveShaper(); s.curve = curve; s.oversample = '2x'; return s;
  }
  function play(item, done) {
    Radio.audio();
    const c = Radio.ctx; if (!c || !item.audio) return false;
    const ac = item.ac, mic = ac && ac.crew ? ac.crew.mic : { lp: 3000, drive: 1.6, noise: 0.5 };
    const nodes = [], at = c.currentTime + 0.09; // a beat between the key click and the first word
    const mk = n => (nodes.push(n), n);
    const input = mk(c.createGain());
    const hp = mk(c.createBiquadFilter()); hp.type = 'highpass'; hp.frequency.value = 330; hp.Q.value = 0.7;
    const pk = mk(c.createBiquadFilter()); pk.type = 'peaking'; pk.frequency.value = 1700; pk.gain.value = 5; pk.Q.value = 0.9;
    const lp = mk(c.createBiquadFilter()); lp.type = 'lowpass'; lp.frequency.value = item.kind === 'pilot' ? mic.lp : 3300; lp.Q.value = 0.8;
    const sh = mk(shaper(c, item.kind === 'pilot' ? mic.drive : 1.2));
    const comp = mk(c.createDynamicsCompressor()); comp.threshold.value = -30; comp.knee.value = 6; comp.ratio.value = 10; comp.attack.value = 0.003; comp.release.value = 0.15;
    const out = mk(c.createGain()); out.gain.value = item.kind === 'atis' ? 1.0 : 1.35;
    input.connect(hp); hp.connect(pk); pk.connect(lp); lp.connect(sh); sh.connect(comp); comp.connect(out); out.connect(window.Settings ? Settings.bus(item.kind === 'ai' ? 'ai' : 'pilots') : Radio.master); // the pilots' or AI controllers' volume
    const src = c.createBufferSource(); src.buffer = item.audio; src.connect(input);
    const srcs = [src];
    // what's behind the mic: engines and slipstream in flight, the APU at the gate
    if (item.kind === 'pilot' && Radio.noiseBuf) {
      const air = !onGround(ac), cab = c.createBufferSource(); cab.buffer = Radio.noiseBuf; cab.loop = true;
      const f = mk(c.createBiquadFilter()); f.type = 'lowpass'; f.frequency.value = air ? 900 : 500;
      const g = mk(c.createGain()); g.gain.value = (air ? 0.07 : ac.phase === 'gate' ? 0.025 : 0.04) * mic.noise;
      cab.connect(f); f.connect(g); g.connect(input); cab.start(c.currentTime, Math.random()); srcs.push(cab);
      // farther out = weaker signal, more hiss
      if (air && Radio.sfx) Radio.staticOn(1 + clamp(Math.hypot(ac.x, ac.y) / 22, 0, 1.6));
      // a master caution behind a mayday call
      if (ac.emg && item.brain && item.brain.task === 'call' && !ac.crew.chimed) {
        ac.crew.chimed = true;
        for (let i = 0; i < 3; i++) { const o = c.createOscillator(), og = mk(c.createGain()); o.type = 'square'; o.frequency.value = i % 2 ? 1300 : 980; og.gain.setValueAtTime(0, at + i * 0.35); og.gain.linearRampToValueAtTime(0.035, at + i * 0.35 + 0.01); og.gain.setValueAtTime(0.035, at + i * 0.35 + 0.22); og.gain.linearRampToValueAtTime(0, at + i * 0.35 + 0.24); o.connect(og); og.connect(input); o.start(at + i * 0.35); o.stop(at + i * 0.35 + 0.26); }
      }
    }
    src.onended = () => { if (cur && cur.src === src) { stop(); done(); } };
    src.start(at);
    cur = { src, srcs, nodes };
    return true;
  }
  function stop() {
    if (!cur) return;
    const k = cur; cur = null;
    k.srcs.forEach(s => { try { s.onended = null; s.stop(); } catch (e) { } });
    setTimeout(() => k.nodes.forEach(n => { try { n.disconnect(); } catch (e) { } }), 300);
  }

  /* ---------- quiet moments ---------- */
  // Real frequencies aren't only requests and readbacks: ride reports, "how many ahead of us", "field in sight".
  let nextChat = performance.now() + 60e3;
  function ideaFor(ac) {
    const d = Math.hypot(ac.x, ac.y);
    if (ac.kind === 'arr' && !onGround(ac) && !ac.loc) return pick([
      `a ride report for the controller (pick smooth, or light chop, as they descend through ${Math.round(ac.alt / 1000)} thousand)`,
      'asks whether to expect any holding or delays into the field',
      'asks how many aircraft are ahead of them in the sequence',
      ...(d < 16 ? ['reports the field in sight'] : []),
      ...(S.wind.spd > 12 ? ['asks for the latest wind at the field'] : []),
    ]);
    if (ac.kind === 'dep' && !onGround(ac) && ac.alt > 3000) return pick([
      'a ride report on the climb (smooth, or occasional light chop)',
      'asks for higher when able',
      `asks if a shortcut direct to ${ac.exitFix} is available`,
    ]);
    if (ac.phase === 'taxiing') return pick(['asks what number they are for departure', 'asks whether to expect any departure delay']);
    return null;
  }
  setInterval(() => {
    if (!S.running || S.paused || !thinking() || Voice.active) return;
    if (Channel.cur || Channel.q.length || Channel.now() - Channel.idleAt < 7 || performance.now() < nextChat) return;
    const cands = S.aircraft.filter(a => S.staffed[a.freq] && chanFor(a.freq) === Channel && !a.emg && !(a.request && a.request.called) && S.t - (a.lastTx || 0) > 45 && S.t - (a.chatAt || -999) > 300);
    nextChat = performance.now() + rnd(75, 150) * 1000 / Math.max(1, S.speed / 2);
    const ac = pick(cands.filter(a => ideaFor(a)));
    if (!ac) return;
    ac.chatAt = S.t;
    const idea = ideaFor(ac);
    say(ac, { task: 'chatter', idea }).then(r => {
      if (!r || !r.text || !S.aircraft.includes(ac) || Channel.q.length || Channel.cur) return;
      Channel.push({ kind: 'pilot', ac, text: r.text, delivery: r.delivery, prio: 1, valid: () => S.aircraft.includes(ac) && !(ac.request && ac.request.called) });
    });
  }, 1000);

  /* ---------- UI ---------- */
  function statusHtml() {
    if (!st.server) return `<div class="crewst" id="crewStatus"><i></i><span><b>Built-in pilots and browser voices.</b> For live crews with real human voices, start the game with <kbd>npm start</kbd> and open <b>http://localhost:8787</b> (see README).</span></div>`;
    if (st.mock) return `<div class="crewst" id="crewStatus"><i class="part"></i><span><b>Test mode:</b> stand-in crews and test tones, no API calls.</span></div>`;
    const parts = [];
    parts.push(st.brain ? `Claude (${esc(st.model)}${st.backend === 'cli' ? ', through Claude Code on your login' : ''}) writes every crew's words` : `AI crews off: ${esc(st.problem || 'install Claude Code, or add ANTHROPIC_API_KEY to .env')}`);
    parts.push(st.voice ? (st.engine === 'local' ? `free local voices on the game computer (${st.cast.length} real speakers: English, Scottish, Irish, American, Canadian, South African, Indian, Australian)` : `ElevenLabs voices them (${st.cast.length} voices in your cast)`) : `radio voices off: ${esc(st.castErr || st.voiceProblem || 'see the server window')}`);
    return `<div class="crewst" id="crewStatus"><i class="${st.brain && st.voice ? 'on' : st.brain || st.voice ? 'part' : ''}"></i><span><b>Live crews:</b> ${parts.join('; ')}.</span></div>`;
  }
  function setupHtml() {
    if (!st.server) return `<p class="sm">Live AI crews and real voices need the local server: run <kbd>npm start</kbd> and open http://localhost:8787.</p>`;
    const tg = (id, label, on, ok) => `<label>${label} <input type="checkbox" id="${id}" ${on && ok ? 'checked' : ''} ${ok ? '' : 'disabled'}></label>`;
    return `<div class="toggles" style="margin-top:8px">
      ${tg('optCrewAi', 'Live AI crews: natural, in-character pilots', pref.brain, st.brain)}
      ${tg('optCrewVoice', 'Real human voices on the radio', pref.voice, st.voice)}
    </div>`;
  }
  function readSetup() {
    const a = document.getElementById('optCrewAi'), v = document.getElementById('optCrewVoice');
    if (a && !a.disabled) pref.brain = a.checked;
    if (v && !v.disabled) pref.voice = v.checked;
    try { localStorage.setItem('vector_crew', JSON.stringify(pref)); } catch (e) { }
  }
  function reset() { stop(); for (const k in ctlVoice) delete ctlVoice[k]; usedVoices.clear(); nextChat = performance.now() + 50e3; }

  connect();
  return {
    st, pref, thinking, interpret, prepare, play, stop, reset, statusHtml, setupHtml, readSetup,
    heard: (ac, raw) => remember(ac, 'controller', raw), crew, context,
  };
})();
window.Crew = Crew;
