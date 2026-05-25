import type {
  ActorRef,
  AgentRole,
  AgentState,
  HarnessSpec,
  HumanEscalation,
  Importance,
  Message,
  MessageKind,
  Ref,
  RoomEvent,
  RuntimeCapabilities,
  RuntimeHealth,
  Task,
  TaskStatus,
} from "@agentroom/core";

export type {
  ActorRef,
  AgentRole,
  AgentState,
  HarnessSpec,
  HumanEscalation,
  Importance,
  Message,
  MessageKind,
  Ref,
  RoomEvent,
  RuntimeCapabilities,
  RuntimeHealth,
  Task,
  TaskStatus,
};

export interface RuntimeProviderSummary {
  id: string;
  kind: string;
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

export interface RuntimeAgentLaunchInput {
  agentId: string;
  role: string;
  harness: HarnessSpec;
  displayName?: string;
  cwd?: string;
  env?: Record<string, string>;
}
