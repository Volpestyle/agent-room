import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentRoomConfigPath,
  agentRoomDir,
  agentRoomProtocolPath,
  agentRoomRootDir,
  createDefaultAgentRoomConfig,
  defaultRoomIdFromEnv,
  ensureAgentRoomProtocol,
  formatAgentRoomConfig,
  parseAgentRoomConfig,
  readAgentRoomProtocol,
  readAgentRoomSessionIdentity,
  resolveStoragePath,
  withDefaultRuntime,
  writeAgentRoomSessionIdentity,
} from "./index.js";

describe("AgentRoom config", () => {
  it("round-trips the default YAML config", () => {
    const config = createDefaultAgentRoomConfig({
      roomId: "agent-room",
      roomName: "AgentRoom",
      defaultRuntime: "herdr",
      runtimeSession: "agent-room",
    });

    expect(parseAgentRoomConfig(formatAgentRoomConfig(config))).toEqual(config);
  });

  it("can switch the configured default runtime", () => {
    const config = createDefaultAgentRoomConfig({ roomId: "agent-room" });
    const updated = withDefaultRuntime(config, "tmux");

    expect(updated.runtime.default).toBe("tmux");
    expect(updated.runtimes.tmux).toEqual(
      expect.objectContaining({ type: "tmux" }),
    );
  });

  it("includes Herdr and tmux runtime settings without making them implicit choices", () => {
    const config = createDefaultAgentRoomConfig({ roomId: "my-project" });

    expect(config.runtime.default).toBe("fake");
    expect(config.workTracker).toEqual({
      default: "native",
      providers: {
        native: { type: "native" },
      },
    });
    expect(config.runtimes.herdr).toEqual(
      expect.objectContaining({
        type: "herdr",
        session: "agent-room",
        layout: expect.objectContaining({
          mode: "pane-grid",
          panesPerTab: 2,
        }),
      }),
    );
    expect(config.runtimes.tmux).toEqual(
      expect.objectContaining({ sessionPrefix: "my-project" }),
    );
  });

  it("keeps the default room id independent of runtime sessions", () => {
    expect(
      defaultRoomIdFromEnv({
        AGENTROOM_ROOM_ID: "custom-room",
      }),
    ).toBe("custom-room");
    expect(
      defaultRoomIdFromEnv({
        TMUX_SESSION: "mux-room",
      }),
    ).toBe("agent-room");
    expect(defaultRoomIdFromEnv({})).toBe("agent-room");
  });

  it("parses Herdr layout numbers and booleans from YAML", () => {
    const parsed = parseAgentRoomConfig(`room:
  id: agent-room

runtime:
  default: herdr

runtimes:
  herdr:
    type: herdr
    layout:
      mode: pane-grid
      workspace: agent-room
      panesPerTab: 3
      split: focused
      balance: false

storage:
  driver: jsonl
  path: events.jsonl
`);

    expect(parsed.runtimes.herdr).toEqual({
      type: "herdr",
      layout: {
        mode: "pane-grid",
        workspace: "agent-room",
        panesPerTab: 3,
        split: "focused",
        balance: false,
      },
    });
  });

  it("parses chat gateways and routes from YAML", () => {
    const parsed = parseAgentRoomConfig(`room:
  id: agent-room

runtime:
  default: fake

runtimes:
  fake:
    type: fake

chat:
  gateways:
    discord-main:
      type: discord
      tokenEnv: AGENTROOM_DISCORD_TOKEN
      credentialKind: bot-token
      webhookMode: true
      webhookName: AgentRoom
  routes:
    main-lead:
      provider: discord-main
      conversationId: "1234567890"
      conversationKind: channel
      target:
        type: agent-stdin
        agentId: clanky-lead
      outbound:
        type: agent-message
        agentId: clanky-lead
        channelId: implementation

storage:
  driver: jsonl
  path: events.jsonl
`);

    expect(parsed.chat).toEqual({
      gateways: {
        "discord-main": {
          type: "discord",
          tokenEnv: "AGENTROOM_DISCORD_TOKEN",
          credentialKind: "bot-token",
          webhookMode: true,
          webhookName: "AgentRoom",
        },
      },
      routes: {
        "main-lead": {
          provider: "discord-main",
          conversationId: "1234567890",
          conversationKind: "channel",
          target: { type: "agent-stdin", agentId: "clanky-lead" },
          outbound: {
            type: "agent-message",
            agentId: "clanky-lead",
            channelId: "implementation",
          },
        },
      },
    });
  });

  it("parses dashboard operator config from YAML", () => {
    const parsed = parseAgentRoomConfig(`room:
  id: agent-room

runtime:
  default: fake

operator:
  agentId: operator
  displayName: Dashboard Operator
  kind: clanky
  command: "clanky --profile operator --home .agentroom/clanky"
  cwd: /tmp/work
  sessionDir: .agentroom/clanky/profiles/operator/sessions
  env:
    CLANKY_PROFILE: operator

runtimes:
  fake:
    type: fake

storage:
  driver: jsonl
  path: events.jsonl
`);

    expect(parsed.operator).toEqual({
      agentId: "operator",
      displayName: "Dashboard Operator",
      kind: "clanky",
      command: "clanky --profile operator --home .agentroom/clanky",
      cwd: "/tmp/work",
      sessionDir: ".agentroom/clanky/profiles/operator/sessions",
      env: {
        CLANKY_PROFILE: "operator",
      },
    });
    expect(parseAgentRoomConfig(formatAgentRoomConfig(parsed))).toEqual(parsed);
  });

  it("parses portable work tracker and Clanky defaults from YAML", () => {
    const parsed = parseAgentRoomConfig(`room:
  id: agent-room

runtime:
  default: fake

workTracker:
  default: linear
  providers:
    linear:
      type: linear
      teamId: team_123

clanky:
  home: .clanky-room
  profile: lead
  chatGatewayOwner: room

runtimes:
  fake:
    type: fake

storage:
  driver: jsonl
  path: events.jsonl
`);

    expect(parsed.workTracker).toEqual({
      default: "linear",
      providers: {
        linear: {
          type: "linear",
          teamId: "team_123",
        },
      },
    });
    expect(parsed.clanky).toEqual({
      home: ".clanky-room",
      profile: "lead",
      chatGatewayOwner: "room",
    });
    expect(parseAgentRoomConfig(formatAgentRoomConfig(parsed))).toEqual(parsed);
  });

  it("discovers the nearest project config from subdirectories", async () => {
    const previousHome = process.env.AGENTROOM_HOME;
    delete process.env.AGENTROOM_HOME;
    const root = await mkdtemp(join(tmpdir(), "agentroom-config-root-"));
    try {
      const nested = join(root, "packages", "app");
      await mkdir(join(root, ".agentroom"), { recursive: true });
      await mkdir(nested, { recursive: true });
      const config = createDefaultAgentRoomConfig({
        roomId: "shared-room",
        defaultRuntime: "fake",
      });
      await writeFile(
        join(root, ".agentroom", "config.yaml"),
        `${formatAgentRoomConfig(config)}\n`,
        "utf8",
      );

      expect(agentRoomDir(nested)).toBe(join(root, ".agentroom"));
      expect(agentRoomRootDir(nested)).toBe(root);
      expect(agentRoomConfigPath(nested)).toBe(
        join(root, ".agentroom", "config.yaml"),
      );
      expect(agentRoomProtocolPath(nested)).toBe(
        join(root, ".agentroom", "AGENTS.md"),
      );
      expect(resolveStoragePath(config, nested)).toBe(
        join(root, ".agentroom", "events.jsonl"),
      );

      const protocolPath = await ensureAgentRoomProtocol(nested);
      expect(protocolPath).toBe(join(root, ".agentroom", "AGENTS.md"));
      const protocol = await readAgentRoomProtocol(nested);
      expect(protocol.content).toContain("# AgentRoom Protocol");
    } finally {
      if (previousHome === undefined) {
        delete process.env.AGENTROOM_HOME;
      } else {
        process.env.AGENTROOM_HOME = previousHome;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets AGENTROOM_HOME override project config discovery", async () => {
    const previousHome = process.env.AGENTROOM_HOME;
    const root = await mkdtemp(join(tmpdir(), "agentroom-config-home-"));
    try {
      const home = join(root, "home");
      const nested = join(root, "repo", "src");
      process.env.AGENTROOM_HOME = home;
      await mkdir(join(root, "repo", ".agentroom"), { recursive: true });
      await mkdir(nested, { recursive: true });
      await writeFile(
        join(root, "repo", ".agentroom", "config.yaml"),
        `${formatAgentRoomConfig(
          createDefaultAgentRoomConfig({ roomId: "project-room" }),
        )}\n`,
        "utf8",
      );

      expect(agentRoomDir(nested)).toBe(home);
      expect(agentRoomRootDir(nested)).toBe(home);
      expect(agentRoomConfigPath(nested)).toBe(join(home, "config.yaml"));
    } finally {
      if (previousHome === undefined) {
        delete process.env.AGENTROOM_HOME;
      } else {
        process.env.AGENTROOM_HOME = previousHome;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not apply a pane-scoped session identity to a caller in a different pane", async () => {
    const previousHome = process.env.AGENTROOM_HOME;
    delete process.env.AGENTROOM_HOME;
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-session-pane-"));
    try {
      await writeAgentRoomSessionIdentity(cwd, {
        agentId: "herdr:agent-room:worker",
        roomId: "agent-room",
        role: "implementer",
        bindingId: "worker",
        paneId: "p_owner",
        updatedAt: "2026-05-31T00:00:00.000Z",
      });

      // Same pane → the enrolled agent resolves.
      const samePane = await readAgentRoomSessionIdentity(cwd, "p_owner");
      expect(samePane?.agentId).toBe("herdr:agent-room:worker");

      // A different active pane must NOT inherit the identity (the bug fix).
      const otherPane = await readAgentRoomSessionIdentity(cwd, "p_other");
      expect(otherPane).toBeUndefined();

      // No pane env still inherits it (intentional "persist for later shells").
      const noPane = await readAgentRoomSessionIdentity(cwd, undefined);
      expect(noPane?.agentId).toBe("herdr:agent-room:worker");
    } finally {
      if (previousHome === undefined) {
        delete process.env.AGENTROOM_HOME;
      } else {
        process.env.AGENTROOM_HOME = previousHome;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
