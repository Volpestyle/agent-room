import type {
  ChatCredentialKind,
  ChatGatewayKind,
  ChatGatewayProvider,
  ChatGatewayRoute,
  ChatInboundHandler,
  ChatGatewayRouter,
  ChatSendMessageResult,
} from "@agentroom/core";
import { DiscordChatGatewayProvider } from "@agentroom/chat-discord";
import type {
  AgentRoomConfig,
  ChatGatewayConfig,
  ChatGatewayRouteConfig,
} from "@agentroom/config";

export type ChatGatewayFactory = (
  id: string,
  config: ChatGatewayConfig,
) => ChatGatewayProvider;

export interface ChatGatewayRegistryOptions {
  config?: AgentRoomConfig;
  env?: NodeJS.ProcessEnv;
  gatewayFactory?: ChatGatewayFactory;
  providers?: ChatGatewayProvider[];
  routes?: ChatGatewayRoute[];
  /** Fallback resolver for gateway tokens not present in `env` (e.g. the SecretStore). */
  resolveSecret?: (name: string) => string | undefined;
}

/**
 * Stand-in for a chat gateway that could not be constructed (e.g. a misconfigured
 * Discord gateway missing its token). It keeps the gateway visible in /health with
 * its failure reason instead of letting the throw crash the whole daemon.
 */
class FailedChatGatewayProvider implements ChatGatewayProvider {
  constructor(
    readonly id: string,
    readonly kind: ChatGatewayKind,
    readonly credentialKind: ChatCredentialKind,
    private readonly error: string,
  ) {}

  async health(): Promise<{ ok: boolean; message?: string }> {
    return { ok: false, message: this.error };
  }

  async start(): Promise<void> {
    throw new Error(this.error);
  }

  async stop(): Promise<void> {
    // nothing to tear down
  }

  async sendMessage(): Promise<ChatSendMessageResult> {
    throw new Error(`chat gateway '${this.id}' is unavailable: ${this.error}`);
  }
}

export class ChatGatewayRegistry {
  private readonly gateways = new Map<string, ChatGatewayProvider>();
  // Live routes array — the same reference handed to the router/dispatcher, so
  // rebuilding it in place applies route changes without a restart.
  private readonly routesList: ChatGatewayRoute[] = [];
  private readonly routeConfigs: Record<string, ChatGatewayRouteConfig>;
  private readonly optionRoutes: ChatGatewayRoute[];
  private readonly startupErrors = new Map<string, string>();
  private readonly gatewayConfigs: Record<string, ChatGatewayConfig>;
  private readonly factory: ChatGatewayFactory;
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolveSecret:
    | ((name: string) => string | undefined)
    | undefined;
  private inboundHandler: ChatInboundHandler | undefined;
  private started = false;

  constructor(options: ChatGatewayRegistryOptions = {}) {
    this.env = options.env ?? process.env;
    this.resolveSecret = options.resolveSecret;
    this.factory =
      options.gatewayFactory ??
      defaultChatGatewayFactory(this.env, this.resolveSecret);
    this.gatewayConfigs = options.config?.chat?.gateways ?? {};

    for (const [id, gatewayConfig] of Object.entries(this.gatewayConfigs)) {
      this.buildAndRegister(id, gatewayConfig);
    }
    for (const provider of options.providers ?? []) {
      this.register(provider);
    }

    this.routeConfigs = options.config?.chat?.routes ?? {};
    this.optionRoutes = options.routes ?? [];
    this.rebuildRoutes();
  }

  /** Rebuild the live routes array in place from the current route configs. */
  private rebuildRoutes(): void {
    const configuredRoutes = Object.values(this.routeConfigs).map(toRuntimeRoute);
    this.routesList.length = 0;
    this.routesList.push(...configuredRoutes, ...this.optionRoutes);
  }

  /**
   * Update (or clear) a configured route's target channel and apply it live.
   * Pass undefined/empty to clear it so the gateway falls back to its default
   * channel. Persisting to config.yaml is the caller's responsibility.
   */
  setRouteChannel(routeId: string, conversationId: string | undefined): void {
    const route = this.routeConfigs[routeId];
    if (!route) throw new Error(`Unknown chat route: ${routeId}`);
    if (conversationId === undefined || conversationId.trim() === "") {
      delete route.conversationId;
    } else {
      route.conversationId = conversationId.trim();
    }
    this.rebuildRoutes();
  }

  /** Configured routes (with their ids) for display/editing. */
  routeSummaries(): Array<{
    id: string;
    provider: string;
    conversationId?: string;
    conversationKind?: string;
  }> {
    return Object.entries(this.routeConfigs).map(([id, route]) => ({
      id,
      provider: route.provider,
      ...(route.conversationId !== undefined
        ? { conversationId: route.conversationId }
        : {}),
      ...(route.conversationKind !== undefined
        ? { conversationKind: route.conversationKind }
        : {}),
    }));
  }

