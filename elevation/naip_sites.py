"""Fetch NAIP tiles at spread-out sites across the valley, as MS-SSIM references.

    run from elevation/ :  python naip_sites.py

One 500 m box at 0.5 m per site, delivered straight into UTM 11N so no
resampling error creeps into the registration reference (same trick as
swarm/core/fetch_naip.py, which this follows).

The sites are chosen to make a single global offset falsifiable: if the
footprint layer really is well registered, every site should peak near zero
independently. A site set clustered in one town could not tell a true
registration from a local coincidence.

Writes raw/naip_sites/<name>.npy (uint8 HxWx4 R,G,B,NIR, row0=SOUTH) + sites.json.
"""
import json, os, time, urllib.parse, urllib.request
import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.warp import transform

SERVICE = ("https://imagery.nationalmap.gov/arcgis/rest/services/"
           "USGSNAIPImagery/ImageServer/exportImage")
OUT = "raw/naip_sites"
SPAN = 500.0        # metres per side
N = 1000            # -> 0.5 m posting, matches the LiDAR tiles

# name, lon, lat, what it is there to test
SITES = [
    ("alva",        -116.4741, 33.8368, "the subject neighbourhood — LiDAR ground truth here"),
    ("cathedral",   -116.4653, 33.7797, "Cathedral City centre, dense single-storey grid"),
    ("palmsprings", -116.5453, 33.8253, "Palm Springs downtown, the tallest blocks"),
    ("psp_airport", -116.5040, 33.8280, "PSP aprons — aircraft vs hangars"),
    ("dhs",         -116.5010, 33.9610, "Desert Hot Springs, sparse and on a slope"),
    ("ranchomirage",-116.4120, 33.7400, "Rancho Mirage, golf-course fabric"),
    ("palmdesert",  -116.3740, 33.7220, "Palm Desert retail + big-box roofs"),
    ("orchard",     -116.3000, 33.7600, "date grove — canopy that must not become buildings"),
]

os.makedirs(OUT, exist_ok=True)
meta = {}
for name, lon, lat, why in SITES:
    xs, ys = transform("EPSG:4326", "EPSG:26911", [lon], [lat])
    x0, y0 = xs[0] - SPAN / 2, ys[0] - SPAN / 2
    path = f"{OUT}/{name}.npy"
    entry = dict(lon=lon, lat=lat, x0=x0, y0=y0, span=SPAN, n=N,
                 cellM=SPAN / N, why=why, file=path)

    if os.path.exists(path):
        print(f"{name:13s} cached")
        meta[name] = entry
        continue

    qs = {"bbox": f"{x0},{y0},{x0+SPAN},{y0+SPAN}",
          "bboxSR": "26911", "imageSR": "26911", "size": f"{N},{N}",
          "format": "tiff", "pixelType": "U8",
          "interpolation": "RSP_BilinearInterpolation",
          "renderingRule": json.dumps({"rasterFunction": "None"}), "f": "image"}
    url = SERVICE + "?" + urllib.parse.urlencode(qs)
    req = urllib.request.Request(url, headers={"User-Agent": "alva-court-render/1.0"})
    # The ImageServer answers in seconds when it answers at all, and stalls
    # outright when it does not — so retry rather than sit on a long timeout.
    buf = None
    for attempt in range(4):
        try:
            buf = urllib.request.urlopen(req, timeout=90).read()
            break
        except Exception as e:
            print(f"{name:13s} attempt {attempt+1}: {type(e).__name__} {e}")
            time.sleep(10)
    if buf is None:
        print(f"{name:13s} GAVE UP")
        continue
    if buf[:200].lstrip().startswith(b"{"):
        print(f"{name:13s} SERVER RETURNED JSON: {buf[:200].decode('utf8','replace')}")
        continue

    with MemoryFile(buf) as mf, mf.open() as ds:
        a = ds.read()                     # (bands, rows, cols), row0 = NORTH
    a = np.flip(a, axis=1)                # -> row0 = SOUTH, project convention
    stack = np.zeros((a.shape[1], a.shape[2], 4), np.uint8)
    for b in range(min(4, a.shape[0])):
        stack[:, :, b] = a[b]
    np.save(path, stack)
    entry["bands"] = int(min(4, a.shape[0]))
    meta[name] = entry
    print(f"{name:13s} {stack.shape} {len(buf)/1e6:.1f} MB  E{x0:.0f} N{y0:.0f}")

json.dump(meta, open(f"{OUT}/sites.json", "w"), indent=2)
print(f"\n{len(meta)} sites -> {OUT}/sites.json")
