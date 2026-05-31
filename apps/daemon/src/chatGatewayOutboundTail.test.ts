import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlEventStore } from "@agentroom/storage-jsonl";
import {
  AgentRoomService,
  ChatGatewayOutboundDispatcher,
  type ChatGatewayProvider,
  type ChatGatewayRoute,
  type ChatInboundHandler,
  type ChatSendMessageInput,
  type ChatSendMessageResult,
} from "@agentroom/core";
import { ChatGatewayOutboundTail } from "./chatGatewayOutboundTail.js";

const ROOM_ID = "test-room";

class RecordingGateway implements ChatGatewayProvider {
  readonly kind = "discord" as const;
  readonly credentialKind = "bot-token" as const;
  private readonly outbound: ChatSendMessageInput[] = [];

  constructor(readonly id: string) {}

  async health(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async start(_handler: ChatInboundHandler): Promise<void> {}
  async stop(): Promise<void> {}

  async sendMessage(
    input: ChatSendMessageInput,
  ): Promise<ChatSendMessageResult> {
    this.outbound.push(input);
    return {
      externalMessageId: `ext-${this.outbound.length}`,
    };
  }

  get sent(): ChatSendMessageInput[] {
    return this.outbound;
  }
}

function mirrorRoute(): ChatGatewayRoute {
  return {
    providerId: "discord-main",
    conversationId: "discord-channel-1",
    conversationKind: "channel",
    target: { type: "room-channel", channelId: "implementation" },
  };
}

describe("ChatGatewayOutboundTail", () => {
  let tempDir: string;
  let store: JsonlEventStore;
  let service: AgentRoomService;
  let gateway: RecordingGateway;
  let dispatcher: ChatGatewayOutboundDispatcher;
  let tail: ChatGatewayOutboundTail;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentroom-outbound-tail-"));
    store = new JsonlEventStore(join(tempDir, "events.jsonl"));
    service = new AgentRoomService(store, { roomId: ROOM_ID });
    gateway = new RecordingGateway("discord-main");
    dispatcher = new ChatGatewayOutboundDispatcher({
      service,
      routes: [mirrorRoute()],
      providerForRoute: () => gateway,
    });
    tail = new ChatGatewayOutboundTail({
      store,
      dispatcher,
      roomId: ROOM_ID,
    });
    await tail.start();
  });

  afterEach(async () => {
    await tail.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  // One poll buffers a freshly-seen message; the second flushes it past the
  // one-cycle inline-marker grace.
  async function pollTwice(): Promise<void> {
    await tail.poll();
    await tail.poll();
  }

  it("mirrors a CLI/MCP-authored message that bypassed the inline path", async () => {
    await service.postMessage({
      body: "from the cli",
      channelId: "implementation",
      sender: { kind: "agent", id: "impl-a" },
      kind: "chat",
    });

    await pollTwice();

    expect(gateway.sent).toEqual([
      expect.objectContaining({
        conversation: { id: "discord-channel-1", kind: "channel" },
        text: "from the cli",
      }),
    ]);
  });

  it("does not double-send a message already mirrored inline (chat.outbound_sent marker)", async () => {
    const message = await service.postMessage({
      body: "from http",
      channelId: "implementation",
      sender: { kind: "agent", id: "impl-a" },
      kind: "chat",
    });
    // Simulate the inline HTTP path having already dispatched + recorded it.
    await dispatcher.dispatchMessage(message);
    expect(gateway.sent).toHaveLength(1);

    await pollTwice();

    // The tail must observe the chat.outbound_sent marker and skip re-sending.
    expect(gateway.sent).toHaveLength(1);
  });

  it("never mirrors connector-sourced messages back out (echo-loop guard)", async () => {
    await service.postMessage({
      body: "echoed from discord",
      channelId: "implementation",
      sender: { kind: "connector", id: "discord-main:u-1" },
      kind: "chat",
    });

    await pollTwice();

    expect(gateway.sent).toEqual([]);
  });

  it("does not replay history posted before start()", async () => {
    // Post BEFORE re-anchoring the cursor to 'end'.
    await service.postMessage({
      body: "historical",
      channelId: "implementation",
      sender: { kind: "agent", id: "impl-a" },
      kind: "chat",
    });
    await tail.stop();
    await tail.start();

    await pollTwice();

    expect(gateway.sent).toEqual([]);
  });
});
