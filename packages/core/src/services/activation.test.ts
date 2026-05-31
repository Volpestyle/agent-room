import { describe, expect, it } from "vitest";
import type {
  AgentOutput,
  EventBatch,
  EventCursor,
  EventCursorPosition,
  EventStore,
  ReadAgentRequest,
  RoomEvent,
  RuntimeAgent,
  RuntimeCapabilities,
  RuntimeHealth,
  RuntimeProvider,
  RuntimeSession,
  SendInputRequest,
  StartAgentRequest,
} from "../index.js";
import { nowIso } from "../index.js";
import { AgentRoomService } from "./AgentRoomService.js";
import { activateAgent, buildAgentActivationPrompt } from "./activation.js";

class TestStore implements EventStore {
  readonly events: RoomEvent[] = [];
  async append(event: RoomEvent) {
    this.events.push(event);
  }
  async appendMany(events: RoomEvent[]) {
    this.events.push(...events);
  }
  async cursor(position: EventCursorPosition = "end"): Promise<EventCursor> {
    return { position: position === "start" ? 0 : this.events.length };
  }
  async listFromCursor(cursor: EventCursor): Promise<EventBatch> {
    const start = Math.max(0, Math.min(cursor.position, this.events.length));
    return {
      events: this.events.slice(start),
      cursor: { position: this.events.length },
    };
  }
  async list() {
    return this.events;
  }
}

class RecordingProvider implements RuntimeProvider {
  readonly id = "fake-runtime";
  readonly kind = "fake" as const;
  readonly inputs: SendInputRequest[] = [];
  constructor(readonly capabilities: RuntimeCapabilities = baseCapabilities()) {}

  async health(): Promise<RuntimeHealth> {
    return { ok: true, status: "ok" };
  }
  async listSessions(): Promise<RuntimeSession[]> {
    return [];
  }
  async listAgents(): Promise<RuntimeAgent[]> {
    return [];
  }
  async startAgent(_request: StartAgentRequest): Promise<RuntimeAgent> {
    throw new Error("not implemented");
  }
  async stopAgent(_agentId: string): Promise<void> {}
  async readAgent(request: ReadAgentRequest): Promise<AgentOutput> {
    return { agentId: request.agentId, text: "", observedAt: nowIso() };
  }
  async sendInput(request: SendInputRequest): Promise<void> {
    this.inputs.push(request);
  }
}

function baseCapabilities(sendInput = true): RuntimeCapabilities {
  return {
    startAgent: false,
    stopAgent: false,
    readOutput: false,
    sendInput,
    attachInteractive: false,
    subscribeEvents: false,
    semanticAgentState: false,
    screenshots: false,
    fileMounts: false,
    worktrees: false,
    remoteExecution: false,
    adoptAgent: false,
  };
}

describe("buildAgentActivationPrompt", () => {
  it("names the agent + room and instructs the agent to load the room skill", () => {
    const prompt = buildAgentActivationPrompt({
      agentId: "herdr:agent-room:p1",
      roomId: "agent-room",
      role: "implementer",
    });
    expect(prompt).toContain('room "agent-room"');
    expect(prompt).toContain('agent "herdr:agent-room:p1"');
    expect(prompt).toContain("agentroom` skill");
    expect(prompt).toContain("agent-room whoami");
  });

  it("is a single line so it auto-submits instead of sticking as a multi-line draft", () => {
    const prompt = buildAgentActivationPrompt({
      agentId: "a1",
      roomId: "agent-room",
      role: "implementer",
      protocolPath: "/x/.agentroom/AGENTS.md",
    });
    expect(prompt).not.toContain("\n");
  });
});

describe("activateAgent", () => {
  it("sends the prompt to the bound pane once and records an audited input event", async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: "agent-room" });
    const provider = new RecordingProvider();

    const result = await activateAgent(provider, service, {
      agentId: "herdr:agent-room:p1",
      roomId: "agent-room",
      bindingId: "p1",
      role: "implementer",
      agentKind: "claude-code",
    });

    expect(provider.inputs).toHaveLength(1);
    expect(provider.inputs[0]).toMatchObject({
      agentId: "herdr:agent-room:p1",
      bindingId: "p1",
      submit: true,
    });
    expect(result.text).toContain("agentroom` skill");
    expect(store.events.map((event) => event.type)).toContain(
      "runtime.input_sent",
    );
  });

  it("adds a trailing empty submit for codex panes (TUI does not auto-dispatch)", async () => {
    const provider = new RecordingProvider();
    await activateAgent(provider, undefined, {
      agentId: "herdr:agent-room:p2",
      roomId: "agent-room",
      bindingId: "p2",
      agentKind: "codex",
    });

    expect(provider.inputs).toHaveLength(2);
    expect(provider.inputs[1]).toMatchObject({ text: "", submit: true });
  });

  it("refuses to activate when the runtime cannot send input", async () => {
    const provider = new RecordingProvider(baseCapabilities(false));
    await expect(
      activateAgent(provider, undefined, {
        agentId: "a1",
        roomId: "agent-room",
      }),
    ).rejects.toThrow(/cannot send input/);
  });
});
