# Alva Court — Elevation Data

Real elevation data for **68075 Alva Court, Cathedral City, CA 92234**
(parcel @ lon -116.474082, lat 33.836760 → UTM 11N 548660.3 E, 3744180.9 N).

## Sources (USGS 3DEP, public domain)
- **Bare-earth 1m DEM** — project `CA_CaliforniaGaps_B23`, published **Aug 2025**.
  Raw GeoTIFF: `raw/USGS_1M_DEM_CaliforniaGaps_B23.tif` (covers a 10×10km tile).
- **LiDAR point cloud** — project `CA_SaltonSea_EarthMRI_2021_D21`, **flown 2021**
  (most recent point cloud for the valley floor; required to derive a DSM).
  Raw LAZ: `raw/LPC_SaltonSea_2021_11SNT480440.laz` (27.6M points, 1km² tile).

> `raw/` is git-ignored (≈200MB). Re-download via the URLs in the git history / TNM API.

## Derived products (committed)
Clipped to a **320 × 320 m** box (640×640 @ 0.5m) centered on the address.

| File | What it is |
|------|-----------|
| `alva_dsm_0p5m.asc` | **DSM** — top surface incl. rooftops, trees. Esri ASCII grid. |
| `alva_dtm_0p5m.asc` | **DTM** — bare-earth ground only (ground-classified returns). |
| `alva_dsm_heightmap_16bit.png` | 16-bit grayscale DSM heightmap, north-up, for three.js displacement. |
| `alva_dsm_meta.json` | Georef + decode info (CRS, grid origin, min/max elevation, ft conversions). |
| `preview_dsm_hillshade.png` | Hillshade visualization (red cross = the address). |

**CRS:** UTM Zone 11N, NAD83 (EPSG:26911). **Vertical:** NAVD88, meters.
DTM relief is only ~3.3m across the block (flat valley floor); DSM rises to ~163m
at the vegetated north edge.

### Decode the heightmap PNG
```
elevation_m = min_m + (gray / 65535) * (max_m - min_m)   // see alva_dsm_meta.json
elevation_ft = elevation_m * 3.280839895
```

## Regenerate
```
npm install            # laz-perf + pngjs
node process_laz.mjs   # decode LAZ -> DSM/DTM/.asc/.png/meta
node preview.mjs       # hillshade preview
```
