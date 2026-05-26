import type {
  ActorRef,
  AgentOutput,
  DaemonHealth,
  Importance,
  Message,
  MessageKind,
  Ref,
  RoomEvent,
  RuntimeBinding,
  RuntimeAgent,
  RuntimeAgentLaunchInput,
  RuntimeProviderSummary,
  Task,
  TaskStatus,
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
    listEvents: (limit = 80) =>
      apiRequest<{ events: RoomEvent[] }>(
        `/v1/events?limit=${encodeURIComponent(limit)}`,
      ),
    listMessages: (limit = 80) =>
      apiRequest<{ messages: Message[] }>(
        `/v1/messages?limit=${encodeURIComponent(limit)}`,
      ),
    postMessage: (input: MessageCreateInput) =>
      apiRequest<{ message: Message }>("/v1/messages", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    listTasks: () => apiRequest<{ tasks: Task[] }>("/v1/tasks"),
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
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
