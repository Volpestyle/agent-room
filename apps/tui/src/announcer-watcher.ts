import type { DashboardAgent } from "./agent/index.js";
import type { DashboardState, DashboardStore } from "./state.js";
import type { AgentState } from "./types.js";

export type AnnouncementKind =
  | "agent-blocked"
  | "agent-done"
  | "agent-joined"
  | "agent-left"
  | "runtime-unhealthy";

export interface AnnouncementEvent {
  kind: AnnouncementKind;
  /** Set for agent-* events. */
  agentId?: string;
  displayName?: string;
  /** Resulting agent state, for agent-* events. */
  state?: AgentState;
  /** Set for runtime-* events. */
  providerId?: string;
  /** Blocked reason / runtime health message, when available. */
  detail?: string;
}

export interface DiffAnnouncementsOptions {
  /** Agent ids to never announce (the dashboard and the announcer itself). */
  ignoreAgentIds?: ReadonlySet<string>;
}

/**
 * Pure diff of two room snapshots into the set of announceable transitions.
 * Detects agents entering blocked/done, agents joining/leaving the roster, and
 * runtime providers becoming unhealthy. Anything in `ignoreAgentIds` is skipped
 * so the dashboard and the announcer never announce themselves.
 */
export function diffAnnouncements(
  prev: DashboardState,
  next: DashboardState,
  options: DiffAnnouncementsOptions = {},
): AnnouncementEvent[] {
  const ignore = options.ignoreAgentIds ?? new Set<string>();
  const events: AnnouncementEvent[] = [];

  const prevAgents = new Map(prev.agents.map((agent) => [agent.id, agent]));
  const nextAgents = new Map(next.agents.map((agent) => [agent.id, agent]));

  for (const [id, agent] of nextAgents) {
    if (ignore.has(id)) continue;
    const before = prevAgents.get(id);
    if (!before) {
      events.push({
        kind: "agent-joined",
        agentId: id,
        displayName: agent.displayName,
        state: agent.state,
      });
      continue;
    }
    if (before.state === agent.state) continue;
    if (agent.state === "blocked") {
      events.push({
        kind: "agent-blocked",
        agentId: id,
        displayName: agent.displayName,
        state: agent.state,
      });
    } else if (agent.state === "done") {
      events.push({
        kind: "agent-done",
        agentId: id,
        displayName: agent.displayName,
        state: agent.state,
      });
    }
  }

  for (const [id, agent] of prevAgents) {
    if (ignore.has(id)) continue;
    if (!nextAgents.has(id)) {
      events.push({
        kind: "agent-left",
        agentId: id,
        displayName: agent.displayName,
      });
    }
  }

  const prevProviders = new Map(
    prev.providers.map((provider) => [provider.id, provider]),
  );
  for (const provider of next.providers) {
    const before = prevProviders.get(provider.id);
    // Treat "unknown health" as healthy so we only fire on a real ok -> not-ok
    // transition rather than on the first time a provider reports.
    const beforeOk = before?.health?.ok ?? true;
    const nowOk = provider.health?.ok ?? true;
    if (beforeOk && !nowOk) {
      events.push({
        kind: "runtime-unhealthy",
        providerId: provider.id,
        ...(provider.health?.message !== undefined
          ? { detail: provider.health.message }
          : {}),
      });
    }
  }

  return events;
}

function describeEvent(event: AnnouncementEvent): string {
  const who =
    event.displayName && event.displayName !== event.agentId
      ? `"${event.displayName}" (${event.agentId})`
      : (event.agentId ?? "agent");
  switch (event.kind) {
    case "agent-blocked":
      return `Agent ${who} is now BLOCKED${event.detail ? `: ${event.detail}` : "."}`;
    case "agent-done":
      return `Agent ${who} finished (done).`;
    case "agent-joined":
      return `Agent ${who} joined the room.`;
    case "agent-left":
      return `Agent ${who} left the room.`;
    case "runtime-unhealthy":
      return `Runtime provider "${event.providerId}" is unhealthy${event.detail ? `: ${event.detail}` : "."}`;
  }
}

