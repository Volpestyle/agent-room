import type {
  ActorRef,
  Agent,
  AgentRole,
  AgentState,
  HarnessSpec,
  HumanEscalation,
  Importance,
  Message,
  MessageKind,
  Ref,
  RoomEvent,
  RuntimeBinding,
  RuntimeCapabilities,
  RuntimeHealth,
  RuntimeSession,
  Task,
  TaskStatus,
  Workspace,
} from "@agentroom/core";
import type { DashboardOperatorConfig } from "@agentroom/config";

export type {
  ActorRef,
  Agent,
  AgentRole,
  AgentState,
  HarnessSpec,
  HumanEscalation,
  Importance,
  Message,
  MessageKind,
  Ref,
  RoomEvent,
  RuntimeBinding,
  RuntimeCapabilities,
  RuntimeHealth,
  RuntimeSession,
  Task,
  TaskStatus,
  Workspace,
};
export type { DashboardOperatorConfig };

export interface RuntimeProviderSummary {
  id: string;
  kind: string;
  default?: boolean;
  capabilities: RuntimeCapabilities;
  health?: RuntimeHealth;
}

export interface RuntimeAgent {
  id: string;
  bindingId: string;
  displayName?: string;
  state: AgentState;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentOutput {
  text: string;
  lineCount?: number;
}

export interface DaemonHealth {
  ok: boolean;
  pid: number;
  roomId: string;
  cwd: string;
  runtimes: RuntimeProviderSummary[];
  chatGateways: Array<{
    id: string;
    kind: string;
    credentialKind?: string;
    health: {
      ok: boolean;
      message?: string;
    };
    startupError?: string;
  }>;
}

export interface DashboardConfig {
  roomId: string;
  cwd: string;
  defaultRuntime?: string | null;
  operator?: DashboardOperatorConfig | null;
}

export interface RuntimeAgentLaunchInput {
  agentId: string;
  role: string;
  harness: HarnessSpec;
  displayName?: string;
  cwd?: string;
  workspace?: string;
  env?: Record<string, string>;
}
