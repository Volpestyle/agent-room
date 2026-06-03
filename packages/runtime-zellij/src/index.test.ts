import { describe, expect, it } from "vitest";
import { ZellijRuntimeProvider, type ZellijCommandRunner } from "./index.js";

describe("ZellijRuntimeProvider", () => {
  it("starts a background session and launches an enrolled command pane", async () => {
    const calls: string[][] = [];
    const runtime = new ZellijRuntimeProvider({
      session: "room",
      runner: async (args) => {
        calls.push(args);
        if (matches(args, ["list-sessions", "--short", "--no-formatting"])) {
          return "";
        }
        if (matches(args, ["attach", "room", "--create-background"])) {
          return "";
        }
        if (args.includes("run")) return "terminal_7\n";
        if (args.includes("list-panes")) return JSON.stringify([]);
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
    });

    const agent = await runtime.startAgent({
      agentId: "demo",
      roomId: "room",
      role: "implementer",
      harness: {
        kind: "shell",
        command: "bash",
        args: ["-lc", "echo hi"],
      },
      cwd: "/tmp/project",
      env: { EXTRA: "has spaces" },
    });

    expect(agent).toEqual(
      expect.objectContaining({
        id: "demo",
        bindingId: "terminal_7",
        sessionId: "room",
      }),
    );
    expect(calls).toContainEqual(["attach", "room", "--create-background"]);
    expect(calls).toContainEqual([
      "--session",
      "room",
      "run",
      "--cwd",
      "/tmp/project",
      "--name",
      "agentroom:demo",
      "--",
      "env",
      "AGENTROOM=1",
      "AGENTROOM_AGENT_ID=demo",
      "AGENTROOM_ROOM_ID=room",
      "AGENTROOM_ROLE=implementer",
      "EXTRA=has spaces",
      "bash",
      "-lc",
      "echo hi",
    ]);
  });

  it("preserves compound command strings through a shell", async () => {
    const calls: string[][] = [];
    const runtime = new ZellijRuntimeProvider({
      session: "room",
      runner: runnerFor(calls, {
        "list-sessions --short --no-formatting": "room\n",
        "--session room run --cwd /tmp/project --name agentroom:lead -- env AGENTROOM=1 AGENTROOM_AGENT_ID=lead AGENTROOM_ROOM_ID=room AGENTROOM_ROLE=lead sh -lc clanky --profile lead --home ./.clanky-room":
          "terminal_3\n",
        "--session room action list-panes --all --json": "[]",
      }),
    });

    await runtime.startAgent({
      agentId: "lead",
      roomId: "room",
      role: "lead",
      harness: {
        kind: "custom",
        command: "clanky --profile lead --home ./.clanky-room",
      },
      cwd: "/tmp/project",
    });

    expect(calls.at(-2)).toEqual([
      "--session",
      "room",
      "run",
      "--cwd",
      "/tmp/project",
      "--name",
      "agentroom:lead",
      "--",
      "env",
      "AGENTROOM=1",
      "AGENTROOM_AGENT_ID=lead",
      "AGENTROOM_ROOM_ID=room",
      "AGENTROOM_ROLE=lead",
      "sh",
      "-lc",
      "clanky --profile lead --home ./.clanky-room",
    ]);
  });

  it("lists terminal panes as runtime agents and strips AgentRoom pane titles", async () => {
    const runtime = new ZellijRuntimeProvider({
      session: "room",
      runner: runnerFor([], {
        "--session room action list-panes --all --json": JSON.stringify([
          {
            id: 7,
            is_plugin: false,
            title: "agentroom:demo",
            tab_id: 1,
            tab_name: "main",
            pane_command: "bash",
            pane_cwd: "/tmp/project",
            is_focused: true,
            exited: false,
          },
          {
            id: 2,
            is_plugin: true,
            title: "status-bar",
          },
        ]),
      }),
    });

    await expect(runtime.listAgents()).resolves.toEqual([
      expect.objectContaining({
        id: "demo",
        bindingId: "terminal_7",
        displayName: "demo",
        state: "online",
        metadata: expect.objectContaining({
          agentRoomAgentId: "demo",
          tabId: "1",
          cwd: "/tmp/project",
        }),
      }),
    ]);
  });

  it("reads, sends input, sends keys, and closes panes by pane id", async () => {
    const calls: string[][] = [];
    const runtime = new ZellijRuntimeProvider({
      session: "room",
      runner: runnerFor(calls, {
        "--session room action dump-screen --pane-id terminal_7 --full":
          "one\ntwo\nthree\n",
        "--session room action write-chars --pane-id terminal_7 hello": "",
        "--session room action send-keys --pane-id terminal_7 Enter": "",
        "--session room action send-keys --pane-id terminal_7 Up Down": "",
        "--session room action close-pane --pane-id terminal_7": "",
      }),
    });

    await expect(
      runtime.readAgent({ agentId: "demo", bindingId: "terminal_7", lines: 2 }),
    ).resolves.toEqual(
      expect.objectContaining({
        text: "three\n",
        bindingId: "terminal_7",
      }),
    );
    await runtime.sendInput({
      agentId: "demo",
      bindingId: "terminal_7",
      text: "hello",
    });
    await runtime.sendKeys({
      agentId: "demo",
      bindingId: "terminal_7",
      keys: ["Up", "Down"],
    });
    await runtime.stopAgent("terminal_7");

    expect(calls).toContainEqual([
      "--session",
      "room",
      "action",
      "close-pane",
      "--pane-id",
      "terminal_7",
    ]);
  });
});

function runnerFor(
  calls: string[][],
  responses: Record<string, string>,
): ZellijCommandRunner {
  return async (args) => {
    calls.push(args);
    const key = args.join(" ");
    const response = responses[key];
    if (response === undefined) {
      throw new Error(`unexpected command: ${key}`);
    }
    return response;
  };
}

function matches(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((v, i) => v === expected[i])
  );
}
