/* make_psc_surfaces.mjs — paved surfaces for Palm Springs + Cathedral City,
 * from OpenStreetMap, draped on the 3DEP terrain.
 *
 *   run from elevation/ :  node make_psc_surfaces.mjs
 *
 * Roads become textured asphalt ribbons and sidewalks become concrete ones.
 * Both are swept the same way the Alva Court road already is in
 * `sim of alva court.html` — resampled along the centreline, offset by half
 * width with a mitred join, and draped on the DTM — just at city scale and
 * from OSM geometry instead of one surveyed centreline.
 *
 * SIDEWALKS ARE NOT INVENTED. OSM in this valley barely uses the `sidewalk=*`
 * tag on roads (36 ways in the whole box) but maps 1 027 separate
 * `highway=footway, footway=sidewalk` ways. Those ways are the only sidewalks
 * drawn. A street with no mapped sidewalk gets none — under PLAN.md a sight
 * line has to argue from what the data shows, and a ribbon of concrete
 * conjured along every residential street would be exactly the invented
 * geometry that rule forbids.
 *
 * Material comes from `surface=*` where OSM states it (2 538 asphalt, 890
 * concrete, 137 unpaved in this box) and from the highway class otherwise.
 *
 * Sources
 *   geometry  OpenStreetMap ways, © OSM contributors, ODbL — raw/osm/roads.json
 *   ground    terrain / terrain_wide / terrain_corridor / valley 3DEP tiles, in the order the
 *             scene's own groundY() walks them
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { toUTM } from './utm11.mjs';

const FT = 3.280839895;

/* ── EXTENT — Palm Springs + Cathedral City ───────────────────────────────── */
const BOX = { s: 33.755, w: -116.585, n: 33.875, e: -116.415 };

/* ── TERRAIN (same loader and order as make_valley_buildings.mjs) ─────────── */
function loadTile(name) {
  const meta = JSON.parse(readFileSync(name + '_meta.json', 'utf8'));
  const raw = readFileSync(meta.bin.file);
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const n = meta.nc * meta.nr;
  const hasDSM = meta.bin.layout.includes('DSM');
  return { name, nc: meta.nc, nr: meta.nr, cell: meta.cellM,
           x0: meta.utm.x0, y0: meta.utm.y0,
           dtm: new Float32Array(buf, hasDSM ? n * 4 : 0, n) };
}
const GROUND = ['terrain', 'terrain_wide', 'terrain_corridor', 'valley']
  .filter(n => existsSync(n + '_meta.json')).map(loadTile);
const REG = JSON.parse(readFileSync('valley_meta.json', 'utf8'));
const BASE_FT = REG.baseFt, ADDR_E = REG.utm.addrE, ADDR_N = REG.utm.addrN;

/* Height of the rendered ground surface, not of the nearest sample.
 *
 * The scene's own groundY() rounds to the nearest cell, which is harmless on
 * a 0.5 m LiDAR tile and ruinous out here: most of Palm Springs sits on
 * valley.bin at 39 m posting, where a road draped on cell-centre values sinks
 * several feet below the interpolated mesh on any slope and simply disappears.
 *
 * So interpolate the way the mesh is actually triangulated — the ground builder
 * emits (a, b, d) and (b, e, d) for the quad a=(r,c) b=(r,c+1) d=(r+1,c)
 * e=(r+1,c+1) — and the ribbon lands exactly on the surface it is drawn over,
 * leaving the small class lift to do nothing but order the junctions. */
function groundY(x, z) {
  const E = x / FT + ADDR_E, N = ADDR_N - z / FT;
  for (const t of GROUND) {
    const fc = (E - t.x0) / t.cell, fr = (N - t.y0) / t.cell;
    const c = Math.floor(fc), r = Math.floor(fr);
    if (c < 0 || c >= t.nc - 1 || r < 0 || r >= t.nr - 1) continue;
    const u = fc - c, v = fr - r;
    const h = (rr, cc) => t.dtm[rr * t.nc + cc] - BASE_FT;
    const a = h(r, c), b = h(r, c + 1), d = h(r + 1, c), e = h(r + 1, c + 1);
    return (u + v <= 1)
      ? a + (b - a) * u + (d - a) * v                       // lower triangle
      : e + (d - e) * (1 - u) + (b - e) * (1 - v);          // upper triangle
  }
  return null;
}

/* ── WIDTH AND MATERIAL ───────────────────────────────────────────────────── */
// Class defaults in feet. US suburban desert arterials are wide; these are the
// kerb-to-kerb widths that read correctly against the NAIP at this latitude.
const CLASS_W = {
  motorway: 48, motorway_link: 20, trunk: 44, trunk_link: 20,
  primary: 44, primary_link: 20, secondary: 36, secondary_link: 18,
  tertiary: 30, tertiary_link: 18, residential: 26, unclassified: 24,
  living_street: 22, service: 18, track: 12, road: 24, busway: 24,
};
const FOOT_W = 5;                       // mapped sidewalk, when width is untagged

