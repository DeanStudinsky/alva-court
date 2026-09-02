/* make_valley_buildings.mjs — building volumes for the valley.bin box,
 * from OpenStreetMap.
 *
 *   run from elevation/ :  node make_valley_buildings.mjs
 *
 * SOURCE POLICY
 * -------------
 * OpenStreetMap only. PLAN.md lists 3DEP, NAIP, OSM and TIGER as the approved
 * sources and swarm/core/CONVENTIONS.md is stricter still; an ML footprint set
 * from outside that list is not admissible here however good its coverage, so
 * this reads raw/osm/buildings.json and nothing else. Fetch it with
 * fetch_valley_osm.mjs.
 *
 * WHAT THAT COSTS, PLAINLY
 * ------------------------
 * OSM maps 33 477 buildings in this box. It also tags a height on 3 of them
 * and a storey count on 122. So essentially every height here is inferred,
 * where the previous source carried a per-building photogrammetric height for
 * 87% of them. The footprints are better — hand-traced beats ML-traced — and
 * the heights are worse. Both facts are recorded per building in `flag` and
 * summarised in the meta, because PLAN.md requires an estimate to be legible
 * as an estimate.
 *
 *   flag 1  MEASURED   3DEP LiDAR nDSM, p75 of the cells inside the ring
 *   flag 2  STATED     OSM height= / building:levels= tag
 *   flag 0  INFERRED   building=* type and footprint area, see inferHeight()
 *
 * Sources
 *   footprints  OpenStreetMap ways + multipolygon outers, (c) OSM contributors, ODbL
 *   heights     the same ways' tags, plus USGS 3DEP LiDAR CA_SaltonSea_EarthMRI_2021_D21
 *   ground      terrain / terrain_wide / terrain_corridor / valley, in the order the scene's groundY() walks
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { toUTM } from './utm11.mjs';

const FT = 3.280839895;
const SRC = 'raw/osm/buildings.json';

if (!existsSync(SRC)) {
  console.error('Missing ' + SRC + ' — run:  node fetch_valley_osm.mjs buildings');
  process.exit(1);
}

/* ── TERRAIN TILES ────────────────────────────────────────────────────────── */
function loadTile(name) {
  const meta = JSON.parse(readFileSync(name + '_meta.json', 'utf8'));
  const raw = readFileSync(meta.bin.file);
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const n = meta.nc * meta.nr;
  const hasDSM = meta.bin.layout.includes('DSM');
  return {
    name, nc: meta.nc, nr: meta.nr, cell: meta.cellM,
    x0: meta.utm.x0, y0: meta.utm.y0,
    dsm: hasDSM ? new Float32Array(buf, 0, n) : null,
    dtm: new Float32Array(buf, hasDSM ? n * 4 : 0, n),
  };
}
const colAt = (t, E) => Math.round((E - t.x0) / t.cell);
const rowAt = (t, N) => Math.round((N - t.y0) / t.cell);
const inTile = (t, c, r) => c >= 0 && c < t.nc && r >= 0 && r < t.nr;

const GROUND = ['terrain', 'terrain_wide', 'terrain_corridor', 'valley']
  .filter(n => existsSync(n + '_meta.json')).map(loadTile);
const LIDAR = ['terrain', 'terrain_fine', 'terrain_lp480440', 'terrain_lp480430',
               'terrain_lp480450', 'terrain_wide']
  .filter(n => existsSync(n + '_meta.json')).map(loadTile).filter(t => t.dsm);

const VALLEY = GROUND[GROUND.length - 1];
const REG = JSON.parse(readFileSync('valley_meta.json', 'utf8'));
const BASE_FT = REG.baseFt, ADDR_E = REG.utm.addrE, ADDR_N = REG.utm.addrN;
const BOX = {
  xmin: VALLEY.x0, xmax: VALLEY.x0 + (VALLEY.nc - 1) * VALLEY.cell,
  ymin: VALLEY.y0, ymax: VALLEY.y0 + (VALLEY.nr - 1) * VALLEY.cell,
};

console.log('ground tiles : ' + GROUND.map(t => t.name).join(', '));
console.log('lidar  tiles : ' + LIDAR.map(t => t.name).join(', '));

