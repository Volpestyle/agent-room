/**
 * Tests for the deterministic town layout (T3).
 *
 * These guard the externally meaningful invariants of `buildTownPlan`: building
 * count tracks agent count, agents group by room, the plan is fully deterministic
 * and stable under growth (existing buildings never move), and the spawn always
 * lands on a walkable tile. They deliberately do not pin exact coordinates — those
 * are implementation detail — only the contract guarantees.
 */

import { describe, expect, it } from "vitest";
import type {
  WorldEntity,
  WorldRoom,
  WorldSnapshot,
} from "@agentroom/diorama-core";
import { createEmptyWorldSnapshot } from "@agentroom/diorama-core";
import { buildTownPlan } from "./townLayout.js";
import type { Building, TileKind, TownPlan } from "./types.js";

const TILE_SIZE = 32;

function agent(id: string): WorldEntity {
  return {
    id,
    kind: "agent",
    role: "implementer",
    domainState: "idle",
    presentation: { animation: "idle", position: { x: 0, y: 0 } },
  };
}

function room(id: string, label: string): WorldRoom {
  return {
    id,
    kind: "workspace",
    label,
    presentation: { bounds: { x: 0, y: 0, w: 0, h: 0 } },
  };
}

function worldWith(
  agents: WorldEntity[],
  rooms: WorldRoom[] = [],
): WorldSnapshot {
  const snapshot = createEmptyWorldSnapshot();
  for (const a of agents) snapshot.entities[a.id] = a;
  for (const r of rooms) snapshot.rooms[r.id] = r;
  return snapshot;
}

/** Look up a tile by tile coordinates. */
function tileAt(plan: TownPlan, tileX: number, tileY: number): TileKind {
  const tile = plan.tiles[tileY * plan.cols + tileX];
  if (tile === undefined) {
    throw new Error(`tile out of range (${tileX}, ${tileY})`);
  }
  return tile;
}

/** Convert a world (pixel) coordinate to its tile index. */
function worldToTile(coord: number, tileSize: number): number {
  return Math.floor(coord / tileSize);
}

function buildingById(plan: TownPlan, id: string): Building {
  const found = plan.buildings.find((b) => b.id === id);
  if (found === undefined) throw new Error(`no building ${id}`);
  return found;
}

