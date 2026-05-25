import { describe, expect, it } from "vitest";
import type {
  ChatGatewayProvider,
  ChatSendMessageInput,
  ChatSendMessageResult,
  EventBatch,
  EventCursor,
  EventCursorPosition,
  EventStore,
  RoomEvent,
} from "../index.js";
import { AgentRoomService } from "./AgentRoomService.js";
import { ChatGatewayOutboundDispatcher } from "./ChatGatewayOutboundDispatcher.js";

class TestStore implements EventStore {
  readonly events: RoomEvent[] = [];
  async append(event: RoomEvent) {
    this.events.push(event);
  }
  async appendMany(events: RoomEvent[]) {
    this.events.push(...events);
  }
  async cursor(position: EventCursorPosition = "end"): Promise<EventCursor> {
    return { position: position === "start" ? 0 : this.events.length };
  }
  async listFromCursor(cursor: EventCursor): Promise<EventBatch> {
    const start = Math.max(0, Math.min(cursor.position, this.events.length));
    return {
      events: this.events.slice(start),
      cursor: { position: this.events.length },
    };
  }
  async list() {
    return this.events;
  }
}

class TestChatProvider implements ChatGatewayProvider {
  readonly id = "discord-main";
  readonly kind = "discord" as const;
  readonly credentialKind = "bot-token" as const;
  readonly sent: ChatSendMessageInput[] = [];

  async health(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(
    input: ChatSendMessageInput,
  ): Promise<ChatSendMessageResult> {
    this.sent.push(input);
    return { externalMessageId: `external-${this.sent.length}` };
  }
}

describe("ChatGatewayOutboundDispatcher", () => {
  it("mirrors room channel messages to matching gateway conversations with attribution", async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: "room-test" });
    const provider = new TestChatProvider();
    const dispatcher = new ChatGatewayOutboundDispatcher({
      service,
      routes: [
        {
          providerId: provider.id,
          conversationId: "discord-channel-1",
          target: { type: "room-channel", channelId: "implementation" },
        },
      ],
      providerForRoute: () => provider,
    });

    const message = await service.postMessage({
      channelId: "implementation",
      body: "patch is ready",
      sender: {
        kind: "agent",
        id: "clanky-impl-a",
        displayName: "clanky-impl-a",
      },
      kind: "status",
    });

    const result = await dispatcher.dispatchMessage(message);

    expect(result).toHaveLength(1);
    expect(provider.sent).toEqual([
      {
        conversation: { id: "discord-channel-1", kind: "channel" },
        text: "patch is ready",
        attribution: {
          actor: {
            kind: "agent",
            id: "clanky-impl-a",
            displayName: "clanky-impl-a",
          },
          username: "clanky-impl-a",
        },
        metadata: {
          roomId: "room-test",
          messageId: message.id,
          channelId: "implementation",
          senderKind: "agent",
          senderId: "clanky-impl-a",
        },
      },
    ]);
    expect(store.events.map((event) => event.type)).toEqual([
      "message.posted",
      "chat.outbound_sent",
    ]);
    expect(store.events[1]).toMatchObject({
      payload: {
        providerId: provider.id,
        conversationId: "discord-channel-1",
        text: "patch is ready",
        source: { kind: "agent", id: "clanky-impl-a" },
        attribution: { username: "clanky-impl-a" },
      },
    });
  });

  it("does not echo connector-authored inbound room messages by default", async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: "room-test" });
    const provider = new TestChatProvider();
    const dispatcher = new ChatGatewayOutboundDispatcher({
      service,
      routes: [
        {
          providerId: provider.id,
          conversationId: "discord-channel-1",
          target: { type: "room-channel", channelId: "implementation" },
        },
      ],
      providerForRoute: () => provider,
    });
    const message = await service.postMessage({
      channelId: "implementation",
      body: "from discord",
      sender: {
        kind: "connector",
        id: "discord-main:u-1",
        displayName: "James",
      },
    });

    await expect(dispatcher.dispatchMessage(message)).resolves.toEqual([]);
    expect(provider.sent).toEqual([]);
    expect(store.events.map((event) => event.type)).toEqual(["message.posted"]);
  });

  it("supports explicit outbound sources for lead-as-public-face routing", async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: "room-test" });
    const provider = new TestChatProvider();
    const dispatcher = new ChatGatewayOutboundDispatcher({
      service,
      routes: [
        {
          providerId: provider.id,
          conversationId: "discord-channel-1",
          target: { type: "agent-stdin", agentId: "clanky-lead" },
          outbound: {
            type: "agent-message",
            agentId: "clanky-lead",
            channelId: "implementation",
          },
        },
      ],
      providerForRoute: () => provider,
    });

    const message = await service.postMessage({
      channelId: "implementation",
      body: "I delegated this to impl-a",
      sender: { kind: "agent", id: "clanky-lead" },
      kind: "chat",
    });

    await expect(dispatcher.dispatchMessage(message)).resolves.toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({
      conversation: { id: "discord-channel-1", kind: "channel" },
      text: "I delegated this to impl-a",
      attribution: { username: "clanky-lead" },
    });
  });
});
