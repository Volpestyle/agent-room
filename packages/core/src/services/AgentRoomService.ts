import type { ActorRef, Agent, HarnessSpec, HumanEscalation, Id, Importance, Message, MessageKind, Ref, RuntimeBinding, Task, TaskStatus } from '../domain.js';
import type { RoomEvent } from '../events.js';
import { createId, nowIso } from '../ids.js';
import type { EventStore } from '../ports/EventStore.js';

export interface AgentRoomServiceOptions {
  roomId: Id;
  systemActor?: ActorRef;
}

export class AgentRoomService {
  private readonly roomId: Id;
  private readonly systemActor: ActorRef;

  constructor(
    private readonly events: EventStore,
    options: AgentRoomServiceOptions
  ) {
    this.roomId = options.roomId;
    this.systemActor = options.systemActor ?? { kind: 'system', id: 'agentroom' };
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
      id: createId('msg'),
      roomId: this.roomId,
      channelId: input.channelId ?? 'announcements',
      sender: input.sender ?? this.systemActor,
      kind: input.kind ?? 'chat',
      body: input.body,
      importance: input.importance ?? 'normal',
      createdAt: now,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.recipients !== undefined && input.recipients.length > 0 ? { recipients: input.recipients } : {})
    };

    await this.events.append(this.event('message.posted', { message }, now));
    return message;
  }

  async listMessages(query: {
    channelId?: string;
    threadId?: string;
    participant?: ActorRef;
    limit?: number;
  } = {}): Promise<Message[]> {
    let messages = (await this.events.list({ roomId: this.roomId }))
      .filter((event): event is Extract<RoomEvent, { type: 'message.posted' }> => event.type === 'message.posted')
      .map((event) => event.payload.message);

    if (query.channelId !== undefined) {
      messages = messages.filter((message) => message.channelId === query.channelId);
    }
    if (query.threadId !== undefined) {
      messages = messages.filter((message) => message.threadId === query.threadId);
    }
    if (query.participant !== undefined) {
      messages = messages.filter(
        (message) =>
          sameActor(message.sender, query.participant!) ||
          (message.recipients ?? []).some((recipient) => sameActor(recipient, query.participant!))
      );
    }
    if (query.limit !== undefined) messages = messages.slice(-query.limit);

    return messages;
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
      id: createId('task'),
      roomId: this.roomId,
      title: input.title,
      status: input.assignee ? 'assigned' : 'planned',
      createdBy: input.createdBy ?? this.systemActor,
      createdAt: now,
      updatedAt: now,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      ...(input.refs !== undefined && input.refs.length > 0 ? { refs: input.refs } : {})
    };

    await this.events.append(this.event('task.created', { task }, now));
    return task;
  }

  async linkTaskRef(input: { taskId: Id; ref: Ref }): Promise<Task> {
    const task = await this.requireTask(input.taskId);
    const now = nowIso();
    const refs = mergeRefs(task.refs ?? [], input.ref);
    const updated: Task = {
      ...task,
      refs,
      updatedAt: now
    };

    await this.events.append(this.event('task.ref_added', { taskId: input.taskId, ref: input.ref }, now));
    if (input.ref.kind === 'linear-issue') {
      await this.events.append(
        this.event('linear.issue_event', { issueId: input.ref.id, taskId: input.taskId, action: 'linked' }, now)
      );
    }
    return updated;
  }

  async listTasks(): Promise<Task[]> {
    return [...(await this.taskProjection()).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getTask(taskId: Id): Promise<Task | undefined> {
    return (await this.taskProjection()).get(taskId);
  }

  async claimTask(input: { taskId: Id; assignee: ActorRef }): Promise<Task> {
    const task = await this.requireTask(input.taskId);
    const now = nowIso();
    const updated: Task = {
      ...task,
      status: 'claimed',
      assignee: input.assignee,
      updatedAt: now
    };

    await this.events.appendMany([
      this.event('task.assigned', { taskId: input.taskId, assignee: input.assignee }, now),
      this.event('task.status_changed', { taskId: input.taskId, status: 'claimed', previousStatus: task.status, actor: input.assignee }, now)
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
      updatedAt: now
    };

    await this.events.append(
      this.event(
        'task.status_changed',
        {
          taskId: input.taskId,
          status: input.status,
          previousStatus: task.status,
          ...(input.actor !== undefined ? { actor: input.actor } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {})
        },
        now
      )
    );

    return updated;
  }

  async blockTask(input: { taskId: Id; reason: string; actor: ActorRef }): Promise<Task> {
    const task = await this.updateTaskStatus({
      taskId: input.taskId,
      status: 'blocked',
      actor: input.actor,
      reason: input.reason
    });

    if (input.actor.kind === 'agent') {
      await this.events.append(
        this.event('agent.blocked', { agentId: input.actor.id, taskId: input.taskId, reason: input.reason })
      );
    }

    return task;
  }

  async completeTask(input: { taskId: Id; summary?: string; actor: ActorRef }): Promise<Task> {
    const task = await this.updateTaskStatus({
      taskId: input.taskId,
      status: 'done',
      actor: input.actor,
      ...(input.summary !== undefined ? { summary: input.summary } : {})
    });

    if (input.actor.kind === 'agent') {
      await this.events.append(
        this.event(
          'agent.done',
          {
            agentId: input.actor.id,
            taskId: input.taskId,
            ...(input.summary !== undefined ? { summary: input.summary } : {})
          }
        )
      );
    }

    return task;
  }

  async registerAgent(input: {
    id: Id;
    displayName?: string;
    role: Agent['role'];
    harness?: HarnessSpec;
    capabilities?: string[];
  }): Promise<Agent> {
    const now = nowIso();
    const agent: Agent = {
      id: input.id,
      roomId: this.roomId,
      displayName: input.displayName ?? input.id,
      role: input.role,
      state: 'created',
      createdAt: now,
      updatedAt: now,
      ...(input.harness !== undefined ? { harness: input.harness } : {}),
      ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {})
    };

    await this.events.append(this.event('agent.joined', { agent }, now));
    return agent;
  }

  async bindRuntime(input: { agentId: Id; runtime: RuntimeBinding }): Promise<void> {
    await this.events.append(this.event('runtime.bound', { agentId: input.agentId, runtime: input.runtime }));
  }

  async getRuntimeBinding(agentId: Id): Promise<RuntimeBinding | undefined> {
    const events = await this.events.list({ roomId: this.roomId });
    let binding: RuntimeBinding | undefined;

    for (const event of events) {
      if (event.type === 'runtime.bound' && event.payload.agentId === agentId) {
        binding = event.payload.runtime;
      }
    }

    return binding;
  }

  async recordRuntimeOutput(input: { agentId: Id; text: string; lineCount?: number }): Promise<void> {
    await this.events.append(
      this.event('runtime.output_observed', {
        agentId: input.agentId,
        text: input.text,
        ...(input.lineCount !== undefined ? { lineCount: input.lineCount } : {})
      })
    );
  }

  async recordRuntimeInput(input: { agentId: Id; text: string; source: ActorRef }): Promise<void> {
    await this.events.append(this.event('runtime.input_sent', { agentId: input.agentId, text: input.text, source: input.source.id }));
  }

  async recordLinearIssueEvent(input: {
    issueId: Id;
    action: 'linked' | 'commented' | 'status_updated' | 'tracker_update_skipped';
    taskId?: Id;
    body?: string;
    status?: string;
    reason?: string;
  }): Promise<void> {
    await this.events.append(
      this.event('linear.issue_event', {
        issueId: input.issueId,
        action: input.action,
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {})
      })
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
      id: createId('q'),
      roomId: this.roomId,
      from: input.from,
      question: input.question,
      priority: input.priority ?? 'normal',
      status: 'open',
      createdAt: now,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {})
    };

    await this.events.append(this.event('human_escalation.created', { escalation }, now));
    return escalation;
  }

  private event<T extends RoomEvent['type']>(
    type: T,
    payload: Extract<RoomEvent, { type: T }>['payload'],
    createdAt = nowIso()
  ): Extract<RoomEvent, { type: T }> {
    return {
      id: createId('evt'),
      roomId: this.roomId,
      type,
      payload,
      createdAt
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
        case 'task.created':
          tasks.set(event.payload.task.id, event.payload.task);
          break;
        case 'task.assigned': {
          const task = tasks.get(event.payload.taskId);
          if (task) {
            tasks.set(event.payload.taskId, {
              ...task,
              status: task.status === 'planned' ? 'assigned' : task.status,
              assignee: event.payload.assignee,
              updatedAt: event.createdAt
            });
          }
          break;
        }
        case 'task.ref_added': {
          const task = tasks.get(event.payload.taskId);
          if (task) {
            tasks.set(event.payload.taskId, {
              ...task,
              refs: mergeRefs(task.refs ?? [], event.payload.ref),
              updatedAt: event.createdAt
            });
          }
          break;
        }
        case 'task.status_changed': {
          const task = tasks.get(event.payload.taskId);
          if (task) {
            tasks.set(event.payload.taskId, {
              ...task,
              status: event.payload.status,
              updatedAt: event.createdAt
            });
          }
          break;
        }
      }
    }

    return tasks;
  }
}

function mergeRefs(existing: Ref[], next: Ref): Ref[] {
  const withoutDuplicate = existing.filter((ref) => ref.kind !== next.kind || ref.id !== next.id);
  return [...withoutDuplicate, next];
}

function sameActor(left: ActorRef, right: ActorRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}
