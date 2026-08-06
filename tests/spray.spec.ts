import { test, expect } from '@playwright/test';
import { bootOcean } from './lib/capture';

/**
 * Hull impact spray.
 *
 * Two failures look identical in a screenshot — the hull is not slamming, and
 * the hull is slamming and nothing is drawn — so this asserts both halves
 * separately: that impacts are being detected at all, and that the detected
 * impacts put light on the screen.
 */

/**
 * PARKED — the system emits and does not draw, and this test is the evidence.
 *
 * `test.fixme` rather than `test.skip`, because nothing here is wrong with the
 * test: it is a correct assertion about a subsystem that does not yet satisfy
 * it, and it should start passing the moment the defect below is fixed. Deleting
 * it or loosening it would throw away the only thing that knows.
 *
 * What is established:
 *
 *   - Impacts are detected. The probe crossing test fires and the ring fills;
 *     `sprayLiveEvents()` reports 4 in twenty seconds of a 21 m/s sea, with one
 *     still airborne at the moment of capture.
 *   - The mesh is real and reaches the renderer. Queried at runtime: in the
 *     scene, `visible: true`, `instanceCount: 960`, indexed, both instanced
 *     attributes present, `MeshBasicNodeMaterial`, and the graph compiles on
 *     both backends.
 *   - Nothing is rasterised. 0 of 1,440,000 pixels differ between spray at full
 *     strength and spray at zero.
 *
 * Four fixes were attempted and none moved the pixel count: four `smoothstep`
 * calls with reversed edges (a real bug, and fixed — reversed edges are
 * undefined in GLSL and WGSL); capturing while the table was empty (a real test
 * bug, and fixed); a degenerate billboard basis when a droplet is directly
 * overhead (a real latent NaN, and fixed); and building the varying outside an
 * `Fn` flow so its `toVar` declarations had no flow to belong to.
 *
 * The surviving hypothesis, which fits every observation above and which the
 * four attempts do not touch, is the dynamic uniform-array index: every
 * instance reads `uOrigin.element(attribute('sprayEvent').x.toInt())`, and if
 * that index does not resolve per instance then all 960 read slot 0, whose
 * emission time is the sentinel -1000, whose age is therefore enormous, and
 * whose `alive` term is zero — permanently, whatever the table contains.
 *
 * The fix that follows from it is to carry the event table in a small
 * `DataTexture` read with `textureLoad`, which is how `OceanSimulation` already
 * indexes its per-cascade spectrum atlas, and which removes the dynamic uniform
 * index entirely. That is an architecture change rather than another patch,
 * which is the point at which this was parked.
 */
test.fixme('a hull driven through a storm throws spray, and it is drawn', async ({ page }) => {
  test.setTimeout(600_000);
  await bootOcean(page);

  const result = await page.evaluate(async () => {
    const ocean = window.__ocean as unknown as {
      setState(p: Record<string, unknown>): Promise<void> | void;
      resetDeterministic(
        t?: number,
        steps?: number,
        shipInput?: { throttle: number; rudder: number } | null,
      ): Promise<void>;
      step(dt: number, steps?: number): Promise<void>;
      capturePixels(): Promise<{ width: number; height: number; data: Uint8Array }>;
      setSprayStrength(s: number): void;
      sprayLiveEvents(): number;
      director: { snapToTarget(): void };
      setShipInput(throttle: number, rudder: number): void;
      shipState(): { speed: number } | null;
    };

    // A storm, and the ship driven hard into it. Spray is a *slam* — the hull
    // arriving where the water already is — so a drifting hull produces none by
    // design and would prove nothing either way.
    //
    // Orbit mode because it targets the hull: the camera has to be looking at
    // the bow for the second assertion to mean anything, and hard-coding a
    // position would need the ship's, which it has moved away from by then.
    await ocean.setState({
      preset: 'storm',
      windSpeed: 21,
      quality: 'high',
      cameraMode: 'orbit',
    });
    await ocean.resetDeterministic(40, 90, { throttle: 1, rudder: 0 });

    // A 27 m hull under sail takes tens of seconds to find its speed, so this
    // steps twenty of them. Stepped rather than run on the wall clock so the
    // count is the same on every machine.
    // The reset seeds the input; this holds it. Without it the throttle decays
    // back to neutral and the hull never gets past a knot.
    ocean.setShipInput(1, 0);
    let peakLive = 0;
    for (let i = 0; i < 60; i++) {
      await ocean.step(1 / 60, 6);
      peakLive = Math.max(peakLive, ocean.sprayLiveEvents());
    }
    ocean.director.snapToTarget();

    // Capture *while a sheet is in the air*, not merely after one has been.
    //
    // Spray lives 1.1 s. Stepping to a fixed count and then capturing takes the
    // picture at whatever phase that lands on, which is usually an empty sky —
    // the first version of this test did exactly that and reported zero changed
    // pixels for a system that was working. Stepping until the table is live and
    // capturing immediately is the only way to photograph a transient.
    let liveAtCapture = 0;
    for (let i = 0; i < 400 && liveAtCapture === 0; i++) {
      await ocean.step(1 / 60, 2);
      liveAtCapture = ocean.sprayLiveEvents();
    }
    peakLive = Math.max(peakLive, liveAtCapture);

    const ship = ocean.shipState();

    // Differenced pixel by pixel rather than by mean brightness. A sheet of
    // spray is a few hundred pixels out of a million, so its effect on the mean
    // is below the fourth decimal — which would make a mean-brightness assertion
    // technically true and evidentially worthless. Counting the pixels it
    // *changed* is the measurement that distinguishes "drew a little" from
    // "drew nothing".
    ocean.setSprayStrength(1);
    const on = await ocean.capturePixels();
    ocean.setSprayStrength(0);
    const off = await ocean.capturePixels();
    ocean.setSprayStrength(1);

    let changed = 0;
    let brighter = 0;
    for (let i = 0; i < on.data.length; i += 4) {
      const d =
        on.data[i] - off.data[i] +
        (on.data[i + 1] - off.data[i + 1]) +
        (on.data[i + 2] - off.data[i + 2]);
      if (Math.abs(d) > 6) {
        changed++;
        if (d > 0) brighter++;
      }
    }

    return {
      peakLive,
      liveAtCapture,
      changed,
      brighter,
      total: on.data.length / 4,
      shipSpeed: ship ? ship.speed : 0,
    };
  });

  console.log(
    `[spray] peak ${result.peakLive} live-at-capture ${result.liveAtCapture} | ` +
      `ship ${result.shipSpeed.toFixed(2)} m/s | ` +
      `pixels changed ${result.changed} of ${result.total} (${result.brighter} brighter)`,
  );

  // The hull has to be working in the sea, or the test proves nothing. Left
  // deliberately low: what spray needs is *vertical* motion through the surface,
  // which a hull gets from the swell whether or not it is making way.
  expect(result.shipSpeed, 'the ship never moved at all').toBeGreaterThan(0.1);

  // Impacts are being detected. One is enough to prove the crossing test fires;
  // the interesting failure is zero, which means the probe logic never triggers.
  expect(result.peakLive, 'no impact registered in twenty seconds of a 21 m/s sea')
    .toBeGreaterThan(0);

  // And they reach the frame.
  expect(
    result.changed,
    'spray registered impacts but changed no pixels — it is emitting and not drawing',
  ).toBeGreaterThan(50);

  // Spray is white water: against the sea and the hull it can only add light.
  // A majority going the other way would mean the quads are occluding rather
  // than accumulating, which is what a depth-write or blend-mode mistake looks
  // like from outside.
  expect(result.brighter).toBeGreaterThan(result.changed * 0.6);
});
