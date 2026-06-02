/**
 * The event→world reducer (Diorama Phase 0, F3).
 *
 * Folds the daemon's `RoomEvent` stream (F1 SSE) into the denormalized
 * {@link WorldSnapshot} the renderer binds to (GAME_BRIDGE §4.2). All spatial
 * presentation (position, animation, badge, effect, link) is **derived here**,
 * never in the backend domain (GAME_BRIDGE §3, `agent-room/AGENTS.md`).
 *
 * Invariants:
 *  - PURE & IMMUTABLE: {@link reduceEvent} returns new objects and never mutates
 *    its input snapshot.
 *  - IDEMPOTENT ON REPLAY: folding the same log twice yields a deeply-equal
 *    snapshot. Effects and links are therefore keyed deterministically by their
 *    source event id (never blindly appended), and entity/object derivation is a
 *    pure function of the accumulated state.
 *  - DETERMINISTIC: all positions/animations come from the injected
 *    {@link LayoutStrategy} / {@link SkinMap}; no randomness, no wall-clock reads.
 *
 * AgentRoom has no task model (`agent-room/AGENTS.md`): {@link WorldObject}s are
 * derived ONLY from `taskId`s that appear inside other events.
 *
 * No `any`, no fallback/fabricated data — real logic or a typed error
 * (`dev/AGENTS.md`).
 */

import type {
  AgentState,
  Id,
  Importance,
  ISODateTime,
  RoomEvent,
  RoomEventType,
} from "@agentroom/core";
import type {
  EntityBadge,
  TaskStatus,
  WorldEffect,
  WorldEntity,
  WorldLink,
  WorldObject,
  WorldRoom,
  WorldSnapshot,
} from "./protocol.js";
import { createEmptyWorldSnapshot } from "./protocol.js";
import type { LayoutStrategy, SkinMap } from "./interfaces.js";

/** Dependencies the reducer needs to derive presentation. */
export interface ReducerDeps {
  layout: LayoutStrategy;
  skin: SkinMap;
}

// ---------------------------------------------------------------------------
// Deterministic keys — the backbone of idempotent replay.
// ---------------------------------------------------------------------------

/**
 * Effect id derived from its source event. Re-applying the same event overwrites
 * the same slot rather than appending a duplicate, so replay is idempotent. A
 * suffix disambiguates multiple effects spawned by one event.
 */
function effectId(event: RoomEvent, suffix: string): Id {
  return `fx:${event.id}:${suffix}`;
}

/** Link id derived from its source event, for the same idempotency reason. */
function linkId(event: RoomEvent): Id {
  return `link:${event.id}`;
}

/**
 * Effect id keyed by the escalation domain id (not the event id). The created
 * event spawns it and the answered event clears it by the SAME key — so the pair
 * round-trips deterministically and replay stays idempotent.
 */
function escalationEffectId(escalationId: Id): Id {
  return `fx:escalation:${escalationId}`;
}

/** Effect id keyed by the approval domain id, paired across request/grant/deny. */
function approvalEffectId(approvalId: Id): Id {
  return `fx:approval:${approvalId}`;
}

// ---------------------------------------------------------------------------
// Derivation helpers (pure).
// ---------------------------------------------------------------------------

/** Map a domain agent state to a floating attention badge, if any. */
function badgeForState(state: AgentState): EntityBadge | undefined {
  if (state === "blocked") return "blocked";
  if (state === "needs-human") return "needs-human";
  return undefined;
}

/**
 * Build an entity's derived presentation from its domain state, placing it via
 * the layout strategy and animating it via the skin map. Position is recomputed
 * deterministically (id-seeded) so it is stable across recompute and replay.
 */
function deriveEntityPresentation(
  entity: WorldEntity,
  world: WorldSnapshot,
  deps: ReducerDeps,
): WorldEntity["presentation"] {
  const animation = deps.skin.stateAnimations[entity.domainState];
  const position = deps.layout.placeEntity(entity, world);
  const badge = badgeForState(entity.domainState);
  const presentation: WorldEntity["presentation"] = { animation, position };
  if (badge !== undefined) presentation.badge = badge;
  return presentation;
}

