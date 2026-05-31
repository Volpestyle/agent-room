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
export function buildAgentActivationPrompt(ctx: AgentActivationContext): string {
  const role = ctx.role ? ` (role: ${ctx.role})` : "";
  // Single line on purpose: a multi-line paste lands in the agent TUI as a
  // multi-line draft and the runtime's Enter does not dispatch it (verified
  // against Claude Code at boot). One line submits like a normal send.
  const parts = [
    `[AgentRoom] You are enrolled in room "${ctx.roomId}" as agent "${ctx.agentId}"${role}.`,
    "You are a room participant, not a standalone session — load and follow the `agentroom` skill now:",
    "run `agent-room whoami --json` and `agent-room protocol --json`, claim your assigned task, and post a short status with `agent-room post` before editing.",
    "Use agent-room post/dm/wait/task for all room coordination.",
  ];
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
