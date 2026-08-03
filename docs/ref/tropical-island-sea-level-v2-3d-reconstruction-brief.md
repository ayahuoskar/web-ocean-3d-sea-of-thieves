# Tropical Island V2 — 3D Reconstruction Brief

## Purpose

Reconstruct [`tropical-island-sea-level-v2.png`](./tropical-island-sea-level-v2.png) as a convincing, navigable real-time 3D environment for the existing Web Ocean 3D project.

The target is not a one-camera matte painting. Build a coherent island that holds together from the intended water approach and nearby fly-camera views, while treating the supplied image as the primary composition and material reference. The hero approach remains the approval camera; secondary views must be plausible without compromising it.

This brief is for environment art, vegetation art, technical art, lighting, level design, and rendering engineering. Values marked **project constraint** already exist in the runtime. Values marked **visual target** describe the reference image. Values marked **starting value** should be tuned against captures rather than treated as immutable geometry.

## Reference priority

When requirements conflict, use this order:

1. Hero-frame silhouette, value structure, shoreline rhythm, and landmark readability from the reference image.
2. Existing deterministic camera, ocean, lighting, and performance contracts in the project.
3. Physical plausibility from other reachable viewpoints.
4. Local detail that is invisible from the hero approach.

Do not improve a close-up at the cost of the distant read. From approximately 400 m off the beach, the player must read five layers immediately: active dark-blue ocean, luminous turquoise shallows, broken pale-and-dark shoreline, dense green canopy, and a pale rocky crown.

## Target read

The island should feel like a compact tropical high island shaped by exposure, erosion, and longshore deposition—not a radial terrain brush with props scattered over it.

The image succeeds because it has a clear hierarchy:

- The island is one broad, calm mass against the sky.
- The summit is pale, dry, and sparsely vegetated.
- The lower two-thirds are dark, continuous vegetation rather than individual tree specimens.
- The beach is discontinuous and repeatedly interrupted by shelves, outcrops, and boulder falls.
- The lagoon is bright enough to separate the island from the foreground sea.
- The fort anchors the far-left headland.
- The jetty and beached boat create a small human-scale story near the cove without becoming the subject.
- Wind direction is consistent across waves, palms, cloud drift, and sun glitter.

The emotional tone is bright, exposed, and adventurous. Avoid resort imagery, manicured landscaping, exaggerated pirate theming, fantasy ruins, or postcard saturation.

## Runtime facts to preserve

| Item | Production value | Direction |
| --- | ---: | --- |
| Renderer | Three.js r185, WebGPU/TSL with WebGL2 fallback | All assets must work in both backends. |
| Island centre | `(-1150, 0, -780)` | **Project constraint.** Keep authored placement relative to this origin. |
| Mean shoreline radius | `500 m` | **Project constraint.** The actual coast varies by bearing. Query terrain height; never place from radius alone. |
| Island footprint | approximately `1 km` across | **Visual target.** Preserve the broad horizontal read. |
| Runtime peak | `150 m` above mean sea level | **Project constraint.** This is deliberate vertical exaggeration for readability. The original visual concept described approximately 70 m; do not reduce the runtime peak unless the entire hero framing is re-approved. |
| Lagoon floor | approximately `-5.5 m` | **Project constraint.** Maintain navigable, visibly shallow water. |
| Beach-to-growth transition | bare sand to `3.5 m`; full ground vegetation by `16 m` | **Project constraint.** Break the edge with mottling and instances. |
| Summit exposure transition | begins around `42%` of peak; mostly rock by `85%` | **Project constraint.** Keep a gradual, irregular treeline. |
| Hero environment | wind `15 m/s`, peak wavelength `47 m`, cloud coverage `0.32`, preset `skyPro` | **Project constraint.** Review art under these settings. |
| Hero camera | position `(-405, 6, -275)`, target `(-1150, 55, -780)`, time `40 s` | **Project constraint.** Primary in-engine approval shot. |
| Runtime camera FOV | `55°` vertical | **Project constraint.** Do not change the global camera to force a match. |
| Image lens language | approximately 35 mm equivalent | **Visual target.** Use as a cue for natural perspective and restrained distortion, not as authorization to alter runtime FOV. |
| Target capture | `1600 × 900`, DPR 1 | **Project constraint.** Final review resolution. |
| LOD switches | `120 m`, `420 m`; refresh after `25 m` camera travel | **Project constraint.** Author and inspect all three levels at their real screen sizes. |

