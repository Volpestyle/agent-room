import type {
  ActorRef,
  AgentOutput,
  DaemonHealth,
  Importance,
  Message,
  MessageKind,
  Ref,
  RoomEvent,
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

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (init.body) headers["Content-Type"] = "application/json";
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

  return {
    base,
    health: () => request<DaemonHealth>(url("/health")),
    listEvents: (limit = 80) =>
      request<{ events: RoomEvent[] }>(
        url(`/v1/events?limit=${encodeURIComponent(limit)}`),
      ),
    listMessages: (limit = 80) =>
      request<{ messages: Message[] }>(
        url(`/v1/messages?limit=${encodeURIComponent(limit)}`),
      ),
    postMessage: (input: MessageCreateInput) =>
      request<{ message: Message }>(url("/v1/messages"), {
        method: "POST",
        body: JSON.stringify(input),
      }),
    listTasks: () => request<{ tasks: Task[] }>(url("/v1/tasks")),
    createTask: (input: TaskCreateInput) =>
      request<{ task: Task }>(url("/v1/tasks"), {
        method: "POST",
        body: JSON.stringify(input),
      }),
    claimTask: (taskId: string, assignee: ActorRef) =>
      request<{ task: Task }>(
        url(`/v1/tasks/${encodeURIComponent(taskId)}/claim`),
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
      request<{ task: Task }>(
        url(`/v1/tasks/${encodeURIComponent(taskId)}/status`),
        {
          method: "PATCH",
          body: JSON.stringify(input),
        },
      ),
    listRuntimeProviders: () =>
      request<{ providers: RuntimeProviderSummary[] }>(
        url("/v1/runtime/providers"),
      ),
    listRuntimeAgents: (providerId: string) =>
      request<{ agents: RuntimeAgent[] }>(
        url(`/v1/runtime/${encodeURIComponent(providerId)}/agents`),
      ),
    launchRuntimeAgent: (
      providerId: string,
      input: RuntimeAgentLaunchInput,
    ) =>
      request<{ agent: RuntimeAgent }>(
        url(`/v1/runtime/${encodeURIComponent(providerId)}/agents`),
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
    readRuntimeAgent: (providerId: string, agentId: string, lines = 120) =>
      request<{ output: AgentOutput }>(
        url(
          `/v1/runtime/${encodeURIComponent(providerId)}/agents/${encodeURIComponent(agentId)}/output?lines=${encodeURIComponent(lines)}`,
        ),
      ),
    sendRuntimeAgentInput: (
      providerId: string,
      agentId: string,
      input: { text: string; submit?: boolean },
    ) =>
      request<{ ok: true }>(
        url(
          `/v1/runtime/${encodeURIComponent(providerId)}/agents/${encodeURIComponent(agentId)}/input`,
        ),
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
