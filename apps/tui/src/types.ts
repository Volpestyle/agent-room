import type {
  ActorRef,
  Agent,
  AgentReport,
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
  RuntimeSearchResult,
  RuntimeSession,
  TrackerEvent,
  TrackerEventActor,
  Workspace,
} from "@agentroom/core";
import type { AgentRoomConfig, DashboardOperatorConfig } from "@agentroom/config";

export type {
  ActorRef,
  Agent,
  AgentReport,
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
  RuntimeSearchResult,
  RuntimeSession,
  TrackerEvent,
  TrackerEventActor,
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
    /** Env-var name the gateway's token is read from (when token-based). */
    tokenEnv?: string;
    /** Whether a token value is currently available (via env or the secret store). */
    secretConfigured?: boolean;
  }>;
  chatRoutes?: Array<{
    id: string;
    provider: string;
    /** Target channel (id or name); absent means the gateway default (Discord: #general). */
    conversationId?: string;
    conversationKind?: string;
  }>;
}

export interface DashboardConfig {
  roomId: string;
  cwd: string;
  protocolPath?: string;
  defaultRuntime?: string | null;
  workTracker?: {
    default: string;
    providers: Record<
      string,
      { type: string; teamId?: string; projectId?: string; baseUrl?: string }
    >;
  } | null;
  mcp?: {
    servers: Record<
      string,
      {
        type: "stdio" | "http" | "streamable-http" | "sse";
        command?: string;
        args?: string[];
        cwd?: string;
        url?: string;
        description?: string;
        disabled?: boolean;
        allowedTools?: string[];
      }
    >;
  } | null;
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
  mcpServer?: {
    id: string;
    remove?: boolean;
    type?: "stdio" | "http" | "streamable-http" | "sse";
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
    description?: string;
    disabled?: boolean;
    allowedTools?: string[];
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