The image prompt placed the camera 4 m above the water. The deterministic runtime camera is 6 m because a 1.5 m swell can occlude the island at 4 m. Use the 6 m runtime camera for sign-off. A 4 m exploratory camera may be used only to confirm that the environment still feels credible near wave height.

## Composition lock

### Hero framing

- Keep the horizon level and close to the island's shoreline band.
- The island should occupy roughly 85–90% of the frame width without clipping either headland.
- Hold the rocky summit slightly right of centre. It should not form a perfect cone or sit exactly over the island origin.
- The island mass should occupy approximately the middle 35–40% of frame height.
- Preserve substantial open ocean in the lower third. The closest waves and glitter are part of the composition, not empty space to crop away.
- Preserve clean sky above the summit. No cloud should merge with the crown strongly enough to damage its silhouette.
- The fort must read as a small, square-edged man-made interruption on the left headland.
- The cove grouping—jetty plus beached boat—must remain legible at hero distance but subordinate to the island.

### Landmark screen-space targets

At 1600 × 900:

- Fort silhouette: approximately 80–120 px wide, clearly masonry, never a castle-sized focal point.
- Jetty: approximately 130–190 px end to end, with deck and pile rhythm readable.
- Beached boat: approximately 55–90 px long, separated from the jetty silhouette.
- Individual palms: readable as trunks and crowns along the shore; inland trees should merge into canopy masses.
- Summit: retain at least three distinct pale-rock planes or breaks at hero distance; do not let it collapse into one flat tan patch.

Use these as perceptual targets, not arbitrary scaling instructions. Adjust placement and contrast before enlarging assets beyond believable scale.

## World blockout

### Terrain mass

Build the island as one continuous heightfield or watertight terrain surface shared by rendering, placement, water-depth shading, and collision queries.

The blockout must include:

1. A broad asymmetric base approximately 1 km across.
2. A gently convex overall profile, elongated laterally.
3. A summit displaced inland and slightly right of the hero camera's centreline.
4. A lower left headland that projects into the sea and supports the fort on stable tableland.
5. A sheltered near-shore cove aligned with the visible lagoon.
6. A mild right-hand shoulder falling into exposed boulder fields.
7. A shallow submarine apron around the near shore, followed by a readable shelf break into deep water.

Do not use a single radial falloff. Combine broad lobes, an offset crest, a cut-in bay, a raised headland, and localized erosion. From overhead, the coast must have large-scale asymmetry before any rocks are added.

### Terrain scale tests

Before dressing:

- Capture the hero camera with a clay terrain material.
- Capture the island from four bearings at equal distance.
- Confirm that no two bearings show the same silhouette.
- Confirm that the summit remains below an approximately 7:1 width-to-height visual ratio in the hero frame.
- Sail or fly through the cove approach and verify that the floor deepens continuously; remove any invisible berms or abrupt heightfield steps.

Do not begin final vegetation until the clay silhouette and coastline are approved.

## Shoreline and bathymetry

The shoreline is the most important realism pass after the island silhouette. It must read as a sequence of different coastal processes, not as a sand ring.

### Near-shore sequence

From open water toward land, establish:

1. Deep blue water with the full ocean response.
2. A blue-to-cyan transition over the shelf.
3. Bright turquoise lagoon water over pale sand at approximately 2–6 m depth.
4. Thin near-white sand visible beneath the shallowest water.
5. A narrow wet-sand band at the active swash.
6. Dry coral sand above repeated wave reach.
7. Dark rock interruptions and vegetation beginning above the beach.

The colour transition must be driven primarily by real water-column depth and substrate albedo. Do not paint a turquoise ring into the water or terrain texture.

### Beach construction

- Use warm coral sand, not pure white. Target a pale neutral-warm response under the current sky so it retains texture rather than clipping.
- Keep the beach narrow on exposed headlands and broader inside the cove.
- Break long arcs every 60–140 m with shelves, boulder clusters, outcrops, or vegetation pushing toward the water.
- Add broad tonal mottling from shell fragments, damp patches, weed, and wind sorting. Avoid high-frequency noise that sparkles from offshore.
- Shape the cove beach as a shallow crescent, with a gentle enough grade for the pinnace to sit naturally.
- Build a subtle wet band straddling mean sea level; it must darken and become glossier without resembling a painted stripe.

### Rock shelves and boulder fields

