import { describe, expect, it } from "vitest";
import { HerdrRuntimeProvider, type HerdrCommandRunner } from "./index.js";

describe("HerdrRuntimeProvider", () => {
  it("reports named Herdr sessions that are not running as offline", async () => {
    const runtime = new HerdrRuntimeProvider({
      runner: runnerFor({
        status: "server:\n  status: not running\n",
      }),
    });

    await expect(runtime.health()).resolves.toEqual(
      expect.objectContaining({ ok: false, status: "offline" }),
    );
  });

  it("returns an empty agent list when Herdr cannot enumerate workspaces", async () => {
    const runtime = new HerdrRuntimeProvider({
      runner: runnerFor({
        "workspace list": new Error(
          'Error: Os { code: 2, kind: NotFound, message: "No such file or directory" }',
        ),
      }),
    });

    await expect(runtime.listAgents()).resolves.toEqual([]);
  });

  it("lists panes as runtime agents using AgentRoom workspace labels", async () => {
    const runtime = new HerdrRuntimeProvider({
      runner: runnerFor({
        "workspace list": envelope({
          type: "workspace_list",
          workspaces: [
            { workspace_id: "w1", label: "agentroom:demo" },
            { workspace_id: "w2", label: "other" },
          ],
        }),
        "pane list": envelope({
          type: "pane_list",
          panes: [
            {
              pane_id: "w1-1",
              workspace_id: "w1",
              tab_id: "w1:1",
              agent: "bash",
              agent_status: "working",
            },
            {
              pane_id: "w2-1",
              workspace_id: "w2",
              tab_id: "w2:1",
              agent: "codex",
              agent_status: "idle",
            },
          ],
        }),
      }),
    });

    await expect(runtime.listAgents()).resolves.toEqual([
      expect.objectContaining({
        id: "demo",
        bindingId: "w1-1",
        displayName: "demo",
        state: "working",
        sessionId: "w1",
      }),
      expect.objectContaining({
        id: "w2-1",
        bindingId: "w2-1",
        displayName: "codex",
        state: "idle",
        sessionId: "w2",
      }),
    ]);
  });

  it("starts an agent by creating a workspace and running the harness in its pane", async () => {
    const calls: string[][] = [];
    const runtime = new HerdrRuntimeProvider({
      runner: async (args) => {
        calls.push(args);
        if (
          matches(args, [
            "workspace",
            "create",
            "--cwd",
            "/tmp/project",
            "--label",
            "agentroom:demo",
            "--no-focus",
          ])
        ) {
          return envelope({
            type: "workspace_created",
            workspace: { workspace_id: "w1", label: "agentroom:demo" },
            root_pane: {
              pane_id: "w1-1",
              workspace_id: "w1",
              tab_id: "w1:1",
              focused: true,
            },
          });
        }
        if (args[0] === "pane" && args[1] === "run") return "";
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    });

    const agent = await runtime.startAgent({
      agentId: "demo",
      roomId: "room",
      role: "implementer",
      harness: { kind: "shell", command: "bash", args: ["-lc", "echo hi"] },
      cwd: "/tmp/project",
      env: { EXTRA: "has spaces" },
    });

    expect(agent).toEqual(
      expect.objectContaining({
        id: "demo",
        bindingId: "w1-1",
        sessionId: "w1",
      }),
    );
    const runCall = calls.find(
      (args) => args[0] === "pane" && args[1] === "run",
    );
    expect(runCall).toEqual([
      "pane",
      "run",
      "w1-1",
      "env AGENTROOM='1' AGENTROOM_AGENT_ID='demo' AGENTROOM_ROOM_ID='room' AGENTROOM_ROLE='implementer' EXTRA='has spaces' 'bash' '-lc' 'echo hi'",
    ]);
  });

  it("starts an agent in a dedicated tab inside a shared Herdr workspace", async () => {
    const calls: string[][] = [];
    const runtime = new HerdrRuntimeProvider({
      layout: { mode: "tab-per-agent", workspace: "room" },
      runner: async (args) => {
        calls.push(args);
        if (matches(args, ["workspace", "list"])) {
          return envelope({
            type: "workspace_list",
            workspaces: [{ workspace_id: "w1", label: "room" }],
          });
        }
        if (
          matches(args, [
            "tab",
            "create",
            "--workspace",
            "w1",
            "--cwd",
            "/tmp/project",
            "--label",
            "reviewer",
            "--no-focus",
          ])
        ) {
          return envelope({
            type: "tab_info",
            tab: { tab_id: "w1:2", workspace_id: "w1", label: "reviewer" },
            root_pane: {
              pane_id: "w1-2",
              workspace_id: "w1",
              tab_id: "w1:2",
            },
          });
        }
        if (args[0] === "pane" && args[1] === "run") return "";
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    });

    const agent = await runtime.startAgent({
      agentId: "reviewer",
      roomId: "room",
      role: "reviewer",
      harness: { kind: "shell", command: "bash" },
      cwd: "/tmp/project",
    });

    expect(agent).toEqual(
      expect.objectContaining({
        id: "reviewer",
        bindingId: "w1-2",
        sessionId: "w1",
        metadata: expect.objectContaining({
          workspaceId: "w1",
          tabId: "w1:2",
          layoutMode: "tab-per-agent",
        }),
      }),
    );
    expect(calls).toContainEqual(["pane", "run", "w1-2", expect.any(String)]);
  });

  it("places pane-grid agents two per tab by reusing the first pane then splitting and balancing", async () => {
    const calls: string[][] = [];
    const runtime = new HerdrRuntimeProvider({
      layout: { mode: "pane-grid", workspace: "room", panesPerTab: 2 },
      runner: async (args) => {
        calls.push(args);
        const runCount = calls.filter(
          (call) => call[0] === "pane" && call[1] === "run",
        ).length;
        if (matches(args, ["workspace", "list"])) {
          return envelope({
            type: "workspace_list",
            workspaces: [{ workspace_id: "w1", label: "room" }],
          });
        }
        if (matches(args, ["tab", "list", "--workspace", "w1"])) {
          return envelope({
            type: "tab_list",
            tabs: [
              {
                tab_id: "w1:1",
                workspace_id: "w1",
                label: runCount === 0 ? "1" : "impl",
                pane_count: 1,
              },
            ],
          });
        }
        if (matches(args, ["pane", "list", "--workspace", "w1"])) {
          return envelope({
            type: "pane_list",
            panes: [
              {
                pane_id: "w1-1",
                workspace_id: "w1",
                tab_id: "w1:1",
                focused: true,
                ...(runCount > 0 ? { agent: "bash" } : {}),
              },
            ],
          });
        }
        if (matches(args, ["tab", "rename", "w1:1", "impl"])) return "";
        if (matches(args, ["tab", "rename", "w1:1", "impl/reviewer"]))
          return "";
        if (
          matches(args, [
            "pane",
            "split",
            "w1-1",
            "--direction",
            "right",
            "--cwd",
            "/tmp/project",
            "--no-focus",
          ])
        ) {
          return envelope({
            type: "pane_info",
            pane: {
              pane_id: "w1-2",
              workspace_id: "w1",
              tab_id: "w1:1",
            },
          });
        }
        if (matches(args, ["tab", "balance", "w1:1"])) return "";
        if (args[0] === "pane" && args[1] === "run") return "";
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    });

    const first = await runtime.startAgent({
      agentId: "impl",
      roomId: "room",
      role: "implementer",
      harness: { kind: "shell", command: "bash" },
      cwd: "/tmp/project",
    });
    const second = await runtime.startAgent({
      agentId: "reviewer",
      roomId: "room",
      role: "reviewer",
      harness: { kind: "shell", command: "bash" },
      cwd: "/tmp/project",
    });

    expect(first.bindingId).toBe("w1-1");
    expect(second.bindingId).toBe("w1-2");
    expect(calls).toContainEqual(["tab", "rename", "w1:1", "impl"]);
    expect(calls).toContainEqual(["tab", "rename", "w1:1", "impl/reviewer"]);
    expect(calls).toContainEqual([
      "pane",
      "split",
      "w1-1",
      "--direction",
      "right",
      "--cwd",
      "/tmp/project",
      "--no-focus",
    ]);
    expect(calls).toContainEqual(["tab", "balance", "w1:1"]);
  });

  it("resolves AgentRoom ids to Herdr pane ids for read and send", async () => {
    const calls: string[][] = [];
    const runtime = new HerdrRuntimeProvider({
      runner: async (args) => {
        calls.push(args);
        if (matches(args, ["pane", "get", "demo"]))
          throw new Error("pane not found");
        if (matches(args, ["workspace", "list"])) {
          return envelope({
            type: "workspace_list",
            workspaces: [{ workspace_id: "w1", label: "agentroom:demo" }],
          });
        }
        if (matches(args, ["pane", "list", "--workspace", "w1"])) {
          return envelope({
            type: "pane_list",
            panes: [
              {
                pane_id: "w1-1",
                workspace_id: "w1",
                tab_id: "w1:1",
                focused: true,
              },
            ],
          });
        }
        if (
          matches(args, [
            "pane",
            "read",
            "w1-1",
            "--source",
            "recent",
            "--lines",
            "5",
          ])
        )
          return "hello\n";
        if (matches(args, ["pane", "send-text", "w1-1", "echo hi"])) return "";
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    });

    await expect(
      runtime.readAgent({ agentId: "demo", lines: 5 }),
    ).resolves.toEqual(
      expect.objectContaining({
        agentId: "demo",
        bindingId: "w1-1",
        text: "hello\n",
        lineCount: 1,
      }),
    );
    await runtime.sendInput({
      agentId: "demo",
      text: "echo hi",
      submit: false,
    });

    expect(calls).toContainEqual([
      "pane",
      "read",
      "w1-1",
      "--source",
      "recent",
      "--lines",
      "5",
    ]);
    expect(calls).toContainEqual(["pane", "send-text", "w1-1", "echo hi"]);
    expect(
      calls.some((args) =>
        matches(args, ["pane", "send-keys", "w1-1", "Enter"]),
      ),
    ).toBe(false);
  });

  it("focuses the workspace for a direct Herdr pane attach target", async () => {
    const calls: string[][] = [];
    const runtime = new HerdrRuntimeProvider({
      runner: async (args) => {
        calls.push(args);
        if (matches(args, ["pane", "get", "w1-2"])) {
          return envelope({
            type: "pane_info",
            pane: {
              pane_id: "w1-2",
              workspace_id: "w1",
              tab_id: "w1:1",
            },
          });
        }
        if (matches(args, ["workspace", "focus", "w1"])) return "";
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    });

    await runtime.attach("w1-2");

    expect(calls).toEqual([
      ["pane", "get", "w1-2"],
      ["workspace", "focus", "w1"],
    ]);
  });

  it("adopts an existing pane without running any command", async () => {
    const calls: string[][] = [];
    const runtime = new HerdrRuntimeProvider({
      runner: async (args) => {
        calls.push(args);
        if (matches(args, ["pane", "get", "p_42"])) {
          return envelope({
            type: "pane_info",
            pane: {
              pane_id: "p_42",
              workspace_id: "w7",
              tab_id: "w7:1",
              focused: true,
            },
          });
        }
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    });

    const agent = await runtime.adoptAgent({
      agentId: "herdr:agent-room:p_42",
      bindingId: "p_42",
      roomId: "agent-room",
      role: "implementer",
    });

    expect(agent).toEqual(
      expect.objectContaining({
        id: "herdr:agent-room:p_42",
        bindingId: "p_42",
        sessionId: "w7",
        state: "online",
        metadata: expect.objectContaining({
          workspaceId: "w7",
          tabId: "w7:1",
          adopted: true,
        }),
      }),
    );
    expect(calls.some((args) => args[0] === "pane" && args[1] === "run")).toBe(
      false,
    );
    expect(runtime.capabilities.adoptAgent).toBe(true);
  });
});

function runnerFor(
  responses: Record<string, string | Error>,
): HerdrCommandRunner {
  return async (args) => {
    const response = responses[args.join(" ")];
    if (response === undefined)
      throw new Error(`unexpected command: ${args.join(" ")}`);
    if (response instanceof Error) throw response;
    return response;
  };
}

function envelope(result: unknown): string {
  return JSON.stringify({ id: "test", result });
}

function matches(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}
