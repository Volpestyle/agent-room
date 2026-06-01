import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { KnownProvider } from "@earendil-works/pi-ai";

export type DashboardLogLevel = "debug" | "info" | "warn" | "error";

export interface DashboardAgentLogContext {
  agentId: string;
  roomId: string;
  cwd: string;
  provider?: KnownProvider;
  modelId?: string;
  modelSource?: string;
  requestedThinkingLevel?: string;
  thinkingLevel?: string;
}

export interface DashboardLogEntry {
  timestamp: string;
  sessionId: string;
  sequence: number;
  level: DashboardLogLevel;
  event: string;
  summary: string;
  details?: unknown;
  agent?: DashboardAgentLogContext;
}

type DashboardLogListener = (entries: readonly DashboardLogEntry[]) => void;

interface DashboardAgentLoggerOptions {
  path: string;
  roomId: string;
  cwd: string;
  maxRecentEntries?: number;
}

const DEFAULT_MAX_RECENT_ENTRIES = 1200;
const MAX_TAIL_BYTES = 2_000_000;
const MAX_SANITIZE_DEPTH = 14;
const REDACTED_KEY_PATTERN =
  /(api[_-]?key|authorization|bearer|credential|password|secret|token)/i;

export class DashboardAgentLogger {
  readonly path: string;
  readonly sessionId: string;
  private readonly maxRecentEntries: number;
  private entries: DashboardLogEntry[] = [];
  private listeners = new Set<DashboardLogListener>();
  private pendingWrite: Promise<void> = Promise.resolve();
  private sequence = 0;
  private lastErrorValue: string | undefined;

  private constructor(options: DashboardAgentLoggerOptions) {
    this.path = options.path;
    this.maxRecentEntries =
      options.maxRecentEntries ?? DEFAULT_MAX_RECENT_ENTRIES;
    this.sessionId = `dash_${Date.now()}_${randomUUID().slice(0, 8)}`;
  }

  static async create(
    options: DashboardAgentLoggerOptions,
  ): Promise<DashboardAgentLogger> {
    const logger = new DashboardAgentLogger(options);
    try {
      await mkdir(dirname(options.path), { recursive: true });
      logger.entries = await readRecentLogEntries(
        options.path,
        logger.maxRecentEntries,
      );
    } catch (error) {
      logger.lastErrorValue = errorMessage(error);
    }
    logger.record("info", "session_start", "dashboard TUI session started", {
      roomId: options.roomId,
      cwd: options.cwd,
      pid: process.pid,
      logPath: options.path,
    });
    return logger;
  }

  get lastError(): string | undefined {
    return this.lastErrorValue;
  }

  recentEntries(): readonly DashboardLogEntry[] {
    return this.entries;
  }

  async flush(): Promise<void> {
    await this.pendingWrite;
  }

  subscribe(listener: DashboardLogListener): () => void {
    this.listeners.add(listener);
    listener(this.entries);
    return () => {
      this.listeners.delete(listener);
    };
  }

  recordAgentUnavailable(reason: string): void {
    this.record("warn", "agent_unavailable", reason, { reason });
  }

  recordAgentCreated(agent: DashboardAgentLogContext): void {
    this.record(
      "info",
      "agent_created",
      `${agent.agentId} using ${agent.provider}/${agent.modelId}`,
      {
        agent,
      },
      agent,
    );
  }

  recordPromptStart(prompt: string, agent: DashboardAgentLogContext): void {
    this.record(
      "info",
      "operator_prompt",
      truncateOneLine(prompt, 180),
      { prompt },
      agent,
    );
  }

  recordPromptEnd(agent: DashboardAgentLogContext): void {
    this.record("info", "operator_prompt_done", "prompt completed", {}, agent);
  }

  recordPromptError(error: unknown, agent: DashboardAgentLogContext): void {
    this.record(
      "error",
      "operator_prompt_error",
      errorMessage(error),
      { error: errorDetails(error) },
      agent,
    );
  }

  recordAbort(agent: DashboardAgentLogContext, reason?: string): void {
    this.record(
      "warn",
      "agent_abort_requested",
      reason ? `abort requested: ${reason}` : "abort requested",
      reason ? { reason } : {},
      agent,
    );
  }

