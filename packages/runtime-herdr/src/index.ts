export * from "./socketClient.js";
import { execFile } from "node:child_process";
import { basename } from "node:path";
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
const AGENTROOM_WORKSPACE_LABEL_PREFIX = "agentroom:";
const DEFAULT_HERDR_LAYOUT: Required<HerdrLayoutOptions> = {
  mode: "workspace-per-agent",
  panesPerTab: 2,
  split: "largest",
  balance: true,
  workspace: "",
};

export type HerdrCommandRunner = (
  args: string[],
  options?: { env?: Record<string, string> },
) => Promise<string>;

export interface HerdrRuntimeProviderOptions {
  id?: string;
  cli?: string;
  session?: string;
  layout?: HerdrLayoutOptions;
  runner?: HerdrCommandRunner;
}

export type HerdrLayoutMode =
  | "workspace-per-agent"
  | "tab-per-agent"
  | "pane-grid";
export type HerdrSplitStrategy = "largest" | "focused";

export interface HerdrLayoutOptions {
  mode?: HerdrLayoutMode;
  workspace?: string;
  panesPerTab?: number;
  split?: HerdrSplitStrategy;
  balance?: boolean;
}

export class HerdrRuntimeProvider implements RuntimeProvider {
  readonly id: string;
  readonly kind = "herdr" as const;
  readonly capabilities: RuntimeCapabilities = {
    startAgent: true,
    stopAgent: true,
    readOutput: true,
    sendInput: true,
    sendKeys: true,
    attachInteractive: true,
    subscribeEvents: false,
    semanticAgentState: true,
    screenshots: false,
    fileMounts: false,
    worktrees: true,
    remoteExecution: false,
    adoptAgent: true,
  };

  private readonly cli: string;
  private readonly session: string | undefined;
  private readonly layout: Required<HerdrLayoutOptions>;
  private readonly runner: HerdrCommandRunner;

