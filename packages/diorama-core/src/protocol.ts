/**
 * Diorama World Protocol — the denormalized, renderer-facing state.
 *
 * From `docs/diorama/GAME_BRIDGE.md` §4.2. `diorama-core` keeps a cursor, replays
 * the daemon's `RoomEvent` stream (SSE, F1), and maintains a reactive
 * {@link WorldSnapshot}. The renderer never touches raw events — it binds to this
 * snapshot and diffs it to tween sprites.
 *
 * Hard rule (`agent-room/CLAUDE.md`, GAME_BRIDGE §3): spatial position, animation
 * state, skins, and layout are **client-side presentation concerns**. They never
 * enter `@agentroom/core` domain types or the event log. The backend stays
 * semantic; the world is *derived*. Everything here is fully typed — no `any`.
 */

import type {
  AgentRole,
  AgentState,
  Id,
  ISODateTime,
  Importance,
  RoomEventType,
} from "@agentroom/core";

/** A 2D position in world/tile space. Assigned by a LayoutStrategy (F5), never by the backend. */
export interface Vec2 {
  x: number;
  y: number;
}

/** An axis-aligned rectangle — a room/zone footprint on the floor plan. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Derived sprite animation state — the visual expression of a domain state.
 * The domain→animation mapping lives in the SkinMap (F5); e.g. `blocked → 'alert'`,
 * `needs-human → 'wave'`, `working → 'typing'`, `done → 'celebrate'`.
 */
export type AnimationState =
  | "idle"
  | "walk"
  | "typing"
  | "thinking"
  | "alert"
  | "wave"
  | "celebrate"
  | "slump";

/** A pending movement the renderer should animate (walk path, approach, etc.). */
export interface MoveIntent {
  kind: "approach-entity" | "walk-to-object" | "walk-to-point";
  /** Entity id, object id, or an explicit point depending on `kind`. */
  target: Id | Vec2;
}

/** A floating status marker over an entity that needs attention. */
export type EntityBadge = "needs-human" | "blocked";

/**
 * A live participant in the world (an agent today; humans/bots later).
 * `domainState` is raw truth from the projection; `presentation` is derived & client-only.
 */
export interface WorldEntity {
  id: Id;
  kind: "agent";
  /** Drives the sprite sheet / skin. */
  role: AgentRole;
  /** Raw truth from the AgentRoom projection. */
  domainState: AgentState;
  /** DERIVED, client-only — never sent to or stored by the backend. */
  presentation: {
    animation: AnimationState;
    position: Vec2;
    intent?: MoveIntent;
    badge?: EntityBadge;
  };
  lastHeartbeatAt?: ISODateTime;
}

/**
 * Presentation status of a task/desk object. Tasks live in an external work
 * tracker (Linear, etc.), not in `@agentroom/core`, so this is a derived,
 * client-side enum — deliberately *not* a domain type.
 */
export type TaskStatus = "planned" | "working" | "done" | "blocked";

/** A task rendered as a desk / workstation / job object in the world. */
export interface WorldObject {
  id: Id;
  kind: "task";
  status: TaskStatus;
  title?: string;
  /** The entity (assignee) whose desk this is, if any. */
  ownerEntityId?: Id;
  /** The room/zone this object sits in. */
  roomId?: Id;
  presentation: {
    position: Vec2;
  };
}

/** A room/zone of the floor plan, derived from a Workspace or channel. */
export interface WorldRoom {
  id: Id;
  kind: "workspace" | "channel";
  label: string;
  presentation: {
    /** Floor-plan footprint, assigned by the layout strategy. */
    bounds: Rect;
  };
}

/** Why two entities are currently connected. */
export type WorldLinkKind = "handoff" | "delegation" | "message";

/** An active relationship between entities — a handoff, delegation, or DM in flight. */
export interface WorldLink {
  id: Id;
  kind: WorldLinkKind;
  fromEntityId: Id;
  toEntityId: Id;
  /** `urgent` messages render hot (red bubble / glow). */
  importance?: Importance;
  label?: string;
  createdAt: ISODateTime;
}

/** A transient visual flourish — speech bubble, "!" alert, celebration, carried item. */
export type WorldEffectKind =
  | "speech-bubble"
  | "alert"
  | "celebrate"
  | "carry-item";

/** A short-lived effect anchored to an entity. */
export interface WorldEffect {
  id: Id;
  kind: WorldEffectKind;
  /** The entity the effect is anchored to. */
  entityId: Id;
  text?: string;
  importance?: Importance;
  /** The `RoomEvent` type that spawned this effect, for debugging/skin mapping. */
  sourceEventType?: RoomEventType;
  /** Transient lifetime in ms; the renderer fades the effect after it elapses. */
  ttlMs?: number;
  createdAt: ISODateTime;
}

/**
 * The complete denormalized world the renderer binds to. Produced by the
 * event→world reducer (F3) from the `RoomEvent` stream.
 */
export interface WorldSnapshot {
  /** Keyed by workspace id / channelId. */
  rooms: Record<Id, WorldRoom>;
  /** Keyed by agent id (later: humans, bots). */
  entities: Record<Id, WorldEntity>;
  /** Tasks rendered as desks/jobs, keyed by id. */
  objects: Record<Id, WorldObject>;
  /** Active handoffs / delegations / DMs. */
  links: WorldLink[];
  /** Transient effects (bubbles, alerts, celebrations). */
  effects: WorldEffect[];
  clock: {
    /** Opaque resume cursor (the SSE frame id from the stream). */
    cursor: string;
    /** When the last consumed event occurred; null for an empty world. */
    lastEventAt: ISODateTime | null;
  };
}

/** A fresh, empty world — the reducer's (F3) starting point before any event is applied. */
export function createEmptyWorldSnapshot(): WorldSnapshot {
  return {
    rooms: {},
    entities: {},
    objects: {},
    links: [],
    effects: [],
    clock: { cursor: "start", lastEventAt: null },
  };
}
