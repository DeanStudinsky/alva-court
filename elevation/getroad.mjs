const base="https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/8/query";
const params=new URLSearchParams({
  where:"NAME LIKE '%Alva%'",
  geometry:"-116.480,33.830,-116.468,33.842",
  geometryType:"esriGeometryEnvelope", inSR:"4326",
  outFields:"NAME", returnGeometry:"true", outSR:"26911", f:"json"
});
const r=await fetch(base+"?"+params.toString());
const j=await r.json();
if(j.error){console.log("ERR",JSON.stringify(j.error));process.exit(1);}
console.log("features:",j.features?.length);
for(const f of (j.features||[])){
  console.log("\nNAME:",f.attributes.NAME);
  for(const path of f.geometry.paths){
    path.forEach((p)=>console.log(`  E ${p[0].toFixed(1)} N ${p[1].toFixed(1)}`));
    const a=path[0],b=path[path.length-1];
    const dE=b[0]-a[0],dN=b[1]-a[1],len=Math.hypot(dE,dN);
    console.log(`  length ${len.toFixed(1)}m (${(len*3.28084).toFixed(1)}ft) bearing(first->last) ${((Math.atan2(dE,dN)*180/Math.PI+360)%360).toFixed(1)}deg`);
  }
}
