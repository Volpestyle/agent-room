#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  Editor,
  ProcessTerminal,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
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
type MouseAction =
  | { type: "view"; view: ViewName }
  | { type: "provider"; providerId: string }
  | { type: "agent"; agentId: string }
  | { type: "task"; taskId: string }
  | { type: "message"; messageId: string };

interface HitZone {
  row: number;
  startCol: number;
  endCol: number;
  action: MouseAction;
}

interface MouseEvent {
  kind: "press" | "release" | "wheel-up" | "wheel-down";
  button: "left" | "middle" | "right" | "wheel" | "unknown";
  row: number;
  col: number;
}

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
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";
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
  tui.setFocus(app.editor);
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
  private selectedAgentIndex = 0;
  private selectedTaskIndex = 0;
  private selectedMessageIndex = Number.MAX_SAFE_INTEGER;
  private isRefreshing = false;
  private mouseEnabled = false;
  private lastError: string | undefined;
  private notices: string[] = [];
  private hitZones: HitZone[] = [];
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
      void this.submit(value);
    };
  }

  start(): void {
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, this.refreshMs);
    this.enableMouse();
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.disableMouse();
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  handleGlobalInput(data: string): { consume?: boolean } | undefined {
    const mouseEvent = parseMouseEvent(data);
    if (mouseEvent) {
      this.handleMouse(mouseEvent);
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+r")) {
      void this.refresh();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+n")) {
      this.changeView(1);
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+p")) {
      this.changeView(-1);
      return { consume: true };
    }
    if (matchesKey(data, "alt+up")) {
      this.changeSelection(-1);
      return { consume: true };
    }
    if (matchesKey(data, "alt+down")) {
      this.changeSelection(1);
      return { consume: true };
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
    this.hitZones = [];
    const fullWidth = Math.max(40, width);
    const editorLines = this.editor.render(fullWidth);
    const headerLines = this.renderHeader(fullWidth);
    const navRow = headerLines.length + 1;
    const navLines = [this.renderNav(fullWidth, navRow)];
    const noticeLines = this.renderNotices(fullWidth);
    const footerLines = this.renderFooter(fullWidth);
    const reserved =
      headerLines.length +
      navLines.length +
      noticeLines.length +
      footerLines.length +
      editorLines.length;
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
      ...editorLines,
    ];

    return lines.map((line) => padLine(line, fullWidth));
  }

  private renderHeader(width: number): string[] {
    const room = this.snapshot.health?.roomId ?? "offline";
    const daemon = this.snapshot.health?.ok
      ? style.green("online")
      : style.red("offline");
    const refresh = this.isRefreshing ? style.amber("refreshing") : style.dim("idle");
    return [
      padLine(
        `${style.bold("agent-room")} ${style.dim(this.client.base)}  room ${style.cyan(room)}  daemon ${daemon}  ${refresh}`,
        width,
      ),
      rule(width),
    ];
  }

  private renderNav(width: number, row: number): string {
    let col = 1;
    const parts = VIEWS.map((view, index) => {
      const label = ` ${view} `;
      this.addHitZone({
        row,
        startCol: col,
        endCol: col + label.length - 1,
        action: { type: "view", view },
      });
      col += label.length + 1;
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
      ["assigned", "claimed", "working", "ready-for-review", "blocked"].includes(
        task.status,
      ),
    );
    const totalAgents = Object.values(this.snapshot.providerAgents).reduce(
      (total, agents) => total + agents.length,
      0,
    );
    const providerLines =
      this.snapshot.providers.length === 0
        ? [style.dim("no runtime providers loaded")]
        : this.snapshot.providers.map((provider, index) =>
            this.renderProviderLine(provider, width, startRow + 5 + index),
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
          this.addHitZone({
            row: startRow + this.snapshot.providers.length + 4 + index,
            startCol: 1,
            endCol: width,
            action: { type: "agent", agentId: agent.id },
          });
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
      ...this.snapshot.providers.map((provider, index) =>
        this.renderProviderLine(provider, width, startRow + 1 + index),
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
    row: number,
  ): string {
    this.addHitZone({
      row,
      startCol: 1,
      endCol: width,
      action: { type: "provider", providerId: provider.id },
    });
    const agents = this.snapshot.providerAgents[provider.id] ?? [];
    const selected = provider.id === this.selectedProviderId;
    const marker = selected ? "> " : "  ";
    const health = provider.health;
    const status =
      health === undefined
        ? style.dim("configured")
        : health.ok
          ? agents.length > 0
            ? style.green(`${agents.length} active ${plural(agents.length, "agent")}`)
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
          this.addHitZone({
            row: startRow + 1 + index,
            startCol: 1,
            endCol: width,
            action: { type: "task", taskId: task.id },
          });
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
        this.addHitZone({
          row: startRow + 1 + visibleIndex,
          startCol: 1,
          endCol: width,
          action: { type: "message", messageId: message.id },
        });
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
    return [rule(width), ...notices.map((notice) => truncateToWidth(notice, width, ""))];
  }

  private renderFooter(width: number): string[] {
    const selectedAgent = this.selectedAgent()?.id ?? "none";
    const selectedTask = this.selectedTask()?.id ?? "none";
    const selectedMessage = this.selectedMessage()?.id ?? "none";
    return [
      rule(width),
      truncateToWidth(
        style.dim(
          `click nav/provider/agent/task/message  wheel select  ctrl+n/p view  ctrl+r refresh  selected agent ${selectedAgent} task ${selectedTask} msg ${selectedMessage}`,
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
      } else if (this.currentView() === "agents" && this.selectedAgent()) {
        await this.sendToAgent(this.selectedAgent()!.id, value);
      } else {
        await this.postMessage("announcements", value);
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
      case "help":
        this.notice(
          "/post [#channel] text | /send [agent] text | /task title | /rename [task] title | /desc [task] text | /delete [task] [reason] | /claim [task] agent | /status [task] status [summary]",
        );
        return;
      case "refresh":
        await this.refresh();
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
        const channel = first?.startsWith("#") ? first.slice(1) : "announcements";
        const body = first?.startsWith("#") ? args.slice(1).join(" ") : args.join(" ");
        await this.postMessage(channel, body);
        return;
      }
      case "send": {
        const selected = this.selectedAgent()?.id;
        const target = args[0] && this.hasAgent(args[0]) ? args[0] : selected;
        const body = target === args[0] ? args.slice(1).join(" ") : args.join(" ");
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
        await this.client.claimTask(target.task.id, { kind: "agent", id: agentId });
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
          ...(summaryParts.length > 0 ? { summary: summaryParts.join(" ") } : {}),
        });
        this.notice(`updated ${target.task.id} to ${status}`);
        return;
      }
      case "launch": {
        const [agentId, maybeRole, maybeHarness, ...rest] = args;
        if (!agentId) throw new Error("Usage: /launch <agentId> [role] [harness] [command...]");
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
    this.notice(`launched ${agentId}`);
  }

  private async readAgentOutput(
    providerId: string,
    agentId: string,
  ): Promise<string | undefined> {
    try {
      const { output } = await this.client.readRuntimeAgent(providerId, agentId, 160);
      return output.text;
    } catch {
      return undefined;
    }
  }

  private handleMouse(event: MouseEvent): void {
    if (event.kind === "wheel-up") {
      this.changeSelection(-1);
      return;
    }
    if (event.kind === "wheel-down") {
      this.changeSelection(1);
      return;
    }
    if (event.kind !== "press" || event.button !== "left") return;

    const zone = this.hitZones.find(
      (candidate) =>
        candidate.row === event.row &&
        event.col >= candidate.startCol &&
        event.col <= candidate.endCol,
    );
    if (!zone) return;

    this.activateMouseAction(zone.action);
  }

  private activateMouseAction(action: MouseAction): void {
    switch (action.type) {
      case "view":
        this.viewIndex = VIEWS.indexOf(action.view);
        this.tui.requestRender();
        return;
      case "provider":
        this.selectedProviderId = action.providerId;
        this.selectedAgentIndex = 0;
        this.snapshot.agents = this.snapshot.providerAgents[action.providerId] ?? [];
        void this.refresh();
        this.tui.requestRender();
        return;
      case "agent": {
        const index = this.snapshot.agents.findIndex(
          (agent) => agent.id === action.agentId,
        );
        if (index >= 0) {
          this.selectedAgentIndex = index;
          this.viewIndex = VIEWS.indexOf("agents");
          void this.refresh();
          this.tui.requestRender();
        }
        return;
      }
      case "task": {
        const index = this.snapshot.tasks.findIndex(
          (task) => task.id === action.taskId,
        );
        if (index >= 0) {
          this.selectedTaskIndex = index;
          this.viewIndex = VIEWS.indexOf("tasks");
          this.tui.requestRender();
        }
        return;
      }
      case "message": {
        const index = this.snapshot.messages.findIndex(
          (message) => message.id === action.messageId,
        );
        if (index >= 0) {
          this.selectedMessageIndex = index;
          this.viewIndex = VIEWS.indexOf("messages");
          this.tui.requestRender();
        }
        return;
      }
    }
  }

  private addHitZone(zone: HitZone): void {
    this.hitZones.push(zone);
  }

  private enableMouse(): void {
    if (this.mouseEnabled) return;
    this.terminal.write(ENABLE_MOUSE);
    this.mouseEnabled = true;
  }

  private disableMouse(): void {
    if (!this.mouseEnabled) return;
    this.terminal.write(DISABLE_MOUSE);
    this.mouseEnabled = false;
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
    }
    this.tui.requestRender();
  }

  private selectProvider(providerId: string | undefined): void {
    if (!providerId) throw new Error("Usage: /provider <providerId>");
    if (!this.snapshot.providers.some((provider) => provider.id === providerId)) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    this.selectedProviderId = providerId;
    this.selectedAgentIndex = 0;
    this.notice(`selected provider ${providerId}`);
  }

  private selectById(id: string | undefined): void {
    if (!id) throw new Error("Usage: /select <agentId|taskId|messageId>");
    const agentIndex = this.snapshot.agents.findIndex((agent) => agent.id === id);
    if (agentIndex >= 0) {
      this.selectedAgentIndex = agentIndex;
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

  private selectedTask(): Task | undefined {
    return this.snapshot.tasks[this.selectedTaskIndex];
  }

  private selectedMessage(): Message | undefined {
    return this.snapshot.messages[this.selectedMessageIndex];
  }

  private hasAgent(agentId: string): boolean {
    return this.snapshot.agents.some((agent) => agent.id === agentId);
  }

  private hasTask(taskId: string): boolean {
    return this.snapshot.tasks.some((task) => task.id === taskId);
  }

  private resolveTaskCommandTarget(
    args: string[],
    usage: string,
  ): { task: Task; rest: string[] } {
    const first = args[0];
    if (first && this.hasTask(first)) {
      const task = this.snapshot.tasks.find((candidate) => candidate.id === first);
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
    const runtimeHealth = runtimeById.get(provider.id)?.health ?? provider.health;
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

function isHarnessKind(value: string | undefined): value is HarnessSpec["kind"] {
  return (
    value === "claude-code" ||
    value === "pi" ||
    value === "codex" ||
    value === "gemini-cli" ||
    value === "shell" ||
    value === "custom"
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function parseMouseEvent(data: string): MouseEvent | undefined {
  const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (!match) return undefined;

  const code = Number(match[1]);
  const col = Number(match[2]);
  const row = Number(match[3]);
  if (!Number.isFinite(code) || !Number.isFinite(col) || !Number.isFinite(row)) {
    return undefined;
  }

  if (code === 64) {
    return { kind: "wheel-up", button: "wheel", row, col };
  }
  if (code === 65) {
    return { kind: "wheel-down", button: "wheel", row, col };
  }

  if (match[4] === "m") {
    return { kind: "release", button: "unknown", row, col };
  }

  const buttonCode = code & 3;
  const button =
    buttonCode === 0
      ? "left"
      : buttonCode === 1
        ? "middle"
        : buttonCode === 2
          ? "right"
          : "unknown";
  return { kind: "press", button, row, col };
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
