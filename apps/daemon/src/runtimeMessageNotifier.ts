import {
  wakeAgentForMessage,
  type ActorRef,
  type AgentRoomService,
  type AgentState,
  type EventCursor,
  type EventStore,
  type Message,
} from "@agentroom/core";
import type { ProviderRegistry } from "./providerRegistry.js";

/** Default cadence for tailing the event log for directed messages. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * How many polls a pending wake may stay undeliverable before we give up. At the
 * default 1s cadence this is ~2 minutes — generous enough to cover a harness
 * boot or a short in-flight turn, bounded so a recipient that never becomes
 * reachable cannot leak a pending entry forever.
 */
const DEFAULT_MAX_DEFER_ATTEMPTS = 120;

/**
 * States the recipient cannot be woken out of — the process is gone, so a
 * pending wake is dropped rather than retried.
 */
const DEAD_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  "stopped",
  "failed",
]);

/** Mid-turn states: injecting now would interrupt active work, so defer. */
const ALWAYS_BUSY_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  "working",
  "reviewing",
]);

/**
 * Not-yet-at-a-prompt states. Deferred ONLY for runtimes that report semantic
 * state (e.g. herdr): there we know the agent will transition to a reachable
 * state once its harness finishes booting, so a boot-window DM lands the moment
 * it is ready instead of being injected into a half-booted TUI. Runtimes without
 * semantic state (tmux) never advance past these, so we deliver best-effort
 * rather than defer forever.
 */
const NOT_READY_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  "created",
  "starting",
]);

type DeliveryResult = "delivered" | "drop" | "defer";

interface PendingWake {
  /** Total directed messages coalesced into this pending wake. */
  count: number;
  /** Most recent directed message, previewed in the nudge. */
  latest: Message;
  /** Flush attempts spent while the recipient was unreachable. */
  attempts: number;
}

export interface RuntimeMessageNotifierOptions {
  store: EventStore;
  service: AgentRoomService;
  registry: ProviderRegistry;
  roomId: string;
  pollIntervalMs?: number;
  maxDeferAttempts?: number;
  logger?: (message: string) => void;
}

/**
 * Closes the AgentRoom delivery gap for runtime-backed agents.
 *
 * Room messages are pull-based: `postMessage` only appends a `message.posted`
 * event to the shared log. A recipient that has ended its turn (idle at its
 * prompt) never sees a DM until it polls or `agent-room wait`s — so coordinators
 * were forced to inject raw terminal input by hand. This observer tails the
 * event log (origin-agnostic: CLI, MCP, HTTP, and chat-gateway writers all land
 * here) and, for each directed message, injects a one-shot wake nudge into the
 * recipient's runtime via the same audited `sendInput` path the chat gateway and
 * pane observer already use.
 *
 * A directed message whose recipient is still booting or mid-turn is not
 * dropped: it is held as a pending wake and re-attempted on every poll until the
 * agent reaches a reachable state, then delivered (coalesced if several queued).
 * This closes the launch→ready race for runtimes that report readiness and also
 * delivers DMs sent to a momentarily-busy agent once it next goes idle.
 *
 * It deliberately only reacts to `message.posted`: `delegate` posts a directed
 * handoff DM alongside the `delegation.created` event, so reacting to both would
 * double-wake. It starts from the end of the log so a daemon restart never
 * replays historical DMs.
 */
export class RuntimeMessageNotifier {
  private readonly store: EventStore;
  private readonly service: AgentRoomService;
  private readonly registry: ProviderRegistry;
  private readonly roomId: string;
  private readonly pollIntervalMs: number;
  private readonly maxDeferAttempts: number;
  private readonly logger: ((message: string) => void) | undefined;
  private readonly pending = new Map<string, PendingWake>();
  private cursor: EventCursor | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private polling = false;

  constructor(options: RuntimeMessageNotifierOptions) {
    this.store = options.store;
    this.service = options.service;
    this.registry = options.registry;
    this.roomId = options.roomId;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxDeferAttempts =
      options.maxDeferAttempts ?? DEFAULT_MAX_DEFER_ATTEMPTS;
    this.logger = options.logger;
  }

