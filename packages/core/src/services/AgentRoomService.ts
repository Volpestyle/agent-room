import type {
  ActorRef,
  Agent,
  HarnessSpec,
  HumanEscalation,
  Id,
  Importance,
  Message,
  MessageKind,
  Ref,
  RuntimeBinding,
  Task,
  TaskStatus,
  Workspace,
} from "../domain.js";
import type { RoomEvent } from "../events.js";
import { createId, nowIso } from "../ids.js";
import type {
  ChatGatewayAttribution,
  ChatInboundMessage,
  ChatSendMessageResult,
} from "../ports/Connectors.js";
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

  async createTask(input: {
    title: string;
    description?: string;
    assignee?: ActorRef;
    createdBy?: ActorRef;
    refs?: Ref[];
  }): Promise<Task> {
    const now = nowIso();
    const task: Task = {
      id: createId("task", input.title),
      roomId: this.roomId,
      title: input.title,
      status: input.assignee ? "assigned" : "planned",
      createdBy: input.createdBy ?? this.systemActor,
      createdAt: now,
      updatedAt: now,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      ...(input.refs !== undefined && input.refs.length > 0
        ? { refs: input.refs }
        : {}),
    };

    await this.events.append(this.event("task.created", { task }, now));
    return task;
  }

  async linkTaskRef(input: { taskId: Id; ref: Ref }): Promise<Task> {
    const task = await this.requireTask(input.taskId);
    const now = nowIso();
    const refs = mergeRefs(task.refs ?? [], input.ref);
    const updated: Task = {
      ...task,
      refs,
      updatedAt: now,
    };

    await this.events.append(
      this.event(
        "task.ref_added",
        { taskId: input.taskId, ref: input.ref },
        now,
      ),
    );
    if (input.ref.kind === "tracker-issue") {
      await this.events.append(
        this.event(
          "tracker.ref_event",
          {
            issueId: input.ref.id,
            taskId: input.taskId,
            action: "linked",
            providerKind: trackerProviderKind(input.ref),
            ...trackerProviderId(input.ref),
          },
          now,
        ),
      );
    }
    return updated;
  }

  async updateTaskDetails(input: {
    taskId: Id;
    title?: string;
    description?: string;
    actor?: ActorRef;
  }): Promise<Task> {
    const task = await this.requireTask(input.taskId);
    const now = nowIso();
    const updated: Task = {
      ...task,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      updatedAt: now,
    };

    await this.events.append(
      this.event(
        "task.updated",
        {
          taskId: input.taskId,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.actor !== undefined ? { actor: input.actor } : {}),
        },
        now,
      ),
    );

    return updated;
  }

  async deleteTask(input: {
    taskId: Id;
    actor?: ActorRef;
    reason?: string;
  }): Promise<void> {
    await this.requireTask(input.taskId);
    const now = nowIso();

    await this.events.append(
      this.event(
        "task.deleted",
        {
          taskId: input.taskId,
          ...(input.actor !== undefined ? { actor: input.actor } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        },
        now,
      ),
    );
  }

  async listTasks(): Promise<Task[]> {
    return [...(await this.taskProjection()).values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
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

  async getTask(taskId: Id): Promise<Task | undefined> {
    return (await this.taskProjection()).get(taskId);
  }

  async claimTask(input: { taskId: Id; assignee: ActorRef }): Promise<Task> {
    const task = await this.requireTask(input.taskId);
    const now = nowIso();
    const updated: Task = {
      ...task,
      status: "claimed",
      assignee: input.assignee,
      updatedAt: now,
    };

    await this.events.appendMany([
      this.event(
        "task.assigned",
        { taskId: input.taskId, assignee: input.assignee },
        now,
      ),
      this.event(
        "task.status_changed",
        {
          taskId: input.taskId,
          status: "claimed",
          previousStatus: task.status,
          actor: input.assignee,
        },
        now,
      ),
    ]);

    return updated;
  }

  async updateTaskStatus(input: {
    taskId: Id;
    status: TaskStatus;
    actor?: ActorRef;
    reason?: string;
    summary?: string;
  }): Promise<Task> {
    const task = await this.requireTask(input.taskId);
    const now = nowIso();
    const updated: Task = {
      ...task,
      status: input.status,
      updatedAt: now,
    };

    await this.events.append(
      this.event(
        "task.status_changed",
        {
          taskId: input.taskId,
          status: input.status,
          previousStatus: task.status,
          ...(input.actor !== undefined ? { actor: input.actor } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
        },
        now,
      ),
    );

    return updated;
  }

  async blockTask(input: {
    taskId: Id;
    reason: string;
    actor: ActorRef;
  }): Promise<Task> {
    const task = await this.updateTaskStatus({
      taskId: input.taskId,
      status: "blocked",
      actor: input.actor,
      reason: input.reason,
    });

    if (input.actor.kind === "agent") {
      await this.events.append(
        this.event("agent.blocked", {
          agentId: input.actor.id,
          taskId: input.taskId,
          reason: input.reason,
        }),
      );
    }

    return task;
  }

  async completeTask(input: {
    taskId: Id;
    summary?: string;
    actor: ActorRef;
  }): Promise<Task> {
    const task = await this.updateTaskStatus({
      taskId: input.taskId,
      status: "done",
      actor: input.actor,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
    });

    if (input.actor.kind === "agent") {
      await this.events.append(
        this.event("agent.done", {
          agentId: input.actor.id,
          taskId: input.taskId,
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
        }),
      );
    }

    return task;
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
        ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
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

  private async requireTask(taskId: Id): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  private async taskProjection(): Promise<Map<Id, Task>> {
    const tasks = new Map<Id, Task>();
    const events = await this.events.list({ roomId: this.roomId });

    for (const event of events) {
      switch (event.type) {
        case "task.created":
          tasks.set(event.payload.task.id, event.payload.task);
          break;
        case "task.assigned": {
          const task = tasks.get(event.payload.taskId);
          if (task) {
            tasks.set(event.payload.taskId, {
              ...task,
              status: task.status === "planned" ? "assigned" : task.status,
              assignee: event.payload.assignee,
              updatedAt: event.createdAt,
            });
          }
          break;
        }
        case "task.updated": {
          const task = tasks.get(event.payload.taskId);
          if (task) {
            tasks.set(event.payload.taskId, {
              ...task,
              ...(event.payload.title !== undefined
                ? { title: event.payload.title }
                : {}),
              ...(event.payload.description !== undefined
                ? { description: event.payload.description }
                : {}),
              updatedAt: event.createdAt,
            });
          }
          break;
        }
        case "task.deleted":
          tasks.delete(event.payload.taskId);
          break;
        case "task.ref_added": {
          const task = tasks.get(event.payload.taskId);
          if (task) {
            tasks.set(event.payload.taskId, {
              ...task,
              refs: mergeRefs(task.refs ?? [], event.payload.ref),
              updatedAt: event.createdAt,
            });
          }
          break;
        }
        case "task.status_changed": {
          const task = tasks.get(event.payload.taskId);
          if (task) {
            tasks.set(event.payload.taskId, {
              ...task,
              status: event.payload.status,
              updatedAt: event.createdAt,
            });
          }
          break;
        }
      }
    }

    return tasks;
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

function mergeRefs(existing: Ref[], next: Ref): Ref[] {
  const withoutDuplicate = existing.filter(
    (ref) => ref.kind !== next.kind || ref.id !== next.id,
  );
  return [...withoutDuplicate, next];
}

function trackerProviderKind(ref: Ref): string {
  const value = ref.metadata?.providerKind;
  return typeof value === "string" && value.length > 0 ? value : "custom";
}

function trackerProviderId(ref: Ref): { providerId?: string } {
  const value = ref.metadata?.providerId;
  return typeof value === "string" && value.length > 0
    ? { providerId: value }
    : {};
}

function sameActor(left: ActorRef, right: ActorRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}
