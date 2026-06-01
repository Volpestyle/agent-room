import { describe, expect, it } from "vitest";
import type {
  Agent,
  AgentOutput,
  ReadAgentRequest,
  RuntimeAgent,
  RuntimeCapabilities,
  RuntimeHealth,
  RuntimeProvider,
  RuntimeSession,
  StartAgentRequest,
} from "../index.js";
import { searchRuntimeAgents } from "./runtimeSearch.js";

const capabilities: RuntimeCapabilities = {
  startAgent: false,
  stopAgent: false,
  readOutput: true,
  sendInput: false,
  attachInteractive: false,
  subscribeEvents: false,
  semanticAgentState: true,
  screenshots: false,
  fileMounts: false,
  worktrees: false,
  remoteExecution: false,
  adoptAgent: false,
};

describe("searchRuntimeAgents", () => {
  it("searches only bound room agents and returns compact context", async () => {
    const provider = new SearchRuntimeProvider({
      "pane-1": "first line\nTypeError: boom\nnext line",
      "pane-2": "other agent\nno match",
    });
    const agents: Agent[] = [
      roomAgent("impl", "Implementer", "pane-1"),
      roomAgent("reviewer", "Reviewer", "pane-2"),
      {
        id: "dashboard",
        roomId: "room",
        displayName: "Dashboard",
        role: "lead",
        state: "idle",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
    ];

    const result = await searchRuntimeAgents({
      agents,
      providerForBinding: () => provider,
      query: "typeerror",
      linesBefore: 1,
      linesAfter: 1,
      limit: 10,
    });

    expect(provider.reads).toEqual(["impl:pane-1", "reviewer:pane-2"]);
    expect(result).toMatchObject({
      searchedAgents: 2,
      matchedAgents: 1,
      matchCount: 1,
      truncated: false,
      matches: [
        {
          agentId: "impl",
          displayName: "Implementer",
          runtime: {
            providerId: "fake",
            providerKind: "fake",
            bindingId: "pane-1",
            kind: "pane",
          },
          state: "working",
          lineNumber: 2,
          matchedLine: "TypeError: boom",
          before: ["first line"],
          after: ["next line"],
        },
      ],
      errors: [],
    });
  });

  it("filters by provider and reports truncated results", async () => {
    const fake = new SearchRuntimeProvider({
      "pane-1": "needle one\nneedle two",
    });
    const other = new SearchRuntimeProvider(
      { "pane-2": "needle other" },
      "other",
    );
    const result = await searchRuntimeAgents({
      agents: [
        roomAgent("impl", "Implementer", "pane-1"),
        roomAgent("other", "Other", "pane-2", "other"),
      ],
      providerForBinding: (binding) =>
        binding.providerId === "other" ? other : fake,
      providerId: "fake",
      query: "needle",
      limit: 1,
    });

    expect(result.matchCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(other.reads).toEqual([]);
  });
});

function roomAgent(
  id: string,
  displayName: string,
  bindingId: string,
  providerId = "fake",
): Agent {
  return {
    id,
    roomId: "room",
    displayName,
    role: "implementer",
    state: "working",
    runtime: { providerId, bindingId, kind: "pane" },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

class SearchRuntimeProvider implements RuntimeProvider {
  readonly kind = "fake" as const;
  readonly capabilities = capabilities;
  readonly reads: string[] = [];

  constructor(
    private readonly outputs: Record<string, string>,
    readonly id = "fake",
  ) {}

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

  async stopAgent(_agentId: string): Promise<void> {
    throw new Error("not implemented");
  }

  async readAgent(request: ReadAgentRequest): Promise<AgentOutput> {
    const bindingId = request.bindingId ?? request.agentId;
    this.reads.push(`${request.agentId}:${bindingId}`);
    const text = this.outputs[bindingId] ?? "";
    return {
      agentId: request.agentId,
      bindingId,
      text,
      lineCount: text.split("\n").filter(Boolean).length,
      observedAt: "2026-06-01T00:00:00.000Z",
    };
  }

  async sendInput(): Promise<void> {
    throw new Error("not implemented");
  }
}
