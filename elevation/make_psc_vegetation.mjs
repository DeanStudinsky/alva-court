/* make_psc_vegetation.mjs — vegetation for Palm Springs + Cathedral City,
 * from OpenStreetMap, draped on the 3DEP terrain.
 *
 *   run from elevation/ :  node make_psc_vegetation.mjs
 *
 * Two products, because OSM holds vegetation in two very different shapes:
 *
 *   AREAS   golf courses, parks, sports pitches, gardens, mown grass -> turf;
 *           scrub, wood and tree rows -> desert scrub. Filled, triangulated,
 *           subdivided until no edge is longer than SUB_FT, then draped. A
 *           golf course is 3 000 ft across and 39 m ground cells run under it,
 *           so an undivided polygon would cut straight through every rise.
 *
 *   TREES   8 043 individually mapped `natural=tree` nodes in this box, plus
 *           trees stepped along `natural=tree_row` ways. Emitted as instance
 *           records (position, height, crown radius, kind), not geometry — the
 *           scene builds one InstancedMesh per kind from them.
 *
 * WHY THE SPECIES TAGS MATTER
 * ---------------------------
 * 633 of these trees are tagged `Arecaceae`, 193 `Washingtonia filifera` and
 * 85 `Washingtonia robusta`. That is not trivia: a Mexican fan palm reaches
 * 80-100 ft with a crown barely 16 ft across, and a California fan palm tops
 * out near half that. Rendering both as a generic 25 ft ball would put the
 * wrong object in front of every sight line this project exists to measure.
 * Where OSM states a height (299 trees) that wins outright.
 *
 * Sources
 *   geometry  OpenStreetMap, (c) OpenStreetMap contributors, ODbL — raw/osm/vegetation.json
 *   colour    NAIP medians over PS + Cathedral City, elevation/measure_psc_tones.py:
 *             turf #52684b from 13 699 px, canopy #465f4a from 22 518 px
 *   ground    terrain / terrain_wide / terrain_corridor / valley, scene groundY() order
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { toUTM } from './utm11.mjs';

const FT = 3.280839895;
const SRC = 'raw/osm/vegetation.json';
const BOX = { s: 33.755, w: -116.585, n: 33.875, e: -116.415 };
// 12 ft — roughly ONE cell of the 4 m corridor tile. This started at 80 ft,
// which was sized for ground that was only smooth because valley.bin at 39 m
// posting made it smooth. The corridor tile has the real wash banks in it, and
// a flat triangle can only be as long as the ground under it is flat: an 80 ft
// chord passed clean under every convex bump and the terrain poked through,
// mottling Cimarron with tan blobs. 24 ft removed most of them; one cell
// removes the rest. Raising the lift instead only hides it until the next
// finer tile arrives.
const SUB_FT = 12;          // subdivide area triangles below this edge length

if (!existsSync(SRC)) {
  console.error('Missing ' + SRC + ' — run:  node fetch_valley_osm.mjs vegetation');
  process.exit(1);
}

/* ── TERRAIN — same interpolated drape as make_psc_surfaces.mjs ───────────── */
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

function groundY(x, z) {
  const E = x / FT + ADDR_E, N = ADDR_N - z / FT;
  for (const t of GROUND) {
    const fc = (E - t.x0) / t.cell, fr = (N - t.y0) / t.cell;
    const c = Math.floor(fc), r = Math.floor(fr);
    if (c < 0 || c >= t.nc - 1 || r < 0 || r >= t.nr - 1) continue;
    const u = fc - c, v = fr - r;
    const h = (rr, cc) => t.dtm[rr * t.nc + cc] - BASE_FT;
    const a = h(r, c), b = h(r, c + 1), d = h(r + 1, c), e = h(r + 1, c + 1);
    return (u + v <= 1) ? a + (b - a) * u + (d - a) * v
                        : e + (d - e) * (1 - u) + (b - e) * (1 - v);
  }
  return null;
}

const toScene = (lon, lat) => {
  const EN = toUTM(lon, lat);
  return [(EN[0] - ADDR_E) * FT, (ADDR_N - EN[1]) * FT];
};
const inBox = g => g.some(p => p.lat >= BOX.s && p.lat <= BOX.n &&
                               p.lon >= BOX.w && p.lon <= BOX.e);

/* ── CLASSIFICATION ───────────────────────────────────────────────────────── */
const TURF = [['leisure', new Set(['golf_course', 'park', 'pitch', 'garden'])],
              ['landuse', new Set(['grass', 'village_green', 'recreation_ground'])]];
const SCRUB = [['natural', new Set(['scrub', 'wood', 'shrubbery'])],
               ['landuse', new Set(['forest', 'orchard', 'vineyard', 'farmland'])]];
const matchAny = (t, table) => table.some(([k, vals]) => vals.has(t[k]));

