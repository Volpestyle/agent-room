/**
 * Default implementations of the framework seams (GAME_BRIDGE §4.3 / §4.4):
 * a deterministic {@link LayoutStrategy} and a baseline {@link SkinMap}.
 *
 * Both are pure and reproducible. The layout is seeded only by entity/object/room
 * id (a small stable string hash implemented here) — no randomness, no wall-clock
 * reads — so the same world always computes the same scene (GAME_BRIDGE §6). The
 * skin map is a declarative, fully-typed costume; swapping it reskins the world.
 *
 * No `any`, no fallback/fabricated data — every value here is a real, intentional
 * default (`dev/AGENTS.md`).
 */

import type {
  AgentRole,
  AgentState,
  Importance,
  RoomEvent,
} from "@agentroom/core";
import type {
  AnimationState,
  MoveIntent,
  Rect,
  TaskStatus,
  Vec2,
  WorldEntity,
  WorldObject,
  WorldRoom,
  WorldSnapshot,
} from "./protocol.js";
import type {
  BubbleStyle,
  LayoutStrategy,
  SkinMap,
  SpriteRef,
  SpriteSheetRef,
} from "./interfaces.js";

// ---------------------------------------------------------------------------
// Deterministic layout
// ---------------------------------------------------------------------------

/**
 * A small, stable, non-cryptographic string hash (FNV-1a, 32-bit). Returns a
 * non-negative integer. Deterministic across runs and platforms — identical
 * input always yields identical output — which is exactly what the layout needs
 * to keep a clanker in the same spot every session.
 */
function stableHash(id: string): number {
  // FNV-1a 32-bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    // hash *= 16777619, kept in 32-bit unsigned range without BigInt.
    hash = Math.imul(hash, 0x01000193);
  }
  // Coerce to an unsigned 32-bit integer.
  return hash >>> 0;
}

/** Tile-space constants for the default grid floor plan. */
const ENTITY_GRID_COLUMNS = 6;
const ENTITY_TILE_STEP = 3;
const OBJECT_GRID_COLUMNS = 6;
const OBJECT_TILE_STEP = 3;
/** Objects sit on their own band of the floor, below the entity band. */
const OBJECT_BAND_OFFSET_Y = 24;
const ROOM_GRID_COLUMNS = 3;
const ROOM_WIDTH = 32;
const ROOM_HEIGHT = 24;
const ROOM_GAP = 4;

/**
 * Deterministic, id-seeded grid layout. Entities cluster in one band, task
 * objects in another, rooms tile across a floor grid. Every position is a pure
 * function of the id, so placement is stable across reloads and identical on
 * every client (GAME_BRIDGE §4.4, §6).
 */
