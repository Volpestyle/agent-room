export type Id = string;
export type ISODateTime = string;

export type ActorKind = "human" | "agent" | "system" | "connector";

export interface ActorRef {
  kind: ActorKind;
  id: Id;
  displayName?: string;
}

export type AgentRole =
  | "lead"
  | "planner"
  | "implementer"
  | "reviewer"
  | "runner"
  | "qa"
  | "observer"
  | "custom";

export type AgentState =
  | "created"
  | "starting"
  | "online"
  | "working"
  | "waiting"
  | "blocked"
  | "needs-human"
  | "reviewing"
  | "done"
  | "idle"
  | "failed"
  | "stopped"
  | "unknown";

export interface RuntimeBinding {
  providerId: string;
  bindingId: string;
  kind: "process" | "pane" | "container" | "remote-session" | "custom";
  metadata?: Record<string, unknown>;
}

export interface HarnessSpec {
  kind: "claude-code" | "pi" | "codex" | "gemini-cli" | "shell" | "custom";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface Agent {
  id: Id;
  roomId: Id;
  displayName: string;
  role: AgentRole;
  state: AgentState;
  runtime?: RuntimeBinding;
  harness?: HarnessSpec;
  capabilities?: string[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface Workspace {
  id: Id;
  roomId: Id;
  cwd: string;
  label: string;
  aliases?: string[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  lastSeenAt: ISODateTime;
  runtime?: RuntimeBinding;
  metadata?: Record<string, unknown>;
}

export type MessageKind =
  | "chat"
  | "announcement"
  | "status"
  | "question"
  | "answer"
  | "decision"
  | "handoff"
  | "review"
  | "approval-request"
  | "approval-result";

export type Importance = "low" | "normal" | "high" | "urgent";

export interface Ref {
  kind:
    | "task"
    | "agent"
    | "message"
    | "github-pr"
    | "github-issue"
    | "tracker-issue"
    | "figma-node"
    | "runtime-output"
    | "url"
    | "file"
    | "custom";
  id: string;
  label?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface Message {
  id: Id;
  roomId: Id;
  channelId?: string;
  threadId?: string;
  sender: ActorRef;
  recipients?: ActorRef[];
  kind: MessageKind;
  body: string;
  refs?: Ref[];
  importance: Importance;
  requiresAck?: boolean;
  createdAt: ISODateTime;
}

export interface AgentPresence {
  agent: Agent;
  lastHeartbeatAt?: ISODateTime;
  heartbeatStatus?: string;
}

export interface HumanEscalation {
  id: Id;
  roomId: Id;
  from: ActorRef;
  owner?: ActorRef;
  taskId?: Id;
  question: string;
  contextRefs?: Ref[];
  priority: Importance;
  status: "open" | "answered" | "dismissed";
  createdAt: ISODateTime;
  answeredAt?: ISODateTime;
}

export interface ApprovalRequest {
  id: Id;
  roomId: Id;
  requestedBy: ActorRef;
  action: string;
  params: Record<string, unknown>;
  risk: "low" | "medium" | "high";
  reason: string;
  requiredApprover: "human" | "lead" | "reviewer";
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: ISODateTime;
  expiresAt?: ISODateTime;
}
