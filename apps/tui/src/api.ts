import type {
  ActorRef,
  Agent,
  AgentRole,
  AgentState,
  AgentOutput,
  AgentRoomConfigResponse,
  AgentRoomProtocolResponse,
  AgentRoomSetupPatch,
  AgentRoomSetupResponse,
  DashboardConfig,
  DaemonHealth,
  HarnessSpec,
  Importance,
  Message,
  MessageKind,
  Ref,
  RoomEvent,
  RuntimeBinding,
  RuntimeAgent,
  RuntimeAgentLaunchInput,
  RuntimeProviderSummary,
  RuntimeSession,
  Task,
  TaskStatus,
  Workspace,
} from "./types.js";

export class AgentRoomApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "AgentRoomApiError";
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
  token?: string;
}

export interface MessageCreateInput {
  channelId?: string;
  threadId?: string;
  sender: ActorRef;
  recipients?: ActorRef[];
  kind?: MessageKind;
  body: string;
  importance?: Importance;
}

export interface TaskCreateInput {
  title: string;
  description?: string;
  assigneeId?: string;
  refs?: Ref[];
  createdBy: ActorRef;
}

export interface TaskDetailsUpdateInput {
  title?: string;
  description?: string;
  actor?: ActorRef;
}

export interface TaskDeleteInput {
  actor?: ActorRef;
  reason?: string;
}

export interface RoomAgentRegisterInput {
  agentId: string;
  displayName?: string;
  role: AgentRole;
  harness?: HarnessSpec;
  capabilities?: string[];
}

export interface WorkspaceRegisterInput {
  cwd: string;
  label?: string;
  aliases?: string[];
  metadata?: Record<string, unknown>;
}

async function request<T>(
  url: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (init.body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.headers) {
    Object.assign(headers, init.headers);
  }

  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    let message = `Request failed: ${res.status} ${res.statusText}`;
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "string"
    ) {
      message = (parsed as { error: string }).error;
    }
    throw new AgentRoomApiError(message, res.status, parsed);
  }

  return parsed as T;
}

