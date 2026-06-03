import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  nowIso,
  type AdoptAgentRequest,
  type AgentOutput,
  type ReadAgentRequest,
  type RuntimeAgent,
  type RuntimeCapabilities,
  type RuntimeHealth,
  type RuntimeProvider,
  type RuntimeSession,
  type SendInputRequest,
  type SendKeysRequest,
  type StartAgentRequest,
} from "@agentroom/core";

const execFileAsync = promisify(execFile);
const DEFAULT_ZELLIJ_SESSION = "agent-room";
const AGENTROOM_PANE_TITLE_PREFIX = "agentroom:";

export type ZellijCommandRunner = (
  args: string[],
  options?: { env?: Record<string, string> },
) => Promise<string>;

export interface ZellijRuntimeProviderOptions {
  id?: string;
  cli?: string;
  session?: string;
  runner?: ZellijCommandRunner;
}

export class ZellijRuntimeProvider implements RuntimeProvider {
  readonly id: string;
  readonly kind = "zellij" as const;
  readonly capabilities: RuntimeCapabilities = {
    startAgent: true,
    stopAgent: true,
    readOutput: true,
    sendInput: true,
    sendKeys: true,
    attachInteractive: true,
    subscribeEvents: false,
    semanticAgentState: false,
    screenshots: false,
    fileMounts: false,
    worktrees: false,
    remoteExecution: false,
    adoptAgent: true,
  };

  private readonly cli: string;
  private readonly session: string;
  private readonly runner: ZellijCommandRunner;

  constructor(options: ZellijRuntimeProviderOptions = {}) {
    this.id = options.id ?? "zellij";
    this.cli = options.cli ?? "zellij";
    this.session = options.session ?? DEFAULT_ZELLIJ_SESSION;
    this.runner = options.runner ?? this.execZellij.bind(this);
  }

  async health(): Promise<RuntimeHealth> {
    try {
      const version = (await this.runBase(["--version"])).trim();
      const sessions = await this.listSessions();
      const sessionActive = sessions.some(
        (session) => session.id === this.session,
      );
      return {
        ok: true,
        status: "ok",
        message: sessionActive
          ? `zellij available; session '${this.session}' is active`
          : `zellij available; session '${this.session}' will be created on launch`,
        metadata: this.baseMetadata({
          ...(version ? { version } : {}),
          sessionActive,
        }),
      };
    } catch (error) {
      return {
        ok: false,
        status: "offline",
        message: error instanceof Error ? error.message : String(error),
        metadata: this.baseMetadata(),
      };
    }
  }

  async listSessions(): Promise<RuntimeSession[]> {
    try {
      const stdout = await this.runBase([
        "list-sessions",
        "--short",
        "--no-formatting",
      ]);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((name) => ({
          id: name,
          name,
          metadata: { cli: this.cli },
        }));
    } catch (error) {
      if (isZellijUnavailableError(error)) return [];
      throw error;
    }
  }

  async listAgents(): Promise<RuntimeAgent[]> {
    try {
      const panes = await this.listPanes();
      return panes
        .filter((pane) => !pane.is_plugin)
        .map((pane) => runtimeAgentForPane(this.session, pane));
    } catch (error) {
      if (isZellijUnavailableError(error)) return [];
      throw error;
    }
  }

  async startAgent(request: StartAgentRequest): Promise<RuntimeAgent> {
    await this.ensureSession();
    const cwd = request.cwd ?? request.harness.cwd ?? process.cwd();
    const title = agentRoomPaneTitle(request.agentId);
    const command = zellijCommandVector(
      {
        AGENTROOM: "1",
        AGENTROOM_AGENT_ID: request.agentId,
        AGENTROOM_ROOM_ID: request.roomId,
        AGENTROOM_ROLE: request.role,
        ...(request.env ?? {}),
        ...(request.harness.env ?? {}),
      },
      request.harness.command,
      request.harness.args ?? [],
    );
    const stdout = await this.runInSession([
      "run",
      "--cwd",
      cwd,
      "--name",
      title,
      "--",
      ...command,
    ]);
    const paneId = parseCreatedPaneId(stdout);
    const pane = paneId ? await this.tryGetPane(paneId) : undefined;
    const bindingId = pane?.pane_id ?? paneId ?? title;

    return {
      id: request.agentId,
      bindingId,
      displayName: request.displayName ?? request.agentId,
      state: "starting",
      sessionId: this.session,
      metadata: {
        session: this.session,
        title,
        cwd,
        ...(pane !== undefined ? paneMetadata(pane) : {}),
      },
    };
  }

  async adoptAgent(request: AdoptAgentRequest): Promise<RuntimeAgent> {
    const pane = await this.getPane(request.bindingId);
    const agentId = agentRoomAgentIdForPane(pane) ?? request.agentId;
    return {
      id: request.agentId,
      bindingId: pane.pane_id,
      displayName: request.displayName ?? agentId,
      state: pane.exited ? "stopped" : "online",
      sessionId: this.session,
      metadata: {
        session: this.session,
        adopted: true,
        ...paneMetadata(pane),
        ...(request.metadata ?? {}),
      },
    };
  }