/** Replace (or insert) an entity in the entities map, returning a new map. */
function withEntity(
  snapshot: WorldSnapshot,
  entity: WorldEntity,
): Record<Id, WorldEntity> {
  return { ...snapshot.entities, [entity.id]: entity };
}

/**
 * Update an existing entity's domain state and re-derive its presentation.
 * Returns the snapshot unchanged if the entity is unknown (e.g. a heartbeat for
 * an agent that never joined) — we never fabricate an entity from a bare id.
 */
function updateEntityState(
  snapshot: WorldSnapshot,
  agentId: Id,
  state: AgentState,
  deps: ReducerDeps,
  lastHeartbeatAt?: ISODateTime,
): Record<Id, WorldEntity> | null {
  const existing = snapshot.entities[agentId];
  if (existing === undefined) return null;
  const next: WorldEntity = {
    ...existing,
    domainState: state,
    presentation: deriveEntityPresentation(
      { ...existing, domainState: state },
      snapshot,
      deps,
    ),
  };
  if (lastHeartbeatAt !== undefined) next.lastHeartbeatAt = lastHeartbeatAt;
  return { ...snapshot.entities, [agentId]: next };
}

/**
 * Ensure a {@link WorldObject} exists for a referenced taskId, applying a status.
 * Status precedence reflects the most specific signal seen: an explicit
 * `blocked`/`done` overrides the generic `working`, but never downgrades a more
 * definitive prior status back to `working`.
 */
function withTaskObject(
  snapshot: WorldSnapshot,
  taskId: Id,
  status: TaskStatus,
  ownerEntityId: Id | undefined,
  deps: ReducerDeps,
): Record<Id, WorldObject> {
  const existing = snapshot.objects[taskId];
  const resolvedStatus = resolveTaskStatus(existing?.status, status);
  const base: WorldObject = existing ?? {
    id: taskId,
    kind: "task",
    status: resolvedStatus,
    presentation: { position: { x: 0, y: 0 } },
  };
  const candidate: WorldObject = {
    ...base,
    status: resolvedStatus,
  };
  if (ownerEntityId !== undefined) candidate.ownerEntityId = ownerEntityId;
  // Position is deterministic (id-seeded); recompute so it is stable on replay.
  const positioned: WorldObject = {
    ...candidate,
    presentation: { position: deps.layout.placeObject(candidate, snapshot) },
  };
  return { ...snapshot.objects, [taskId]: positioned };
}

/**
 * Combine a prior task status with an incoming one. `working` is the baseline;
 * `blocked` and `done` are definitive and win over `working`. `done` is terminal
 * and is never overwritten. `blocked` yields to a later `done`.
 */
function resolveTaskStatus(
  prior: TaskStatus | undefined,
  incoming: TaskStatus,
): TaskStatus {
  if (prior === undefined) return incoming;
  if (prior === "done") return "done";
  if (incoming === "done") return "done";
  if (incoming === "blocked") return "blocked";
  if (prior === "blocked") return "blocked";
  return incoming;
}

/**
 * Set an effect by deterministic id. If one with that id already exists it is
 * replaced IN PLACE (same array position) so re-folding the same log yields a
 * deeply-equal array; otherwise the effect is appended.
 */
function setEffect(
  effects: readonly WorldEffect[],
  effect: WorldEffect,
): WorldEffect[] {
  const index = effects.findIndex((e) => e.id === effect.id);
  if (index === -1) return [...effects, effect];
  const next = effects.slice();
  next[index] = effect;
  return next;
}

/** Remove effects by predicate, returning a new array. */
function removeEffects(
  effects: readonly WorldEffect[],
  predicate: (effect: WorldEffect) => boolean,
): WorldEffect[] {
  return effects.filter((e) => !predicate(e));
}

/**
 * Set a link by deterministic id. Replaces in place (preserving position) when
 * the id exists, else appends — so re-folding the same log is deeply equal.
 */
function setLink(links: readonly WorldLink[], link: WorldLink): WorldLink[] {
  const index = links.findIndex((l) => l.id === link.id);
  if (index === -1) return [...links, link];
  const next = links.slice();
  next[index] = link;
  return next;
}

