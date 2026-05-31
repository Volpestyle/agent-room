import type {
  ActorRef,
  Agent,
  AgentPresence,
  HarnessSpec,
  HumanEscalation,
  Id,
  Importance,
  Message,
  MessageKind,
  RuntimeBinding,
  Workspace,
} from "../domain.js";
import type { RoomEvent } from "../events.js";
import { createId, nowIso } from "../ids.js";
import type {
  ChatGatewayAttribution,
  ChatInboundMessage,
  ChatSendMessageResult,
} from "../ports/ChatGatewayProvider.js";
import type {
  EventBatch,
  EventCursor,
  EventCursorPosition,
  EventQuery,
  EventStore,
} from "../ports/EventStore.js";

export interface AgentRoomServiceOptions {
  roomId: Id;
  systemActor?: ActorRef;
}

export class AgentRoomService {
  private readonly roomId: Id;
  private readonly systemActor: ActorRef;

  constructor(
    private readonly events: EventStore,
    options: AgentRoomServiceOptions,
  ) {
    this.roomId = options.roomId;
    this.systemActor = options.systemActor ?? {
      kind: "system",
      id: "agentroom",
    };
  }

  async postMessage(input: {
    body: string;
    channelId?: string;
    threadId?: string;
    sender?: ActorRef;
    recipients?: ActorRef[];
    kind?: MessageKind;
    importance?: Importance;
  }): Promise<Message> {
    const now = nowIso();
    const message: Message = {
      id: createId("msg"),
      roomId: this.roomId,
      channelId: input.channelId ?? "announcements",
      sender: input.sender ?? this.systemActor,
      kind: input.kind ?? "chat",
      body: input.body,
      importance: input.importance ?? "normal",
      createdAt: now,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.recipients !== undefined && input.recipients.length > 0
        ? { recipients: input.recipients }
        : {}),
    };

