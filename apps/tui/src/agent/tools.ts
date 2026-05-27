import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { basename } from "node:path";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { AgentRole, HarnessSpec } from "@agentroom/core";
import type { ApiClient } from "../api.js";
import type { Poller } from "../poller.js";
import type {
  DashboardConfig,
  RuntimeAgent,
  RuntimeProviderSummary,
} from "../types.js";
import { dashboardActor } from "./identity.js";

interface ToolEnv {
  api: ApiClient;
  poller: Poller;
}

function defineTool<S extends TSchema>(tool: AgentTool<S>): AgentTool<S> {
  return tool;
}

function ok(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function jsonContent(value: unknown): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: {},
  };
}

function formatToolError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const LAUNCH_ROLE_ALIASES: Record<string, AgentRole> = {
  dev: "implementer",
  developer: "implementer",
  engineer: "implementer",
  engineering: "implementer",
  impl: "implementer",
  implementation: "implementer",
};

const DEFAULT_LAUNCH_ROLE: AgentRole = "implementer";
const DEFAULT_HARNESS_KIND: HarnessSpec["kind"] = "codex";

function prepareLaunchArguments(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};

  const prepared = { ...(args as Record<string, unknown>) };
  if (typeof prepared.role === "string") {
    const normalized = prepared.role.trim().toLowerCase();
    prepared.role = LAUNCH_ROLE_ALIASES[normalized] ?? prepared.role;
  }
  return prepared;
}

function defaultCommandForHarness(kind: HarnessSpec["kind"]): string {
  switch (kind) {
    case "claude-code":
      return "claude";
    case "codex":
      return "codex";
    case "gemini-cli":
      return "gemini";
    case "pi":
      return "pi";
    case "shell":
      return "bash";
    case "custom":
      throw new Error("custom harness requires command");
  }
}

function selectLaunchProvider(input: {
  providerId?: string | undefined;
  providers: RuntimeProviderSummary[];
  config: DashboardConfig;
}): RuntimeProviderSummary {
  const startable = input.providers.filter(
    (provider) => provider.capabilities.startAgent,
  );
  const selectedId =
    input.providerId ??
    input.config.defaultRuntime ??
    input.providers.find((provider) => provider.default)?.id;

  if (selectedId) {
    const selected = input.providers.find(
      (provider) => provider.id === selectedId,
    );
    if (!selected) throw new Error(`unknown runtime provider: ${selectedId}`);
    if (!selected.capabilities.startAgent) {
      throw new Error(`runtime provider cannot launch agents: ${selectedId}`);
    }
    return selected;
  }

  if (startable.length === 1) return startable[0]!;
  throw new Error(
    "No default runtime provider is configured; specify providerId.",
  );
}

function nextAgentId(role: AgentRole, agents: RuntimeAgent[]): string {
  const base = role === "implementer" ? "implementer" : role;
  const ids = new Set(agents.map((agent) => agent.id));
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
  throw new Error(`could not allocate agent id for role ${role}`);
}

function workspaceLabelFromCwd(cwd: string): string {
  const label = basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return label || "workspace";
}

