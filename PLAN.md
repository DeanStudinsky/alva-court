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
  This list is exhaustive, not indicative: a Microsoft ML footprint set with
  four times OSM's coverage and a photogrammetric height on 87% of buildings
  was built, rendered, and then removed for being outside it.
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
- [x] Buildings across the valley — 33 127 OpenStreetMap footprints out to the
      edge of `valley.bin`, provenance flagged per building and toggleable in
      the scene (`B` / `I`). Heights are almost all inferred: OSM tags a height
      on 3 of them. See CLAUDE.md for what that trade cost.
- [x] Palm Springs + Cathedral City paving — 1 100 mi of OSM roadway in asphalt,
      100 mi of *mapped* sidewalk in concrete, draped on 3DEP
- [x] Surface tone calibrated against NAIP, not chosen by eye — roadway dE76
      3.2 / 1.0, sidewalk 4.5 / 4.6, bare ground 9.1 / 5.5 (Palm Springs /
      Cathedral City). Repeatable: `render_vs_naip_psc.py`

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
| `valley_buildings.bin` | footprint | 40 km (131 234 ft) | 33 127 OSM buildings, Desert Hot Springs → west Indio |
| `psc_surfaces.bin` | ribbon | Palm Springs + Cathedral City | 1 100 mi roadway, 100 mi mapped sidewalk |
| `raw/naip_sites/` | 0.5 m | 8 × 500 m boxes | the calibration references |

OSM covers ±1800 ft, wider than either tile. Intersections beyond the wide tile
(Tortuga, Concepcion) need an adjacent LAZ tile from USGS TNM.

## Running it

Static HTTP server at the repo root (ES modules + `fetch` both fail on
`file://`), then open `neighbourhood.html`. Do **not** serve the repo root with a
directory-listing server: `.git/config` contains a plaintext token.
