import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import {
  AgentRoomService,
  ChatGatewayOutboundDispatcher,
  ChatGatewayRouter,
  humanEscalationCreateSchema,
  messageCreateSchema,
  taskClaimSchema,
  taskCreateSchema,
  taskDeleteSchema,
  taskDetailsUpdateSchema,
  taskLinkRefSchema,
  taskStatusUpdateSchema,
  type ChatGatewayProvider,
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
import { HerdrPaneObserver, resolveHerdrSocketPath } from "./herdrObserver.js";
import { ProviderRegistry } from "./providerRegistry.js";
import {
  ChatGatewayRegistry,
  type ChatGatewayFactory,
} from "./chatGatewayRegistry.js";

export interface CreateAppOptions {
  roomId?: string;
  eventLogPath?: string;
  config?: AgentRoomConfig;
  cwd?: string;
  chatGateways?: ChatGatewayProvider[];
  startChatGateways?: boolean;
  chatGatewayRegistry?: ChatGatewayRegistry;
  chatGatewayFactory?: ChatGatewayFactory;
}

export interface CreateAppResult {
  app: Hono;
  chatGateways: ChatGatewayRegistry;
  chatStartup: Promise<void>;
  shutdown: () => Promise<void>;
}

export function createApp(options: CreateAppOptions = {}): Hono {
  return createAppWithLifecycle(options).app;
}

export function createAppWithLifecycle(
  options: CreateAppOptions = {},
): CreateAppResult {
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

  const chatRegistry =
    options.chatGatewayRegistry ??
    new ChatGatewayRegistry({
      ...(configured !== undefined ? { config: configured } : {}),
      ...(options.chatGateways !== undefined
        ? { providers: options.chatGateways }
        : {}),
      ...(options.chatGatewayFactory !== undefined
        ? { gatewayFactory: options.chatGatewayFactory }
        : {}),
    });

  const chatRoutes = chatRegistry.routes();
  const chatRouter = new ChatGatewayRouter({
    service,
    routes: chatRoutes,
    runtimeProviderForBinding: (binding) =>
      registry.runtime(binding.providerId),
  });
  const chatDispatcher = new ChatGatewayOutboundDispatcher({
    service,
    routes: chatRoutes,
    providerForRoute: (route) => chatRegistry.gateway(route.providerId),
  });
  const chatStartup =
    options.startChatGateways === false
      ? Promise.resolve()
      : chatRegistry.start(chatRouter);

  const herdrObservers = startHerdrObservers({
    ...(configured !== undefined ? { config: configured } : {}),
    registry,
    service,
    roomId,
  });

  const apiToken = process.env.AGENTROOM_API_TOKEN?.trim();

  const app = new Hono();

  app.use("/v1/*", async (c, next) => {
    if (isPublicV1Path(new URL(c.req.url).pathname)) {
      await next();
      return;
    }
    if (!apiToken) {
      await next();
      return;
    }
    if (isAuthorizedApiRequest(c.req.raw.headers, apiToken)) {
      await next();
      return;
    }

    c.header("WWW-Authenticate", 'Bearer realm="agentroom"');
    return c.json({ error: "unauthorized" }, 401);
  });

  app.get("/health", async (c) => {
    const runtimes = await Promise.all(
      registry.listRuntimes().map(async (provider) => ({
        id: provider.id,
        kind: provider.kind,
        capabilities: provider.capabilities,
        health: await provider.health(),
      })),
    );
    const chatGateways = await Promise.all(
      chatRegistry.listGateways().map(async (provider) => ({
        id: provider.id,
        kind: provider.kind,
        credentialKind: provider.credentialKind,
        health: await provider.health(),
        startupError: chatRegistry.startupError(provider.id),
      })),
    );

    return c.json({
      ok: true,
      pid: process.pid,
      roomId,
      auth: {
        apiTokenRequired: Boolean(apiToken),
      },
      runtimes,
      chatGateways,
    });
  });

  app.post("/v1/admin/shutdown", (c) => {
    const configuredToken = process.env.AGENTROOM_DAEMON_TOKEN;
    const requestToken = c.req.header("x-agentroom-daemon-token");
    if (!configuredToken || requestToken !== configuredToken) {
      return c.json({ error: "forbidden" }, 403);
    }

    setTimeout(() => {
      void chatRegistry.stop().finally(() => process.exit(0));
    }, 10);
    return c.json({ ok: true, pid: process.pid });
  });

  app.get("/v1/dashboard/config", (c) => {
    return c.json({
      roomId,
      cwd,
      operator: configured?.operator ?? null,
    });
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
    try {
      await chatStartup;
      await chatDispatcher.dispatchMessage(message);
    } catch (error) {
      console.error(
        `[chat-gateway] outbound dispatch failed for message ${message.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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

  app.patch("/v1/tasks/:taskId", async (c) => {
    const input = taskDetailsUpdateSchema.parse(await c.req.json());
    if (input.title === undefined && input.description === undefined) {
      return c.json({ error: "title or description is required" }, 400);
    }
    const task = await service.updateTaskDetails({
      taskId: c.req.param("taskId"),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
    });
    return c.json({ task });
  });

  app.delete("/v1/tasks/:taskId", async (c) => {
    const input = taskDeleteSchema.parse(await c.req.json());
    await service.deleteTask({
      taskId: c.req.param("taskId"),
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    return c.json({ ok: true });
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

  app.get("/v1/runtime/bindings/:agentId", async (c) => {
    const binding = await service.getRuntimeBinding(c.req.param("agentId"));
    return c.json({ binding: binding ?? null });
  });

  app.get("/v1/agents/by-binding/:bindingId", async (c) => {
    const agentId = await service.findAgentByBinding(c.req.param("bindingId"));
    return c.json({ agentId: agentId ?? null });
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

  app.get("/v1/chat/gateways", async (c) => {
    const gateways = await Promise.all(
      chatRegistry.listGateways().map(async (provider) => ({
        id: provider.id,
        kind: provider.kind,
        credentialKind: provider.credentialKind,
        health: await provider.health(),
        startupError: chatRegistry.startupError(provider.id),
      })),
    );
    return c.json({ gateways });
  });

  app.get("/v1/chat/routes", (c) => {
    const routes = chatRegistry.routes().map((route) => ({
      providerId: route.providerId,
      conversationId: route.conversationId,
      ...(route.conversationKind !== undefined
        ? { conversationKind: route.conversationKind }
        : {}),
      ...(route.threadId !== undefined ? { threadId: route.threadId } : {}),
      target: route.target,
      ...(route.outbound !== undefined ? { outbound: route.outbound } : {}),
    }));
    return c.json({ routes });
  });

  return {
    app,
    chatGateways: chatRegistry,
    chatStartup,
    shutdown: async () => {
      await Promise.all(herdrObservers.map((observer) => observer.stop()));
      await chatRegistry.stop();
    },
  };
}

function startHerdrObservers(input: {
  config?: AgentRoomConfig;
  registry: ProviderRegistry;
  service: AgentRoomService;
  roomId: string;
}): HerdrPaneObserver[] {
  if (!input.config) return [];
  const observers: HerdrPaneObserver[] = [];
  for (const [providerId, runtime] of Object.entries(input.config.runtimes)) {
    if (runtime.type !== "herdr") continue;
    const session = process.env.HERDR_SESSION ?? runtime.session;
    if (!session) continue;
    const socketPath = resolveHerdrSocketPath({
      ...(process.env.HERDR_SOCKET_PATH !== undefined
        ? { envSocketPath: process.env.HERDR_SOCKET_PATH }
        : {}),
      session,
      ...(process.env.XDG_CONFIG_HOME !== undefined
        ? { xdgConfigHome: process.env.XDG_CONFIG_HOME }
        : {}),
      ...(process.env.HOME !== undefined ? { home: process.env.HOME } : {}),
    });
    if (!socketPath) continue;

    let provider;
    try {
      provider = input.registry.runtime(providerId);
    } catch {
      continue;
    }
    if (!provider.adoptAgent) continue;

    const observer = new HerdrPaneObserver({
      socketPath,
      session,
      service: input.service,
      provider,
      roomId: input.roomId,
      logger: (message) => console.log(`[herdr-observer] ${message}`),
    });
    void observer.start().catch((error: Error) => {
      console.error(
        `[herdr-observer] failed to start for ${providerId}: ${error.message}`,
      );
    });
    observers.push(observer);
  }
  return observers;
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

function isPublicV1Path(pathname: string): boolean {
  return pathname.startsWith("/v1/admin/");
}

function isAuthorizedApiRequest(
  headers: Headers,
  expectedToken: string,
): boolean {
  const bearer = bearerToken(headers.get("authorization"));
  const headerToken = headers.get("x-agentroom-api-token");
  return (
    (bearer !== undefined && tokenMatches(bearer, expectedToken)) ||
    (headerToken !== null && tokenMatches(headerToken, expectedToken))
  );
}

function bearerToken(value: string | null): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
