"""Downsample the 1 m corridor DEM into a scene tile.

    run from elevation/ :  python make_corridor_tile.py [factor]

WHY THIS TILE EXISTS
--------------------
reconcile_cc.py measured the coarse surface against 1 m 3DEP over the wash
corridor and found nothing to correct:

    horizontal   peak correlation at dE=0, dN=0        already registered
    vertical     bulk median -0.17 ft over 18 476 pts  no datum offset
    along-wash   median -0.10 ft, no significant tilt  no drift

There is no offset field to interpolate. The entire disagreement is RESOLUTION,
and it shows up as equal and opposite errors on the two control features:

    the wash     39 m posting bridges over a 100 m channel, so the coarse
                 surface floats 4.8 ft ABOVE the real bed, and the 13.1 ft
                 walls do not exist in it at all
    the runways  the same posting shaves down an engineered flat, so it sits
                 3.6 ft BELOW the real surface

Both are cured by giving the corridor a finer tile rather than by bending the
numbers. That is also the honest answer to "make it look right": the wash reads
as a smooth swale today because the data genuinely has no channel in it, not
because anything is mis-registered.

4 m, not 1 m: the corridor is 6000 x 5000 at 1 m, and 30 M vertices is not a
thing the scene can carry next to everything else. At 4 m it is 1500 x 1250 =
1.9 M, the same order as valley.bin, and a 100 m channel with 13 ft walls is
still resolved across ~25 cells.

Writes terrain_corridor.bin + terrain_corridor_meta.json in the standard
convention, so the scene's existing nested-tile loader takes it unchanged.
The nesting order becomes terrain -> terrain_wide -> terrain_corridor ->
valley, and each of those really is contained in the next.
"""
import json, sys
import numpy as np

FACTOR = int(sys.argv[1]) if len(sys.argv) > 1 else 4

dm = json.load(open("dem1m_wash_meta.json", encoding="utf-8"))
W, H, POST = dm["nc"], dm["nr"], dm["cellM"]
X0, Y0 = dm["utm"]["x0"], dm["utm"]["y0"]
a = np.fromfile(dm["bin"]["file"], dtype="<f4").reshape(H, W)
print(f"source {W}x{H} @ {POST} m, valid {100*np.isfinite(a).mean():.1f}%")

nc, nr = W // FACTOR, H // FACTOR
a = a[:nr * FACTOR, :nc * FACTOR].reshape(nr, FACTOR, nc, FACTOR)

# Block mean, NaN-aware. Mean rather than a decimated sample: a channel wall is
# a step, and sampling every 4th cell would put the wall in a different place
# depending on phase. Averaging keeps the wall where it is and only softens it.
with np.errstate(invalid="ignore"):
    out = np.nanmean(a, axis=(1, 3)).astype(np.float32)

bad = ~np.isfinite(out)
if bad.any():
    # The scene's loader has no nodata concept, so any hole has to be filled.
    # Nearest valid by a couple of dilation passes, then flat fill.
    med = float(np.nanmedian(out))
    for _ in range(4):
        if not (~np.isfinite(out)).any():
            break
        pad = np.pad(out, 1, constant_values=np.nan)
        stack = np.stack([pad[:-2, 1:-1], pad[2:, 1:-1], pad[1:-1, :-2], pad[1:-1, 2:]])
        with np.errstate(invalid="ignore"):
            fill = np.nanmean(stack, axis=0)
        out = np.where(np.isfinite(out), out, fill)
    out = np.where(np.isfinite(out), out, med)
print(f"filled {int(bad.sum())} nodata cells")

out.tofile("terrain_corridor.bin")

cell = POST * FACTOR
json.dump({
    "note": "Elevations in FEET (NAVD88). Grid row0=SOUTH, col0=WEST. World: "
            "+X=East, +Z=South, North=-Z. Subtract baseFt for y near 0.",
    "source": "USGS 3DEP bare earth via the 3DEPElevation ImageServer, 1 m, "
              "block-averaged to " + str(int(cell)) + " m (fetch_3dep_utm.py -> make_corridor_tile.py)",
    "purpose": "Wash corridor + PSP + Cimarron + Escena. Resolves the Whitewater "
               "channel (13.1 ft walls) and the airport platform, neither of which "
               "exists in valley.bin at 39 m posting.",
    "nc": nc, "nr": nr, "cellM": cell, "cellFt": cell * 3.280839895,
    "utm": {"x0": X0, "y0": Y0,
            "addrE": 548660.3, "addrN": 3744180.9, "wkid": 26911},
    "baseFt": dm["baseFt"],
    "elevFt": [round(float(out.min()), 2), round(float(out.max()), 2)],
    "bin": {"file": "terrain_corridor.bin", "layout": "Float32LE: DTM[nc*nr]"},
    "sizeFt": [nc * cell * 3.280839895, nr * cell * 3.280839895],
}, open("terrain_corridor_meta.json", "w"), indent=2)

print(f"wrote terrain_corridor.bin  {nc}x{nr} @ {cell:.0f} m  "
      f"({out.nbytes/1e6:.1f} MB)  elev {out.min():.0f}..{out.max():.0f} ft")
print(f"  E {X0:.0f}..{X0+nc*cell:.0f}   N {Y0:.0f}..{Y0+nr*cell:.0f}")
