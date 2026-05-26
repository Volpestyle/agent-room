#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Editor,
  Input,
  ProcessTerminal,
  SelectList,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type OverlayHandle,
  type SelectItem,
  type SelectListTheme,
  type Terminal,
} from "@earendil-works/pi-tui";
import { maybeLoadAgentRoomConfigSync } from "@agentroom/config";
import { createApiClient, type ApiClient } from "./api.js";
import type {
  ActorRef,
  AgentRole,
  DaemonHealth,
  DashboardConfig,
  DashboardOperatorConfig,
  HarnessSpec,
  Message,
  RoomEvent,
  RuntimeAgent,
  RuntimeBinding,
  RuntimeProviderSummary,
  Task,
  TaskStatus,
} from "./types.js";

type ViewName =
  | "chat"
  | "overview"
  | "agents"
  | "tasks"
  | "messages"
  | "events";

export interface AgentRoomTuiOptions {
  baseUrl?: string;
  apiToken?: string;
  refreshMs?: number;
}

interface Snapshot {
  health?: DaemonHealth;
  providers: RuntimeProviderSummary[];
  providerAgents: Record<string, RuntimeAgent[]>;
  agents: RuntimeAgent[];
  tasks: Task[];
  messages: Message[];
  events: RoomEvent[];
  operatorBinding?: RuntimeBinding;
  output?: string;
  operatorOutput?: string;
  operatorTranscript?: ChatTurn[];
  operatorNotice?: string;
}

const VIEWS: ViewName[] = [
  "chat",
  "overview",
  "agents",
  "tasks",
  "messages",
  "events",
];
const TASK_STATUSES: TaskStatus[] = [
  "planned",
  "assigned",
  "claimed",
  "working",
  "blocked",
  "ready-for-review",
  "changes-requested",
  "approved",
  "merged",
  "done",
  "canceled",
];
const AGENT_ROLES: AgentRole[] = [
  "lead",
  "planner",
  "implementer",
  "reviewer",
  "runner",
  "qa",
  "observer",
  "custom",
];
const DEFAULT_OPERATOR_SESSION_DIR = ".agentroom/operator-sessions";

type OperatorBootstrapState = "pending" | "starting" | "ready" | "failed";

interface OperatorTarget {
  providerId: string;
  agentId: string;
}

type OperatorKind = HarnessSpec["kind"] | "clanky";

interface ResolvedOperatorConfig {
  agentId: string;
  displayName: string;
  kind?: OperatorKind;
  command?: string;
  cwd?: string;
  sessionDir: string;
  env?: Record<string, string>;
}

interface SlashCommandSpec {
  value: string;
  label: string;
  description: string;
  template?: string;
  run?: string;
}

interface ChatTurn {
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
}

const SLASH_COMMANDS: SlashCommandSpec[] = [
  {
    value: "/ask [agent] <text>",
    label: "ask agent",
    description: "Send input to the selected or named runtime agent",
    template: "/ask ",
  },
  {
    value: "/post [#channel] <text>",
    label: "post message",
    description: "Post a room message to a channel",
    template: "/post #announcements ",
  },
  {
    value: "/task <title>",
    label: "create task",
    description: "Create a local AgentRoom task",
    template: "/task ",
  },
  {
    value: "/rename [task] <title>",
    label: "rename task",
    description: "Rename the selected or named task",
    template: "/rename ",
  },
  {
    value: "/desc [task] <text|--clear>",
    label: "describe task",
    description: "Edit or clear a task description",
    template: "/desc ",
  },
  {
    value: "/status [task] <status> [summary]",
    label: "set status",
    description: "Move a task through the workflow",
    template: "/status ",
  },
  {
    value: "/claim [task] <agent>",
    label: "claim task",
    description: "Assign a task to an agent",
    template: "/claim ",
  },
  {
    value: "/cancel [task] [reason]",
    label: "cancel task",
    description: "Mark a task canceled without deleting it",
    template: "/cancel ",
  },
  {
    value: "/delete [task] [reason]",
    label: "delete task",
    description: "Remove a task from active room state",
    template: "/delete ",
  },
  {
    value: "/launch <agent> [role] [harness] [command...]",
    label: "launch agent",
    description: "Start a runtime-backed worker",
    template: "/launch ",
  },
  {
    value: "/operator [agent] [kind] [command...]",
    label: "restart operator",
    description: "Launch or relaunch the dashboard operator agent",
    template: "/operator ",
  },
  {
    value: "/provider <id>",
    label: "select provider",
    description: "Switch the active runtime provider",
    template: "/provider ",
  },
  {
    value: "/select <id>",
    label: "select item",
    description: "Select an agent, task, or message by id",
    template: "/select ",
  },
  {
    value: "/view <name>",
    label: "switch view",
    description: "Jump to chat, overview, agents, tasks, messages, or events",
    template: "/view ",
  },
  {
    value: "/actions",
    label: "actions",
    description: "Open actions for the current selection",
    run: "/actions",
  },
  {
    value: "/tasks",
    label: "tasks",
    description: "Open the task selector",
    run: "/tasks",
  },
  {
    value: "/agents",
    label: "agents",
    description: "Open the agent selector",
    run: "/agents",
  },
  {
    value: "/messages",
    label: "messages",
    description: "Open the message selector",
    run: "/messages",
  },
  {
    value: "/refresh",
    label: "refresh",
    description: "Reload daemon, runtime, task, message, and event state",
    run: "/refresh",
  },
  {
    value: "/palette",
    label: "palette",
    description: "Open the high-level operator action palette",
    run: "/palette",
  },
  {
    value: "/commands",
    label: "commands",
    description: "Browse these slash command templates",
    run: "/commands",
  },
  {
    value: "/help",
    label: "help",
    description: "Show operator input help and command templates",
    run: "/help",
  },
];

const RESET = "\x1b[0m";
const style = {
  bold: (text: string) => `\x1b[1m${text}${RESET}`,
  dim: (text: string) => `\x1b[2m${text}${RESET}`,
  cyan: (text: string) => `\x1b[36m${text}${RESET}`,
  green: (text: string) => `\x1b[32m${text}${RESET}`,
  amber: (text: string) => `\x1b[33m${text}${RESET}`,
  red: (text: string) => `\x1b[31m${text}${RESET}`,
  inverse: (text: string) => `\x1b[7m${text}${RESET}`,
};

const selectListTheme: SelectListTheme = {
  selectedPrefix: style.cyan,
  selectedText: style.inverse,
  description: style.dim,
  scrollInfo: style.dim,
  noMatch: style.dim,
};

const editorTheme: EditorTheme = {
  borderColor: style.dim,
  selectList: selectListTheme,
};

class SelectDialog implements Component {
  private readonly list: SelectList;

  public onSelect?: (item: SelectItem) => void;
  public onCancel?: () => void;

  constructor(
    private readonly title: string,
    items: SelectItem[],
    private readonly hint = "Up/Down or j/k, Enter to select, Esc to cancel",
  ) {
    this.list = new SelectList(
      items,
      Math.min(Math.max(items.length, 1), 12),
      selectListTheme,
      {
        minPrimaryColumnWidth: 18,
        maxPrimaryColumnWidth: 34,
      },
    );
    this.list.onSelect = (item) => this.onSelect?.(item);
    this.list.onCancel = () => this.onCancel?.();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "j")) {
      this.list.handleInput("\x1b[B");
      return;
    }
    if (matchesKey(data, "k")) {
      this.list.handleInput("\x1b[A");
      return;
    }
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 4);
    const title = truncateToWidth(` ${this.title} `, innerWidth, "");
    return [
      style.inverse(title),
      ...this.list.render(innerWidth),
      style.dim(this.hint),
    ].map((line) => padLine(line, innerWidth));
  }
}

class TextInputDialog implements Component {
  private readonly input = new Input();

  public onSubmit?: (value: string) => void;
  public onCancel?: () => void;

  constructor(
    private readonly title: string,
    private readonly hint = "Enter to submit, Esc to cancel",
    initialValue?: string,
  ) {
    if (initialValue !== undefined) this.input.setValue(initialValue);
    this.input.onSubmit = (value) => this.onSubmit?.(value);
    this.input.onEscape = () => this.onCancel?.();
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 4);
    return [
      style.inverse(truncateToWidth(` ${this.title} `, innerWidth, "")),
      ...this.input.render(innerWidth),
      style.dim(this.hint),
    ].map((line) => padLine(line, innerWidth));
  }
}

export async function runAgentRoomTui(
  options: AgentRoomTuiOptions = {},
): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);
  const client = createApiClient({
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.apiToken !== undefined ? { token: options.apiToken } : {}),
  });
  const app = new AgentRoomTuiApp(tui, terminal, client, options);

  tui.addChild(app);
  tui.setFocus(app);
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      app.dispose();
      tui.stop();
      process.exit(0);
    }
    return app.handleGlobalInput(data);
  });

  process.once("SIGINT", () => {
    app.dispose();
    tui.stop();
    process.exit(130);
  });

  await app.refresh();
  tui.start();
  app.start();
}

class AgentRoomTuiApp implements Component {
  public readonly editor: Editor;
  private readonly refreshMs: number;
  private refreshTimer: NodeJS.Timeout | undefined;
  private viewIndex = 0;
  private selectedProviderId: string | undefined;
  private activeAgentId: string | undefined;
  private selectedAgentIndex = 0;
  private selectedTaskIndex = 0;
  private selectedMessageIndex = Number.MAX_SAFE_INTEGER;
  private promptActive = false;
  private operatorConfig = dashboardOperatorConfig();
  private operatorBootstrapState: OperatorBootstrapState = "pending";
  private operatorBootstrapError: string | undefined;
  private operatorLaunchPromise: Promise<OperatorTarget> | undefined;
  private chatTurns: ChatTurn[] = [];
  private isRefreshing = false;
  private lastError: string | undefined;
  private notices: string[] = [];
  private snapshot: Snapshot = {
    providers: [],
    providerAgents: {},
    agents: [],
    tasks: [],
    messages: [],
    events: [],
  };

  constructor(
    private readonly tui: TUI,
    private readonly terminal: Terminal,
    private readonly client: ApiClient,
    options: AgentRoomTuiOptions,
  ) {
    this.refreshMs = options.refreshMs ?? 2500;
    this.editor = new Editor(tui, editorTheme, {
      paddingX: 1,
      autocompleteMaxVisible: 8,
    });
    this.editor.onSubmit = (value) => {
      this.leavePrompt(false);
      void this.submit(value);
    };
  }

