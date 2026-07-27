const base="https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/8/query";
const params=new URLSearchParams({where:"1=1",geometry:"-116.482,33.828,-116.466,33.844",geometryType:"esriGeometryEnvelope",inSR:"4326",outFields:"NAME",returnGeometry:"true",outSR:"26911",f:"json"});
const j=await (await fetch(base+"?"+params)).json();
const W={e:548618.7,n:3744187.4}, E={e:548725.2,n:3744193.6};
function near(p,q){return Math.hypot(p[0]-q.e,p[1]-q.n);}
console.log("roads in area:",j.features.length);
for(const f of j.features){
  if(f.attributes.NAME==="Alva Ct")continue;
  for(const path of f.geometry.paths){
    for(const p of path){
      const dW=near(p,W),dE=near(p,E);
      if(dW<25||dE<25)console.log(`${f.attributes.NAME}: node E${p[0].toFixed(1)} N${p[1].toFixed(1)}  distToWestEnd ${dW.toFixed(1)}m  distToEastEnd ${dE.toFixed(1)}m`);
    }
  }
}
