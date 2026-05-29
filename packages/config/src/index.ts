import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  ChatConversationKind,
  ChatCredentialKind,
  HarnessSpec,
  RuntimeProviderKind,
} from "@agentroom/core";

export const AGENTROOM_DIR = ".agentroom";
export const AGENTROOM_CONFIG_FILE = "config.yaml";
export const AGENTROOM_PROTOCOL_FILE = "AGENTS.md";
export const DEFAULT_EVENT_LOG_PATH = "events.jsonl";
export const DEFAULT_ROOM_ID = "agent-room";
export const DEFAULT_HERDR_SESSION = DEFAULT_ROOM_ID;
export const DEFAULT_TMUX_SESSION_PREFIX = DEFAULT_ROOM_ID;
export const DEFAULT_AGENTROOM_PROTOCOL = `# AgentRoom Protocol

This file is the editable room protocol. Keep machine topology in config.yaml;
keep agent behavior, room norms, and work-tracker policy here.

## Core Rules

- The configured external work tracker is canonical for durable project work.
- AgentRoom tasks are local execution shadows and audit context.
- Use AgentRoom messages and DMs for active coordination inside the room.
- Use the configured tracker MCP, connector, CLI, or skill for tracker actions.
- Link external tracker issues back to local task shadows with tracker refs.
- If tracker tools are unavailable, report tracker_update_skipped with the reason.
- Secrets and auth stay in each agent runtime, MCP connector, env, or auth store.

## Worker Behavior

- Post a short status before meaningful work.
- Claim or confirm the relevant task before editing.
- Use room-native waits, questions, blockers, and done updates.
- Keep comments concise: what changed, what was verified, and remaining risk.

## Operator Behavior

- Prefer AgentRoom launch/read/send/stop so runtime actions are audited.
- Verify runtime health before launching new workers.
- Do not bypass the room unless it is manual recovery.
`;

export function defaultRoomIdFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  return firstNonEmpty(env.AGENTROOM_ROOM_ID) ?? DEFAULT_ROOM_ID;
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export type ConfiguredRuntimeKind = Extract<
  RuntimeProviderKind,
  "fake" | "herdr" | "tmux"
>;

export interface AgentRoomConfig {
  room: {
    id: string;
    name?: string;
  };
  runtime: {
    default: string;
  };
  workTracker?: WorkTrackerConfig;
  clanky?: ClankyConfig;
  operator?: DashboardOperatorConfig;
  runtimes: Record<string, RuntimeConfig>;
  chat?: ChatConfig;
  storage: {
    driver: "jsonl";
    path: string;
  };
}

export type RuntimeConfig =
  | { type: "fake" }
  | {
      type: "herdr";
      session?: string;
      cli?: string;
      layout?: HerdrLayoutConfig;
    }
  | { type: "tmux"; sessionPrefix?: string; cli?: string };

export interface DashboardOperatorConfig {
  agentId?: string;
  displayName?: string;
  kind?: HarnessSpec["kind"] | "clanky";
  command?: string;
  cwd?: string;
  sessionDir?: string;
  env?: Record<string, string>;
}

export type HerdrLayoutMode =
  | "workspace-per-agent"
  | "tab-per-agent"
  | "pane-grid";
export type HerdrSplitStrategy = "largest" | "focused";

export interface HerdrLayoutConfig {
  mode?: HerdrLayoutMode;
  workspace?: string;
  panesPerTab?: number;
  split?: HerdrSplitStrategy;
  balance?: boolean;
}

export type WorkTrackerProviderKind =
  | "native"
  | "linear"
  | "github-issues"
  | "jira"
  | "custom";

export interface WorkTrackerConfig {
  default: string;
  providers: Record<string, WorkTrackerProviderConfig>;
}

export interface WorkTrackerProviderConfig {
  type: WorkTrackerProviderKind;
  teamId?: string;
  projectId?: string;
  baseUrl?: string;
}

export type ClankyChatGatewayOwner = "agent" | "room" | "off";

export interface ClankyConfig {
  home?: string;
  profile?: string;
  chatGatewayOwner?: ClankyChatGatewayOwner;
}

export interface ChatConfig {
  gateways: Record<string, ChatGatewayConfig>;
  routes: Record<string, ChatGatewayRouteConfig>;
}