- Use broad, low wave-cut slabs where strata or erosion would expose them.
- Face shelf assets along the local coastline tangent, with their eroded face toward the water.
- Use tall coast assets only where their one-sided form is hidden or correctly oriented.
- Group boulders in falls and clusters of 3–9. Never distribute them at uniform spacing.
- Vary burial from roughly 15–45% of height. Floating contact points are an immediate rejection.
- Darken and increase gloss near the waterline; keep upper surfaces pale and sun-bleached.
- Reserve the strongest dark-rock contrast for the left fort headland and the near-right foreground outcrop.

Use the existing asset families as the starting kit: `rock_slab_a`, `rock_slab_b`, `rock_boulder`, `coast_line_01`, `coast_line_02`, `coast_rocks_01`, `coast_rocks_03`, and `coast_land_rocks_03`.

## Terrain materials

Author material transitions from world elevation, slope, exposure, and low-frequency masks. Avoid UV-visible rings tied to island radius.

### Material families

**Submerged sand**

- Pale warm sand with low-frequency weed and sediment patches.
- Soft ripple normal aligned broadly with wave approach.
- Enough contrast to remain visible through refraction without reading as a tiled texture.

**Wet beach**

- Approximately half the dry-sand value.
- Lower roughness and slightly higher saturation.
- No mirror-like strip; roughness variation should follow microtopography.

**Dry beach and inland soil**

- Coral sand transitions into warmer, darker mineral soil beneath vegetation.
- Use broad, metre-to-tens-of-metres breakup. Tiny procedural grain belongs in the normal map, not the albedo.

**Vegetated ground**

- The terrain itself must carry the dominant dark olive-green biomass. Instances are the hero layer, not the only source of green.
- Maintain approximately 85% perceived cover through the mid-slopes from the hero camera.
- Vary hue locally between olive, yellow-green, and deep neutral green; avoid uniformly saturated emerald.

**Summit rock**

- Pale warm-grey stone with darker seams and weathered recesses.
- Use slope and erosion direction to reveal large planes.
- Maintain enough midtone separation that the crown does not clip under midday lighting.
- Allow sparse grass and shrubs in cracks below the highest exposed band, then thin rapidly.

## Vegetation art direction

The canopy must read first as connected masses, second as species variation, and only third as individual assets.

### Ecological zoning

**Shoreline palm belt**

- Concentrate coconut palms on the near shore and cove edges, set back from active swash.
- Use two crown/trunk silhouettes: low, heavier coconut forms and taller slender palms.
- Lean exposed palms seaward and downwind. Use a range of approximately 3–12° for most trunks, with a few hero silhouettes up to 18°.
- Keep wind direction consistent from frame-left toward frame-right.
- Avoid a continuous decorative row. Build loose groups separated by rock, beach access, and storm gaps.

**Mixed broadleaf canopy**

- Close the canopy across most lower and middle slopes.
- Cluster by species and moisture instead of mixing every asset uniformly.
- Use rounded crown masses at multiple heights; keep the silhouette irregular but not spiky.
- Preserve occasional dark gaps that reveal trunks and understorey near the beach.
- Maintain a clear reduction in height and density toward exposed ridges and the summit.

**Flowering accents**

- Red/orange-flowering trees are focal punctuation, not a biome colour.
- Aim for roughly four clearly visible flowering crowns in the hero frame, supported by additional partially hidden instances.
- Keep them away from the fort silhouette and avoid a regular left-to-right rhythm.

**Understorey and ground cover**

- Use ferns, anthurium, calathea, sorrel, meadow grass, tussocks, and Bermuda grass to close visible gaps beneath the first tree line.
- Concentrate broadleaf plants in sheltered, moister pockets.
- Use grasses on exposed slopes and in the transition toward the rocky crown.
- Do not spend dense geometry deep inside canopy regions that cannot be seen from reachable cameras.

### Existing density envelope

At full detail, treat the current capacities as the upper production envelope, not a requirement to display every instance simultaneously:

| Family | Current capacity |
| --- | ---: |
| Coconut palms | 54 |
| Tall palms | 34 |
| Main orchid trees | 52 |
| Mid-canopy trees | 44 |
| Poinciana/flame trees | 20 |
| Jacaranda | 14 |
| Pachira | 40 |
| Ferns | 110 |
| Sorrel shrubs | 130 |
| Anthurium | 70 |
| Calathea | 84 |
| Meadow grass | 380 |
| Tussocks | 200 |
| Bermuda grass | 620 |

The current low tier retains at least 25% of each kind and uses approximately 30% prop detail overall. Every tier must preserve the same large canopy silhouette and landmark clearings; reduce internal density before removing edge-defining specimens.

