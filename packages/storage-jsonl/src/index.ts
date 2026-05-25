import { mkdir, readFile, appendFile, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EventBatch, EventCursor, EventCursorPosition, EventQuery, EventStore, RoomEvent } from '@agentroom/core';

export class JsonlEventStore implements EventStore {
  constructor(private readonly path: string) {}

  async append(event: RoomEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async appendMany(events: RoomEvent[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
  }

  async cursor(position: EventCursorPosition = 'end'): Promise<EventCursor> {
    if (position === 'start') return { position: 0 };

    try {
      const stats = await stat(this.path);
      return { position: stats.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { position: 0 };
      throw error;
    }
  }

  async listFromCursor(cursor: EventCursor, query: EventQuery = {}): Promise<EventBatch> {
    let start = cursor.position;
    let text = '';

    try {
      const handle = await open(this.path, 'r');
      try {
        const stats = await handle.stat();
        if (start > stats.size) start = stats.size;
        const length = stats.size - start;

        if (length > 0) {
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, start);
          const chunk = buffer.subarray(0, bytesRead);
          const lastNewline = chunk.lastIndexOf(0x0a);

          if (lastNewline >= 0) {
            text = chunk.subarray(0, lastNewline + 1).toString('utf8');
            start += lastNewline + 1;
          }
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], cursor: { position: 0 } };
      throw error;
    }

    return {
      events: this.filterEvents(parseEvents(text), query),
      cursor: { position: start }
    };
  }

  async list(query: EventQuery = {}): Promise<RoomEvent[]> {
    let text = '';
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    return this.filterEvents(parseEvents(text), query);
  }

  private filterEvents(events: RoomEvent[], query: EventQuery): RoomEvent[] {
    if (query.roomId) events = events.filter((event) => event.roomId === query.roomId);
    if (query.type) events = events.filter((event) => event.type === query.type);
    if (query.since) events = events.filter((event) => event.createdAt >= query.since!);
    if (query.limit !== undefined) events = events.slice(-query.limit);
    return events;
  }
}

function parseEvents(text: string): RoomEvent[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RoomEvent);
}
