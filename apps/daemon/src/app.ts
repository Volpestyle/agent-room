import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  AgentRoomService,
  ChatGatewayOutboundDispatcher,
  ChatGatewayRouter,
  activateAgent,
  agentRoleSchema,
  agentStateSchema,
  createId,
  harnessKindSchema,
  humanEscalationCreateSchema,
  messageCreateSchema,
  nowIso,
  workspaceRegisterSchema,
  type ChatGatewayProvider,
  type HarnessSpec,
  type Importance,
  type Ref,
  type RoomEvent,
  type RuntimeBinding,
  type RuntimeHealth,
  type RuntimeProvider,
  type StartAgentRequest,
  type TrackerEventActor,
} from "@agentroom/core";
import {
  agentRoomDir,
  agentRoomProtocolPath,
  agentRoomConfigPath,
  createDefaultAgentRoomConfig,
  defaultRoomIdFromEnv,
  ensureAgentRoomProtocol,
  maybeLoadAgentRoomConfigSync,
  readAgentRoomProtocol,
  resolveStoragePath,
  withDefaultRuntime,
  workTrackerLabel,
  writeAgentRoomConfig,
  type AgentRoomConfig,
  type ClankyChatGatewayOwner,
  type McpServerConfig,
  type McpServerTransportKind,
  type WorkTrackerProviderConfig,
  type WorkTrackerProviderKind,
} from "@agentroom/config";
import { JsonlEventStore } from "@agentroom/storage-jsonl";
import { HerdrPaneObserver, resolveHerdrSocketPath } from "./herdrObserver.js";
import { ProviderRegistry } from "./providerRegistry.js";
import { RuntimeMessageNotifier } from "./runtimeMessageNotifier.js";
import {
  ChatGatewayRegistry,
  type ChatGatewayFactory,
} from "./chatGatewayRegistry.js";
import { ApnsClient, apnsConfigFromEnv } from "./apns.js";
import { DeviceRegistry } from "./deviceStore.js";
import {
  ClientTelemetry,
  parseClientIngest,
  parseCommandKind,
} from "./clientTelemetry.js";
import { SecretStore } from "./secretStore.js";

