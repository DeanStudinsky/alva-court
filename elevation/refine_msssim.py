"""MS-SSIM registration audit: footprint layers vs NAIP, at eight valley sites.

    run from elevation/ :  python refine_msssim.py

WHAT THIS MEASURES, AND WHAT IT CANNOT
--------------------------------------
MS-SSIM cannot reshape a polygon. What it can do — and what swarm/core/
CONVENTIONS.md already established as this project's standard of proof — is
score a *positional* claim so it is falsifiable: rasterise a footprint layer,
slide it over a sweep of offsets against the aerial, and report the peak
alongside the mean of the whole sweep. A layer that is genuinely registered
produces a sharp peak at a consistent offset across independent sites. A layer
that is not produces a flat sweep, and `best/mean ~ 1.0` says so out loud.

Cross-modal, so the comparison is on EDGE STRUCTURE, not tone: a filled
polygon mask and a colour orthophoto share no luminance relationship at all,
but a roof edge is an edge in both. Both sides are reduced to Sobel gradient
magnitude before scoring.

Layers scored, on the same grid, at the same sites:
  ms    Microsoft ML footprints, as shipped in valley_buildings.bin
  osm   OpenStreetMap building ways/relations — the open-data cross-check

Writes out/msssim_registration.json.
"""
import json, os
import cv2
import numpy as np
from rasterio.warp import transform

import sys
sys.path.insert(0, "C:/Users/dmcge/Desktop/Coachella Valley 3DEP/swarm/core")
from msssim import msssim                                   # noqa: E402

FT = 3.280839895
SITES_JSON = "raw/naip_sites/sites.json"
OSM_BUILDINGS = "raw/osm/buildings.json"
BLD_META = "valley_buildings_meta.json"
OUT = "out"
SWEEP_M = 6.0            # +/- metres searched
MARGIN = 20              # px cropped after the shift, so no wrap enters a score

os.makedirs(OUT, exist_ok=True)
sites = json.load(open(SITES_JSON, encoding="utf-8"))
meta = json.load(open(BLD_META, encoding="utf-8"))
ADDR_E, ADDR_N = meta["utm"]["addrE"], meta["utm"]["addrN"]

# ── the ML footprints, straight out of the product the scene loads ──────────
raw = np.fromfile("valley_buildings.bin", dtype=np.uint8)
S = {}
for s in meta["bin"]["sections"]:
    dt = dict(Uint8=np.uint8, Uint16=np.uint16, Uint32=np.uint32, Float32=np.float32)[s["type"]]
    S[s["name"]] = raw[s["byteOffset"]:s["byteOffset"] + s["length"] * np.dtype(dt).itemsize].view(dt)
ring_off, xz = S["ringOff"], S["xz"].reshape(-1, 2)
ms_E = xz[:, 0] / FT + ADDR_E
ms_N = ADDR_N - xz[:, 1] / FT
print(f"ML footprints: {meta['count']} rings, {len(xz)} vertices")

# ── OSM buildings, projected once ──────────────────────────────────────────
osm_rings = []
if os.path.exists(OSM_BUILDINGS):
    doc = json.load(open(OSM_BUILDINGS, encoding="utf-8"))
    lons, lats, bounds = [], [], []
    for el in doc["elements"]:
        geoms = ([el["geometry"]] if el.get("geometry") else
                 [m["geometry"] for m in el.get("members", [])
                  if m.get("role") == "outer" and m.get("geometry")])
        for g in geoms:
            if len(g) < 4:
                continue
            bounds.append((len(lons), len(lons) + len(g)))
            lons.extend(p["lon"] for p in g)
            lats.extend(p["lat"] for p in g)
    E, N = transform("EPSG:4326", "EPSG:26911", lons, lats)
    E, N = np.asarray(E), np.asarray(N)
    osm_rings = [(E[a:b], N[a:b]) for a, b in bounds]
    print(f"OSM buildings: {len(osm_rings)} rings, {len(E)} vertices")
else:
    print("OSM buildings not fetched yet — scoring the ML layer alone")


def edges(img):
    """Sobel gradient magnitude, normalised to [0,1]. The only channel two
    modalities this different can honestly be compared on."""
    g = cv2.GaussianBlur(img.astype(np.float32), (5, 5), 1.0)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    m = np.hypot(gx, gy)
    hi = np.percentile(m, 99.5)
    return np.clip(m / max(hi, 1e-6), 0, 1).astype(np.float64)


