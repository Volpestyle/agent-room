#!/usr/bin/env node
import { existsSync } from "node:fs";
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
import { createApiClient, type ApiClient } from "./api.js";
import type {
  ActorRef,
  AgentRole,
  DaemonHealth,
  HarnessSpec,
  Message,
  RoomEvent,
  RuntimeAgent,
  RuntimeProviderSummary,
  Task,
  TaskStatus,
} from "./types.js";

type ViewName = "overview" | "agents" | "tasks" | "messages" | "events";

export interface AgentRoomTuiOptions {
  baseUrl?: string;
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
  output?: string;
}

const VIEWS: ViewName[] = ["overview", "agents", "tasks", "messages", "events"];
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
  const client = createApiClient(
    options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {},
  );
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

  start(): void {
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, this.refreshMs);
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
      this.setView("overview");
      return { consume: true };
    }
    if (matchesKey(data, "2")) {
      this.setView("agents");
      return { consume: true };
    }
    if (matchesKey(data, "3")) {
      this.setView("tasks");
      return { consume: true };
    }
    if (matchesKey(data, "4")) {
      this.setView("messages");
      return { consume: true };
    }
    if (matchesKey(data, "5")) {
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
      const health = await this.client.health();
      const providers = await this.client.listRuntimeProviders();
      const providerRows = mergeProviderHealth(providers.providers, health);
      const providerAgents = await this.loadProviderAgents(providerRows);
      const selectedProviderId = this.nextSelectedProvider(
        providerRows,
        providerAgents,
      );
      this.selectedProviderId = selectedProviderId;

      const [tasks, messages, events] = await Promise.all([
        this.client.listTasks(),
        this.client.listMessages(80),
        this.client.listEvents(100),
      ]);

      const agents = selectedProviderId
        ? (providerAgents[selectedProviderId] ?? [])
        : [];
      const selectedAgent = agents[this.selectedAgentIndex] ?? agents[0];
      const output =
        selectedProviderId && selectedAgent
          ? await this.readAgentOutput(selectedProviderId, selectedAgent.id)
          : undefined;

      this.snapshot = {
        health,
        providers: providerRows,
        providerAgents,
        agents,
        tasks: tasks.tasks,
        messages: messages.messages,
        events: events.events,
        ...(output !== undefined ? { output } : {}),
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
    const contentStartRow = headerLines.length + navLines.length + 1;
    const contentLines = this.renderCurrentView(
      fullWidth,
      contentHeight,
      contentStartRow,
    );
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
      return [section("operator input"), ...this.editor.render(width)];
    }
    const selectedAgent = this.inputAgentId() ?? "no agent";
    return [
      style.dim(
        `browse mode  / slash commands  ? palette  i ask ${selectedAgent}  enter actions  n task  p post`,
      ),
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

  private renderCurrentView(
    width: number,
    height: number,
    startRow: number,
  ): string[] {
    const view = VIEWS[this.viewIndex] ?? "overview";
    const lines =
      view === "overview"
        ? this.renderOverview(width, startRow)
        : view === "agents"
          ? this.renderAgents(width, startRow)
          : view === "tasks"
            ? this.renderTasks(width, startRow)
            : view === "messages"
              ? this.renderMessages(width, startRow)
              : this.renderEvents(width);

    return fitLines(lines, width, height);
  }

  private renderOverview(width: number, startRow: number): string[] {
    const activeTasks = this.snapshot.tasks.filter((task) =>
      [
        "assigned",
        "claimed",
        "working",
        "ready-for-review",
        "blocked",
      ].includes(task.status),
    );
    const totalAgents = Object.values(this.snapshot.providerAgents).reduce(
      (total, agents) => total + agents.length,
      0,
    );
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

  private renderAgents(width: number, startRow: number): string[] {
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

  private renderTasks(width: number, startRow: number): string[] {
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

  private renderMessages(width: number, startRow: number): string[] {
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
          `↑/↓ j/k select  tab/←/→ view  enter actions  / commands  ? palette  i ask  selected agent ${selectedAgent} task ${selectedTask} msg ${selectedMessage}`,
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
      } else if (this.inputAgentId()) {
        await this.sendToAgent(this.inputAgentId()!, value);
      } else {
        throw new Error(
          "No agent selected; use /operator, /launch, or /post #channel",
        );
      }
      await this.refresh();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.tui.requestRender();
    }
  }

  private async runCommand(commandLine: string): Promise<void> {
    const [command, ...args] = splitArgs(commandLine);
    switch (command) {
      case undefined:
      case "":
      case "?":
      case "commands":
      case "palette":
        this.showCommandPalette();
        return;
      case "help":
        this.notice(
          "/ask [agent] text | /post [#channel] text | /tasks | /agents | /messages | /actions | /task title | /rename [task] title | /desc [task] text | /delete [task] [reason]",
        );
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
        if (!target) throw new Error("No agent selected");
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
        const [agentId = "operator", ...commandParts] = args;
        this.activeAgentId = agentId;
        await this.launchAgent(agentId, "lead", operatorHarness(commandParts));
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

  private async sendToAgent(agentId: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error("Input text is required");
    const providerId = this.selectedProviderId;
    if (!providerId) throw new Error("No runtime provider selected");
    await this.client.sendRuntimeAgentInput(providerId, agentId, {
      text,
      submit: true,
    });
    this.notice(`sent input to ${agentId}`);
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
          label: "ask agent",
          description: "Send plain text to the selected runtime agent",
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
          label: "launch operator",
          description: "Launch a Pi lead agent named operator",
        },
        {
          value: "slash",
          label: "slash command",
          description: "Type a raw slash command",
        },
      ],
      async (item) => {
        switch (item.value) {
          case "ask":
            this.enterPrompt();
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
            this.enterPrompt("/operator operator");
            return;
          case "slash":
            this.enterPrompt("/");
            return;
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
    if (view === "overview") {
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
      this.notice("no agents for selected provider; use /launch or /operator");
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
          label: "ask agent",
          description: "Ask the selected agent about this task",
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
            this.enterPrompt();
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
          label: "ask agent",
          description: "Ask selected agent about this message",
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
    const agentIndex = this.snapshot.agents.findIndex(
      (agent) => agent.id === id,
    );
    if (agentIndex >= 0) {
      this.selectedAgentIndex = agentIndex;
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
    return this.knownAgentIds().has(agentId);
  }

  private hasTask(taskId: string): boolean {
    return this.snapshot.tasks.some((task) => task.id === taskId);
  }

  private knownAgentIds(): Set<string> {
    const ids = new Set(this.snapshot.agents.map((agent) => agent.id));
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
    return VIEWS[this.viewIndex] ?? "overview";
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
    this.notices.push(text);
    this.notices = this.notices.slice(-6);
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

function emptyHint<T>(items: readonly T[], hint: string): string[] {
  return items.length === 0 ? [style.dim(hint)] : [];
}

function normalizeSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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

function operatorHarness(commandParts: string[]): HarnessSpec {
  if (commandParts.length > 0) {
    const [command, ...args] = commandParts;
    return {
      kind: "pi",
      command: command ?? "pi",
      ...(args.length > 0 ? { args } : {}),
    };
  }

  const configured = process.env.AGENTROOM_OPERATOR_COMMAND?.trim();
  if (configured) {
    const [command, ...args] = splitArgs(configured);
    if (command) {
      return {
        kind: "pi",
        command,
        ...(args.length > 0 ? { args } : {}),
      };
    }
  }

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
        ".agentroom/pi-sessions",
      ],
      cwd: process.cwd(),
    };
  }

  const pi = findExecutableInPath("pi");
  if (pi) {
    return {
      kind: "pi",
      command: pi,
      args: ["--session-dir", ".agentroom/pi-sessions"],
      cwd: process.cwd(),
    };
  }

  return {
    kind: "pi",
    command: "/bin/sh",
    args: [
      "-lc",
      "echo 'agent-room: could not find pi. Set AGENTROOM_OPERATOR_COMMAND or keep the pi checkout at ../pi or ./pi.' >&2; exit 127",
    ],
    cwd: process.cwd(),
  };
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
      "Usage: agent-room-tui [--daemon <url>] [--refresh-ms <ms>]\n",
    );
    process.exit(0);
  }
  const baseUrl = argValue("--daemon") ?? process.env.AGENTROOM_DAEMON;
  const refreshMs = argValue("--refresh-ms");
  await runAgentRoomTui({
    ...(baseUrl ? { baseUrl } : {}),
    ...(refreshMs ? { refreshMs: Number(refreshMs) } : {}),
  });
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
