import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RuntimeProviderKind } from '@agentroom/core';

export const AGENTROOM_DIR = '.agentroom';
export const AGENTROOM_CONFIG_FILE = 'config.yaml';
export const DEFAULT_EVENT_LOG_PATH = '.agentroom/events.jsonl';

export type ConfiguredRuntimeKind = Extract<RuntimeProviderKind, 'fake' | 'herdr' | 'tmux'>;

export interface AgentRoomConfig {
  room: {
    id: string;
    name?: string;
  };
  runtime: {
    default: string;
  };
  runtimes: Record<string, RuntimeConfig>;
  storage: {
    driver: 'jsonl';
    path: string;
  };
}

export type RuntimeConfig =
  | { type: 'fake' }
  | { type: 'herdr'; session?: string; cli?: string; layout?: HerdrLayoutConfig }
  | { type: 'tmux'; sessionPrefix?: string; cli?: string };

export type HerdrLayoutMode = 'workspace-per-agent' | 'tab-per-agent' | 'pane-grid';
export type HerdrSplitStrategy = 'largest' | 'focused';

export interface HerdrLayoutConfig {
  mode?: HerdrLayoutMode;
  workspace?: string;
  panesPerTab?: number;
  split?: HerdrSplitStrategy;
  balance?: boolean;
}

export interface CreateDefaultConfigOptions {
  roomId: string;
  roomName?: string;
  defaultRuntime?: ConfiguredRuntimeKind;
  runtimeSession?: string;
}

export function agentRoomDir(cwd = process.cwd()): string {
  return join(cwd, AGENTROOM_DIR);
}

export function agentRoomConfigPath(cwd = process.cwd()): string {
  return join(agentRoomDir(cwd), AGENTROOM_CONFIG_FILE);
}

export function createDefaultAgentRoomConfig(options: CreateDefaultConfigOptions): AgentRoomConfig {
  const defaultRuntime = options.defaultRuntime ?? 'herdr';
  const session = options.runtimeSession ?? options.roomId;

  return {
    room: {
      id: options.roomId,
      name: options.roomName ?? options.roomId
    },
    runtime: {
      default: defaultRuntime
    },
    runtimes: {
      fake: { type: 'fake' },
      herdr: {
        type: 'herdr',
        session,
        cli: 'herdr',
        layout: {
          mode: 'pane-grid',
          workspace: options.roomId,
          panesPerTab: 2,
          split: 'largest',
          balance: true
        }
      },
      tmux: { type: 'tmux', sessionPrefix: session, cli: 'tmux' }
    },
    storage: {
      driver: 'jsonl',
      path: DEFAULT_EVENT_LOG_PATH
    }
  };
}

export async function loadAgentRoomConfig(cwd = process.cwd()): Promise<AgentRoomConfig> {
  const path = agentRoomConfigPath(cwd);
  const text = await readFile(path, 'utf8');
  return parseAgentRoomConfig(text);
}

export async function maybeLoadAgentRoomConfig(cwd = process.cwd()): Promise<AgentRoomConfig | undefined> {
  try {
    return await loadAgentRoomConfig(cwd);
  } catch {
    return undefined;
  }
}

export function loadAgentRoomConfigSync(cwd = process.cwd()): AgentRoomConfig {
  const text = readFileSync(agentRoomConfigPath(cwd), 'utf8');
  return parseAgentRoomConfig(text);
}

export function maybeLoadAgentRoomConfigSync(cwd = process.cwd()): AgentRoomConfig | undefined {
  try {
    return loadAgentRoomConfigSync(cwd);
  } catch {
    return undefined;
  }
}

export async function writeAgentRoomConfig(cwd: string, config: AgentRoomConfig): Promise<void> {
  await mkdir(agentRoomDir(cwd), { recursive: true });
  await writeFile(agentRoomConfigPath(cwd), `${formatAgentRoomConfig(config)}\n`, 'utf8');
}

export function resolveStoragePath(config: AgentRoomConfig, cwd = process.cwd()): string {
  return resolve(cwd, config.storage.path);
}

