import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EventQuery, EventStore, RoomEvent } from '@agentroom/core';

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

  async list(query: EventQuery = {}): Promise<RoomEvent[]> {
    let text = '';
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    let events = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RoomEvent);

    if (query.roomId) events = events.filter((event) => event.roomId === query.roomId);
    if (query.type) events = events.filter((event) => event.type === query.type);
    if (query.since) events = events.filter((event) => event.createdAt >= query.since!);
    if (query.limit !== undefined) events = events.slice(-query.limit);

    return events;
  }
}
