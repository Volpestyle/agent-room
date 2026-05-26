import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChatGatewayProvider,
  ChatInboundHandler,
  ChatInboundMessage,
  ChatSendMessageInput,
  ChatSendMessageResult,
} from "@agentroom/core";
import { createApp, createAppWithLifecycle } from "./app.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
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

      const deniedResponse = await app.request("/v1/tasks");
      expect(deniedResponse.status).toBe(401);

      const bearerResponse = await app.request("/v1/tasks", {
        headers: { authorization: "Bearer mobile-secret" },
      });
      expect(bearerResponse.status).toBe(200);

      const headerResponse = await app.request("/v1/tasks", {
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

  it("creates, claims, updates, and lists tasks", async () => {
    const app = createApp(await appOptions());

    const createResponse = await app.request("/v1/tasks", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        title: "Ship MVP",
        assigneeId: "impl",
        refs: [{ kind: "linear-issue", id: "ENG-123", label: "ENG-123" }],
      }),
    });
    expect(createResponse.status).toBe(201);
    const { task } = (await createResponse.json()) as {
      task: { id: string; status: string };
    };

    const updateResponse = await app.request(`/v1/tasks/${task.id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({
        title: "Ship polished MVP",
        description: "Include task editing in the TUI",
        actor: { kind: "human", id: "tester" },
      }),
    });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({
      task: {
        id: task.id,
        title: "Ship polished MVP",
        description: "Include task editing in the TUI",
      },
    });

    const claimResponse = await app.request(`/v1/tasks/${task.id}/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ assignee: { kind: "agent", id: "impl" } }),
    });
    expect(claimResponse.status).toBe(200);

    const statusResponse = await app.request(`/v1/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({
        status: "done",
        actor: { kind: "agent", id: "impl" },
        summary: "Done",
      }),
    });
    expect(statusResponse.status).toBe(200);

    const listResponse = await app.request("/v1/tasks");
    const { tasks } = (await listResponse.json()) as {
      tasks: Array<{
        id: string;
        title: string;
        description?: string;
        status: string;
        assignee?: { id: string };
      }>;
    };
    expect(tasks).toEqual([
      expect.objectContaining({
        id: task.id,
        title: "Ship polished MVP",
        description: "Include task editing in the TUI",
        status: "done",
        assignee: { kind: "agent", id: "impl" },
        refs: [{ kind: "linear-issue", id: "ENG-123", label: "ENG-123" }],
      }),
    ]);
  });

  it("deletes tasks from the active task list", async () => {
    const app = createApp(await appOptions());

    const createResponse = await app.request("/v1/tasks", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ title: "Duplicate task" }),
    });
    expect(createResponse.status).toBe(201);
    const { task } = (await createResponse.json()) as {
      task: { id: string };
    };

    const deleteResponse = await app.request(`/v1/tasks/${task.id}`, {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({
        actor: { kind: "human", id: "tester" },
        reason: "duplicate",
      }),
    });
    expect(deleteResponse.status).toBe(200);

    const listResponse = await app.request("/v1/tasks");
    await expect(listResponse.json()).resolves.toEqual({ tasks: [] });

    const eventsResponse = await app.request("/v1/events?limit=10");
    const { events } = (await eventsResponse.json()) as {
      events: Array<{ type: string; payload: unknown }>;
    };
    expect(events.map((event) => event.type)).toEqual([
      "task.created",
      "task.deleted",
    ]);
    expect(events[1]).toMatchObject({
      payload: {
        taskId: task.id,
        actor: { kind: "human", id: "tester" },
        reason: "duplicate",
      },
    });
  });

  it("launches a fake runtime agent and audits input and output events", async () => {
    const app = createApp(await appOptions());

    const launchResponse = await app.request("/v1/runtime/fake-local/agents", {
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
        providerId: "fake-local",
        bindingId: "fake:demo",
      },
    });

    const inputResponse = await app.request(
      "/v1/runtime/fake-local/agents/demo/input",
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ text: "echo hello" }),
      },
    );
    expect(inputResponse.status).toBe(200);

    const outputResponse = await app.request(
      "/v1/runtime/fake-local/agents/demo/output?lines=20",
    );
    expect(outputResponse.status).toBe(200);
    await outputResponse.json();

    const eventsResponse = await app.request("/v1/events?limit=20");
    const { events } = (await eventsResponse.json()) as {
      events: Array<{ type: string }>;
    };
    expect(events.map((event) => event.type)).toEqual([
      "agent.joined",
      "runtime.bound",
      "runtime.input_sent",
      "runtime.output_observed",
    ]);
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
});

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
  return {
    roomId: "test-room",
    eventLogPath: join(dir, "events.jsonl"),
    cwd: dir,
  };
}

function jsonHeaders(): HeadersInit {
  return { "content-type": "application/json" };
}
