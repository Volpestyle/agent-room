import type {
  ChatGatewayAttribution,
  ChatCredentialKind,
  ChatGatewayAttachment,
  ChatGatewayConversation,
  ChatGatewayProvider,
  ChatGatewayUser,
  ChatInboundHandler,
  ChatInboundMessage,
  ChatMessageKind,
  ChatSendMessageInput,
  ChatSendMessageResult,
  ChatSendTypingInput,
} from "@agentroom/core";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type ClientOptions,
  type Message,
} from "discord.js";
import {
  applyDiscordUserTokenPatches,
  type DiscordUserTokenClientLike,
} from "./discordUserTokenPatches.js";

const DISCORD_MESSAGE_LIMIT = 2000;
const DEFAULT_WEBHOOK_NAME = "AgentRoom";

// Re-export discord.js primitives so downstream consumers (clanky-pi, etc.)
// resolve the SAME discord.js instance that discordUserTokenPatches.ts
// patches via createRequire. Without this, a second workspace that imports
// `discord.js` directly gets its own copy and the user-token READY patch
// silently fails to apply.
export {
  Client as DiscordClient,
  type ClientOptions as DiscordClientOptions,
  GatewayIntentBits as DiscordGatewayIntentBits,
  Partials as DiscordPartials,
} from "discord.js";
export { applyDiscordUserTokenPatches } from "./discordUserTokenPatches.js";

export interface DiscordChatGatewayProviderOptions {
  id?: string;
  token?: string;
  credentialKind?: Extract<ChatCredentialKind, "bot-token" | "user-token">;
  client?: DiscordGatewayClient;
  clientOptions?: ClientOptions;
  ignoreOwnMessages?: boolean;
  ignoreBotMessages?: boolean;
  webhookMode?: boolean;
  webhookName?: string;
  webhookAvatarUrl?: string;
  now?: () => string;
}

export interface DiscordGatewayClient extends DiscordUserTokenClientLike {
  user: { id?: string; username?: string; tag?: string } | null;
  channels: {
    fetch: (id: string) => Promise<unknown>;
    cache: { get: (id: string) => unknown };
  };
  on: (
    event: typeof Events.MessageCreate,
    listener: (message: Message) => void,
  ) => unknown;
  off: (
    event: typeof Events.MessageCreate,
    listener: (message: Message) => void,
  ) => unknown;
  login: (token: string) => Promise<string>;
  destroy: () => void;
  isReady: () => boolean;
}

export interface DiscordMessageLike {
  id: string;
  content?: string | null;
  channelId?: string | null;
  guildId?: string | null;
  createdTimestamp?: number;
  createdAt?: Date;
  author?: DiscordUserLike | null;
  member?: { displayName?: string | null } | null;
  channel?: DiscordChannelLike | null;
  mentions?: {
    users?: { has: (id: string) => boolean };
  } | null;
  reference?: { messageId?: string | null | undefined } | null;
  attachments?:
    | IterableCollection<DiscordAttachmentLike>
    | DiscordAttachmentLike[]
    | null;
}

export interface DiscordUserLike {
  id?: string | null;
  username?: string | null;
  globalName?: string | null;
  displayName?: string | null;
  tag?: string | null;
  bot?: boolean | null;
}

export interface DiscordChannelLike {
  id?: string | null;
  name?: string | null;
  guildId?: string | null;
  parentId?: string | null;
  parent?: { id?: string | null; name?: string | null } | null;
  isDMBased?: () => boolean;
  isThread?: () => boolean;
}

export interface DiscordAttachmentLike {
  id?: string | null;
  url?: string | null;
  contentType?: string | null;
  name?: string | null;
  description?: string | null;
  size?: number | null;
}

export class DiscordChatGatewayProvider implements ChatGatewayProvider {
  readonly id: string;
  readonly kind = "discord" as const;
  readonly credentialKind: Extract<
    ChatCredentialKind,
    "bot-token" | "user-token"
  >;

  private readonly token: string | undefined;
  private readonly client: DiscordGatewayClient;
  private readonly ignoreOwnMessages: boolean;
  private readonly ignoreBotMessages: boolean;
  private readonly webhookMode: boolean;
  private readonly webhookName: string;
  private readonly webhookAvatarUrl: string | undefined;
  private readonly now: () => string;
  private readonly webhooks = new Map<string, DiscordWebhook>();
  private handler: ChatInboundHandler | undefined;
  private messageListener: ((message: Message) => void) | undefined;
  private started = false;
  private lastError: string | undefined;

