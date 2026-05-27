import { describe, expect, it } from "vitest";
import {
  createDefaultAgentRoomConfig,
  defaultRoomIdFromEnv,
  formatAgentRoomConfig,
  parseAgentRoomConfig,
  withDefaultRuntime,
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
          workspace: "my-project",
        }),
      }),
    );
    expect(config.runtimes.tmux).toEqual(
      expect.objectContaining({ sessionPrefix: "my-project" }),
    );
  });

  it("derives the default room id from runtime session environment", () => {
    expect(
      defaultRoomIdFromEnv({
        HERDR_SESSION: "agent-room",
      }),
    ).toBe("agent-room");
    expect(
      defaultRoomIdFromEnv({
        TMUX_SESSION: "mux-room",
      }),
    ).toBe("mux-room");
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
  path: .agentroom/events.jsonl
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
  path: .agentroom/events.jsonl
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
  path: .agentroom/events.jsonl
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
      tokenEnv: LINEAR_API_KEY
      commandEnv: AGENTROOM_LINEAR_COMMAND
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
  path: .agentroom/events.jsonl
`);

    expect(parsed.workTracker).toEqual({
      default: "linear",
      providers: {
        linear: {
          type: "linear",
          tokenEnv: "LINEAR_API_KEY",
          commandEnv: "AGENTROOM_LINEAR_COMMAND",
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
});
