import { createRequire } from 'node:module';
import path from 'node:path';

const DISCORD_USER_IDENTIFY_PROPERTIES = {
  os: 'Windows',
  browser: 'Discord Client',
  device: ''
};

const require = createRequire(import.meta.url);

export interface DiscordUserTokenClientLike {
  rest: unknown;
  ws: unknown;
}

export interface GatewayDispatchClientLike {
  on: (event: string, callback: GatewayRawDispatchListener) => void;
  off?: (event: string, callback: GatewayRawDispatchListener) => void;
  removeListener?: (event: string, callback: GatewayRawDispatchListener) => void;
  ws: {
    _ws?: {
      send: (shardId: number, payload: { op: number; d: unknown }) => void;
    } | null;
    shards: {
      first: () => { id?: number } | null | undefined;
    };
  };
}

type GatewayRawDispatchPacket = {
  t?: string;
  d?: Record<string, unknown> | null;
};

type GatewayRawDispatchListener = (packet: GatewayRawDispatchPacket, shardId?: number) => void;

export function getDiscordUserAuthorizationHeaderValue(token: string): string {
  return String(token || '').trim();
}

export function applyDiscordUserTokenPatches(client: DiscordUserTokenClientLike): void {
  patchRestAuth(client);
  patchReadyHandlerForUserTokenPayload();
  patchInternalWebSocketManager(client);
}

export function sendGatewayPayload(
  client: GatewayDispatchClientLike,
  payload: { op: number; d: unknown }
): void {
  const shardId = client.ws.shards.first()?.id ?? 0;
  client.ws._ws?.send(shardId, payload);
}

export function onRawDispatch(
  client: GatewayDispatchClientLike,
  eventName: string,
  callback: (data: Record<string, unknown>) => void
): () => void {
  const listener: GatewayRawDispatchListener = (packet) => {
    if (!packet || packet.t !== eventName) return;
    if (!packet.d || typeof packet.d !== 'object' || Array.isArray(packet.d)) return;
    callback(packet.d);
  };
  client.on('raw', listener);
  return () => {
    if (typeof client.off === 'function') {
      client.off('raw', listener);
      return;
    }
    if (typeof client.removeListener === 'function') {
      client.removeListener('raw', listener);
    }
  };
}

function patchRestAuth(client: DiscordUserTokenClientLike): void {
  const rest = coerceRest(client.rest);
  if (!rest) return;

  const originalResolveRequest = rest.resolveRequest;
  rest.resolveRequest = async function (request: Record<string, unknown>) {
    const result = await Promise.resolve(originalResolveRequest.call(rest, request));
    const headers = result?.fetchOptions?.headers;
    if (typeof headers?.Authorization === 'string' && headers.Authorization.startsWith('Bot ')) {
      headers.Authorization = getDiscordUserAuthorizationHeaderValue(headers.Authorization.slice(4));
    }
    return result;
  };
}

function patchInternalWebSocketManager(client: DiscordUserTokenClientLike): void {
  const ws = coerceWebSocketManagerHost(client.ws);
  if (!ws) return;

  let wsInner: InternalWSManager | null = coerceInternalWsManager(ws._ws);

  Object.defineProperty(ws, '_ws', {
    get() {
      return wsInner;
    },
    set(value: unknown) {
      const nextWs = coerceInternalWsManager(value);
      wsInner = nextWs;
      if (nextWs?.options) {
        nextWs.options.identifyProperties = { ...DISCORD_USER_IDENTIFY_PROPERTIES };
        patchFetchGatewayInformation(nextWs);
      }
    },
    configurable: true,
    enumerable: true
  });
}

function patchFetchGatewayInformation(wsManager: InternalWSManager): void {
  wsManager.fetchGatewayInformation = async function (force = false) {
    if (this.gatewayInformation) {
      if (this.gatewayInformation.expiresAt <= Date.now()) {
        this.gatewayInformation = null;
      } else if (!force) {
        return this.gatewayInformation.data;
      }
    }

    const data = (await this.options.rest.get('/gateway')) as GatewayResponse;
    const enriched: GatewayBotResponse = {
      url: data.url,
      shards: 1,
      session_start_limit: {
        total: 1000,
        remaining: 1000,
        reset_after: 14_400_000,
        max_concurrency: 1
      }
    };
    this.gatewayInformation = {
      data: enriched,
      expiresAt: Date.now() + enriched.session_start_limit.reset_after
    };
    return this.gatewayInformation.data;
  };
}

