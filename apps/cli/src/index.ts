#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { AgentRoomService, type AgentRole, type HarnessSpec, type RuntimeProvider } from '@agentroom/core';
import { JsonlEventStore } from '@agentroom/storage-jsonl';
import { FakeRuntimeProvider } from '@agentroom/runtime-fake';
import { HerdrRuntimeProvider } from '@agentroom/runtime-herdr';
import { TmuxRuntimeProvider } from '@agentroom/runtime-tmux';

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 4317;

interface RoomConfig {
  roomId: string;
  roomName: string;
  createdAt: string;
}

const program = new Command();

program
  .name('agentroom')
  .description('Runtime-agnostic coordination plane for long-running coding agents')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize AgentRoom metadata in the current project')
  .option('--room <id>', 'room id', basename(process.cwd()))
  .option('--name <name>', 'human-readable room name')
  .action(async (options: { room: string; name?: string }) => {
    const dir = roomDir();
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeJson(join(dir, 'room.json'), {
      roomId: options.room,
      roomName: options.name ?? options.room,
      createdAt: new Date().toISOString()
    } satisfies RoomConfig);

    await writeFile(
      join(dir, 'policies.yaml'),
      `approvals:\n  required:\n    - action: github.merge_pr\n      approver: human\n    - action: deploy.production\n      approver: human\n`,
      'utf8'
    );

    await writeFile(
      join(dir, 'agents', 'lead.yaml'),
      `id: lead\nrole: lead\nharness:\n  kind: claude-code\n  command: claude\npermissions:\n  - room:read_all\n  - task:assign\n  - human:escalate\n`,
      'utf8'
    );

    console.log(`Initialized AgentRoom room '${options.room}' in ${dir}`);
  });

program
  .command('whoami')
  .description('Print the current AgentRoom enrollment environment')
  .option('--json', 'print JSON')
  .action((options: { json?: boolean }) => {
    const info = {
      enrolled: process.env.AGENTROOM === '1',
      agentId: process.env.AGENTROOM_AGENT_ID,
      roomId: process.env.AGENTROOM_ROOM_ID,
      role: process.env.AGENTROOM_ROLE,
      daemon: process.env.AGENTROOM_DAEMON ?? `http://127.0.0.1:${DEFAULT_PORT}`
    };
    output(info, options.json);
  });

program
  .command('post')
  .description('Post a message to the local room event log')
  .argument('<body>', 'message body')
  .option('-c, --channel <channel>', 'channel id', 'announcements')
  .option('-k, --kind <kind>', 'message kind', 'chat')
  .option('--json', 'print JSON')
  .action(async (body: string, options: { channel: string; kind: string; json?: boolean }) => {
    const service = await serviceForCwd();
    const message = await service.postMessage({
      body,
      channelId: options.channel,
      kind: options.kind as never,
      sender: currentActor()
    });
    output(message, options.json);
  });

const task = program.command('task').description('Task commands');

task
  .command('create')
  .description('Create a local task event')
  .argument('<title>', 'task title')
  .option('-d, --description <description>', 'task description')
  .option('-a, --assignee <agentId>', 'agent id')
  .option('--json', 'print JSON')
  .action(async (title: string, options: { description?: string; assignee?: string; json?: boolean }) => {
    const service = await serviceForCwd();
    const created = await service.createTask({
      title,
      createdBy: currentActor(),
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.assignee !== undefined ? { assignee: { kind: 'agent' as const, id: options.assignee } } : {})
    });
    output(created, options.json);
  });

program
  .command('ask-human')
  .description('Create a human escalation question')
  .argument('<question>', 'question for the human')
  .option('--task <taskId>', 'related task id')
  .option('-p, --priority <priority>', 'low|normal|high|urgent', 'normal')
  .option('--json', 'print JSON')
  .action(async (question: string, options: { task?: string; priority: string; json?: boolean }) => {
    const service = await serviceForCwd();
    const escalation = await service.askHuman({
      question,
      from: currentActor(),
      priority: options.priority as never,
      ...(options.task !== undefined ? { taskId: options.task } : {})
    });
    output(escalation, options.json);
  });

program
  .command('events')
  .description('Show recent local room events')
  .option('-n, --limit <number>', 'number of events', parseInteger, 20)
  .option('--json', 'print JSON')
  .action(async (options: { limit: number; json?: boolean }) => {
    const { store, config } = await storeForCwd();
    const events = await store.list({ roomId: config.roomId, limit: options.limit });
    output(events, options.json);
  });

program
  .command('doctor')
  .description('Check local prerequisites')
  .option('--json', 'print JSON')
  .action(async (options: { json?: boolean }) => {
    const checks = {
      node: process.version,
      agentroomDir: await exists(roomDir()),
      herdr: await commandAvailable('herdr'),
      tmux: await commandAvailable('tmux')
    };
    output(checks, options.json);
  });

const runtime = program.command('runtime').description('Runtime provider commands');

