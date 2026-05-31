import { describe, expect, it } from "vitest";
import type { DashboardState } from "../state.js";
import type { RuntimeCapabilities } from "../types.js";
import { dashboardContext } from "./chat.js";

const runtimeCapabilities: RuntimeCapabilities = {
  startAgent: true,
  stopAgent: true,
  readOutput: true,
  sendInput: true,
  attachInteractive: true,
  subscribeEvents: false,
  semanticAgentState: true,
  screenshots: false,
  fileMounts: false,
  worktrees: true,
  remoteExecution: false,
  adoptAgent: true,
};

describe("dashboard chat context", () => {
  it("promotes Herdr pane labels into room-agent aliases", () => {
    const state: DashboardState = {
      health: {
        ok: true,
        pid: 123,
        roomId: "agent-room",
        cwd: "/repo",
        runtimes: [
          {
            id: "herdr",
            kind: "herdr",
            default: true,
            capabilities: runtimeCapabilities,
            health: { ok: true, status: "ok" },
          },
        ],
        chatGateways: [],
      },
      config: {
        roomId: "agent-room",
        cwd: "/repo",
        defaultRuntime: "herdr",
      },
      events: [],
      agents: [
        {
          id: "herdr:agent-room:w1-2",
          roomId: "agent-room",
          displayName: "claude",
          role: "implementer",
          state: "idle",
          runtime: {
            providerId: "herdr",
            bindingId: "w1-2",
            kind: "pane",
            metadata: { agent: "claude" },
          },
          createdAt: "2026-05-27T10:00:00.000Z",
          updatedAt: "2026-05-27T10:00:00.000Z",
        },
      ],
      messages: [],
      workspaces: [],
      providers: [
        {
          id: "herdr",
          kind: "herdr",
          default: true,
          capabilities: runtimeCapabilities,
        },
      ],
      runtimeAgents: [
        {
          providerId: "herdr",
          agent: {
            id: "w1-2",
            bindingId: "w1-2",
            displayName: "claude",
            state: "idle",
            sessionId: "w1",
            metadata: { agent: "claude" },
          },
        },
      ],
      lastError: undefined,
      lastRefreshAt: "2026-05-27T10:00:00.000Z",
      connection: "online",
      lastConnectedAt: "2026-05-27T10:00:00.000Z",
      restarting: false,
    };

    const context = dashboardContext(state);

    expect(context).toContain(
      "herdr:agent-room:w1-2[display=claude, state=idle, role=implementer, runtime=herdr:w1-2, agent=claude",
    );
    expect(context).toContain(
      "herdr:w1-2[state=idle, binding=w1-2, agent=claude, workspace=w1]",
    );
    expect(context).toContain(
      "agentAliases: claude => roomAgent=herdr:agent-room:w1-2, runtimeTarget=herdr:w1-2, state=idle",
    );
  });
});