// A palm is a different silhouette, not a different colour, and the difference
// is the whole point of carrying species through.
const PALM_RE = /arecaceae|washingtonia|phoenix|syagrus|palm/i;
function treeSpec(t) {
  const taxon = [t.taxon, t.species, t.genus, t['taxon:en']].filter(Boolean).join(' ');
  const palm = PALM_RE.test(taxon);

  let h = 0;
  if (t.height) {
    const m = /^([\d.]+)\s*(m|ft|')?$/.exec(String(t.height).trim());
    if (m) {
      const v = +m[1];
      if (v > 2 && v < 200) h = (m[2] === 'ft' || m[2] === "'") ? v : v * FT;
    }
  }
  if (!h) {
    if (/robusta/i.test(taxon)) h = 70;          // Mexican fan palm, the tall one
    else if (/filifera/i.test(taxon)) h = 45;    // California fan palm
    else if (palm) h = 40;
    else h = 25;
  }
  // Palms carry a small crown at any height; broadleaf crowns scale with it.
  const crown = palm ? 8 : Math.max(6, 0.40 * h);
  return { h, crown, kind: palm ? 1 : 0 };
}

/* ── AREA MESHING ─────────────────────────────────────────────────────────── */
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
      out.push(a, b, c); V.splice(i, 1); clipped = true; break;
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

// Split on the longest edge until every edge is under SUB_FT, then drape.
// Recursing on the longest edge (rather than a 4-way split) keeps triangle
// count near the minimum needed for the terrain, instead of 4^depth.
function emitDraped(ax, az, bx, bz, cx, cz, g, depth) {
  const e = [
    [(ax - bx) ** 2 + (az - bz) ** 2, 0],
    [(bx - cx) ** 2 + (bz - cz) ** 2, 1],
    [(cx - ax) ** 2 + (cz - az) ** 2, 2],
  ].sort((p, q) => q[0] - p[0])[0];

  if (depth < 7 && e[0] > SUB_FT * SUB_FT) {
    if (e[1] === 0) {
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      emitDraped(ax, az, mx, mz, cx, cz, g, depth + 1);
      emitDraped(mx, mz, bx, bz, cx, cz, g, depth + 1);
    } else if (e[1] === 1) {
      const mx = (bx + cx) / 2, mz = (bz + cz) / 2;
      emitDraped(ax, az, bx, bz, mx, mz, g, depth + 1);
      emitDraped(ax, az, mx, mz, cx, cz, g, depth + 1);
    } else {
      const mx = (cx + ax) / 2, mz = (cz + az) / 2;
      emitDraped(ax, az, bx, bz, mx, mz, g, depth + 1);
      emitDraped(mx, mz, bx, bz, cx, cz, g, depth + 1);
    }
    return;
  }
  const base = g.nv;
  for (const [x, z] of [[ax, az], [bx, bz], [cx, cz]]) {
    const y = groundY(x, z);
    // 4 ft of clearance. KNOWN ISSUE, measured not guessed: raycasting into
    // the tan blobs on Cimarron put terrain_corridor in front at y=10.1 with
    // the turf behind at y=7.9 — the drape lands up to ~2.2 ft BELOW the mesh
    // the scene actually draws, even though sampling the same vertices against
    // groundY() says it is 1.3-1.7 ft above. So this offline drape and the
    // rendered ground disagree somewhere I have not yet isolated; subdividing
    // 80 -> 24 -> 12 ft changed the picture not at all, which rules out the
    // flat-chord explanation.
    //
    // 4 ft clears the measured worst case and is invisible at any camera
    // height that shows a golf course. It is a render lift, not a claim about
    // elevation, and it is covering a real defect rather than fixing it.
    // polygonOffset cannot help: logarithmicDepthBuffer writes gl_FragDepth,
    // which makes fixed-function polygon offset inert.
    g.pos.push(x, (y === null ? 0 : y) + 4.0, z);
  }
  g.idx.push(base, base + 1, base + 2);
  g.nv += 3;
}

/* ── PASS ─────────────────────────────────────────────────────────────────── */
const doc = JSON.parse(readFileSync(SRC, 'utf8'));
const groups = { turf: { pos: [], idx: [], nv: 0, ways: 0, acres: 0 },
                 scrub: { pos: [], idx: [], nv: 0, ways: 0, acres: 0 } };
const trees = [];                    // x, y, z, height, crown, kind
let treeRows = 0;

for (const el of doc.elements) {
  const t = el.tags || {};

  if (el.type === 'node') {
    if (t.natural !== 'tree') continue;
    if (el.lat < BOX.s || el.lat > BOX.n || el.lon < BOX.w || el.lon > BOX.e) continue;
    const [x, z] = toScene(el.lon, el.lat);
    const y = groundY(x, z);
    if (y === null) continue;
    const s = treeSpec(t);
    trees.push([x, y, z, s.h, s.crown, s.kind]);
    continue;
  }

  const geom = el.geometry;
  if (!geom || geom.length < 2 || !inBox(geom)) continue;

  // A tree row is a line, not an area: step trees along it.
  if (t.natural === 'tree_row') {
    const pts = geom.map(p => toScene(p.lon, p.lat));
    const s = treeSpec(t);
    let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0], dz = pts[i][1] - pts[i - 1][1];
      const len = Math.hypot(dx, dz);
      for (let d = carry; d < len; d += 25) {
        const x = pts[i - 1][0] + dx * d / len, z = pts[i - 1][1] + dz * d / len;
        const y = groundY(x, z);
        if (y !== null) trees.push([x, y, z, s.h, s.crown, s.kind]);
      }
      carry = Math.max(0, 25 - ((len - carry) % 25));
    }
    treeRows++;
    continue;
  }

  const isTurf = matchAny(t, TURF);
  const isScrub = matchAny(t, SCRUB);
  if (!isTurf && !isScrub) continue;
  if (geom.length < 4) continue;

  const closed = geom[geom.length - 1].lat === geom[0].lat &&
                 geom[geom.length - 1].lon === geom[0].lon;
  const n = closed ? geom.length - 1 : geom.length;
  if (n < 3) continue;

  const ring = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const [x, z] = toScene(geom[i].lon, geom[i].lat);
    ring[i * 2] = x; ring[i * 2 + 1] = z;
  }
  if (Math.abs(signedArea(ring)) < 400) continue;
  if (signedArea(ring) > 0) {                        // face +Y
    for (let i = 0, j = n - 1; i < j; i++, j--) {
      let s = ring[i * 2]; ring[i * 2] = ring[j * 2]; ring[j * 2] = s;
      s = ring[i * 2 + 1]; ring[i * 2 + 1] = ring[j * 2 + 1]; ring[j * 2 + 1] = s;
    }
  }

  const g = isTurf ? groups.turf : groups.scrub;
  const tri = triangulate(ring);
  for (let i = 0; i < tri.length; i += 3) {
    const a = tri[i], b = tri[i + 1], c = tri[i + 2];
    emitDraped(ring[a * 2], ring[a * 2 + 1], ring[b * 2], ring[b * 2 + 1],
               ring[c * 2], ring[c * 2 + 1], g, 0);
  }
  g.ways++;
  g.acres += Math.abs(signedArea(ring)) / 43560;
}