export type ChatGatewayConfig = {
  type: "discord";
  tokenEnv: string;
  credentialKind?: Extract<ChatCredentialKind, "bot-token" | "user-token">;
  webhookMode?: boolean;
  webhookName?: string;
  webhookAvatarUrl?: string;
  ignoreOwnMessages?: boolean;
  ignoreBotMessages?: boolean;
};

export interface ChatGatewayRouteConfig {
  provider: string;
  conversationId: string;
  conversationKind?: ChatConversationKind;
  threadId?: string;
  target: ChatRouteTargetConfig;
  outbound?: ChatOutboundSourceConfig;
}

export type ChatRouteTargetConfig =
  | { type: "room-channel"; channelId: string }
  | { type: "agent-dm"; agentId: string }
  | { type: "agent-stdin"; agentId: string };

export type ChatOutboundSourceConfig =
  | { type: "room-channel"; channelId: string }
  | { type: "agent-dm"; agentId: string }
  | { type: "agent-message"; agentId: string; channelId?: string };

export interface CreateDefaultConfigOptions {
  roomId: string;
  roomName?: string;
  defaultRuntime?: ConfiguredRuntimeKind;
  runtimeSession?: string;
}

export function agentRoomDir(cwd = process.cwd()): string {
  const home = process.env.AGENTROOM_HOME?.trim();
  return home ? resolve(home) : nearestAgentRoomDir(cwd) ?? projectAgentRoomDir(cwd);
}

export function agentRoomConfigPath(cwd = process.cwd()): string {
  return join(agentRoomDir(cwd), AGENTROOM_CONFIG_FILE);
}

export function agentRoomProtocolPath(cwd = process.cwd()): string {
  return join(agentRoomDir(cwd), AGENTROOM_PROTOCOL_FILE);
}

export function projectAgentRoomDir(cwd = process.cwd()): string {
  return join(cwd, AGENTROOM_DIR);
}

export function agentRoomRootDir(cwd = process.cwd()): string {
  const home = process.env.AGENTROOM_HOME?.trim();
  if (home) return resolve(home);
  const roomDir = nearestAgentRoomDir(cwd);
  return roomDir === undefined ? resolve(cwd) : dirname(roomDir);
}

export function createDefaultAgentRoomConfig(
  options: CreateDefaultConfigOptions,
): AgentRoomConfig {
  const defaultRuntime = options.defaultRuntime ?? "fake";
  const herdrSession = options.runtimeSession ?? DEFAULT_HERDR_SESSION;
  const tmuxSessionPrefix = options.runtimeSession ?? options.roomId;

  return {
    room: {
      id: options.roomId,
      name: options.roomName ?? options.roomId,
    },
    runtime: {
      default: defaultRuntime,
    },
    workTracker: {
      default: "native",
      providers: {
        native: { type: "native" },
      },
    },
    runtimes: {
      fake: { type: "fake" },
      herdr: {
        type: "herdr",
        session: herdrSession,
        cli: "herdr",
        layout: {
          mode: "pane-grid",
          panesPerTab: 2,
          split: "largest",
          balance: true,
        },
      },
      tmux: { type: "tmux", sessionPrefix: tmuxSessionPrefix, cli: "tmux" },
    },
    storage: {
      driver: "jsonl",
      path: DEFAULT_EVENT_LOG_PATH,
    },
  };
}

export async function loadAgentRoomConfig(
  cwd = process.cwd(),
): Promise<AgentRoomConfig> {
  const path = agentRoomConfigPath(cwd);
  const text = await readFile(path, "utf8");
  return parseAgentRoomConfig(text);
}

export async function maybeLoadAgentRoomConfig(
  cwd = process.cwd(),
): Promise<AgentRoomConfig | undefined> {
  try {
    return await loadAgentRoomConfig(cwd);
  } catch {
    return undefined;
  }
}

function loadAgentRoomConfigSync(cwd = process.cwd()): AgentRoomConfig {
  const text = readFileSync(agentRoomConfigPath(cwd), "utf8");
  return parseAgentRoomConfig(text);
}

export function maybeLoadAgentRoomConfigSync(
  cwd = process.cwd(),
): AgentRoomConfig | undefined {
  try {
    return loadAgentRoomConfigSync(cwd);
  } catch {
    return undefined;
  }
}

