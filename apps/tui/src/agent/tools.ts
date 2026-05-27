import type {
  AgentTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { ApiClient } from "../api.js";
import type { Poller } from "../poller.js";
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

function jsonContent(
  value: unknown,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: {},
  };
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
        ...(params.channelId !== undefined ? { channelId: params.channelId } : {}),
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
        ...(params.channelId !== undefined ? { channelId: params.channelId } : {}),
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
      return ok(`task created (${created.task.id})`, { taskId: created.task.id });
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
      "List agents currently known to a runtime provider (id, binding, state).",
    parameters: Type.Object({
      providerId: Type.String(),
    }),
    execute: async (_callId, params) => {
      const agents = await api.listRuntimeAgents(params.providerId);
      return jsonContent(agents);
    },
  });

  const launchAgent = defineTool({
    name: "launch_runtime_agent",
    label: "Launch a runtime agent",
    description:
      "Start an agent under a runtime provider with a configured harness.",
    parameters: Type.Object({
      providerId: Type.String(),
      agentId: Type.String(),
      role: Type.Union([
        Type.Literal("lead"),
        Type.Literal("planner"),
        Type.Literal("implementer"),
        Type.Literal("reviewer"),
        Type.Literal("runner"),
        Type.Literal("qa"),
        Type.Literal("observer"),
        Type.Literal("custom"),
      ]),
      harnessKind: Type.Union([
        Type.Literal("claude-code"),
        Type.Literal("pi"),
        Type.Literal("codex"),
        Type.Literal("gemini-cli"),
        Type.Literal("shell"),
        Type.Literal("custom"),
      ]),
      command: Type.String(),
      args: Type.Optional(Type.Array(Type.String())),
      cwd: Type.Optional(Type.String()),
      displayName: Type.Optional(Type.String()),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
    }),
    execute: async (_callId, params) => {
      const launched = await api.launchRuntimeAgent(params.providerId, {
        agentId: params.agentId,
        role: params.role,
        harness: {
          kind: params.harnessKind,
          command: params.command,
          ...(params.args !== undefined ? { args: params.args } : {}),
          ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
          ...(params.env !== undefined ? { env: params.env } : {}),
        },
        ...(params.displayName !== undefined
          ? { displayName: params.displayName }
          : {}),
        ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
        ...(params.env !== undefined ? { env: params.env } : {}),
      });
      void poller.tick();
      return ok(
        `agent ${params.agentId} launched on ${params.providerId} (binding ${launched.agent.bindingId})`,
        { agent: launched.agent },
      );
    },
  });

  const readAgent = defineTool({
    name: "read_runtime_agent",
    label: "Read agent output",
    description:
      "Read the last N lines of terminal output for a bound runtime agent.",
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
      "Send a line of input to a bound runtime agent. Set submit=true (default) to press Enter.",
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
    description: "Force a refresh of dashboard data (health/messages/tasks/agents).",
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
    createTask,
    claimTask,
    updateTaskStatus,
    listEvents,
    listProviders,
    listAgents,
    launchAgent,
    readAgent,
    sendInput,
    refresh,
    getHealth,
  ] as AgentTool[];
}
