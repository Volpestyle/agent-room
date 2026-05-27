import {
  Container,
  Key,
  matchesKey,
  SelectList,
  TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
  Component,
  OverlayHandle,
  Terminal,
} from "@earendil-works/pi-tui";
import { PanelBase } from "./components/panel.js";
import type { AuthStorage } from "./auth/storage.js";
import type {
  DashboardAgent,
  DashboardAgentError,
  DashboardThinkingLevel,
} from "./agent/index.js";
import type { ApiClient } from "./api.js";
import type { Poller } from "./poller.js";
import { selectListTheme, palette } from "./theme.js";
import { dashboardActor } from "./agent/identity.js";
import type { DashboardStore } from "./state.js";
import { createAgentsView } from "./views/agents.js";
import { createChatView } from "./views/chat.js";
import { createEventsView } from "./views/events.js";
import { createHelpView } from "./views/help.js";
import { createMessagesView } from "./views/messages.js";
import { createOverviewView } from "./views/overview.js";
import { createTasksView } from "./views/tasks.js";
import { createWorkspacesView } from "./views/workspaces.js";
import type { View } from "./views/types.js";

const DASHBOARD_AGENT_CAPABILITIES = [
  "dashboard",
  "control-plane",
  "local-agent",
  "agentroom-operator",
] as const;

export interface DashboardOptions {
  terminal: Terminal;
  api: ApiClient;
  poller: Poller;
  store: DashboardStore;
  agent: DashboardAgent | DashboardAgentError;
  auth: AuthStorage;
  rebuildAgent(
    thinkingLevel?: DashboardThinkingLevel,
  ): DashboardAgent | DashboardAgentError;
  baseUrl: string;
}

class HeaderBar extends PanelBase {
  constructor(
    private readonly views: () => View[],
    private readonly activeId: () => string,
    private readonly store: DashboardStore,
    private readonly baseUrl: string,
    private readonly agentLabel: () => string,
  ) {
    super();
  }

  render(width: number): string[] {
    const state = this.store.get();
    const active = this.activeId();
    const tabs = this.views()
      .map((view) => {
        const label = `${view.label} ${palette.muted("(" + view.hotkey + ")")}`;
        return view.id === active
          ? palette.badgeActive(" " + view.label + " ")
          : palette.badge(" " + label + " ");
      })
      .join(" ");
    const room = state.health?.roomId ?? state.config?.roomId ?? "—";
    const right = `${palette.muted("room: ")}${palette.accentBold(room)}  ${palette.muted("daemon: ")}${palette.accent(stripScheme(this.baseUrl))}  ${palette.muted("agent: ")}${palette.accent(this.agentLabel())}`;
    const top = padWrapped(tabs, right, width);
    const status = renderStatusLines(state, width);
    return [...top, ...status];
  }
}

class FooterBar extends PanelBase {
  constructor(private readonly hint: () => string) {
    super();
  }
  render(width: number): string[] {
    return [fit(palette.muted(this.hint()), width)];
  }
}

class DashboardLayout extends PanelBase {
  constructor(
    private readonly header: Component,
    private readonly body: Component,
    private readonly footer: Component,
    private readonly terminal: Terminal,
  ) {
    super();
  }

  render(width: number): string[] {
    const height = Math.max(1, this.terminal.rows);
    const headerLines = this.header.render(width);
    const footerLines = this.footer.render(width);
    const spacerRows = height > headerLines.length + footerLines.length ? 2 : 0;
    const bodyRows = Math.max(
      0,
      height - headerLines.length - footerLines.length - spacerRows,
    );
    const bodyLines = this.body.render(width);
    const visibleBody =
      bodyRows > 0
        ? bodyLines.slice(Math.max(0, bodyLines.length - bodyRows))
        : [];

    const lines = [
      ...headerLines,
      ...Array(spacerRows > 0 ? 1 : 0).fill(""),
      ...visibleBody,
      ...Array(spacerRows > 1 ? 1 : 0).fill(""),
      ...footerLines,
    ];

    return lines.slice(0, height);
  }
}

