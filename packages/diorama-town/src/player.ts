/**
 * `@agentroom/diorama-town` — player avatar simulation (T4).
 *
 * Pure, deterministic player movement. {@link inputFromKeys} folds a set of
 * pressed key names (WASD + arrow keys) into a normalized {@link InputState}
 * axis; {@link stepPlayer} integrates that axis through the collision grid via
 * {@link resolveMove} and derives facing / animation from the resulting motion.
 *
 * No randomness, no wall-clock reads — given the same state, input, dt and grid
 * the output is identical (`README` HARD RULES). No `any`, no fallback data.
 */

import type { Vec2 } from "@agentroom/diorama-core";
import { resolveMove } from "./collision.js";
import type { CollisionGrid, Facing, InputState, PlayerState } from "./types.js";

/**
 * Player movement speed in world (pixel) units per millisecond. Constant so
 * movement is fully deterministic from the integration step.
 */
export const PLAYER_SPEED_PX_PER_MS = 0.18;

/** Collision radius (world px) used when resolving the player against walls. */
export const PLAYER_RADIUS_PX = 8;

/** Keys that drive the player up (negative Y in screen/world space). */
const UP_KEYS: ReadonlySet<string> = new Set(["w", "W", "ArrowUp"]);
/** Keys that drive the player down (positive Y). */
const DOWN_KEYS: ReadonlySet<string> = new Set(["s", "S", "ArrowDown"]);
/** Keys that drive the player left (negative X). */
const LEFT_KEYS: ReadonlySet<string> = new Set(["a", "A", "ArrowLeft"]);
/** Keys that drive the player right (positive X). */
const RIGHT_KEYS: ReadonlySet<string> = new Set(["d", "D", "ArrowRight"]);

/** True when `pressed` contains any member of `keys`. */
function anyPressed(pressed: ReadonlySet<string>, keys: ReadonlySet<string>): boolean {
  for (const key of keys) {
    if (pressed.has(key)) {
      return true;
    }
  }
  return false;
}

/**
 * Fold a set of currently-pressed key names into a normalized movement axis.
 *
 * WASD and arrow keys map to the four cardinal directions; opposing keys
 * cancel. The raw axis is normalized to unit length when non-zero so a diagonal
 * is not faster than a straight line, while a single-axis press stays exactly
 * `±1`.
 */
export function inputFromKeys(pressed: ReadonlySet<string>): InputState {
  let x = 0;
  let y = 0;
  if (anyPressed(pressed, RIGHT_KEYS)) {
    x += 1;
  }
  if (anyPressed(pressed, LEFT_KEYS)) {
    x -= 1;
  }
  if (anyPressed(pressed, DOWN_KEYS)) {
    y += 1;
  }
  if (anyPressed(pressed, UP_KEYS)) {
    y -= 1;
  }

  const lengthSq = x * x + y * y;
  if (lengthSq > 1) {
    const length = Math.sqrt(lengthSq);
    x /= length;
    y /= length;
  }

  return { axis: { x, y } };
}

/** Derive the dominant-axis facing for a non-zero movement axis. */
function facingFromAxis(axis: Vec2, previous: Facing): Facing {
  if (axis.x === 0 && axis.y === 0) {
    return previous;
  }
  // Dominant axis: horizontal wins ties so left/right reads naturally on
  // perfect diagonals.
  if (Math.abs(axis.x) >= Math.abs(axis.y)) {
    return axis.x >= 0 ? "right" : "left";
  }
  return axis.y >= 0 ? "down" : "up";
}

/**
 * Advance the player one frame.
 *
 * The requested delta is `axis * speed * dtMs`, resolved against the collision
 * grid (axis-separated, sliding) by {@link resolveMove}. `moving` reflects the
 * input intent for this frame; `facing` tracks the dominant input axis and is
 * preserved when idle; `animation` is `walk` while moving else `idle`.
 */
export function stepPlayer(
  state: PlayerState,
  input: InputState,
  dtMs: number,
  grid: CollisionGrid,
): PlayerState {
  const { axis } = input;
  const moving = axis.x !== 0 || axis.y !== 0;
  const facing = facingFromAxis(axis, state.facing);

  const step = PLAYER_SPEED_PX_PER_MS * dtMs;
  const delta: Vec2 = { x: axis.x * step, y: axis.y * step };
  const position = resolveMove(grid, state.position, delta, PLAYER_RADIUS_PX);

  return {
    position,
    facing,
    moving,
    animation: moving ? "walk" : "idle",
  };
}