  private get operatorAgentId(): string {
    return this.operatorConfig.agentId;
  }

  start(): void {
    this.enterPrompt();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, this.refreshMs);
    void this.bootstrapOperator();
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  handleGlobalInput(data: string): { consume?: boolean } | undefined {
    if (matchesKey(data, "ctrl+r")) {
      void this.refresh();
      return { consume: true };
    }

    if (this.tui.hasOverlay()) return undefined;

    if (this.promptActive) {
      if (matchesKey(data, "escape")) {
        this.leavePrompt();
        return { consume: true };
      }
      return undefined;
    }

    return this.handleBrowseInput(data) ?? { consume: true };
  }

  handleInput(data: string): void {
    if (this.promptActive || this.tui.hasOverlay()) return;
    this.handleBrowseInput(data);
  }

  private handleBrowseInput(data: string): { consume?: boolean } | undefined {
    if (
      matchesKey(data, "ctrl+n") ||
      matchesKey(data, "tab") ||
      matchesKey(data, "right")
    ) {
      this.changeView(1);
      return { consume: true };
    }
    if (
      matchesKey(data, "ctrl+p") ||
      matchesKey(data, "shift+tab") ||
      matchesKey(data, "left")
    ) {
      this.changeView(-1);
      return { consume: true };
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.changeSelection(-1);
      return { consume: true };
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.changeSelection(1);
      return { consume: true };
    }
    if (matchesKey(data, "pageUp")) {
      this.changeSelection(-8);
      return { consume: true };
    }
    if (matchesKey(data, "pageDown")) {
      this.changeSelection(8);
      return { consume: true };
    }
    if (matchesKey(data, "enter")) {
      this.showContextActions();
      return { consume: true };
    }
    if (matchesKey(data, "/")) {
      this.enterPrompt("/");
      return { consume: true };
    }
    if (this.currentView() === "chat" && isPlainTextInput(data)) {
      this.enterPrompt(data);
      return { consume: true };
    }
    if (matchesKey(data, "i")) {
      this.enterPrompt();
      return { consume: true };
    }
    if (matchesKey(data, "?")) {
      this.showCommandPalette();
      return { consume: true };
    }
    if (matchesKey(data, "v")) {
      this.showViewSelector();
      return { consume: true };
    }
    if (matchesKey(data, "n")) {
      this.showNewTaskInput();
      return { consume: true };
    }
    if (matchesKey(data, "p")) {
      this.enterPrompt("/post #announcements ");
      return { consume: true };
    }
    if (matchesKey(data, "1")) {
      this.setView("chat");
      return { consume: true };
    }
    if (matchesKey(data, "2")) {
      this.setView("overview");
      return { consume: true };
    }
    if (matchesKey(data, "3")) {
      this.setView("agents");
      return { consume: true };
    }
    if (matchesKey(data, "4")) {
      this.setView("tasks");
      return { consume: true };
    }
    if (matchesKey(data, "5")) {
      this.setView("messages");
      return { consume: true };
    }
    if (matchesKey(data, "6")) {
      this.setView("events");
      return { consume: true };
    }
    if (this.currentView() === "tasks") {
      if (matchesKey(data, "e")) {
        this.showRenameTaskInput();
        return { consume: true };
      }
      if (matchesKey(data, "d")) {
        this.showDeleteTaskInput();
        return { consume: true };
      }
      if (matchesKey(data, "s")) {
        this.showStatusSelector();
        return { consume: true };
      }
      if (matchesKey(data, "c")) {
        this.showClaimTaskInput();
        return { consume: true };
      }
    }
    return undefined;
  }

  async refresh(): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    this.tui.requestRender();
    const wasFollowingMessages =
      this.selectedMessageIndex >= this.snapshot.messages.length - 1;