### Variation rules

- Randomize scale within botanically credible bands, generally ±15–25%, not ±50%.
- Rotate freely only where the asset is radially credible. Respect one-sided scans and visible ground plates.
- Align trees primarily to world up; align rocks partially to terrain normal.
- Prevent overlapping trunks, intersecting crowns with identical rotations, and repeated asset pairs.
- Remove or bury photogrammetry ground slabs before instancing.
- Use deterministic seeds. Adding a fern must not move the palms or landmarks.

## Fort

The fort is a small ruined coastal battery, not a castle.

### Placement

- Keep it on the left headland, approximately 34% of the island radius inland from the local waterline.
- Seat it on stable tableland around 35 m elevation; the footprint must not bridge a steep terrain break.
- Turn the seaward face toward the cove approach rather than directly radial from the island centre.
- Preserve sky or pale distant water behind enough of its silhouette to keep it legible.

### Form and condition

- Approximate footprint: 44 × 32 m.
- Use a round tower as the principal vertical element, broken curtain walls, one obvious breach, a partial landward return, and limited surviving walkway/stair elements.
- Keep the ruin low and heavy. No intact roof, flags, banners, glowing windows, or theatrical skull motifs.
- Sink the assembly approximately 0.8 m to eliminate terrain gaps.
- Add a single cannon within the breach only if it remains subordinate at hero distance.

### Materials

- Sun-bleached local stone with warmer dirt in joints.
- Dark moisture staining low on seaward faces.
- Sparse vegetation in cracks and protected corners.
- Avoid high-contrast edge wear that makes every block visible from 400 m.

## Cove, jetty, and beached boat

Treat these three elements as one composition with a clear hierarchy: beach first, jetty second, boat third.

### Jetty

- Begin approximately 5 m seaward of the locally queried shoreline and extend into the lagoon.
- Deck height: approximately 2.1 m above mean sea level.
- Keep the current starting scale of 1.5 unless screen-space review proves it too dominant.
- Align to actual water access, not to island centre.
- Use uneven timber tone, sun bleaching, salt staining, and darker wet piles.
- Keep pile spacing readable at hero distance. Avoid excessive ropes, lanterns, or clutter that turns it into a hero prop.

### Beached pinnace

- Place approximately 7 m landward of the shoreline and about 30 m alongshore from the jetty.
- Set the keel into sand, lifted only enough to prevent the hull from floating visually.
- Starting values: scale `0.55`, heel `0.17 rad`, bow-up trim `-0.05 rad` in the current coordinate convention.
- Orient mainly along the beach, with a slight angle toward the water.
- Keep the hull dry and sun-faded above, darker near the keel. Do not add intact sails or rigging that compete with the palms.

### Clear space

- Maintain a readable sand gap between jetty, boat, and first tree line.
- Use low vegetation and sparse small props in the cove; the player should understand how a person would move from boat to beach.
- Do not add a village, dock complex, or secondary boats.

## Ocean and water integration

The island art must be reviewed against the live ocean, never against a flat proxy plane.

- Use the existing 15 m/s directional spectrum and approximately 1.5 m visible swell character.
- Preserve scattered whitecaps; do not paint foam uniformly along every shore segment.
- Keep the shallow tint physically tied to real seafloor depth.
- Ensure rocks crossing the waterline receive wetness and correct reflection/refraction treatment.
- Check that low shelves disappear and reappear plausibly as waves pass.
- Maintain an anisotropic glitter track extending from the left-side sun toward the camera.
- Keep foreground ocean darker and more saturated than the lagoon so the depth transition reads instantly.

Near-shore breaking interaction may remain stylized within the current renderer, but the art must provide believable locations for it: shelves, shoals, and boulder lips rather than a featureless beach spline.

## Lighting, sky, and atmosphere

### Key light

- Midday sun, high and slightly behind the camera's left shoulder.
- Preserve enough side component to model the summit planes and tree crowns.
- Keep shadows short but readable; do not flatten the island with pure frontal illumination.
- Avoid blown beach and summit values. Filmic shoulder compression should retain surface detail.

### Sky

- Deep clean blue overhead.
- Small cumulus clouds at approximately 30–32% coverage.
- Keep most clouds small enough that the sky feels active without becoming overcast.
- Reserve clear blue around critical summit edges where possible.

### Atmosphere

- Use clean kilometre-scale aerial perspective: slight blue lift and contrast loss on the far side of the island.
- Do not add bloom haze, fog veils, vignette, chromatic aberration, or faux lens dirt.
- Cloud shadows should create slow broad value changes across the canopy without making the lighting read as late afternoon.

