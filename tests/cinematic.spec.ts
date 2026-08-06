import { test, expect } from '@playwright/test';
import * as THREE from 'three';
import { setState } from './helpers';
import { bootOcean } from './lib/capture';
import { CINEMATIC_LOOP_SECONDS, CinematicDirector, ISLAND_STAND_OFF } from '../src/cameras/Cinematic';
import { ISLAND } from '../src/scene/Seafloor';

/**
 * What the tour promises, asserted rather than trusted.
 *
 * The seam test in `ocean.spec.ts` already proves the *camera* is continuous at
 * the wrap. These cover the two things the re-authored flight added — a day that
 * genuinely reaches night, and weather that genuinely arrives — plus the one
 * property whose failure mode is completely silent: the hull sailing somewhere
 * boring during the beats that frame it.
 */

test.describe('the cinematic tour', () => {
  /**
   * The flight is smooth, and stands off the island.
   *
   * Run against `CinematicDirector` directly rather than through the browser.
   * The rig is a pure function of one clock with no GPU in it, so a full lap at
   * 60 Hz is 3600 CPU samples and costs milliseconds; the same walk through
   * `__ocean.step` would be 3600 rendered frames. The seam test in `ocean.spec`
   * covers the one thing this cannot — that the *live* rig, with its easing,
   * crosses the wrap without a jump.
   *
   * The bounds are set an order of magnitude above what the flight measures, so
   * this catches a knot edited into a lurch rather than policing the last few
   * per cent. What the flight it replaced measured, on the same walk: 300 m/s,
   * 422 m/s², 297 °/s, and a look point that closed to 9 m.
   */
  test('flies smoothly and keeps its distance from the island', () => {
    const director = new CinematicDirector();
    director.setEnabled(true);
    const pose = { position: new THREE.Vector3(), target: new THREE.Vector3() };

    const STEPS = 3600;
    const dt = CINEMATIC_LOOP_SECONDS / STEPS;
    const eye: THREE.Vector3[] = [];
    const dir: THREE.Vector3[] = [];
    for (let i = 0; i < STEPS; i++) {
      director.resetClock(i * dt);
      director.update(0, pose);
      eye.push(pose.position.clone());
      dir.push(pose.target.clone().sub(pose.position));
    }

    const at = <T>(a: T[], i: number): T => a[((i % STEPS) + STEPS) % STEPS];

    let peakSpeed = 0;
    let peakAccel = 0;
    let peakTurn = 0;
    let minReach = Infinity;
    let closestIsland = Infinity;
    for (let i = 0; i < STEPS; i++) {
      const a = at(eye, i - 1);
      const b = at(eye, i);
      const c = at(eye, i + 1);
      peakSpeed = Math.max(peakSpeed, c.distanceTo(a) / (2 * dt));
      // Second difference of a C¹ curve is bounded; a knot shows as a step in it
      // rather than as a spike, so this measures curvature and not the knots.
      peakAccel = Math.max(
        peakAccel,
        new THREE.Vector3().addVectors(a, c).addScaledVector(b, -2).length() / (dt * dt),
      );
      const u = at(dir, i - 1).clone().normalize();
      const w = at(dir, i + 1).clone().normalize();
      peakTurn = Math.max(peakTurn, (Math.acos(Math.min(1, Math.max(-1, u.dot(w)))) / (2 * dt)) * (180 / Math.PI));
      minReach = Math.min(minReach, at(dir, i).length());
      closestIsland = Math.min(closestIsland, Math.hypot(b.x - ISLAND.x, b.z - ISLAND.z));
    }

    console.log(
      `[cinematic] peak speed ${peakSpeed.toFixed(1)} m/s, accel ${peakAccel.toFixed(1)} m/s², ` +
        `view ${peakTurn.toFixed(1)} °/s, min look reach ${minReach.toFixed(0)} m, ` +
        `island ${closestIsland.toFixed(0)} m`,
    );

    expect(peakSpeed, 'a leg of the flight lurches').toBeLessThan(70);
    expect(peakAccel, 'the curve has a corner in it').toBeLessThan(80);
    // The single most useful bound here. Every whip the previous flight had came
    // from a look target drifting close to — or through — the camera, which makes
    // the view direction hypersensitive to it. Bounding the *reach* catches the
    // cause; bounding the turn rate alone only catches it after the fact.
    expect(minReach, 'a look target passes too close to the lens').toBeGreaterThan(40);
    expect(peakTurn, 'the camera whips rather than pans').toBeLessThan(60);
    expect(
      closestIsland,
      'the flight is meant to stand off the island, not fly over it',
    ).toBeGreaterThan(ISLAND_STAND_OFF);
  });

  test('reaches night, rains, and closes its environment on the loop', async ({ page }) => {
    await bootOcean(page);

    const samples = await page.evaluate((loop) => {
      const out: Array<{ t: number; hours: number; rain: number; kind: string; cloud: number }> = [];
      for (let t = 0; t < loop; t += 0.25) {
        const e = window.__ocean.cinematicEnvironment(t);
        out.push({ t, hours: e.hours, rain: e.rain, kind: e.weatherKind, cloud: e.cloudCoverage });
      }
      return out;
    }, CINEMATIC_LOOP_SECONDS);

    // Sun elevation, from the same diurnal arc `sunFromClock` uses. Asserting on
    // the elevation rather than on the hour is what makes this mean "it gets
    // dark" instead of "a number went outside a range".
    const elevation = (h: number) => Math.sin(((h - 6) / 24) * Math.PI * 2) * 1.32;

    // It actually reaches night — the previous flight's sun bottomed out at
    // 08:18 and never came close.
    expect(Math.min(...samples.map((s) => elevation(s.hours)))).toBeLessThan(-0.5);
    // And it actually reaches the middle of the day, which a widened sine about
    // noon could not have done at the same time.
    expect(Math.max(...samples.map((s) => elevation(s.hours)))).toBeGreaterThan(1.0);

    // It actually rains, and declares the kind that makes rain visible at all.
    // Without the kind, `Weather` draws nothing and main's `raining` scalar is
    // zero, so every downstream effect stays dry — which would look like a bug
    // in the curves rather than a missing field.
    expect(samples.some((s) => s.rain > 0.5 && s.kind === 'rain')).toBe(true);
    // And it is dry for most of the lap, or it is not a *change*.
    expect(samples.filter((s) => s.rain < 0.001).length / samples.length).toBeGreaterThan(0.6);
    // Cloud follows the rain up.
    const wettest = samples.reduce((a, b) => (b.rain > a.rain ? b : a));
    const driest = samples.find((s) => s.rain === 0)!;
    expect(wettest.cloud).toBeGreaterThan(driest.cloud + 0.3);

    // Continuous at the wrap, to the same standard the pose is held to. `hours`
    // is an angle — 24 and 0 are the same sun — so the comparison is on the
    // circle rather than on the number.
    const first = samples[0];
    const last = samples[samples.length - 1];
    // Signed difference on the 24-hour circle, folded into [-12, 12). The naive
    // `a - b` reports nearly a full day across the wrap, which is the whole
    // reason this is done on the circle: the tour advances by exactly one day
    // per lap, so hour 24 and hour 0 are the same sun and the same frame.
    const circular = (a: number, b: number) => (((a - b + 12) % 24) + 24) % 24 - 12;
    expect(Math.abs(circular(first.hours, last.hours))).toBeLessThan(0.6);
    expect(Math.abs(first.rain - last.rain)).toBeLessThan(0.05);
  });

  test('keeps the hull over the plateau whenever it frames it', async ({ page }) => {
    await bootOcean(page);

    // The beats whose keys look at 'ship'. A beat that frames the hull is making
    // a promise about where the hull is; the others are free to let it wander.
    const SHIP_BEATS = ['open-water', 'outbound', 'squall', 'reef-run'];

    const worst = await page.evaluate((names) => {
      let max = 0;
      for (const beat of window.__ocean.cinematicBeats()) {
        if (!names.includes(beat.name)) continue;
        for (let t = beat.start; t < beat.start + beat.duration; t += 0.25) {
          const { x, z } = window.__ocean.nominalShipAt(t);
          max = Math.max(max, Math.hypot(x, z));
        }
      }
      return max;
    }, SHIP_BEATS);

    // The shallow plateau runs to 320 m; past it the hull is over deep blue
    // water with no reef under it. This is asserted rather than left to the
    // radius constant because the failure is completely silent — the tour would
    // still loop perfectly and would simply have sailed somewhere with nothing
    // to look at. Note the hull's far point is *twice* the track radius: the
    // circuit passes through the origin rather than being centred on it.
    expect(worst).toBeLessThan(320);
  });

  test('the tour drives the sky, and hands it back on the way out', async ({ page }) => {
    await bootOcean(page);
    await setState(page, { preset: 'skyPro', cameraMode: 'cinematic' });

    // Park the flight in the middle of the squall — 00:56 on the tour's day —
    // and let it apply. A literal rather than a lookup, so it has to be revisited
    // when the flight is re-cut: this was 117, which was the night watch on the
    // 166-second lap and wraps to 57 s of a 60-second one, where the sun is up.
    // The test failed loudly, which is the behaviour wanted from a stale
    // constant.
    const night = await page.evaluate(async () => {
      await window.__ocean.resetDeterministic(0, 30);
      window.__ocean.director.resetCinematic(44);
      await window.__ocean.step(1 / 60, 4);
      return window.__ocean.atmosphere.sunDirection.y;
    });
    expect(night).toBeLessThan(0);

    // Leaving hands the sun back to the preset, which is daylight.
    await setState(page, { cameraMode: 'orbit' });
    const day = await page.evaluate(async () => {
      await window.__ocean.step(1 / 60, 4);
      return window.__ocean.atmosphere.sunDirection.y;
    });
    expect(day).toBeGreaterThan(0);
  });
});
