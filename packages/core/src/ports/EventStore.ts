import type { Id } from '../domain.js';
import type { RoomEvent, RoomEventType } from '../events.js';

export interface EventQuery {
  roomId?: Id;
  type?: RoomEventType;
  since?: string;
  limit?: number;
}

export type EventCursorPosition = 'start' | 'end';

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
