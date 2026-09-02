"""Reconcile the coarse valley surface against the 1 m DEM, using the wash and
the PSP runways as control.

    run from elevation/ :  python reconcile_cc.py

THE TWO MAPS
------------
`valley.bin` is 39 m NED and is what Cathedral City is currently standing on.
`dem1m_wash.bin` is 1 m 3DEP bare earth over E 544000..550000 / N 3742000..3747000,
pulled by fetch_3dep_utm.py — the marked wash corridor, both PSP runways,
Cimarron and Escena.

Do NOT reach for raw/USGS_1M_DEM_CaliforniaGaps_B23.tif for this. It looks like
it covers the area (E 539994..550006) and does not: it is a gap-fill tile, 9.6%
valid, and its data stops at E 544379 / N 3744386 — short of the airport, the
corridor and Cathedral City. Every sample over this ground comes back NoData.

WHY THESE TWO CONTROLS
----------------------
A 39 m posting cannot see a 100 m channel properly: it averages the bed and the
banks together, so wherever the wash runs, the coarse surface floats above the
real bed and cuts into the real banks. That makes the wash the sharpest
disagreement in the whole area — which is exactly what makes it useful. Its
walls are near-vertical and its bed is flat, so a cross-section gives an
unambiguous bed elevation and two bank tops at every station along it.

The runways are the opposite kind of control. NOT because they are level —
PSP sits on the alluvial fan and its two runways genuinely fall about 46 ft
along their length — but because they are an engineered surface: smooth,
graded, surveyed, and 3 km long. Coarse posting cannot shave a channel into
them the way it does the wash; it can only average their platform down toward
the surrounding fan. So they measure the same resolution error with the
opposite sign, which is what makes the pair conclusive.

Measures, in order, and reports before it corrects anything:
  1. bulk vertical offset, valley.bin vs 1 m DEM, over the shared box
  2. the same restricted to the runways (flat, so any residual is registration)
  3. horizontal shift by hillshade edge correlation over the wash corridor
  4. the along-wash offset profile — is it a constant, a tilt, or noise?

Writes out/reconcile_cc.json.
"""
import json, os
import cv2
import numpy as np
import rasterio
from rasterio.warp import transform

FT = 3.280839895
DEM1M = "dem1m_wash"        # written by fetch_3dep_utm.py
OUT = "out"
os.makedirs(OUT, exist_ok=True)

# ── the coarse surface the scene currently draws ───────────────────────────
vm = json.load(open("valley_meta.json", encoding="utf-8"))
NCV, NRV, CELLV = vm["nc"], vm["nr"], vm["cellM"]
X0V, Y0V = vm["utm"]["x0"], vm["utm"]["y0"]
BASE_FT = vm["baseFt"]
valley = np.fromfile("valley.bin", dtype="<f4").reshape(NRV, NCV)   # feet, row0=SOUTH

dm = json.load(open(f"{DEM1M}_meta.json", encoding="utf-8"))
W, H, DPOST = dm["nc"], dm["nr"], dm["cellM"]
DX0, DY0 = dm["utm"]["x0"], dm["utm"]["y0"]       # row 0 = SOUTH, same as everything else
dem_ft = np.fromfile(dm["bin"]["file"], dtype="<f4").reshape(H, W)
DE1, DN1 = DX0 + W * DPOST, DY0 + H * DPOST
print(f"1 m DEM  {W}x{H} @ {DPOST} m  E {DX0:.0f}..{DE1:.0f}  N {DY0:.0f}..{DN1:.0f}  "
      f"valid {100*np.isfinite(dem_ft).mean():.1f}%")
print(f"valley   {NCV}x{NRV} @ {CELLV:.1f} m")


def dem_at(E, N):
    """1 m DEM in feet at UTM (E, N). row 0 = SOUTH, the project convention."""
    c = np.round((E - DX0) / DPOST).astype(int)
    r = np.round((N - DY0) / DPOST).astype(int)
    ok = (c >= 0) & (c < W) & (r >= 0) & (r < H)
    out = np.full(len(E), np.nan, np.float32)
    out[ok] = dem_ft[r[ok], c[ok]]
    return out


def valley_at(E, N):
    """valley.bin in feet, bilinear on its own triangulation (row0 = SOUTH)."""
    fc = (E - X0V) / CELLV
    fr = (N - Y0V) / CELLV
    c, r = np.floor(fc).astype(int), np.floor(fr).astype(int)
    ok = (c >= 0) & (c < NCV - 1) & (r >= 0) & (r < NRV - 1)
    out = np.full(len(E), np.nan, np.float32)
    u, v = (fc - c)[ok], (fr - r)[ok]
    ci, ri = c[ok], r[ok]
    a = valley[ri, ci]; b = valley[ri, ci + 1]
    d = valley[ri + 1, ci]; e = valley[ri + 1, ci + 1]
    out[ok] = np.where(u + v <= 1,
                       a + (b - a) * u + (d - a) * v,
                       e + (d - e) * (1 - u) + (b - e) * (1 - v))
    return out


