import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { LinearWorkTrackerProvider } from './index.js';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe('LinearWorkTrackerProvider', () => {
  it('reports explicit tracker_update_skipped when no bridge command is configured', async () => {
    const provider = new LinearWorkTrackerProvider({ env: {} });

    await expect(provider.health()).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('tracker_update_skipped')
    });
    await expect(
      provider.comment('ENG-1', 'Implemented and tested', { kind: 'agent', id: 'impl' })
    ).rejects.toThrow('tracker_update_skipped');
  });

  it('delegates create, status, and comments to a configured bridge command', async () => {
    const bridge = await writeBridge();
    const provider = new LinearWorkTrackerProvider({
      command: process.execPath,
      commandArgs: [bridge],
      env: {}
    });

    await expect(provider.health()).resolves.toMatchObject({ ok: true });

    const issue = await provider.createIssue({
      id: 'task-1',
      roomId: 'room',
      title: 'Implement tracker bridge',
      status: 'planned',
      createdBy: { kind: 'human', id: 'local' },
      createdAt: '2026-05-24T00:00:00.000Z',
      updatedAt: '2026-05-24T00:00:00.000Z'
    });

    expect(issue).toMatchObject({
      id: 'ENG-123',
      title: 'Implement tracker bridge',
      status: 'planned',
      url: 'https://linear.app/example/issue/ENG-123'
    });

    await expect(provider.updateIssueStatus('ENG-123', 'working')).resolves.toBeUndefined();
    await expect(provider.comment('ENG-123', 'Started implementation')).resolves.toBeUndefined();
  });
});

async function writeBridge(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentroom-linear-'));
  tempDirs.push(dir);
  const bridge = join(dir, 'linear-bridge.mjs');
  await writeFile(
    bridge,
    `
const action = process.argv[2];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  const payload = input.trim() ? JSON.parse(input) : {};
  if (action === 'health') {
    console.log(JSON.stringify({ ok: true }));
    return;
  }
  if (action === 'create-issue') {
    console.log(JSON.stringify({
      id: 'ENG-123',
      title: payload.task.title,
      status: payload.task.status,
      url: 'https://linear.app/example/issue/ENG-123'
    }));
    return;
  }
  if (action === 'update-status' || action === 'comment') {
    console.log(JSON.stringify({ ok: true }));
    return;
  }
  throw new Error('unknown action ' + action);
});
`,
    'utf8'
  );
  return bridge;
}