function renderStatusLines(
  state: { lastError: string | undefined; lastRefreshAt: string | undefined },
  width: number,
): string[] {
  const refreshed = state.lastRefreshAt
    ? `refreshed ${new Date(state.lastRefreshAt).toLocaleTimeString()}`
    : "refreshing…";
  const error = state.lastError
    ? palette.bad(" · error: " + state.lastError)
    : "";
  return wrapFit(palette.muted(refreshed) + error, width);
}

export class Dashboard {
  private readonly tui: TUI;
  private readonly views: View[];
  private readonly viewIndexById: Map<string, number>;
  private activeIndex = 0;
  private currentViewContainer = new Container();
  private overlayHandle: OverlayHandle | undefined;
  private shuttingDown = false;
  private currentAgent: DashboardAgent | DashboardAgentError;
  private readonly closed: Promise<void>;
  private resolveClosed: () => void = () => undefined;

  constructor(private readonly options: DashboardOptions) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.tui = new TUI(options.terminal);
    options.store.subscribe(() => {
      this.tui.requestRender();
    });

    this.currentAgent = options.agent;
    const chatView = createChatView({
      tui: this.tui,
      api: options.api,
      poller: options.poller,
      store: options.store,
      auth: options.auth,
      agent: options.agent,
      rebuildAgent: (thinkingLevel) => {
        if (!("reason" in this.currentAgent)) {
          try {
            this.currentAgent.abort();
          } catch {
            // ignore — agent may already be settled
          }
        }
        const next = options.rebuildAgent(thinkingLevel);
        this.currentAgent = next;
        if (!("reason" in next)) {
          void this.announceJoin(next);
        } else {
          void this.announceLeave("dashboard agent disabled");
        }
        return next;
      },
      onCommand: (cmd) => {
        if (cmd === "quit" || cmd === "exit") {
          void this.shutdown();
          return true;
        }
        if (cmd === "help") {
          this.switchToId("help");
          return true;
        }
        return false;
      },
    });

    this.views = [
      chatView,
      createOverviewView(options.store),
      createWorkspacesView(options.store),
      createAgentsView(options.store),
      createTasksView(options.store),
      createMessagesView(options.store),
      createEventsView(options.store),
      createHelpView(() => this.hotkeyHint()),
    ];
    this.viewIndexById = new Map(this.views.map((v, i) => [v.id, i]));

    const header = new HeaderBar(
      () => this.views,
      () => this.views[this.activeIndex]!.id,
      options.store,
      options.baseUrl,
      () =>
        "reason" in this.currentAgent
          ? "disabled"
          : `${this.currentAgent.agentId}@${this.currentAgent.resolvedModel.provider} effort=${this.currentAgent.thinkingLevel}`,
    );
    const footer = new FooterBar(() => this.hotkeyHint());
    const layout = new DashboardLayout(
      header,
      this.currentViewContainer,
      footer,
      options.terminal,
    );

    this.tui.addChild(layout);

    this.tui.addInputListener((data) => this.onGlobalInput(data));

