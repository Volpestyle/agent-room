/**
 * Diorama framework interfaces — the pluggable seams of the bridge.
 *
 * From `docs/diorama/GAME_BRIDGE.md` §4.3 ({@link SkinMap}), §4.4
 * ({@link LayoutStrategy}), and §4.5 ({@link WorldCommands} / {@link WorldSource}).
 *
 * These are *contracts only* — no implementations live here. They describe the
 * three reusability seams of the framework:
 *
 *  - {@link LayoutStrategy} owns space (the backend has none). Implementations MUST
 *    be deterministic, seeded by entity/object id — no randomness, no wall-clock
 *    reads (see `agent-room/AGENTS.md`, GAME_BRIDGE §3 & §6). Same inputs → same scene.
 *  - {@link SkinMap} is the theming seam: a declarative map from domain facts →
 *    visual assets/behaviors. Swapping it reskins the whole world.
 *  - {@link WorldSource} / {@link WorldCommands} abstract where events come from and
 *    where commands go, so a world can be backed by an AgentRoom daemon today (SSE +
 *    REST) and another source (e.g. Clanky) later, without the renderer knowing.
 *
 * Everything here is fully typed — no `any` (see `dev/AGENTS.md`).
 */

import type {
  AgentRole,
  AgentState,
  Id,
  Importance,
  RoomEvent,
  RoomEventType,
} from "@agentroom/core";
import type {
  AnimationState,
  MoveIntent,
  Rect,
  TaskStatus,
  Vec2,
  WorldEffectKind,
  WorldEntity,
  WorldObject,
  WorldRoom,
  WorldSnapshot,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// §4.4 — Layout strategy: owns space, because the backend doesn't.
// ---------------------------------------------------------------------------

/**
 * Pluggable policy that assigns world-space positions and movement to the
 * otherwise position-less domain. Implementations MUST be pure and deterministic
 * — seeded by entity/object id so a clanker stands in the same place every
 * session (GAME_BRIDGE §4.4, §6). No randomness, no wall-clock.
 */
export interface LayoutStrategy {
  /** Stable resting position for an entity, seeded by its id (same spot each load). */
  placeEntity(entity: WorldEntity, world: WorldSnapshot): Vec2;
  /** Position for a task desk/object, grouped near its assignee/room. */
  placeObject(object: WorldObject, world: WorldSnapshot): Vec2;
  /** Movement(s) an event implies — e.g. handoff → walk path; message → approach recipient. */
  moveIntentFor(event: RoomEvent, world: WorldSnapshot): MoveIntent[];
  /** Floor-plan footprint for a room/zone (workspace/channel → floor zone). */
  roomBounds(room: WorldRoom, world: WorldSnapshot): Rect;
}

// ---------------------------------------------------------------------------
// §4.3 — Skin Map supporting ref/spec shapes.
// ---------------------------------------------------------------------------

/** A reference to a multi-frame sprite sheet (e.g. a walk cycle for a role). */
export interface SpriteSheetRef {
  /** Asset path / URL of the packed sheet. */
  src: string;
  /** Width of one frame, in pixels. */
  frameWidth: number;
  /** Height of one frame, in pixels. */
  frameHeight: number;
  /** Total number of frames in the sheet. */
  frames: number;
}

/** A reference to a single static sprite (e.g. one desk-state image). */
export interface SpriteRef {
  /** Asset path / URL of the sprite. */
  src: string;
}

/** A reference to a tileset image used to paint the floor plan. */
export interface TilesetRef {
  /** Asset path / URL of the tileset image. */
  src: string;
  /** Square tile edge length, in pixels. */
  tileSize: number;
}

/** A reference to a named color palette the renderer applies to the world. */
export interface PaletteRef {
  /** Asset path / URL of the palette resource. */
  src: string;
}

/** How a domain event maps to a transient {@link WorldEffect}. */
export interface EffectSpec {
  /** The kind of effect to spawn (bubble, alert, celebration, carried item). */
  kind: WorldEffectKind;
  /** Optional transient lifetime in ms; renderer fades the effect after it elapses. */
  ttlMs?: number;
}

/** Visual styling for a message speech bubble, keyed by {@link Importance}. */
export interface BubbleStyle {
  /** Bubble accent color (e.g. `urgent` renders hot/red). */
  color: string;
  /** Whether the bubble text renders bold. */
  bold?: boolean;
}

/**
 * The theming seam (GAME_BRIDGE §4.3): a declarative map from domain facts →
 * visual assets/behaviors. Defaults ship; everything is overridable. Swapping
 * this is how the same bridge powers a Sims game, a spaceship crew, or a clanker
 * factory — same data, different costume.
 */
export interface SkinMap {
  /** Sprite sheet per agent role — drives the character skin. */
  roleSkins: Record<AgentRole, SpriteSheetRef>;
  /** Domain state → animation (e.g. `blocked → 'alert'`, `done → 'celebrate'`). */
  stateAnimations: Record<AgentState, AnimationState>;
  /** Event type → effect (e.g. `handoff.created → carry-item`); not every event maps. */
  eventEffects: Partial<Record<RoomEventType, EffectSpec>>;
  /** Message importance → bubble style (`urgent` glows hot). */
  importanceStyles: Record<Importance, BubbleStyle>;
  /** Object skins, keyed by kind then status — e.g. desk states for tasks. */
  objectSkins: { task: Record<TaskStatus, SpriteRef> };
  /** World-level theme assets: floor tileset + color palette. */
  theme: { tileset: TilesetRef; palette: PaletteRef };
}

// ---------------------------------------------------------------------------
// §4.5 — Command API + Source adapter.
// ---------------------------------------------------------------------------

/** Typed spec for launching a new agent into the room. */
export interface LaunchSpec {
  /** Role the launched agent should take in the world. */
  role: AgentRole;
  /** Runtime provider id to bind the agent to (e.g. a herdr/tmux provider). */
  providerId: string;
  /** Harness/command to start (e.g. the coding-agent startup command). */
  command: string;
  /** Optional human-readable label for the agent. */
  label?: string;
}

/** Typed unit of work to delegate to an agent. */
export interface DelegateWork {
  /** The instruction / prompt describing the work to perform. */
  prompt: string;
  /** Optional external work-tracker reference (e.g. a Linear issue ref). */
  trackerRef?: string;
}

/**
 * Thin typed wrappers over the daemon's existing REST endpoints (GAME_BRIDGE
 * §4.5), so "click → act" is uniform across renderers. Each call resolves when
 * the command has been accepted; failures reject with a typed error.
 */
export interface WorldCommands {
  /** Send raw input into an agent's runtime (POST runtime input). */
  sendInput(agentId: Id, text: string): Promise<void>;
  /** Launch a new agent from a typed {@link LaunchSpec}. */
  launch(spec: LaunchSpec): Promise<void>;
  /** Stop a running agent. */
  stop(agentId: Id): Promise<void>;
  /** Delegate a typed unit of {@link DelegateWork} to an agent. */
  delegate(agentId: Id, work: DelegateWork): Promise<void>;
  /** Post a message body into a channel. */
  post(channelId: Id, body: string): Promise<void>;
  /** Answer/resolve an open human escalation. */
  resolveEscalation(escalationId: Id, answer: string): Promise<void>;
}

/** A live subscription handle; call {@link Subscription.close} to stop streaming. */
export interface Subscription {
  /** Tear down the subscription and release its transport (SSE/WS). */
  close(): void;
}

/**
 * Source adapter (GAME_BRIDGE §4.5): abstracts where events/commands come from,
 * so a world can be backed by an AgentRoom daemon today (SSE for events, REST for
 * commands) and another source later, without the renderer knowing.
 */
export interface WorldSource {
  /**
   * Subscribe to the room event stream starting at `cursor` (an opaque resume
   * cursor; "start"/"end" or a byte-position string per F1). `onEvent` receives
   * each event with the cursor that follows it, for durable resume.
   */
  subscribe(
    cursor: string,
    onEvent: (event: RoomEvent, cursor: string) => void,
  ): Subscription;
  /** The command surface for this source. */
  commands: WorldCommands;
}
