'use strict';
/* ==========================================================================
   Procedures and terrain: published departure turns (SIDs), the published missed approach,
   arrivals routed over their entry fix (STARs), minimum vectoring altitudes from the real terrain,
   the radar's low altitude alert (MSAW) and the aircraft's own terrain warning (TAWS).
   Altitudes in the sim are above the airfield, so terrain is stored as height above the field.
   ========================================================================== */
(() => {
  // peaks: [name, lat, lon, top ft MSL, radius NM]. wps: extra waypoints [name, true bearing, NM].
  // sid / ma by runway: at = NM past the field before turning, wps = waypoints in order, alt = missed approach altitude,
  // hold = hold at the last waypoint when a controller is working the aircraft.
  const DATA = {
    LOWS: {
      elev: 1411, base: 2500, initAlt: 8000,
      peaks: [['Untersberg', 47.700, 13.003, 6470, 1.8], ['Gaisberg', 47.805, 13.112, 4226, 1.2], ['Hochstaufen', 47.762, 12.807, 5814, 1.5], ['Watzmann', 47.555, 12.922, 8901, 2],
        ['Hoher Göll', 47.594, 13.065, 8274, 2], ['Schafberg', 47.776, 13.433, 5850, 1.5], ['Zwölferhorn', 47.740, 13.350, 4990, 1.5], ['Osterhorn', 47.680, 13.250, 5300, 2.5],
        ['Tennengebirge', 47.500, 13.300, 7976, 3], ['Hochkönig', 47.420, 13.063, 9649, 3]],
      wps: [['SBG', 330, 9], ['FREIL', 285, 4.5]],
      sid: { '15': { at: 0.8, wps: ['FREIL'] } }, // an early right turn: the Untersberg is 5 NM ahead
      ma: { '15': { at: 0.3, alt: 7000, wps: ['FREIL', 'SBG'], hold: true }, '33': { at: 3, alt: 7000, wps: ['SBG'], hold: true } },
    },
    TNCM: {
      elev: 13, base: 1500,
      peaks: [['Pic Paradis', 18.074, -63.050, 1391, 1.5], ['Mount Scenery', 17.635, -63.237, 2910, 1.5], ['The Quill', 17.478, -62.961, 1972, 1], ['Morne du Vitet', 17.900, -62.830, 938, 1.2]],
      wps: [['SIMPS', 170, 5]],
      sid: { '10': { at: 1, wps: ['SIMPS'] } },
      ma: { '10': { at: 1, alt: 2500, wps: ['SIMPS'], hold: true }, '28': { at: 3, alt: 2500, wps: ['SIMPS'], hold: true } },
    },
    CYVR: {
      elev: 14, base: 2000, initAlt: 7000,
      peaks: [['Grouse', 49.380, -123.081, 4039, 1.5], ['Seymour', 49.397, -122.941, 4754, 1.5], ['Strachan', 49.414, -123.193, 4770, 1.5], ['Brunswick', 49.487, -123.206, 5866, 2],
        ['Golden Ears', 49.474, -122.466, 5630, 2.5], ['Mount Baker', 48.777, -121.813, 10781, 4]],
      wps: [], sid: {}, ma: {},
    },
    LPMA: {
      elev: 192, base: 2500,
      peaks: [['Pico Ruivo', 32.759, -16.943, 6109, 3], ['Pico do Arieiro', 32.735, -16.928, 5965, 2.5], ['Santo da Serra', 32.730, -16.820, 2200, 1.5], ['Pico do Facho, Porto Santo', 33.080, -16.330, 1693, 1.5], ['Paul da Serra', 32.740, -17.050, 5200, 3]],
      wps: [['SEA05', 135, 6]], sid: {}, ma: {},
    },
    EGJJ: { elev: 277, base: 2000, peaks: [], wps: [], sid: {}, ma: {} },
    LFLB: {
      elev: 779, base: 3500, initAlt: 8000,
      peaks: [['Mont du Chat', 45.660, 5.800, 4970, 2], ['Dent du Nivolet', 45.610, 5.970, 5056, 1.2], ['Mont Granier', 45.460, 5.930, 6355, 1.5], ['Mont Margériaz', 45.620, 6.070, 5830, 1.5], ['Grand Colombier', 45.900, 5.760, 5033, 2]],
      wps: [['LAC', 352, 8], ['MTM', 150, 7]], sid: {},
      ma: { '18': { at: 1, alt: 6000, wps: ['MTM'], hold: true }, '36': { at: 2, alt: 6000, wps: ['LAC'], hold: true } }, // up the valley, or out over the lake
    },
    EGLL: { elev: 83, base: 2000, peaks: [['The Shard', 51.5045, -0.0865, 1016, 0.3], ['Crystal Palace mast', 51.424, -0.075, 1080, 0.3]], wps: [], sid: {}, ma: {} },
  };
  const DEF_MA = { at: 3, alt: 3000, wps: [] };
  const ceil100 = v => Math.ceil(v / 100) * 100;

  const Proc = {
    peaks: [], d: null,
    build(L) {
      const d = this.d = DATA[L.icao] || { elev: 0, base: 2000, peaks: [], wps: [], sid: {}, ma: {} };
      APT.elev = d.elev;
      const ll = [L.map.lat, L.map.lon];
      this.peaks = d.peaks.map(([name, lat, lon, top, r]) => {
        const g = geo(ll, lat, lon), a = (g.b - ROT) * Math.PI / 180;
        return { name, x: Math.sin(a) * g.d, y: Math.cos(a) * g.d, top, rel: top - d.elev, r };
      });
      for (const [n, b, dd] of d.wps) addFix(n, b, dd, 'proc');
    },
    // the minimum vectoring altitude here: 1000 ft above anything within the peak's reach plus 2 NM
    mva(x, y) {
      if (!this.d) return 2000;
      let m = this.d.base;
      // the final approach corridor is protected by the published approach itself: only what's really in it counts
      const g = locGeom(x, y), buf = g.d > -1 && g.d < 22 && Math.abs(g.cross) < 5 ? 0.3 : 2;
      for (const p of this.peaks) if (dist(x, y, p.x, p.y) < p.r + buf) m = Math.max(m, ceil100(p.rel + 1000));
      return m;
    },
    // the highest MVA between two points (for vectors: the whole leg must be clear)
    mvaAlong(x1, y1, x2, y2) { let m = 0; for (let i = 0; i <= 8; i++) m = Math.max(m, this.mva(x1 + (x2 - x1) * i / 8, y1 + (y2 - y1) * i / 8)); return m; },
    // still on the runway track before the published turn (the sim must not turn it toward its exit fix yet)
    holdsTrack(ac) { const s = this.d && this.d.sid[ac.sidRwy || this.rwyKey('dep')]; return !!(s && ac.sidI == null && !ac.vectored); },
    // how far past the field centre, along the runway direction
    past(ac, crs) { const u = crs * Math.PI / 180; return ac.x * Math.sin(u) + ac.y * Math.cos(u); },
    rwyKey(kind) { return kind === 'dep' ? depRwyName() : arrRwyName(); },

    // a departure: the published turn after takeoff, then on to its exit fix
    sidStep(ac) {
      const s = this.d && this.d.sid[ac.sidRwy || (ac.sidRwy = this.rwyKey('dep'))];
      if (!s || ac.vectored || ac.sidDone) return;
      if (ac.sidI == null) {
        if (this.past(ac, ac.hdg0 != null ? ac.hdg0 : (ac.hdg0 = ac.hdg)) < s.at || ac.alt < 400) { ac.tgtHdg = ac.hdg0; return; } // straight ahead on the runway track
        ac.sidI = 0;
      }
      const w = s.wps[ac.sidI];
      if (!w || !FIXES[w]) { ac.sidDone = true; return; }
      if (ac.direct && ac.direct !== w) { ac.sidDone = true; return; } // the controller sent it elsewhere
      ac.direct = w;
      if (dist(ac.x, ac.y, FIXES[w].x, FIXES[w].y) < 1.2) { ac.sidI++; ac.direct = null; if (ac.sidI >= s.wps.length) ac.sidDone = true; }
    },
    // a go-around flies the published missed approach until a controller says otherwise
    missed(ac) {
      const m = (this.d && this.d.ma[this.rwyKey('arr')]) || DEF_MA;
      ac.ma = { m, ph: 'straight', i: 0, set: course() };
      ac.tgtHdg = ac.ma.set; ac.tgtAlt = m.alt; ac.turnDir = null;
    },
    maStep(ac) {
      const a = ac.ma;
      // a controller took over: a heading, a direct, a hold or an approach clearance
      const took = ac.ils || ac.holdFix; // (a heading or a direct clears ac.ma where it's given)
      if (took) { ac.ma = null; return; }
      if (a.ph === 'straight') {
        a.set = ac.tgtHdg = course();
        const g = locGeom(ac.x, ac.y);
        if (this.past(ac, course()) > a.m.at) a.ph = a.m.wps.length ? 'wps' : 'done';
        return;
      }
      if (a.ph === 'wps') {
        const w = a.m.wps[a.i], f = FIXES[w];
        if (!f) { a.ph = 'done'; return; }
        ac.direct = w; a.started = true;
        if (dist(ac.x, ac.y, f.x, f.y) < 1.2) {
          a.i++; a.started = false;
          if (a.i >= a.m.wps.length) {
            ac.direct = null; ac.ma = null;
            // hold there as published while a controller is working it; the AI vectors it straight back instead
            if (a.m.hold && S.staffed[ac.freq] && window.Sit && Sit.startHold) Sit.startHold(ac, { fix: w });
          }
        }
        return;
      }
      ac.ma = null;
    },

    // every step, for an aircraft in the air
    stepAc(ac, dt) {
      if (onGround(ac) || !this.d) return;
      if (ac.kind === 'dep' && (ac.phase === 'climb' || ac.phase === 'dep')) this.sidStep(ac);
      if (ac.ma) this.maStep(ac);
      this.terrain(ac, dt);
    },
    terrain(ac, dt) {
      if (ac.alt < 50 || ac.phase === 'takeoff') return;
      const fd = dist(0, 0, ac.x, ac.y), g = locGeom(ac.x, ac.y);
      // the aircraft's own terrain warning: too close to a mountain → it climbs, whatever it was told
      const hit = this.peaks.find(p => dist(ac.x, ac.y, p.x, p.y) < p.r && ac.alt < p.rel + 300);
      if (hit && !(ac.loc && ac.gs)) {
        if (!ac.taws || S.t - ac.taws > 60) {
          ac.taws = S.t; S.stats.taws = (S.stats.taws || 0) + 1;
          ac.tgtAlt = Math.max(ac.tgtAlt, this.mva(ac.x, ac.y)); ac.altAssigned = true;
          award(-200, `${ac.cs}: terrain warning near ${hit.name}`);
          UI.log('SYS', `⚠ ${ac.cs} had a terrain warning near ${hit.name} (${hit.top} ft) and is climbing.`, 'alert');
          pilotSay(ac, `${ac.cs}, terrain warning, climbing.`);
        }
        return;
      }
      // the radar's low altitude alert: below the minimum vectoring altitude, now or in 30 seconds.
      // Not on the ILS, not climbing out near the field, not on short final.
      const exempt = (ac.loc) || ((ac.kind === 'dep' || ac.ma) && ac.tgtAlt > ac.alt + 200 && fd < 15) || (fd < 3 && ac.alt < 1600) || (g.d > 0 && g.d < 12 && Math.abs(g.cross) < 1 && ac.ils);
      const r = ac.hdg * Math.PI / 180, ahead = ac.spd / 3600 * 30, px = ac.x + Math.sin(r) * ahead, py = ac.y + Math.cos(r) * ahead;
      const m = Math.max(this.mva(ac.x, ac.y), this.mva(px, py)), pAlt = ac.alt + Math.min(0, ac.vs || 0) * 30;
      const low = !exempt && (ac.alt < m - 200 || pAlt < m - 200) && ac.tgtAlt < m - 100;
      if (low && !ac.msaw) {
        ac.msaw = { t: S.t, m }; S.stats.msaw = (S.stats.msaw || 0) + 1;
        Radio.alert('ca');
        UI.log('SYS', `LOW ALTITUDE ALERT: ${ac.cs} at ${fmtAlt(Math.round(ac.alt / 100) * 100)}, the minimum vectoring altitude here is ${fmtAlt(m)}.`, 'alert');
        if (!S.staffed[ac.freq] && ac.freq !== 'CTR' && typeof AI !== 'undefined') AI.say(ac, ac.freq, this.alertText(ac).text);
      } else if (ac.msaw && (ac.tgtAlt >= ac.msaw.m - 100 || exempt)) ac.msaw = null;
      else if (ac.msaw && !ac.msaw.pen && S.t - ac.msaw.t > 40 && S.staffed[ac.freq]) { ac.msaw.pen = true; award(-100, `${ac.cs}: low altitude alert not resolved`); }
    },
    alertText(ac) {
      const m = ac.msaw ? ac.msaw.m : this.mva(ac.x, ac.y);
      return { type: 'msaw', label: 'Low altitude alert', pos: ac.freq, text: `${ac.cs}, low altitude alert, check your altitude immediately, the minimum altitude in the area is ${m}, climb and maintain ${m}`,
        template: `${ac.cs}, low altitude alert, check your altitude immediately, climb and maintain ▢MVA`,
        why: 'The radar’s low altitude alert (MSAW): the aircraft is, or soon will be, below the minimum vectoring altitude over the terrain here. Tell the pilot at once and give a safe altitude.' };
    },
    // the radar map: the high ground, with its height
    drawRadar(c, X, Y, sc) {
      if (!this.peaks.length) return;
      c.save(); c.font = '9.5px Inconsolata, monospace'; c.textAlign = 'left';
      for (const p of this.peaks) {
        const x = X(p.x), y = Y(p.y), rr = (p.r + 2) * sc;
        c.strokeStyle = 'rgba(176,138,96,0.22)'; c.setLineDash([3, 5]); c.beginPath(); c.arc(x, y, rr, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
        c.strokeStyle = c.fillStyle = 'rgba(196,158,112,0.7)';
        c.beginPath(); c.moveTo(x - 5, y + 3); c.lineTo(x, y - 4); c.lineTo(x + 5, y + 3); c.stroke();
        c.fillText(String(Math.round(p.top / 100)).padStart(3, '0'), x + 7, y + 3);
      }
      c.restore();
    },
  };
  window.Proc = Proc;
})();
