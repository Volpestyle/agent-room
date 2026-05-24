import { describe, expect, it } from 'vitest';
import type { EventStore, RoomEvent } from '../index.js';
import { AgentRoomService } from './AgentRoomService.js';

class TestStore implements EventStore {
  readonly events: RoomEvent[] = [];
  async append(event: RoomEvent) {
    this.events.push(event);
  }
  async appendMany(events: RoomEvent[]) {
    this.events.push(...events);
  }
  async list() {
    return this.events;
  }
}

describe('AgentRoomService', () => {
  it('appends a message event', async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: 'room-test' });
    const message = await service.postMessage({ body: 'hello' });

    expect(message.body).toBe('hello');
    expect(store.events).toHaveLength(1);
    expect(store.events[0]?.type).toBe('message.posted');
  });

  it('lists channel and direct messages', async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: 'room-test' });

    await service.postMessage({
      body: 'Starting implementation',
      channelId: 'implementation',
      sender: { kind: 'agent', id: 'impl' }
    });
    await service.postMessage({
      body: 'Please review',
      channelId: 'dm',
      sender: { kind: 'agent', id: 'impl' },
      recipients: [{ kind: 'agent', id: 'reviewer' }]
    });

    expect(await service.listMessages({ channelId: 'implementation' })).toHaveLength(1);
    expect(await service.listMessages({ participant: { kind: 'agent', id: 'reviewer' } })).toMatchObject([
      {
        body: 'Please review',
        recipients: [{ kind: 'agent', id: 'reviewer' }]
      }
    ]);
  });

  it('projects task claim and status changes from events', async () => {
    const store = new TestStore();
    const service = new AgentRoomService(store, { roomId: 'room-test' });

    const created = await service.createTask({ title: 'Wire task commands' });
    const claimed = await service.claimTask({
      taskId: created.id,
      assignee: { kind: 'agent', id: 'impl' }
    });
    await service.linkTaskRef({
      taskId: created.id,
      ref: { kind: 'linear-issue', id: 'ENG-123', label: 'ENG-123' }
    });
    const done = await service.completeTask({
      taskId: created.id,
      actor: { kind: 'agent', id: 'impl' },
      summary: 'Implemented'
    });

    expect(claimed.status).toBe('claimed');
    expect(done.status).toBe('done');
    expect(await service.getTask(created.id)).toMatchObject({
      id: created.id,
      status: 'done',
      assignee: { kind: 'agent', id: 'impl' },
      refs: [{ kind: 'linear-issue', id: 'ENG-123', label: 'ENG-123' }]
    });
    expect((await service.listTasks()).map((task) => task.id)).toEqual([created.id]);
    expect(store.events.map((event) => event.type)).toEqual([
      'task.created',
      'task.assigned',
      'task.status_changed',
      'task.ref_added',
      'linear.issue_event',
      'task.status_changed',
      'agent.done'
    ]);
  });
});
