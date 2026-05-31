import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  AgentRoomService,
  type EventBatch,
  type EventCursor,
  type EventCursorPosition,
  type EventStore,
  type RoomEvent,
} from "@agentroom/core";
import { FakeRuntimeProvider } from "@agentroom/runtime-fake";
import type { DuplexLike } from "@agentroom/runtime-herdr";
import { HerdrPaneObserver, deriveAgentId } from "./herdrObserver.js";

describe("HerdrPaneObserver", () => {
  it("adopts panes that already exist when the observer starts", async () => {
    const { socket, factory } = createMockSocket();
    const store = new TestEventStore();
    const service = new AgentRoomService(store, { roomId: "room" });
    const provider = new FakeRuntimeProvider({ id: "test-herdr" });
    await provider.adoptAgent({
      agentId: "p_existing",
      bindingId: "p_existing",
      roomId: "room",
      role: "implementer",
      displayName: "claude",
      metadata: { agent: "claude" },
    });

    const observer = new HerdrPaneObserver({
      socketPath: "ignored",
      session: "agent-room",
      service,
      provider,
      roomId: "room",
      reconnectDelayMs: 5000,
      socketFactory: factory,
    });

    const startPromise = observer.start();
    await flush();
    socket.ackLastSubscribeRequest();
    await startPromise;

    const expectedAgentId = deriveAgentId("agent-room", "p_existing");
    expect(
      store.events.filter(
        (event) =>
          event.type === "agent.joined" &&
          event.payload.agent.id === expectedAgentId,
      ),
    ).toHaveLength(1);
    expect(
      store.events.filter(
        (event) =>
          event.type === "runtime.bound" &&
          event.payload.agentId === expectedAgentId,
      ),
    ).toHaveLength(1);

    await observer.stop();
  });

  it("still adopts existing panes when the push subscription fails", async () => {
    const store = new TestEventStore();
    const service = new AgentRoomService(store, { roomId: "room" });
    const provider = new FakeRuntimeProvider({ id: "test-herdr" });
    await provider.adoptAgent({
      agentId: "p_existing",
      bindingId: "p_existing",
      roomId: "room",
      role: "implementer",
      displayName: "claude",
      metadata: { agent: "claude" },
    });

    // Push socket cannot connect (e.g. wrong/missing socket path). Enrollment
    // must still happen via the provider CLI rather than aborting.
    const failingFactory: (
      socketPath: string,
    ) => Promise<DuplexLike> = async () => {
      throw new Error("connect ENOENT herdr.sock");
    };

    const observer = new HerdrPaneObserver({
      socketPath: "ignored",
      session: "agent-room",
      service,
      provider,
      roomId: "room",
      reconnectDelayMs: 5000,
      socketFactory: failingFactory,
    });

    await observer.start();

    const expectedAgentId = deriveAgentId("agent-room", "p_existing");
    expect(
      store.events.filter(
        (event) =>
          event.type === "agent.joined" &&
          event.payload.agent.id === expectedAgentId,
      ),
    ).toHaveLength(1);

    await observer.stop();
  });

  it("adopts a pane on pane_created and is idempotent", async () => {
    const { socket, factory } = createMockSocket();
    const store = new TestEventStore();
    const service = new AgentRoomService(store, { roomId: "room" });
    const provider = new FakeRuntimeProvider({ id: "test-herdr" });

    const observer = new HerdrPaneObserver({
      socketPath: "ignored",
      session: "agent-room",
      service,
      provider,
      roomId: "room",
      reconnectDelayMs: 5000,
      socketFactory: factory,
    });

    const startPromise = observer.start();
    await flush();
    socket.ackLastSubscribeRequest();
    await startPromise;

    socket.deliverEvent("pane_created", {
      pane: {
        pane_id: "p_42",
        workspace_id: "w1",
        tab_id: "w1:1",
        agent: "claude",
        agent_status: "working",
      },
    });
    await flush();
    await flush();

    const expectedAgentId = deriveAgentId("agent-room", "p_42");
    const joined = store.events.filter(
      (event) =>
        event.type === "agent.joined" &&
        event.payload.agent.id === expectedAgentId,
    );
    const bound = store.events.filter(
      (event) =>
        event.type === "runtime.bound" &&
        event.payload.agentId === expectedAgentId,
    );
    expect(joined).toHaveLength(1);
    expect(bound).toHaveLength(1);
    const boundEvent = bound[0];
    if (!boundEvent || boundEvent.type !== "runtime.bound") {
      throw new Error("expected a runtime.bound event");
    }
    expect(boundEvent.payload.runtime).toEqual(
      expect.objectContaining({
        providerId: "test-herdr",
        bindingId: "p_42",
      }),
    );
    // First adoption injects exactly one activation prompt into the pane.
    expect(
      store.events.filter(
        (event) =>
          event.type === "runtime.input_sent" &&
          event.payload.agentId === expectedAgentId,
      ),
    ).toHaveLength(1);

    socket.deliverEvent("pane_created", {
      pane: {
        pane_id: "p_42",
        workspace_id: "w1",
        tab_id: "w1:1",
        agent: "claude",
      },
    });
    await flush();
    await flush();

    expect(
      store.events.filter(
        (event) =>
          event.type === "agent.joined" &&
          event.payload.agent.id === expectedAgentId,
      ),
    ).toHaveLength(1);
    // Re-adoption of the same pane must not re-prompt a running agent.
    expect(
      store.events.filter(
        (event) =>
          event.type === "runtime.input_sent" &&
          event.payload.agentId === expectedAgentId,
      ),
    ).toHaveLength(1);
    expect(
      store.events.filter(
        (event) =>
          event.type === "runtime.bound" &&
          event.payload.agentId === expectedAgentId,
      ),
    ).toHaveLength(1);

    await observer.stop();
  });

  it("does not enroll panes until Herdr reports an agent", async () => {
    const { socket, factory } = createMockSocket();
    const store = new TestEventStore();
    const service = new AgentRoomService(store, { roomId: "room" });
    const provider = new FakeRuntimeProvider({ id: "test-herdr" });

    const observer = new HerdrPaneObserver({
      socketPath: "ignored",
      session: "agent-room",
      service,
      provider,
      roomId: "room",
      reconnectDelayMs: 5000,
      socketFactory: factory,
    });

    const startPromise = observer.start();
    await flush();
    socket.ackLastSubscribeRequest();
    await startPromise;

    socket.deliverEvent("pane_created", {
      pane: { pane_id: "p_shell", workspace_id: "w1", tab_id: "w1:1" },
    });
    await flush();
    await flush();

    expect(store.events).toHaveLength(0);

    socket.deliverEvent("pane_agent_detected", {
      pane_id: "p_shell",
      workspace_id: "w1",
      tab_id: "w1:1",
      agent: "codex",
    });
    await flush();
    await flush();

    const expectedAgentId = deriveAgentId("agent-room", "p_shell");
    expect(
      store.events.filter(
        (event) =>
          event.type === "agent.joined" &&
          event.payload.agent.id === expectedAgentId,
      ),
    ).toHaveLength(1);

    await observer.stop();
  });

  it("marks stale auto-adopted panes stopped when they no longer report an agent", async () => {
    const { socket, factory } = createMockSocket();
    const store = new TestEventStore();
    const service = new AgentRoomService(store, { roomId: "room" });
    const provider = new FakeRuntimeProvider({ id: "test-herdr" });
    const staleAgentId = deriveAgentId("agent-room", "p_logs");

    await service.registerAgent({
      id: staleAgentId,
      role: "implementer",
      displayName: "p_logs",
    });
    await service.bindRuntime({
      agentId: staleAgentId,
      runtime: {
        providerId: "test-herdr",
        bindingId: "p_logs",
        kind: "pane",
        metadata: { adopted: true },
      },
    });
    await provider.adoptAgent({
      agentId: staleAgentId,
      bindingId: "p_logs",
      roomId: "room",
      role: "implementer",
    });

    const observer = new HerdrPaneObserver({
      socketPath: "ignored",
      session: "agent-room",
      service,
      provider,
      roomId: "room",
      reconnectDelayMs: 5000,
      socketFactory: factory,
    });

    const startPromise = observer.start();
    await flush();
    socket.ackLastSubscribeRequest();
    await startPromise;

    await expect(service.getAgent(staleAgentId)).resolves.toEqual(
      expect.objectContaining({ state: "stopped" }),
    );
    expect(
      store.events.filter(
        (event) =>
          event.type === "agent.left" && event.payload.agentId === staleAgentId,
      ),
    ).toHaveLength(1);

    await observer.stop();
  });
});