/* ── GEOMETRY HELPERS (unchanged — the consumer contract has not moved) ───── */
function signedArea(p) {
  const n = p.length / 2;
  let s = 0;
  for (let i = 0, j = n - 1; i < n; j = i++)
    s += p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
  return s / 2;
}

function triangulate(p) {
  const n = p.length / 2;
  if (n < 3) return [];
  const V = [];
  for (let i = 0; i < n; i++) V.push(i);
  const ccw = signedArea(p) > 0;
  const cross = (a, b, c) => {
    const s = (p[b * 2] - p[a * 2]) * (p[c * 2 + 1] - p[a * 2 + 1])
            - (p[b * 2 + 1] - p[a * 2 + 1]) * (p[c * 2] - p[a * 2]);
    return ccw ? s : -s;
  };
  const inTri = (a, b, c, q) =>
    cross(a, b, q) >= 0 && cross(b, c, q) >= 0 && cross(c, a, q) >= 0;

  const out = [];
  let guard = n * n + 8;
  while (V.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < V.length; i++) {
      const a = V[(i + V.length - 1) % V.length], b = V[i], c = V[(i + 1) % V.length];
      if (cross(a, b, c) <= 0) continue;
      let ok = true;
      for (const q of V) {
        if (q === a || q === b || q === c) continue;
        if (inTri(a, b, c, q)) { ok = false; break; }
      }
      if (!ok) continue;
      out.push(a, b, c);
      V.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (V.length === 3) out.push(V[0], V[1], V[2]);
  if (out.length < (n - 2) * 3) {
    out.length = 0;
    for (let i = 1; i < n - 1; i++) out.push(0, i, i + 1);
  }
  return out;
}

function pointInRing(p, x, z) {
  const n = p.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/* ── HEIGHT SOURCES ───────────────────────────────────────────────────────── */
function lidarHeight(ringUTM, ringXZ) {
  let e0 = Infinity, e1 = -Infinity, n0 = Infinity, n1 = -Infinity;
  for (let i = 0; i < ringUTM.length; i += 2) {
    if (ringUTM[i] < e0) e0 = ringUTM[i];
    if (ringUTM[i] > e1) e1 = ringUTM[i];
    if (ringUTM[i + 1] < n0) n0 = ringUTM[i + 1];
    if (ringUTM[i + 1] > n1) n1 = ringUTM[i + 1];
  }
  for (const t of LIDAR) {
    const c0 = colAt(t, e0), c1 = colAt(t, e1), r0 = rowAt(t, n0), r1 = rowAt(t, n1);
    if (!inTile(t, c0, r0) || !inTile(t, c1, r1)) continue;
    const s = [];
    for (let r = r0; r <= r1; r++) {
      const N = t.y0 + r * t.cell, z = (ADDR_N - N) * FT;
      for (let c = c0; c <= c1; c++) {
        const x = (t.x0 + c * t.cell - ADDR_E) * FT;
        if (!pointInRing(ringXZ, x, z)) continue;
        const i = r * t.nc + c, h = t.dsm[i] - t.dtm[i];
        if (h > 2.5) s.push(h);
      }
    }
    if (s.length < 4) continue;
    s.sort((a, b) => a - b);
    const h = s[Math.min(s.length - 1, Math.floor(s.length * 0.75))];
    if (h > 3) return h;
  }
  return 0;
}

// OSM states it: height in metres unless suffixed, or storeys.
function statedHeight(t) {
  if (t.height) {
    const m = /^([\d.]+)\s*(m|ft|')?$/.exec(String(t.height).trim());
    if (m) {
      const v = +m[1];
      if (v > 0 && v < 400) return (m[2] === 'ft' || m[2] === "'") ? v : v * FT;
    }
  }
  const lv = parseFloat(t['building:levels']);
  if (lv > 0 && lv < 60) return lv * 10.5 + 3;      // 10.5 ft floor-to-floor + parapet
  return 0;
}

/* No stated height and no LiDAR. `building=*` is the one thing OSM does tag
 * densely here (28 576 `yes`, but 2 635 `house`, 807 `roof`, 218 `retail`…),
 * and a type is a better prior than area alone: a 3 000 sq ft `roof` is a
 * carport at 9 ft, a 3 000 sq ft `apartments` is two storeys at 22 ft, and an
 * area rule cannot tell them apart. Values are the valley's own measured
 * distribution — median LiDAR roof 14.4 ft, almost entirely single storey. */
const TYPE_H = {
  roof: 9, carport: 9, canopy: 9, shelter: 9, shed: 9, garage: 9, garages: 10,
  hut: 9, cabin: 11, bungalow: 12, house: 13, detached: 13, semidetached_house: 13,
  residential: 14, terrace: 14, static_caravan: 10, mobile_home: 11,
  apartments: 22, dormitory: 22, hotel: 26, motel: 14,
  church: 26, chapel: 20, civic: 20, public: 20, school: 18, university: 22,
  hospital: 26, commercial: 18, office: 22, retail: 18, supermarket: 22,
  industrial: 24, warehouse: 26, service: 10, greenhouse: 12, farm_auxiliary: 12,
};
function inferHeight(type, areaFt2) {
  const t = TYPE_H[type];
  if (t) return t;
  if (areaFt2 < 400) return 8;
  if (areaFt2 < 4000) return 12;
  if (areaFt2 < 20000) return 16;
  return 22;
}

/* ── PASS ─────────────────────────────────────────────────────────────────── */
const doc = JSON.parse(readFileSync(SRC, 'utf8'));

const rings = [], tris = [], topY = [], botY = [], flags = [];
let seen = 0, kept = 0, tiny = 0, offGrid = 0;
const nFlag = [0, 0, 0];
const byType = {};

for (const el of doc.elements) {
  const t = el.tags || {};
  if (t.building === 'construction' || t.building === 'no') continue;

  // A way carries one ring; a multipolygon relation carries its outers. Holes
  // are dropped — a courtyard is not a sight-line question at this scale.
  const geoms = el.geometry ? [el.geometry]
    : (el.members || []).filter(m => m.role === 'outer' && m.geometry).map(m => m.geometry);

  for (const geom of geoms) {
    seen++;
    if (geom.length < 4) continue;

    const closed = geom[geom.length - 1].lat === geom[0].lat &&
                   geom[geom.length - 1].lon === geom[0].lon;
    const n = closed ? geom.length - 1 : geom.length;
    if (n < 3) continue;

    const utm = new Float64Array(n * 2), xz = new Float32Array(n * 2);
    let inBox = false;
    for (let i = 0; i < n; i++) {
      const EN = toUTM(geom[i].lon, geom[i].lat);
      utm[i * 2] = EN[0]; utm[i * 2 + 1] = EN[1];
      xz[i * 2] = (EN[0] - ADDR_E) * FT;
      xz[i * 2 + 1] = (ADDR_N - EN[1]) * FT;
      if (EN[0] >= BOX.xmin && EN[0] <= BOX.xmax &&
          EN[1] >= BOX.ymin && EN[1] <= BOX.ymax) inBox = true;
    }
    if (!inBox) continue;

    const area = Math.abs(signedArea(xz));
    if (area < 40) { tiny++; continue; }

    if (signedArea(xz) > 0) {                      // wind so the roof faces +Y
      for (let i = 0, j = n - 1; i < j; i++, j--) {
        let s = xz[i * 2]; xz[i * 2] = xz[j * 2]; xz[j * 2] = s;
        s = xz[i * 2 + 1]; xz[i * 2 + 1] = xz[j * 2 + 1]; xz[j * 2 + 1] = s;
        s = utm[i * 2]; utm[i * 2] = utm[j * 2]; utm[j * 2] = s;
        s = utm[i * 2 + 1]; utm[i * 2 + 1] = utm[j * 2 + 1]; utm[j * 2 + 1] = s;
      }
    }

    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += xz[i * 2]; cz += xz[i * 2 + 1]; }
    cx /= n; cz /= n;
    const gAt = (x, z) => {
      const E = x / FT + ADDR_E, N = ADDR_N - z / FT;
      for (const tl of GROUND) {
        const c = colAt(tl, E), r = rowAt(tl, N);
        if (inTile(tl, c, r)) return tl.dtm[r * tl.nc + c] - BASE_FT;
      }
      return null;
    };
    const gc = gAt(cx, cz);
    if (gc === null) { offGrid++; continue; }
    let gmin = gc;
    for (let i = 0; i < n; i++) {
      const g = gAt(xz[i * 2], xz[i * 2 + 1]);
      if (g !== null && g < gmin) gmin = g;
    }

    let h = lidarHeight(utm, xz), flag = 1;
    if (!h) {
      h = statedHeight(t);
      flag = 2;
      if (!h) { h = inferHeight(t.building, area); flag = 0; }
    }

    rings.push(xz);
    tris.push(triangulate(xz));
    topY.push(gc + h);
    botY.push(gmin - 8);
    flags.push(flag);
    nFlag[flag]++;
    byType[t.building || 'yes'] = (byType[t.building || 'yes'] || 0) + 1;
    kept++;
    if (kept % 10000 === 0) console.log('  ' + kept + ' buildings...');
  }
}

/* ── WRITE (same layout — the scene reader is unchanged) ──────────────────── */
const count = kept;
let nv = 0, nt = 0;
for (let i = 0; i < count; i++) { nv += rings[i].length / 2; nt += tris[i].length; }

const ringOff = new Uint32Array(count + 1);
const triOff = new Uint32Array(count + 1);
const xzAll = new Float32Array(nv * 2);
const triAll = new Uint16Array(nt);
const top = new Float32Array(count);
const bot = new Float32Array(count);
const flg = new Uint8Array(count);
let vo = 0, to = 0;
for (let i = 0; i < count; i++) {
  ringOff[i] = vo; triOff[i] = to;
  xzAll.set(rings[i], vo * 2); vo += rings[i].length / 2;
  triAll.set(tris[i], to); to += tris[i].length;
  top[i] = topY[i]; bot[i] = botY[i]; flg[i] = flags[i];
}
ringOff[count] = vo; triOff[count] = to;

const parts = [ringOff, triOff, xzAll, triAll, top, bot, flg];
const names = ['ringOff', 'triOff', 'xz', 'tri', 'top', 'bot', 'flag'];
const types = ['Uint32', 'Uint32', 'Float32', 'Uint16', 'Float32', 'Float32', 'Uint8'];
const sections = [], chunks = [];
let off = 0;
parts.forEach((p, i) => {
  const pad = (4 - (off % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); off += pad; }
  sections.push({ name: names[i], type: types[i], byteOffset: off, length: p.length });
  chunks.push(Buffer.from(p.buffer, p.byteOffset, p.byteLength));
  off += p.byteLength;
});
writeFileSync('valley_buildings.bin', Buffer.concat(chunks));

writeFileSync('valley_buildings_meta.json', JSON.stringify({
  note: 'Building volumes inside the valley.bin box. Scene feet, +X=East, ' +
        '+Z=South, y=0 at baseFt. Extrude each ring from bot[i] to top[i].',
  sources: {
    footprints: 'OpenStreetMap building ways + multipolygon outers, (c) OpenStreetMap contributors, ODbL',
    heightLidar: 'USGS 3DEP LiDAR CA_SaltonSea_EarthMRI_2021_D21 - nDSM p75 inside the ring',
    heightStated: 'OSM height= / building:levels=',
    heightInferred: 'building=* type then footprint area, see inferHeight()',
    ground: 'terrain / terrain_wide / terrain_corridor / valley 3DEP tiles, same order as the scene groundY()',
  },
  flag: { 0: 'inferred height', 1: 'measured - 3DEP LiDAR nDSM', 2: 'stated - OSM tag' },
  count, vertices: nv, roofIndices: nt,
  byFlag: { inferred: nFlag[0], lidar: nFlag[1], stated: nFlag[2] },
  buildingTypes: Object.fromEntries(
    Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 20)),
  baseFt: BASE_FT,
  utm: { addrE: ADDR_E, addrN: ADDR_N, xmin: BOX.xmin, xmax: BOX.xmax, ymin: BOX.ymin, ymax: BOX.ymax },
  bin: { file: 'valley_buildings.bin', sections },
}, null, 2));

console.log('\nscanned ' + seen + ' OSM rings, dropped ' + tiny +
            ' under 40 sq ft, ' + offGrid + ' off the terrain');
console.log('wrote ' + count + ' buildings - ' + nv + ' vertices, ' + (nt / 3) + ' roof triangles');
console.log('  LiDAR-measured ' + nFlag[1]);
console.log('  OSM-stated     ' + nFlag[2]);
console.log('  inferred       ' + nFlag[0]);
