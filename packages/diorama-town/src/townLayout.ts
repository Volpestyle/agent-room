/**
 * `@agentroom/diorama-town` — deterministic town floor-plan layout (T3).
 *
 * Turns a {@link WorldSnapshot} into an inhabitable {@link TownPlan}: one building
 * per agent {@link WorldEntity}, the buildings grouped into districts by room
 * (workspace), surrounded by walkable ground/path tiles, with a single spawn
 * point at the town entrance and world bounds sized to fit everything.
 *
 * DETERMINISM (GAME_BRIDGE §6, `agent-room/AGENTS.md`): every placement is a pure
 * function of stable ids. There is no randomness and no wall-clock read, so the
 * same world always lays out the same town on every client and every session. The
 * hashing reuses the FNV-1a style from `diorama-core/defaults.ts`.
 *
 * STABILITY: each agent's lot is keyed by its OWN id (a hash into a fixed,
 * count-independent slot grid with min-id-owns collision resolution — see
 * {@link assignSlots}), NOT by its rank among the current members. Districts get a
 * constant reserved height, so a growing district never shifts its neighbours.
 * Together this means adding an agent (the ordinary "a new agent joined" case)
 * leaves every existing building rect exactly where it was. (Room/district
 * assignment is also untouched, since adding an agent does not change the room
 * set.)
 *
 * No `any`, no fallback/fabricated data — real logic or a typed error
 * (`dev/AGENTS.md`).
 */

import type {
  Rect,
  Vec2,
  WorldEntity,
  WorldRoom,
  WorldSnapshot,
} from "@agentroom/diorama-core";
import type {
  Building,
  TileKind,
  TownLayoutOptions,
  TownPlan,
} from "./types.js";

// ---------------------------------------------------------------------------
// Deterministic hashing (FNV-1a 32-bit) — copied in style from
// diorama-core/defaults.ts so town placement matches the world's seeding.
// ---------------------------------------------------------------------------

/**
 * A small, stable, non-cryptographic string hash (FNV-1a, 32-bit). Returns a
 * non-negative integer; identical input always yields identical output across
 * runs and platforms.
 */
