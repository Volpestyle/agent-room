import type { Id } from "../domain.js";
import type { RoomEvent, RoomEventType } from "../events.js";

export interface EventQuery {
  roomId?: Id;
  type?: RoomEventType;
  since?: string;
  limit?: number;
}

export type EventCursorPosition = "start" | "end";

export interface EventCursor {
  position: number;
}

export interface EventBatch {
  events: RoomEvent[];
  cursor: EventCursor;
}

export interface EventStore {
  append(event: RoomEvent): Promise<void>;
  appendMany(events: RoomEvent[]): Promise<void>;
  cursor(position?: EventCursorPosition): Promise<EventCursor>;
  listFromCursor(cursor: EventCursor, query?: EventQuery): Promise<EventBatch>;
  list(query?: EventQuery): Promise<RoomEvent[]>;
}

export function filterRoomEvents(
  events: readonly RoomEvent[],
  query: EventQuery = {},
): RoomEvent[] {
  let result = [...events];
  if (query.roomId) {
    result = result.filter((event) => event.roomId === query.roomId);
  }
  if (query.type) {
    result = result.filter((event) => event.type === query.type);
  }
  const since = query.since;
  if (since) {
    result = result.filter((event) => event.createdAt >= since);
  }
  if (query.limit !== undefined) {
    result = result.slice(-query.limit);
  }
  return result;
}
