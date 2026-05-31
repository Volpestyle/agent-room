/**
 * `@agentroom/diorama-town` — tile-resolution collision.
 *
 * Builds a coarse blocked/clear map from a {@link TownPlan} and resolves player
 * movement against it. Movement is AXIS-SEPARATED (X resolved independently of
 * Y) so the player slides along walls instead of sticking on them, and a move
 * is only committed on an axis when the player's circular footprint stays
 * entirely inside the town and clear of every blocked tile.
 *
 * Pure, deterministic logic: no randomness, no wall-clock reads. Strict TS, no
 * `any`, no fallback data (`dev/CLAUDE.md`).
 */

import type { Vec2 } from "@agentroom/diorama-core";
import type { CollisionGrid, TownPlan } from "./types.js";

/**
 * Derive a tile-resolution collision grid from a laid-out town.
 *
 * A tile is blocked when it is covered by any {@link Building} footprint, or
 * when the plan already marks it as a `building` tile. Building rects are in
 * tile coordinates; cells outside the grid are ignored (out-of-bounds is
 * handled separately by {@link resolveMove}, which treats it as blocked).
 */
export function buildCollisionGrid(plan: TownPlan): CollisionGrid {
  const { cols, rows, tileSize } = plan;
  const cellCount = cols * rows;
  const blocked: boolean[] = new Array<boolean>(cellCount).fill(false);

  // Seed from the floor plan's own tile kinds so any structure tile is solid
  // even if it is not enumerated as a discrete building.
  for (let i = 0; i < cellCount && i < plan.tiles.length; i += 1) {
    if (plan.tiles[i] === "building") {
      blocked[i] = true;
    }
  }

  // Stamp every building footprint as blocked, clamped to the grid.
  for (const building of plan.buildings) {
    const { rect } = building;
    const startCol = Math.max(0, Math.floor(rect.x));
    const startRow = Math.max(0, Math.floor(rect.y));
    const endCol = Math.min(cols, Math.ceil(rect.x + rect.w));
    const endRow = Math.min(rows, Math.ceil(rect.y + rect.h));
    for (let row = startRow; row < endRow; row += 1) {
      for (let col = startCol; col < endCol; col += 1) {
        blocked[row * cols + col] = true;
      }
    }
  }

  return { cols, rows, tileSize, blocked };
}

/**
 * Resolve a single movement step against the collision grid.
 *
 * The player is treated as an axis-aligned footprint of half-extent `radius`
 * (world units) centered on its position. Movement is resolved one axis at a
 * time — X first, then Y — so that a diagonal push into a wall slides along the
 * unobstructed axis instead of stopping dead. Any candidate position whose
 * footprint overlaps a blocked tile or leaves the town is rejected on that
 * axis, so the returned position never enters a blocked tile.
 */
export function resolveMove(
  grid: CollisionGrid,
  from: Vec2,
  delta: Vec2,
  radius: number,
): Vec2 {
  let x = from.x;
  let y = from.y;

  // Resolve X, keeping the current Y so the test isolates the horizontal axis.
  const candidateX = x + delta.x;
  if (!footprintBlocked(grid, candidateX, y, radius)) {
    x = candidateX;
  }

  // Resolve Y against the (possibly) updated X so sliding composes correctly.
  const candidateY = y + delta.y;
  if (!footprintBlocked(grid, x, candidateY, radius)) {
    y = candidateY;
  }

  return { x, y };
}

/**
 * Whether a footprint of half-extent `radius` centered at (cx, cy) overlaps any
 * blocked tile or extends outside the town. Out-of-bounds counts as blocked.
 */
function footprintBlocked(
  grid: CollisionGrid,
  cx: number,
  cy: number,
  radius: number,
): boolean {
  const { cols, rows, tileSize } = grid;

  const minX = cx - radius;
  const maxX = cx + radius;
  const minY = cy - radius;
  const maxY = cy + radius;

  // Any part of the footprint leaving the world is treated as a wall.
  if (minX < 0 || minY < 0 || maxX > cols * tileSize || maxY > rows * tileSize) {
    return true;
  }

  const startCol = Math.floor(minX / tileSize);
  const startRow = Math.floor(minY / tileSize);
  // `maxX`/`maxY` sitting exactly on a tile boundary should not pull in the
  // next tile, so step back one epsilon-tile via the inclusive ceil.
  const endCol = Math.ceil(maxX / tileSize) - 1;
  const endRow = Math.ceil(maxY / tileSize) - 1;

  for (let row = startRow; row <= endRow; row += 1) {
    for (let col = startCol; col <= endCol; col += 1) {
      if (col < 0 || row < 0 || col >= cols || row >= rows) {
        return true;
      }
      if (grid.blocked[row * cols + col]) {
        return true;
      }
    }
  }

  return false;
}