export function buildAnnouncerBatchPrompt(
  events: readonly AnnouncementEvent[],
): string {
  const lines = events.map((event) => `- ${describeEvent(event)}`);
  return [
    "Room events since your last announcement. Post one concise announcement covering these; ignore anything not worth surfacing.",
    "",
    ...lines,
  ].join("\n");
}

interface WatcherLogger {
  record(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    summary: string,
    details?: unknown,
  ): void;
}

export interface AnnouncerWatcherOptions {
  store: DashboardStore;
  announcer: DashboardAgent;
  ignoreAgentIds?: ReadonlySet<string>;
  /** Coalesce window: events within this window become one announcer turn. */
  debounceMs?: number;
  /** Suppress an identical transition seen again within this window. */
  dedupeWindowMs?: number;
  logger?: WatcherLogger;
  now?: () => number;
}

const DEFAULT_DEBOUNCE_MS = 4000;
const DEFAULT_DEDUPE_WINDOW_MS = 60_000;

/**
 * Watches the dashboard store for announceable room transitions and wakes the
 * announcer sub-agent to post about them. The announcer runs in its own
 * session, so this never interrupts the main dashboard agent.
 *
 * - Baseline: the first *refreshed* snapshot (lastRefreshAt set) is taken as the
 *   baseline with no announcements, so the existing roster is not announced.
 * - Coalescing: a burst of transitions is debounced into a single announcer turn.
 * - Serial: only one announcer turn runs at a time; events that arrive mid-turn
 *   are drained on the next cycle.
 */
export class AnnouncerWatcher {
  private readonly store: DashboardStore;
  private readonly announcer: DashboardAgent;
  private readonly ignoreAgentIds: ReadonlySet<string>;
  private readonly debounceMs: number;
  private readonly dedupeWindowMs: number;
  private readonly logger: WatcherLogger | undefined;
  private readonly now: () => number;

  private prev: DashboardState | undefined;
  private buffer: AnnouncementEvent[] = [];
  private readonly seen = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private stopped = false;
  private unsubscribe: (() => void) | undefined;

  constructor(options: AnnouncerWatcherOptions) {
    this.store = options.store;
    this.announcer = options.announcer;
    this.ignoreAgentIds = options.ignoreAgentIds ?? new Set<string>();
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    this.stopped = false;
    this.unsubscribe = this.store.subscribe((state) => this.onState(state));
  }

  stop(): void {
    this.stopped = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.buffer = [];
  }

  private onState(state: DashboardState): void {
    if (this.stopped) return;
    // Seed the baseline from the first snapshot that has actually been polled,
    // so we diff against real roster/provider data rather than the empty store.
    if (this.prev === undefined) {
      if (state.lastRefreshAt === undefined) return;
      this.prev = state;
      return;
    }
    const events = diffAnnouncements(this.prev, state, {
      ignoreAgentIds: this.ignoreAgentIds,
    });
    this.prev = state;
    if (events.length === 0) return;
    const fresh = events.filter((event) => this.admit(event));
    if (fresh.length === 0) return;
    this.buffer.push(...fresh);
    this.schedule();
  }

  private admit(event: AnnouncementEvent): boolean {
    const key = `${event.kind}:${event.agentId ?? event.providerId ?? ""}:${event.state ?? ""}`;
    const now = this.now();
    const last = this.seen.get(key);
    if (last !== undefined && now - last < this.dedupeWindowMs) return false;
    this.seen.set(key, now);
    return true;
  }

  private schedule(): void {
    if (this.timer || this.busy || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
    // Don't keep the process alive just for a pending announcement.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.busy || this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    this.busy = true;
    this.logger?.record(
      "info",
      "announcer_batch",
      `announcing ${batch.length} event(s)`,
      { count: batch.length, kinds: batch.map((event) => event.kind) },
    );
    try {
      await this.announcer.prompt(buildAnnouncerBatchPrompt(batch));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.record("warn", "announcer_error", message, { message });
    } finally {
      this.busy = false;
      if (!this.stopped && this.buffer.length > 0) this.schedule();
    }
  }
}