export async function writeAgentRoomConfig(
  cwd: string,
  config: AgentRoomConfig,
): Promise<void> {
  await mkdir(agentRoomDir(cwd), { recursive: true });
  await writeFile(
    agentRoomConfigPath(cwd),
    `${formatAgentRoomConfig(config)}\n`,
    "utf8",
  );
}

export async function ensureAgentRoomProtocol(cwd = process.cwd()): Promise<string> {
  const path = agentRoomProtocolPath(cwd);
  if (!existsSync(path)) {
    await mkdir(agentRoomDir(cwd), { recursive: true });
    await writeFile(path, DEFAULT_AGENTROOM_PROTOCOL, "utf8");
  }
  return path;
}

export async function readAgentRoomProtocol(
  cwd = process.cwd(),
): Promise<{ path: string; content: string }> {
  const path = agentRoomProtocolPath(cwd);
  return { path, content: await readFile(path, "utf8") };
}

export function readAgentRoomProtocolSync(
  cwd = process.cwd(),
): { path: string; content: string } {
  const path = agentRoomProtocolPath(cwd);
  return { path, content: readFileSync(path, "utf8") };
}

export function resolveStoragePath(
  config: AgentRoomConfig,
  cwd = process.cwd(),
): string {
  return resolve(agentRoomDir(cwd), config.storage.path);
}

function nearestAgentRoomDir(cwd: string): string | undefined {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, AGENTROOM_DIR);
    if (existsSync(join(candidate, AGENTROOM_CONFIG_FILE))) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function ensureRuntimeConfig(
  config: AgentRoomConfig,
  runtimeName: string,
): RuntimeConfig {
  const runtime = config.runtimes[runtimeName];
  if (!runtime)
    throw new Error(
      `Unknown runtime '${runtimeName}'. Run 'agent-room runtime providers' to list configured runtimes.`,
    );
  return runtime;
}

export function withDefaultRuntime(
  config: AgentRoomConfig,
  runtimeName: string,
): AgentRoomConfig {
  const runtime =
    config.runtimes[runtimeName] ?? builtInRuntimeConfig(runtimeName);
  return {
    ...config,
    runtime: { default: runtimeName },
    runtimes: {
      ...config.runtimes,
      [runtimeName]: runtime,
    },
  };
}

export function builtInRuntimeConfig(runtimeName: string): RuntimeConfig {
  switch (runtimeName) {
    case "fake":
    case "fake-local":
      return { type: "fake" };
    case "herdr":
    case "local-herdr":
      return {
        type: "herdr",
        session: DEFAULT_HERDR_SESSION,
        cli: "herdr",
        layout: {
          mode: "pane-grid",
          panesPerTab: 2,
          split: "largest",
          balance: true,
        },
      };
    case "tmux":
    case "local-tmux":
      return {
        type: "tmux",
        sessionPrefix: DEFAULT_TMUX_SESSION_PREFIX,
        cli: "tmux",
      };
    default:
      throw new Error(`Unknown runtime '${runtimeName}'`);
  }
}

export function formatAgentRoomConfig(config: AgentRoomConfig): string {
  return [
    "room:",
    `  id: ${yamlScalar(config.room.id)}`,
    ...(config.room.name !== undefined
      ? [`  name: ${yamlScalar(config.room.name)}`]
      : []),
    "",
    "runtime:",
    `  default: ${yamlScalar(config.runtime.default)}`,
    "",
    ...(config.workTracker !== undefined
      ? [...formatWorkTracker(config.workTracker), ""]
      : []),
    ...(config.clanky !== undefined
      ? [...formatClanky(config.clanky), ""]
      : []),
    ...(config.operator !== undefined
      ? [...formatDashboardOperator(config.operator), ""]
      : []),
    "runtimes:",
    ...Object.entries(config.runtimes).flatMap(([name, runtime]) =>
      formatRuntime(name, runtime),
    ),
    "",
    ...(config.chat !== undefined ? [...formatChat(config.chat), ""] : []),
    "storage:",
    `  driver: ${yamlScalar(config.storage.driver)}`,
    `  path: ${yamlScalar(config.storage.path)}`,
  ].join("\n");
}