  constructor(options: DiscordChatGatewayProviderOptions = {}) {
    this.id = options.id ?? "discord";
    this.token = options.token;
    this.credentialKind = options.credentialKind ?? "bot-token";
    this.client = options.client ?? createDefaultClient(options.clientOptions);
    this.ignoreOwnMessages = options.ignoreOwnMessages ?? true;
    this.ignoreBotMessages = options.ignoreBotMessages ?? false;
    this.webhookMode = options.webhookMode ?? false;
    this.webhookName = options.webhookName ?? DEFAULT_WEBHOOK_NAME;
    this.webhookAvatarUrl = options.webhookAvatarUrl;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    if (this.lastError !== undefined)
      return { ok: false, message: this.lastError };
    if (this.client.isReady())
      return {
        ok: true,
        message: `${this.id} connected (${this.credentialKind})`,
      };
    if (this.started)
      return {
        ok: false,
        message: `${this.id} started but Discord client is not ready`,
      };
    return { ok: false, message: `${this.id} is not started` };
  }

  async start(handler: ChatInboundHandler): Promise<void> {
    if (this.started) return;
    if (!this.token)
      throw new Error(`Discord chat gateway '${this.id}' requires a token`);

    this.handler = handler;
    this.messageListener = (message) => {
      void this.handleDiscordMessage(message).catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
    };
    this.client.on(Events.MessageCreate, this.messageListener);

    if (this.credentialKind === "user-token") {
      applyDiscordUserTokenPatches(this.client);
    }

    await this.client.login(this.token);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.messageListener !== undefined) {
      this.client.off(Events.MessageCreate, this.messageListener);
    }
    this.client.destroy();
    this.started = false;
    this.handler = undefined;
    this.messageListener = undefined;
  }

  async sendMessage(
    input: ChatSendMessageInput,
  ): Promise<ChatSendMessageResult> {
    const useWebhook = this.webhookMode && input.attribution !== undefined;
    const channelId = useWebhook
      ? input.conversation.id
      : (input.conversation.threadId ?? input.conversation.id);
    const channel = await this.resolveChannel(channelId);
    if (!isSendableDiscordChannel(channel)) {
      throw new Error(`Discord conversation '${channelId}' is not sendable`);
    }
    const webhook =
      useWebhook && isWebhookCapableDiscordChannel(channel)
        ? await this.resolveWebhook(channelId, channel)
        : undefined;
    if (useWebhook && webhook === undefined) {
      throw new Error(
        `Discord conversation '${channelId}' does not support webhook-mode sends`,
      );
    }

    const text = appendAttachmentUrls(input.text, input.attachments);
    if (!text.trim())
      throw new Error("Discord message text or attachment URL is required");
    const chunks = splitDiscordMessage(text);
    let firstMessageId: string | undefined;

    for (let index = 0; index < chunks.length; index += 1) {
      const replyTo = index === 0 ? input.replyToExternalMessageId : undefined;
      const payload =
        webhook !== undefined
          ? buildWebhookSendPayload(
              chunks[index] ?? "",
              replyTo,
              input.attribution,
              input.conversation.threadId,
            )
          : buildSendPayload(chunks[index] ?? "", replyTo);
      const sent =
        webhook !== undefined
          ? await webhook.send(payload)
          : await channel.send(payload);
      if (firstMessageId === undefined) firstMessageId = sent.id;
    }

    return {
      externalMessageId: firstMessageId ?? "",
      ...(chunks.length > 1 ? { chunked: true } : {}),
      ...sendResultMetadata(chunks.length, webhook),
    };
  }

  async sendTyping(input: ChatSendTypingInput): Promise<void> {
    const channelId = input.conversation.threadId ?? input.conversation.id;
    const channel = await this.resolveChannel(channelId);
    if (!isTypingCapableDiscordChannel(channel)) {
      throw new Error(
        `Discord conversation '${channelId}' does not support typing indicators`,
      );
    }
    await channel.sendTyping();
  }

  private async handleDiscordMessage(message: Message): Promise<void> {
    if (!this.handler) return;
    const messageLike = message as unknown as DiscordMessageLike;
    if (!this.shouldHandleMessage(messageLike)) return;

    const inbound = buildDiscordInboundMessage({
      providerId: this.id,
      credentialKind: this.credentialKind,
      clientUserId: this.client.user?.id,
      message: messageLike,
      now: this.now,
    });
    if (!inbound) return;

    await this.handler(inbound);
  }

  private shouldHandleMessage(message: DiscordMessageLike): boolean {
    const authorId = String(message.author?.id ?? "").trim();
    if (this.ignoreOwnMessages && authorId && authorId === this.client.user?.id)
      return false;
    if (this.ignoreBotMessages && message.author?.bot === true) return false;
    return true;
  }

  private async resolveChannel(channelId: string): Promise<unknown> {
    const cached = this.client.channels.cache.get(channelId);
    if (cached !== undefined && cached !== null) return cached;
    return this.client.channels.fetch(channelId);
  }

  private async resolveWebhook(
    channelId: string,
    channel: DiscordWebhookCapableChannel,
  ): Promise<DiscordWebhook> {
    const cached = this.webhooks.get(channelId);
    if (cached !== undefined) return cached;

    const existing = valuesOf(await channel.fetchWebhooks()).find(
      (webhook) => webhook.name === this.webhookName,
    );
    const webhook =
      existing ??
      (await channel.createWebhook(
        createWebhookOptions(this.webhookName, this.webhookAvatarUrl),
      ));
    this.webhooks.set(channelId, webhook);
    return webhook;
  }
}