/** Set or clear a badge on an entity, returning a new entities map (or null). */
function setEntityBadge(
  snapshot: WorldSnapshot,
  agentId: Id,
  badge: EntityBadge | undefined,
): Record<Id, WorldEntity> | null {
  const existing = snapshot.entities[agentId];
  if (existing === undefined) return null;
  const presentation: WorldEntity["presentation"] = {
    animation: existing.presentation.animation,
    position: existing.presentation.position,
  };
  if (existing.presentation.intent !== undefined) {
    presentation.intent = existing.presentation.intent;
  }
  if (badge !== undefined) presentation.badge = badge;
  const next: WorldEntity = { ...existing, presentation };
  return { ...snapshot.entities, [agentId]: next };
}

/** Resolve the ttlMs for an effect from the skin's event-effect table. */
function ttlFor(skin: SkinMap, type: RoomEventType): number | undefined {
  return skin.eventEffects[type]?.ttlMs;
}

/** Advance clock.lastEventAt to the max createdAt seen. Cursor is left to the source. */
function advanceClock(
  clock: WorldSnapshot["clock"],
  createdAt: ISODateTime,
): WorldSnapshot["clock"] {
  if (clock.lastEventAt === null || createdAt > clock.lastEventAt) {
    return { cursor: clock.cursor, lastEventAt: createdAt };
  }
  return clock;
}

// ---------------------------------------------------------------------------
// The reducer.
// ---------------------------------------------------------------------------

/**
 * Apply one {@link RoomEvent} to the snapshot, returning a NEW snapshot. Pure and
 * immutable; the input is never mutated. Unknown/non-spatial events advance only
 * the clock.
 */
