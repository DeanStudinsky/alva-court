"""Score the Palm Springs / Cathedral City render against NAIP, and say what
the material tints should be.

    run from elevation/ :  python render_vs_naip_psc.py <site> <render.png>

Two numbers, because "looks right" is two separate claims:

  TONE       median RGB of the rendered roadway / sidewalk / ground, compared
             to the NAIP median over the same mask, as CIE dE76. Reports the
             multiplicative correction to apply to each material tint, which is
             what actually closes the gap — the render is lit and tone-mapped,
             so no analytic solve gets there in one step.

  STRUCTURE  MS-SSIM on Sobel edge magnitude, render vs NAIP, over the four
             flips. Cross-modal, so per swarm/core/CONVENTIONS.md the absolute
             value means nothing and only the margin over the wrong flips does:
             if "as-is" does not win clearly the framing is wrong and every
             tone number above it is being measured through a misalignment.

The render must be framed to the site box: camera straight down, north up,
square viewport. See the --frame helper printed by this script.
"""
import json, os, sys
import cv2
import numpy as np
from rasterio.warp import transform

sys.path.insert(0, "C:/Users/dmcge/Desktop/Coachella Valley 3DEP/swarm/core")
from msssim import msssim                                   # noqa: E402

FT = 3.280839895
ADDR_E, ADDR_N = 548660.3, 3744180.9
CLASS_W = {"motorway": 48, "trunk": 44, "primary": 44, "secondary": 36,
           "tertiary": 30, "residential": 26, "unclassified": 24,
           "living_street": 22, "service": 18, "track": 12}

site_name = sys.argv[1] if len(sys.argv) > 1 else "palmsprings"
render_png = sys.argv[2] if len(sys.argv) > 2 else f"../out/render_{site_name}.png"

sites = json.load(open("raw/naip_sites/sites.json", encoding="utf-8"))
site = sites[site_name]
x0, y0, n, cell = site["x0"], site["y0"], site["n"], site["cellM"]

# ── camera frame for this site, in scene feet ──────────────────────────────
cx = ((x0 + n * cell / 2) - ADDR_E) * FT
cz = (ADDR_N - (y0 + n * cell / 2)) * FT
half = (n * cell / 2) * FT
print(f"site {site_name}: centre scene ({cx:.0f}, {cz:.0f}) ft, half-span {half:.0f} ft")
print(f"  frame with fov=5 => altitude {half/np.tan(np.radians(2.5)):.0f} ft, square viewport\n")

if not os.path.exists(render_png):
    print(f"no render at {render_png} — capture one first")
    sys.exit(1)

naip = np.load(site["file"])                      # row0 = SOUTH
shot = cv2.imread(render_png, cv2.IMREAD_COLOR)[:, :, ::-1]      # BGR -> RGB
shot = cv2.resize(shot, (n, n), interpolation=cv2.INTER_AREA)
# A top-down render is north-up; the NAIP array is south-first.
shot_s = np.flipud(shot)

# ── masks, on the site grid ────────────────────────────────────────────────
roads = json.load(open("raw/osm/roads.json", encoding="utf-8"))
blds = json.load(open("raw/osm/buildings.json", encoding="utf-8"))


def to_px(geom):
    E, N = transform("EPSG:4326", "EPSG:26911",
                     [p["lon"] for p in geom], [p["lat"] for p in geom])
    return (np.round((np.asarray(E) - x0) / cell).astype(np.int32),
            np.round((np.asarray(N) - y0) / cell).astype(np.int32))


def near(cs, rs):
    return cs.max() > -60 and cs.min() < n + 60 and rs.max() > -60 and rs.min() < n + 60


