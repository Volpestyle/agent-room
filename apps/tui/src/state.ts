import type {
  Agent,
  DaemonHealth,
  DashboardConfig,
  Message,
  RoomEvent,
  RuntimeAgent,
  RuntimeProviderSummary,
  Task,
  Workspace,
} from "./types.js";

export interface RuntimeAgentSnapshot {
  providerId: string;
  agent: RuntimeAgent;
}

/**
 * Connectivity to the daemon, independent of per-request errors.
 * - "connecting": no successful poll yet this session
 * - "online": daemon reachable
 * - "offline": daemon unreachable (connection refused / network failure)
 */
export type ConnectionStatus = "connecting" | "online" | "offline";

export interface DashboardState {
  health: DaemonHealth | undefined;
  config: DashboardConfig | undefined;
  events: RoomEvent[];
  agents: Agent[];
  messages: Message[];
  tasks: Task[];
  workspaces: Workspace[];
  providers: RuntimeProviderSummary[];
  runtimeAgents: RuntimeAgentSnapshot[];
  lastError: string | undefined;
  lastRefreshAt: string | undefined;
  connection: ConnectionStatus;
  lastConnectedAt: string | undefined;
  restarting: boolean;
}

export type StateListener = (state: DashboardState) => void;

export class DashboardStore {
  private state: DashboardState = {
    health: undefined,
    config: undefined,
    events: [],
    agents: [],
    messages: [],
    tasks: [],
    workspaces: [],
    providers: [],
    runtimeAgents: [],
    lastError: undefined,
    lastRefreshAt: undefined,
    connection: "connecting",
    lastConnectedAt: undefined,
    restarting: false,
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
