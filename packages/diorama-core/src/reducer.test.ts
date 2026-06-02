/**
 * Reducer invariant test (Diorama Phase 0, F4).
 *
 * Per `dev/AGENTS.md` testing philosophy this is the ONE reducer test worth
 * keeping: it pins the two cross-cutting invariants the whole bridge relies on —
 *
 *  1. DETERMINISM: building the same event log twice yields a deeply-equal world
 *     (no randomness, no wall-clock leakage into presentation).
 *  2. IDEMPOTENT ON REPLAY: re-folding the SAME log appended to itself yields a
 *     deeply-equal world — effects/links/entities/objects are keyed
 *     deterministically and replaced in place, never duplicated.
 *
 * Along the way it asserts the externally meaningful derivations: a workspace
 * becomes a room, an agent becomes a positioned+animated entity, a heartbeat
 * updates domain state + animation, a handoff spawns a link + carry effect + a
 * task object, a message spawns a speech bubble, an escalation raises then clears
 * a needs-human badge + alert, and a done agent celebrates with a done task.
 *
 * These are stable public behaviors of the World Protocol, not implementation
 * details, so the test stays valuable as the internals evolve. No `any`, no
 * fabricated data — every event is a real, correctly-typed `RoomEvent`.
 */

import { describe, it, expect } from "vitest";
import type {
  ActorRef,
  Agent,
  HumanEscalation,
  Message,
  RoomEvent,
  Workspace,
} from "@agentroom/core";
import { buildWorld, reduceEvent } from "./reducer.js";
import type { ReducerDeps } from "./reducer.js";
import { createDeterministicLayout, defaultSkinMap } from "./defaults.js";
import { createEmptyWorldSnapshot } from "./protocol.js";

const deps: ReducerDeps = {
  layout: createDeterministicLayout(),
  skin: defaultSkinMap,
};

// A fixed clock for the fixture — these are literals, never `Date.now()`, so the
// log is reproducible and presentation can never depend on the wall clock.
const ROOM_ID = "room-1";
const WS_ID = "ws-1";
const ALICE = "agent-alice";
const BOB = "agent-bob";
const TASK_ID = "task-42";
const ESC_ID = "esc-7";

function actor(id: string): ActorRef {
  return { kind: "agent", id };
}

