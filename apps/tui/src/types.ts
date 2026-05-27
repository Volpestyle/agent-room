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
import type { AgentRoomConfig, DashboardOperatorConfig } from "@agentroom/config";

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
  protocolPath?: string;
  defaultRuntime?: string | null;
  operator?: DashboardOperatorConfig | null;
}

export interface AgentRoomConfigResponse {
  path: string;
  config: AgentRoomConfig;
}

export interface AgentRoomProtocolResponse {
  path: string;
  content: string;
}

export interface AgentRoomSetupPatch {
  runtimeDefault?: string;
  workTracker?: {
    type: "native" | "linear" | "github-issues" | "jira" | "custom";
    id?: string;
    teamId?: string;
    projectId?: string;
    baseUrl?: string;
  };
  clanky?: {
    home?: string;
    profile?: string;
    chatGatewayOwner?: "agent" | "room" | "off";
  };
}

export interface AgentRoomSetupResponse extends AgentRoomConfigResponse {
  ok: true;
  restartRequired: boolean;
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