export interface CreateAppOptions {
  roomId?: string;
  eventLogPath?: string;
  config?: AgentRoomConfig;
  cwd?: string;
  chatGateways?: ChatGatewayProvider[];
  runtimeProviders?: RuntimeProvider[];
  startChatGateways?: boolean;
  chatGatewayRegistry?: ChatGatewayRegistry;
  chatGatewayFactory?: ChatGatewayFactory;
  /**
   * Tail the event log and wake idle runtime-backed recipients of directed
   * messages. Defaults to on; tests that don't exercise delivery can disable it.
   */
  startMessageNotifier?: boolean;
  /** Poll cadence for the message notifier's event-log tail. */
  messageNotifierPollIntervalMs?: number;
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

async function chatGatewaySummaries(registry: ChatGatewayRegistry) {
  return Promise.all(
    registry.listGateways().map(async (provider) => {
      const secret = registry.secretInfo(provider.id);
      return {
        id: provider.id,
        kind: provider.kind,
        credentialKind: provider.credentialKind,
        health: await provider.health(),
        startupError: registry.startupError(provider.id),
        ...(secret.tokenEnv !== undefined ? { tokenEnv: secret.tokenEnv } : {}),
        secretConfigured: secret.secretConfigured,
      };
    }),
  );
}

export function createAppWithLifecycle(
  options: CreateAppOptions = {},
): CreateAppResult {
  const cwd = options.cwd ?? process.cwd();
  let configured =
    options.config ??
    maybeLoadAgentRoomConfigSync(cwd) ??
    createDefaultAgentRoomConfig({
      roomId: defaultRoomIdFromEnv(process.env),
      roomName: "AgentRoom",
      defaultRuntime: "herdr",
    });
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
  for (const provider of options.runtimeProviders ?? []) {
    registry.registerRuntime(provider);
  }
  const deviceRegistry = new DeviceRegistry(
    join(dirname(eventLogPath), "devices.json"),
  );
  const clientTelemetry = new ClientTelemetry(
    join(dirname(eventLogPath), "client-logs.jsonl"),
  );
  void clientTelemetry.hydrate();

  const secretStore = new SecretStore(join(agentRoomDir(cwd), "secrets.json"));

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
      resolveSecret: (name) => secretStore.get(name),
    });

  const chatRoutes = chatRegistry.routes();
  const chatRouter = new ChatGatewayRouter({
    service,
    routes: chatRoutes,
    runtimeProviderForBinding: (binding) =>
      registry.runtime(binding.providerId),
    providerForRoute: (route) => chatRegistry.gateway(route.providerId),
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

  const messageNotifier =
    options.startMessageNotifier === false
      ? undefined
      : new RuntimeMessageNotifier({
          store,
          service,
          registry,
          roomId,
          ...(options.messageNotifierPollIntervalMs !== undefined
            ? { pollIntervalMs: options.messageNotifierPollIntervalMs }
            : {}),
          logger: (message) => console.log(`[message-notifier] ${message}`),
        });
  void messageNotifier?.start();

  const apiToken = process.env.AGENTROOM_API_TOKEN?.trim();

  const app = new Hono();
  if (process.env.AGENTROOM_LOG_REQUESTS === "1") {
    app.use("*", async (c, next) => {
      await next();
      console.log(
        `[req] ${c.req.method} ${new URL(c.req.url).pathname} -> ${c.res.status}`,
      );
    });
  }
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
    const chatGateways = await chatGatewaySummaries(chatRegistry);

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
      chatRoutes: chatRegistry.routeSummaries(),
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
      protocolPath: agentRoomProtocolPath(cwd),
      defaultRuntime: configured?.runtime.default ?? null,
      workTracker: configured?.workTracker ?? null,
      mcp: configured?.mcp ?? null,
      operator: configured?.operator ?? null,
    });
  });

  app.get("/v1/config", (c) => {
    configured = maybeLoadAgentRoomConfigSync(cwd) ?? configured;
    return c.json({
      path: agentRoomConfigPath(cwd),
      config: configured,
    });
  });

  app.get("/v1/protocol", async (c) => {
    await ensureAgentRoomProtocol(cwd);
    return c.json(await readAgentRoomProtocol(cwd));
  });

  app.patch("/v1/config/setup", async (c) => {
    const patch = parseConfigSetupPatch(await c.req.json());
    configured = maybeLoadAgentRoomConfigSync(cwd) ?? configured;
    configured = applyConfigSetupPatch(configured, patch);
    await writeAgentRoomConfig(cwd, configured);
    return c.json({
      ok: true,
      path: agentRoomConfigPath(cwd),
      config: configured,
      restartRequired: patch.runtimeDefault !== undefined,
    });
  });

  // Set a daemon-side secret (e.g. a chat-gateway token) by env-var name. The
  // value is persisted to the 0600 secret store and any gateway that reads that
  // env var is reloaded so it reconnects. The value is never echoed back.
  app.put("/v1/config/secrets/:name", async (c) => {
    const name = c.req.param("name");
    const body: unknown = await c.req.json().catch(() => null);
    const value =
      body !== null &&
      typeof body === "object" &&
      typeof (body as { value?: unknown }).value === "string"
        ? (body as { value: string }).value
        : undefined;
    if (!name || value === undefined || value === "") {
      return c.json({ error: "a non-empty string `value` is required" }, 400);
    }
    secretStore.set(name, value);
    const reloaded = await chatRegistry.reloadGatewaysForSecret(name);
    return c.json({ ok: true, name, configured: true, reloaded });
  });

  // Set (or clear) a chat route's target channel. Persists to config.yaml and
  // applies live by rebuilding the route. An empty/missing value clears it so
  // the gateway falls back to its default channel (Discord: #general).
  app.patch("/v1/config/chat/routes/:routeId", async (c) => {
    const routeId = c.req.param("routeId");
    const body: unknown = await c.req.json().catch(() => null);
    const raw =
      body !== null && typeof body === "object"
        ? (body as { conversationId?: unknown }).conversationId
        : undefined;
    const conversationId =
      typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;

    configured = maybeLoadAgentRoomConfigSync(cwd) ?? configured;
    const route = configured?.chat?.routes?.[routeId];
    if (!route) {
      return c.json({ error: `unknown chat route: ${routeId}` }, 404);
    }
    if (conversationId === undefined) {
      delete route.conversationId;
    } else {
      route.conversationId = conversationId;
    }
    await writeAgentRoomConfig(cwd, configured);

    let applied = false;
    try {
      chatRegistry.setRouteChannel(routeId, conversationId);
      applied = true;
    } catch {
      // route not present in the running registry (added since boot) — persisted,
      // will take effect on next restart.
    }
    return c.json({
      ok: true,
      routeId,
      conversationId: conversationId ?? null,
      applied,
    });
  });

  app.get("/v1/events", async (c) => {
    const limit = Number(c.req.query("limit") ?? "100");
    const events = await store.list({ roomId, limit });
    return c.json({ events });
  });

  app.get("/v1/feed", async (c) => {
    const limit = Number(c.req.query("limit") ?? "100");
    const events = await service.listUserFeed({ limit });
    return c.json({ events });
  });

  // Live event stream — GAME_BRIDGE.md §4.1 / Diorama F1. Wraps the existing
  // eventCursor / listEventsFromCursor primitive in a text/event-stream so clients
  // (the Diorama world reducer) can tail RoomEvents at low latency instead of
  // polling. One-directional: commands still go over the REST routes. `?cursor=`
  // is the resume point — a byte position, "start" (default: full replay) or "end"
  // (only new events). Each frame's SSE id is the resume cursor, so reconnecting
  // with the last id is gap- and dupe-free.
  app.get("/v1/events/stream", async (c) => {
    const pollIntervalMs = 1000;
    const keepaliveMs = 25_000;

    const raw = c.req.query("cursor");
    let position: number | undefined;
    if (raw !== undefined && raw !== "start" && raw !== "end") {
      position = Number(raw);
      if (!Number.isInteger(position) || position < 0) {
        return c.json({ error: "invalid cursor" }, 400);
      }
    }
    let cursor = await service.eventCursor(raw === "end" ? "end" : "start");
    if (position !== undefined) {
      cursor = { position };
    }

    return streamSSE(
      c,
      async (stream) => {
        let aborted = false;
        stream.onAbort(() => {
          aborted = true;
        });
        let idleMs = 0;
        while (!aborted && !stream.aborted) {
          const batch = await service.listEventsFromCursor(cursor, { limit: 1 });
          const event = batch.events[0];
          if (event !== undefined) {
            cursor = batch.cursor;
            await stream.writeSSE({
              event: "room-event",
              id: String(cursor.position),
              data: JSON.stringify(event),
            });
            idleMs = 0;
            continue;
          }
          // Caught up to the tail — idle until the next append, with a periodic
          // SSE comment so dead connections surface and proxies stay open.
          await stream.sleep(pollIntervalMs);
          idleMs += pollIntervalMs;
          if (idleMs >= keepaliveMs) {
            await stream.write(": keepalive\n\n");
            idleMs = 0;
          }
        }
      },
      async (error, stream) => {
        console.error(`[events-stream] ${errorMessage(error)}`);
        await stream.close();
      },
    );
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

  app.get("/v1/workspaces", async (c) => {
    return c.json({ workspaces: await service.listWorkspaces() });
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

  app.post("/v1/tracker/events", async (c) => {
    let input: ReturnType<typeof parseTrackerEventInput>;
    try {
      input = parseTrackerEventInput(await c.req.json().catch(() => null));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    const event = await service.recordTrackerEvent(input);
    return c.json({ event }, 201);
  });

  app.post("/v1/reports", async (c) => {
    let input: ReturnType<typeof parseAgentReportInput>;
    try {
      input = parseAgentReportInput(await c.req.json().catch(() => null));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    const report = await service.createAgentReport(input);
    return c.json({ report }, 201);
  });

  app.post("/v1/workspaces", async (c) => {
    const input = workspaceRegisterSchema.parse(await c.req.json());
    const workspace = await service.registerWorkspace({
      cwd: input.cwd,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
    return c.json({ workspace }, 201);
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
    if (body.cwd !== undefined) {
      await service.registerWorkspace({
        cwd: body.cwd,
        label: body.workspace ?? body.cwd,
      });
    }

    const agent = await provider.startAgent({
      agentId: body.agentId,
      roomId,
      role: role.data,
      harness,
      ...(body.displayName !== undefined
        ? { displayName: body.displayName }
        : {}),
      ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
      ...(body.workspace !== undefined ? { workspace: body.workspace } : {}),
      env: {
        ...(body.env ?? {}),
        ...agentRoomProtocolEnv(
          configured,
          {
            agentId: body.agentId,
            role: role.data,
          },
          cwd,
        ),
      },
    });

    if (agent.id !== body.agentId) {
      await service.leaveAgent({
        agentId: body.agentId,
        reason: `runtime returned mismatched agent id ${agent.id}`,
      });
      return c.json(
        {
          error: `runtime provider returned mismatched agent id: expected ${body.agentId}, got ${agent.id}`,
        },
        502,
      );
    }

    const existingByBinding = await service.findAgentByBinding(agent.bindingId);
    if (existingByBinding && existingByBinding !== body.agentId) {
      const existingAgent = await service.getAgent(existingByBinding);
      if (existingAgent?.state !== "stopped") {
        await service.leaveAgent({
          agentId: body.agentId,
          reason: `runtime binding ${agent.bindingId} already owned by ${existingByBinding}`,
        });
        return c.json(
          {
            error: `runtime binding ${agent.bindingId} is already owned by active agent ${existingByBinding}`,
          },
          409,
        );
      }
    }

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

  app.post("/v1/runtime/:providerId/agents/:agentId/keys", async (c) => {
    const provider = registry.runtime(c.req.param("providerId"));
    if (!provider.capabilities.sendKeys || !provider.sendKeys) {
      return c.json(
        { error: `runtime provider cannot send keys: ${provider.id}` },
        501,
      );
    }
    const agentId = c.req.param("agentId");
    const binding = await service.getRuntimeBinding(agentId);
    const body = (await c.req.json()) as { keys?: unknown };
    const keys = Array.isArray(body.keys)
      ? body.keys.filter(
          (key): key is string => typeof key === "string" && key.length > 0,
        )
      : [];
    if (keys.length === 0) return c.json({ error: "keys is required" }, 400);
    const bindingId = bindingIdFor(provider, binding);
    await provider.sendKeys({
      agentId,
      ...(bindingId !== undefined ? { bindingId } : {}),
      keys,
    });
    await service.recordRuntimeInput({
      agentId,
      text: `keys: ${keys.join(" ")}`,
      source: { kind: "human", id: "api" },
    });
    return c.json({ ok: true });
  });

  app.post("/v1/runtime/:providerId/agents/:agentId/activate", async (c) => {
    const provider = registry.runtime(c.req.param("providerId"));
    if (!provider.capabilities.sendInput) {
      return c.json(
        { error: `runtime provider cannot send input: ${provider.id}` },
        501,
      );
    }
    const agentId = c.req.param("agentId");
    const binding = await service.getRuntimeBinding(agentId);
    const agent = await service.getAgent(agentId);
    const bindingId = bindingIdFor(provider, binding);
    const agentKind =
      agent?.harness?.kind ?? metaString(binding?.metadata, "agent");
    const trackerLabel = workTrackerLabel(configured);
    const result = await activateAgent(provider, service, {
      agentId,
      roomId,
      ...(bindingId !== undefined ? { bindingId } : {}),
      ...(agent?.role !== undefined ? { role: agent.role } : {}),
      ...(agentKind !== undefined ? { agentKind } : {}),
      ...(trackerLabel !== undefined ? { workTracker: trackerLabel } : {}),
      source: { kind: "human", id: "api" },
    });
    return c.json({ ok: true, ...result });
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
    const gateways = await chatGatewaySummaries(chatRegistry);
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

  app.post("/v1/devices", async (c) => {
    const body = (await c.req.json()) as {
      token?: unknown;
      platform?: unknown;
      env?: unknown;
      bundleId?: unknown;
      label?: unknown;
    };
    if (typeof body.token !== "string" || body.token.trim() === "") {
      return c.json({ error: "token is required" }, 400);
    }
    const device = await deviceRegistry.upsert({
      token: body.token,
      ...(body.platform === "ios" ? { platform: "ios" } : {}),
      ...(body.env === "production" || body.env === "sandbox"
        ? { env: body.env }
        : {}),
      ...(typeof body.bundleId === "string" ? { bundleId: body.bundleId } : {}),
      ...(typeof body.label === "string" ? { label: body.label } : {}),
    });
    return c.json({ ok: true, device }, 201);
  });

  app.get("/v1/devices", async (c) => {
    return c.json({ devices: await deviceRegistry.list() });
  });

  app.delete("/v1/devices/:token", async (c) => {
    const removed = await deviceRegistry.remove(c.req.param("token"));
    return c.json({ ok: removed });
  });

  app.post("/v1/mobile/connect-push", async (c) => {
    const apnsConfig = apnsConfigFromEnv();
    if (!apnsConfig) {
      return c.json(
        {
          error:
            "APNs is not configured. Set AGENTROOM_APNS_KEY_PATH, AGENTROOM_APNS_KEY_ID, and AGENTROOM_APNS_TEAM_ID.",
        },
        503,
      );
    }
    let body: { baseUrl?: unknown; mode?: unknown; silent?: unknown } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      // an empty body is allowed; the app falls back to its saved settings
    }
    const devices = await deviceRegistry.list();
    if (devices.length === 0) {
      return c.json({ error: "no registered devices" }, 404);
    }
    const client = new ApnsClient(apnsConfig);
    const results = await client.sendConnect(devices, {
      roomId,
      ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
      ...(body.mode === "tailnet" || body.mode === "custom"
        ? { mode: body.mode }
        : {}),
      ...(body.silent === true ? { silent: true } : {}),
    });
    const sent = results.filter((result) => result.ok).length;
    return c.json({
      ok: sent > 0,
      sent,
      failed: results.length - sent,
      results,
    });
  });

  // --- Agent-facing client telemetry (mobile observability) ---

  app.post("/v1/clients/events", async (c) => {
    const input = parseClientIngest(await c.req.json().catch(() => null));
    if (!input) return c.json({ error: "clientId is required" }, 400);
    const commands = clientTelemetry.ingest(input);
    return c.json({ ok: true, commands });
  });

  app.get("/v1/clients", (c) => {
    return c.json({ clients: clientTelemetry.listStates() });
  });

  app.get("/v1/clients/events", (c) => {
    const since = c.req.query("since");
    const limit = c.req.query("limit");
    const client = c.req.query("client");
    return c.json({
      events: clientTelemetry.recentEvents({
        ...(client !== undefined ? { clientId: client } : {}),
        ...(since !== undefined ? { sinceSeq: Number(since) } : {}),
        ...(limit !== undefined ? { limit: Number(limit) } : {}),
      }),
    });
  });

  app.get("/v1/clients/:clientId/events", (c) => {
    const since = c.req.query("since");
    const limit = c.req.query("limit");
    return c.json({
      events: clientTelemetry.recentEvents({
        clientId: c.req.param("clientId"),
        ...(since !== undefined ? { sinceSeq: Number(since) } : {}),
        ...(limit !== undefined ? { limit: Number(limit) } : {}),
      }),
    });
  });

  app.post("/v1/clients/:clientId/commands", async (c) => {
    const body = await c.req.json().catch(() => null);
    const kind = parseCommandKind(
      body && typeof body === "object" ? (body as Record<string, unknown>).kind : undefined,
    );
    if (!kind) {
      return c.json({ error: "invalid or missing command kind" }, 400);
    }
    const rawArgs =
      body && typeof body === "object"
        ? (body as Record<string, unknown>).args
        : undefined;
    const args =
      typeof rawArgs === "object" && rawArgs !== null
        ? Object.fromEntries(
            Object.entries(rawArgs as Record<string, unknown>).flatMap(
              ([k, v]) => (typeof v === "string" ? [[k, v]] : []),
            ),
          )
        : undefined;
    const command = clientTelemetry.enqueueCommand(
      c.req.param("clientId"),
      kind,
      args,
    );
    return c.json({ ok: true, command }, 201);
  });

  return {
    app,
    chatGateways: chatRegistry,
    chatStartup,
    shutdown: async () => {
      await messageNotifier?.stop();
      await Promise.all(herdrObservers.map((observer) => observer.stop()));
      await chatRegistry.stop();
    },
  };
}

interface ConfigSetupPatch {
  runtimeDefault?: string;
  workTracker?: ConfigSetupWorkTrackerPatch;
  mcpServer?: ConfigSetupMcpServerPatch;
  clanky?: ConfigSetupClankyPatch;
}

interface TrackerEventCreateInput {
  providerKind: string;
  providerId?: string;
  eventType: string;
  action?: string;
  issueRef?: string;
  title?: string;
  status?: string;
  url?: string;
  actor?: TrackerEventActor;
  summary?: string;
  raw?: unknown;
  visibleToUser?: boolean;
}

interface AgentReportCreateInput {
  agentId: string;
  title?: string;
  summary: string;
  details?: string;
  importance?: Importance;
  refs?: Ref[];
  visibleToUser?: boolean;
}

function parseTrackerEventInput(input: unknown): TrackerEventCreateInput {
  const body = asRecord(input, "tracker event");
  const providerKind =
    optionalString(body.providerKind) ??
    optionalString(body.provider) ??
    optionalString(body.providerType);
  if (providerKind === undefined) {
    throw new Error("providerKind is required");
  }
  const eventType = optionalString(body.eventType) ?? optionalString(body.type);
  if (eventType === undefined) throw new Error("eventType is required");

  const actorInput = optionalRecord(body.actor, "actor");
  const actor =
    actorInput === undefined ? undefined : parseTrackerEventActor(actorInput);
  const visibleToUser = optionalBoolean(body.visibleToUser);
  const raw = Object.hasOwn(body, "raw") ? body.raw : input;

  return {
    providerKind,
    eventType,
    ...optionalStringProp(body, "providerId"),
    ...optionalStringProp(body, "action"),
    ...optionalStringProp(body, "issueRef"),
    ...optionalStringProp(body, "title"),
    ...optionalStringProp(body, "status"),
    ...optionalStringProp(body, "url"),
    ...(actor !== undefined ? { actor } : {}),
    ...optionalStringProp(body, "summary"),
    ...(raw !== undefined ? { raw } : {}),
    ...(visibleToUser !== undefined ? { visibleToUser } : {}),
  };
}

function parseAgentReportInput(input: unknown): AgentReportCreateInput {
  const body = asRecord(input, "agent report");
  const agentId = optionalString(body.agentId);
  if (agentId === undefined) throw new Error("agentId is required");
  const summary = optionalString(body.summary);
  if (summary === undefined) throw new Error("summary is required");
  const importance = parseImportanceValue(optionalString(body.importance));
  const refs = parseRefs(body.refs);
  const visibleToUser = optionalBoolean(body.visibleToUser);

  return {
    agentId,
    summary,
    ...optionalStringProp(body, "title"),
    ...optionalStringProp(body, "details"),
    ...(importance !== undefined ? { importance } : {}),
    ...(refs !== undefined ? { refs } : {}),
    ...(visibleToUser !== undefined ? { visibleToUser } : {}),
  };
}

function parseTrackerEventActor(
  input: Record<string, unknown>,
): TrackerEventActor | undefined {
  const actor: TrackerEventActor = {
    ...optionalStringProp(input, "id"),
    ...optionalStringProp(input, "name"),
    ...optionalStringProp(input, "type"),
  };
  return Object.keys(actor).length > 0 ? actor : undefined;
}

function parseRefs(value: unknown): Ref[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("refs must be an array");
  return value.map((item) => parseRef(asRecord(item, "ref")));
}

function parseRef(input: Record<string, unknown>): Ref {
  const kind = parseRefKind(optionalString(input.kind));
  if (kind === undefined) throw new Error("ref.kind is invalid");
  const id = optionalString(input.id);
  if (id === undefined) throw new Error("ref.id is required");
  return {
    kind,
    id,
    ...optionalStringProp(input, "label"),
    ...optionalStringProp(input, "url"),
    ...(input.metadata !== undefined
      ? { metadata: asRecord(input.metadata, "ref.metadata") }
      : {}),
  };
}

function parseRefKind(value: string | undefined): Ref["kind"] | undefined {
  if (
    value === "task" ||
    value === "agent" ||
    value === "message" ||
    value === "github-pr" ||
    value === "github-issue" ||
    value === "tracker-issue" ||
    value === "figma-node" ||
    value === "runtime-output" ||
    value === "url" ||
    value === "file" ||
    value === "custom"
  ) {
    return value;
  }
  return undefined;
}

function parseImportanceValue(value: string | undefined): Importance | undefined {
  if (
    value === "low" ||
    value === "normal" ||
    value === "high" ||
    value === "urgent"
  ) {
    return value;
  }
  if (value !== undefined) throw new Error("importance is invalid");
  return undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new Error("visibleToUser must be a boolean");
}

interface ConfigSetupWorkTrackerPatch {
  type: WorkTrackerProviderKind;
  id?: string;
  teamId?: string;
  projectId?: string;
  baseUrl?: string;
}

interface ConfigSetupMcpServerPatch {
  id: string;
  remove?: boolean;
  type?: McpServerTransportKind;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  description?: string;
  disabled?: boolean;
  allowedTools?: string[];
}

interface ConfigSetupClankyPatch {
  home?: string;
  profile?: string;
  chatGatewayOwner?: ClankyChatGatewayOwner;
}

function parseConfigSetupPatch(input: unknown): ConfigSetupPatch {
  const body = asRecord(input, "config setup patch");
  const patch: ConfigSetupPatch = {};
  const runtimeDefault =
    optionalString(body.runtimeDefault) ?? optionalString(body.defaultRuntime);
  if (runtimeDefault !== undefined) patch.runtimeDefault = runtimeDefault;

  const workTrackerInput = optionalRecord(body.workTracker, "workTracker");
  if (workTrackerInput !== undefined) {
    patch.workTracker = parseWorkTrackerSetupPatch(workTrackerInput);
  }

  const mcpServerInput = optionalRecord(body.mcpServer, "mcpServer");
  if (mcpServerInput !== undefined) {
    patch.mcpServer = parseMcpServerSetupPatch(mcpServerInput);
  }

  const clankyInput = optionalRecord(body.clanky, "clanky");
  if (clankyInput !== undefined) {
    patch.clanky = parseClankySetupPatch(clankyInput);
  }

  if (
    patch.runtimeDefault === undefined &&
    patch.workTracker === undefined &&
    patch.mcpServer === undefined &&
    patch.clanky === undefined
  ) {
    throw new Error(
      "Config setup patch must include runtimeDefault, workTracker, mcpServer, or clanky",
    );
  }
  return patch;
}

function parseWorkTrackerSetupPatch(
  input: Record<string, unknown>,
): ConfigSetupWorkTrackerPatch {
  const typeRaw =
    optionalString(input.type) ??
    optionalString(input.providerKind) ??
    optionalString(input.trackerKind);
  const providerId = optionalString(input.id) ?? optionalString(input.provider);
  const type = parseWorkTrackerProviderKind(typeRaw ?? providerId);
  if (type === undefined) {
    throw new Error(
      "workTracker.type must be native, linear, github-issues, jira, or custom",
    );
  }
  return {
    type,
    ...(providerId !== undefined ? { id: providerId } : {}),
    ...optionalStringProp(input, "teamId"),
    ...optionalStringProp(input, "projectId"),
    ...optionalStringProp(input, "baseUrl"),
  };
}

function parseMcpServerSetupPatch(
  input: Record<string, unknown>,
): ConfigSetupMcpServerPatch {
  const id =
    optionalString(input.id) ??
    optionalString(input.name) ??
    optionalString(input.server);
  if (id === undefined) throw new Error("mcpServer.id is required");
  const remove = optionalBoolean(input.remove) ?? optionalBoolean(input.delete);
  if (remove === true) return { id, remove: true };

  const command = optionalString(input.command);
  const url = optionalString(input.url);
  const type = parseMcpServerTransportKind(optionalString(input.type), {
    ...(command !== undefined ? { command } : {}),
    ...(url !== undefined ? { url } : {}),
  });
  if (type === undefined) {
    throw new Error("mcpServer.type must be stdio, http, streamable-http, or sse");
  }
  if (type === "stdio" && command === undefined) {
    throw new Error("mcpServer.command is required for stdio servers");
  }
  if (type !== "stdio" && url === undefined) {
    throw new Error("mcpServer.url is required for HTTP/SSE servers");
  }

  return {
    id,
    type,
    ...(command !== undefined ? { command } : {}),
    ...(url !== undefined ? { url } : {}),
    ...optionalStringArrayProp(input, "args"),
    ...optionalStringProp(input, "cwd"),
    ...optionalStringProp(input, "description"),
    ...optionalStringArrayProp(input, "allowedTools"),
    ...optionalBooleanProp(input, "disabled"),
  };
}

function parseClankySetupPatch(
  input: Record<string, unknown>,
): ConfigSetupClankyPatch {
  const owner = parseClankyChatGatewayOwner(
    optionalString(input.chatGatewayOwner) ?? optionalString(input.owner),
  );
  return {
    ...optionalStringProp(input, "home"),
    ...optionalStringProp(input, "profile"),
    ...(owner !== undefined ? { chatGatewayOwner: owner } : {}),
  };
}

function applyConfigSetupPatch(
  config: AgentRoomConfig,
  patch: ConfigSetupPatch,
): AgentRoomConfig {
  let next = config;
  if (patch.runtimeDefault !== undefined) {
    next = withDefaultRuntime(next, patch.runtimeDefault);
  }
  if (patch.workTracker !== undefined) {
    next = withSetupWorkTracker(next, patch.workTracker);
  }
  if (patch.mcpServer !== undefined) {
    next = withSetupMcpServer(next, patch.mcpServer);
  }
  if (patch.clanky !== undefined) {
    next = withSetupClanky(next, patch.clanky);
  }
  return next;
}

function withSetupWorkTracker(
  config: AgentRoomConfig,
  patch: ConfigSetupWorkTrackerPatch,
): AgentRoomConfig {
  const providerId = patch.id ?? defaultWorkTrackerProviderId(patch.type);
  const existing = config.workTracker?.providers ?? {};
  return {
    ...config,
    workTracker: {
      default: providerId,
      providers: {
        ...existing,
        [providerId]: setupWorkTrackerProvider(patch),
      },
    },
  };
}

function setupWorkTrackerProvider(
  patch: ConfigSetupWorkTrackerPatch,
): WorkTrackerProviderConfig {
  if (patch.type === "native") return { type: "native" };
  const provider: WorkTrackerProviderConfig = { type: patch.type };
  if (patch.teamId !== undefined) provider.teamId = patch.teamId;
  if (patch.projectId !== undefined) provider.projectId = patch.projectId;
  if (patch.baseUrl !== undefined) provider.baseUrl = patch.baseUrl;
  return provider;
}

function withSetupMcpServer(
  config: AgentRoomConfig,
  patch: ConfigSetupMcpServerPatch,
): AgentRoomConfig {
  const existing = config.mcp?.servers ?? {};
  if (patch.remove === true) {
    const { [patch.id]: _removed, ...servers } = existing;
    if (Object.keys(servers).length > 0) return { ...config, mcp: { servers } };
    const { mcp: _mcp, ...rest } = config;
    return rest;
  }
  return {
    ...config,
    mcp: {
      servers: {
        ...existing,
        [patch.id]: setupMcpServer(patch),
      },
    },
  };
}

function setupMcpServer(patch: ConfigSetupMcpServerPatch): McpServerConfig {
  if (patch.type === undefined) {
    throw new Error("mcpServer.type is required");
  }
  return {
    type: patch.type,
    ...(patch.command !== undefined ? { command: patch.command } : {}),
    ...(patch.args !== undefined ? { args: patch.args } : {}),
    ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
    ...(patch.url !== undefined ? { url: patch.url } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
    ...(patch.allowedTools !== undefined
      ? { allowedTools: patch.allowedTools }
      : {}),
  };
}

function withSetupClanky(
  config: AgentRoomConfig,
  patch: ConfigSetupClankyPatch,
): AgentRoomConfig {
  const home = patch.home ?? config.clanky?.home ?? ".clanky-room";
  const profile = patch.profile ?? config.clanky?.profile ?? "lead";
  const chatGatewayOwner =
    patch.chatGatewayOwner ?? config.clanky?.chatGatewayOwner ?? "agent";
  return {
    ...config,
    clanky: { home, profile, chatGatewayOwner },
    operator: {
      ...(config.operator ?? {}),
      agentId: config.operator?.agentId ?? "clanky",
      displayName: config.operator?.displayName ?? "Clanky",
      kind: "clanky",
      command: `clanky --home ${home} --profile ${profile}`,
      cwd: config.operator?.cwd ?? ".",
      sessionDir: `${home}/profiles/${profile}/sessions`,
      env: {
        ...(config.operator?.env ?? {}),
        CLANKY_HOME: home,
        CLANKY_PROFILE: profile,
        CLANKY_CHAT_GATEWAY_OWNER: chatGatewayOwner,
      },
    },
  };
}

function defaultWorkTrackerProviderId(type: WorkTrackerProviderKind): string {
  return type;
}

function parseWorkTrackerProviderKind(
  value: string | undefined,
): WorkTrackerProviderKind | undefined {
  if (
    value === "native" ||
    value === "linear" ||
    value === "github-issues" ||
    value === "jira" ||
    value === "custom"
  ) {
    return value;
  }
  if (value === "github") return "github-issues";
  return undefined;
}

function parseMcpServerTransportKind(
  value: string | undefined,
  input: { command?: string; url?: string },
): McpServerTransportKind | undefined {
  if (value === "stdio") return "stdio";
  if (value === "http" || value === "streamable-http") {
    return "streamable-http";
  }
  if (value === "sse") return "sse";
  if (value !== undefined) return undefined;
  if (input.command !== undefined) return "stdio";
  if (input.url !== undefined) return "streamable-http";
  return undefined;
}

function parseClankyChatGatewayOwner(
  value: string | undefined,
): ClankyChatGatewayOwner | undefined {
  if (value === "agent" || value === "room" || value === "off") return value;
  return undefined;
}

function optionalStringProp<T extends string>(
  input: Record<string, unknown>,
  key: T,
): { [K in T]?: string } {
  const value = optionalString(input[key]);
  return value === undefined ? {} : ({ [key]: value } as { [K in T]?: string });
}

function optionalStringArrayProp<T extends string>(
  input: Record<string, unknown>,
  key: T,
): { [K in T]?: string[] } {
  const value = optionalStringArray(input[key]);
  return value === undefined ? {} : ({ [key]: value } as { [K in T]?: string[] });
}

function optionalBooleanProp<T extends string>(
  input: Record<string, unknown>,
  key: T,
): { [K in T]?: boolean } {
  const value = optionalBoolean(input[key]);
  return value === undefined ? {} : ({ [key]: value } as { [K in T]?: boolean });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const entries = value.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );
    return entries.length > 0 ? entries : undefined;
  }
  const raw = optionalString(value);
  if (raw === undefined) return undefined;
  const entries = raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}

function optionalRecord(
  value: unknown,
  name: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return asRecord(value, name);
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

// How often each herdr observer re-adopts panes from the provider. Drives
// enrollment for panes that predate the observer and self-heals after missed
// push events or a daemon restart.
const HERDR_RECONCILE_INTERVAL_MS = 15_000;

function startHerdrObservers(input: {
  config?: AgentRoomConfig;
  registry: ProviderRegistry;
  service: AgentRoomService;
  roomId: string;
}): HerdrPaneObserver[] {
  if (!input.config) return [];
  const observers: HerdrPaneObserver[] = [];
  const trackerLabel = workTrackerLabel(input.config);
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
      ...(trackerLabel !== undefined ? { workTracker: trackerLabel } : {}),
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
  workTracker?: string;
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
      ...(input.workTracker !== undefined
        ? { workTracker: input.workTracker }
        : {}),
      reconcileIntervalMs: HERDR_RECONCILE_INTERVAL_MS,
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
    ...(process.env.HERDR_SOCKET_PATH !== undefined
      ? { envSocketPath: process.env.HERDR_SOCKET_PATH }
      : {}),
    session: input.session,
    ...(input.runtime.cli !== undefined ? { cli: input.runtime.cli } : {}),
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

function metaString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function agentRoomProtocolEnv(
  config: AgentRoomConfig,
  input: { agentId: string; role: StartAgentRequest["role"] },
  cwd: string,
): Record<string, string> {
  return {
    AGENTROOM: "1",
    AGENTROOM_AGENT_ID: input.agentId,
    AGENTROOM_ROOM_ID: config.room.id,
    AGENTROOM_ROLE: input.role,
    AGENTROOM_PROTOCOL_FILE: agentRoomProtocolPath(cwd),
    ...workTrackerProtocolEnv(config),
  };
}

function workTrackerProtocolEnv(
  config: AgentRoomConfig,
): Record<string, string> {
  const trackerId = config.workTracker?.default;
  if (trackerId === undefined) return {};
  const provider = config.workTracker?.providers[trackerId];
  if (provider === undefined) return { AGENTROOM_WORK_TRACKER: trackerId };
  return {
    AGENTROOM_WORK_TRACKER: trackerId,
    AGENTROOM_WORK_TRACKER_PROVIDER_KIND: provider.type,
    ...(provider.teamId !== undefined
      ? { AGENTROOM_WORK_TRACKER_TEAM_ID: provider.teamId }
      : {}),
    ...(provider.projectId !== undefined
      ? { AGENTROOM_WORK_TRACKER_PROJECT_ID: provider.projectId }
      : {}),
    ...(provider.baseUrl !== undefined
      ? { AGENTROOM_WORK_TRACKER_BASE_URL: provider.baseUrl }
      : {}),
  };
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
