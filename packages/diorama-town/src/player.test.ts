/**
 * Player simulation tests (Diorama town, T4).
 *
 * These pin externally meaningful, long-term player behavior (`dev/AGENTS.md`
 * testing philosophy): the key→axis mapping that drives all input, the
 * idle/moving/facing/animation derivation the renderer reads, and the hard
 * collision invariant that the player never walks into a blocked tile. None of
 * these assert implementation internals — only the public contract.
 */

import { describe, it, expect } from "vitest";
import { inputFromKeys, stepPlayer, PLAYER_RADIUS_PX } from "./player.js";
import type { CollisionGrid } from "./collision.js";
import type { PlayerState } from "./types.js";

/** An entirely-clear collision grid; no movement is ever blocked. */
function clearGrid(
  cols: number,
  rows: number,
  tileSize: number,
): CollisionGrid {
  return {
    cols,
    rows,
    tileSize,
    blocked: new Array<boolean>(cols * rows).fill(false),
  };
}

/** A fresh idle player at the origin facing down. */
function idleAtOrigin(): PlayerState {
  return {
    position: { x: 0, y: 0 },
    facing: "down",
    moving: false,
    animation: "idle",
  };
}

describe("inputFromKeys", () => {
  it("maps WASD to the correct axis", () => {
    expect(inputFromKeys(new Set(["d"])).axis).toEqual({ x: 1, y: 0 });
    expect(inputFromKeys(new Set(["a"])).axis).toEqual({ x: -1, y: 0 });
    expect(inputFromKeys(new Set(["s"])).axis).toEqual({ x: 0, y: 1 });
    expect(inputFromKeys(new Set(["w"])).axis).toEqual({ x: 0, y: -1 });
  });

  it("maps arrow keys to the same axis as WASD", () => {
    expect(inputFromKeys(new Set(["ArrowRight"])).axis).toEqual({ x: 1, y: 0 });
    expect(inputFromKeys(new Set(["ArrowLeft"])).axis).toEqual({ x: -1, y: 0 });
    expect(inputFromKeys(new Set(["ArrowDown"])).axis).toEqual({ x: 0, y: 1 });
    expect(inputFromKeys(new Set(["ArrowUp"])).axis).toEqual({ x: 0, y: -1 });
  });

  it("normalizes diagonals to unit length so they are not faster", () => {
    const { axis } = inputFromKeys(new Set(["w", "d"]));
    const length = Math.sqrt(axis.x * axis.x + axis.y * axis.y);
    expect(length).toBeCloseTo(1, 12);
    expect(axis.x).toBeGreaterThan(0);
    expect(axis.y).toBeLessThan(0);
  });

  it("cancels opposing keys to a zero axis", () => {
    expect(inputFromKeys(new Set(["a", "d"])).axis).toEqual({ x: 0, y: 0 });
    expect(inputFromKeys(new Set(["w", "s"])).axis).toEqual({ x: 0, y: 0 });
  });

  it("with no keys yields a zero axis", () => {
    expect(inputFromKeys(new Set<string>()).axis).toEqual({ x: 0, y: 0 });
  });
});

describe("stepPlayer", () => {
  const grid = clearGrid(8, 8, 32);

  it("with no input is idle with a zero axis and does not move", () => {
    const state: PlayerState = {
      position: { x: 64, y: 64 },
      facing: "left",
      moving: true,
      animation: "walk",
    };
    const next = stepPlayer(state, inputFromKeys(new Set<string>()), 16, grid);
    expect(next.moving).toBe(false);
    expect(next.animation).toBe("idle");
    expect(next.position).toEqual({ x: 64, y: 64 });
  });

  it("preserves prior facing when idle", () => {
    const state: PlayerState = { ...idleAtOrigin(), facing: "right" };
    const next = stepPlayer(state, inputFromKeys(new Set<string>()), 16, grid);
    expect(next.facing).toBe("right");
  });

  it("faces the dominant axis", () => {
    const start: PlayerState = {
      ...idleAtOrigin(),
      position: { x: 64, y: 64 },
    };
    expect(
      stepPlayer(start, inputFromKeys(new Set(["d"])), 16, grid).facing,
    ).toBe("right");
    expect(
      stepPlayer(start, inputFromKeys(new Set(["a"])), 16, grid).facing,
    ).toBe("left");
    expect(
      stepPlayer(start, inputFromKeys(new Set(["s"])), 16, grid).facing,
    ).toBe("down");
    expect(
      stepPlayer(start, inputFromKeys(new Set(["w"])), 16, grid).facing,
    ).toBe("up");
  });

  it("sets animation to walk while moving", () => {
    const start: PlayerState = {
      ...idleAtOrigin(),
      position: { x: 64, y: 64 },
    };
    const next = stepPlayer(start, inputFromKeys(new Set(["d"])), 16, grid);
    expect(next.moving).toBe(true);
    expect(next.animation).toBe("walk");
    expect(next.position.x).toBeGreaterThan(64);
  });

  it("keeps the player out of a blocked tile (movement blocked by a wall)", () => {
    // 2x1 grid, tileSize 32. Column 1 is a wall; column 0 is clear.
    const walled: CollisionGrid = {
      cols: 2,
      rows: 1,
      tileSize: 32,
      blocked: [false, true],
    };
    // Start inside the clear column, near the wall boundary, moving right hard.
    const start: PlayerState = {
      ...idleAtOrigin(),
      position: { x: 20, y: 16 },
    };
    const next = stepPlayer(start, inputFromKeys(new Set(["d"])), 1000, walled);
    // Invariant: the player's collision circle never enters the blocked tile,
    // whose left edge sits at world x = 32.
    expect(next.position.x + PLAYER_RADIUS_PX).toBeLessThanOrEqual(32);
    // And it certainly did not teleport past the wall.
    expect(next.position.x).toBeLessThan(32);
  });
});
