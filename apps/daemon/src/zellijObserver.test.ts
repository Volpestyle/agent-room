import { describe, expect, it } from "vitest";
import {
  AgentRoomService,
  type AdoptAgentRequest,
  type AgentOutput,
  type EventBatch,
  type EventCursor,
  type EventCursorPosition,
  type EventStore,
  type ReadAgentRequest,
  type RoomEvent,
  type RuntimeAgent,
  type RuntimeCapabilities,
  type RuntimeHealth,
  type RuntimeProvider,
  type RuntimeSession,
  type SendInputRequest,
  type StartAgentRequest,
} from "@agentroom/core";
import { ZellijPaneObserver } from "./zellijObserver.js";

describe("ZellijPaneObserver", () => {
  it("adopts AgentRoom-marked Zellij panes when it starts", async () => {
    const store = new TestEventStore();
    const service = new AgentRoomService(store, { roomId: "room" });
    const provider = new TestZellijRuntimeProvider([
      {
        id: "demo",
        bindingId: "terminal_7",
        displayName: "demo",
        state: "online",
        sessionId: "agent-room",
        metadata: {
          agentRoomAgentId: "demo",
          title: "agentroom:demo",
          tabId: "1",
        },
      },
      {
        id: "terminal_8",
        bindingId: "terminal_8",
        displayName: "shell",
        state: "online",
        sessionId: "agent-room",
        metadata: { title: "shell" },
      },
    ]);

    const observer = new ZellijPaneObserver({
      session: "agent-room",
      service,
      provider,
      roomId: "room",
      autoActivate: false,
    });

    await observer.start();

    await expect(service.getAgent("demo")).resolves.toEqual(
      expect.objectContaining({
        id: "demo",
        state: "online",
        runtime: expect.objectContaining({
          providerId: "test-zellij",
          bindingId: "terminal_7",
          kind: "pane",
        }),
      }),
    );
    await expect(
      service.findAgentByBinding("terminal_8"),
    ).resolves.toBeUndefined();

    await observer.stop();
  });
});

class TestZellijRuntimeProvider implements RuntimeProvider {
  readonly id = "test-zellij";
  readonly kind = "zellij" as const;
  readonly capabilities: RuntimeCapabilities = {
    startAgent: false,
    stopAgent: false,
    readOutput: false,
    sendInput: false,
    attachInteractive: false,
    subscribeEvents: false,
    semanticAgentState: false,
    screenshots: false,
    fileMounts: false,
    worktrees: false,
    remoteExecution: false,
    adoptAgent: true,
  };

  constructor(private readonly agents: RuntimeAgent[]) {}

  async health(): Promise<RuntimeHealth> {
    return { ok: true, status: "ok" };
  }

  async listSessions(): Promise<RuntimeSession[]> {
    return [{ id: "agent-room" }];
  }

  async listAgents(): Promise<RuntimeAgent[]> {
    return this.agents;
  }

  async startAgent(_request: StartAgentRequest): Promise<RuntimeAgent> {
    throw new Error("not implemented");
  }

  async adoptAgent(request: AdoptAgentRequest): Promise<RuntimeAgent> {
    const agent = this.agents.find(
      (candidate) => candidate.bindingId === request.bindingId,
    );
    if (!agent) throw new Error(`not found: ${request.bindingId}`);
    return {
      ...agent,
      id: request.agentId,
      ...(request.displayName !== undefined
        ? { displayName: request.displayName }
        : agent.displayName !== undefined
          ? { displayName: agent.displayName }
          : {}),
      metadata: {
        ...(agent.metadata ?? {}),
        adopted: true,
      },
    };
  }

  async stopAgent(_agentId: string): Promise<void> {
    throw new Error("not implemented");
  }

  async readAgent(_request: ReadAgentRequest): Promise<AgentOutput> {
    throw new Error("not implemented");
  }

  async sendInput(_request: SendInputRequest): Promise<void> {
    throw new Error("not implemented");
  }
}

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
