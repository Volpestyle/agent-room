import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import {
  AgentRoomService,
  ChatGatewayOutboundDispatcher,
  ChatGatewayRouter,
  agentRoleSchema,
  agentStateSchema,
  createId,
  harnessKindSchema,
  humanEscalationCreateSchema,
  messageCreateSchema,
  nowIso,
  taskClaimSchema,
  taskCreateSchema,
  taskDeleteSchema,
  taskDetailsUpdateSchema,
  taskLinkRefSchema,
  taskStatusUpdateSchema,
  type ChatGatewayProvider,
  type HarnessSpec,
  type RoomEvent,
  type RuntimeBinding,
  type RuntimeHealth,
  type RuntimeProvider,
  type StartAgentRequest,
} from "@agentroom/core";
import {
  defaultRoomIdFromEnv,
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
    defaultRoomIdFromEnv(process.env);
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
  app.onError((error, c) => {
    console.error(
      `[http] ${c.req.method} ${new URL(c.req.url).pathname} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return c.json({ error: errorMessage(error) }, 500);
  });

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
        health: await safeRuntimeHealth(provider),
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
      cwd,
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
      defaultRuntime: configured?.runtime.default ?? null,
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

  app.get("/v1/agents", async (c) => {
    return c.json({ agents: await service.listAgents() });
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

  app.post("/v1/agents", async (c) => {
    const body = (await c.req.json()) as {
      agentId?: string;
      displayName?: string;
      role?: unknown;
      harness?: Partial<HarnessSpec>;
      capabilities?: unknown;
    };
    if (!body.agentId) return c.json({ error: "agentId is required" }, 400);
    if (!body.role) return c.json({ error: "role is required" }, 400);
    const role = agentRoleSchema.safeParse(body.role);
    if (!role.success) {
      return c.json({ error: `Invalid agent role: ${String(body.role)}` }, 400);
    }

    let harness: HarnessSpec | undefined;
    if (body.harness !== undefined) {
      const harnessKind = harnessKindSchema.safeParse(body.harness.kind);
      if (!harnessKind.success) {
        return c.json(
          { error: `Invalid harness kind: ${String(body.harness.kind)}` },
          400,
        );
      }
      if (!body.harness.command) {
        return c.json({ error: "harness.command is required" }, 400);
      }
      harness = {
        ...body.harness,
        kind: harnessKind.data,
        command: body.harness.command,
      };
    }

    const capabilities = Array.isArray(body.capabilities)
      ? body.capabilities.filter(
          (capability): capability is string => typeof capability === "string",
        )
      : undefined;
    const agent = await service.registerAgent({
      id: body.agentId,
      role: role.data,
      ...(body.displayName !== undefined
        ? { displayName: body.displayName }
        : {}),
      ...(harness !== undefined ? { harness } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
    });
    return c.json({ agent }, 201);
  });

  app.post("/v1/agents/:agentId/heartbeat", async (c) => {
    const body = (await c.req.json()) as { state?: unknown; status?: string };
    const state = agentStateSchema.safeParse(body.state);
    if (!state.success) {
      return c.json(
        { error: `Invalid agent state: ${String(body.state)}` },
        400,
      );
    }
    await service.recordAgentHeartbeat({
      agentId: c.req.param("agentId"),
      state: state.data,
      ...(body.status !== undefined ? { status: body.status } : {}),
    });
    return c.json({ ok: true });
  });

  app.delete("/v1/agents/:agentId", async (c) => {
    let body: { reason?: string } = {};
    try {
      body = (await c.req.json()) as { reason?: string };
    } catch {
      // request body is optional
    }
    await service.leaveAgent({
      agentId: c.req.param("agentId"),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    });
    return c.json({ ok: true, agentId: c.req.param("agentId") });
  });

  app.get("/v1/runtime/providers", (c) => {
    return c.json({
      providers: registry.listRuntimes().map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        default: provider.id === configured?.runtime.default,
        capabilities: provider.capabilities,
      })),
    });
  });

  app.get("/v1/runtime/:providerId/agents", async (c) => {
    const provider = registry.runtime(c.req.param("providerId"));
    return c.json({ agents: await provider.listAgents() });
  });

  app.get("/v1/runtime/:providerId/sessions", async (c) => {
    const provider = registry.runtime(c.req.param("providerId"));
    return c.json({ sessions: await provider.listSessions() });
  });

  app.get("/v1/runtime/bindings/:agentId", async (c) => {
    const binding = await service.getRuntimeBinding(c.req.param("agentId"));
    return c.json({ binding: binding ?? null });
  });

  app.get("/v1/agents/by-binding/:bindingId", async (c) => {
    const agentId = await service.findAgentByBinding(c.req.param("bindingId"));
    return c.json({ agentId: agentId ?? null });
  });

  app.get("/v1/agents/:agentId", async (c) => {
    const agent = await service.getAgent(c.req.param("agentId"));
    if (!agent) return c.json({ error: "agent not found" }, 404);
    return c.json({ agent });
  });

  app.post("/v1/runtime/:providerId/agents", async (c) => {
    const provider = registry.runtime(c.req.param("providerId"));
    const body = (await c.req.json()) as Partial<StartAgentRequest> & {
      displayName?: string;
    };
    if (!body.agentId) return c.json({ error: "agentId is required" }, 400);
    if (!body.role) return c.json({ error: "role is required" }, 400);
    if (!body.harness) return c.json({ error: "harness is required" }, 400);
    const role = agentRoleSchema.safeParse(body.role);
    if (!role.success) {
      return c.json({ error: `Invalid agent role: ${String(body.role)}` }, 400);
    }
    const harnessKind = harnessKindSchema.safeParse(body.harness.kind);
    if (!harnessKind.success) {
      return c.json(
        { error: `Invalid harness kind: ${String(body.harness.kind)}` },
        400,
      );
    }
    const harness: HarnessSpec = {
      ...body.harness,
      kind: harnessKind.data,
    };

    await service.registerAgent({
      id: body.agentId,
      role: role.data,
      harness,
      ...(body.displayName !== undefined
        ? { displayName: body.displayName }
        : {}),
    });

    const agent = await provider.startAgent({
      agentId: body.agentId,
      roomId,
      role: role.data,
      harness,
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

  app.post("/v1/runtime/:providerId/agents/:agentId/attach", async (c) => {
    const provider = registry.runtime(c.req.param("providerId"));
    if (!provider.capabilities.attachInteractive || !provider.attach) {
      return c.json(
        { error: `runtime provider cannot attach agents: ${provider.id}` },
        501,
      );
    }
    const agentId = c.req.param("agentId");
    const binding = await service.getRuntimeBinding(agentId);
    await provider.attach(attachTargetFor(provider, agentId, binding));
    return c.json({ ok: true, agentId, runtime: provider.id });
  });

  app.delete("/v1/runtime/:providerId/agents/:agentId", async (c) => {
    const provider = registry.runtime(c.req.param("providerId"));
    const agentId = c.req.param("agentId");
    const binding = await service.getRuntimeBinding(agentId);
    await provider.stopAgent(stopTargetFor(provider, agentId, binding));
    await store.append(agentLeftEvent(roomId, agentId, "stopped via api"));
    return c.json({ ok: true, agentId, runtime: provider.id });
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
    const session = runtime.session ?? process.env.HERDR_SESSION;
    if (!session) continue;

    let provider;
    try {
      provider = input.registry.runtime(providerId);
    } catch {
      continue;
    }
    if (!provider.adoptAgent) continue;

    void startHerdrObserver({
      providerId,
      runtime,
      session,
      provider,
      service: input.service,
      roomId: input.roomId,
      observers,
    });
  }
  return observers;
}

async function startHerdrObserver(input: {
  providerId: string;
  runtime: Extract<AgentRoomConfig["runtimes"][string], { type: "herdr" }>;
  session: string;
  provider: RuntimeProvider;
  service: AgentRoomService;
  roomId: string;
  observers: HerdrPaneObserver[];
}): Promise<void> {
  try {
    const socketPath = await herdrSocketPathForRuntime(input);
    if (!socketPath) return;
    const observer = new HerdrPaneObserver({
      socketPath,
      session: input.session,
      service: input.service,
      provider: input.provider,
      roomId: input.roomId,
      logger: (message) => console.log(`[herdr-observer] ${message}`),
    });
    input.observers.push(observer);
    await observer.start();
  } catch (error) {
    console.error(
      `[herdr-observer] failed to start for ${input.providerId}: ${errorMessage(error)}`,
    );
  }
}

async function herdrSocketPathForRuntime(input: {
  runtime: Extract<AgentRoomConfig["runtimes"][string], { type: "herdr" }>;
  session: string;
  provider: RuntimeProvider;
}): Promise<string | undefined> {
  const health = await input.provider.health().catch(() => undefined);
  const socketPath = stringMetadata(health?.metadata, "socketPath");
  if (socketPath) return socketPath;

  return resolveHerdrSocketPath({
    ...(input.runtime.session === undefined &&
    process.env.HERDR_SOCKET_PATH !== undefined
      ? { envSocketPath: process.env.HERDR_SOCKET_PATH }
      : {}),
    session: input.session,
    ...(process.env.XDG_CONFIG_HOME !== undefined
      ? { xdgConfigHome: process.env.XDG_CONFIG_HOME }
      : {}),
    ...(process.env.HOME !== undefined ? { home: process.env.HOME } : {}),
  });
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function stopTargetFor(
  provider: RuntimeProvider,
  agentId: string,
  binding?: RuntimeBinding,
): string {
  if (provider.kind === "herdr" && binding?.providerId === provider.id) {
    return binding.bindingId;
  }
  return agentId;
}

function attachTargetFor(
  provider: RuntimeProvider,
  agentId: string,
  binding?: RuntimeBinding,
): string {
  if (provider.kind === "herdr" && binding?.providerId === provider.id) {
    return binding.bindingId;
  }
  return agentId;
}

function agentLeftEvent(
  roomId: string,
  agentId: string,
  reason?: string,
): Extract<RoomEvent, { type: "agent.left" }> {
  return {
    id: createId("evt"),
    roomId,
    type: "agent.left",
    payload: {
      agentId,
      ...(reason !== undefined ? { reason } : {}),
    },
    createdAt: nowIso(),
  };
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

async function safeRuntimeHealth(
  provider: RuntimeProvider,
): Promise<RuntimeHealth> {
  try {
    return await provider.health();
  } catch (error) {
    return {
      ok: false,
      status: "offline",
      message: errorMessage(error),
      metadata: { providerId: provider.id, kind: provider.kind },
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
