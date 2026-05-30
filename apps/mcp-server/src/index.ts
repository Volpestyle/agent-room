#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type ActorRef,
  type AgentState,
  AgentRoomService,
  type EventCursor,
  type Id,
  type Importance,
  type MessageKind,
  type RoomEvent,
  type TaskStatus,
} from "@agentroom/core";
import {
  createDefaultAgentRoomConfig,
  defaultRoomIdFromEnv,
  loadAgentRoomConfig,
  readAgentRoomSessionIdentity,
  resolveStoragePath,
  writeAgentRoomSessionIdentity,
} from "@agentroom/config";
import { JsonlEventStore } from "@agentroom/storage-jsonl";
import { z } from "zod";

const DEFAULT_MESSAGE_LIMIT = 20;
const DEFAULT_TASK_LIMIT = 20;
const DEFAULT_EVENT_LIMIT = 20;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 300;
const MAX_LIMIT = 100;
const MAX_WAIT_TIMEOUT_SECONDS = 900;
const MAX_TEXT_CHARS = 12_000;

const messageKindSchema = z.enum([
  "chat",
  "announcement",
  "status",
  "question",
  "answer",
  "decision",
  "handoff",
  "review",
  "approval-request",
  "approval-result",
]);

const importanceSchema = z.enum(["low", "normal", "high", "urgent"]);

const taskStatusSchema = z.enum([
  "planned",
  "assigned",
  "claimed",
  "working",
  "blocked",
  "ready-for-review",
  "changes-requested",
  "approved",
  "merged",
  "failed",
  "done",
  "canceled",
]);

const agentStateSchema = z.enum([
  "created",
  "starting",
  "online",
  "working",
  "waiting",
  "blocked",
  "needs-human",
  "reviewing",
  "done",
  "idle",
  "failed",
  "stopped",
  "unknown",
]);

const taskActionSchema = z.enum([
  "create",
  "list",
  "show",
  "claim",
  "status",
  "comment",
  "link-tracker",
  "request-review",
  "approve",
  "changes-requested",
]);

interface RoomContext {
  cwd: string;
  roomId: string;
  service: AgentRoomService;
  events: JsonlEventStore;
}

async function main(): Promise<void> {
  const server = new McpServer(
    {
      name: "agentroom",
      version: "0.1.0",
    },
    {
      instructions:
        "AgentRoom coordination tools for room messages, DMs, watchable delegated task handles, task shadows, waits, and audit context. Prefer bounded reads. Use the configured work tracker MCP, CLI, or skill as the durable tracker, then link external issue refs with agentroom_task action=link-tracker.",
    },
  );

  registerTools(server);
  await server.connect(new StdioServerTransport());
}