export function reduceEvent(
  snapshot: WorldSnapshot,
  event: RoomEvent,
  deps: ReducerDeps,
): WorldSnapshot {
  const clock = advanceClock(snapshot.clock, event.createdAt);

  switch (event.type) {
    case "workspace.registered": {
      const ws = event.payload.workspace;
      const room: WorldRoom = {
        id: ws.id,
        kind: "workspace",
        label: ws.label,
        presentation: { bounds: { x: 0, y: 0, w: 0, h: 0 } },
      };
      const bounds = deps.layout.roomBounds(room, snapshot);
      const placed: WorldRoom = { ...room, presentation: { bounds } };
      return {
        ...snapshot,
        rooms: { ...snapshot.rooms, [placed.id]: placed },
        clock,
      };
    }

    case "workspace.updated": {
      const { workspaceId, label } = event.payload;
      const existing = snapshot.rooms[workspaceId];
      const room: WorldRoom = existing ?? {
        id: workspaceId,
        kind: "workspace",
        label: label ?? workspaceId,
        presentation: { bounds: { x: 0, y: 0, w: 0, h: 0 } },
      };
      const merged: WorldRoom = {
        ...room,
        label: label ?? room.label,
      };
      const bounds = deps.layout.roomBounds(merged, snapshot);
      const placed: WorldRoom = { ...merged, presentation: { bounds } };
      return {
        ...snapshot,
        rooms: { ...snapshot.rooms, [placed.id]: placed },
        clock,
      };
    }

    case "agent.joined": {
      const agent = event.payload.agent;
      const base: WorldEntity = {
        id: agent.id,
        kind: "agent",
        role: agent.role,
        domainState: agent.state,
        presentation: { animation: "idle", position: { x: 0, y: 0 } },
      };
      const entity: WorldEntity = {
        ...base,
        presentation: deriveEntityPresentation(base, snapshot, deps),
      };
      return { ...snapshot, entities: withEntity(snapshot, entity), clock };
    }

    case "agent.left": {
      const { [event.payload.agentId]: _removed, ...rest } = snapshot.entities;
      return { ...snapshot, entities: rest, clock };
    }

    case "agent.heartbeat": {
      const entities = updateEntityState(
        snapshot,
        event.payload.agentId,
        event.payload.state,
        deps,
        event.createdAt,
      );
      if (entities === null) return { ...snapshot, clock };
      return { ...snapshot, entities, clock };
    }

    case "runtime.state_observed": {
      const entities = updateEntityState(
        snapshot,
        event.payload.agentId,
        event.payload.state,
        deps,
      );
      if (entities === null) return { ...snapshot, clock };
      return { ...snapshot, entities, clock };
    }

    case "agent.finished": {
      const entities = updateEntityState(
        snapshot,
        event.payload.agentId,
        event.payload.state,
        deps,
      );
      const objects =
        event.payload.taskId !== undefined
          ? withTaskObject(
              snapshot,
              event.payload.taskId,
              event.payload.state === "done" ? "done" : "blocked",
              event.payload.agentId,
              deps,
            )
          : snapshot.objects;
      return {
        ...snapshot,
        entities: entities ?? snapshot.entities,
        objects,
        clock,
      };
    }

    case "agent.blocked": {
      const entities = updateEntityState(
        snapshot,
        event.payload.agentId,
        "blocked",
        deps,
      );
      const objects =
        event.payload.taskId !== undefined
          ? withTaskObject(
              snapshot,
              event.payload.taskId,
              "blocked",
              event.payload.agentId,
              deps,
            )
          : snapshot.objects;
      return {
        ...snapshot,
        entities: entities ?? snapshot.entities,
        objects,
        clock,
      };
    }

    case "agent.done": {
      const entities = updateEntityState(
        snapshot,
        event.payload.agentId,
        "done",
        deps,
      );
      const objects =
        event.payload.taskId !== undefined
          ? withTaskObject(
              snapshot,
              event.payload.taskId,
              "done",
              event.payload.agentId,
              deps,
            )
          : snapshot.objects;
      return {
        ...snapshot,
        entities: entities ?? snapshot.entities,
        objects,
        clock,
      };
    }

    case "handoff.created": {
      const { taskId, fromAgentId, toAgentId, summary } = event.payload;
      // The task object exists if either party referenced it; owner is the receiver.
      const objects = withTaskObject(
        snapshot,
        taskId,
        "working",
        toAgentId,
        deps,
      );
      const link: WorldLink = {
        id: linkId(event),
        kind: "handoff",
        fromEntityId: fromAgentId,
        toEntityId: toAgentId,
        label: summary,
        createdAt: event.createdAt,
      };
      const links = setLink(snapshot.links, link);
      // A transient carried-item effect anchored to the giver.
      const effect: WorldEffect = {
        id: effectId(event, "carry"),
        kind: "carry-item",
        entityId: fromAgentId,
        sourceEventType: event.type,
        createdAt: event.createdAt,
      };
      const ttl = ttlFor(deps.skin, event.type);
      if (ttl !== undefined) effect.ttlMs = ttl;
      const effects = setEffect(snapshot.effects, effect);
      return { ...snapshot, objects, links, effects, clock };
    }

    case "message.posted": {
      const msg = event.payload.message;
      const effect: WorldEffect = {
        id: effectId(event, "bubble"),
        kind: "speech-bubble",
        entityId: msg.sender.id,
        text: msg.body,
        importance: msg.importance,
        sourceEventType: event.type,
        createdAt: event.createdAt,
      };
      const ttl = ttlFor(deps.skin, event.type);
      if (ttl !== undefined) effect.ttlMs = ttl;
      const effects = setEffect(snapshot.effects, effect);
      const link = messageLink(event, msg.importance, msg.recipients?.[0]?.id);
      const links =
        link === null ? snapshot.links : setLink(snapshot.links, link);
      return { ...snapshot, effects, links, clock };
    }

    case "human_escalation.created": {
      const esc = event.payload.escalation;
      const fromId = esc.from.id;
      const entities = setEntityBadge(snapshot, fromId, "needs-human");
      // Keyed by escalation id (not event id) so the answered event clears the
      // exact same effect — deterministic, idempotent pairing.
      const effect: WorldEffect = {
        id: escalationEffectId(esc.id),
        kind: "alert",
        entityId: fromId,
        text: esc.question,
        importance: esc.priority,
        sourceEventType: event.type,
        createdAt: event.createdAt,
      };
      const ttl = ttlFor(deps.skin, event.type);
      if (ttl !== undefined) effect.ttlMs = ttl;
      const effects = setEffect(snapshot.effects, effect);
      return {
        ...snapshot,
        entities: entities ?? snapshot.entities,
        effects,
        clock,
      };
    }

    case "human_escalation.answered": {
      // Clear the escalation-keyed alert effect and the needs-human badge on the
      // entity it was anchored to. The answered event carries only the escalation
      // id; we recover the affected entity from the matching effect — no
      // fabricated correlation, and clearing is idempotent (a re-applied answer
      // simply finds nothing left to clear).
      const targetId = escalationEffectId(event.payload.escalationId);
      const flagged = snapshot.effects.find((e) => e.id === targetId);
      const effects = removeEffects(snapshot.effects, (e) => e.id === targetId);
      const entities =
        flagged !== undefined
          ? setEntityBadge(snapshot, flagged.entityId, undefined)
          : null;
      return {
        ...snapshot,
        entities: entities ?? snapshot.entities,
        effects,
        clock,
      };
    }

    case "approval.requested": {
      const approval = event.payload.approval;
      const requesterId = approval.requestedBy.id;
      // Keyed by approval id so granted/denied clears the exact same effect.
      const effect: WorldEffect = {
        id: approvalEffectId(approval.id),
        kind: "alert",
        entityId: requesterId,
        text: approval.reason,
        importance: importanceForRisk(approval.risk),
        sourceEventType: event.type,
        createdAt: event.createdAt,
      };
      const ttl = ttlFor(deps.skin, event.type);
      if (ttl !== undefined) effect.ttlMs = ttl;
      const effects = setEffect(snapshot.effects, effect);
      return { ...snapshot, effects, clock };
    }

    case "approval.granted":
    case "approval.denied": {
      // Clear the alert effect spawned by the matching approval.requested event,
      // keyed by the shared approval id. Idempotent on replay.
      const targetId = approvalEffectId(event.payload.approvalId);
      const effects = removeEffects(snapshot.effects, (e) => e.id === targetId);
      return { ...snapshot, effects, clock };
    }

    // Non-spatial / unmapped events: advance the clock only. (`thread.created`
    // and `reaction.added` appear in RoomEventType but carry no payload variant
    // in the RoomEvent union, so they never reach this reducer and need no case.)
    case "runtime.bound":
    case "runtime.output_observed":
    case "runtime.input_sent":
    case "chat.inbound_received":
    case "chat.outbound_sent":
    case "tracker.ref_event":
    case "tracker.event":
    case "agent.report":
    case "decision.recorded":
      return { ...snapshot, clock };

    default:
      return assertExhaustive(event, snapshot, clock);
  }
}

