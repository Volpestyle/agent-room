#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type ActorRef,
  type AgentState,
  type AgentRole,
  AgentRoomService,
  type EventCursor,
  type HarnessSpec,
  type Importance,
  type MessageKind,
  type RoomEvent,
  type RuntimeBinding,
  type RuntimeProvider,
  type StartAgentRequest,
  agentRoleSchema,
} from "@agentroom/core";
import {
  type AgentRoomConfig,
  type RuntimeConfig,
  agentRoomProtocolPath,
  builtInRuntimeConfig,
  createDefaultAgentRoomConfig,
  defaultRoomIdFromEnv,
  ensureRuntimeConfig,
  loadAgentRoomConfig,
  readAgentRoomSessionIdentity,
  resolveStoragePath,
  writeAgentRoomSessionIdentity,
} from "@agentroom/config";
import { FakeRuntimeProvider } from "@agentroom/runtime-fake";
import { HerdrRuntimeProvider } from "@agentroom/runtime-herdr";
import { TmuxRuntimeProvider } from "@agentroom/runtime-tmux";
import { ZellijRuntimeProvider } from "@agentroom/runtime-zellij";
import { JsonlEventStore } from "@agentroom/storage-jsonl";
import { z } from "zod";

const DEFAULT_MESSAGE_LIMIT = 20;
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

const harnessKindInputSchema = z.enum([
  "claude-code",
  "pi",
  "codex",
  "gemini-cli",
  "shell",
  "custom",
]);

