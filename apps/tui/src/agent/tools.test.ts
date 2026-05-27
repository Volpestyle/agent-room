import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api.js";
import type { Poller } from "../poller.js";
import { createDashboardTools } from "./tools.js";

const runtimeCapabilities = {
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

describe("dashboard launch tool", () => {
  it("normalizes engineer role aliases before schema validation", () => {
    const tools = createDashboardTools({
      api: {} as ApiClient,
      poller: { tick: async () => undefined } as unknown as Poller,
    });
    const launch = tools.find((tool) => tool.name === "launch_runtime_agent");

    expect(launch?.prepareArguments?.({ role: "engineer" })).toEqual({
      role: "implementer",
    });
  });

  it("requires cwd before launching an agent", async () => {
    const api = {
      dashboardConfig: async () => ({
        roomId: "agent-room",
        cwd: "/repo",
        defaultRuntime: "herdr",
      }),
      listRuntimeProviders: async () => ({
        providers: [
          {
            id: "herdr",
            kind: "herdr",
            default: true,
            capabilities: runtimeCapabilities,
          },
        ],
      }),
      listRuntimeAgents: async () => ({ agents: [] }),
    } as unknown as ApiClient;
    const tools = createDashboardTools({
      api,
      poller: { tick: async () => undefined } as unknown as Poller,
    });
    const launch = tools.find((tool) => tool.name === "launch_runtime_agent");

    await expect(launch?.execute("call-1", {})).rejects.toThrow(
      "cwd is required",
    );
  });

  it("derives launch defaults after cwd is provided", async () => {
    const launchRuntimeAgent = vi.fn(
      async (_providerId: string, input: { agentId: string }) => ({
        agent: {
          id: input.agentId,
          bindingId: "binding-2",
          state: "starting" as const,
        },
      }),
    );
    const attachRuntimeAgent = vi.fn(async () => ({
      ok: true as const,
      agentId: "implementer-2",
      runtime: "herdr",
    }));
    const api = {
      dashboardConfig: async () => ({
        roomId: "agent-room",
        cwd: "/repo",
        defaultRuntime: "herdr",
      }),
      listRuntimeProviders: async () => ({
        providers: [
          {
            id: "herdr",
            kind: "herdr",
            default: true,
            capabilities: runtimeCapabilities,
          },
        ],
      }),
      listRuntimeAgents: async () => ({
        agents: [
          {
            id: "implementer-1",
            bindingId: "binding-1",
            state: "idle" as const,
          },
        ],
      }),
      launchRuntimeAgent,
      attachRuntimeAgent,
    } as unknown as ApiClient;
    const tools = createDashboardTools({
      api,
      poller: { tick: async () => undefined } as unknown as Poller,
    });
    const launch = tools.find((tool) => tool.name === "launch_runtime_agent");

    expect(launch).toBeDefined();
    await launch?.execute("call-1", { cwd: "/repo" });

    expect(launchRuntimeAgent).toHaveBeenCalledWith("herdr", {
      agentId: "implementer-2",
      role: "implementer",
      harness: {
        kind: "codex",
        command: "codex",
        cwd: "/repo",
      },
      cwd: "/repo",
      workspace: "repo",
    });
    expect(attachRuntimeAgent).toHaveBeenCalledWith("herdr", "implementer-2");
  });
});