    try {
      const [health, dashboardConfig] = await Promise.all([
        this.client.health(),
        this.loadDashboardConfig(),
      ]);
      this.applyDashboardConfig(dashboardConfig);
      const providers = await this.client.listRuntimeProviders();
      const providerRows = mergeProviderHealth(providers.providers, health);
      const providerAgents = await this.loadProviderAgents(providerRows);
      const selectedProviderId = this.nextSelectedProvider(
        providerRows,
        providerAgents,
      );
      this.selectedProviderId = selectedProviderId;

      const [tasks, messages, events, operatorBinding] = await Promise.all([
        this.client.listTasks(),
        this.client.listMessages(80),
        this.client.listEvents(100),
        this.loadRuntimeBinding(this.operatorAgentId),
      ]);

      const agents = selectedProviderId
        ? (providerAgents[selectedProviderId] ?? [])
        : [];
      const activeAgentIndex = this.activeAgentId
        ? agents.findIndex((agent) => agent.id === this.activeAgentId)
        : -1;
      if (activeAgentIndex >= 0) this.selectedAgentIndex = activeAgentIndex;
      const selectedAgent = agents[this.selectedAgentIndex] ?? agents[0];
      const output =
        selectedProviderId && selectedAgent
          ? await this.readAgentOutput(selectedProviderId, selectedAgent.id)
          : undefined;
      const operatorTarget =
        (operatorBinding
          ? {
              providerId: operatorBinding.providerId,
              agentId: this.operatorAgentId,
            }
          : undefined) ??
        this.operatorTargetFromEvents(events.events) ??
        this.operatorTargetFrom(providerAgents) ??
        (selectedProviderId
          ? { providerId: selectedProviderId, agentId: this.operatorAgentId }
          : undefined);
      const operatorOutput = operatorTarget
        ? await this.readAgentOutput(
            operatorTarget.providerId,
            operatorTarget.agentId,
          )
        : undefined;
      const operatorTranscript = loadPiSessionTranscript(
        operatorSessionDirs(this.operatorConfig),
      );
      const operatorNotice = operatorOutput
        ? operatorNoticeFromOutput(operatorOutput, this.operatorConfig)
        : undefined;

      this.snapshot = {
        health,
        providers: providerRows,
        providerAgents,
        agents,
        tasks: tasks.tasks,
        messages: messages.messages,
        events: events.events,
        ...(operatorBinding !== undefined ? { operatorBinding } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(operatorOutput !== undefined ? { operatorOutput } : {}),
        ...(operatorTranscript.length > 0 ? { operatorTranscript } : {}),
        ...(operatorNotice !== undefined ? { operatorNotice } : {}),
      };
      if (wasFollowingMessages && messages.messages.length > 0) {
        this.selectedMessageIndex = messages.messages.length - 1;
      }
      this.lastError = undefined;
      this.clampSelections();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.isRefreshing = false;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const fullWidth = Math.max(40, width);
    const promptLines = this.renderPrompt(fullWidth);
    const headerLines = this.renderHeader(fullWidth);
    const navLines = [this.renderNav(fullWidth)];
    const noticeLines = this.renderNotices(fullWidth);
    const footerLines = this.renderFooter(fullWidth);
    const reserved =
      headerLines.length +
      navLines.length +
      noticeLines.length +
      footerLines.length +
      promptLines.length;
    const contentHeight = Math.max(4, this.terminal.rows - reserved);
    const contentLines = this.renderCurrentView(fullWidth, contentHeight);
    const lines = [
      ...headerLines,
      ...navLines,
      ...contentLines,
      ...noticeLines,
      ...footerLines,
      ...promptLines,
    ];

    return lines.map((line) => padLine(line, fullWidth));
  }

  private renderPrompt(width: number): string[] {
    if (this.promptActive) {
      return [section("chat"), ...this.editor.render(width)];
    }
    const operator = this.renderOperatorStatus();
    return [
      `${style.dim("operator")} ${operator}  ${style.dim("type to chat  / commands  esc dashboard keys")}`,
    ];
  }

  private renderHeader(width: number): string[] {
    const room = this.snapshot.health?.roomId ?? "offline";
    const daemon = this.snapshot.health?.ok
      ? style.green("online")
      : style.red("offline");
    const refresh = this.isRefreshing
      ? style.amber("refreshing")
      : style.dim("idle");
    return [
      padLine(
        `${style.bold("agent-room")} ${style.dim(this.client.base)}  room ${style.cyan(room)}  daemon ${daemon}  ${refresh}`,
        width,
      ),
      rule(width),
    ];
  }

  private renderNav(width: number): string {
    const parts = VIEWS.map((view, index) => {
      const label = ` ${view} `;
      return index === this.viewIndex ? style.inverse(label) : style.dim(label);
    });
    return truncateToWidth(parts.join(" "), width, "");
  }

  private renderCurrentView(width: number, height: number): string[] {
    const view = VIEWS[this.viewIndex] ?? "chat";
    const lines =
      view === "chat"
        ? this.renderChat(width)
        : view === "overview"
          ? this.renderOverview(width)
          : view === "agents"
            ? this.renderAgents(width)
            : view === "tasks"
              ? this.renderTasks(width)
              : view === "messages"
                ? this.renderMessages(width)
                : this.renderEvents(width);

    return view === "chat"
      ? fitTailLines(lines, width, height)
      : fitLines(lines, width, height);
  }

  private renderChat(width: number): string[] {
    const room = this.snapshot.health?.roomId ?? "offline";
    const activeTasks = this.snapshot.tasks.filter((task) =>
      [
        "assigned",
        "claimed",
        "working",
        "ready-for-review",
        "blocked",
      ].includes(task.status),
    );
    const transcriptTurns =
      this.snapshot.operatorTranscript &&
      this.snapshot.operatorTranscript.length > 0
        ? dedupeChatTurns(
            [...this.snapshot.operatorTranscript, ...this.chatTurns].sort(
              compareChatTurns,
            ),
          )
        : this.chatTurns;
    const noticeTurn = this.snapshot.operatorNotice
      ? [
          {
            role: "system" as const,
            text: this.snapshot.operatorNotice,
            createdAt: new Date().toISOString(),
          },
        ]
      : [];
    const roomTurns = this.snapshot.messages.slice(-6).map((message) => ({
      role: "system" as const,
      text: `${actorLabel(message.sender)} #${message.channelId ?? "announcements"}: ${message.body}`,
      createdAt: message.createdAt,
    }));
    const turns = [...transcriptTurns, ...noticeTurn, ...roomTurns]
      .slice(-14)
      .flatMap((turn) => renderChatTurn(turn, width));
    const statusLine = `${style.bold("operator")} ${this.renderOperatorStatus()}  ${style.dim(`room ${room}  active tasks ${activeTasks.length}  agents ${this.totalAgentCount()}`)}`;
    const transcript =
      turns.length > 0
        ? turns
        : [
            style.dim(
              "Ask the operator here, or use /commands for room actions.",
            ),
          ];

    return [statusLine, "", ...transcript];
  }

  private renderOverview(width: number): string[] {
    const activeTasks = this.snapshot.tasks.filter((task) =>
      [
        "assigned",
        "claimed",
        "working",
        "ready-for-review",
        "blocked",
      ].includes(task.status),
    );
    const totalAgents = this.totalAgentCount();
    const providerLines =
      this.snapshot.providers.length === 0
        ? [style.dim("no runtime providers loaded")]
        : this.snapshot.providers.map((provider) =>
            this.renderProviderLine(provider, width),
          );

    return [
      section("status"),
      `providers ${this.snapshot.providers.length}  agents ${totalAgents} total / ${this.snapshot.agents.length} selected  tasks ${this.snapshot.tasks.length}  messages ${this.snapshot.messages.length}`,
      `active tasks ${activeTasks.length}  events ${this.snapshot.events.length}`,
      `operator ${this.renderOperatorStatus()}`,
      "",
      section("providers"),
      ...providerLines,
      "",
      section("latest"),
      ...this.snapshot.events
        .slice(-8)
        .reverse()
        .map((event) => renderEvent(event, width)),
      ...emptyHint(this.snapshot.events, "no events recorded yet"),
    ];
  }

  private renderAgents(width: number): string[] {
    const providerLabel = this.selectedProviderId ?? "none";
    const selectedAgent = this.selectedAgent();
    const agents = this.snapshot.agents.length
      ? this.snapshot.agents.map((agent, index) => {
          const prefix = index === this.selectedAgentIndex ? "> " : "  ";
          const state = renderState(agent.state);
          const name = agent.displayName ?? agent.id;
          return `${prefix}${truncateToWidth(name, 24, "")} ${state} ${style.dim(agent.id)}`;
        })
      : [style.dim("no runtime agents")];
    const outputLines = (this.snapshot.output ?? "")
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(-Math.max(8, this.terminal.rows - 16));

    return [
      section(`provider ${providerLabel}`),
      ...this.snapshot.providers.map((provider) =>
        this.renderProviderLine(provider, width),
      ),
      "",
      section("agents"),
      ...agents,
      "",
      section(selectedAgent ? `output ${selectedAgent.id}` : "output"),
      ...outputLines.map((line) => truncateToWidth(line, width, "")),
      ...emptyHint(
        outputLines,
        "select or launch an agent to see output; use /provider <id> to switch",
      ),
    ];
  }

  private renderProviderLine(
    provider: RuntimeProviderSummary,
    width: number,
  ): string {
    const agents = this.snapshot.providerAgents[provider.id] ?? [];
    const selected = provider.id === this.selectedProviderId;
    const marker = selected ? "> " : "  ";
    const health = provider.health;
    const status =
      health === undefined
        ? style.dim("configured")
        : health.ok
          ? agents.length > 0
            ? style.green(
                `${agents.length} active ${plural(agents.length, "agent")}`,
              )
            : style.dim("available, no agents")
          : style.red(health.status ?? "offline");
    const message =
      health && !health.ok && health.message
        ? ` ${style.dim(normalizeSingleLine(health.message))}`
        : "";
    return truncateToWidth(
      `${marker}${provider.id} (${provider.kind}) ${status}${message}`,
      width,
      "",
    );
  }

  private renderTasks(width: number): string[] {
    const tasks = this.snapshot.tasks.length
      ? this.snapshot.tasks.map((task, index) => {
          const prefix = index === this.selectedTaskIndex ? "> " : "  ";
          const assignee = task.assignee?.id ?? "unassigned";
          const refCount = task.refs?.length ?? 0;
          const meta = `${task.id} ${assignee}${refCount > 0 ? ` ${refCount} refs` : ""}`;
          return `${prefix}${renderTaskStatus(task.status)} ${truncateToWidth(task.title, Math.max(18, width - 52), "")} ${style.dim(meta)}`;
        })
      : [style.dim("no tasks")];

    const selected = this.selectedTask();
    const selectedRefs = selected?.refs ?? [];
    return [
      section("tasks"),
      ...tasks,
      "",
      section("selected"),
      ...(selected
        ? [
            `${style.bold(selected.title)} ${style.dim(selected.id)}`,
            `status ${selected.status}  assignee ${selected.assignee?.id ?? "none"}`,
            `created ${formatDateTime(selected.createdAt)}  updated ${formatDateTime(selected.updatedAt)}`,
            ...(selectedRefs.length > 0
              ? [
                  `refs ${selectedRefs
                    .map((ref) => ref.label ?? `${ref.kind}:${ref.id}`)
                    .join(", ")}`,
                ]
              : []),
            ...(selected.description
              ? wrapTextWithAnsi(selected.description, width)
              : []),
          ]
        : [style.dim("no selected task")]),
    ];
  }

  private renderMessages(width: number): string[] {
    const { startIndex, messages } = this.visibleMessages();
    const selected = this.selectedMessage();
    return [
      section("messages"),
      ...messages.map((message, visibleIndex) => {
        const index = startIndex + visibleIndex;
        const prefix = index === this.selectedMessageIndex ? "> " : "  ";
        const channel = message.channelId ?? "announcements";
        const sender = actorLabel(message.sender);
        const head = `${prefix}${style.dim(message.createdAt.slice(11, 19))} ${style.cyan(sender)} ${style.dim(`#${channel}`)} ${renderImportance(message.importance)} `;
        return truncateToWidth(
          `${head}${message.body.replace(/\s+/g, " ")}`,
          width,
          "",
        );
      }),
      ...emptyHint(messages, "no messages"),
      "",
      section("selected message"),
      ...(selected
        ? [
            `${style.bold(actorLabel(selected.sender))} ${style.dim(selected.id)}`,
            `channel #${selected.channelId ?? "announcements"}  kind ${selected.kind}  importance ${selected.importance}  ${formatDateTime(selected.createdAt)}`,
            ...(selected.recipients?.length
              ? [`to ${selected.recipients.map(actorLabel).join(", ")}`]
              : []),
            ...wrapTextWithAnsi(selected.body, width),
          ]
        : [style.dim("no selected message")]),
    ];
  }

  private renderEvents(width: number): string[] {
    const events = this.snapshot.events.slice(-40).reverse();
    return [
      section("events"),
      ...events.map((event) => renderEvent(event, width)),
      ...emptyHint(events, "no events"),
    ];
  }

  private renderNotices(width: number): string[] {
    const notices = [
      ...(this.lastError ? [style.red(`error: ${this.lastError}`)] : []),
      ...this.notices.slice(-2).map(style.dim),
    ];
    if (notices.length === 0) return [];
    return [
      rule(width),
      ...notices.map((notice) => truncateToWidth(notice, width, "")),
    ];
  }

  private renderFooter(width: number): string[] {
    const selectedAgent = this.inputAgentId() ?? "none";
    const selectedTask = this.selectedTask()?.id ?? "none";
    const selectedMessage = this.selectedMessage()?.id ?? "none";
    return [
      rule(width),
      truncateToWidth(
        style.dim(
          `chat first  / commands  tab views  esc browse  selected ${selectedAgent} task ${selectedTask} msg ${selectedMessage}`,
        ),
        width,
        "",
      ),
    ];
  }

  private async submit(rawValue: string): Promise<void> {
    const value = rawValue.trim();
    if (!value) return;

    try {
      if (value.startsWith("/")) {
        await this.runCommand(value.slice(1));
      } else {
        await this.sendToOperator(value);
      }
      await this.refresh();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.tui.requestRender();
    } finally {
      if (!this.tui.hasOverlay() && this.currentView() === "chat") {
        this.enterPrompt();
      }
    }
  }

  private async runCommand(commandLine: string): Promise<void> {
    const [command, ...args] = splitArgs(commandLine);
    switch (command) {
      case undefined:
      case "":
      case "?":
      case "commands":
        this.showSlashCommandReference();
        return;
      case "palette":
        this.showCommandPalette();
        return;
      case "help":
        this.notice(
          "Plain text asks the dashboard operator. Slash commands run manual actions.",
        );
        this.showSlashCommandReference();
        return;
      case "refresh":
        await this.refresh();
        return;
      case "views":
        this.showViewSelector();
        return;
      case "actions":
        this.showContextActions();
        return;
      case "tasks":
        this.showTaskSelector();
        return;
      case "agents":
        this.showAgentSelector();
        return;
      case "messages":
        this.showMessageSelector();
        return;
      case "view":
        this.setView(args[0]);
        return;
      case "provider":
        this.selectProvider(args[0]);
        return;
      case "select":
        this.selectById(args[0]);
        return;
      case "post": {
        const first = args[0];
        const channel = first?.startsWith("#")
          ? first.slice(1)
          : "announcements";
        const body = first?.startsWith("#")
          ? args.slice(1).join(" ")
          : args.join(" ");
        await this.postMessage(channel, body);
        return;
      }
      case "ask":
      case "send": {
        const selected = this.inputAgentId();
        const target = args[0] && this.hasAgent(args[0]) ? args[0] : selected;
        const body =
          target === args[0] ? args.slice(1).join(" ") : args.join(" ");
        if (!target) {
          await this.sendToOperator(body);
          return;
        }
        await this.sendToAgent(target, body);
        return;
      }
      case "task": {
        const title = args.join(" ").trim();
        if (!title) throw new Error("Usage: /task <title>");
        await this.client.createTask({
          title,
          createdBy: humanActor(),
        });
        this.notice(`created task: ${title}`);
        return;
      }
      case "rename":
      case "title": {
        const target = this.resolveTaskCommandTarget(
          args,
          "Usage: /rename [taskId] <title>",
        );
        const title = target.rest.join(" ").trim();
        if (!title) throw new Error("Usage: /rename [taskId] <title>");
        await this.client.updateTaskDetails(target.task.id, {
          title,
          actor: humanActor(),
        });
        this.notice(`renamed ${target.task.id}`);
        return;
      }
      case "describe":
      case "desc": {
        const target = this.resolveTaskCommandTarget(
          args,
          "Usage: /desc [taskId] <description|--clear>",
        );
        const description = target.rest.join(" ").trim();
        if (!description) {
          throw new Error("Usage: /desc [taskId] <description|--clear>");
        }
        await this.client.updateTaskDetails(target.task.id, {
          description: description === "--clear" ? "" : description,
          actor: humanActor(),
        });
        this.notice(`updated description for ${target.task.id}`);
        return;
      }
      case "delete":
      case "del": {
        const target = this.resolveTaskCommandTarget(
          args,
          "Usage: /delete [taskId] [reason]",
        );
        const reason = target.rest.join(" ").trim();
        await this.client.deleteTask(target.task.id, {
          actor: humanActor(),
          ...(reason ? { reason } : {}),
        });
        this.notice(`deleted ${target.task.id}`);
        return;
      }
      case "cancel": {
        const target = this.resolveTaskCommandTarget(
          args,
          "Usage: /cancel [taskId] [reason]",
        );
        const reason = target.rest.join(" ").trim();
        await this.client.updateTaskStatus(target.task.id, {
          status: "canceled",
          actor: humanActor(),
          ...(reason ? { reason } : {}),
        });
        this.notice(`canceled ${target.task.id}`);
        return;
      }
      case "claim": {
        const target = this.resolveTaskCommandTarget(
          args,
          "Usage: /claim [taskId] <agentId>",
        );
        const [agentId] = target.rest;
        if (!agentId) throw new Error("Usage: /claim [taskId] <agentId>");
        await this.client.claimTask(target.task.id, {
          kind: "agent",
          id: agentId,
        });
        this.notice(`claimed ${target.task.id} for ${agentId}`);
        return;
      }
      case "status": {
        const target = this.resolveTaskCommandTarget(
          args,
          `Usage: /status [taskId] <${TASK_STATUSES.join("|")}> [summary]`,
        );
        const [status, ...summaryParts] = target.rest;
        if (!isTaskStatus(status)) {
          throw new Error(
            `Usage: /status [taskId] <${TASK_STATUSES.join("|")}> [summary]`,
          );
        }
        await this.client.updateTaskStatus(target.task.id, {
          status,
          actor: humanActor(),
          ...(summaryParts.length > 0
            ? { summary: summaryParts.join(" ") }
            : {}),
        });
        this.notice(`updated ${target.task.id} to ${status}`);
        return;
      }
      case "launch": {
        const [agentId, maybeRole, maybeHarness, ...rest] = args;
        if (!agentId)
          throw new Error(
            "Usage: /launch <agentId> [role] [harness] [command...]",
          );
        const role = isAgentRole(maybeRole) ? maybeRole : "implementer";
        const harness = isHarnessKind(maybeHarness) ? maybeHarness : "shell";
        const commandParts = rest.length > 0 ? rest : ["bash"];
        await this.launchAgent(agentId, role, {
          kind: harness,
          command: commandParts[0] ?? "bash",
          ...(commandParts.length > 1 ? { args: commandParts.slice(1) } : {}),
        });
        return;
      }
      case "operator": {
        const operator = operatorConfigForCommand(args, this.operatorConfig);
        this.activeAgentId = operator.agentId;
        await this.launchAgent(
          operator.agentId,
          "lead",
          operatorHarness(operator),
        );
        return;
      }
      default:
        throw new Error(`Unknown command: /${command}`);
    }
  }

  private async postMessage(channelId: string, body: string): Promise<void> {
    if (!body.trim()) throw new Error("Message body is required");
    await this.client.postMessage({
      channelId,
      body,
      sender: humanActor(),
      kind: "chat",
    });
    this.notice(`posted to #${channelId}`);
  }

  private async sendToOperator(text: string): Promise<void> {
    if (!text.trim()) throw new Error("Operator request is required");
    this.viewIndex = VIEWS.indexOf("chat");
    this.addChatTurn("user", text);
    const target = await this.ensureOperatorAgent();
    await this.sendToAgent(target.agentId, text, {
      providerId: target.providerId,
      notice: `asked operator ${target.agentId}`,
    });
  }

  private async sendToAgent(
    agentId: string,
    text: string,
    options: { providerId?: string; notice?: string | false } = {},
  ): Promise<void> {
    if (!text.trim()) throw new Error("Input text is required");
    const providerId =
      options.providerId ??
      this.providerIdForAgent(agentId) ??
      this.selectedProviderId;
    if (!providerId) throw new Error("No runtime provider selected");
    await this.client.sendRuntimeAgentInput(providerId, agentId, {
      text,
      submit: true,
    });
    if (options.notice !== false) {
      this.notice(options.notice ?? `sent input to ${agentId}`);
    }
  }

  private async launchAgent(
    agentId: string,
    role: AgentRole,
    harness: HarnessSpec,
  ): Promise<void> {
    const providerId = this.selectedProviderId;
    if (!providerId) throw new Error("No runtime provider selected");
    await this.client.launchRuntimeAgent(providerId, {
      agentId,
      role,
      harness,
    });
    this.activeAgentId = agentId;
    this.notice(`launched ${agentId}`);
  }

  private async readAgentOutput(
    providerId: string,
    agentId: string,
  ): Promise<string | undefined> {
    try {
      const { output } = await this.client.readRuntimeAgent(
        providerId,
        agentId,
        160,
      );
      return output.text;
    } catch {
      return undefined;
    }
  }

  private async bootstrapOperator(): Promise<void> {
    try {
      await this.ensureOperatorAgent({ quiet: true });
      await this.refresh();
    } catch (error) {
      this.operatorBootstrapState = "failed";
      this.operatorBootstrapError =
        error instanceof Error ? error.message : String(error);
      this.notice(`operator not started: ${this.operatorBootstrapError}`);
    }
  }

  private async ensureOperatorAgent(
    options: { quiet?: boolean } = {},
  ): Promise<OperatorTarget> {
    const existing = this.operatorTarget();
    if (existing) {
      this.operatorBootstrapState = "ready";
      this.operatorBootstrapError = undefined;
      this.activeAgentId = this.operatorAgentId;
      return existing;
    }

    if (this.operatorLaunchPromise) return this.operatorLaunchPromise;

    const detected = await this.detectOperatorTarget();
    if (detected) {
      this.operatorBootstrapState = "ready";
      this.operatorBootstrapError = undefined;
      this.activeAgentId = this.operatorAgentId;
      return detected;
    }

    const provider = this.preferredOperatorProvider();
    if (!provider) {
      throw new Error("No runtime provider is available for the operator");
    }
    if (!provider.capabilities.startAgent) {
      throw new Error(`Runtime provider ${provider.id} cannot launch agents`);
    }
    if (provider.health?.ok === false) {
      throw new Error(
        `Runtime provider ${provider.id} is ${provider.health.status}: ${provider.health.message ?? "unavailable"}`,
      );
    }

    this.operatorBootstrapState = "starting";
    this.operatorBootstrapError = undefined;
    if (!options.quiet) {
      this.notice(`starting operator ${this.operatorAgentId}`);
    }

    this.operatorLaunchPromise = (async () => {
      await this.client.launchRuntimeAgent(provider.id, {
        agentId: this.operatorAgentId,
        role: "lead",
        displayName: this.operatorConfig.displayName,
        harness: operatorHarness(this.operatorConfig),
        env: {
          AGENTROOM_DASHBOARD_OPERATOR: "1",
          ...(this.operatorConfig.env ?? {}),
        },
      });
      this.selectedProviderId = provider.id;
      this.activeAgentId = this.operatorAgentId;
      this.operatorBootstrapState = "ready";
      this.operatorBootstrapError = undefined;
      if (!options.quiet) {
        this.notice(`operator ${this.operatorAgentId} ready`);
      }
      return { providerId: provider.id, agentId: this.operatorAgentId };
    })();

    try {
      return await this.operatorLaunchPromise;
    } catch (error) {
      this.operatorBootstrapState = "failed";
      this.operatorBootstrapError =
        error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.operatorLaunchPromise = undefined;
    }
  }

  private enterPrompt(initialText = ""): void {
    this.promptActive = true;
    this.editor.setText(initialText);
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  private leavePrompt(clear = true): void {
    this.promptActive = false;
    if (clear) this.editor.setText("");
    this.tui.setFocus(this);
    this.tui.requestRender();
  }

  private showCommandPalette(): void {
    this.showSelectDialog(
      "operator commands",
      [
        {
          value: "ask",
          label: "ask operator",
          description: "Ask the dashboard operator about this room",
        },
        {
          value: "ask-selected",
          label: "ask selected",
          description: "Send input to the selected runtime agent",
        },
        {
          value: "post",
          label: "post message",
          description: "Post a room message to a channel",
        },
        {
          value: "tasks",
          label: "task selector",
          description: "Open the task sub-TUI",
        },
        {
          value: "agents",
          label: "agent selector",
          description: "Open the agent sub-TUI",
        },
        {
          value: "messages",
          label: "message selector",
          description: "Open the message sub-TUI",
        },
        {
          value: "views",
          label: "switch view",
          description: "Jump to another dashboard view",
        },
        { value: "new-task", label: "new task", description: "Create a task" },
        {
          value: "launch",
          label: "launch agent",
          description: "Run /launch with a custom command",
        },
        {
          value: "operator",
          label: "operator",
          description: "Start or focus the dashboard operator",
        },
        {
          value: "slash",
          label: "slash commands",
          description: "Browse manual dashboard commands",
        },
      ],
      async (item) => {
        switch (item.value) {
          case "ask":
            this.enterPrompt();
            return;
          case "ask-selected":
            this.enterPrompt(
              this.inputAgentId() ? `/ask ${this.inputAgentId()} ` : "/ask ",
            );
            return;
          case "post":
            this.enterPrompt("/post #announcements ");
            return;
          case "tasks":
            this.showTaskSelector();
            return;
          case "agents":
            this.showAgentSelector();
            return;
          case "messages":
            this.showMessageSelector();
            return;
          case "views":
            this.showViewSelector();
            return;
          case "new-task":
            this.showNewTaskInput();
            return;
          case "launch":
            this.enterPrompt("/launch ");
            return;
          case "operator":
            await this.ensureOperatorAgent();
            await this.refresh();
            return;
          case "slash":
            this.showSlashCommandReference();
            return;
        }
      },
    );
  }

  private showSlashCommandReference(): void {
    this.showSelectDialog(
      "slash commands",
      SLASH_COMMANDS.map((command) => ({
        value: command.value,
        label: command.label,
        description: `${command.value} - ${command.description}`,
      })),
      async (item) => {
        const command = SLASH_COMMANDS.find(
          (candidate) => candidate.value === item.value,
        );
        if (!command) return;
        if (command.template !== undefined) {
          this.enterPrompt(command.template);
          return;
        }
        if (command.run !== undefined) {
          await this.runCommand(command.run.slice(1));
          await this.refresh();
        }
      },
    );
  }

  private showContextActions(): void {
    const view = this.currentView();
    if (view === "tasks") {
      this.showTaskActions();
      return;
    }
    if (view === "agents") {
      this.showAgentActions();
      return;
    }
    if (view === "messages") {
      this.showMessageActions();
      return;
    }
    if (view === "chat" || view === "overview") {
      this.showCommandPalette();
      return;
    }
    this.showViewSelector();
  }

  private showViewSelector(): void {
    this.showSelectDialog(
      "views",
      VIEWS.map((view, index) => ({
        value: view,
        label: `${index + 1}. ${view}`,
        description:
          view === this.currentView() ? "current view" : "switch view",
      })),
      (item) => {
        this.setView(item.value);
      },
    );
  }

  private showTaskSelector(): void {
    if (this.snapshot.tasks.length === 0) {
      this.notice("no tasks; press n or use /task <title>");
      return;
    }
    this.showSelectDialog(
      "tasks",
      this.snapshot.tasks.map((task) => ({
        value: task.id,
        label: task.title,
        description: `${task.status} ${task.assignee?.id ?? "unassigned"} ${task.id}`,
      })),
      (item) => {
        const index = this.snapshot.tasks.findIndex(
          (task) => task.id === item.value,
        );
        if (index >= 0) {
          this.selectedTaskIndex = index;
          this.viewIndex = VIEWS.indexOf("tasks");
          this.tui.requestRender();
          this.showTaskActions();
        }
      },
    );
  }

  private showAgentSelector(): void {
    if (this.snapshot.agents.length === 0) {
      this.notice(
        "no agents for selected provider; use /launch or ask operator",
      );
      return;
    }
    this.showSelectDialog(
      "agents",
      this.snapshot.agents.map((agent) => ({
        value: agent.id,
        label: agent.displayName ?? agent.id,
        description: `${agent.state} ${agent.id}`,
      })),
      (item) => {
        const index = this.snapshot.agents.findIndex(
          (agent) => agent.id === item.value,
        );
        if (index >= 0) {
          this.selectedAgentIndex = index;
          this.activeAgentId = item.value;
          this.viewIndex = VIEWS.indexOf("agents");
          void this.refresh();
          this.tui.requestRender();
          this.showAgentActions();
        }
      },
    );
  }

  private showMessageSelector(): void {
    if (this.snapshot.messages.length === 0) {
      this.notice("no messages");
      return;
    }
    this.showSelectDialog(
      "messages",
      this.snapshot.messages
        .slice(-60)
        .reverse()
        .map((message) => ({
          value: message.id,
          label: `${actorLabel(message.sender)} #${message.channelId ?? "announcements"}`,
          description: message.body.replace(/\s+/g, " "),
        })),
      (item) => {
        const index = this.snapshot.messages.findIndex(
          (message) => message.id === item.value,
        );
        if (index >= 0) {
          this.selectedMessageIndex = index;
          this.viewIndex = VIEWS.indexOf("messages");
          this.tui.requestRender();
          this.showMessageActions();
        }
      },
    );
  }

  private showTaskActions(task = this.selectedTask()): void {
    if (!task) {
      this.notice("no selected task");
      return;
    }
    this.showSelectDialog(
      `task: ${task.title}`,
      [
        {
          value: "rename",
          label: "rename",
          description: "Edit the task title",
        },
        {
          value: "describe",
          label: "describe",
          description: "Edit or clear the task description",
        },
        { value: "status", label: "status", description: "Change task status" },
        { value: "claim", label: "claim", description: "Assign to an agent" },
        {
          value: "cancel",
          label: "cancel",
          description: "Mark canceled but keep visible",
        },
        {
          value: "delete",
          label: "delete",
          description: "Remove from active tasks",
        },
        {
          value: "ask",
          label: "ask operator",
          description: "Ask the dashboard operator about this task",
        },
      ],
      (item) => {
        switch (item.value) {
          case "rename":
            this.showRenameTaskInput(task);
            return;
          case "describe":
            this.showDescribeTaskInput(task);
            return;
          case "status":
            this.showStatusSelector(task);
            return;
          case "claim":
            this.showClaimTaskInput(task);
            return;
          case "cancel":
            this.showCancelTaskInput(task);
            return;
          case "delete":
            this.showDeleteTaskInput(task);
            return;
          case "ask":
            this.enterPrompt(
              `Please help with task ${task.id}: ${task.title}\n`,
            );
            return;
        }
      },
    );
  }

  private showAgentActions(agent = this.selectedAgent()): void {
    if (!agent) {
      this.notice("no selected agent");
      return;
    }
    this.showSelectDialog(
      `agent: ${agent.id}`,
      [
        { value: "ask", label: "ask", description: "Send input to this agent" },
        {
          value: "output",
          label: "read output",
          description: "Refresh and show latest output",
        },
        {
          value: "provider",
          label: "provider",
          description: "Switch runtime provider",
        },
        {
          value: "launch",
          label: "launch another",
          description: "Run a launch command",
        },
      ],
      async (item) => {
        switch (item.value) {
          case "ask":
            this.enterPrompt(`/ask ${agent.id} `);
            return;
          case "output":
            this.viewIndex = VIEWS.indexOf("agents");
            await this.refresh();
            return;
          case "provider":
            this.showProviderSelector();
            return;
          case "launch":
            this.enterPrompt("/launch ");
            return;
        }
      },
    );
  }

  private showMessageActions(message = this.selectedMessage()): void {
    if (!message) {
      this.notice("no selected message");
      return;
    }
    const channel = message.channelId ?? "announcements";
    this.showSelectDialog(
      `message: ${actorLabel(message.sender)}`,
      [
        {
          value: "reply",
          label: "reply to channel",
          description: `Post to #${channel}`,
        },
        {
          value: "ask",
          label: "ask operator",
          description: "Ask the dashboard operator about this message",
        },
        { value: "select", label: "select only", description: message.id },
      ],
      (item) => {
        switch (item.value) {
          case "reply":
            this.enterPrompt(`/post #${channel} `);
            return;
          case "ask":
            this.enterPrompt(
              `Please review this room message from ${actorLabel(message.sender)}:\n${message.body}\n`,
            );
            return;
          case "select":
            this.viewIndex = VIEWS.indexOf("messages");
            this.tui.requestRender();
            return;
        }
      },
    );
  }

  private showProviderSelector(): void {
    if (this.snapshot.providers.length === 0) {
      this.notice("no providers configured");
      return;
    }
    this.showSelectDialog(
      "providers",
      this.snapshot.providers.map((provider) => ({
        value: provider.id,
        label: provider.id,
        description: `${provider.kind} ${provider.health?.ok === false ? "offline" : "available"}`,
      })),
      async (item) => {
        this.selectProvider(item.value);
        await this.refresh();
      },
    );
  }

  private showStatusSelector(task = this.selectedTask()): void {
    if (!task) {
      this.notice("no selected task");
      return;
    }
    this.showSelectDialog(
      `status: ${task.title}`,
      TASK_STATUSES.map((status) => ({
        value: status,
        label: status,
        description:
          status === task.status ? "current status" : `set ${task.id}`,
      })),
      async (item) => {
        if (!isTaskStatus(item.value)) return;
        await this.client.updateTaskStatus(task.id, {
          status: item.value,
          actor: humanActor(),
        });
        this.notice(`updated ${task.id} to ${item.value}`);
        await this.refresh();
      },
    );
  }

  private showNewTaskInput(): void {
    this.showInputDialog("new task title", async (title) => {
      const clean = title.trim();
      if (!clean) return;
      await this.client.createTask({
        title: clean,
        createdBy: humanActor(),
      });
      this.notice(`created task: ${clean}`);
      await this.refresh();
    });
  }

  private showRenameTaskInput(task = this.selectedTask()): void {
    if (!task) {
      this.notice("no selected task");
      return;
    }
    this.showInputDialog(
      "rename task",
      async (title) => {
        const clean = title.trim();
        if (!clean) return;
        await this.client.updateTaskDetails(task.id, {
          title: clean,
          actor: humanActor(),
        });
        this.notice(`renamed ${task.id}`);
        await this.refresh();
      },
      task.title,
    );
  }

  private showDescribeTaskInput(task = this.selectedTask()): void {
    if (!task) {
      this.notice("no selected task");
      return;
    }
    this.showInputDialog(
      "task description (--clear to empty)",
      async (description) => {
        const clean = description.trim();
        await this.client.updateTaskDetails(task.id, {
          description: clean === "--clear" ? "" : clean,
          actor: humanActor(),
        });
        this.notice(`updated description for ${task.id}`);
        await this.refresh();
      },
      task.description,
    );
  }

  private showClaimTaskInput(task = this.selectedTask()): void {
    if (!task) {
      this.notice("no selected task");
      return;
    }
    if (this.snapshot.agents.length > 0) {
      this.showSelectDialog(
        `claim: ${task.title}`,
        this.snapshot.agents.map((agent) => ({
          value: agent.id,
          label: agent.displayName ?? agent.id,
          description: agent.state,
        })),
        async (item) => {
          await this.client.claimTask(task.id, {
            kind: "agent",
            id: item.value,
          });
          this.notice(`claimed ${task.id} for ${item.value}`);
          await this.refresh();
        },
      );
      return;
    }
    this.showInputDialog("claim task to agent id", async (agentId) => {
      const clean = agentId.trim();
      if (!clean) return;
      await this.client.claimTask(task.id, { kind: "agent", id: clean });
      this.notice(`claimed ${task.id} for ${clean}`);
      await this.refresh();
    });
  }

  private showCancelTaskInput(task = this.selectedTask()): void {
    if (!task) {
      this.notice("no selected task");
      return;
    }
    this.showInputDialog("cancel reason (optional)", async (reason) => {
      const clean = reason.trim();
      await this.client.updateTaskStatus(task.id, {
        status: "canceled",
        actor: humanActor(),
        ...(clean ? { reason: clean } : {}),
      });
      this.notice(`canceled ${task.id}`);
      await this.refresh();
    });
  }

  private showDeleteTaskInput(task = this.selectedTask()): void {
    if (!task) {
      this.notice("no selected task");
      return;
    }
    this.showInputDialog("delete reason (optional)", async (reason) => {
      const clean = reason.trim();
      await this.client.deleteTask(task.id, {
        actor: humanActor(),
        ...(clean ? { reason: clean } : {}),
      });
      this.notice(`deleted ${task.id}`);
      await this.refresh();
    });
  }

  private showSelectDialog(
    title: string,
    items: SelectItem[],
    onSelect: (item: SelectItem) => void | Promise<void>,
  ): void {
    if (items.length === 0) {
      this.notice("no options");
      return;
    }

    let handle: OverlayHandle | undefined;
    const dialog = new SelectDialog(title, items);
    dialog.onCancel = () => handle?.hide();
    dialog.onSelect = (item) => {
      handle?.hide();
      void this.runDialogAction(async () => {
        await onSelect(item);
      });
    };
    handle = this.tui.showOverlay(dialog, {
      width: "88%",
      maxHeight: "70%",
      anchor: "bottom-center",
      margin: { left: 2, right: 2, bottom: 2 },
    });
  }

  private showInputDialog(
    title: string,
    onSubmit: (value: string) => void | Promise<void>,
    initialValue?: string,
  ): void {
    let handle: OverlayHandle | undefined;
    const dialog = new TextInputDialog(title, undefined, initialValue);
    dialog.onCancel = () => handle?.hide();
    dialog.onSubmit = (value) => {
      handle?.hide();
      void this.runDialogAction(async () => {
        await onSubmit(value);
      });
    };
    handle = this.tui.showOverlay(dialog, {
      width: "80%",
      maxHeight: 6,
      anchor: "bottom-center",
      margin: { left: 2, right: 2, bottom: 2 },
    });
  }

  private async runDialogAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.tui.requestRender();
    }
  }