function registerTools(server: McpServer): void {
  server.registerTool(
    "agentroom_whoami",
    {
      description:
        "Resolve the current AgentRoom identity from AGENTROOM_* environment or the local runtime binding.",
      inputSchema: {},
    },
    async () => jsonResult(await whoami()),
  );

  server.registerTool(
    "agentroom_enroll",
    {
      description:
        "Persist an AgentRoom identity for this MCP/session when AGENTROOM_* env is unavailable.",
      inputSchema: {
        agentId: z.string().min(1),
        role: z.string().optional(),
        roomId: z.string().optional(),
        bindingId: z.string().optional(),
        paneId: z.string().optional(),
      },
    },
    async (input) => {
      const ctx = await roomContext();
      const agent =
        (await ctx.service.getAgent(input.agentId)) ??
        (await ctx.service.registerAgent({
          id: input.agentId,
          role: parseRole(input.role),
        }));
      if (input.bindingId !== undefined || input.paneId !== undefined) {
        await ctx.service.bindRuntime({
          agentId: input.agentId,
          runtime: {
            providerId: "manual",
            bindingId: input.bindingId ?? input.paneId ?? input.agentId,
            kind: "custom",
          },
        });
      }
      const roomId = input.roomId ?? ctx.roomId;
      const env = {
        AGENTROOM: "1",
        AGENTROOM_AGENT_ID: input.agentId,
        AGENTROOM_ROOM_ID: roomId,
        ...(input.role !== undefined ? { AGENTROOM_ROLE: input.role } : {}),
      };
      await writeAgentRoomSessionIdentity(ctx.cwd, {
        agentId: input.agentId,
        roomId,
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.bindingId !== undefined
          ? { bindingId: input.bindingId }
          : {}),
        ...(input.paneId !== undefined ? { paneId: input.paneId } : {}),
        env,
        updatedAt: new Date().toISOString(),
      });
      return jsonResult({ enrolled: true, agent, roomId, source: "session" });
    },
  );

  server.registerTool(
    "agentroom_context",
    {
      description:
        "Read a compact AgentRoom snapshot: identity, recent messages, task shadows, and audit events.",
      inputSchema: {
        messagesLimit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        tasksLimit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        eventsLimit: z.number().int().min(0).max(MAX_LIMIT).optional(),
        channel: z.string().optional(),
        withAgentId: z.string().optional(),
      },
    },
    async (input) => {
      const ctx = await roomContext();
      const actor = await currentActor(ctx.service);
      const messages = await ctx.service.listMessages({
        limit: input.messagesLimit ?? DEFAULT_MESSAGE_LIMIT,
        ...(input.channel !== undefined ? { channelId: input.channel } : {}),
        ...(input.withAgentId !== undefined
          ? { participant: { kind: "agent", id: input.withAgentId } }
          : {}),
      });
      const tasks = (await ctx.service.listTasks()).slice(
        -(input.tasksLimit ?? DEFAULT_TASK_LIMIT),
      );
      const events =
        input.eventsLimit === 0
          ? []
          : await ctx.events.list({
              roomId: ctx.roomId,
              limit: input.eventsLimit ?? DEFAULT_EVENT_LIMIT,
            });

      return jsonResult({
        cwd: ctx.cwd,
        roomId: ctx.roomId,
        generatedAt: new Date().toISOString(),
        actor,
        messages,
        tasks,
        events,
      });
    },
  );

  server.registerTool(
    "agentroom_agents",
    {
      description:
        "List enrolled room agents with role, state, runtime binding, and last heartbeat.",
      inputSchema: {},
    },
    async () => {
      const ctx = await roomContext();
      return jsonResult(await ctx.service.listAgentPresence());
    },
  );

  server.registerTool(
    "agentroom_messages",
    {
      description:
        "Read recent AgentRoom channel, thread, or DM messages with a bounded limit.",
      inputSchema: {
        channel: z.string().optional(),
        thread: z.string().optional(),
        withAgentId: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
    },
    async (input) => {
      const ctx = await roomContext();
      return jsonResult(
        await ctx.service.listMessages({
          limit: input.limit ?? DEFAULT_MESSAGE_LIMIT,
          ...(input.channel !== undefined ? { channelId: input.channel } : {}),
          ...(input.thread !== undefined ? { threadId: input.thread } : {}),
          ...(input.withAgentId !== undefined
            ? { participant: { kind: "agent", id: input.withAgentId } }
            : {}),
        }),
      );
    },
  );

  server.registerTool(
    "agentroom_directed_messages",
    {
      description:
        "Read recent directed messages addressed to the current AgentRoom agent.",
      inputSchema: {
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
    },
    async (input) => {
      const ctx = await roomContext();
      const actor = await currentActor(ctx.service);
      if (actor.kind !== "agent") {
        throw new Error(
          "agentroom_directed_messages requires an agent identity.",
        );
      }
      const messages = await ctx.service.listMessages({
        channelId: "dm",
        participant: actor,
        limit: input.limit ?? DEFAULT_MESSAGE_LIMIT,
      });
      return jsonResult(
        messages.filter((message) =>
          (message.recipients ?? []).some(
            (recipient) =>
              recipient.kind === "agent" && recipient.id === actor.id,
          ),
        ),
      );
    },
  );

  server.registerTool(
    "agentroom_events",
    {
      description:
        "Read recent AgentRoom audit events with a bounded limit and optional event type filter.",
      inputSchema: {
        type: z.string().optional(),
        since: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
    },
    async (input) => {
      const ctx = await roomContext();
      const events = await ctx.events.list({
        roomId: ctx.roomId,
        limit: input.limit ?? DEFAULT_EVENT_LIMIT,
        ...(input.since !== undefined ? { since: input.since } : {}),
      });
      return jsonResult(
        input.type === undefined
          ? events
          : events.filter((event) => event.type === input.type),
      );
    },
  );

  server.registerTool(
    "agentroom_post",
    {
      description:
        "Post a short AgentRoom channel message, status, handoff, question, decision, or review note.",
      inputSchema: {
        message: z.string().min(1),
        channel: z.string().optional(),
        thread: z.string().optional(),
        kind: messageKindSchema.optional(),
        importance: importanceSchema.optional(),
      },
    },
    async (input) => {
      const ctx = await roomContext();
      return jsonResult(
        await ctx.service.postMessage({
          body: input.message,
          sender: await currentActor(ctx.service),
          ...(input.channel !== undefined ? { channelId: input.channel } : {}),
          ...(input.thread !== undefined ? { threadId: input.thread } : {}),
          ...(input.kind !== undefined
            ? { kind: input.kind as MessageKind }
            : {}),
          ...(input.importance !== undefined
            ? { importance: input.importance as Importance }
            : {}),
        }),
      );
    },
  );

  server.registerTool(
    "agentroom_dm",
    {
      description:
        "Send a direct AgentRoom message to one or more room agents.",
      inputSchema: {
        agentId: z.string().optional(),
        agentIds: z.array(z.string()).optional(),
        to: z.string().optional(),
        message: z.string().min(1),
        thread: z.string().optional(),
      },
    },
    async (input) => {
      const recipients = normalizeRecipients(input);
      if (recipients.length === 0) {
        throw new Error("agentroom_dm requires agentId, agentIds, or to.");
      }
      const ctx = await roomContext();
      return jsonResult(
        await ctx.service.postMessage({
          body: input.message,
          channelId: "dm",
          sender: await currentActor(ctx.service),
          recipients: recipients.map((id) => ({ kind: "agent", id })),
          ...(input.thread !== undefined ? { threadId: input.thread } : {}),
        }),
      );
    },
  );

  server.registerTool(
    "agentroom_delegate_task",
    {
      description:
        "Assign work to a room agent and return a watchable task/delegation handle.",
      inputSchema: {
        agentId: z.string().min(1),
        work: z.string().min(1),
        description: z.string().optional(),
        notifyAgentId: z.string().optional(),
      },
    },
    async (input) => {
      const ctx = await roomContext();
      const actor = await currentActor(ctx.service);
      const notify =
        input.notifyAgentId !== undefined
          ? ({ kind: "agent", id: input.notifyAgentId } as const)
          : actor.kind === "agent"
            ? actor
            : undefined;
      const result = await ctx.service.delegateTask({
        agentId: input.agentId,
        work: input.work,
        delegatedBy: actor,
        ...(notify !== undefined ? { notify } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
      });
      const message = await ctx.service.postMessage({
        body: `Delegated ${result.task.id}: ${input.work}`,
        channelId: "dm",
        sender: actor,
        recipients: [{ kind: "agent", id: input.agentId }],
        kind: "handoff",
        threadId: result.task.id,
      });
      return jsonResult({
        ...result,
        message,
        handle: result.task.id,
        await: {
          tool: "agentroom_wait",
          arguments: { taskId: result.task.id },
        },
      });
    },
  );

  server.registerTool(
    "agentroom_task",
    {
      description:
        "Create, list, show, claim, update, comment on, or tracker-link an AgentRoom task shadow.",
      inputSchema: {
        action: taskActionSchema,
        taskId: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        assignee: z.string().optional(),
        status: taskStatusSchema.optional(),
        reason: z.string().optional(),
        summary: z.string().optional(),
        comment: z.string().optional(),
        issueId: z.string().optional(),
        providerKind: z.string().optional(),
        providerId: z.string().optional(),
        url: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
    },
    async (input) => jsonResult(await runTaskTool(input)),
  );

  server.registerTool(
    "agentroom_wait",
    {
      description:
        "Block until a matching future AgentRoom message, DM, or task-status event arrives.",
      inputSchema: {
        message: z.string().optional(),
        ignoreCase: z.boolean().optional(),
        fromAgentId: z.string().optional(),
        channel: z.string().optional(),
        kind: messageKindSchema.optional(),
        taskStatus: z.string().optional(),
        taskId: z.string().optional(),
        status: taskStatusSchema.optional(),
        agentId: z.string().optional(),
        agentState: agentStateSchema.optional(),
        dmToMe: z.boolean().optional(),
        timeoutSeconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_TIMEOUT_SECONDS)
          .optional(),
        since: z.string().optional(),
      },
    },
    async (input) => jsonResult(await waitForEvent(input)),
  );
}

async function runTaskTool(input: {
  action: z.infer<typeof taskActionSchema>;
  taskId?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  assignee?: string | undefined;
  status?: z.infer<typeof taskStatusSchema> | undefined;
  reason?: string | undefined;
  summary?: string | undefined;
  comment?: string | undefined;
  issueId?: string | undefined;
  providerKind?: string | undefined;
  providerId?: string | undefined;
  url?: string | undefined;
  limit?: number | undefined;
}): Promise<unknown> {
  const ctx = await roomContext();
  const actor = await currentActor(ctx.service);

  switch (input.action) {
    case "create":
      if (input.title === undefined || input.title.trim().length === 0) {
        throw new Error("agentroom_task action=create requires title.");
      }
      return await ctx.service.createTask({
        title: input.title,
        createdBy: actor,
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.assignee !== undefined
          ? { assignee: { kind: "agent", id: input.assignee } }
          : {}),
        ...(input.issueId !== undefined
          ? {
              refs: [trackerRef(input.issueId, trackerRefOptions(input))],
            }
          : {}),
      });
    case "list":
      return (await ctx.service.listTasks()).slice(
        -(input.limit ?? DEFAULT_TASK_LIMIT),
      );
    case "show":
      return await requireTask(ctx.service, input.taskId);
    case "claim":
      return await ctx.service.claimTask({
        taskId: requireTaskId(input.taskId),
        assignee:
          input.assignee !== undefined
            ? { kind: "agent", id: input.assignee }
            : actor,
      });
    case "status":
      if (input.status === undefined) {
        throw new Error("agentroom_task action=status requires status.");
      }
      return await ctx.service.updateTaskStatus({
        taskId: requireTaskId(input.taskId),
        status: input.status as TaskStatus,
        actor,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
      });
    case "request-review": {
      const taskId = requireTaskId(input.taskId);
      const task = await ctx.service.updateTaskStatus({
        taskId,
        status: "ready-for-review",
        actor,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
      });
      const message = await ctx.service.postMessage({
        body: input.summary ?? `${taskId} is ready for review`,
        channelId: input.assignee === undefined ? "implementation" : "dm",
        sender: actor,
        kind: "review",
        threadId: taskId,
        ...(input.assignee !== undefined
          ? { recipients: [{ kind: "agent" as const, id: input.assignee }] }
          : {}),
      });
      return { task, message };
    }
    case "approve": {
      const taskId = requireTaskId(input.taskId);
      const task = await ctx.service.updateTaskStatus({
        taskId,
        status: "approved",
        actor,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
      });
      const message = await ctx.service.postMessage({
        body: input.summary ?? `${taskId} approved`,
        channelId: "implementation",
        sender: actor,
        kind: "review",
        threadId: taskId,
      });
      return { task, message };
    }
    case "changes-requested": {
      const taskId = requireTaskId(input.taskId);
      const reason = input.reason?.trim();
      if (!reason) {
        throw new Error(
          "agentroom_task action=changes-requested requires reason.",
        );
      }
      const task = await ctx.service.updateTaskStatus({
        taskId,
        status: "changes-requested",
        actor,
        reason,
      });
      const message = await ctx.service.postMessage({
        body: reason,
        channelId: "implementation",
        sender: actor,
        kind: "review",
        threadId: taskId,
      });
      return { task, message };
    }
    case "comment": {
      const body = input.comment?.trim();
      if (body === undefined || body.length === 0) {
        throw new Error("agentroom_task action=comment requires comment.");
      }
      return await ctx.service.postMessage({
        body,
        channelId: "implementation",
        sender: actor,
        kind: "status",
        threadId: requireTaskId(input.taskId),
      });
    }
    case "link-tracker":
      if (input.issueId === undefined || input.issueId.trim().length === 0) {
        throw new Error("agentroom_task action=link-tracker requires issueId.");
      }
      return await ctx.service.linkTaskRef({
        taskId: requireTaskId(input.taskId),
        ref: trackerRef(input.issueId, trackerRefOptions(input)),
      });
  }
}

async function waitForEvent(input: {
  message?: string | undefined;
  ignoreCase?: boolean | undefined;
  fromAgentId?: string | undefined;
  channel?: string | undefined;
  kind?: z.infer<typeof messageKindSchema> | undefined;
  taskStatus?: string | undefined;
  taskId?: string | undefined;
  status?: z.infer<typeof taskStatusSchema> | undefined;
  agentId?: string | undefined;
  agentState?: z.infer<typeof agentStateSchema> | undefined;
  dmToMe?: boolean | undefined;
  timeoutSeconds?: number | undefined;
  since?: string | undefined;
}): Promise<RoomEvent> {
  const ctx = await roomContext();
  const actor = await currentActor(ctx.service);
  const matchers = buildWaitMatchers(input, actor);
  if (matchers.length === 0) {
    throw new Error(
      "agentroom_wait requires message, taskStatus/taskId+status, agentId+agentState, or dmToMe.",
    );
  }

  const since =
    input.since === undefined || input.since === "now"
      ? new Date().toISOString()
      : parseSince(input.since);
  let cursor: EventCursor = await ctx.service.eventCursor("end");
  const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (true) {
    const batch = await ctx.service.listEventsFromCursor(cursor);
    cursor = batch.cursor;
    const match = batch.events.find(
      (event) =>
        event.createdAt > since && matchers.some((matcher) => matcher(event)),
    );
    if (match !== undefined) return match;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Timed out waiting for matching event after ${timeoutSeconds}s.`,
      );
    }
    await sleep(Math.min(1000, remaining));
  }
}

function buildWaitMatchers(
  input: {
    message?: string | undefined;
    ignoreCase?: boolean | undefined;
    fromAgentId?: string | undefined;
    channel?: string | undefined;
    kind?: z.infer<typeof messageKindSchema> | undefined;
    taskStatus?: string | undefined;
    taskId?: string | undefined;
    status?: z.infer<typeof taskStatusSchema> | undefined;
    agentId?: string | undefined;
    agentState?: z.infer<typeof agentStateSchema> | undefined;
    dmToMe?: boolean | undefined;
  },
  actor: ActorRef,
): Array<(event: RoomEvent) => boolean> {
  const matchers: Array<(event: RoomEvent) => boolean> = [];

  if (input.message !== undefined) {
    const pattern = compileMessagePattern(input.message, input.ignoreCase);
    matchers.push(
      (event) =>
        event.type === "message.posted" &&
        messageScopeMatches(event, input) &&
        pattern.test(event.payload.message.body),
    );
  }

  const taskStatus =
    input.taskStatus ??
    (input.taskId !== undefined && input.status !== undefined
      ? `${input.taskId}:${input.status}`
      : undefined);
  if (taskStatus !== undefined) {
    const parsed = parseTaskStatusMatcher(taskStatus);
    matchers.push(
      (event) =>
        event.type === "task.status_changed" &&
        event.payload.taskId === parsed.taskId &&
        event.payload.status === parsed.status,
    );
  }

  if (input.agentId !== undefined && input.agentState !== undefined) {
    matchers.push((event) =>
      agentStateMatches(event, input.agentId!, input.agentState!),
    );
  }

  if (input.dmToMe === true) {
    if (actor.kind !== "agent") {
      throw new Error("agentroom_wait dmToMe requires an agent identity.");
    }
    matchers.push(
      (event) =>
        event.type === "message.posted" &&
        messageScopeMatches(event, input) &&
        (event.payload.message.recipients ?? []).some(
          (recipient) =>
            recipient.kind === "agent" && recipient.id === actor.id,
        ),
    );
  }

  return matchers;
}

function messageScopeMatches(
  event: RoomEvent,
  input: {
    fromAgentId?: string | undefined;
    channel?: string | undefined;
    kind?: z.infer<typeof messageKindSchema> | undefined;
  },
): boolean {
  if (event.type !== "message.posted") return false;
  const message = event.payload.message;
  if (
    input.fromAgentId !== undefined &&
    (message.sender.kind !== "agent" || message.sender.id !== input.fromAgentId)
  ) {
    return false;
  }
  if (input.channel !== undefined && message.channelId !== input.channel) {
    return false;
  }
  if (input.kind !== undefined && message.kind !== input.kind) {
    return false;
  }
  return true;
}

function agentStateMatches(
  event: RoomEvent,
  agentId: string,
  state: AgentState,
): boolean {
  switch (event.type) {
    case "agent.heartbeat":
      return event.payload.agentId === agentId && event.payload.state === state;
    case "runtime.state_observed":
      return event.payload.agentId === agentId && event.payload.state === state;
    case "agent.done":
      return event.payload.agentId === agentId && state === "done";
    case "agent.blocked":
      return event.payload.agentId === agentId && state === "blocked";
    case "agent.left":
      return event.payload.agentId === agentId && state === "stopped";
    case "agent.finished":
      return event.payload.agentId === agentId && event.payload.state === state;
    default:
      return false;
  }
}

function compileMessagePattern(
  value: string,
  ignoreCase: boolean | undefined,
): RegExp {
  let source = value;
  let flags = ignoreCase ? "i" : "";
  if (source.startsWith("(?i)")) {
    source = source.slice(4);
    flags = "i";
  }
  try {
    return new RegExp(source, flags);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid JavaScript message regex: ${reason}. Use ignoreCase instead of inline (?i) when possible.`,
    );
  }
}

async function roomContext(): Promise<RoomContext> {
  const cwd = process.env.AGENTROOM_CWD ?? process.cwd();
  const config = await loadAgentRoomConfig(cwd).catch(() =>
    createDefaultAgentRoomConfig({
      roomId: defaultRoomIdFromEnv(process.env),
      roomName: "AgentRoom",
      defaultRuntime: "herdr",
    }),
  );
  const events = new JsonlEventStore(resolveStoragePath(config, cwd));
  return {
    cwd,
    roomId: config.room.id,
    service: new AgentRoomService(events, { roomId: config.room.id }),
    events,
  };
}

async function whoami(): Promise<unknown> {
  const ctx = await roomContext();
  const identity = await resolveCurrentIdentity(ctx.service, ctx.cwd);
  return {
    enrolled: identity !== undefined,
    agentId: identity?.agentId,
    roomId: identity?.roomId ?? process.env.AGENTROOM_ROOM_ID ?? ctx.roomId,
    role: identity?.role ?? process.env.AGENTROOM_ROLE,
    source: identity?.source ?? "none",
    cwd: ctx.cwd,
  };
}

async function currentActor(service: AgentRoomService): Promise<ActorRef> {
  const identity = await resolveCurrentIdentity(
    service,
    process.env.AGENTROOM_CWD ?? process.cwd(),
  );
  if (identity !== undefined) return { kind: "agent", id: identity.agentId };
  return { kind: "human", id: process.env.USER ?? "local" };
}

async function resolveCurrentIdentity(
  service: AgentRoomService,
  cwd: string,
): Promise<
  | {
      agentId: string;
      roomId?: string;
      role?: string;
      source: "env" | "pane" | "session";
    }
  | undefined
> {
  const envAgentId = process.env.AGENTROOM_AGENT_ID?.trim();
  if (envAgentId) {
    return {
      agentId: envAgentId,
      ...(process.env.AGENTROOM_ROOM_ID !== undefined
        ? { roomId: process.env.AGENTROOM_ROOM_ID }
        : {}),
      ...(process.env.AGENTROOM_ROLE !== undefined
        ? { role: process.env.AGENTROOM_ROLE }
        : {}),
      source: "env",
    };
  }
  const paneAgentId = await resolveAgentByPane(service);
  if (paneAgentId !== undefined) {
    return {
      agentId: paneAgentId,
      ...(process.env.AGENTROOM_ROOM_ID !== undefined
        ? { roomId: process.env.AGENTROOM_ROOM_ID }
        : {}),
      ...(process.env.AGENTROOM_ROLE !== undefined
        ? { role: process.env.AGENTROOM_ROLE }
        : {}),
      source: "pane",
    };
  }
  const session = await readAgentRoomSessionIdentity(
    cwd,
    process.env.HERDR_PANE_ID,
  );
  if (session !== undefined) {
    return {
      agentId: session.agentId,
      roomId: session.roomId,
      ...(session.role !== undefined ? { role: session.role } : {}),
      source: "session",
    };
  }
  return undefined;
}

async function resolveAgentByPane(
  service: AgentRoomService,
): Promise<string | undefined> {
  const paneId = process.env.HERDR_PANE_ID;
  if (paneId === undefined || paneId.length === 0) return undefined;
  return await service.findAgentByBinding(paneId);
}

function jsonResult(value: unknown) {
  const truncated = truncateStrings(value);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(truncated, null, 2),
      },
    ],
  };
}

