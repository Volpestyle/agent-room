import {
  Agent,
  type AgentEvent,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  clampThinkingLevel,
  getModel,
  getModels,
  type KnownProvider,
} from "@earendil-works/pi-ai";
import type { AuthStorage } from "../auth/storage.js";
import type { ApiClient } from "../api.js";
import type { Poller } from "../poller.js";
import { dashboardAgentId } from "./identity.js";
import { loadDashboardOperatorSkillPrompt } from "./operator-skill.js";
import { createDashboardTools } from "./tools.js";

export type DashboardThinkingLevel = ThinkingLevel;

export interface DashboardAgentOptions {
  api: ApiClient;
  poller: Poller;
  auth: AuthStorage;
  roomId: string;
  cwd: string;
  thinkingLevel?: ThinkingLevel;
  operatorSkillPrompt?: string | false;
}

export interface ResolvedModel {
  provider: KnownProvider;
  modelId: string;
  source: "override" | "stored-oauth" | "stored-api-key" | "environment";
}

export interface DashboardAgent {
  agent: Agent;
  resolvedModel: ResolvedModel;
  requestedThinkingLevel: ThinkingLevel;
  thinkingLevel: ThinkingLevel;
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

export const DASHBOARD_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export function parseDashboardThinkingLevel(
  value: string,
): ThinkingLevel | undefined {
  const normalized = value.trim().toLowerCase();
  return (DASHBOARD_THINKING_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as ThinkingLevel)
    : undefined;
}

function resolveThinkingLevel(override?: ThinkingLevel): ThinkingLevel {
  if (override) return override;
  const raw = process.env.AGENTROOM_TUI_THINKING_LEVEL?.trim().toLowerCase();
  if (raw) {
    const parsed = parseDashboardThinkingLevel(raw);
    if (parsed) return parsed;
  }
  return "medium";
}

function defaultModelFor(provider: KnownProvider): string {
  switch (provider) {
    case "anthropic":
      return "claude-sonnet-4-5-20250929";
    case "openai":
      return "gpt-4o";
    case "openai-codex":
      return "gpt-5.5";
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
- Each user prompt may include "AgentRoom dashboard context"; treat it as current daemon/config/TUI state and use it for dashboard-scoped questions before asking clarifying questions.
- The operator can see the dashboard panels (overview, agents, messages, events) — don't dump JSON they can already see; summarize, then act.
- When asked to coordinate other agents, prefer post_message (channel or DM) over send_runtime_agent_input unless the operator explicitly wants raw terminal input.
- You do not have direct local filesystem or shell access. Do not claim to inspect dotfiles, aliases, shell functions, or local command behavior unless the operator provides that content or explicitly asks you to use a runtime agent for it.
- When asked how to join, inspect, or troubleshoot a runtime, call get_runtime_status first.
- Runtime mental model: a runtime provider has sessions; agents have bindings; output comes from bindings. For Herdr specifically, the Herdr session namespace is the value for "herdr --session <name>", while agent sessionId / metadata.workspaceId values are Herdr workspace ids inside that session. Never tell the operator to pass a workspace id like "w..." as a Herdr --session value.
- Runtime agents can expose provider-specific agent labels such as Herdr's "claude" or "codex" label. Treat those labels as type aliases: if the operator says "a Claude instance", resolve it to the room agent/runtime target whose dashboard context or list_runtime_agents result has agent=claude. Use the room agent id for messages, and providerId + runtime agent id or binding for read/send/attach operations.
- If the operator asks how to join Herdr, answer from get_runtime_status using health.metadata.session or sessions[].id for the --session value, health.metadata.socketPath for the socket, and clearly label workspace ids as "not --session".
- Launch runtime agents only when the operator explicitly asks you to start/spawn/launch one. Do not launch agents to answer ordinary dashboard questions or to compensate for missing local shell/file access.
- If the operator asks generically to create/start an agent, do not guess the working directory. Ask which cwd/workspace to use unless the dashboard context already supplies an explicit selected workspace. The launch tool can derive runtime, implementer role, codex harness, workspace label, and a non-conflicting agent id after cwd is known.
- Treat examples you gave as examples only; if the operator replies "go for it" after an example but did not choose concrete non-default values, use daemon defaults instead of copying the example.
- Valid launch roles are lead, planner, implementer, reviewer, runner, qa, observer, and custom. If the operator says "engineer" or "developer", use implementer.
- Track all work in the configured work tracker (set in config.yaml under workTracker) via its MCP/CLI. AgentRoom does not track tasks; there are no task tools or panels.
- If you are blocked, post a question into the room (kind=question, importance=high) instead of guessing.

Room cwd: {{cwd}}
`;

export function buildDashboardSystemPrompt(input: {
  agentId: string;
  roomId: string;
  cwd: string;
  operatorSkillPrompt?: string | false;
}): string {
  const base = SYSTEM_PROMPT_TEMPLATE.replace("{{agentId}}", input.agentId)
    .replace("{{roomId}}", input.roomId)
    .replace("{{cwd}}", input.cwd);
  const operatorSkillPrompt =
    input.operatorSkillPrompt === false
      ? undefined
      : (input.operatorSkillPrompt ??
        loadDashboardOperatorSkillPrompt(input.cwd));
  return operatorSkillPrompt ? `${base}\n\n${operatorSkillPrompt}` : base;
}

export function createDashboardAgent(
  options: DashboardAgentOptions,
): DashboardAgent | DashboardAgentError {
  const resolved = resolveModelOrError(options.auth);
  if ("reason" in resolved) return resolved;

  const tools = createDashboardTools({
    api: options.api,
    poller: options.poller,
  });
  const agentId = dashboardAgentId();
  const systemPrompt = buildDashboardSystemPrompt({
    agentId,
    roomId: options.roomId,
    cwd: options.cwd,
    ...(options.operatorSkillPrompt !== undefined
      ? { operatorSkillPrompt: options.operatorSkillPrompt }
      : {}),
  });

  const model = getModel(resolved.provider, resolved.modelId as never);
  const requestedThinking = resolveThinkingLevel(options.thinkingLevel);
  const thinkingLevel = clampThinkingLevel(model, requestedThinking);

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel,
      tools,
    },
    getApiKey: async (provider) => options.auth.getApiKey(provider),
  });

  return {
    agent,
    resolvedModel: resolved,
    requestedThinkingLevel: requestedThinking,
    thinkingLevel,
    agentId,
    subscribe: (listener) => agent.subscribe(listener),
    prompt: (text) => agent.prompt(text),
    abort: () => agent.abort(),
  };
}
