# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-based Three.js render of the neighbourhood around **68075 Alva Court, Cathedral City, CA 92234** (Coachella Valley desert floor; lon/lat −116.474082, 33.836760), built from public geospatial data.

**Read `PLAN.md` first.** It holds the purpose (a traffic-safety case for city council about hit-and-run collisions at stop signs), the ground rules, and the current priority list. This file covers only *how the code works*.

There is **no build system, framework, or bundler**. Scenes are standalone HTML importing Three.js from the unpkg CDN via an `importmap`. Offline Node scripts in `elevation/` decode raw LiDAR/imagery into binaries the page fetches at load.

## Running it

Must be served over **HTTP** — ES-module imports and `fetch()` both fail from `file://`. Any static server works; prior sessions used port 7432. The `/run` skill is pre-approved.

**Do not serve the repo root with a directory-listing or dotfile-serving server** — `.git/config` contains a plaintext GitHub PAT. A minimal Node server that denies dot-segments is the safe pattern (bind `127.0.0.1`, 403 any path segment starting with `.`).

No tests, no lint, no build. "Verify a change" = serve it, load it, read the console.

## Coordinate system — get this right

- **`+X = East`, `+Z = SOUTH`, `North = −Z`, `Y = up`. All world units are FEET.**
- The street address is scene **(0, 0)**. Cul-de-sac bulb rounds **due east** at x≈+213; the road runs **west**. Road centreline z ≈ −21 → −42 (i.e. *north* of the address).
- Scene `y = 0` is `BASE_FT` = **399.573 ft** (DTM at the address, NAVD88). Both terrain tiles share this datum.
- Source CRS **UTM 11N / NAD83 (EPSG:26911)**, vertical **NAVD88 m**, ×3.280839895 → feet.
- Grid convention for **every** binary: `row 0 = SOUTH`, `col 0 = WEST`. Grid sample `(row, col)` is the value at UTM `(X0 + col·cell, Y0 + row·cell)`. NAIP PNGs are north-up, so rows get flipped on read.
- Derive scene↔grid transforms from the UTM georef directly (see `index.html`'s `cellX`/`cellZ`/`colAt`/`rowAt`). Note `NC` samples span `NC−1` cell widths, not `NC` — getting this wrong stretches terrain against building placement.

### Three traps that have already cost real time

1. **`.claude/commands/lighting-setup.md` assumes `−Z = south`. This scene uses `+Z = south`.** Its "negative Z component" advice is wrong here, and is why the sun currently sits north (`z = −200`) casting shadows the wrong way. Measured shadow directions in the NAIP put the real sun **south-southwest**.
2. **`terrain_meta.json`'s `road.*LocalFt` pairs are already world `[x, z]`** (`make_terrain.mjs` writes `z = -(N - addrN)`) — *not* `[E, N]`. Negating `z` "to convert" lands you 83 ft off, and because desert soil and asphalt are the same tone here, the wrong sample still returns grey and looks like a successful registration check. By contrast **`houses.json` uses `{E, N}` with N north-positive**, so scene `z = −N`. Two different conventions in two files; check which one you're holding.
3. **A footprint cluster is not one roof.** The flood fill merges main house + garage extension + patio awnings + (on the subject house) a semi-attached corrugated RV cover into one id at different heights. Never fit a single height per house; extrude the DSM per cell. Roof area whose NAIP colour differs from the main roof is usually an awning.

## Data pipeline (`elevation/`)

Node ESM (`"type": "module"`; deps `laz-perf` WASM + `pngjs`). **Run with `elevation/` as cwd** — scripts use bare relative paths.

```
cd elevation && npm install
node process_laz.mjs     # LAZ -> DSM/DTM .asc + 16-bit heightmap + meta
node make_terrain.mjs    # .asc -> terrain.bin + terrain_meta.json
node classify.mjs        # terrain.bin + LAZ -> classify.bin (routes A & B)
node naip_analyze.mjs    # naip/*.png + classify.bin -> naip.bin, houses.bin, houses.json
node make_osm.mjs        # osm_raw.json -> osm.json  (street network + stop signs)
node preview.mjs         # optional hillshade PNG
```

`process_laz.mjs` and `make_terrain.mjs` take **env overrides** so one code path cuts both tiles. Bare invocation reproduces the original detail-tile outputs exactly. The wide tile:

```
ALVA_CELL=1 ALVA_X0=548000 ALVA_Y0=3744000 ALVA_NC=1000 ALVA_NR=1000 \
  ALVA_PREFIX=wide node process_laz.mjs
ALVA_IN=wide ALVA_OUT=terrain_wide ALVA_BASE_FT=399.57349381574863 node make_terrain.mjs
```

`ALVA_BASE_FT` is **required** for any additional tile — without it each tile computes its own datum and they won't share `y = 0`.

### The classifier chain (why there are three opinions)

Trees and buildings are both "tall", and getting that distinction wrong puts fake sight-line blockers in a safety render. So three independent routes vote:

- **A** (`classify.mjs`) — LiDAR return structure: tall + porous/multi-return ⇒ tree.
- **B** (`classify.mjs`) — surface geometry: tall + planar ⇒ building.
- **C** (`naip_analyze.mjs`) — NDVI from 4-band NAIP: irrigated vegetation is bright NIR / dark red. A cue the LiDAR cannot see.

A/B agree ~80%; all three are unanimous on 59% of tall cells. `classify_review.html` is a standalone 2D canvas tool for eyeballing the **disagreement** map — that's its purpose, not the agreement.

### Products and who consumes them

| file | what | consumed by |
|---|---|---|
| `terrain.bin` | 0.5 m, 640², `[DSM][DTM]` Float32LE ft | ground mesh, `groundY()`, house seating |
| `terrain_wide.bin` | 1 m, 1000², same layout + datum | wider context (not yet wired in) |
| `houses.bin` | Uint16 per cell, `0`=none else `houseId+1` | **building geometry source** |
| `houses.json` | 108 houses: centroid, bbox, heights, roof colour | roof colours, façade location |
| `naip.bin` | `[labelC, ndvi, R, G, B]` uint8 per cell | per-cell roof colour |
| `classify.bin` | `[A, B, nDSM, mfrac, rough, disc]` uint8 | `classify_review.html` |
| `osm.json` | 78 ways, 37 stop signs, 22 intersections, scene-local ft | roads/signs (not yet wired in) |

`osm_raw.json` and `wide_*.asc` are gitignored intermediates; regenerate via the header comment in `make_osm.mjs` / the env vars above.

## The scene

- **`index.html`** — the live scene. LiDAR DTM ground; all 108 buildings extruded from `houses.bin` (roof quad per cell at measured DSM height, per-cell NAIP colour, wall quads wherever a neighbour is lower — so internal height breaks render as the garage/awning faces they are). Palm-frond spikes are capped per cluster at p99 + 2 ft. Doors/windows/garage are placed by finding the real façade in the mask (street-most cell per column, longest coplanar run) for the 10 houses fronting Alva Ct.
- **`sim of alva court.html`** — older flat-ground scene; the reference for **PBR asphalt compositing** (`blendWithNoise`, seeded value noise, cul-de-sac UV remap, async `EXRLoader`). Keep for that technique.
- **`elevation/classify_review.html`** — classifier review tool, no Three.js.

**`src/` split is planned but does not exist yet** (P0 in `PLAN.md`). Until it lands, `index.html` holds the whole scene inline.

## Textures & assets

- `textures/asphalt/` and `textures/cement/` are the paths the scenes load. `asphalt assets/` and `cement assets/` are the older duplicates, still tracked. One live reference remains to the old path: `index.html` loads `cement assets/painted-gray-wall.jpg`, which has **no copy** under `textures/cement/`.
- `grass/` and `stucco/` are committed (4K/2K diffuse+normal+bump sets) but **not yet referenced by any scene**. Source `.zip`s are gitignored; extracted folders are committed.
- Directory names contain **spaces** — URL-encode in HTML (`asphalt%20assets/...`, `%20(1)`).
- `asphalt_02_nor_gl_4k.exr` is not loadable by `TextureLoader`; use `EXRLoader` from `three/addons` or convert to PNG offline in linear space.
- Measured surface colours from the aerial, if you need them without re-deriving: ground/gravel `#9a988d`, roadway `#9d9a8e`, turf `#596b52`, canopy `#476047`, roofs `#b9ada3`. The old flat ground colour `#c4956a` is too warm and too saturated.

## Git tracking

`git ls-files` is authoritative — **not `.gitignore`**. Several ignore rules are inert no-ops because the files were committed before being ignored (`asphalt assets/`, `cement assets/`, `asphalt_02/`, `visual examples/`, the `.blend`, and `sim of alva court.html` are all on GitHub regardless).

As of this writing, still untracked: **`.claude/settings.json`** (permission allowlists only) and `elevation/raw/` (~200 MB, intentionally out). Everything else the app needs is committed.

## Design intent (`.claude/commands/`)

- **`/lighting-setup`** — desert sun from the southeast, warm `0xfff4e0`, sky `0x87CEEB`, sandy bounce `0xd4a76a`, low ambient for hard shadows, cul-de-sac all asphalt, no HDRI/fog/post. **Its Z-sign is wrong for this scene — see trap 1.**
- **`/satellite-critique`** — render-vs-aerial accuracy report format.
- **`/texture-integrate`** — spec for wiring the 4K PBR asphalt maps in.

All three name `sim of alva court.html` explicitly; apply their intent to whichever scene you're editing.

## Security

`.git/config`'s `origin` URL embeds a **plaintext GitHub PAT**. It should be rotated and moved to a credential helper. Never print the remote URL or commit it anywhere.
