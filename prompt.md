Rebuild the visible experience and functionality of https://www.threejswaterpro.com/ as a production-ready, AAA-quality web experience.

### Workflow

1. Inspect the reference across key viewpoints, presets, interactions, underwater states, and screen sizes. Create a concise feature matrix and visual-quality checklist.
2. Research official documentation and proven open-source implementations before selecting the architecture.
3. Produce a short design spec and implementation plan, then execute through subagent-driven development:

   * Use a fresh implementation agent for each scoped task.
   * Test and commit each task.
   * Run independent specification and code-quality reviews after every task.
   * Use Codex as an independent specialist for architecture, shader development, debugging, performance analysis, and final review.
   * Never allow agents to edit overlapping files concurrently.
4. Prefer modern Three.js with WebGPU/TSL and a graceful WebGL fallback. Recreate the reference’s visible capabilities, including realistic waves, physically based water lighting, reflections/refraction, foam, caustics, underwater transitions, atmosphere, buoyancy, wakes, presets, and polished controls.
5. Reuse libraries and repositories. Download redistributable, game-ready assets. Record every external asset, source, modification, and licence in `ASSET_LICENSES.md`.
6. Optimize using adaptive quality, LOD, instancing, compressed GLB assets, Meshopt/Draco, KTX2 textures, lazy loading, efficient shadows, and correct GPU-resource disposal.
7. Use Playwright and browser profiling as a continuous verification loop:

   * Capture deterministic reference and local screenshots at fixed cameras and states.
   * Compare, identify the largest visual gaps, fix them, and repeat.
   * Test interactions, responsiveness, loading, console errors, and fallback behaviour.

### Completion gates

Do not stop at a convincing first pass. Finish only when:

* Key scenes closely match the reference in composition, water, lighting, atmosphere, effects, UI polish, and motion.
* All interactions and automated tests pass with no console errors.
* Performance is stable at approximately 60 FPS on the target desktop and at least 30 FPS using fallback quality.
* There are no obvious loading hitches, memory leaks, or broken transitions.
* The production build, setup instructions, architecture, licences, and performance results are documented. Any remaining deviation from the reference is a deliberate, defended choice — not unfinished work filed as a limitation.

Resolve routine implementation decisions independently. Act autonomously throughout. For every ambiguity or implementation decision, research the available options, choose the strongest practical approach, document the rationale briefly, and proceed without requesting approval. Escalate only when progress is technically impossible due to missing access, credentials, or an external dependency.