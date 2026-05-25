import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  nowIso,
  type AgentOutput,
  type ReadAgentRequest,
  type RuntimeAgent,
  type RuntimeCapabilities,
  type RuntimeHealth,
  type RuntimeProvider,
  type RuntimeSession,
  type SendInputRequest,
  type StartAgentRequest,
} from "@agentroom/core";

const execFileAsync = promisify(execFile);
const AGENTROOM_WORKSPACE_LABEL_PREFIX = "agentroom:";

export type HerdrCommandRunner = (
  args: string[],
  options?: { env?: Record<string, string> },
) => Promise<string>;

export interface HerdrRuntimeProviderOptions {
  id?: string;
  cli?: string;
  session?: string;
  runner?: HerdrCommandRunner;
}

export class HerdrRuntimeProvider implements RuntimeProvider {
  readonly id: string;
  readonly kind = "herdr" as const;
  readonly capabilities: RuntimeCapabilities = {
    startAgent: true,
    stopAgent: true,
    readOutput: true,
    sendInput: true,
    attachInteractive: true,
    subscribeEvents: false,
    semanticAgentState: true,
    screenshots: false,
    fileMounts: false,
    worktrees: true,
    remoteExecution: false,
  };

  private readonly cli: string;
  private readonly session: string | undefined;
  private readonly runner: HerdrCommandRunner;

  constructor(options: HerdrRuntimeProviderOptions = {}) {
    this.id = options.id ?? "local-herdr";
    this.cli = options.cli ?? "herdr";
    this.session = options.session;
    this.runner = options.runner ?? this.execHerdr.bind(this);
  }

