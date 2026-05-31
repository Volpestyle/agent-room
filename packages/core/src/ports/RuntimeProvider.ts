import type {
  ActorRef,
  AgentRole,
  AgentState,
  HarnessSpec,
  Id,
} from "../domain.js";

export type RuntimeProviderKind = "fake" | "herdr" | "tmux" | "custom";

export interface RuntimeCapabilities {
  startAgent: boolean;
  stopAgent: boolean;
  readOutput: boolean;
  sendInput: boolean;
  /**
   * Provider can deliver discrete named terminal keys (arrows, Enter, Esc, …)
   * to a pane, distinct from typing literal text. Required to drive interactive
   * TUI prompts. Optional so existing capability literals stay valid; treat an
   * absent value as `false`.
   */
  sendKeys?: boolean;
  attachInteractive: boolean;
  subscribeEvents: boolean;
  semanticAgentState: boolean;
  screenshots: boolean;
  fileMounts: boolean;
  worktrees: boolean;
  remoteExecution: boolean;
  adoptAgent: boolean;
}

export interface RuntimeHealth {
  ok: boolean;
  status: "ok" | "degraded" | "offline";
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeSession {
  id: Id;
  name?: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeAgent {
  id: Id;
  bindingId: string;
  displayName?: string;
  state: AgentState;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface StartAgentRequest {
  agentId: Id;
  roomId: Id;
  displayName?: string;
  role: AgentRole;
  harness: HarnessSpec;
  cwd?: string;
  workspace?: string;
  env?: Record<string, string>;
}

export interface AdoptAgentRequest {
  agentId: Id;
  bindingId: string;
  roomId: Id;
  displayName?: string;
  role: AgentRole;
  harness?: HarnessSpec;
  metadata?: Record<string, unknown>;
}

export interface ReadAgentRequest {
  agentId: Id;
  bindingId?: string;
  lines?: number;
  source?: "visible" | "recent" | "recent-unwrapped" | "all";
}

export interface AgentOutput {
  agentId: Id;
  bindingId?: string;
  text: string;
  lineCount?: number;
  observedAt: string;
}

export interface SendInputRequest {
  agentId: Id;
  bindingId?: string;
  text: string;
  submit?: boolean;
  source?: ActorRef;
}

/**
 * Send one or more discrete named terminal keys to a pane. Unlike
 * {@link SendInputRequest}, this types no literal text and appends no implicit
 * Enter — the caller controls the exact key sequence. Key names are
 * provider-neutral tokens such as `Up`, `Down`, `Enter`, `Esc`, `Tab`,
 * `Left`, `Right`; each adapter maps them onto its own terminal key vocabulary.
 */
export interface SendKeysRequest {
  agentId: Id;
  bindingId?: string;
  keys: string[];
  source?: ActorRef;
}

export type RuntimeEvent =
  | { type: "process.started"; bindingId: string; agentId?: Id; at: string }
  | {
      type: "process.exited";
      bindingId: string;
      agentId?: Id;
      code?: number;
      at: string;
    }
  | {
      type: "output.appended";
      bindingId: string;
      agentId?: Id;
      text: string;
      at: string;
    }
  | {
      type: "state.changed";
      bindingId: string;
      agentId?: Id;
      state: AgentState;
      at: string;
    }
  | {
      type: "input.sent";
      bindingId: string;
      agentId?: Id;
      source?: string;
      at: string;
    };

export type RuntimeEventHandler = (event: RuntimeEvent) => void | Promise<void>;

export interface RuntimeSubscription {
  close(): Promise<void>;
}

export interface RuntimeProvider {
  readonly id: string;
  readonly kind: RuntimeProviderKind;
  readonly capabilities: RuntimeCapabilities;

  health(): Promise<RuntimeHealth>;
  listSessions(): Promise<RuntimeSession[]>;
  listAgents(): Promise<RuntimeAgent[]>;
  startAgent(request: StartAgentRequest): Promise<RuntimeAgent>;
  adoptAgent?(request: AdoptAgentRequest): Promise<RuntimeAgent>;
  stopAgent(agentId: Id): Promise<void>;
  readAgent(request: ReadAgentRequest): Promise<AgentOutput>;
  sendInput(request: SendInputRequest): Promise<void>;
  sendKeys?(request: SendKeysRequest): Promise<void>;
  attach?(agentId: Id): Promise<void>;
  subscribeEvents?(handler: RuntimeEventHandler): Promise<RuntimeSubscription>;
}