  async stopAgent(agentId: string): Promise<void> {
    await this.runInSession([
      "action",
      "close-pane",
      "--pane-id",
      await this.resolvePaneId(agentId),
    ]);
  }

  async readAgent(request: ReadAgentRequest): Promise<AgentOutput> {
    const paneId =
      request.bindingId ?? (await this.resolvePaneId(request.agentId));
    const full = request.source !== "visible";
    const stdout = await this.runInSession([
      "action",
      "dump-screen",
      "--pane-id",
      paneId,
      ...(full ? ["--full"] : []),
    ]);
    const lines = stdout.split("\n");
    const selected =
      request.source === "all" || request.lines === undefined
        ? lines
        : lines.slice(-request.lines);
    const text = selected.join("\n");
    return {
      agentId: request.agentId,
      bindingId: paneId,
      text,
      lineCount: selected.filter(Boolean).length,
      observedAt: nowIso(),
    };
  }

  async sendInput(request: SendInputRequest): Promise<void> {
    const paneId =
      request.bindingId ?? (await this.resolvePaneId(request.agentId));
    if (request.text.length > 0) {
      await this.runInSession([
        "action",
        "write-chars",
        "--pane-id",
        paneId,
        request.text,
      ]);
    }
    if (request.submit !== false) {
      await this.sendKeys({
        agentId: request.agentId,
        bindingId: paneId,
        keys: ["Enter"],
        ...(request.source !== undefined ? { source: request.source } : {}),
      });
    }
  }

  async sendKeys(request: SendKeysRequest): Promise<void> {
    if (request.keys.length === 0) return;
    const paneId =
      request.bindingId ?? (await this.resolvePaneId(request.agentId));
    await this.runInSession([
      "action",
      "send-keys",
      "--pane-id",
      paneId,
      ...request.keys,
    ]);
  }

  async attach(agentId: string): Promise<void> {
    const paneId = await this.resolvePaneId(agentId);
    await this.runInSession(["action", "focus-pane-id", paneId]);
    await this.runBase(["attach", this.session]);
  }

  private async ensureSession(): Promise<void> {
    const sessions = await this.listSessions();
    if (sessions.some((session) => session.id === this.session)) return;
    await this.runBase(["attach", this.session, "--create-background"]);
  }