  async health(): Promise<RuntimeHealth> {
    try {
      const stdout = await this.run(["status"]);
      if (stdout.includes("status: not running")) {
        return {
          ok: false,
          status: "offline",
          message: stdout.trim() || "herdr server is not running",
        };
      }
      return {
        ok: true,
        status: "ok",
        message: stdout.trim() || "herdr status ok",
      };
    } catch (error) {
      return {
        ok: false,
        status: "offline",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listSessions(): Promise<RuntimeSession[]> {
    // Herdr session enumeration differs by install/context. Keep this conservative for now.
    return [{ id: this.session ?? "default", name: this.session ?? "default" }];
  }

  async listAgents(): Promise<RuntimeAgent[]> {
    const workspaces = await this.listWorkspaces();
    const workspaceLabels = new Map(
      workspaces.map((workspace) => [workspace.workspace_id, workspace.label]),
    );
    const panes = await this.listPanes();
    return panes.map((pane) => normalizeHerdrPane(pane, workspaceLabels));
  }

  async startAgent(request: StartAgentRequest): Promise<RuntimeAgent> {
    const cwd = request.cwd ?? request.harness.cwd ?? process.cwd();
    const created = await this.createWorkspace(
      cwd,
      agentRoomWorkspaceLabel(request.agentId),
    );
    const pane =
      created.rootPane ??
      (await this.primaryPaneForWorkspace(created.workspace.workspace_id));
    const command = shellCommand(
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

    await this.run(["pane", "run", pane.pane_id, command]);

    return {
      id: request.agentId,
      bindingId: pane.pane_id,
      displayName: request.displayName ?? request.agentId,
      state: "starting",
      sessionId: created.workspace.workspace_id,
      metadata: {
        workspaceId: created.workspace.workspace_id,
        tabId: pane.tab_id,
      },
    };
  }

  async stopAgent(agentId: string): Promise<void> {
    await this.run(["pane", "close", await this.resolvePaneId(agentId)]);
  }

  async readAgent(request: ReadAgentRequest): Promise<AgentOutput> {
    const paneId =
      request.bindingId ?? (await this.resolvePaneId(request.agentId));
    const stdout = await this.run([
      "pane",
      "read",
      paneId,
      "--source",
      request.source ?? "recent",
      "--lines",
      String(request.lines ?? 80),
    ]);

    return {
      agentId: request.agentId,
      bindingId: paneId,
      text: stdout,
      lineCount: stdout.split("\n").filter(Boolean).length,
      observedAt: nowIso(),
    };
  }

  async sendInput(request: SendInputRequest): Promise<void> {
    const paneId =
      request.bindingId ?? (await this.resolvePaneId(request.agentId));
    await this.run(["pane", "send-text", paneId, request.text]);
    if (request.submit !== false) {
      await this.run(["pane", "send-keys", paneId, "Enter"]);
    }
  }

  async attach(agentId: string): Promise<void> {
    const pane = await this.getPane(await this.resolvePaneId(agentId));
    if (pane.workspace_id)
      await this.run(["workspace", "focus", pane.workspace_id]);
  }

  private async createWorkspace(
    cwd: string,
    label: string,
  ): Promise<HerdrWorkspaceCreated> {
    const result = parseHerdrResult<{
      workspace?: unknown;
      root_pane?: unknown;
    }>(
      await this.run([
        "workspace",
        "create",
        "--cwd",
        cwd,
        "--label",
        label,
        "--no-focus",
      ]),
      "workspace_created",
    );
    return {
      workspace: normalizeWorkspaceInfo(result.workspace),
      ...(result.root_pane
        ? { rootPane: normalizePaneInfo(result.root_pane) }
        : {}),
    };
  }

  private async listWorkspaces(): Promise<HerdrWorkspaceInfo[]> {
    const result = parseHerdrResult<{ workspaces?: unknown[] }>(
      await this.run(["workspace", "list"]),
      "workspace_list",
    );
    return (result.workspaces ?? []).map(normalizeWorkspaceInfo);
  }

  private async listPanes(workspaceId?: string): Promise<HerdrPaneInfo[]> {
    const args = workspaceId
      ? ["pane", "list", "--workspace", workspaceId]
      : ["pane", "list"];
    const result = parseHerdrResult<{ panes?: unknown[] }>(
      await this.run(args),
      "pane_list",
    );
    return (result.panes ?? []).map(normalizePaneInfo);
  }

  private async getPane(paneId: string): Promise<HerdrPaneInfo> {
    const result = parseHerdrResult<{ pane?: unknown }>(
      await this.run(["pane", "get", paneId]),
      "pane_info",
    );
    return normalizePaneInfo(result.pane);
  }

  private async primaryPaneForWorkspace(
    workspaceId: string,
  ): Promise<HerdrPaneInfo> {
    const panes = await this.listPanes(workspaceId);
    const pane = panes.find((candidate) => candidate.focused) ?? panes[0];
    if (!pane) throw new Error(`Herdr workspace has no panes: ${workspaceId}`);
    return pane;
  }

  private async resolvePaneId(agentIdOrPaneId: string): Promise<string> {
    const direct = await this.tryGetPane(agentIdOrPaneId);
    if (direct) return direct.pane_id;

    const workspaces = await this.listWorkspaces();
    const workspace = workspaces.find(
      (candidate) =>
        candidate.label === agentRoomWorkspaceLabel(agentIdOrPaneId) ||
        candidate.label === agentIdOrPaneId,
    );
    if (workspace)
      return (await this.primaryPaneForWorkspace(workspace.workspace_id))
        .pane_id;

    const panes = await this.listPanes();
    const pane = panes.find((candidate) => candidate.agent === agentIdOrPaneId);
    return pane?.pane_id ?? agentIdOrPaneId;
  }

  private async tryGetPane(paneId: string): Promise<HerdrPaneInfo | undefined> {
    try {
      return await this.getPane(paneId);
    } catch {
      return undefined;
    }
  }

  private async run(
    args: string[],
    options: { env?: Record<string, string> } = {},
  ): Promise<string> {
    const finalArgs = this.session
      ? ["--session", this.session, ...args]
      : args;
    return this.runner(finalArgs, options);
  }

  private async execHerdr(
    args: string[],
    options: { env?: Record<string, string> } = {},
  ): Promise<string> {
    const { stdout } = await execFileAsync(this.cli, args, {
      env: { ...process.env, ...(options.env ?? {}) },
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }
}

interface HerdrWorkspaceInfo {
  workspace_id: string;
  label?: string;
  active_tab_id?: string;
  agent_status?: string;
  metadata?: Record<string, unknown>;
}

interface HerdrWorkspaceCreated {
  workspace: HerdrWorkspaceInfo;
  rootPane?: HerdrPaneInfo;
}

interface HerdrPaneInfo {
  pane_id: string;
  workspace_id?: string;
  tab_id?: string;
  cwd?: string;
  agent?: string;
  agent_status?: string;
  focused?: boolean;
  metadata?: Record<string, unknown>;
}

function parseHerdrResult<T>(text: string, expectedType: string): T {
  const parsed = parseJson(text);
  if (parsed && typeof parsed === "object") {
    const envelope = parsed as {
      result?: unknown;
      error?: { code?: string; message?: string };
    };
    if (envelope.error) {
      throw new Error(
        envelope.error.message ?? envelope.error.code ?? "Herdr command failed",
      );
    }

    const result = asRecord(envelope.result ?? parsed);
    if (result.type !== expectedType) {
      throw new Error(
        `Unexpected Herdr response type: ${String(result.type ?? "unknown")}`,
      );
    }
    return result as T;
  }

  throw new Error("Herdr command did not return JSON");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalizeWorkspaceInfo(input: unknown): HerdrWorkspaceInfo {
  const value = asRecord(input);
  const workspaceId = stringField(value, "workspace_id");
  if (!workspaceId) throw new Error("Herdr workspace is missing workspace_id");
  const label = stringField(value, "label");
  const activeTabId = stringField(value, "active_tab_id");
  const agentStatus = stringField(value, "agent_status");
  return {
    workspace_id: workspaceId,
    ...(label ? { label } : {}),
    ...(activeTabId ? { active_tab_id: activeTabId } : {}),
    ...(agentStatus ? { agent_status: agentStatus } : {}),
    metadata: value,
  };
}

function normalizePaneInfo(input: unknown): HerdrPaneInfo {
  const value = asRecord(input);
  const paneId = stringField(value, "pane_id");
  if (!paneId) throw new Error("Herdr pane is missing pane_id");
  const workspaceId = stringField(value, "workspace_id");
  const tabId = stringField(value, "tab_id");
  const cwd = stringField(value, "cwd");
  const agent = stringField(value, "agent");
  const agentStatus = stringField(value, "agent_status");

  return {
    pane_id: paneId,
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    ...(tabId ? { tab_id: tabId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(agent ? { agent } : {}),
    ...(agentStatus ? { agent_status: agentStatus } : {}),
    ...(typeof value.focused === "boolean" ? { focused: value.focused } : {}),
    metadata: value,
  };
}

function normalizeHerdrPane(
  input: HerdrPaneInfo,
  workspaceLabels: Map<string, string | undefined>,
): RuntimeAgent {
  const workspaceLabel = input.workspace_id
    ? workspaceLabels.get(input.workspace_id)
    : undefined;
  const agentId = workspaceLabel?.startsWith(AGENTROOM_WORKSPACE_LABEL_PREFIX)
    ? workspaceLabel.slice(AGENTROOM_WORKSPACE_LABEL_PREFIX.length)
    : input.pane_id;
  const state = input.agent_status ?? "unknown";

  return {
    id: agentId,
    bindingId: input.pane_id,
    displayName:
      agentId === input.pane_id ? (input.agent ?? input.pane_id) : agentId,
    state: isAgentState(state) ? state : "unknown",
    ...(input.workspace_id ? { sessionId: input.workspace_id } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object")
    return value as Record<string, unknown>;
  return {};
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function agentRoomWorkspaceLabel(agentId: string): string {
  return `${AGENTROOM_WORKSPACE_LABEL_PREFIX}${agentId}`;
}

function shellCommand(
  env: Record<string, string>,
  command: string,
  args: string[],
): string {
  return [
    "env",
    ...Object.entries(env).map(
      ([key, value]) => `${shellEnvKey(key)}=${shellQuote(value)}`,
    ),
    shellQuote(command),
    ...args.map(shellQuote),
  ].join(" ");
}

function shellEnvKey(key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    throw new Error(`Invalid environment variable name: ${key}`);
  return key;
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isAgentState(value: string): value is RuntimeAgent["state"] {
  return [
    "created",
    "starting",
    "online",
    "working",
    "waiting",
    "blocked",
    "needs-human",
    "reviewing",
    "done",
    "idle",
    "failed",
    "stopped",
    "unknown",
  ].includes(value);
}
