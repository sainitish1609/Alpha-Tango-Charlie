'use strict';
/* ==========================================================================
   Radar tools: the range and bearing line (right-drag, or Alt-drag, on the radar; it sticks to aircraft),
   the conflict probe (pairs that will lose separation in the next two minutes, drawn ahead of time),
   wake turbulence categories and the spacing behind heavier aircraft on final, the view from the tower
   in fog (what the tower can't see shows only as a ground radar target), and clearances by datalink
   (PDC for the departure clearance, CPDLC for the frequency change to the en-route centre).
   ========================================================================== */
(() => {
  // ICAO wake categories: J (A380), H (heavy), M, L
  const wakeOf = ac => ac.type === 'A388' ? 'J' : ac.perf && ac.perf.heavy ? 'H' : ['DHC6'].includes(ac.type) ? 'L' : 'M';
  // the distance a follower must keep behind its leader on final (NM)
  const WAKE = { J: { J: 4, H: 6, M: 7, L: 8 }, H: { H: 4, M: 5, L: 6 }, M: { L: 5 } };
  const wakeNeed = (lead, foll) => ((WAKE[wakeOf(lead)] || {})[wakeOf(foll)]) || 3;

  const RT = {
    wakeOf, wakeNeed,
    rbl: null, drag: null, probe: [], t: 0,
    // ---------- the range and bearing line ----------
    init() {
      const cv = R.cv; if (!cv || this.inited) return; this.inited = true;
      const tf = () => R.tf('radar');
      const toGame = (sx, sy) => { const T = tf(); return { x: (sx - T.X(0)) / T.sc, y: (T.Y(0) - sy) / T.sc }; };
      const local = e => { const b = cv.getBoundingClientRect(); return { x: (e.clientX - b.left) * (R.w / b.width || 1), y: (e.clientY - b.top) * (R.h / b.height || 1) }; };
      const near = p => { let best = null, bd = 16; for (const h of R.hits || []) { const d = Math.hypot(h.x - p.x, h.y - p.y); if (d < bd) { bd = d; best = h.ac; } } return best; };
      const end = p => { const ac = near(p); return ac ? { ac } : toGame(p.x, p.y); };
      cv.addEventListener('contextmenu', e => { const p = local(e); if (R.viewAt(p.x, p.y) === 'radar') e.preventDefault(); });
      cv.addEventListener('mousedown', e => {
        const p = local(e);
        if (R.viewAt(p.x, p.y) !== 'radar' || !(e.button === 2 || e.altKey)) return;
        e.preventDefault(); e.stopImmediatePropagation();
        this.drag = { a: end(p), b: toGame(p.x, p.y) };
      }, true);
      window.addEventListener('mousemove', e => { if (!this.drag) return; const p = local(e); this.drag.b = end(p); this.rbl = { a: this.drag.a, b: this.drag.b }; }, true);
      window.addEventListener('mouseup', e => {
        if (!this.drag) return; e.stopImmediatePropagation();
        const d = this.drag; this.drag = null;
        const a = this.pt(d.a), b = this.pt(d.b);
        this.rbl = a && b && dist(a.x, a.y, b.x, b.y) > 0.3 ? { a: d.a, b: d.b } : null; // a click without a drag clears it
      }, true);
      window.addEventListener('keydown', e => { if (e.key === 'Escape') this.rbl = null; });
    },
    pt(e) { if (!e) return null; if (e.ac) return S.aircraft.includes(e.ac) ? e.ac : null; return e; },

    // ---------- every second: the probe, wake spacing ----------
    step(dt) {
      this.t += dt; if (this.t < 1) return; this.t = 0;
      const air = S.aircraft.filter(a => !onGround(a) && a.alt > 300);
      // linear projection, altitude moving toward its target
      const at = (a, t) => { const r = a.hdg * Math.PI / 180, d = a.spd / 3600 * t; const vs = (a.vs || 0) * t; const alt = a.vs > 0 ? Math.min(a.alt + vs, Math.max(a.tgtAlt, a.alt)) : Math.max(a.alt + vs, Math.min(a.tgtAlt, a.alt)); return { x: a.x + Math.sin(r) * d, y: a.y + Math.cos(r) * d, alt }; };
      const out = [];
      for (let i = 0; i < air.length; i++) for (let j = i + 1; j < air.length; j++) {
        const a = air[i], b = air[j];
        if (a.ca || b.ca || a.los || b.los) continue;
        if (a.loc && b.loc) continue; // the same final: that's wake spacing, below
        for (let t = 15; t <= 120; t += 15) {
          const p = at(a, t), q = at(b, t);
          if (dist(p.x, p.y, q.x, q.y) < 3 && Math.abs(p.alt - q.alt) < 900) { out.push({ a, b, t, p, q }); break; }
        }
      }
      this.probe = out;
      // behind a heavier aircraft on final
      const fin = S.aircraft.filter(a => a.kind === 'arr' && !onGround(a) && a.loc).map(a => ({ a, d: locGeom(a.x, a.y).d })).sort((p, q) => p.d - q.d);
      for (const f of fin) f.a.wake = null;
      for (let k = 1; k < fin.length; k++) {
        const lead = fin[k - 1], foll = fin[k], need = wakeNeed(lead.a, foll.a), gap = foll.d - lead.d;
        if (gap < need - 0.2 && need > 3) {
          foll.a.wake = { lead: lead.a, gap, need };
          if (!foll.a.flags.wakeTip) {
            foll.a.flags.wakeTip = true; S.stats.wake = (S.stats.wake || 0) + 1;
            if (S.staffed.APP || S.staffed.TWR) UI.log('SYS', `Wake turbulence: ${foll.a.cs} (${wakeOf(foll.a)}) is ${gap.toFixed(1)} NM behind ${lead.a.cs} (${wakeOf(lead.a)}); it needs ${need} NM. Slow it down, or take it off the approach.`, 'tip');
          }
        }
      }
    },

    drawRadar(c, X, Y, sc) {
      c.save(); c.font = '600 10.5px Inconsolata, monospace';
      // the probe: where they'd meet, and when
      for (const k of (window.Lay && !Lay('rProbe') ? [] : this.probe)) {
        c.strokeStyle = 'rgba(255,176,32,0.75)'; c.setLineDash([4, 4]); c.lineWidth = 1;
        c.beginPath(); c.moveTo(X(k.a.x), Y(k.a.y)); c.lineTo(X(k.p.x), Y(k.p.y)); c.moveTo(X(k.b.x), Y(k.b.y)); c.lineTo(X(k.q.x), Y(k.q.y)); c.stroke(); c.setLineDash([]);
        const mx = (X(k.p.x) + X(k.q.x)) / 2, my = (Y(k.p.y) + Y(k.q.y)) / 2;
        c.beginPath(); c.arc(mx, my, 1.5 * sc, 0, 7); c.stroke();
        c.fillStyle = '#FFB020'; c.fillText(`${Math.floor(k.t / 60)}:${String(k.t % 60).padStart(2, '0')}`, mx + 1.5 * sc + 4, my + 4);
      }
      // the range and bearing line
      const r = this.rbl, a = r && this.pt(r.a), b = r && this.pt(r.b);
      if (a && b) {
        const x1 = X(a.x), y1 = Y(a.y), x2 = X(b.x), y2 = Y(b.y), d = dist(a.x, a.y, b.x, b.y), h = magOf(brg(a.x, a.y, b.x, b.y));
        c.strokeStyle = '#7FE0FF'; c.lineWidth = 1.2; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
        let lbl = `${pad3(h)}° ${d.toFixed(1)} NM`;
        const mover = r.a.ac || r.b.ac; if (mover && mover.spd > 30) { const m = d / mover.spd * 60; lbl += ` ${Math.floor(m)}:${String(Math.round(m % 1 * 60)).padStart(2, '0')}`; }
        const w = c.measureText(lbl).width + 8, lx = (x1 + x2) / 2 + 6, ly = (y1 + y2) / 2 - 8;
        c.fillStyle = 'rgba(8,14,20,0.85)'; c.fillRect(lx - 4, ly - 11, w, 15);
        c.fillStyle = '#7FE0FF'; c.fillText(lbl, lx, ly);
      }
      c.restore();
    },

    // ---------- the tower's view in fog ----------
    // aircraft further from the tower than the visibility show only as a ground radar target
    towerHides(ac) {
      const w = window.Env && Env.wx; if (!w || w.vis >= 3000 || !onGround(ac)) return false;
      const t = this.tower(); return dist(ac.x, ac.y, t.x, t.y) * 1852 > w.vis * 1.1;
    },
    tower() {
      if (this._tw && this._tw.k === LAYOUT.icao) return this._tw;
      const g = GATES.length ? GATES.reduce((s, g) => ({ x: s.x + NODES[g.node].x, y: s.y + NODES[g.node].y }), { x: 0, y: 0 }) : { x: 0, y: 0 };
      const n = Math.max(1, GATES.length);
      return (this._tw = { k: LAYOUT.icao, x: g.x / n * 0.7, y: g.y / n * 0.7 }); // between the terminals and the runways
    },
    asde(c, ac, x, y) {
      c.save(); c.strokeStyle = 'rgba(120,220,255,0.9)'; c.lineWidth = 1.4; c.strokeRect(x - 5, y - 5, 10, 10);
      c.fillStyle = 'rgba(120,220,255,0.9)'; c.font = '600 10px Inconsolata, monospace'; c.fillText(ac.cs, x + 8, y - 6); c.restore();
    },

    // ---------- datalink ----------
    canDatalink(sug) { return sug && !sug.none && (sug.type === 'clearance' || sug.type === 'handoff_ctr'); },
    send(ac, sug) {
      const kind = sug.type === 'clearance' ? 'PDC' : 'CPDLC';
      S.dl = kind; S.stats.dl = (S.stats.dl || 0) + 1;
      try { processTransmission(sug.text, { datalink: kind }); } finally { S.dl = null; }
    },
  };
  window.RTools = RT;
})();