/* ── WRITE ────────────────────────────────────────────────────────────────── */
const inst = new Float32Array(trees.length * 6);
trees.forEach((t, i) => inst.set(t, i * 6));

const chunks = [], sections = [];
let off = 0;
const push = (name, type, arr) => {
  const pad = (4 - (off % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); off += pad; }
  sections.push({ name, type, byteOffset: off, length: arr.length });
  chunks.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  off += arr.byteLength;
};
for (const [name, g] of Object.entries(groups)) {
  push(name + '_pos', 'Float32', new Float32Array(g.pos));
  push(name + '_idx', 'Uint32', new Uint32Array(g.idx));
}
push('tree', 'Float32', inst);
writeFileSync('psc_vegetation.bin', Buffer.concat(chunks));

const palms = trees.filter(t => t[5] === 1).length;
writeFileSync('psc_vegetation_meta.json', JSON.stringify({
  note: 'Palm Springs + Cathedral City vegetation, scene feet, +X=East, +Z=South, ' +
        'y=0 at baseFt. Area meshes are pre-draped. tree[] is 6 floats per tree: ' +
        'x, y, z, heightFt, crownRadiusFt, kind (0 broadleaf, 1 palm).',
  source: 'OpenStreetMap (c) OpenStreetMap contributors, ODbL',
  colour: {
    turf: '#52684b', canopy: '#465f4a',
    provenance: 'NAIP medians over PS + Cathedral City, measure_psc_tones.py',
  },
  extent: BOX,
  areas: {
    turf: { ways: groups.turf.ways, acres: +groups.turf.acres.toFixed(1),
            vertices: groups.turf.nv },
    scrub: { ways: groups.scrub.ways, acres: +groups.scrub.acres.toFixed(1),
             vertices: groups.scrub.nv },
  },
  trees: { total: trees.length, palms, broadleaf: trees.length - palms,
           fromTreeRows: treeRows },
  bin: { file: 'psc_vegetation.bin', sections },
}, null, 2));

console.log('Palm Springs + Cathedral City vegetation');
console.log('  turf   ' + String(groups.turf.ways).padStart(4) + ' areas  ' +
            groups.turf.acres.toFixed(0).padStart(6) + ' acres  ' +
            String(groups.turf.nv).padStart(7) + ' verts');
console.log('  scrub  ' + String(groups.scrub.ways).padStart(4) + ' areas  ' +
            groups.scrub.acres.toFixed(0).padStart(6) + ' acres  ' +
            String(groups.scrub.nv).padStart(7) + ' verts');
console.log('  trees  ' + trees.length + ' (' + palms + ' palm, ' +
            (trees.length - palms) + ' broadleaf, ' + treeRows + ' rows stepped)');
console.log('wrote psc_vegetation.bin (' + (off / 1e6).toFixed(1) + ' MB)');