runtime
  .command('providers')
  .description('List built-in runtime providers')
  .option('--json', 'print JSON')
  .action((options: { json?: boolean }) => {
    output(
      [
        { id: 'fake-local', kind: 'fake' },
        { id: 'local-herdr', kind: 'herdr' },
        { id: 'local-tmux', kind: 'tmux' }
      ],
      options.json
    );
  });

runtime
  .command('fake-smoke')
  .description('Run a provider contract smoke test against the fake runtime')
  .option('--json', 'print JSON')
  .action(async (options: { json?: boolean }) => {
    const provider = new FakeRuntimeProvider();
    await provider.startAgent({
      agentId: 'demo',
      roomId: 'demo',
      role: 'implementer',
      harness: { kind: 'shell', command: 'bash' }
    });
    await provider.sendInput({ agentId: 'demo', text: 'echo hello' });
    const outputText = await provider.readAgent({ agentId: 'demo', lines: 10 });
    output(outputText, options.json);
  });

program
  .command('launch')
  .description('Launch an opted-in agent through a runtime provider')
  .argument('<agentId>', 'agent id')
  .option('--runtime <runtime>', 'fake|herdr|tmux', 'herdr')
  .option('--role <role>', 'agent role', 'implementer')
  .option('--harness <kind>', 'harness kind', 'claude-code')
  .option('--command <command>', 'command to run', 'claude')
  .option('--cwd <cwd>', 'working directory', process.cwd())
  .option('--json', 'print JSON')
  .action(async (agentId: string, options: { runtime: string; role: string; harness: string; command: string; cwd: string; json?: boolean }) => {
    const { config } = await storeForCwd();
    const provider = makeRuntimeProvider(options.runtime);
    const harness: HarnessSpec = {
      kind: options.harness as never,
      command: options.command,
      cwd: resolve(options.cwd)
    };
    const agent = await provider.startAgent({
      agentId,
      roomId: config.roomId,
      role: options.role as AgentRole,
      harness,
      cwd: resolve(options.cwd)
    });
    output(agent, options.json);
  });

program
  .command('read')
  .description('Read recent output from a runtime-backed agent')
  .argument('<agentId>', 'agent id')
  .option('--runtime <runtime>', 'fake|herdr|tmux', 'herdr')
  .option('--lines <number>', 'line count', parseInteger, 80)
  .option('--json', 'print JSON')
  .action(async (agentId: string, options: { runtime: string; lines: number; json?: boolean }) => {
    const provider = makeRuntimeProvider(options.runtime);
    const result = await provider.readAgent({ agentId, lines: options.lines });
    output(result, options.json);
  });

program
  .command('send')
  .description('Send input to a runtime-backed agent')
  .argument('<agentId>', 'agent id')
  .argument('<text>', 'text to send')
  .option('--runtime <runtime>', 'fake|herdr|tmux', 'herdr')
  .option('--no-submit', 'do not press Enter after input')
  .option('--json', 'print JSON')
  .action(async (agentId: string, text: string, options: { runtime: string; submit?: boolean; json?: boolean }) => {
    const provider = makeRuntimeProvider(options.runtime);
    await provider.sendInput({
      agentId,
      text,
      source: currentActor(),
      ...(options.submit !== undefined ? { submit: options.submit } : {})
    });
    output({ ok: true, agentId, text }, options.json);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function makeRuntimeProvider(kind: string): RuntimeProvider {
  switch (kind) {
    case 'fake':
      return new FakeRuntimeProvider();
    case 'tmux':
      return new TmuxRuntimeProvider();
    case 'herdr':
      return new HerdrRuntimeProvider({ ...(process.env.HERDR_SESSION ? { session: process.env.HERDR_SESSION } : {}) });
    default:
      throw new Error(`Unknown runtime provider: ${kind}`);
  }
}

async function serviceForCwd(): Promise<AgentRoomService> {
  const { store, config } = await storeForCwd();
  return new AgentRoomService(store, { roomId: config.roomId });
}

async function storeForCwd(): Promise<{ store: JsonlEventStore; config: RoomConfig }> {
  const config = await loadRoomConfig();
  return {
    config,
    store: new JsonlEventStore(join(roomDir(), 'events.jsonl'))
  };
}

async function loadRoomConfig(): Promise<RoomConfig> {
  const path = join(roomDir(), 'room.json');
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RoomConfig;
  } catch (error) {
    throw new Error(`No AgentRoom found. Run 'agentroom init' first. Missing ${path}`);
  }
}

function roomDir(): string {
  return join(process.cwd(), '.agentroom');
}

function currentActor() {
  if (process.env.AGENTROOM === '1' && process.env.AGENTROOM_AGENT_ID) {
    return { kind: 'agent' as const, id: process.env.AGENTROOM_AGENT_ID };
  }
  return { kind: 'human' as const, id: process.env.USER ?? 'local' };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function output(value: unknown, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (typeof value === 'string') {
    console.log(value);
    return;
  }

  console.log(JSON.stringify(value, null, 2));
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error(`Invalid integer: ${value}`);
  return parsed;
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? 'default';
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ['--version']);
    return true;
  } catch {
    try {
      await execFileAsync(command, ['-V']);
      return true;
    } catch {
      return false;
    }
  }
}
