'use strict';
/* ==========================================================================
   Settings: one window for everything you can change while you play.
   Opened from the Windows app's menu (File or Edit > Settings…), the gear in the top bar, or Ctrl+,.
   - Audio: which microphone and which speakers (any device Windows has), volumes for pilots,
     AI controllers and radio effects, a microphone level meter and a speaker test
   - Radio and voices: pilot voices, radio effects, listening to the AI controllers, voice input,
     which speech recognition to use
   - Weather and time: live or chosen weather, time of day (applied straight away)
   - Display: the map, the coach, the score
   - Controls: the push-to-talk key, and every keyboard shortcut
   ========================================================================== */
(function () {
  const $ = s => document.querySelector(s);
  const KEY = 'vector_settings2';
  const Settings = {
    p: { mic: 'default', spk: 'default', vol: { master: 1, pilots: 1, ai: 0.8, fx: 0.8, amb: 0.6 }, ptt: 'Space', asr: 'auto', amb: true, ui: 1, hc: false, cb: false, calm: false },
    tab: 'audio', meter: null,
    load() { try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s) this.p = { ...this.p, ...s, vol: { ...this.p.vol, ...(s.vol || {}) } }; } catch (e) { } try { const a = localStorage.getItem('vector_asr'); if (a) this.p.asr = a; } catch (e) { } },
    save() { try { localStorage.setItem(KEY, JSON.stringify(this.p)); } catch (e) { } },

    /* ---------- applying the choices ---------- */
    // volume channels inside the radio's audio graph: master > (pilots, AI controllers, effects)
    bus(kind) {
      const R = (typeof Radio !== 'undefined' ? Radio : null); if (!R || !R.ctx || !R.master) return R && R.master;
      if (!R.buses) { R.buses = {}; for (const k of ['pilots', 'ai', 'fx', 'amb']) { const g = R.ctx.createGain(); g.connect(R.master); R.buses[k] = g; } this.applyVolumes(); }
      return R.buses[kind] || R.master;
    },
    applyVolumes() {
      const R = (typeof Radio !== 'undefined' ? Radio : null), v = this.p.vol; if (!R || !R.ctx) return;
      if (R.master) R.master.gain.value = v.master;
      if (R.buses) { R.buses.pilots.gain.value = v.pilots; R.buses.ai.gain.value = v.ai; R.buses.fx.gain.value = v.fx; R.buses.amb.gain.value = this.p.amb === false ? 0 : v.amb; }
    },
    // the speakers: every game sound comes from one audio engine, so it all moves together
    async applySpeaker() {
      const R = (typeof Radio !== 'undefined' ? Radio : null), id = this.p.spk === 'default' ? '' : this.p.spk;
      try { if (R && R.ctx && R.ctx.setSinkId) await R.ctx.setSinkId(id); } catch (e) { this.note('Couldn’t switch to that speaker: ' + e.message); }
    },
    canPickSpeaker() { return !!(window.AudioContext && AudioContext.prototype.setSinkId); },
    micConstraint() { return this.p.mic && this.p.mic !== 'default' ? { deviceId: { exact: this.p.mic } } : {}; },
    // a new microphone: close the open one so the next press of the talk key opens the chosen device
    resetMic() {
      const V = (typeof Voice !== 'undefined' ? Voice : null); if (V && V.mic) { try { V.mic.stream.getTracks().forEach(t => t.stop()); V.mic.ctx.close(); } catch (e) { } V.mic = null; }
      // the browser's own recogniser always listens to the Windows default microphone; another device needs the game's recogniser
      if (V && this.p.mic !== 'default' && V.asrAvail && this.p.asr !== 'browser') V.server = true;
      else if (V) V.probe();
    },
    applyAsr() { try { if (this.p.asr === 'auto') localStorage.removeItem('vector_asr'); else localStorage.setItem('vector_asr', this.p.asr); } catch (e) { } if ((typeof Voice !== 'undefined' ? Voice : null)) Voice.probe(); },
    isPtt(e) { return e.code === this.p.ptt; },
    keyName(code) {
      const N = { Space: 'Space', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', AltLeft: 'Left Alt', AltRight: 'Right Alt', CapsLock: 'Caps Lock', Backquote: '`', Insert: 'Insert', Backslash: '\\' };
      return N[code] || code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ').replace(/^F(\d+)$/, 'F$1');
    },
    applyAll() { this.applyVolumes(); this.applySpeaker(); },
    // accessibility: text size, high contrast, colour-blind safe colours, calmer screen
    applyAccess() {
      const b = document.body; if (!b) return;
      b.style.zoom = this.p.ui && this.p.ui !== 1 ? this.p.ui : '';
      b.classList.toggle('hc', !!this.p.hc); b.classList.toggle('cb', !!this.p.cb); b.classList.toggle('calm', !!this.p.calm);
      if (typeof R !== 'undefined' && R.resize) { R.resize(); R.sceneFor = null; }
    },
    // colours for targets that stay apart for red-green colour blindness (blue/orange/magenta instead of green/red)
    col(c) { if (!this.p.cb) return c; return ({ '#FF5A4F': '#FF4FD8', '#8DEBB4': '#6FB8FF', '#FF8A80': '#FF8AE6', '#6FE3A1': '#6FB8FF' })[c] || c; },

    /* ---------- the window ---------- */
    open(tab) {
      if (tab) this.tab = tab;
      let el = $('#settingsWin');
      if (!el) { el = document.createElement('div'); el.id = 'settingsWin'; document.body.appendChild(el); el.addEventListener('mousedown', e => { if (e.target === el) this.close(); }); }
      el.classList.add('on'); this.wasPaused = S.paused; if (S.running && !S.paused) { S.paused = true; this.paused = true; }
      this.render();
    },
    close() {
      const el = $('#settingsWin'); if (el) el.classList.remove('on');
      this.stopMeter(); this.capturing = false;
      if (this.paused) { S.paused = false; this.paused = false; }
    },
    note(t) { const n = $('#setNote'); if (n) n.textContent = t; },
    tabs() { return [['audio', 'Audio'], ['radio', 'Radio and voices'], ['wx', 'Weather and time'], ['display', 'Display'], ['view', 'View'], ['access', 'Accessibility'], ['controls', 'Controls']]; },
    async devices() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return { mics: [], spks: [] };
      let list = await navigator.mediaDevices.enumerateDevices();
      if (!list.some(d => d.kind === 'audioinput' && d.label)) { // names only show once the microphone is allowed
        try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); list = await navigator.mediaDevices.enumerateDevices(); } catch (e) { }
      }
      const clean = l => l.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '');
      return {
        mics: list.filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'communications').map(d => ({ id: d.deviceId, name: d.deviceId === 'default' ? 'Windows default' + (d.label ? ' (' + clean(d.label.replace(/^Default - /, '')) + ')' : '') : clean(d.label || 'Microphone') })),
        spks: list.filter(d => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'communications').map(d => ({ id: d.deviceId, name: d.deviceId === 'default' ? 'Windows default' + (d.label ? ' (' + clean(d.label.replace(/^Default - /, '')) + ')' : '') : clean(d.label || 'Speakers') })),
      };
    },
    async render() {
      const el = $('#settingsWin'); if (!el) return;
      const tabs = this.tabs().map(([k, l]) => `<button class="st-tab${this.tab === k ? ' on' : ''}" data-tab="${k}">${l}</button>`).join('');
      el.innerHTML = `<div class="st-box" role="dialog" aria-label="Settings"><div class="st-head"><b>Settings</b><button class="st-x" id="setClose" aria-label="Close">✕</button></div>
        <div class="st-body"><nav class="st-nav">${tabs}</nav><section class="st-pane" id="setPane"><div class="st-load">Loading…</div></section></div>
        <div class="st-foot"><span id="setNote"></span><button class="go st-done" id="setDone">Done</button></div></div>`;
      $('#setClose').onclick = $('#setDone').onclick = () => this.close();
      el.querySelectorAll('.st-tab').forEach(b => b.onclick = () => { this.stopMeter(); this.tab = b.dataset.tab; this.render(); });
      const pane = $('#setPane');
      pane.innerHTML = await this['pane_' + this.tab]();
      this['wire_' + this.tab] && this['wire_' + this.tab](pane);
    },
    row(label, ctrl, hint) { return `<div class="st-row"><label>${label}</label><div class="st-ctl">${ctrl}${hint ? `<small>${hint}</small>` : ''}</div></div>`; },
    toggle(id, on) { return `<label class="st-sw"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i></i></label>`; },
    slider(id, v) { return `<div class="st-sl"><input type="range" id="${id}" min="0" max="100" value="${Math.round(v * 100)}"><span>${Math.round(v * 100)}%</span></div>`; },
    sel(id, opts, cur) { return `<select id="${id}" class="st-sel">${opts.map(([v, l]) => `<option value="${String(v).replace(/"/g, '&quot;')}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('')}</select>`; },

    async pane_audio() {
      const d = await this.devices(), app = /VECTOR-Desktop\//.test(navigator.userAgent), V = (typeof Voice !== 'undefined' ? Voice : null);
      const mics = d.mics.length ? d.mics.map(m => [m.id, m.name]) : [['default', 'Windows default']];
      const spks = d.spks.length ? d.spks.map(m => [m.id, m.name]) : [['default', 'Windows default']];
      if (this.p.mic !== 'default' && !mics.some(m => m[0] === this.p.mic)) mics.push([this.p.mic, 'Not connected']);
      if (this.p.spk !== 'default' && !spks.some(m => m[0] === this.p.spk)) spks.push([this.p.spk, 'Not connected']);
      if (!mics.some(m => m[0] === 'default')) mics.unshift(['default', 'Windows default']);
      if (!spks.some(m => m[0] === 'default')) spks.unshift(['default', 'Windows default']);
      const browserAsr = V && !V.server;
      return `<h3>Microphone</h3>
        ${this.row('Microphone', this.sel('setMic', mics, this.p.mic), browserAsr && this.p.mic !== 'default' ? 'This browser’s speech recognition always uses the Windows default microphone. The chosen one is used when the game’s own recognition (Whisper) is on.' : 'Used when you hold the talk key.')}
        ${this.row('Level', '<div class="st-meter"><i id="setLevel"></i></div><button class="cbtn" id="setMicTest">Test</button>', 'Speak: the bar should move well into the green, but not hit the end.')}
        <h3>Speakers</h3>
        ${this.row('Speakers or headset', this.canPickSpeaker() ? this.sel('setSpk', spks, this.p.spk) : '<span class="st-dim">This browser can only play through the Windows default speakers.</span>', 'Pilots, the AI controllers and every radio sound play here.')}
        ${this.row('Test', '<button class="cbtn" id="setSpkTest">Play a radio call</button>')}
        <h3>Volume</h3>
        ${this.row('Overall', this.slider('setVolMaster', this.p.vol.master))}
        ${this.row('Pilots', this.slider('setVolPilots', this.p.vol.pilots))}
        ${this.row('AI controllers', this.slider('setVolAi', this.p.vol.ai))}
        ${this.row('Radio effects', this.slider('setVolFx', this.p.vol.fx), 'Static, squelch, clicks and alerts.')}
        ${this.row('Airfield sound', this.slider('setVolAmb', this.p.vol.amb), 'Wind, rain and engines as heard from the tower: loud in the airport view, faint behind the radar.')}
        ${app ? '' : '<p class="st-dim">In a browser, devices are listed once you allow the microphone.</p>'}`;
    },
    wire_audio(pane) {
      const mic = $('#setMic'), spk = $('#setSpk');
      if (mic) mic.onchange = () => { this.p.mic = mic.value; this.save(); this.resetMic(); this.note('Microphone changed.'); if (this.meter) this.startMeter(); };
      if (spk) spk.onchange = async () => { this.p.spk = spk.value; this.save(); await this.applySpeaker(); this.note('Speakers changed.'); };
      for (const [id, k] of [['setVolMaster', 'master'], ['setVolPilots', 'pilots'], ['setVolAi', 'ai'], ['setVolFx', 'fx'], ['setVolAmb', 'amb']]) {
        const s = $('#' + id); s.oninput = () => { this.p.vol[k] = s.value / 100; s.nextElementSibling.textContent = s.value + '%'; this.applyVolumes(); }; s.onchange = () => this.save();
      }
      $('#setMicTest').onclick = () => this.meter ? this.stopMeter() : this.startMeter();
      $('#setSpkTest').onclick = () => this.testSpeaker();
    },
    async startMeter() {
      this.stopMeter();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...this.micConstraint(), echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        const ctx = new AudioContext(), an = ctx.createAnalyser(); an.fftSize = 512; ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Float32Array(an.fftSize), bar = $('#setLevel'), btn = $('#setMicTest'); if (btn) btn.textContent = 'Stop';
        const tick = () => { if (!this.meter) return; an.getFloatTimeDomainData(buf); let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v)); const lv = Math.min(1, Math.sqrt(p) * 1.15); if (bar) { bar.style.width = (lv * 100).toFixed(0) + '%'; bar.className = lv > 0.92 ? 'hot' : ''; } this.meter.raf = requestAnimationFrame(tick); };
        this.meter = { stream, ctx }; tick();
        this.note('Listening to: ' + (stream.getAudioTracks()[0].label || 'microphone'));
      } catch (e) { this.note('The microphone couldn’t be opened: ' + (e.message || e.name)); }
    },
    stopMeter() { const m = this.meter; if (!m) return; this.meter = null; cancelAnimationFrame(m.raf); try { m.stream.getTracks().forEach(t => t.stop()); m.ctx.close(); } catch (e) { } const b = $('#setMicTest'); if (b) b.textContent = 'Test'; const bar = $('#setLevel'); if (bar) bar.style.width = '0'; },
    // a short radio call through the full chain: squelch, a voice-like tone, squelch tail
    testSpeaker() {
      const R = (typeof Radio !== 'undefined' ? Radio : null); if (!R) return; const c = R.audio(); if (!c) { this.note('Turn on radio effects to hear the test.'); return; }
      this.applySpeaker();
      const out = this.bus('pilots'), t0 = c.currentTime + 0.05;
      const sq = (t, d) => { const s = c.createBufferSource(); s.buffer = R.noiseBuf; const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2200; const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.25, t + 0.01); g.gain.linearRampToValueAtTime(0.0001, t + d); s.connect(f); f.connect(g); g.connect(this.bus('fx')); s.start(t); s.stop(t + d + 0.05); };
      sq(t0, 0.12);
      for (let i = 0; i < 6; i++) { const o = c.createOscillator(), g = c.createGain(), t = t0 + 0.15 + i * 0.18; o.type = 'sawtooth'; o.frequency.value = [180, 210, 160, 230, 190, 150][i]; const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 0.8; g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.22, t + 0.03); g.gain.linearRampToValueAtTime(0.0001, t + 0.16); o.connect(f); f.connect(g); g.connect(out); o.start(t); o.stop(t + 0.2); }
      sq(t0 + 1.3, 0.25);
      this.note('Playing a test call on ' + (($('#setSpk') && $('#setSpk').selectedOptions[0]) ? $('#setSpk').selectedOptions[0].textContent : 'the default speakers') + '.');
    },

    pane_radio() {
      const V = (typeof Voice !== 'undefined' ? Voice : null), R = (typeof Radio !== 'undefined' ? Radio : null), srv = V && V.asrAvail;
      return `<h3>Voices</h3>
        ${this.row('Pilot voices', this.toggle('setPv', R.pilotVoices), 'Each crew speaks with its own voice and accent.')}
        ${this.row('Listen in on the AI controllers', this.toggle('setAiv', R.aiVoices), 'Hear the positions the AI is working.')}
        ${this.row('Radio sound', this.toggle('setSfx', R.sfx), 'Static, squelch, the key click, alerts. Off also mutes the pilots’ radio effect.')}
        <h3>Voice input</h3>
        ${this.row('Talk to the pilots by voice', this.toggle('setMicOn', V ? V.enabled : true))}
        ${this.row('Speech recognition', this.sel('setAsr', [['auto', 'Automatic'], ['server', 'Game server (Whisper on the GPU)'], ['browser', 'This browser’s own']], this.p.asr), srv ? 'The game server’s recognition knows the callsigns and taxiways and can use any microphone.' : 'The game server’s recognition isn’t available right now.')}`;
    },
    wire_radio() {
      const R = (typeof Radio !== 'undefined' ? Radio : null), V = (typeof Voice !== 'undefined' ? Voice : null);
      $('#setPv').onchange = e => { R.pilotVoices = e.target.checked; this.saveGame(); };
      $('#setAiv').onchange = e => { R.aiVoices = e.target.checked; this.saveGame(); };
      $('#setSfx').onchange = e => { R.sfx = e.target.checked; this.saveGame(); };
      $('#setMicOn').onchange = e => { if (V) { V.enabled = e.target.checked; UI.pttState(false); } this.saveGame(); };
      $('#setAsr').onchange = e => { this.p.asr = e.target.value; this.save(); this.applyAsr(); this.note('Speech recognition: ' + e.target.selectedOptions[0].textContent + '.'); };
    },
    // the game's own saved settings (the same ones as the shift setup)
    saveGame() { try { const st = JSON.parse(localStorage.getItem('vector_atc_settings') || '{}'); Object.assign(st, { pv: Radio.pilotVoices, av: Radio.aiVoices, sfx: Radio.sfx, mic: Voice.enabled, coach: UI.coachMode, score: S.opt.score }); localStorage.setItem('vector_atc_settings', JSON.stringify(st)); } catch (e) { } },

    pane_wx() {
      const E = window.Env; if (!E) return '<p>Weather isn’t available.</p>';
      return `<h3>Weather</h3>
        ${this.row('Weather', this.sel('setWxm', [['live', 'Live: the airport’s real weather'], ['sim', 'Chosen']], E.mode))}
        ${this.row('Chosen weather', this.sel('setWxp', Object.entries(E.PRESETS), E.preset), 'Used when the weather is set to Chosen.')}
        ${this.row('Now', `<code class="st-metar">${E.wx ? E.wx.raw.replace(/^(METAR|SPECI)\s+/, '') : '—'}</code>`)}
        <h3>Light</h3>
        ${this.row('Time of day', this.sel('setTod', Object.entries(E.TODS).map(([k, v]) => [k, v + (k === 'real' ? ' at the airport' : '')]), E.tod))}`;
    },
    wire_wx() {
      const E = window.Env, again = () => { E.L = null; if (R.gs) R.gs.key = ''; };
      const applyWx = async () => {
        E.save();
        if (!S.running) return;
        if (E.mode === 'live') { try { const d = await E.fetchLive(E.icao()); E.update(d.raw, 'live', false); } catch (e) { this.note('No live weather right now.'); } }
        else E.update(E.simMetar(E.preset, E.icao()), 'sim', false);
        again(); this.note('Weather updated: ' + (E.wx ? E.wx.raw.replace(/^(METAR|SPECI)\s+/, '') : '')); const m = document.querySelector('.st-metar'); if (m && E.wx) m.textContent = E.wx.raw.replace(/^(METAR|SPECI)\s+/, '');
      };
      $('#setWxm').onchange = e => { E.mode = e.target.value; applyWx(); };
      $('#setWxp').onchange = e => { E.preset = e.target.value; if (E.mode === 'sim') applyWx(); else E.save(); };
      $('#setTod').onchange = e => { E.tod = e.target.value; E.save(); again(); this.note('Time of day: ' + e.target.selectedOptions[0].textContent + '.'); };
    },

    pane_display() {
      return `<h3>Airport view</h3>
        ${this.row('Real map underneath', this.toggle('setMap', OSM.on), 'The airfield and its surroundings, drawn from OpenStreetMap.')}
        ${this.row('Graphics quality', this.sel('setGfx', [['high', 'High: full lighting and weather'], ['balanced', 'Balanced: lighter on high-resolution screens'], ['low', 'Low: for older or integrated graphics']], this.p.gfx || 'high'), 'Low draws at normal resolution and 30 frames a second, without the night lighting, glow and weather particles.')}
        <h3>Coach</h3>
        ${this.row('Coach', this.sel('setCoach', [['auto', 'Adaptive: fades as you learn each call'], ['full', 'Always show the full phrase'], ['off', 'Off']], UI.coachMode))}
        <h3>Score</h3>
        ${this.row('Show score and points', this.toggle('setScore', S.opt.score), 'Off: a pure shift, no numbers.')}`;
    },
    wire_display() {
      $('#setMap').onchange = e => { OSM.on = e.target.checked; OSM.save(); if (R.gs) R.gs.key = ''; if (window.syncView) syncView(); };
      $('#setGfx').onchange = e => { this.p.gfx = e.target.value; this.save(); if (R.resize) R.resize(); R.sceneFor = null; if (R.gs) R.gs.key = ''; this.note('Graphics: ' + e.target.selectedOptions[0].textContent + '.'); };
      $('#setCoach').onchange = e => { UI.coachMode = e.target.value; UI.renderCoach(true); this.saveGame(); };
      $('#setScore').onchange = e => { S.opt.score = e.target.checked; document.body.classList.toggle('quiet', !Mission.cur && !S.opt.score); this.saveGame(); };
    },

    pane_view() { return window.Views ? Views.pane(this) : ''; },
    wire_view() { if (window.Views) Views.wire(this); },

    pane_access() {
      return `<h3>Reading</h3>
        ${this.row('Text and controls size', this.sel('setUi', [['1', 'Normal'], ['1.15', 'Larger (115%)'], ['1.3', 'Largest (130%)']], String(this.p.ui || 1)), 'Scales the whole screen: strips, coach, log and data blocks.')}
        ${this.row('High contrast', this.toggle('setHc', !!this.p.hc), 'Brighter text and borders on darker panels.')}
        <h3>Colour</h3>
        ${this.row('Colour-blind safe colours', this.toggle('setCb', !!this.p.cb), 'Arrivals blue instead of green, losses of separation magenta instead of red, so they stay apart with red-green colour blindness.')}
        <h3>Motion</h3>
        ${this.row('Calmer screen', this.toggle('setCalm', !!this.p.calm), 'No radar sweep, no blinking targets or badges: alerts stay lit instead.')}
        <h3>Screen readers</h3>
        <p class="st-dim">Every transmission is announced as it is logged (the frequency log is a live region), and the coach's phrase is plain text. Typing calls in the text box works without a microphone.</p>`;
    },
    wire_access() {
      $('#setUi').onchange = e => { this.p.ui = +e.target.value; this.save(); this.applyAccess(); this.render(); };
      $('#setHc').onchange = e => { this.p.hc = e.target.checked; this.save(); this.applyAccess(); };
      $('#setCb').onchange = e => { this.p.cb = e.target.checked; this.save(); this.applyAccess(); };
      $('#setCalm').onchange = e => { this.p.calm = e.target.checked; this.save(); this.applyAccess(); };
    },

    pane_controls() {
      const K = (k, t) => `<tr><td><kbd>${k}</kbd></td><td>${t}</td></tr>`;
      return `<h3>Push to talk</h3>
        ${this.row('Talk key', `<button class="cbtn" id="setPtt">${this.keyName(this.p.ptt)}</button>`, 'Click, then press the key you want to hold while you talk. A key on a USB foot pedal or a mouse button mapped to a key works too.')}
        <h3>Keyboard shortcuts</h3>
        <table class="st-keys">${K(this.keyName(this.p.ptt), 'hold to talk')}${K('Tab', 'next aircraft waiting for you')}${K('H', 'show the full phrase')}${K('P', 'pause')}${K('+ / −', 'faster / slower')}${K('1 / 2 / 3', 'split view / airport / radar')}${K('4', 'airport: real look / ground radar')}${K('5', 'final approach monitor')}${K('6', '3D tower view')}${K('Esc', 'deselect')}${K('Ctrl + ,', 'settings')}</table>`;
    },
    wire_controls() {
      const b = $('#setPtt');
      b.onclick = () => {
        this.capturing = true; b.textContent = 'Press a key…';
        const h = e => { e.preventDefault(); e.stopPropagation(); window.removeEventListener('keydown', h, true); this.capturing = false; if (e.code !== 'Escape') { this.p.ptt = e.code; this.save(); } this.render(); this.note(e.code !== 'Escape' ? 'Talk key: ' + this.keyName(this.p.ptt) + '.' : ''); };
        window.addEventListener('keydown', h, true);
      };
    },
  };
  Settings.load();
  window.Settings = Settings;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => Settings.applyAccess()); else setTimeout(() => Settings.applyAccess(), 0);
})();