function stableHash(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Tile-space constants for the town floor plan. All measured in tiles.
// ---------------------------------------------------------------------------

/** Footprint of a single agent building, in tiles. */
const BUILDING_W = 4;
const BUILDING_H = 4;
/** Walkable gap (path) between adjacent building lots, in tiles. */
const LOT_GAP_X = 2;
const LOT_GAP_Y = 2;
/** How many building lots sit in a row before a district wraps to a new row. */
const LOTS_PER_ROW = 4;
/** Walkable margin around the whole town, in tiles. */
const TOWN_MARGIN = 3;
/** Walkable gap between districts (stacked vertically), in tiles. */
const DISTRICT_GAP_Y = 3;
/** Plaza band height at the town entrance, in tiles. */
const PLAZA_ROWS = 4;

/** A single lot's pitch (footprint + trailing gap), in tiles. */
const LOT_PITCH_X = BUILDING_W + LOT_GAP_X;
const LOT_PITCH_Y = BUILDING_H + LOT_GAP_Y;

/**
 * Rows of lots reserved per district. The slot space (and therefore each
 * district's reserved height) is a FIXED constant independent of how many agents
 * the district currently holds. Keeping it constant is what makes one district's
 * growth never shift another district: vertical district origins never move as
 * agents join. A district holds up to `DISTRICT_LOT_ROWS * LOTS_PER_ROW` agents
 * (ample for a Phase 1 spike room).
 */
const DISTRICT_LOT_ROWS = 6;
/** Fixed lot-slot capacity per district (`rows * cols`). */
const SLOTS_PER_DISTRICT = DISTRICT_LOT_ROWS * LOTS_PER_ROW;

// ---------------------------------------------------------------------------
// Grouping — deterministic entity → district (room) assignment.
// ---------------------------------------------------------------------------

/**
 * A district is the set of agents grouped under one room (workspace). Districts
 * are stacked vertically below the entrance plaza; agents fill a wrapping grid of
 * lots within their district.
 */
interface District {
  /** The room this district represents, or `null` for the unassigned commons. */
  roomId: string | null;
  /** Agent entity ids, in a stable (id-sorted) slot order. */
  entityIds: string[];
}

/**
 * Pick a stable district key for an entity. The {@link WorldEntity} protocol does
 * not carry a room id, so when rooms exist we assign each agent to one room
 * deterministically by hashing its id over the *sorted* room id list. With no
 * rooms, every agent shares a single commons district (key `null`).
 *
 * Crucially this is a pure function of the entity id and the room set — adding an
 * agent leaves the room set unchanged, so no existing agent's district moves.
 */
function districtKeyFor(
  entityId: string,
  sortedRoomIds: string[],
): string | null {
  if (sortedRoomIds.length === 0) return null;
  const index = stableHash(entityId) % sortedRoomIds.length;
  return sortedRoomIds[index] ?? null;
}

/**
 * Group every agent entity into districts by room, with each district's agents
 * placed into stable, id-sorted slots. District order itself is stable: rooms in
 * sorted id order first, then the commons (`null`) if it has any occupants.
 */
function buildDistricts(world: WorldSnapshot): District[] {
  const rooms: WorldRoom[] = Object.values(world.rooms);
  const sortedRoomIds = rooms.map((room) => room.id).sort();

  const byKey = new Map<string | null, string[]>();
  for (const id of sortedRoomIds) byKey.set(id, []);

  const entities: WorldEntity[] = Object.values(world.entities);
  for (const entity of entities) {
    const key = districtKeyFor(entity.id, sortedRoomIds);
    const bucket = byKey.get(key);
    if (bucket === undefined) {
      byKey.set(key, [entity.id]);
    } else {
      bucket.push(entity.id);
    }
  }

  const districts: District[] = [];
  // Rooms first, in sorted id order — a stable, deterministic district sequence.
  for (const roomId of sortedRoomIds) {
    const ids = byKey.get(roomId);
    if (ids !== undefined && ids.length > 0) {
      districts.push({ roomId, entityIds: ids.slice().sort() });
    }
  }
  // The commons (entities with no room) trail the named districts.
  const commons = byKey.get(null);
  if (commons !== undefined && commons.length > 0) {
    districts.push({ roomId: null, entityIds: commons.slice().sort() });
  }
  return districts;
}

// ---------------------------------------------------------------------------
// Placement geometry — turn districts into building rects (in tiles).
// ---------------------------------------------------------------------------

/** A district laid out at a vertical offset, with its agents' building rects. */
interface PlacedDistrict {
  roomId: string | null;
  buildings: Building[];
  /** Rows this district occupies (building grid only), in tiles. */
  rows: number;
}

/**
 * A secondary hash, derived from the primary, for the overflow region. Distinct
 * mixing so an id that collides at its primary home rarely collides again.
 */
function secondaryHash(id: string): number {
  let x = stableHash(id) ^ 0x9e3779b9;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  return x >>> 0;
}

/**
 * Assign every member of a district to a DISTINCT lot slot keyed PURELY by its
 * own id — never by its rank among the current members. Rank-based slotting would
 * shift everyone after an inserted id; id-keyed slotting does not.
 *
 * Slots are split into a primary region `[0, PRIMARY)` and an overflow region
 * `[PRIMARY, SLOTS_PER_DISTRICT)`. The assignment rule:
 *  - An id's primary home is `h(id) mod PRIMARY`.
 *  - When several ids share a home, the **minimum id** owns it and stays put
 *    regardless of who joins later; the rest are "losers".
 *  - Losers are reseated in the overflow region by the SAME min-id-owns rule on
 *    `secondaryHash`, and any second-order collision falls back to a stable
 *    sorted-id append at the tail.
 *
 * Stability: because each contested slot is owned by the smallest colliding id,
 * adding an agant whose id sorts AFTER its home's current owner — the ordinary
 * "a new agent joined" case — never evicts an incumbent, so every existing
 * building keeps its exact footprint. (Introducing an id that sorts BEFORE an
 * incumbent at the very same home is the one documented case that can reseat that
 * home; it is rare and bounded to a single home group.) The result is fully
 * deterministic and independent of entity insertion order.
 *
 * Returns slot indices keyed by entity id; slot 0 is the top-left lot.
 */
function assignSlots(entityIds: string[]): Map<string, number> {
  if (entityIds.length > SLOTS_PER_DISTRICT) {
    throw new Error(
      `district overflow: ${entityIds.length} agents exceeds the ` +
        `${SLOTS_PER_DISTRICT}-slot district capacity`,
    );
  }
  // Reserve the last lot-row of the grid as the overflow region; the primary
  // region (where each id homes via the primary hash) uses the rows above it.
  const primarySlots = (DISTRICT_LOT_ROWS - 1) * LOTS_PER_ROW;
  const overflowStart = primarySlots;
  const overflowSize = SLOTS_PER_DISTRICT - primarySlots;

  const slotById = new Map<string, number>();
  const occupied = new Set<number>();

  // Group by primary home; smallest id owns the home, others are losers.
  const homeGroups = new Map<number, string[]>();
  for (const id of entityIds) {
    const home = stableHash(id) % primarySlots;
    const group = homeGroups.get(home);
    if (group === undefined) homeGroups.set(home, [id]);
    else group.push(id);
  }
  const losers: string[] = [];
  for (const [home, group] of homeGroups) {
    const sorted = group.slice().sort();
    const owner = sorted[0];
    if (owner === undefined) continue;
    slotById.set(owner, home);
    occupied.add(home);
    for (let i = 1; i < sorted.length; i += 1) {
      const loser = sorted[i];
      if (loser !== undefined) losers.push(loser);
    }
  }

  // Reseat losers in the overflow region by the same min-id-owns rule.
  const overflowGroups = new Map<number, string[]>();
  for (const id of losers) {
    const home = overflowStart + (secondaryHash(id) % overflowSize);
    const group = overflowGroups.get(home);
    if (group === undefined) overflowGroups.set(home, [id]);
    else group.push(id);
  }
  const stillLost: string[] = [];
  for (const [home, group] of overflowGroups) {
    const sorted = group.slice().sort();
    const owner = sorted[0];
    if (owner === undefined || occupied.has(home)) {
      stillLost.push(...sorted);
      continue;
    }
    slotById.set(owner, home);
    occupied.add(home);
    for (let i = 1; i < sorted.length; i += 1) {
      const loser = sorted[i];
      if (loser !== undefined) stillLost.push(loser);
    }
  }

  // Final fallback: any remaining doubly-collided ids take the lowest free slots
  // in sorted-id order. Deterministic and order-independent.
  if (stillLost.length > 0) {
    const free: number[] = [];
    for (
      let s = 0;
      s < SLOTS_PER_DISTRICT && free.length < stillLost.length;
      s += 1
    ) {
      if (!occupied.has(s)) free.push(s);
    }
    stillLost.sort();
    stillLost.forEach((id, i) => {
      const slot = free[i];
      if (slot === undefined) {
        throw new Error(`district overflow: no free slot for ${id}`);
      }
      slotById.set(id, slot);
      occupied.add(slot);
    });
  }

  return slotById;
}

/**
 * Place one district's buildings into a wrapping lot grid, anchored at
 * (`originX`, `originY`) in tile coordinates. Each agent occupies the id-keyed
 * slot from {@link assignSlots}, so building positions are stable as agents join.
 * The district's reserved height is constant, so growth never shifts neighbours.
 */
function placeDistrict(
  district: District,
  originX: number,
  originY: number,
): PlacedDistrict {
  const slots = assignSlots(district.entityIds);
  const buildings: Building[] = [];
  // Emit in stable id order so the buildings array itself is deterministic.
  for (const entityId of district.entityIds.slice().sort()) {
    const slot = slots.get(entityId);
    if (slot === undefined) {
      throw new Error(`assignSlots dropped entity ${entityId}`);
    }
    const col = slot % LOTS_PER_ROW;
    const row = Math.floor(slot / LOTS_PER_ROW);
    const rect: Rect = {
      x: originX + col * LOT_PITCH_X,
      y: originY + row * LOT_PITCH_Y,
      w: BUILDING_W,
      h: BUILDING_H,
    };
    const building: Building = {
      id: `bldg:${entityId}`,
      entityId,
      rect,
    };
    if (district.roomId !== null) building.roomId = district.roomId;
    buildings.push(building);
  }
  return {
    roomId: district.roomId,
    buildings,
    // Constant reserved height: independent of occupancy, so a growing district
    // never shifts the districts stacked below it.
    rows: DISTRICT_LOT_ROWS * LOT_PITCH_Y,
  };
}

/** The widest district (in tiles), used to size the town. */
function districtGridWidth(): number {
  // A full row of lots; the trailing gap is absorbed by the town margin so we
  // do not count it past the last lot.
  return LOTS_PER_ROW * LOT_PITCH_X - LOT_GAP_X;
}

// ---------------------------------------------------------------------------
// Tile rasterization.
// ---------------------------------------------------------------------------

/** Fill a row-major tile array of `cols * rows`, painting buildings as blocked. */
function rasterizeTiles(
  cols: number,
  rows: number,
  buildings: Building[],
  plazaRows: number,
): TileKind[] {
  const tiles: TileKind[] = new Array<TileKind>(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      // The entrance plaza is the top band, inside the margin.
      const inPlaza =
        r >= TOWN_MARGIN &&
        r < TOWN_MARGIN + plazaRows &&
        c >= TOWN_MARGIN &&
        c < cols - TOWN_MARGIN;
      tiles[r * cols + c] = inPlaza ? "plaza" : "ground";
    }
  }

  // Carve building footprints (blocked) and a one-tile path apron around them so
  // every building is reachable on foot.
  for (const building of buildings) {
    paintApron(tiles, cols, rows, building.rect);
  }
  for (const building of buildings) {
    paintBuilding(tiles, cols, rows, building.rect);
  }
  return tiles;
}

