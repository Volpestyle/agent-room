import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentOutput,
  ChatGatewayProvider,
  ChatInboundHandler,
  ChatInboundMessage,
  ChatSendMessageInput,
  ChatSendMessageResult,
  RuntimeAgent,
  RuntimeCapabilities,
  RuntimeHealth,
  RuntimeProvider,
  RuntimeSession,
  SendInputRequest,
  StartAgentRequest,
} from "@agentroom/core";
import { createApp, createAppWithLifecycle } from "./app.js";

let tempDirs: string[] = [];
let previousAgentRoomHome: string | undefined;

beforeEach(() => {
  previousAgentRoomHome = process.env.AGENTROOM_HOME;
});

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
  restoreEnv("AGENTROOM_HOME", previousAgentRoomHome);
});

describe("agentroom daemon app", () => {
  it("requires an API token for /v1 routes when AGENTROOM_API_TOKEN is set", async () => {
    const previousToken = process.env.AGENTROOM_API_TOKEN;
    process.env.AGENTROOM_API_TOKEN = "mobile-secret";
    try {
      const app = createApp(await appOptions());

      const healthResponse = await app.request("/health");
      expect(healthResponse.status).toBe(200);
      await expect(healthResponse.json()).resolves.toMatchObject({
        auth: { apiTokenRequired: true },
      });

      const deniedResponse = await app.request("/v1/workspaces");
      expect(deniedResponse.status).toBe(401);

      const bearerResponse = await app.request("/v1/workspaces", {
        headers: { authorization: "Bearer mobile-secret" },
      });
      expect(bearerResponse.status).toBe(200);

      const headerResponse = await app.request("/v1/workspaces", {
        headers: { "x-agentroom-api-token": "mobile-secret" },
      });
      expect(headerResponse.status).toBe(200);
    } finally {
      if (previousToken === undefined) {
        delete process.env.AGENTROOM_API_TOKEN;
      } else {
        process.env.AGENTROOM_API_TOKEN = previousToken;
      }
    }
  });

  it("serves dashboard config from the daemon room config", async () => {
    const options = await appOptions();
    const app = createApp({
      ...options,
      config: {
        room: { id: "test-room" },
        runtime: { default: "fake" },
        operator: {
          agentId: "operator",
          displayName: "Clanky Operator",
          kind: "clanky",
          command: "clanky --profile operator",
          sessionDir: ".agentroom/clanky/profiles/operator/sessions",
        },
        runtimes: { fake: { type: "fake" } },
        storage: { driver: "jsonl", path: ".agentroom/events.jsonl" },
      },
    });

    const response = await app.request("/v1/dashboard/config");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      roomId: "test-room",
      cwd: options.cwd,
      protocolPath: join(options.cwd, "home", "AGENTS.md"),
      defaultRuntime: "fake",
      workTracker: null,
      mcp: null,
      operator: {
        agentId: "operator",
        displayName: "Clanky Operator",
        kind: "clanky",
        command: "clanky --profile operator",
        sessionDir: ".agentroom/clanky/profiles/operator/sessions",
      },
    });

    const providersResponse = await app.request("/v1/runtime/providers");
    expect(providersResponse.status).toBe(200);
    await expect(providersResponse.json()).resolves.toMatchObject({
      providers: [
        expect.objectContaining({
          id: "fake",
          default: true,
        }),
      ],
    });
  });

  it("serves and creates the editable room protocol", async () => {
    const options = await appOptions();
    const app = createApp(options);

    const response = await app.request("/v1/protocol");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      path: join(options.cwd, "home", "AGENTS.md"),
      content: expect.stringContaining("# AgentRoom Protocol"),
    });
  });

  it("updates first-run setup config through the daemon", async () => {
    const options = await appOptions();
    const app = createApp(options);

    const response = await app.request("/v1/config/setup", {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({
        runtimeDefault: "tmux",
        workTracker: { type: "linear", teamId: "team_123" },
        mcpServer: { id: "linear", type: "http", url: "https://mcp.linear.app/mcp" },
        clanky: {
          chatGatewayOwner: "room",
          home: ".clanky-room",
          profile: "lead",
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      path: string;
      config: {
        runtime: { default: string };
        workTracker: { default: string };
        mcp: { servers: Record<string, { type: string; url?: string }> };
        clanky: { chatGatewayOwner: string };
        operator: { kind: string; env: Record<string, string> };
      };
    };
    expect(body.config.runtime.default).toBe("tmux");
    expect(body.config.workTracker.default).toBe("linear");
    expect(body.config.mcp.servers.linear).toEqual({
      type: "streamable-http",
      url: "https://mcp.linear.app/mcp",
    });
    expect(body.config.clanky.chatGatewayOwner).toBe("room");
    expect(body.config.operator.kind).toBe("clanky");
    expect(body.config.operator.env.CLANKY_CHAT_GATEWAY_OWNER).toBe("room");

    const written = await readFile(body.path, "utf8");
    expect(written).toContain("default: tmux");
    expect(written).toContain("teamId: team_123");
    expect(written).toContain("url: https://mcp.linear.app/mcp");
    expect(written).toContain("chatGatewayOwner: room");
  });

  it("exposes daemon cwd in health checks", async () => {
    const options = await appOptions();
    const app = createApp(options);

    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      roomId: "test-room",
      cwd: options.cwd,
    });
  });

  it("uses the singleton default room id without config", async () => {
    const options = await appOptions();
    const previousRoom = process.env.AGENTROOM_ROOM_ID;
    const previousHerdr = process.env.HERDR_SESSION;
    delete process.env.AGENTROOM_ROOM_ID;
    process.env.HERDR_SESSION = "agent-room";
    try {
      const app = createApp({
        cwd: options.cwd,
        eventLogPath: options.eventLogPath,
      });

      const response = await app.request("/health");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        roomId: "agent-room",
        cwd: options.cwd,
      });
    } finally {
      restoreEnv("AGENTROOM_ROOM_ID", previousRoom);
      restoreEnv("HERDR_SESSION", previousHerdr);
    }
  });

  it("posts and filters room messages", async () => {
    const app = createApp(await appOptions());

    const channelResponse = await app.request("/v1/messages", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        channelId: "implementation",
        sender: { kind: "agent", id: "impl" },
        body: "Starting work",
      }),
    });
    expect(channelResponse.status).toBe(201);

    const dmResponse = await app.request("/v1/messages", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        channelId: "dm",
        sender: { kind: "agent", id: "impl" },
        recipients: [{ kind: "agent", id: "reviewer" }],
        body: "Ready for review",
      }),
    });
    expect(dmResponse.status).toBe(201);

    const messagesResponse = await app.request(
      "/v1/messages?participant=reviewer",
    );
    const { messages } = (await messagesResponse.json()) as {
      messages: Array<{ body: string }>;
    };
    expect(messages).toEqual([
      expect.objectContaining({ body: "Ready for review" }),
    ]);
  });

  it("records objective tracker events and narrative reports in the feed", async () => {
    const app = createApp(await appOptions());

    const trackerResponse = await app.request("/v1/tracker/events", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        providerKind: "linear",
        eventType: "Issue",
        action: "update",
        issueRef: "ENG-123",
        title: "Ship feed",
        status: "In Progress",
        raw: { type: "Issue", action: "update" },
      }),
    });
    expect(trackerResponse.status).toBe(201);

    const reportResponse = await app.request("/v1/reports", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        agentId: "dashboard",
        title: "Room summary",
        summary: "Implementation is moving",
        importance: "high",
      }),
    });
    expect(reportResponse.status).toBe(201);

    const hiddenResponse = await app.request("/v1/reports", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        agentId: "dashboard",
        summary: "Internal note",
        visibleToUser: false,
      }),
    });
    expect(hiddenResponse.status).toBe(201);

    const feedResponse = await app.request("/v1/feed?limit=10");
    const { events } = (await feedResponse.json()) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(events).toEqual([
      expect.objectContaining({
        type: "tracker.event",
        payload: {
          event: expect.objectContaining({
            providerKind: "linear",
            issueRef: "ENG-123",
          }),
        },
      }),
      expect.objectContaining({
        type: "agent.report",
        payload: {
          report: expect.objectContaining({
            agentId: "dashboard",
            summary: "Implementation is moving",
          }),
        },
      }),
    ]);
  });

  it("registers local room agents without runtime bindings", async () => {
    const app = createApp(await appOptions());

    const registerResponse = await app.request("/v1/agents", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        agentId: "dashboard",
        displayName: "Dashboard",
        role: "lead",
        capabilities: ["dashboard", "control-plane"],
      }),
    });
    expect(registerResponse.status).toBe(201);

    const heartbeatResponse = await app.request(
      "/v1/agents/dashboard/heartbeat",
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ state: "idle", status: "ready" }),
      },
    );
    expect(heartbeatResponse.status).toBe(200);

    const agentResponse = await app.request("/v1/agents/dashboard");
    expect(agentResponse.status).toBe(200);
    await expect(agentResponse.json()).resolves.toMatchObject({
      agent: {
        id: "dashboard",
        displayName: "Dashboard",
        role: "lead",
        state: "idle",
        capabilities: ["dashboard", "control-plane"],
      },
    });

    const leaveResponse = await app.request("/v1/agents/dashboard", {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ reason: "tui shutdown" }),
    });
    expect(leaveResponse.status).toBe(200);

    const listResponse = await app.request("/v1/agents");
    const { agents } = (await listResponse.json()) as {
      agents: Array<{ id: string; state: string; runtime?: unknown }>;
    };
    expect(agents).toEqual([
      expect.objectContaining({ id: "dashboard", state: "stopped" }),
    ]);
    expect(agents[0]?.runtime).toBeUndefined();
  });

  it("launches a fake runtime agent and audits input and output events", async () => {
    const app = createApp(await appOptions());

    const launchResponse = await app.request("/v1/runtime/fake/agents", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        agentId: "demo",
        role: "implementer",
        harness: { kind: "shell", command: "bash" },
      }),
    });
    expect(launchResponse.status).toBe(201);

    const bindingResponse = await app.request("/v1/runtime/bindings/demo");
    expect(bindingResponse.status).toBe(200);
    await expect(bindingResponse.json()).resolves.toMatchObject({
      binding: {
        providerId: "fake",
        bindingId: "fake:demo",
      },
    });

    const inputResponse = await app.request(
      "/v1/runtime/fake/agents/demo/input",
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ text: "echo hello" }),
      },
    );
    expect(inputResponse.status).toBe(200);

    const outputResponse = await app.request(
      "/v1/runtime/fake/agents/demo/output?lines=20",
    );
    expect(outputResponse.status).toBe(200);
    await outputResponse.json();

    const stopResponse = await app.request("/v1/runtime/fake/agents/demo", {
      method: "DELETE",
    });
    expect(stopResponse.status).toBe(200);
    await expect(stopResponse.json()).resolves.toMatchObject({
      ok: true,
      agentId: "demo",
      runtime: "fake",
    });

    const eventsResponse = await app.request("/v1/events?limit=20");
    const { events } = (await eventsResponse.json()) as {
      events: Array<{ type: string }>;
    };
    expect(events.map((event) => event.type)).toEqual([
      "agent.joined",
      "runtime.bound",
      "runtime.input_sent",
      "runtime.output_observed",
      "agent.left",
    ]);
  });

  it("sends discrete named keys to a runtime agent and audits them", async () => {
    const app = createApp(await appOptions());

    const launchResponse = await app.request("/v1/runtime/fake/agents", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        agentId: "demo",
        role: "implementer",
        harness: { kind: "shell", command: "bash" },
      }),
    });
    expect(launchResponse.status).toBe(201);

    const emptyResponse = await app.request(
      "/v1/runtime/fake/agents/demo/keys",
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ keys: [] }),
      },
    );
    expect(emptyResponse.status).toBe(400);

    const keysResponse = await app.request(
      "/v1/runtime/fake/agents/demo/keys",
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ keys: ["Up", "Down", "Enter"] }),
      },
    );
    expect(keysResponse.status).toBe(200);
    await expect(keysResponse.json()).resolves.toMatchObject({ ok: true });

    const outputResponse = await app.request(
      "/v1/runtime/fake/agents/demo/output?lines=20",
    );
    const { output } = (await outputResponse.json()) as {
      output: { text: string };
    };
    expect(output.text).toContain("keys from unknown: Up Down Enter");

    const eventsResponse = await app.request("/v1/events?limit=20");
    const { events } = (await eventsResponse.json()) as {
      events: Array<{ type: string }>;
    };
    expect(events.map((event) => event.type)).toContain("runtime.input_sent");
  });

  it("rejects a runtime launch when the returned binding is already active", async () => {
    const sharedRuntime = new SharedBindingRuntimeProvider("shared-runtime");
    const app = createApp({
      ...(await appOptions()),
      config: {
        room: { id: "test-room" },
        runtime: { default: "fake" },
        runtimes: { fake: { type: "fake" } },
        storage: { driver: "jsonl", path: ".agentroom/events.jsonl" },
      },
      runtimeProviders: [sharedRuntime],
    });

    const firstLaunch = await app.request("/v1/runtime/shared-runtime/agents", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        agentId: "existing",
        role: "implementer",
        harness: { kind: "shell", command: "bash" },
      }),
    });
    expect(firstLaunch.status).toBe(201);

    const conflictingLaunch = await app.request(
      "/v1/runtime/shared-runtime/agents",
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          agentId: "demo",
          role: "implementer",
          harness: { kind: "shell", command: "bash" },
        }),
      },
    );
    expect(conflictingLaunch.status).toBe(409);
    await expect(conflictingLaunch.json()).resolves.toEqual({
      error:
        "runtime binding shared-pane is already owned by active agent existing",
    });

    const eventsResponse = await app.request("/v1/events?limit=20");
    const { events } = (await eventsResponse.json()) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(
      events.filter(
        (event) =>
          event.type === "runtime.bound" && event.payload.agentId === "demo",
      ),
    ).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent.left",
        payload: expect.objectContaining({
          agentId: "demo",
          reason: "runtime binding shared-pane already owned by existing",
        }),
      }),
    );
  });

  it("rejects invalid runtime launch role and harness values", async () => {
    const app = createApp(await appOptions());

    const invalidRole = await app.request("/v1/runtime/fake/agents", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        agentId: "demo",
        role: "engineer",
        harness: { kind: "shell", command: "bash" },
      }),
    });
    expect(invalidRole.status).toBe(400);
    await expect(invalidRole.json()).resolves.toMatchObject({
      error: "Invalid agent role: engineer",
    });

    const invalidHarness = await app.request("/v1/runtime/fake/agents", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        agentId: "demo",
        role: "implementer",
        harness: { kind: "unknown", command: "bash" },
      }),
    });
    expect(invalidHarness.status).toBe(400);
    await expect(invalidHarness.json()).resolves.toMatchObject({
      error: "Invalid harness kind: unknown",
    });
  });

  it("mirrors configured outbound chat routes through registered chat gateways", async () => {
    const chat = new TestChatGatewayProvider("discord-main");
    const app = createApp({
      ...(await appOptions()),
      config: {
        room: { id: "test-room" },
        runtime: { default: "fake" },
        runtimes: { fake: { type: "fake" } },
        chat: {
          gateways: {},
          routes: {
            lead: {
              provider: "discord-main",
              conversationId: "discord-channel-1",
              conversationKind: "channel",
              target: { type: "agent-stdin", agentId: "clanky-lead" },
              outbound: {
                type: "agent-message",
                agentId: "clanky-lead",
                channelId: "implementation",
              },
            },
          },
        },
        storage: { driver: "jsonl", path: ".agentroom/events.jsonl" },
      },
      chatGateways: [chat],
      startChatGateways: false,
    });

    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        channelId: "implementation",
        sender: { kind: "agent", id: "clanky-lead" },
        body: "Delegated to impl-a",
      }),
    });

    expect(response.status).toBe(201);
    expect(chat.sent).toEqual([
      expect.objectContaining({
        conversation: { id: "discord-channel-1", kind: "channel" },
        text: "Delegated to impl-a",
        attribution: {
          actor: { kind: "agent", id: "clanky-lead" },
          username: "clanky-lead",
        },
      }),
    ]);

    const eventsResponse = await app.request("/v1/events?limit=20");
    const { events } = (await eventsResponse.json()) as {
      events: Array<{ type: string }>;
    };
    expect(events.map((event) => event.type)).toEqual([
      "message.posted",
      "chat.outbound_sent",
    ]);
  });

  it("routes inbound chat gateway messages to runtime-backed agent input", async () => {
    const chat = new TestChatGatewayProvider("discord-main");
    const app = createApp({
      ...(await appOptions()),
      config: {
        room: { id: "test-room" },
        runtime: { default: "fake" },
        runtimes: { fake: { type: "fake" } },
        chat: {
          gateways: {},
          routes: {
            lead: {
              provider: "discord-main",
              conversationId: "discord-channel-1",
              conversationKind: "channel",
              target: { type: "agent-stdin", agentId: "clanky-lead" },
            },
          },
        },
        storage: { driver: "jsonl", path: ".agentroom/events.jsonl" },
      },
      chatGateways: [chat],
    });
    await Promise.resolve();

    const launchResponse = await app.request("/v1/runtime/fake/agents", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        agentId: "clanky-lead",
        role: "implementer",
        harness: { kind: "shell", command: "bash" },
      }),
    });
    expect(launchResponse.status).toBe(201);

    await chat.emit({
      providerId: "discord-main",
      providerKind: "discord",
      credentialKind: "bot-token",
      externalMessageId: "m-1",
      conversation: { id: "discord-channel-1", kind: "channel" },
      sender: { id: "u-1", username: "james", displayName: "James" },
      text: "run the plan",
      kind: "text",
      attachments: [],
      mentionsSelf: true,
      receivedAt: "2026-05-25T00:00:00.000Z",
    });

    const eventsResponse = await app.request("/v1/events?limit=20");
    const { events } = (await eventsResponse.json()) as {
      events: Array<{ type: string; payload: unknown }>;
    };
    expect(events.map((event) => event.type)).toEqual([
      "agent.joined",
      "runtime.bound",
      "chat.inbound_received",
      "runtime.input_sent",
    ]);
    expect(events[3]).toMatchObject({
      payload: {
        agentId: "clanky-lead",
        text: "run the plan",
        source: "discord-main:u-1",
      },
    });
  });

  it("does not loop connector-sourced messages back through the outbound dispatcher", async () => {
    const chat = new TestChatGatewayProvider("discord-main");
    const app = createApp({
      ...(await appOptions()),
      config: {
        room: { id: "test-room" },
        runtime: { default: "fake" },
        runtimes: { fake: { type: "fake" } },
        chat: {
          gateways: {},
          routes: {
            mirror: {
              provider: "discord-main",
              conversationId: "discord-channel-1",
              conversationKind: "channel",
              target: { type: "room-channel", channelId: "implementation" },
            },
          },
        },
        storage: { driver: "jsonl", path: ".agentroom/events.jsonl" },
      },
      chatGateways: [chat],
      startChatGateways: false,
    });

    // A connector-sourced message posted into the routed channel must not
    // round-trip back out through the dispatcher.
    const connectorPost = await app.request("/v1/messages", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        channelId: "implementation",
        sender: { kind: "connector", id: "discord-main:u-1" },
        body: "Echoed from connector",
      }),
    });
    expect(connectorPost.status).toBe(201);
    expect(chat.sent).toEqual([]);

    // Sanity: an agent-sourced message in the same channel WOULD be dispatched
    // if the route had a matching outbound source. With a `room-channel`
    // target+outbound source on `implementation`, an agent post should go.
    const agentPost = await app.request("/v1/messages", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        channelId: "implementation",
        sender: { kind: "agent", id: "clanky-lead" },
        body: "Real agent output",
      }),
    });
    expect(agentPost.status).toBe(201);
    expect(chat.sent).toEqual([
      expect.objectContaining({ text: "Real agent output" }),
    ]);
  });

  it("exposes /v1/chat/gateways and /v1/chat/routes shapes", async () => {
    const chat = new TestChatGatewayProvider("discord-main");
    const app = createApp({
      ...(await appOptions()),
      config: {
        room: { id: "test-room" },
        runtime: { default: "fake" },
        runtimes: { fake: { type: "fake" } },
        chat: {
          gateways: {},
          routes: {
            lead: {
              provider: "discord-main",
              conversationId: "discord-channel-1",
              conversationKind: "channel",
              target: { type: "agent-stdin", agentId: "clanky-lead" },
              outbound: {
                type: "agent-message",
                agentId: "clanky-lead",
                channelId: "implementation",
              },
            },
          },
        },
        storage: { driver: "jsonl", path: ".agentroom/events.jsonl" },
      },
      chatGateways: [chat],
    });

    const gatewaysResponse = await app.request("/v1/chat/gateways");
    expect(gatewaysResponse.status).toBe(200);
    const gatewaysBody = (await gatewaysResponse.json()) as {
      gateways: Array<{
        id: string;
        kind: string;
        credentialKind: string;
        health: { ok: boolean };
      }>;
    };
    expect(gatewaysBody.gateways).toEqual([
      expect.objectContaining({
        id: "discord-main",
        kind: "discord",
        credentialKind: "bot-token",
        health: expect.objectContaining({ ok: true }),
      }),
    ]);

    const routesResponse = await app.request("/v1/chat/routes");
    expect(routesResponse.status).toBe(200);
    const routesBody = (await routesResponse.json()) as {
      routes: Array<Record<string, unknown>>;
    };
    expect(routesBody.routes).toEqual([
      {
        providerId: "discord-main",
        conversationId: "discord-channel-1",
        conversationKind: "channel",
        target: { type: "agent-stdin", agentId: "clanky-lead" },
        outbound: {
          type: "agent-message",
          agentId: "clanky-lead",
          channelId: "implementation",
        },
      },
    ]);
  });

  it("constructs discord gateways via the configured gatewayFactory override", async () => {
    const chat = new TestChatGatewayProvider("discord-main");
    const app = createApp({
      ...(await appOptions()),
      config: {
        room: { id: "test-room" },
        runtime: { default: "fake" },
        runtimes: { fake: { type: "fake" } },
        chat: {
          gateways: {
            "discord-main": { type: "discord", tokenEnv: "FAKE_TOKEN_ENV" },
          },
          routes: {
            lead: {
              provider: "discord-main",
              conversationId: "discord-channel-1",
              conversationKind: "channel",
              target: { type: "room-channel", channelId: "implementation" },
            },
          },
        },
        storage: { driver: "jsonl", path: ".agentroom/events.jsonl" },
      },
      chatGatewayFactory: (id) => {
        if (id !== "discord-main") throw new Error(`unexpected gateway ${id}`);
        return chat;
      },
      startChatGateways: false,
    });

    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        channelId: "implementation",
        sender: { kind: "agent", id: "clanky-lead" },
        body: "Via factory",
      }),
    });
    expect(response.status).toBe(201);
    expect(chat.sent).toEqual([
      expect.objectContaining({
        conversation: { id: "discord-channel-1", kind: "channel" },
        text: "Via factory",
      }),
    ]);
  });

  it("tolerates gateway start failures and surfaces them via /health", async () => {
    const failing = new FailingChatGatewayProvider("discord-bad");
    const { app, chatStartup } = createAppWithLifecycle({
      ...(await appOptions()),
      config: {
        room: { id: "test-room" },
        runtime: { default: "fake" },
        runtimes: { fake: { type: "fake" } },
        chat: {
          gateways: {},
          routes: {},
        },
        storage: { driver: "jsonl", path: ".agentroom/events.jsonl" },
      },
      chatGateways: [failing],
    });

    await chatStartup;

    const healthResponse = await app.request("/health");
    const health = (await healthResponse.json()) as {
      chatGateways: Array<{ id: string; startupError?: string }>;
    };
    expect(health.chatGateways).toEqual([
      expect.objectContaining({
        id: "discord-bad",
        startupError: "boom",
      }),
    ]);
  });

  it("tolerates gateway construction failures and surfaces them via /health", async () => {
    // Regression: a gateway whose construction throws (e.g. Discord missing its
    // token env var) must not crash daemon startup — it must surface in /health.
    const { app, chatStartup } = createAppWithLifecycle({
      ...(await appOptions()),
      config: {
        room: { id: "test-room" },
        runtime: { default: "fake" },
        runtimes: { fake: { type: "fake" } },
        chat: {
          gateways: {
            "discord-main": { type: "discord", tokenEnv: "MISSING_TOKEN_ENV" },
          },
          routes: {},
        },
        storage: { driver: "jsonl", path: ".agentroom/events.jsonl" },
      },
      chatGatewayFactory: (id) => {
        throw new Error(`Chat gateway '${id}' requires env var to be set`);
      },
    });

    await chatStartup;

    const healthResponse = await app.request("/health");
    expect(healthResponse.status).toBe(200);
    const health = (await healthResponse.json()) as {
      ok: boolean;
      chatGateways: Array<{
        id: string;
        kind: string;
        startupError?: string;
        health: { ok: boolean };
      }>;
    };
    expect(health.ok).toBe(true);
    expect(health.chatGateways).toEqual([
      expect.objectContaining({
        id: "discord-main",
        kind: "discord",
        startupError: "Chat gateway 'discord-main' requires env var to be set",
        health: expect.objectContaining({ ok: false }),
      }),
    ]);
  });

  it("keeps a configured Discord gateway without a token as a health failure only", async () => {
    const previousToken = process.env.MISSING_AGENTROOM_DISCORD_TOKEN;
    delete process.env.MISSING_AGENTROOM_DISCORD_TOKEN;
    try {
      const { app, chatStartup } = createAppWithLifecycle({
        ...(await appOptions()),
        config: {
          room: { id: "test-room" },
          runtime: { default: "fake" },
          runtimes: { fake: { type: "fake" } },
          chat: {
            gateways: {
              "discord-main": {
                type: "discord",
                tokenEnv: "MISSING_AGENTROOM_DISCORD_TOKEN",
              },
            },
            routes: {},
          },
          storage: { driver: "jsonl", path: ".agentroom/events.jsonl" },
        },
      });

      await chatStartup;

      const healthResponse = await app.request("/health");
      expect(healthResponse.status).toBe(200);
      const health = (await healthResponse.json()) as {
        ok: boolean;
        chatGateways: Array<{
          id: string;
          startupError?: string;
          secretConfigured: boolean;
          health: { ok: boolean; message?: string };
        }>;
      };
      expect(health.ok).toBe(true);
      expect(health.chatGateways).toEqual([
        expect.objectContaining({
          id: "discord-main",
          secretConfigured: false,
          startupError:
            "Chat gateway 'discord-main' has no token — set 'MISSING_AGENTROOM_DISCORD_TOKEN' in the TUI Settings view or as an environment variable",
          health: expect.objectContaining({ ok: false }),
        }),
      ]);
    } finally {
      restoreEnv("MISSING_AGENTROOM_DISCORD_TOKEN", previousToken);
    }
  });
});