  recordAgentEvent(event: AgentEvent, agent: DashboardAgentLogContext): void {
    const log = logRecordForAgentEvent(event);
    this.record(log.level, log.event, log.summary, log.details, agent);
  }

  record(
    level: DashboardLogLevel,
    event: string,
    summary: string,
    details?: unknown,
    agent?: DashboardAgentLogContext,
  ): void {
    const entry: DashboardLogEntry = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      sequence: ++this.sequence,
      level,
      event,
      summary,
      ...(details === undefined ? {} : { details: sanitizeForJson(details) }),
      ...(agent === undefined ? {} : { agent }),
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxRecentEntries) {
      this.entries.splice(0, this.entries.length - this.maxRecentEntries);
    }
    this.emit();
    this.pendingWrite = this.pendingWrite
      .then(() => appendFile(this.path, JSON.stringify(entry) + "\n", "utf8"))
      .catch((error: unknown) => {
        this.lastErrorValue = errorMessage(error);
        this.emit();
      });
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.entries);
    }
  }
}

interface EventLogRecord {
  level: DashboardLogLevel;
  event: string;
  summary: string;
  details: unknown;
}

export function logRecordForAgentEvent(event: AgentEvent): EventLogRecord {
  switch (event.type) {
    case "agent_start":
      return {
        level: "info",
        event: "agent_start",
        summary: "agent run started",
        details: {},
      };
    case "agent_end":
      return {
        level: "info",
        event: "agent_end",
        summary: `agent run ended with ${event.messages.length} new message(s)`,
        details: { messageCount: event.messages.length },
      };
    case "turn_start":
      return {
        level: "debug",
        event: "turn_start",
        summary: "turn started",
        details: {},
      };
    case "turn_end":
      return {
        level: levelForMessage(event.message),
        event: "turn_end",
        summary: `turn ended: ${assistantStopSummary(event.message)}`,
        details: {
          message: event.message,
          toolResults: event.toolResults,
        },
      };
    case "message_start":
      return {
        level: "debug",
        event: "message_start",
        summary: `${messageRole(event.message)} message started`,
        details: { message: compactMessage(event.message) },
      };
    case "message_update":
      return {
        level: "debug",
        event: "message_update",
        summary: messageUpdateSummary(event),
        details: {
          assistantMessageEvent: compactAssistantMessageEvent(
            event.assistantMessageEvent,
          ),
          message: compactMessage(event.message),
        },
      };
    case "message_end":
      return {
        level: levelForMessage(event.message),
        event: "message_end",
        summary: `${messageRole(event.message)} message ended: ${messagePreview(
          event.message,
          220,
        )}`,
        details: { message: event.message },
      };
    case "tool_execution_start":
      return {
        level: "info",
        event: "tool_execution_start",
        summary: `tool ${event.toolName} started`,
        details: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        },
      };
    case "tool_execution_update":
      return {
        level: "debug",
        event: "tool_execution_update",
        summary: `tool ${event.toolName} updated`,
        details: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          partialResult: event.partialResult,
        },
      };
    case "tool_execution_end":
      return {
        level: event.isError ? "error" : "info",
        event: "tool_execution_end",
        summary: `tool ${event.toolName} ${event.isError ? "failed" : "completed"}`,
        details: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        },
      };
  }
}

function levelForMessage(message: AgentMessage): DashboardLogLevel {
  if (isRecord(message) && message.role === "assistant") {
    const stopReason = stringValue(message.stopReason);
    if (stopReason === "error") return "error";
    if (stopReason === "aborted") return "warn";
  }
  if (isRecord(message) && message.role === "toolResult" && message.isError) {
    return "error";
  }
  return "info";
}

function assistantStopSummary(message: AgentMessage): string {
  if (!isRecord(message) || message.role !== "assistant") {
    return messagePreview(message, 120);
  }
  const stop = stringValue(message.stopReason) ?? "unknown";
  const error = stringValue(message.errorMessage);
  return error ? `${stop}: ${error}` : stop;
}

function messageUpdateSummary(
  event: Extract<AgentEvent, { type: "message_update" }>,
): string {
  const providerEvent = isRecord(event.assistantMessageEvent)
    ? stringValue(event.assistantMessageEvent.type)
    : undefined;
  return providerEvent
    ? `assistant stream ${providerEvent}`
    : "assistant stream update";
}