function patchReadyHandlerForUserTokenPayload(): void {
  const handlers = require(resolveDiscordJsHandlersPath()) as {
    READY?: ReadyHandler;
  };
  const originalReady = handlers.READY;
  if (typeof originalReady !== 'function' || originalReady.__agentroomUserTokenPatched) return;

  const patchedReady: ReadyHandler = function (client: unknown, packet: ReadyPacket, shard: { id: number }) {
    const data = packet?.d;
    if (data && (!data.application || typeof data.application !== 'object')) {
      packet = {
        ...packet,
        d: {
          ...data,
          application: buildSyntheticReadyApplication(data)
        }
      };
    }
    return originalReady(client, packet, shard);
  };
  patchedReady.__agentroomUserTokenPatched = true;
  handlers.READY = patchedReady;
}

function resolveDiscordJsHandlersPath(): string {
  try {
    return require.resolve('discord.js/src/client/websocket/handlers/index.js');
  } catch {
    try {
      return path.resolve(path.dirname(require.resolve('discord.js')), 'client/websocket/handlers/index.js');
    } catch {
      return path.resolve(process.cwd(), 'node_modules/discord.js/src/client/websocket/handlers/index.js');
    }
  }
}

function buildSyntheticReadyApplication(data: Record<string, unknown>): Record<string, unknown> {
  const rawUser = data.user;
  const user = rawUser && typeof rawUser === 'object' && !Array.isArray(rawUser) ? rawUser as Record<string, unknown> : null;
  const userId = String(user?.id || '').trim() || '0';
  const username = String(user?.username || '').trim() || 'Discord User';
  return {
    id: userId,
    name: username,
    description: '',
    icon: null,
    flags: 0,
    bot_public: false,
    bot_require_code_grant: false
  };
}

function coerceRest(value: unknown): RestLike | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as RestLike;
  if (typeof candidate.resolveRequest !== 'function') return null;
  return candidate;
}

function coerceWebSocketManagerHost(value: unknown): WebSocketManagerHost | null {
  if (!value || typeof value !== 'object') return null;
  return value as WebSocketManagerHost;
}

function coerceInternalWsManager(value: unknown): InternalWSManager | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as InternalWSManager;
  if (!candidate.options || typeof candidate.options !== 'object') return null;
  if (typeof candidate.fetchGatewayInformation !== 'function') return null;
  return candidate;
}

interface RestResolveRequestResult {
  url?: string;
  fetchOptions?: {
    headers?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface RestLike {
  resolveRequest: (this: RestLike, request: Record<string, unknown>) => Promise<RestResolveRequestResult> | RestResolveRequestResult;
}

interface WebSocketManagerHost {
  _ws?: unknown;
}

interface InternalWSManager {
  options: {
    identifyProperties: { os: string; browser: string; device: string };
    rest: { get: (route: string) => Promise<unknown> };
    [key: string]: unknown;
  };
  gatewayInformation: {
    data: GatewayBotResponse;
    expiresAt: number;
  } | null;
  fetchGatewayInformation: (this: InternalWSManager, force?: boolean) => Promise<GatewayBotResponse>;
  send: (shardId: number, payload: { op: number; d: unknown }) => void;
}

interface GatewayResponse {
  url: string;
}

interface GatewayBotResponse {
  url: string;
  shards: number;
  session_start_limit: {
    total: number;
    remaining: number;
    reset_after: number;
    max_concurrency: number;
  };
}

type ReadyPacket = {
  d?: Record<string, unknown>;
};

type ReadyHandler = ((client: unknown, packet: ReadyPacket, shard: { id: number }) => void) & {
  __agentroomUserTokenPatched?: boolean;
};