/** Paint a one-tile-thick `path` apron around a building rect (walkable). */
function paintApron(
  tiles: TileKind[],
  cols: number,
  rows: number,
  rect: Rect,
): void {
  const x0 = rect.x - 1;
  const y0 = rect.y - 1;
  const x1 = rect.x + rect.w;
  const y1 = rect.y + rect.h;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      const index = y * cols + x;
      // Only upgrade walkable ground to a path; never overwrite the plaza band.
      if (tiles[index] === "ground") tiles[index] = "path";
    }
  }
}

/** Paint a building rect as blocked `building` tiles. */
function paintBuilding(
  tiles: TileKind[],
  cols: number,
  rows: number,
  rect: Rect,
): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      tiles[y * cols + x] = "building";
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Build a deterministic, id-seeded {@link TownPlan} from a world snapshot.
 *
 * One building per agent entity, grouped into districts by room. Districts stack
 * vertically below an entrance plaza; agents fill a wrapping lot grid within each
 * district. Ground/path tiles surround the buildings, the spawn sits at the
 * entrance plaza, and world bounds are sized to fit the whole town.
 */
export function buildTownPlan(
  world: WorldSnapshot,
  opts: TownLayoutOptions,
): TownPlan {
  const { tileSize } = opts;
  if (!Number.isFinite(tileSize) || tileSize <= 0) {
    throw new Error(
      `buildTownPlan: tileSize must be a positive finite number, got ${tileSize}`,
    );
  }

  const districts = buildDistricts(world);

  // Lay districts out top-to-bottom, below the entrance plaza, each anchored
  // inside the town margin. Building columns start one tile in from the margin
  // so the apron path stays inside the town.
  const originX = TOWN_MARGIN + 1;
  const plazaBottom = TOWN_MARGIN + PLAZA_ROWS;
  let cursorY = plazaBottom + 1;
  const placed: PlacedDistrict[] = [];
  for (const district of districts) {
    const placedDistrict = placeDistrict(district, originX, cursorY);
    placed.push(placedDistrict);
    cursorY += placedDistrict.rows + DISTRICT_GAP_Y;
  }

  const buildings: Building[] = placed.flatMap((d) => d.buildings);

  // Size the grid: wide enough for a full lot row plus margins and the building
  // origin offset; tall enough for the plaza, every district, and bottom margin.
  const gridWidth = districtGridWidth();
  const cols = gridWidth + originX + TOWN_MARGIN;
  // `cursorY` already includes a trailing DISTRICT_GAP_Y after the last district
  // (or sits at the first lot row when there are none); reserve the bottom margin.
  const rows = Math.max(cursorY + TOWN_MARGIN, plazaBottom + TOWN_MARGIN + 1);

  const tiles = rasterizeTiles(cols, rows, buildings, PLAZA_ROWS);

  // Spawn at the center of the entrance plaza band, in world (pixel) coordinates
  // (tile center). The plaza is always painted walkable, so this is a guaranteed
  // walkable tile.
  const spawnTileX = Math.floor(cols / 2);
  const spawnTileY = TOWN_MARGIN + Math.floor(PLAZA_ROWS / 2);
  const spawn: Vec2 = {
    x: (spawnTileX + 0.5) * tileSize,
    y: (spawnTileY + 0.5) * tileSize,
  };

  const bounds: Rect = {
    x: 0,
    y: 0,
    w: cols * tileSize,
    h: rows * tileSize,
  };

  return {
    tileSize,
    cols,
    rows,
    bounds,
    tiles,
    buildings,
    spawn,
  };
}
