// Turns raw OpenStreetMap airport data (data/osm/ICAO.json, fetched with Overpass) into the
// game's airport files (public/airports/ICAO.json).
//
// The game frame: origin at the runway centre (between the two parallels at a twin-runway field),
// turned so the main runways run along x, y up, units nautical miles. Everything here is real
// geometry from OSM: runways, taxiways with their names, holding points, stands, terminals.
//
//   node tools/build-airports.mjs            (all airports)
//   node tools/build-airports.mjs EGLL       (one)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NM = 1852, RE = 6378137;
const CFG = {
  EGLL: { N: '09L/27R', S: '09R/27L' },
  CYVR: { N: '08L/26R', S: '08R/26L' },
  TNCM: { N: '10/28' },
  LOWS: { N: '15/33' },
  LPMA: { N: '05/23' },
  EGJJ: { N: '08/26' },
  LOWI: { N: '08/26' },
  LSZA: { N: '01/19' },
  LFLB: { N: '18/36' },
};

const r5 = v => Math.round(v * 1e5) / 1e5;
const D2R = Math.PI / 180;

function build(icao) {
  const cfg = CFG[icao];
  const raw = JSON.parse(readFileSync(join(ROOT, 'data', 'osm', icao + '.json'), 'utf8')).elements;
  const T = e => e.tags || {};
  const ways = raw.filter(e => e.type === 'way' && e.geometry);
  const rwyWays = ref => ways.filter(w => T(w).aeroway === 'runway' && T(w).ref === ref);

  // ---- frame: runway bearing and origin ----
  const lonlatEnds = ref => { // the two far ends of a runway (it may be split into several ways)
    const pts = rwyWays(ref).flatMap(w => w.geometry);
    if (!pts.length) throw new Error(`${icao}: no runway ${ref}`);
    let best = [pts[0], pts[0]], bd = -1;
    for (const a of pts) for (const b of pts) { const d = (a.lat - b.lat) ** 2 + ((a.lon - b.lon) * Math.cos(a.lat * D2R)) ** 2; if (d > bd) { bd = d; best = [a, b]; } }
    return best;
  };
  const nEnds = lonlatEnds(cfg.N);
  const mid = e => ({ lat: (e[0].lat + e[1].lat) / 2, lon: (e[0].lon + e[1].lon) / 2 });
  let o = mid(nEnds);
  if (cfg.S) { const s = mid(lonlatEnds(cfg.S)); o = { lat: (o.lat + s.lat) / 2, lon: (o.lon + s.lon) / 2 }; }
  const cos0 = Math.cos(o.lat * D2R), my = lat => Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2));
  const merc = p => [RE * (p.lon - o.lon) * D2R * cos0, RE * (my(p.lat) - my(o.lat)) * cos0];
  // bearing of the main runway, pointing east-ish
  const [ea, eb] = nEnds.map(merc);
  let brg = Math.atan2(eb[0] - ea[0], eb[1] - ea[1]) / D2R; brg = ((brg % 360) + 360) % 360; if (brg > 180) brg -= 180; // 0..180: the "east" direction
  const phi = (brg - 90) * D2R, cphi = Math.cos(phi), sphi = Math.sin(phi);
  const P = p => { const [x, y] = merc(p); return [(x * cphi - y * sphi) / NM, (x * sphi + y * cphi) / NM]; };

  // ---- runways ----
  const runways = {};
  for (const id of ['N', 'S']) {
    const ref = cfg[id]; if (!ref) continue;
    const [a, b] = lonlatEnds(ref).map(P), w = parseFloat(T(rwyWays(ref)[0]).width) || 45;
    const [lo, hi] = a[0] < b[0] ? [a, b] : [b, a];
    // which designator is flown toward the west in the game frame (heading 270)?
    const parts = ref.split('/'), wHdg = (brg + 180) % 360;
    const num = s => parseInt(s, 10) * 10, dh = (h, g) => Math.abs(((h - g + 540) % 360) - 180);
    const W = parts.reduce((m, p) => dh(num(p), wHdg) < dh(num(m), wHdg) ? p : m, parts[0]);
    const E = parts.find(p => p !== W);
    runways[id] = { ref, names: { W, E }, x1: r5(lo[0]), x2: r5(hi[0]), y: r5((lo[1] + hi[1]) / 2), width: w };
  }
  const otherRwys = ways.filter(w => T(w).aeroway === 'runway' && !Object.values(cfg).includes(T(w).ref))
    .map(w => ({ ref: T(w).ref || '', width: parseFloat(T(w).width) || 45, pts: w.geometry.map(P).flat().map(r5) }));

  // ---- taxi graph from shared OSM nodes ----
  const twName = t => {
    let r = (t.ref || '').trim();
    r = r.replace(/^taxiway\s+/i, '').replace(/^link\s+/i, 'L').replace(/\s+/g, '').toUpperCase();
    return /^[A-Z]{1,2}\d{0,2}[A-Z]?$/.test(r) ? r : '';
  };
  const gNodes = new Map(); // osm id -> {id, x, y, adj:Set}
  const gEdges = [];        // {a, b, name, rwy}
  const addN = (nid, p) => { if (!gNodes.has(nid)) { const [x, y] = P(p); gNodes.set(nid, { id: nid, x, y, adj: new Set(), kind: 't' }); } return gNodes.get(nid); };
  const isTaxi = w => ['taxiway', 'taxilane'].includes(T(w).aeroway) || (T(w).aeroway === 'runway' && !Object.values(cfg).includes(T(w).ref));
  const rwyIdOf = w => T(w).aeroway === 'runway' ? Object.keys(cfg).find(k => cfg[k] === T(w).ref) : null;
  for (const w of ways) {
    const rid = rwyIdOf(w);
    if (!isTaxi(w) && !rid) continue;
    const name = rid ? 'RWY' : (T(w).aeroway === 'runway' ? '' : twName(T(w)));
    const width = rid ? 0 : parseFloat(T(w).width) || (T(w).aeroway === 'taxilane' ? 15 : 23);
    for (let i = 0; i < w.nodes.length; i++) addN(w.nodes[i], w.geometry[i]);
    for (let i = 0; i < w.nodes.length - 1; i++) {
      const a = w.nodes[i], b = w.nodes[i + 1]; if (a === b) continue;
      gEdges.push({ a, b, name, rwy: rid, width, way: w.id });
      gNodes.get(a).adj.add(gEdges.length - 1); gNodes.get(b).adj.add(gEdges.length - 1);
    }
  }
  for (const e of gEdges) if (e.rwy) { gNodes.get(e.a).kind = 'r'; gNodes.get(e.a).rwy = e.rwy; gNodes.get(e.b).kind = 'r'; gNodes.get(e.b).rwy = e.rwy; }
  // keep only the biggest connected piece (drops stray bits of mapped taxiway)
  const comp = new Map(); let best = null;
  for (const n of gNodes.values()) {
    if (comp.has(n.id)) continue;
    const st = [n.id], members = []; comp.set(n.id, members);
    while (st.length) { const u = st.pop(); members.push(u); for (const ei of gNodes.get(u).adj) { const e = gEdges[ei]; const v = e.a === u ? e.b : e.a; if (!comp.has(v)) { comp.set(v, members); st.push(v); } } }
    if (!best || members.length > best.length) best = members;
  }
  const keep = new Set(best);
  for (const id of [...gNodes.keys()]) if (!keep.has(id)) gNodes.delete(id);
  for (let i = 0; i < gEdges.length; i++) if (!keep.has(gEdges[i].a)) gEdges[i] = null;

  const other = (e, u) => e.a === u ? e.b : e.a;
  const live = n => [...n.adj].filter(i => gEdges[i]);
  let nextId = -1;
  const split = (ei, x, y) => { // put a new node on edge ei at (x,y); returns the node
    const e = gEdges[ei], id = nextId--, n = { id, x, y, adj: new Set(), kind: 't' };
    gNodes.set(id, n);
    const e2 = { ...e, a: id, b: e.b };
    gNodes.get(e.b).adj.delete(ei); e.b = id; n.adj.add(ei);
    gEdges.push(e2); const i2 = gEdges.length - 1; n.adj.add(i2); gNodes.get(e2.b).adj.add(i2);
    return n;
  };
  const projOn = (px, py, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-12; const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / L2)); const x = a.x + t * dx, y = a.y + t * dy; return { t, x, y, d: Math.hypot(px - x, py - y) }; };

  // ---- taxiways drawn across a runway without being joined to it: make the crossing a runway point ----
  for (let i = 0; i < gEdges.length; i++) {
    const e = gEdges[i]; if (!e || e.rwy) continue;
    const A = gNodes.get(e.a), B = gNodes.get(e.b);
    for (const [id, R] of Object.entries(runways)) {
      if ((A.y - R.y) * (B.y - R.y) >= 0 || A.kind === 'r' || B.kind === 'r') continue;
      const t = (R.y - A.y) / (B.y - A.y), x = A.x + (B.x - A.x) * t;
      if (x < R.x1 || x > R.x2) continue;
      const n = split(i, x, R.y); n.kind = 'r'; n.rwy = id;
      break;
    }
  }


  // ---- holding points (OSM nodes and lines) ----
  const holdPts = [];
  for (const e of raw) {
    if (T(e).aeroway !== 'holding_position') continue;
    if (e.type === 'node') { const [x, y] = P(e); holdPts.push({ x, y, osm: e.id }); }
    else if (e.geometry) { const ps = e.geometry.map(P); holdPts.push({ x: ps.reduce((s, p) => s + p[0], 0) / ps.length, y: ps.reduce((s, p) => s + p[1], 0) / ps.length }); }
  }

  // ---- runway entries: from each runway node, out along the taxiway to the holding point ----
  const entries = { N: [], S: [] };
  const HOLD_DEF = 90 / NM, HOLD_MIN = 60 / NM, HOLD_MAX = 260 / NM;
  for (const n of [...gNodes.values()]) {
    if (n.kind !== 'r' || !runways[n.rwy]) continue;
    for (const ei0 of live(n)) {
      if (gEdges[ei0].rwy) continue;
      // walk out from the runway
      const chain = [n.id]; let u = n.id, ei = ei0, d = 0, hs = null;
      for (let guard = 0; guard < 60 && !hs; guard++) {
        const e = gEdges[ei], v = other(e, u), A = gNodes.get(u), B = gNodes.get(v), segL = Math.hypot(B.x - A.x, B.y - A.y);
        // a mapped holding point on this stretch?
        const hp = holdPts.map(h => ({ h, p: projOn(h.x, h.y, A, B) })).filter(q => q.p.d < 20 / NM && d + q.p.t * segL >= HOLD_MIN && d + q.p.t * segL <= HOLD_MAX).sort((a, b) => a.p.t - b.p.t)[0];
        if (hp) {
          if (hp.p.t < 0.02 && u !== n.id) hs = A; else if (hp.p.t > 0.98) { hs = B; chain.push(v); } else { hs = split(ei, hp.p.x, hp.p.y); chain.push(hs.id); }
          break;
        }
        if (d + segL >= HOLD_DEF && !holdPts.some(h => { const q = projOn(h.x, h.y, A, B); return q.d < 20 / NM && d + q.t * segL <= HOLD_MAX; })) {
          // no mapped hold here: the standard 90 m from the centreline
          const t = (HOLD_DEF - d) / segL;
          hs = t > 0.97 ? B : split(ei, A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t); chain.push(hs.id); break;
        }
        d += segL; chain.push(v); u = v;
        const nx = live(gNodes.get(v)).filter(i => i !== ei && !gEdges[i].rwy);
        if (gNodes.get(v).kind === 'r' || nx.length !== 1) { // reached a junction before the hold distance: hold here
          if (d >= HOLD_MIN * 0.7) hs = gNodes.get(v);
          break;
        }
        ei = nx[0];
      }
      if (!hs || hs.kind === 'r') continue;
      hs.kind = 'h'; hs.rwy = n.rwy;
      // one more node past the hold, where the aircraft is clear of the runway
      const past = live(hs).map(i => other(gEdges[i], hs.id)).filter(v => !chain.includes(v) && gNodes.get(v).kind !== 'r');
      if (!past.length) continue;
      chain.push(past[0]);
      const name = gEdges[ei0].name || live(hs).map(i => gEdges[i].name).find(Boolean) || '';
      const first = gNodes.get(chain[1]);
      entries[n.rwy].push({ rn: n.id, hs: hs.id, tw: past[0], path: chain, name, x: r5(n.x), side: Math.sign(hs.y - n.y), dx: r5(first.x - n.x) });
    }
  }

  // ---- stands ----
  const taxiEdgeIdx = () => gEdges.map((e, i) => e && !e.rwy ? i : -1).filter(i => i >= 0);
  const nearestEdge = (x, y, maxD) => {
    let best = null;
    for (const i of taxiEdgeIdx()) { const e = gEdges[i], p = projOn(x, y, gNodes.get(e.a), gNodes.get(e.b)); if (p.d < maxD && (!best || p.d < best.p.d)) best = { i, p }; }
    return best;
  };
  const gateNodes = raw.filter(e => e.type === 'node' && T(e).aeroway === 'gate').map(e => { const [x, y] = P(e); return { x, y, ref: T(e).ref || '' }; });
  const bridgeWays = ways.filter(w => T(w).aeroway === 'jet_bridge').map(w => w.geometry.map(P));
  // distance to the nearest building wall or terminal gate: the nose of a parked aircraft points at it
  const wallPolys = raw.filter(e => e.type === 'way' && e.geometry && (T(e).building || T(e).aeroway === 'terminal')).map(e => e.geometry.map(P));
  const nearBuilding = (x, y) => { let d = 300 / NM; for (const g of gateNodes) d = Math.min(d, Math.hypot(g.x - x, g.y - y)); for (const pl of wallPolys) for (let i = 1; i < pl.length; i++) d = Math.min(d, projOn(x, y, { x: pl[i - 1][0], y: pl[i - 1][1] }, { x: pl[i][0], y: pl[i][1] }).d); return d; };
  const standSrc = [];
  for (const e of raw) {
    if (T(e).aeroway !== 'parking_position') continue;
    const ref = (T(e).ref || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z]?\d{1,3}$/.test(ref)) continue; // the plain stand numbers; "501L"/"501R" overlays are skipped
    if (e.type === 'way' && e.geometry && e.geometry.length >= 2) standSrc.push({ ref, line: e.geometry.map(P), nodes: e.nodes });
    else if (e.type === 'node') { const [x, y] = P(e); standSrc.push({ ref, pt: [x, y] }); }
  }
  const seen = new Set(), stands = [];
  for (const s of standSrc.sort((a, b) => (b.line ? 1 : 0) - (a.line ? 1 : 0))) {
    if (seen.has(s.ref)) continue;
    let lead, nose, tail;
    if (s.line) {
      const a = s.line[0], b = s.line[s.line.length - 1];
      const ea = nearestEdge(a[0], a[1], 80 / NM), eb = nearestEdge(b[0], b[1], 80 / NM);
      const aOnNet = s.nodes && gNodes.has(s.nodes[0]), bOnNet = s.nodes && gNodes.has(s.nodes[s.nodes.length - 1]);
      const score = (p, onNet, ne) => (onNet ? 0 : ne ? ne.p.d : 1) - nearBuilding(p[0], p[1]); // low: taxi side
      const leadEnd = score(a, aOnNet, ea) <= score(b, bOnNet, eb) ? 'a' : 'b';
      tail = leadEnd === 'a' ? a : b; nose = leadEnd === 'a' ? b : a;
      const onNet = leadEnd === 'a' ? (aOnNet && s.nodes[0]) : (bOnNet && s.nodes[s.nodes.length - 1]);
      if (onNet) lead = gNodes.get(onNet);
      else { const ne = leadEnd === 'a' ? ea : eb; if (!ne) continue; lead = ne.p.t < 0.03 ? gNodes.get(gEdges[ne.i].a) : ne.p.t > 0.97 ? gNodes.get(gEdges[ne.i].b) : split(ne.i, ne.p.x, ne.p.y); }
    } else {
      const ne = nearestEdge(s.pt[0], s.pt[1], 90 / NM); if (!ne) continue;
      lead = ne.p.t < 0.03 ? gNodes.get(gEdges[ne.i].a) : ne.p.t > 0.97 ? gNodes.get(gEdges[ne.i].b) : split(ne.i, ne.p.x, ne.p.y);
      // the point is the stand centre; the nose is a little further in
      const dx = s.pt[0] - lead.x, dy = s.pt[1] - lead.y, L = Math.hypot(dx, dy) || 1e-6;
      nose = [s.pt[0] + dx / L * 18 / NM, s.pt[1] + dy / L * 18 / NM]; tail = [lead.x, lead.y];
    }
    if (lead.kind === 'r' || lead.kind === 'h') continue;
    const dx = nose[0] - lead.x, dy = nose[1] - lead.y, L = Math.hypot(dx, dy);
    if (L < 25 / NM || L > 260 / NM) continue;
    // the aircraft's centre sits about 22 m behind the stop line
    const back = Math.min(22 / NM, L * 0.55), cx = nose[0] - dx / L * back, cy = nose[1] - dy / L * back;
    const hdg = ((Math.atan2(dx, dy) / D2R) + 360) % 360;
    // a jet bridge: an OSM gate node or jet bridge near the nose
    let bridge = null;
    const door = [nose[0] - dx / L * 5 / NM - dy / L * 3 / NM, nose[1] - dy / L * 5 / NM + dx / L * 3 / NM]; // front left door, roughly
    for (const bw of bridgeWays) for (const p of [bw[0], bw[bw.length - 1]]) { const dd = Math.hypot(p[0] - door[0], p[1] - door[1]); if (dd < 30 / NM && !bridge) { const far = p === bw[0] ? bw[bw.length - 1] : bw[0]; bridge = [r5(far[0]), r5(far[1])]; } }
    if (!bridge) { const gn = gateNodes.map(g => ({ g, d: Math.hypot(g.x - door[0], g.y - door[1]) })).filter(q => q.d < 80 / NM).sort((a, b) => a.d - b.d)[0]; if (gn) { const k = Math.min(1, (26 / NM) / gn.d); bridge = [r5(door[0] + (gn.g.x - door[0]) * k), r5(door[1] + (gn.g.y - door[1]) * k)]; } }
    seen.add(s.ref);
    stands.push({ ref: s.ref, x: r5(cx), y: r5(cy), nx: r5(nose[0]), ny: r5(nose[1]), lead: lead.id, hdg: Math.round(hdg), bridge, line: [r5(lead.x), r5(lead.y), r5(nose[0]), r5(nose[1])] });
  }

  // ---- simplify: drop shape points on straight stretches, keep everything that matters ----
  const important = new Set([...stands.map(s => s.lead), ...Object.values(entries).flat().flatMap(e => [e.rn, e.hs, e.tw])]);
  for (const n of [...gNodes.values()]) {
    if (important.has(n.id) || n.kind !== 't') continue;
    const es = live(n); if (es.length !== 2) continue;
    const [e1, e2] = es.map(i => gEdges[i]);
    if (e1.name !== e2.name || !!e1.rwy !== !!e2.rwy) continue;
    const a = gNodes.get(other(e1, n.id)), b = gNodes.get(other(e2, n.id));
    if (a.id === b.id) continue;
    const p = projOn(n.x, n.y, a, b), len = Math.hypot(b.x - a.x, b.y - a.y);
    if (p.d > 1.2 / NM || len > 400 / NM) continue; // a real bend stays
    // merge: a—n—b becomes a—b
    const i1 = es[0], i2 = es[1];
    gEdges[i2] = null; b.adj.delete(i2);
    if (e1.a === n.id) e1.a = b.id; else e1.b = b.id;
    b.adj.add(i1); gNodes.delete(n.id);
  }

  // ---- output ----
  const ids = new Map(); let k = 0;
  for (const n of gNodes.values()) ids.set(n.id, k++);
  const nodes = [...gNodes.values()].map(n => [r5(n.x), r5(n.y), n.kind === 'r' ? n.rwy : n.kind === 'h' ? 'h' + n.rwy : '']);
    // a taxiway stretch lying on runway pavement: only runway entries and exits use it, never a taxi route
  const onPave = (x, y) => Object.values(runways).some(R => Math.abs(y - R.y) * NM < R.width / 2 + 3 && x >= R.x1 - 8 / NM && x <= R.x2 + 8 / NM);
  const edges = gEdges.filter(Boolean).filter(e => gNodes.has(e.a) && gNodes.has(e.b)).map(e => { const A = gNodes.get(e.a), B = gNodes.get(e.b); return [ids.get(e.a), ids.get(e.b), e.rwy ? '#' + e.rwy : e.name, Math.round(e.width), !e.rwy && onPave((A.x + B.x) / 2, (A.y + B.y) / 2) ? 1 : 0]; });
  for (const id in entries) entries[id] = entries[id].map(e => ({ ...e, rn: ids.get(e.rn), hs: ids.get(e.hs), tw: ids.get(e.tw), path: e.path.map(p => ids.get(p)).filter(p => p !== undefined) }))
    .filter(e => e.path.length >= 3 && e.path.every(p => p !== undefined));
  for (const s of stands) s.lead = ids.get(s.lead);

  // ---- drawing layers ----
  const poly = g => g.map(P).flat().map(r5);
  const polysOf = test => {
    const out = [];
    for (const e of raw) {
      if (!test(T(e))) continue;
      if (e.type === 'way' && e.geometry) out.push({ t: T(e), p: poly(e.geometry) });
      if (e.type === 'relation' && e.members) for (const m of e.members) if (m.role === 'outer' && m.geometry) out.push({ t: T(e), p: poly(m.geometry) });
    }
    return out;
  };
  const aprons = polysOf(t => t.aeroway === 'apron').map(o => o.p);
  const lvl = t => parseFloat(t.height) || (parseFloat(t['building:levels']) || 0) * 4 || 0;
  const buildings = polysOf(t => t.aeroway === 'terminal' || t.building || t.aeroway === 'hangar').map(o => ({ k: o.t.aeroway === 'terminal' || o.t.building === 'terminal' ? 't' : o.t.aeroway === 'hangar' || o.t.building === 'hangar' ? 'h' : 'b', h: lvl(o.t) || (o.t.aeroway === 'terminal' ? 16 : o.t.aeroway === 'hangar' ? 18 : 9), p: o.p }));
  const water = polysOf(t => t.natural === 'water').map(o => o.p);
  // taxiway centrelines as polylines per OSM way, for drawing pavement and markings
  const twy = ways.filter(w => ['taxiway', 'taxilane'].includes(T(w).aeroway)).map(w => [twName(T(w)), parseFloat(T(w).width) || (T(w).aeroway === 'taxilane' ? 15 : 23), poly(w.geometry)]);
  const bridges = bridgeWays.map(b => b.flat().map(r5));
  const thresholds = raw.filter(e => e.type === 'node' && T(e).aeroway === 'threshold').map(e => P(e).map(r5));
  // labels: one per taxiway name, at the middle of its longest piece, plus extra on long ones
  const labels = [];
  const byName = {};
  for (const [nm, , p] of twy) { if (!nm) continue; let L = 0; for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); (byName[nm] = byName[nm] || []).push({ p, L }); }
  for (const nm in byName) for (const { p, L } of byName[nm].sort((a, b) => b.L - a.L).slice(0, 4)) {
    if (L < 120 / NM) continue;
    const n = Math.max(1, Math.floor(L / (900 / NM)));
    for (let j = 0; j < n; j++) { let want = L * (j + 0.5) / n, acc = 0; for (let i = 2; i < p.length; i += 2) { const s = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); if (acc + s >= want) { const t = (want - acc) / s; labels.push([nm, r5(p[i - 2] + (p[i] - p[i - 2]) * t), r5(p[i - 1] + (p[i + 1] - p[i - 1]) * t)]); break; } acc += s; } }
  }
  const xs = nodes.map(n => n[0]), ys = nodes.map(n => n[1]);
  const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(r5);

  const out = { icao, origin: { lat: +o.lat.toFixed(6), lon: +o.lon.toFixed(6) }, brg: +brg.toFixed(3), runways, otherRwys, nodes, edges, entries, stands, aprons, buildings, water, twy, bridges, thresholds, labels, bounds };
  mkdirSync(join(ROOT, 'public', 'airports'), { recursive: true });
  writeFileSync(join(ROOT, 'public', 'airports', icao + '.json'), JSON.stringify(out));
  const ec = Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v.length]));
  console.log(`${icao}: brg ${brg.toFixed(1)}, runways ${Object.values(runways).map(r => `${r.names.E}/${r.names.W} ${((r.x2 - r.x1) * NM).toFixed(0)}m y=${(r.y * NM).toFixed(0)}m`).join(', ')}; ${nodes.length} nodes, ${edges.length} edges, entries ${JSON.stringify(ec)}, ${stands.length} stands (${stands.filter(s => s.bridge).length} with bridges)`);
}

for (const icao of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CFG)) build(icao);
