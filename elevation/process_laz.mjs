import { readFileSync, writeFileSync } from 'fs';
import zlib from 'zlib';
import lp from 'laz-perf';
const createLazPerf = lp.createLazPerf || lp.create;

// ---- config ----
const CELL = 0.5;                 // meters per grid cell
const HALF = 160;                 // clip half-size (m) -> 320m box
const ADDR_E = 548660.3, ADDR_N = 3744180.9;   // address in UTM11N
const X0 = Math.floor((ADDR_E - HALF)/CELL)*CELL;
const Y0 = Math.floor((ADDR_N - HALF)/CELL)*CELL;
const NC = Math.round((2*HALF)/CELL), NR = NC;
const X1 = X0 + NC*CELL, Y1 = Y0 + NR*CELL;
console.log(`Clip box E[${X0}..${X1}] N[${Y0}..${Y1}]  grid ${NC}x${NR} @ ${CELL}m`);

const buf = readFileSync('raw/LPC_SaltonSea_2021_11SNT480440.laz');
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const xs=dv.getFloat64(131,true),ys=dv.getFloat64(139,true),zs=dv.getFloat64(147,true);
const xo=dv.getFloat64(155,true),yo=dv.getFloat64(163,true),zo=dv.getFloat64(171,true);

const mod = await createLazPerf();
const z = new mod.LASZip();
const fptr = mod._malloc(buf.length);
mod.HEAPU8.set(buf, fptr);
z.open(fptr, buf.length);
const count = z.getCount();
const ptLen = z.getPointLength();
const fmt = z.getPointFormat() & 0x3f;
const classOff = fmt >= 6 ? 16 : 15;
console.log(`points ${count.toLocaleString()} ptLen ${ptLen} fmt ${fmt} classOff ${classOff}`);

const dsm = new Float32Array(NC*NR).fill(NaN);  // max Z all returns
const dtm = new Float32Array(NC*NR).fill(NaN);  // ground (class 2) min Z
const dest = mod._malloc(ptLen);
const i32 = mod.HEAP32, u8 = mod.HEAPU8;
const di = dest>>2;
let kept=0;
for (let i=0;i<count;i++){
  z.getPoint(dest);
  const X=i32[di], Y=i32[di+1], Z=i32[di+2];
  const e = X*xs+xo, n = Y*ys+yo;
  if (e<X0||e>=X1||n<Y0||n>=Y1) continue;
  const zz = Z*zs+zo;
  const cls = u8[dest+classOff];
  if (cls===7 || cls===18 || cls===20) continue;   // minimal denoise: drop low/high noise + nonstandard class 20
  const col = (e-X0)/CELL|0;
  const row = (n-Y0)/CELL|0;           // row from bottom (south)
  const idx = row*NC+col;
  if (!(dsm[idx]>=zz)) dsm[idx]=zz;     // max (NaN-safe)
  if (cls===2){ if(!(dtm[idx]<=zz)) dtm[idx]=zz; } // ground min
  kept++;
}
console.log(`kept ${kept.toLocaleString()} points in clip`);

// ---- fill small holes (iterative 8-neighbour mean) for a clean heightmap ----
function fillHoles(g, passes){
  for(let p=0;p<passes;p++){
    let filled=0;
    const cp=Float32Array.from(g);
    for(let r=0;r<NR;r++)for(let c=0;c<NC;c++){
      const id=r*NC+c; if(!Number.isNaN(cp[id]))continue;
      let s=0,k=0;
      for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
        const rr=r+dr,cc=c+dc; if(rr<0||rr>=NR||cc<0||cc>=NC)continue;
        const v=cp[rr*NC+cc]; if(!Number.isNaN(v)){s+=v;k++;}
      }
      if(k>=3){g[id]=s/k;filled++;}
    }
    if(!filled)break;
  }
}
const dsmFilled=Float32Array.from(dsm); fillHoles(dsmFilled,12);
const dtmFilled=Float32Array.from(dtm); fillHoles(dtmFilled,30);

