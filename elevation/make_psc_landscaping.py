"""Per-property landscaping for Palm Springs + Cathedral City, from NAIP NDVI.

    run from elevation/ :  python make_psc_landscaping.py [max_tiles]

WHY THIS EXISTS SEPARATELY FROM make_psc_vegetation.mjs
-------------------------------------------------------
OSM maps 8 043 trees in this box and almost all of them are downtown street
trees. Residential Palm Springs is mapped at essentially zero trees per house,
and residential yards are exactly where a sight line gets blocked. So the yards
come from the imagery instead: NAIP carries a near-infrared band, irrigated
vegetation is bright in NIR and dark in red, and NDVI separates a watered yard
from bare desert with no ambiguity at all.

Every plant this produces is INFERRED, and the meta says so. NDVI gives a
canopy outline and nothing else — no species, no trunk, no height. Height is a
documented function of crown radius, which is a rule, not a measurement.

Method, per 4 km tile:
  1. NAIP 4-band at 1 m, delivered straight into UTM 11N (no reprojection).
  2. NDVI > NDVI_MIN, with OSM building footprints knocked out — a roof that
     reads green is a tarp or an artefact, not a tree.
  3. Connected components. Compact ones in the plant size range become plants;
     the rest is lawn and is left to the OSM turf layer.
  4. Each plant is assigned to the nearest OSM building within ASSIGN_FT, so
     the scene can answer "what is planted at this house" rather than only
     "how many trees are in Palm Springs".

Writes psc_landscaping.bin + _meta.json. The rasters are never kept; only the
derived instances are, which is the difference between a 40 MB product and a
1 GB one.
"""
import json, os, sys, time, urllib.parse, urllib.request
import cv2
import numpy as np
from rasterio.io import MemoryFile
from rasterio.warp import transform

FT = 3.280839895
SERVICE = ("https://imagery.nationalmap.gov/arcgis/rest/services/"
           "USGSNAIPImagery/ImageServer/exportImage")

BOX = dict(s=33.755, w=-116.585, n=33.875, e=-116.415)
# 1 km, not 4. The ImageServer serves a 1000x1000 export in about four
# seconds, times out on 2000x2000, and times out outright on 4000x4000 (a
# 64 MB TIFF) — so the tile is sized to what the service will actually
# deliver, and there are simply more of them. Posting stays at 1 m: at 2 m a
# 5 m crown is 2.5 px and plant detection stops being trustworthy.
#
# The service also goes down for stretches (502s, then read timeouts) for
# reasons that have nothing to do with the request. Hence CACHE below: every
# finished tile is written out, so a run that dies half way is resumed rather
# than repeated.
TILE_M = 1000          # metres per NAIP request, at 1 m posting
CACHE = "raw/naip_sites/landscape_cache" 
NDVI_MIN = 0.25
PLANT_MIN_M2 = 4.0     # smaller than this is NDVI speckle
PLANT_MAX_M2 = 160.0   # larger is lawn, golf fairway or a citrus block
FILL_MIN = 0.35        # area / bbox area — a compact blob, not a hedge line
ASSIGN_FT = 160.0      # a plant further than this from any building is streetscape

os.makedirs(CACHE, exist_ok=True)

meta_out = "psc_landscaping_meta.json"
bin_out = "psc_landscaping.bin"
max_tiles = int(sys.argv[1]) if len(sys.argv) > 1 else 999

# ── terrain, for draping ───────────────────────────────────────────────────
def load_tile(name):
    m = json.load(open(f"{name}_meta.json", encoding="utf-8"))
    n = m["nc"] * m["nr"]
    off = n if "DSM" in m["bin"]["layout"] else 0
    a = np.fromfile(m["bin"]["file"], dtype="<f4")
    return dict(nc=m["nc"], nr=m["nr"], cell=m["cellM"],
                x0=m["utm"]["x0"], y0=m["utm"]["y0"],
                dtm=a[off:off + n].reshape(m["nr"], m["nc"]))

GROUND = [load_tile(n) for n in ("terrain", "terrain_wide",
                                 "terrain_corridor", "valley")
          if os.path.exists(f"{n}_meta.json")]
REG = json.load(open("valley_meta.json", encoding="utf-8"))
BASE_FT = REG["baseFt"]
ADDR_E, ADDR_N = REG["utm"]["addrE"], REG["utm"]["addrN"]


def ground_y(E, N):
    """Vectorised, and interpolated the way the ground mesh is triangulated —
    same rule as make_psc_surfaces.mjs, for the same reason."""
    out = np.zeros(len(E), np.float32)
    todo = np.ones(len(E), bool)
    for t in GROUND:
        if not todo.any():
            break
        fc = (E - t["x0"]) / t["cell"]
        fr = (N - t["y0"]) / t["cell"]
        c, r = np.floor(fc).astype(int), np.floor(fr).astype(int)
        ok = todo & (c >= 0) & (c < t["nc"] - 1) & (r >= 0) & (r < t["nr"] - 1)
        if not ok.any():
            continue
        u, v = (fc - c)[ok], (fr - r)[ok]
        ci, ri = c[ok], r[ok]
        d = t["dtm"]
        a = d[ri, ci]; b = d[ri, ci + 1]; dd = d[ri + 1, ci]; e = d[ri + 1, ci + 1]
        lower = (u + v) <= 1
        h = np.where(lower,
                     a + (b - a) * u + (dd - a) * v,
                     e + (dd - e) * (1 - u) + (b - e) * (1 - v))
        out[ok] = h - BASE_FT
        todo[ok] = False
    return out


