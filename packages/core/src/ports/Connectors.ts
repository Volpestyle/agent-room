import type { ActorRef, Id, Importance, Ref, Task } from "../domain.js";

export interface WorkTrackerIssue {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkTrackerProvider {
  id: string;
  kind: "linear" | "github-issues" | "jira" | "custom";
  health(): Promise<{ ok: boolean; message?: string }>;
  createIssue(task: Task): Promise<WorkTrackerIssue>;
  updateIssueStatus(issueId: string, status: string): Promise<void>;
  comment(issueId: string, body: string, author?: ActorRef): Promise<void>;
}

export interface PullRequestRef {
  id: string;
  number: number;
  title: string;
  url: string;
  branch: string;
  status: "open" | "closed" | "merged";
}

export interface CodeHostProvider {
  id: string;
  kind: "github" | "gitlab" | "bitbucket" | "custom";
  health(): Promise<{ ok: boolean; message?: string }>;
  createPullRequest(input: {
    title: string;
    body: string;
    branch: string;
    base: string;
  }): Promise<PullRequestRef>;
  commentOnPullRequest(prId: string, body: string): Promise<void>;
}

export interface DesignProvider {
  id: string;
  kind: "figma" | "custom";
  health(): Promise<{ ok: boolean; message?: string }>;
  resolveRef(
    ref: Ref,
  ): Promise<{
    title: string;
    summary?: string;
    url?: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface NotificationProvider {
  id: string;
  kind: "telegram" | "discord" | "custom-app" | "email" | "webhook" | "custom";
  health(): Promise<{ ok: boolean; message?: string }>;
  notify(input: {
    roomId: Id;
    channelId?: string;
    recipients?: ActorRef[];
    title: string;
    body: string;
    priority?: Importance;
    refs?: Ref[];
  }): Promise<void>;
}

export type ChatGatewayKind =
  | "discord"
  | "telegram"
  | "sms"
  | "email"
  | "webhook"
  | "custom";

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
  | "voice"
  | "document"
  | "sticker"
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
