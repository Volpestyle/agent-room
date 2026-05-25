import type { ActorRef, RuntimeBinding } from "../domain.js";
import type { RuntimeProvider } from "../ports/RuntimeProvider.js";
import type {
  ChatConversationKind,
  ChatInboundMessage,
} from "../ports/Connectors.js";
import type { AgentRoomService } from "./AgentRoomService.js";

export type ChatRouteTarget =
  | { type: "room-channel"; channelId: string }
  | { type: "agent-dm"; agentId: string }
  | { type: "agent-stdin"; agentId: string };

export type ChatGatewayOutboundSource =
  | { type: "room-channel"; channelId: string }
  | { type: "agent-dm"; agentId: string }
  | { type: "agent-message"; agentId: string; channelId?: string };

export interface ChatGatewayRoute {
  providerId: string;
  conversationId: string;
  conversationKind?: ChatConversationKind;
  threadId?: string;
  target: ChatRouteTarget;
  outbound?: ChatGatewayOutboundSource;
}

export interface ChatGatewayRouterOptions {
  service: AgentRoomService;
  routes: ChatGatewayRoute[];
  runtimeProviderForBinding?: (
    binding: RuntimeBinding,
  ) => RuntimeProvider | Promise<RuntimeProvider>;
}

export interface ChatGatewayRouteResult {
  routed: boolean;
  route?: ChatGatewayRoute;
  reason?: string;
}

export class ChatGatewayRouter {
  private readonly service: AgentRoomService;
  private readonly routes: ChatGatewayRoute[];
  private readonly runtimeProviderForBinding:
    | ((binding: RuntimeBinding) => RuntimeProvider | Promise<RuntimeProvider>)
    | undefined;

  constructor(options: ChatGatewayRouterOptions) {
    this.service = options.service;
    this.routes = options.routes;
    this.runtimeProviderForBinding = options.runtimeProviderForBinding;
  }

  async handleInbound(
    message: ChatInboundMessage,
  ): Promise<ChatGatewayRouteResult> {
    const route = this.findRoute(message);
    if (!route) {
      await this.service.recordChatInbound({ message });
      return { routed: false, reason: "no_route" };
    }

    const routedTo = routeLabel(route);
    await this.service.recordChatInbound({ message, routedTo });

    switch (route.target.type) {
      case "room-channel":
        await this.service.postMessage({
          body: message.text,
          channelId: route.target.channelId,
          sender: connectorActor(message),
          kind: "chat",
        });
        return { routed: true, route };
      case "agent-dm":
        await this.service.postMessage({
          body: message.text,
          channelId: "dm",
          sender: connectorActor(message),
          recipients: [{ kind: "agent", id: route.target.agentId }],
          kind: "chat",
        });
        return { routed: true, route };
      case "agent-stdin":
        await this.sendToAgentStdin(route.target.agentId, message);
        return { routed: true, route };
    }
  }

  private findRoute(message: ChatInboundMessage): ChatGatewayRoute | undefined {
    return this.routes.find(
      (route) =>
        route.providerId === message.providerId &&
        route.conversationId === message.conversation.id &&
        (route.threadId === undefined ||
          route.threadId === message.conversation.threadId),
    );
  }

  private async sendToAgentStdin(
    agentId: string,
    message: ChatInboundMessage,
  ): Promise<void> {
    if (!this.runtimeProviderForBinding) {
      throw new Error(
        "agent-stdin chat routes require runtimeProviderForBinding",
      );
    }

    const binding = await this.service.getRuntimeBinding(agentId);
    if (!binding)
      throw new Error(
        `No runtime binding found for chat route target '${agentId}'`,
      );
    const provider = await this.runtimeProviderForBinding(binding);
    if (provider.id !== binding.providerId) {
      throw new Error(
        `Runtime provider '${provider.id}' does not match bound provider '${binding.providerId}' for '${agentId}'`,
      );
    }

    await provider.sendInput({
      agentId,
      bindingId: binding.bindingId,
      text: message.text,
      source: connectorActor(message),
    });
    await this.service.recordRuntimeInput({
      agentId,
      text: message.text,
      source: connectorActor(message),
    });
  }
}

function connectorActor(message: ChatInboundMessage): ActorRef {
  return {
    kind: "connector",
    id: `${message.providerId}:${message.sender.id}`,
    ...(message.sender.displayName !== undefined
      ? { displayName: message.sender.displayName }
      : {}),
  };
}

function routeLabel(route: ChatGatewayRoute): string {
  switch (route.target.type) {
    case "room-channel":
      return `room-channel:${route.target.channelId}`;
    case "agent-dm":
      return `agent-dm:${route.target.agentId}`;
    case "agent-stdin":
      return `agent-stdin:${route.target.agentId}`;
  }
}