export function ensureRuntimeConfig(config: AgentRoomConfig, runtimeName: string): RuntimeConfig {
  const runtime = config.runtimes[runtimeName];
  if (!runtime) throw new Error(`Unknown runtime '${runtimeName}'. Run 'agent-room runtime providers' to list configured runtimes.`);
  return runtime;
}

export function runtimeNameFor(config: AgentRoomConfig, runtimeName?: string): string {
  return runtimeName ?? config.runtime.default;
}

export function withDefaultRuntime(config: AgentRoomConfig, runtimeName: string): AgentRoomConfig {
  const runtime = config.runtimes[runtimeName] ?? builtInRuntimeConfig(runtimeName);
  return {
    ...config,
    runtime: { default: runtimeName },
    runtimes: {
      ...config.runtimes,
      [runtimeName]: runtime
    }
  };
}

export function builtInRuntimeConfig(runtimeName: string): RuntimeConfig {
  switch (runtimeName) {
    case 'fake':
    case 'fake-local':
      return { type: 'fake' };
    case 'herdr':
    case 'local-herdr':
      return {
        type: 'herdr',
        ...(process.env.HERDR_SESSION !== undefined ? { session: process.env.HERDR_SESSION } : {}),
        cli: 'herdr',
        layout: {
          mode: 'pane-grid',
          panesPerTab: 2,
          split: 'largest',
          balance: true
        }
      };
    case 'tmux':
    case 'local-tmux':
      return { type: 'tmux', sessionPrefix: 'agentroom', cli: 'tmux' };
    default:
      throw new Error(`Unknown runtime '${runtimeName}'`);
  }
}

export function formatAgentRoomConfig(config: AgentRoomConfig): string {
  return [
    'room:',
    `  id: ${yamlScalar(config.room.id)}`,
    ...(config.room.name !== undefined ? [`  name: ${yamlScalar(config.room.name)}`] : []),
    '',
    'runtime:',
    `  default: ${yamlScalar(config.runtime.default)}`,
    '',
    'runtimes:',
    ...Object.entries(config.runtimes).flatMap(([name, runtime]) => formatRuntime(name, runtime)),
    '',
    'storage:',
    `  driver: ${yamlScalar(config.storage.driver)}`,
    `  path: ${yamlScalar(config.storage.path)}`
  ].join('\n');
}

export function parseAgentRoomConfig(text: string): AgentRoomConfig {
  const parsed = parseSimpleYaml(text);
  const room = objectAt(parsed, 'room');
  const runtime = objectAt(parsed, 'runtime');
  const runtimes = objectAt(parsed, 'runtimes');
  const storage = objectAt(parsed, 'storage');
  const roomId = stringAt(room, 'id');
  const defaultRuntime = stringAt(runtime, 'default');
  const runtimeConfigs = parseRuntimeConfigs(runtimes);
  const driver = stringAt(storage, 'driver') || 'jsonl';
  if (driver !== 'jsonl') throw new Error(`Unsupported storage driver '${driver}'`);

  const roomName = stringAt(room, 'name');
  return {
    room: {
      id: required(roomId, 'room.id'),
      ...(roomName !== undefined ? { name: roomName } : {})
    },
    runtime: {
      default: required(defaultRuntime, 'runtime.default')
    },
    runtimes: runtimeConfigs,
    storage: {
      driver,
      path: stringAt(storage, 'path') || DEFAULT_EVENT_LOG_PATH
    }
  };
}

function formatRuntime(name: string, runtime: RuntimeConfig): string[] {
  const lines = [`  ${name}:`, `    type: ${yamlScalar(runtime.type)}`];
  if (runtime.type === 'herdr') {
    if (runtime.session !== undefined) lines.push(`    session: ${yamlScalar(runtime.session)}`);
    if (runtime.cli !== undefined) lines.push(`    cli: ${yamlScalar(runtime.cli)}`);
    if (runtime.layout !== undefined) {
      lines.push('    layout:');
      if (runtime.layout.mode !== undefined) lines.push(`      mode: ${yamlScalar(runtime.layout.mode)}`);
      if (runtime.layout.workspace !== undefined) lines.push(`      workspace: ${yamlScalar(runtime.layout.workspace)}`);
      if (runtime.layout.panesPerTab !== undefined) lines.push(`      panesPerTab: ${yamlScalar(runtime.layout.panesPerTab)}`);
      if (runtime.layout.split !== undefined) lines.push(`      split: ${yamlScalar(runtime.layout.split)}`);
      if (runtime.layout.balance !== undefined) lines.push(`      balance: ${yamlScalar(runtime.layout.balance)}`);
    }
  }
  if (runtime.type === 'tmux') {
    if (runtime.sessionPrefix !== undefined) lines.push(`    sessionPrefix: ${yamlScalar(runtime.sessionPrefix)}`);
    if (runtime.cli !== undefined) lines.push(`    cli: ${yamlScalar(runtime.cli)}`);
  }
  return lines;
}