def rasterise(polys, x0, y0, n, cell):
    """Filled mask on the site grid. row 0 = SOUTH, col 0 = WEST."""
    img = np.zeros((n, n), np.uint8)
    for pe, pn in polys:
        c = np.round((pe - x0) / cell).astype(np.int32)
        r = np.round((pn - y0) / cell).astype(np.int32)
        cv2.fillPoly(img, [np.stack([c, r], 1)], 255)
    return img


def sweep(ref_e, mask, cell, span_m):
    """MS-SSIM over integer-pixel offsets. Returns (best_dx_m, best_dy_m,
    peak, mean) with dx east-positive and dy north-positive, both metres."""
    k = int(round(span_m / cell))
    m = MARGIN
    best, grid = None, []
    for dr in range(-k, k + 1):
        row = []
        for dc in range(-k, k + 1):
            shifted = np.roll(np.roll(mask, dr, axis=0), dc, axis=1)
            a = ref_e[m:-m, m:-m]
            b = edges(shifted)[m:-m, m:-m]
            s = msssim(a, b)
            row.append(s)
            if best is None or s > best[0]:
                best = (s, dc * cell, dr * cell)
        grid.append(row)
    g = np.array(grid)
    return best[1], best[2], float(g.max()), float(g.mean())


report = {}
for name, site in sites.items():
    x0, y0, n, cell = site["x0"], site["y0"], site["n"], site["cellM"]
    naip = np.load(site["file"])
    ref = edges(cv2.cvtColor(naip[:, :, :3], cv2.COLOR_RGB2GRAY))

    # ML rings whose bounding box touches this site
    sel = ((ms_E >= x0 - 50) & (ms_E <= x0 + n * cell + 50) &
           (ms_N >= y0 - 50) & (ms_N <= y0 + n * cell + 50))
    polys_ms = []
    for i in range(meta["count"]):
        a, b = ring_off[i], ring_off[i + 1]
        if sel[a:b].any():
            polys_ms.append((ms_E[a:b], ms_N[a:b]))

    polys_osm = [(pe, pn) for pe, pn in osm_rings
                 if (pe >= x0 - 50).any() and (pe <= x0 + n * cell + 50).any()
                 and (pn >= y0 - 50).any() and (pn <= y0 + n * cell + 50).any()
                 and pe.max() >= x0 and pe.min() <= x0 + n * cell
                 and pn.max() >= y0 and pn.min() <= y0 + n * cell]

    entry = {"why": site["why"], "n_ms": len(polys_ms), "n_osm": len(polys_osm)}
    for layer, polys in (("ms", polys_ms), ("osm", polys_osm)):
        if not polys:
            continue
        mask = rasterise(polys, x0, y0, n, cell)
        cover = float((mask > 0).mean())
        if cover < 0.005:                       # nothing to register against
            entry[layer] = {"skipped": "coverage %.3f%%" % (100 * cover)}
            continue
        dx, dy, peak, mean = sweep(ref, mask, cell, SWEEP_M)
        entry[layer] = {"dx_m": dx, "dy_m": dy, "peak": round(peak, 4),
                        "mean": round(mean, 4), "sharpness": round(peak / mean, 4),
                        "coverage": round(cover, 4), "n": len(polys)}
    report[name] = entry
    line = f"{name:13s} ms:"
    for layer in ("ms", "osm"):
        e = entry.get(layer)
        if not e or "peak" not in e:
            line += f" {layer}=-"
            continue
        line += (f" {layer} n={e['n']:4d} off=({e['dx_m']:+.1f},{e['dy_m']:+.1f})m "
                 f"peak={e['peak']:.4f} sharp={e['sharpness']:.3f} |")
    print(line.replace("ms: ms", "ms"))

json.dump(report, open(f"{OUT}/msssim_registration.json", "w"), indent=2)

# ── verdict ────────────────────────────────────────────────────────────────
for layer in ("ms", "osm"):
    got = [(k, v[layer]) for k, v in report.items() if layer in v and "peak" in v[layer]]
    if not got:
        continue
    dx = np.array([e["dx_m"] for _, e in got])
    dy = np.array([e["dy_m"] for _, e in got])
    sh = np.array([e["sharpness"] for _, e in got])
    print(f"\n{layer.upper():4s} over {len(got)} sites: "
          f"dx {dx.mean():+.2f} +/- {dx.std():.2f} m, dy {dy.mean():+.2f} +/- {dy.std():.2f} m, "
          f"sharpness {sh.mean():.3f}")
print(f"\nwrote {OUT}/msssim_registration.json")
