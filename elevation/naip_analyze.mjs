// NAIP cross-check (Source C) + per-house registry for Alva Court.
//
// Adds a THIRD independent opinion to the LiDAR routes A (returns) and B
// (geometry): NDVI from NAIP 4-band imagery. Healthy/irrigated vegetation is
// bright in NIR and dark in red -> high NDVI; roofs, asphalt and bare desert
// are low. That makes NDVI a clean tree-vs-building tie-breaker the LiDAR
// cannot see.
//
// Also clusters the consensus building cells into individual HOUSE objects with
// stable IDs, local-ft centroids, footprints and a median roof colour sampled
// straight from NAIP. houses.json is the registry the user's Street View
// screenshots attach to (by id), and the seed for adding doors/windows.
//
// Grid is identical to terrain.bin / classify.bin: 640x640 @ 0.5m,
// row0 = SOUTH, col0 = WEST, UTM11N origin 548500 E / 3744020.5 N.
// NAIP PNGs are north-up (png row0 = NORTH) so rows are FLIPPED on read.
import { readFileSync, writeFileSync } from 'fs';
import { PNG } from 'pngjs';

const NC = 640, NR = 640, N = NC * NR;
const CELL = 0.5, FT = 3.280839895, cellFt = CELL * FT;
const X0 = 548500, Y0 = 3744020.5;
const ADDR_E = 548660.3, ADDR_N = 3744180.9;
const addrCol = Math.round((ADDR_E - X0) / CELL);
const addrRow = Math.round((ADDR_N - Y0) / CELL);
const GROUND_FT = 2 * FT;
const THR_NDVI = 0.20;            // >= this = vegetation (rough; desert summer NAIP)

// ---- read the two LiDAR routes (classify.bin: 6 bytes/cell [A,B,nDSM,mfrac,rough,disc]) ----
const cb = readFileSync('classify.bin');
const A = i => cb[i * 6], B = i => cb[i * 6 + 1];
const ndsmByte = i => cb[i * 6 + 2];              // 0..255 over 0..40 ft

// ---- read terrain.bin (feet, [DSM N][DTM N]) for true per-house heights ----
// classify.bin's nDSM byte is quantised to 40ft/255; the float grids are exact.
const tb = readFileSync('terrain.bin');
const dsmFt = new Float32Array(tb.buffer, tb.byteOffset, N);
const dtmFt = new Float32Array(tb.buffer, tb.byteOffset + N * 4, N);

// ---- read NAIP (pngjs expands every source to RGBA in .data) ----
const rgb = PNG.sync.read(readFileSync('naip/naip_rgb.png'));
const red = PNG.sync.read(readFileSync('naip/naip_red.png'));
const nir = PNG.sync.read(readFileSync('naip/naip_nir.png'));
// grid cell (row r from south, col c) -> png pixel (row NR-1-r from top, col c)
const pngIdx = (r, c) => ((NR - 1 - r) * NC + c) * 4;

// per-cell NAIP-derived arrays (grid order, row0=south)
const ndvi = new Float32Array(N);
const roofR = new Uint8Array(N), roofG = new Uint8Array(N), roofB = new Uint8Array(N);
const labelC = new Uint8Array(N);                 // 0 ground, 1 tree/veg, 2 building
for (let r = 0; r < NR; r++) for (let c = 0; c < NC; c++) {
  const i = r * NC + c, p = pngIdx(r, c);
  const R = red.data[p], IR = nir.data[p];
  const nd = (IR + R) ? (IR - R) / (IR + R) : 0;
  ndvi[i] = nd;
  roofR[i] = rgb.data[p]; roofG[i] = rgb.data[p + 1]; roofB[i] = rgb.data[p + 2];
  const tall = ndsmByte(i) / 255 * 40 >= GROUND_FT / 1;   // ndsm ft >= GROUND_FT
  labelC[i] = !tall ? 0 : (nd >= THR_NDVI ? 1 : 2);
}

