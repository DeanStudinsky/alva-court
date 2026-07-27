import { readFileSync, writeFileSync } from 'fs';
import zlib from 'zlib';
function readAsc(p){const t=readFileSync(p,'utf8').split('\n');const h={};let li=0;for(;li<6;li++){const[k,v]=t[li].trim().split(/\s+/);h[k.toLowerCase()]=parseFloat(v);}const NC=h.ncols,NR=h.nrows;const g=new Float32Array(NC*NR);for(let r=0;r<NR;r++){const vals=t[li+r].trim().split(/\s+/);for(let c=0;c<NC;c++){const v=+vals[c];g[(NR-1-r)*NC+c]=v===-9999?NaN:v;}}return{g,NC,NR,cell:h.cellsize,x0:h.xllcorner,y0:h.yllcorner};}
function crc32(b){let c=~0;for(let i=0;i<b.length;i++){c^=b[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return ~c>>>0;}
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const b=Buffer.concat([Buffer.from(t),d]);const cr=Buffer.alloc(4);cr.writeUInt32BE(crc32(b));return Buffer.concat([l,b,cr]);}
function writeRGB(path,NC,NR,rgb){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(NC,0);ihdr.writeUInt32BE(NR,4);ihdr[8]=8;ihdr[9]=2;const raw=Buffer.alloc(NR*(1+NC*3));let o=0;for(let r=0;r<NR;r++){raw[o++]=0;for(let c=0;c<NC;c++){const i=(r*NC+c)*3;raw[o++]=rgb[i];raw[o++]=rgb[i+1];raw[o++]=rgb[i+2];}}const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);writeFileSync(path,png);}

const {g,NC,NR,cell,x0,y0}=readAsc('alva_dsm_0p5m.asc');
// hillshade (north up: row0=south in g, but we output top=north)
const az=315*Math.PI/180, alt=45*Math.PI/180;
const lx=Math.cos(alt)*Math.cos(az), ly=Math.cos(alt)*Math.sin(az), lz=Math.sin(alt);
// percentile clip for color ramp
const sorted=Float32Array.from(g.filter(v=>!Number.isNaN(v))).sort();
const lo=sorted[(sorted.length*0.02)|0], hi=sorted[(sorted.length*0.98)|0];
const rgb=new Uint8Array(NC*NR*3);
const AE=548660.3, AN=3744180.9; // address
const ac=Math.round((AE-x0)/cell), ar=Math.round((AN-y0)/cell);
for(let R=0;R<NR;R++)for(let c=0;c<NC;c++){
  const r=NR-1-R; // g row from south; output R from north
  const gx=( (g[r*NC+Math.min(c+1,NC-1)]) - (g[r*NC+Math.max(c-1,0)]) )/(2*cell);
  const gy=( (g[Math.min(r+1,NR-1)*NC+c]) - (g[Math.max(r-1,0)*NC+c]) )/(2*cell);
  let nl=( -gx*lx - gy*ly + lz )/Math.sqrt(gx*gx+gy*gy+1);
  nl=Math.max(0,nl);
  const t=Math.max(0,Math.min(1,(g[r*NC+c]-lo)/(hi-lo)));
  // elevation ramp (dark blue low -> green -> tan high) modulated by hillshade
  const cr3=Math.round((60+t*180))*nl, cg=Math.round((90+t*120))*nl, cb=Math.round((70+(1-t)*120))*nl;
  const o=(R*NC+c)*3; rgb[o]=Math.min(255,cr3);rgb[o+1]=Math.min(255,cg);rgb[o+2]=Math.min(255,cb);
}
// mark address with red crosshair
function setpx(R,c,col){if(R<0||R>=NR||c<0||c>=NC)return;const o=(R*NC+c)*3;rgb[o]=col[0];rgb[o+1]=col[1];rgb[o+2]=col[2];}
const AR=NR-1-ar;
for(let d=-8;d<=8;d++){setpx(AR,ac+d,[255,30,30]);setpx(AR+d,ac,[255,30,30]);}
writeRGB('preview_dsm_hillshade.png',NC,NR,rgb);
console.log('wrote preview_dsm_hillshade.png',NC,'x',NR,'(red cross = your address)');
