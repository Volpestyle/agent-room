import { describe, expect, it } from "vitest";
import { diffAnnouncements } from "./announcer-watcher.js";
import type { DashboardState } from "./state.js";
import type {
  Agent,
  AgentState,
  RuntimeProviderSummary,
} from "./types.js";

function agent(id: string, state: AgentState): Agent {
  return {
    id,
    roomId: "room",
    displayName: id,
    role: "implementer",
    state,
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
  };
}

function provider(id: string, ok: boolean): RuntimeProviderSummary {
  return {
    id,
    kind: "herdr",
    capabilities: {
      startAgent: true,
      stopAgent: true,
      readOutput: true,
      sendInput: true,
      attachInteractive: true,
      subscribeEvents: true,
      semanticAgentState: true,
      screenshots: false,
      fileMounts: false,
      worktrees: false,
      remoteExecution: false,
      adoptAgent: true,
    },
    health: { ok, status: ok ? "ok" : "offline" },
  };
}

function state(
  patch: Partial<Pick<DashboardState, "agents" | "providers">>,
): DashboardState {
  return {
    health: undefined,
    config: undefined,
    events: [],
    agents: patch.agents ?? [],
    messages: [],
    workspaces: [],
    providers: patch.providers ?? [],
    runtimeAgents: [],
    lastError: undefined,
    lastRefreshAt: "2026-05-31T00:00:00.000Z",
    connection: "online",
    lastConnectedAt: "2026-05-31T00:00:00.000Z",
    restarting: false,
  };
}

describe("diffAnnouncements", () => {
  it("emits nothing when nothing changed", () => {
    const snapshot = state({ agents: [agent("alice", "working")] });
    expect(diffAnnouncements(snapshot, snapshot)).toEqual([]);
  });

  it("announces an agent entering blocked, with no event for other transitions", () => {
    const prev = state({
      agents: [agent("alice", "working"), agent("bob", "working")],
    });
    const next = state({
      agents: [agent("alice", "blocked"), agent("bob", "reviewing")],
    });
    const events = diffAnnouncements(prev, next);
    expect(events).toEqual([
      { kind: "agent-blocked", agentId: "alice", displayName: "alice", state: "blocked" },
    ]);
  });

  it("announces an agent finishing (done)", () => {
    const prev = state({ agents: [agent("alice", "working")] });
    const next = state({ agents: [agent("alice", "done")] });
    expect(diffAnnouncements(prev, next)).toEqual([
      { kind: "agent-done", agentId: "alice", displayName: "alice", state: "done" },
    ]);
  });

  it("announces a newly joined agent and a departed agent", () => {
    const prev = state({ agents: [agent("alice", "working")] });
    const next = state({ agents: [agent("bob", "working")] });
    const events = diffAnnouncements(prev, next);
    expect(events).toContainEqual({
      kind: "agent-joined",
      agentId: "bob",
      displayName: "bob",
      state: "working",
    });
    expect(events).toContainEqual({
      kind: "agent-left",
      agentId: "alice",
      displayName: "alice",
    });
  });

  it("never announces ignored agents (dashboard / announcer)", () => {
    const prev = state({ agents: [] });
    const next = state({
      agents: [agent("dashboard", "idle"), agent("dashboard-announcer", "idle")],
    });
    const events = diffAnnouncements(prev, next, {
      ignoreAgentIds: new Set(["dashboard", "dashboard-announcer"]),
    });
    expect(events).toEqual([]);
  });

  it("announces a runtime going unhealthy only on the ok -> not-ok edge", () => {
    const healthy = state({ providers: [provider("herdr", true)] });
    const broken = state({ providers: [provider("herdr", false)] });
    expect(diffAnnouncements(healthy, broken)).toEqual([
      { kind: "runtime-unhealthy", providerId: "herdr" },
    ]);
    // Staying unhealthy does not re-announce.
    expect(diffAnnouncements(broken, broken)).toEqual([]);
  });
});