// ---- 3-way cross-check over tall cells ----
const tall = [];
for (let i = 0; i < N; i++) if (A(i) !== 0) tall.push(i);   // A tags ground as 0 too
let agree3 = 0, agree2 = 0, split = 0;
const consensus = new Uint8Array(N);              // majority of A,B,C (0 if ground)
for (const i of tall) {
  const v = [A(i), B(i), labelC[i]];
  const nb = v.filter(x => x === 2).length;       // building votes
  const nt = v.filter(x => x === 1).length;       // tree votes
  consensus[i] = nb >= nt ? 2 : 1;
  if (nb === 3 || nt === 3) agree3++;
  else if (nb === 2 || nt === 2) agree2++;
  else split++;                                    // (can't happen with 3 votes, kept for clarity)
}

// ---- cluster consensus BUILDING cells into houses (8-connected) ----
const isB = new Uint8Array(N);
for (const i of tall) if (consensus[i] === 2) isB[i] = 1;
const MIN_CELLS = 150;                             // ~400 sqft footprint floor (drop sheds/clutter)
const comp = new Int32Array(N).fill(-1);
const houses = [];
const stack = [];
for (let s = 0; s < N; s++) {
  if (!isB[s] || comp[s] !== -1) continue;
  const id = houses.length;
  let n = 0, sc = 0, sr = 0, minc = NC, maxc = 0, minr = NR, maxr = 0;
  const cells = [];
  stack.length = 0; stack.push(s); comp[s] = id;
  while (stack.length) {
    const p = stack.pop(); const r = p / NC | 0, c = p % NC;
    n++; sc += c; sr += r; cells.push(p);
    if (c < minc) minc = c; if (c > maxc) maxc = c;
    if (r < minr) minr = r; if (r > maxr) maxr = r;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= NR || cc < 0 || cc >= NC) continue;
      const q = rr * NC + cc;
      if (isB[q] && comp[q] === -1) { comp[q] = id; stack.push(q); }
    }
  }
  if (n < MIN_CELLS) { for (const q of cells) comp[q] = -2; continue; } // reject; mark rejected
  // median roof colour over this house's cells
  const rs = [], gs = [], bs = [], nds = [];
  for (const q of cells) { rs.push(roofR[q]); gs.push(roofG[q]); bs.push(roofB[q]); nds.push(ndvi[q]); }
  const med = arr => { arr.sort((x, y) => x - y); return arr[arr.length >> 1]; };
  const pct = (arr, p) => { arr.sort((x, y) => x - y); return arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]; };
  const mR = med(rs), mG = med(gs), mB = med(bs);
  // heights straight off the float grids: nDSM = roof surface - bare earth.
  // median = the flat bulk of the roof (eave/deck height), p90 = ridge/parapet.
  // groundFt is the pad the house sits on, absolute NAVD88 ft (scene subtracts baseFt).
  const nd_ = cells.map(q => dsmFt[q] - dtmFt[q]);
  const gr_ = cells.map(q => dtmFt[q]);
  const hex = '#' + [mR, mG, mB].map(v => v.toString(16).padStart(2, '0')).join('');
  const cc = sc / n, cr = sr / n;                 // centroid col,row (from south)
  houses.push({
    id,
    cellCount: n,
    footprint_sqft: +(n * cellFt * cellFt).toFixed(0),
    centroidCell: { col: +cc.toFixed(1), row: +cr.toFixed(1) },
    // local ft offset from the street address (E = +X, N = +Z-north); matches scene axes
    centerLocalFt: { E: +((cc - addrCol) * cellFt).toFixed(1), N: +((cr - addrRow) * cellFt).toFixed(1) },
    bboxLocalFt: {
      E0: +((minc - addrCol) * cellFt).toFixed(1), E1: +((maxc - addrCol) * cellFt).toFixed(1),
      N0: +((minr - addrRow) * cellFt).toFixed(1), N1: +((maxr - addrRow) * cellFt).toFixed(1),
      widthFt: +((maxc - minc + 1) * cellFt).toFixed(1), depthFt: +((maxr - minr + 1) * cellFt).toFixed(1),
    },
    roofColor: hex,
    roofRGB: [mR, mG, mB],
    heightFt: +med(nd_.slice()).toFixed(1),        // eave / flat-roof deck
    ridgeFt: +pct(nd_.slice(), 0.9).toFixed(1),    // top of roof
    groundFt: +med(gr_.slice()).toFixed(2),        // absolute pad elevation, NAVD88 ft
    meanNDVI: +(nds.reduce((a, b) => a + b, 0) / n).toFixed(3),
    streetView: null,                             // <- user attaches a screenshot filename/id here
  });
}
// stable-ish ordering: nearest the address first (so #0 is the subject house)
houses.sort((a, b) => Math.hypot(a.centerLocalFt.E, a.centerLocalFt.N) - Math.hypot(b.centerLocalFt.E, b.centerLocalFt.N));
const remap = new Int32Array(houses.length);      // pre-sort id -> post-sort id
houses.forEach((h, k) => { remap[h.id] = k; h.id = k; });

