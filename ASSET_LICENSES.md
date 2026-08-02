# Asset Licences

## Policy

`web-ocean-3d` is an **independent implementation**. Every binary asset shipped in
`public/` must be one of:

- **CC0 1.0** (public domain dedication), or
- **CC-BY** with the exact attribution string recorded in the table below, or
- **MIT / Apache-2.0**.

Nothing else may be committed. In particular, **no assets are taken from
threejswaterpro.com or any other commercial product**. Assets are sourced from
[Poly Haven](https://polyhaven.com), [ambientCG](https://ambientcg.com) and the
[Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)
repository (the latter licence-checked per model).

As of this revision **every asset in `public/` is CC0 1.0 from Poly Haven**, so no
attribution is legally required. We record the authors anyway, as a courtesy and
because Poly Haven asks contributors be credited where practical.

Sources that were surveyed and not used, so the next reader does not repeat the
search:

| Source | Licence | Why not |
| --- | --- | --- |
| [Quaternius](https://quaternius.com) | CC0 | Has the animated bird and fish packs this scene wants, but the downloads are issued by client-side script rather than a stable URL, so they cannot be fetched reproducibly. |
| [Kenney](https://kenney.nl) | CC0 | Excellent, and stylistically incompatible: flat-shaded low-poly next to photogrammetry reads as two projects. |
| [ambientCG](https://ambientcg.com) | CC0 | Materials and HDRIs rather than props; its "3D model" category is scatter meshes. Worth revisiting for ground materials. |
| [Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets) | per model | `BarramundiFish` is CC0 and genuinely good, but it is a 12 MB single fish. A school wants instanced geometry, not one hero mesh. |
| [Smithsonian Open Access](https://www.si.edu/openaccess) | CC0 | Real scanned artefacts, plausible for the treasure. Scans are heavy and would need the same decimation pass; not needed once Poly Haven's cove set covered it. |

> Poly Haven's licence terms: <https://polyhaven.com/license> — *"All assets on Poly
> Haven are licensed as CC0, which is the same as public domain. This means you can use,
> modify and redistribute our assets for any purpose, including commercial use, without
> attribution or permission."*

### Reproducing this asset set

Run:

```sh
node scripts/fetch-assets.mjs
```

The script resolves the exact download URLs at run time through the public Poly Haven
API (`https://api.polyhaven.com/files/<slug>`), verifies each file's size and MD5
against the API manifest, checks glTF/HDR/JPEG magic bytes, and is idempotent (existing
non-empty files are skipped). It exits non-zero on any failure.

**Total size of `public/`: 57,433,343 bytes (54.77 MiB / 57.43 MB) across 36 files.**

### Paths the application should load

| Purpose | Path (relative to the Vite public root, i.e. served at `/`) |
| --- | --- |
| Hero sailing ship | `/models/dutch_ship_medium/dutch_ship_medium_2k.gltf` |
| Floating buoy | `/models/ocean_buoy/ocean_buoy_1k.gltf` |
| Floating barrel | `/models/barrel_03/barrel_03_1k.gltf` |
| Rock (island detail) | `/models/rock_07/rock_07_1k.gltf` |
| Cliff (island silhouette) | `/models/namaqualand_cliff_01/namaqualand_cliff_01_1k.gltf` |
| Environment — day preset | `/hdris/kloofendal_43d_clear_puresky_2k.hdr` |
| Environment — sunset preset | `/hdris/industrial_sunset_puresky_2k.hdr` |
| Environment — foggy preset | `/hdris/kloofendal_misty_morning_puresky_2k.hdr` |
| Environment — moonlit preset | `/hdris/satara_night_no_lamps_2k.hdr` |

Each `.gltf` resolves its own `.bin` and `textures/*.jpg` siblings by relative URI, so
the folder layout must be preserved as-is.

---

## Asset inventory

One row per file shipped in `public/`.

| Asset | File path | Source URL | Author | Licence | Modifications |
| --- | --- | --- | --- | --- | --- |
| Dutch Ship Medium (`dutch_ship_medium`, 2k) | `public/models/dutch_ship_medium/dutch_ship_medium_2k.gltf` | https://polyhaven.com/a/dutch_ship_medium | James Ray Cock (model, textures, cleanup); Rico Cilliers (sails model, textures); Nicolò Zubbini (original model) | CC0 1.0 | None (as downloaded) |
| Dutch Ship Medium (`dutch_ship_medium`, 2k) | `public/models/dutch_ship_medium/dutch_ship_medium.bin` | https://polyhaven.com/a/dutch_ship_medium | James Ray Cock; Rico Cilliers; Nicolò Zubbini | CC0 1.0 | None (as downloaded) |
| Dutch Ship Medium (`dutch_ship_medium`, 2k) | `public/models/dutch_ship_medium/textures/dutch_ship_medium_hull_diff_2k.jpg` | https://polyhaven.com/a/dutch_ship_medium | James Ray Cock; Rico Cilliers; Nicolò Zubbini | CC0 1.0 | None (as downloaded) |
| Dutch Ship Medium (`dutch_ship_medium`, 2k) | `public/models/dutch_ship_medium/textures/dutch_ship_medium_hull_arm_2k.jpg` | https://polyhaven.com/a/dutch_ship_medium | James Ray Cock; Rico Cilliers; Nicolò Zubbini | CC0 1.0 | None (as downloaded) |
| Dutch Ship Medium (`dutch_ship_medium`, 2k) | `public/models/dutch_ship_medium/textures/dutch_ship_medium_hull_nor_gl_2k.jpg` | https://polyhaven.com/a/dutch_ship_medium | James Ray Cock; Rico Cilliers; Nicolò Zubbini | CC0 1.0 | None (as downloaded) |
| Dutch Ship Medium (`dutch_ship_medium`, 2k) | `public/models/dutch_ship_medium/textures/dutch_ship_medium_rigging_diff_2k.jpg` | https://polyhaven.com/a/dutch_ship_medium | James Ray Cock; Rico Cilliers; Nicolò Zubbini | CC0 1.0 | None (as downloaded) |
| Dutch Ship Medium (`dutch_ship_medium`, 2k) | `public/models/dutch_ship_medium/textures/dutch_ship_medium_rigging_arm_2k.jpg` | https://polyhaven.com/a/dutch_ship_medium | James Ray Cock; Rico Cilliers; Nicolò Zubbini | CC0 1.0 | None (as downloaded) |
| Dutch Ship Medium (`dutch_ship_medium`, 2k) | `public/models/dutch_ship_medium/textures/dutch_ship_medium_rigging_nor_gl_2k.jpg` | https://polyhaven.com/a/dutch_ship_medium | James Ray Cock; Rico Cilliers; Nicolò Zubbini | CC0 1.0 | None (as downloaded) |
| Dutch Ship Medium (`dutch_ship_medium`, 2k) | `public/models/dutch_ship_medium/textures/dutch_ship_medium_sails_diff_2k.jpg` | https://polyhaven.com/a/dutch_ship_medium | James Ray Cock; Rico Cilliers; Nicolò Zubbini | CC0 1.0 | None (as downloaded) |
| Dutch Ship Medium (`dutch_ship_medium`, 2k) | `public/models/dutch_ship_medium/textures/dutch_ship_medium_sails_arm_2k.jpg` | https://polyhaven.com/a/dutch_ship_medium | James Ray Cock; Rico Cilliers; Nicolò Zubbini | CC0 1.0 | None (as downloaded) |
| Dutch Ship Medium (`dutch_ship_medium`, 2k) | `public/models/dutch_ship_medium/textures/dutch_ship_medium_sails_nor_gl_2k.jpg` | https://polyhaven.com/a/dutch_ship_medium | James Ray Cock; Rico Cilliers; Nicolò Zubbini | CC0 1.0 | None (as downloaded) |
| Ocean Buoy (`ocean_buoy`, 1k) | `public/models/ocean_buoy/ocean_buoy_1k.gltf` | https://polyhaven.com/a/ocean_buoy | Mateusz Sadek | CC0 1.0 | None (as downloaded) |
| Ocean Buoy (`ocean_buoy`, 1k) | `public/models/ocean_buoy/ocean_buoy.bin` | https://polyhaven.com/a/ocean_buoy | Mateusz Sadek | CC0 1.0 | None (as downloaded) |
| Ocean Buoy (`ocean_buoy`, 1k) | `public/models/ocean_buoy/textures/ocean_buoy_diff_1k.jpg` | https://polyhaven.com/a/ocean_buoy | Mateusz Sadek | CC0 1.0 | None (as downloaded) |
| Ocean Buoy (`ocean_buoy`, 1k) | `public/models/ocean_buoy/textures/ocean_buoy_arm_1k.jpg` | https://polyhaven.com/a/ocean_buoy | Mateusz Sadek | CC0 1.0 | None (as downloaded) |
| Ocean Buoy (`ocean_buoy`, 1k) | `public/models/ocean_buoy/textures/ocean_buoy_nor_gl_1k.jpg` | https://polyhaven.com/a/ocean_buoy | Mateusz Sadek | CC0 1.0 | None (as downloaded) |
| Ocean Buoy (`ocean_buoy`, 1k) | `public/models/ocean_buoy/textures/ocean_buoy_emission_1k.jpg` | https://polyhaven.com/a/ocean_buoy | Mateusz Sadek | CC0 1.0 | None (as downloaded) |
| Barrel 03 (`barrel_03`, 1k) | `public/models/barrel_03/barrel_03_1k.gltf` | https://polyhaven.com/a/barrel_03 | Serhii Khromov | CC0 1.0 | None (as downloaded) |
| Barrel 03 (`barrel_03`, 1k) | `public/models/barrel_03/barrel_03.bin` | https://polyhaven.com/a/barrel_03 | Serhii Khromov | CC0 1.0 | None (as downloaded) |
| Barrel 03 (`barrel_03`, 1k) | `public/models/barrel_03/textures/barrel_03_diff_1k.jpg` | https://polyhaven.com/a/barrel_03 | Serhii Khromov | CC0 1.0 | None (as downloaded) |
| Barrel 03 (`barrel_03`, 1k) | `public/models/barrel_03/textures/barrel_03_arm_1k.jpg` | https://polyhaven.com/a/barrel_03 | Serhii Khromov | CC0 1.0 | None (as downloaded) |
| Barrel 03 (`barrel_03`, 1k) | `public/models/barrel_03/textures/barrel_03_nor_gl_1k.jpg` | https://polyhaven.com/a/barrel_03 | Serhii Khromov | CC0 1.0 | None (as downloaded) |
| Rock 07 (`rock_07`, 1k) | `public/models/rock_07/rock_07_1k.gltf` | https://polyhaven.com/a/rock_07 | Jenelle van Heerden | CC0 1.0 | None (as downloaded) |
| Rock 07 (`rock_07`, 1k) | `public/models/rock_07/rock_07.bin` | https://polyhaven.com/a/rock_07 | Jenelle van Heerden | CC0 1.0 | None (as downloaded) |
| Rock 07 (`rock_07`, 1k) | `public/models/rock_07/textures/rock_07_diff_1k.jpg` | https://polyhaven.com/a/rock_07 | Jenelle van Heerden | CC0 1.0 | None (as downloaded) |
| Rock 07 (`rock_07`, 1k) | `public/models/rock_07/textures/rock_07_arm_1k.jpg` | https://polyhaven.com/a/rock_07 | Jenelle van Heerden | CC0 1.0 | None (as downloaded) |
| Rock 07 (`rock_07`, 1k) | `public/models/rock_07/textures/rock_07_nor_gl_1k.jpg` | https://polyhaven.com/a/rock_07 | Jenelle van Heerden | CC0 1.0 | None (as downloaded) |
| Namaqualand Cliff 01 (`namaqualand_cliff_01`, 1k) | `public/models/namaqualand_cliff_01/namaqualand_cliff_01_1k.gltf` | https://polyhaven.com/a/namaqualand_cliff_01 | Jenelle van Heerden (photography); Rico Cilliers (modeling) | CC0 1.0 | None (as downloaded) |
| Namaqualand Cliff 01 (`namaqualand_cliff_01`, 1k) | `public/models/namaqualand_cliff_01/namaqualand_cliff_01.bin` | https://polyhaven.com/a/namaqualand_cliff_01 | Jenelle van Heerden; Rico Cilliers | CC0 1.0 | None (as downloaded) |
| Namaqualand Cliff 01 (`namaqualand_cliff_01`, 1k) | `public/models/namaqualand_cliff_01/textures/namaqualand_cliff_01_diff_1k.jpg` | https://polyhaven.com/a/namaqualand_cliff_01 | Jenelle van Heerden; Rico Cilliers | CC0 1.0 | None (as downloaded) |
| Namaqualand Cliff 01 (`namaqualand_cliff_01`, 1k) | `public/models/namaqualand_cliff_01/textures/namaqualand_cliff_01_arm_1k.jpg` | https://polyhaven.com/a/namaqualand_cliff_01 | Jenelle van Heerden; Rico Cilliers | CC0 1.0 | None (as downloaded) |
| Namaqualand Cliff 01 (`namaqualand_cliff_01`, 1k) | `public/models/namaqualand_cliff_01/textures/namaqualand_cliff_01_nor_gl_1k.jpg` | https://polyhaven.com/a/namaqualand_cliff_01 | Jenelle van Heerden; Rico Cilliers | CC0 1.0 | None (as downloaded) |
| Kloofendal 43d Clear (Pure Sky) (`kloofendal_43d_clear_puresky`, 2k HDR) | `public/hdris/kloofendal_43d_clear_puresky_2k.hdr` | https://polyhaven.com/a/kloofendal_43d_clear_puresky | Greg Zaal | CC0 1.0 | None (as downloaded) |
| Industrial Sunset (Pure Sky) (`industrial_sunset_puresky`, 2k HDR) | `public/hdris/industrial_sunset_puresky_2k.hdr` | https://polyhaven.com/a/industrial_sunset_puresky | Jarod Guest (sky edits); Sergej Majboroda (original) | CC0 1.0 | None (as downloaded) |
| Kloofendal Misty Morning (Pure Sky) (`kloofendal_misty_morning_puresky`, 2k HDR) | `public/hdris/kloofendal_misty_morning_puresky_2k.hdr` | https://polyhaven.com/a/kloofendal_misty_morning_puresky | Greg Zaal | CC0 1.0 | None (as downloaded) |
| Satara Night (No Lamps) (`satara_night_no_lamps`, 2k HDR) | `public/hdris/satara_night_no_lamps_2k.hdr` | https://polyhaven.com/a/satara_night_no_lamps | Greg Zaal | CC0 1.0 | None (as downloaded) |

### Scene dressing (`public/models/dressing/`)

These are **modified**, and the modification is the point. Poly Haven publishes
film-quality geometry — `island_tree_01` arrives as 1.6 million triangles for a
background tree — so `scripts/optimize-assets.mjs` decimates each one, welds it,
resizes and re-encodes the textures to WebP, and compresses the result through
Meshopt. 226 MB of source becomes 24 MB shipped.

Only the `.glb` outputs are committed. The raw downloads are `.gitignore`d and
reproducible:

```sh
node scripts/fetch-assets.mjs      # authoritative source, verified against the publisher
node scripts/optimize-assets.mjs   # what actually ships
```

CC0 imposes no obligation to record any of this. It is recorded because a reader
comparing a shipped mesh against the publisher's page should be able to see why
they differ.

| Asset | File path | Source URL | Author | Licence | Modifications |
| --- | --- | --- | --- | --- | --- |
| Coast Rocks 01 (`coast_rocks_01`) | `public/models/dressing/coast_rocks_01.glb` | https://polyhaven.com/a/coast_rocks_01 | Rob Tuytel (Photography, processing); Rico Cilliers (cleanup) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Coast Rocks 03 (`coast_rocks_03`) | `public/models/dressing/coast_rocks_03.glb` | https://polyhaven.com/a/coast_rocks_03 | Rob Tuytel (Photography, processing); Rico Cilliers (cleanup) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Coastal Cliff 02 (`coastal_cliff_02`) | `public/models/dressing/coastal_cliff_02.glb` | https://polyhaven.com/a/coastal_cliff_02 | Rob Tuytel (All) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Sand Rocks Small 01 (`sand_rocks_small_01`) | `public/models/dressing/sand_rocks_small_01.glb` | https://polyhaven.com/a/sand_rocks_small_01 | Rob Tuytel (Photography, processing); Rico Cilliers (cleanup) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Island Tree 01 (`island_tree_01`) | `public/models/dressing/island_tree_01.glb` | https://polyhaven.com/a/island_tree_01 | Rob Tuytel (scanning, processing); Rico Cilliers (cleanup, processing) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Pachira Aquatica 01 (`pachira_aquatica_01`) | `public/models/dressing/pachira_aquatica_01.glb` | https://polyhaven.com/a/pachira_aquatica_01 | Rob Tuytel (scanning); Rico Cilliers (modeling) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Fern 02 (`fern_02`) | `public/models/dressing/fern_02.glb` | https://polyhaven.com/a/fern_02 | Rob Tuytel (scanning); Rico Cilliers (modeling) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Shrub Sorrel 01 (`shrub_sorrel_01`) | `public/models/dressing/shrub_sorrel_01.glb` | https://polyhaven.com/a/shrub_sorrel_01 | Rico Cilliers (All) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Grass Bermuda 01 (`grass_bermuda_01`) | `public/models/dressing/grass_bermuda_01.glb` | https://polyhaven.com/a/grass_bermuda_01 | Rico Cilliers (All) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Anthurium Botany 01 (`anthurium_botany_01`) | `public/models/dressing/anthurium_botany_01.glb` | https://polyhaven.com/a/anthurium_botany_01 | Rob Tuytel (scanning); Rico Cilliers (modeling) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Calathea Orbifolia 01 (`calathea_orbifolia_01`) | `public/models/dressing/calathea_orbifolia_01.glb` | https://polyhaven.com/a/calathea_orbifolia_01 | Rob Tuytel (scanning); Rico Cilliers (modeling) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Ship Pinnace (`ship_pinnace`) | `public/models/dressing/ship_pinnace.glb` | https://polyhaven.com/a/ship_pinnace | James Ray Cock (model, textures, cleanup); Rico Cilliers (sails model, textures); Nicolò Zubbini (original model); Yann Kervran (Rigging) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Modular Wooden Pier (`modular_wooden_pier`) | `public/models/dressing/modular_wooden_pier.glb` | https://polyhaven.com/a/modular_wooden_pier | Rico Cilliers (All) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Cannon 01 (`cannon_01`) | `public/models/dressing/cannon_01.glb` | https://polyhaven.com/a/cannon_01 | Yann Kervran (Rigging); James Ray Cock (Modeling & Texturing) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Wooden Barrels 01 (`wooden_barrels_01`) | `public/models/dressing/wooden_barrels_01.glb` | https://polyhaven.com/a/wooden_barrels_01 | James Ray Cock (All) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Wooden Lantern 01 (`wooden_lantern_01`) | `public/models/dressing/wooden_lantern_01.glb` | https://polyhaven.com/a/wooden_lantern_01 | James Ray Cock (All) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Wooden Crate 02 (`wooden_crate_02`) | `public/models/dressing/wooden_crate_02.glb` | https://polyhaven.com/a/wooden_crate_02 | James Ray Cock (modeling); Jurita Burger (graphic design) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Treasure Chest (`treasure_chest`) | `public/models/dressing/treasure_chest.glb` | https://polyhaven.com/a/treasure_chest | Rico Cilliers (All) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Wooden Crate 01 (`wooden_crate_01`) | `public/models/dressing/wooden_crate_01.glb` | https://polyhaven.com/a/wooden_crate_01 | James Ray Cock (All) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Lambis Shell (`lambis_shell`) | `public/models/dressing/lambis_shell.glb` | https://polyhaven.com/a/lambis_shell | Kuutti Siitonen (All) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Coast Line 01 (`coast_line_01`) | `public/models/dressing/coast_line_01.glb` | https://polyhaven.com/a/coast_line_01 | Rob Tuytel (Photography, processing); Rico Cilliers (cleanup) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Coast Line 02 (`coast_line_02`) | `public/models/dressing/coast_line_02.glb` | https://polyhaven.com/a/coast_line_02 | Rob Tuytel (Photography, processing); Rico Cilliers (cleanup) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Coast Land Rocks 03 (`coast_land_rocks_03`) | `public/models/dressing/coast_land_rocks_03.glb` | https://polyhaven.com/a/coast_land_rocks_03 | Rob Tuytel (Photography, processing); Rico Cilliers (cleanup) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Coastal Cliff 04 (`coastal_cliff_04`) | `public/models/dressing/coastal_cliff_04.glb` | https://polyhaven.com/a/coastal_cliff_04 | Rob Tuytel (Photography, processing); Rico Cilliers (cleanup) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Island Tree 02 (`island_tree_02`) | `public/models/dressing/island_tree_02.glb` | https://polyhaven.com/a/island_tree_02 | Rob Tuytel (scanning, processing); Rico Cilliers (cleanup, processing) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Island Tree 03 (`island_tree_03`) | `public/models/dressing/island_tree_03.glb` | https://polyhaven.com/a/island_tree_03 | Rob Tuytel (scanning, processing); Rico Cilliers (cleanup, processing) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Jacaranda Tree (`jacaranda_tree`) | `public/models/dressing/jacaranda_tree.glb` | https://polyhaven.com/a/jacaranda_tree | Rob Tuytel (guidance); Rico Cilliers (All) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Antique Estoc (`antique_estoc`) | `public/models/dressing/antique_estoc.glb` | https://polyhaven.com/a/antique_estoc | James Ray Cock (Texturing); Ulan Cabanilla (modeling) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Jug 01 (`jug_01`) | `public/models/dressing/jug_01.glb` | https://polyhaven.com/a/jug_01 | Kuutti Siitonen (All) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Wooden Bucket 01 (`wooden_bucket_01`) | `public/models/dressing/wooden_bucket_01.glb` | https://polyhaven.com/a/wooden_bucket_01 | James Ray Cock (All) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |
| Modular Fort 01 (`modular_fort_01`) | `public/models/dressing/modular_fort_01.glb` | https://polyhaven.com/a/modular_fort_01 | Rico Cilliers (All) | CC0 1.0 | Decimated, welded and Meshopt-encoded by `scripts/optimize-assets.mjs`; textures resized and re-encoded to WebP |

### Substitutions

Some slugs floated during planning do not exist on Poly Haven. Verified against
`https://api.polyhaven.com/assets?t=models` (521 models) and `?t=hdris` (981 HDRIs):

| Slug considered | Exists? | Used instead | Why |
| --- | --- | --- | --- |
| `dutch_ship_medium` | yes | — | Used as-is at 2k. (`dutch_ship_large_01` / `_02` and `ship_pinnace` also exist.) |
| `buoy` | no | `ocean_buoy` | Closest real equivalent; `lifebuoy` is the only other buoy. |
| `wooden_barrel` | no | `barrel_03` | Real barrels are `barrel_03`, `barrel_stove`, `wine_barrel_01`, `wooden_barrels_01`. `barrel_03` is the cleanest single floating prop. |
| `rock_02` | no | `rock_07` | Only `rock_07` and `rock_09` exist in the plain `rock_NN` series. |
| `cliff_side_rock` | no | `namaqualand_cliff_01` | Real cliffs are `coastal_cliff_01/02/04` and `namaqualand_cliff_01/02`. The `coastal_cliff_*` and `coast_rocks_*` scans carry 20–42 MB mesh buffers even at 1k texture resolution; `namaqualand_cliff_01` gives the same silhouette for 4.3 MiB. |
| `kloofendal_43d_clear_puresky` | yes | — | Day preset. |
| `industrial_sunset_puresky` | yes | — | Sunset preset. |
| `satara_night_no_lamps` | yes | — | Moonlit preset. |
| `qwantani_puresky` | yes | `kloofendal_misty_morning_puresky` | `qwantani_puresky` exists and is fine, but the demo needed a foggy/overcast sky rather than a fourth clear one. |

---

## Software dependencies

| Software | Version | Licence | Project URL |
| --- | --- | --- | --- |
| three.js | ^0.185.1 | MIT | https://github.com/mrdoob/three.js |
| Vite | ^6.0.0 | MIT | https://github.com/vitejs/vite |
| Playwright (`@playwright/test`) | ^1.50.0 | Apache-2.0 | https://github.com/microsoft/playwright |
| TypeScript | ^5.7.0 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| `@types/three` | ^0.185.0 | MIT (DefinitelyTyped) | https://github.com/DefinitelyTyped/DefinitelyTyped |

All of the above are permissively licensed and redistributable in a bundled build.
