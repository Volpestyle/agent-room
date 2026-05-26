import {
  filterRoomEvents,
  type EventBatch,
  type EventCursor,
  type EventCursorPosition,
  type EventQuery,
  type EventStore,
  type RoomEvent,
} from "@agentroom/core";

export class InMemoryEventStore implements EventStore {
  private readonly events: RoomEvent[] = [];

  async append(event: RoomEvent): Promise<void> {
    this.events.push(event);
  }

  async appendMany(events: RoomEvent[]): Promise<void> {
    this.events.push(...events);
  }

  async cursor(position: EventCursorPosition = "end"): Promise<EventCursor> {
    return { position: position === "start" ? 0 : this.events.length };
  }

  async listFromCursor(
    cursor: EventCursor,
    query: EventQuery = {},
  ): Promise<EventBatch> {
    const start = Math.max(0, Math.min(cursor.position, this.events.length));
    return {
      events: filterRoomEvents(this.events.slice(start), query),
      cursor: { position: this.events.length },
    };
  }

  async list(query: EventQuery = {}): Promise<RoomEvent[]> {
    return filterRoomEvents(this.events, query);
  }
}
