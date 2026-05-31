/**
 * Dead-zone follow camera invariants (T2).
 *
 * These pin the externally meaningful behaviors of {@link followCamera} — the
 * properties any consumer (renderer, player-follow loop) relies on — rather
 * than internal structure:
 *
 *  1. A target resting inside the dead-zone leaves the camera unchanged.
 *  2. A target past a dead-zone edge scrolls the camera by exactly the
 *     overshoot (target lands back on the edge), in all four directions.
 *  3. The viewport is clamped to stay within world bounds at every edge.
 *  4. A viewport larger than the world is stable (pins to the near edge).
 *
 * Pure deterministic math — no randomness, no wall-clock, no `any`.
 */

import { describe, it, expect } from "vitest";
import type { Vec2 } from "@agentroom/diorama-core";
import type { CameraState, CameraOptions } from "./types.js";
import { followCamera } from "./camera.js";

/**
 * A roomy world (1000x1000) with a 200x100 viewport and an 80x40 dead-zone.
 * The world comfortably exceeds the viewport so clamping never interferes with
 * the dead-zone assertions unless a test deliberately drives toward an edge.
 */
const baseOpts: CameraOptions = {
  viewport: { w: 200, h: 100 },
  deadZone: { w: 80, h: 40 },
  worldBounds: { x: 0, y: 0, w: 1000, h: 1000 },
};

function cam(x: number, y: number): CameraState {
  return { position: { x, y } };
}

function pt(x: number, y: number): Vec2 {
  return { x, y };
}

describe("followCamera dead-zone", () => {
  it("leaves the camera unchanged when the target rests inside the dead-zone", () => {
    // Camera at (300,300): viewport spans [300,500]x[300,400], dead-zone is
    // centered → x in [360,440], y in [330,370]. The viewport center is (400,350).
    const current = cam(300, 300);

    // Dead center.
    expect(followCamera(current, pt(400, 350), baseOpts)).toEqual(current);
    // Just inside each edge of the dead-zone band.
    expect(followCamera(current, pt(360, 350), baseOpts)).toEqual(current);
    expect(followCamera(current, pt(440, 350), baseOpts)).toEqual(current);
    expect(followCamera(current, pt(400, 330), baseOpts)).toEqual(current);
    expect(followCamera(current, pt(400, 370), baseOpts)).toEqual(current);
  });

  it("scrolls by exactly the overshoot past each dead-zone edge", () => {
    const current = cam(300, 300);

    // Past the left edge (deadMin.x = 360) by 25 → camera shifts left 25.
    expect(followCamera(current, pt(335, 350), baseOpts).position).toEqual({
      x: 275,
      y: 300,
    });
    // Past the right edge (deadMax.x = 440) by 30 → camera shifts right 30.
    expect(followCamera(current, pt(470, 350), baseOpts).position).toEqual({
      x: 330,
      y: 300,
    });
    // Past the top edge (deadMin.y = 330) by 10 → camera shifts up 10.
    expect(followCamera(current, pt(400, 320), baseOpts).position).toEqual({
      x: 300,
      y: 290,
    });
    // Past the bottom edge (deadMax.y = 370) by 15 → camera shifts down 15.
    expect(followCamera(current, pt(400, 385), baseOpts).position).toEqual({
      x: 300,
      y: 315,
    });
  });

  it("scrolls on both axes simultaneously by each axis's overshoot", () => {
    const current = cam(300, 300);
    // x past right edge by 60 (target 500 vs deadMax 440),
    // y past bottom edge by 50 (target 420 vs deadMax 370).
    expect(followCamera(current, pt(500, 420), baseOpts).position).toEqual({
      x: 360,
      y: 350,
    });
  });

  it("re-resting the target on the new dead-zone edge is a fixed point", () => {
    // After one scroll the target sits exactly on the edge; a second call with
    // the same target must not move the camera again.
    const once = followCamera(cam(300, 300), pt(470, 385), baseOpts);
    const twice = followCamera(once, pt(470, 385), baseOpts);
    expect(twice).toEqual(once);
  });

  it("clamps the viewport to the world's near (min) edges", () => {
    // Drive the target hard toward the world origin; the viewport cannot scroll
    // past worldBounds (x,y) = (0,0).
    const result = followCamera(cam(50, 50), pt(-500, -500), baseOpts);
    expect(result.position).toEqual({ x: 0, y: 0 });
  });

  it("clamps the viewport to the world's far (max) edges", () => {
    // Far edge = worldBounds + size - viewport = (1000-200, 1000-100) = (800,900).
    const result = followCamera(cam(700, 800), pt(5000, 5000), baseOpts);
    expect(result.position).toEqual({ x: 800, y: 900 });
  });

  it("respects a non-zero world origin when clamping", () => {
    const opts: CameraOptions = {
      viewport: { w: 200, h: 100 },
      deadZone: { w: 80, h: 40 },
      worldBounds: { x: 100, y: 200, w: 400, h: 300 },
    };
    // Near edge pins to (100,200).
    expect(
      followCamera(cam(150, 250), pt(-1000, -1000), opts).position,
    ).toEqual({ x: 100, y: 200 });
    // Far edge = (100+400-200, 200+300-100) = (300, 400).
    expect(
      followCamera(cam(250, 350), pt(9999, 9999), opts).position,
    ).toEqual({ x: 300, y: 400 });
  });

  it("stays stable when the viewport is larger than the world", () => {
    // Viewport 200x100 vs world 120x60: the viewport can't fit, so each axis
    // pins to the world's near edge regardless of where the target is.
    const opts: CameraOptions = {
      viewport: { w: 200, h: 100 },
      deadZone: { w: 80, h: 40 },
      worldBounds: { x: 0, y: 0, w: 120, h: 60 },
    };
    const farRight = followCamera(cam(40, 30), pt(5000, 5000), opts);
    const farLeft = followCamera(cam(40, 30), pt(-5000, -5000), opts);
    expect(farRight.position).toEqual({ x: 0, y: 0 });
    expect(farLeft.position).toEqual({ x: 0, y: 0 });
    // And it is a fixed point: re-applying does not drift.
    expect(followCamera(farRight, pt(60, 30), opts)).toEqual(farRight);
  });

  it("is a pure function — the same inputs always produce the same output", () => {
    const current = cam(300, 300);
    const target = pt(470, 385);
    const a = followCamera(current, target, baseOpts);
    const b = followCamera(current, target, baseOpts);
    expect(a).toEqual(b);
    // The input camera is never mutated.
    expect(current).toEqual({ position: { x: 300, y: 300 } });
  });
});