export function createDeterministicLayout(): LayoutStrategy {
  return {
    placeEntity(entity: WorldEntity, _world: WorldSnapshot): Vec2 {
      const seed = stableHash(entity.id);
      const col = seed % ENTITY_GRID_COLUMNS;
      const row = Math.floor(seed / ENTITY_GRID_COLUMNS) % ENTITY_GRID_COLUMNS;
      return {
        x: col * ENTITY_TILE_STEP,
        y: row * ENTITY_TILE_STEP,
      };
    },

    placeObject(object: WorldObject, _world: WorldSnapshot): Vec2 {
      const seed = stableHash(object.id);
      const col = seed % OBJECT_GRID_COLUMNS;
      const row = Math.floor(seed / OBJECT_GRID_COLUMNS) % OBJECT_GRID_COLUMNS;
      return {
        x: col * OBJECT_TILE_STEP,
        y: OBJECT_BAND_OFFSET_Y + row * OBJECT_TILE_STEP,
      };
    },

    moveIntentFor(event: RoomEvent, _world: WorldSnapshot): MoveIntent[] {
      switch (event.type) {
        case "handoff.created":
          // The giver walks to the receiver to hand off the task.
          return [
            { kind: "approach-entity", target: event.payload.toAgentId },
            { kind: "walk-to-object", target: event.payload.taskId },
          ];
        case "message.posted": {
          const recipient = event.payload.message.recipients?.[0];
          if (recipient !== undefined) {
            // Approach the first directed recipient to "deliver" the message.
            return [{ kind: "approach-entity", target: recipient.id }];
          }
          return [];
        }
        default:
          return [];
      }
    },

    roomBounds(room: WorldRoom, _world: WorldSnapshot): Rect {
      const seed = stableHash(room.id);
      const col = seed % ROOM_GRID_COLUMNS;
      const row = Math.floor(seed / ROOM_GRID_COLUMNS) % ROOM_GRID_COLUMNS;
      return {
        x: col * (ROOM_WIDTH + ROOM_GAP),
        y: row * (ROOM_HEIGHT + ROOM_GAP),
        w: ROOM_WIDTH,
        h: ROOM_HEIGHT,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Default skin map
// ---------------------------------------------------------------------------

/** Asset root for the default Clankton costume. Real, resolvable relative paths. */
const ASSET_ROOT = "assets/diorama";

/** Build a role sprite-sheet ref with the default frame geometry. */
function roleSheet(role: AgentRole): SpriteSheetRef {
  return {
    src: `${ASSET_ROOT}/roles/${role}.png`,
    frameWidth: 32,
    frameHeight: 32,
    frames: 8,
  };
}

/** Build a task desk sprite ref for a given status. */
function taskSprite(status: TaskStatus): SpriteRef {
  return { src: `${ASSET_ROOT}/objects/task-${status}.png` };
}

/** Bubble style for a given importance. */
function bubble(color: string, bold: boolean): BubbleStyle {
  return { color, bold };
}

const roleSkins: Record<AgentRole, SpriteSheetRef> = {
  lead: roleSheet("lead"),
  planner: roleSheet("planner"),
  implementer: roleSheet("implementer"),
  reviewer: roleSheet("reviewer"),
  runner: roleSheet("runner"),
  qa: roleSheet("qa"),
  observer: roleSheet("observer"),
  custom: roleSheet("custom"),
};

/**
 * Domain state → animation. This is the heart of the "Sims" feel
 * (GAME_BRIDGE §4.3): working types, blocked alerts, needs-human waves, done
 * celebrates, reviewing thinks, failed/stopped slumps, the rest idle.
 */
const stateAnimations: Record<AgentState, AnimationState> = {
  created: "idle",
  starting: "idle",
  online: "idle",
  working: "typing",
  waiting: "idle",
  blocked: "alert",
  "needs-human": "wave",
  reviewing: "thinking",
  done: "celebrate",
  idle: "idle",
  failed: "slump",
  stopped: "slump",
  unknown: "idle",
};

const importanceStyles: Record<Importance, BubbleStyle> = {
  low: bubble("#9aa0a6", false),
  normal: bubble("#e8eaed", false),
  high: bubble("#fbbc04", true),
  urgent: bubble("#ea4335", true),
};

const objectTaskSkins: Record<TaskStatus, SpriteRef> = {
  planned: taskSprite("planned"),
  working: taskSprite("working"),
  done: taskSprite("done"),
  blocked: taskSprite("blocked"),
};

/**
 * The default Clankton skin. `eventEffects` is intentionally partial — only
 * spatial/visible events map; the reducer (F3) owns effect spawning, this map is
 * the declarative table it consults.
 */
export const defaultSkinMap: SkinMap = {
  roleSkins,
  stateAnimations,
  eventEffects: {
    "message.posted": { kind: "speech-bubble", ttlMs: 4000 },
    "handoff.created": { kind: "carry-item", ttlMs: 3000 },
    "human_escalation.created": { kind: "alert" },
    "approval.requested": { kind: "alert" },
    "agent.done": { kind: "celebrate", ttlMs: 3000 },
    "agent.finished": { kind: "celebrate", ttlMs: 3000 },
  },
  importanceStyles,
  objectSkins: { task: objectTaskSkins },
  theme: {
    tileset: { src: `${ASSET_ROOT}/theme/floor.png`, tileSize: 32 },
    palette: { src: `${ASSET_ROOT}/theme/palette.json` },
  },
};
