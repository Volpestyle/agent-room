import type { EventBatch, EventCursor, EventCursorPosition, EventQuery, EventStore, RoomEvent } from '@agentroom/core';

export class InMemoryEventStore implements EventStore {
  private readonly events: RoomEvent[] = [];

  async append(event: RoomEvent): Promise<void> {
    this.events.push(event);
  }

  async appendMany(events: RoomEvent[]): Promise<void> {
    this.events.push(...events);
  }

  async cursor(position: EventCursorPosition = 'end'): Promise<EventCursor> {
    return { position: position === 'start' ? 0 : this.events.length };
  }

  async listFromCursor(cursor: EventCursor, query: EventQuery = {}): Promise<EventBatch> {
    const start = Math.max(0, Math.min(cursor.position, this.events.length));
    return {
      events: this.filterEvents(this.events.slice(start), query),
      cursor: { position: this.events.length }
    };
  }

  async list(query: EventQuery = {}): Promise<RoomEvent[]> {
    return this.filterEvents([...this.events], query);
  }

  private filterEvents(events: RoomEvent[], query: EventQuery): RoomEvent[] {
    let result = events;
    if (query.roomId) result = result.filter((event) => event.roomId === query.roomId);
    if (query.type) result = result.filter((event) => event.type === query.type);
    if (query.since) result = result.filter((event) => event.createdAt >= query.since!);
    if (query.limit !== undefined) result = result.slice(-query.limit);
    return result;
  }
}