export function parseAgentRoomConfig(text: string): AgentRoomConfig {
  const parsed = parseSimpleYaml(text);
  const room = objectAt(parsed, "room");
  const runtime = objectAt(parsed, "runtime");
  const workTracker = parseWorkTrackerConfig(objectAt(parsed, "workTracker"));
  const clanky = parseClankyConfig(objectAt(parsed, "clanky"));
  const operator = parseDashboardOperatorConfig(objectAt(parsed, "operator"));
  const runtimes = objectAt(parsed, "runtimes");
  const chat = parseChatConfig(objectAt(parsed, "chat"));
  const storage = objectAt(parsed, "storage");
  const roomId = stringAt(room, "id");
  const defaultRuntime = stringAt(runtime, "default");
  const runtimeConfigs = parseRuntimeConfigs(runtimes);
  const driver = stringAt(storage, "driver") || "jsonl";
  if (driver !== "jsonl")
    throw new Error(`Unsupported storage driver '${driver}'`);

  const roomName = stringAt(room, "name");
  return {
    room: {
      id: required(roomId, "room.id"),
      ...(roomName !== undefined ? { name: roomName } : {}),
    },
    runtime: {
      default: required(defaultRuntime, "runtime.default"),
    },
    ...(workTracker !== undefined ? { workTracker } : {}),
    ...(clanky !== undefined ? { clanky } : {}),
    ...(operator !== undefined ? { operator } : {}),
    runtimes: runtimeConfigs,
    ...(chat !== undefined ? { chat } : {}),
    storage: {
      driver,
      path: stringAt(storage, "path") || DEFAULT_EVENT_LOG_PATH,
    },
  };
}

function formatWorkTracker(workTracker: WorkTrackerConfig): string[] {
  return [
    "workTracker:",
    `  default: ${yamlScalar(workTracker.default)}`,
    "  providers:",
    ...Object.entries(workTracker.providers).flatMap(([id, provider]) =>
      formatWorkTrackerProvider(id, provider),
    ),
  ];
}

function formatWorkTrackerProvider(
  id: string,
  provider: WorkTrackerProviderConfig,
): string[] {
  return [
    `    ${id}:`,
    `      type: ${yamlScalar(provider.type)}`,
    ...(provider.teamId !== undefined
      ? [`      teamId: ${yamlScalar(provider.teamId)}`]
      : []),
    ...(provider.projectId !== undefined
      ? [`      projectId: ${yamlScalar(provider.projectId)}`]
      : []),
    ...(provider.baseUrl !== undefined
      ? [`      baseUrl: ${yamlScalar(provider.baseUrl)}`]
      : []),
  ];
}

function formatClanky(clanky: ClankyConfig): string[] {
  return [
    "clanky:",
    ...(clanky.home !== undefined
      ? [`  home: ${yamlScalar(clanky.home)}`]
      : []),
    ...(clanky.profile !== undefined
      ? [`  profile: ${yamlScalar(clanky.profile)}`]
      : []),
    ...(clanky.chatGatewayOwner !== undefined
      ? [`  chatGatewayOwner: ${yamlScalar(clanky.chatGatewayOwner)}`]
      : []),
  ];
}

function formatDashboardOperator(operator: DashboardOperatorConfig): string[] {
  return [
    "operator:",
    ...(operator.agentId !== undefined
      ? [`  agentId: ${yamlScalar(operator.agentId)}`]
      : []),
    ...(operator.displayName !== undefined
      ? [`  displayName: ${yamlScalar(operator.displayName)}`]
      : []),
    ...(operator.kind !== undefined
      ? [`  kind: ${yamlScalar(operator.kind)}`]
      : []),
    ...(operator.command !== undefined
      ? [`  command: ${yamlScalar(operator.command)}`]
      : []),
    ...(operator.cwd !== undefined
      ? [`  cwd: ${yamlScalar(operator.cwd)}`]
      : []),
    ...(operator.sessionDir !== undefined
      ? [`  sessionDir: ${yamlScalar(operator.sessionDir)}`]
      : []),
    ...(operator.env !== undefined && Object.keys(operator.env).length > 0
      ? [
          "  env:",
          ...Object.entries(operator.env).map(
            ([key, value]) => `    ${key}: ${yamlScalar(value)}`,
          ),
        ]
      : []),
  ];
}

function formatChat(chat: ChatConfig): string[] {
  return [
    "chat:",
    "  gateways:",
    ...Object.entries(chat.gateways).flatMap(([id, gateway]) =>
      formatChatGateway(id, gateway),
    ),
    "  routes:",
    ...Object.entries(chat.routes).flatMap(([id, route]) =>
      formatChatRoute(id, route),
    ),
  ];
}

