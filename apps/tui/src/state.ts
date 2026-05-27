import type {
  DaemonHealth,
  DashboardConfig,
  Message,
  RoomEvent,
  RuntimeAgent,
  RuntimeProviderSummary,
  Task,
} from "./types.js";

export interface RuntimeAgentSnapshot {
  providerId: string;
  agent: RuntimeAgent;
}

export interface DashboardState {
  health: DaemonHealth | undefined;
  config: DashboardConfig | undefined;
  events: RoomEvent[];
  messages: Message[];
  tasks: Task[];
  providers: RuntimeProviderSummary[];
  runtimeAgents: RuntimeAgentSnapshot[];
  lastError: string | undefined;
  lastRefreshAt: string | undefined;
}

export type StateListener = (state: DashboardState) => void;

export class DashboardStore {
  private state: DashboardState = {
    health: undefined,
    config: undefined,
    events: [],
    messages: [],
    tasks: [],
    providers: [],
    runtimeAgents: [],
    lastError: undefined,
    lastRefreshAt: undefined,
  };
  private listeners = new Set<StateListener>();

  get(): DashboardState {
    return this.state;
  }

  set(patch: Partial<DashboardState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  update(mutator: (state: DashboardState) => DashboardState): void {
    this.state = mutator(this.state);
    this.emit();
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}
