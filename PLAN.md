# Alva Court — Traffic Safety Render

## Why this exists

Cathedral City has had repeated **hit-and-run collisions at stop signs** in this
neighbourhood. This project builds an accurate 3D render of the area to present
to city council, so that proposed intersection improvements are argued from
measured evidence rather than impressions — and so public money is directed at
intersections that are actually dangerous.

**The argument is sight lines.** A driver stopped at a stop sign either can or
cannot see cross traffic. What blocks that view is vegetation, walls, parked
vehicles, and grade. All of those are measurable here from public data, and the
render exists to show them.

Aesthetics are not the goal, but they are not optional either: a render that
looks wrong gets dismissed before its content is heard. Accuracy first,
presentable second, decorative last.

## Ground rules

- **Everything traceable to a public source.** USGS 3DEP LiDAR, USDA NAIP,
  OpenStreetMap, Census TIGER. No invented geometry presented as measured.
- **Say what is measured vs. inferred.** Anything the data cannot support gets
  labelled as an estimate, in the render and in the notes.
- **Free and reproducible.** CC0/public-domain assets, or generated procedurally.
- **Modular.** One concern per file, so a change to foliage doesn't risk the
  terrain.

## Status

Done:
- [x] Terrain from LiDAR — 0.5 m detail tile (320 m) + 1 m wide tile (1 km)
- [x] Buildings — all 108 extruded from real per-cell footprints, real heights
- [x] Building classifier — 3 independent routes (LiDAR returns / geometry / NDVI)
- [x] Street network + 37 stop signs + 22 intersections in scene coordinates

### P0 — no deliverable without these
- [ ] **Split into `src/` modules** (do first; every later task is cheaper after)
- [ ] Roads rendered from `osm.json`, draped on terrain
- [ ] Stop signs + intersection markers
- [ ] **Foliage** from the 34 772 canopy cells — the actual sight-line blocker
- [ ] **Sight-line analysis at each stop sign** — the argument itself
- [ ] Research + cite an intersection sight-distance standard (AASHTO / Caltrans)

### P1 — credibility
- [ ] Fix sun to `+z`; expose time-of-day (glare is a plausible factor)
- [ ] Street name + intersection labels, scale reference, north arrow
- [ ] Camera presets per intersection, to jump to a hotspot during the meeting
- [ ] On-screen provenance panel: data source + date for every layer

### P2 — presentation polish
- [ ] NAIP orthophoto draped as ground colour
- [ ] PBR textures (asphalt / concrete / stucco / grass all already in-repo)
- [ ] Pools, driveways, tile roofs

## Facts that have already cost time

- **`+Z = SOUTH`** in this scene. `.claude/commands/lighting-setup.md` assumes
  `−Z = south` and is wrong here — that is why the sun is currently in the
  wrong hemisphere.
- **`terrain_meta.json` road pairs are `[x, z]`**, already world coordinates —
  *not* `[E, N]`. Negating `z` "to convert" puts you 83 ft off and, because
  desert soil and asphalt are the same tone here, the error still samples grey
  and looks like success.
- **A footprint cluster is not one roof.** Main house + garage + awnings + RV
  cover are one connected blob at different heights. Never fit a single height
  per house.
- **Grid convention, everywhere:** 640×640 (detail) / 1000×1000 (wide),
  `row 0 = SOUTH`, `col 0 = WEST`. NAIP PNGs are north-up and get row-flipped.

## Coverage

| tile | cell | extent | reaches |
|---|---|---|---|
| `terrain.bin` | 0.5 m | 320 m (±525 ft) | Alva Ct block only |
| `terrain_wide.bin` | 1 m | 1 km (3281 ft) | 7 of the nearest intersections |

OSM covers ±1800 ft, wider than either tile. Intersections beyond the wide tile
(Tortuga, Concepcion) need an adjacent LAZ tile from USGS TNM.

## Running it

Static HTTP server at the repo root (ES modules + `fetch` both fail on
`file://`), then open `index.html`. Do **not** serve the repo root with a
directory-listing server: `.git/config` contains a plaintext token.