/**
 * Build the message link, if the message is directed at a recipient. Undirected
 * (channel) messages produce no link.
 */
function messageLink(
  event: RoomEvent & { type: "message.posted" },
  importance: Importance,
  recipientId: Id | undefined,
): WorldLink | null {
  if (recipientId === undefined) return null;
  return {
    id: linkId(event),
    kind: "message",
    fromEntityId: event.payload.message.sender.id,
    toEntityId: recipientId,
    importance,
    createdAt: event.createdAt,
  };
}

/** Map an approval's risk level to the bubble importance used for its alert. */
function importanceForRisk(risk: "low" | "medium" | "high"): Importance {
  if (risk === "high") return "urgent";
  if (risk === "medium") return "high";
  return "normal";
}

/** Compile-time exhaustiveness guard; runtime-safe (advances clock only). */
function assertExhaustive(
  _event: never,
  snapshot: WorldSnapshot,
  clock: WorldSnapshot["clock"],
): WorldSnapshot {
  return { ...snapshot, clock };
}

/**
 * Fold an entire event log into a world snapshot from the empty start state.
 * `buildWorld(log) deep-equals buildWorld([...log, ...log])`-style idempotency
 * holds because every effect/link is keyed by source event id.
 */
export function buildWorld(
  events: readonly RoomEvent[],
  deps: ReducerDeps,
): WorldSnapshot {
  let snapshot = createEmptyWorldSnapshot();
  for (const event of events) {
    snapshot = reduceEvent(snapshot, event, deps);
  }
  return snapshot;
}