function compactAssistantMessageEvent(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const type = stringValue(value.type);
  if (type === "text_delta" || type === "thinking_delta") {
    return {
      type,
      contentIndex: value.contentIndex,
      delta: truncateOneLine(stringValue(value.delta) ?? "", 500),
    };
  }
  if (type === "toolcall_delta") {
    return {
      type,
      contentIndex: value.contentIndex,
      delta: truncateOneLine(stringValue(value.delta) ?? "", 500),
    };
  }
  if (type === "done" || type === "error") {
    return value;
  }
  return {
    type,
    contentIndex: value.contentIndex,
  };
}

function compactMessage(message: AgentMessage): unknown {
  if (!isRecord(message)) return message;
  return {
    role: message.role,
    timestamp: message.timestamp,
    preview: messagePreview(message, 500),
    ...(message.role === "assistant"
      ? {
          provider: message.provider,
          model: message.model,
          stopReason: message.stopReason,
          errorMessage: message.errorMessage,
          usage: message.usage,
        }
      : {}),
    ...(message.role === "toolResult"
      ? {
          toolName: message.toolName,
          isError: message.isError,
        }
      : {}),
  };
}

function messageRole(message: AgentMessage): string {
  return isRecord(message) && typeof message.role === "string"
    ? message.role
    : "unknown";
}

export function messagePreview(
  message: AgentMessage,
  maxChars: number,
): string {
  if (!isRecord(message)) return truncateOneLine(String(message), maxChars);
  if (message.role === "user") {
    return truncateOneLine(contentText(message.content), maxChars);
  }
  if (message.role === "assistant") {
    return truncateOneLine(contentText(message.content), maxChars);
  }
  if (message.role === "toolResult") {
    return truncateOneLine(contentText(message.content), maxChars);
  }
  return truncateOneLine(JSON.stringify(sanitizeForJson(message)), maxChars);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!isRecord(item)) return "";
      if (item.type === "text") return stringValue(item.text) ?? "";
      if (item.type === "thinking") {
        if (item.redacted === true) return "[thinking redacted]";
        return stringValue(item.thinking) ?? "";
      }
      if (item.type === "toolCall") {
        const name = stringValue(item.name) ?? "unknown";
        return `[toolCall ${name}] ${JSON.stringify(
          sanitizeForJson(item.arguments),
        )}`;
      }
      if (item.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function sanitizeForJson(value: unknown): unknown {
  return sanitizeValue(value, 0, new WeakSet<object>());
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (depth >= MAX_SANITIZE_DEPTH) return "[max-depth]";
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return errorDetails(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1, seen));
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    output[key] = REDACTED_KEY_PATTERN.test(key)
      ? "[redacted]"
      : sanitizeValue(item, depth + 1, seen);
  }
  seen.delete(value);
  return output;
}

async function readRecentLogEntries(
  path: string,
  maxEntries: number,
): Promise<DashboardLogEntry[]> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const stats = await handle.stat();
    const length = Math.min(stats.size, MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stats.size - length);
    let text = buffer.toString("utf8");
    if (stats.size > length) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .slice(-maxEntries)
      .flatMap(parseLogEntry);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return [];
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseLogEntry(line: string): DashboardLogEntry[] {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return [];
    if (
      typeof parsed.timestamp !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.sequence !== "number" ||
      typeof parsed.level !== "string" ||
      typeof parsed.event !== "string" ||
      typeof parsed.summary !== "string"
    ) {
      return [];
    }
    const entry: DashboardLogEntry = {
      timestamp: parsed.timestamp,
      sessionId: parsed.sessionId,
      sequence: parsed.sequence,
      level: isDashboardLogLevel(parsed.level) ? parsed.level : "info",
      event: parsed.event,
      summary: parsed.summary,
      ...(parsed.details === undefined ? {} : { details: parsed.details }),
      ...(isRecord(parsed.agent)
        ? { agent: parsed.agent as unknown as DashboardAgentLogContext }
        : {}),
    };
    return [entry];
  } catch {
    return [];
  }
}

function isDashboardLogLevel(value: string): value is DashboardLogLevel {
  return (
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error"
  );
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateOneLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars
    ? normalized.slice(0, Math.max(0, maxChars - 3)) + "..."
    : normalized;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
