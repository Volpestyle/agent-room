import type { EventQuery, EventStore, RoomEvent } from '@agentroom/core';

export class InMemoryEventStore implements EventStore {
  private readonly events: RoomEvent[] = [];

  async append(event: RoomEvent): Promise<void> {
    this.events.push(event);
  }

  async appendMany(events: RoomEvent[]): Promise<void> {
    this.events.push(...events);
  }

  async list(query: EventQuery = {}): Promise<RoomEvent[]> {
    let result = [...this.events];

    if (query.roomId) result = result.filter((event) => event.roomId === query.roomId);
    if (query.type) result = result.filter((event) => event.type === query.type);
    if (query.since) result = result.filter((event) => event.createdAt >= query.since!);
    if (query.limit !== undefined) result = result.slice(-query.limit);

    return result;
  }
}