function formatChatGateway(id: string, gateway: ChatGatewayConfig): string[] {
  return [
    `    ${id}:`,
    `      type: ${yamlScalar(gateway.type)}`,
    `      tokenEnv: ${yamlScalar(gateway.tokenEnv)}`,
    ...(gateway.credentialKind !== undefined
      ? [`      credentialKind: ${yamlScalar(gateway.credentialKind)}`]
      : []),
    ...(gateway.webhookMode !== undefined
      ? [`      webhookMode: ${yamlScalar(gateway.webhookMode)}`]
      : []),
    ...(gateway.webhookName !== undefined
      ? [`      webhookName: ${yamlScalar(gateway.webhookName)}`]
      : []),
    ...(gateway.webhookAvatarUrl !== undefined
      ? [`      webhookAvatarUrl: ${yamlScalar(gateway.webhookAvatarUrl)}`]
      : []),
    ...(gateway.ignoreOwnMessages !== undefined
      ? [`      ignoreOwnMessages: ${yamlScalar(gateway.ignoreOwnMessages)}`]
      : []),
    ...(gateway.ignoreBotMessages !== undefined
      ? [`      ignoreBotMessages: ${yamlScalar(gateway.ignoreBotMessages)}`]
      : []),
  ];
}

function formatChatRoute(id: string, route: ChatGatewayRouteConfig): string[] {
  return [
    `    ${id}:`,
    `      provider: ${yamlScalar(route.provider)}`,
    `      conversationId: ${yamlScalar(route.conversationId)}`,
    ...(route.conversationKind !== undefined
      ? [`      conversationKind: ${yamlScalar(route.conversationKind)}`]
      : []),
    ...(route.threadId !== undefined
      ? [`      threadId: ${yamlScalar(route.threadId)}`]
      : []),
    "      target:",
    ...formatChatTarget(route.target, 8),
    ...(route.outbound !== undefined
      ? ["      outbound:", ...formatChatOutbound(route.outbound, 8)]
      : []),
  ];
}

function formatChatTarget(
  target: ChatRouteTargetConfig,
  indent: number,
): string[] {
  const pad = " ".repeat(indent);
  switch (target.type) {
    case "room-channel":
      return [
        `${pad}type: ${yamlScalar(target.type)}`,
        `${pad}channelId: ${yamlScalar(target.channelId)}`,
      ];
    case "agent-dm":
    case "agent-stdin":
      return [
        `${pad}type: ${yamlScalar(target.type)}`,
        `${pad}agentId: ${yamlScalar(target.agentId)}`,
      ];
  }
}

function formatChatOutbound(
  outbound: ChatOutboundSourceConfig,
  indent: number,
): string[] {
  const pad = " ".repeat(indent);
  switch (outbound.type) {
    case "room-channel":
      return [
        `${pad}type: ${yamlScalar(outbound.type)}`,
        `${pad}channelId: ${yamlScalar(outbound.channelId)}`,
      ];
    case "agent-dm":
      return [
        `${pad}type: ${yamlScalar(outbound.type)}`,
        `${pad}agentId: ${yamlScalar(outbound.agentId)}`,
      ];
    case "agent-message":
      return [
        `${pad}type: ${yamlScalar(outbound.type)}`,
        `${pad}agentId: ${yamlScalar(outbound.agentId)}`,
        ...(outbound.channelId !== undefined
          ? [`${pad}channelId: ${yamlScalar(outbound.channelId)}`]
          : []),
      ];
  }
}

function formatRuntime(name: string, runtime: RuntimeConfig): string[] {
  const lines = [`  ${name}:`, `    type: ${yamlScalar(runtime.type)}`];
  if (runtime.type === "herdr") {
    if (runtime.session !== undefined)
      lines.push(`    session: ${yamlScalar(runtime.session)}`);
    if (runtime.cli !== undefined)
      lines.push(`    cli: ${yamlScalar(runtime.cli)}`);
    if (runtime.layout !== undefined) {
      lines.push("    layout:");
      if (runtime.layout.mode !== undefined)
        lines.push(`      mode: ${yamlScalar(runtime.layout.mode)}`);
      if (runtime.layout.workspace !== undefined)
        lines.push(`      workspace: ${yamlScalar(runtime.layout.workspace)}`);
      if (runtime.layout.panesPerTab !== undefined)
        lines.push(
          `      panesPerTab: ${yamlScalar(runtime.layout.panesPerTab)}`,
        );
      if (runtime.layout.split !== undefined)
        lines.push(`      split: ${yamlScalar(runtime.layout.split)}`);
      if (runtime.layout.balance !== undefined)
        lines.push(`      balance: ${yamlScalar(runtime.layout.balance)}`);
    }
  }
  if (runtime.type === "tmux") {
    if (runtime.sessionPrefix !== undefined)
      lines.push(`    sessionPrefix: ${yamlScalar(runtime.sessionPrefix)}`);
    if (runtime.cli !== undefined)
      lines.push(`    cli: ${yamlScalar(runtime.cli)}`);
  }
  return lines;
}

