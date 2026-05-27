import type { ApiClient } from "./api.js";
import type { DashboardStore, RuntimeAgentSnapshot } from "./state.js";

export interface PollerOptions {
  intervalMs: number;
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
      const [health, events, agents, messages, tasks, providers, config] =
        await Promise.all([
          this.api.health(),
          this.api.listEvents(120),
          this.api.listAgents(),
          this.api.listMessages({ limit: 120 }),
          this.api.listTasks(),
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

      this.store.set({
        health,
        events: events.events,
        agents: agents.agents,
        messages: messages.messages,
        tasks: tasks.tasks,
        providers: providers.providers,
        runtimeAgents,
        ...(config !== undefined ? { config } : {}),
        lastError: undefined,
        lastRefreshAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.set({ lastError: message });
    } finally {
      this.inflight = false;
    }
  }
}