class TestEventStore implements EventStore {
  readonly events: RoomEvent[] = [];

  async append(event: RoomEvent): Promise<void> {
    this.events.push(event);
  }

  async appendMany(events: RoomEvent[]): Promise<void> {
    this.events.push(...events);
  }

  async cursor(position?: EventCursorPosition): Promise<EventCursor> {
    return {
      position: position === "start" ? 0 : this.events.length,
    };
  }

  async listFromCursor(cursor: EventCursor): Promise<EventBatch> {
    const events = this.events.slice(cursor.position);
    return { events, cursor: { position: this.events.length } };
  }

  async list(): Promise<RoomEvent[]> {
    return [...this.events];
  }
}

interface MockSocket extends EventEmitter {
  write(chunk: string): boolean;
  end(): void;
  ackLastSubscribeRequest(): void;
  deliverEvent(name: string, data: Record<string, unknown>): void;
}

function createMockSocket(): {
  socket: MockSocket;
  factory: (socketPath: string) => Promise<DuplexLike>;
} {
  const written: string[] = [];
  const emitter = new EventEmitter();
  const socket: MockSocket = Object.assign(emitter, {
    write(chunk: string): boolean {
      written.push(chunk);
      return true;
    },
    end(): void {
      emitter.emit("close");
    },
    ackLastSubscribeRequest(): void {
      const last = written[written.length - 1];
      if (!last) throw new Error("no socket write to ack");
      const parsed = JSON.parse(last) as { id: string };
      emitter.emit(
        "data",
        `${JSON.stringify({
          id: parsed.id,
          result: { type: "subscription_started" },
        })}\n`,
      );
    },
    deliverEvent(name: string, data: Record<string, unknown>): void {
      emitter.emit("data", `${JSON.stringify({ event: name, data })}\n`);
    },
  });
  const factory: (socketPath: string) => Promise<DuplexLike> = async () =>
    socket as unknown as DuplexLike;
  return { socket, factory };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
