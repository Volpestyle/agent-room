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
  it("exposes feed, report, and configured MCP tooling to the dashboard agent", () => {
    const tools = createDashboardTools({
      api: {} as ApiClient,
      poller: { tick: async () => undefined } as unknown as Poller,
    });

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "list_user_feed",
        "post_agent_report",
        "list_mcp_tools",
        "call_mcp_tool",
      ]),
    );
    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([
        "list_work_tracker_actions",
        "run_cli_command",
        "list_skills",
        "read_skill",
      ]),
    );
  });

  it("lists MCP servers from dashboard config without connecting to disabled servers", async () => {
    const dashboardConfig = vi.fn(async () => ({
      roomId: "agent-room",
      cwd: "/repo",
      defaultRuntime: "fake",
      mcp: {
        servers: {
          linear: {
            type: "streamable-http" as const,
            url: "https://mcp.linear.app/mcp",
            disabled: true,
          },
        },
      },
    }));
    const tools = createDashboardTools({
      api: { dashboardConfig } as unknown as ApiClient,
      poller: { tick: async () => undefined } as unknown as Poller,
      cwd: "/repo",
    });
    const tool = tools.find((entry) => entry.name === "list_mcp_tools");

    const result = await tool?.execute("call-1", {});

    expect(dashboardConfig).toHaveBeenCalled();
    const firstContent = result?.content[0];
    expect(firstContent?.type === "text" ? firstContent.text : "").toContain(
      "linear",
    );
    expect(firstContent?.type === "text" ? firstContent.text : "").toContain(
      "disabled",
    );
  });

  it("lists the user-visible feed", async () => {
    const listUserFeed = vi.fn(async () => ({
      events: [
        {
          type: "tracker.event",
          payload: { event: { providerKind: "linear", issueRef: "ENG-123" } },
        },
      ],
    }));
    const tools = createDashboardTools({
      api: { listUserFeed } as unknown as ApiClient,
      poller: { tick: async () => undefined } as unknown as Poller,
    });
    const tool = tools.find((entry) => entry.name === "list_user_feed");

    const result = await tool?.execute("call-1", { limit: 25 });

    expect(listUserFeed).toHaveBeenCalledWith(25);
    expect(result?.content[0]?.type).toBe("text");
    const firstContent = result?.content[0];
    expect(firstContent?.type === "text" ? firstContent.text : "").toContain(
      "tracker.event",
    );
  });

  it("posts a narrative report as the dashboard agent", async () => {
    const tick = vi.fn(async () => undefined);
    const createAgentReport = vi.fn(async () => ({
      report: { id: "rep_1", agentId: "dashboard", summary: "Room is moving" },
    }));
    const tools = createDashboardTools({
      api: { createAgentReport } as unknown as ApiClient,
      poller: { tick } as unknown as Poller,
    });
    const tool = tools.find((entry) => entry.name === "post_agent_report");

    const result = await tool?.execute("call-1", {
      title: "Daily summary",
      summary: "Room is moving",
      importance: "high",
      refs: [{ kind: "tracker-issue", id: "ENG-123" }],
    });

    expect(createAgentReport).toHaveBeenCalledWith({
      agentId: "dashboard",
      title: "Daily summary",
      summary: "Room is moving",
      importance: "high",
      refs: [{ kind: "tracker-issue", id: "ENG-123" }],
    });
    expect(tick).toHaveBeenCalled();
    expect(result?.details).toMatchObject({ report: { id: "rep_1" } });
  });

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
