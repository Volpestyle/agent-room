import {
  Agent,
  type AgentTool,
  type AgentToolResult,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  clampThinkingLevel,
  getModel,
  Type,
  type TSchema,
} from "@earendil-works/pi-ai";
import type { AuthStorage } from "../auth/storage.js";
import type { ApiClient } from "../api.js";
import type { Poller } from "../poller.js";
import {
  type DashboardAgent,
  type DashboardAgentError,
  parseDashboardThinkingLevel,
  resolveModelOrError,
} from "./index.js";
import { announcerActor, announcerAgentId } from "./identity.js";

export interface AnnouncerAgentOptions {
  api: ApiClient;
  poller: Poller;
  auth: AuthStorage;
  roomId: string;
  cwd: string;
  thinkingLevel?: ThinkingLevel;
}

/**
 * The announcer is an autonomous sub-agent that fires without a human in the
 * loop, so it gets a deliberately narrow toolset: it can read room state and
 * post announcements, but it cannot launch, stop, or otherwise control agents.
 * Everything it posts is attributed to the announcer actor, not the dashboard.
 */
function defineTool<S extends TSchema>(tool: AgentTool<S>): AgentTool<S> {
  return tool;
}

function ok(text: string): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details: {} };
}

function jsonContent(value: unknown): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: {},
  };
}

export function createAnnouncerTools(env: {
  api: ApiClient;
  poller: Poller;
}): AgentTool[] {
  const { api, poller } = env;

  const importance = Type.Union([
    Type.Literal("low"),
    Type.Literal("normal"),
    Type.Literal("high"),
    Type.Literal("urgent"),
  ]);

  const postAnnouncement = defineTool({
    name: "post_announcement",
    label: "Post an announcement into the room",
    description:
      'Post an announcement message into a room channel (default "announcements"). Use for high-signal events the operator and in-room agents should see immediately.',
    parameters: Type.Object({
      body: Type.String({ description: "Message body (markdown ok)." }),
      channelId: Type.Optional(
        Type.String({ description: 'Defaults to "announcements".' }),
      ),
      importance: Type.Optional(importance),
    }),
    execute: async (_callId, params) => {
      const result = await api.postMessage({
        body: params.body,
        sender: announcerActor(),
        channelId: params.channelId ?? "announcements",
        kind: "announcement",
        ...(params.importance !== undefined
          ? { importance: params.importance }
          : {}),
      });
      void poller.tick();
      return ok(`announcement posted (${result.message.id})`);
    },
  });

  const postReport = defineTool({
    name: "post_agent_report",
    label: "Append to the user feed",
    description:
      "Append a narrative report to the user-visible feed. This is the canonical, projection-agnostic surface (a Discord bridge, if configured, mirrors the feed). Use for every announcement worth surfacing to the user.",
    parameters: Type.Object({
      summary: Type.String(),
      title: Type.Optional(Type.String()),
      details: Type.Optional(Type.String()),
      importance: Type.Optional(importance),
    }),
    execute: async (_callId, params) => {
      const result = await api.createAgentReport({
        agentId: announcerActor().id,
        summary: params.summary,
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(params.details !== undefined ? { details: params.details } : {}),
        ...(params.importance !== undefined
          ? { importance: params.importance }
          : {}),
      });
      void poller.tick();
      return ok(`report posted (${result.report.id})`);
    },
  });

  const listAgents = defineTool({
    name: "list_agents",
    label: "List room agents",
    description: "List the agents currently in the room and their states.",
    parameters: Type.Object({}),
    execute: async () => {
      const { agents } = await api.listAgents();
      return jsonContent(agents);
    },
  });

  const listEvents = defineTool({
    name: "list_events",
    label: "List recent room events",
    description: "Return the most recent room audit events for context.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 200, default: 40 }),
      ),
    }),
    execute: async (_callId, params) => {
      const events = await api.listEvents(params.limit ?? 40);
      return jsonContent(events);
    },
  });

  const listUserFeed = defineTool({
    name: "list_user_feed",
    label: "List user feed",
    description:
      "Return the user-visible feed (tracker events + agent reports). Use to avoid re-announcing something already surfaced.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 200, default: 40 }),
      ),
    }),
    execute: async (_callId, params) => {
      const events = await api.listUserFeed(params.limit ?? 40);
      return jsonContent(events);
    },
  });

  return [
    postAnnouncement,
    postReport,
    listAgents,
    listEvents,
    listUserFeed,
  ] as AgentTool[];
}