// 0 asphalt · 1 concrete · 2 unpaved · 3 sidewalk (concrete, raised on a kerb)
const UNPAVED = new Set(['unpaved', 'dirt', 'ground', 'earth', 'sand', 'gravel',
                         'fine_gravel', 'compacted', 'grass', 'mud']);
const CONCRETE = new Set(['concrete', 'concrete:plates', 'concrete:lanes',
                          'paving_stones', 'sett', 'unhewn_cobblestone', 'cobblestone']);

function widthFt(t, isFoot) {
  if (t.width) {                                   // metres unless it says ft
    const m = /^([\d.]+)\s*(ft|')?$/.exec(t.width.trim());
    if (m) return m[2] ? +m[1] : +m[1] * FT;
  }
  if (isFoot) return FOOT_W;
  const lanes = +t.lanes;
  if (lanes > 0 && lanes < 12) return lanes * 11.5 + 4;   // + gutter either side
  return CLASS_W[t.highway] || 22;
}

function materialOf(t, isFoot) {
  if (isFoot) return 3;
  if (t.surface && UNPAVED.has(t.surface)) return 2;
  if (t.surface && CONCRETE.has(t.surface)) return 1;
  return 0;
}

// Bigger roads sit a hair higher so a junction resolves in favour of the
// through route instead of z-fighting. Sidewalks sit on their kerb.
const LIFT = { motorway: 0.34, trunk: 0.32, primary: 0.30, secondary: 0.28,
               tertiary: 0.26, residential: 0.22, unclassified: 0.22,
               living_street: 0.20, service: 0.18, track: 0.16 };
function liftOf(t, isFoot) {
  if (isFoot) return 0.55;                          // ~kerb height
  return LIFT[(t.highway || '').replace(/_link$/, '')] || 0.20;
}

/* ── SWEEP ────────────────────────────────────────────────────────────────── */
const STEP = 20;                    // ft between draped samples
// 40 ft, not the 20 ft the Alva Court street uses. A 2048 px texture repeated
// every 20 ft over a network seen from 1 500 ft up lands about one texel per
// screen pixel and reads as noise; 40 ft puts the mip chain back in charge
// without visibly stretching the grain at street level.
const TILE = 40;                    // ft of surface per texture repeat
const MITRE_LIMIT = 3.0;

const groups = [0, 1, 2, 3].map(() => ({ pos: [], uv: [], idx: [], nv: 0 }));

function ribbon(pts, halfW, lift, g, tile) {
  // Resample so no piece is longer than STEP — the DTM under a city block is a
  // 39 m cell, and a 300 ft straight would otherwise cut through a rise.
  const p = [];
  for (let i = 0; i < pts.length; i++) {
    if (i) {
      const a = pts[i - 1], b = pts[i];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const nsub = Math.max(1, Math.ceil(d / STEP));
      for (let k = 1; k < nsub; k++)
        p.push([a[0] + (b[0] - a[0]) * k / nsub, a[1] + (b[1] - a[1]) * k / nsub]);
    }
    p.push(pts[i]);
  }
  // Drop repeats — a duplicated node makes a zero-length tangent.
  const q = [p[0]];
  for (let i = 1; i < p.length; i++)
    if (Math.hypot(p[i][0] - q[q.length - 1][0], p[i][1] - q[q.length - 1][1]) > 0.05) q.push(p[i]);
  if (q.length < 2) return;

  const base = g.nv;
  let run = 0;
  for (let i = 0; i < q.length; i++) {
    const prev = q[Math.max(0, i - 1)], next = q[Math.min(q.length - 1, i + 1)];
    let tx = next[0] - prev[0], tz = next[1] - prev[1];
    const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    // Mitre: widen the offset into a corner so the outer edge stays continuous.
    let scale = 1;
    if (i > 0 && i < q.length - 1) {
      let ax = q[i][0] - prev[0], az = q[i][1] - prev[1];
      let bx = next[0] - q[i][0], bz = next[1] - q[i][1];
      const al = Math.hypot(ax, az) || 1, bl = Math.hypot(bx, bz) || 1;
      const cos = (ax / al) * (bx / bl) + (az / al) * (bz / bl);
      scale = Math.min(MITRE_LIMIT, 1 / Math.max(0.2, Math.sqrt((1 + cos) / 2)));
    }
    const nx = -tz * halfW * scale, nz = tx * halfW * scale;
    if (i) run += Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);

    for (const s of [-1, 1]) {
      const x = q[i][0] + nx * s, z = q[i][1] + nz * s;
      const y = groundY(x, z);
      g.pos.push(x, (y === null ? 0 : y) + lift, z);
      g.uv.push((s * halfW) / tile, run / tile);
    }
  }
  // Vertices go left(s=-1), right(s=+1) per station, so a=left b=right of one
  // station and c,d the next. (a,b,c)+(b,d,c) is the winding whose normal is
  // +Y; the transpose of it faces the ground and gets back-face culled away.
  for (let i = 0; i < q.length - 1; i++) {
    const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
    g.idx.push(a, b, c, b, d, c);
  }
  g.nv += q.length * 2;
}

