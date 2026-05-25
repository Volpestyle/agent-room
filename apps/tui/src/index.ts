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
  app.start();
  tui.start();
}

class AgentRoomTuiApp implements Component {
  public readonly editor: Editor;
  private readonly refreshMs: number;
  private refreshTimer: NodeJS.Timeout | undefined;
  private viewIndex = 0;
  private selectedProviderId: string | undefined;
  private selectedAgentIndex = 0;
  private selectedTaskIndex = 0;
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
    const editorLines = this.editor.render(fullWidth);
    const headerLines = this.renderHeader(fullWidth);
    const navLines = [this.renderNav(fullWidth)];
    const noticeLines = this.renderNotices(fullWidth);
    const footerLines = this.renderFooter(fullWidth);
    const reserved =
      headerLines.length +
      navLines.length +
      noticeLines.length +
      footerLines.length +
      editorLines.length;
    const contentHeight = Math.max(4, this.terminal.rows - reserved);
    const contentLines = this.renderCurrentView(fullWidth, contentHeight);
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

  private renderNav(width: number): string {
    const parts = VIEWS.map((view, index) => {
      const label = ` ${view} `;
      return index === this.viewIndex ? style.inverse(label) : style.dim(label);
    });
    return truncateToWidth(parts.join(" "), width, "");
  }

  private renderCurrentView(width: number, height: number): string[] {
    const view = VIEWS[this.viewIndex] ?? "overview";
    const lines =
      view === "overview"
        ? this.renderOverview(width)
        : view === "agents"
          ? this.renderAgents(width)
          : view === "tasks"
            ? this.renderTasks(width)
            : view === "messages"
              ? this.renderMessages(width)
              : this.renderEvents(width);

    return fitLines(lines, width, height);
  }

  private renderOverview(width: number): string[] {
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

  private renderTasks(width: number): string[] {
    const tasks = this.snapshot.tasks.length
      ? this.snapshot.tasks.map((task, index) => {
          const prefix = index === this.selectedTaskIndex ? "> " : "  ";
          const assignee = task.assignee?.id ?? "unassigned";
          return `${prefix}${renderTaskStatus(task.status)} ${truncateToWidth(task.title, Math.max(18, width - 44), "")} ${style.dim(`${task.id} ${assignee}`)}`;
        })
      : [style.dim("no tasks")];

    const selected = this.selectedTask();
    return [
      section("tasks"),
      ...tasks,
      "",
      section("selected"),
      ...(selected
        ? [
            `${style.bold(selected.title)} ${style.dim(selected.id)}`,
            `status ${selected.status}  assignee ${selected.assignee?.id ?? "none"}`,
            ...(selected.description
              ? wrapTextWithAnsi(selected.description, width)
              : []),
          ]
        : [style.dim("no selected task")]),
    ];
  }

  private renderMessages(width: number): string[] {
    const messages = this.snapshot.messages.slice(-30);
    return [
      section("messages"),
      ...messages.map((message) => {
        const channel = message.channelId ?? "announcements";
        const sender = message.sender.displayName ?? message.sender.id;
        const head = `${style.cyan(sender)} ${style.dim(`#${channel}`)} `;
        return truncateToWidth(`${head}${message.body.replace(/\s+/g, " ")}`, width, "");
      }),
      ...emptyHint(messages, "no messages"),
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
    return [
      rule(width),
      truncateToWidth(
        style.dim(
          `ctrl+n/p view  alt+up/down select  ctrl+r refresh  selected agent ${selectedAgent} task ${selectedTask}`,
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
          "/post [channel] text | /send [agent] text | /task title | /claim task agent | /status task status [summary] | /launch id [role] [harness] [command...]",
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
      case "claim": {
        const [taskId, agentId] = args;
        if (!taskId || !agentId) throw new Error("Usage: /claim <taskId> <agentId>");
        await this.client.claimTask(taskId, { kind: "agent", id: agentId });
        this.notice(`claimed ${taskId} for ${agentId}`);
        return;
      }
      case "status": {
        const [taskId, status, ...summaryParts] = args;
        if (!taskId || !isTaskStatus(status)) {
          throw new Error(`Usage: /status <taskId> <${TASK_STATUSES.join("|")}>`);
        }
        await this.client.updateTaskStatus(taskId, {
          status,
          actor: humanActor(),
          ...(summaryParts.length > 0 ? { summary: summaryParts.join(" ") } : {}),
        });
        this.notice(`updated ${taskId} to ${status}`);
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
    if (!id) throw new Error("Usage: /select <agentId|taskId>");
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
    throw new Error(`No agent or task found for ${id}`);
  }

  private selectedAgent(): RuntimeAgent | undefined {
    return this.snapshot.agents[this.selectedAgentIndex];
  }

  private selectedTask(): Task | undefined {
    return this.snapshot.tasks[this.selectedTaskIndex];
  }

  private hasAgent(agentId: string): boolean {
    return this.snapshot.agents.some((agent) => agent.id === agentId);
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
