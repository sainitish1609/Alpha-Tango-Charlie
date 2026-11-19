'use strict';
/* ==========================================================================
   The 3D tower view: the airport as seen from the tower cab, built from the same OpenStreetMap data
   as the airport view (runways, taxiways, aprons, buildings with their heights), every aircraft at its
   real size, position, heading and height, in the light and weather of the moment (sky, sun or night,
   fog at the real visibility, lights on at night). Drag to look around, the wheel zooms like binoculars;
   with an aircraft selected the view follows it. Uses three.js (public/vendor, MIT licence).
   ========================================================================== */
(() => {
  const NM = 1852, FT = 0.3048;
  const T3 = {
    on: false, built: '', yaw: 0, pitch: -0.06, fov: 45, follow: true,
    init() {
      if (this.cv || !window.THREE || typeof R === 'undefined' || !R.cv) return !!this.cv;
      const host = R.cv.parentElement;
      this.cv = document.createElement('canvas'); this.cv.id = 't3d';
      this.lb = document.createElement('canvas'); this.lb.id = 't3dl';
      for (const c of [this.cv, this.lb]) { c.style.cssText = 'position:absolute;display:none;'; host.appendChild(c); }
      this.lb.style.pointerEvents = 'none';
      try { this.gl = new THREE.WebGLRenderer({ canvas: this.cv, antialias: true }); } catch (e) { this.gl = null; this.cv.remove(); this.lb.remove(); this.cv = null; return false; }
      this.scene = new THREE.Scene(); this.cam = new THREE.PerspectiveCamera(this.fov, 1, 2, 60000);
      this.hemi = new THREE.HemisphereLight(0xdfeeff, 0x445533, 0.9); this.sun = new THREE.DirectionalLight(0xffffff, 0.8); this.sun.position.set(-3000, 6000, 2000);
      this.scene.add(this.hemi, this.sun);
      this.planes = new Map();
      // look around: drag; zoom: wheel
      let drag = null;
      this.cv.addEventListener('mousedown', e => { drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch }; this.follow = false; });
      window.addEventListener('mousemove', e => { if (!drag) return; const k = this.fov / 45 * 0.004; this.yaw = drag.yaw - (e.clientX - drag.x) * k; this.pitch = Math.max(-0.7, Math.min(0.5, drag.pitch - (e.clientY - drag.y) * k)); });
      window.addEventListener('mouseup', () => { drag = null; });
      this.cv.addEventListener('wheel', e => { e.preventDefault(); this.fov = Math.max(6, Math.min(70, this.fov * (e.deltaY > 0 ? 1.12 : 0.89))); }, { passive: false });
      this.cv.addEventListener('dblclick', () => { this.follow = true; });
      return true;
    },
    // the airport, once per airport
    build() {
      const d = LAYOUT.data, sc = this.scene;
      if (this.ground) sc.remove(this.ground);
      const G = this.ground = new THREE.Group(); sc.add(G);
      const P = (x, y, h) => new THREE.Vector3(x * NM, h || 0, -y * NM);
      const b = d.bounds, w = (b[2] - b[0] + 8) * NM, hh = (b[3] - b[1] + 8) * NM;
      const grass = new THREE.Mesh(new THREE.PlaneGeometry(w * 6, hh * 6), new THREE.MeshLambertMaterial({ color: 0x5f7a45 }));
      grass.rotation.x = -Math.PI / 2; grass.position.set((b[0] + b[2]) / 2 * NM, -0.3, -(b[1] + b[3]) / 2 * NM); G.add(grass); this.grass = grass;
      const poly = (pts, mat, y) => { if (!pts || pts.length < 6) return; const s = new THREE.Shape(); s.moveTo(pts[0] * NM, pts[1] * NM); for (let i = 2; i < pts.length; i += 2) s.lineTo(pts[i] * NM, pts[i + 1] * NM); const m = new THREE.Mesh(new THREE.ShapeGeometry(s), mat); m.rotation.x = -Math.PI / 2; m.position.y = y; G.add(m); };
      const apron = new THREE.MeshLambertMaterial({ color: 0x8d9196 }), water = new THREE.MeshLambertMaterial({ color: 0x3b5d78 });
      (d.aprons || []).forEach(a => poly(a.p || a, apron, 0.05));
      (d.water || []).forEach(a => poly(a.p || a, water, -0.2));
      // taxiways: flat strips along each edge
      const twy = new THREE.MeshLambertMaterial({ color: 0x77797c }), rwyM = new THREE.MeshLambertMaterial({ color: 0x3f4246 }), white = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 }), yel = new THREE.MeshBasicMaterial({ color: 0xd8b400 });
      const strip = (a, c, wd, mat, y) => { const L = a.distanceTo(c); if (L < 0.5) return; const m = new THREE.Mesh(new THREE.PlaneGeometry(wd, L), mat); m.rotation.x = -Math.PI / 2; m.rotation.z = Math.atan2(c.x - a.x, -(c.z - a.z)) * -1; m.position.set((a.x + c.x) / 2, y, (a.z + c.z) / 2); G.add(m); };
      for (const e of EDGES) { if (e.rwy) continue; const a = NODES[e.a], c = NODES[e.b]; strip(P(a.x, a.y), P(c.x, c.y), Math.max(15, e.w || 23), twy, 0.1); strip(P(a.x, a.y), P(c.x, c.y), 0.4, yel, 0.15); }
      for (const k in RWY) {
        const r = RWY[k], wd = (d.runways[k] && d.runways[k].width) || 45;
        strip(P(r.x1, r.y), P(r.x2, r.y), wd, rwyM, 0.2);
        for (let x = r.x1 + 0.06; x < r.x2 - 0.06; x += 0.035) strip(P(x, r.y), P(x + 0.016, r.y), 0.9, white, 0.25); // centre line
        for (const xe of [r.x1, r.x2]) for (let k2 = -3; k2 <= 3; k2++) { if (!k2) continue; const yy = r.y + k2 * wd / 8 / NM, xs = xe + (xe === r.x1 ? 0.01 : -0.04); strip(P(xs, yy), P(xs + 0.03, yy), 1.8, white, 0.25); } // thresholds
      }
      // buildings at their heights
      const bm = { t: new THREE.MeshLambertMaterial({ color: 0xb8bec6 }), h: new THREE.MeshLambertMaterial({ color: 0x9aa3ad }), b: new THREE.MeshLambertMaterial({ color: 0xa69f94 }) };
      for (const bl of d.buildings || []) {
        const p = bl.p; if (!p || p.length < 6) continue;
        const s = new THREE.Shape(); s.moveTo(p[0] * NM, p[1] * NM); for (let i = 2; i < p.length; i += 2) s.lineTo(p[i] * NM, p[i + 1] * NM);
        const m = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: bl.h || 9, bevelEnabled: false }), bm[bl.k] || bm.b);
        m.rotation.x = -Math.PI / 2; G.add(m);
      }
      // the tower itself, where we stand
      const t = RTools.tower();
      const tw = new THREE.Mesh(new THREE.CylinderGeometry(4, 6, 50, 12), bm.t); tw.position.set(t.x * NM, 25, -t.y * NM); G.add(tw);
      // runway edge lights for the night
      const lights = []; for (const k in RWY) { const r = RWY[k], wd = ((d.runways[k] && d.runways[k].width) || 45) / 2 / NM; for (let x = r.x1; x <= r.x2; x += 0.033) for (const s of [-1, 1]) lights.push(x * NM, 0.6, -(r.y + s * wd) * NM); }
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lights, 3));
      this.edgeLights = new THREE.Points(lg, new THREE.PointsMaterial({ color: 0xfff1c8, size: 3, sizeAttenuation: false })); G.add(this.edgeLights);
      for (const m of this.planes.values()) sc.remove(m.g); this.planes.clear();
      this.built = LAYOUT.icao;
    },
    // one aircraft: fuselage, wings, tailplane and fin at its real size, in its airline's main colour
    plane(ac) {
      const [L, Sp, Wd] = dimsOf(ac.type), g = new THREE.Group();
      const lv = typeof livery === 'function' ? livery(ac) : {}, body = new THREE.MeshLambertMaterial({ color: new THREE.Color(lv.body || '#f4f6f8') }), tail = new THREE.MeshLambertMaterial({ color: new THREE.Color(lv.tail || '#1d3f7a') });
      const fus = new THREE.Mesh(new THREE.CylinderGeometry(Wd / 2, Wd / 2.4, L, 10), body); fus.rotation.x = Math.PI / 2; g.add(fus);
      const wing = new THREE.Mesh(new THREE.BoxGeometry(Sp, Wd * 0.12, L * 0.13), body); wing.position.set(0, -Wd * 0.2, -L * 0.02); g.add(wing);
      const stab = new THREE.Mesh(new THREE.BoxGeometry(Sp * 0.33, Wd * 0.08, L * 0.08), body); stab.position.set(0, Wd * 0.1, L * 0.43); g.add(stab);
      const fin = new THREE.Mesh(new THREE.BoxGeometry(Wd * 0.08, Wd * 1.6, L * 0.12), tail); fin.position.set(0, Wd * 0.9, L * 0.42); g.add(fin);
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.6, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff2a1a })); beacon.position.set(0, Wd / 2 + 0.4, 0); g.add(beacon);
      return { g, beacon };
    },
    show(on) {
      if (on && !this.init()) { UI.log('SYS', 'The 3D tower view needs WebGL, which this computer or browser does not offer.', 'tip'); on = false; }
      this.on = on; if (this.cv) { this.cv.style.display = on ? '' : 'none'; this.lb.style.display = on ? '' : 'none'; }
    },
    frame() {
      const want = !!(window.Views && Views.p.g3d) && (R.mode === 'ground' || R.mode === 'split') && S.running !== undefined;
      if (want !== this.on) this.show(want);
      if (!this.on) return;
      const rc = R.rects.ground; if (!rc) return;
      const dpr = Math.min(window.devicePixelRatio || 1, window.Settings && Settings.p.gfx === 'low' ? 1 : 2);
      for (const c of [this.cv, this.lb]) { c.style.left = rc.x + 'px'; c.style.top = rc.y + 'px'; c.style.width = rc.w + 'px'; c.style.height = rc.h + 'px'; }
      if (this.cv.width !== Math.round(rc.w * dpr) || this.cv.height !== Math.round(rc.h * dpr)) { this.gl.setPixelRatio(dpr); this.gl.setSize(rc.w, rc.h, false); this.lb.width = rc.w * dpr; this.lb.height = rc.h * dpr; }
      if (this.built !== LAYOUT.icao) this.build();
      // light, sky and fog from the weather
      const L = window.Env ? Env.light() : { amb: [1, 1, 1], lights: 0, phase: 'day' }, amb = L.amb || [1, 1, 1], night = L.lights || 0;
      const sky = new THREE.Color().setRGB(0.55 * amb[0] + 0.03, 0.72 * amb[1] + 0.04, 0.92 * amb[2] + 0.08);
      const wx = window.Env && Env.wx, vis = wx && wx.vis ? Math.min(wx.vis, 9999) : 9999, cloudy = wx && wx.clouds && wx.clouds.some(c => /BKN|OVC/.test(c.cover || c)) ? 0.75 : 1;
      sky.multiplyScalar(cloudy); this.gl.setClearColor(sky);
      this.scene.fog = new THREE.Fog(sky, Math.min(vis * 0.25, 1500), Math.max(vis * 1.2, 1500));
      this.hemi.intensity = 0.25 + 0.75 * (1 - night); this.sun.intensity = (0.15 + 0.75 * (1 - night)) * cloudy;
      this.grass.material.color.setRGB(0.37 * amb[0], 0.48 * amb[1], 0.27 * amb[2]);
      if (wx && wx.snow > 0.2) this.grass.material.color.setRGB(0.85 * amb[0], 0.88 * amb[1], 0.92 * amb[2]);
      this.edgeLights.visible = night > 0.25 || vis < 3000;
      // aircraft
      const seen = new Set(), now = performance.now();
      for (const ac of S.aircraft) {
        if (!onGround(ac) && (ac.alt > 6000 || dist(ac.x, ac.y, 0, 0) > 15)) continue;
        let m = this.planes.get(ac.id); if (!m) { m = this.plane(ac); this.scene.add(m.g); this.planes.set(ac.id, m); }
        seen.add(ac.id);
        m.g.position.set(ac.x * NM, (onGround(ac) ? 2.2 : ac.alt * FT + 2.2), -ac.y * NM);
        m.g.rotation.set(0, -ac.hdg * Math.PI / 180 + Math.PI, 0);
        if (!onGround(ac)) m.g.rotation.x = Math.max(-0.2, Math.min(0.2, (ac.vs || 0) / 3000)) * -1;
        m.beacon.visible = Math.floor(now / 600 + ac.id) % 2 === 0 && ac.phase !== 'gate' && ac.phase !== 'parked';
      }
      for (const [id, m] of this.planes) if (!seen.has(id)) { this.scene.remove(m.g); this.planes.delete(id); }
      // camera in the cab, 50 m up, looking where it's told (or after the selected aircraft)
      const t = RTools.tower(), cx = t.x * NM, cz = -t.y * NM;
      if (this.follow && S.sel && S.aircraft.includes(S.sel)) {
        const a = S.sel, dx = a.x * NM - cx, dz = -a.y * NM - cz, dy = (onGround(a) ? 3 : a.alt * FT) - 52;
        this.yaw = Math.atan2(dx, -dz); this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      } else if (this.follow) { const dx = 0 - cx, dz = 0 - cz; this.yaw = Math.atan2(dx, -dz); this.pitch = -0.05; }
      this.cam.fov = this.fov; this.cam.aspect = rc.w / rc.h; this.cam.updateProjectionMatrix();
      this.cam.position.set(cx, 52, cz);
      this.cam.lookAt(cx + Math.sin(this.yaw) * Math.cos(this.pitch) * 1000, 52 + Math.sin(this.pitch) * 1000, cz - Math.cos(this.yaw) * Math.cos(this.pitch) * 1000);
      this.gl.render(this.scene, this.cam);
      // callsigns over the aircraft
      const c = this.lb.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, rc.w, rc.h);
      c.font = '600 11px Inconsolata, monospace'; c.textBaseline = 'bottom';
      R.hits3d = [];
      for (const ac of S.aircraft) {
        const m = this.planes.get(ac.id); if (!m) continue;
        const v = m.g.position.clone().project(this.cam); if (v.z > 1) continue;
        const x = (v.x + 1) / 2 * rc.w, y = (1 - v.y) / 2 * rc.h; if (x < -40 || x > rc.w + 40 || y < -20 || y > rc.h + 20) continue;
        const col = R.acColor(ac); c.fillStyle = 'rgba(8,12,18,.6)'; const tw = c.measureText(ac.cs).width; c.fillRect(x + 6, y - 22, tw + 6, 14);
        c.fillStyle = col; c.fillText(ac.cs, x + 9, y - 9);
        R.hits3d.push({ x: x + rc.x, y: y + rc.y, ac });
      }
      c.fillStyle = 'rgba(10,15,22,.78)'; c.fillRect(10, rc.h - 30, 330, 20); c.fillStyle = '#C3CCD8';
      c.fillText(`3D TOWER · ${this.follow && S.sel ? 'following ' + S.sel.cs : 'drag to look, wheel to zoom'} · ${Math.round(45 / this.fov * 10) / 10}×`, 16, rc.h - 15);
    },
  };
  window.T3 = T3;
})();