# ── OSM buildings: knockout mask + assignment targets ──────────────────────
blds = json.load(open("raw/osm/buildings.json", encoding="utf-8"))
rings, cent_E, cent_N = [], [], []
for el in blds["elements"]:
    g = el.get("geometry")
    if not g or len(g) < 4:
        continue
    E, N = transform("EPSG:4326", "EPSG:26911",
                     [p["lon"] for p in g], [p["lat"] for p in g])
    E, N = np.asarray(E), np.asarray(N)
    rings.append((E, N))
    cent_E.append(E.mean()); cent_N.append(N.mean())
cent_E = np.asarray(cent_E); cent_N = np.asarray(cent_N)
print(f"{len(rings)} OSM buildings loaded for knockout + assignment")

# ── tile grid over the box, skipping tiles with no buildings ───────────────
xs, ys = transform("EPSG:4326", "EPSG:26911",
                   [BOX["w"], BOX["e"], BOX["w"], BOX["e"]],
                   [BOX["s"], BOX["s"], BOX["n"], BOX["n"]])
X0, X1 = min(xs), max(xs)
Y0, Y1 = min(ys), max(ys)
tiles = []
x = X0
while x < X1:
    y = Y0
    while y < Y1:
        if ((cent_E >= x - 200) & (cent_E < x + TILE_M + 200) &
                (cent_N >= y - 200) & (cent_N < y + TILE_M + 200)).sum() >= 15:
            tiles.append((x, y))
        y += TILE_M
    x += TILE_M
print(f"{len(tiles)} tiles of {TILE_M} m carry buildings "
      f"(box {X1-X0:.0f} x {Y1-Y0:.0f} m)")


def fetch_naip(x0, y0, span, n):
    qs = {"bbox": f"{x0},{y0},{x0+span},{y0+span}",
          "bboxSR": "26911", "imageSR": "26911", "size": f"{n},{n}",
          "format": "tiff", "pixelType": "U8",
          "interpolation": "RSP_BilinearInterpolation",
          "renderingRule": json.dumps({"rasterFunction": "None"}), "f": "image"}
    req = urllib.request.Request(SERVICE + "?" + urllib.parse.urlencode(qs),
                                 headers={"User-Agent": "alva-court-render/1.0"})
    for attempt in range(6):
        try:
            buf = urllib.request.urlopen(req, timeout=120).read()
            if buf[:200].lstrip().startswith(b"{"):
                print("      server returned JSON, skipping tile")
                return None
            with MemoryFile(buf) as mf, mf.open() as ds:
                a = ds.read()
            a = np.flip(a, axis=1)                 # -> row0 = SOUTH
            if a.shape[0] < 4:
                print("      no NIR band, skipping tile")
                return None
            return a
        except Exception as e:
            wait = min(120, 10 * 2 ** attempt)
            print(f"      attempt {attempt+1}: {type(e).__name__} {e} — {wait}s")
            time.sleep(wait)
    return None


