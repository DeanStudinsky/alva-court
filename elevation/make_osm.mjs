// OpenStreetMap street network + traffic controls -> scene-local feet.
//
// Feeds the traffic-safety render: every road centreline, every stop sign, and
// every crossing in the study area, in the SAME local-ft frame as terrain.bin
// (+X = East, +Z = South, origin = 68075 Alva Court).
//
// Input:  osm_raw.json  (Overpass export, see FETCH below)
// Output: osm.json      (scene-ready geometry)
//
// FETCH (re-run when the study area changes):
//   curl -X POST https://overpass.kumi.systems/api/interpreter \
//     --data-urlencode 'data=[out:json][timeout:90];(way["highway"](BBOX);
//        node["highway"="stop"](BBOX);node["highway"="give_way"](BBOX);
//        node["highway"="crossing"](BBOX);node["traffic_calming"](BBOX););out geom;' \
//     -o osm_raw.json
import { readFileSync, writeFileSync } from 'fs';

const FT = 3.280839895;
const ADDR_E = 548660.3, ADDR_N = 3744180.9;      // scene origin, UTM 11N
const HALF_FT = 1800;                              // keep features within this of origin

// lon/lat (WGS84) -> UTM 11N, Snyder forward (same maths as probe_header.mjs)
function toUTM(lon, lat, zone = 11) {
  const a = 6378137.0, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const lon0 = (zone * 6 - 183) * Math.PI / 180;
  const rlat = lat * Math.PI / 180, rlon = lon * Math.PI / 180;
  const Nn = a / Math.sqrt(1 - e2 * Math.sin(rlat) ** 2);
  const T = Math.tan(rlat) ** 2, C = ep2 * Math.cos(rlat) ** 2;
  const A = (rlon - lon0) * Math.cos(rlat);
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * rlat
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * rlat)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * rlat)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * rlat));
  const E = k0 * Nn * (A + (1 - T + C) * A ** 3 / 6
    + (5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
  const N = k0 * (M + Nn * Math.tan(rlat) * (A ** 2 / 2 + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24
    + (61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6 / 720));
  return [E, N];
}

// -> scene local feet: +X east, +Z south
const toLocal = (lon, lat) => {
  const [e, n] = toUTM(lon, lat);
  return [+((e - ADDR_E) * FT).toFixed(2), +(-(n - ADDR_N) * FT).toFixed(2)];
};
const inArea = ([x, z]) => Math.abs(x) <= HALF_FT && Math.abs(z) <= HALF_FT;

const raw = JSON.parse(readFileSync('osm_raw.json', 'utf8'));

// Lane counts / widths by OSM class. Residential streets here measure 22-26 ft
// kerb-to-kerb in the aerial; TIGER attributes Alva Ct at 22.
const WIDTH_FT = {
  motorway: 48, trunk: 44, primary: 44, secondary: 38, tertiary: 32,
  residential: 24, unclassified: 24, service: 14, living_street: 20,
  footway: 5, path: 4, cycleway: 6, steps: 4,
};
const DRIVABLE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'residential', 'unclassified', 'service', 'living_street']);

const ways = [];
for (const el of raw.elements) {
  if (el.type !== 'way' || !el.geometry) continue;
  const kind = el.tags?.highway;
  if (!kind) continue;
  const pts = el.geometry.map(g => toLocal(g.lon, g.lat));
  if (!pts.some(inArea)) continue;                 // wholly outside the study area
  ways.push({
    id: el.id,
    name: el.tags.name ?? null,
    kind,
    drivable: DRIVABLE.has(kind),
    widthFt: el.tags.width ? +el.tags.width * 3.28084 : (WIDTH_FT[kind] ?? 20),
    lanes: el.tags.lanes ? +el.tags.lanes : null,
    oneway: el.tags.oneway === 'yes',
    surface: el.tags.surface ?? null,
    pts,
  });
}

const points = [];
for (const el of raw.elements) {
  if (el.type !== 'node') continue;
  const kind = el.tags?.highway ?? (el.tags?.traffic_calming ? 'traffic_calming' : null);
  if (!kind) continue;
  const p = toLocal(el.lon, el.lat);
  if (!inArea(p)) continue;
  points.push({ id: el.id, kind, direction: el.tags.direction ?? null, at: p });
}

// Which stop signs guard which intersection? Cluster them so the render can label
// an intersection once instead of stamping four unrelated posts.
const stops = points.filter(p => p.kind === 'stop');
const CLUSTER_FT = 120;
const seen = new Set(); const intersections = [];
for (let i = 0; i < stops.length; i++) {
  if (seen.has(i)) continue;
  const group = [i]; seen.add(i);
  for (let j = i + 1; j < stops.length; j++) {
    if (seen.has(j)) continue;
    if (Math.hypot(stops[i].at[0] - stops[j].at[0], stops[i].at[1] - stops[j].at[1]) < CLUSTER_FT) {
      group.push(j); seen.add(j);
    }
  }
  const cx = group.reduce((s, k) => s + stops[k].at[0], 0) / group.length;
  const cz = group.reduce((s, k) => s + stops[k].at[1], 0) / group.length;
  // name it from the drivable ways passing nearby
  const near = new Set();
  for (const w of ways) {
    if (!w.drivable || !w.name) continue;
    for (const [x, z] of w.pts) if (Math.hypot(x - cx, z - cz) < 90) { near.add(w.name); break; }
  }
  intersections.push({
    id: intersections.length,
    centerFt: [+cx.toFixed(1), +cz.toFixed(1)],
    stopCount: group.length,
    streets: [...near],
    stops: group.map(k => stops[k].at),
  });
}
intersections.sort((a, b) => Math.hypot(...a.centerFt) - Math.hypot(...b.centerFt));
intersections.forEach((it, k) => it.id = k);

writeFileSync('osm.json', JSON.stringify({
  note: 'Scene-local FEET. +X=East, +Z=South, origin = 68075 Alva Court. Same frame as terrain.bin.',
  source: 'OpenStreetMap via Overpass (ODbL). Widths inferred from highway class unless tagged.',
  studyHalfWidthFt: HALF_FT,
  counts: { ways: ways.length, points: points.length, intersections: intersections.length },
  ways, points, intersections,
}, null, 1));

console.log(`ways ${ways.length} (${ways.filter(w => w.drivable).length} drivable)`);
console.log(`points ${points.length}:`, JSON.stringify(points.reduce((a, p) => (a[p.kind] = (a[p.kind] || 0) + 1, a), {})));
console.log(`stop-controlled intersections: ${intersections.length}`);
for (const it of intersections.slice(0, 10))
  console.log(`  #${it.id} (${it.centerFt[0]}, ${it.centerFt[1]}) ${it.stopCount} stops — ${it.streets.join(' / ') || '(unnamed)'}`);
console.log('wrote osm.json');