## Asset authoring and delivery

### Geometry

- Deliver glTF/GLB assets in metres, Y-up, with origins suitable for placement and burial.
- Use closed geometry for rocks intended to rotate freely.
- Identify facade/slab assets explicitly and provide their intended seaward axis.
- Separate modular fort pieces by stable node names; do not collapse the entire kit if runtime assembly is required.
- Keep pivots at the base contact point for vegetation and at meaningful assembly origins for structures.

### Materials and textures

- Prefer opaque materials. Use alpha masking for foliage where required; avoid alpha blending unless the visual need is demonstrated.
- Pack occlusion, roughness, and metalness consistently with the existing pipeline.
- Use normal maps appropriate to Three.js/glTF conventions.
- Author albedo without baked directional light, heavy ambient occlusion, or colour grading.
- Use shared texture sets across repeated asset families where practical.
- Validate mip behaviour at the 420 m LOD boundary; foliage alpha and rock normals must not shimmer.

### LODs

Provide or generate two reduced levels for expensive repeated assets:

- **LOD0:** within approximately 120 m; supports close fly-camera inspection.
- **LOD1:** approximately 120–420 m; preserves crown, trunk, and rock silhouette while removing interior detail.
- **LOD2:** beyond approximately 420 m; optimized for the hero approach and normal play-area view.

LOD2 is the most important island asset in the primary experience. Judge it at target screen size, not enlarged in a model viewer. Preserve silhouette, colour mass, and alpha coverage; remove topology that does not affect them.

Use `scripts/modelkit/inspect.mjs`, `shells.mjs`, and `plates.mjs` before approving source assets. Use `scripts/optimize-assets.mjs` for the shipping LOD/optimization path. Only CC0 and CC-BY assets are acceptable, and all CC-BY sources must be recorded in `ASSET_LICENSES.md`.

## Performance envelope

The complete scene—not only the island—currently measures at 1600 × 900, DPR 1:

| Configuration | Draw calls | Triangles | GPU p50 | Gate |
| --- | ---: | ---: | ---: | ---: |
| WebGPU High | 155 | 3,799,069 | 3.09 ms | less than 16.7 ms |
| WebGL2 Low | 65 | 1,807,467 | 2.06 ms | less than 33.3 ms |

These measurements were captured on an RTX 5090 and are not permission to spend the apparent headroom freely. The scene already carries expensive ocean, cloud, fog, reflection, and post-processing passes.

Art-side requirements:

- Keep repeated rocks and vegetation instanced by kind and material.
- Do not add unique materials for colour variation; use instance data or restrained shader variation.
- Preserve low-tier landmark silhouettes while thinning nonessential dressing.
- Avoid new transparency-heavy canopy materials that increase overdraw.
- Keep shadow casting selective. Hero palms, fort, jetty, and near-shore trees matter; deep canopy interiors do not all need individual shadow cost.
- Any material or asset-count increase must be checked with `npm run bench`, not inferred from editor frame rate.

## Team responsibilities

### Art direction

- Own hero-frame hierarchy, value grouping, colour relationships, and final visual acceptance.
- Approve the clay silhouette, shoreline rhythm, canopy massing, and final grade in that order.
- Prevent local detail from displacing the established composition.

### Environment and terrain art

- Build the terrain mass, coastline, beach, shelves, boulder clusters, terrain materials, and summit exposure.
- Maintain a watertight, collision-consistent surface and correct seafloor depth.
- Supply four-bearing clay reviews before dressing.

### Vegetation art

- Define species families, crown variation, LOD silhouettes, alpha coverage, and wind-ready pivots.
- Create ecological clusters and maintain the dark continuous canopy read.
- Keep flowering trees rare and compositionally placed.

### Prop art

- Assemble and weather the ruined fort.
- Prepare the jetty and pinnace with correct pivots, scale, contact, and material response.
- Keep prop storytelling restrained and readable from the water.

### Technical art/rendering

- Maintain instancing, deterministic scatter, terrain-derived placement, LOD switching, wetness, wind response, and backend compatibility.
- Validate source models for open shells, facade bias, ground plates, material modes, texture slots, and triangle cost.
- Protect ocean depth tint, reflection, shadow, and atmospheric integration.

### Level design

- Protect the hero camera corridor and cove approach.
- Verify navigable water depth, believable beach access, collision, and fly-camera sightlines.
- Define no-spawn/no-clutter zones around fort silhouette, jetty gap, boat outline, and summit edge.