export function buildDiscordInboundMessage(input: {
  providerId: string;
  credentialKind: Extract<ChatCredentialKind, "bot-token" | "user-token">;
  clientUserId?: string | undefined;
  message: DiscordMessageLike;
  now?: () => string;
}): ChatInboundMessage | undefined {
  const conversation = buildConversation(input.message);
  if (!conversation) return undefined;

  const sender = buildSender(input.message);
  const attachments = buildAttachments(input.message.attachments);
  const text = String(input.message.content ?? "").trim();
  const kind = text ? "text" : (attachments[0]?.kind ?? "custom");
  const receivedAt =
    input.message.createdTimestamp !== undefined
      ? new Date(input.message.createdTimestamp).toISOString()
      : (input.message.createdAt?.toISOString() ??
        input.now?.() ??
        new Date().toISOString());
  const raw = buildRawMessageMetadata(input.message, sender.id);

  return {
    providerId: input.providerId,
    providerKind: "discord",
    credentialKind: input.credentialKind,
    externalMessageId: input.message.id,
    conversation,
    sender,
    text,
    kind,
    attachments,
    mentionsSelf: mentionsClient(
      input.message,
      conversation,
      input.clientUserId,
    ),
    ...(input.message.reference?.messageId
      ? { replyToExternalMessageId: input.message.reference.messageId }
      : {}),
    receivedAt,
    raw,
  };
}

export function splitDiscordMessage(text: string): string[] {
  const normalized = String(text || "").trim();
  if (!normalized) return [""];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > DISCORD_MESSAGE_LIMIT) {
    let cutAt = remaining.lastIndexOf("\n", DISCORD_MESSAGE_LIMIT);
    if (cutAt < DISCORD_MESSAGE_LIMIT * 0.5) {
      cutAt = remaining.lastIndexOf(" ", DISCORD_MESSAGE_LIMIT);
    }
    if (cutAt < 1) cutAt = DISCORD_MESSAGE_LIMIT;
    chunks.push(remaining.slice(0, cutAt).trimEnd());
    remaining = remaining.slice(cutAt).trimStart();
  }
  chunks.push(remaining);
  return chunks;
}

function createDefaultClient(options?: ClientOptions): DiscordGatewayClient {
  return new Client(
    options ?? {
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    },
  ) as DiscordGatewayClient;
}

