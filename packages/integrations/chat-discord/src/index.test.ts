import { Events, type Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  DiscordChatGatewayProvider,
  buildDiscordInboundMessage,
  splitDiscordMessage,
  type DiscordGatewayClient,
  type DiscordMessageLike
} from './index.js';

describe('DiscordChatGatewayProvider', () => {
  it('normalizes Discord DMs into chat gateway messages', () => {
    const inbound = buildDiscordInboundMessage({
      providerId: 'discord-personal',
      credentialKind: 'user-token',
      clientUserId: 'self',
      message: {
        id: 'm-1',
        channelId: 'dm-1',
        content: 'hello clanky',
        createdTimestamp: Date.UTC(2026, 4, 25),
        author: { id: 'u-1', username: 'james', globalName: 'James' },
        channel: { id: 'dm-1', isDMBased: () => true },
        attachments: [{ id: 'a-1', url: 'https://cdn.example/image.png', contentType: 'image/png', name: 'image.png' }]
      }
    });

    expect(inbound).toMatchObject({
      providerId: 'discord-personal',
      providerKind: 'discord',
      credentialKind: 'user-token',
      conversation: { id: 'dm-1', kind: 'dm' },
      sender: { id: 'u-1', username: 'james', displayName: 'James' },
      text: 'hello clanky',
      kind: 'text',
      mentionsSelf: true,
      attachments: [{ kind: 'image', url: 'https://cdn.example/image.png', mime: 'image/png' }]
    });
  });

  it('normalizes thread messages with parent conversation routing keys', () => {
    const inbound = buildDiscordInboundMessage({
      providerId: 'discord-bot',
      credentialKind: 'bot-token',
      clientUserId: 'bot-1',
      message: {
        id: 'm-2',
        channelId: 'thread-1',
        guildId: 'guild-1',
        content: 'status?',
        author: { id: 'u-2', username: 'sam' },
        channel: {
          id: 'thread-1',
          guildId: 'guild-1',
          parentId: 'channel-1',
          name: 'task-thread',
          isThread: () => true
        },
        mentions: { users: { has: (id) => id === 'bot-1' } }
      }
    });

    expect(inbound).toMatchObject({
      conversation: {
        id: 'channel-1',
        kind: 'thread',
        threadId: 'thread-1',
        parentId: 'channel-1',
        guildId: 'guild-1',
        displayName: 'task-thread'
      },
      mentionsSelf: true
    });
  });

  it('splits outbound Discord messages at Discord limits', () => {
    const chunks = splitDiscordMessage(`${'a'.repeat(1990)}\n${'b'.repeat(50)}`);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.length).toBe(1990);
    expect(chunks[1]).toBe('b'.repeat(50));
  });

  it('sends chunked messages and replies only on the first chunk', async () => {
    const client = new FakeDiscordClient();
    const provider = new DiscordChatGatewayProvider({
      token: 'bot-token',
      client,
      credentialKind: 'bot-token'
    });

    const result = await provider.sendMessage({
      conversation: { id: 'channel-1', kind: 'channel' },
      text: `${'a'.repeat(2000)} ${'b'.repeat(5)}`,
      replyToExternalMessageId: 'parent-1'
    });

    expect(result).toEqual({ externalMessageId: 'sent-1', chunked: true, metadata: { chunkCount: 2 } });
    expect(client.sent).toHaveLength(2);
    expect(client.sent[0]).toMatchObject({
      content: 'a'.repeat(2000),
      reply: { messageReference: 'parent-1', failIfNotExists: false },
      allowedMentions: { parse: [], repliedUser: false }
    });
    expect(client.sent[1]).toMatchObject({
      content: 'b'.repeat(5),
      allowedMentions: { parse: [], repliedUser: false }
    });
    expect(client.sent[1]?.reply).toBeUndefined();
  });

  it('starts the client and forwards inbound messages to the handler', async () => {
    const client = new FakeDiscordClient();
    const provider = new DiscordChatGatewayProvider({
      id: 'discord-personal',
      token: 'user-token',
      credentialKind: 'user-token',
      client
    });
    const received: Array<string> = [];

    await provider.start((message: { text: string }) => {
      received.push(message.text);
    });
    client.emitMessage({
      id: 'm-1',
      channelId: 'dm-1',
      content: 'from phone',
      author: { id: 'u-1', username: 'james' },
      channel: { id: 'dm-1', isDMBased: () => true }
    });

    expect(client.loggedInToken).toBe('user-token');
    expect(received).toEqual(['from phone']);
  });
});

class FakeDiscordClient implements DiscordGatewayClient {
  readonly rest = {
    async resolveRequest() {
      return { fetchOptions: { headers: { Authorization: 'Bot token' } } };
    }
  };
  readonly ws = {
    _ws: null as unknown,
    shards: {
      first() {
        return { id: 0 };
      }
    }
  };
  readonly user = { id: 'self', username: 'clanky' };
  readonly sent: Array<{
    content: string;
    reply?: { messageReference: string; failIfNotExists: boolean };
    allowedMentions: { parse: string[]; repliedUser: boolean };
  }> = [];
  loggedInToken: string | undefined;
  private messageListener: ((message: Message) => void) | undefined;

  readonly channels = {
    fetch: async (_id: string): Promise<unknown> => this.channel,
    cache: {
      get: (_id: string): unknown => this.channel
    }
  };

  private readonly channel = {
    send: async (payload: {
      content: string;
      reply?: { messageReference: string; failIfNotExists: boolean };
      allowedMentions: { parse: string[]; repliedUser: boolean };
    }) => {
      this.sent.push(payload);
      return { id: `sent-${this.sent.length}` };
    }
  };

  on(event: typeof Events.MessageCreate, listener: (message: Message) => void): unknown {
    this.messageListener = listener;
    return this;
  }

  off(event: typeof Events.MessageCreate, listener: (message: Message) => void): unknown {
    if (this.messageListener === listener) this.messageListener = undefined;
    return this;
  }

  async login(token: string): Promise<string> {
    this.loggedInToken = token;
    return token;
  }

  destroy(): void {}

  isReady(): boolean {
    return this.loggedInToken !== undefined;
  }

  emitMessage(message: DiscordMessageLike): void {
    this.messageListener?.(message as Message);
  }
}