    await this.events.append(this.event("message.posted", { message }, now));
    return message;
  }

  async listMessages(
    query: {
      channelId?: string;
      threadId?: string;
      participant?: ActorRef;
      limit?: number;
    } = {},
  ): Promise<Message[]> {
    let messages = (await this.events.list({ roomId: this.roomId }))
      .filter(
        (event): event is Extract<RoomEvent, { type: "message.posted" }> =>
          event.type === "message.posted",
      )
      .map((event) => event.payload.message);

    if (query.channelId !== undefined) {
      messages = messages.filter(
        (message) => message.channelId === query.channelId,
      );
    }
    if (query.threadId !== undefined) {
      messages = messages.filter(
        (message) => message.threadId === query.threadId,
      );
    }
    if (query.participant !== undefined) {
      messages = messages.filter(
        (message) =>
          sameActor(message.sender, query.participant!) ||
          (message.recipients ?? []).some((recipient) =>
            sameActor(recipient, query.participant!),
          ),
      );
    }
    if (query.limit !== undefined) messages = messages.slice(-query.limit);

    return messages;
  }

  async eventCursor(
    position: EventCursorPosition = "end",
  ): Promise<EventCursor> {
    return this.events.cursor(position);
  }

  async listEventsFromCursor(
    cursor: EventCursor,
    query: Omit<EventQuery, "roomId"> = {},
  ): Promise<EventBatch> {
    return this.events.listFromCursor(cursor, {
      ...query,
      roomId: this.roomId,
    });
  }

  async registerWorkspace(input: {
    cwd: string;
    label?: string;
    aliases?: string[];
    runtime?: RuntimeBinding;
    metadata?: Record<string, unknown>;
  }): Promise<Workspace> {
    const now = nowIso();
    const existing = (await this.workspaceProjection()).find(
      (workspace) => workspace.cwd === input.cwd,
    );

    if (existing) {
      const updated: Workspace = {
        ...existing,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
        ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        lastSeenAt: now,
        updatedAt: now,
      };
      await this.events.append(
        this.event("workspace.updated", {
          workspaceId: existing.id,
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
          lastSeenAt: now,
          ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        }),
      );
      return updated;
    }

    const workspace: Workspace = {
      id: createId("ws", input.label ?? input.cwd),
      roomId: this.roomId,
      cwd: input.cwd,
      label: input.label ?? input.cwd,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      ...(input.aliases !== undefined && input.aliases.length > 0
        ? { aliases: input.aliases }
        : {}),
      ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    await this.events.append(
      this.event("workspace.registered", { workspace }, now),
    );
    return workspace;
  }

  async listWorkspaces(): Promise<Workspace[]> {
    return (await this.workspaceProjection()).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }

  /** Report that an agent is blocked (agent-state signal — not a task). */
  async markAgentBlocked(input: { agentId: Id; reason: string }): Promise<void> {
    await this.events.append(
      this.event("agent.blocked", {
        agentId: input.agentId,
        reason: input.reason,
      }),
    );
  }

  /** Report that an agent finished its work (agent-state signal — not a task). */
  async markAgentDone(input: { agentId: Id; summary?: string }): Promise<void> {
    await this.events.appendMany([
      this.event("agent.done", {
        agentId: input.agentId,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
      }),
      this.event("agent.finished", {
        agentId: input.agentId,
        state: "done",
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
      }),
    ]);
  }

  async registerAgent(input: {
    id: Id;
    displayName?: string;
    role: Agent["role"];
    harness?: HarnessSpec;
    capabilities?: string[];
  }): Promise<Agent> {
    const now = nowIso();
    const agent: Agent = {
      id: input.id,
      roomId: this.roomId,
      displayName: input.displayName ?? input.id,
      role: input.role,
      state: "created",
      createdAt: now,
      updatedAt: now,
      ...(input.harness !== undefined ? { harness: input.harness } : {}),
      ...(input.capabilities !== undefined
        ? { capabilities: input.capabilities }
        : {}),
    };

    await this.events.append(this.event("agent.joined", { agent }, now));
    return agent;
  }

  async listAgents(): Promise<Agent[]> {
    return [...(await this.agentProjection()).values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  async listAgentPresence(): Promise<AgentPresence[]> {
    const agents = await this.agentProjection();
    const presence = new Map<Id, AgentPresence>();
    for (const agent of agents.values()) {
      presence.set(agent.id, { agent });
    }

    const events = await this.events.list({ roomId: this.roomId });
    for (const event of events) {
      if (event.type !== "agent.heartbeat") continue;
      const current = presence.get(event.payload.agentId);
      if (!current) continue;
      presence.set(event.payload.agentId, {
        agent: current.agent,
        lastHeartbeatAt: event.createdAt,
        ...(event.payload.status !== undefined
          ? { heartbeatStatus: event.payload.status }
          : {}),
      });
    }

    return [...presence.values()].sort((a, b) =>
      a.agent.createdAt.localeCompare(b.agent.createdAt),
    );
  }

  async getAgent(agentId: Id): Promise<Agent | undefined> {
    return (await this.agentProjection()).get(agentId);
  }

  async recordAgentHeartbeat(input: {
    agentId: Id;
    state: Agent["state"];
    status?: string;
  }): Promise<void> {
    await this.events.append(
      this.event("agent.heartbeat", {
        agentId: input.agentId,
        state: input.state,
        ...(input.status !== undefined ? { status: input.status } : {}),
      }),
    );
  }

  async leaveAgent(input: { agentId: Id; reason?: string }): Promise<void> {
    await this.events.append(
      this.event("agent.left", {
        agentId: input.agentId,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      }),
    );
  }

  async bindRuntime(input: {
    agentId: Id;
    runtime: RuntimeBinding;
  }): Promise<void> {
    await this.events.append(
      this.event("runtime.bound", {
        agentId: input.agentId,
        runtime: input.runtime,
      }),
    );
  }

  async getRuntimeBinding(agentId: Id): Promise<RuntimeBinding | undefined> {
    const events = await this.events.list({ roomId: this.roomId });
    let binding: RuntimeBinding | undefined;

    for (const event of events) {
      if (event.type === "runtime.bound" && event.payload.agentId === agentId) {
        binding = event.payload.runtime;
      }
    }

    return binding;
  }

  async findAgentByBinding(bindingId: string): Promise<Id | undefined> {
    const events = await this.events.list({ roomId: this.roomId });
    let agentId: Id | undefined;
    for (const event of events) {
      if (
        event.type === "runtime.bound" &&
        event.payload.runtime.bindingId === bindingId
      ) {
        agentId = event.payload.agentId;
      }
    }
    return agentId;
  }

  async recordRuntimeOutput(input: {
    agentId: Id;
    text: string;
    lineCount?: number;
  }): Promise<void> {
    await this.events.append(
      this.event("runtime.output_observed", {
        agentId: input.agentId,
        text: input.text,
        ...(input.lineCount !== undefined
          ? { lineCount: input.lineCount }
          : {}),
      }),
    );
  }

  async recordRuntimeInput(input: {
    agentId: Id;
    text: string;
    source: ActorRef;
  }): Promise<void> {
    await this.events.append(
      this.event("runtime.input_sent", {
        agentId: input.agentId,
        text: input.text,
        source: input.source.id,
      }),
    );
  }

  async recordChatInbound(input: {
    message: ChatInboundMessage;
    routedTo?: string;
  }): Promise<void> {
    await this.events.append(
      this.event("chat.inbound_received", {
        message: input.message,
        ...(input.routedTo !== undefined ? { routedTo: input.routedTo } : {}),
      }),
    );
  }

  async recordChatOutbound(input: {
    providerId: Id;
    conversationId: Id;
    result: ChatSendMessageResult;
    text: string;
    messageId?: Id;
    source?: ActorRef;
    attribution?: ChatGatewayAttribution;
  }): Promise<void> {
    await this.events.append(
      this.event("chat.outbound_sent", {
        providerId: input.providerId,
        conversationId: input.conversationId,
        result: input.result,
        text: input.text,
        ...(input.messageId !== undefined
          ? { messageId: input.messageId }
          : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.attribution !== undefined
          ? { attribution: input.attribution }
          : {}),
      }),
    );
  }

  async recordTrackerRefEvent(input: {
    issueId: Id;
    providerKind: string;
    providerId?: string;
    action: "linked" | "tracker_update_skipped";
    taskId?: Id;
    reason?: string;
  }): Promise<void> {
    await this.events.append(
      this.event("tracker.ref_event", {
        issueId: input.issueId,
        providerKind: input.providerKind,
        ...(input.providerId !== undefined
          ? { providerId: input.providerId }
          : {}),
        action: input.action,
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      }),
    );
  }

  async askHuman(input: {
    question: string;
    from: ActorRef;
    taskId?: Id;
    priority?: Importance;
  }): Promise<HumanEscalation> {
    const now = nowIso();
    const escalation: HumanEscalation = {
      id: createId("q"),
      roomId: this.roomId,
      from: input.from,
      question: input.question,
      priority: input.priority ?? "normal",
      status: "open",
      createdAt: now,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    };

    await this.events.append(
      this.event("human_escalation.created", { escalation }, now),
    );
    return escalation;
  }

  private event<T extends RoomEvent["type"]>(
    type: T,
    payload: Extract<RoomEvent, { type: T }>["payload"],
    createdAt = nowIso(),
  ): Extract<RoomEvent, { type: T }> {
    return {
      id: createId("evt"),
      roomId: this.roomId,
      type,
      payload,
      createdAt,
    } as Extract<RoomEvent, { type: T }>;
  }

  private async workspaceProjection(): Promise<Workspace[]> {
    const workspaces = new Map<Id, Workspace>();
    const events = await this.events.list({ roomId: this.roomId });

    for (const event of events) {
      switch (event.type) {
        case "workspace.registered":
          workspaces.set(event.payload.workspace.id, event.payload.workspace);
          break;
        case "workspace.updated": {
          const workspace = workspaces.get(event.payload.workspaceId);
          if (workspace) {
            workspaces.set(event.payload.workspaceId, {
              ...workspace,
              ...(event.payload.label !== undefined
                ? { label: event.payload.label }
                : {}),
              ...(event.payload.cwd !== undefined
                ? { cwd: event.payload.cwd }
                : {}),
              ...(event.payload.aliases !== undefined
                ? { aliases: event.payload.aliases }
                : {}),
              ...(event.payload.runtime !== undefined
                ? { runtime: event.payload.runtime }
                : {}),
              ...(event.payload.metadata !== undefined
                ? { metadata: event.payload.metadata }
                : {}),
              lastSeenAt: event.payload.lastSeenAt ?? event.createdAt,
              updatedAt: event.createdAt,
            });
          }
          break;
        }
      }
    }

    return [...workspaces.values()];
  }

  private async agentProjection(): Promise<Map<Id, Agent>> {
    const agents = new Map<Id, Agent>();
    const events = await this.events.list({ roomId: this.roomId });

    for (const event of events) {
      switch (event.type) {
        case "agent.joined":
          agents.set(event.payload.agent.id, event.payload.agent);
          break;
        case "runtime.bound": {
          const agent = agents.get(event.payload.agentId);
          if (agent) {
            agents.set(event.payload.agentId, {
              ...agent,
              runtime: event.payload.runtime,
              updatedAt: event.createdAt,
            });
          }
          break;
        }
        case "agent.heartbeat": {
          const agent = agents.get(event.payload.agentId);
          if (agent) {
            agents.set(event.payload.agentId, {
              ...agent,
              state: event.payload.state,
              updatedAt: event.createdAt,
            });
          }
          break;
        }
        case "runtime.state_observed": {
          const agent = agents.get(event.payload.agentId);
          if (agent) {
            agents.set(event.payload.agentId, {
              ...agent,
              state: event.payload.state,
              updatedAt: event.createdAt,
            });
          }
          break;
        }
        case "agent.blocked": {
          const agent = agents.get(event.payload.agentId);
          if (agent) {
            agents.set(event.payload.agentId, {
              ...agent,
              state: "blocked",
              updatedAt: event.createdAt,
            });
          }
          break;
        }
        case "agent.done": {
          const agent = agents.get(event.payload.agentId);
          if (agent) {
            agents.set(event.payload.agentId, {
              ...agent,
              state: "done",
              updatedAt: event.createdAt,
            });
          }
          break;
        }
        case "agent.finished": {
          const agent = agents.get(event.payload.agentId);
          if (agent) {
            agents.set(event.payload.agentId, {
              ...agent,
              state: event.payload.state,
              updatedAt: event.createdAt,
            });
          }
          break;
        }
        case "agent.left": {
          const agent = agents.get(event.payload.agentId);
          if (agent) {
            agents.set(event.payload.agentId, {
              ...agent,
              state: "stopped",
              updatedAt: event.createdAt,
            });
          }
          break;
        }
      }
    }

    return agents;
  }

}

function sameActor(left: ActorRef, right: ActorRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}
