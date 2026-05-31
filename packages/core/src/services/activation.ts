import type { ActorRef } from "../domain.js";
import type { RuntimeProvider } from "../ports/RuntimeProvider.js";
import type { AgentRoomService } from "./AgentRoomService.js";

/**
 * Default audited source for an activation prompt that the room injects on its
 * own behalf (auto-adoption, enroll, or an operator-triggered API call).
 */
const DEFAULT_ACTIVATION_SOURCE: ActorRef = { kind: "human", id: "agentroom" };

export interface AgentActivationContext {
  agentId: string;
  roomId: string;
  bindingId?: string;
  role?: string;
  /** Absolute path to the room protocol file, when AgentRoom can resolve it. */
  protocolPath?: string;
  /** Resolved work-tracker label (e.g. "linear (team VUH)"), when one is configured. */
  workTracker?: string;
  /**
   * Detected harness/agent kind (e.g. "codex", "claude-code"). Controls TUI
   * submit quirks; safe to omit.
   */
  agentKind?: string;
  source?: ActorRef;
}

/**
 * Build the one-shot prompt that tells an already-running coding agent it is an
 * enrolled AgentRoom participant and must follow the `agentroom` skill.
 *
 * This exists for panes that were adopted rather than launched: AGENTROOM_* env
 * was never injected into the process, so the harness cannot auto-load the skill
 * from the environment. Delivering this as runtime input makes the agent
 * activate the same way a launched agent would.
 */
export function buildAgentActivationPrompt(
  ctx: AgentActivationContext,
): string {
  const role = ctx.role ? ` (role: ${ctx.role})` : "";
  // Single line on purpose: a multi-line paste lands in the agent TUI as a
  // multi-line draft and the runtime's Enter does not dispatch it (verified
  // against Claude Code at boot). One line submits like a normal send.
  const parts = [
    `[AgentRoom] You are enrolled in room "${ctx.roomId}" as agent "${ctx.agentId}"${role}.`,
    "You are a room participant, not a standalone session — load and follow the `agentroom` skill now:",
    "run `agent-room whoami --json` and `agent-room protocol --json`, track your work in the configured work tracker (or a markdown checklist if none is configured), and post a short status with `agent-room post` before editing.",
    "Use agent-room post/dm/wait for all room coordination.",
  ];
  if (ctx.workTracker) {
    parts.push(
      `Work tracker: ${ctx.workTracker} — track issues there via its MCP (also in the AGENTROOM_WORK_TRACKER env).`,
    );
  }
  if (ctx.protocolPath) {
    parts.push(`Room protocol file: ${ctx.protocolPath}.`);
  }
  return parts.join(" ").replace(/\s*\n\s*/g, " ");
}

function needsTrailingSubmit(agentKind: string | undefined): boolean {
  // Codex's TUI lands a multi-line send in the prompt without auto-submitting;
  // a trailing empty submit dispatches it. Claude Code submits on first send.
  return (agentKind ?? "").toLowerCase().includes("codex");
}

/**
 * Default audited source for a message-wake nudge the room injects on its own
 * behalf when a directed message lands for an idle runtime-backed agent.
 */
const MESSAGE_WAKE_SOURCE: ActorRef = { kind: "system", id: "agentroom-wake" };

/** Cap on how much of the message body is inlined into the wake nudge. */
const MESSAGE_WAKE_PREVIEW_LIMIT = 400;

export interface AgentMessageWakeContext {
  agentId: string;
  bindingId?: string;
  /** Sender label shown in the nudge (display name or actor id). */
  from: string;
  /** Body of the directed message; multi-line bodies are collapsed to one line. */
  body: string;
  /** Channel the message landed on, used for the read-back hint. Defaults to "dm". */
  channelId?: string;
  /**
   * Total directed messages this nudge stands in for. >1 when messages queued
   * while the agent was booting/busy and are delivered together once it is
   * reachable. Defaults to 1.
   */
  count?: number;
  /** Detected harness/agent kind (e.g. "codex") for TUI submit quirks. */
  agentKind?: string;
  source?: ActorRef;
}

