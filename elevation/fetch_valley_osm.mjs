/* fetch_valley_osm.mjs — OpenStreetMap for the whole valley.bin box.
 *
 *   run from elevation/ :  node fetch_valley_osm.mjs [layer ...]
 *
 * PLAN.md names OpenStreetMap as an approved source alongside 3DEP and NAIP.
 * This pulls it once, raw, into gitignored raw/osm/ so the conflation step
 * (make_valley_features.mjs) is offline and repeatable. One request per layer
 * rather than one giant union — a single query for all of it times out on the
 * public Overpass instance, and a partial answer would silently look complete.
 *
 * Extent is the valley.bin footprint, i.e. exactly the map the scene draws.
 * Sequential with a pause between layers: the public endpoint is shared.
 */
import { writeFileSync, existsSync, mkdirSync, statSync } from 'fs';

const OUT = 'raw/osm';
mkdirSync(OUT, { recursive: true });

// valley.bin corners through utm11.mjs, rounded outward.
const BBOX = '33.6560,-116.6920,34.0170,-116.2550';   // S,W,N,E

// The public instances rate-limit and fall over independently, and a 504 says
// nothing about the query. Rotate, and back off long enough to outlast a busy
// spell rather than hammering a loaded endpoint.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const UA = 'alva-court-render/1.0 (traffic-safety render; contact via repo)';

const LAYERS = {
  // Hand-drawn outlines + any tagged height. The cross-check for the ML
  // footprints, and a better outline wherever the two disagree.
  buildings: `
    way["building"](${BBOX});
    relation["building"](${BBOX});`,

  // "Sidestreets" — the whole classified network, not just the ±1800 ft of
  // osm.json. service/residential is most of it and is what osm.json misses.
  roads: `
    way["highway"](${BBOX});`,

  // Vegetation the LiDAR cannot reach: canopy polygons and mapped single trees.
  // orchard matters here specifically — the valley's date groves read as tall
  // rough surface and would otherwise be extruded as buildings.
  vegetation: `
    way["natural"~"^(wood|scrub|tree_row|shrubbery)$"](${BBOX});
    way["landuse"~"^(forest|orchard|vineyard|farmland|greenhouse_horticulture)$"](${BBOX});
    way["leisure"~"^(golf_course|park|garden|pitch)$"](${BBOX});
    node["natural"="tree"](${BBOX});`,

  // Palm Springs Intl, Bermuda Dunes, Jacqueline Cochran. Aprons and runways
  // are how a parked aircraft gets told apart from a hangar: the ML footprints
  // trace aircraft, and anything standing on an apron is one.
  aeroway: `
    way["aeroway"](${BBOX});
    relation["aeroway"](${BBOX});
    node["aeroway"](${BBOX});`,

  // Golf ponds and channels — flat, dark, and never a building.
  water: `
    way["natural"="water"](${BBOX});
    way["waterway"~"^(river|stream|canal|ditch)$"](${BBOX});
    relation["natural"="water"](${BBOX});`,
};

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(LAYERS);

for (const name of want) {
  const body = LAYERS[name];
  if (!body) { console.error('unknown layer ' + name); continue; }
  const file = OUT + '/' + name + '.json';
  if (existsSync(file) && statSync(file).size > 1000) {
    console.log(name.padEnd(11) + ' cached (' + (statSync(file).size / 1e6).toFixed(1) + ' MB)');
    continue;
  }
  const q = '[out:json][timeout:900][maxsize:1073741824];(' + body + '\n);out geom;';
  console.log(name.padEnd(11) + ' fetching…');
  const t0 = Date.now();
  let text = null;
  for (let attempt = 0; attempt < 24 && text === null; attempt++) {
    const ep = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(ep, {
        method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        signal: AbortSignal.timeout(900000),
      });
      const t = await res.text();
      if (res.ok && t.startsWith('{')) { text = t; break; }
      throw new Error('HTTP ' + res.status + ' ' + t.replace(/\s+/g, ' ').slice(0, 100));
    } catch (e) {
      const wait = Math.min(180, 15 * (1 + Math.floor(attempt / ENDPOINTS.length) * 2));
      console.log('  ' + new URL(ep).host + ': ' + e.message + ' — retry in ' + wait + ' s');
      await new Promise(r => setTimeout(r, wait * 1000));
    }
  }
  if (text === null) { console.log('  ' + name + ' GAVE UP'); continue; }
  writeFileSync(file, text);
  const n = JSON.parse(text).elements.length;
  console.log((text.length / 1e6).toFixed(1) + ' MB, ' + n + ' elements, ' +
              ((Date.now() - t0) / 1000).toFixed(0) + ' s');
  await new Promise(r => setTimeout(r, 5000));
}