    this.activateView(0, false);
  }

  hotkeyHint(): string {
    return (
      this.views
        .map((v) => `${palette.accent(v.label)} ${palette.faint(v.hotkey)}`)
        .join("  ") +
      "  " +
      palette.muted("Ctrl+G next · Ctrl+L prev · Esc view picker · Ctrl+C quit")
    );
  }

  async start(): Promise<void> {
    this.tui.start();
    if (!("reason" in this.currentAgent)) {
      await this.announceJoin(this.currentAgent);
    }
    this.options.poller.start();
    await this.closed;
  }

  private async announceJoin(agent: DashboardAgent): Promise<void> {
    try {
      await this.options.api.registerRoomAgent({
        agentId: dashboardActor().id,
        displayName: "Dashboard",
        role: "lead",
        capabilities: [...DASHBOARD_AGENT_CAPABILITIES],
      });
      await this.options.api.agentHeartbeat(dashboardActor().id, {
        state: "idle",
        status: `${agent.resolvedModel.provider}/${agent.resolvedModel.modelId}`,
      });
      await this.options.api.postMessage({
        body:
          `📊 Dashboard agent **${dashboardActor().id}** is online — using model ` +
          `${agent.resolvedModel.provider}/${agent.resolvedModel.modelId} ` +
          `with effort ${agent.thinkingLevel}.`,
        sender: dashboardActor(),
        kind: "announcement",
      });
    } catch {
      // ignore — the daemon may be unreachable at boot
    }
  }

  private async announceLeave(reason: string): Promise<void> {
    try {
      await this.options.api.leaveRoomAgent(dashboardActor().id, { reason });
    } catch {
      // ignore
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.options.poller.stop();
    if (!("reason" in this.currentAgent)) {
      try {
        this.currentAgent.abort();
      } catch {
        // ignore — agent may already be settled
      }
      try {
        await this.options.api.postMessage({
          body: `Dashboard agent ${dashboardActor().id} signing off.`,
          sender: dashboardActor(),
          kind: "announcement",
        });
      } catch {
        // ignore
      }
      await this.announceLeave("dashboard shutdown");
    }
    this.tui.stop();
    this.resolveClosed();
  }

  private activateView(index: number, forceFullRender = true): void {
    const previous = this.views[this.activeIndex];
    previous?.onDeactivate?.();
    this.activeIndex = index;
    const next = this.views[index]!;
    this.currentViewContainer.clear();
    this.currentViewContainer.addChild(next.root);
    next.onActivate?.({
      setFocus: (component) => this.tui.setFocus(component),
    });
    if (!next.onActivate) {
      this.tui.setFocus(null);
    }
    this.tui.requestRender(forceFullRender);
  }

  private switchToId(id: string): void {
    const index = this.viewIndexById.get(id);
    if (index === undefined) return;
    this.activateView(index);
  }

  private cycleView(delta: number): void {
    const next =
      (this.activeIndex + delta + this.views.length) % this.views.length;
    this.activateView(next);
  }

  private onGlobalInput(data: string): { consume?: boolean } | undefined {
    if (matchesKey(data, Key.ctrl("c"))) {
      void this.shutdown();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("g"))) {
      this.cycleView(1);
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("l"))) {
      this.cycleView(-1);
      return { consume: true };
    }
    if (matchesKey(data, Key.escape)) {
      if (!this.overlayHandle) {
        this.openViewPicker();
        return { consume: true };
      }
    }
    return undefined;
  }

  private openViewPicker(): void {
    const items = this.views.map((view) => ({
      value: view.id,
      label: view.label,
      description: view.description ?? "",
    }));
    const list = new SelectList(items, 10, selectListTheme);
    list.onSelect = (item) => {
      this.closeOverlay();
      this.switchToId(item.value);
    };
    list.onCancel = () => this.closeOverlay();
    this.overlayHandle = this.tui.showOverlay(list, {
      width: 50,
      anchor: "center",
    });
  }

  private closeOverlay(): void {
    if (this.overlayHandle) {
      this.overlayHandle.hide();
      this.overlayHandle = undefined;
    }
  }
}

function pad(left: string, right: string, width: number): string {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  const space = Math.max(1, width - leftWidth - rightWidth);
  if (leftWidth + rightWidth + 1 > width) {
    return fit(left + " " + right, width);
  }
  return left + " ".repeat(space) + right;
}

function padWrapped(left: string, right: string, width: number): string[] {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + rightWidth + 1 <= width) {
    return [pad(left, right, width)];
  }
  return wrapFit(left + " " + right, width);
}

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

function wrapFit(line: string, width: number): string[] {
  return wrapTextWithAnsi(line, Math.max(1, width)).map((part) =>
    fit(part, width),
  );
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
