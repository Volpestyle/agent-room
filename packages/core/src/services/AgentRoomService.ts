import type { ActorRef, Agent, HarnessSpec, HumanEscalation, Id, Importance, Message, MessageKind, Task } from '../domain.js';
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
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {})
    };

    await this.events.append(this.event('message.posted', { message }, now));
    return message;
  }

  async createTask(input: {
    title: string;
    description?: string;
    assignee?: ActorRef;
    createdBy?: ActorRef;
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
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {})
    };

    await this.events.append(this.event('task.created', { task }, now));
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
}