function agent(id: string, role: Agent["role"], state: Agent["state"]): Agent {
  return {
    id,
    roomId: ROOM_ID,
    displayName: id,
    role,
    state,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function workspace(id: string, label: string): Workspace {
  return {
    id,
    roomId: ROOM_ID,
    cwd: `/work/${id}`,
    label,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
  };
}

function message(
  id: string,
  senderId: string,
  body: string,
  importance: Message["importance"],
): Message {
  return {
    id,
    roomId: ROOM_ID,
    sender: actor(senderId),
    kind: "chat",
    body,
    importance,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function escalation(
  id: string,
  fromId: string,
  question: string,
): HumanEscalation {
  return {
    id,
    roomId: ROOM_ID,
    from: actor(fromId),
    question,
    priority: "high",
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * A hand-written, correctly-typed log exercising every spatial reduction the
 * renderer cares about, in causal order. Timestamps are strictly increasing so
 * the clock advances monotonically.
 */
const events: readonly RoomEvent[] = [
  {
    id: "e1",
    roomId: ROOM_ID,
    type: "workspace.registered",
    payload: { workspace: workspace(WS_ID, "Backend") },
    createdAt: "2026-01-01T00:00:01.000Z",
  },
  {
    id: "e2",
    roomId: ROOM_ID,
    type: "agent.joined",
    payload: { agent: agent(ALICE, "implementer", "online") },
    createdAt: "2026-01-01T00:00:02.000Z",
  },
  {
    id: "e3",
    roomId: ROOM_ID,
    type: "agent.joined",
    payload: { agent: agent(BOB, "reviewer", "online") },
    createdAt: "2026-01-01T00:00:03.000Z",
  },
  {
    id: "e4",
    roomId: ROOM_ID,
    type: "agent.heartbeat",
    payload: { agentId: ALICE, state: "working" },
    createdAt: "2026-01-01T00:00:04.000Z",
  },
  {
    id: "e5",
    roomId: ROOM_ID,
    type: "handoff.created",
    payload: {
      taskId: TASK_ID,
      fromAgentId: ALICE,
      toAgentId: BOB,
      summary: "Please review the auth refactor",
    },
    createdAt: "2026-01-01T00:00:05.000Z",
  },
  {
    id: "e6",
    roomId: ROOM_ID,
    type: "message.posted",
    payload: { message: message("m1", ALICE, "Heads up, urgent", "urgent") },
    createdAt: "2026-01-01T00:00:06.000Z",
  },
  {
    id: "e7",
    roomId: ROOM_ID,
    type: "human_escalation.created",
    payload: {
      escalation: escalation(ESC_ID, BOB, "Need a decision on the API shape"),
    },
    createdAt: "2026-01-01T00:00:07.000Z",
  },
  {
    id: "e8",
    roomId: ROOM_ID,
    type: "human_escalation.answered",
    payload: { escalationId: ESC_ID, answer: "Go with option B" },
    createdAt: "2026-01-01T00:00:08.000Z",
  },
  {
    id: "e9",
    roomId: ROOM_ID,
    type: "agent.done",
    payload: {
      agentId: BOB,
      taskId: TASK_ID,
      summary: "Reviewed and approved",
    },
    createdAt: "2026-01-01T00:00:09.000Z",
  },
];

describe("reduceEvent / buildWorld", () => {
  it("derives a room from workspace.registered", () => {
    const world = buildWorld(events, deps);
    const room = world.rooms[WS_ID];
    expect(room).toBeDefined();
    expect(room.kind).toBe("workspace");
    expect(room.label).toBe("Backend");
    // Bounds are laid out by the deterministic strategy, not left at the seed.
    expect(room.presentation.bounds.w).toBeGreaterThan(0);
    expect(room.presentation.bounds.h).toBeGreaterThan(0);
  });

  it("derives a positioned, animated entity from agent.joined", () => {
    const world = buildWorld(events, deps);
    const alice = world.entities[ALICE];
    expect(alice).toBeDefined();
    expect(alice.kind).toBe("agent");
    expect(alice.role).toBe("implementer");
    // Position comes from the id-seeded layout; it equals a fresh placement.
    const expected = deps.layout.placeEntity(alice, world);
    expect(alice.presentation.position).toEqual(expected);
  });

  it("updates domainState + animation on agent.heartbeat", () => {
    const world = buildWorld(events, deps);
    const alice = world.entities[ALICE];
    expect(alice.domainState).toBe("working");
    // working -> typing per the default skin's stateAnimations.
    expect(alice.presentation.animation).toBe(
      defaultSkinMap.stateAnimations.working,
    );
    // Heartbeat stamps lastHeartbeatAt from the event.
    expect(alice.lastHeartbeatAt).toBe("2026-01-01T00:00:04.000Z");
  });

  it("spawns a link, a carry effect, and a task object on handoff.created", () => {
    const world = buildWorld(events, deps);

    const link = world.links.find((l) => l.kind === "handoff");
    expect(link).toBeDefined();
    expect(link?.fromEntityId).toBe(ALICE);
    expect(link?.toEntityId).toBe(BOB);

    const carry = world.effects.find((e) => e.kind === "carry-item");
    expect(carry).toBeDefined();
    expect(carry?.entityId).toBe(ALICE);

    const task = world.objects[TASK_ID];
    expect(task).toBeDefined();
    expect(task.kind).toBe("task");
    // Receiver of the handoff owns the desk.
    expect(task.ownerEntityId).toBe(BOB);
  });

  it("spawns a speech-bubble effect on message.posted", () => {
    const world = buildWorld(events, deps);
    const bubble = world.effects.find((e) => e.kind === "speech-bubble");
    expect(bubble).toBeDefined();
    expect(bubble?.entityId).toBe(ALICE);
    expect(bubble?.text).toBe("Heads up, urgent");
    expect(bubble?.importance).toBe("urgent");
  });

  it("raises a needs-human badge + alert on escalation, then clears both on answer", () => {
    // Mid-log state: after the escalation is created but before it is answered.
    // Assert through the public snapshot surface (the alert anchored to Bob),
    // not the reducer's internal effect-id scheme.
    const open = buildWorld(events.slice(0, 7), deps);
    const bobOpen = open.entities[BOB];
    expect(bobOpen.presentation.badge).toBe("needs-human");
    const alert = open.effects.find(
      (e) => e.kind === "alert" && e.entityId === BOB,
    );
    expect(alert).toBeDefined();
    expect(alert?.sourceEventType).toBe("human_escalation.created");

    // Final state: the answer clears the badge and removes the alert effect.
    const answered = buildWorld(events, deps);
    expect(
      answered.effects.find((e) => e.kind === "alert" && e.entityId === BOB),
    ).toBeUndefined();
    // Bob then goes done, so his badge must not be needs-human anymore.
    expect(answered.entities[BOB].presentation.badge).toBeUndefined();
  });

  it("celebrates and marks the task done on agent.done", () => {
    const world = buildWorld(events, deps);
    const bob = world.entities[BOB];
    expect(bob.domainState).toBe("done");
    // done -> celebrate per the default skin.
    expect(bob.presentation.animation).toBe(
      defaultSkinMap.stateAnimations.done,
    );
    const task = world.objects[TASK_ID];
    // The task started "working" (handoff) and was driven to "done".
    expect(task.status).toBe("done");
  });

  it("does not mutate the input snapshot (pure reducer)", () => {
    const empty = createEmptyWorldSnapshot();
    const before = JSON.stringify(empty);
    reduceEvent(empty, events[0], deps);
    expect(JSON.stringify(empty)).toBe(before);
  });

  it("is deterministic: two builds of the same log are deeply equal", () => {
    const a = buildWorld(events, deps);
    const b = buildWorld(events, deps);
    expect(a).toEqual(b);
  });

  it("is idempotent on replay: log === log ++ log (no duplicate effects/links/entities/objects)", () => {
    const once = buildWorld(events, deps);
    const twice = buildWorld([...events, ...events], deps);
    expect(twice).toEqual(once);
  });
});