  private async listPanes(): Promise<ZellijPaneInfo[]> {
    const stdout = await this.runInSession([
      "action",
      "list-panes",
      "--all",
      "--json",
    ]);
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizePaneInfo).filter((pane) => pane !== undefined);
  }

  private async getPane(paneId: string): Promise<ZellijPaneInfo> {
    const normalized = normalizePaneId(paneId);
    const pane = (await this.listPanes()).find(
      (candidate) => candidate.pane_id === normalized,
    );
    if (!pane) throw new Error(`Zellij pane not found: ${paneId}`);
    return pane;
  }

  private async tryGetPane(
    paneId: string,
  ): Promise<ZellijPaneInfo | undefined> {
    try {
      return await this.getPane(paneId);
    } catch {
      return undefined;
    }
  }

  private async resolvePaneId(agentIdOrPaneId: string): Promise<string> {
    if (isPaneId(agentIdOrPaneId)) return normalizePaneId(agentIdOrPaneId);
    const direct = await this.tryGetPane(agentIdOrPaneId);
    if (direct) return direct.pane_id;
    const panes = await this.listPanes();
    const pane = panes.find(
      (candidate) =>
        agentRoomAgentIdForPane(candidate) === agentIdOrPaneId ||
        candidate.title === agentIdOrPaneId,
    );
    return pane?.pane_id ?? normalizePaneId(agentIdOrPaneId);
  }

  private async runBase(
    args: string[],
    options: { env?: Record<string, string> } = {},
  ): Promise<string> {
    return this.runner(args, options);
  }

  private async runInSession(
    args: string[],
    options: { env?: Record<string, string> } = {},
  ): Promise<string> {
    return this.runner(["--session", this.session, ...args], options);
  }

  private async execZellij(
    args: string[],
    options: { env?: Record<string, string> } = {},
  ): Promise<string> {
    const { stdout } = await execFileAsync(this.cli, args, {
      env: { ...process.env, ...(options.env ?? {}) },
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  private baseMetadata(
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      session: this.session,
      cli: this.cli,
      ...extra,
    };
  }
}

export interface ZellijPaneInfo {
  pane_id: string;
  id: number;
  is_plugin: boolean;
  title: string;
  tab_id?: string;
  tab_position?: number;
  tab_name?: string;
  command?: string;
  cwd?: string;
  focused?: boolean;
  floating?: boolean;
  exited?: boolean;
  held?: boolean;
  rows?: number;
  columns?: number;
}

function runtimeAgentForPane(
  session: string,
  pane: ZellijPaneInfo,
): RuntimeAgent {
  const agentRoomAgentId = agentRoomAgentIdForPane(pane);
  const displayName =
    agentRoomAgentId ?? nonEmpty(pane.title) ?? pane.command ?? pane.pane_id;
  return {
    id: agentRoomAgentId ?? pane.pane_id,
    bindingId: pane.pane_id,
    displayName,
    state: pane.exited ? "stopped" : pane.held ? "idle" : "online",
    sessionId: session,
    metadata: {
      session,
      ...paneMetadata(pane),
      ...(agentRoomAgentId !== undefined ? { agentRoomAgentId } : {}),
    },
  };
}

function paneMetadata(pane: ZellijPaneInfo): Record<string, unknown> {
  return {
    paneId: pane.pane_id,
    title: pane.title,
    ...(pane.tab_id !== undefined ? { tabId: pane.tab_id } : {}),
    ...(pane.tab_position !== undefined
      ? { tabPosition: pane.tab_position }
      : {}),
    ...(pane.tab_name !== undefined ? { tabName: pane.tab_name } : {}),
    ...(pane.command !== undefined ? { command: pane.command } : {}),
    ...(pane.cwd !== undefined ? { cwd: pane.cwd } : {}),
    ...(pane.focused !== undefined ? { focused: pane.focused } : {}),
    ...(pane.floating !== undefined ? { floating: pane.floating } : {}),
    ...(pane.exited !== undefined ? { exited: pane.exited } : {}),
    ...(pane.held !== undefined ? { held: pane.held } : {}),
    ...(pane.rows !== undefined ? { rows: pane.rows } : {}),
    ...(pane.columns !== undefined ? { columns: pane.columns } : {}),
  };
}

function normalizePaneInfo(input: unknown): ZellijPaneInfo | undefined {
  const record = asRecord(input);
  const id = numberField(record, "id");
  const isPlugin = booleanField(record, "is_plugin") ?? false;
  if (id === undefined) return undefined;
  const paneId = isPlugin ? `plugin_${id}` : `terminal_${id}`;
  const tabId = numberField(record, "tab_id");
  const tabPosition = numberField(record, "tab_position");
  const tabName = stringField(record, "tab_name");
  const command =
    stringField(record, "pane_command") ??
    stringField(record, "terminal_command");
  const cwd = stringField(record, "pane_cwd");
  const focused = booleanField(record, "is_focused");
  const floating = booleanField(record, "is_floating");
  const exited = booleanField(record, "exited");
  const held = booleanField(record, "is_held");
  const rows = numberField(record, "pane_rows");
  const columns = numberField(record, "pane_columns");
  return {
    pane_id: paneId,
    id,
    is_plugin: isPlugin,
    title: stringField(record, "title") ?? paneId,
    ...(tabId !== undefined ? { tab_id: String(tabId) } : {}),
    ...(tabPosition !== undefined ? { tab_position: tabPosition } : {}),
    ...(tabName !== undefined ? { tab_name: tabName } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(focused !== undefined ? { focused } : {}),
    ...(floating !== undefined ? { floating } : {}),
    ...(exited !== undefined ? { exited } : {}),
    ...(held !== undefined ? { held } : {}),
    ...(rows !== undefined ? { rows } : {}),
    ...(columns !== undefined ? { columns } : {}),
  };
}

function agentRoomPaneTitle(agentId: string): string {
  return `${AGENTROOM_PANE_TITLE_PREFIX}${agentId}`;
}

function agentRoomAgentIdForPane(pane: ZellijPaneInfo): string | undefined {
  if (pane.title.startsWith(AGENTROOM_PANE_TITLE_PREFIX)) {
    return pane.title.slice(AGENTROOM_PANE_TITLE_PREFIX.length);
  }
  return agentRoomAgentIdFromCommand(pane.command);
}

function agentRoomAgentIdFromCommand(
  command: string | undefined,
): string | undefined {
  if (!command) return undefined;
  const match = command.match(
    /(?:^|\s)AGENTROOM_AGENT_ID=(?:'([^']+)'|"([^"]+)"|([^\s]+))/,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function zellijCommandVector(
  env: Record<string, string>,
  command: string,
  args: string[],
): string[] {
  const assignments = Object.entries(env).map(
    ([key, value]) => `${key}=${value}`,
  );
  if (args.length === 0 || /\s/.test(command)) {
    return ["env", ...assignments, "sh", "-lc", shellCommand(command, args)];
  }
  return ["env", ...assignments, command, ...args];
}

function shellCommand(command: string, args: string[]): string {
  if (args.length === 0) return command;
  return [command, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function parseCreatedPaneId(stdout: string): string | undefined {
  const match = stdout.match(/\b(?:terminal|plugin)_\d+\b/);
  return match?.[0];
}

function normalizePaneId(value: string): string {
  return /^\d+$/.test(value) ? `terminal_${value}` : value;
}

function isPaneId(value: string): boolean {
  return /^\d+$/.test(value) || /^(?:terminal|plugin)_\d+$/.test(value);
}

function isZellijUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("not found") ||
    message.includes("No active zellij sessions") ||
    message.includes("No active session") ||
    message.includes("There is no active session") ||
    (message.includes("Session") && message.includes("not found"))
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanField(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}