m_road = np.zeros((n, n), np.uint8)
m_walk = np.zeros((n, n), np.uint8)
for el in roads["elements"]:
    g, t = el.get("geometry"), el.get("tags", {})
    if not g or len(g) < 2:
        continue
    hw = t.get("highway")
    if hw in CLASS_W:
        w = CLASS_W[hw]
        if t.get("lanes", "").isdigit() and 0 < int(t["lanes"]) < 12:
            w = int(t["lanes"]) * 11.5 + 4
        cs, rs = to_px(g)
        if near(cs, rs):
            cv2.polylines(m_road, [np.stack([cs, rs], 1)], False, 255,
                          max(1, int(round((w - 10) / FT / cell))))
    elif hw == "footway" and t.get("footway") == "sidewalk":
        cs, rs = to_px(g)
        if near(cs, rs):
            cv2.polylines(m_walk, [np.stack([cs, rs], 1)], False, 255, 2)

m_bld = np.zeros((n, n), np.uint8)
for el in blds["elements"]:
    g = el.get("geometry")
    if not g or len(g) < 4:
        continue
    cs, rs = to_px(g)
    if near(cs, rs):
        cv2.fillPoly(m_bld, [np.stack([cs, rs], 1)], 255)

R = naip[:, :, 0].astype(np.float32)
NIR = naip[:, :, 3].astype(np.float32)
ndvi = (NIR - R) / np.maximum(NIR + R, 1e-6)
masks = {
    "road": (m_road > 0) & (m_bld == 0),
    "sidewalk": (m_walk > 0) & (m_bld == 0),
    "ground": (m_road == 0) & (m_walk == 0) & (m_bld == 0) & (ndvi < 0.12),
}


def lab(rgb):
    return cv2.cvtColor(np.uint8([[rgb]]), cv2.COLOR_RGB2LAB)[0, 0].astype(float)


print("TONE  (median over the same mask, render vs NAIP)")
print(f"  {'layer':10s} {'NAIP':9s} {'render':9s} {'dE76':>6s}   tint correction")
out = {"site": site_name, "tone": {}}
for label, m in masks.items():
    if m.sum() < 300:
        continue
    a = np.median(naip[:, :, :3][m], axis=0)
    b = np.median(shot_s[m], axis=0)
    de = float(np.linalg.norm(lab(a) - lab(b)))
    corr = [round(float(a[i] / max(b[i], 1e-3)), 4) for i in range(3)]
    hx = lambda v: "#%02x%02x%02x" % tuple(int(x) for x in v)
    print(f"  {label:10s} {hx(a):9s} {hx(b):9s} {de:6.1f}   x{corr}")
    out["tone"][label] = {"naip": hx(a), "render": hx(b), "dE76": round(de, 1),
                          "correction": corr, "px": int(m.sum())}


def edges(img):
    g = cv2.GaussianBlur(img.astype(np.float32), (5, 5), 1.0)
    m = np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0, 3), cv2.Sobel(g, cv2.CV_32F, 0, 1, 3))
    return np.clip(m / max(np.percentile(m, 99.5), 1e-6), 0, 1).astype(np.float64)


ref = edges(cv2.cvtColor(naip[:, :, :3], cv2.COLOR_RGB2GRAY))
g = edges(cv2.cvtColor(shot_s, cv2.COLOR_RGB2GRAY))
variants = {"as-is": g, "flipud": np.flipud(g), "fliplr": np.fliplr(g),
            "rot180": np.flipud(np.fliplr(g))}
scores = {k: msssim(ref, v) for k, v in variants.items()}
best = max(scores, key=scores.get)
runner = max(v for k, v in scores.items() if k != "as-is")
print("\nSTRUCTURE  MS-SSIM on edge magnitude, by orientation")
for k, v in sorted(scores.items(), key=lambda kv: -kv[1]):
    print(f"  {k:8s} {v:.4f}{'   <-- best' if k == best else ''}")
print(f"  as-is margin over the best wrong flip: {scores['as-is'] - runner:+.4f}"
      f"   {'FRAMING OK' if best == 'as-is' else 'FRAMING WRONG — tone numbers above are suspect'}")

out["structure"] = {"by_orientation": scores, "best": best,
                    "margin": scores["as-is"] - runner}
os.makedirs("out", exist_ok=True)
json.dump(out, open(f"out/render_vs_naip_{site_name}.json", "w"), indent=2)
print(f"\nwrote out/render_vs_naip_{site_name}.json")