  constructor(options: HerdrRuntimeProviderOptions = {}) {
    this.id = options.id ?? "local-herdr";
    this.cli = options.cli ?? "herdr";
    this.session = options.session;
    this.layout = { ...DEFAULT_HERDR_LAYOUT, ...(options.layout ?? {}) };
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
          metadata: this.statusMetadata(stdout),
        };
      }
      return {
        ok: true,
        status: "ok",
        message: stdout.trim() || "herdr status ok",
        metadata: this.statusMetadata(stdout),
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
    let metadata = this.baseMetadata();
    try {
      metadata = this.statusMetadata(await this.run(["status"]));
    } catch {
      // Keep session enumeration available even when the server is offline.
    }
    const session = this.session ?? "default";
    return [{ id: session, name: session, metadata }];
  }

  async listAgents(): Promise<RuntimeAgent[]> {
    try {
      const workspaces = await this.listWorkspaces();
      const workspaceLabels = new Map(
        workspaces.map((workspace) => [
          workspace.workspace_id,
          workspace.label,
        ]),
      );
      const panes = await this.listPanes();
      return panes.map((pane) => normalizeHerdrPane(pane, workspaceLabels));
    } catch (error) {
      if (!isHerdrUnavailableError(error)) throw error;
      return [];
    }
  }

  async startAgent(request: StartAgentRequest): Promise<RuntimeAgent> {
    switch (this.layout.mode) {
      case "workspace-per-agent":
        return this.startAgentInDedicatedWorkspace(request);
      case "tab-per-agent":
        return this.startAgentInDedicatedTab(request);
      case "pane-grid":
        return this.startAgentInPaneGrid(request);
    }
  }

  private async startAgentInDedicatedWorkspace(
    request: StartAgentRequest,
  ): Promise<RuntimeAgent> {
    const cwd = request.cwd ?? request.harness.cwd ?? process.cwd();
    const created = await this.createWorkspace(
      cwd,
      agentRoomWorkspaceLabel(request.agentId),
    );
    const pane =
      created.rootPane ??
      (await this.primaryPaneForWorkspace(created.workspace.workspace_id));

    await this.runAgentCommand(pane.pane_id, request);

    return {
      id: request.agentId,
      bindingId: pane.pane_id,
      displayName: request.displayName ?? request.agentId,
      state: "starting",
      sessionId: created.workspace.workspace_id,
      metadata: {
        workspaceId: created.workspace.workspace_id,
        tabId: pane.tab_id,
        layoutMode: "workspace-per-agent",
      },
    };
  }

  private async startAgentInDedicatedTab(
    request: StartAgentRequest,
  ): Promise<RuntimeAgent> {
    const cwd = request.cwd ?? request.harness.cwd ?? process.cwd();
    const workspaceLabel =
      request.workspace || this.layout.workspace || workspaceLabelForCwd(cwd);
    const workspace = await this.ensureWorkspace(workspaceLabel, cwd);
    const created = await this.createTab(
      workspace.workspace_id,
      cwd,
      request.agentId,
    );
    const pane =
      created.rootPane ?? (await this.primaryPaneForTab(created.tab.tab_id));

    await this.runAgentCommand(pane.pane_id, request);

    return {
      id: request.agentId,
      bindingId: pane.pane_id,
      displayName: request.displayName ?? request.agentId,
      state: "starting",
      sessionId: workspace.workspace_id,
      metadata: {
        workspaceId: workspace.workspace_id,
        workspaceLabel,
        cwd,
        tabId: created.tab.tab_id,
        layoutMode: "tab-per-agent",
      },
    };
  }

  private async startAgentInPaneGrid(
    request: StartAgentRequest,
  ): Promise<RuntimeAgent> {
    const cwd = request.cwd ?? request.harness.cwd ?? process.cwd();
    const workspaceLabel =
      request.workspace || this.layout.workspace || workspaceLabelForCwd(cwd);
    const workspace = await this.ensureWorkspace(workspaceLabel, cwd);
    const panesPerTab = Math.max(1, this.layout.panesPerTab);
    const placement = await this.nextPaneGridPlacement(
      workspace.workspace_id,
      cwd,
      request.agentId,
      panesPerTab,
    );

    await this.runAgentCommand(placement.pane.pane_id, request);

    return {
      id: request.agentId,
      bindingId: placement.pane.pane_id,
      displayName: request.displayName ?? request.agentId,
      state: "starting",
      sessionId: workspace.workspace_id,
      metadata: {
        workspaceId: workspace.workspace_id,
        workspaceLabel,
        cwd,
        tabId: placement.tab.tab_id,
        layoutMode: "pane-grid",
      },
    };
  }

  async adoptAgent(request: AdoptAgentRequest): Promise<RuntimeAgent> {
    const pane = await this.getPane(request.bindingId);
    return {
      id: request.agentId,
      bindingId: pane.pane_id,
      displayName: request.displayName ?? request.agentId,
      state:
        pane.agent_status && isAgentState(pane.agent_status)
          ? pane.agent_status
          : "online",
      ...(pane.workspace_id ? { sessionId: pane.workspace_id } : {}),
      metadata: {
        ...(pane.workspace_id ? { workspaceId: pane.workspace_id } : {}),
        ...(pane.tab_id ? { tabId: pane.tab_id } : {}),
        adopted: true,
        ...(request.metadata ?? {}),
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

  async sendKeys(request: SendKeysRequest): Promise<void> {
    const paneId =
      request.bindingId ?? (await this.resolvePaneId(request.agentId));
    // herdr's `pane send-keys` takes one named key per invocation; send the
    // sequence in order so the foreground TUI sees each keypress discretely.
    for (const key of request.keys) {
      await this.run(["pane", "send-keys", paneId, key]);
    }
  }

  async attach(agentId: string): Promise<void> {
    const pane =
      (await this.tryGetPane(agentId)) ??
      (await this.getPane(await this.resolvePaneId(agentId)));
    if (pane.workspace_id)
      await this.run(["workspace", "focus", pane.workspace_id]);
  }

  private async runAgentCommand(
    paneId: string,
    request: StartAgentRequest,
  ): Promise<void> {
    // `pane run` types the launch command into the pane's foreground program.
    // If the pane already runs an agent, the command would be swallowed as that
    // agent's input (and the launched harness would never start with AGENTROOM_*
    // env). Refuse loudly instead of silently misfiring.
    await this.assertPaneFree(paneId, request.agentId);
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

    await this.run(["pane", "run", paneId, command]);
  }

  private async assertPaneFree(paneId: string, agentId: string): Promise<void> {
    const pane = await this.tryGetPane(paneId);
    if (pane && !isReusableShellPane(pane)) {
      throw new Error(
        `Herdr pane ${paneId} already has agent '${pane.agent}' running; ` +
          `refusing to launch ${agentId} into an occupied pane (the command would ` +
          `be delivered as input to the running program instead of starting a new ` +
          `enrolled process). Free the pane or use a layout that allocates a fresh pane.`,
      );
    }
  }

  private async ensureWorkspace(
    label: string,
    cwd: string,
  ): Promise<HerdrWorkspaceInfo> {
    const existing = (await this.listWorkspaces()).find(
      (workspace) => workspace.label === label,
    );
    if (existing) return existing;
    return (await this.createWorkspace(cwd, label)).workspace;
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
      ["workspace_created", "workspace_info"],
    );
    return {
      workspace: normalizeWorkspaceInfo(result.workspace),
      ...(result.root_pane
        ? { rootPane: normalizePaneInfo(result.root_pane) }
        : {}),
    };
  }

  private async createTab(
    workspaceId: string,
    cwd: string,
    label: string,
  ): Promise<HerdrTabCreated> {
    const result = parseHerdrResult<{
      tab?: unknown;
      root_pane?: unknown;
    }>(
      await this.run([
        "tab",
        "create",
        "--workspace",
        workspaceId,
        "--cwd",
        cwd,
        "--label",
        label,
        "--no-focus",
      ]),
      ["tab_created", "tab_info"],
    );

    if ("tab_id" in asRecord(result)) {
      const tab = normalizeTabInfo(result);
      return { tab, rootPane: await this.primaryPaneForTab(tab.tab_id) };
    }

    return {
      tab: normalizeTabInfo(result.tab),
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

  private async listTabs(workspaceId: string): Promise<HerdrTabInfo[]> {
    const result = parseHerdrResult<{ tabs?: unknown[] }>(
      await this.run(["tab", "list", "--workspace", workspaceId]),
      "tab_list",
    );
    return (result.tabs ?? []).map(normalizeTabInfo);
  }

  private async renameTab(tabId: string, label: string): Promise<void> {
    await this.run(["tab", "rename", tabId, label]);
  }

  private async balanceTab(tabId: string): Promise<void> {
    await this.run(["tab", "balance", tabId]);
  }

  private async splitPane(
    paneId: string,
    cwd: string,
    direction: "right" | "down",
  ): Promise<HerdrPaneInfo> {
    const result = parseHerdrResult<{ pane?: unknown }>(
      await this.run([
        "pane",
        "split",
        paneId,
        "--direction",
        direction,
        "--cwd",
        cwd,
        "--no-focus",
      ]),
      "pane_info",
    );
    if ("pane_id" in asRecord(result)) return normalizePaneInfo(result);
    return normalizePaneInfo(result.pane);
  }

  private async getPane(paneId: string): Promise<HerdrPaneInfo> {
    const result = parseHerdrResult<{ pane?: unknown }>(
      await this.run(["pane", "get", paneId]),
      "pane_info",
    );
    if ("pane_id" in asRecord(result)) return normalizePaneInfo(result);
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

  private async primaryPaneForTab(tabId: string): Promise<HerdrPaneInfo> {
    const workspaceId = tabId.split(":")[0];
    if (!workspaceId) throw new Error(`Invalid Herdr tab id: ${tabId}`);
    const panes = (await this.listPanes(workspaceId)).filter(
      (pane) => pane.tab_id === tabId,
    );
    const pane = panes.find((candidate) => candidate.focused) ?? panes[0];
    if (!pane) throw new Error(`Herdr tab has no panes: ${tabId}`);
    return pane;
  }

  private async nextPaneGridPlacement(
    workspaceId: string,
    cwd: string,
    agentId: string,
    panesPerTab: number,
  ): Promise<{ tab: HerdrTabInfo; pane: HerdrPaneInfo }> {
    const tabs = await this.listTabs(workspaceId);
    const panes = await this.listPanes(workspaceId);

    // Always launch into a FRESHLY allocated pane; never reuse a pre-existing one.
    // `pane run` types the launch command into whatever foreground program the pane
    // is running, and Herdr only reports *detected coding agents* (`pane.agent`) —
    // so a pane running the dashboard TUI, an editor, a REPL, or an un-detected
    // agent looks "idle" yet would swallow the command (and the harness would never
    // start with AGENTROOM_* env). Splitting an existing tab or opening a new tab
    // both yield a brand-new shell at a clean prompt.

    // Prefer a tab that still has capacity: split it to add a new, empty pane.
    const tabWithCapacity = tabs.find(
      (candidate) => panesForTab(panes, candidate.tab_id).length < panesPerTab,
    );
    if (tabWithCapacity) {
      const tabPanes = panesForTab(panes, tabWithCapacity.tab_id);
      await this.labelTabForAgent(tabWithCapacity, tabPanes.length, agentId);
      // A tab just created elsewhere can show 0 panes in this stale snapshot; its
      // root pane is itself fresh, so use it directly.
      if (tabPanes.length === 0) {
        return {
          tab: tabWithCapacity,
          pane: await this.primaryPaneForTab(tabWithCapacity.tab_id),
        };
      }
      const newPane = await this.splitPane(
        selectSplitTarget(tabPanes, this.layout.split).pane_id,
        cwd,
        splitDirectionForNextPane(tabPanes.length),
      );
      if (this.layout.balance) await this.balanceTab(tabWithCapacity.tab_id);
      return { tab: tabWithCapacity, pane: newPane };
    }

    // Every tab is full — open a new tab whose root pane is freshly spawned.
    const created = await this.createTab(workspaceId, cwd, agentId);
    return {
      tab: created.tab,
      pane:
        created.rootPane ?? (await this.primaryPaneForTab(created.tab.tab_id)),
    };
  }

  private async labelTabForAgent(
    tab: HerdrTabInfo,
    paneCount: number,
    agentId: string,
  ): Promise<void> {
    if (paneCount <= 1 && isDefaultTabLabel(tab.label)) {
      await this.renameTab(tab.tab_id, agentId);
    } else if (!tabLabelContains(tab.label, agentId)) {
      await this.renameTab(tab.tab_id, combinedTabLabel(tab.label, agentId));
    }
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

  private baseMetadata(socketPath?: string): Record<string, unknown> {
    return {
      session: this.session ?? "default",
      cli: this.cli,
      layoutMode: this.layout.mode,
      panesPerTab: this.layout.panesPerTab,
      split: this.layout.split,
      balance: this.layout.balance,
      ...(this.layout.workspace
        ? { workspaceLabel: this.layout.workspace }
        : {}),
      ...(socketPath ? { socketPath } : {}),
    };
  }

  private statusMetadata(statusText: string): Record<string, unknown> {
    return this.baseMetadata(parseStatusField(statusText, "socket"));
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

interface HerdrTabInfo {
  tab_id: string;
  workspace_id?: string;
  label?: string;
  pane_count?: number;
  focused?: boolean;
  metadata?: Record<string, unknown>;
}

interface HerdrTabCreated {
  tab: HerdrTabInfo;
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

function parseHerdrResult<T>(
  text: string,
  expectedType: string | readonly string[],
): T {
  const parsed = parseJson(text);
  if (parsed && typeof parsed === "object") {
    const expected = Array.isArray(expectedType)
      ? expectedType
      : [expectedType];
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
    if (!expected.includes(String(result.type))) {
      throw new Error(
        `Unexpected Herdr response type: ${String(result.type ?? "unknown")}`,
      );
    }
    return result as T;
  }

  throw new Error("Herdr command did not return JSON");
}

function parseStatusField(text: string, field: string): string | undefined {
  const prefix = `${field}:`;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length).trim() || undefined;
    }
  }
  return undefined;
}

function isHerdrUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("status: not running") ||
    message.includes("No such file or directory") ||
    message.includes("ENOENT") ||
    message.includes("ECONNREFUSED")
  );
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

function normalizeTabInfo(input: unknown): HerdrTabInfo {
  const value = asRecord(input);
  const tabId = stringField(value, "tab_id");
  if (!tabId) throw new Error("Herdr tab is missing tab_id");
  const workspaceId = stringField(value, "workspace_id");
  const label = stringField(value, "label");
  return {
    tab_id: tabId,
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    ...(label ? { label } : {}),
    ...(typeof value.pane_count === "number"
      ? { pane_count: value.pane_count }
      : {}),
    ...(typeof value.focused === "boolean" ? { focused: value.focused } : {}),
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

function panesForTab(panes: HerdrPaneInfo[], tabId: string): HerdrPaneInfo[] {
  return panes.filter((pane) => pane.tab_id === tabId);
}

function isReusableShellPane(pane: HerdrPaneInfo): boolean {
  return (
    pane.agent === undefined &&
    (pane.agent_status === undefined || pane.agent_status === "unknown")
  );
}

function isDefaultTabLabel(label?: string): boolean {
  return label === undefined || /^\d+$/.test(label);
}

function tabLabelContains(label: string | undefined, agentId: string): boolean {
  return (label ?? "").split("/").includes(agentId);
}

function combinedTabLabel(label: string | undefined, agentId: string): string {
  return isDefaultTabLabel(label) ? agentId : `${label}/${agentId}`;
}

function selectSplitTarget(
  panes: HerdrPaneInfo[],
  strategy: HerdrSplitStrategy,
): HerdrPaneInfo {
  const pane =
    strategy === "focused"
      ? (panes.find((candidate) => candidate.focused) ?? panes[0])
      : panes[0];
  if (!pane) throw new Error("Cannot split an empty Herdr tab");
  return pane;
}

function splitDirectionForNextPane(
  existingPaneCount: number,
): "right" | "down" {
  return existingPaneCount % 2 === 1 ? "right" : "down";
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
    metadata: {
      ...(input.metadata ?? {}),
      ...(workspaceLabel ? { workspaceLabel } : {}),
    },
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

function workspaceLabelForCwd(cwd: string): string {
  const label = basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return label || "workspace";
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