function buildConversation(
  message: DiscordMessageLike,
): ChatGatewayConversation | undefined {
  const channelId = String(
    message.channelId ?? message.channel?.id ?? "",
  ).trim();
  if (!channelId) return undefined;

  const channel = message.channel;
  const isThread = channel?.isThread?.() === true;
  const isDm = channel?.isDMBased?.() === true;
  const parentId = String(
    channel?.parentId ?? channel?.parent?.id ?? "",
  ).trim();
  const conversation: ChatGatewayConversation = {
    id: isThread && parentId ? parentId : channelId,
    kind: isDm ? "dm" : isThread ? "thread" : "channel",
  };

  const guildId = String(message.guildId ?? channel?.guildId ?? "").trim();
  const displayName = String(channel?.name ?? "").trim();
  const parentName = String(channel?.parent?.name ?? "").trim();
  if (guildId) conversation.guildId = guildId;
  if (displayName) conversation.displayName = displayName;
  if (isThread) conversation.threadId = channelId;
  if (parentId) conversation.parentId = parentId;
  if (!displayName && parentName) conversation.displayName = parentName;
  return conversation;
}

function buildSender(message: DiscordMessageLike): ChatGatewayUser {
  const author = message.author;
  const id = String(author?.id ?? "unknown").trim() || "unknown";
  const username = String(author?.username ?? "").trim();
  const displayName = String(
    message.member?.displayName ??
      author?.displayName ??
      author?.globalName ??
      username,
  ).trim();
  const sender: ChatGatewayUser = { id };
  if (username) sender.username = username;
  if (displayName) sender.displayName = displayName;
  if (author?.bot !== undefined && author.bot !== null)
    sender.isBot = author.bot;
  return sender;
}

function buildAttachments(
  value: DiscordMessageLike["attachments"],
): ChatGatewayAttachment[] {
  return valuesOf(value).map((attachment) => {
    const mime = String(attachment.contentType ?? "").trim();
    const filename = String(attachment.name ?? "").trim();
    const url = String(attachment.url ?? "").trim();
    const item: ChatGatewayAttachment = {
      kind: classifyAttachment(mime, filename),
    };
    const id = String(attachment.id ?? "").trim();
    const caption = String(attachment.description ?? "").trim();
    if (id) item.id = id;
    if (url) item.url = url;
    if (mime) item.mime = mime;
    if (filename) item.filename = filename;
    if (caption) item.caption = caption;
    if (attachment.size !== undefined && attachment.size !== null)
      item.metadata = { size: attachment.size };
    return item;
  });
}

function classifyAttachment(
  mime: string,
  filename: string,
): Exclude<ChatMessageKind, "text"> {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  const lower = filename.toLowerCase();
  if (
    lower.endsWith(".png") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".webp")
  )
    return "image";
  if (
    lower.endsWith(".mp4") ||
    lower.endsWith(".mov") ||
    lower.endsWith(".webm")
  )
    return "video";
  if (
    lower.endsWith(".mp3") ||
    lower.endsWith(".wav") ||
    lower.endsWith(".ogg") ||
    lower.endsWith(".opus")
  )
    return "audio";
  return "document";
}

function mentionsClient(
  message: DiscordMessageLike,
  conversation: ChatGatewayConversation,
  clientUserId?: string,
): boolean {
  if (conversation.kind === "dm") return true;
  const userId = String(clientUserId ?? "").trim();
  if (!userId) return false;
  return message.mentions?.users?.has(userId) === true;
}

function buildRawMessageMetadata(
  message: DiscordMessageLike,
  authorId: string,
): Record<string, string> {
  const raw: Record<string, string> = { authorId };
  const guildId = String(message.guildId ?? "").trim();
  const channelId = String(
    message.channelId ?? message.channel?.id ?? "",
  ).trim();
  if (guildId) raw.guildId = guildId;
  if (channelId) raw.channelId = channelId;
  return raw;
}

function appendAttachmentUrls(
  text: string,
  attachments?: ChatGatewayAttachment[],
): string {
  const urls = (attachments ?? [])
    .map((attachment) => attachment.url)
    .filter((url): url is string => typeof url === "string" && url.length > 0);
  if (urls.length === 0) return text;
  const body = String(text || "").trim();
  return [body, ...urls].filter((part) => part.length > 0).join("\n");
}

function buildSendPayload(
  content: string,
  replyToExternalMessageId?: string,
): DiscordSendPayload {
  const payload: DiscordSendPayload = {
    content,
    allowedMentions: { parse: [], repliedUser: false },
  };
  if (
    replyToExternalMessageId !== undefined &&
    replyToExternalMessageId.length > 0
  ) {
    payload.reply = {
      messageReference: replyToExternalMessageId,
      failIfNotExists: false,
    };
  }
  return payload;
}

