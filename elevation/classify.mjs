// Cross-check classifier for Alva Court.
// Produces TWO independent per-cell classifications from the LiDAR:
//   A) return-structure route: tall + porous(multi-return) => tree, else building
//   B) surface-geometry route: tall + planar => building, else tree
// Ground gate is shared (undisputed). Disagreement between A and B = the cells
// worth a human glance. Outputs classify.bin (+ meta) for classify_review.html.
//
// Grid matches terrain.bin exactly: 640x640 @ 0.5m, row0=SOUTH, col0=WEST,
// UTM11N origin 548500 E / 3744020.5 N.  nDSM/DTM come from terrain.bin (feet,
// already hole-filled); multi-return stats come from one pass over the LAZ.
import { readFileSync, writeFileSync } from 'fs';
import lp from 'laz-perf';
const createLazPerf = lp.createLazPerf || lp.create;

const NC = 640, NR = 640, N = NC * NR;
const CELL = 0.5, FT = 3.280839895;
const X0 = 548500, Y0 = 3744020.5;
const GROUND_FT = 2 * FT;                 // nDSM below this = ground

// ---- height from terrain.bin (feet): [DSM N][DTM N] ----
const tb = readFileSync('terrain.bin');
const dsmFt = new Float32Array(tb.buffer, tb.byteOffset, N);
const dtmFt = new Float32Array(tb.buffer, tb.byteOffset + N * 4, N);
const ndsm = new Float32Array(N);
for (let i = 0; i < N; i++) ndsm[i] = dsmFt[i] - dtmFt[i];

// ---- local surface roughness (std of nDSM in 3x3) ----
const rough = new Float32Array(N);
for (let r = 0; r < NR; r++) for (let c = 0; c < NC; c++) {
  let s = 0, s2 = 0, k = 0;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const rr = r + dr, cc = c + dc;
    if (rr < 0 || rr >= NR || cc < 0 || cc >= NC) continue;
    const v = ndsm[rr * NC + cc]; s += v; s2 += v * v; k++;
  }
  const m = s / k; rough[r * NC + c] = Math.sqrt(Math.max(0, s2 / k - m * m));
}

// ---- multi-return fraction per cell (one LAZ pass) ----
const total = new Uint32Array(N), multi = new Uint32Array(N);
{
  const buf = readFileSync('raw/LPC_SaltonSea_2021_11SNT480440.laz');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const xs = dv.getFloat64(131, true), ys = dv.getFloat64(139, true);
  const xo = dv.getFloat64(155, true), yo = dv.getFloat64(163, true);
  const mod = await createLazPerf();
  const z = new mod.LASZip();
  const fptr = mod._malloc(buf.length); mod.HEAPU8.set(buf, fptr); z.open(fptr, buf.length);
  const count = z.getCount(), ptLen = z.getPointLength();
  const fmt = z.getPointFormat() & 0x3f;
  const dest = mod._malloc(ptLen); const i32 = mod.HEAP32, u8 = mod.HEAPU8; const di = dest >> 2;
  for (let i = 0; i < count; i++) {
    z.getPoint(dest);
    const e = i32[di] * xs + xo, n = i32[di + 1] * ys + yo;
    const col = (e - X0) / CELL | 0, row = (n - Y0) / CELL | 0;
    if (col < 0 || col >= NC || row < 0 || row >= NR) continue;
    const rb = u8[dest + 14];
    const nret = fmt >= 6 ? (rb >> 4) & 0x0f : (rb >> 3) & 0x07;
    const idx = row * NC + col;
    total[idx]++; if (nret > 1) multi[idx]++;
  }
  z.delete(); mod._free(fptr); mod._free(dest);
}
const mfrac = new Float32Array(N);
for (let i = 0; i < N; i++) mfrac[i] = total[i] ? multi[i] / total[i] : 0;

// ---- data-driven thresholds over the disputed (tall) cells ----
const tall = [];
for (let i = 0; i < N; i++) if (ndsm[i] >= GROUND_FT) tall.push(i);
const median = (arr, pick) => { const a = arr.map(pick).sort((x, y) => x - y); return a[a.length >> 1]; };
const mean = (arr, pick) => arr.reduce((s, i) => s + pick(i), 0) / arr.length;
const THR_MULTI = Math.max(0.10, mean(tall, i => mfrac[i]));   // porosity cutoff
const THR_ROUGH = median(tall, i => rough[i]);                 // planarity cutoff (ft std)

// ---- classify: 0 ground, 1 tree, 2 building ----
const labelA = new Uint8Array(N), labelB = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  if (ndsm[i] < GROUND_FT) { labelA[i] = labelB[i] = 0; continue; }
  labelA[i] = mfrac[i] > THR_MULTI ? 1 : 2;          // returns route
  labelB[i] = rough[i] > THR_ROUGH ? 1 : 2;          // geometry route
}

// ---- continuous discrepancy: |treeness_returns - treeness_geometry| ----
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const disc = new Float32Array(N);
for (const i of tall) {
  const tR = clamp01(mfrac[i] / (2 * THR_MULTI));
  const tG = clamp01(rough[i] / (2 * THR_ROUGH));
  disc[i] = Math.abs(tR - tG);
}
const discMean = mean(tall, i => disc[i]);
let agree = 0; for (const i of tall) if (labelA[i] === labelB[i]) agree++;

// ---- pack classify.bin: 6 bytes/cell [A,B,nDSM,mfrac,rough,disc] (row0=south) ----
const NDSM_MAX = 40, ROUGH_MAX = 6;   // ft, for byte scaling in the GUI
const out = Buffer.alloc(N * 6);
for (let i = 0; i < N; i++) {
  const o = i * 6;
  out[o] = labelA[i]; out[o + 1] = labelB[i];
  out[o + 2] = Math.min(255, ndsm[i] / NDSM_MAX * 255) | 0;
  out[o + 3] = Math.min(255, mfrac[i] * 255) | 0;
  out[o + 4] = Math.min(255, rough[i] / ROUGH_MAX * 255) | 0;
  out[o + 5] = Math.min(255, disc[i] * 255) | 0;
}
writeFileSync('classify.bin', out);
writeFileSync('classify_meta.json', JSON.stringify({
  nc: NC, nr: NR, cellFt: CELL * FT, rowOrder: 'row0=south, col0=west',
  bin: { file: 'classify.bin', bytesPerCell: 6, layout: '[labelA,labelB,nDSM,mfrac,rough,disc] uint8' },
  labels: { 0: 'ground', 1: 'tree', 2: 'building' },
  scaling: { nDSM_maxFt: NDSM_MAX, rough_maxFt: ROUGH_MAX, mfrac: '0..1', disc: '0..1' },
  thresholds: { multiReturnFrac: THR_MULTI, roughnessFt: THR_ROUGH, groundFt: GROUND_FT },
  stats: { tallCells: tall.length, agreementPct: 100 * agree / tall.length, discMean },
  addressCell: { col: Math.round((548660.3 - X0) / CELL), row: Math.round((3744180.9 - Y0) / CELL) },
}, null, 2));

console.log(`tall cells ${tall.length}  |  A/B agreement ${(100 * agree / tall.length).toFixed(1)}%`);
console.log(`THR multi-return ${THR_MULTI.toFixed(3)}  THR roughness ${THR_ROUGH.toFixed(2)} ft`);
console.log(`mean discrepancy ${discMean.toFixed(3)}  |  wrote classify.bin (${(out.length/1e6).toFixed(2)} MB) + classify_meta.json`);