/**
 * Build the one-shot nudge injected into an idle runtime-backed agent when a
 * directed message (DM, delegation handoff) lands for it. Room messages are
 * pull-based — they sit unread until the recipient polls or `agent-room wait`s.
 * An agent that already ended its turn never sees them; this nudge wakes it.
 *
 * Single line on purpose: a multi-line paste lands in a coding-agent TUI as a
 * draft that the runtime's Enter does not dispatch (same constraint as the
 * activation prompt). The body is collapsed and truncated so it always submits.
 */
export function buildMessageWakePrompt(ctx: AgentMessageWakeContext): string {
  const channel = ctx.channelId ?? "dm";
  const count = ctx.count !== undefined && ctx.count > 1 ? ctx.count : 1;
  const collapsed = ctx.body.replace(/\s*\n\s*/g, " ").trim();
  const preview =
    collapsed.length > MESSAGE_WAKE_PREVIEW_LIMIT
      ? `${collapsed.slice(0, MESSAGE_WAKE_PREVIEW_LIMIT)}…`
      : collapsed;
  const lead =
    count > 1
      ? `[AgentRoom] ${count} new directed messages waiting — latest from ${ctx.from} on #${channel}: ${preview}`
      : `[AgentRoom] New directed message from ${ctx.from} on #${channel}: ${preview}`;
  return [
    lead,
    `— read the full thread with \`agent-room messages -c ${channel} --limit ${Math.max(count, 5)}\` and reply via \`agent-room dm\`/\`agent-room post\`.`,
    "End your next turn inside `agent-room wait` so messages reach you without this nudge.",
  ]
    .join(" ")
    .replace(/\s*\n\s*/g, " ");
}

/**
 * Inject a message-wake nudge into a running agent's runtime and record the
 * audited input event. Returns the prompt text that was sent.
 *
 * Throws if the provider cannot send input. Callers that fire this
 * opportunistically (e.g. the daemon message notifier) should catch and log
 * rather than fail their main flow.
 */
export async function wakeAgentForMessage(
  provider: RuntimeProvider,
  service: AgentRoomService | undefined,
  ctx: AgentMessageWakeContext,
): Promise<{ agentId: string; text: string }> {
  if (!provider.capabilities.sendInput) {
    throw new Error(
      `runtime provider '${provider.id}' cannot send input; cannot wake ${ctx.agentId}`,
    );
  }
  const text = buildMessageWakePrompt(ctx);
  const source = ctx.source ?? MESSAGE_WAKE_SOURCE;
  const target = {
    agentId: ctx.agentId,
    ...(ctx.bindingId !== undefined ? { bindingId: ctx.bindingId } : {}),
    source,
  };

  await provider.sendInput({ ...target, text, submit: true });
  if (needsTrailingSubmit(ctx.agentKind)) {
    await provider.sendInput({ ...target, text: "", submit: true });
  }

  if (service) {
    await service.recordRuntimeInput({ agentId: ctx.agentId, text, source });
  }

  return { agentId: ctx.agentId, text };
}

/**
 * Inject the activation prompt into a running agent's runtime and record the
 * audited input event. Returns the prompt text that was sent.
 *
 * Throws if the provider cannot send input. Callers that fire this opportunistically
 * (e.g. the pane observer) should catch and log rather than fail their main flow.
 */
export async function activateAgent(
  provider: RuntimeProvider,
  service: AgentRoomService | undefined,
  ctx: AgentActivationContext,
): Promise<{ agentId: string; text: string }> {
  if (!provider.capabilities.sendInput) {
    throw new Error(
      `runtime provider '${provider.id}' cannot send input; cannot activate ${ctx.agentId}`,
    );
  }
  const text = buildAgentActivationPrompt(ctx);
  const source = ctx.source ?? DEFAULT_ACTIVATION_SOURCE;
  const target = {
    agentId: ctx.agentId,
    ...(ctx.bindingId !== undefined ? { bindingId: ctx.bindingId } : {}),
    source,
  };

  await provider.sendInput({ ...target, text, submit: true });
  if (needsTrailingSubmit(ctx.agentKind)) {
    await provider.sendInput({ ...target, text: "", submit: true });
  }

  if (service) {
    await service.recordRuntimeInput({ agentId: ctx.agentId, text, source });
  }

  return { agentId: ctx.agentId, text };
}