function truncateStrings(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= MAX_TEXT_CHARS) return value;
    return `${value.slice(0, MAX_TEXT_CHARS)}... [truncated ${value.length - MAX_TEXT_CHARS} chars]`;
  }
  if (Array.isArray(value)) return value.map((entry) => truncateStrings(entry));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = truncateStrings(entry);
    }
    return result;
  }
  return value;
}

function normalizeRecipients(input: {
  agentId?: string | undefined;
  agentIds?: string[] | undefined;
  to?: string | undefined;
}): string[] {
  return [
    ...(input.agentIds ?? []),
    ...(input.agentId !== undefined ? [input.agentId] : []),
    ...(input.to !== undefined ? input.to.split(",") : []),
  ]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function requireTask(
  service: AgentRoomService,
  taskId: string | undefined,
) {
  const task = await service.getTask(requireTaskId(taskId));
  if (task === undefined) throw new Error(`Task not found: ${taskId}`);
  return task;
}

function requireTaskId(taskId: string | undefined): Id {
  if (taskId === undefined || taskId.trim().length === 0) {
    throw new Error("taskId is required.");
  }
  return taskId.trim();
}

function parseRole(value: string | undefined) {
  const role = value ?? "implementer";
  const allowed = new Set([
    "lead",
    "planner",
    "implementer",
    "reviewer",
    "runner",
    "qa",
    "observer",
    "custom",
  ]);
  if (!allowed.has(role)) throw new Error(`Invalid agent role: ${role}`);
  return role as
    | "lead"
    | "planner"
    | "implementer"
    | "reviewer"
    | "runner"
    | "qa"
    | "observer"
    | "custom";
}

function trackerRef(
  issueId: string,
  options: {
    providerKind?: string;
    providerId?: string;
    url?: string;
  } = {},
) {
  const metadata: Record<string, unknown> = {
    providerKind: options.providerKind ?? "custom",
  };
  if (options.providerId !== undefined)
    metadata.providerId = options.providerId;
  return {
    kind: "tracker-issue" as const,
    id: issueId,
    ...(options.url !== undefined ? { url: options.url } : {}),
    metadata,
  };
}

function trackerRefOptions(input: {
  providerKind?: string | undefined;
  providerId?: string | undefined;
  url?: string | undefined;
}): {
  providerKind?: string;
  providerId?: string;
  url?: string;
} {
  return {
    ...(input.providerKind !== undefined
      ? { providerKind: input.providerKind }
      : {}),
    ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
  };
}

function parseTaskStatusMatcher(value: string): {
  taskId: string;
  status: TaskStatus;
} {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid taskStatus '${value}'. Expected taskId:status.`);
  }
  const status = taskStatusSchema.parse(value.slice(separator + 1));
  return {
    taskId: value.slice(0, separator),
    status,
  };
}

function parseSince(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(
      `Invalid since '${value}'. Expected ISO timestamp or 'now'.`,
    );
  }
  return new Date(timestamp).toISOString();
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