const runtimeOutputSourceSchema = z.enum([
  "visible",
  "recent",
  "recent-unwrapped",
  "all",
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

interface RoomContext {
  cwd: string;
  roomId: string;
  config: AgentRoomConfig;
  service: AgentRoomService;
  events: JsonlEventStore;
}

interface RuntimeContext extends RoomContext {
  providers: RuntimeProvider[];
}

async function main(): Promise<void> {
  const server = new McpServer(
    {
      name: "agentroom",
      version: "0.1.0",
    },
    {
      instructions:
        "AgentRoom coordination tools for room messages, DMs, waits, audit context, runtime-backed agent launch/read/send/stop, and user-visible reports. Prefer bounded reads. AgentRoom does not track tasks — use the configured work tracker's MCP, CLI, or skill for issue/task state, and use AgentRoom reports only for narrative updates.",
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
    "agentroom_ios_logs",
    {
      description:
        "Read structured logs reported by AgentRoom iOS clients (connect/push/api lifecycle + errors). Debug mobile client behavior from the host without inspecting the phone.",
      inputSchema: {
        clientId: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        sinceSeq: z.number().int().min(0).optional(),
      },
    },
    async (input) => {
      let events = await readClientEvents();
      if (input.clientId !== undefined) {
        events = events.filter((event) => event.clientId === input.clientId);
      }
      const since = input.sinceSeq;
      if (since !== undefined) {
        events = events.filter((event) => event.seq > since);
      }
      return jsonResult({ events: events.slice(-(input.limit ?? 100)) });
    },
  );

  server.registerTool(
    "agentroom_ios_state",
    {
      description:
        "Read the latest reported state of each AgentRoom iOS client (connection, push token/status, last error, build, APNs env).",
      inputSchema: {
        clientId: z.string().optional(),
      },
    },
    async (input) => {
      const states = await readClientStates();
      const clients =
        input.clientId !== undefined
          ? states.filter((state) => state.clientId === input.clientId)
          : states;
      return jsonResult({ clients });
    },
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
        "Read a compact AgentRoom snapshot: identity, recent messages, and audit events.",
      inputSchema: {
        messagesLimit: z.number().int().min(1).max(MAX_LIMIT).optional(),
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
    "agentroom_runtime_providers",
    {
      description:
        "List configured AgentRoom runtime providers and capabilities for launching and controlling runtime-backed agents.",
      inputSchema: {},
    },
    async () => {
      const ctx = await runtimeContext();
      return jsonResult({
        defaultRuntime: ctx.config.runtime.default,
        providers: ctx.providers.map((provider) => ({
          id: provider.id,
          kind: provider.kind,
          default: provider.id === ctx.config.runtime.default,
          capabilities: provider.capabilities,
        })),
      });
    },
  );

  server.registerTool(
    "agentroom_runtime_agents",
    {
      description:
        "List runtime agents from one runtime provider or all configured providers.",
      inputSchema: {
        providerId: z.string().optional(),
      },
    },
    async (input) => {
      const ctx = await runtimeContext();
      const providers =
        input.providerId === undefined
          ? ctx.providers
          : [selectRuntimeProvider(ctx, input.providerId)];
      return jsonResult({
        providers: await Promise.all(
          providers.map(async (provider) => ({
            id: provider.id,
            kind: provider.kind,
            agents: await provider.listAgents(),
          })),
        ),
      });
    },
  );

  server.registerTool(
    "agentroom_launch_agent",
    {
      description:
        "Launch/start/spawn a runtime-backed AgentRoom agent through the configured runtime provider, then bind it to the room event log.",
      inputSchema: {
        providerId: z.string().optional(),
        agentId: z.string().min(1).optional(),
        role: agentRoleSchema.optional(),
        harnessKind: harnessKindInputSchema.optional(),
        command: z.string().min(1).optional(),
        args: z.array(z.string()).optional(),
        cwd: z.string().optional(),
        workspace: z.string().optional(),
        displayName: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
      },
    },
    async (input) => jsonResult(await launchRuntimeAgent(input)),
  );

  server.registerTool(
    "agentroom_read_agent",
    {
      description:
        "Read the last N lines of terminal output for a runtime-backed AgentRoom agent and record the observation in the audit log.",
      inputSchema: {
        providerId: z.string().optional(),
        agentId: z.string().min(1),
        lines: z.number().int().min(1).max(1000).optional(),
        source: runtimeOutputSourceSchema.optional(),
      },
    },
    async (input) => jsonResult(await readRuntimeAgent(input)),
  );

  server.registerTool(
    "agentroom_send_agent",
    {
      description:
        "Send terminal input to a runtime-backed AgentRoom agent through the audited runtime provider path.",
      inputSchema: {
        providerId: z.string().optional(),
        agentId: z.string().min(1),
        text: z.string().min(1),
        submit: z.boolean().optional(),
      },
    },
    async (input) => jsonResult(await sendRuntimeAgent(input)),
  );

  server.registerTool(
    "agentroom_stop_agent",
    {
      description:
        "Stop a runtime-backed AgentRoom agent through its runtime provider and mark it stopped in the room.",
      inputSchema: {
        providerId: z.string().optional(),
        agentId: z.string().min(1),
        reason: z.string().optional(),
      },
    },
    async (input) => jsonResult(await stopRuntimeAgent(input)),
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
    "agentroom_feed",
    {
      description:
        "Read the user-visible feed: objective tracker/provider webhook events plus narrative agent reports.",
      inputSchema: {
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
    },
    async (input) => {
      const ctx = await roomContext();
      return jsonResult(
        await ctx.service.listUserFeed({
          limit: input.limit ?? DEFAULT_EVENT_LIMIT,
        }),
      );
    },
  );

  server.registerTool(
    "agentroom_report",
    {
      description:
        "Post a concise narrative report to the user-visible feed. This is for surfacing notable progress, not for tracking task state.",
      inputSchema: {
        summary: z.string().min(1),
        title: z.string().optional(),
        details: z.string().optional(),
        importance: importanceSchema.optional(),
        visibleToUser: z.boolean().optional(),
      },
    },
    async (input) => {
      const ctx = await roomContext();
      const actor = await currentActor(ctx.service);
      if (actor.kind !== "agent") {
        throw new Error("agentroom_report requires an agent identity.");
      }
      return jsonResult(
        await ctx.service.createAgentReport({
          agentId: actor.id,
          summary: input.summary,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.details !== undefined ? { details: input.details } : {}),
          ...(input.importance !== undefined
            ? { importance: input.importance as Importance }
            : {}),
          ...(input.visibleToUser !== undefined
            ? { visibleToUser: input.visibleToUser }
            : {}),
        }),
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
    "agentroom_wait",
    {
      description:
        "Block until a matching future AgentRoom message, DM, or agent-state event arrives.",
      inputSchema: {
        message: z.string().optional(),
        ignoreCase: z.boolean().optional(),
        fromAgentId: z.string().optional(),
        channel: z.string().optional(),
        kind: messageKindSchema.optional(),
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

type LaunchRuntimeAgentInput = {
  providerId?: string | undefined;
  agentId?: string | undefined;
  role?: AgentRole | undefined;
  harnessKind?: HarnessSpec["kind"] | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  cwd?: string | undefined;
  workspace?: string | undefined;
  displayName?: string | undefined;
  env?: Record<string, string> | undefined;
};

type RuntimeAgentTargetInput = {
  providerId?: string | undefined;
  agentId: string;
};

async function launchRuntimeAgent(
  input: LaunchRuntimeAgentInput,
): Promise<unknown> {
  const ctx = await runtimeContext();
  const provider = selectRuntimeProvider(
    ctx,
    input.providerId ?? ctx.config.runtime.default,
  );
  if (!provider.capabilities.startAgent) {
    throw new Error(`runtime provider cannot launch agents: ${provider.id}`);
  }

  const role = input.role ?? "implementer";
  const harnessKind = input.harnessKind ?? "codex";
  const command = input.command ?? defaultCommandForHarness(harnessKind);
  const cwd = resolve(ctx.cwd, input.cwd ?? ".");
  const workspace =
    cleanOptionalString(input.workspace) ?? workspaceLabelFromCwd(cwd);
  const runtimeAgents = await provider.listAgents();
  const agentId =
    cleanOptionalString(input.agentId) ?? nextAgentId(role, runtimeAgents);
  const env = input.env ?? {};
  const harness: HarnessSpec = {
    kind: harnessKind,
    command,
    ...(input.args !== undefined ? { args: input.args } : {}),
    cwd,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };

  await ctx.service.registerAgent({
    id: agentId,
    role,
    harness,
    ...(input.displayName !== undefined
      ? { displayName: input.displayName }
      : {}),
  });
  await ctx.service.registerWorkspace({ cwd, label: workspace });

  let agent: Awaited<ReturnType<RuntimeProvider["startAgent"]>>;
  try {
    agent = await provider.startAgent({
      agentId,
      roomId: ctx.roomId,
      role,
      harness,
      ...(input.displayName !== undefined
        ? { displayName: input.displayName }
        : {}),
      cwd,
      workspace,
      env: {
        ...env,
        ...agentRoomProtocolEnv(
          ctx.config,
          { agentId, role, roomId: ctx.roomId },
          ctx.cwd,
        ),
      },
    });
  } catch (error) {
    await ctx.service.leaveAgent({
      agentId,
      reason: `runtime launch failed: ${errorMessage(error)}`,
    });
    throw error;
  }

  if (agent.id !== agentId) {
    await stopRuntimeAfterLaunchFailure(provider, agent);
    await ctx.service.leaveAgent({
      agentId,
      reason: `runtime returned mismatched agent id ${agent.id}`,
    });
    throw new Error(
      `runtime provider returned mismatched agent id: expected ${agentId}, got ${agent.id}`,
    );
  }

  const existingByBinding = await ctx.service.findAgentByBinding(
    agent.bindingId,
  );
  if (existingByBinding !== undefined && existingByBinding !== agentId) {
    const existingAgent = await ctx.service.getAgent(existingByBinding);
    if (existingAgent?.state !== "stopped") {
      await stopRuntimeAfterLaunchFailure(provider, agent);
      await ctx.service.leaveAgent({
        agentId,
        reason: `runtime binding ${agent.bindingId} already owned by ${existingByBinding}`,
      });
      throw new Error(
        `runtime binding ${agent.bindingId} is already owned by active agent ${existingByBinding}`,
      );
    }
  }

  await ctx.service.bindRuntime({
    agentId,
    runtime: bindingFor(provider, agent.bindingId, agent.metadata),
  });

  return {
    agent,
    provider: {
      id: provider.id,
      kind: provider.kind,
    },
    defaults: {
      role,
      harnessKind,
      command,
      cwd,
      workspace,
    },
  };
}

async function readRuntimeAgent(
  input: RuntimeAgentTargetInput & {
    lines?: number | undefined;
    source?: "visible" | "recent" | "recent-unwrapped" | "all" | undefined;
  },
): Promise<unknown> {
  const ctx = await runtimeContext();
  const { provider, binding } = await runtimeProviderForAgent(ctx, input);
  if (!provider.capabilities.readOutput) {
    throw new Error(`runtime provider cannot read agents: ${provider.id}`);
  }
  const output = await provider.readAgent({
    agentId: input.agentId,
    ...bindingIdFor(provider, binding),
    lines: input.lines ?? 80,
    ...(input.source !== undefined ? { source: input.source } : {}),
  });
  await ctx.service.recordRuntimeOutput({
    agentId: input.agentId,
    text: output.text,
    ...(output.lineCount !== undefined ? { lineCount: output.lineCount } : {}),
  });
  return { output };
}

async function sendRuntimeAgent(
  input: RuntimeAgentTargetInput & {
    text: string;
    submit?: boolean | undefined;
  },
): Promise<unknown> {
  const ctx = await runtimeContext();
  const { provider, binding } = await runtimeProviderForAgent(ctx, input);
  if (!provider.capabilities.sendInput) {
    throw new Error(`runtime provider cannot send input: ${provider.id}`);
  }
  const source = await currentActor(ctx.service);
  await provider.sendInput({
    agentId: input.agentId,
    ...bindingIdFor(provider, binding),
    text: input.text,
    ...(input.submit !== undefined ? { submit: input.submit } : {}),
    source,
  });
  await ctx.service.recordRuntimeInput({
    agentId: input.agentId,
    text: input.text,
    source,
  });
  return { ok: true, agentId: input.agentId, runtime: provider.id };
}

async function stopRuntimeAgent(
  input: RuntimeAgentTargetInput & {
    reason?: string | undefined;
  },
): Promise<unknown> {
  const ctx = await runtimeContext();
  const { provider, binding } = await runtimeProviderForAgent(ctx, input);
  if (!provider.capabilities.stopAgent) {
    throw new Error(`runtime provider cannot stop agents: ${provider.id}`);
  }
  await provider.stopAgent(stopTargetFor(provider, input.agentId, binding));
  await ctx.service.leaveAgent({
    agentId: input.agentId,
    reason: input.reason ?? "stopped via agentroom MCP",
  });
  return { ok: true, agentId: input.agentId, runtime: provider.id };
}

async function waitForEvent(input: {
  message?: string | undefined;
  ignoreCase?: boolean | undefined;
  fromAgentId?: string | undefined;
  channel?: string | undefined;
  kind?: z.infer<typeof messageKindSchema> | undefined;
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
      "agentroom_wait requires message, agentId+agentState, or dmToMe.",
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

async function runtimeContext(): Promise<RuntimeContext> {
  const ctx = await roomContext();
  return {
    ...ctx,
    providers: Object.entries(ctx.config.runtimes).map(([id, runtime]) =>
      makeRuntimeProvider(id, runtime),
    ),
  };
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
    config,
    service: new AgentRoomService(events, { roomId: config.room.id }),
    events,
  };
}

function selectRuntimeProvider(
  ctx: RuntimeContext,
  providerId: string,
): RuntimeProvider {
  const provider = ctx.providers.find((entry) => entry.id === providerId);
  if (provider !== undefined) return provider;
  const runtime = ensureRuntimeConfig(ctx.config, providerId);
  return makeRuntimeProvider(providerId, runtime);
}

async function runtimeProviderForAgent(
  ctx: RuntimeContext,
  input: RuntimeAgentTargetInput,
): Promise<{ provider: RuntimeProvider; binding: RuntimeBinding }> {
  const binding = await ctx.service.getRuntimeBinding(input.agentId);
  if (binding === undefined) {
    throw new Error(
      `No runtime binding found for agent '${input.agentId}'. Launch or enroll the agent before using MCP runtime IO.`,
    );
  }
  const providerId = input.providerId ?? binding.providerId;
  if (providerId !== binding.providerId) {
    throw new Error(
      `Runtime '${providerId}' does not match bound runtime '${binding.providerId}' for agent '${input.agentId}'.`,
    );
  }
  return {
    provider: selectRuntimeProvider(ctx, providerId),
    binding,
  };
}

function makeRuntimeProvider(
  id: string,
  runtime: RuntimeConfig | undefined,
): RuntimeProvider {
  const config = runtime ?? builtInRuntimeConfig(id);
  switch (config.type) {
    case "fake":
      return new FakeRuntimeProvider({ id });
    case "herdr": {
      const session = config.session ?? process.env.HERDR_SESSION;
      return new HerdrRuntimeProvider({
        id,
        ...(config.cli !== undefined ? { cli: config.cli } : {}),
        ...(session !== undefined ? { session } : {}),
        ...(config.layout !== undefined ? { layout: config.layout } : {}),
      });
    }
    case "tmux":
      return new TmuxRuntimeProvider({
        id,
        ...(config.cli !== undefined ? { cli: config.cli } : {}),
        ...(config.sessionPrefix !== undefined
          ? { sessionPrefix: config.sessionPrefix }
          : {}),
      });
    case "zellij":
      return new ZellijRuntimeProvider({
        id,
        ...(config.cli !== undefined ? { cli: config.cli } : {}),
        ...(config.session !== undefined ? { session: config.session } : {}),
      });
  }
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

function nextAgentId(role: AgentRole, agents: Array<{ id: string }>): string {
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

function cleanOptionalString(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned === undefined || cleaned.length === 0 ? undefined : cleaned;
}

async function stopRuntimeAfterLaunchFailure(
  provider: RuntimeProvider,
  agent: { id: string; bindingId: string; metadata?: Record<string, unknown> },
): Promise<void> {
  if (!provider.capabilities.stopAgent) return;
  const runtime = bindingFor(provider, agent.bindingId, agent.metadata);
  await provider
    .stopAgent(stopTargetFor(provider, agent.id, runtime))
    .catch(() => {});
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      provider.kind === "tmux" ||
      provider.kind === "herdr" ||
      provider.kind === "zellij"
        ? "pane"
        : "process",
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function bindingIdFor(
  provider: RuntimeProvider,
  binding?: RuntimeBinding,
): { bindingId?: string } {
  return binding?.providerId === provider.id
    ? { bindingId: binding.bindingId }
    : {};
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

function agentRoomProtocolEnv(
  config: AgentRoomConfig,
  input: {
    agentId: string;
    role: StartAgentRequest["role"];
    roomId?: string;
  },
  cwd: string,
): Record<string, string> {
  return {
    AGENTROOM: "1",
    AGENTROOM_AGENT_ID: input.agentId,
    AGENTROOM_ROOM_ID: input.roomId ?? config.room.id,
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

interface ClientLogEvent {
  seq: number;
  ts: string;
  clientId: string;
  level: string;
  category: string;
  message: string;
  fields?: Record<string, unknown>;
}

interface ClientStateRow {
  clientId: string;
  [key: string]: unknown;
}

async function clientTelemetryDir(): Promise<string> {
  const cwd = process.env.AGENTROOM_CWD ?? process.cwd();
  const config = await loadAgentRoomConfig(cwd).catch(() =>
    createDefaultAgentRoomConfig({
      roomId: defaultRoomIdFromEnv(process.env),
      roomName: "AgentRoom",
      defaultRuntime: "herdr",
    }),
  );
  return dirname(resolveStoragePath(config, cwd));
}

async function readClientEvents(): Promise<ClientLogEvent[]> {
  const path = join(await clientTelemetryDir(), "client-logs.jsonl");
  const raw = await readFile(path, "utf8").catch(() => "");
  const events: ClientLogEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as ClientLogEvent;
      if (typeof event.seq === "number") events.push(event);
    } catch {
      // skip malformed line
    }
  }
  return events;
}

async function readClientStates(): Promise<ClientStateRow[]> {
  const path = join(await clientTelemetryDir(), "client-states.json");
  const raw = await readFile(path, "utf8").catch(() => "");
  if (!raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ClientStateRow[]) : [];
  } catch {
    return [];
  }
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