report = {}

# ── 1. bulk vertical offset over the shared box ────────────────────────────
gx, gy = np.meshgrid(np.arange(DX0 + 20, DE1 - 20, 40.0),
                     np.arange(DY0 + 20, DN1 - 20, 40.0))
gE, gN = gx.ravel(), gy.ravel()
d1 = dem_at(gE, gN)
d2 = valley_at(gE, gN)
good = np.isfinite(d1) & np.isfinite(d2)
diff = (d1 - d2)[good]
report["bulk"] = {
    "samples": int(good.sum()),
    "median_ft": round(float(np.median(diff)), 2),
    "mean_ft": round(float(diff.mean()), 2),
    "std_ft": round(float(diff.std()), 2),
    "p05_ft": round(float(np.percentile(diff, 5)), 2),
    "p95_ft": round(float(np.percentile(diff, 95)), 2),
}
print(f"\n1. BULK  1 m DEM minus valley.bin, {good.sum():,} samples on a 40 m grid")
print(f"   median {np.median(diff):+.2f} ft   mean {diff.mean():+.2f}   "
      f"sd {diff.std():.2f}   p05..p95 {np.percentile(diff,5):+.1f}..{np.percentile(diff,95):+.1f}")

# ── 2. the same over the runways — flat, so residual is registration ───────
aw = json.load(open("raw/osm/aeroway.json", encoding="utf-8"))
run_E, run_N = [], []
PSP_RUNWAYS = {"13L/31R", "13R/31L"}
for el in aw["elements"]:
    t = el.get("tags") or {}
    if t.get("aeroway") != "runway":
        continue
    # Only the two named PSP runways. The untagged "runway" ways in this
    # extract run NW up the alluvial fan and are not pavement — including them
    # put 78 ft of relief into a control whose entire value is being flat.
    if t.get("ref") not in PSP_RUNWAYS:
        continue
    g = el.get("geometry")
    if not g or len(g) < 2:
        continue
    E, N = transform("EPSG:4326", "EPSG:26911",
                     [p["lon"] for p in g], [p["lat"] for p in g])
    E, N = np.asarray(E), np.asarray(N)
    # step along the centreline at 10 m
    for i in range(1, len(E)):
        d = np.hypot(E[i] - E[i-1], N[i] - N[i-1])
        k = max(2, int(d / 10))
        run_E.append(np.linspace(E[i-1], E[i], k))
        run_N.append(np.linspace(N[i-1], N[i], k))
if run_E:
    rE = np.concatenate(run_E); rN = np.concatenate(run_N)
    d1 = dem_at(rE, rN); d2 = valley_at(rE, rN)
    good = np.isfinite(d1) & np.isfinite(d2)
    rdiff = (d1 - d2)[good]
    if good.sum() < 50:
        report["runways"] = {"samples": int(good.sum()),
                             "note": "runways fall outside the DEM box — no control"}
        print(f"\n2. RUNWAYS  only {good.sum()} samples inside the DEM box — skipped")
        rdiff = None
    else:
      report["runways"] = {
        "samples": int(good.sum()),
        "median_ft": round(float(np.median(rdiff)), 2),
        "std_ft": round(float(rdiff.std()), 2),
        "dem_relief_ft": round(float(np.nanmax(d1[good]) - np.nanmin(d1[good])), 2),
      }
      print(f"\n2. RUNWAYS  {good.sum():,} centreline samples on PSP 13L/31R + 13R/31L")
      print(f"   median {np.median(rdiff):+.2f} ft   sd {rdiff.std():.2f}   "
            f"(1 m DEM fall along them: {np.nanmax(d1[good])-np.nanmin(d1[good]):.1f} ft — "
            f"real fan gradient, not error)")

# ── 3. horizontal shift, by hillshade edge correlation over the corridor ───
def hillshade(z, az=315.0, alt=45.0):
    z = np.nan_to_num(z, nan=float(np.nanmedian(z)))
    gy, gx = np.gradient(z)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    a, A = np.radians(alt), np.radians(az)
    hs = np.sin(a) * np.cos(slope) + np.cos(a) * np.sin(slope) * np.cos(A - aspect)
    return np.clip(hs, 0, 1)


