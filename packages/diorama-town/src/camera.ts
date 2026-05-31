/**
 * `@agentroom/diorama-town` — dead-zone follow camera (T2).
 *
 * A classic platformer-style follow camera: the viewport stays put while the
 * target moves freely inside a centered "dead-zone" box, and only scrolls once
 * the target pushes past a dead-zone edge — and then by exactly the overshoot,
 * so the target is nudged back to rest on that edge rather than re-centered.
 * The resulting viewport is clamped to stay within {@link CameraOptions.worldBounds}.
 *
 * Pure math, fully deterministic: same inputs always produce the same camera.
 * No randomness, no wall-clock reads, no `any`, no fallback data
 * (`dev/CLAUDE.md`).
 */

import type { Vec2 } from "@agentroom/diorama-core";
import type { CameraState, CameraOptions } from "./types.js";

/**
 * Clamp `value` into `[min, max]`. If the range is inverted (`max < min`,
 * which happens when the viewport is larger than the world on this axis), the
 * lower bound `min` wins — the viewport pins to the world's near edge and stays
 * there, which keeps the camera stable for over-large viewports.
 */
function clampRange(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/**
 * Compute the scrolled position of a single axis given a dead-zone band.
 *
 * `pos` is the viewport's near-edge coordinate, `extent` the viewport size on
 * this axis, `dead` the dead-zone size on this axis, and `target` the target's
 * world coordinate on this axis. The dead-zone is centered in the viewport; the
 * camera only moves when the target crosses a band edge, and then by exactly
 * the overshoot so the target lands back on that edge.
 */
function followAxis(
  pos: number,
  extent: number,
  dead: number,
  target: number,
): number {
  // Clamp the dead-zone to the viewport so a malformed (over-large) dead-zone
  // degrades to "center on target" rather than producing a negative margin.
  const band = Math.min(dead, extent);
  const margin = (extent - band) / 2;
  const deadMin = pos + margin;
  const deadMax = pos + margin + band;

  if (target < deadMin) {
    // Target pushed past the near edge — scroll by the (negative) overshoot.
    return pos + (target - deadMin);
  }
  if (target > deadMax) {
    // Target pushed past the far edge — scroll by the (positive) overshoot.
    return pos + (target - deadMax);
  }
  // Target rests inside the dead-zone — this axis does not move.
  return pos;
}

/**
 * Advance a dead-zone follow camera one step toward `targetWorldPos`.
 *
 * The viewport only scrolls once the target leaves the centered dead-zone box,
 * and then by exactly the overshoot. The result is clamped so the viewport
 * `[position, position + viewport]` stays inside `opts.worldBounds`; when the
 * viewport is larger than the world on an axis, that axis pins to the world's
 * near edge.
 */
export function followCamera(
  current: CameraState,
  targetWorldPos: Vec2,
  opts: CameraOptions,
): CameraState {
  const { viewport, deadZone, worldBounds } = opts;

  const followedX = followAxis(
    current.position.x,
    viewport.w,
    deadZone.w,
    targetWorldPos.x,
  );
  const followedY = followAxis(
    current.position.y,
    viewport.h,
    deadZone.h,
    targetWorldPos.y,
  );

  const clampedX = clampRange(
    followedX,
    worldBounds.x,
    worldBounds.x + worldBounds.w - viewport.w,
  );
  const clampedY = clampRange(
    followedY,
    worldBounds.y,
    worldBounds.y + worldBounds.h - viewport.h,
  );

  return { position: { x: clampedX, y: clampedY } };
}
