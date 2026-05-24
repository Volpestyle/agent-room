import { Hono } from 'hono';
import { AgentRoomService, messageCreateSchema, taskCreateSchema } from '@agentroom/core';
import { JsonlEventStore } from '@agentroom/storage-jsonl';
import { ProviderRegistry } from './providerRegistry.js';

export interface CreateAppOptions {
  roomId?: string;
  eventLogPath?: string;
}

export function createApp(options: CreateAppOptions = {}) {
  const roomId = options.roomId ?? process.env.AGENTROOM_ROOM_ID ?? 'default';
  const eventLogPath = options.eventLogPath ?? process.env.AGENTROOM_EVENT_LOG ?? '.agentroom/events.jsonl';
  const store = new JsonlEventStore(eventLogPath);
  const service = new AgentRoomService(store, { roomId });
  const registry = new ProviderRegistry();

  const app = new Hono();

  app.get('/health', async (c) => {
    const runtimes = await Promise.all(
      registry.listRuntimes().map(async (provider) => ({
        id: provider.id,
        kind: provider.kind,
        capabilities: provider.capabilities,
        health: await provider.health()
      }))
    );

    return c.json({ ok: true, roomId, runtimes });
  });

  app.get('/v1/events', async (c) => {
    const limit = Number(c.req.query('limit') ?? '100');
    const events = await store.list({ roomId, limit });
    return c.json({ events });
  });

  app.post('/v1/messages', async (c) => {
    const body = await c.req.json();
    const input = messageCreateSchema.parse(body);
    const message = await service.postMessage({
      body: input.body,
      channelId: input.channelId,
      sender: input.sender,
      kind: input.kind,
      importance: input.importance,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {})
    });
    return c.json({ message }, 201);
  });

  app.post('/v1/tasks', async (c) => {
    const body = await c.req.json();
    const input = taskCreateSchema.parse(body);
    const task = await service.createTask({
      title: input.title,
      createdBy: input.createdBy,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.assigneeId !== undefined ? { assignee: { kind: 'agent' as const, id: input.assigneeId } } : {})
    });
    return c.json({ task }, 201);
  });

  app.get('/v1/runtime/providers', (c) => {
    return c.json({
      providers: registry.listRuntimes().map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        capabilities: provider.capabilities
      }))
    });
  });

  app.get('/v1/runtime/:providerId/agents', async (c) => {
    const provider = registry.runtime(c.req.param('providerId'));
    return c.json({ agents: await provider.listAgents() });
  });

  app.get('/v1/runtime/:providerId/agents/:agentId/output', async (c) => {
    const provider = registry.runtime(c.req.param('providerId'));
    const lines = Number(c.req.query('lines') ?? '80');
    const output = await provider.readAgent({ agentId: c.req.param('agentId'), lines });
    return c.json({ output });
  });

  app.post('/v1/runtime/:providerId/agents/:agentId/input', async (c) => {
    const provider = registry.runtime(c.req.param('providerId'));
    const body = (await c.req.json()) as { text?: string; submit?: boolean };
    if (!body.text) return c.json({ error: 'text is required' }, 400);
    await provider.sendInput({
      agentId: c.req.param('agentId'),
      text: body.text,
      ...(body.submit !== undefined ? { submit: body.submit } : {})
    });
    return c.json({ ok: true });
  });

  return app;
}