// ---- houses.bin: the actual per-cell footprint mask the 3D scene extrudes ----
// Uint16LE, one per grid cell, row0=south/col0=west like every other grid here.
// 0 = not a house; otherwise houseId + 1 (so id 0 is representable).
const mask = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) {
  const c = comp[i];                              // -1 = never visited, -2 = rejected (too small)
  if (c >= 0) mask.writeUInt16LE(remap[c] + 1, i * 2);
}
writeFileSync('houses.bin', mask);

// ---- pack naip.bin: 5 bytes/cell [labelC, ndviByte, R, G, B] (row0=south) ----
const out = Buffer.alloc(N * 5);
for (let i = 0; i < N; i++) {
  const o = i * 5;
  out[o] = labelC[i];
  out[o + 1] = Math.max(0, Math.min(255, Math.round((ndvi[i] + 1) / 2 * 255)));
  out[o + 2] = roofR[i]; out[o + 3] = roofG[i]; out[o + 4] = roofB[i];
}
writeFileSync('naip.bin', out);

// ---- also stamp each house's consensus footprint into a compact map for the GUI ----
writeFileSync('houses.json', JSON.stringify({
  source: 'NAIP USDA_CONUS_PRIME exportImage, EPSG:26911, 640x640 @0.5m, pixel-aligned to terrain.bin',
  addressCell: { col: addrCol, row: addrRow },
  cellFt, thrNDVI: THR_NDVI, minFootprintCells: MIN_CELLS,
  count: houses.length,
  mask: {
    file: 'houses.bin',
    layout: 'Uint16LE per cell, 640x640, row0=south col0=west; 0=none else houseId+1',
  },
  heights: 'heightFt/ridgeFt = nDSM median/p90 over the house cells; groundFt = median DTM (absolute NAVD88 ft)',
  crossCheck: {
    tallCells: tall.length,
    agree3of3: agree3, agree2of3: agree2,
    pctUnanimous: +(100 * agree3 / tall.length).toFixed(1),
  },
  houses,
}, null, 2));

writeFileSync('naip_meta.json', JSON.stringify({
  nc: NC, nr: NR, cellFt, rowOrder: 'row0=south, col0=west',
  bin: { file: 'naip.bin', bytesPerCell: 5, layout: '[labelC,ndvi,R,G,B] uint8', ndvi: 'byte=(ndvi+1)/2*255' },
  labels: { 0: 'ground', 1: 'tree/veg', 2: 'building' },
  thrNDVI: THR_NDVI,
  crossCheck3way: { tallCells: tall.length, agree3of3: agree3, agree2of3: agree2, pctUnanimous: +(100 * agree3 / tall.length).toFixed(1) },
}, null, 2));

console.log(`NDVI Source C done. tall cells ${tall.length}`);
console.log(`3-way: unanimous ${agree3} (${(100 * agree3 / tall.length).toFixed(1)}%)  2-of-3 ${agree2}`);
console.log(`houses detected (>=${MIN_CELLS} cells): ${houses.length}`);
console.log(`subject house #0: ${houses[0] ? houses[0].footprint_sqft + ' sqft roof ' + houses[0].roofColor + ' @ E' + houses[0].centerLocalFt.E + ' N' + houses[0].centerLocalFt.N : 'none'}`);
console.log('wrote naip.bin, naip_meta.json, houses.json');
