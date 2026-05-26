import { describe, expect, it } from 'vitest';
import type {
  AgentOutput,
  EventBatch,
  EventCursor,
  EventCursorPosition,
  EventStore,
  ReadAgentRequest,
  RoomEvent,
  RuntimeAgent,
  RuntimeCapabilities,
  RuntimeEventHandler,
  RuntimeHealth,
  RuntimeProvider,
  RuntimeSession,
  RuntimeSubscription,
  SendInputRequest,
  StartAgentRequest
} from '../index.js';
import { nowIso } from '../index.js';
import type { ChatInboundMessage } from '../ports/Connectors.js';
import { AgentRoomService } from './AgentRoomService.js';
import { ChatGatewayRouter } from './ChatGatewayRouter.js';

class TestStore implements EventStore {
  readonly events: RoomEvent[] = [];
  async append(event: RoomEvent) {
    this.events.push(event);
  }
  async appendMany(events: RoomEvent[]) {
    this.events.push(...events);
  }
  async cursor(position: EventCursorPosition = 'end'): Promise<EventCursor> {
    return { position: position === 'start' ? 0 : this.events.length };
  }
  async listFromCursor(cursor: EventCursor): Promise<EventBatch> {
    const start = Math.max(0, Math.min(cursor.position, this.events.length));
    return {
      events: this.events.slice(start),
      cursor: { position: this.events.length }
    };
  }
  async list() {
    return this.events;
  }
}

class TestRuntimeProvider implements RuntimeProvider {
  readonly id = 'fake-runtime';
  readonly kind = 'fake' as const;
  readonly capabilities: RuntimeCapabilities = {
    startAgent: false,
    stopAgent: false,
    readOutput: false,
    sendInput: true,
    attachInteractive: false,
    subscribeEvents: false,
    semanticAgentState: false,
    screenshots: false,
    fileMounts: false,
    worktrees: false,
    remoteExecution: false,
    adoptAgent: false
  };
  readonly inputs: SendInputRequest[] = [];

  async health(): Promise<RuntimeHealth> {
    return { ok: true, status: 'ok' };
  }
  async listSessions(): Promise<RuntimeSession[]> {
    return [];
  }
  async listAgents(): Promise<RuntimeAgent[]> {
    return [];
  }
  async startAgent(_request: StartAgentRequest): Promise<RuntimeAgent> {
    throw new Error('not implemented');
  }
  async stopAgent(_agentId: string): Promise<void> {}
  async readAgent(request: ReadAgentRequest): Promise<AgentOutput> {
    return { agentId: request.agentId, text: '', observedAt: nowIso() };
  }
  async sendInput(request: SendInputRequest): Promise<void> {
    this.inputs.push(request);
  }
  async subscribeEvents(_handler: RuntimeEventHandler): Promise<RuntimeSubscription> {
    return { close: async () => {} };
  }
}

describe('ChatGatewayRouter', () => {
  it('records unrouted inbound chat messages', async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: 'room-test' });
    const router = new ChatGatewayRouter({ service, routes: [] });

    await expect(router.handleInbound(chatMessage({ conversationId: 'unknown' }))).resolves.toEqual({
      routed: false,
      reason: 'no_route'
    });

    expect(store.events.map((event) => event.type)).toEqual(['chat.inbound_received']);
    expect(store.events[0]).toMatchObject({
      payload: {
        message: {
          conversation: { id: 'unknown' },
          text: 'hello from discord'
        }
      }
    });
  });

  it('routes inbound chat to a room channel', async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: 'room-test' });
    const router = new ChatGatewayRouter({
      service,
      routes: [
        {
          providerId: 'discord-personal',
          conversationId: 'dm-1',
          target: { type: 'room-channel', channelId: 'phone' }
        }
      ]
    });

    const result = await router.handleInbound(chatMessage({ conversationId: 'dm-1' }));

    expect(result.routed).toBe(true);
    expect(store.events.map((event) => event.type)).toEqual(['chat.inbound_received', 'message.posted']);
    expect(store.events[0]).toMatchObject({ payload: { routedTo: 'room-channel:phone' } });
    expect(store.events[1]).toMatchObject({
      payload: {
        message: {
          channelId: 'phone',
          body: 'hello from discord',
          sender: { kind: 'connector', id: 'discord-personal:u-1', displayName: 'James' }
        }
      }
    });
  });

  it('routes inbound chat to a runtime-backed agent stdin', async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: 'room-test' });
    const runtime = new TestRuntimeProvider();
    await service.bindRuntime({
      agentId: 'clanky',
      runtime: { providerId: runtime.id, bindingId: 'pane-1', kind: 'pane' }
    });
    const router = new ChatGatewayRouter({
      service,
      routes: [
        {
          providerId: 'discord-personal',
          conversationId: 'dm-1',
          target: { type: 'agent-stdin', agentId: 'clanky' }
        }
      ],
      runtimeProviderForBinding: () => runtime
    });

    const result = await router.handleInbound(chatMessage({ conversationId: 'dm-1', text: 'run the plan' }));

    expect(result.routed).toBe(true);
    expect(runtime.inputs).toEqual([
      {
        agentId: 'clanky',
        bindingId: 'pane-1',
        text: 'run the plan',
        source: { kind: 'connector', id: 'discord-personal:u-1', displayName: 'James' }
      }
    ]);
    expect(store.events.map((event) => event.type)).toEqual([
      'runtime.bound',
      'chat.inbound_received',
      'runtime.input_sent'
    ]);
    expect(store.events[1]).toMatchObject({ payload: { routedTo: 'agent-stdin:clanky' } });
    expect(store.events[2]).toMatchObject({
      payload: {
        agentId: 'clanky',
        text: 'run the plan',
        source: 'discord-personal:u-1'
      }
    });
  });
});

function chatMessage(input: { conversationId: string; text?: string }): ChatInboundMessage {
  return {
    providerId: 'discord-personal',
    providerKind: 'discord',
    credentialKind: 'user-token',
    externalMessageId: 'm-1',
    conversation: { id: input.conversationId, kind: 'dm' },
    sender: { id: 'u-1', username: 'james', displayName: 'James' },
    text: input.text ?? 'hello from discord',
    kind: 'text',
    attachments: [],
    mentionsSelf: true,
    receivedAt: '2026-05-25T00:00:00.000Z'
  };
}