class SharedBindingRuntimeProvider implements RuntimeProvider {
  readonly kind = "fake" as const;
  readonly capabilities: RuntimeCapabilities = {
    startAgent: true,
    stopAgent: true,
    readOutput: true,
    sendInput: true,
    attachInteractive: false,
    subscribeEvents: false,
    semanticAgentState: true,
    screenshots: false,
    fileMounts: false,
    worktrees: false,
    remoteExecution: false,
    adoptAgent: false,
  };
  private readonly agents = new Map<string, RuntimeAgent>();

  constructor(readonly id: string) {}

  async health(): Promise<RuntimeHealth> {
    return { ok: true, status: "ok", message: "shared binding runtime ready" };
  }

  async listSessions(): Promise<RuntimeSession[]> {
    return [{ id: "shared-session", name: "Shared Session" }];
  }

  async listAgents(): Promise<RuntimeAgent[]> {
    return [...this.agents.values()];
  }

  async startAgent(request: StartAgentRequest): Promise<RuntimeAgent> {
    const agent: RuntimeAgent = {
      id: request.agentId,
      bindingId: "shared-pane",
      displayName: request.agentId,
      state: "online",
      sessionId: "shared-session",
    };
    this.agents.set(request.agentId, agent);
    return agent;
  }

  async stopAgent(agentId: string): Promise<void> {
    this.agents.delete(agentId);
  }

