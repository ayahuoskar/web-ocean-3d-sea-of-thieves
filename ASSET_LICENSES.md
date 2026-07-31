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