  /**
   * Construct a gateway and register it. If construction throws (e.g. a
   * misconfigured Discord gateway missing its token), register a placeholder so
   * the failure surfaces in /health instead of crashing the daemon.
   */
  private buildAndRegister(
    id: string,
    gatewayConfig: ChatGatewayConfig,
  ): void {
    try {
      this.register(this.factory(id, gatewayConfig));
      this.startupErrors.delete(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.startupErrors.set(id, message);
      this.register(
        new FailedChatGatewayProvider(
          id,
          gatewayConfig.type,
          gatewayConfig.credentialKind ?? "bot-token",
          message,
        ),
      );
      console.error(
        `[chat-gateway] failed to construct gateway '${id}' (${gatewayConfig.type}): ${message}`,
      );
    }
  }

  register(provider: ChatGatewayProvider): void {
    this.gateways.set(provider.id, provider);
  }

  /** The env-var name a gateway's token is read from, and whether a value is available. */
  secretInfo(id: string): { tokenEnv?: string; secretConfigured: boolean } {
    const gatewayConfig = this.gatewayConfigs[id];
    if (!gatewayConfig) return { secretConfigured: true };
    const tokenEnv = gatewayConfig.tokenEnv;
    const fromEnv = this.env[tokenEnv];
    const configured =
      (fromEnv !== undefined && fromEnv !== "") ||
      Boolean(this.resolveSecret?.(tokenEnv));
    return { tokenEnv, secretConfigured: configured };
  }

  /** Rebuild a configured gateway (picking up a freshly-set secret) and restart it if running. */
  async reloadGateway(id: string): Promise<void> {
    const gatewayConfig = this.gatewayConfigs[id];
    if (!gatewayConfig) return;
    const existing = this.gateways.get(id);
    if (existing) {
      try {
        await existing.stop();
      } catch (error) {
        console.error(
          `[chat-gateway] error stopping gateway '${id}' during reload: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.buildAndRegister(id, gatewayConfig);
    if (this.started && this.inboundHandler) {
      const provider = this.gateways.get(id);
      if (provider) {
        try {
          await provider.start(this.inboundHandler);
          this.startupErrors.delete(id);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.startupErrors.set(id, message);
          console.error(
            `[chat-gateway] failed to start gateway '${id}' (${provider.kind}): ${message}`,
          );
        }
      }
    }
  }

  /** Reload every gateway whose token is read from the given env-var name. Returns affected ids. */
  async reloadGatewaysForSecret(name: string): Promise<string[]> {
    const affected = Object.entries(this.gatewayConfigs)
      .filter(([, gatewayConfig]) => gatewayConfig.tokenEnv === name)
      .map(([id]) => id);
    for (const id of affected) {
      await this.reloadGateway(id);
    }
    return affected;
  }

  listGateways(): ChatGatewayProvider[] {
    return [...this.gateways.values()];
  }

  gateway(id: string): ChatGatewayProvider {
    const provider = this.gateways.get(id);
    if (!provider) throw new Error(`Unknown chat gateway provider: ${id}`);
    return provider;
  }

  // Returns the live routes array (same reference the router/dispatcher hold) so
  // in-place rebuilds take effect without re-wiring. Callers must not mutate it.
  routes(): ChatGatewayRoute[] {
    return this.routesList;
  }

  startupError(id: string): string | undefined {
    return this.startupErrors.get(id);
  }

  async start(router: ChatGatewayRouter): Promise<void> {
    if (this.started) return;
    this.started = true;
    const handler: ChatInboundHandler = async (message) => {
      await router.handleInbound(message);
    };
    this.inboundHandler = handler;
    await Promise.all(
      this.listGateways().map(async (provider) => {
        try {
          await provider.start(handler);
          this.startupErrors.delete(provider.id);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.startupErrors.set(provider.id, message);
          console.error(
            `[chat-gateway] failed to start gateway '${provider.id}' (${provider.kind}): ${message}`,
          );
        }
      }),
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await Promise.all(
      this.listGateways().map(async (provider) => {
        try {
          await provider.stop();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(
            `[chat-gateway] error stopping gateway '${provider.id}' (${provider.kind}): ${message}`,
          );
        }
      }),
    );
  }
}

export function defaultChatGatewayFactory(
  env: NodeJS.ProcessEnv = process.env,
  resolveSecret?: (name: string) => string | undefined,
): ChatGatewayFactory {
  return (id, config) =>
    buildChatGatewayProvider(id, config, env, resolveSecret);
}

export function buildChatGatewayProvider(
  id: string,
  config: ChatGatewayConfig,
  env: NodeJS.ProcessEnv = process.env,
  resolveSecret?: (name: string) => string | undefined,
): ChatGatewayProvider {
  switch (config.type) {
    case "discord": {
      const token = env[config.tokenEnv] ?? resolveSecret?.(config.tokenEnv);
      if (token === undefined || token === "") {
        throw new Error(
          `Chat gateway '${id}' has no token — set '${config.tokenEnv}' in the TUI Settings view or as an environment variable`,
        );
      }
      return new DiscordChatGatewayProvider({
        id,
        token,
        credentialKind: config.credentialKind ?? "bot-token",
        webhookMode: config.webhookMode ?? false,
        ...(config.webhookName !== undefined
          ? { webhookName: config.webhookName }
          : {}),
        ...(config.webhookAvatarUrl !== undefined
          ? { webhookAvatarUrl: config.webhookAvatarUrl }
          : {}),
        ...(config.ignoreOwnMessages !== undefined
          ? { ignoreOwnMessages: config.ignoreOwnMessages }
          : {}),
        ...(config.ignoreBotMessages !== undefined
          ? { ignoreBotMessages: config.ignoreBotMessages }
          : {}),
      });
    }
  }
}

function toRuntimeRoute(route: ChatGatewayRouteConfig): ChatGatewayRoute {
  return {
    providerId: route.provider,
    ...(route.conversationId !== undefined
      ? { conversationId: route.conversationId }
      : {}),
    ...(route.conversationKind !== undefined
      ? { conversationKind: route.conversationKind }
      : {}),
    ...(route.threadId !== undefined ? { threadId: route.threadId } : {}),
    target: route.target,
    ...(route.outbound !== undefined ? { outbound: route.outbound } : {}),
  };
}
