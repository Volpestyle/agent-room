import type {
  ChatGatewayProvider,
  ChatGatewayRoute,
  ChatInboundHandler,
  ChatGatewayRouter,
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
}

export class ChatGatewayRegistry {
  private readonly gateways = new Map<string, ChatGatewayProvider>();
  private readonly routesList: ChatGatewayRoute[];
  private readonly startupErrors = new Map<string, string>();
  private started = false;

  constructor(options: ChatGatewayRegistryOptions = {}) {
    const env = options.env ?? process.env;
    const factory = options.gatewayFactory ?? defaultChatGatewayFactory(env);

    for (const [id, gatewayConfig] of Object.entries(
      options.config?.chat?.gateways ?? {},
    )) {
      this.register(factory(id, gatewayConfig));
    }
    for (const provider of options.providers ?? []) {
      this.register(provider);
    }

    const configuredRoutes = Object.values(
      options.config?.chat?.routes ?? {},
    ).map(toRuntimeRoute);
    this.routesList = [...configuredRoutes, ...(options.routes ?? [])];
  }

  register(provider: ChatGatewayProvider): void {
    this.gateways.set(provider.id, provider);
  }

  listGateways(): ChatGatewayProvider[] {
    return [...this.gateways.values()];
  }

  gateway(id: string): ChatGatewayProvider {
    const provider = this.gateways.get(id);
    if (!provider) throw new Error(`Unknown chat gateway provider: ${id}`);
    return provider;
  }

  routes(): ChatGatewayRoute[] {
    return [...this.routesList];
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
): ChatGatewayFactory {
  return (id, config) => buildChatGatewayProvider(id, config, env);
}

export function buildChatGatewayProvider(
  id: string,
  config: ChatGatewayConfig,
  env: NodeJS.ProcessEnv = process.env,
): ChatGatewayProvider {
  switch (config.type) {
    case "discord": {
      const token = env[config.tokenEnv];
      if (token === undefined || token === "") {
        throw new Error(
          `Chat gateway '${id}' requires env var '${config.tokenEnv}' to be set`,
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
    conversationId: route.conversationId,
    ...(route.conversationKind !== undefined
      ? { conversationKind: route.conversationKind }
      : {}),
    ...(route.threadId !== undefined ? { threadId: route.threadId } : {}),
    target: route.target,
    ...(route.outbound !== undefined ? { outbound: route.outbound } : {}),
  };
}
