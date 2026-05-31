import { AgentRoomApiError, type ApiClient } from "./api.js";
import type { DashboardStore, RuntimeAgentSnapshot } from "./state.js";

export interface PollerOptions {
  intervalMs: number;
}

/**
 * True when the failure means the daemon was unreachable (connection refused,
 * DNS, timeout) rather than a request the daemon actually answered. An
 * AgentRoomApiError always implies the daemon responded, so it is never a
 * connection-level failure.
 */
function isConnectionError(error: unknown): boolean {
  return !(error instanceof AgentRoomApiError);
}

export class Poller {
  private timer: NodeJS.Timeout | undefined;
  private inflight = false;

  constructor(
    private readonly api: ApiClient,
    private readonly store: DashboardStore,
    private readonly options: PollerOptions,
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      // Probe connectivity first so we can distinguish "daemon is down" from a
      // single endpoint returning an error while the daemon is up.
      const health = await this.api.health();
      const [
        events,
        agents,
        messages,
        tasks,
        workspaces,
        providers,
        config,
      ] = await Promise.all([
        this.api.listEvents(120),
        this.api.listAgents(),
        this.api.listMessages({ limit: 120 }),
        this.api.listTasks(),
        this.api.listWorkspaces(),
        this.api.listRuntimeProviders(),
        this.api.dashboardConfig().catch(() => undefined),
      ]);
      const runtimeAgents: RuntimeAgentSnapshot[] = [];
      await Promise.all(
        providers.providers.map(async (provider) => {
          try {
            const { agents } = await this.api.listRuntimeAgents(provider.id);
            for (const agent of agents) {
              runtimeAgents.push({ providerId: provider.id, agent });
            }
          } catch {
            // ignore provider failures so one bad runtime doesn't kill the dashboard
          }
        }),
      );

      const now = new Date().toISOString();
      this.store.set({
        health,
        events: events.events,
        agents: agents.agents,
        messages: messages.messages,
        tasks: tasks.tasks,
        workspaces: workspaces.workspaces,
        providers: providers.providers,
        runtimeAgents,
        ...(config !== undefined ? { config } : {}),
        lastError: undefined,
        lastRefreshAt: now,
        connection: "online",
        lastConnectedAt: now,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.set(
        isConnectionError(error)
          ? { connection: "offline", lastError: message }
          : { connection: "online", lastError: message },
      );
    } finally {
      this.inflight = false;
    }
  }
}