function buildWebhookSendPayload(
  content: string,
  replyToExternalMessageId: string | undefined,
  attribution: ChatGatewayAttribution | undefined,
  threadId?: string,
): DiscordWebhookSendPayload {
  const payload: DiscordWebhookSendPayload = {
    ...buildSendPayload(content, replyToExternalMessageId),
  };
  const username = usernameForAttribution(attribution);
  if (username !== undefined) payload.username = username;
  if (attribution?.avatarUrl !== undefined)
    payload.avatarURL = attribution.avatarUrl;
  if (threadId !== undefined) payload.threadId = threadId;
  return payload;
}

function usernameForAttribution(
  attribution: ChatGatewayAttribution | undefined,
): string | undefined {
  const username = String(
    attribution?.username ??
      attribution?.actor?.displayName ??
      attribution?.actor?.id ??
      "",
  ).trim();
  return username.length > 0 ? username.slice(0, 80) : undefined;
}

function createWebhookOptions(
  name: string,
  avatarUrl: string | undefined,
): DiscordCreateWebhookOptions {
  return {
    name,
    reason: "AgentRoom chat gateway attribution",
    ...(avatarUrl !== undefined ? { avatar: avatarUrl } : {}),
  };
}

function sendResultMetadata(
  chunkCount: number,
  webhook: DiscordWebhook | undefined,
): Pick<ChatSendMessageResult, "metadata"> {
  if (chunkCount <= 1 && webhook === undefined) return {};
  const metadata: Record<string, unknown> = {};
  if (chunkCount > 1) metadata.chunkCount = chunkCount;
  if (webhook !== undefined) {
    metadata.transport = "webhook";
    if (webhook.id !== undefined) metadata.webhookId = webhook.id;
  }
  return {
    metadata,
  };
}

function isSendableDiscordChannel(
  value: unknown,
): value is DiscordSendableChannel {
  if (!value || typeof value !== "object") return false;
  const candidate = value as DiscordSendableChannel;
  return typeof candidate.send === "function";
}

function isWebhookCapableDiscordChannel(
  value: unknown,
): value is DiscordWebhookCapableChannel {
  if (!value || typeof value !== "object") return false;
  const candidate = value as DiscordWebhookCapableChannel;
  return (
    typeof candidate.fetchWebhooks === "function" &&
    typeof candidate.createWebhook === "function"
  );
}

function isTypingCapableDiscordChannel(
  value: unknown,
): value is DiscordTypingCapableChannel {
  if (!value || typeof value !== "object") return false;
  const candidate = value as DiscordTypingCapableChannel;
  return typeof candidate.sendTyping === "function";
}

function valuesOf<T>(
  value: IterableCollection<T> | T[] | null | undefined,
): T[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.values === "function") return [...value.values()];
  return [];
}

interface IterableCollection<T> {
  values: () => IterableIterator<T>;
}

interface DiscordSendPayload {
  content: string;
  reply?: {
    messageReference: string;
    failIfNotExists: boolean;
  };
  allowedMentions: {
    parse: Array<"users" | "roles" | "everyone">;
    repliedUser: boolean;
  };
}

interface DiscordWebhookSendPayload extends DiscordSendPayload {
  username?: string;
  avatarURL?: string;
  threadId?: string;
}

interface DiscordCreateWebhookOptions {
  name: string;
  avatar?: string;
  reason?: string;
}

interface DiscordSentMessage {
  id: string;
}

interface DiscordSendableChannel {
  send: (payload: DiscordSendPayload) => Promise<DiscordSentMessage>;
}

interface DiscordTypingCapableChannel {
  sendTyping: () => Promise<void>;
}

interface DiscordWebhook {
  id?: string;
  name?: string | null;
  send: (payload: DiscordWebhookSendPayload) => Promise<DiscordSentMessage>;
}

interface DiscordWebhookCapableChannel {
  fetchWebhooks: () => Promise<
    IterableCollection<DiscordWebhook> | DiscordWebhook[]
  >;
  createWebhook: (
    options: DiscordCreateWebhookOptions,
  ) => Promise<DiscordWebhook>;
}
