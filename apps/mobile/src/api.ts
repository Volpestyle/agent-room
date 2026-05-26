export type ActorKind = "human" | "agent" | "system" | "connector";

export interface ActorRef {
  kind: ActorKind;
  id: string;
  displayName?: string;
}

export type TaskStatus =
  | "planned"
  | "assigned"
  | "claimed"
  | "working"
  | "blocked"
  | "ready-for-review"
  | "changes-requested"
  | "approved"
  | "merged"
  | "done"
  | "canceled";

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assignee?: ActorRef;
  updatedAt: string;
}

export interface Message {
  id: string;
  channelId?: string;
  sender: ActorRef;
  body: string;
  createdAt: string;
}

export interface RoomEvent {
  id: string;
  type: string;
  createdAt: string;
}

export interface RuntimeCapabilities {
  startAgent: boolean;
  readOutput: boolean;
  sendInput: boolean;
}

export interface RuntimeHealth {
  ok: boolean;
  status: "ok" | "degraded" | "offline";
  message?: string;
}

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
  state: string;
}

export interface DaemonHealth {
  ok: boolean;
  pid: number;
  roomId: string;
  auth?: {
    apiTokenRequired: boolean;
  };
  runtimes?: RuntimeProviderSummary[];
}

export interface AgentOutput {
  agentId: string;
  text: string;
  observedAt: string;
}

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

export interface AgentRoomClientOptions {
  baseUrl: string;
  token?: string;
}

export function createAgentRoomClient(options: AgentRoomClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body) headers.set("content-type", "application/json");
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);

    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
    });
    const text = await response.text();
    const parsed = parseResponseBody(text);

    if (!response.ok) {
      throw new AgentRoomApiError(
        errorMessage(parsed) ?? `Request failed: ${response.status}`,
        response.status,
        parsed,
      );
    }

    return parsed as T;
  }

  return {
    baseUrl,
    health: () => request<DaemonHealth>("/health"),
    listTasks: () => request<{ tasks: Task[] }>("/v1/tasks"),
    listMessages: (limit = 40) =>
      request<{ messages: Message[] }>(
        `/v1/messages?limit=${encodeURIComponent(limit)}`,
      ),
    listEvents: (limit = 30) =>
      request<{ events: RoomEvent[] }>(
        `/v1/events?limit=${encodeURIComponent(limit)}`,
      ),
    listRuntimeProviders: () =>
      request<{ providers: RuntimeProviderSummary[] }>("/v1/runtime/providers"),
    listRuntimeAgents: (providerId: string) =>
      request<{ agents: RuntimeAgent[] }>(
        `/v1/runtime/${encodeURIComponent(providerId)}/agents`,
      ),
    readRuntimeAgent: (providerId: string, agentId: string, lines = 80) =>
      request<{ output: AgentOutput }>(
        `/v1/runtime/${encodeURIComponent(providerId)}/agents/${encodeURIComponent(agentId)}/output?lines=${encodeURIComponent(lines)}`,
      ),
    sendRuntimeAgentInput: (
      providerId: string,
      agentId: string,
      text: string,
    ) =>
      request<{ ok: true }>(
        `/v1/runtime/${encodeURIComponent(providerId)}/agents/${encodeURIComponent(agentId)}/input`,
        {
          method: "POST",
          body: JSON.stringify({ text, submit: true }),
        },
      ),
    postMessage: (body: string, channelId = "announcements") =>
      request<{ message: Message }>("/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          channelId,
          sender: { kind: "human", id: "mobile" },
          body,
        }),
      }),
  };
}

function parseResponseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(value: unknown): string | undefined {
  if (
    value &&
    typeof value === "object" &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "string"
  ) {
    return (value as { error: string }).error;
  }
  return undefined;
}