# corridor box, inside both surfaces
CE0, CE1 = 544200.0, 549800.0
CN0, CN1 = 3742200.0, 3746800.0
step = 10.0
cx, cy = np.meshgrid(np.arange(CE0, CE1, step), np.arange(CN0, CN1, step))
fine = dem_at(cx.ravel(), cy.ravel()).reshape(cx.shape)
best = None
sweep = {}
for dE in range(-60, 61, 10):
    for dN in range(-60, 61, 10):
        coarse = valley_at(cx.ravel() + dE, cy.ravel() + dN).reshape(cx.shape)
        m = np.isfinite(fine) & np.isfinite(coarse)
        if m.sum() < 1000:
            continue
        a = hillshade(np.where(m, fine, np.nan))
        b = hillshade(np.where(m, coarse, np.nan))
        r = float(np.corrcoef(a[m].ravel(), b[m].ravel())[0, 1])
        sweep[f"{dE},{dN}"] = round(r, 4)
        if best is None or r > best[0]:
            best = (r, dE, dN)
vals = np.array(list(sweep.values()))
report["horizontal"] = {
    "best_dE_m": best[1], "best_dN_m": best[2],
    "peak_r": round(best[0], 4), "mean_r": round(float(vals.mean()), 4),
    "sharpness": round(best[0] / max(abs(vals.mean()), 1e-6), 3),
    "step_m": 10, "search_m": 60,
}
print(f"\n3. HORIZONTAL  hillshade correlation over the wash corridor, +/-60 m")
print(f"   peak r={best[0]:.4f} at dE={best[1]:+d} m dN={best[2]:+d} m   "
      f"sweep mean r={vals.mean():.4f}")
print(f"   {'shift is real' if abs(best[1])+abs(best[2]) > 0 else 'peak is at zero — already registered'}")

# ── 4. along-wash offset profile ───────────────────────────────────────────
wj = json.load(open("raw/osm/water.json", encoding="utf-8"))
line = None
for el in wj["elements"]:
    if el.get("id") == 941733512:
        line = el["geometry"]
if line:
    E, N = transform("EPSG:4326", "EPSG:26911",
                     [p["lon"] for p in line], [p["lat"] for p in line])
    E, N = np.asarray(E), np.asarray(N)
    stations, prof = [], []
    s_acc = 0.0
    for i in range(1, len(E)):
        seg = np.hypot(E[i] - E[i-1], N[i] - N[i-1])
        k = max(2, int(seg / 25))
        for t in np.linspace(0, 1, k, endpoint=False):
            px, py = E[i-1] + (E[i] - E[i-1]) * t, N[i-1] + (N[i] - N[i-1]) * t
            # cross-section perpendicular to the reach, +/-150 m at 2 m
            tx, ty = E[i] - E[i-1], N[i] - N[i-1]
            L = np.hypot(tx, ty) or 1.0
            nx, ny = -ty / L, tx / L
            off = np.arange(-150, 151, 2.0)
            sx, sy = px + nx * off, py + ny * off
            zf = dem_at(sx, sy)
            zc = valley_at(sx, sy)
            if not np.isfinite(zf).any() or not np.isfinite(zc).any():
                continue
            bed = np.nanmin(zf)                       # channel invert
            top = np.nanpercentile(zf, 90)            # bank top / floodplain
            stations.append(s_acc + seg * t)
            prof.append((bed, top, top - bed,
                         float(np.nanmedian(zf - zc)),
                         float(np.nanmin(zf) - np.nanmin(zc))))
        s_acc += seg
    if prof:
        P = np.array(prof)
        wall = P[:, 2]
        med = P[:, 3]
        report["wash"] = {
            "stations": len(P),
            "wall_height_ft": {"median": round(float(np.median(wall)), 1),
                               "p10": round(float(np.percentile(wall, 10)), 1),
                               "p90": round(float(np.percentile(wall, 90)), 1)},
            "offset_ft": {"median": round(float(np.median(med)), 2),
                          "std": round(float(med.std()), 2),
                          "first_quarter": round(float(np.median(med[:len(med)//4])), 2),
                          "last_quarter": round(float(np.median(med[-len(med)//4:])), 2)},
            "bed_offset_median_ft": round(float(np.median(P[:, 4])), 2),
        }
        drift = np.median(med[-len(med)//4:]) - np.median(med[:len(med)//4])
        print(f"\n4. WASH  {len(P)} cross-sections at 25 m along the Whitewater channel")
        print(f"   wall height (1 m DEM): median {np.median(wall):.1f} ft  "
              f"p10..p90 {np.percentile(wall,10):.1f}..{np.percentile(wall,90):.1f}")
        print(f"   fine-minus-coarse along the reach: median {np.median(med):+.2f} ft  "
              f"sd {med.std():.2f}")
        print(f"   drift head-to-toe: {drift:+.2f} ft  "
              f"({'a tilt' if abs(drift) > 2 * med.std() / np.sqrt(len(med)) else 'no significant tilt'})")
        print(f"   channel bed sits {np.median(P[:,4]):+.1f} ft below the coarse surface "
              f"— this is what 39 m posting does to a 100 m channel")

json.dump(report, open(f"{OUT}/reconcile_cc.json", "w"), indent=2)
print(f"\nwrote {OUT}/reconcile_cc.json")
