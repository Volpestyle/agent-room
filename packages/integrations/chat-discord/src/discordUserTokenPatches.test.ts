import { Client, GatewayIntentBits } from 'discord.js';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyDiscordUserTokenPatches,
  getDiscordUserAuthorizationHeaderValue,
  onRawDispatch,
  sendGatewayPayload,
  type DiscordUserTokenClientLike,
  type GatewayDispatchClientLike
} from './discordUserTokenPatches.js';

const require = createRequire(import.meta.url);
const DISCORD_JS_HANDLERS_PATH = (() => {
  try {
    return require.resolve('discord.js/src/client/websocket/handlers/index.js');
  } catch {
    try {
      return path.resolve(path.dirname(require.resolve('discord.js')), 'client/websocket/handlers/index.js');
    } catch {
      return path.resolve(process.cwd(), 'node_modules/discord.js/src/client/websocket/handlers/index.js');
    }
  }
})();

describe('discord user-token patches', () => {
  it('normalizes user-token authorization headers', () => {
    expect(getDiscordUserAuthorizationHeaderValue('  user_token_123  ')).toBe('user_token_123');
  });

  it('strips the Bot prefix from resolved REST auth', async () => {
    const client = createFakeClient();
    client.rest.setToken('user_token_123');
    applyDiscordUserTokenPatches(client);

    const result = await client.rest.resolveRequest({});

    expect(result.fetchOptions.headers.Authorization).toBe('user_token_123');
  });

  it('patches identify properties when discord.js creates the internal websocket manager', () => {
    const client = createFakeClient();
    applyDiscordUserTokenPatches(client);

    const fakeWsManager = createFakeWsManager(client.rest);
    client.ws._ws = fakeWsManager;

    expect(fakeWsManager.options.identifyProperties).toEqual({
      os: 'Windows',
      browser: 'Discord Client',
      device: ''
    });
  });

  it('uses the user gateway endpoint and synthesizes session limits', async () => {
    const client = createFakeClient();
    applyDiscordUserTokenPatches(client);

    const fakeWsManager = createFakeWsManager(client.rest);
    client.ws._ws = fakeWsManager;

    const result = await fakeWsManager.fetchGatewayInformation();

    expect(result.url).toBe('wss://gateway.discord.gg');
    expect(result.shards).toBe(1);
    expect(result.session_start_limit.total).toBe(1000);
    expect(client.rest.getRequests).toEqual(['/gateway']);
  });

  it('patches READY payload handling when user-token READY omits application', () => {
    const handlers = require(DISCORD_JS_HANDLERS_PATH) as {
      READY: (client: Client, packet: { d?: Record<string, unknown> }, shard: { id: number; checkReady: () => void }) => void;
    };
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    applyDiscordUserTokenPatches(client);

    expect(() => {
      handlers.READY(
        client,
        {
          d: {
            user: {
              id: '123456789012345678',
              username: 'selfbot-user',
              discriminator: '0',
              avatar: null,
              bot: false
            },
            guilds: []
          }
        },
        {
          id: 0,
          checkReady() {}
        }
      );
    }).not.toThrow();

    expect(client.application?.id).toBe('123456789012345678');
    expect(client.application?.name).toBe('selfbot-user');
  });

  it('sends raw gateway payloads through the first shard', () => {
    const client = createFakeClient();
    applyDiscordUserTokenPatches(client);

    const sent: Array<{ shardId: number; payload: unknown }> = [];
    const fakeWsManager = createFakeWsManager(client.rest, (shardId, payload) => {
      sent.push({ shardId, payload });
    });
    client.ws._ws = fakeWsManager;

    sendGatewayPayload(client, { op: 20, d: { stream_key: 'guild:123:456' } });

    expect(sent).toEqual([{ shardId: 0, payload: { op: 20, d: { stream_key: 'guild:123:456' } } }]);
  });

  it('routes raw gateway dispatch callbacks by event type', () => {
    const client = createFakeClient();
    const received: Array<Record<string, unknown>> = [];

    onRawDispatch(client, 'STREAM_CREATE', (data) => {
      received.push(data);
    });
    client.emit('raw', { t: 'STREAM_CREATE', d: { stream_key: 'guild:1:2' } });
    client.emit('raw', { t: 'MESSAGE_CREATE', d: { content: 'hi' } });

    expect(received).toEqual([{ stream_key: 'guild:1:2' }]);
  });
});

function createFakeClient() {
  const rest = createFakeRest();
  const listeners = new Map<string, Array<(packet: { t?: string; d?: Record<string, unknown> | null }) => void>>();
  return {
    rest,
    ws: {
      _ws: null as null | ReturnType<typeof createFakeWsManager>,
      shards: {
        first() {
          return { id: 0 };
        }
      }
    },
    on(event: string, callback: (packet: { t?: string; d?: Record<string, unknown> | null }) => void) {
      const callbacks = listeners.get(event) ?? [];
      callbacks.push(callback);
      listeners.set(event, callbacks);
    },
    off(event: string, callback: (packet: { t?: string; d?: Record<string, unknown> | null }) => void) {
      listeners.set(event, (listeners.get(event) ?? []).filter((listener) => listener !== callback));
    },
    emit(event: string, packet: { t?: string; d?: Record<string, unknown> | null }) {
      for (const callback of listeners.get(event) ?? []) callback(packet);
    }
  } satisfies DiscordUserTokenClientLike & GatewayDispatchClientLike & {
    rest: ReturnType<typeof createFakeRest>;
    ws: {
      _ws: null | ReturnType<typeof createFakeWsManager>;
      shards: { first: () => { id: number } };
    };
    emit: (event: string, packet: { t?: string; d?: Record<string, unknown> | null }) => void;
  };
}

function createFakeRest() {
  let storedToken: string | null = null;
  const getRequests: string[] = [];
  return {
    getRequests,
    setToken(token: string) {
      storedToken = token;
    },
    async resolveRequest(request: Record<string, unknown>) {
      const authPrefix = String(request.authPrefix ?? 'Bot');
      return {
        url: '/test',
        fetchOptions: {
          headers: {
            Authorization: `${authPrefix} ${storedToken ?? 'tok_abc'}`
          },
          method: 'GET'
        }
      };
    },
    async get(route: string) {
      getRequests.push(route);
      if (route === '/gateway') return { url: 'wss://gateway.discord.gg' };
      throw new Error(`unexpected route: ${route}`);
    }
  };
}

function createFakeWsManager(
  rest: ReturnType<typeof createFakeRest>,
  send: (shardId: number, payload: { op: number; d: unknown }) => void = () => {}
) {
  return {
    options: {
      identifyProperties: {
        browser: '@discordjs/ws',
        device: '@discordjs/ws',
        os: 'linux'
      },
      rest
    },
    gatewayInformation: null as null | {
      data: {
        url: string;
        shards: number;
        session_start_limit: {
          total: number;
          remaining: number;
          reset_after: number;
          max_concurrency: number;
        };
      };
      expiresAt: number;
    },
    async fetchGatewayInformation() {
      return {
        url: 'wss://gateway.discord.gg/bot',
        shards: 1,
        session_start_limit: {
          total: 1,
          remaining: 1,
          reset_after: 1,
          max_concurrency: 1
        }
      };
    },
    send
  };
}
