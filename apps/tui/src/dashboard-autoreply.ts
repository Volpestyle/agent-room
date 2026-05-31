import type { Message } from "./types.js";

export const DEFAULT_DASHBOARD_WAKE_NAMES = [
  "AgentRoom",
  "Agent Room",
  "dashboard",
] as const;

export interface DashboardWakeOptions {
  wakeNames?: readonly string[];
  startedAtMs?: number;
}

export function resolveDashboardWakeNames(input: {
  dashboardId: string;
  displayName?: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  return dedupeWakeNames([
    ...DEFAULT_DASHBOARD_WAKE_NAMES,
    input.dashboardId,
    input.displayName ?? "",
    ...parseWakeNamesEnv(input.env?.AGENTROOM_DASHBOARD_WAKE_NAMES),
  ]);
}

export function shouldAutoReplyToConnectorMessage(
  message: Message,
  options: DashboardWakeOptions = {},
): boolean {
  if (message.sender.kind !== "connector") return false;
  if (message.kind !== "chat" && message.kind !== "question") return false;
  if (message.body.trim().length === 0) return false;
  if (options.startedAtMs !== undefined) {
    const createdAt = Date.parse(message.createdAt);
    if (!Number.isFinite(createdAt) || createdAt < options.startedAtMs) {
      return false;
    }
  }
  return containsWakeName(
    message.body,
    options.wakeNames ?? DEFAULT_DASHBOARD_WAKE_NAMES,
  );
}

export function formatAutoReplyConversationHistory(input: {
  message: Message;
  messages: readonly Message[];
  limit?: number;
}): string {
  const limit = input.limit ?? 12;
  const channelId = input.message.channelId ?? "announcements";
  const currentCreatedAt = Date.parse(input.message.createdAt);
  const threadId = input.message.threadId;
  const entries = input.messages
    .filter((candidate) => candidate.id !== input.message.id)
    .filter(
      (candidate) => (candidate.channelId ?? "announcements") === channelId,
    )
    .filter((candidate) => candidate.threadId === threadId)
    .filter((candidate) => {
      const createdAt = Date.parse(candidate.createdAt);
      return (
        !Number.isFinite(currentCreatedAt) ||
        !Number.isFinite(createdAt) ||
        createdAt <= currentCreatedAt
      );
    })
    .slice(-limit);

  return entries
    .map((entry) => {
      const sender = entry.sender.displayName ?? entry.sender.id;
      const body = entry.body.replace(/\s+/g, " ").trim();
      return `- ${sender}: ${body}`;
    })
    .join("\n");
}

export function containsWakeName(
  text: string,
  wakeNames: readonly string[],
): boolean {
  const textTokens = tokenizeWakeText(text);
  if (textTokens.length === 0) return false;

  for (const wakeName of dedupeWakeNames(wakeNames)) {
    const wakeTokens = tokenizeWakeText(wakeName);
    if (wakeTokens.length === 0) continue;
    if (containsTokenSequence(textTokens, wakeTokens)) return true;

    const mergedWakeName = wakeTokens.join("");
    if (
      mergedWakeName.length >= 4 &&
      textTokens.some((token) => token === mergedWakeName)
    ) {
      return true;
    }

    if (
      wakeTokens.length === 1 &&
      wakeTokens[0] !== undefined &&
      wakeTokens[0].length >= 4 &&
      (textTokens.some((token) => token === wakeTokens[0]) ||
        containsMergedToken(textTokens, wakeTokens[0]))
    ) {
      return true;
    }
  }
  return false;
}

function parseWakeNamesEnv(value: string | undefined): string[] {
  return (
    value
      ?.split(/[,;\n]/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0) ?? []
  );
}

function dedupeWakeNames(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    const key = normalizeWakeText(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function containsTokenSequence(
  tokens: readonly string[],
  sequence: readonly string[],
): boolean {
  if (
    tokens.length === 0 ||
    sequence.length === 0 ||
    sequence.length > tokens.length
  ) {
    return false;
  }
  for (let start = 0; start <= tokens.length - sequence.length; start += 1) {
    let matched = true;
    for (let index = 0; index < sequence.length; index += 1) {
      if (tokens[start + index] !== sequence[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function containsMergedToken(
  tokens: readonly string[],
  merged: string,
): boolean {
  for (let start = 0; start < tokens.length; start += 1) {
    let candidate = "";
    for (let index = start; index < tokens.length; index += 1) {
      candidate += tokens[index];
      if (candidate === merged) return true;
      if (candidate.length >= merged.length) break;
    }
  }
  return false;
}

function tokenizeWakeText(value: string): string[] {
  const matches = normalizeWakeText(value).match(/[\p{L}\p{N}]+/gu);
  return Array.isArray(matches) ? matches : [];
}

function normalizeWakeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
}
