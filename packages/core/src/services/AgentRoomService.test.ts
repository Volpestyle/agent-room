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
});
