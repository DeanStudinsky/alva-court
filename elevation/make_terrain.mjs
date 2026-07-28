import { readFileSync, writeFileSync } from 'fs';
const FT = 3.280839895;
const ADDR_E = 548660.3, ADDR_N = 3744180.9;
function readAsc(p){
  const t=readFileSync(p,'utf8').split('\n');const h={};let li=0;
  for(;li<6;li++){const[k,v]=t[li].trim().split(/\s+/);h[k.toLowerCase()]=parseFloat(v);}
  const NC=h.ncols,NR=h.nrows;const g=new Float32Array(NC*NR); // row0 = SOUTH
  for(let line=0;line<NR;line++){const r=NR-1-line;const vals=t[li+line].trim().split(/\s+/);
    for(let c=0;c<NC;c++){const v=+vals[c];g[r*NC+c]=(v===-9999)?NaN:v;}}
  return {g,NC,NR,cell:h.cellsize,x0:h.xllcorner,y0:h.yllcorner};
}
// Env overrides let one script pack either tile. Both MUST share baseFt so the
// detail tile and the wide tile sit on the same y=0 datum in the scene.
//   ALVA_IN=wide ALVA_OUT=terrain_wide ALVA_BASE_FT=399.57349381574863 node make_terrain.mjs
const IN  = process.env.ALVA_IN  ?? null;
const OUT = process.env.ALVA_OUT ?? 'terrain';
const dsm=readAsc(IN ? `${IN}_dsm.asc` : 'alva_dsm_0p5m.asc');
const dtm=readAsc(IN ? `${IN}_dtm.asc` : 'alva_dtm_0p5m.asc');
const NC=dsm.NC,NR=dsm.NR;

// base elevation = DTM at the address cell -> scene sits near y=0
const ac=Math.round((ADDR_E-dsm.x0)/dsm.cell), ar=Math.round((ADDR_N-dsm.y0)/dsm.cell);
const baseM=process.env.ALVA_BASE_FT ? +process.env.ALVA_BASE_FT/FT : dtm.g[ar*NC+ac];
console.log('base (ground @ address) =',baseM.toFixed(2),'m =',(baseM*FT).toFixed(2),'ft');

// pack: feet absolute, NaN->base for safety
const dsmFt=new Float32Array(NC*NR), dtmFt=new Float32Array(NC*NR);
for(let i=0;i<NC*NR;i++){dsmFt[i]=(Number.isNaN(dsm.g[i])?baseM:dsm.g[i])*FT; dtmFt[i]=(Number.isNaN(dtm.g[i])?baseM:dtm.g[i])*FT;}

// terrain.bin = [DSM ft][DTM ft] Float32LE, row0=south col0=west
const buf=Buffer.alloc(NC*NR*4*2);
for(let i=0;i<NC*NR;i++)buf.writeFloatLE(dsmFt[i],i*4);
for(let i=0;i<NC*NR;i++)buf.writeFloatLE(dtmFt[i],(NC*NR+i)*4);
writeFileSync(`${OUT}.bin`,buf);

// road centerline (TIGER, UTM11N) -> local feet (x=E, z=-N rel address)
const roadUTM=[[548618.7,3744187.4],[548640.1,3744187.3],[548679.3,3744187.4],[548701.9,3744189.4],[548704.1,3744189.7],[548719.7,3744192.3],[548725.2,3744193.6]];
const road=roadUTM.map(([e,n])=>[ (e-ADDR_E)*FT, -(n-ADDR_N)*FT ]);

const meta={
  note:'Elevations in FEET (NAVD88). Grid row0=SOUTH, col0=WEST. World: +X=East, +Z=South, North=-Z. Subtract baseFt for y near 0.',
  source:'USGS 3DEP DSM/DTM, CA_SaltonSea_EarthMRI_2021_D21 (flown 2021)',
  nc:NC, nr:NR, cellFt:dsm.cell*FT, cellM:dsm.cell,
  utm:{x0:dsm.x0,y0:dsm.y0,addrE:ADDR_E,addrN:ADDR_N},
  baseFt:baseM*FT,
  bin:{file:`${OUT}.bin`,layout:'Float32LE: DSM[nc*nr] then DTM[nc*nr]'},
  road:{entranceLocalFt:road[0], bulbLocalFt:road[road.length-1], centerlineLocalFt:road,
        widthFt:22, bearingDeg:86.7},
  address:{localFt:[0,0], lonlat:[-116.474082,33.836760]},
  sizeFt:[NC*dsm.cell*FT, NR*dsm.cell*FT]
};
writeFileSync(`${OUT}_meta.json`,JSON.stringify(meta,null,2));
console.log('grid',NC,'x',NR,'cell',(dsm.cell*FT).toFixed(2),'ft  extent',(NC*dsm.cell*FT).toFixed(0),'ft sq');
console.log('road entrance(W) local ft',road[0].map(v=>v.toFixed(1)),' bulb(E)',road[road.length-1].map(v=>v.toFixed(1)));
console.log(`wrote ${OUT}.bin`,(buf.length/1e6).toFixed(2),'MB +',`${OUT}_meta.json`);
