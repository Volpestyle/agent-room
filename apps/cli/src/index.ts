#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { AgentRoomService, type ActorRef, type AgentRole, type HarnessSpec, type Ref, type RuntimeBinding, type RuntimeProvider, type TaskStatus } from '@agentroom/core';
import {
  agentRoomConfigPath,
  builtInRuntimeConfig,
  createDefaultAgentRoomConfig,
  ensureRuntimeConfig,
  loadAgentRoomConfig,
  maybeLoadAgentRoomConfig,
  resolveStoragePath,
  runtimeNameFor,
  withDefaultRuntime,
  writeAgentRoomConfig,
  type AgentRoomConfig,
  type HerdrLayoutConfig,
  type RuntimeConfig
} from '@agentroom/config';
import { JsonlEventStore } from '@agentroom/storage-jsonl';
import { FakeRuntimeProvider } from '@agentroom/runtime-fake';
import { HerdrRuntimeProvider } from '@agentroom/runtime-herdr';
import { TmuxRuntimeProvider } from '@agentroom/runtime-tmux';
import { LinearWorkTrackerProvider } from '@agentroom/worktracker-linear';

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
  .option('--runtime <runtime>', 'default runtime provider: herdr|tmux|fake', 'herdr')
  .option('--runtime-session <name>', 'Herdr session name or tmux session prefix; defaults to room id')
  .action(async (options: { room: string; name?: string; runtime: string; runtimeSession?: string }) => {
    const dir = roomDir();
    await mkdir(join(dir, 'agents'), { recursive: true });
    const appConfig = createDefaultAgentRoomConfig({
      roomId: options.room,
      ...(options.name !== undefined ? { roomName: options.name } : {}),
      defaultRuntime: parseConfiguredRuntime(options.runtime),
      ...(options.runtimeSession !== undefined ? { runtimeSession: options.runtimeSession } : {})
    });

    await writeJson(join(dir, 'room.json'), {
      roomId: options.room,
      roomName: options.name ?? options.room,
      createdAt: new Date().toISOString()
    } satisfies RoomConfig);
    await writeAgentRoomConfig(process.cwd(), appConfig);

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
    console.log(`Default runtime: ${appConfig.runtime.default}`);
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
  .option('-t, --to <agentIds>', 'comma-separated agent recipients for a directed message')
  .option('-k, --kind <kind>', 'message kind', 'chat')
  .option('--json', 'print JSON')
  .action(async (body: string, options: { channel: string; to?: string; kind: string; json?: boolean }) => {
    const service = await serviceForCwd();
    const message = await service.postMessage({
      body,
      channelId: options.channel,
      kind: options.kind as never,
      sender: currentActor(),
      ...(options.to !== undefined ? { recipients: parseAgentRecipients(options.to) } : {})
    });
    output(message, options.json);
  });

program
  .command('dm')
  .description('Send a direct room message to one or more agents')
  .argument('<agentIds>', 'comma-separated agent ids')
  .argument('<body>', 'message body')
  .option('--thread <threadId>', 'thread id')
  .option('--json', 'print JSON')
  .action(async (agentIds: string, body: string, options: { thread?: string; json?: boolean }) => {
    const service = await serviceForCwd();
    const message = await service.postMessage({
      body,
      channelId: 'dm',
      sender: currentActor(),
      recipients: parseAgentRecipients(agentIds),
      ...(options.thread !== undefined ? { threadId: options.thread } : {})
    });
    output(message, options.json);
  });

program
  .command('messages')
  .description('Show recent room messages')
  .option('-c, --channel <channel>', 'channel id')
  .option('--thread <threadId>', 'thread id')
  .option('--with <agentId>', 'messages sent to or from an agent')
  .option('-n, --limit <number>', 'number of messages', parseInteger, 20)
  .option('--json', 'print JSON')
  .action(async (options: { channel?: string; thread?: string; with?: string; limit: number; json?: boolean }) => {
    const service = await serviceForCwd();
    const messages = await service.listMessages({
      limit: options.limit,
      ...(options.channel !== undefined ? { channelId: options.channel } : {}),
      ...(options.thread !== undefined ? { threadId: options.thread } : {}),
      ...(options.with !== undefined ? { participant: { kind: 'agent', id: options.with } } : {})
    });
    output(messages, options.json);
  });

const task = program.command('task').description('Task commands');

task
  .command('create')
  .description('Create a local task shadow, optionally linked to a Linear issue')
  .argument('<title>', 'task title')
  .option('-d, --description <description>', 'task description')
  .option('-a, --assignee <agentId>', 'agent id')
  .option('--linear <issueId>', 'existing Linear issue id or key to use as the tracker source')
  .option('--linear-url <url>', 'Linear issue URL')
  .option('--json', 'print JSON')
  .action(async (title: string, options: { description?: string; assignee?: string; linear?: string; linearUrl?: string; json?: boolean }) => {
    const service = await serviceForCwd();
    const refs = options.linear ? [linearRef(options.linear, options.linearUrl)] : [];
    const created = await service.createTask({
      title,
      createdBy: currentActor(),
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.assignee !== undefined ? { assignee: { kind: 'agent' as const, id: options.assignee } } : {}),
      ...(refs.length > 0 ? { refs } : {})
    });
    output(created, options.json);
  });

task
  .command('list')
  .description('List local task shadows')
  .option('--json', 'print JSON')
  .action(async (options: { json?: boolean }) => {
    const service = await serviceForCwd();
    const tasks = await service.listTasks();
    output(tasks, options.json);
  });

task
  .command('link-linear')
  .description('Link a local task shadow to the canonical Linear issue')
  .argument('<taskId>', 'local task id')
  .argument('<issueId>', 'Linear issue id or key')
  .option('--url <url>', 'Linear issue URL')
  .option('--json', 'print JSON')
  .action(async (taskId: string, issueId: string, options: { url?: string; json?: boolean }) => {
    const service = await serviceForCwd();
    const task = await service.linkTaskRef({
      taskId,
      ref: linearRef(issueId, options.url)
    });
    output(task, options.json);
  });

task
  .command('comment')
  .description('Comment on the Linear issue linked to a local task')
  .argument('<taskId>', 'local task id')
  .argument('<body>', 'comment body')
  .option('--json', 'print JSON')
  .action(async (taskId: string, body: string, options: { json?: boolean }) => {
    const service = await serviceForCwd();
    const task = await service.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const issueId = linearIssueIdForTask(task);
    if (!issueId) throw new Error(`Task has no Linear issue ref: ${taskId}`);
    const result = await commentOnLinearIssue(issueId, body, taskId, service);
    output(result, options.json);
  });

task
  .command('claim')
  .description('Claim a local task shadow')
  .argument('<taskId>', 'task id')
  .option('-a, --assignee <agentId>', 'agent id; defaults to current enrolled agent or local user')
  .option('--json', 'print JSON')
  .action(async (taskId: string, options: { assignee?: string; json?: boolean }) => {
    const service = await serviceForCwd();
    const assignee = options.assignee ? { kind: 'agent' as const, id: options.assignee } : currentActor();
    const claimed = await service.claimTask({
      taskId,
      assignee
    });
    output(claimed, options.json);
  });

task
  .command('status')
  .description('Set a local task-shadow status')
  .argument('<taskId>', 'task id')
  .argument('<status>', 'task status')
  .option('-r, --reason <reason>', 'reason for the status change')
  .option('-s, --summary <summary>', 'completion or review summary')
  .option('--json', 'print JSON')
  .action(async (taskId: string, status: string, options: { reason?: string; summary?: string; json?: boolean }) => {
    const service = await serviceForCwd();
    const updated = await service.updateTaskStatus({
      taskId,
      status: parseTaskStatus(status),
      actor: currentActor(),
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      ...(options.summary !== undefined ? { summary: options.summary } : {})
    });
    output(updated, options.json);
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
  .command('block')
  .description('Mark a local task shadow blocked and record the reason')
  .argument('<taskId>', 'task id')
  .requiredOption('-r, --reason <reason>', 'blocker reason')
  .option('--json', 'print JSON')
  .action(async (taskId: string, options: { reason: string; json?: boolean }) => {
    const service = await serviceForCwd();
    const blocked = await service.blockTask({
      taskId,
      reason: options.reason,
      actor: currentActor()
    });
    output(blocked, options.json);
  });

program
  .command('done')
  .description('Mark a local task shadow done')
  .argument('<taskId>', 'task id')
  .option('-s, --summary <summary>', 'completion summary')
  .option('--json', 'print JSON')
  .action(async (taskId: string, options: { summary?: string; json?: boolean }) => {
    const service = await serviceForCwd();
    const done = await service.completeTask({
      taskId,
      actor: currentActor(),
      ...(options.summary !== undefined ? { summary: options.summary } : {})
    });
    output(done, options.json);
  });

const tracker = program.command('tracker').description('External work tracker commands');

tracker
  .command('health')
  .description('Check the configured Linear bridge command for MCP/CLI/skill delegation')
  .option('--json', 'print JSON')
  .action(async (options: { json?: boolean }) => {
    const provider = new LinearWorkTrackerProvider();
    output(await provider.health(), options.json);
  });

tracker
  .command('comment')
  .description('Comment on a Linear issue through the configured bridge')
  .argument('<issueId>', 'Linear issue id or key')
  .argument('<body>', 'comment body')
  .option('--json', 'print JSON')
  .action(async (issueId: string, body: string, options: { json?: boolean }) => {
    const service = await maybeServiceForCwd();
    const result = await commentOnLinearIssue(issueId, body, undefined, service);
    output(result, options.json);
  });

tracker
  .command('status')
  .description('Update a Linear issue status through the configured bridge')
  .argument('<issueId>', 'Linear issue id or key')
  .argument('<status>', 'tracker status name')
  .option('--json', 'print JSON')
  .action(async (issueId: string, status: string, options: { json?: boolean }) => {
    const service = await maybeServiceForCwd();
    const result = await updateLinearIssueStatus(issueId, status, service);
    output(result, options.json);
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
    const config = await maybeLoadAgentRoomConfig();
    const checks = {
      node: process.version,
      agentroomDir: await exists(roomDir()),
      config: config ? agentRoomConfigPath() : undefined,
      defaultRuntime: config?.runtime.default,
      herdr: await commandAvailable('herdr'),
      tmux: await commandAvailable('tmux')
    };
    output(checks, options.json);
  });

const runtime = program.command('runtime').description('Runtime provider commands');

runtime
  .command('providers')
  .description('List configured runtime providers')
  .option('--json', 'print JSON')
  .action(async (options: { json?: boolean }) => {
    const config = await maybeLoadAgentRoomConfig();
    if (config) {
      output(
        Object.entries(config.runtimes).map(([id, runtime]) => ({
          id,
          kind: runtime.type,
          default: id === config.runtime.default
        })),
        options.json
      );
      return;
    }

    output(
      [
        { id: 'fake', kind: 'fake', default: false },
        { id: 'herdr', kind: 'herdr', default: true },
        { id: 'tmux', kind: 'tmux', default: false }
      ],
      options.json
    );
  });

runtime
  .command('use')
  .description('Set the default runtime provider in .agentroom/config.yaml')
  .argument('<runtime>', 'configured runtime name, or built-in herdr|tmux|fake')
  .option('--json', 'print JSON')
  .action(async (runtimeName: string, options: { json?: boolean }) => {
    const config = await loadAgentRoomConfigForCwd();
    const updated = withDefaultRuntime(config, runtimeName);
    await writeAgentRoomConfig(process.cwd(), updated);
    output({ ok: true, defaultRuntime: updated.runtime.default, config: agentRoomConfigPath() }, options.json);
  });

runtime
  .command('doctor')
  .description('Check the selected runtime provider')
  .option('--runtime <runtime>', 'runtime provider to check; defaults to configured runtime')
  .option('--json', 'print JSON')
  .action(async (options: { runtime?: string; json?: boolean }) => {
    const selected = await runtimeProviderForCwd(options.runtime);
    output(
      {
        runtime: selected.name,
        kind: selected.provider.kind,
        config: selected.config ? agentRoomConfigPath() : undefined,
        health: await selected.provider.health()
      },
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
  .option('--runtime <runtime>', 'runtime provider; defaults to .agentroom/config.yaml')
  .option('--placement <placement>', 'Herdr placement: workspace|tab|pane')
  .option('--workspace <label>', 'Herdr workspace label for tab/pane placement')
  .option('--panes-per-tab <number>', 'max panes per Herdr tab for pane placement', parseInteger)
  .option('--split <strategy>', 'Herdr pane split strategy: largest|focused')
  .option('--role <role>', 'agent role', 'implementer')
  .option('--harness <kind>', 'harness kind', 'claude-code')
  .option('--command <command>', 'command to run', 'claude')
  .option('--cwd <cwd>', 'working directory', process.cwd())
  .option('--json', 'print JSON')
  .action(async (agentId: string, options: { runtime?: string; placement?: string; workspace?: string; panesPerTab?: number; split?: string; role: string; harness: string; command: string; cwd: string; json?: boolean }) => {
    const { store, config } = await storeForCwd();
    const service = new AgentRoomService(store, { roomId: config.roomId });
    const { provider } = await runtimeProviderForCwd(
      options.runtime,
      herdrLayoutOverride({
        ...(options.placement !== undefined ? { placement: options.placement } : {}),
        ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
        ...(options.panesPerTab !== undefined ? { panesPerTab: options.panesPerTab } : {}),
        ...(options.split !== undefined ? { split: options.split } : {})
      })
    );
    const harness: HarnessSpec = {
      kind: options.harness as never,
      command: options.command,
      cwd: resolve(options.cwd)
    };
    await service.registerAgent({
      id: agentId,
      role: options.role as AgentRole,
      harness
    });
    const agent = await provider.startAgent({
      agentId,
      roomId: config.roomId,
      role: options.role as AgentRole,
      harness,
      cwd: resolve(options.cwd)
    });
    await service.bindRuntime({
      agentId,
      runtime: bindingFor(provider, agent.bindingId, agent.metadata)
    });
    output(agent, options.json);
  });

program
  .command('read')
  .description('Read recent output from a runtime-backed agent')
  .argument('<agentId>', 'agent id')
  .option('--runtime <runtime>', 'runtime provider; defaults to .agentroom/config.yaml')
  .option('--lines <number>', 'line count', parseInteger, 80)
  .option('--json', 'print JSON')
  .action(async (agentId: string, options: { runtime?: string; lines: number; json?: boolean }) => {
    const service = await maybeServiceForCwd();
    const binding = await service?.getRuntimeBinding(agentId);
    const { provider } = await runtimeProviderForCwd(options.runtime ?? binding?.providerId);
    const bindingId = bindingIdFor(provider, binding);
    const result = await provider.readAgent({
      agentId,
      ...(bindingId !== undefined ? { bindingId } : {}),
      lines: options.lines
    });
    await service?.recordRuntimeOutput({
      agentId,
      text: result.text,
      ...(result.lineCount !== undefined ? { lineCount: result.lineCount } : {})
    });
    output(result, options.json);
  });

program
  .command('send')
  .description('Send input to a runtime-backed agent')
  .argument('<agentId>', 'agent id')
  .argument('<text>', 'text to send')
  .option('--runtime <runtime>', 'runtime provider; defaults to .agentroom/config.yaml')
  .option('--no-submit', 'do not press Enter after input')
  .option('--json', 'print JSON')
  .action(async (agentId: string, text: string, options: { runtime?: string; submit?: boolean; json?: boolean }) => {
    const service = await maybeServiceForCwd();
    const binding = await service?.getRuntimeBinding(agentId);
    const { provider } = await runtimeProviderForCwd(options.runtime ?? binding?.providerId);
    const bindingId = bindingIdFor(provider, binding);
    const source = currentActor();
    await provider.sendInput({
      agentId,
      ...(bindingId !== undefined ? { bindingId } : {}),
      text,
      source,
      ...(options.submit !== undefined ? { submit: options.submit } : {})
    });
    await service?.recordRuntimeInput({
      agentId,
      text,
      source
    });
    output({ ok: true, agentId, text }, options.json);
  });

program
  .command('stop')
  .description('Stop a runtime-backed agent')
  .argument('<agentId>', 'agent id')
  .option('--runtime <runtime>', 'runtime provider; defaults to bound runtime or .agentroom/config.yaml')
  .option('--json', 'print JSON')
  .action(async (agentId: string, options: { runtime?: string; json?: boolean }) => {
    const service = await maybeServiceForCwd();
    const binding = await service?.getRuntimeBinding(agentId);
    const { provider } = await runtimeProviderForCwd(options.runtime ?? binding?.providerId);
    const target =
      provider.kind === 'herdr' && binding?.providerId === provider.id
        ? binding.bindingId
        : agentId;
    await provider.stopAgent(target);
    output({ ok: true, agentId, runtime: provider.id }, options.json);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function runtimeProviderForCwd(
  runtimeName?: string,
  herdrLayout?: HerdrLayoutConfig
): Promise<{ name: string; provider: RuntimeProvider; config?: AgentRoomConfig }> {
  const config = await maybeLoadAgentRoomConfig();
  const name = config ? runtimeNameFor(config, runtimeName) : runtimeName ?? 'herdr';
  const runtime = config ? ensureRuntimeConfig(config, name) : builtInRuntimeConfig(name);
  return {
    name,
    provider: makeRuntimeProvider(name, runtime, herdrLayout),
    ...(config !== undefined ? { config } : {})
  };
}

function makeRuntimeProvider(
  name: string,
  runtime: RuntimeConfig,
  herdrLayout?: HerdrLayoutConfig
): RuntimeProvider {
  switch (runtime.type) {
    case 'fake':
      if (herdrLayout !== undefined) throw new Error('Herdr layout options require a Herdr runtime');
      return new FakeRuntimeProvider({ id: name });
    case 'tmux':
      if (herdrLayout !== undefined) throw new Error('Herdr layout options require a Herdr runtime');
      return new TmuxRuntimeProvider({
        id: name,
        ...(runtime.cli !== undefined ? { cli: runtime.cli } : {}),
        ...(runtime.sessionPrefix !== undefined ? { sessionPrefix: runtime.sessionPrefix } : {})
      });
    case 'herdr': {
      const session = process.env.HERDR_SESSION ?? runtime.session;
      const layout = herdrLayout
        ? { ...(runtime.layout ?? {}), ...herdrLayout }
        : runtime.layout;
      return new HerdrRuntimeProvider({
        id: name,
        ...(runtime.cli !== undefined ? { cli: runtime.cli } : {}),
        ...(session !== undefined ? { session } : {}),
        ...(layout !== undefined ? { layout } : {})
      });
    }
  }
}

async function serviceForCwd(): Promise<AgentRoomService> {
  const { store, config } = await storeForCwd();
  return new AgentRoomService(store, { roomId: config.roomId });
}

async function maybeServiceForCwd(): Promise<AgentRoomService | undefined> {
  try {
    return await serviceForCwd();
  } catch {
    return undefined;
  }
}

async function storeForCwd(): Promise<{ store: JsonlEventStore; config: RoomConfig; appConfig?: AgentRoomConfig }> {
  const project = await loadProjectConfig();
  return {
    config: project.room,
    store: new JsonlEventStore(project.eventLogPath),
    ...(project.appConfig !== undefined ? { appConfig: project.appConfig } : {})
  };
}

async function loadProjectConfig(): Promise<{ room: RoomConfig; eventLogPath: string; appConfig?: AgentRoomConfig }> {
  const appConfig = await maybeLoadAgentRoomConfig();
  if (appConfig) {
    return {
      room: {
        roomId: appConfig.room.id,
        roomName: appConfig.room.name ?? appConfig.room.id,
        createdAt: ''
      },
      eventLogPath: resolveStoragePath(appConfig),
      appConfig
    };
  }

  const path = join(roomDir(), 'room.json');
  try {
    return {
      room: JSON.parse(await readFile(path, 'utf8')) as RoomConfig,
      eventLogPath: join(roomDir(), 'events.jsonl')
    };
  } catch (error) {
    throw new Error(`No AgentRoom found. Run 'agent-room init' first. Missing ${path}`);
  }
}

async function loadAgentRoomConfigForCwd(): Promise<AgentRoomConfig> {
  try {
    return await loadAgentRoomConfig();
  } catch (error) {
    throw new Error(`No AgentRoom config found. Run 'agent-room init' first. Missing ${agentRoomConfigPath()}`);
  }
}

function roomDir(): string {
  return join(process.cwd(), '.agentroom');
}

function currentActor(): ActorRef {
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

function parseTaskStatus(value: string): TaskStatus {
  const statuses: TaskStatus[] = [
    'planned',
    'assigned',
    'claimed',
    'working',
    'blocked',
    'ready-for-review',
    'changes-requested',
    'approved',
    'merged',
    'done',
    'canceled'
  ];
  if (!statuses.includes(value as TaskStatus)) throw new Error(`Invalid task status: ${value}`);
  return value as TaskStatus;
}

function parseAgentRecipients(value: string): ActorRef[] {
  const recipients = value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => ({ kind: 'agent' as const, id }));
  if (recipients.length === 0) throw new Error('At least one recipient agent id is required');
  return recipients;
}

function linearRef(issueId: string, url?: string): Ref {
  return {
    kind: 'linear-issue',
    id: issueId,
    label: issueId,
    ...(url !== undefined ? { url } : {})
  };
}

function linearIssueIdForTask(task: { refs?: Ref[] }): string | undefined {
  return task.refs?.find((ref) => ref.kind === 'linear-issue')?.id;
}

function herdrLayoutOverride(input: {
  placement?: string;
  workspace?: string;
  panesPerTab?: number;
  split?: string;
}): HerdrLayoutConfig | undefined {
  const mode = input.placement !== undefined ? parseHerdrPlacement(input.placement) : undefined;
  const split = input.split !== undefined ? parseHerdrSplit(input.split) : undefined;
  if (input.panesPerTab !== undefined && input.panesPerTab < 1) {
    throw new Error('--panes-per-tab must be at least 1');
  }

  if (
    mode === undefined &&
    input.workspace === undefined &&
    input.panesPerTab === undefined &&
    split === undefined
  ) {
    return undefined;
  }

  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
    ...(input.panesPerTab !== undefined ? { panesPerTab: input.panesPerTab } : {}),
    ...(split !== undefined ? { split } : {})
  };
}

function parseHerdrPlacement(value: string): HerdrLayoutConfig['mode'] {
  switch (value) {
    case 'workspace':
    case 'workspace-per-agent':
      return 'workspace-per-agent';
    case 'tab':
    case 'tab-per-agent':
      return 'tab-per-agent';
    case 'pane':
    case 'pane-grid':
      return 'pane-grid';
    default:
      throw new Error(`Invalid Herdr placement '${value}'. Expected workspace, tab, or pane.`);
  }
}

function parseHerdrSplit(value: string): NonNullable<HerdrLayoutConfig['split']> {
  if (value === 'largest' || value === 'focused') return value;
  throw new Error(`Invalid Herdr split strategy '${value}'. Expected largest or focused.`);
}

function bindingIdFor(provider: RuntimeProvider, binding?: RuntimeBinding): string | undefined {
  return binding?.providerId === provider.id ? binding.bindingId : undefined;
}

async function commentOnLinearIssue(
  issueId: string,
  body: string,
  taskId: string | undefined,
  service: AgentRoomService | undefined
): Promise<{ ok: boolean; issueId: string; action: string; code?: string; reason?: string }> {
  const provider = new LinearWorkTrackerProvider();
  try {
    await provider.comment(issueId, body, currentActor());
    await service?.recordLinearIssueEvent({
      issueId,
      action: 'commented',
      body,
      ...(taskId !== undefined ? { taskId } : {})
    });
    return { ok: true, issueId, action: 'commented' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await service?.recordLinearIssueEvent({
      issueId,
      action: 'tracker_update_skipped',
      body,
      reason,
      ...(taskId !== undefined ? { taskId } : {})
    });
    return { ok: false, issueId, action: 'commented', code: 'tracker_update_skipped', reason };
  }
}

async function updateLinearIssueStatus(
  issueId: string,
  status: string,
  service: AgentRoomService | undefined
): Promise<{ ok: boolean; issueId: string; action: string; code?: string; reason?: string }> {
  const provider = new LinearWorkTrackerProvider();
  try {
    await provider.updateIssueStatus(issueId, status);
    await service?.recordLinearIssueEvent({
      issueId,
      action: 'status_updated',
      status
    });
    return { ok: true, issueId, action: 'status_updated' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await service?.recordLinearIssueEvent({
      issueId,
      action: 'tracker_update_skipped',
      status,
      reason
    });
    return { ok: false, issueId, action: 'status_updated', code: 'tracker_update_skipped', reason };
  }
}

function bindingFor(
  provider: RuntimeProvider,
  bindingId: string,
  metadata?: Record<string, unknown>
): RuntimeBinding {
  return {
    providerId: provider.id,
    bindingId,
    kind: provider.kind === 'tmux' || provider.kind === 'herdr' ? 'pane' : 'process',
    ...(metadata !== undefined ? { metadata } : {})
  };
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? 'default';
}

function parseConfiguredRuntime(value: string): 'fake' | 'herdr' | 'tmux' {
  if (value === 'fake' || value === 'herdr' || value === 'tmux') return value;
  throw new Error(`Invalid runtime '${value}'. Expected fake, herdr, or tmux.`);
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