/* ── PASS ─────────────────────────────────────────────────────────────────── */
const doc = JSON.parse(readFileSync('raw/osm/roads.json', 'utf8'));
const stat = { asphalt: 0, concrete: 0, unpaved: 0, sidewalk: 0, skipped: 0 };
let lenFt = [0, 0, 0, 0];

for (const el of doc.elements) {
  const g = el.geometry;
  if (!g || g.length < 2) continue;
  const t = el.tags || {};
  const hw = t.highway;
  if (!hw) continue;

  const isFoot = hw === 'footway' && t.footway === 'sidewalk';
  // Everything else that is not a driveable, paved-by-default way is out:
  // paths, steps, cycleways, crossings, proposed and under-construction.
  if (!isFoot && !(hw in CLASS_W)) continue;
  if (t.area === 'yes') continue;

  // Clip to the PS + Cathedral City box by node membership.
  if (!g.some(p => p.lat >= BOX.s && p.lat <= BOX.n && p.lon >= BOX.w && p.lon <= BOX.e)) continue;

  const pts = g.map(p => {
    const EN = toUTM(p.lon, p.lat);
    return [(EN[0] - ADDR_E) * FT, (ADDR_N - EN[1]) * FT];
  });
  if (groundY(pts[0][0], pts[0][1]) === null) { stat.skipped++; continue; }

  const mat = materialOf(t, isFoot);
  const w = widthFt(t, isFoot);
  const tile = isFoot ? 5.67 : TILE;      // sidewalk repeats at one 68" slab
  ribbon(pts, w / 2, liftOf(t, isFoot), groups[mat], tile);

  for (let i = 1; i < pts.length; i++)
    lenFt[mat] += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  stat[['asphalt', 'concrete', 'unpaved', 'sidewalk'][mat]]++;
}

/* ── WRITE ────────────────────────────────────────────────────────────────── */
const NAMES = ['asphalt', 'concrete', 'unpaved', 'sidewalk'];
const chunks = [], sections = [];
let off = 0;
const push = (name, type, arr) => {
  const pad = (4 - (off % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); off += pad; }
  sections.push({ name, type, byteOffset: off, length: arr.length });
  chunks.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  off += arr.byteLength;
};
const summary = {};
groups.forEach((g, i) => {
  push(NAMES[i] + '_pos', 'Float32', new Float32Array(g.pos));
  push(NAMES[i] + '_uv', 'Float32', new Float32Array(g.uv));
  push(NAMES[i] + '_idx', 'Uint32', new Uint32Array(g.idx));
  summary[NAMES[i]] = { ways: stat[NAMES[i]], vertices: g.nv,
                        triangles: g.idx.length / 3, miles: +(lenFt[i] / 5280).toFixed(1) };
});
writeFileSync('psc_surfaces.bin', Buffer.concat(chunks));

writeFileSync('psc_surfaces_meta.json', JSON.stringify({
  note: 'Palm Springs + Cathedral City paved surfaces, scene feet, +X=East, ' +
        '+Z=South, y=0 at baseFt. Ribbons are pre-draped; UV u is across the ' +
        'width and v runs along the centreline, both already in tile units, so ' +
        'the texture repeat stays (1,1).',
  source: 'OpenStreetMap ways (c) OpenStreetMap contributors, ODbL',
  ground: 'terrain / terrain_wide / terrain_corridor / valley 3DEP tiles, scene groundY() order',
  extent: BOX,
  sidewalks: 'only OSM highway=footway + footway=sidewalk ways — never generated ' +
             'alongside a road that does not map one',
  tileFt: { road: TILE, sidewalk: 20 },
  groups: summary,
  skippedOutsideTerrain: stat.skipped,
  bin: { file: 'psc_surfaces.bin', sections },
}, null, 2));

console.log('Palm Springs + Cathedral City surfaces');
for (const n of NAMES) {
  const s = summary[n];
  console.log('  ' + n.padEnd(9) + String(s.ways).padStart(5) + ' ways  ' +
              String(s.miles).padStart(7) + ' mi  ' +
              String(s.vertices).padStart(8) + ' verts');
}
console.log('  skipped (off terrain): ' + stat.skipped);
console.log('wrote psc_surfaces.bin (' + (off / 1e6).toFixed(1) + ' MB)');