describe("buildTownPlan", () => {
  it("creates exactly one building per agent entity", () => {
    const world = worldWith([agent("a"), agent("b"), agent("c")]);
    const plan = buildTownPlan(world, { tileSize: TILE_SIZE });
    expect(plan.buildings).toHaveLength(3);
    const entityIds = plan.buildings.map((b) => b.entityId).sort();
    expect(entityIds).toEqual(["a", "b", "c"]);
  });

  it("places no buildings for an empty world but still yields a town", () => {
    const plan = buildTownPlan(createEmptyWorldSnapshot(), {
      tileSize: TILE_SIZE,
    });
    expect(plan.buildings).toHaveLength(0);
    expect(plan.cols).toBeGreaterThan(0);
    expect(plan.rows).toBeGreaterThan(0);
    expect(plan.tiles).toHaveLength(plan.cols * plan.rows);
  });

  it("tiles array length always equals cols * rows", () => {
    const world = worldWith(
      Array.from({ length: 11 }, (_, i) => agent(`agent-${i}`)),
      [room("ws-1", "One"), room("ws-2", "Two")],
    );
    const plan = buildTownPlan(world, { tileSize: TILE_SIZE });
    expect(plan.tiles).toHaveLength(plan.cols * plan.rows);
  });

  it("groups agents into districts by room (workspace)", () => {
    const rooms = [room("ws-alpha", "Alpha"), room("ws-beta", "Beta")];
    const agents = Array.from({ length: 12 }, (_, i) => agent(`agent-${i}`));
    const world = worldWith(agents, rooms);
    const plan = buildTownPlan(world, { tileSize: TILE_SIZE });

    // Every building is tagged with one of the known rooms, and we bucket by it.
    const roomIds = new Set(["ws-alpha", "ws-beta"]);
    const byRoom = new Map<string, Building[]>();
    for (const b of plan.buildings) {
      const key = b.roomId;
      expect(key).toBeDefined();
      if (key === undefined) continue;
      expect(roomIds.has(key)).toBe(true);
      const list = byRoom.get(key) ?? [];
      list.push(b);
      byRoom.set(key, list);
    }
    // Both rooms received at least one agent (12 agents over 2 rooms by hash).
    expect(byRoom.size).toBe(2);

    // District bands do not vertically interleave: the max y of one room's
    // buildings is separated from the min y of the other.
    const bands = [...byRoom.values()].map((bs) => ({
      minY: Math.min(...bs.map((b) => b.rect.y)),
      maxY: Math.max(...bs.map((b) => b.rect.y + b.rect.h)),
    }));
    bands.sort((p, q) => p.minY - q.minY);
    const [first, second] = bands;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first !== undefined && second !== undefined) {
      expect(first.maxY).toBeLessThanOrEqual(second.minY);
    }
  });

  it("falls back to a single commons district when there are no rooms", () => {
    const world = worldWith([agent("a"), agent("b")]);
    const plan = buildTownPlan(world, { tileSize: TILE_SIZE });
    for (const b of plan.buildings) {
      expect(b.roomId).toBeUndefined();
    }
    expect(plan.buildings).toHaveLength(2);
  });

  it("is deterministic — two calls produce deep-equal plans", () => {
    const rooms = [room("ws-1", "One"), room("ws-2", "Two")];
    const agents = Array.from({ length: 9 }, (_, i) => agent(`a-${i}`));
    const world = worldWith(agents, rooms);
    const a = buildTownPlan(world, { tileSize: TILE_SIZE });
    const b = buildTownPlan(world, { tileSize: TILE_SIZE });
    expect(a).toEqual(b);
  });

  it("is order-independent — entity/room insertion order does not matter", () => {
    const rooms = [room("ws-1", "One"), room("ws-2", "Two")];
    const ids = ["a-0", "a-1", "a-2", "a-3", "a-4"];
    const forward = worldWith(ids.map(agent), rooms);
    const reversed = worldWith(
      [...ids].reverse().map(agent),
      [...rooms].reverse(),
    );
    expect(buildTownPlan(forward, { tileSize: TILE_SIZE })).toEqual(
      buildTownPlan(reversed, { tileSize: TILE_SIZE }),
    );
  });

  it("is stable — adding an agent leaves every existing building rect unchanged", () => {
    const rooms = [room("ws-1", "One"), room("ws-2", "Two")];
    const existing = Array.from({ length: 7 }, (_, i) => agent(`a-${i}`));
    const before = buildTownPlan(worldWith(existing, rooms), {
      tileSize: TILE_SIZE,
    });

    const grown = [...existing, agent("newcomer")];
    const after = buildTownPlan(worldWith(grown, rooms), {
      tileSize: TILE_SIZE,
    });

    // The newcomer added exactly one building.
    expect(after.buildings).toHaveLength(before.buildings.length + 1);

    // Every previously-placed building keeps its exact footprint.
    for (const prev of before.buildings) {
      const now = buildingById(after, prev.id);
      expect(now.rect).toEqual(prev.rect);
      expect(now.roomId).toEqual(prev.roomId);
      expect(now.entityId).toEqual(prev.entityId);
    }
  });

  it("places the spawn on a walkable (non-building) tile", () => {
    const rooms = [room("ws-1", "One")];
    const world = worldWith(
      Array.from({ length: 6 }, (_, i) => agent(`a-${i}`)),
      rooms,
    );
    const plan = buildTownPlan(world, { tileSize: TILE_SIZE });
    const tx = worldToTile(plan.spawn.x, plan.tileSize);
    const ty = worldToTile(plan.spawn.y, plan.tileSize);
    expect(tx).toBeGreaterThanOrEqual(0);
    expect(ty).toBeGreaterThanOrEqual(0);
    expect(tx).toBeLessThan(plan.cols);
    expect(ty).toBeLessThan(plan.rows);
    const tile = tileAt(plan, tx, ty);
    expect(tile).not.toBe("building");
  });

  it("never paints a building tile outside a building rect, and every rect is blocked", () => {
    const rooms = [room("ws-1", "One"), room("ws-2", "Two")];
    const world = worldWith(
      Array.from({ length: 10 }, (_, i) => agent(`a-${i}`)),
      rooms,
    );
    const plan = buildTownPlan(world, { tileSize: TILE_SIZE });

    const isInsideABuilding = (x: number, y: number): boolean =>
      plan.buildings.some(
        (b) =>
          x >= b.rect.x &&
          x < b.rect.x + b.rect.w &&
          y >= b.rect.y &&
          y < b.rect.y + b.rect.h,
      );

    for (let y = 0; y < plan.rows; y += 1) {
      for (let x = 0; x < plan.cols; x += 1) {
        const tile = tileAt(plan, x, y);
        if (tile === "building") {
          expect(isInsideABuilding(x, y)).toBe(true);
        }
      }
    }
    // And conversely, each building rect's tiles are all marked blocked.
    for (const b of plan.buildings) {
      for (let y = b.rect.y; y < b.rect.y + b.rect.h; y += 1) {
        for (let x = b.rect.x; x < b.rect.x + b.rect.w; x += 1) {
          expect(tileAt(plan, x, y)).toBe("building");
        }
      }
    }
  });

  it("rejects a non-positive tileSize with a typed error", () => {
    const world = worldWith([agent("a")]);
    expect(() => buildTownPlan(world, { tileSize: 0 })).toThrow(
      /tileSize must be a positive/,
    );
    expect(() => buildTownPlan(world, { tileSize: -4 })).toThrow();
  });
});