  async start(): Promise<void> {
    // Anchor at the current end of the log so we only ever wake on messages that
    // arrive after the daemon is up. Replaying history on a restart would
    // spam-wake every agent with stale DMs.
    this.cursor = await this.store.cursor("end");
    this.stopped = false;
    this.timer = setInterval(() => {
      if (this.stopped) return;
      void this.poll();
    }, this.pollIntervalMs);
    // Never let the tail timer keep the process alive on its own.
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Intake new directed messages since the last cursor, then attempt to flush
   * every pending wake. Safe to call manually (tests drive it directly); the
   * tail timer calls it on each tick. Reentrancy-guarded so overlapping ticks
   * never double-process a batch.
   */
  async poll(): Promise<void> {
    if (this.polling || this.cursor === undefined) return;
    this.polling = true;
    try {
      const batch = await this.store.listFromCursor(this.cursor, {
        roomId: this.roomId,
      });
      this.cursor = batch.cursor;
      for (const event of batch.events) {
        if (event.type !== "message.posted") continue;
        this.intake(event.payload.message);
      }
      await this.flushPending();
    } catch (error) {
      this.log(`poll error: ${errorMessage(error)}`);
    } finally {
      this.polling = false;
    }
  }

  private intake(message: Message): void {
    for (const recipient of message.recipients ?? []) {
      if (recipient.kind !== "agent") continue;
      // Never wake the sender about their own message.
      if (sameActor(recipient, message.sender)) continue;
      const existing = this.pending.get(recipient.id);
      if (existing) {
        existing.count += 1;
        existing.latest = message;
      } else {
        this.pending.set(recipient.id, {
          count: 1,
          latest: message,
          attempts: 0,
        });
      }
    }
  }

  private async flushPending(): Promise<void> {
    for (const [agentId, entry] of [...this.pending]) {
      let result: DeliveryResult;
      try {
        result = await this.tryDeliver(agentId, entry);
      } catch (error) {
        this.log(`wake attempt failed for ${agentId}: ${errorMessage(error)}`);
        result = "defer";
      }

      if (result === "delivered") {
        this.pending.delete(agentId);
        this.log(
          `woke ${agentId} for ${entry.count} message(s), latest from ${senderLabel(entry.latest.sender)}`,
        );
      } else if (result === "drop") {
        this.pending.delete(agentId);
      } else {
        entry.attempts += 1;
        if (entry.attempts >= this.maxDeferAttempts) {
          this.pending.delete(agentId);
          this.log(
            `gave up waking ${agentId} after ${entry.attempts} attempts; ${entry.count} message(s) left unread`,
          );
        }
      }
    }
  }

  private async tryDeliver(
    agentId: string,
    entry: PendingWake,
  ): Promise<DeliveryResult> {
    const agent = await this.service.getAgent(agentId);
    if (!agent) return "drop"; // not a room agent
    const binding =
      agent.runtime ?? (await this.service.getRuntimeBinding(agentId));
    // No binding means the recipient is not runtime-backed (a human, a mobile
    // client, or an agent that was never launched) — nothing to wake.
    if (!binding) return "drop";

    const provider = this.registry.runtime(binding.providerId);
    if (!provider.capabilities.sendInput) return "drop";
    if (DEAD_STATES.has(agent.state)) return "drop";
    if (isBusy(agent.state, provider.capabilities.semanticAgentState)) {
      return "defer";
    }

    const agentKind =
      agent.harness?.kind ?? metadataString(binding.metadata, "agent");
    await wakeAgentForMessage(provider, this.service, {
      agentId,
      bindingId: binding.bindingId,
      from: senderLabel(entry.latest.sender),
      body: entry.latest.body,
      count: entry.count,
      ...(entry.latest.channelId !== undefined
        ? { channelId: entry.latest.channelId }
        : {}),
      ...(agentKind !== undefined ? { agentKind } : {}),
    });
    return "delivered";
  }

  private log(message: string): void {
    this.logger?.(message);
  }
}

function isBusy(state: AgentState, semanticState: boolean): boolean {
  if (ALWAYS_BUSY_STATES.has(state)) return true;
  return semanticState && NOT_READY_STATES.has(state);
}

function sameActor(left: ActorRef, right: ActorRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function senderLabel(actor: ActorRef): string {
  return actor.displayName !== undefined && actor.displayName.length > 0
    ? actor.displayName
    : actor.id;
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