plants = []          # E, N, crown_ft, bldIdx
t_start = time.time()
done = 0
for ti, (x0, y0) in enumerate(tiles[:max_tiles]):
    cache_f = f"{CACHE}/{int(x0)}_{int(y0)}.npy"
    if os.path.exists(cache_f):
        c = np.load(cache_f)
        if len(c):
            plants.extend(map(tuple, c))
        done += 1
        continue
    print(f"  tile {ti+1}/{min(len(tiles), max_tiles)}  E{x0:.0f} N{y0:.0f}")
    a = fetch_naip(x0, y0, TILE_M, TILE_M)        # 1 m posting
    if a is None:
        continue
    R = a[0].astype(np.float32)
    NIR = a[3].astype(np.float32)
    ndvi = (NIR - R) / np.maximum(NIR + R, 1e-6)
    mask = (ndvi > NDVI_MIN).astype(np.uint8)

    # Knock out roofs: green on a roof is a tarp, a pool cover or an artefact.
    knock = np.zeros_like(mask)
    for E, N in rings:
        if E.max() < x0 or E.min() > x0 + TILE_M or N.max() < y0 or N.min() > y0 + TILE_M:
            continue
        c = np.round(E - x0).astype(np.int32)
        r = np.round(N - y0).astype(np.int32)
        cv2.fillPoly(knock, [np.stack([c, r], 1)], 1)
    mask &= (1 - knock)

    # Open once: removes single-pixel NDVI speckle without eating a small shrub.
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))

    nlab, lab, stats, cents = cv2.connectedComponentsWithStats(mask, 8)
    area = stats[:, cv2.CC_STAT_AREA].astype(np.float32)     # m^2 at 1 m
    w = stats[:, cv2.CC_STAT_WIDTH].astype(np.float32)
    h = stats[:, cv2.CC_STAT_HEIGHT].astype(np.float32)
    fill = area / np.maximum(w * h, 1.0)

    sel = ((area >= PLANT_MIN_M2) & (area <= PLANT_MAX_M2) & (fill >= FILL_MIN))
    sel[0] = False                                            # label 0 is background
    idx = np.flatnonzero(sel)
    if len(idx) == 0:
        np.save(cache_f, np.zeros((0, 4), np.float64))
        done += 1
        print("      no plants found")
        continue

    pE = x0 + cents[idx, 0]
    pN = y0 + cents[idx, 1]
    crown = np.sqrt(area[idx] / np.pi) * FT                   # ft
    crown = np.clip(crown, 3.0, 30.0)

    # Nearest building, in chunks so the distance matrix stays bounded.
    near = ((cent_E >= x0 - 300) & (cent_E < x0 + TILE_M + 300) &
            (cent_N >= y0 - 300) & (cent_N < y0 + TILE_M + 300))
    nidx = np.flatnonzero(near)
    assigned = np.full(len(pE), -1, np.int32)
    if len(nidx):
        bE, bN = cent_E[nidx], cent_N[nidx]
        for s in range(0, len(pE), 2000):
            e = min(s + 2000, len(pE))
            d2 = ((pE[s:e, None] - bE[None, :]) ** 2 +
                  (pN[s:e, None] - bN[None, :]) ** 2)
            j = d2.argmin(1)
            dmin = np.sqrt(d2[np.arange(e - s), j]) * FT
            take = dmin <= ASSIGN_FT
            assigned[s:e][take] = nidx[j][take]

    tile_rows = np.stack([pE, pN, crown, assigned.astype(np.float64)], 1)
    np.save(cache_f, tile_rows)
    plants.extend(map(tuple, tile_rows))
    done += 1
    print(f"      {len(pE)} plants, {(assigned >= 0).sum()} assigned to a building"
          f"   [{done}/{min(len(tiles), max_tiles)} tiles, {time.time()-t_start:.0f}s]")

if not plants:
    print("no plants extracted — nothing written")
    sys.exit(1)

P = np.array(plants, dtype=np.float64)
E, N, crown, bld = P[:, 0], P[:, 1], P[:, 2].astype(np.float32), P[:, 3].astype(np.int32)
x = ((E - ADDR_E) * FT).astype(np.float32)
z = ((ADDR_N - N) * FT).astype(np.float32)
y = ground_y(E, N).astype(np.float32)

# Height from crown radius. Desert landscaping runs taller than wide for palms
# and rounder for broadleaf, but NDVI cannot tell them apart from above, so one
# documented rule covers both and every plant here is flagged inferred.
height = np.clip(2.2 * crown, 8.0, 55.0).astype(np.float32)

inst = np.empty(len(x) * 6, np.float32)
inst[0::6] = x; inst[1::6] = y; inst[2::6] = z
inst[3::6] = height; inst[4::6] = crown; inst[5::6] = bld.astype(np.float32)

sections, chunks, off = [], [], 0
buf = inst.tobytes()
sections.append({"name": "plant", "type": "Float32", "byteOffset": 0, "length": len(inst)})
open(bin_out, "wb").write(buf)

per_house = np.bincount(bld[bld >= 0], minlength=len(rings)) if (bld >= 0).any() else np.zeros(1)
housed = int((per_house > 0).sum())
json.dump({
    "note": "NAIP-NDVI landscaping for Palm Springs + Cathedral City. Scene feet, "
            "+X=East, +Z=South, y=0 at baseFt. plant[] is 6 floats: x, y, z, "
            "heightFt, crownRadiusFt, osmBuildingIndex (-1 = streetscape).",
    "source": "USDA NAIP 4-band via USGS The National Map (public domain); "
              "OpenStreetMap building footprints for roof knockout and assignment",
    "status": "ALL INFERRED. NDVI gives a canopy outline only — no species, no "
              "trunk, no measured height. Height = clip(2.2 x crown radius, 8, 55) ft.",
    "method": {"posting_m": 1, "ndvi_min": NDVI_MIN,
               "plant_area_m2": [PLANT_MIN_M2, PLANT_MAX_M2],
               "min_fill_ratio": FILL_MIN, "assign_radius_ft": ASSIGN_FT,
               "roofs_knocked_out": True},
    "extent": BOX,
    "tiles_processed": done,
    "tiles_total": len(tiles),
    "plants": int(len(x)),
    "assignedToBuilding": int((bld >= 0).sum()),
    "streetscape": int((bld < 0).sum()),
    "buildingsWithPlanting": housed,
    "medianPlantsPerPlantedHouse": float(np.median(per_house[per_house > 0])) if housed else 0,
    "bin": {"file": bin_out, "sections": sections},
}, open(meta_out, "w"), indent=2)

print(f"\nwrote {bin_out}: {len(x):,} plants, {(bld>=0).sum():,} assigned to "
      f"{housed:,} buildings (median {np.median(per_house[per_house>0]) if housed else 0:.0f} per planted house)")
