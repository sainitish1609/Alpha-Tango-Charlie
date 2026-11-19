'use strict';
/* ==========================================================================
   Views: what each scope shows, and other ways to look at the airport.
   - Layers you can switch on and off: on the radar (map, range rings and compass, fixes, procedure
     waypoints, terrain, the final approach course, trails, heading lines, data blocks, conflict probe,
     weather) and in the airport view (map, vehicles and ground crews, stop bars, the selected route,
     aircraft labels, weather, the wind box)
   - The airport view in two styles: the real look, or a ground radar (ASDE-X style) display, flat and
     dark like the tower's surface movement radar
   - Presets that set the window up in one go: Tower, Ground radar, Approach, Final monitor
   ========================================================================== */
(() => {
  const DEF = {
    rMap: true, rRings: true, rFixes: true, rProc: true, rTerrain: true, rFinal: true, rTrails: true, rLeaders: true, rBlocks: 'full', rProbe: true, rWx: true,
    g3d: false, gMap: true, gVehicles: true, gBars: true, gRoute: true, gTags: 'auto', gWx: true, gWind: true, gStyle: 'real',
  };
  const Views = {
    p: { ...DEF },
    load() { try { const s = JSON.parse(localStorage.getItem('vector_view') || 'null'); if (s) this.p = { ...DEF, ...s }; } catch (e) { } },
    save() { try { localStorage.setItem('vector_view', JSON.stringify(this.p)); } catch (e) { } },
    on(k) { return this.p[k] !== false && this.p[k] !== 'off'; },
    set(k, v) { this.p[k] = v; this.save(); if (typeof R !== 'undefined') { R.sceneFor = null; if (R.gs) R.gs.key = ''; } },
    asde() { return this.p.gStyle === 'asde'; },

    // ---------- presets ----------
    preset(name) {
      if (typeof R === 'undefined') return;
      this.p.g3d = name === 'tower3d';
      if (name === 'tower3d') { R.mode = 'ground'; if (window.T3) T3.follow = true; }
      if (name === 'tower') { R.mode = 'ground'; this.p.gStyle = 'real'; R.views.ground = { zoom: 1, px: 0, py: 0 }; }
      if (name === 'asde') { R.mode = 'ground'; this.p.gStyle = 'asde'; }
      if (name === 'approach') { R.mode = 'radar'; R.views.radar = { zoom: 1, px: 0, py: 0 }; }
      if (name === 'split') { R.mode = 'split'; }
      if (name === 'final') { // the final approach course filling the radar, threshold to 22 NM out
        R.mode = 'radar'; if (window.syncView) syncView();
        if (R.layout) R.layout(); // the radar's rectangle for this mode
        const rc = R.rects.radar; if (!rc) return;
        const zoom = 2.3, sc = Math.min(rc.w, rc.h) / 62 * zoom, cx = S.flow === 'W' ? 7 : -7, f = finalPoint(11, 0);
        R.views.radar = { zoom, px: -(f.x - cx) * sc, py: f.y * sc };
      }
      this.save(); if (window.syncView) syncView(); R.sceneFor = null; if (R.gs) R.gs.key = '';
    },

    // ---------- the ground radar (surface movement) display ----------
    drawAsde(c, X, Y, M, r) {
      c.fillStyle = '#0B1014'; c.fillRect(r.x, r.y, r.w, r.h);
      c.lineCap = 'round';
      // taxiways and aprons as grey bands at their real width; runways darker, outlined
      for (const e of EDGES) {
        const a = NODES[e.a], b = NODES[e.b]; if (!a || !b) continue;
        c.strokeStyle = e.rwy ? '#1E262E' : '#2B343D'; c.lineWidth = Math.max(1.5, (e.w || (e.rwy ? 45 : 23)) * M);
        c.beginPath(); c.moveTo(X(a.x), Y(a.y)); c.lineTo(X(b.x), Y(b.y)); c.stroke();
      }
      for (const k in RWY) {
        const rw = RWY[k], hw = 22 * M;
        c.strokeStyle = rw.closed ? '#3A2A2A' : '#5E6C7A'; c.lineWidth = 1;
        c.strokeRect(X(rw.x1), Y(rw.y) - hw, X(rw.x2) - X(rw.x1), hw * 2);
        c.fillStyle = '#8A98A6'; c.font = '600 11px Inconsolata, monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(rw.names.E, X(rw.x1) - 16, Y(rw.y)); c.fillText(rw.names.W, X(rw.x2) + 16, Y(rw.y));
      }
      // taxiway names at the middle of each named stretch
      if (M > 0.25) {
        c.fillStyle = '#6D7C8A'; c.font = '10px Inconsolata, monospace';
        const done = new Set();
        for (const e of EDGES) { if (!e.name || e.rwy || e.name === 'ramp' || done.has(e.name) || e.len < 0.05) continue; done.add(e.name); const a = NODES[e.a], b = NODES[e.b]; c.fillText(e.name, (X(a.x) + X(b.x)) / 2, (Y(a.y) + Y(b.y)) / 2); }
      }
      // stands as small ticks
      c.fillStyle = '#3A4652'; for (const g of GATES) { const n = NODES[g.node]; c.fillRect(X(n.x) - 1.5, Y(n.y) - 1.5, 3, 3); }
      c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    },
    asdeTarget(c, ac, x, y, col, M) {
      const [L, Wsp] = dimsOf(ac.type), h = ac.hdg * Math.PI / 180, k = Math.max(M, 9 / L);
      c.save(); c.translate(x, y); c.rotate(h);
      c.fillStyle = col; c.globalAlpha = 0.9;
      c.fillRect(-1.6 * k * 2, -L * k / 2, 3.2 * k * 2, L * k); c.fillRect(-Wsp * k / 2, -L * k * 0.08, Wsp * k, 2.4 * k * 2);
      c.restore(); c.globalAlpha = 1;
    },

    // ---------- the settings tab ----------
    pane(S2) {
      const t = (id, k, label, help) => S2.row(label, S2.toggle(id, this.on(k)), help);
      return `<h3>Views</h3>
        <div class="st-presets">${[['tower', 'Tower', 'The airport as it looks'], ['tower3d', '3D tower', 'Out of the cab windows, in 3D'], ['asde', 'Ground radar', 'Surface movement radar, flat and dark'], ['approach', 'Approach radar', 'The whole terminal area'], ['final', 'Final monitor', 'The final approach, zoomed in'], ['split', 'Split', 'Airport and radar side by side']].map(([k, n, d]) => `<button class="cbtn st-pre" data-pre="${k}" title="${d}"><b>${n}</b><span>${d}</span></button>`).join('')}</div>
        <h3>Airport view</h3>
        ${S2.row('Style', S2.sel('vGStyle', [['real', 'Real look'], ['asde', 'Ground radar (ASDE)']], this.p.gStyle))}
        ${t('vGMap', 'gMap', 'Map underneath', 'The real surroundings from OpenStreetMap.')}
        ${t('vGVeh', 'gVehicles', 'Vehicles and ground crews')}
        ${t('vGBars', 'gBars', 'Stop bars')}
        ${t('vGRoute', 'gRoute', 'Selected aircraft’s route')}
        ${S2.row('Aircraft labels', S2.sel('vGTags', [['auto', 'The ones that matter (and all close up)'], ['all', 'All aircraft'], ['off', 'None']], this.p.gTags))}
        ${t('vGWx', 'gWx', 'Rain, snow and fog')}
        ${t('vGWind', 'gWind', 'Wind and weather box')}
        <h3>Radar</h3>
        ${t('vRMap', 'rMap', 'Map underneath')}
        ${t('vRRings', 'rRings', 'Range rings and compass')}
        ${t('vRFixes', 'rFixes', 'Fixes')}
        ${t('vRProc', 'rProc', 'Procedure waypoints (SID turns, missed approach)')}
        ${t('vRTerr', 'rTerrain', 'Terrain heights')}
        ${t('vRFinal', 'rFinal', 'Final approach course')}
        ${t('vRTrails', 'rTrails', 'Position history trails')}
        ${t('vRLead', 'rLeaders', 'Heading lines (one minute ahead)')}
        ${S2.row('Data blocks', S2.sel('vRBlocks', [['full', 'Full (callsign, altitude, speed, more)'], ['compact', 'Compact (callsign and altitude)'], ['off', 'Off']], this.p.rBlocks))}
        ${t('vRProbe', 'rProbe', 'Conflict probe')}
        ${t('vRWx', 'rWx', 'Weather (storm cells)')}`;
    },
    wire(S2) {
      const q = s => document.querySelector(s);
      document.querySelectorAll('.st-pre').forEach(b => b.onclick = () => { this.preset(b.dataset.pre); S2.note('View: ' + b.querySelector('b').textContent + '.'); S2.render(); });
      const tog = (id, k) => { const el = q('#' + id); if (el) el.onchange = e => this.set(k, e.target.checked); };
      [['vGMap', 'gMap'], ['vGVeh', 'gVehicles'], ['vGBars', 'gBars'], ['vGRoute', 'gRoute'], ['vGWx', 'gWx'], ['vGWind', 'gWind'], ['vRMap', 'rMap'], ['vRRings', 'rRings'], ['vRFixes', 'rFixes'], ['vRProc', 'rProc'], ['vRTerr', 'rTerrain'], ['vRFinal', 'rFinal'], ['vRTrails', 'rTrails'], ['vRLead', 'rLeaders'], ['vRProbe', 'rProbe'], ['vRWx', 'rWx']].forEach(([i, k]) => tog(i, k));
      q('#vGStyle').onchange = e => this.set('gStyle', e.target.value);
      q('#vGTags').onchange = e => this.set('gTags', e.target.value);
      q('#vRBlocks').onchange = e => this.set('rBlocks', e.target.value);
    },
  };
  Views.load();
  window.Views = Views;
  window.Lay = k => Views.on(k);
})();
