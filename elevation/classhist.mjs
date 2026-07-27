// Diagnostic: histogram ASPRS classification + return structure in the LAZ.
// Answers: is the cloud classified (trees/buildings tagged)? does it carry
// multi-return data (the palm-vs-pole discriminator)?  Global + scene-clip.
import { readFileSync } from 'fs';
import lp from 'laz-perf';
const createLazPerf = lp.createLazPerf || lp.create;

const CELL = 0.5, HALF = 160;
const ADDR_E = 548660.3, ADDR_N = 3744180.9;
const X0 = Math.floor((ADDR_E - HALF) / CELL) * CELL;
const Y0 = Math.floor((ADDR_N - HALF) / CELL) * CELL;
const X1 = X0 + (2 * HALF), Y1 = Y0 + (2 * HALF);

const ASPRS = {
  0: 'never classified', 1: 'unassigned', 2: 'ground', 3: 'low veg',
  4: 'med veg', 5: 'high veg (trees)', 6: 'building', 7: 'low point/noise',
  9: 'water', 10: 'rail', 11: 'road surface', 17: 'bridge deck', 18: 'high noise',
};

const buf = readFileSync('raw/LPC_SaltonSea_2021_11SNT480440.laz');
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const xs = dv.getFloat64(131, true), ys = dv.getFloat64(139, true), zs = dv.getFloat64(147, true);
const xo = dv.getFloat64(155, true), yo = dv.getFloat64(163, true), zo = dv.getFloat64(171, true);

const mod = await createLazPerf();
const z = new mod.LASZip();
const fptr = mod._malloc(buf.length);
mod.HEAPU8.set(buf, fptr);
z.open(fptr, buf.length);
const count = z.getPointLength && z.getCount();
const ptLen = z.getPointLength();
const fmt = z.getPointFormat() & 0x3f;
const classOff = fmt >= 6 ? 16 : 15;
const retOff = 14;
console.log(`point format ${fmt} · ptLen ${ptLen} · ${count.toLocaleString()} points\n`);

const dest = mod._malloc(ptLen);
const i32 = mod.HEAP32, u8 = mod.HEAPU8;
const di = dest >> 2;

const clsAll = {}, clsBox = {};
const nretAll = {}, nretBox = {};
let inBox = 0, multiAll = 0;
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

for (let i = 0; i < count; i++) {
  z.getPoint(dest);
  const X = i32[di], Y = i32[di + 1];
  const e = X * xs + xo, n = Y * ys + yo;

  let cls = u8[dest + classOff];
  if (fmt < 6) cls &= 0x1f;                     // legacy: strip flag bits
  const rb = u8[dest + retOff];
  const nret = fmt >= 6 ? (rb >> 4) & 0x0f : (rb >> 3) & 0x07;

  bump(clsAll, cls);
  bump(nretAll, nret);
  if (nret > 1) multiAll++;

  if (e >= X0 && e < X1 && n >= Y0 && n < Y1) {
    inBox++;
    bump(clsBox, cls);
    bump(nretBox, nret);
  }
}

function report(title, hist, total) {
  console.log(`── ${title}  (${total.toLocaleString()} pts) ──`);
  for (const k of Object.keys(hist).map(Number).sort((a, b) => a - b)) {
    const pct = (100 * hist[k] / total).toFixed(1).padStart(5);
    console.log(`  class ${String(k).padStart(2)}  ${pct}%  ${hist[k].toLocaleString().padStart(12)}  ${ASPRS[k] || '?'}`);
  }
}
report('CLASSIFICATION — whole tile', clsAll, count);
console.log();
report('CLASSIFICATION — Alva Court 320m clip', clsBox, inBox);

console.log(`\n── RETURN STRUCTURE (multi-return = porous/vegetation signal) ──`);
console.log(`  whole tile: ${(100 * multiAll / count).toFixed(1)}% of pulses are multi-return`);
const nrLine = (h, t) => Object.keys(h).map(Number).sort((a, b) => a - b)
  .map(k => `${k}:${(100 * h[k] / t).toFixed(1)}%`).join('  ');
console.log(`  # returns, whole tile:  ${nrLine(nretAll, count)}`);
console.log(`  # returns, clip box:    ${nrLine(nretBox, inBox)}`);

z.delete(); mod._free(fptr); mod._free(dest);
