import type { ActorRef } from "../domain.js";

export type ChatGatewayKind = "discord" | "webhook" | "custom";

export type ChatCredentialKind =
  | "bot-token"
  | "user-token"
  | "webhook"
  | "custom";

export type ChatConversationKind =
  | "dm"
  | "channel"
  | "group"
  | "thread"
  | "custom";

export type ChatMessageKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "custom";

export interface ChatGatewayUser {
  id: string;
  username?: string;
  displayName?: string;
  isBot?: boolean;
}

export interface ChatGatewayConversation {
  id: string;
  kind: ChatConversationKind;
  threadId?: string;
  parentId?: string;
  guildId?: string;
  displayName?: string;
}

export interface ChatGatewayAttachment {
  kind: Exclude<ChatMessageKind, "text">;
  id?: string;
  url?: string;
  mime?: string;
  filename?: string;
  caption?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatGatewayAttribution {
  actor?: ActorRef;
  username?: string;
  avatarUrl?: string;
}

export interface ChatInboundMessage {
  providerId: string;
  providerKind: ChatGatewayKind;
  credentialKind: ChatCredentialKind;
  externalMessageId: string;
  conversation: ChatGatewayConversation;
  sender: ChatGatewayUser;
  text: string;
  kind: ChatMessageKind;
  attachments: ChatGatewayAttachment[];
  mentionsSelf: boolean;
  replyToExternalMessageId?: string;
  receivedAt: string;
  raw?: unknown;
}

export interface ChatSendMessageInput {
  conversation: ChatGatewayConversation;
  text: string;
  replyToExternalMessageId?: string;
  attachments?: ChatGatewayAttachment[];
  attribution?: ChatGatewayAttribution;
  metadata?: Record<string, unknown>;
}

export interface ChatSendMessageResult {
  externalMessageId: string;
  chunked?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ChatSendTypingInput {
  conversation: ChatGatewayConversation;
  metadata?: Record<string, unknown>;
}

export type ChatInboundHandler = (
  message: ChatInboundMessage,
) => void | Promise<void>;

export interface ChatGatewayProvider {
  id: string;
  kind: ChatGatewayKind;
  credentialKind: ChatCredentialKind;
  health(): Promise<{ ok: boolean; message?: string }>;
  start(handler: ChatInboundHandler): Promise<void>;
  stop(): Promise<void>;
  sendMessage(input: ChatSendMessageInput): Promise<ChatSendMessageResult>;
  sendTyping?(input: ChatSendTypingInput): Promise<void>;
}
