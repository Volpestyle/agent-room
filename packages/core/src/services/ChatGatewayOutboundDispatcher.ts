import type { ActorRef, Message } from "../domain.js";
import type { RoomEvent } from "../events.js";
import type {
  ChatGatewayAttribution,
  ChatGatewayConversation,
  ChatGatewayProvider,
} from "../ports/ChatGatewayProvider.js";
import type { AgentRoomService } from "./AgentRoomService.js";
import type {
  ChatGatewayOutboundSource,
  ChatGatewayRoute,
} from "./ChatGatewayRouter.js";

export interface ChatGatewayOutboundDispatcherOptions {
  service: AgentRoomService;
  routes: ChatGatewayRoute[];
  providerForRoute: (
    route: ChatGatewayRoute,
  ) => ChatGatewayProvider | Promise<ChatGatewayProvider>;
  attributionForMessage?: (
    message: Message,
    route: ChatGatewayRoute,
  ) => ChatGatewayAttribution | undefined;
  ignoreConnectorMessages?: boolean;
}

export interface ChatGatewayOutboundDispatchResult {
  route: ChatGatewayRoute;
  providerId: string;
  conversationId: string;
  externalMessageId: string;
  chunked?: boolean;
}

export class ChatGatewayOutboundDispatcher {
  private readonly service: AgentRoomService;
  private readonly routes: ChatGatewayRoute[];
  private readonly providerForRoute: (
    route: ChatGatewayRoute,
  ) => ChatGatewayProvider | Promise<ChatGatewayProvider>;
  private readonly attributionForMessage: (
    message: Message,
    route: ChatGatewayRoute,
  ) => ChatGatewayAttribution | undefined;
  private readonly ignoreConnectorMessages: boolean;

  constructor(options: ChatGatewayOutboundDispatcherOptions) {
    this.service = options.service;
    this.routes = options.routes;
    this.providerForRoute = options.providerForRoute;
    this.attributionForMessage =
      options.attributionForMessage ?? defaultAttributionForMessage;
    this.ignoreConnectorMessages = options.ignoreConnectorMessages ?? true;
  }

  async dispatchEvent(
    event: RoomEvent,
  ): Promise<ChatGatewayOutboundDispatchResult[]> {
    if (event.type !== "message.posted") return [];
    return this.dispatchMessage(event.payload.message);
  }

  async dispatchMessage(
    message: Message,
  ): Promise<ChatGatewayOutboundDispatchResult[]> {
    if (this.ignoreConnectorMessages && message.sender.kind === "connector")
      return [];

    const results: ChatGatewayOutboundDispatchResult[] = [];
    for (const route of this.routes) {
      const source = outboundSourceForRoute(route);
      if (source === undefined || !matchesOutboundSource(message, source))
        continue;

      const provider = await this.providerForRoute(route);
      if (provider.id !== route.providerId) {
        throw new Error(
          `Chat provider '${provider.id}' does not match route provider '${route.providerId}'`,
        );
      }

      const attribution = this.attributionForMessage(message, route);
      const result = await provider.sendMessage({
        conversation: conversationForRoute(route),
        text: message.body,
        ...(attribution !== undefined ? { attribution } : {}),
        metadata: {
          roomId: message.roomId,
          messageId: message.id,
          channelId: message.channelId ?? "announcements",
          senderKind: message.sender.kind,
          senderId: message.sender.id,
        },
      });

      await this.service.recordChatOutbound({
        providerId: provider.id,
        conversationId: route.conversationId ?? "",
        result,
        text: message.body,
        messageId: message.id,
        source: message.sender,
        ...(attribution !== undefined ? { attribution } : {}),
      });

      results.push({
        route,
        providerId: provider.id,
        conversationId: route.conversationId ?? "",
        externalMessageId: result.externalMessageId,
        ...(result.chunked !== undefined ? { chunked: result.chunked } : {}),
      });
    }

    return results;
  }
}

export function outboundSourceForRoute(
  route: ChatGatewayRoute,
): ChatGatewayOutboundSource | undefined {
  if (route.outbound !== undefined) return route.outbound;
  switch (route.target.type) {
    case "room-channel":
      return { type: "room-channel", channelId: route.target.channelId };
    case "agent-dm":
      return { type: "agent-dm", agentId: route.target.agentId };
    case "agent-stdin":
      return undefined;
  }
}

function matchesOutboundSource(
  message: Message,
  source: ChatGatewayOutboundSource,
): boolean {
  switch (source.type) {
    case "room-channel":
      return (message.channelId ?? "announcements") === source.channelId;
    case "agent-dm":
      return (
        (message.channelId ?? "") === "dm" &&
        hasParticipant(message, { kind: "agent", id: source.agentId })
      );
    case "agent-message":
      return (
        message.sender.kind === "agent" &&
        message.sender.id === source.agentId &&
        (source.channelId === undefined ||
          (message.channelId ?? "announcements") === source.channelId)
      );
  }
}

function hasParticipant(message: Message, actor: ActorRef): boolean {
  return (
    sameActor(message.sender, actor) ||
    (message.recipients ?? []).some((recipient) => sameActor(recipient, actor))
  );
}

function sameActor(left: ActorRef, right: ActorRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function conversationForRoute(
  route: ChatGatewayRoute,
): ChatGatewayConversation {
  const conversation: ChatGatewayConversation = {
    // Empty when the route has no explicit channel — the gateway substitutes its
    // own default (Discord resolves "" to #general).
    id: route.conversationId ?? "",
    kind:
      route.conversationKind ??
      (route.threadId !== undefined ? "thread" : "channel"),
  };
  if (route.threadId !== undefined) conversation.threadId = route.threadId;
  return conversation;
}

function defaultAttributionForMessage(
  message: Message,
): ChatGatewayAttribution | undefined {
  if (message.sender.kind === "system" || message.sender.kind === "connector")
    return undefined;

  const attribution: ChatGatewayAttribution = {
    actor: message.sender,
  };
  const username = message.sender.displayName ?? message.sender.id;
  if (username) attribution.username = username;
  return attribution;
}
