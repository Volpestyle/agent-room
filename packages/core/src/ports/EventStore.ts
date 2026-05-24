import type { Id } from '../domain.js';
import type { RoomEvent, RoomEventType } from '../events.js';

export interface EventQuery {
  roomId?: Id;
  type?: RoomEventType;
  since?: string;
  limit?: number;
}

export interface EventStore {
  append(event: RoomEvent): Promise<void>;
  appendMany(events: RoomEvent[]): Promise<void>;
  list(query?: EventQuery): Promise<RoomEvent[]>;
}