export function createDashboardTools(env: ToolEnv): AgentTool[] {
  const { api, poller } = env;

  const listMessages = defineTool({
    name: "list_messages",
    label: "List room messages",
    description:
      "List recent room messages. Optionally filter by channel or thread.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 500, default: 50 }),
      ),
      channelId: Type.Optional(Type.String()),
      threadId: Type.Optional(Type.String()),
    }),
    execute: async (_callId, params) => {
      const result = await api.listMessages({
        limit: params.limit ?? 50,
        ...(params.channelId !== undefined
          ? { channelId: params.channelId }
          : {}),
        ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
      });
      return jsonContent(result);
    },
  });

  const postMessage = defineTool({
    name: "post_message",
    label: "Post a message into the room",
    description:
      "Post a message as the dashboard agent. Use this to announce status, answer the human, or send a DM by passing recipients.",
    parameters: Type.Object({
      body: Type.String({ description: "Message body (markdown ok)." }),
      channelId: Type.Optional(Type.String()),
      threadId: Type.Optional(Type.String()),
      kind: Type.Optional(
        Type.Union([
          Type.Literal("chat"),
          Type.Literal("announcement"),
          Type.Literal("status"),
          Type.Literal("question"),
          Type.Literal("answer"),
          Type.Literal("decision"),
          Type.Literal("handoff"),
          Type.Literal("review"),
        ]),
      ),
      importance: Type.Optional(
        Type.Union([
          Type.Literal("low"),
          Type.Literal("normal"),
          Type.Literal("high"),
          Type.Literal("urgent"),
        ]),
      ),
      recipients: Type.Optional(
        Type.Array(
          Type.Object({
            kind: Type.Union([
              Type.Literal("human"),
              Type.Literal("agent"),
              Type.Literal("system"),
              Type.Literal("connector"),
            ]),
            id: Type.String(),
          }),
        ),
      ),
    }),
    execute: async (_callId, params) => {
      const sender = dashboardActor();
      const result = await api.postMessage({
        body: params.body,
        sender,
        ...(params.channelId !== undefined
          ? { channelId: params.channelId }
          : {}),
        ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
        ...(params.kind !== undefined ? { kind: params.kind } : {}),
        ...(params.importance !== undefined
          ? { importance: params.importance }
          : {}),
        ...(params.recipients !== undefined
          ? { recipients: params.recipients }
          : {}),
      });
      void poller.tick();
      return ok(`message posted (${result.message.id})`, {
        messageId: result.message.id,
      });
    },
  });

  const listTasks = defineTool({
    name: "list_tasks",
    label: "List room tasks",
    description: "Return all local task shadows in the room.",
    parameters: Type.Object({}),
    execute: async () => {
      const tasks = await api.listTasks();
      return jsonContent(tasks);
    },
  });

  const listWorkspaces = defineTool({
    name: "list_workspaces",
    label: "List workspaces",
    description:
      "List durable AgentRoom workspaces. Use this before launching agents when the operator references a project or repo by name.",
    parameters: Type.Object({}),
    execute: async () => {
      const { workspaces } = await api.listWorkspaces();
      return jsonContent(workspaces);
    },
  });

  const registerWorkspace = defineTool({
    name: "register_workspace",
    label: "Register workspace",
    description: "Register a working directory as an AgentRoom workspace.",
    parameters: Type.Object({
      cwd: Type.String(),
      label: Type.Optional(Type.String()),
    }),
    execute: async (_callId, params) => {
      const workspace = await api.registerWorkspace({
        cwd: params.cwd,
        label: params.label ?? workspaceLabelFromCwd(params.cwd),
      });
      void poller.tick();
      return ok(`workspace ${workspace.workspace.label} registered`, {
        workspace: workspace.workspace,
      });
    },
  });

  const createTask = defineTool({
    name: "create_task",
    label: "Create a task",
    description: "Create a local task. Optionally assign it.",
    parameters: Type.Object({
      title: Type.String(),
      description: Type.Optional(Type.String()),
      assigneeId: Type.Optional(Type.String()),
    }),
    execute: async (_callId, params) => {
      const created = await api.createTask({
        title: params.title,
        createdBy: dashboardActor(),
        ...(params.description !== undefined
          ? { description: params.description }
          : {}),
        ...(params.assigneeId !== undefined
          ? { assigneeId: params.assigneeId }
          : {}),
      });
      void poller.tick();
      return ok(`task created (${created.task.id})`, {
        taskId: created.task.id,
      });
    },
  });

  const claimTask = defineTool({
    name: "claim_task",
    label: "Claim a task for an agent",
    description: "Assign an existing task to an agent or human.",
    parameters: Type.Object({
      taskId: Type.String(),
      assigneeId: Type.String(),
      assigneeKind: Type.Optional(
        Type.Union([Type.Literal("agent"), Type.Literal("human")]),
      ),
    }),
    execute: async (_callId, params) => {
      const claimed = await api.claimTask(params.taskId, {
        kind: params.assigneeKind ?? "agent",
        id: params.assigneeId,
      });
      void poller.tick();
      return ok(`task ${params.taskId} → ${params.assigneeId}`, {
        task: claimed.task,
      });
    },
  });

  const updateTaskStatus = defineTool({
    name: "update_task_status",
    label: "Update task status",
    description:
      "Update a task's lifecycle status (working/blocked/ready-for-review/done/etc.).",
    parameters: Type.Object({
      taskId: Type.String(),
      status: Type.Union([
        Type.Literal("planned"),
        Type.Literal("assigned"),
        Type.Literal("claimed"),
        Type.Literal("working"),
        Type.Literal("blocked"),
        Type.Literal("ready-for-review"),
        Type.Literal("changes-requested"),
        Type.Literal("approved"),
        Type.Literal("merged"),
        Type.Literal("done"),
        Type.Literal("canceled"),
      ]),
      reason: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String()),
    }),
    execute: async (_callId, params) => {
      const updated = await api.updateTaskStatus(params.taskId, {
        status: params.status,
        actor: dashboardActor(),
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
        ...(params.summary !== undefined ? { summary: params.summary } : {}),
      });
      void poller.tick();
      return ok(`task ${params.taskId} status → ${params.status}`, {
        task: updated.task,
      });
    },
  });

  const listEvents = defineTool({
    name: "list_events",
    label: "List recent room events",
    description: "Return the most recent room audit events.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 500, default: 50 }),
      ),
    }),
    execute: async (_callId, params) => {
      const events = await api.listEvents(params.limit ?? 50);
      return jsonContent(events);
    },
  });

  const getRoomProtocol = defineTool({
    name: "get_room_protocol",
    label: "Get room protocol",
    description:
      "Return the editable AgentRoom room protocol from .agentroom/AGENTS.md.",
    parameters: Type.Object({}),
    execute: async () => {
      const protocol = await api.protocol();
      return jsonContent(protocol);
    },
  });

  const listProviders = defineTool({
    name: "list_runtime_providers",
    label: "List runtime providers",
    description: "List configured runtime providers (tmux/herdr/fake/etc.).",
    parameters: Type.Object({}),
    execute: async () => {
      const providers = await api.listRuntimeProviders();
      return jsonContent(providers);
    },
  });

  const listAgents = defineTool({
    name: "list_runtime_agents",
    label: "List runtime agents",
    description:
      "List agents currently known to a runtime provider (id, binding, state). Herdr agents include labels like metadata.agent/displayName=claude or codex; use those labels to resolve phrases like 'a Claude instance'.",
    parameters: Type.Object({
      providerId: Type.String(),
    }),
    execute: async (_callId, params) => {
      const agents = await api.listRuntimeAgents(params.providerId);
      return jsonContent(agents);
    },
  });

  const getRuntimeStatus = defineTool({
    name: "get_runtime_status",
    label: "Runtime status",
    description:
      "Return runtime health, sessions, and agents. Use this for questions about how to join a Herdr session, which socket is active, or what workspace ids mean.",
    parameters: Type.Object({
      providerId: Type.Optional(Type.String()),
    }),
    execute: async (_callId, params) => {
      const health = await api.health();
      const { providers } = await api.listRuntimeProviders();
      const selected = params.providerId
        ? providers.filter((provider) => provider.id === params.providerId)
        : providers;
      const runtimes = await Promise.all(
        selected.map(async (provider) => {
          const [sessions, agents] = await Promise.all([
            api.listRuntimeSessions(provider.id).then(
              (result) => result.sessions,
              (error) => ({
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
            api.listRuntimeAgents(provider.id).then(
              (result) => result.agents,
              (error) => ({
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          ]);
          return {
            provider,
            health: health.runtimes.find(
              (runtime) => runtime.id === provider.id,
            )?.health,
            sessions,
            agents,
          };
        }),
      );
      return jsonContent({ roomId: health.roomId, runtimes });
    },
  });

  const launchAgent = defineTool({
    name: "launch_runtime_agent",
    label: "Launch a runtime agent",
    description:
      "Start an agent under a runtime provider only when the operator explicitly asks to launch/start/spawn/create one. Require cwd from the operator unless the UI supplies a selected workspace.",
    parameters: Type.Object({
      providerId: Type.Optional(Type.String()),
      agentId: Type.Optional(Type.String()),
      role: Type.Optional(
        Type.Union([
          Type.Literal("lead"),
          Type.Literal("planner"),
          Type.Literal("implementer"),
          Type.Literal("reviewer"),
          Type.Literal("runner"),
          Type.Literal("qa"),
          Type.Literal("observer"),
          Type.Literal("custom"),
        ]),
      ),
      harnessKind: Type.Optional(
        Type.Union([
          Type.Literal("claude-code"),
          Type.Literal("pi"),
          Type.Literal("codex"),
          Type.Literal("gemini-cli"),
          Type.Literal("shell"),
          Type.Literal("custom"),
        ]),
      ),
      command: Type.Optional(Type.String()),
      args: Type.Optional(Type.Array(Type.String())),
      cwd: Type.Optional(Type.String()),
      workspace: Type.Optional(Type.String()),
      displayName: Type.Optional(Type.String()),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
    }),
    prepareArguments: (args) => prepareLaunchArguments(args) as never,
    execute: async (_callId, params) => {
      const [config, providerList] = await Promise.all([
        api.dashboardConfig(),
        api.listRuntimeProviders(),
      ]);
      const provider = selectLaunchProvider({
        providerId: params.providerId,
        providers: providerList.providers,
        config,
      });
      const { agents } = await api.listRuntimeAgents(provider.id);
      const role = params.role ?? DEFAULT_LAUNCH_ROLE;
      const harnessKind = params.harnessKind ?? DEFAULT_HARNESS_KIND;
      const command =
        params.command ??
        defaultCommandForHarness(harnessKind as HarnessSpec["kind"]);
      const agentId = params.agentId ?? nextAgentId(role, agents);
      if (!params.cwd) {
        throw new Error(
          "cwd is required to launch an agent; ask the operator which working directory/workspace to use.",
        );
      }
      const cwd = params.cwd;
      const workspace = params.workspace ?? workspaceLabelFromCwd(cwd);

      const launched = await api.launchRuntimeAgent(provider.id, {
        agentId,
        role,
        harness: {
          kind: harnessKind,
          command,
          ...(params.args !== undefined ? { args: params.args } : {}),
          cwd,
          ...(params.env !== undefined ? { env: params.env } : {}),
        },
        ...(params.displayName !== undefined
          ? { displayName: params.displayName }
          : {}),
        cwd,
        workspace,
        ...(params.env !== undefined ? { env: params.env } : {}),
      });
      let attached = false;
      let attachError: string | undefined;
      if (provider.capabilities.attachInteractive) {
        try {
          await api.attachRuntimeAgent(provider.id, agentId);
          attached = true;
        } catch (error) {
          attachError = formatToolError(error);
        }
      }
      void poller.tick();
      return ok(
        `agent ${agentId} launched on ${provider.id} (binding ${launched.agent.bindingId})${
          attached
            ? " and focused"
            : attachError
              ? `; focus failed: ${attachError}`
              : ""
        }`,
        {
          agent: launched.agent,
          defaults: { role, harnessKind, command, cwd, workspace },
          attached,
          ...(attachError !== undefined ? { attachError } : {}),
        },
      );
    },
  });

  const readAgent = defineTool({
    name: "read_runtime_agent",
    label: "Read agent output",
    description:
      "Read the last N lines of terminal output for a bound runtime agent. agentId may be a room agent id with a runtime binding or a runtime pane/agent id.",
    parameters: Type.Object({
      providerId: Type.String(),
      agentId: Type.String(),
      lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    }),
    execute: async (_callId, params) => {
      const out = await api.readRuntimeAgent(
        params.providerId,
        params.agentId,
        params.lines ?? 120,
      );
      return jsonContent(out.output);
    },
  });

  const sendInput = defineTool({
    name: "send_runtime_agent_input",
    label: "Send input to an agent",
    description:
      "Send a line of input to a bound runtime agent. agentId may be a room agent id with a runtime binding or a runtime pane/agent id. Set submit=true (default) to press Enter.",
    parameters: Type.Object({
      providerId: Type.String(),
      agentId: Type.String(),
      text: Type.String(),
      submit: Type.Optional(Type.Boolean({ default: true })),
    }),
    execute: async (_callId, params) => {
      await api.sendRuntimeAgentInput(params.providerId, params.agentId, {
        text: params.text,
        submit: params.submit ?? true,
      });
      void poller.tick();
      return ok(`input sent to ${params.agentId}`);
    },
  });

  const refresh = defineTool({
    name: "refresh_dashboard",
    label: "Refresh dashboard",
    description:
      "Force a refresh of dashboard data (health/messages/tasks/agents).",
    parameters: Type.Object({}),
    execute: async () => {
      await poller.tick();
      return ok("dashboard refreshed");
    },
  });

  const getHealth = defineTool({
    name: "get_health",
    label: "Daemon health",
    description: "Return daemon health, runtime, and chat gateway summary.",
    parameters: Type.Object({}),
    execute: async () => {
      const health = await api.health();
      return jsonContent(health);
    },
  });

  return [
    listMessages,
    postMessage,
    listTasks,
    listWorkspaces,
    registerWorkspace,
    createTask,
    claimTask,
    updateTaskStatus,
    listEvents,
    getRoomProtocol,
    listProviders,
    listAgents,
    getRuntimeStatus,
    launchAgent,
    readAgent,
    sendInput,
    refresh,
    getHealth,
  ] as AgentTool[];
}
