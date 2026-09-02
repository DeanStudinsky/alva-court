"""Fetch USGS 3DEP bare-earth elevation for a UTM 11N box, at 1 m.

    run from elevation/ :  python fetch_3dep_utm.py <prefix> <E0> <N0> <E1> <N1> [posting_m]

Same trick as fetch_naip.py: ask the ImageServer for bboxSR=imageSR=26911 and
it delivers straight into this project's grid, so no reprojection error enters
the control data.

Why this and not the LAZ tiles: the wash walls are BARE EARTH. A channel bank
is terrain, not surface, so a 1 m DEM shows it exactly as well as a point cloud
would — at roughly 4 MB per km2 instead of 150. (Buildings are a different
question: those need the surface return, and that is a point-cloud job.)

`raw/USGS_1M_DEM_CaliforniaGaps_B23.tif` does NOT cover this ground. It is a
gap-fill tile: 9.6% valid, confined to E 539994..544379 / N 3739995..3744386,
which stops short of the airport, the wash corridor and Cathedral City.

Writes dem1m_<prefix>.bin (Float32LE feet NAVD88, row0=SOUTH col0=WEST, on the
project's baseFt datum) + dem1m_<prefix>_meta.json — same convention as every
other binary here.
"""
import json, os, sys, time, urllib.parse, urllib.request
import numpy as np
from rasterio.io import MemoryFile

FT = 3.280839895
SERVICE = ("https://elevation.nationalmap.gov/arcgis/rest/services/"
           "3DEPElevation/ImageServer/exportImage")
CHUNK = 1000        # px per request — the size these services reliably serve

prefix = sys.argv[1] if len(sys.argv) > 1 else "wash"
E0, N0, E1, N1 = (float(v) for v in (sys.argv[2:6] if len(sys.argv) > 5
                                     else (544000, 3742000, 550000, 3747000)))
POST = float(sys.argv[6]) if len(sys.argv) > 6 else 1.0

BASE_FT = json.load(open("valley_meta.json", encoding="utf-8"))["baseFt"]

NC = int(round((E1 - E0) / POST))
NR = int(round((N1 - N0) / POST))
print(f"{prefix}: E {E0:.0f}..{E1:.0f}  N {N0:.0f}..{N1:.0f}  "
      f"{NC} x {NR} @ {POST} m")

grid = np.full((NR, NC), np.nan, np.float32)          # row0 = SOUTH


def fetch(x0, y0, w, h, nx, ny):
    qs = {"bbox": f"{x0},{y0},{x0+w},{y0+h}",
          "bboxSR": "26911", "imageSR": "26911", "size": f"{nx},{ny}",
          "format": "tiff", "pixelType": "F32",
          "interpolation": "RSP_BilinearInterpolation",
          "f": "image"}
    req = urllib.request.Request(SERVICE + "?" + urllib.parse.urlencode(qs),
                                 headers={"User-Agent": "alva-court-render/1.0"})
    for attempt in range(5):
        try:
            buf = urllib.request.urlopen(req, timeout=120).read()
            if buf[:200].lstrip().startswith(b"{"):
                print("      server returned JSON:", buf[:160])
                return None
            with MemoryFile(buf) as mf, mf.open() as ds:
                a = ds.read(1).astype(np.float32)
                nod = ds.nodata
            if nod is not None:
                a = np.where(a <= nod + 1, np.nan, a)
            return np.flipud(a)                        # -> row0 = SOUTH
        except Exception as e:
            wait = min(90, 8 * 2 ** attempt)
            print(f"      attempt {attempt+1}: {type(e).__name__} {e} — {wait}s")
            time.sleep(wait)
    return None


t0 = time.time()
ncx = (NC + CHUNK - 1) // CHUNK
ncy = (NR + CHUNK - 1) // CHUNK
total = ncx * ncy
k = 0
for jy in range(ncy):
    for jx in range(ncx):
        k += 1
        c0, r0 = jx * CHUNK, jy * CHUNK
        nx, ny = min(CHUNK, NC - c0), min(CHUNK, NR - r0)
        x0, y0 = E0 + c0 * POST, N0 + r0 * POST
        print(f"  {k}/{total}  E{x0:.0f} N{y0:.0f}  {nx}x{ny}")
        a = fetch(x0, y0, nx * POST, ny * POST, nx, ny)
        if a is None:
            continue
        grid[r0:r0 + ny, c0:c0 + nx] = a[:ny, :nx]

valid = np.isfinite(grid)
print(f"\nvalid {100*valid.mean():.1f}%   {time.time()-t0:.0f}s")
if valid.mean() < 0.05:
    print("almost nothing came back — not writing")
    sys.exit(1)

# metres -> feet on the project datum, NaN preserved as a sentinel the
# consumer can test (the other binaries have no nodata, so say so in the meta)
out = (grid * FT).astype(np.float32)
out[~valid] = np.nan
out.tofile(f"dem1m_{prefix}.bin")

good = out[valid]
json.dump({
    "note": "USGS 3DEP bare earth, feet NAVD88. Float32LE[nc*nr], row0=SOUTH, "
            "col0=WEST. NaN = no data. Subtract baseFt for scene y.",
    "source": "USGS 3DEPElevation ImageServer (public domain), bboxSR=imageSR=26911",
    "nc": NC, "nr": NR, "cellM": POST, "cellFt": POST * FT,
    "utm": {"x0": E0, "y0": N0, "wkid": 26911},
    "baseFt": BASE_FT,
    "validFraction": round(float(valid.mean()), 4),
    "elevFt": [round(float(good.min()), 2), round(float(good.max()), 2)],
    "bin": {"file": f"dem1m_{prefix}.bin", "layout": "Float32LE feet, NaN=nodata"},
}, open(f"dem1m_{prefix}_meta.json", "w"), indent=2)
print(f"wrote dem1m_{prefix}.bin ({out.nbytes/1e6:.0f} MB)  "
      f"elev {good.min():.0f}..{good.max():.0f} ft")
