'use strict';
/* ==========================================================================
   Situations: the non-routine events of real ATC work, after FAA JO 7110.65
   (Air Traffic Control) and ICAO Doc 4444 (PANS-ATM), with what the controller
   is expected to do in each one.

   Emergencies   mayday / pan-pan inbound, departure emergency and return, rejected
                 takeoff, aircraft disabled on the runway, minimum fuel that becomes
                 a fuel emergency, pan with a hold to run a checklist, radio failure
                 (7600), unlawful interference code (7500)
   Runway        runway incursion, debris (FOD) and runway inspection, wind shear
                 go-around, birds, laser, drone reports passed on to the next aircraft
   Airspace      TCAS resolution advisories, VFR pop-up traffic needing advisories,
                 thunderstorms and deviations, low visibility procedures (fog),
                 holding, visual approaches, pilot requests (direct, higher)
   Ground        breakdown on the taxiway, return to stand, similar callsigns

   The game's sim calls in at a few hook points (Sit.step, Sit.parse, Sit.before,
   Sit.apply, Sit.after, Sit.suggest, Sit.heard, Sit.deaf, Sit.landed ...).
   ========================================================================== */
(function () {
  const air = ac => !onGround(ac) && ac.phase !== 'gate';
  const alive = ac => ac && S.aircraft.includes(ac);
  const staffed = p => !!S.staffed[p];
  const tel = ac => `${ac.al.tel} ${ac.num}`;
  const clock = (ac, x, y) => { const r = hdgDiff(ac.hdg, brg(ac.x, ac.y, x, y)); let k = Math.round(norm360(r) / 30) % 12; return k || 12; };
  const fixOf = w => { if (!w) return null; const U = w.toUpperCase(); if (FIXES[U]) return U; return Object.keys(FIXSAY || {}).find(k => FIXSAY[k].split(' ')[0].toLowerCase() === w && FIXES[k]) || null; };
  const nearestFix = ac => { let b = null, bd = 1e9; for (const k in FIXES) { const f = FIXES[k], d = dist(ac.x, ac.y, f.x, f.y); if (f.kind === 'arr' && d < bd) { bd = d; b = k; } } return b || Object.keys(FIXES)[0]; };
  const freeArrGate = ac => freeGate({ type: ac.type, kind: 'arr', id: ac.id });

  // What each situation request is called, who answers it, and which of the controller's instructions settle it
  const REQS = {
    sit_emg: { pos: 'APP', label: 'Mayday: priority vectors', active: true, by: ['hdg', 'alt', 'direct', 'ils', 'visual', 'ack', 'souls', 'services', 'hold', 'approve'] },
    sit_emgtwr: { pos: 'TWR', label: 'Mayday: return to land', active: true, by: ['contact', 'land', 'ack', 'services', 'hdg', 'alt'] },
    sit_hold: { pos: 'APP', label: 'PAN: hold for checklist', active: true, by: ['hold', 'hdg', 'approve', 'ack', 'direct'] },
    sit_ready: { pos: 'APP', label: 'Ready for approach', active: true, by: ['hdg', 'alt', 'ils', 'direct', 'visual'] },
    sit_minfuel: { pos: 'APP', label: 'Minimum fuel', active: false, by: ['ack', 'hdg', 'alt', 'direct', 'ils', 'visual', 'spd'] },
    sit_wx: { pos: 'APP', label: 'Weather deviation', active: true, by: ['deviate', 'devno', 'approve', 'hdg', 'unable', 'direct'] },
    sit_wxclr: { pos: 'APP', label: 'Clear of weather', active: true, by: ['hdg', 'direct', 'ils', 'ack', 'approve', 'visual'] },
    sit_report: { pos: 'TWR', label: 'Pilot report', active: false, by: ['*'] },
    sit_rto: { pos: 'TWR', label: 'Rejected takeoff', active: true, by: ['holdpos', 'ack', 'assist', 'services', 'taxi'] },
    sit_stuck: { pos: 'TWR', label: 'Disabled on runway', active: true, by: ['holdpos', 'ack', 'assist', 'services'] },
    sit_tow: { pos: 'GND', label: 'Breakdown: needs tow', active: true, by: ['holdpos', 'ack', 'assist', 'services'] },
    sit_return: { pos: 'GND', label: 'Return to stand', active: true, by: ['taxi'] },
    sit_visual: { pos: 'APP', label: 'Visual approach request', active: true, by: ['visual', 'unable', 'ils', 'approve'] },
    sit_direct: { pos: 'APP', label: 'Pilot request', active: true, by: ['direct', 'alt', 'unable', 'approve'] },
    sit_ra: { pos: 'APP', label: 'TCAS RA', active: false, by: ['ack', '*'] },
    sit_efc: { pos: 'APP', label: 'Holding: EFC passed', active: true, by: ['efc', 'hdg', 'direct', 'ils', 'visual', 'hold', 'approve', 'alt'] },
    sit_racl: { pos: 'APP', label: 'Clear of conflict', active: false, by: ['ack', 'hdg', 'alt', 'direct', '*'] },
  };
  for (const k in REQS) REQ[k] = { pos: REQS[k].pos, label: REQS[k].label, active: REQS[k].active };
  const LBL = { deviate: 'deviation approved', notyou: 'not for you', devno: 'deviation not approved', approve: 'request approved', hold: 'hold', efc: 'expect further clearance', souls: 'souls and fuel', assist: 'assistance', services: 'emergency services', vsq: 'verify squawk', green: 'light gun: steady green', visual: 'visual approach', exped: 'expedite', unable: 'unable', intent: 'say intentions' };

  // Emergencies that arrive with a new inbound (the game's own mayday pick uses this list)
  const INBOUND = [
    { t: 'engine failure', say: 'engine failure, single engine', w: 3 },
    { t: 'medical emergency', say: 'medical emergency, passenger in cardiac arrest', w: 2, med: true },
    { t: 'low fuel', say: 'fuel emergency, we must land now', w: 2 },
    { t: 'smoke in the cabin', say: 'smoke in the cabin', w: 2, stop: 'we will stop on the runway for the fire services to check the aircraft' },
    { t: 'hydraulic failure', say: 'hydraulic failure, we will have no nosewheel steering after landing', w: 2, stop: 'no nosewheel steering, we are stopped on the runway and need a tow' },
    { t: 'bird strike', say: 'bird strike, number two engine damaged', w: 1 },
    { t: 'medical (urgency)', say: 'a sick passenger on board, request priority and an ambulance at the stand', w: 3, pan: true, med: true },
    { t: 'pressurisation problem (urgency)', say: 'a pressurisation problem, we are fine at this altitude, request priority', w: 1, pan: true },
  ];
  if (typeof EMG !== 'undefined') { EMG.length = 0; for (const e of INBOUND) for (let i = 0; i < e.w; i++) EMG.push(e); }

  // The catalogue. can(): is there someone (or something) this can happen to right now? start(): make it happen.
  const CAT = [
    { id: 'mayday', name: 'Mayday inbound', major: true, pos: ['APP', 'TWR'], w: 3, can: () => true, start: () => { S.nextEmg = S.t; return true; } },
    { id: 'depemg', name: 'Departure emergency and return', major: true, pos: ['APP', 'TWR'], w: 3,
      can: () => S.aircraft.find(a => a.kind === 'dep' && ['climb', 'dep'].includes(a.phase) && a.alt > 1200 && a.alt < 8000 && ['TWR', 'APP'].includes(a.freq) && !a.sit),
      start: ac => depEmergency(ac) },
    { id: 'rto', name: 'Rejected takeoff', major: true, pos: ['TWR'], w: 2, arm: true },
    { id: 'tyre', name: 'Aircraft disabled on the runway', major: true, pos: ['TWR'], w: 2, arm: true },
    { id: 'incursion', name: 'Runway incursion', major: true, pos: ['TWR'], w: 2, arm: true, ok: () => mixedOps() },
    { id: 'nordo', name: 'Radio failure (7600)', major: true, pos: ['APP', 'TWR'], w: 2,
      can: () => S.aircraft.find(a => a.kind === 'arr' && a.phase === 'arr' && a.freq === 'APP' && !a.loc && !a.ils && !a.emg && !a.sit && locGeom(a.x, a.y).d > 14),
      start: ac => nordo(ac) },
    { id: 'sq7500', name: 'Code 7500 (unlawful interference)', major: true, pos: ['APP'], w: 1,
      can: () => S.aircraft.find(a => a.kind === 'arr' && a.phase === 'arr' && a.freq === 'APP' && !a.loc && !a.emg && !a.sit && !a.request),
      start: ac => code7500(ac) },
    { id: 'pan_hold', name: 'PAN: hold to run a checklist', major: true, pos: ['APP'], w: 2,
      can: () => S.aircraft.find(a => a.kind === 'arr' && a.phase === 'arr' && a.freq === 'APP' && !a.loc && !a.ils && !a.emg && !a.sit && !a.request && locGeom(a.x, a.y).d > 10),
      start: ac => panHold(ac) },
    { id: 'minfuel', name: 'Minimum fuel', pos: ['APP'], w: 2,
      can: () => S.aircraft.find(a => a.kind === 'arr' && a.phase === 'arr' && a.freq === 'APP' && !a.emg && !a.sit && !a.request && !a.loc),
      start: ac => minFuel(ac) },
    { id: 'windshear', name: 'Wind shear go-around', pos: ['TWR'], w: 2, arm: true, hazard: true },
    { id: 'laser', name: 'Laser illumination', pos: ['TWR'], w: 1, hazard: true,
      can: () => S.aircraft.find(a => a.kind === 'arr' && a.loc && a.freq === 'TWR' && !a.sit && locGeom(a.x, a.y).d > 2 && locGeom(a.x, a.y).d < 7),
      start: ac => report(ac, 'laser') },
    { id: 'birds', name: 'Bird activity', pos: ['TWR'], w: 2, hazard: true,
      can: () => S.aircraft.find(a => a.freq === 'TWR' && !a.sit && ((a.kind === 'arr' && a.loc && locGeom(a.x, a.y).d < 5) || (a.kind === 'dep' && a.phase === 'climb' && a.alt < 2500))),
      start: ac => report(ac, 'birds') },
    { id: 'drone', name: 'Drone sighting', pos: ['TWR', 'APP'], w: 1, hazard: true,
      can: () => S.aircraft.find(a => a.kind === 'arr' && a.loc && ['TWR', 'APP'].includes(a.freq) && !a.sit && locGeom(a.x, a.y).d > 4 && locGeom(a.x, a.y).d < 10),
      start: ac => report(ac, 'drone') },
    { id: 'fod', name: 'Debris on the runway', major: true, pos: ['TWR'], w: 2,
      can: () => S.aircraft.find(a => a.kind === 'dep' && a.phase === 'climb' && a.freq === 'TWR' && a.alt > 300 && a.alt < 2000 && !a.sit),
      start: ac => fod(ac) },
    { id: 'wx', name: 'Thunderstorms', pos: ['APP'], w: 2, ok: () => !window.Env && !Sit.cells.length, start: () => storms() }, // with real or chosen weather, storms come from the weather
    { id: 'lvp', name: 'Fog: low visibility procedures', pos: ['TWR', 'GND', 'APP'], w: 1, ok: () => !window.Env && !S.lvp, start: () => fog() },
    { id: 'vfr', name: 'VFR pop-up traffic', pos: ['APP', 'TWR'], w: 2, ok: () => Sit.vfr.length < 2, start: () => popup() },
    { id: 'breakdown', name: 'Breakdown on the taxiway', major: true, pos: ['GND'], w: 2,
      can: () => S.aircraft.find(a => a.kind === 'dep' && a.phase === 'taxiing' && a.freq === 'GND' && !a.held && !a.sit && a.path.length > 3),
      start: ac => breakdown(ac) },
    { id: 'return', name: 'Return to stand', pos: ['GND'], w: 2,
      can: () => S.aircraft.find(a => a.kind === 'dep' && a.phase === 'taxiing' && a.freq === 'GND' && !a.sit && a.path.length > 2),
      start: ac => returnToStand(ac) },
    { id: 'similar', name: 'Similar callsigns', pos: ['DEL', 'GND', 'TWR', 'APP'], w: 2, arm: true },
    { id: 'visual', name: 'Visual approach request', pos: ['APP'], w: 2, ok: () => !S.lvp && !Sit.cells.length && (!window.Env || Env.vmc()),
      can: () => S.aircraft.find(a => a.kind === 'arr' && a.phase === 'arr' && a.freq === 'APP' && !a.ils && !a.request && !a.sit && !a.emg && a.alt < 9000 && locGeom(a.x, a.y).d > 6 && locGeom(a.x, a.y).d < 24),
      start: ac => raise(ac, 'sit_visual', `${ac.cs}, we have the field in sight, request the visual approach runway ${arrRwyName()}.`, `${ac.cs}, still looking for that visual approach.`, 'has the airport in sight and asked for a visual approach') },
    { id: 'direct', name: 'Pilot request: direct / higher', pos: ['APP'], w: 2,
      can: () => S.aircraft.find(a => a.kind === 'dep' && a.phase === 'dep' && a.freq === 'APP' && !a.request && !a.sit && a.alt > 4000),
      start: ac => {
        const f = FIXES[ac.exitFix];
        if (ac.tgtAlt < 9000 && Math.random() < 0.5) return raise(ac, 'sit_direct', `${ac.cs}, request higher when able.`, `${ac.cs}, any chance of higher?`, 'asked for a higher altitude', { want: 'higher' });
        if (!f || ac.direct === ac.exitFix || dist(ac.x, ac.y, f.x, f.y) < 8) return false;
        return raise(ac, 'sit_direct', `${ac.cs}, request direct ${ac.exitFix}.`, `${ac.cs}, still requesting direct ${ac.exitFix}.`, 'asked to fly direct to its exit fix', { want: 'direct' });
      } },
  ];

  /* ---------- helpers ---------- */
  // A situation's call to the controller: becomes the aircraft's open request, with its own words
  function raise(ac, type, text, rem, brief, extra) {
    if (!alive(ac)) return false;
    ac.sit = Object.assign(ac.sit || {}, { type, text, rem: rem || text, brief: brief || ac.sit && ac.sit.brief, since: S.t }, extra || {});
    ac.sitText = brief || ac.sitText;
    ac.request = null;
    setRequest(ac, type, true);
    Sit.seen(ac);
    return true;
  }
  const sys = (t, k) => UI.log('SYS', t, k || 'alert');
  function credit(pts, why) { award(pts, why); S.stats.sitDone = (S.stats.sitDone || 0) + 1; }

  /* ---------- emergencies ---------- */
  function depEmergency(ac) {
    const g = freeArrGate(ac); if (!g) return false;
    const e = pick([
      { t: 'engine failure', say: 'engine failure, request immediate return', w: 1 },
      { t: 'bird strike', say: 'bird strike, engine vibrations, request to return', w: 1 },
      { t: 'engine fire', say: 'engine fire, fire is out, request immediate return', stop: 'we will stop on the runway for the fire services to check the engine' },
      { t: 'cabin pressure', say: 'unable to pressurise, request to return' },
    ]);
    const heavy = ac.perf.heavy;
    seatAtGate(ac, g);
    ac.kind = 'arr'; ac.phase = 'arr'; ac.orig = { icao: APT.icao, name: APT.name }; ac.star = nearestFix(ac); ac.starAlt = 4000;
    ac.emg = { t: e.t, say: e.say + (heavy ? ', we are overweight' : ''), stop: e.stop }; ac.squawk = '7700';
    ac.flags = { emgReturn: true }; ac.landClr = false; ac.ils = ac.loc = ac.gs = false; ac.vectored = true; ac.direct = null;
    ac.tgtAlt = clamp(Math.round(ac.alt / 1000) * 1000, 3000, 6000); ac.altAssigned = true; ac.tgtSpd = 210; ac.request = null;
    ac.sitText = `just declared a mayday after departure (${e.t}) and is returning to land`;
    Radio.alert('emg'); sys(`⚠ EMERGENCY: ${ac.cs} squawks 7700 after departure (${e.t}) and wants to come back.`);
    const call = `Mayday, mayday, mayday, ${APT.tel} ${POSNAME[ac.freq] === 'Approach' ? 'Departure' : POSNAME[ac.freq]}, ${ac.cs}, ${ac.emg.say}, runway ${arrRwyName()}.`;
    if (ac.freq === 'TWR') raise(ac, 'sit_emgtwr', call, `${ac.cs}, mayday, we need to get back on the ground.`, ac.sitText);
    else raise(ac, 'sit_emg', call, `${ac.cs}, mayday, we need vectors back to the field now.`, ac.sitText);
    return true;
  }
  function nordo(ac) {
    ac.nordo = { rx: Math.random() < 0.5, since: S.t, old: ac.squawk, quietLog: 0 };
    ac.squawk = '7600'; ac.vectored = false; ac.direct = null; ac.holding = false; ac.altAssigned = false; ac.request = null; ac.flags.twrLate = true;
    ac.sitText = 'has lost its radio';
    sys(`⚠ ${ac.cs} is squawking 7600: radio failure. It will fly its arrival and the ILS on its own.`);
    Radio.alert('emg'); Sit.seen(ac);
    return true;
  }
  function code7500(ac) {
    ac.s75 = { real: Math.random() < 0.3, old: ac.squawk, since: S.t };
    ac.squawk = '7500'; Sit.seen(ac);
    sys(`Code 7500 showing on ${ac.cs}'s transponder.`, 'tip');
    if (ac.s75.real) { ac.prio = true; ac.sitText = 'is squawking 7500 under duress; the crew sounds normal and gives nothing away'; }
    else ac.sitText = 'set 7500 on the transponder by mistake and has not noticed';
    return true;
  }
  function panHold(ac) {
    const e = pick([
      { t: 'unsafe gear indication', say: 'an unsafe nose gear indication', ok: 'the gear now shows down and locked', bad: 'the nose gear still shows unsafe, we will stop on the runway' },
      { t: 'flap problem', say: 'a flap asymmetry warning', ok: 'we have the flaps at fifteen, we will need a little more runway', bad: null },
      { t: 'hydraulic problem', say: 'a hydraulic system failure', ok: 'we have the standby system', bad: 'no nosewheel steering, we will stop on the runway and need a tow' },
    ]);
    ac.emg = { t: e.t + ' (urgency)', say: e.say, pan: true, stop: Math.random() < 0.6 ? e.bad : null, ok: e.ok };
    ac.sitText = `declared a PAN for ${e.say} and wants to hold to run the checklist`;
    sys(`${ac.cs} declares a PAN: ${e.say}. It wants to hold to work the problem.`);
    raise(ac, 'sit_hold', `Pan-pan, pan-pan, pan-pan, ${APT.tel} Approach, ${ac.cs}, we have ${e.say}. Request to hold for about five minutes to run the checklist.`, `${ac.cs}, we still need somewhere to hold to run our checklist.`, ac.sitText);
    return true;
  }
  function minFuel(ac) {
    ac.minFuel = { t: S.t };
    ac.sitText = 'is at minimum fuel: it can accept little or no delay';
    raise(ac, 'sit_minfuel', `${APT.tel} Approach, ${ac.cs}, we are now minimum fuel, we can accept only a short delay.`, null, ac.sitText);
    return true;
  }

  /* ---------- runway ---------- */
  const HZ = {
    windshear: { re: /\bwind ?shear\b|\bshear\b/, say: () => `wind shear reported on short final, minus 20 knots at 500 feet` },
    laser: { re: /\blaser\b/, say: () => `laser activity reported on final` },
    birds: { re: /\bbirds?\b/, say: () => `bird activity in the vicinity of the airport` },
    drone: { re: /\bdrones?\b|\bunmanned\b|\buas\b/, say: () => `a drone reported on final, about 2000 feet` },
  };
  function report(ac, kind) {
    const d = Math.max(1, Math.round(locGeom(ac.x, ac.y).d));
    const T = {
      laser: `${APT.tel} Tower, ${ac.cs}, we were just illuminated by a green laser from the ${pick(['left', 'right'])}, about ${d} miles final.`,
      birds: `${APT.tel} Tower, ${ac.cs}, be advised, a large flock of birds ${ac.kind === 'arr' ? 'on short final' : 'just off the departure end'}, about ${ac.kind === 'arr' ? 400 : Math.round(ac.alt / 100) * 100} feet.`,
      drone: `${APT.tel} ${POSNAME[ac.freq]}, ${ac.cs}, we just passed a drone, about ${Math.max(1500, Math.round(ac.alt / 100) * 100)} feet, ${d} miles final, it was close.`,
    }[kind];
    Sit.hazard = { kind, by: ac, t: S.t, told: new Set([ac.id]), say: HZ[kind].say(), re: HZ[kind].re };
    raise(ac, 'sit_report', T, null, `reported ${kind === 'birds' ? 'birds' : 'a ' + kind}`);
    sys(`${ac.cs} reports ${kind === 'birds' ? 'birds' : 'a ' + kind}. Pass it on to the aircraft behind (“caution, ${Sit.hazard.say}”).`, 'tip');
    return true;
  }
  function windshear(ac) {
    const sc = S.score;
    goAround(ac, 'wind shear');
    S.score = sc; // a pilot's wind shear go-around isn't the controller's doing
    ac.sitText = 'went around for wind shear on short final';
    S.wind = { ...S.wind, gust: (S.wind.spd || 10) + rint(12, 20) };
    Sit.hazard = { kind: 'windshear', by: ac, t: S.t, told: new Set([ac.id]), say: HZ.windshear.say(), re: HZ.windshear.re };
    schedule(2.5, () => alive(ac) && pilotSay(ac, `${ac.cs}, that was wind shear, we lost 20 knots at 500 feet.`));
    sys(`Pass on the wind shear to every arrival behind ${ac.cs}: “caution, ${Sit.hazard.say}”.`, 'tip');
    Sit.seen(ac);
    return true;
  }
  function closeRunway(rid, secs, why) {
    const rw = RWY[rid]; if (!rw) return;
    Sit.closures[rid] = { until: S.t + secs, why, veh: { x: S.flow === 'W' ? rw.x1 : rw.x2, dir: S.flow === 'W' ? 1 : -1 } };
    sys(`Runway ${rid === S.rwyDep ? depRwyName() : arrRwyName()} closed for about ${Math.round(secs / 60)} minutes: ${why}. Hold departures, and send arrivals around or into the hold.`);
  }
  function fod(ac) {
    const e = (DEPR().entries || [])[0];
    raise(ac, 'sit_report', `${APT.tel} Tower, ${ac.cs}, there was something on the runway on our takeoff roll, looked like a piece of tyre${e ? ' near ' + sayTwy(e.name) : ''}.`, null, 'reported debris on the departure runway');
    closeRunway(S.rwyDep, rnd(150, 210), 'a runway inspection for debris');
    return true;
  }

  /* ---------- airspace ---------- */
  function storms() {
    const n = rint(2, 3), cells = [];
    for (let i = 0; i < 40 && cells.length < n; i++) {
      const a = rnd(0, Math.PI * 2), d = rnd(10, 26), x = Math.sin(a) * d, y = Math.cos(a) * d;
      if (Math.abs(locGeom(x, y).cross) < 4 && locGeom(x, y).d > 0) continue; // keep the final approach usable
      if (cells.some(c => dist(c.x, c.y, x, y) < 8)) continue;
      cells.push({ x, y, r: rnd(2.5, 4.2), seed: Math.random() * 100, born: S.t });
    }
    Sit.cells = cells; Sit.cellsUntil = S.t + rnd(900, 1200);
    S.atis = String.fromCharCode(65 + ((S.atis.charCodeAt(0) - 64) % 25));
    sys(`Thunderstorms building in the area (information ${S.atis}). Expect requests to deviate around them.`, 'tip');
    return true;
  }
  function fog() {
    S.lvp = true; Sit.lvpUntil = S.t + rnd(600, 840);
    S.atis = String.fromCharCode(65 + ((S.atis.charCodeAt(0) - 64) % 25));
    sys(`Fog: RVR 350 metres, low visibility procedures in force (information ${S.atis}). Spacing on final grows, no visual approaches; keep the ILS clear while an arrival is inside 6 miles.`);
    return true;
  }
  function popup() {
    const a = rnd(0, Math.PI * 2), sx = Math.sin(a) * 28, sy = Math.cos(a) * 28;
    const tgt = finalPoint(rnd(6, 14), rnd(-3, 3));
    Sit.vfr.push({ id: 'V' + (++Sit.vfrN), x: sx, y: sy, hdg: brg(sx, sy, tgt.x, tgt.y), alt: rint(25, 45) * 100, spd: rint(95, 125), told: new Set(), hit: new Set(), trail: [] });
    return true;
  }
  function ra(ac, other) {
    if (ac.ra || ac.nordo || !alive(ac)) return;
    const up = ac.alt >= other.alt;
    ac.ra = { until: S.t + rnd(20, 28), saved: ac.tgtAlt, dir: up ? 1 : -1 };
    ac.tgtAlt = ac.alt + (up ? 1000 : -800); ac.exped = true;
    ac.sitText = 'is following a TCAS resolution advisory';
    pilotSay(ac, `${ac.cs}, TCAS RA.`, { pos: ac.freq });
    ac.request = null; setRequest(ac, 'sit_ra', false);
    sys(`${ac.cs}: TCAS RA (${up ? 'climb' : 'descend'}). While it follows the RA, don't give it instructions; acknowledge and wait for “clear of conflict”.`, 'tip');
    Sit.seen(ac);
  }

  /* ---------- ground ---------- */
  function breakdown(ac) {
    ac.sitStop = { kind: 'tow', until: S.t + rnd(150, 210) };
    const where = nearName(ac.node) || 'the taxiway';
    raise(ac, 'sit_tow', `${APT.tel} Ground, ${ac.cs}, we've lost nosewheel steering, we're stopped on ${where}. We'll need a tow back to the ${standWord()}.`, `${ac.cs}, still waiting on that tug.`, 'broke down on the taxiway and needs a tow');
    sys(`${ac.cs} is stopped on the taxiway and needs a tow. Route traffic around it (“taxi via …”).`, 'tip');
    return true;
  }
  function returnToStand(ac) {
    const g = freeArrGate(ac); if (!g) return false;
    seatAtGate(ac, g); ac.sitReturn = true; ac.held = true;
    const why = pick(['we have a sick passenger', 'a passenger wants to get off', 'we have a technical problem, an amber caution we need maintenance to look at']);
    raise(ac, 'sit_return', `${APT.tel} Ground, ${ac.cs}, ${why}, we need to return to the ${standWord()}.`, `${ac.cs}, holding, we need to get back to a ${standWord()}.`, 'needs to return to a stand');
    return true;
  }
  function similar(ac) {
    if (!ac || ac.live) return false;
    const twin = S.aircraft.find(o => o !== ac && o.al === ac.al && o.num.length >= 3 && !o.twin);
    if (!twin) return false;
    const n = twin.num; let num = n.slice(0, -2) + n.slice(-1) + n.slice(-2, -1);
    if (num === n) num = n.slice(0, -1) + String((+n.slice(-1) + 1) % 10);
    const cs = ac.al.code + num;
    if (num.startsWith('0') || S.aircraft.some(o => o.cs === cs)) return false;
    ac.num = num; ac.cs = cs; ac.twin = twin; twin.twin = ac;
    sys(`Similar callsigns: ${twin.cs} and ${ac.cs}. Say “caution, similar callsign” and listen for who answers.`, 'tip');
    Sit.seen(ac);
    return true;
  }

  /* ---------- holding (FAA JO 7110.65 §4-6, ICAO Doc 4444 and Doc 8168) ---------- */
  const DIRS = { north: 0, northeast: 45, east: 90, southeast: 135, south: 180, southwest: 225, west: 270, northwest: 315 };
  const clockNow = () => ((((S.clockBase || 0) + S.t) % 86400) + 86400) % 86400;
  const hhmm = t => { const s = ((((S.clockBase || 0) + t) % 86400) + 86400) % 86400; return String(Math.floor(s / 3600)).padStart(2, '0') + String(Math.floor(s % 3600 / 60)).padStart(2, '0'); };
  // an EFC as said ("1450", or "50" for minutes past the hour), as sim time
  function efcTime(v) {
    v = String(v); const now = clockNow(); let h, m;
    if (v.length <= 2) { h = Math.floor(now / 3600); m = +v; } else { v = v.padStart(4, '0'); h = +v.slice(0, 2); m = +v.slice(2); }
    if (h > 23 || m > 59) return null;
    let s = h * 3600 + m * 60 - now; if (s < -1800) s += v.length <= 2 ? 3600 : 86400;
    return S.t + s;
  }
  function setEfc(h, c) {
    const t = c.efcIn ? S.t + c.efcIn * 60 : efcTime(c.efc);
    if (t == null) return; h.efcT = t; h.efc = hhmm(t); h.efcAsked = false;
  }
  const holdSpd = alt => alt <= 6000 ? 200 : alt <= 14000 ? 230 : 265; // FAA maximum holding speeds
  const turnR = spd => spd / (60 * Math.PI);                            // standard-rate turn radius, NM
  const legOf = (h, alt) => h.legNm || (h.legMin || 1) * holdSpd(alt) / 60;
  const holders = fix => S.aircraft.filter(a => a.hold && a.hold.fix === fix && !onGround(a));
  const holdFixFor = ac => (FIXES[ac.star] ? ac.star : nearestFix(ac));
  // the stack: 1,000 ft apart from 5,000 ft up. A newcomer goes on top (never down through the others);
  // the lowest leaves first and the rest step down behind it.
  function stackSlot(fix, me) {
    // the lowest free level in the stack (by assigned levels: one still descending into its level doesn't push the stack up)
    const used = new Set(holders(fix).filter(a => a !== me).map(a => Math.round(a.tgtAlt / 1000) * 1000));
    const f = FIXES[fix], floor = window.Proc && f ? Math.ceil(Proc.mva(f.x, f.y) / 1000) * 1000 : 0;
    // a newcomer goes on top (nobody jumps the stack); the ones below step down as levels free up
    return used.size ? Math.max(Math.max(...used) + 1000, floor) : Math.max(5000, floor);
  }
  // when the runway is blocked, and until when
  function arrBlockedUntil() {
    const cl = Sit.closures[S.rwyArr]; let t = cl && S.t < cl.until ? cl.until : 0;
    for (const a of S.aircraft) if (a.sitStop && a.sitStop.kind === 'stuck') t = Math.max(t, a.sitStop.until);
    return t;
  }
  // EFC for the next aircraft into a stack: after the runway opens and 3 minutes after the one below, on a whole minute
  function stackEfc(fix, me) {
    let t = Math.max(S.t + 300, arrBlockedUntil() + 120);
    for (const a of holders(fix)) if (a !== me && a.hold.efcT) t = Math.max(t, a.hold.efcT + 180);
    const s = (S.clockBase || 0) + t; return t + (60 - (s % 60)) % 60;
  }
  function startHold(ac, c) {
    const f = FIXES[c.fix];
    const inbound = c.inbCrs != null ? gameOf(c.inbCrs) : c.radial != null ? norm360(gameOf(c.radial) + 180) : c.dir ? norm360(DIRS[c.dir] - ROT + 180) : norm360(brg(f.x, f.y, 0, 0)); // courses as said are magnetic; 'northeast' is true
    const prev = ac.hold && ac.hold.fix === c.fix ? ac.hold : null;
    const h = { fix: c.fix, inbound, dir: c.dir || null, radial: c.radial, inbCrs: c.inbCrs, legNm: c.legNm || null, legMin: c.legMin || 1, left: !!c.left,
      published: !c.dir && c.radial == null && c.inbCrs == null, ph: prev ? prev.ph : 'to', laps: prev ? prev.laps : 0, since: prev && prev.since != null ? prev.since : S.t, efcT: prev ? prev.efcT : null, efc: prev ? prev.efc : null };
    if (c.efc || c.efcIn) setEfc(h, c);
    ac.hold = h; ac.holdFix = c.fix; ac.vectored = true; ac.ils = false; ac.loc = false; ac.gs = false; ac.holding = true;
    if (h.ph === 'to') ac.direct = c.fix;
    return h;
  }
  function cancelHold(ac) { ac.hold = null; ac.holdFix = null; ac.holding = false; ac.turnDir = null; }
  function sayHold(h) {
    const p = h.published ? [`hold at ${h.fix} as published`] : [`hold ${h.dir ? h.dir + ' of' : 'at'} ${h.fix}${h.radial != null ? ` on the ${pad3(h.radial)} radial` : h.inbCrs != null ? `, inbound track ${pad3(h.inbCrs)}` : ''}`];
    if (h.legNm) p.push(`${h.legNm} mile legs`); else if (h.legMin !== 1) p.push(`${h.legMin} minute legs`);
    if (h.left) p.push('left turns');
    if (h.efc) p.push(`expect further clearance ${h.efc}`);
    return p.join(', ');
  }
  // the racetrack: to the fix, turn outbound, a minute (or the given miles) out, turn back, inbound to the fix, and round again
  function holdStep(ac) {
    const h = ac.hold, f = FIXES[h.fix]; if (!f) return cancelHold(ac);
    ac.vectored = true; ac.holding = true;
    ac.tgtSpd = Math.min(ac.tgtSpd || 250, holdSpd(ac.alt));
    const turn = h.left ? 'L' : 'R', d = dist(ac.x, ac.y, f.x, f.y), u = h.inbound * Math.PI / 180;
    const along = (ac.x - f.x) * Math.sin(u) + (ac.y - f.y) * Math.cos(u); // > 0: past the fix on the inbound course
    const outb = norm360(h.inbound + 180);
    switch (h.ph) {
      case 'to': ac.direct = h.fix; if (d < 1.1) { ac.direct = null; h.ph = 'outTurn'; h.entered = S.t; } break;
      case 'outTurn': ac.direct = null; ac.tgtHdg = outb; ac.turnDir = turn; if (Math.abs(hdgDiff(ac.hdg, outb)) < 6) { h.ph = 'out'; h.t = S.t; } break;
      case 'out': ac.tgtHdg = outb; ac.turnDir = null; if (h.legNm ? d >= h.legNm : S.t - h.t >= 60 * h.legMin) h.ph = 'inTurn'; break;
      case 'inTurn': ac.tgtHdg = h.inbound; ac.turnDir = turn; if (Math.abs(hdgDiff(ac.hdg, h.inbound)) < 10) h.ph = 'in'; break;
      case 'in': ac.turnDir = null; ac.tgtHdg = norm360(h.inbound + clamp(hdgDiff(h.inbound, brg(ac.x, ac.y, f.x, f.y)) * 2, -30, 30)); if (along > -0.05) { h.ph = 'outTurn'; h.laps++; } break;
    }
  }

  /* ---------- the engine ---------- */
  const Sit = {
    LBL, CAT, cells: [], vfr: [], vfrN: 0, closures: {}, hazard: null, armed: {}, next: 0, acc: 0, lastId: 0, practice: 'mix', list: null, raPairs: {},
    on() { return S.running && (Mission.cur ? !!this.list : (S.opt.emg || this.practice !== 'mix')); },
    reset() {
      this.cells = []; this.vfr = []; this.closures = {}; this.hazard = null; this.armed = {}; this.raPairs = {}; this.acc = 0; this.lastId = 0;
      S.lvp = false;
      S.stats.sitDone = 0; S.stats.sitSeen = 0; S.stats.nordoLanded = 0; S.stats.devOk = 0; S.stats.advis = 0; this.seenIds = new Set();
      const m = Mission.cur;
      this.list = m ? (m.sit || null) : (this.practice !== 'mix' ? [this.practice] : null);
      this.next = m && m.sit ? (m.sitAt || 60) : this.practice !== 'mix' ? 45 : rnd(200, 360);
      if (!m && this.practice !== 'mix' && this.practice !== 'mayday') S.nextEmg = Infinity; // practising one situation: no random maydays on top
      if (!m && this.practice === 'mayday') S.nextEmg = 40;
    },
    seen(ac) { if (ac && !this.seenIds.has(ac.id)) { this.seenIds.add(ac.id); S.stats.sitSeen = (S.stats.sitSeen || 0) + 1; } },
    closed(rid) { const c = this.closures[rid]; return !!(c && S.t < c.until); },
    skipAI(ac) { return !!(ac.nordo || ac.ra || ac.holdFix || ac.sitStop || ac.visual); },

    // a few things happen on every sim step: an aborted takeoff stopping, aircraft held on the runway
    stepAc(ac, dt) {
      if (ac.rto && ac.phase === 'takeoff' && ac.alt <= 0) {
        const r = ac.hdg * Math.PI / 180;
        ac.spd = Math.max(0, ac.spd - 9 * dt);
        ac.x += Math.sin(r) * ac.spd / 3600 * dt; ac.y += Math.cos(r) * ac.spd / 3600 * dt;
        return true;
      }
      if (ac.sitStop) { ac.spd = 0; return true; }
      if (ac.exped && !onGround(ac) && Math.abs(ac.tgtAlt - ac.alt) > 50) { const v = (ac.tgtAlt > ac.alt ? 1 : -1) * 900 / 60 * dt; ac.alt += v; } // expedite: about half as fast again
      return false;
    },

    step(dt) {
      this.acc += dt; if (this.acc < 1) return; const t1 = this.acc; this.acc = 0;
      // new aircraft: maybe a similar callsign
      for (const ac of S.aircraft) if (ac.id > this.lastId) { this.lastId = Math.max(this.lastId, ac.id); if (this.armed.similar && similar(ac)) delete this.armed.similar; }
      this.vfrStep(t1);
      this.watch();
      if (!this.on()) return;
      if (S.t >= this.next) this.pick();
    },
    pick() {
      const major = S.aircraft.some(a => (a.emg && !a.emg.pan) || a.nordo || a.rto || a.sitStop || (a.s75 && a.s75.real)) || Object.keys(this.armed).some(k => CAT.find(c => c.id === k && c.major));
      const pool = CAT.filter(c => (!this.list || this.list.includes(c.id)) && c.pos.some(staffed) && !(c.major && major && !this.list) && (!c.ok || c.ok()) && !this.armed[c.id]);
      const ready = [];
      for (const c of pool) { if (c.arm) ready.push([c, null]); else if (c.can) { const ac = c.can(); if (ac) ready.push([c, ac]); } else ready.push([c, null]); }
      if (!ready.length) { this.next = S.t + 20; return; }
      const tot = ready.reduce((s, [c]) => s + c.w, 0); let r = Math.random() * tot, sel = ready[0];
      for (const x of ready) { r -= x[0].w; if (r <= 0) { sel = x; break; } }
      const [c, ac] = sel;
      let ok;
      if (c.arm) { this.armed[c.id] = S.t + 600; ok = true; }
      else ok = c.start(ac === true ? null : ac);
      const gap = { light: [300, 480], medium: [220, 380], heavy: [160, 300] }[S.density] || [240, 400];
      this.next = S.t + (ok ? (this.list ? rnd(150, 240) : rnd(...gap)) : 20);
    },

    // conditions checked once a second
    watch() {
      const now = S.t;
      for (const k in this.armed) if (now > this.armed[k]) delete this.armed[k];
      for (const k in this.closures) if (now >= this.closures[k].until) { delete this.closures[k]; sys(`Runway ${RWY[k] ? RWY[k].names[S.flow] : k} is open again: inspection complete.`, 'tip'); }
      if (this.hazard && now - this.hazard.t > 600) this.hazard = null;
      if (this.cells.length && now > this.cellsUntil) { this.cells = []; sys('The thunderstorms have moved away.', 'tip'); }
      for (const c of this.cells) { const w = (S.wind.dir + 180) * Math.PI / 180; c.x += Math.sin(w) * 0.004; c.y += Math.cos(w) * 0.004; }
      if (S.lvp && now > this.lvpUntil) { S.lvp = false; S.atis = String.fromCharCode(65 + ((S.atis.charCodeAt(0) - 64) % 25)); sys(`The fog has lifted: low visibility procedures cancelled (information ${S.atis}).`, 'tip'); }

      for (const ac of S.aircraft.slice()) {
        const g = !onGround(ac) ? locGeom(ac.x, ac.y) : null;
        // armed: waiting for the right moment
        if (this.armed.rto && ac.kind === 'dep' && ac.phase === 'takeoff' && ac.alt <= 0 && ac.spd > 55 && ac.spd < ac.perf.vr - 25 && !ac.rto) {
          delete this.armed.rto; ac.rto = true; Sit.seen(ac);
          const why = pick(['engine fire warning', 'engine failure', 'a configuration warning', 'a bird strike on the roll']);
          ac.sitText = `rejected its takeoff (${why}) and is stopped on the runway`;
          Radio.alert('emg');
          raise(ac, 'sit_rto', `${ac.cs}, stopping! Rejected takeoff, ${why}.`, `${ac.cs}, we're stopped on the runway, we'll need a few minutes for the brakes.`, ac.sitText);
          ac.rtoUntil = S.t + rnd(120, 170);
          sys(`⚠ ${ac.cs} rejected its takeoff and is stopping on runway ${depRwyName()}. The runway is blocked: send arrivals around.`);
        }
        if (ac.rto && ac.rtoUntil && now > ac.rtoUntil) {
          sys(`${ac.cs} has left the runway with a tug, back to a ${standWord()} for an inspection.`, 'tip');
          if (ac.sitThanks) credit(100, 'rejected takeoff handled'); else S.stats.sitDone++;
          removeAc(ac); continue;
        }
        if (this.armed.incursion && ac.kind === 'dep' && ac.phase === 'holdshort' && !ac.toClr && !ac.luawPending && mixedOps()) {
          const arr = S.aircraft.find(o => o.kind === 'arr' && o.loc && o.landClr && locGeom(o.x, o.y).d > 1.2 && locGeom(o.x, o.y).d < 3.2);
          if (arr) {
            delete this.armed.incursion; beginLineup(ac, false); ac.incursion = { arr, t: now }; Sit.seen(ac);
            ac.sitText = 'misheard and lined up on the runway without a clearance';
            schedule(3, () => { if (!alive(ac)) return; Radio.alert('ca'); sys(`⚠ RUNWAY INCURSION: ${ac.cs} is entering runway ${depRwyName()} without a clearance, ${arr.cs} is on short final. Send ${arr.cs} around!`); });
          }
        }
        if (ac.incursion && alive(ac.incursion.arr)) {
          const a = ac.incursion.arr;
          if (a.phase === 'ga' && !ac.incursion.done) { ac.incursion.done = true; if (a.flags.atcGa) credit(200, `sent ${a.cs} around for the incursion`); }
        }
        if (this.armed.windshear && ac.kind === 'arr' && ac.loc && ac.landClr && g && g.d < 1.4 && ac.alt < 700 && ac.alt > 250 && ac.freq === 'TWR') { delete this.armed.windshear; windshear(ac); continue; }
        if (this.armed.tyre && ac.kind === 'arr' && ac.phase === 'rollout' && !ac.stopOnRwy && ac.spd < 120) { delete this.armed.tyre; ac.stopOnRwy = pick(['we have a burst tyre, we are stopped on the runway', 'brake fire indication, we are stopping on the runway, request the fire services']); ac.sitText = 'is disabled on the runway after landing'; Sit.seen(ac); }
        // disabled on the runway after landing
        if (ac.phase === 'rollout' && !ac.sitStop && ac.spd <= 60 && (ac.stopOnRwy || (ac.emg && ac.emg.stop))) {
          const why = ac.stopOnRwy || ac.emg.stop;
          ac.sitStop = { kind: 'stuck', until: now + rnd(150, 210) }; ac.held = false;
          Radio.alert('emg');
          raise(ac, 'sit_stuck', `${APT.tel} Tower, ${ac.cs}, ${why}.`, `${ac.cs}, still on the runway, waiting for the fire services.`, `stopped on the runway after landing: ${why}`);
          sys(`⚠ ${ac.cs} has stopped on runway ${arrRwyName()}. It's closed until the aircraft is moved: send arrivals around or hold them.`);
        }
        if (ac.sitStop && now >= ac.sitStop.until) {
          const k = ac.sitStop.kind; ac.sitStop = null; ac.held = false; ac.stopOnRwy = null; if (ac.emg) ac.emg.stop = null;
          if (k === 'tow') { sys(`${ac.cs} has been towed back to the ${standWord()}.`, 'tip'); if (ac.sitThanks) credit(80, `${ac.cs}'s breakdown handled`); removeAc(ac); continue; }
          pilotSay(ac, `${ac.cs}, the tug is here, we're being moved off the runway now.`);
          if (ac.sitThanks) credit(120, `${ac.cs} cleared off the runway safely`);
          if (ac.request && ac.request.type === 'sit_stuck') ac.request = null;
        }
        // going back to the stand against the flow: if it meets traffic nose to nose, a tug takes it the rest of the way
        if (ac.flags.returned && ac.phase === 'taxiing_in' && ac.blockT > 90) { sys(`${ac.cs} is being towed the rest of the way to its ${standWord()}.`, 'tip'); removeAc(ac); continue; }
        if (ac.minFuel && ac.kind === 'arr' && !onGround(ac) && now - ac.minFuel.t > 660 && !ac.emg) {
          ac.emg = { t: 'low fuel', say: 'fuel emergency, we must land now' }; ac.squawk = '7700'; ac.minFuel = null;
          award(-100, `${ac.cs}: minimum fuel turned into a fuel emergency`); Radio.alert('emg');
          ac.sitText = 'declared a fuel emergency after being kept waiting at minimum fuel';
          raise(ac, ac.freq === 'TWR' ? 'sit_emgtwr' : 'sit_emg', `Mayday, mayday, mayday, ${ac.cs}, fuel emergency, we must land now.`, `${ac.cs}, mayday, we need the approach now.`, ac.sitText);
        }
        // the PAN hold: once the checklist is done they want the approach
        if (ac.troubleUntil && now > ac.troubleUntil && !onGround(ac)) {
          ac.troubleUntil = null; cancelHold(ac);
          const e = ac.emg || {};
          raise(ac, 'sit_ready', `${APT.tel} Approach, ${ac.cs}, checklist complete, ${e.stop ? e.stop.replace(/^we will/, 'we will') : (e.ok || 'all normal now')}. Ready for the approach, request emergency services standing by.`, `${ac.cs}, ready for the approach when you are.`, 'finished its checklist and is ready for the approach');
        }
        // radio failure: it flies its arrival and then the ILS on its own
        if (ac.nordo && !onGround(ac)) {
          const q = starPoint(ac);
          if (!ac.hold && !ac.ils && (ac.holding || dist(ac.x, ac.y, q.x, q.y) < 2.2)) {
            const side = g.cross >= 0 ? 1 : -1;
            ac.ils = true; ac.vectored = true; ac.holding = false; ac.turnDir = null;
            ac.tgtHdg = norm360(course() - side * 30); ac.tgtAlt = 3000; ac.altAssigned = true;
          }
          if (ac.loc && ac.freq === 'APP') { ac.freq = 'TWR'; ac.request = null; UI.log('SYS', `Approach has passed ${ac.cs} (no radio) to the tower: it is established on the ILS.`, 'tip'); }
          if (ac.request && ac.request.type === 'handoff_twr_arr') ac.request = null;
          if (ac.loc && g.d < 5 && !ac.landClr && !staffed('TWR')) { ac.landClr = true; UI.log('AI TWR', `Steady green light to ${ac.cs}.`, 'ai'); }
          if (ac.loc && g.d < 2.5 && !ac.landClr && !ac.nordo.warned) { ac.nordo.warned = true; sys(`${ac.cs} (no radio) is on short final with no light signal: “${ac.cs}, light gun, steady green, cleared to land”.`); }
        }
        // a 7500 set by mistake: the crew notices after a while
        if (ac.s75 && !ac.s75.real && !ac.s75.done && now - ac.s75.since > 150) {
          ac.s75.done = true; ac.squawk = ac.s75.old; pilotSay(ac, `${APT.tel} Approach, ${ac.cs}, sorry about that, we had the wrong code in, squawking ${ac.squawk} now.`);
        }
        // TCAS RA: over after 20-30 s
        if (ac.ra && now > ac.ra.until) {
          const back = ac.ra.saved; ac.ra = null; ac.tgtAlt = back; ac.exped = false;
          raise(ac, 'sit_racl', `${ac.cs}, clear of conflict, returning to ${fmtAlt(back)}.`, null, 'is returning to its clearance after a TCAS RA');
        }
        if (ac.exped && !ac.ra && Math.abs(ac.tgtAlt - ac.alt) < 60) ac.exped = false;
        // holding: fly the racetrack; at the EFC a crew with no radio leaves by itself, any other one asks
        if (ac.hold && !onGround(ac)) {
          holdStep(ac);
          const h = ac.hold;
          if (h && ac.nordo && ((h.efcT && now >= h.efcT) || (!h.efcT && h.laps >= 1))) {
            cancelHold(ac); ac.vectored = false;
            UI.log('SYS', `${ac.cs} (no radio) leaves the hold at ${h.efc ? 'its EFC, ' + h.efc : h.fix} and starts the approach on its own.`, 'tip');
          } else if (h && h.efcT && now > h.efcT + 60 && !h.efcAsked && !ac.nordo && !ac.request && !ac.troubleUntil && staffed(ac.freq)) {
            h.efcAsked = true;
            raise(ac, 'sit_efc', `${APT.tel} Approach, ${ac.cs}, holding at ${h.fix}, we're past our expect further clearance time, any update?`, `${ac.cs}, still holding at ${h.fix}, we need an update.`, `is holding at ${h.fix} past its EFC`);
          } else if (h && !staffed(ac.freq) && ac.freq === 'APP' && !ac.aiPending && !ac.request && !ac.troubleUntil && now - (h.aiT || 0) > 20) {
            h.aiT = now; const s = this.holdAdvice(ac, null, null); // the AI approach controller works its own stack
            if (s && !s.none) AI.say(ac, 'APP', s.text);
          }
        }
        // a visual approach: the crew turns itself onto final
        if (ac.visual && !ac.loc && !onGround(ac) && g && ac.phase === 'arr') {
          const p = finalPoint(clamp(g.d * 0.55, 4, 9), 0);
          ac.tgtHdg = brg(ac.x, ac.y, p.x, p.y); ac.turnDir = null; ac.vectored = true;
          if (ac.tgtAlt > 3000) { ac.tgtAlt = Math.max(2500, Math.min(ac.tgtAlt, g.d * 320)); }
          if (g.d > 1.5 && Math.abs(g.cross) < 2.5 && Math.abs(hdgDiff(ac.hdg, course())) < 100) { ac.loc = true; ac.vectored = false; ac.direct = null; S.stats.ils++; }
        }
        // weather: a crew about to fly into a storm asks to go round it
        if (this.cells.length && !onGround(ac) && !ac.loc && !ac.nordo && !ac.ra && ac.freq === 'APP' && !ac.request && !ac.devUntil && (!ac.devAsked || now - ac.devAsked > 120)) {
          const h = ac.hdg * Math.PI / 180;
          const cell = this.cells.find(c => [3, 6, 9].some(k => dist(ac.x + Math.sin(h) * k, ac.y + Math.cos(h) * k, c.x, c.y) < c.r + 0.8));
          if (cell) {
            const rel = hdgDiff(ac.hdg, brg(ac.x, ac.y, cell.x, cell.y)), dir = rel > 0 ? 'left' : 'right';
            ac.devAsked = now; ac.devDir = dir;
            raise(ac, 'sit_wx', `${ac.cs}, request ${rint(2, 3) * 10} degrees ${dir} for weather.`, `${ac.cs}, we need to deviate ${dir} now, there's a cell ahead.`, `wants to deviate ${dir} around a thunderstorm`);
          }
        }
        if (ac.request && ac.request.type === 'sit_wx' && ac.request.called && now - ac.request.t0 > 45 && !ac.devUntil) { // the crew won't fly into a storm: they turn anyway
          ac.devUntil = now + 80; ac.tgtHdg = norm360(ac.hdg + (ac.devDir === 'left' ? -25 : 25)); ac.vectored = true; ac.direct = null; ac.request = null;
          pilotSay(ac, `${ac.cs}, we're deviating ${ac.devDir} for weather now.`); award(-40, `${ac.cs} had to deviate without an answer`);
        }
        if (ac.devUntil && now > ac.devUntil && !onGround(ac)) {
          const h = ac.hdg * Math.PI / 180;
          const still = this.cells.some(c => dist(ac.x + Math.sin(h) * 3, ac.y + Math.cos(h) * 3, c.x, c.y) < c.r + 0.5);
          if (still) ac.devUntil = now + 20;
          else { ac.devUntil = null; raise(ac, 'sit_wxclr', `${ac.cs}, clear of the weather, ${ac.kind === 'dep' ? 'request direct ' + ac.exitFix : 'ready for vectors'}.`, null, 'is clear of the weather'); }
        }
      }
      // TCAS: two aircraft closing fast, too close
      if (this.on() || this.vfr.length) {
        const airs = S.aircraft.filter(a => !onGround(a) && a.alt > 1000 && !a.gs);
        for (let i = 0; i < airs.length; i++) for (let j = i + 1; j < airs.length; j++) {
          const a = airs[i], b = airs[j], key = a.id + '-' + b.id;
          if (this.raPairs[key] && now - this.raPairs[key] < 180) continue;
          if (a.alt < 3200 && b.alt < 3200 && dist(0, 0, a.x, a.y) < 7 && dist(0, 0, b.x, b.y) < 7) continue; // the tower's visual traffic
          const d = dist(a.x, a.y, b.x, b.y);
          if (Math.abs(a.alt - b.alt) < 600 && d < 1.6) { const pa = project(a, 20), pb = project(b, 20); if (dist(pa.x, pa.y, pb.x, pb.y) < d - 0.25) { this.raPairs[key] = now; const x = Math.random() < 0.5 ? a : b; ra(x, x === a ? b : a); } }
        }
      }
      // closed runway, nobody staffing the tower: the AI tower sends arrivals around
      for (const rid in this.closures) if (rid === S.rwyArr && !staffed('TWR')) for (const a of S.aircraft) if (a.kind === 'arr' && a.loc && a.landClr && locGeom(a.x, a.y).d < 4 && !a.flags.closedGa) { a.flags.closedGa = true; AI.say(a, 'TWR', `${a.cs}, go around, runway ${arrRwyName()} closed`); }
    },

    // VFR targets: no radio with us, squawk 1200, flying straight across
    vfrStep(dt) {
      for (const v of this.vfr) {
        const r = v.hdg * Math.PI / 180; v.x += Math.sin(r) * v.spd / 3600 * dt; v.y += Math.cos(r) * v.spd / 3600 * dt;
        v.tt = (v.tt || 0) + dt; if (v.tt > 4) { v.tt = 0; v.trail.push({ x: v.x, y: v.y }); if (v.trail.length > 7) v.trail.shift(); }
        for (const ac of S.aircraft) {
          if (onGround(ac) || ac.alt < 500) continue;
          const d = dist(ac.x, ac.y, v.x, v.y), da = Math.abs(ac.alt - v.alt);
          if (d < 6 && da < 1500 && !v.hit.has(ac.id) && !v.told.has(ac.id) && staffed(ac.freq) && ac.freq !== 'CTR') { v.hit.add(ac.id); Sit.seen(ac); }
          if (d < 1.1 && da < 500 && !v['ra' + ac.id]) {
            v['ra' + ac.id] = true; ra(ac, { alt: v.alt });
            if (v.hit.has(ac.id) && !v.told.has(ac.id)) award(-75, `${ac.cs} wasn't told about the VFR traffic`);
          }
        }
      }
      this.vfr = this.vfr.filter(v => dist(0, 0, v.x, v.y) < 34);
    },
    nearVfr(ac) { let b = null, bd = 9; for (const v of this.vfr) { const d = dist(ac.x, ac.y, v.x, v.y); if (d < bd && Math.abs(ac.alt - v.alt) < 2000) { bd = d; b = v; } } return b; },

    /* ---------- the controller's words ---------- */
    parse(t, c, has) {
      const ks = new Set(c.map(x => x.k));
      if (has(/\bdeviations? (?:(?:left|right|north|south|east|west) )?(?:of course )?(?:is |are )?approved\b|\bdeviate\b.{0,30}\bapproved\b|\bapproved\b.{0,12}\bdeviat/)) c.push({ k: 'deviate', dir: (t.match(/\bdeviations? (left|right)\b/) || [])[1] });
      else if (has(/\bunable (?:the )?deviation|\bdeviation(?:s)? (?:is )?not approved\b/)) c.push({ k: 'devno' });
      else if (has(/\b(?:approved as requested|request approved|proceed as requested|as requested approved)\b/)) c.push({ k: 'approve' });
      // "hold at BOOTH as published" or the full form: "hold northeast of BOOTH on the 045 radial, 10 mile legs, left turns, … expect further clearance 1450"
      const tt = t.replace(/\b(north|south) (east|west)\b/g, '$1$2');
      const hm = tt.match(/\bhold (?:(north|northeast|east|southeast|south|southwest|west|northwest) of |at |over |as published at )?(?:the )?([a-z]{3,9})\b/);
      let hc = null;
      if (hm && !['position', 'short', 'your', 'for', 'and', 'please'].includes(hm[2])) { const f = fixOf(hm[2]); if (f) hc = { k: 'hold', fix: f, dir: hm[1] || null }; }
      if (hc) {
        const inb = tt.match(/\binbound (?:track|course) (\d{3})\b/), rad = tt.match(/\b(\d{3}) (?:radial|bearing|course)\b/);
        if (inb) hc.inbCrs = +inb[1] % 360; else if (rad) hc.radial = +rad[1] % 360;
        const ln = tt.match(/\b(\d{1,2}) (?:mile|miles|nm|nautical mile) legs?\b/), lm = tt.match(/\b(\d(?:\.5)?) minutes? legs?\b|\boutbound time (\d(?:\.5)?) minutes?\b/);
        if (ln) hc.legNm = +ln[1]; if (lm) hc.legMin = +(lm[1] || lm[2]);
        hc.left = /\bleft (?:turns?|hand)\b/.test(tt);
        c.push(hc);
        for (let i = c.length - 1; i >= 0; i--) if (['clr', 'direct', 'holdpos', 'hdg'].includes(c[i].k)) c.splice(i, 1);
      }
      const ef = tt.match(/\bexpect (?:further|onward|approach) clearance (?:at |time )?(\d{2,4})\b|\bexpect approach (?:at |time )?(\d{2,4})\b|\befc (\d{2,4})\b/);
      const efm = tt.match(/\bexpect (?:further|onward|approach) clearance in (\d{1,2}) minutes?\b/);
      if (ef || efm) { const e = { efc: ef ? (ef[1] || ef[2] || ef[3]) : null, efcIn: efm ? +efm[1] : null }; if (hc) Object.assign(hc, e); else c.push({ k: 'efc', ...e }); }
      if (has(/\bsouls\b|\bpersons on board\b|\bpeople on board\b|\bfuel (?:remaining|on board|endurance)\b|\bendurance\b/)) c.push({ k: 'souls' });
      if (has(/\b(?:require|need|request|want) (?:any )?(?:further )?assistance\b|\bassistance required\b/)) c.push({ k: 'assist' });
      if (has(/\b(?:emergency services|emergency vehicles|fire (?:services|trucks?|crews?|brigade|rescue)|crash (?:fire )?rescue|trucks (?:are )?(?:standing by|rolling|on the way)|equipment (?:is )?standing by|ambulance|paramedics?|medical (?:services|team|assistance)|tug (?:is )?on (?:the|its) way)\b/)) c.push({ k: 'services' });
      const vs = t.match(/\b(?:verify|confirm)(?: you are)?(?: squawk(?:ing)?| code| transponder)(?: code)? ?(\d{4})?\b/);
      if (vs) { c.push({ k: 'vsq', code: vs[1] || null }); for (let i = c.length - 1; i >= 0; i--) if (c[i].k === 'squawk') c.splice(i, 1); }
      if (has(/\bsteady green\b|\blight gun\b|\blight signal\b/)) c.push({ k: 'green' });
      if (has(/\bcleared(?: for)?(?: the)? visual(?: approach)?\b|\bvisual approach (?:runway \w+ )?(?:is )?approved\b/)) c.push({ k: 'visual' });
      if (has(/\bexpedite\b|\bimmediately\b/) && (ks.has('alt') || ks.has('hdg'))) c.push({ k: 'exped' });
      if (has(/\bunable\b/) && !c.some(x => x.k === 'devno')) c.push({ k: 'unable' });
      if (has(/\bsay (?:your )?intentions\b|\bwhat are your intentions\b/)) c.push({ k: 'intent' });
      if (has(/\bnegative\b.{0,20}\b(?:that was for|was for|not for you)\b|\bnot for you\b/)) c.push({ k: 'notyou' });
    },
    // before the game applies an instruction: is this crew in a state where it can't?
    before(ac, c) {
      if (ac.ra && ['hdg', 'alt', 'spd', 'direct', 'ils', 'hold', 'visual'].includes(c.k)) { if (!ac.flags.raInstr) { ac.flags.raInstr = true; award(-30, `${ac.cs} is following a TCAS RA: no instructions until clear of conflict`); } return { ok: false, why: 'unable, TCAS RA' }; }
      if (['hdg', 'direct', 'ils', 'visual', 'goaround'].includes(c.k) && ac.hold && !(c.k === 'direct' && c.fix === ac.hold.fix)) {
        if (ac.troubleUntil && S.t < ac.troubleUntil && c.k !== 'goaround') return { ok: false, why: `unable, we're still working the checklist, about ${Math.max(1, Math.round((ac.troubleUntil - S.t) / 60))} more minutes` };
        cancelHold(ac);
      }
      if (c.k === 'goaround') ac.flags.atcGa = true;
      if (c.k === 'holdpos' && ac.incursion && !ac.incursion.stopped) { ac.incursion.stopped = true; credit(60, `${ac.cs} stopped on the runway`); }
      if (c.k === 'land' && this.closed(S.rwyArr)) { award(-150, `Landing clearance on a closed runway`); return { ok: false, why: `confirm cleared to land? We understood runway ${arrRwyName()} is closed` }; }
      if ((c.k === 'takeoff' || c.k === 'luaw') && this.closed(S.rwyDep)) { award(-150, `Takeoff clearance on a closed runway`); return { ok: false, why: `confirm? We understood runway ${depRwyName()} is closed for the inspection` }; }
      if (c.k === 'takeoff' && S.lvp && mixedOps() && S.aircraft.some(o => o.kind === 'arr' && o.loc && locGeom(o.x, o.y).d < 6)) UI.log('COACH', 'Low visibility: a departure on the runway disturbs the ILS signal for an arrival inside 6 miles. Wait until it has landed.', 'tip');
      if (c.k === 'taxi' && ac.sitReturn && ac.kind === 'dep') {
        let g = c.gate ? GATES.find(x => x.n === c.gate) : GATES.find(x => x.n === ac.gate);
        if (c.gate && (!g || (g.occ && g.occ !== ac.id))) return { ok: false, why: g ? `${standWord()} ${c.gate} is occupied` : `there's no ${standWord()} ${c.gate}` };
        if (g.n !== ac.gate) { GATES.forEach(x => { if (x.occ === ac.id) x.occ = null; }); seatAtGate(ac, g); }
        const allowed = c.via ? new Set(c.via) : null;
        const path = findPath(ac.node, g.node, allowed) || findPath(ac.node, g.node, null);
        if (!path) return { ok: false, why: 'unable, no route back' };
        ac.path = path; ac.phase = 'taxiing_in'; ac.held = false; ac.request = null; ac.sitReturn = false; ac.flags.returned = true;
        credit(60, `${ac.cs} on its way back to the ${standWord()}`);
        return { ok: true, rb: `Taxi to ${standWord()} ${ac.gate} via ${c.via ? c.via.join(', ') : routeNames(ac.node, path).join(', ')}`, sat: ['sit_return'] };
      }
      return undefined;
    },
    // the new instructions
    apply(ac, c, isAir) {
      const R = (rb, sat) => ({ ok: true, rb, sat: sat || [] }), U = why => ({ ok: false, why });
      const rq = ac.request && ac.request.called ? ac.request.type : null;
      switch (c.k) {
        case 'deviate': {
          if (!isAir) return U('say again');
          const dir = c.dir || ac.devDir || 'left';
          ac.tgtHdg = norm360(ac.hdg + (dir === 'left' ? -25 : 25)); ac.turnDir = dir[0].toUpperCase(); ac.vectored = true; ac.direct = null; ac.holding = false;
          ac.devUntil = S.t + rnd(70, 100);
          if (rq === 'sit_wx') { S.stats.devOk = (S.stats.devOk || 0) + 1; credit(40, `${ac.cs}'s deviation approved`); }
          return R(`Deviating ${dir}, we'll report clear of the weather`, ['sit_wx']);
        }
        case 'devno': return R(`Roger, we'll hold this heading for now`, ['sit_wx']);
        case 'approve': {
          if (rq === 'sit_wx') return this.apply(ac, { k: 'deviate' }, isAir);
          if (rq === 'sit_hold') return this.apply(ac, { k: 'hold', fix: nearestFix(ac) }, isAir);
          if (rq === 'sit_visual') return this.apply(ac, { k: 'visual' }, isAir);
          if (rq === 'sit_direct' && ac.sit && ac.sit.want === 'direct') { ac.direct = ac.exitFix; ac.vectored = true; return R(`Direct ${ac.exitFix}`, ['sit_direct']); }
          if (rq === 'sit_direct') { ac.tgtAlt = Math.min(ac.tgtAlt + 4000, 13000); ac.clearedAlt = ac.tgtAlt; ac.altAssigned = true; return R(`Climb and maintain ${fmtAlt(ac.tgtAlt)}`, ['sit_direct']); }
          return R('Roger', rq ? [rq] : []);
        }
        case 'hold': {
          if (!isAir) return U('say again');
          if (c.dir && c.radial != null && Math.abs(hdgDiff(DIRS[c.dir], c.radial)) > 60) return U(`confirm the holding instructions? The ${pad3(c.radial)} radial isn't ${c.dir} of ${c.fix}`);
          const trouble = rq === 'sit_hold' || (ac.sit && ac.sit.type === 'sit_hold' && !ac.troubleUntil);
          const h = startHold(ac, c);
          if (trouble) { ac.troubleUntil = S.t + rnd(200, 280); credit(60, `${ac.cs} given a hold to work its problem`); }
          else {
            S.stats.holds = (S.stats.holds || 0) + 1;
            if (!h.efc) UI.log('COACH', `Give an expect-further-clearance time with every hold (“expect further clearance ${hhmm(stackEfc(h.fix, ac))}”). If the radio fails, that is when ${ac.cs} leaves the hold and starts the approach.`, 'tip');
            const clash = holders(h.fix).find(a => a !== ac && Math.abs(a.tgtAlt - ac.tgtAlt) < 900);
            if (clash) UI.log('COACH', `${clash.cs} is already holding at ${h.fix} at ${fmtAlt(Math.round(clash.tgtAlt / 100) * 100)}. Stack them 1,000 ft apart: give ${ac.cs} ${fmtAlt(stackSlot(h.fix, ac))}.`, 'tip');
          }
          return R(cap(sayHold(h)), ['sit_hold', 'arr_checkin', 'radar_contact', 'sit_efc']);
        }
        case 'efc': {
          if (!ac.hold) return U(`we're not holding, say again`);
          setEfc(ac.hold, c);
          return R(`Expect further clearance ${ac.hold.efc}`, ['sit_efc']);
        }
        case 'souls': {
          const cr = ac.crew || {}, souls = cr.souls || rint(120, 190), fuel = ac.kind === 'arr' ? (cr.fuel || `${rint(35, 80)} minutes of fuel`) : 'about three hours of fuel';
          if ((ac.emg || ac.nordo || ac.rto) && !ac.flags.soulsAsked) { ac.flags.soulsAsked = true; credit(50, 'asked for souls on board and fuel'); }
          return R(`${souls} souls on board, ${fuel}`, ['sit_emg', 'sit_emgtwr', 'arr_checkin']);
        }
        case 'assist': {
          ac.sitThanks = true;
          const need = ac.rto ? 'affirmative, we would like the fire services to check our brakes' : ac.sitStop ? (ac.sitStop.kind === 'tow' ? 'just the tug, thanks' : 'affirmative, fire services and a tug please') : ac.emg ? (ac.emg.med ? 'affirmative, paramedics at the stand please' : 'affirmative, have the fire services standing by') : 'negative, no assistance required';
          return R(cap(need), ['sit_rto', 'sit_stuck', 'sit_tow']);
        }
        case 'services': {
          if ((ac.emg || ac.sitStop || ac.rto) && !ac.flags.services) { ac.flags.services = true; ac.sitThanks = true; credit(50, 'emergency services called'); }
          return R('Roger, thanks', ['sit_rto', 'sit_stuck', 'sit_tow', 'sit_emg', 'sit_emgtwr', 'sit_ready']);
        }
        case 'vsq': {
          if (ac.squawk !== '7500' || !ac.s75) return R(`Negative, we're squawking ${ac.squawk}`);
          if (ac.s75.verified) return R('Affirmative');
          ac.s75.verified = true;
          if (ac.s75.real) { credit(100, `${ac.cs}: code 7500 verified, no more questions`); sys(`${ac.cs} confirms 7500. Give it priority, don't ask why, and let the authorities know.`); return R('Affirmative'); }
          ac.s75.done = true; ac.squawk = ac.s75.old; credit(60, `${ac.cs}: wrong code caught`);
          return R(`Negative, sorry, finger trouble, squawking ${ac.squawk}`);
        }
        case 'green': if (ac.nordo) { ac.landClr = true; return { ok: true, rb: '', sat: [] }; } return null;
        case 'visual': {
          if (ac.kind !== 'arr' || !isAir) return U('confirm the visual approach? ' + cap(whereWe(ac)));
          if (S.lvp) return U("we can't accept a visual approach, the field is in fog");
          ac.visual = true; ac.ils = true; ac.altAssigned = true;
          if (rq === 'sit_visual') credit(40, `${ac.cs} cleared for the visual`);
          return R(`Cleared visual approach runway ${arrRwyName()}`, ['sit_visual', 'arr_checkin']);
        }
        case 'notyou': { const had = ac.flags.askedFor; ac.flags.askedFor = null; if (had) credit(20, 'callsign confusion cleared up'); return R('Roger'); }
        case 'exped': if (!isAir) return R('Expediting'); ac.exped = true; return R('Expediting');
        case 'unable': return R('Roger', ['sit_visual', 'sit_direct', 'sit_wx'].includes(rq) ? [rq] : []);
        case 'intent': {
          const it = ac.nordo ? '' : ac.emg ? `we'd like to land runway ${arrRwyName()} as soon as possible` : ac.rto ? 'we need to get off the runway and back to a stand' : ac.sitStop ? 'we need a tow' : ac.kind === 'arr' ? `landing runway ${arrRwyName()}` : `continuing to ${ac.dest ? ac.dest.name : 'destination'}`;
          return R(cap(it));
        }
      }
      return null;
    },
    // after a call: which open situation request did it settle?
    after(ac, cmds, results, sat) {
      const rq = ac.request && ac.request.called ? ac.request.type : null;
      if (!rq || !REQS[rq] || !results.some(r => r.ok)) return;
      const by = REQS[rq].by, ks = cmds.map(c => c.k);
      if (by.includes('*') || ks.some(k => by.includes(k))) {
        sat.add(rq);
        if (rq === 'sit_hold' && !ac.troubleUntil && !ks.includes('hold')) { ac.troubleUntil = S.t + rnd(200, 280); if (!ks.includes('hdg')) startHold(ac, { fix: nearestFix(ac) }); credit(40, `${ac.cs} given time to work its problem`); }
        if (rq === 'sit_wxclr' && ks.includes('ack')) { ac.vectored = false; ac.direct = null; }
        if (['sit_rto', 'sit_stuck', 'sit_tow'].includes(rq)) ac.sitThanks = true;
        if (rq === 'sit_minfuel') credit(20, 'minimum fuel acknowledged');
        if ((rq === 'sit_emg' || rq === 'sit_emgtwr') && !ac.flags.emgAck) { ac.flags.emgAck = true; credit(60, `${ac.cs}'s mayday acknowledged`); }
      }
    },
    // every call to an aircraft: hazards passed on, similar callsigns, verify codes
    heard(ac, n) {
      const hz = this.hazard;
      if (hz && !hz.told.has(ac.id) && hz.re.test(n) && !onGround(ac)) { hz.told.add(ac.id); credit(40, `passed on the ${hz.kind === 'windshear' ? 'wind shear' : hz.kind} report to ${ac.cs}`); }
      if (/\btraffic\b/.test(n)) { const v = this.nearVfr(ac); if (v && !v.told.has(ac.id)) { v.told.add(ac.id); S.stats.advis = (S.stats.advis || 0) + 1; credit(40, `traffic advisory to ${ac.cs}`); } }
      if (ac.twin && alive(ac.twin) && /\bsimilar call ?signs?\b/.test(n) && !ac.flags.simWarn) { ac.flags.simWarn = ac.twin.flags.simWarn = true; credit(30, 'similar callsigns warned'); }
      if (ac.twin && alive(ac.twin) && ac.twin.freq === ac.freq && !ac.flags.simWarn && Math.random() < 0.3 && !/\bsimilar\b/.test(n)) {
        const tw = ac.twin; schedule(rnd(4, 6), () => { if (!alive(tw)) return; tw.flags.askedFor = { ac, t: S.t }; pilotSay(tw, `${APT.tel} ${POSNAME[tw.freq]}, was that for ${tel(tw)}?`); });
      }
    },
    // radio failure: whatever is said, nobody answers (a working receiver still does as it's told)
    deaf(ac, cmds) {
      if (!ac.nordo) return false;
      for (const c of cmds) {
        if (c.k === 'green') { ac.landClr = true; credit(50, `steady green for ${ac.cs}`); UI.log('SYS', `Steady green light shown to ${ac.cs}.`, 'tip'); continue; }
        if (!ac.nordo.rx) continue;
        if (c.k === 'ident') { ac.identUntil = S.t + 15; if (!ac.nordo.idented) { ac.nordo.idented = true; UI.log('SYS', `${ac.cs} idents: its receiver works, it can hear you but can't answer.`, 'tip'); credit(40, `found out ${ac.cs} can hear you`); } continue; }
        if (['hdg', 'alt', 'land', 'ils', 'spd', 'direct'].includes(c.k)) applyCmd(ac, c, true);
      }
      if (cmds.some(c => c.k !== 'green') && S.t - (ac.nordo.quietLog || 0) > 20) { ac.nordo.quietLog = S.t; UI.log('SYS', `No reply from ${ac.cs} (squawking 7600).${ac.nordo.rx ? '' : ' Try “if you hear me, ident”.'}`, 'tip'); }
      return true;
    },
    landed(ac) {
      if (ac.nordo) {
        const noLos = !Object.keys(S.losPairs).some(k => k.split('-').includes(String(ac.id)) && S.t - S.losPairs[k] < 1200);
        S.stats.nordoLanded = (S.stats.nordoLanded || 0) + 1;
        credit(noLos ? 300 : 100, `${ac.cs} landed without a radio`);
        const old = ac.nordo.old; ac.nordo = null; ac.squawk = old;
        schedule(rnd(20, 30), () => alive(ac) && pilotSay(ac, `${APT.tel} Tower, ${ac.cs}, radio is back, we had a total radio failure, thanks for the green light.`));
      }
      if (ac.emg && ac.emg.med) schedule(rnd(20, 30), () => alive(ac) && !ac.flags.services && UI.log('COACH', `${ac.cs} has a medical case on board: make sure an ambulance meets it (“paramedics will meet you at the ${standWord()}”).`, 'tip'));
      if (ac.prio && ac.s75 && ac.s75.real) credit(150, `${ac.cs} (7500) on the ground`);
      if (ac.visual) ac.visual = false;
    },

    /* ---------- the coach ---------- */
    suggest(ac, base) {
      if (!ac) return base;
      return this.extras(ac, this.suggest1(ac, base));
    },
    // Things a controller adds to whatever call is due: hazard reports, similar callsigns,
    // low visibility, the emergency status for the next controller, the missed approach after a go-around
    extras(ac, s) {
      if (!s || s.none || !s.text || /^\(/.test(s.text)) {
        const tw = ac.twin;
        if (!s && tw && alive(tw) && tw.freq === ac.freq && !ac.flags.simWarn && staffed(ac.freq)) return { type: 'sit', label: 'Similar callsigns', text: `${ac.cs}, caution, similar callsign on frequency`, template: `${ac.cs}, caution, similar callsign on frequency`, why: `${ac.cs} and ${tw.cs} sound alike. Warn both, say every callsign in full, and listen to who answers (7110.65 §2-4-15).`, pos: ac.freq };
        return s;
      }
      let text = s.text, why = s.why || '';
      const add = (t, w) => { text += t; why += (why ? ' ' : '') + w; };
      if (s.type === 'handoff_ga' && ac.phase === 'ga') {
        text = `${ac.cs}, roger, fly heading ${hdgSay(ac.tgtHdg)}, climb and maintain ${fmtAlt(Math.round(ac.tgtAlt / 100) * 100)}, contact Departure ${FREQ.APP}`;
        why = 'After a go-around, confirm the missed approach (a heading and an altitude clear of the departures), then hand it to the radar controller for another approach. If it went around for wind shear or traffic, warn the aircraft behind.';
      }
      const hz = this.hazard;
      if (hz && hz.by !== ac && !hz.told.has(ac.id) && !/\bcaution\b/.test(text) &&
        ((ac.kind === 'arr' && !onGround(ac)) || (hz.kind === 'birds' && ac.kind === 'dep' && ['takeoff', 'handoff_dep', 'radar_contact'].includes(s.type))))
        add(`, caution, ${hz.say}`, `Pass the pilot report on to every aircraft that will fly through the same place (7110.65 §2-6-3).`);
      if (s.type === 'arr_checkin' && window.Env && Env.wx && !/altimeter|qnh/i.test(text)) add(`, ${Env.pressureSay(false)}`, 'Approach gives the altimeter setting on first contact.');
      if (ac.emg && s.type === 'handoff_twr_arr') add(`, Tower is aware of your ${ac.emg.pan ? 'situation' : 'emergency'}`, 'Coordinate the emergency with the next controller before the handoff, so the crew does not have to explain it again.');
      if (S.lvp) {
        if (s.type === 'landing') add(', report runway vacated', 'Low visibility: the tower cannot see the runway, so ask the crew to report when they have vacated it.');
        if (s.type === 'arr_checkin') add(', low visibility procedures in force', 'Low visibility: tell arrivals that low visibility procedures are in force, and keep 3 NM more between them.');
        if (s.type === 'taxi') add(', low visibility procedures in force, hold at the CAT III holding point', 'Low visibility: departures hold further back, at the CAT III holding point, so they stay out of the ILS signal.');
      }
      const tw = ac.twin;
      if (tw && alive(tw) && tw.freq === ac.freq && !ac.flags.simWarn && !/similar/.test(text)) add(', caution, similar callsign on frequency', `${ac.cs} and ${tw.cs} sound alike: warn them both.`);
      return text === s.text && why === s.why ? s : { ...s, text, why };
    },
    suggest1(ac, base) {
      const cs = ac.cs, rq = ac.request && ac.request.called ? ac.request.type : null;
      const S2 = (type, text, template, why, pos, label) => ({ type, label: label || (REQ[type] ? REQ[type].label : 'Situation'), text, template: template || '', why, pos: pos || (REQ[type] ? REQ[type].pos : ac.freq) });
      const NONE = (label, text, why, pos) => ({ type: 'sit', label, text, template: '', why, pos: pos || ac.freq, none: true });
      if (ac.nordo) {
        const g = !onGround(ac) && locGeom(ac.x, ac.y);
        if (g && ac.loc && g.d < 7 && !ac.landClr && ac.freq === 'TWR') return S2('sit', `${cs}, light gun, steady green, cleared to land runway ${arrRwyName()}`, `${cs}, light gun, steady green`, 'A steady green light from the tower is a landing clearance for an aircraft with no radio (7110.65 §3-2-1, ICAO light signals).', 'TWR', 'No radio: light signal');
        return NONE('Radio failure (7600)', `(${cs} has no radio. It flies its arrival, then the ILS by itself, as the lost-communications rules say. Keep everyone else 3 miles or 1,000 ft away from it.${ac.nordo.rx && !ac.nordo.idented ? ` Try “${cs}, if you hear me, ident”.` : ''})`, 'Radio failure: squawk 7600. Expect it to do exactly what it was last cleared for, and plan around it.', 'APP');
      }
      if (ac.ra) return S2('sit_ra', `${cs}, roger`, `${cs}, roger`, 'An aircraft following a TCAS RA ignores ATC until it reports “clear of conflict” (7110.65 §2-1-27). Acknowledge only; no instructions.');
      if (ac.s75 && !ac.s75.verified && !ac.s75.done && ac.squawk === '7500') return S2('sit', `${cs}, verify squawking 7500`, `${cs}, verify squawking ▢code`, 'Code 7500 means unlawful interference. Verify the code once, calmly; if they confirm, give priority and ask nothing more (7110.65 §10-2-6).', ac.freq, 'Code 7500: verify');
      if (ac.s75 && ac.s75.real && ac.s75.verified && !base) return NONE('Code 7500', `(${cs} confirmed 7500. Give it priority to the runway, don't ask questions, and keep the code on.)`, 'Treat it like any priority arrival; say nothing about the code unless the crew does.');
      // runway incursion: the arrival goes around at once, the aircraft on the runway is stopped
      const intr = S.aircraft.find(o => o.incursion && !o.incursion.done && o.incursion.arr === ac && onGround(o));
      if (intr && !onGround(ac) && ac.phase !== 'ga') return S2('sit', `${cs}, go around, traffic on the runway`, `${cs}, go around, ▢reason`, `${intr.cs} has entered the runway without a clearance and ${cs} is on short final. Send it around now; don't wait to see if the runway clears. Then stop ${intr.cs} with “hold position”.`, 'TWR', 'Runway incursion: go around');
      if (ac.incursion && !ac.incursion.stopped && onGround(ac) && ['lineup_move', 'lineup'].includes(ac.phase)) return S2('sit', `${cs}, hold position`, `${cs}, hold position`, `${cs} is on the runway without a clearance. Stop it where it is, make sure the arrival is going around, and only clear ${cs} once the runway is safe. Then tell it what happened: it may have to report the incursion.`, 'TWR', 'Runway incursion: stop it');
      // the wrong aircraft answered: tell it the call was not for it
      const asked = ac.flags.askedFor;
      if (asked && S.t - asked.t < 60 && alive(asked.ac)) return S2('sit', `${cs}, negative, that was for ${tel(asked.ac)}`, `${cs}, negative, that was for ▢callsign`, `${cs} thinks the last call was for it. Correct it straight away, so it doesn't act on someone else's clearance. Then say the call again to the right aircraft.`, null, 'Wrong aircraft answered');
      const ha = this.holdAdvice(ac, base, rq); if (ha) return ha;
      // after acknowledging a mayday: souls and fuel, then the emergency services; for a medical PAN, the ambulance
      if (ac.emg && !rq && !onGround(ac) && staffed(ac.freq) && ['APP', 'TWR'].includes(ac.freq) && !ac.flags.wentAround) {
        if (!ac.emg.pan && !ac.flags.soulsAsked) return S2('sit', `${cs}, say souls on board and fuel remaining`, `${cs}, say souls on board and fuel remaining`, 'With the mayday acknowledged and the aircraft turning in, ask for the number of people on board and the fuel left in time: the fire services need both (7110.65 §10-2-1).', null, 'Mayday: souls and fuel');
        if (!ac.flags.services) return S2('sit', ac.emg.med ? `${cs}, roger, an ambulance will meet you at the ${standWord()}` : `${cs}, the emergency services have been alerted and will be standing by`, `${cs}, emergency services ▢…`, ac.emg.med ? 'A medical case: arrange paramedics at the stand and tell the crew.' : 'Alert the fire and rescue services and tell the crew they will be waiting.', null, ac.emg.med ? 'Medical: ambulance' : 'Mayday: emergency services');
      }
      if (rq && REQS[rq]) {
        const vec = () => { const v = vectorSuggestion(ac, false); return v && !v.none ? v : null; };
        switch (rq) {
          case 'sit_emg': { const v = vec(); return S2(rq, v ? v.text.replace(`${cs}, `, `${cs}, roger mayday, `) : `${cs}, roger mayday, cleared ILS runway ${arrRwyName()} approach`, `${cs}, roger mayday, turn ▢dir heading ▢hdg, ▢alt`, 'Acknowledge the mayday, give it priority and the shortest way in. Then ask “souls on board and fuel remaining” and have the fire services standing by (7110.65 §10-2-1).'); }
          case 'sit_emgtwr': return S2(rq, `${cs}, roger mayday, contact Departure ${FREQ.APP} for vectors back, emergency services are standing by`, `${cs}, roger mayday, ▢instructions`, 'Acknowledge, alert the fire services, and get it to the radar controller who will bring it back to the runway.');
          case 'sit_hold': { const f = nearestFix(ac), al = stackSlot(f, ac); return S2(rq, `${cs}, roger pan, hold at ${f} as published, ${al < ac.alt - 300 ? 'descend and maintain' : al > ac.alt + 300 ? 'climb and maintain' : 'maintain'} ${fmtAlt(al)}, report ready for the approach`, `${cs}, roger, hold at ▢fix as published, report ready for the approach`, 'A crew working a problem needs time and a quiet place: give a hold and let them call you when they are ready (ICAO Doc 4444 §15.1).'); }
          case 'sit_ready': { const v = vec(); return S2(rq, (v ? v.text : `${cs}, cleared ILS runway ${arrRwyName()} approach`) + ', emergency services are standing by', `${cs}, turn ▢dir heading ▢hdg, emergency services standing by`, 'Bring them in with priority, and tell them the fire services are waiting.'); }
          case 'sit_minfuel': return S2(rq, `${cs}, roger minimum fuel, expect no delay`, `${cs}, roger minimum fuel`, 'Minimum fuel is not an emergency, but any more delay could make it one. Acknowledge and keep it moving.');
          case 'sit_wx': return S2(rq, `${cs}, deviation ${ac.devDir || 'left'} approved, report clear of weather`, `${cs}, deviation ▢left/right approved, report clear of weather`, 'Pilots do not fly into thunderstorms. Approve the deviation if traffic allows; if not, give a heading that avoids both the cell and the traffic.');
          case 'sit_wxclr': { if (ac.kind === 'dep') return S2(rq, `${cs}, proceed direct ${ac.exitFix}`, `${cs}, proceed direct ▢fix`, 'Back on course after the weather.'); const v = vec(); return S2(rq, v ? v.text : `${cs}, roger`, '', 'Back into the sequence for the approach.'); }
          case 'sit_report': { const hz = this.hazard; return S2(rq, `${cs}, roger, thanks for the report${hz && hz.kind === 'drone' ? ', we will inform the police' : ''}`, `${cs}, roger`, 'Acknowledge, then pass it on to every aircraft that will fly through the same place.'); }
          case 'sit_rto': return S2(rq, `${cs}, roger, hold position, do you require assistance?`, `${cs}, roger, hold position, do you require assistance?`, 'After a rejected takeoff the runway is blocked. Stop other movements, ask if they need help, and send arrivals around.');
          case 'sit_stuck': return S2(rq, `${cs}, roger, emergency services are on the way, hold position`, `${cs}, roger, emergency services are on the way`, 'The runway is closed while the aircraft is on it. Get the fire services and a tug out, and hold or send arrivals around.');
          case 'sit_tow': return S2(rq, `${cs}, roger, hold position, a tug is on the way`, `${cs}, roger, a tug is on the way`, 'Send a tug, and route the traffic behind it another way.');
          case 'sit_return': { const g = GATES.find(x => x.n === ac.gate); const p = g ? findPath(ac.node, g.node, null) : null; return S2(rq, `${cs}, taxi to ${standWord()} ${ac.gate} via ${p ? routeNames(ac.node, p).join(', ') : nearName(ac.node)}`, `${cs}, taxi to ${standWord()} ▢number via ▢taxiways`, 'Find them a stand and a route back.'); }
          case 'sit_visual': return S2(rq, `${cs}, cleared visual approach runway ${arrRwyName()}`, `${cs}, cleared visual approach runway ▢runway`, 'They have the field in sight, so they can find their own way to final. Only clear it if it fits your sequence (7110.65 §7-4).');
          case 'sit_direct': return ac.sit && ac.sit.want === 'higher' ? S2(rq, `${cs}, climb and maintain ${fmtAlt(Math.min(ac.tgtAlt + 4000, 13000))}`, `${cs}, climb and maintain ▢altitude`, 'Give them higher if nobody is above them.') : S2(rq, `${cs}, proceed direct ${ac.exitFix}`, `${cs}, proceed direct ▢fix`, 'A shortcut saves them fuel: approve it if it does not cut across your arrivals.');
          case 'sit_racl': return S2(rq, `${cs}, roger`, `${cs}, roger`, 'The RA is over: they go back to their last clearance. Check the separation again.');
        }
      }
      if (ac.sitStop && !rq) return NONE('Waiting for the tug', `(${cs} is stopped; it moves again when the ${ac.sitStop.kind === 'tow' ? 'tug' : 'fire services and tug'} are done.)`, 'Keep everyone clear of it.');
      if (base && base.type === 'takeoff' && this.closed(S.rwyDep)) return NONE('Takeoff (runway closed)', `(${cs} holds: runway ${depRwyName()} is closed for about ${Math.max(1, Math.round((this.closures[S.rwyDep].until - S.t) / 60))} more minutes.)`, 'No takeoffs until the inspection says the runway is clear.', 'TWR');
      if (base && base.type === 'takeoff' && S.lvp && mixedOps() && S.aircraft.some(o => o.kind === 'arr' && o.loc && locGeom(o.x, o.y).d < 6)) return NONE('Takeoff (low visibility)', `(${cs} holds: in low visibility the ILS must stay clear while an arrival is inside 6 miles.)`, 'Low visibility procedures protect the ILS signal.', 'TWR');
      if (base && base.type === 'landing') {
        if (this.closed(S.rwyArr)) { const g = locGeom(ac.x, ac.y); return g.d < 5 ? S2('landing', `${cs}, go around, runway ${arrRwyName()} closed`, `${cs}, go around, runway closed`, 'The runway is closed: send it around now rather than at the last moment.') : NONE('Landing (runway closed)', `(Runway ${arrRwyName()} is closed. Say “${cs}, continue, runway closed, expect go-around” or hold it until the runway opens.)`, 'Plan the go-around early.', 'TWR'); }
        if (ac.emg && !ac.flags.services) return { ...base, text: `${base.text}, emergency services are standing by`, why: base.why + ' Tell an emergency aircraft that the fire services are ready.' };
      }
      if (base && base.type === 'arr_checkin' && ac.emg && !ac.flags.wentAround) return { ...base, text: base.text.replace(/^([^,]+), [^,]*Approach, /, `$1, roger ${ac.emg.pan ? 'pan' : 'mayday'}, `), why: `Acknowledge the ${ac.emg.pan ? 'PAN' : 'mayday'} and give priority. Then ask “souls on board and fuel remaining” and have the emergency services standing by (7110.65 §10-2-1). ${base.why}` };
      if (!rq && !onGround(ac) && staffed(ac.freq)) {
        const v = this.nearVfr(ac);
        if (v && !v.told.has(ac.id) && dist(ac.x, ac.y, v.x, v.y) < 7) {
          const k = clock(ac, v.x, v.y), d = Math.max(1, Math.round(dist(ac.x, ac.y, v.x, v.y)));
          const rel = Math.abs(hdgDiff(ac.hdg, v.hdg)), mv = rel > 135 ? 'opposite direction' : rel < 45 ? 'same direction' : hdgDiff(ac.hdg, v.hdg) > 0 ? 'left to right' : 'right to left';
          return S2('sit', `${cs}, traffic, ${k} o'clock, ${d} miles, ${mv}, altitude indicates ${Math.round(v.alt / 100) * 100}, type unknown`, `${cs}, traffic, ▢clock o'clock, ▢miles, ▢direction, altitude ▢alt`, 'An unknown VFR aircraft is close. Give a traffic advisory: where it is by the clock, how far, which way it goes, how high (7110.65 §2-1-21).', null, 'Traffic advisory');
        }
      }
      return base;
    },

    // Holding, the way an approach controller runs it: park arrivals when the runway is blocked or the
    // sequence is full, stack them 1,000 ft apart, step them down as the bottom one leaves, and keep the EFCs current.
    holdAdvice(ac, base, rq) {
      if (!ac || onGround(ac) || ac.kind !== 'arr' || ac.nordo || ac.troubleUntil) return null;
      if (rq && !['sit_efc', 'arr_checkin'].includes(rq)) return null;
      const cs = ac.cs, P = (label, text, template, why, none) => ({ type: rq || 'hold', label, text, template: template || '', why, pos: 'APP', none: !!none });
      const RULES = 'The crew picks the entry (direct, parallel or teardrop), turns right unless told “left turns”, flies 1-minute legs at or below 14,000 ft (1½ above), and keeps to 200 kt up to 6,000 ft and 230 kt up to 14,000 ft (7110.65 §4-6, ICAO Doc 8168).';
      const blockedT = arrBlockedUntil();
      const verb = al => al < ac.alt - 300 ? 'descend and maintain' : al > ac.alt + 300 ? 'climb and maintain' : 'maintain';
      if (ac.hold) {
        const h = ac.hold, list = holders(h.fix).sort((a, b) => a.tgtAlt - b.tgtAlt), n = list.indexOf(ac) + 1;
        const myAlt = Math.round(ac.tgtAlt / 100) * 100, below = Math.round((myAlt - 1000) / 1000) * 1000;
        if (n > 1 && below >= 5000 && h.ph !== 'to' && !list.some(a => a !== ac && (Math.abs(a.tgtAlt - below) < 300 || (a.alt > below - 900 && a.alt < ac.alt)))) return P('Step down in the stack', `${cs}, descend and maintain ${fmtAlt(below)}`, `${cs}, descend and maintain ▢altitude`, `The level below it at ${h.fix} is free: step it down 1,000 ft, so the stack stays tight and the next one in can go on top.`);
        if (blockedT > S.t) {
          if (!h.efcT || S.t > h.efcT - 60) { const t = Math.max(stackEfc(h.fix, ac), blockedT + 120 + (n - 1) * 180); return P('Holding: update the EFC', `${cs}, expect further clearance ${hhmm(t)}`, `${cs}, expect further clearance ▢time`, 'The runway is still blocked and its EFC is running out. Give a new one before it passes; a crew with no radio would leave the hold at the old time. ' + RULES); }
          return P(`Holding, number ${n} at ${h.fix}`, `(${cs} holds at ${h.fix}, ${fmtAlt(myAlt)}${h.efc ? ', EFC ' + h.efc : ''}. Nothing to say until the runway opens.)`, '', RULES, true);
        }
        const others = S.aircraft.filter(a => a.kind === 'arr' && !onGround(a) && !a.hold && !a.loc && a !== ac && dist(0, 0, a.x, a.y) < 25).length; // ones still out at the edge of the airspace come after the stack
        // the bottoms of all the stacks take turns: the one holding longest goes first
        const bottoms = S.aircraft.filter(a => a.hold && !onGround(a) && holders(a.hold.fix).sort((p, q) => p.tgtAlt - q.tgtAlt)[0] === a), first = bottoms.sort((p, q) => (p.hold.since ?? 0) - (q.hold.since ?? 0))[0] === ac;
        if (n === 1 && ((first && others < (mixedOps() ? 2 : 3)) || (h.efcT && S.t >= h.efcT - 60 && others < 4))) {
          const v = vectorSuggestion(ac, false);
          if (v && !v.none) return P(`Leave the hold at ${h.fix}`, v.text.replace(`${cs}, `, `${cs}, leave ${h.fix}, `), `${cs}, leave ▢fix, turn ▢dir heading ▢hdg, descend and maintain ▢alt`, `It is the lowest in the stack at ${h.fix}, so it leaves first: a heading out of the hold and a lower altitude, then the approach. Everyone above steps down 1,000 ft.`);
        }
        if (rq === 'sit_efc' || (h.efcT && S.t > h.efcT - 60)) return P('Holding: update the EFC', `${cs}, expect further clearance ${hhmm(stackEfc(h.fix, ac))}`, `${cs}, expect further clearance ▢time`, `Its EFC is up but it isn't its turn yet: give a new time, a few minutes after the aircraft below it. ` + RULES);
        return P(`Holding, number ${n} at ${h.fix}`, `(${cs} is number ${n} in the hold at ${h.fix}, ${fmtAlt(myAlt)}${h.efc ? ', EFC ' + h.efc : ''}. It moves down when the one below leaves.)`, '', RULES, true);
      }
      if (ac.freq !== 'APP' || ac.loc || ac.ils || ac.emg || ac.visual || ac.prio || !base) return null;
      const fix = holdFixFor(ac), slot = arrSlots()[ac.id], blocked = blockedT - S.t > 120;
      const sequenced = S.aircraft.filter(a => a !== ac && a.kind === 'arr' && !onGround(a) && !a.hold && !a.loc).length;
      // a long sequence is a reason to hold for a player on Approach; the AI controller leaves them on the arrival instead. Nobody jumps a stack.
      const full = (staffed('APP') && slot && slot.baseD > 32) || (holders(fix).length > 0 && sequenced >= 1);
      if (!blocked && !full) return null;
      const al = stackSlot(fix, ac), efcT = stackEfc(fix, ac);
      const pre = base.type === 'arr_checkin' ? `${cs}, ${APT.tel} Approach, ` : `${cs}, `;
      return P(`Hold at ${fix}`, `${pre}hold at ${fix} as published, ${verb(al)} ${fmtAlt(al)}, expect further clearance ${hhmm(efcT)}`,
        `${cs}, hold ▢direction of ▢fix on the ▢radial radial, ▢leg length, ▢left turns, maintain ▢altitude, expect further clearance ▢time`,
        `${blocked ? `The runway is blocked for about ${Math.round((blockedT - S.t) / 60)} more minutes` : 'The arrival sequence is full'}: park it in the hold at ${fix}, its arrival fix. Stack 1,000 ft apart from 5,000 ft up; the lowest leaves first. Always give an EFC. For a hold that isn't published, say the direction from the fix, the fix, the radial, legs if not standard, “left turns” if not right, the altitude and the EFC (7110.65 §4-6-4). ` + RULES);
    },

    tag(a) {
      const t = [];
      if (a.emg) t.push(`<span class="tag e">${a.emg.pan ? 'PAN' : 'MAYDAY'}</span>`);
      if (a.nordo) t.push('<span class="tag e">NORDO 7600</span>');
      if (a.squawk === '7500') t.push('<span class="tag e">7500</span>');
      if (a.ra) t.push('<span class="tag e">TCAS RA</span>');
      if (a.rto) t.push('<span class="tag e">RTO</span>');
      if (a.sitStop) t.push(`<span class="tag e">${a.sitStop.kind === 'tow' ? 'BROKEN DOWN' : 'DISABLED'}</span>`);
      if (a.minFuel) t.push('<span class="tag e">MIN FUEL</span>');
      if (a.hold) t.push(`<span class="tag v">HOLD ${a.hold.fix}${a.hold.efc ? ' EFC ' + a.hold.efc : ''}</span>`);
      if (a.devUntil) t.push('<span class="tag v">WX DEV</span>');
      if (a.twin && alive(a.twin)) t.push('<span class="tag v">SIMILAR CS</span>');
      return t.join('');
    },
    // the radar data block's top line: what the scope shows for special codes
    flag(a) { return a.squawk === '7700' ? 'EM' : a.squawk === '7600' ? 'RF' : a.squawk === '7500' ? 'HJ' : a.ra ? 'RA' : ''; },

    /* ---------- drawing ---------- */
    drawRadar(c, X, Y, sc, now) {
      // holding patterns in use, and the stack at each fix
      const drawn = new Set(), stacks = {};
      for (const a of S.aircraft) {
        const h = a.hold; if (!h || onGround(a)) continue;
        (stacks[h.fix] = stacks[h.fix] || []).push(a);
        const key = [h.fix, h.inbound, h.left, h.legNm, h.legMin].join('|'); if (drawn.has(key)) continue; drawn.add(key);
        const f = FIXES[h.fix]; if (!f) continue;
        const u = h.inbound * Math.PI / 180, ux = Math.sin(u), uy = Math.cos(u), s = h.left ? -1 : 1, rx = uy * s, ry = -ux * s;
        const R = turnR(holdSpd(a.alt)), L = legOf(h, a.alt), P = [];
        const c1 = { x: f.x + rx * R, y: f.y + ry * R }, c2 = { x: f.x + rx * R - ux * L, y: f.y + ry * R - uy * L };
        for (let i = 0; i <= 14; i++) { const t = i / 14 * Math.PI; P.push([c1.x + R * (-rx * Math.cos(t) + ux * Math.sin(t)), c1.y + R * (-ry * Math.cos(t) + uy * Math.sin(t))]); }
        for (let i = 0; i <= 14; i++) { const t = i / 14 * Math.PI; P.push([c2.x + R * (rx * Math.cos(t) - ux * Math.sin(t)), c2.y + R * (ry * Math.cos(t) - uy * Math.sin(t))]); }
        P.push([f.x, f.y]);
        c.save(); c.strokeStyle = 'rgba(127,211,255,.55)'; c.lineWidth = 1.2; c.setLineDash([5, 4]);
        c.beginPath(); P.forEach(([x, y], i) => i ? c.lineTo(X(x), Y(y)) : c.moveTo(X(x), Y(y))); c.stroke();
        // inbound arrow
        c.setLineDash([]); const ax = X(f.x - ux * L * 0.45), ay = Y(f.y - uy * L * 0.45), ang = Math.atan2(-uy, ux);
        c.beginPath(); c.moveTo(ax + Math.cos(ang) * 5, ay + Math.sin(ang) * 5); c.lineTo(ax + Math.cos(ang + 2.5) * 5, ay + Math.sin(ang + 2.5) * 5); c.lineTo(ax + Math.cos(ang - 2.5) * 5, ay + Math.sin(ang - 2.5) * 5); c.closePath(); c.fillStyle = 'rgba(127,211,255,.7)'; c.fill();
        c.restore();
      }
      for (const fix in stacks) {
        const f = FIXES[fix]; if (!f) continue;
        const list = stacks[fix].sort((a, b) => b.tgtAlt - a.tgtAlt), x = X(f.x) + 10, y = Y(f.y) + 16;
        c.font = '10px Inconsolata, monospace'; c.fillStyle = 'rgba(10,20,28,.8)'; c.fillRect(x - 3, y - 10, 118, 13 * list.length + 15);
        c.fillStyle = '#7FD3FF'; c.fillText(`HOLD ${fix}`, x, y);
        list.forEach((a, i) => c.fillText(`${String(Math.round(a.tgtAlt / 100)).padStart(3, '0')} ${a.cs}${a.hold.efc ? ' ' + a.hold.efc : ''}`, x, y + 13 * (i + 1)));
      }
      for (const cell of this.cells) { // weather radar: green rain, yellow and red cores
        const age = Math.min(1, (S.t - cell.born) / 90), fade = Math.min(1, Math.max(0, (this.cellsUntil - S.t) / 90));
        c.save(); c.globalAlpha = 0.55 * age * fade;
        [[1, 'rgba(46,160,67,.35)'], [0.66, 'rgba(230,190,40,.45)'], [0.36, 'rgba(220,60,50,.55)']].forEach(([k, col], i) => {
          c.fillStyle = col; c.beginPath();
          for (let a = 0; a <= 24; a++) { const t = a / 24 * Math.PI * 2, wob = 1 + 0.18 * Math.sin(t * 3 + cell.seed + i) + 0.1 * Math.sin(t * 5 + cell.seed * 2); const rr = cell.r * k * wob; const px = X(cell.x + Math.sin(t) * rr), py = Y(cell.y + Math.cos(t) * rr); a ? c.lineTo(px, py) : c.moveTo(px, py); }
          c.closePath(); c.fill();
        });
        c.restore();
      }
      for (const v of this.vfr) { // VFR primary/1200 targets
        const x = X(v.x), y = Y(v.y);
        c.fillStyle = '#9FB3C8'; v.trail.forEach((p, i) => { c.globalAlpha = 0.12 + i * 0.07; c.fillRect(X(p.x) - 1, Y(p.y) - 1, 2.5, 2.5); }); c.globalAlpha = 1;
        c.strokeStyle = '#9FB3C8'; c.lineWidth = 1.4; c.beginPath(); c.moveTo(x - 4, y - 4); c.lineTo(x + 4, y + 4); c.moveTo(x + 4, y - 4); c.lineTo(x - 4, y + 4); c.stroke(); c.lineWidth = 1;
        c.font = '10px Inconsolata, monospace'; c.fillStyle = '#9FB3C8'; c.fillText(`1200 ${String(Math.round(v.alt / 100)).padStart(3, '0')}`, x + 8, y - 6);
      }
      for (const rid in this.closures) { const rw = RWY[rid]; if (!rw) continue; c.strokeStyle = '#FF5A4F'; c.lineWidth = 2; const mx = X((rw.x1 + rw.x2) / 2), my = Y(rw.y); c.beginPath(); c.moveTo(mx - 7, my - 7); c.lineTo(mx + 7, my + 7); c.moveTo(mx + 7, my - 7); c.lineTo(mx - 7, my + 7); c.stroke(); c.lineWidth = 1; }
    },
    drawGround(c, X, Y, M, now, r) {
      const blink = Math.floor(now / 350) % 2 === 0;
      const lamp = (x, y, col) => { c.fillStyle = col; c.beginPath(); c.arc(x, y, Math.max(1.6, 1.2 * M), 0, 7); c.fill(); };
      const truck = (wx, wy, hdg, body, len, wid, lights) => {
        const x = X(wx), y = Y(wy), L = Math.max(len * M, 5), W = Math.max(wid * M, 2.5);
        c.save(); c.translate(x, y); c.rotate(hdg * Math.PI / 180);
        c.fillStyle = 'rgba(0,0,0,.25)'; c.fillRect(-W / 2 + 1, -L / 2 + 1, W, L);
        c.fillStyle = body; c.fillRect(-W / 2, -L / 2, W, L);
        if (lights) { lamp(-W / 3, -L / 2 + 1, blink ? lights[0] : lights[1]); lamp(W / 3, -L / 2 + 1, blink ? lights[1] : lights[0]); }
        c.restore();
      };
      // runway inspection car driving the runway
      for (const rid in this.closures) {
        const cl = this.closures[rid], rw = RWY[rid]; if (!rw) continue;
        const v = cl.veh; v.x += v.dir * 0.0006; if (v.x > rw.x2) v.dir = -1; if (v.x < rw.x1) v.dir = 1;
        truck(v.x, rw.y + 0.006, v.dir > 0 ? 90 : 270, '#F2C230', 4.6, 1.9, ['#FFB020', '#5a4200']);
        const x1 = X(rw.x1), x2 = X(rw.x2), y = Y(rw.y);
        if (M > 0.2) { c.strokeStyle = 'rgba(255,214,0,.85)'; c.lineWidth = Math.max(2, 6 * M); [[x1, 1], [x2, -1]].forEach(([x, s]) => { const xx = x + s * 30 * M; c.beginPath(); c.moveTo(xx - 12 * M, y - 12 * M); c.lineTo(xx + 12 * M, y + 12 * M); c.moveTo(xx + 12 * M, y - 12 * M); c.lineTo(xx - 12 * M, y + 12 * M); c.stroke(); }); }
      }
      // fire trucks round a disabled aircraft, a tug for a breakdown
      for (const ac of S.aircraft) {
        if (!(ac.sitStop || ac.rto) || !onGround(ac)) continue;
        const [L, B] = dimsOf(ac.type), h = ac.hdg * Math.PI / 180, ux = Math.sin(h), uy = Math.cos(h), m = 1 / 1852;
        if (ac.sitStop && ac.sitStop.kind === 'tow') { truck(ac.x + ux * (L / 2 + 6) * m, ac.y + uy * (L / 2 + 6) * m, ac.hdg, '#E8E8E8', 6, 2.6, ['#FFB020', '#5a4200']); continue; }
        const spots = [[B / 2 + 10, 0], [-(B / 2 + 10), 0], [B / 3, L / 2 + 12], [-B / 3, -L / 2 - 12]];
        spots.forEach(([sx, sy], i) => truck(ac.x + (uy * sx + ux * sy) * m, ac.y + (-ux * sx + uy * sy) * m, ac.hdg + (i % 2 ? 90 : -90), '#D7261E', 10, 3, ['#FF3B30', '#2F7CF6']));
      }
      // fog
      if (S.lvp && !window.Env) { c.fillStyle = 'rgba(214,219,224,.5)'; c.fillRect(r.x, r.y, r.w, r.h); }
    },
  };
  Sit.startHold = startHold; // the published missed approach ends in a hold (procs.js)
  window.Sit = Sit;
})();