## Production sequence and review gates

### Gate 1 — Composition blockout

Deliver:

- Clay terrain.
- Flat colour bands for deep water, lagoon, sand, vegetation, and summit rock.
- Primitive fort, jetty, and boat volumes.
- Hero capture plus four equal-distance bearings.

Pass when the island reads correctly without textures, vegetation assets, or post effects.

### Gate 2 — Shoreline and bathymetry

Deliver:

- Final coastline macro shape.
- Lagoon and shelf depths.
- Beach width variation.
- Major shelves, outcrops, and boulder clusters.
- Live-ocean capture at time 40 s.

Pass when the sand-white → turquoise → deep-blue gradient is continuous and the shore never reads as a smooth ring.

### Gate 3 — Canopy massing

Deliver:

- Vegetated ground material.
- Palm belt, broadleaf canopy clusters, summit thinning, and flowering accents using proxy or production assets.
- High and low quality captures.

Pass when green coverage and silhouette hold in LOD2 and low tier without visible repeated rows or bald terrain patches.

### Gate 4 — Landmark finish

Deliver:

- Fort assembly and weathering.
- Jetty and boat final placement.
- Contact, wetness, shadow, and collision review.

Pass when all landmarks are legible at hero distance, correctly grounded up close, and subordinate to the island.

### Gate 5 — Lighting, grade, and optimization

Deliver:

- Final `skyPro` capture at 1600 × 900, DPR 1.
- WebGPU High and WebGL2 Low captures.
- LOD transition video or stepped captures at 100 m, 140 m, 380 m, and 460 m.
- Benchmark and asset-inspection reports.

Pass when visual acceptance and performance gates both pass with no console errors.

## Final acceptance checklist

### Composition

- [ ] Island fills the intended middle band without clipping.
- [ ] Summit is offset, pale, and clearly modelled by light.
- [ ] Fort reads on the left headland.
- [ ] Jetty and beached boat are distinct but secondary.
- [ ] Foreground ocean remains compositionally important.

### Terrain and coast

- [ ] Coastline is asymmetric at terrain level, before props.
- [ ] Beach width changes with exposure and cove shelter.
- [ ] Rock shelves and boulders interrupt the sand naturally.
- [ ] No floating, buried beyond recognition, or repeated rock assets.
- [ ] Lagoon depth is navigable and produces the intended colour gradient.

### Vegetation

- [ ] Lower slopes read as continuous dark canopy from 400 m offshore.
- [ ] Palms cluster along shore and lean consistently with the wind.
- [ ] Flowering trees are sparse focal accents.
- [ ] Vegetation thins into exposed summit rock without a hard contour line.
- [ ] Low tier preserves canopy silhouette and landmark framing.

### Materials and lighting

- [ ] Beach and summit retain detail under midday exposure.
- [ ] Wet sand and waterline rocks respond correctly without a painted strip.
- [ ] Water colour follows real depth.
- [ ] Sun glitter stretches toward the camera.
- [ ] No bloom haze, vignette, stylized saturation, text, or UI appears in the hero capture.

### Technical

- [ ] Assets are metre-scaled, correctly oriented, and licensed.
- [ ] Repeated assets are instanced and use appropriate LODs.
- [ ] LOD changes do not pop noticeably at 120 m or 420 m.
- [ ] WebGPU High and WebGL2 Low boot without console errors.
- [ ] `npm run build`, visual tests, and `npm run bench` complete with accepted results.

## Common failure modes

Reject or revise the scene if any of the following appear:

- Circular island or identical silhouette from multiple bearings.
- Smooth, uninterrupted white beach ring.
- Turquoise water painted independently of depth.
- Vegetation scattered uniformly instead of forming canopy masses.
- Shore palms placed as a decorative row.
- Too many flowering trees, turning the island orange-red.
- Summit vegetation continuing at full density to the peak.
- Fort enlarged until it becomes the subject.
- Jetty or boat floating, intersecting, or sitting in implausible water depth.
- Repeated rock orientation, visible scan ground plates, or billboard-like coast assets viewed from behind.
- Overexposed sand, flat frontal lighting, excessive saturation, bloom, or atmospheric milkiness.
- Close-up detail that disappears in LOD2 while consuming the budget in LOD0.

The final scene is successful when the hero capture communicates the same place at a glance, and closer exploration reveals coherent terrain, ecology, access, and construction rather than camera-specific cheats.