export function createApiClient(options: ApiClientOptions = {}) {
  const base = (options.baseUrl ?? "http://127.0.0.1:4317").replace(/\/$/, "");
  const url = (path: string) => `${base}${path}`;
  const token = options.token?.trim();
  const apiRequest = <T>(path: string, init: RequestInit = {}) =>
    request<T>(url(path), init, token);

  return {
    base,
    health: () => apiRequest<DaemonHealth>("/health"),
    dashboardConfig: () => apiRequest<DashboardConfig>("/v1/dashboard/config"),
    config: () => apiRequest<AgentRoomConfigResponse>("/v1/config"),
    protocol: () => apiRequest<AgentRoomProtocolResponse>("/v1/protocol"),
    updateSetupConfig: (input: AgentRoomSetupPatch) =>
      apiRequest<AgentRoomSetupResponse>("/v1/config/setup", {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    listEvents: (limit = 80) =>
      apiRequest<{ events: RoomEvent[] }>(
        `/v1/events?limit=${encodeURIComponent(limit)}`,
      ),
    listMessages: (
      input: {
        limit?: number;
        channelId?: string;
        threadId?: string;
      } = {},
    ) => {
      const search = new URLSearchParams();
      search.set("limit", String(input.limit ?? 80));
      if (input.channelId) search.set("channelId", input.channelId);
      if (input.threadId) search.set("threadId", input.threadId);
      return apiRequest<{ messages: Message[] }>(
        `/v1/messages?${search.toString()}`,
      );
    },
    postMessage: (input: MessageCreateInput) =>
      apiRequest<{ message: Message }>("/v1/messages", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    listAgents: () => apiRequest<{ agents: Agent[] }>("/v1/agents"),
    registerRoomAgent: (input: RoomAgentRegisterInput) =>
      apiRequest<{ agent: Agent }>("/v1/agents", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    agentHeartbeat: (
      agentId: string,
      input: { state: AgentState; status?: string },
    ) =>
      apiRequest<{ ok: true }>(
        `/v1/agents/${encodeURIComponent(agentId)}/heartbeat`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
    leaveRoomAgent: (agentId: string, input: { reason?: string } = {}) =>
      apiRequest<{ ok: true; agentId: string }>(
        `/v1/agents/${encodeURIComponent(agentId)}`,
        {
          method: "DELETE",
          body: JSON.stringify(input),
        },
      ),
    listTasks: () => apiRequest<{ tasks: Task[] }>("/v1/tasks"),
    listWorkspaces: () =>
      apiRequest<{ workspaces: Workspace[] }>("/v1/workspaces"),
    registerWorkspace: (input: WorkspaceRegisterInput) =>
      apiRequest<{ workspace: Workspace }>("/v1/workspaces", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    createTask: (input: TaskCreateInput) =>
      apiRequest<{ task: Task }>("/v1/tasks", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    updateTaskDetails: (taskId: string, input: TaskDetailsUpdateInput) =>
      apiRequest<{ task: Task }>(`/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    deleteTask: (taskId: string, input: TaskDeleteInput = {}) =>
      apiRequest<{ ok: true }>(`/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: "DELETE",
        body: JSON.stringify(input),
      }),
    claimTask: (taskId: string, assignee: ActorRef) =>
      apiRequest<{ task: Task }>(
        `/v1/tasks/${encodeURIComponent(taskId)}/claim`,
        {
          method: "POST",
          body: JSON.stringify({ assignee }),
        },
      ),
    updateTaskStatus: (
      taskId: string,
      input: {
        status: TaskStatus;
        actor?: ActorRef;
        reason?: string;
        summary?: string;
      },
    ) =>
      apiRequest<{ task: Task }>(
        `/v1/tasks/${encodeURIComponent(taskId)}/status`,
        {
          method: "PATCH",
          body: JSON.stringify(input),
        },
      ),
    listRuntimeProviders: () =>
      apiRequest<{ providers: RuntimeProviderSummary[] }>(
        "/v1/runtime/providers",
      ),
    listRuntimeAgents: (providerId: string) =>
      apiRequest<{ agents: RuntimeAgent[] }>(
        `/v1/runtime/${encodeURIComponent(providerId)}/agents`,
      ),
    listRuntimeSessions: (providerId: string) =>
      apiRequest<{ sessions: RuntimeSession[] }>(
        `/v1/runtime/${encodeURIComponent(providerId)}/sessions`,
      ),
    getRuntimeBinding: (agentId: string) =>
      apiRequest<{ binding: RuntimeBinding | null }>(
        `/v1/runtime/bindings/${encodeURIComponent(agentId)}`,
      ),
    launchRuntimeAgent: (providerId: string, input: RuntimeAgentLaunchInput) =>
      apiRequest<{ agent: RuntimeAgent }>(
        `/v1/runtime/${encodeURIComponent(providerId)}/agents`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
    readRuntimeAgent: (providerId: string, agentId: string, lines = 120) =>
      apiRequest<{ output: AgentOutput }>(
        `/v1/runtime/${encodeURIComponent(providerId)}/agents/${encodeURIComponent(agentId)}/output?lines=${encodeURIComponent(lines)}`,
      ),
    sendRuntimeAgentInput: (
      providerId: string,
      agentId: string,
      input: { text: string; submit?: boolean },
    ) =>
      apiRequest<{ ok: true }>(
        `/v1/runtime/${encodeURIComponent(providerId)}/agents/${encodeURIComponent(agentId)}/input`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
    attachRuntimeAgent: (providerId: string, agentId: string) =>
      apiRequest<{ ok: true; agentId: string; runtime: string }>(
        `/v1/runtime/${encodeURIComponent(providerId)}/agents/${encodeURIComponent(agentId)}/attach`,
        { method: "POST" },
      ),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
