'use strict';
/* ==========================================================================
   Weather and light.
   - Weather is the airport's real METAR (live, refreshed every 5 minutes), or one the player picks
     (clear, cloudy, rain, thunderstorms, fog, snow, strong wind). Either way it is a METAR, read the
     same way, and everything in the game follows it:
       wind      runway direction, the wind in clearances and the ATIS, drift and crab in the air,
                 groundspeed on the takeoff roll and the landing roll, gust additives, wind limits
       visibility, RVR and cloud
                 low visibility procedures, visual approaches only in visual conditions
       weather   thunderstorms on the radar with deviation requests, wet or snowy runways (longer
                 landing rolls), rain and snow on the airfield, fog
       altimeter and temperature
                 ATIS, first contact with Approach, takeoff performance
   - Light is the real sky over the airport: the sun's position for the airport's place and the game
     clock (sunrise, day, golden hour, sunset, dusk, night), dimmed by cloud, rain and fog. At night the
     airfield lights come on: apron floodlights, the terminal, runway and taxiway lights, approach
     lights, stop bars, aircraft lights.
   ========================================================================== */
(function () {
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const mix = (a, b, t) => a + (b - a) * t;
  const PRESETS = { clear: 'Clear', cloudy: 'Cloudy', rain: 'Rain', storm: 'Thunderstorms', fog: 'Fog', snow: 'Snow', windy: 'Strong wind' };
  const TODS = { real: 'Real time', sunrise: 'Sunrise', day: 'Day', sunset: 'Sunset', night: 'Night' };

  /* ---------- reading a METAR ---------- */
  function parseMetar(raw) {
    const w = { raw, wind: { dir: 0, spd: 0, gust: 0, vrb: false }, vis: 9999, rvr: null, wx: [], clouds: [], temp: 15, dew: 10, qnh: 1013, altim: '2992', usesA: false };
    const toks = raw.replace(/=\s*$/, '').trim().split(/\s+/);
    let body = true;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (/^(RMK|TEMPO|BECMG|NOSIG|FM\d+)$/.test(t)) { body = false; }
      if (!body) continue;
      let m;
      if ((m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/.exec(t))) { const k = m[4] === 'MPS' ? 1.944 : 1; w.wind = { dir: m[1] === 'VRB' ? 0 : +m[1], spd: Math.round(+m[2] * k), gust: m[3] ? Math.round(+m[3] * k) : 0, vrb: m[1] === 'VRB' }; continue; }
      if (/^\d{3}V\d{3}$/.test(t)) continue;
      if (t === 'CAVOK') { w.vis = 9999; continue; }
      if (/^\d{4}$/.test(t) && i > 1) { w.vis = +t; continue; }
      if ((m = /^(P|M)?(\d+)?\/?(\d+)?SM$/.exec(t)) || (m = /^(P|M)?(\d+\/\d+)SM$/.exec(t))) {
        let v = 0; const s = t.replace(/^[PM]/, '').replace('SM', '');
        if (s.includes('/')) { const [a, b] = s.split('/'); v = +a / +b; if (/^\d+$/.test(toks[i - 1] || '')) v += +toks[i - 1]; } else v = +s;
        w.vis = Math.min(9999, Math.round(v * 1609)); continue;
      }
      if ((m = /^R\d{2}[LRC]?\/[PM]?(\d{4})/.exec(t))) { w.rvr = w.rvr == null ? +m[1] : Math.min(w.rvr, +m[1]); continue; }
      if ((m = /^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/.exec(t))) { w.clouds.push({ c: m[1], ft: +m[2] * 100, cb: m[3] || '' }); continue; }
      if (/^(NCD|NSC|SKC|CLR)$/.test(t)) continue;
      if ((m = /^(M?\d{2})\/(M?\d{2})?$/.exec(t))) { const n = s => s ? (s[0] === 'M' ? -1 : 1) * +s.replace('M', '') : null; w.temp = n(m[1]); w.dew = m[2] ? n(m[2]) : w.temp - 3; continue; }
      if ((m = /^A(\d{4})$/.exec(t))) { w.altim = m[1]; w.qnh = Math.round(+m[1] / 100 * 33.8639); w.usesA = true; continue; }
      if ((m = /^Q(\d{4})$/.exec(t))) { w.qnh = +m[1]; w.altim = String(Math.round(+m[1] * 2.953)).padStart(4, '0'); continue; }
      if (/^(\+|-|VC)?(MI|BC|PR|DR|BL|SH|TS|FZ)?((DZ|RA|SN|SG|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PO|SQ|FC|SS|DS)+)?$/.test(t) && /[A-Z]{2}/.test(t) && !/^(METAR|SPECI|AUTO|COR)$/.test(t) && !(i <= 1 && /^[A-Z]{4}$/.test(t)) || /^(TS|VCTS|VCSH|\+?FC)$/.test(t)) { w.wx.push(t); continue; }
    }
    const COVER = { FEW: 0.2, SCT: 0.45, BKN: 0.75, OVC: 1, VV: 1 };
    w.cover = w.clouds.reduce((a, c) => Math.max(a, COVER[c.c] || 0), 0);
    const ceil = w.clouds.filter(c => ['BKN', 'OVC', 'VV'].includes(c.c)).map(c => c.ft);
    w.ceiling = ceil.length ? Math.min(...ceil) : null;
    const has = re => w.wx.some(x => re.test(x));
    const inten = x => x[0] === '+' ? 1 : x[0] === '-' ? 0.35 : 0.65;
    const pr = w.wx.filter(x => /RA|DZ|SN|SG|PL|GR|GS|UP/.test(x) && !/^VC/.test(x));
    w.rain = pr.filter(x => /RA|DZ|UP/.test(x)).reduce((a, x) => Math.max(a, inten(x) * (/DZ/.test(x) ? 0.5 : 1)), 0);
    w.snow = pr.filter(x => /SN|SG|PL|GR|GS/.test(x)).reduce((a, x) => Math.max(a, inten(x)), 0);
    w.ts = has(/TS/) || w.clouds.some(c => c.cb === 'CB');
    w.fog = has(/FG/) ? 1 : has(/BR|HZ|FU/) ? 0.4 : 0;
    if (w.temp != null && w.temp <= 0 && w.rain) { w.snow = Math.max(w.snow, w.rain * 0.5); }
    return w;
  }

  /* ---------- the sun ---------- */
  // NOAA's simple solar position: elevation and azimuth (degrees, true) for a place and a time
  function sunAt(lat, lon, ms) {
    const d = ms / 864e5 - 10957.5; // days since J2000
    const g = rad((357.529 + 0.98560028 * d) % 360), q = (280.459 + 0.98564736 * d) % 360;
    const L = rad(q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)), e = rad(23.439 - 0.00000036 * d);
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24, lst = rad(((gmst * 15 + lon) % 360 + 360) % 360);
    const ha = lst - ra, la = rad(lat);
    const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
    const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
    return { el: deg(el), az: (deg(az) + 360) % 360 };
  }

  const Env = {
    mode: 'live', preset: 'clear', tod: 'real', PRESETS, TODS,
    wx: null, src: '', cache: {}, nextFetch: 0, fetching: false, L: null, Lt: -1, flash: 0, nextFlash: 0,
    load() { try { const s = JSON.parse(localStorage.getItem('vector_env') || 'null'); if (s) { this.mode = s.mode || 'live'; this.preset = s.preset || 'clear'; this.tod = s.tod || 'real'; } } catch (e) { } },
    save() { try { localStorage.setItem('vector_env', JSON.stringify({ mode: this.mode, preset: this.preset, tod: this.tod })); } catch (e) { } },
    icao() { return (window.Live && Live.on && Live.icao) || (AIRPORTS[S.airport] || AIRPORTS.CYVR).icao; },
    // a situation being practised that is really a kind of weather
    forced() {
      const list = (Mission.cur && Mission.cur.sit) || (window.Sit && Sit.practice !== 'mix' ? [Sit.practice] : []);
      return list.includes('lvp') ? 'fog' : list.includes('wx') ? 'storm' : null;
    },

    /* ---------- getting the weather ---------- */
    async fetchLive(icao) {
      const c = this.cache[icao];
      if (c && Date.now() - c.at < 4.5 * 60e3) return c.data;
      const r = await fetch('/api/wx/' + icao, { cache: 'no-store' });
      if (!r.ok) throw new Error('weather ' + r.status);
      const data = await r.json(); this.cache[icao] = { at: Date.now(), data }; return data;
    },
    prefetch() { const i = this.icao(); if (this.mode === 'live') this.fetchLive(i).catch(() => { }); },
    // a chosen weather, written as the METAR an observer would issue for it
    simMetar(kind, icao) {
      const z = new Date(), dd = String(z.getUTCDate()).padStart(2, '0'), hh = String(z.getUTCHours()).padStart(2, '0');
      const us = /^[KCP]/.test(icao), p = n => String(n).padStart(2, '0');
      const real = this.cache[icao] && this.cache[icao].data && parseMetar(this.cache[icao].data.raw);
      const wdir = real && !real.wind.vrb && real.wind.spd > 2 ? real.wind.dir : rint(0, 35) * 10 || 360;
      const qnh = rint(1002, 1024), alt = us ? 'A' + String(Math.round(qnh * 2.953)).padStart(4, '0') : 'Q' + qnh;
      const vis = v => us ? (v >= 9999 ? '10SM' : v >= 1609 ? Math.round(v / 1609) + 'SM' : '1/4SM') : String(v).padStart(4, '0');
      const W = (s, g) => `${pad3(wdir)}${p(s)}${g ? 'G' + p(g) : ''}KT`;
      const t0 = real ? real.temp : 15, TD = (t, spread) => { t = Math.round(t); const d = t - spread, f = v => (v < 0 ? 'M' : '') + p(Math.abs(v)); return `${f(t)}/${f(d)}`; }; // temperature near the real one, dew point never above it
      const rw = (() => { try { const g = norm360(wdir - ROT), fl = S.flowPref === 'auto' ? (Math.abs(hdgDiff(g, 270)) <= 90 ? 'W' : 'E') : (S.flowPref === 'E' ? 'E' : 'W'), R0 = RWY[S.rwyArr] || RWY.S || RWY.N; return 'R' + R0.names[fl] + '/'; } catch (e) { return 'R27/'; } })(); // the runway in use
      const body = {
        clear: `${W(rint(4, 10))} ${vis(9999)} FEW${p(rint(30, 50))}0 ${TD(t0 + 2, rint(6, 12))}`,
        cloudy: `${W(rint(6, 14))} ${vis(9999)} BKN0${p(rint(12, 25))} OVC0${p(rint(30, 45))} ${TD(t0, rint(2, 5))}`,
        rain: `${W(rint(10, 18))} ${vis(rint(3, 6) * 1000)} RA BKN0${p(rint(8, 14))} OVC0${p(rint(20, 30))} ${TD(Math.max(3, t0 - 3), rint(0, 2))}`,
        storm: `${W(rint(16, 22), rint(30, 38))} ${vis(4000)} +TSRA BKN0${p(rint(18, 25))}CB OVC0${p(rint(40, 60))} ${TD(Math.max(12, t0), rint(2, 4))}`,
        fog: `${W(rint(2, 4))} ${vis(rint(2, 4) * 100)} ${rw}0${rint(300, 450)} ${t0 <= 0 ? 'FZFG' : 'FG'} VV001 ${TD(Math.min(t0, 12), 0)}`,
        snow: `${W(rint(8, 14))} ${vis(rint(15, 30) * 100)} SN OVC0${p(rint(8, 12))} ${TD(Math.min(t0, -1), rint(1, 3))}`,
        windy: `${W(rint(24, 30), rint(36, 44))} ${vis(9999)} SCT0${p(rint(25, 40))} ${TD(t0, rint(5, 9))}`,
      }[kind] || '';
      return `${icao} ${dd}${hh}50Z ${body} ${alt}`;
    },
    // the weather for a new shift: live if we have it (fetched while the player was in the menus), else chosen
    async begin() {
      const icao = this.icao(), f = this.forced();
      let raw = null, src = 'sim';
      if (!f && this.mode === 'live') {
        const c = this.cache[icao];
        if (c) { raw = c.data.raw; src = 'live'; }
        else { this.fetchLive(icao).then(d => { if (S.running && this.icao() === icao && this.src !== 'live') this.update(d.raw, 'live', false); }).catch(() => UI.log('SYS', `No live weather for ${icao} right now, so the shift uses simulated weather.`, 'tip')); }
      }
      if (!raw) raw = this.simMetar(f || (this.mode === 'live' ? 'clear' : this.preset), icao);
      this.update(raw, src, true);
      this.nextFetch = S.t + 300;
    },
    // a weather report takes effect: at the start of a shift it also picks the runway direction
    update(raw, src, atStart) {
      const w = parseMetar(raw), old = this.wx;
      if (old && old.raw === raw) return;
      this.wx = w; this.src = src; S.metar = raw;
      const real = w.wind.dir, g = norm360(real - ROT);
      if (atStart && S.flowPref === 'auto') {
        // into the wind; an airport with a preferred runway (Salzburg: the ILS is on 15 only) keeps it up to 10 kt of tailwind
        const pf = LAYOUT.prefFlow, tail = pf ? -(w.wind.vrb ? 0 : w.wind.spd) * Math.cos((g - (pf === 'W' ? 270 : 90)) * Math.PI / 180) : 99;
        if (pf && tail <= 10) { S.flow = pf; applyRunways(); }
        else if (!w.wind.vrb && w.wind.spd >= 3) { S.flow = Math.abs(hdgDiff(g, 270)) <= 90 ? 'W' : 'E'; applyRunways(); }
      }
      S.wind = { dir: w.wind.vrb ? S.wind.dir || 270 : g, real: w.wind.vrb ? null : real, spd: w.wind.spd, gust: w.wind.gust, vrb: w.wind.vrb };
      S.altim = w.altim; S.qnh = w.qnh;
      if (!atStart && window.Gops) Gops.windCheck(); // a wind shift may mean a runway change
      this.effects(!atStart);
      if (!atStart) {
        S.atis = String.fromCharCode(65 + ((S.atis.charCodeAt(0) - 64) % 25));
        UI.log('SYS', `New weather, information ${S.atis}: ${raw}`, 'sys');
        const tw = this.tailwind(), xw = this.crosswind();
        if (tw > 10) UI.log('SYS', `The wind now gives a ${tw} kt tailwind on ${arrRwyName()}. Crews may refuse it: start the next shift the other way round.`, 'alert');
        else if (xw > 25) UI.log('SYS', `Crosswind ${xw} kt on ${arrRwyName()}: expect some crews to go around.`, 'tip');
      }
      this.L = null;
    },
    // low visibility procedures and thunderstorm cells, straight from the report
    effects(say) {
      const w = this.wx; if (!w) return;
      const lvp = (w.rvr != null && w.rvr < 600) || w.vis < 600 || (w.ceiling != null && w.ceiling < 200);
      if (say && lvp !== !!S.lvp) UI.log('SYS', lvp ? 'Low visibility procedures in force: RVR below 600 m. Bigger spacing on final, departures hold at the CAT III holding points, “report runway vacated”.' : 'Low visibility procedures cancelled.', lvp ? 'alert' : 'tip');
      S.lvp = lvp;
      if (window.Sit) {
        if (w.ts && !Sit.cells.length) { const keep = S.atis, c = Sit.CAT.find(x => x.id === 'wx'); if (c) c.start(); S.atis = keep; }
        if (w.ts) Sit.cellsUntil = Infinity; else if (Sit.cells.length && Sit.cellsUntil === Infinity) Sit.cellsUntil = S.t + 150;
      }
    },
    afterReset() { this.effects(false); this.L = null; },
    // the setup screen shows what the live weather is right now
    setupHook(icao) {
      const el = document.getElementById('wxLive'); if (!el) return; icao = icao || this.icao();
      const show = () => { const c = this.cache[icao]; el.textContent = c ? c.data.raw.replace(/^(METAR|SPECI)\s+/, '') : this.mode === 'live' ? `Getting the weather at ${icao}…` : ''; };
      show(); this.fetchLive(icao).then(show).catch(() => { el.textContent = 'Live weather unavailable right now: the shift will use chosen weather.'; });
    },
    step() {
      if (!S.running || this.mode !== 'live' || this.src !== 'live' || S.t < this.nextFetch || this.fetching) return;
      this.nextFetch = S.t + 300; this.fetching = true;
      const icao = this.icao();
      this.fetchLive(icao).then(d => { if (S.running && this.icao() === icao) this.update(d.raw, 'live', false); }).catch(() => { }).finally(() => { this.fetching = false; });
    },

    /* ---------- what the sim takes from it ---------- */
    // wind as a vector in the game frame (knots, the way it blows), stronger aloft
    windAt(alt) {
      const s = S.wind || { spd: 0 }; if (!s.spd || s.vrb) return { x: 0, y: 0 };
      const k = s.spd * (1 + Math.min(Math.max(alt || 0, 0), 12000) / 16000), r = rad(s.dir + 180);
      return { x: Math.sin(r) * k, y: Math.cos(r) * k };
    },
    along(course, alt) { const w = this.windAt(alt), r = rad(course); return w.x * Math.sin(r) + w.y * Math.cos(r); }, // + tailwind, - headwind
    tailwind() { return Math.round(Math.max(0, this.along(course(), 0)) + (S.wind && S.wind.gust ? 0 : 0)); },
    crosswind() { const w = this.windAt(0), r = rad(course()), x = Math.abs(w.x * Math.cos(r) - w.y * Math.sin(r)); return Math.round(x * (S.wind && S.wind.gust ? S.wind.gust / Math.max(1, S.wind.spd) : 1)); },
    // the heading correction a crew flies to hold a track
    wca(track, tas, alt) { const w = this.windAt(alt), r = rad(track), cross = w.x * Math.cos(r) - w.y * Math.sin(r); return -deg(Math.asin(clamp(cross / Math.max(tas, 100), -0.5, 0.5))); },
    gustAdd() { const s = S.wind || {}; return s.gust ? Math.min(15, Math.round((s.gust - s.spd) / 2)) : 0; },
    braking() { const w = this.wx; if (!w) return 1; return w.snow > 0.2 ? 0.55 : w.rain > 0.2 ? 0.78 : 1; },
    accel() { const t = this.wx ? this.wx.temp : 15; return clamp(1 - (t - 15) * 0.006, 0.82, 1.08); },
    vmc() { const w = this.wx; return !w || ((w.ceiling == null || w.ceiling >= 1500) && w.vis >= 5000 && !w.ts); },
    runwayState() { const w = this.wx; if (!w) return ''; return w.snow > 0.2 ? 'snow covered' : w.rain > 0.15 ? 'wet' : ''; },

    /* ---------- how it is said ---------- */
    windSay() {
      const s = S.wind || {};
      if (!s.spd || s.spd < 3) return 'calm';
      return `${s.vrb ? 'variable' : pad3(Math.round(norm360(s.real != null ? s.real - DECL : s.dir + HOFF) / 10) * 10 || 360)} at ${s.spd}${s.gust ? ' gusting ' + s.gust : ''}`;
    },
    visSay() {
      const w = this.wx; if (!w) return 'visibility 10 kilometres or more';
      if (w.usesA) { const sm = w.vis / 1609; return w.vis >= 9999 ? 'visibility 10 miles or more' : 'visibility ' + (sm >= 1 ? Math.round(sm) : sm >= 0.5 ? 'one half' : 'one quarter') + (sm >= 1.5 ? ' miles' : ' mile'); }
      return w.vis >= 9999 ? 'visibility 10 kilometres or more' : w.vis >= 5000 ? `visibility ${Math.round(w.vis / 1000)} kilometres` : `visibility ${w.vis} metres`;
    },
    wxSay() {
      const w = this.wx; if (!w) return '';
      const D = { RA: 'rain', DZ: 'drizzle', SN: 'snow', SG: 'snow grains', PL: 'ice pellets', GR: 'hail', GS: 'small hail', BR: 'mist', FG: 'fog', HZ: 'haze', FU: 'smoke', TS: 'thunderstorm', SH: 'showers of', FZ: 'freezing', VC: 'in the vicinity', UP: 'precipitation', MI: 'shallow', BC: 'patches of', BL: 'blowing', DR: 'drifting' };
      return w.wx.map(t => { let s = t, pre = ''; if (s[0] === '+') { pre = 'heavy '; s = s.slice(1); } else if (s[0] === '-') { pre = 'light '; s = s.slice(1); } const parts = s.match(/.{2}/g) || []; const vc = parts[0] === 'VC'; const words = parts.filter(x => x !== 'VC').map(x => D[x] || x); return pre + words.join(' ') + (vc ? ' in the vicinity' : ''); }).join(', ');
    },
    cloudSay() {
      const w = this.wx; if (!w || !w.clouds.length) return w && w.vis >= 9999 ? 'sky clear' : '';
      const N = { FEW: 'few', SCT: 'scattered', BKN: 'broken', OVC: 'overcast', VV: 'vertical visibility' };
      return w.clouds.map(c => `${N[c.c]} ${c.ft.toLocaleString('en-US')}${c.cb ? c.cb === 'CB' ? ' cumulonimbus' : ' towering cumulus' : ''}`).join(', ');
    },
    pressureSay(spoken) { const w = this.wx || { usesA: true, altim: S.altim, qnh: 1013 }; const sp = v => String(v).split('').join(' '); return w.usesA ? `altimeter ${spoken ? sp(w.altim) : w.altim}` : `QNH ${spoken ? sp(w.qnh) : w.qnh}`; },
    atis() {
      const w = this.wx; const z = fmtClock(S.clockBase + S.t), sp = v => String(v).split('').join(' ');
      const t = w ? `Temperature ${w.temp < 0 ? 'minus ' + -w.temp : w.temp}, dew point ${w.dew < 0 ? 'minus ' + -w.dew : w.dew}. ` : '';
      const rvr = w && w.rvr != null ? ` R V R runway ${arrRwyName()} ${w.rvr} metres.` : '';
      const extra = [S.lvp ? 'Low visibility procedures in force.' : '', this.runwayState() ? `Runway ${arrRwyName()} ${this.runwayState()}.` : '', window.Sit && Sit.hazard && Sit.hazard.kind === 'windshear' ? 'Wind shear reported on final.' : '', w && w.ts ? 'Thunderstorms in the area.' : ''].filter(Boolean).join(' ');
      return `${APT.name} information ${S.atis}, time ${sp(z.slice(0, 2) + z.slice(3, 5))} Zulu. Wind ${this.windSay()}. ${cap(this.visSay())}.${rvr} ${this.wxSay() ? cap(this.wxSay()) + '. ' : ''}${this.cloudSay() ? cap(this.cloudSay()) + '. ' : ''}${t}${cap(this.pressureSay(true))}. ILS approach runway ${arrRwyName()} in use, departing runway ${depRwyName()}. ${extra} Advise on initial contact you have information ${S.atis}.`.replace(/\s+/g, ' ');
    },
    plain() {
      const w = this.wx; if (!w) return 'fine';
      return [`wind ${this.windSay()}`, this.visSay(), this.wxSay(), this.cloudSay(), `${w.temp} degrees`, S.lvp ? 'low visibility procedures in force' : '', this.runwayState() ? 'runway ' + this.runwayState() : '', this.light().phase].filter(Boolean).join(', ');
    },

    /* ---------- light ---------- */
    sun() {
      const m = LAYOUT && LAYOUT.map; if (!m) return { el: 40, az: 180 };
      const fixed = { sunrise: { el: 2, az: 95 }, day: { el: 48, az: m.lat >= 0 ? 180 : 0 }, sunset: { el: 1.5, az: 265 }, night: { el: -30, az: 0 } }[this.tod];
      if (fixed) return fixed;
      const now = new Date(), day0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      let secs = (S.clockBase || 0) + S.t; if (!S.running) secs = (now.getTime() - day0) / 1000;
      return sunAt(m.lat, m.lon, day0 + secs * 1000);
    },
    light() {
      if (this.L && performance.now() - this.Lt < 2000) return this.L;
      const s = this.sun(), w = this.wx || { cover: 0.2, rain: 0, snow: 0, fog: 0, vis: 9999, ts: false };
      const day = smooth(-7, 7, s.el), cover = w.cover || 0;
      const golden = day > 0 ? clamp(1 - Math.abs(s.el - 3) / 11, 0, 1) * (1 - cover * 0.75) : 0;
      // the light falling on the airfield, as a colour to multiply the day picture by
      let r = 1, g = 1, b = 1;
      const grey = cover * 0.7 + w.rain * 0.15 + w.snow * 0.1;
      r = mix(r, 0.80, grey); g = mix(g, 0.82, grey); b = mix(b, 0.86, grey);
      r *= mix(1, 1.04, golden); g *= mix(1, 0.88, golden); b *= mix(1, 0.74, golden);
      const level = (0.16 + 0.84 * Math.min(1, day * 1.15)) * (1 - 0.18 * w.rain - 0.12 * (w.fog || 0));
      r *= level; g *= level; b *= level;
      const blue = (1 - day) * 0.75; r = mix(r, r * 0.55, blue); g = mix(g, g * 0.72, blue); b = mix(b, Math.min(1, b * 1.35), blue);
      const fogVis = w.rvr != null ? Math.min(w.rvr, w.vis) : w.vis;
      const lowVis = fogVis < 1500 ? 0.75 : fogVis < 5000 ? 0.35 : 0;
      const lights = Math.max(1 - smooth(-6, 3, s.el), lowVis, cover > 0.95 && w.rain > 0.5 ? 0.25 : 0);
      const fogA = fogVis >= 9000 ? 0 : fogVis >= 5000 ? 0.06 : fogVis >= 3000 ? 0.14 : fogVis >= 1500 ? 0.24 : fogVis >= 800 ? 0.38 : fogVis >= 400 ? 0.5 : 0.62;
      const sh = day * (1 - cover * 0.85) * (1 - (w.fog || 0) * 0.8);
      const sa = rad((s.az - ROT) + 180), len = 1 / Math.tan(rad(Math.max(s.el, 10)));
      const phase = s.el < -6 ? 'night' : s.el < 0 ? (s.az < 180 ? 'dawn' : 'dusk') : s.el < 8 ? (s.az < 180 ? 'sunrise' : 'sunset') : cover > 0.7 ? 'overcast day' : 'day';
      this.L = { el: s.el, az: s.az, day, golden, cover, amb: [r, g, b], lights, fogA, shadow: sh, sdx: Math.sin(sa) * len, sdy: -Math.cos(sa) * len, rain: w.rain, snow: w.snow, ts: w.ts, phase };
      this.Lt = performance.now();
      return this.L;
    },
    key() { const L = this.light(); return ['a' + this.season(), L.amb.map(v => Math.round(v * 24)).join(','), Math.round(L.lights * 8), this.wx && this.wx.snow > 0.2 ? 's' : '', Math.round(L.shadow * 4)].join('/'); },
    hex(rgb) { return '#' + rgb.map(v => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join(''); },
    // how much an aircraft is darkened: the light falling where it stands
    dimFor(ac) {
      const L = this.light(), lum = (L.amb[0] + L.amb[1] + L.amb[2]) / 3;
      let lit = lum;
      if (L.lights > 0.1 && this.lightAt && (onGround(ac) || ac.alt < 400)) { const l = this.lightAt(ac.x, ac.y); if (l) lit = Math.max(lit, Math.min(1, (l[0] + l[1] + l[2]) / 3 * 1.15)); }
      return clamp(1 - lit, 0, 0.86);
    },
    // a colour as the light at a place shows it (night: the floodlights' pools; day: the sky)
    dimAt(x, y) {
      const L = this.light(); let lit = (L.amb[0] + L.amb[1] + L.amb[2]) / 3;
      if (L.lights > 0.1 && this.lightAt) { const l = this.lightAt(x, y); if (l) lit = Math.max(lit, Math.min(1, (l[0] + l[1] + l[2]) / 3 * 1.15)); }
      const dk = clamp(1 - lit, 0, 0.86); return dk < 0.02 ? (v => v) : (v => v && v[0] === '#' ? shade(v, -dk) : v);
    },
    nearMast(x, y) { let b = null, bd = 0.09; for (const m of this.masts()) { const dd = Math.hypot(m[0] - x, m[1] - y); if (dd < bd) { bd = dd; b = m; } } return b; },
    shadowA(ac) { const L = this.light(); return L.lights > 0.3 && onGround(ac) && this.nearMast(ac.x, ac.y) ? Math.max(L.shadow, 0.6 * L.lights) : L.shadow; },
    // which way a shadow falls (screen x, y): away from the sun, or at night away from the nearest floodlight
    shadowDir(ac) {
      const L = this.light();
      if (L.lights > 0.3 && onGround(ac)) { const m = this.nearMast(ac.x, ac.y); if (m) { const dx = ac.x - m[0], dy = ac.y - m[1], n = Math.hypot(dx, dy) || 1; return [dx / n * 2.2, -dy / n * 2.2]; } }
      return [clamp(L.sdx, -3, 3), clamp(L.sdy, -3, 3)];
    },

    /* ---------- drawing ---------- */
    sprite(col, size) {
      const k = col + size; this.sp = this.sp || {}; if (this.sp[k]) return this.sp[k];
      const cv = document.createElement('canvas'); cv.width = cv.height = size * 2; const g = cv.getContext('2d');
      const gr = g.createRadialGradient(size, size, 0, size, size, size);
      gr.addColorStop(0, '#FFFFFF'); gr.addColorStop(0.12, col); gr.addColorStop(0.4, col + '66'); gr.addColorStop(1, col + '00');
      g.fillStyle = gr; g.fillRect(0, 0, size * 2, size * 2);
      return this.sp[k] = cv;
    },
    // OSM tiles at night, two ways: what lights the ground (streets glowing under sodium lamps, a little
    // light spilling from built-up areas) and the lamps themselves (street lights, windows)
    nightTile(t) { if (!t) return null; if (t.night === undefined) this.nightMaps(t); return t.night; },
    lampTile(t) { if (!t) return null; if (t.lamps === undefined) this.nightMaps(t); return t.lamps; },
    nightMaps(t) {
      try {
        const mk = () => { const cv = document.createElement('canvas'); cv.width = cv.height = 256; return cv; };
        const a = mk(), b = mk(), ga = a.getContext('2d', { willReadFrequently: true }), gb = b.getContext('2d');
        ga.drawImage(t.im, 0, 0); const d = ga.getImageData(0, 0, 256, 256), p = d.data, lamps = gb.createImageData(256, 256), q = lamps.data;
        const tm = /(\d+)\/(\d+)\/(\d+)\.png/.exec(t.im.src || '') || [0, 0, 0, 0], tz = +tm[1], tx = +tm[2], ty = +tm[3];
        // street lighting comes in districts: most now white LED, some still old orange sodium, a few streets dark
        const district = (x, y) => hash(((tx * 4 + (x >> 6)) * 92821) ^ ((ty * 4 + (y >> 6)) * 68917) ^ (tz * 1013));
        const LED = [222, 230, 242], SOD = [255, 156, 66];
        for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
          const i = (y * 256 + x) * 4, r = p[i], gg = p[i + 1], bb = p[i + 2], mx = Math.max(r, gg, bb), mn = Math.min(r, gg, bb), sat = mx - mn;
          const h = ((i * 2654435761) >>> 0) % 1000, dv = district(x, y), sod = dv < 0.28, col = sod ? SOD : LED, lit = dv > 0.06;
          const glow = k => [col[0] * k, col[1] * k, col[2] * k];
          let o = [0, 0, 0], lamp = null;
          if (bb > r + 18 && bb > 170) o = [0, 0, 0];                                                                      // water
          else if (r >= 225 && gg >= 120 && bb <= 215 && sat > 22 && r >= gg) { o = glow(0.62); if (h < 16) lamp = sod ? [255, 196, 120] : [236, 242, 255]; } // main roads, motorways
          else if (r >= 250 && gg >= 250 && bb >= 250) { if (lit) { o = glow(0.16); if (h < 6) lamp = sod ? [255, 188, 112] : [230, 236, 250]; } }        // side streets: dim, patchy
          else if (mx < 120) o = [0, 0, 0];                                                                                 // lettering
          else if (sat <= 3 && mx >= 214 && mx <= 240) { o = [26, 22, 18]; if (h < 8) lamp = [255, 200, 140]; }                                         // houses, car parks
          else if (r > gg && r > bb && sat >= 8 && sat < 40 && mx > 220) { o = [40, 38, 36]; if (h < 18) lamp = h < 9 ? [255, 222, 175] : [225, 235, 255]; } // shops, offices
          else if (sat < 22 && mx < 222 && r >= bb) { o = [18, 16, 14]; if (h < 5) lamp = [255, 224, 180]; }                                            // buildings
          p[i] = o[0]; p[i + 1] = o[1]; p[i + 2] = o[2];
          if (lamp) { q[i] = lamp[0]; q[i + 1] = lamp[1]; q[i + 2] = lamp[2]; q[i + 3] = 255; }
        }
        ga.putImageData(d, 0, 0); gb.putImageData(lamps, 0, 0); t.night = a; t.lamps = b;
      } catch (e) { t.night = null; t.lamps = null; }
    },
    // after the airfield is painted into the cache: the light of the hour and the weather, then the lights
    // canvases reused between repaints
    buf(i, w, h) { this.bufs = this.bufs || []; let b = this.bufs[i]; if (!b) b = this.bufs[i] = document.createElement('canvas'); if (b.width !== w || b.height !== h) { b.width = w; b.height = h; } return b; },
    // where the apron floodlight masts stand: about every 120 m across the aprons
    masts() {
      if (LAYOUT._masts) return LAYOUT._masts;
      const F = fieldShapes(LAYOUT), b = LAYOUT.data.bounds, g = this.buf(9, 4, 4).getContext('2d'), out = [], st = 0.065;
      for (let x = b[0]; x <= b[2]; x += st) for (let y = b[1]; y <= b[3]; y += st) { const jx = x + Math.sin(x * 91 + y * 37) * 0.012, jy = y + Math.cos(x * 53 - y * 71) * 0.012; if (g.isPointInPath(F.aprons, jx, jy)) out.push([jx, jy]); }
      return LAYOUT._masts = out;
    },
    underMast(x, y) { for (const m of this.masts()) if (Math.abs(m[0] - x) < 0.06 && Math.abs(m[1] - y) < 0.06) return true; return false; },
    // after the airfield is painted into the cache: the light of the hour and the weather. At night the
    // floodlit aprons show the day picture again under LED light, and everything else falls into darkness.
    // after the airfield is painted into the cache: light it. The picture is multiplied by a light map:
    // the sky's light everywhere (sun, cloud, moon), plus at night every lamp: apron masts, terminal façades,
    // the city's streets. Then the light sources themselves, bloom and haze, as a camera sees them.
    grade(c, r, X, Y, sc) {
      const L = this.light(), M = sc / 1852, F = fieldShapes(LAYOUT), d = LAYOUT.data, a = L.lights;
      const cv = c.canvas, W = cv.width, H = cv.height;
      if (window.Settings && Settings.p && Settings.p.gfx === 'low') { // low quality: just the ambient light, no light map or glow
        c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'multiply'; c.fillStyle = this.hex(L.amb.map(v => 0.42 + 0.58 * v)); c.fillRect(0, 0, W, H); c.restore(); return; // kept readable without the lamps
      }
      if (OSM.on && LAYOUT.map) this.dayDetail(c, r, X, Y, sc); // concrete, rubber, roofs, grain
      // 1. the light map, at half resolution: light is soft anyway
      const lw = Math.max(1, Math.round(W / 2)), lh = Math.max(1, Math.round(H / 2)), lm = this.buf(1, lw, lh), g = lm.getContext('2d'), k = lw / r.w;
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.filter = 'none';
      g.fillStyle = this.hex(L.amb); g.fillRect(0, 0, lw, lh);
      const pool = (x, y, rad, rgb, k0) => {
        const px = X(x), py = Y(y), rr = rad * M; if (rr < 1 || px < -rr || py < -rr || px > r.w + rr || py > r.h + rr) return;
        const gr = g.createRadialGradient(px, py, 0, px, py, rr), c0 = rgb.join(',');
        gr.addColorStop(0, `rgba(${c0},${k0})`); gr.addColorStop(0.18, `rgba(${c0},${k0 * 0.82})`); gr.addColorStop(0.45, `rgba(${c0},${k0 * 0.42})`); gr.addColorStop(0.75, `rgba(${c0},${k0 * 0.12})`); gr.addColorStop(1, `rgba(${c0},0)`);
        g.fillStyle = gr; g.fillRect(px - rr, py - rr, rr * 2, rr * 2);
      };
      if (a > 0.04) {
        g.setTransform(k, 0, 0, k, 0, 0); g.globalCompositeOperation = 'lighter';
        // the streets of the city: the night map blurred into pools of sodium light
        if (OSM.on && LAYOUT.map) {
          const sb = this.buf(4, lw, lh), sg = sb.getContext('2d'); sg.setTransform(1, 0, 0, 1, 0, 0); sg.clearRect(0, 0, lw, lh); sg.setTransform(k, 0, 0, k, 0, 0); this.nightBlur = 'none'; OSM.draw(sg, r, X, Y, sc, 'night');
          sg.save(); sg.globalCompositeOperation = 'destination-out'; sg.transform(sc, 0, 0, -sc, X(0), Y(0)); sg.fillStyle = sg.strokeStyle = '#000'; sg.lineCap = 'round'; sg.lineJoin = 'round';
          sg.fill(F.aprons); sg.lineWidth = 70 / 1852; sg.stroke(F.aprons); for (const [w, q] of F.twy) { sg.lineWidth = (w + 60) / 1852; sg.stroke(q); } for (const o of F.other) { sg.lineWidth = (o.w + 80) / 1852; sg.stroke(o.q); }
          for (const kk in RWY) { const R0 = RWY[kk]; sg.fillRect(R0.x1 - 0.03, R0.y - (R0.width / 2 + 90) / 1852, R0.x2 - R0.x1 + 0.06, (R0.width + 180) / 1852); }
          sg.restore();

          g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 0.95 * a; g.filter = `blur(${clamp(8 * M * k, 1.2, 10).toFixed(1)}px)`; g.drawImage(sb, 0, 0); g.restore();
          this.streets = sb;
        }
        // apron floodlight masts (LED, a touch warm) and the lights over each stand
        for (const [x, y] of this.masts()) pool(x, y, 120, [255, 240, 222], 0.38 * a);
        for (const s of GATES) { const [lx, ly, nx, ny] = s.line; pool((lx + nx) / 2, (ly + ny) / 2, 50, [255, 238, 214], 0.22 * a); }
        // light from inside the terminals, spilling out through the glass (all outlines first, one blur)
        const tb = this.buf(8, lw, lh), tg = tb.getContext('2d'); tg.setTransform(1, 0, 0, 1, 0, 0); tg.clearRect(0, 0, lw, lh);
        tg.setTransform(k, 0, 0, k, 0, 0); tg.transform(sc, 0, 0, -sc, X(0), Y(0)); tg.lineJoin = 'round';
        tg.lineWidth = 34 / 1852; tg.strokeStyle = `rgba(255,196,130,${0.45 * a})`; for (const b of F.bld) if (b.roofCol === '#E3E1DC') tg.stroke(b.roof);
        tg.lineWidth = 16 / 1852; tg.strokeStyle = `rgba(255,190,130,${0.25 * a})`; for (const b of F.bld) if (b.roofCol !== '#E3E1DC') tg.stroke(b.roof);
        g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.filter = `blur(${clamp(14 * M * k, 2, 18).toFixed(1)}px)`; g.drawImage(tb, 0, 0); g.restore(); g.filter = 'none';
      }
      // 2. light the picture
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'multiply'; c.imageSmoothingQuality = 'high'; c.drawImage(lm, 0, 0, W, H); c.restore();
      c.save();
      if (L.golden > 0.05) {
        c.globalCompositeOperation = 'soft-light'; c.fillStyle = `rgba(255,170,90,${0.18 * L.golden})`; c.fillRect(r.x, r.y, r.w, r.h);
        // a low sun: warm on the side it shines from, cool blue in the shade of the far side
        const sa = (L.az - ROT) * Math.PI / 180, cx = r.x + r.w / 2, cy = r.y + r.h / 2, R0 = Math.hypot(r.w, r.h) / 2, dx = Math.sin(sa) * R0, dy = -Math.cos(sa) * R0;
        const lg = c.createLinearGradient(cx + dx, cy + dy, cx - dx, cy - dy); lg.addColorStop(0, `rgba(255,170,90,${0.26 * L.golden})`); lg.addColorStop(0.55, 'rgba(128,128,128,0)'); lg.addColorStop(1, `rgba(70,100,160,${0.22 * L.golden})`);
        c.fillStyle = lg; c.fillRect(r.x, r.y, r.w, r.h);
      }
      const wet = this.wx ? Math.max(this.wx.rain, this.wx.snow * 0.4) : 0;
      if (wet > 0.1) {
        c.save(); c.setTransform(cv.width / r.w, 0, 0, cv.height / r.h, 0, 0); c.transform(sc, 0, 0, -sc, X(0), Y(0));
        const pav = F.pavement || (F.pavement = (() => { const q = new Path2D(F.aprons); for (const kk in RWY) { const R0 = RWY[kk]; q.rect(R0.x1, R0.y - R0.width / 2 / 1852, R0.x2 - R0.x1, R0.width / 1852); } return q; })());
        c.clip(pav); c.setTransform(cv.width / r.w, 0, 0, cv.height / r.h, 0, 0);
        c.globalCompositeOperation = 'multiply'; c.fillStyle = `rgba(${Math.round(255 - 60 * wet)},${Math.round(255 - 58 * wet)},${Math.round(255 - 50 * wet)},1)`; c.fillRect(r.x, r.y, r.w, r.h); // wet and dark
        c.globalCompositeOperation = 'screen'; c.globalAlpha = (a > 0.2 ? 0.18 : 0.12) * wet; c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(lm, 0, 0, cv.width, cv.height); // the sheen: lights mirrored in the water
        c.restore();
      }
      if (a > 0.04) {
        const dot = (x, y, col, s) => { const im = this.sprite(col, 16); const z = s * clamp(M * 0.7, 0.4, 1.8); c.drawImage(im, x - z, y - z, z * 2, z * 2); };
        c.globalCompositeOperation = 'lighter';
        // 3. the lamps themselves: street lights and windows across the city
        if (this.streets) { c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 0.2 * a; c.drawImage(this.streets, 0, 0, W, H); c.restore(); } // the street network glowing
        if (OSM.on && LAYOUT.map) { c.globalAlpha = 0.55 * a; this.nightBlur = 'none'; OSM.draw(c, r, X, Y, sc, 'lamps'); c.globalAlpha = 1; }
        // the terminals' glazing: a fine warm line, not a neon tube
        c.save(); c.transform(sc, 0, 0, -sc, X(0), Y(0)); c.lineJoin = 'round'; c.lineWidth = Math.max(0.8 / sc, 0.7 / 1852); c.strokeStyle = `rgba(255,214,160,${0.32 * a})`;
        for (const b of F.bld) if (b.roofCol === '#E3E1DC') c.stroke(b.roof);
        c.restore();
        // the mast heads, tiny and hot
        if (M > 0.3) for (const [x, y] of this.masts()) dot(X(x), Y(y), '#FFF6E8', 1.5 * a);
        // taxiways: green centreline and blue edge lights, close up; faint green lines from afar
        c.save(); c.transform(sc, 0, 0, -sc, X(0), Y(0)); c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = `rgba(80,255,150,${(M > 0.6 ? 0.05 : 0.11) * a})`; c.lineWidth = Math.max(1 / sc, 1.5 / 1852); c.stroke(F.cl); c.restore();
        const step = M > 1.2 ? 30 : 60;
        if (M > 0.6) for (const [, wdt, p] of d.twy) {
          for (let i = 0; i + 3 < p.length; i += 2) {
            const x1 = p[i], y1 = p[i + 1], x2 = p[i + 2], y2 = p[i + 3], len = dist(x1, y1, x2, y2) * 1852; if (len < 1) continue;
            const ux = (x2 - x1) / len, uy = (y2 - y1) / len, off = (wdt / 2 + 2) / 1852, nxv = -uy * 1852 * off, nyv = ux * 1852 * off;
            for (let mm = 0; mm < len; mm += step) {
              const x = x1 + ux * mm, y = y1 + uy * mm;
              dot(X(x), Y(y), '#3CFF7A', 1.1 * a);
              if (M > 1 && (mm / step) % 2 < 1) { dot(X(x + nxv), Y(y + nyv), '#3D7BFF', 1.1 * a); dot(X(x - nxv), Y(y - nyv), '#3D7BFF', 1.1 * a); }
            }
          }
        }
        // runways in use: white edge and centreline lights, touchdown zone barrettes, green thresholds, red ends
        for (const kk of [S.rwyDep, S.rwyArr]) {
          const R = RWY[kk]; if (!R) continue;
          const Lm = (R.x2 - R.x1) * 1852, hw = (R.width / 2 + 1.5) / 1852;
          for (let mm = 0; mm <= Lm; mm += 60) { const x = R.x1 + mm / 1852; dot(X(x), Y(R.y + hw), '#FFF6E0', 2.6 * a); dot(X(x), Y(R.y - hw), '#FFF6E0', 2.6 * a); }
          const cStep = M > 0.4 ? 30 : 60, endX = S.flow === 'W' ? R.x1 : R.x2, thrX = S.flow === 'W' ? R.x2 : R.x1;
          for (let mm = 0; mm <= Lm; mm += cStep) { const x = R.x1 + mm / 1852, toEnd = Math.abs(x - endX) * 1852; dot(X(x), Y(R.y), toEnd < 300 ? '#FF3B30' : toEnd < 900 && (mm / cStep) % 2 < 1 ? '#FF3B30' : '#FFFFFF', 1.9 * a); }
          if (kk === S.rwyArr && M > 0.3) for (let mm = 60; mm <= 900; mm += 60) for (const q of [-9, -6, -3, 3, 6, 9]) { const x = thrX - (S.flow === 'W' ? 1 : -1) * mm / 1852; dot(X(x), Y(R.y + q / 1852), '#FFFFFF', 1.3 * a); }
          for (let q = -R.width / 2; q <= R.width / 2; q += 4) { dot(X(R.x1), Y(R.y + q / 1852), S.flow === 'W' ? '#FF3B30' : '#3CFF7A', 2.2 * a); dot(X(R.x2), Y(R.y + q / 1852), S.flow === 'W' ? '#3CFF7A' : '#FF3B30', 2.2 * a); }
        }
        // 4. bloom: the brightest light spills over, as through a lens (blurred small, then scaled up)
        const bw = Math.max(1, Math.round(W / 4)), bh = Math.max(1, Math.round(H / 4)), bl = this.buf(2, bw, bh), bg = bl.getContext('2d');
        bg.setTransform(1, 0, 0, 1, 0, 0); bg.globalCompositeOperation = 'copy'; bg.filter = 'brightness(.7) contrast(2.6)'; bg.drawImage(cv, 0, 0, bw, bh); bg.filter = 'none'; bg.globalCompositeOperation = 'source-over';
        const b1 = this.buf(5, bw, bh), g1 = b1.getContext('2d'); g1.setTransform(1, 0, 0, 1, 0, 0); g1.globalCompositeOperation = 'copy'; g1.filter = 'blur(1px)'; g1.drawImage(bl, 0, 0); g1.filter = 'none';
        const sw2 = Math.max(1, Math.round(W / 12)), sh2 = Math.max(1, Math.round(H / 12)), b2 = this.buf(6, sw2, sh2), g2 = b2.getContext('2d'); g2.setTransform(1, 0, 0, 1, 0, 0); g2.globalCompositeOperation = 'copy'; g2.filter = 'blur(1.5px)'; g2.drawImage(bl, 0, 0, sw2, sh2); g2.filter = 'none';
        const b3 = this.buf(7, sw2, sh2), g3 = b3.getContext('2d'); g3.setTransform(1, 0, 0, 1, 0, 0); g3.globalCompositeOperation = 'copy'; g3.filter = 'blur(2.5px)'; g3.drawImage(lm, 0, 0, sw2, sh2); g3.filter = 'none';
        c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'screen'; c.imageSmoothingQuality = 'high';
        c.globalAlpha = 0.16 * a; c.drawImage(b1, 0, 0, W, H);
        c.globalAlpha = 0.08 * a; c.drawImage(b2, 0, 0, W, H);
        // 5. haze: the light map scattered in the night air
        c.globalAlpha = 0.035 * a; c.drawImage(b3, 0, 0, W, H);
        c.filter = 'none'; c.restore();
      }
      c.restore();
      // keep a small copy of the light map so aircraft can be lit by the light where they stand
      try {
        const sw = Math.max(1, Math.round(lw / 8)), shh = Math.max(1, Math.round(lh / 8)), sm = this.buf(3, sw, shh), sg = sm.getContext('2d', { willReadFrequently: true });
        sg.setTransform(1, 0, 0, 1, 0, 0); sg.drawImage(lm, 0, 0, sw, shh);
        const data = sg.getImageData(0, 0, sw, shh).data, fx = sw / r.w, fy = shh / r.h, X0 = X, Y0 = Y;
        this.lightAt = (x, y) => { const px = Math.floor(X0(x) * fx), py = Math.floor(Y0(y) * fy); if (px < 0 || py < 0 || px >= sw || py >= shh) return null; const i = (py * sw + px) * 4; return [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255]; };
      } catch (e) { this.lightAt = null; }
    },
    // snow lying on the grass, under the pavement
    paintBase(c, r) { if (this.wx && this.wx.snow > 0.2) { c.fillStyle = `rgba(250,252,255,${0.45 + 0.3 * this.wx.snow})`; c.fillRect(r.x, r.y, r.w, r.h); } },
    // moving lights and weather over the airfield view
    drawUnder(c, X, Y, M, now, r) {
      const L = this.light(), a = L.lights;
      // cloud shadows drifting across the field on a broken-cloud day
      if (L.shadow > 0.1 && L.cover >= 0.2 && L.cover < 0.95) {
        const w = this.windAt(4000), t = S.t, im = this.tex('clouds'), k = 2600 / 1852 * (M * 1852) / im.width; // a texture tile covers about 2.6 km
        const p = c.createPattern(im, 'repeat'), ox = X(0) + w.x * t / 3600 * M * 1852, oy = Y(0) - w.y * t / 3600 * M * 1852;
        p.setTransform(new DOMMatrix([k, 0, 0, k, ox, oy]));
        c.save(); c.globalCompositeOperation = 'multiply'; c.globalAlpha = clamp(0.55 * L.shadow * (0.4 + L.cover), 0, 0.6); c.fillStyle = p; c.fillRect(r.x, r.y, r.w, r.h); c.restore();
      }
      // vehicles going about their work on the aprons
      if (!window.Lay || Lay('gVehicles')) this.trafficDraw(c, X, Y, M, now, a);
      if (a < 0.05) return;
      c.save(); c.globalCompositeOperation = 'lighter';
      const dot = (x, y, col, s) => { const im = this.sprite(col, 16); const z = s * clamp(M * 0.8, 0.45, 2.4); c.drawImage(im, x - z, y - z, z * 2, z * 2); };
      // approach lights with the sequenced flashers running in to the threshold, and the PAPI
      const AR = ARRR(); if (AR) {
        const thrX = S.flow === 'W' ? AR.x2 : AR.x1, out = S.flow === 'W' ? 1 : -1, seq = Math.floor(now / 70) % 22;
        for (let m = 30; m <= 900; m += 30) {
          const x = thrX + out * m / 1852; dot(X(x), Y(AR.y), '#FFF2D6', 3 * a);
          if (m === 300) for (let q = -15; q <= 15; q += 3) dot(X(x), Y(AR.y + q / 1852), '#FFF2D6', 2.4 * a);
          if (Math.round(m / 30) === 30 - seq && m > 300) dot(X(x), Y(AR.y), '#FFFFFF', 7 * a);
        }
        for (let i = 0; i < 4; i++) { const x0 = thrX - out * 300 / 1852, y0 = AR.y + (AR.width / 2 + 15 + i * 9) / 1852; dot(X(x0), Y(y0), i < 2 ? '#FF3B30' : '#FFFFFF', 3.5 * a); }
      }
      // red stop bars at the holding points, off for the aircraft cleared onto the runway
      for (const R of [DEPR(), ARRR()]) for (const e of (R && R.entries) || []) {
        const i = e.path.indexOf(e.hs); if (i < 1) continue;
        const h = NODES[e.hs], p = NODES[e.path[i - 1]], Ln = dist(h.x, h.y, p.x, p.y); if (!Ln) continue;
        const clearedOn = S.aircraft.some(o => o.phase === 'lineup_move' && dist(o.x, o.y, h.x, h.y) < 0.03);
        if (clearedOn) continue;
        const ux = (p.x - h.x) / Ln, uy = (p.y - h.y) / Ln, vx = -uy, vy = ux;
        for (let q = -10; q <= 10; q += 4) dot(X(h.x + vx * q / 1852), Y(h.y + vy * q / 1852), '#FF2A1A', 2.6 * Math.max(a, 0.5));
      }
      // landing lights and taxi lights
      for (const ac of S.aircraft) {
        const air = !onGround(ac); if (air && ac.alt > 2500) continue;
        const moving = ['taxiing', 'taxiing_in', 'exiting', 'takeoff', 'rollout', 'lineup_move', 'lineup'].includes(ac.phase) || (air && ac.alt < 2500);
        if (!moving) continue;
        const big = air || ['takeoff', 'rollout', 'lineup'].includes(ac.phase), len = (big ? 260 : 70) * M, hd = rad(ac.hdg), x = X(ac.x), y = Y(ac.y);
        const ex = x + Math.sin(hd) * len, ey = y - Math.cos(hd) * len;
        const gr = c.createRadialGradient(ex, ey, 0, ex, ey, len * 0.55);
        gr.addColorStop(0, `rgba(255,248,225,${(big ? 0.28 : 0.2) * a})`); gr.addColorStop(1, 'rgba(255,248,225,0)');
        c.fillStyle = gr; c.beginPath(); c.moveTo(x, y);
        const sp = big ? 0.22 : 0.4; c.lineTo(x + Math.sin(hd - sp) * len * 1.1, y - Math.cos(hd - sp) * len * 1.1); c.lineTo(x + Math.sin(hd + sp) * len * 1.1, y - Math.cos(hd + sp) * len * 1.1); c.closePath(); c.fill();
      }
      c.restore();
    },
    // aircraft lights glow at night
    glows(c, z, sh, now, running, strobe) {
      const a = this.light().lights; if (a < 0.15) return;
      c.save(); c.globalCompositeOperation = 'lighter';
      const g = (x, y, col, s) => { const im = this.sprite(col, 16); c.drawImage(im, x - s, y - s, s * 2, s * 2); };
      const s = z * 4.5 * a;
      g(-sh.semi, sh.tipY, '#FF3B30', s); g(sh.semi, sh.tipY, '#30D158', s);
      if (running && Math.floor(now / 600) % 2 === 0) g(0, 0, '#FF2D20', s * 1.2);
      if (strobe && Math.floor(now / 100) % 12 === 0) { g(-sh.semi, sh.tipY, '#FFFFFF', s * 1.8); g(sh.semi, sh.tipY, '#FFFFFF', s * 1.8); }
      c.restore();
    },
    drawOver(c, X, Y, M, now, r) {
      const L = this.light(), w = this.wx; if (!w) return;
      if (window.Settings && Settings.p && Settings.p.gfx === 'low') return; // low quality: no weather particles
      const t = now / 1000;
      if (L.lights > 0.3) {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2, R0 = Math.hypot(r.w, r.h) / 2;
        const vg = c.createRadialGradient(cx, cy, R0 * 0.55, cx, cy, R0); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,6,${0.38 * L.lights})`);
        c.fillStyle = vg; c.fillRect(r.x, r.y, r.w, r.h);
      }
      // the city's glow in the night air, strongest toward the edges of the view
      if (L.lights > 0.3 && L.day < 0.5) {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2, R0 = Math.hypot(r.w, r.h) / 2;
        const gr = c.createRadialGradient(cx, cy, R0 * 0.45, cx, cy, R0); gr.addColorStop(0, 'rgba(255,140,60,0)'); gr.addColorStop(1, `rgba(255,140,60,${0.10 * L.lights})`);
        c.save(); c.globalCompositeOperation = 'lighter'; c.fillStyle = gr; c.fillRect(r.x, r.y, r.w, r.h); c.restore();
      }
      // fog and mist: banks drifting with the wind over a general haze; at night they glow with the lights
      if (L.fogA > 0.01) {
        const day = L.day, col = `${Math.round(mix(58, 206, day))},${Math.round(mix(56, 211, day))},${Math.round(mix(60, 216, day))}`;
        c.fillStyle = `rgba(${col},${L.fogA * 0.65})`; c.fillRect(r.x, r.y, r.w, r.h);
        const im = this.tex('fog'), wv = this.windAt(0), k = 900 / 1852 * (M * 1852) / im.width, pt = c.createPattern(im, 'repeat');
        pt.setTransform(new DOMMatrix([k, 0, 0, k, X(0) + wv.x * S.t / 3600 * M * 1852, Y(0) - wv.y * S.t / 3600 * M * 1852]));
        c.save(); c.globalAlpha = Math.min(0.9, L.fogA * 1.1); c.globalCompositeOperation = day > 0.4 ? 'screen' : 'lighter'; c.fillStyle = pt; c.fillRect(r.x, r.y, r.w, r.h); c.restore();
      }
      // rain: short falling drops of different brightness, and splashes on the pavement; snow drifting down
      const ww = this.windAt(0), slant = clamp(ww.x / 25, -0.8, 0.8);
      if (w.rain > 0.05) {
        const n = Math.round(r.w * r.h / 7000 * w.rain), lit = L.day > 0.4 ? '205,214,226' : '170,180,198';
        for (let pass = 0; pass < 2; pass++) {
          c.strokeStyle = `rgba(${lit},${pass ? 0.18 : 0.34})`; c.lineWidth = pass ? 0.8 : 1.1; c.beginPath();
          for (let i = pass; i < n; i += 2) { const sp = 700 + (i % 7) * 70, len = 7 + (i % 5) * 2, sx = (i * 97.13 + t * 40 * slant) % r.w, sy = ((i * 53.71) % r.h + t * sp) % r.h, x = r.x + (sx + r.w) % r.w, y = r.y + sy; c.moveTo(x, y); c.lineTo(x + slant * len * 0.6, y + len); }
          c.stroke();
        }
        if (M > 0.6) { c.strokeStyle = `rgba(${lit},.4)`; c.lineWidth = 0.8; const m = Math.round(n / 5); c.beginPath();
          for (let i = 0; i < m; i++) { const ph = ((t * 2.4 + i * 0.137) % 1), x = r.x + (i * 211.7) % r.w, y = r.y + (i * 89.3 + Math.floor(t * 2.4 + i * 0.137) * 37) % r.h, rr = 0.6 + ph * 2.6; c.moveTo(x + rr, y); c.ellipse(x, y, rr, rr * 0.55, 0, 0, 7); }
          c.globalAlpha = 0.6; c.stroke(); c.globalAlpha = 1; }
      }
      if (w.snow > 0.05) {
        const n = Math.round(r.w * r.h / 4000 * w.snow);
        for (let i = 0; i < n; i++) { const sz = 1 + (i % 3) * 0.7, x = r.x + (((i * 73.3 + Math.sin(t * 0.8 + i) * 14 + t * 30 * slant) % r.w) + r.w) % r.w, y = r.y + ((i * 41.7) % r.h + t * (40 + (i % 4) * 12)) % r.h; c.fillStyle = `rgba(255,255,255,${0.55 + (i % 3) * 0.15})`; c.beginPath(); c.arc(x, y, sz, 0, 7); c.fill(); }
      }
      // lightning
      if (w.ts) {
        if (now > this.nextFlash) { this.flash = now; this.nextFlash = now + rnd(6000, 18000); }
        const f = now - this.flash; if (f < 260) { c.fillStyle = `rgba(235,240,255,${(f < 60 || (f > 120 && f < 170)) ? 0.38 : 0.08})`; c.fillRect(r.x, r.y, r.w, r.h); }
      }
    },
    // Vehicles driving between stands along the apron taxi lanes: baggage tugs with carts, catering and fuel
    // trucks, buses, follow-me cars. With headlights and tail lights at night.
    traffic: [], trafficApt: '',
    trafficDraw(c, X, Y, M, now, a) {
      if (!GATES.length || M < 0.45) return;
      if (this.trafficApt !== LAYOUT.icao) { this.traffic = []; this.trafficApt = LAYOUT.icao; }
      const t = S.t, want = Math.min(26, Math.round(GATES.length / 3));
      const svc = g => { const u = g.hdg * Math.PI / 180, [lx, ly, nx, ny] = g.line; return { x: nx * 0.55 + lx * 0.45 + Math.cos(u) * 22 / 1852, y: ny * 0.55 + ly * 0.45 - Math.sin(u) * 22 / 1852 }; };
      const KINDS = [['tug', 1.8, 3, '#E3B505', 3], ['tug', 1.8, 3, '#2F3439', 2], ['cater', 2.6, 7.5, '#F2F2F0', 0], ['fuel', 2.6, 8, '#E9E6DA', 0], ['bus', 2.6, 12, '#2E6DB4', 0], ['car', 1.9, 4.6, '#F2C200', 0], ['van', 2, 5.4, '#FFFFFF', 0]];
      const route = v => {
        const A = GATES[Math.floor(Math.random() * GATES.length)], near = GATES.filter(g => g !== A && dist(NODES[g.lead].x, NODES[g.lead].y, NODES[A.lead].x, NODES[A.lead].y) < 0.22);
        const B = near.length ? near[Math.floor(Math.random() * near.length)] : A, la = NODES[A.lead], lb = NODES[B.lead];
        v.pts = [svc(A), { x: la.x, y: la.y }, { x: lb.x, y: lb.y }, svc(B)]; v.i = 0; v.s = 0; v.wait = 0;
      };
      while (this.traffic.length < want) { const kd = KINDS[Math.floor(Math.random() * KINDS.length)], v = { kd, v: (kd[0] === 'bus' ? 8 : kd[0] === 'car' ? 12 : 9) / 3600 * (0.8 + Math.random() * 0.4), t }; route(v); v.s = Math.random() * 0.05; this.traffic.push(v); }
      const DV = col => col;
      for (const v of this.traffic) {
        const dt = clamp(t - v.t, 0, 2); v.t = t;
        if (v.wait > 0) { v.wait -= dt; if (v.wait <= 0) route(v); continue; }
        // give way to aircraft: stop if one is close ahead
        let P0 = v.pts[v.i], P1 = v.pts[v.i + 1], sl = dist(P0.x, P0.y, P1.x, P1.y) || 1e-6;
        const px = P0.x + (P1.x - P0.x) * Math.min(1, v.s / sl), py = P0.y + (P1.y - P0.y) * Math.min(1, v.s / sl);
        const blocked = S.aircraft.some(o => onGround(o) && dist(o.x, o.y, px, py) < 0.03 && !['gate', 'parked'].includes(o.phase));
        if (!blocked) v.s += v.v * dt;
        while (v.s >= sl) { v.s -= sl; v.i++; if (v.i >= v.pts.length - 1) { v.i = v.pts.length - 2; v.s = sl; v.wait = 15 + Math.random() * 60; break; } P0 = v.pts[v.i]; P1 = v.pts[v.i + 1]; sl = dist(P0.x, P0.y, P1.x, P1.y) || 1e-6; }
        const f = Math.min(1, v.s / sl), x = X(P0.x + (P1.x - P0.x) * f), y = Y(P0.y + (P1.y - P0.y) * f), hd = Math.atan2(P1.x - P0.x, P1.y - P0.y);
        const [kind, w, l, col, carts] = v.kd, D = this.dimAt(P0.x + (P1.x - P0.x) * f, P0.y + (P1.y - P0.y) * f);
        c.save(); c.translate(x, y); c.rotate(hd);
        c.fillStyle = 'rgba(0,0,0,.25)'; c.fillRect(-w / 2 * M + 0.8, -l / 2 * M + 0.8, w * M, l * M);
        c.fillStyle = D(col); c.fillRect(-w / 2 * M, -l / 2 * M, w * M, l * M); c.fillStyle = D('#3A3F46'); c.fillRect(-w / 2 * M, -l / 2 * M, w * M, l * 0.25 * M);
        for (let k = 1; k <= carts; k++) { c.fillStyle = D('#8C99A6'); c.fillRect(-0.85 * M, (l / 2 + 0.6 + (k - 1) * 3.2) * M, 1.7 * M, 2.8 * M); }
        if (a > 0.3) { // headlights ahead, tail lights behind
          c.globalCompositeOperation = 'lighter';
          const hl = c.createRadialGradient(0, -l / 2 * M - 5 * M, 0, 0, -l / 2 * M - 5 * M, 7 * M); hl.addColorStop(0, `rgba(255,246,220,${0.35 * a})`); hl.addColorStop(1, 'rgba(255,246,220,0)');
          c.fillStyle = hl; c.fillRect(-7 * M, -l / 2 * M - 12 * M, 14 * M, 12 * M);
          c.fillStyle = `rgba(255,40,30,${0.8 * a})`; c.fillRect(-w / 2 * M, l / 2 * M - 0.5, Math.max(1, 0.4 * M), 1); c.fillRect(w / 2 * M - Math.max(1, 0.4 * M), l / 2 * M - 0.5, Math.max(1, 0.4 * M), 1);
          if (kind === 'car' && Math.floor(now / 400) % 2) { c.fillStyle = `rgba(255,170,0,${0.9 * a})`; c.beginPath(); c.arc(0, 0, Math.max(1.2, 0.5 * M), 0, 7); c.fill(); } // beacon on the follow-me car
        } else if (kind === 'car' && Math.floor(now / 400) % 2) { c.fillStyle = '#FFB000'; c.beginPath(); c.arc(0, 0, Math.max(1, 0.4 * M), 0, 7); c.fill(); }
        c.restore();
      }
    },
    // rain showers on the radar (thunderstorm cells are drawn by the situations)
    drawRadar(c, X, Y, sc) {
      const w = this.wx; if (!w || (w.rain + w.snow) < 0.1 || w.ts) return;
      const ww = this.windAt(3000), t = S.t / 3600;
      c.save(); c.globalAlpha = 0.35 * Math.min(1, w.rain + w.snow);
      for (let i = 0; i < 6; i++) {
        const a0 = i * 1.1, d0 = 6 + (i * 7) % 20, x = Math.sin(a0) * d0 + ww.x * t, y = Math.cos(a0) * d0 + ww.y * t, rr = (3 + (i % 3) * 2) * sc;
        const gr = c.createRadialGradient(X(x), Y(y), 0, X(x), Y(y), rr); gr.addColorStop(0, w.snow > w.rain ? 'rgba(180,200,255,.55)' : 'rgba(46,160,67,.55)'); gr.addColorStop(1, 'rgba(46,160,67,0)');
        c.fillStyle = gr; c.fillRect(X(x) - rr, Y(y) - rr, rr * 2, rr * 2);
      }
      c.restore();
    },
    status() {
      const w = this.wx; if (!w) return '';
      return `${this.src === 'live' ? 'LIVE ' : 'SIM '}${w.raw.replace(/^(METAR|SPECI)\s+/, '')}`;
    },
  };
  /* ---------- the day picture: an aerial photograph rather than a map ---------- */
  // OSM map colours and what that ground looks like from the air: [map rgb, aerial rgb, grain, kind]
  const PAL = [
    [[242, 239, 233], [132, 134, 100], 14, 'land'], [[170, 211, 223], [44, 76, 90], 5, 'water'], [[181, 208, 208], [44, 76, 90], 5, 'water'],
    [[205, 235, 176], [92, 121, 60], 13, 'grass'], [[200, 250, 204], [88, 122, 64], 13, 'veg'], [[223, 252, 226], [92, 126, 70], 12, 'veg'], [[222, 246, 192], [112, 142, 80], 10, 'veg'],
    [[238, 240, 213], [146, 138, 96], 16, 'farm'], [[173, 209, 158], [52, 74, 42], 20, 'forest'], [[157, 202, 138], [48, 70, 40], 20, 'forest'], [[200, 215, 171], [98, 110, 68], 16, 'veg'],
    [[214, 217, 159], [124, 120, 78], 14, 'veg'], [[170, 224, 203], [90, 132, 72], 8, 'veg'], [[170, 203, 175], [80, 102, 70], 14, 'veg'], [[201, 225, 191], [96, 116, 68], 16, 'veg'], [[174, 223, 163], [78, 108, 56], 16, 'veg'],
    [[224, 223, 223], [128, 126, 118], 30, 'urban'], [[242, 218, 217], [150, 148, 144], 20, 'lots'], [[255, 214, 209], [150, 146, 142], 20, 'lots'], [[235, 219, 232], [148, 147, 144], 20, 'lots'],
    [[233, 231, 226], [106, 126, 72], 10, 'aero'], [[218, 218, 224], [176, 174, 168], 6, 'paved'], [[187, 187, 204], [86, 88, 90], 5, 'paved'],
    [[217, 208, 201], [152, 148, 142], 26, 'roof'], [[196, 182, 171], [120, 116, 110], 10, 'roof'],
    [[238, 238, 238], [104, 104, 104], 22, 'lot'], [[245, 233, 198], [198, 184, 148], 10, 'sand'], [[238, 229, 220], [150, 144, 134], 14, 'land'],
    [[232, 146, 162], [86, 86, 88], 5, 'road'], [[249, 178, 156], [88, 88, 90], 5, 'road'], [[252, 214, 164], [90, 90, 92], 5, 'road'], [[247, 250, 191], [92, 92, 94], 5, 'road'], [[255, 255, 255], [96, 96, 98], 5, 'road'],
    [[192, 192, 192], [118, 118, 116], 6, 'road'], [[221, 236, 236], [210, 222, 228], 6, 'land'],
  ];
  const MEMO = new Map(); // map colour -> nearest palette entry
  const hash = n => { n = (n ^ 61) ^ (n >>> 16); n = (n + (n << 3)) | 0; n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15; return (n >>> 0) / 4294967296; };
  Object.assign(Env, {
    // how far the season has turned the grass: northern winter, southern winter
    season() {
      const m = LAYOUT && LAYOUT.map, mo = new Date().getUTCMonth() + 1; if (!m) return 0;
      if (Math.abs(m.lat) < 23) return 0.15;
      const winter = m.lat > 0 ? [11, 12, 1, 2, 3].includes(mo) : [5, 6, 7, 8, 9].includes(mo);
      return winter ? 0.45 : [4, 10].includes(mo) || (m.lat < 0 && [4, 10].includes(mo)) ? 0.2 : 0;
    },
    dayTile(t, key) {
      const sea = this.season(), sk = 'a' + sea;
      if (!t || !t.im || !t.ok) return null;
      if (t.aerial && t.aerialK === sk) return t.aerial;
      try {
        const [z, tx, ty] = String(key).split('/').map(Number);
        const cv = document.createElement('canvas'); cv.width = cv.height = 256; const g = cv.getContext('2d', { willReadFrequently: true });
        g.drawImage(t.im, 0, 0); const d = g.getImageData(0, 0, 256, 256), p = d.data;
        const seed = (tx * 73856093) ^ (ty * 19349663) ^ (z * 83492791);
        const brown = [128, 120, 82], kinds = new Uint8Array(65536), KC = { urban: 1, veg: 2, forest: 3, land: 4, farm: 5, aero: 6 };
        const lat = (LAYOUT.map && LAYOUT.map.lat) || 45, mpp = 156543.034 * Math.cos(lat * Math.PI / 180) / 2 ** (z || 17); // metres per tile pixel
        for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
          const i = (y * 256 + x) * 4, r = p[i], gg = p[i + 1], b = p[i + 2];
          const lum = (r + gg + b) / 3;
          const ck = (r << 16) | (gg << 8) | b; let hit = MEMO.get(ck);
          if (!hit) { let best = null, bd = 1e9; for (const e of PAL) { const c = e[0], dd = (r - c[0]) ** 2 + (gg - c[1]) ** 2 + (b - c[2]) ** 2; if (dd < bd) { bd = dd; best = e; } } hit = [best, bd]; if (MEMO.size < 200000) MEMO.set(ck, hit); }
          const best = hit[0], bd = hit[1];
          let o;
          if (lum < 105 || bd > 2400 || (b > r + 50 && b > 150 && lum < 160)) { // lettering and symbols: carry on the ground beside it
            const j = i - 4; o = x > 0 ? [p[j], p[j + 1], p[j + 2]] : [132, 134, 100];
            p[i] = o[0]; p[i + 1] = o[1]; p[i + 2] = o[2]; continue;
          }
          const [, base, grain, kind] = best; kinds[y * 256 + x] = KC[kind] || 0;
          o = base.slice();
          const n = hash(seed + i) - 0.5, cell = hash(seed + ((y >> 3) * 977 + (x >> 3)) * 31) - 0.5, blk = hash(seed + ((y >> 4) * 557 + (x >> 4)) * 17);
          if (kind === 'farm') { const F = [[150, 140, 96], [118, 128, 78], [138, 122, 86], [100, 124, 66], [160, 150, 112]]; o = F[Math.floor(blk * F.length)].slice(); }
          else if (kind === 'urban') { const q = hash(seed + ((y >> 1) * 1301 + (x >> 1)) * 7); o = q < 0.42 ? [118 + cell * 60, 112 + cell * 50, 104 + cell * 40] : q < 0.72 ? [72, 96, 54] : [100, 100, 100]; }
          else if (kind === 'roof') { o = [base[0] + cell * 50, base[1] + cell * 46, base[2] + cell * 42]; }
          else if (kind === 'forest') { const cl = hash(seed + ((y >> 1) * 613 + (x >> 1)) * 13); o = [base[0] + (cl - 0.5) * 26, base[1] + (cl - 0.5) * 30, base[2] + (cl - 0.5) * 18]; }
          else if (kind === 'lot') { const car = hash(seed + i * 3) < 0.05; if (car) { const cc = [[200, 200, 200], [40, 40, 44], [150, 30, 30], [60, 70, 110], [220, 220, 215]][Math.floor(hash(seed + i * 7) * 5)]; o = cc.slice(); } }
          if (kind === 'aero' || kind === 'veg' || kind === 'grass') { const big = hash(seed + ((y >> 6) * 211 + (x >> 6)) * 97) - 0.5; o[0] += big * 14; o[1] += big * 16; o[2] += big * 8; } // broad patches in the grass
          if (kind === 'veg' || kind === 'farm' || kind === 'forest' || kind === 'land' || kind === 'aero' || kind === 'grass') { o[0] += (brown[0] - o[0]) * sea; o[1] += (brown[1] - o[1]) * sea; o[2] += (brown[2] - o[2]) * sea; }
          const k = n * grain + cell * grain * 0.6;
          p[i] = clamp(o[0] + k, 0, 255); p[i + 1] = clamp(o[1] + k, 0, 255); p[i + 2] = clamp(o[2] + k * 0.8, 0, 255);
        }
        g.putImageData(d, 0, 0);
        // trees: canopies with their shadows in gardens, parks, along roads and in the woods (never on the airfield grass)
        const rr = 4 / mpp;
        if (rr >= 0.7) {
          const step = Math.max(2, Math.round(rr * 1.6)), P = { 1: 0.2, 2: 0.13, 3: 0.75, 4: 0.06, 5: 0.015 };
          for (let y = 0; y < 256; y += step) for (let x = 0; x < 256; x += step) {
            const jx = x + Math.floor(hash(seed + x * 7 + y * 131) * step), jy = y + Math.floor(hash(seed + x * 13 + y * 71) * step); if (jx > 255 || jy > 255) continue;
            const kd = kinds[jy * 256 + jx], pr = P[kd]; if (!pr || hash(seed + jx * 31 + jy * 977) > pr) continue;
            const R = rr * (0.7 + hash(seed + jx * 3 + jy * 5) * 0.8), gtone = 0.75 + hash(seed + jx + jy * 9) * 0.5;
            g.fillStyle = 'rgba(10,16,8,.38)'; g.beginPath(); g.arc(jx + R * 0.55, jy + R * 0.45, R, 0, 7); g.fill();
            const cg = g.createRadialGradient(jx - R * 0.35, jy - R * 0.35, 0, jx, jy, R);
            const base = sea > 0.3 && kd !== 3 ? [92, 88, 60] : [50, 78, 40];
            cg.addColorStop(0, `rgb(${Math.round(base[0] * gtone * 1.45)},${Math.round(base[1] * gtone * 1.35)},${Math.round(base[2] * gtone * 1.3)})`); cg.addColorStop(1, `rgb(${Math.round(base[0] * gtone * 0.75)},${Math.round(base[1] * gtone * 0.75)},${Math.round(base[2] * gtone * 0.75)})`);
            g.fillStyle = cg; g.beginPath(); g.arc(jx, jy, R, 0, 7); g.fill();
          }
        }
        t.aerial = cv; t.aerialK = sk;
      } catch (e) { t.aerial = null; return null; }
      return t.aerial;
    },
    // small repeating textures, made once
    tex(name) {
      this.tx = this.tx || {}; if (this.tx[name]) return this.tx[name];
      const cv = document.createElement('canvas'), N = name === 'noise' ? 256 : 128; cv.width = cv.height = N; const g = cv.getContext('2d');
      if (name === 'noise') { const d = g.createImageData(N, N); for (let i = 0; i < N * N; i++) { const v = 128 + (hash(i * 7 + 3) - 0.5) * 90 + (hash(((i >> 10) * 31 + ((i & 255) >> 2)) * 5) - 0.5) * 40; d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = v; d.data[i * 4 + 3] = 255; } g.putImageData(d, 0, 0); }
      if (name === 'joints') { g.fillStyle = '#fff'; g.fillRect(0, 0, N, N); g.fillStyle = 'rgba(70,70,70,.9)'; for (let k = 0; k < 4; k++) { g.fillRect(k * N / 4, 0, 1.2, N); g.fillRect(0, k * N / 4, N, 1.2); } for (let k = 0; k < 6; k++) { g.fillStyle = `rgba(0,0,0,${0.03 + hash(k * 11) * 0.05})`; g.fillRect(Math.floor(hash(k * 3) * 4) * N / 4, Math.floor(hash(k * 5) * 4) * N / 4, N / 4, N / 4); } }
      if (name === 'hvac') {
        g.clearRect(0, 0, N, N);
        for (let k = 0; k < 9; k++) { const x = hash(k * 13) * (N - 20), y = hash(k * 17) * (N - 14), w = 6 + hash(k * 19) * 14, h = 5 + hash(k * 23) * 9; g.fillStyle = 'rgba(0,0,0,.4)'; g.fillRect(x + 2.5, y + 2.5, w, h); g.fillStyle = hash(k * 29) < 0.5 ? '#C4C5C4' : '#8F9295'; g.fillRect(x, y, w, h); g.strokeStyle = 'rgba(60,60,60,.5)'; g.lineWidth = 0.6; g.strokeRect(x, y, w, h); }
        g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, N * 0.66); g.lineTo(N, N * 0.66); g.stroke();
      }
      if (name === 'clouds' || name === 'fog') {
        const small = document.createElement('canvas'), sn = name === 'fog' ? 24 : 16; small.width = small.height = sn; const sg = small.getContext('2d'), sd = sg.createImageData(sn, sn);
        for (let i = 0; i < sn * sn; i++) { const v = hash(i * 31 + (name === 'fog' ? 7 : 3)); const a = name === 'fog' ? Math.max(0, v - 0.35) * 1.6 : Math.max(0, v - 0.45) * 2; sd.data[i * 4] = sd.data[i * 4 + 1] = sd.data[i * 4 + 2] = name === 'fog' ? 235 : 60; sd.data[i * 4 + 3] = Math.round(a * 255); }
        sg.putImageData(sd, 0, 0);
        // wrap the edges so the pattern tiles, then blow it up smoothly with a blur
        const big = document.createElement('canvas'); big.width = big.height = N * 3; const bg = big.getContext('2d'); bg.imageSmoothingEnabled = true;
        for (let ix = 0; ix < 3; ix++) for (let iy = 0; iy < 3; iy++) bg.drawImage(small, ix * N, iy * N, N, N);
        g.filter = `blur(${name === 'fog' ? 7 : 9}px)`; g.drawImage(big, N, N, N, N, 0, 0, N, N); g.filter = 'none';
        if (name === 'clouds') { g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, N, N); g.globalCompositeOperation = 'source-over'; }
      }
      if (name === 'mow') { for (let k = 0; k < 8; k++) { g.fillStyle = k % 2 ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.45)'; g.fillRect(0, k * N / 8, N, N / 8); } }
      return this.tx[name] = cv;
    },
    // a pattern laid on the world: `metres` of ground per repeat, lined up with the runways
    pat(c, name, metres, sc, X, Y) {
      const im = this.tex(name), p = c.createPattern(im, 'repeat'), k = metres / 1852 * sc / im.width;
      p.setTransform(new DOMMatrix([k, 0, 0, k, X(0), Y(0)])); return p;
    },
    // under the pavement: mowing stripes on the airfield grass
    paintBase2(c, r, X, Y, sc) {
      if (this.light().day < 0.05 || !LAYOUT.data) return;
      const M = sc / 1852, b = LAYOUT.data.bounds; if (M < 0.15) return;
      c.save(); c.globalCompositeOperation = 'soft-light'; c.globalAlpha = 0.09;
      c.fillStyle = this.pat(c, 'mow', 96, sc, X, Y);
      c.fillRect(X(b[0]), Y(b[3]), (b[2] - b[0]) * sc, (b[3] - b[1]) * sc);
      c.restore();
    },
    // shadows of the buildings, cast away from the sun
    bldShadows(c, F) {
      const L = this.light(); if (L.shadow < 0.03) return;
      const sa = rad((L.az - ROT) + 180), len = Math.min(3, 1 / Math.tan(rad(Math.max(L.el, 8)))), wx = Math.sin(sa) * len, wy = Math.cos(sa) * len;
      c.fillStyle = `rgba(20,26,34,${0.34 * L.shadow})`;
      for (const b of F.bld) {
        if (!b.foot) continue;
        const dx = wx * b.h / 1852, dy = wy * b.h / 1852, steps = Math.max(2, Math.min(6, Math.ceil(b.h / 6)));
        for (let s = 1; s <= steps; s++) { c.save(); c.translate(dx * s / steps, dy * s / steps); c.fill(b.foot); c.restore(); }
      }
    },
    // the photographic detail laid over the airfield before the light of the hour
    dayDetail(c, r, X, Y, sc) {
      const M = sc / 1852, F = fieldShapes(LAYOUT), dpr = c.canvas.width / r.w, base = () => c.setTransform(dpr, 0, 0, dpr, 0, 0);
      const clipWorld = path => { c.transform(sc, 0, 0, -sc, X(0), Y(0)); c.clip(path); base(); };
      c.save();
      // concrete slabs and their joints on the aprons, oil and rubber at the stands
      if (M > 0.35) {
        c.save(); clipWorld(F.aprons);
        c.globalCompositeOperation = 'multiply'; c.globalAlpha = clamp((M - 0.35) * 0.45, 0, 0.24); c.fillStyle = this.pat(c, 'joints', 30, sc, X, Y); c.fillRect(r.x, r.y, r.w, r.h);
        c.globalAlpha = 1;
        for (const g of GATES) { const [lx, ly, nx, ny] = g.line, x = X(nx * 0.75 + lx * 0.25), y = Y(ny * 0.75 + ly * 0.25), rr = 22 * M; const gr = c.createRadialGradient(x, y, 0, x, y, rr); gr.addColorStop(0, 'rgba(90,86,80,.13)'); gr.addColorStop(1, 'rgba(90,86,80,0)'); c.fillStyle = gr; c.fillRect(x - rr, y - rr, rr * 2, rr * 2); }
        c.restore();
      }
      // grain over everything: no surface is flat paint from the air
      c.globalCompositeOperation = 'soft-light'; c.globalAlpha = 0.2; c.fillStyle = this.pat(c, 'noise', clamp(60 / Math.max(M, 0.2), 30, 300), sc, X, Y); c.fillRect(r.x, r.y, r.w, r.h); c.globalAlpha = 1;
      // rubber laid down in the touchdown zones, a darker wear line down the middle
      c.globalCompositeOperation = 'multiply';
      for (const k in RWY) {
        const R = RWY[k]; if (R.closed) continue;
        const w = R.width * M, y0 = Y(R.y);
        const zone = (from, dir) => { const xa = X(from + dir * 150 / 1852), xb = X(from + dir * 1100 / 1852); const gr = c.createLinearGradient(xa, 0, xb, 0); gr.addColorStop(0, 'rgba(40,40,42,0)'); gr.addColorStop(0.15, 'rgba(40,40,42,.55)'); gr.addColorStop(0.6, 'rgba(60,60,62,.35)'); gr.addColorStop(1, 'rgba(70,70,72,0)'); c.fillStyle = gr; c.fillRect(Math.min(xa, xb), y0 - w * 0.36, Math.abs(xb - xa), w * 0.72); };
        zone(R.x1, 1); zone(R.x2, -1);
        c.fillStyle = 'rgba(70,70,72,.25)'; c.fillRect(X(R.x1), y0 - w * 0.08, (R.x2 - R.x1) * sc, w * 0.16);
      }
      // roofs: plant, vents and skylights
      if (M > 0.4) {
        const all = F.roofs || (F.roofs = (() => { const q = new Path2D(); for (const b of F.bld) q.addPath(b.roof); return q; })());
        c.save(); clipWorld(all);
        c.globalCompositeOperation = 'source-over'; c.globalAlpha = clamp((M - 0.4) * 1.2, 0, 0.9); c.fillStyle = this.pat(c, 'hvac', 70, sc, X, Y); c.fillRect(r.x, r.y, r.w, r.h);
        c.restore();
      }
      c.restore();
    },
  });
  Env.parse = parseMetar; Env.sunAt = sunAt;
  window.Env = Env;
})();