  async readAgent(request: { agentId: string }): Promise<AgentOutput> {
    return {
      agentId: request.agentId,
      bindingId: "shared-pane",
      text: "",
      lineCount: 0,
      observedAt: new Date(0).toISOString(),
    };
  }

  async sendInput(_request: SendInputRequest): Promise<void> {
    // Test double does not need to persist input.
  }
}

class TestChatGatewayProvider implements ChatGatewayProvider {
  readonly id: string;
  readonly kind = "discord" as const;
  readonly credentialKind = "bot-token" as const;
  readonly sent: ChatSendMessageInput[] = [];
  private handler: ChatInboundHandler | undefined;

  constructor(id: string) {
    this.id = id;
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }

  async start(handler: ChatInboundHandler): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = undefined;
  }

  async sendMessage(
    input: ChatSendMessageInput,
  ): Promise<ChatSendMessageResult> {
    this.sent.push(input);
    return { externalMessageId: `sent-${this.sent.length}` };
  }

  async emit(message: ChatInboundMessage): Promise<void> {
    if (this.handler === undefined)
      throw new Error("chat gateway handler was not started");
    await this.handler(message);
  }
}

class FailingChatGatewayProvider implements ChatGatewayProvider {
  readonly id: string;
  readonly kind = "discord" as const;
  readonly credentialKind = "bot-token" as const;
  private failure: string | undefined;

  constructor(id: string) {
    this.id = id;
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    return this.failure === undefined
      ? { ok: false, message: "not started" }
      : { ok: false, message: this.failure };
  }

  async start(_handler: ChatInboundHandler): Promise<void> {
    this.failure = "boom";
    throw new Error("boom");
  }

  async stop(): Promise<void> {
    this.failure = undefined;
  }

  async sendMessage(
    _input: ChatSendMessageInput,
  ): Promise<ChatSendMessageResult> {
    throw new Error("failing gateway cannot send");
  }
}

async function appOptions() {
  const dir = await mkdtemp(join(tmpdir(), "agentroom-test-"));
  tempDirs.push(dir);
  process.env.AGENTROOM_HOME = join(dir, "home");
  return {
    roomId: "test-room",
    eventLogPath: join(dir, "events.jsonl"),
    cwd: dir,
  };
}

function jsonHeaders(): HeadersInit {
  return { "content-type": "application/json" };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
