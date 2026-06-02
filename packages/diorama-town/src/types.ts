/**
 * `@agentroom/diorama-town` — shared data types for the inhabitable town spike.
 *
 * Pure presentation/layout shapes consumed by the town's game logic (camera,
 * collision, player, layout). All geometry reuses {@link Vec2}/{@link Rect} from
 * `@agentroom/diorama-core` so the town and the world protocol speak the same
 * spatial language. Nothing here is randomized or wall-clock dependent — every
 * value is derived deterministically from the world snapshot and its ids.
 *
 * No `any`, no fallback data (`dev/AGENTS.md`).
 */

import type { Vec2, Rect } from "@agentroom/diorama-core";
import type { AnimationState } from "@agentroom/diorama-core";

/** A width/height pair in world (pixel) units. */
export interface Size {
  w: number;
  h: number;
}

/**
 * The kind of a single town tile.
 * - `ground`: open, walkable terrain.
 * - `path`: walkable connective routes (plaza spokes, building approaches).
 * - `building`: a structure footprint; blocked for collision.
 * - `plaza`: the central walkable gathering area / town entrance surround.
 */
export type TileKind = "ground" | "path" | "building" | "plaza";

/**
 * A placed structure on the town floor plan — one per agent entity (or a
 * shared lot grouped by room/workspace). Its `rect` is in tile coordinates and
 * is treated as blocked terrain by the collision grid.
 */
export interface Building {
  /** Stable, deterministic id for this building (id-keyed slot assignment). */
  id: string;
  /** The agent WorldEntity this building represents, when one-per-agent. */
  entityId?: string;
  /** The room/workspace this building is grouped under, when applicable. */
  roomId?: string;
  /** Footprint in tile coordinates (x/y/w/h measured in tiles). */
  rect: Rect;
}

/**
 * The fully laid-out town: a deterministic floor plan derived from a world
 * snapshot. Tiles are stored row-major (`tiles[row * cols + col]`).
 */
export interface TownPlan {
  /** Edge length of a single tile in world (pixel) units. */
  tileSize: number;
  /** Town width in tiles. */
  cols: number;
  /** Town height in tiles. */
  rows: number;
  /** Walkable world-space bounds for the camera/player (in pixel units). */
  bounds: Rect;
  /** Row-major tile kinds; length is exactly `cols * rows`. */
  tiles: TileKind[];
  /** Every placed building, keyed and ordered deterministically by id. */
  buildings: Building[];
  /** The town entrance spawn point, in world (pixel) coordinates. */
  spawn: Vec2;
}

/**
 * A coarse, tile-resolution blocked/clear map derived from a {@link TownPlan}.
 * Used by movement resolution for cheap axis-separated collision queries.
 * `blocked` is row-major (`blocked[row * cols + col]`).
 */
export interface CollisionGrid {
  /** Grid width in tiles. */
  cols: number;
  /** Grid height in tiles. */
  rows: number;
  /** Edge length of a single tile in world (pixel) units. */
  tileSize: number;
  /** Row-major blocked flags; `true` means the tile cannot be entered. */
  blocked: boolean[];
}

/** The cardinal direction a player sprite is facing. */
export type Facing = "up" | "down" | "left" | "right";

/** The simulated player avatar's current state. */
export interface PlayerState {
  /** Player center position in world (pixel) coordinates. */
  position: Vec2;
  /** The dominant-axis direction the player is facing. */
  facing: Facing;
  /** Whether the player is currently moving this frame. */
  moving: boolean;
  /** Derived sprite animation: `walk` while moving, otherwise `idle`. */
  animation: AnimationState;
}

/** Normalized movement intent for a single frame. */
export interface InputState {
  /** Movement axis; each component is clamped to `[-1, 1]`. */
  axis: Vec2;
}

/** The camera's current viewport position in the world. */
export interface CameraState {
  /** Viewport top-left corner, in world (pixel) coordinates. */
  position: Vec2;
}

/** Configuration for camera follow behavior. */
export interface CameraOptions {
  /** Visible viewport size in world (pixel) units. */
  viewport: Size;
  /** Centered dead-zone box; the camera only scrolls once the target exits it. */
  deadZone: Size;
  /** World extent the viewport is clamped within (in pixel units). */
  worldBounds: Rect;
}

/** Configuration for deterministic town layout. */
export interface TownLayoutOptions {
  /** Edge length of a single tile in world (pixel) units. */
  tileSize: number;
}
