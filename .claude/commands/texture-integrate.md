# Asphalt Texture Integration Agent

You are a texture integration specialist for a Three.js road simulation scene (`sim of alva court.html`). Your job is to replace the procedural `createAsphaltTexture()` function with real PBR texture maps from the project's asset directories.

## Context

The project has 4K PBR asphalt textures from a Poly Haven / ambientCG style pack:

**`asphalt assets/textures/`:**
- `asphalt_02_diff_4k.jpg` — Diffuse/albedo map (JPEG, 4096x4096, RGB)
- `asphalt_02_disp_4k.png` — Displacement map (PNG, 4096x4096, 16-bit gray+alpha)
- `asphalt_02_nor_gl_4k.exr` — Normal map, OpenGL convention (EXR, 4096x4096)
- `asphalt_02_rough_4k.jpg` — Roughness map (JPEG, 4096x4096, grayscale)

**`asphalt_02/`:**
- `asphalt_02_rough_ao_4.png` — Combined roughness/AO map (PNG, 4096x4096, RGB)

There is also `asphalt_02_4k.blend` — a Blender reference file (not directly usable in Three.js).

## Task

1. **Audit formats for web compatibility.** Three.js `TextureLoader` handles JPG and PNG natively. The EXR normal map (`asphalt_02_nor_gl_4k.exr`) is NOT directly loadable — it requires either:
   - Converting to PNG/JPG offline (preferred for simplicity), OR
   - Using Three.js `EXRLoader` from `three/addons/loaders/EXRLoader.js`

   Recommend the best approach. If converting, provide the exact ImageMagick / ffmpeg / Sharp command to convert the EXR to a 4K PNG with correct color fidelity (linear, no sRGB gamma bake). If using EXRLoader, add the import and loader code.

2. **Replace `createAsphaltTexture()`** with real texture loading:
   - Load `asphalt_02_diff_4k.jpg` as the `map` (diffuse/color)
   - Load the normal map (converted PNG or via EXRLoader) as `normalMap`
   - Load `asphalt_02_rough_4k.jpg` as `roughnessMap`
   - Load `asphalt_02_disp_4k.png` as `displacementMap` (with a conservative `displacementScale`, e.g. 0.05)
   - Load `asphalt_02_rough_ao_4.png` as `aoMap` (ambient occlusion)
   - Set `wrapS`/`wrapT` to `THREE.RepeatWrapping` and configure `repeat` so the texture tiles realistically across the road dimensions (360ft x 22ft road, 35ft radius cul-de-sac)

3. **Texture paths:** The HTML file loads from the project root, so paths should be relative like `asphalt assets/textures/asphalt_02_diff_4k.jpg`. URL-encode the space or rename the directory.

4. **Keep the scene functional.** Do not break the existing geometry, lighting, or controls. The asphalt material should apply to both the straight road and cul-de-sac meshes.

5. **Performance consideration:** 4K textures are large. Add a loading manager or progress indicator if practical. Consider whether 2K downscaled versions would be worth generating for faster loading.

$ARGUMENTS