  private async loadProviderAgents(
    providers: RuntimeProviderSummary[],
  ): Promise<Record<string, RuntimeAgent[]>> {
    const entries = await Promise.all(
      providers.map(async (provider): Promise<[string, RuntimeAgent[]]> => {
        try {
          const { agents } = await this.client.listRuntimeAgents(provider.id);
          return [provider.id, agents];
        } catch {
          return [provider.id, []];
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  private async loadRuntimeBinding(
    agentId: string,
  ): Promise<RuntimeBinding | undefined> {
    try {
      const { binding } = await this.client.getRuntimeBinding(agentId);
      return binding ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async loadDashboardConfig(): Promise<DashboardConfig | undefined> {
    try {
      return await this.client.dashboardConfig();
    } catch {
      return undefined;
    }
  }

  private applyDashboardConfig(config: DashboardConfig | undefined): void {
    const previousAgentId = this.operatorConfig.agentId;
    this.operatorConfig = dashboardOperatorConfig(
      config?.operator ?? undefined,
      config?.cwd,
    );
    if (this.activeAgentId === previousAgentId) {
      this.activeAgentId = this.operatorConfig.agentId;
    }
  }

  private async detectOperatorTarget(): Promise<OperatorTarget | undefined> {
    const providerIds = [
      this.snapshot.operatorBinding?.providerId,
      this.selectedProviderId,
      ...this.snapshot.providers.map((provider) => provider.id),
    ].filter((providerId): providerId is string => Boolean(providerId));

    for (const providerId of [...new Set(providerIds)]) {
      try {
        await this.client.readRuntimeAgent(providerId, this.operatorAgentId, 1);
        return { providerId, agentId: this.operatorAgentId };
      } catch {
        // Keep probing providers; older daemons do not expose binding lookup.
      }
    }
    return undefined;
  }

  private nextSelectedProvider(
    providers: RuntimeProviderSummary[],
    providerAgents: Record<string, RuntimeAgent[]>,
  ): string | undefined {
    if (
      this.selectedProviderId &&
      providers.some((provider) => provider.id === this.selectedProviderId)
    ) {
      return this.selectedProviderId;
    }

    const activeProvider = providers.find(
      (provider) => (providerAgents[provider.id]?.length ?? 0) > 0,
    );
    if (activeProvider) return activeProvider.id;

    const availableNonFake = providers.find(
      (provider) => provider.kind !== "fake" && provider.health?.ok !== false,
    );
    return availableNonFake?.id ?? providers[0]?.id;
  }

  private operatorTarget(): OperatorTarget | undefined {
    if (this.snapshot.operatorBinding) {
      return {
        providerId: this.snapshot.operatorBinding.providerId,
        agentId: this.operatorAgentId,
      };
    }
    return (
      this.operatorTargetFromEvents(this.snapshot.events) ??
      this.operatorTargetFrom(this.snapshot.providerAgents)
    );
  }

  private operatorTargetFrom(
    providerAgents: Record<string, RuntimeAgent[]>,
  ): OperatorTarget | undefined {
    for (const [providerId, agents] of Object.entries(providerAgents)) {
      if (agents.some((agent) => agent.id === this.operatorAgentId)) {
        return { providerId, agentId: this.operatorAgentId };
      }
    }
    return undefined;
  }

  private operatorTargetFromEvents(
    events: RoomEvent[],
  ): OperatorTarget | undefined {
    for (const event of events.slice().reverse()) {
      if (
        event.type === "runtime.bound" &&
        event.payload.agentId === this.operatorAgentId
      ) {
        return {
          providerId: event.payload.runtime.providerId,
          agentId: this.operatorAgentId,
        };
      }
    }
    return undefined;
  }

  private totalAgentCount(): number {
    return Object.values(this.snapshot.providerAgents).reduce(
      (total, agents) => total + agents.length,
      0,
    );
  }

  private providerIdForAgent(agentId: string): string | undefined {
    for (const [providerId, agents] of Object.entries(
      this.snapshot.providerAgents,
    )) {
      if (agents.some((agent) => agent.id === agentId)) return providerId;
    }
    return undefined;
  }

  private preferredOperatorProvider(): RuntimeProviderSummary | undefined {
    const launchable = (provider: RuntimeProviderSummary) =>
      provider.capabilities.startAgent && provider.health?.ok !== false;
    const selected = this.snapshot.providers.find(
      (provider) => provider.id === this.selectedProviderId,
    );
    if (selected && launchable(selected)) return selected;

    const active = this.snapshot.providers.find(
      (provider) =>
        launchable(provider) &&
        (this.snapshot.providerAgents[provider.id]?.length ?? 0) > 0,
    );
    if (active) return active;

    const nonFake = this.snapshot.providers.find(
      (provider) => provider.kind !== "fake" && launchable(provider),
    );
    return nonFake ?? this.snapshot.providers.find(launchable);
  }

  private renderOperatorStatus(): string {
    const target = this.operatorTarget();
    const kind = this.operatorKindLabel();
    const label = `${this.operatorAgentId}${kind ? ` ${kind}` : ""}`;
    if (target) {
      return `${style.green(label)} ${style.dim(target.providerId)}`;
    }
    if (this.operatorBootstrapState === "starting") {
      return style.amber(`${label} starting`);
    }
    if (this.operatorBootstrapState === "failed") {
      const reason = this.operatorBootstrapError
        ? ` ${normalizeSingleLine(this.operatorBootstrapError)}`
        : "";
      return style.red(`${label} offline${reason}`);
    }
    if (this.operatorBootstrapState === "ready") {
      const provider = this.selectedProviderId
        ? ` ${this.selectedProviderId}`
        : "";
      return `${style.green(label)}${style.dim(provider)}`;
    }
    return style.amber(`${label} pending`);
  }

  private operatorKindLabel(): string | undefined {
    return (
      this.operatorConfig.kind ?? inferOperatorKind(this.operatorConfig.command)
    );
  }

  private changeView(delta: number): void {
    this.viewIndex = mod(this.viewIndex + delta, VIEWS.length);
    this.tui.requestRender();
  }

  private setView(view: string | undefined): void {
    const index = VIEWS.indexOf(view as ViewName);
    if (index === -1) throw new Error(`Unknown view: ${view ?? ""}`);
    this.viewIndex = index;
    this.tui.requestRender();
  }

  private changeSelection(delta: number): void {
    if (this.currentView() === "tasks") {
      this.selectedTaskIndex = mod(
        this.selectedTaskIndex + delta,
        Math.max(1, this.snapshot.tasks.length),
      );
    } else if (this.currentView() === "messages") {
      this.selectedMessageIndex = mod(
        this.selectedMessageIndex + delta,
        Math.max(1, this.snapshot.messages.length),
      );
    } else {
      this.selectedAgentIndex = mod(
        this.selectedAgentIndex + delta,
        Math.max(1, this.snapshot.agents.length),
      );
      this.activeAgentId = this.selectedAgent()?.id;
    }
    this.tui.requestRender();
  }

  private selectProvider(providerId: string | undefined): void {
    if (!providerId) throw new Error("Usage: /provider <providerId>");
    if (
      !this.snapshot.providers.some((provider) => provider.id === providerId)
    ) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    this.selectedProviderId = providerId;
    this.selectedAgentIndex = 0;
    this.notice(`selected provider ${providerId}`);
  }

  private selectById(id: string | undefined): void {
    if (!id) throw new Error("Usage: /select <agentId|taskId|messageId>");
    const providerId = this.providerIdForAgent(id);
    if (providerId) {
      this.selectedProviderId = providerId;
      this.selectedAgentIndex = Math.max(
        0,
        (this.snapshot.providerAgents[providerId] ?? []).findIndex(
          (agent) => agent.id === id,
        ),
      );
      this.activeAgentId = id;
      this.viewIndex = VIEWS.indexOf("agents");
      return;
    }
    if (this.knownAgentIds().has(id)) {
      this.activeAgentId = id;
      this.viewIndex = VIEWS.indexOf("agents");
      return;
    }
    const taskIndex = this.snapshot.tasks.findIndex((task) => task.id === id);
    if (taskIndex >= 0) {
      this.selectedTaskIndex = taskIndex;
      this.viewIndex = VIEWS.indexOf("tasks");
      return;
    }
    const messageIndex = this.snapshot.messages.findIndex(
      (message) => message.id === id,
    );
    if (messageIndex >= 0) {
      this.selectedMessageIndex = messageIndex;
      this.viewIndex = VIEWS.indexOf("messages");
      return;
    }
    throw new Error(`No agent, task, or message found for ${id}`);
  }

  private selectedAgent(): RuntimeAgent | undefined {
    return this.snapshot.agents[this.selectedAgentIndex];
  }

  private inputAgentId(): string | undefined {
    return this.activeAgentId ?? this.selectedAgent()?.id;
  }

  private selectedTask(): Task | undefined {
    return this.snapshot.tasks[this.selectedTaskIndex];
  }

  private selectedMessage(): Message | undefined {
    return this.snapshot.messages[this.selectedMessageIndex];
  }

  private hasAgent(agentId: string): boolean {
    return (
      this.providerIdForAgent(agentId) !== undefined ||
      this.knownAgentIds().has(agentId)
    );
  }

  private hasTask(taskId: string): boolean {
    return this.snapshot.tasks.some((task) => task.id === taskId);
  }

  private knownAgentIds(): Set<string> {
    const ids = new Set(
      Object.values(this.snapshot.providerAgents).flatMap((agents) =>
        agents.map((agent) => agent.id),
      ),
    );
    for (const event of this.snapshot.events) {
      if (event.type === "runtime.bound") {
        ids.add(event.payload.agentId);
      } else if (event.type === "agent.joined") {
        ids.add(event.payload.agent.id);
      }
    }
    return ids;
  }

  private resolveTaskCommandTarget(
    args: string[],
    usage: string,
  ): { task: Task; rest: string[] } {
    const first = args[0];
    if (first && this.hasTask(first)) {
      const task = this.snapshot.tasks.find(
        (candidate) => candidate.id === first,
      );
      if (task) return { task, rest: args.slice(1) };
    }
    if (first?.startsWith("task_")) {
      throw new Error(`Unknown task: ${first}`);
    }
    const selected = this.selectedTask();
    if (!selected) throw new Error(`${usage}; no task selected`);
    return { task: selected, rest: args };
  }

  private visibleMessages(): { startIndex: number; messages: Message[] } {
    const limit = Math.max(6, Math.min(18, this.terminal.rows - 16));
    const total = this.snapshot.messages.length;
    if (total <= limit) {
      return { startIndex: 0, messages: this.snapshot.messages };
    }
    const centeredStart = this.selectedMessageIndex - Math.floor(limit / 2);
    const startIndex = clamp(centeredStart, 0, total - limit);
    return {
      startIndex,
      messages: this.snapshot.messages.slice(startIndex, startIndex + limit),
    };
  }

  private currentView(): ViewName {
    return VIEWS[this.viewIndex] ?? "chat";
  }

  private clampSelections(): void {
    this.selectedAgentIndex = clamp(
      this.selectedAgentIndex,
      0,
      Math.max(0, this.snapshot.agents.length - 1),
    );
    this.selectedTaskIndex = clamp(
      this.selectedTaskIndex,
      0,
      Math.max(0, this.snapshot.tasks.length - 1),
    );
    this.selectedMessageIndex = clamp(
      this.selectedMessageIndex,
      0,
      Math.max(0, this.snapshot.messages.length - 1),
    );
  }

  private notice(text: string): void {
    if (this.notices.at(-1) === text) {
      this.tui.requestRender();
      return;
    }
    this.notices.push(text);
    this.notices = this.notices.slice(-6);
    this.tui.requestRender();
  }

  private addChatTurn(role: ChatTurn["role"], text: string): void {
    this.chatTurns.push({
      role,
      text: text.trim(),
      createdAt: new Date().toISOString(),
    });
    this.chatTurns = this.chatTurns.slice(-24);
    this.tui.requestRender();
  }
}

function section(label: string): string {
  return style.bold(style.cyan(label.toUpperCase()));
}

function rule(width: number): string {
  return style.dim("-".repeat(Math.max(1, width)));
}

function padLine(line: string, width: number): string {
  const clean = truncateToWidth(line, width, "");
  return clean + " ".repeat(Math.max(0, width - visibleWidth(clean)));
}

function fitLines(lines: string[], width: number, height: number): string[] {
  const fitted = lines.flatMap((line) => wrapTextWithAnsi(line, width));
  const visible = fitted.slice(0, height);
  while (visible.length < height) visible.push("");
  return visible;
}

function fitTailLines(
  lines: string[],
  width: number,
  height: number,
): string[] {
  const fitted = lines.flatMap((line) => wrapTextWithAnsi(line, width));
  if (height <= 1) return fitted.slice(-height);
  const [header, ...body] = fitted;
  const visible =
    header === undefined
      ? []
      : fitted.length <= height
        ? fitted
        : [header, ...body.slice(-(height - 1))];
  while (visible.length < height) visible.unshift("");
  return visible;
}

function emptyHint<T>(items: readonly T[], hint: string): string[] {
  return items.length === 0 ? [style.dim(hint)] : [];
}

function renderChatTurn(turn: ChatTurn, width: number): string[] {
  const time = style.dim(turn.createdAt.slice(11, 19));
  const label =
    turn.role === "user"
      ? style.cyan("you")
      : turn.role === "assistant"
        ? style.green("operator")
        : style.dim("system");
  const firstLine = `${time} ${label} ${turn.text}`;
  return wrapTextWithAnsi(firstLine, width);
}

function compareChatTurns(a: ChatTurn, b: ChatTurn): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

function dedupeChatTurns(turns: ChatTurn[]): ChatTurn[] {
  const deduped: ChatTurn[] = [];
  for (const turn of turns) {
    const duplicate = deduped.some(
      (candidate) =>
        candidate.role === turn.role &&
        candidate.text === turn.text &&
        Math.abs(Date.parse(candidate.createdAt) - Date.parse(turn.createdAt)) <
          5000,
    );
    if (!duplicate) deduped.push(turn);
  }
  return deduped;
}

function normalizeSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isPlainTextInput(data: string): boolean {
  return data.length === 1 && data >= " " && data !== "\x7f";
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function mergeProviderHealth(
  providers: RuntimeProviderSummary[],
  health: DaemonHealth,
): RuntimeProviderSummary[] {
  const runtimeById = new Map(
    health.runtimes.map((runtime) => [runtime.id, runtime]),
  );

  return providers.map((provider) => {
    const runtimeHealth =
      runtimeById.get(provider.id)?.health ?? provider.health;
    return {
      ...provider,
      ...(runtimeHealth !== undefined ? { health: runtimeHealth } : {}),
    };
  });
}

function actorLabel(actor: ActorRef): string {
  return actor.displayName ?? actor.id;
}

function formatDateTime(value: string): string {
  return value.replace("T", " ").slice(0, 19);
}

function renderState(state: string): string {
  if (state === "online" || state === "working") return style.green(state);
  if (state === "blocked" || state === "failed") return style.red(state);
  if (state === "stopped" || state === "unknown") return style.dim(state);
  return style.amber(state);
}

function renderTaskStatus(status: TaskStatus): string {
  if (status === "done" || status === "approved" || status === "merged") {
    return style.green(status.padEnd(16));
  }
  if (status === "blocked" || status === "changes-requested") {
    return style.red(status.padEnd(16));
  }
  return style.amber(status.padEnd(16));
}

function renderImportance(importance: Message["importance"]): string {
  if (importance === "urgent") return style.red("urgent");
  if (importance === "high") return style.amber("high");
  if (importance === "low") return style.dim("low");
  return style.dim("normal");
}

function renderEvent(event: RoomEvent, width: number): string {
  const time = event.createdAt.slice(11, 19);
  return truncateToWidth(
    `${style.dim(time)} ${style.cyan(event.type)} ${eventSummary(event)}`,
    width,
    "",
  );
}

function eventSummary(event: RoomEvent): string {
  const payload = event.payload as Record<string, unknown>;
  if (event.type === "message.posted") {
    const message = payload.message as Message | undefined;
    return `${message?.sender.id ?? "?"}: ${message?.body ?? ""}`;
  }
  if (event.type === "task.created") {
    const task = payload.task as Task | undefined;
    return task?.title ?? "";
  }
  if (event.type === "task.updated") {
    const title = typeof payload.title === "string" ? ` ${payload.title}` : "";
    return `${String(payload.taskId ?? "?")} updated${title}`;
  }
  if (event.type === "task.deleted") {
    const reason =
      typeof payload.reason === "string" && payload.reason.length > 0
        ? `: ${payload.reason}`
        : "";
    return `${String(payload.taskId ?? "?")} deleted${reason}`;
  }
  if (event.type === "task.status_changed") {
    return `${String(payload.taskId ?? "?")} -> ${String(payload.status ?? "?")}`;
  }
  if (event.type === "runtime.input_sent") {
    return `${String(payload.agentId ?? "?")} <- ${String(payload.text ?? "")}`;
  }
  if (event.type === "runtime.output_observed") {
    return `${String(payload.agentId ?? "?")} output`;
  }
  return JSON.stringify(payload).slice(0, 160);
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) args.push(current);
  return args;
}

function humanActor(): ActorRef {
  return { kind: "human", id: process.env.USER || "operator" };
}

function operatorSessionDirs(config: ResolvedOperatorConfig): string[] {
  const configured =
    process.env.AGENTROOM_OPERATOR_SESSION_DIR?.trim() ||
    process.env.AGENTROOM_PI_SESSION_DIR?.trim() ||
    config.sessionDir;
  const candidates = [
    configured,
    resolve(process.cwd(), DEFAULT_OPERATOR_SESSION_DIR),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return [...new Set(candidates.map((candidate) => resolve(candidate)))];
}

function loadPiSessionTranscript(sessionDirs: string[]): ChatTurn[] {
  const sessionFile = findMostRecentPiSession(sessionDirs);
  if (!sessionFile) return [];

  try {
    return readFileSync(sessionFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseJsonLine(line))
      .flatMap((entry) => {
        const turn = piSessionTurnFromEntry(entry);
        return turn ? [turn] : [];
      })
      .slice(-24);
  } catch {
    return [];
  }
}

function findMostRecentPiSession(sessionDirs: string[]): string | undefined {
  const files: Array<{ path: string; mtime: number }> = [];
  for (const dir of sessionDirs) {
    try {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      for (const fileName of readdirSync(dir)) {
        if (!fileName.endsWith(".jsonl")) continue;
        const path = resolve(dir, fileName);
        const stat = statSync(path);
        if (stat.isFile()) files.push({ path, mtime: stat.mtimeMs });
      }
    } catch {
      // Session transcript is best-effort; the live TUI must keep rendering.
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime)[0]?.path;
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function piSessionTurnFromEntry(entry: unknown): ChatTurn | undefined {
  if (!isRecord(entry) || entry.type !== "message") return undefined;
  const message = entry.message;
  if (!isRecord(message)) return undefined;
  if (message.role !== "user" && message.role !== "assistant") {
    return undefined;
  }

  const text = piMessageText(message).trim();
  if (!text) return undefined;

  return {
    role: message.role,
    text,
    createdAt: piMessageTimestamp(message, entry),
  };
}

function piMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const parts = content.flatMap((part) => {
      if (!isRecord(part)) return [];
      if (part.type === "text" && typeof part.text === "string") {
        return [part.text];
      }
      if (part.type === "toolCall") {
        const name = typeof part.name === "string" ? part.name : "tool";
        return [`[tool: ${name}]`];
      }
      return [];
    });
    if (parts.length > 0) return parts.join("\n");
  }

  if (typeof message.errorMessage === "string") {
    return `Error: ${message.errorMessage}`;
  }
  return "";
}

function piMessageTimestamp(
  message: Record<string, unknown>,
  entry: Record<string, unknown>,
): string {
  if (typeof message.timestamp === "number") {
    return new Date(message.timestamp).toISOString();
  }
  if (typeof entry.timestamp === "string") return entry.timestamp;
  return new Date().toISOString();
}

function operatorNoticeFromOutput(
  output: string,
  config: ResolvedOperatorConfig,
): string | undefined {
  const text = stripAnsi(output).replace(/\s+/g, " ");
  if (text.includes("No API key found")) {
    return `${config.displayName} needs a model login or API key before it can answer.`;
  }
  if (text.includes("No models available")) {
    return `${config.displayName} has no models available; log in or configure a model in the operator pane.`;
  }
  if (text.includes("operator.kind custom requires operator.command")) {
    return `${config.displayName} is not configured. Set AGENTROOM_OPERATOR_COMMAND or configure operator.command.`;
  }
  if (text.includes("could not find pi")) {
    return `${config.displayName} could not start Pi. Set AGENTROOM_OPERATOR_COMMAND or configure operator.command.`;
  }
  return undefined;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTaskStatus(value: string | undefined): value is TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus);
}

function isAgentRole(value: string | undefined): value is AgentRole {
  return AGENT_ROLES.includes(value as AgentRole);
}

function isHarnessKind(
  value: string | undefined,
): value is HarnessSpec["kind"] {
  return (
    value === "claude-code" ||
    value === "pi" ||
    value === "codex" ||
    value === "gemini-cli" ||
    value === "shell" ||
    value === "custom"
  );
}

function dashboardOperatorConfig(
  daemonConfig?: DashboardOperatorConfig,
  daemonCwd?: string,
): ResolvedOperatorConfig {
  const fileConfig =
    daemonConfig ?? maybeLoadAgentRoomConfigSync(process.cwd())?.operator;
  const agentId =
    envValue("AGENTROOM_TUI_OPERATOR_ID") ??
    envValue("AGENTROOM_OPERATOR_AGENT_ID") ??
    fileConfig?.agentId ??
    "operator";
  const displayName =
    envValue("AGENTROOM_OPERATOR_DISPLAY_NAME") ??
    fileConfig?.displayName ??
    "Operator";
  const configuredKind =
    parseOperatorKind(
      envValue("AGENTROOM_OPERATOR_KIND") ??
        envValue("AGENTROOM_OPERATOR") ??
        fileConfig?.kind,
      "AGENTROOM_OPERATOR_KIND",
    ) ?? fileConfig?.kind;
  const command = envValue("AGENTROOM_OPERATOR_COMMAND") ?? fileConfig?.command;
  const cwd =
    envValue("AGENTROOM_OPERATOR_CWD") ?? fileConfig?.cwd ?? daemonCwd;
  const sessionDir =
    envValue("AGENTROOM_OPERATOR_SESSION_DIR") ??
    envValue("AGENTROOM_PI_SESSION_DIR") ??
    fileConfig?.sessionDir ??
    DEFAULT_OPERATOR_SESSION_DIR;
  const env = fileConfig?.env;

  return {
    agentId,
    displayName,
    ...(configuredKind !== undefined ? { kind: configuredKind } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    sessionDir,
    ...(env !== undefined ? { env } : {}),
  };
}

function operatorConfigForCommand(
  args: string[],
  base: ResolvedOperatorConfig,
): ResolvedOperatorConfig {
  if (args.length === 0) return base;

  const first = args[0];
  const second = args[1];
  if (isOperatorKind(first)) {
    return {
      ...base,
      kind: first,
      ...(args.length > 1 ? { command: args.slice(1).join(" ") } : {}),
    };
  }

  const agentId = first ?? base.agentId;
  if (isOperatorKind(second)) {
    return {
      ...base,
      agentId,
      kind: second,
      ...(args.length > 2 ? { command: args.slice(2).join(" ") } : {}),
    };
  }

  return {
    ...base,
    agentId,
    ...(args.length > 1 ? { command: args.slice(1).join(" ") } : {}),
  };
}

function operatorHarness(config: ResolvedOperatorConfig): HarnessSpec {
  const kind = config.kind ?? inferOperatorKind(config.command) ?? "custom";
  const commandParts = commandPartsForOperator(kind, config);
  const [command, ...args] = commandParts;
  if (command === undefined) {
    return fallbackPiHarness(config);
  }

  return {
    kind: harnessKindForOperator(kind),
    command,
    ...(args.length > 0 ? { args } : {}),
    cwd: resolve(config.cwd ?? process.cwd()),
    ...(config.env !== undefined ? { env: config.env } : {}),
  };
}

function commandPartsForOperator(
  kind: OperatorKind,
  config: ResolvedOperatorConfig,
): string[] {
  if (config.command !== undefined && config.command.trim().length > 0) {
    return splitArgs(config.command);
  }

  if (kind === "claude-code") return ["claude"];
  if (kind === "codex") return ["codex"];
  if (kind === "gemini-cli") return ["gemini"];
  if (kind === "shell") return ["bash"];
  if (kind === "custom") {
    return [
      "/bin/sh",
      "-lc",
      "echo 'agent-room: operator.kind custom requires operator.command.' >&2; exit 2",
    ];
  }
  if (kind === "clanky") {
    return [
      "clanky",
      "--profile",
      config.agentId,
      "--home",
      ".agentroom/clanky",
    ];
  }
  if (kind !== "pi") return [kind];
  return [];
}

function fallbackPiHarness(config: ResolvedOperatorConfig): HarnessSpec {
  const sessionDir = config.sessionDir || DEFAULT_OPERATOR_SESSION_DIR;

  const localPi = findSiblingPiCheckout();
  const node = findExecutableInPath("node");
  if (localPi && node) {
    return {
      kind: "pi",
      command: node,
      args: [
        resolve(localPi, "node_modules/tsx/dist/cli.mjs"),
        resolve(localPi, "packages/coding-agent/src/cli.ts"),
        "--session-dir",
        sessionDir,
      ],
      cwd: resolve(config.cwd ?? process.cwd()),
      ...(config.env !== undefined ? { env: config.env } : {}),
    };
  }

  const pi = findExecutableInPath("pi");
  if (pi) {
    return {
      kind: "pi",
      command: pi,
      args: ["--session-dir", sessionDir],
      cwd: resolve(config.cwd ?? process.cwd()),
      ...(config.env !== undefined ? { env: config.env } : {}),
    };
  }

  return {
    kind: "pi",
    command: "/bin/sh",
    args: [
      "-lc",
      "echo 'agent-room: could not find pi. Set AGENTROOM_OPERATOR_COMMAND or keep the pi checkout at ../pi or ./pi.' >&2; exit 127",
    ],
    cwd: resolve(config.cwd ?? process.cwd()),
    ...(config.env !== undefined ? { env: config.env } : {}),
  };
}

function harnessKindForOperator(kind: OperatorKind): HarnessSpec["kind"] {
  return kind === "clanky" ? "pi" : kind;
}

function inferOperatorKind(
  command: string | undefined,
): OperatorKind | undefined {
  const [executable] = command ? splitArgs(command) : [];
  if (!executable) return undefined;
  const name = executable.split("/").pop() ?? executable;
  if (name === "claude") return "claude-code";
  if (name === "codex") return "codex";
  if (name === "clanky") return "clanky";
  if (name === "pi") return "pi";
  return undefined;
}

function parseOperatorKind(
  value: string | undefined,
  label: string,
): OperatorKind | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const normalized = value.trim();
  if (isOperatorKind(normalized)) return normalized;
  throw new Error(
    `${label} must be claude-code, codex, clanky, pi, shell, gemini-cli, or custom`,
  );
}

function isOperatorKind(value: string | undefined): value is OperatorKind {
  return isHarnessKind(value) || value === "clanky";
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function findSiblingPiCheckout(): string | undefined {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.AGENTROOM_PI_ROOT,
    resolve(process.cwd(), "pi"),
    resolve(process.cwd(), "..", "pi"),
    resolve(process.cwd(), "..", "..", "pi"),
    resolve(moduleDir, "..", "..", "..", "..", "pi"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const root of [...new Set(candidates)]) {
    if (
      existsSync(resolve(root, "packages/coding-agent/src/cli.ts")) &&
      existsSync(resolve(root, "node_modules/tsx/dist/cli.mjs"))
    ) {
      return root;
    }
  }
  return undefined;
}

function findExecutableInPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) : "";
if (process.argv[1] && process.argv[1] === invokedPath) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(
      "Usage: agent-room-tui [--daemon <url>] [--api-token <token>] [--refresh-ms <ms>]\n",
    );
    process.exit(0);
  }
  const baseUrl = argValue("--daemon") ?? process.env.AGENTROOM_DAEMON;
  const apiToken = argValue("--api-token") ?? process.env.AGENTROOM_API_TOKEN;
  const refreshMs = argValue("--refresh-ms");
  await runAgentRoomTui({
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiToken ? { apiToken } : {}),
    ...(refreshMs ? { refreshMs: Number(refreshMs) } : {}),
  });
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