function parseWorkTrackerConfig(
  input: Record<string, unknown>,
): WorkTrackerConfig | undefined {
  if (Object.keys(input).length === 0) return undefined;
  const defaultProvider = required(
    stringAt(input, "default"),
    "workTracker.default",
  );
  const providers = parseWorkTrackerProviders(objectAt(input, "providers"));
  if (providers[defaultProvider] === undefined) {
    throw new Error(
      `Default work tracker '${defaultProvider}' is not configured in workTracker.providers`,
    );
  }

  return {
    default: defaultProvider,
    providers,
  };
}

function parseWorkTrackerProviders(
  input: Record<string, unknown>,
): Record<string, WorkTrackerProviderConfig> {
  const providers: Record<string, WorkTrackerProviderConfig> = {};
  for (const [id, value] of Object.entries(input)) {
    const provider = asRecord(value);
    const type = stringAt(provider, "type");
    if (!isWorkTrackerProviderKind(type)) {
      throw new Error(
        `Unsupported work tracker type '${String(type)}' for provider '${id}'`,
      );
    }

    const teamId = stringAt(provider, "teamId");
    const projectId = stringAt(provider, "projectId");
    const baseUrl = stringAt(provider, "baseUrl");

    providers[id] = {
      type,
      ...(teamId !== undefined ? { teamId } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    };
  }
  return providers;
}

function parseClankyConfig(
  input: Record<string, unknown>,
): ClankyConfig | undefined {
  if (Object.keys(input).length === 0) return undefined;

  const home = stringAt(input, "home");
  const profile = stringAt(input, "profile");
  const chatGatewayOwner = stringAt(input, "chatGatewayOwner");
  if (
    chatGatewayOwner !== undefined &&
    chatGatewayOwner !== "agent" &&
    chatGatewayOwner !== "room" &&
    chatGatewayOwner !== "off"
  ) {
    throw new Error(
      `Unsupported Clanky chat gateway owner '${chatGatewayOwner}'`,
    );
  }

  return {
    ...(home !== undefined ? { home } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(chatGatewayOwner !== undefined ? { chatGatewayOwner } : {}),
  };
}

function parseDashboardOperatorConfig(
  input: Record<string, unknown>,
): DashboardOperatorConfig | undefined {
  if (Object.keys(input).length === 0) return undefined;

  const agentId = stringAt(input, "agentId");
  const displayName = stringAt(input, "displayName");
  const kind = stringAt(input, "kind");
  const command = stringAt(input, "command");
  const cwd = stringAt(input, "cwd");
  const sessionDir = stringAt(input, "sessionDir");
  if (
    kind !== undefined &&
    kind !== "claude-code" &&
    kind !== "pi" &&
    kind !== "codex" &&
    kind !== "gemini-cli" &&
    kind !== "shell" &&
    kind !== "custom" &&
    kind !== "clanky"
  ) {
    throw new Error(`Unsupported dashboard operator kind '${kind}'`);
  }

  const env = stringRecordAt(input, "env");
  const operator: DashboardOperatorConfig = {};
  if (agentId !== undefined) operator.agentId = agentId;
  if (displayName !== undefined) operator.displayName = displayName;
  if (kind !== undefined) {
    operator.kind = kind as NonNullable<DashboardOperatorConfig["kind"]>;
  }
  if (command !== undefined) operator.command = command;
  if (cwd !== undefined) operator.cwd = cwd;
  if (sessionDir !== undefined) operator.sessionDir = sessionDir;
  if (Object.keys(env).length > 0) operator.env = env;
  return operator;
}

function parseChatConfig(
  input: Record<string, unknown>,
): ChatConfig | undefined {
  if (Object.keys(input).length === 0) return undefined;
  return {
    gateways: parseChatGateways(objectAt(input, "gateways")),
    routes: parseChatRoutes(objectAt(input, "routes")),
  };
}

function parseChatGateways(
  input: Record<string, unknown>,
): Record<string, ChatGatewayConfig> {
  const gateways: Record<string, ChatGatewayConfig> = {};
  for (const [id, value] of Object.entries(input)) {
    const gateway = asRecord(value);
    const type = stringAt(gateway, "type");
    if (type !== "discord")
      throw new Error(
        `Unsupported chat gateway type '${String(type)}' for gateway '${id}'`,
      );

    const credentialKind = stringAt(gateway, "credentialKind");
    if (
      credentialKind !== undefined &&
      credentialKind !== "bot-token" &&
      credentialKind !== "user-token"
    ) {
      throw new Error(
        `Unsupported Discord credential kind '${credentialKind}' for gateway '${id}'`,
      );
    }
    const webhookMode = booleanAt(gateway, "webhookMode");
    const webhookName = stringAt(gateway, "webhookName");
    const webhookAvatarUrl = stringAt(gateway, "webhookAvatarUrl");
    const ignoreOwnMessages = booleanAt(gateway, "ignoreOwnMessages");
    const ignoreBotMessages = booleanAt(gateway, "ignoreBotMessages");

    gateways[id] = {
      type,
      tokenEnv: required(
        stringAt(gateway, "tokenEnv"),
        `chat.gateways.${id}.tokenEnv`,
      ),
      ...(credentialKind !== undefined ? { credentialKind } : {}),
      ...(webhookMode !== undefined ? { webhookMode } : {}),
      ...(webhookName !== undefined ? { webhookName } : {}),
      ...(webhookAvatarUrl !== undefined ? { webhookAvatarUrl } : {}),
      ...(ignoreOwnMessages !== undefined ? { ignoreOwnMessages } : {}),
      ...(ignoreBotMessages !== undefined ? { ignoreBotMessages } : {}),
    };
  }
  return gateways;
}

function parseChatRoutes(
  input: Record<string, unknown>,
): Record<string, ChatGatewayRouteConfig> {
  const routes: Record<string, ChatGatewayRouteConfig> = {};
  for (const [id, value] of Object.entries(input)) {
    const route = asRecord(value);
    const conversationKind = stringAt(route, "conversationKind");
    if (
      conversationKind !== undefined &&
      conversationKind !== "dm" &&
      conversationKind !== "channel" &&
      conversationKind !== "group" &&
      conversationKind !== "thread" &&
      conversationKind !== "custom"
    ) {
      throw new Error(
        `Unsupported chat conversation kind '${conversationKind}' for route '${id}'`,
      );
    }
    const threadId = stringAt(route, "threadId");
    const outbound = objectAt(route, "outbound");

    routes[id] = {
      provider: required(
        stringAt(route, "provider"),
        `chat.routes.${id}.provider`,
      ),
      conversationId: required(
        stringAt(route, "conversationId"),
        `chat.routes.${id}.conversationId`,
      ),
      ...(conversationKind !== undefined ? { conversationKind } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      target: parseChatTarget(
        objectAt(route, "target"),
        `chat.routes.${id}.target`,
      ),
      ...(Object.keys(outbound).length > 0
        ? {
            outbound: parseChatOutbound(outbound, `chat.routes.${id}.outbound`),
          }
        : {}),
    };
  }
  return routes;
}

function parseChatTarget(
  input: Record<string, unknown>,
  path: string,
): ChatRouteTargetConfig {
  const type = stringAt(input, "type");
  switch (type) {
    case "room-channel":
      return {
        type,
        channelId: required(stringAt(input, "channelId"), `${path}.channelId`),
      };
    case "agent-dm":
    case "agent-stdin":
      return {
        type,
        agentId: required(stringAt(input, "agentId"), `${path}.agentId`),
      };
    default:
      throw new Error(
        `Unsupported chat route target '${String(type)}' at '${path}'`,
      );
  }
}

function parseChatOutbound(
  input: Record<string, unknown>,
  path: string,
): ChatOutboundSourceConfig {
  const type = stringAt(input, "type");
  switch (type) {
    case "room-channel":
      return {
        type,
        channelId: required(stringAt(input, "channelId"), `${path}.channelId`),
      };
    case "agent-dm":
      return {
        type,
        agentId: required(stringAt(input, "agentId"), `${path}.agentId`),
      };
    case "agent-message": {
      const channelId = stringAt(input, "channelId");
      return {
        type,
        agentId: required(stringAt(input, "agentId"), `${path}.agentId`),
        ...(channelId !== undefined ? { channelId } : {}),
      };
    }
    default:
      throw new Error(
        `Unsupported chat outbound source '${String(type)}' at '${path}'`,
      );
  }
}

function parseRuntimeConfigs(
  input: Record<string, unknown>,
): Record<string, RuntimeConfig> {
  const runtimes: Record<string, RuntimeConfig> = {};
  for (const [name, value] of Object.entries(input)) {
    const runtime = asRecord(value);
    const type = stringAt(runtime, "type");
    switch (type) {
      case "fake":
        runtimes[name] = { type };
        break;
      case "herdr":
        {
          const session = stringAt(runtime, "session");
          const cli = stringAt(runtime, "cli");
          const layout = parseHerdrLayoutConfig(objectAt(runtime, "layout"));
          runtimes[name] = {
            type,
            ...(session !== undefined ? { session } : {}),
            ...(cli !== undefined ? { cli } : {}),
            ...(layout !== undefined ? { layout } : {}),
          };
        }
        break;
      case "tmux":
        {
          const sessionPrefix = stringAt(runtime, "sessionPrefix");
          const cli = stringAt(runtime, "cli");
          runtimes[name] = {
            type,
            ...(sessionPrefix !== undefined ? { sessionPrefix } : {}),
            ...(cli !== undefined ? { cli } : {}),
          };
        }
        break;
      default:
        throw new Error(
          `Unsupported runtime type '${String(type)}' for runtime '${name}'`,
        );
    }
  }
  return runtimes;
}

function parseHerdrLayoutConfig(
  input: Record<string, unknown>,
): HerdrLayoutConfig | undefined {
  if (Object.keys(input).length === 0) return undefined;

  const mode = stringAt(input, "mode");
  const workspace = stringAt(input, "workspace");
  const panesPerTab = numberAt(input, "panesPerTab");
  const split = stringAt(input, "split");
  const balance = booleanAt(input, "balance");

  if (
    mode !== undefined &&
    mode !== "workspace-per-agent" &&
    mode !== "tab-per-agent" &&
    mode !== "pane-grid"
  ) {
    throw new Error(`Unsupported Herdr layout mode '${mode}'`);
  }
  if (split !== undefined && split !== "largest" && split !== "focused") {
    throw new Error(`Unsupported Herdr split strategy '${split}'`);
  }

  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(panesPerTab !== undefined ? { panesPerTab } : {}),
    ...(split !== undefined ? { split } : {}),
    ...(balance !== undefined ? { balance } : {}),
  };
}

function parseSimpleYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [
    { indent: -1, value: root },
  ];

  for (const rawLine of text.split("\n")) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "");
    if (!withoutComment.trim()) continue;

    const indent = withoutComment.match(/^ */)?.[0].length ?? 0;
    const trimmed = withoutComment.trim();
    const match = /^([^:]+):(.*)$/.exec(trimmed);
    if (!match) throw new Error(`Invalid config line: ${rawLine}`);

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent)
      stack.pop();

    const parent = stack[stack.length - 1]!.value;
    const key = match[1]!.trim();
    const rest = match[2]!.trim();

    if (rest === "") {
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
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return value;
}

function yamlScalar(value: string | number | boolean): string {
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (/^[A-Za-z0-9_.:/@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function objectAt(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return asRecord(value[key]);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

function isWorkTrackerProviderKind(
  value: string | undefined,
): value is WorkTrackerProviderKind {
  return (
    value === "native" ||
    value === "linear" ||
    value === "github-issues" ||
    value === "jira" ||
    value === "custom"
  );
}

function stringAt(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function stringRecordAt(
  value: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const record = objectAt(value, key);
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function numberAt(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  return typeof value[key] === "number" ? value[key] : undefined;
}

function booleanAt(
  value: Record<string, unknown>,
  key: string,
): boolean | undefined {
  return typeof value[key] === "boolean" ? value[key] : undefined;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required config value '${name}'`);
  return value;
}