function parseRuntimeConfigs(input: Record<string, unknown>): Record<string, RuntimeConfig> {
  const runtimes: Record<string, RuntimeConfig> = {};
  for (const [name, value] of Object.entries(input)) {
    const runtime = asRecord(value);
    const type = stringAt(runtime, 'type');
    switch (type) {
      case 'fake':
        runtimes[name] = { type };
        break;
      case 'herdr':
        {
          const session = stringAt(runtime, 'session');
          const cli = stringAt(runtime, 'cli');
          const layout = parseHerdrLayoutConfig(objectAt(runtime, 'layout'));
          runtimes[name] = {
            type,
            ...(session !== undefined ? { session } : {}),
            ...(cli !== undefined ? { cli } : {}),
            ...(layout !== undefined ? { layout } : {})
          };
        }
        break;
      case 'tmux':
        {
          const sessionPrefix = stringAt(runtime, 'sessionPrefix');
          const cli = stringAt(runtime, 'cli');
          runtimes[name] = {
            type,
            ...(sessionPrefix !== undefined ? { sessionPrefix } : {}),
            ...(cli !== undefined ? { cli } : {})
          };
        }
        break;
      default:
        throw new Error(`Unsupported runtime type '${String(type)}' for runtime '${name}'`);
    }
  }
  return runtimes;
}

function parseHerdrLayoutConfig(input: Record<string, unknown>): HerdrLayoutConfig | undefined {
  if (Object.keys(input).length === 0) return undefined;

  const mode = stringAt(input, 'mode');
  const workspace = stringAt(input, 'workspace');
  const panesPerTab = numberAt(input, 'panesPerTab');
  const split = stringAt(input, 'split');
  const balance = booleanAt(input, 'balance');

  if (
    mode !== undefined &&
    mode !== 'workspace-per-agent' &&
    mode !== 'tab-per-agent' &&
    mode !== 'pane-grid'
  ) {
    throw new Error(`Unsupported Herdr layout mode '${mode}'`);
  }
  if (split !== undefined && split !== 'largest' && split !== 'focused') {
    throw new Error(`Unsupported Herdr split strategy '${split}'`);
  }

  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(panesPerTab !== undefined ? { panesPerTab } : {}),
    ...(split !== undefined ? { split } : {}),
    ...(balance !== undefined ? { balance } : {})
  };
}

function parseSimpleYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [{ indent: -1, value: root }];

  for (const rawLine of text.split('\n')) {
    const withoutComment = rawLine.replace(/\s+#.*$/, '');
    if (!withoutComment.trim()) continue;

    const indent = withoutComment.match(/^ */)?.[0].length ?? 0;
    const trimmed = withoutComment.trim();
    const match = /^([^:]+):(.*)$/.exec(trimmed);
    if (!match) throw new Error(`Invalid config line: ${rawLine}`);

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();

    const parent = stack[stack.length - 1]!.value;
    const key = match[1]!.trim();
    const rest = match[2]!.trim();

    if (rest === '') {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = parseScalar(rest);
    }
  }

  return root;
}

function parseScalar(value: string): string | number | boolean {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return value;
}

function yamlScalar(value: string | number | boolean): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (/^[A-Za-z0-9_.:/@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function objectAt(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(value[key]);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function stringAt(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined;
}

function numberAt(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === 'number' ? value[key] : undefined;
}

function booleanAt(value: Record<string, unknown>, key: string): boolean | undefined {
  return typeof value[key] === 'boolean' ? value[key] : undefined;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required config value '${name}'`);
  return value;
}
