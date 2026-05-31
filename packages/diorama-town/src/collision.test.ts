/**
 * Collision tests — tile-resolution blocked map + axis-separated slide.
 *
 * These protect the core movement invariants of the inhabitable spike: a
 * resolved position must never enter a blocked tile, and a diagonal push into a
 * wall must slide along the open axis rather than stick. They verify externally
 * meaningful behavior (player can't walk through buildings; movement feels like
 * sliding), not internal structure.
 */

import { describe, expect, it } from "vitest";

import type { TownPlan, TileKind } from "./types.js";
import { buildCollisionGrid, resolveMove } from "./collision.js";

const TILE = 16;

/**
 * Build a town plan from a tile-art map. Each string row is one grid row;
 * `#` marks a building tile (blocked), any other char marks ground (clear).
 * Buildings are emitted as 1x1 footprints so both the tile seeding and the
 * building stamping paths are exercised.
 */
function planFromArt(art: readonly string[]): TownPlan {
  const rows = art.length;
  const cols = art[0]?.length ?? 0;
  const tiles: TileKind[] = [];
  const buildings: TownPlan["buildings"] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const isBuilding = art[row][col] === "#";
      tiles.push(isBuilding ? "building" : "ground");
      if (isBuilding) {
        buildings.push({
          id: `b-${col}-${row}`,
          rect: { x: col, y: row, w: 1, h: 1 },
        });
      }
    }
  }
  return {
    tileSize: TILE,
    cols,
    rows,
    bounds: { x: 0, y: 0, w: cols * TILE, h: rows * TILE },
    tiles,
    buildings,
    spawn: { x: TILE, y: TILE },
  };
}

describe("buildCollisionGrid", () => {
  it("marks building tiles and footprints as blocked, ground as clear", () => {
    const grid = buildCollisionGrid(
      planFromArt([
        "...",
        ".#.",
        "...",
      ]),
    );
    expect(grid.cols).toBe(3);
    expect(grid.rows).toBe(3);
    expect(grid.tileSize).toBe(TILE);
    // Center tile (1,1) is the building.
    expect(grid.blocked[1 * 3 + 1]).toBe(true);
    // Corners are clear.
    expect(grid.blocked[0]).toBe(false);
    expect(grid.blocked[3 * 3 - 1]).toBe(false);
  });
});

describe("resolveMove", () => {
  // A 5x5 open field surrounded by nothing; center column row 2 is a wall.
  //   col: 0 1 2 3 4
  // row 0: . . . . .
  // row 1: . . . . .
  // row 2: . . # . .
  // row 3: . . . . .
  // row 4: . . . . .
  const grid = buildCollisionGrid(
    planFromArt([
      ".....",
      ".....",
      "..#..",
      ".....",
      ".....",
    ]),
  );
  const radius = 4;

  it("moves freely through open ground", () => {
    // Start centered in tile (1,1) = world (24,24); move right within open row.
    const from = { x: 24, y: 24 };
    const out = resolveMove(grid, from, { x: 8, y: 0 }, radius);
    expect(out.x).toBe(32);
    expect(out.y).toBe(24);
  });

  it("blocks movement into a wall on the moving axis", () => {
    // Sit just left of the wall tile (2,2) which spans world x[32,48), y[32,48).
    // Footprint right edge at x+radius; pushing right into the wall is rejected.
    const from = { x: 24, y: 40 };
    const out = resolveMove(grid, from, { x: 8, y: 0 }, radius);
    // X is blocked (would overlap the wall), Y unchanged.
    expect(out.x).toBe(24);
    expect(out.y).toBe(40);
  });

  it("slides along a wall: the perpendicular axis still moves", () => {
    // Same approach as above but pushing diagonally up-right into the wall.
    // X is blocked by the wall, but Y (upward) is open, so the player slides up.
    const from = { x: 24, y: 40 };
    const out = resolveMove(grid, from, { x: 8, y: -8 }, radius);
    expect(out.x).toBe(24); // blocked horizontally
    expect(out.y).toBe(32); // slid vertically along the wall face
  });

  it("stops in a corner when both axes are blocked", () => {
    // A concave pocket: a wall to the right (col 2) and a wall below (row 2)
    // meet at the player's tile, wedging it so neither axis can advance.
    //   row 1:  . . # . .
    //   row 2:  # # # . .
    //   row 3:  . . # . .
    const cornerGrid = buildCollisionGrid(
      planFromArt([
        ".....",
        "..#..",
        "###..",
        "..#..",
        ".....",
      ]),
    );
    // Sit centered in tile (1,1) = world (24,24). Pushing +x meets the col-2
    // wall and pushing +y meets the row-2 wall, so the player stays put.
    const from = { x: 24, y: 24 };
    const out = resolveMove(cornerGrid, from, { x: 8, y: 8 }, radius);
    expect(out.x).toBe(24);
    expect(out.y).toBe(24);
  });

  it("treats out-of-bounds as blocked", () => {
    // Player hugging the left/top edge cannot move further out of the world.
    const from = { x: radius, y: radius };
    const out = resolveMove(grid, from, { x: -8, y: -8 }, radius);
    expect(out.x).toBe(radius);
    expect(out.y).toBe(radius);
  });
});
