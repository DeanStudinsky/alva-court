"""Measure the real Palm Springs / Cathedral City surface tones off NAIP.

    run from elevation/ :  python measure_psc_tones.py

"Visually matching" needs a target, and guessing at asphalt grey is how the
old #c4956a ground colour ended up in this project — too warm and too
saturated, by four years of nobody checking. So the numbers come out of the
orthophoto: rasterise the OSM roadway and sidewalk centrelines onto the NAIP
site grids, erode the mask so only interior pixels count (a road edge pixel is
half kerb), and take the median.

Median, not mean: parked cars, lane paint and roof shadows are all outliers
and a mean chases them.

Writes out/psc_tones.json.
"""
import json, os
import cv2
import numpy as np
from rasterio.warp import transform

SITES = ["palmsprings", "cathedral", "alva"]
NAIP = "raw/naip_sites/sites.json"
ROADS = "raw/osm/roads.json"
BUILDINGS = "raw/osm/buildings.json"
VEG = "raw/osm/vegetation.json"

# Irrigated turf and tree canopy are different materials and read very
# differently in the aerial — lumping them into one "vegetation" median
# produces a colour that matches neither. Split them by whether the pixel
# falls inside an OSM turf polygon.
TURF_TAGS = [("leisure", {"golf_course", "park", "pitch", "garden"}),
             ("landuse", {"grass", "village_green", "recreation_ground"})]
OUT = "out"

CLASS_W = {"motorway": 48, "trunk": 44, "primary": 44, "secondary": 36,
           "tertiary": 30, "residential": 26, "unclassified": 24,
           "living_street": 22, "service": 18, "track": 12}
FT = 3.280839895

os.makedirs(OUT, exist_ok=True)
sites = json.load(open(NAIP, encoding="utf-8"))
roads = json.load(open(ROADS, encoding="utf-8"))
blds = json.load(open(BUILDINGS, encoding="utf-8"))
veg = json.load(open(VEG, encoding="utf-8"))


def project(geom):
    lons = [p["lon"] for p in geom]
    lats = [p["lat"] for p in geom]
    E, N = transform("EPSG:4326", "EPSG:26911", lons, lats)
    return np.asarray(E), np.asarray(N)


# Project once; the site loop just clips.
road_lines, walk_lines = [], []
for el in roads["elements"]:
    g, t = el.get("geometry"), el.get("tags", {})
    if not g or len(g) < 2:
        continue
    hw = t.get("highway")
    if hw in CLASS_W:
        w = CLASS_W[hw]
        if t.get("lanes", "").isdigit() and 0 < int(t["lanes"]) < 12:
            w = int(t["lanes"]) * 11.5 + 4
        road_lines.append((project(g), w))
    elif hw == "footway" and t.get("footway") == "sidewalk":
        walk_lines.append((project(g), 5))

bld_rings = []
for el in blds["elements"]:
    g = el.get("geometry")
    if g and len(g) >= 4:
        bld_rings.append(project(g))

turf_rings = []
for el in veg["elements"]:
    g, t = el.get("geometry"), el.get("tags", {})
    if not g or len(g) < 4:
        continue
    if any(t.get(k) in vals for k, vals in TURF_TAGS):
        turf_rings.append(project(g))
print(f"{len(road_lines)} roads, {len(walk_lines)} sidewalks, {len(bld_rings)} buildings projected")


def draw(lines, x0, y0, n, cell, shrink_ft):
    """Mask of the given ribbons on the site grid, narrowed by shrink_ft either
    side so kerb and shoulder pixels stay out of the sample."""
    img = np.zeros((n, n), np.uint8)
    for (E, N), w in lines:
        px = np.round((E - x0) / cell).astype(np.int32)
        py = np.round((N - y0) / cell).astype(np.int32)
        thick = max(1, int(round((w / FT - 2 * shrink_ft / FT) / cell)))
        pts = np.stack([px, py], 1)
        cv2.polylines(img, [pts], False, 255, thick)
    return img > 0


report = {}
for name in SITES:
    s = sites[name]
    x0, y0, n, cell = s["x0"], s["y0"], s["n"], s["cellM"]
    naip = np.load(s["file"])
    rgb = naip[:, :, :3].astype(np.float32)

    m_road = draw(road_lines, x0, y0, n, cell, 5.0)
    m_walk = draw(walk_lines, x0, y0, n, cell, 1.0)

    def fill(rings):
        img = np.zeros((n, n), np.uint8)
        for E, N in rings:
            c = np.round((E - x0) / cell).astype(np.int32)
            r = np.round((N - y0) / cell).astype(np.int32)
            if c.max() < -50 or c.min() > n + 50 or r.max() < -50 or r.min() > n + 50:
                continue
            cv2.fillPoly(img, [np.stack([c, r], 1)], 255)
        return img > 0

    m_bld = fill(bld_rings)
    m_turf_poly = fill(turf_rings)

    R, G, B = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    NIR = naip[:, :, 3].astype(np.float32)
    ndvi = (NIR - R) / np.maximum(NIR + R, 1e-6)

    # bare ground = not road, not sidewalk, not building, not vegetated
    m_ground = ~(m_road | m_walk | m_bld) & (ndvi < 0.12)

    entry = {}
    green = ndvi > 0.30
    for label, mask in (("road", m_road & ~m_bld), ("sidewalk", m_walk & ~m_bld),
                        ("ground", m_ground),
                        ("turf", green & m_turf_poly),
                        ("canopy", green & ~m_turf_poly & ~m_bld),
                        ("vegetation", green)):
        px = rgb[mask]
        if len(px) < 200:
            entry[label] = {"n": int(len(px)), "note": "too few pixels"}
            continue
        med = np.median(px, axis=0)
        entry[label] = {
            "n": int(len(px)),
            "hex": "#%02x%02x%02x" % tuple(int(v) for v in med),
            "rgb": [round(float(v), 1) for v in med],
            "p25": "#%02x%02x%02x" % tuple(int(v) for v in np.percentile(px, 25, axis=0)),
            "p75": "#%02x%02x%02x" % tuple(int(v) for v in np.percentile(px, 75, axis=0)),
        }
    report[name] = entry
    line = f"{name:12s}"
    for label in ("road", "sidewalk", "ground", "turf", "canopy"):
        e = entry[label]
        line += f"  {label} {e.get('hex','-'):8s}"
    print(line)

# Pooled target across Palm Springs + Cathedral City — what the city materials
# have to hit. Alva is reported but excluded: it is one cul-de-sac and would
# weight the arterial network by a block.
pool = {}
for label in ("road", "sidewalk", "ground", "turf", "canopy", "vegetation"):
    vals, wts = [], []
    for name in ("palmsprings", "cathedral"):
        e = report[name][label]
        if "rgb" in e:
            vals.append(e["rgb"]); wts.append(e["n"])
    if vals:
        v = np.average(np.array(vals), axis=0, weights=wts)
        pool[label] = {"hex": "#%02x%02x%02x" % tuple(int(x) for x in v),
                       "rgb": [round(float(x), 1) for x in v],
                       "pixels": int(sum(wts))}
report["_target_ps_cc"] = pool
print("\nPS+CC pooled target:")
for k, v in pool.items():
    print(f"  {k:11s} {v['hex']}  rgb {v['rgb']}  from {v['pixels']:,} px")

json.dump(report, open(f"{OUT}/psc_tones.json", "w"), indent=2)
print(f"\nwrote {OUT}/psc_tones.json")
