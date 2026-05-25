import { Hono } from "hono";
import {
  AgentRoomService,
  humanEscalationCreateSchema,
  messageCreateSchema,
  taskClaimSchema,
  taskCreateSchema,
  taskLinkRefSchema,
  taskStatusUpdateSchema,
  type RuntimeProvider,
  type RuntimeBinding,
  type StartAgentRequest,
} from "@agentroom/core";
import {
  maybeLoadAgentRoomConfigSync,
  resolveStoragePath,
  type AgentRoomConfig,
} from "@agentroom/config";
import { JsonlEventStore } from "@agentroom/storage-jsonl";
import { ProviderRegistry } from "./providerRegistry.js";

export interface CreateAppOptions {
  roomId?: string;
  eventLogPath?: string;
  config?: AgentRoomConfig;
  cwd?: string;
}

export function createApp(options: CreateAppOptions = {}) {
  const cwd = options.cwd ?? process.cwd();
  const configured = options.config ?? maybeLoadAgentRoomConfigSync(cwd);
  const roomId =
    options.roomId ??
    process.env.AGENTROOM_ROOM_ID ??
    configured?.room.id ??
    "default";
  const eventLogPath =
    options.eventLogPath ??
    process.env.AGENTROOM_EVENT_LOG ??
    (configured
      ? resolveStoragePath(configured, cwd)
      : ".agentroom/events.jsonl");
  const store = new JsonlEventStore(eventLogPath);
  const service = new AgentRoomService(store, { roomId });
  const registry = new ProviderRegistry(configured);

  const app = new Hono();

  app.get("/health", async (c) => {
    const runtimes = await Promise.all(
      registry.listRuntimes().map(async (provider) => ({
        id: provider.id,
        kind: provider.kind,
        capabilities: provider.capabilities,
        health: await provider.health(),
      })),
    );

    return c.json({ ok: true, pid: process.pid, roomId, runtimes });
  });

  app.post("/v1/admin/shutdown", (c) => {
    const configuredToken = process.env.AGENTROOM_DAEMON_TOKEN;
    const requestToken = c.req.header("x-agentroom-daemon-token");
    if (!configuredToken || requestToken !== configuredToken) {
      return c.json({ error: "forbidden" }, 403);
    }

    setTimeout(() => process.exit(0), 10);
    return c.json({ ok: true, pid: process.pid });
  });

  app.get("/v1/events", async (c) => {
    const limit = Number(c.req.query("limit") ?? "100");
    const events = await store.list({ roomId, limit });
    return c.json({ events });
  });

  app.get("/v1/messages", async (c) => {
    const limit = Number(c.req.query("limit") ?? "100");
    const channelId = c.req.query("channelId") ?? c.req.query("channel");
    const threadId = c.req.query("threadId") ?? c.req.query("thread");
    const participantId =
      c.req.query("participantId") ?? c.req.query("participant");
    const participantKind = c.req.query("participantKind") ?? "agent";
    const messages = await service.listMessages({
      limit,
      ...(channelId !== undefined ? { channelId } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      ...(participantId !== undefined
        ? {
            participant: {
              kind: actorKind(participantKind),
              id: participantId,
            },
          }
        : {}),
    });
    return c.json({ messages });
  });

  app.get("/v1/tasks", async (c) => {
    return c.json({ tasks: await service.listTasks() });
  });

  app.post("/v1/messages", async (c) => {
    const body = await c.req.json();
    const input = messageCreateSchema.parse(body);
    const message = await service.postMessage({
      body: input.body,
      channelId: input.channelId,
      sender: input.sender,
      ...(input.recipients !== undefined
        ? { recipients: input.recipients }
        : {}),
      kind: input.kind,
      importance: input.importance,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    });
    return c.json({ message }, 201);
  });

  app.post("/v1/tasks", async (c) => {
    const body = await c.req.json();
    const input = taskCreateSchema.parse(body);
    const task = await service.createTask({
      title: input.title,
      createdBy: input.createdBy,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.assigneeId !== undefined
        ? { assignee: { kind: "agent" as const, id: input.assigneeId } }
        : {}),
      ...(input.refs.length > 0 ? { refs: input.refs } : {}),
    });
    return c.json({ task }, 201);
  });

  app.get("/v1/tasks/:taskId", async (c) => {
    const task = await service.getTask(c.req.param("taskId"));
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ task });
  });

  app.post("/v1/tasks/:taskId/refs", async (c) => {
    const input = taskLinkRefSchema.parse(await c.req.json());
    const task = await service.linkTaskRef({
      taskId: c.req.param("taskId"),
      ref: input.ref,
    });
    return c.json({ task });
  });

  app.post("/v1/tasks/:taskId/claim", async (c) => {
    const input = taskClaimSchema.parse(await c.req.json());
    const task = await service.claimTask({
      taskId: c.req.param("taskId"),
      assignee: input.assignee,
    });
    return c.json({ task });
  });

  app.patch("/v1/tasks/:taskId/status", async (c) => {
    const input = taskStatusUpdateSchema.parse(await c.req.json());
    const task = await service.updateTaskStatus({
      taskId: c.req.param("taskId"),
      status: input.status,
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
    });
    return c.json({ task });
  });

  app.post("/v1/human-escalations", async (c) => {
    const input = humanEscalationCreateSchema.parse(await c.req.json());
    const escalation = await service.askHuman({
      question: input.question,
      from: input.from,
      priority: input.priority,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    });
    return c.json({ escalation }, 201);
  });

  app.get("/v1/runtime/providers", (c) => {
    return c.json({
      providers: registry.listRuntimes().map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        capabilities: provider.capabilities,
      })),
    });
  });

  app.get("/v1/runtime/:providerId/agents", async (c) => {
    const provider = registry.runtime(c.req.param("providerId"));
    return c.json({ agents: await provider.listAgents() });
  });

  app.post("/v1/runtime/:providerId/agents", async (c) => {
    const provider = registry.runtime(c.req.param("providerId"));
    const body = (await c.req.json()) as Partial<StartAgentRequest> & {
      displayName?: string;
    };
    if (!body.agentId) return c.json({ error: "agentId is required" }, 400);
    if (!body.role) return c.json({ error: "role is required" }, 400);
    if (!body.harness) return c.json({ error: "harness is required" }, 400);

    await service.registerAgent({
      id: body.agentId,
      role: body.role,
      harness: body.harness,
      ...(body.displayName !== undefined
        ? { displayName: body.displayName }
        : {}),
    });

    const agent = await provider.startAgent({
      agentId: body.agentId,
      roomId,
      role: body.role,
      harness: body.harness,
      ...(body.displayName !== undefined
        ? { displayName: body.displayName }
        : {}),
      ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
      ...(body.env !== undefined ? { env: body.env } : {}),
    });

    await service.bindRuntime({
      agentId: body.agentId,
      runtime: bindingFor(provider, agent.bindingId, agent.metadata),
    });

    return c.json({ agent }, 201);
  });

  app.get("/v1/runtime/:providerId/agents/:agentId/output", async (c) => {
    const provider = registry.runtime(c.req.param("providerId"));
    const agentId = c.req.param("agentId");
    const binding = await service.getRuntimeBinding(agentId);
    const lines = Number(c.req.query("lines") ?? "80");
    const bindingId = bindingIdFor(provider, binding);
    const output = await provider.readAgent({
      agentId,
      ...(bindingId !== undefined ? { bindingId } : {}),
      lines,
    });
    await service.recordRuntimeOutput({
      agentId,
      text: output.text,
      ...(output.lineCount !== undefined
        ? { lineCount: output.lineCount }
        : {}),
    });
    return c.json({ output });
  });

  app.post("/v1/runtime/:providerId/agents/:agentId/input", async (c) => {
    const provider = registry.runtime(c.req.param("providerId"));
    const agentId = c.req.param("agentId");
    const binding = await service.getRuntimeBinding(agentId);
    const body = (await c.req.json()) as { text?: string; submit?: boolean };
    if (!body.text) return c.json({ error: "text is required" }, 400);
    const bindingId = bindingIdFor(provider, binding);
    await provider.sendInput({
      agentId,
      ...(bindingId !== undefined ? { bindingId } : {}),
      text: body.text,
      ...(body.submit !== undefined ? { submit: body.submit } : {}),
    });
    await service.recordRuntimeInput({
      agentId,
      text: body.text,
      source: { kind: "human", id: "api" },
    });
    return c.json({ ok: true });
  });

  return app;
}

function bindingFor(
  provider: RuntimeProvider,
  bindingId: string,
  metadata?: Record<string, unknown>,
): RuntimeBinding {
  return {
    providerId: provider.id,
    bindingId,
    kind:
      provider.kind === "tmux" || provider.kind === "herdr"
        ? "pane"
        : "process",
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function bindingIdFor(
  provider: RuntimeProvider,
  binding?: RuntimeBinding,
): string | undefined {
  return binding?.providerId === provider.id ? binding.bindingId : undefined;
}

function actorKind(value: string): "human" | "agent" | "system" | "connector" {
  if (
    value === "human" ||
    value === "agent" ||
    value === "system" ||
    value === "connector"
  )
    return value;
  return "agent";
}