const ANNOUNCER_SYSTEM_PROMPT_TEMPLATE = `You are the AgentRoom announcer for room {{roomId}} (id: {{agentId}}).

You are a dedicated, autonomous sub-agent whose only job is to post short, high-signal announcements about room activity. You run in your own session, separate from the dashboard agent — never assume you share its context.

Each turn you are handed a batch of room events that just happened (agents going blocked or done, runtimes becoming unhealthy, agents joining or leaving). Decide what — if anything — is worth surfacing, then post ONE concise announcement covering the whole batch.

How to post:
- Always use post_agent_report for anything worth surfacing. The feed is the canonical, projection-agnostic surface. A Discord bridge, if configured, mirrors the feed — but do NOT assume Discord exists and never address Discord directly.
- For high-importance events (an agent blocked, a runtime unhealthy) ALSO call post_announcement so the operator and in-room agents see it immediately. Set importance to high for blocked/unhealthy, normal otherwise.
- Post at most one report and at most one announcement per turn. Coalesce multiple events into a single message (e.g. "3 agents finished: alice, bob, carol").

Style:
- Teammate voice: terse and factual. No hype, no filler. At most one leading glyph.
- Name the agent(s) or provider and what changed; include any reason/health detail you were given.
- If nothing in the batch is worth announcing, post nothing and end your turn.

You have read-only tools (list_agents, list_events, list_user_feed) for context. You cannot launch, stop, message, or control agents — you only announce.

Room cwd: {{cwd}}
`;

export function buildAnnouncerSystemPrompt(input: {
  agentId: string;
  roomId: string;
  cwd: string;
}): string {
  return ANNOUNCER_SYSTEM_PROMPT_TEMPLATE.replace("{{agentId}}", input.agentId)
    .replace("{{roomId}}", input.roomId)
    .replace("{{cwd}}", input.cwd);
}

function resolveAnnouncerThinkingLevel(override?: ThinkingLevel): ThinkingLevel {
  if (override) return override;
  const raw = process.env.AGENTROOM_TUI_ANNOUNCER_THINKING?.trim().toLowerCase();
  if (raw) {
    const parsed = parseDashboardThinkingLevel(raw);
    if (parsed) return parsed;
  }
  // Announcements are short summaries — keep effort low by default.
  return "low";
}

/**
 * Returns false only when the announcer is explicitly disabled via
 * AGENTROOM_TUI_ANNOUNCER. Default is enabled.
 */
export function isAnnouncerEnabled(
  raw = process.env.AGENTROOM_TUI_ANNOUNCER,
): boolean {
  const value = raw?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

export function createAnnouncerAgent(
  options: AnnouncerAgentOptions,
): DashboardAgent | DashboardAgentError {
  const resolved = resolveModelOrError(
    options.auth,
    process.env.AGENTROOM_TUI_ANNOUNCER_MODEL?.trim() ||
      process.env.AGENTROOM_TUI_MODEL?.trim(),
  );
  if ("reason" in resolved) return resolved;

  const agentId = announcerAgentId();
  const tools = createAnnouncerTools({ api: options.api, poller: options.poller });
  const model = getModel(resolved.provider, resolved.modelId as never);
  const requestedThinking = resolveAnnouncerThinkingLevel(options.thinkingLevel);
  const thinkingLevel = clampThinkingLevel(model, requestedThinking);

  const agent = new Agent({
    initialState: {
      systemPrompt: buildAnnouncerSystemPrompt({
        agentId,
        roomId: options.roomId,
        cwd: options.cwd,
      }),
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
    prompt: async (text) => {
      await agent.prompt(text);
    },
    abort: () => agent.abort(),
  };
}
