import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { getModel, getModels, type KnownProvider } from "@earendil-works/pi-ai";
import type { AuthStorage } from "../auth/storage.js";
import type { ApiClient } from "../api.js";
import type { Poller } from "../poller.js";
import { dashboardAgentId } from "./identity.js";
import { createDashboardTools } from "./tools.js";

export interface DashboardAgentOptions {
  api: ApiClient;
  poller: Poller;
  auth: AuthStorage;
  roomId: string;
  cwd: string;
}

export interface ResolvedModel {
  provider: KnownProvider;
  modelId: string;
  source: "override" | "stored-oauth" | "stored-api-key" | "environment";
}

export interface DashboardAgent {
  agent: Agent;
  resolvedModel: ResolvedModel;
  agentId: string;
  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void;
  prompt(text: string): Promise<void>;
  abort(): void;
}

export interface DashboardAgentError {
  reason: string;
}

const DEFAULT_PROVIDER_ORDER: KnownProvider[] = [
  // OAuth-capable providers first so a stored ChatGPT login is preferred over
  // a stale env key.
  "openai-codex",
  "anthropic",
  "openai",
  "google",
];

function defaultModelFor(provider: KnownProvider): string {
  switch (provider) {
    case "anthropic":
      return "claude-sonnet-4-5-20250929";
    case "openai":
      return "gpt-4o";
    case "openai-codex":
      return "gpt-5.2";
    case "google":
      return "gemini-2.0-flash";
    default:
      return "";
  }
}

export function resolveModelOrError(
  auth: AuthStorage,
): ResolvedModel | DashboardAgentError {
  const override = process.env.AGENTROOM_TUI_MODEL?.trim();
  if (override) {
    const [providerPart, ...rest] = override.split("/");
    if (!providerPart || rest.length === 0) {
      return {
        reason: `AGENTROOM_TUI_MODEL must be "provider/modelId" — got ${override}`,
      };
    }
    const provider = providerPart as KnownProvider;
    const modelId = rest.join("/");
    const status = auth.status(provider);
    if (!status.configured) {
      return {
        reason: `Provider "${provider}" has no credentials. Run /login ${provider} or set its env key.`,
      };
    }
    try {
      const list = getModels(provider);
      if (!list.some((entry) => entry.id === modelId)) {
        return {
          reason: `Model "${modelId}" not registered for ${provider}.`,
        };
      }
    } catch (error) {
      return {
        reason: `Unknown provider "${provider}": ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { provider, modelId, source: "override" };
  }

  for (const provider of DEFAULT_PROVIDER_ORDER) {
    const status = auth.status(provider);
    if (!status.configured) continue;
    return {
      provider,
      modelId: defaultModelFor(provider),
      source:
        status.source === "stored-oauth"
          ? "stored-oauth"
          : status.source === "stored-api-key"
            ? "stored-api-key"
            : "environment",
    };
  }
  return {
    reason:
      "No LLM credentials. Run /login openai (ChatGPT Plus/Pro), or set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY.",
  };
}

const SYSTEM_PROMPT_TEMPLATE = `You are the AgentRoom dashboard agent (id: {{agentId}}) inside room {{roomId}}.

You live permanently inside the room and have access to the entire AgentRoom HTTP API through your tools. Use those tools to read state and act on the room — do not invent IDs or guess; always call list_* first when you need fresh data, and call refresh_dashboard after mutating actions so the operator sees the result.

Be concise. Speak as a teammate to the human operator and to the other agents in the room. Address the human directly in chat replies; when broadcasting to the room, use post_message.

Guidelines:
- The operator can see the dashboard panels (overview, agents, tasks, messages, events) — don't dump JSON they can already see; summarize, then act.
- When asked to coordinate other agents, prefer post_message (channel or DM) over send_runtime_agent_input unless the operator explicitly wants raw terminal input.
- Always honor the project tracker as canonical. AgentRoom tasks are local shadows.
- If you are blocked, post a question into the room (kind=question, importance=high) instead of guessing.

Room cwd: {{cwd}}
`;

export function createDashboardAgent(
  options: DashboardAgentOptions,
): DashboardAgent | DashboardAgentError {
  const resolved = resolveModelOrError(options.auth);
  if ("reason" in resolved) return resolved;

  const tools = createDashboardTools({ api: options.api, poller: options.poller });
  const agentId = dashboardAgentId();
  const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace("{{agentId}}", agentId)
    .replace("{{roomId}}", options.roomId)
    .replace("{{cwd}}", options.cwd);

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: getModel(resolved.provider, resolved.modelId as never),
      tools,
    },
    getApiKey: async (provider) => options.auth.getApiKey(provider),
  });

  return {
    agent,
    resolvedModel: resolved,
    agentId,
    subscribe: (listener) => agent.subscribe(listener),
    prompt: (text) => agent.prompt(text),
    abort: () => agent.abort(),
  };
}
