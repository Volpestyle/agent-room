import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe('agentroom daemon app', () => {
  it('posts and filters room messages', async () => {
    const app = createApp(await appOptions());

    const channelResponse = await app.request('/v1/messages', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        channelId: 'implementation',
        sender: { kind: 'agent', id: 'impl' },
        body: 'Starting work'
      })
    });
    expect(channelResponse.status).toBe(201);

    const dmResponse = await app.request('/v1/messages', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        channelId: 'dm',
        sender: { kind: 'agent', id: 'impl' },
        recipients: [{ kind: 'agent', id: 'reviewer' }],
        body: 'Ready for review'
      })
    });
    expect(dmResponse.status).toBe(201);

    const messagesResponse = await app.request('/v1/messages?participant=reviewer');
    const { messages } = (await messagesResponse.json()) as {
      messages: Array<{ body: string }>;
    };
    expect(messages).toEqual([expect.objectContaining({ body: 'Ready for review' })]);
  });

  it('creates, claims, updates, and lists tasks', async () => {
    const app = createApp(await appOptions());

    const createResponse = await app.request('/v1/tasks', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        title: 'Ship MVP',
        assigneeId: 'impl',
        refs: [{ kind: 'linear-issue', id: 'ENG-123', label: 'ENG-123' }]
      })
    });
    expect(createResponse.status).toBe(201);
    const { task } = (await createResponse.json()) as {
      task: { id: string; status: string };
    };

    const claimResponse = await app.request(`/v1/tasks/${task.id}/claim`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ assignee: { kind: 'agent', id: 'impl' } })
    });
    expect(claimResponse.status).toBe(200);

    const statusResponse = await app.request(`/v1/tasks/${task.id}/status`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({
        status: 'done',
        actor: { kind: 'agent', id: 'impl' },
        summary: 'Done'
      })
    });
    expect(statusResponse.status).toBe(200);

    const listResponse = await app.request('/v1/tasks');
    const { tasks } = (await listResponse.json()) as {
      tasks: Array<{ id: string; status: string; assignee?: { id: string } }>;
    };
    expect(tasks).toEqual([
      expect.objectContaining({
        id: task.id,
        status: 'done',
        assignee: { kind: 'agent', id: 'impl' },
        refs: [{ kind: 'linear-issue', id: 'ENG-123', label: 'ENG-123' }]
      })
    ]);
  });

  it('launches a fake runtime agent and audits input and output events', async () => {
    const app = createApp(await appOptions());

    const launchResponse = await app.request('/v1/runtime/fake-local/agents', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        agentId: 'demo',
        role: 'implementer',
        harness: { kind: 'shell', command: 'bash' }
      })
    });
    expect(launchResponse.status).toBe(201);

    const inputResponse = await app.request('/v1/runtime/fake-local/agents/demo/input', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ text: 'echo hello' })
    });
    expect(inputResponse.status).toBe(200);

    const outputResponse = await app.request('/v1/runtime/fake-local/agents/demo/output?lines=20');
    expect(outputResponse.status).toBe(200);
    await outputResponse.json();

    const eventsResponse = await app.request('/v1/events?limit=20');
    const { events } = (await eventsResponse.json()) as {
      events: Array<{ type: string }>;
    };
    expect(events.map((event) => event.type)).toEqual(['agent.joined', 'runtime.bound', 'runtime.input_sent', 'runtime.output_observed']);
  });
});

async function appOptions() {
  const dir = await mkdtemp(join(tmpdir(), 'agentroom-test-'));
  tempDirs.push(dir);
  return {
    roomId: 'test-room',
    eventLogPath: join(dir, 'events.jsonl'),
    cwd: dir
  };
}

function jsonHeaders(): HeadersInit {
  return { 'content-type': 'application/json' };
}
