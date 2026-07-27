import { readFileSync } from 'fs';
const buf = readFileSync('raw/LPC_SaltonSea_2021_11SNT480440.laz');
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const sig = String.fromCharCode(buf[0],buf[1],buf[2],buf[3]);
const vMaj = buf[24], vMin = buf[25];
const headerSize = dv.getUint16(94, true);
const offToPts = dv.getUint32(96, true);
const fmt = buf[104];
const ptLen = dv.getUint16(105, true);
const legacyCount = dv.getUint32(107, true);
const xs = dv.getFloat64(131,true), ys = dv.getFloat64(139,true), zs = dv.getFloat64(147,true);
const xo = dv.getFloat64(155,true), yo = dv.getFloat64(163,true), zo = dv.getFloat64(171,true);
const maxX=dv.getFloat64(179,true),minX=dv.getFloat64(187,true),maxY=dv.getFloat64(195,true),minY=dv.getFloat64(203,true),maxZ=dv.getFloat64(211,true),minZ=dv.getFloat64(219,true);
let count = legacyCount;
if (vMin>=4) { const c14 = dv.getBigUint64(247,true); if(c14>0n) count = Number(c14); }

// --- lon/lat -> UTM 11N (GRS80/WGS84) forward, Snyder ---
function toUTM(lon,lat,zone=11){
  const a=6378137.0, f=1/298.257223563, k0=0.9996;
  const e2=f*(2-f), ep2=e2/(1-e2);
  const lon0=(zone*6-183)*Math.PI/180;
  const rlat=lat*Math.PI/180, rlon=lon*Math.PI/180;
  const N=a/Math.sqrt(1-e2*Math.sin(rlat)**2);
  const T=Math.tan(rlat)**2, C=ep2*Math.cos(rlat)**2, A=(rlon-lon0)*Math.cos(rlat);
  const M=a*((1-e2/4-3*e2*e2/64-5*e2**3/256)*rlat-(3*e2/8+3*e2*e2/32+45*e2**3/1024)*Math.sin(2*rlat)+(15*e2*e2/256+45*e2**3/1024)*Math.sin(4*rlat)-(35*e2**3/3072)*Math.sin(6*rlat));
  const east=k0*N*(A+(1-T+C)*A**3/6+(5-18*T+T*T+72*C-58*ep2)*A**5/120)+500000;
  const north=k0*(M+N*Math.tan(rlat)*(A*A/2+(5-T+9*C+4*C*C)*A**4/24+(61-58*T+T*T+600*C-330*ep2)*A**6/720));
  return {east,north};
}
const addr = toUTM(-116.474082293246, 33.836760774048);
console.log('LAS', sig, 'v'+vMaj+'.'+vMin, 'fmt', fmt, 'ptLen', ptLen, 'count', count.toLocaleString());
console.log('scale', xs, ys, zs, 'offset', xo, yo, zo);
console.log('bounds X', minX.toFixed(1), maxX.toFixed(1), 'Y', minY.toFixed(1), maxY.toFixed(1), 'Z', minZ.toFixed(2), maxZ.toFixed(2));
console.log('ADDRESS UTM11N east', addr.east.toFixed(1), 'north', addr.north.toFixed(1));
console.log('address inside tile:', addr.east>=minX&&addr.east<=maxX&&addr.north>=minY&&addr.north<=maxY);