// ---- stats ----
function stats(g){let mn=Infinity,mx=-Infinity,n=0;for(const v of g){if(!Number.isNaN(v)){if(v<mn)mn=v;if(v>mx)mx=v;n++;}}return{mn,mx,n};}
const sD=stats(dsmFilled), sT=stats(dtmFilled);
console.log(`DSM z ${sD.mn.toFixed(2)}..${sD.mx.toFixed(2)}m  filled cells ${sD.n}/${NC*NR}`);
console.log(`DTM z ${sT.mn.toFixed(2)}..${sT.mx.toFixed(2)}m  filled cells ${sT.n}/${NC*NR}`);

// ---- write Esri ASCII grid (rows north->south) ----
function writeAsc(path, g){
  const lines=[`ncols ${NC}`,`nrows ${NR}`,`xllcorner ${X0}`,`yllcorner ${Y0}`,`cellsize ${CELL}`,`NODATA_value -9999`];
  for(let r=NR-1;r>=0;r--){ // top row = north
    const row=new Array(NC);
    for(let c=0;c<NC;c++){const v=g[r*NC+c];row[c]=Number.isNaN(v)?'-9999':v.toFixed(2);}
    lines.push(row.join(' '));
  }
  writeFileSync(path, lines.join('\n'));
}
writeAsc('alva_dsm_0p5m.asc', dsmFilled);
writeAsc('alva_dtm_0p5m.asc', dtmFilled);

// ---- minimal 16-bit grayscale PNG (north up) ----
function crc32(b){let c=~0;for(let i=0;i<b.length;i++){c^=b[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return ~c>>>0;}
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const t=Buffer.from(type,'ascii');const body=Buffer.concat([t,data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body));return Buffer.concat([len,body,crc]);}
function writePNG16(path,g,mn,mx){
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(NC,0);ihdr.writeUInt32BE(NR,4);ihdr[8]=16;ihdr[9]=0;//gray16
  const raw=Buffer.alloc(NR*(1+NC*2));let o=0;const rng=(mx-mn)||1;
  for(let r=NR-1;r>=0;r--){raw[o++]=0;for(let c=0;c<NC;c++){let v=g[r*NC+c];if(Number.isNaN(v))v=mn;let s=Math.round((v-mn)/rng*65535);if(s<0)s=0;if(s>65535)s=65535;raw[o++]=s>>8;raw[o++]=s&255;}}
  const idat=zlib.deflateSync(raw,{level:9});
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',idat),chunk('IEND',Buffer.alloc(0))]);
  writeFileSync(path,png);
}
writePNG16('alva_dsm_heightmap_16bit.png', dsmFilled, sD.mn, sD.mx);

// ---- georef + integration meta ----
const M2FT=3.280839895;
const meta={
  source:'USGS 3DEP LiDAR CA_SaltonSea_EarthMRI_2021_D21 tile 11SNT480440 (flown 2021)',
  crs:'UTM Zone 11N, NAD83 (EPSG:26911); vertical NAVD88 meters',
  address:'68075 Alva Court, Cathedral City CA 92234',
  addressUTM:{east:ADDR_E,north:ADDR_N},
  grid:{ncols:NC,nrows:NR,cellSize_m:CELL,xllcorner:X0,yllcorner:Y0},
  dsm:{min_m:sD.mn,max_m:sD.mx,min_ft:sD.mn*M2FT,max_ft:sD.mx*M2FT,relief_ft:(sD.mx-sD.mn)*M2FT},
  dtm:{min_m:sT.mn,max_m:sT.mx},
  heightmap_png:{file:'alva_dsm_heightmap_16bit.png',encoding:'16-bit grayscale, 0=min .. 65535=max, north up',
    decode:'elevation_m = min_m + (gray/65535)*(max_m-min_m)'},
};
writeFileSync('alva_dsm_meta.json', JSON.stringify(meta,null,2));
console.log('WROTE alva_dsm_0p5m.asc, alva_dtm_0p5m.asc, alva_dsm_heightmap_16bit.png, alva_dsm_meta.json');
z.delete(); mod._free(fptr); mod._free(dest);
