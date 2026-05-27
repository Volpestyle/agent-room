import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Loader,
  Markdown,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { editorTheme, markdownTheme, palette } from "../theme.js";
import type { AuthStorage } from "../auth/storage.js";
import { buildLoginCallbacks } from "../auth/login-flow.js";
import { showLoginOverlay } from "../auth/login-overlay.js";
import { dashboardActor } from "../agent/identity.js";
import {
  DASHBOARD_THINKING_LEVELS,
  parseDashboardThinkingLevel,
  type DashboardAgent,
  type DashboardAgentError,
  type DashboardThinkingLevel,
} from "../agent/index.js";
import type { ApiClient } from "../api.js";
import type { Poller } from "../poller.js";
import type { DashboardState, DashboardStore } from "../state.js";
import type { RuntimeAgent } from "../types.js";
import type { View } from "./types.js";

const SLASH_COMMANDS = [
  { name: "help", description: "Show help view" },
  { name: "clear", description: "Clear the chat transcript" },
  { name: "refresh", description: "Force a dashboard refresh" },
  {
    name: "post",
    description: "Post raw text to the room as the dashboard agent",
  },
  { name: "login", description: "Sign in to a provider (default: openai)" },
  { name: "logout", description: "Sign out of a provider" },
  { name: "effort", description: "Show or set model effort level" },
  { name: "trace", description: "Show or set transcript trace mode" },
  { name: "runtime", description: "Show runtime session/socket status" },
  { name: "quit", description: "Exit the dashboard" },
];

const OPENAI_LOGIN_PROVIDER = "openai-codex";
const TRACE_MODES = ["off", "tools", "full"] as const;
type TraceMode = (typeof TRACE_MODES)[number];

class TextLine implements Component {
  constructor(public text: string) {}
  setText(text: string): void {
    this.text = text;
  }
  render(width: number): string[] {
    return [fit(this.text, width)];
  }
  invalidate(): void {}
}

class StreamingMarkdown implements Component {
  private content: string;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  constructor(initial: string) {
    this.content = initial;
  }
  append(chunk: string): void {
    this.content += chunk;
    this.invalidate();
  }
  setContent(content: string): void {
    this.content = content;
    this.invalidate();
  }
  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const md = new Markdown(this.content, 1, 0, markdownTheme);
    const lines = md.render(width);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

export interface ChatViewOptions {
  tui: TUI;
  api: ApiClient;
  poller: Poller;
  store: DashboardStore;
  auth: AuthStorage;
  agent: DashboardAgent | DashboardAgentError;
  rebuildAgent(
    thinkingLevel?: DashboardThinkingLevel,
  ): DashboardAgent | DashboardAgentError;
  onCommand(cmd: string): boolean;
}

interface ChatViewHandle extends View {
  focus(): void;
}

export function createChatView(options: ChatViewOptions): ChatViewHandle {
  const { tui, api, poller, store, auth, rebuildAgent, onCommand } = options;
  const transcript = new Container();
  const editor = new Editor(tui, editorTheme);
  const root = new Container();
  root.addChild(transcript);
  root.addChild(editor);

  let currentAgent: DashboardAgent | DashboardAgentError = options.agent;
  let agentUnsubscribe: (() => void) | undefined;

  const autocompleteProvider = new CombinedAutocompleteProvider(
    SLASH_COMMANDS.map((c) => ({
      name: c.name,
      description: c.description,
    })),
    process.cwd(),
  );
  editor.setAutocompleteProvider(autocompleteProvider);

  let busy = false;
  let activeAssistant: StreamingMarkdown | undefined;
  let activeLoader: Loader | undefined;
  let traceMode = parseTraceMode(process.env.AGENTROOM_TUI_TRACE) ?? "full";

  function addLine(line: Component): void {
    transcript.addChild(line);
    tui.requestRender();
  }

  function setBusy(value: boolean): void {
    busy = value;
    editor.disableSubmit = value;
    tui.requestRender();
  }

  function startLoader(message: string): Loader {
    if (activeLoader) return activeLoader;
    activeLoader = new Loader(
      tui,
      (s) => palette.accent(s),
      (s) => palette.muted(s),
      message,
    );
    addLine(activeLoader);
    activeLoader.start();
    return activeLoader;
  }

  function stopLoader(): void {
    if (activeLoader) {
      activeLoader.stop();
      transcript.removeChild(activeLoader);
      activeLoader = undefined;
      tui.requestRender();
    }
  }

  function addUserBubble(text: string): void {
    addLine(new Markdown(palette.human("you ▸ ") + text, 1, 0, markdownTheme));
  }

  function addSystemNote(text: string): void {
    addLine(new TextLine(palette.muted("· " + text)));
  }

  function addErrorNote(text: string): void {
    addLine(new TextLine(palette.bad("× " + text)));
  }

  function beginAssistant(): StreamingMarkdown {
    const md = new StreamingMarkdown(assistantPrefix());
    addLine(md);
    activeAssistant = md;
    return md;
  }

  function assistantPrefix(): string {
    return palette.agent("dashboard ▸ ");
  }

  function updateAssistant(message: AgentMessage): void {
    if (message.role !== "assistant") return;
    const content = renderAssistantMessage(message, traceMode);
    if (!content && !activeAssistant) return;
    stopLoader();
    const md = activeAssistant ?? beginAssistant();
    md.setContent(assistantPrefix() + content);
    tui.requestRender();
  }

  const banner = new Container();

  function renderBanner(agent: DashboardAgent | DashboardAgentError): void {
    if (!transcript.children.includes(banner)) {
      transcript.addChild(banner);
    }
    banner.clear();
    if ("reason" in agent) {
      banner.addChild(
        new Text(
          palette.warn("Dashboard agent disabled.") +
            " " +
            palette.muted(agent.reason),
          1,
          1,
        ),
      );
      banner.addChild(
        new Text(
          palette.muted(
            "Run /login openai (ChatGPT Plus/Pro), or /post <text> to broadcast directly.",
          ),
          1,
          0,
        ),
      );
    } else {
      banner.addChild(
        new Text(
          palette.muted("Dashboard agent: ") +
            palette.accentBold(agent.agentId) +
            palette.muted(" · model ") +
            palette.accent(
              `${agent.resolvedModel.provider}/${agent.resolvedModel.modelId}`,
            ) +
            palette.muted(" · effort ") +
            palette.accent(effortLabel(agent)) +
            palette.muted(" · trace ") +
            palette.accent(traceMode) +
            palette.muted(` · auth ${agent.resolvedModel.source}`),
          1,
          1,
        ),
      );
      banner.addChild(
        new Text(
          palette.muted(
            "Talk to it in plain language. /help · /clear · /refresh · /post · /login · /logout · /effort · /trace · /runtime · /quit",
          ),
          1,
          0,
        ),
      );
    }
    tui.requestRender();
  }

  function onAgentEvent(event: AgentEvent): void {
    if (event.type === "agent_start") {
      stopLoader();
      startLoader("Thinking…");
    } else if (event.type === "agent_end") {
      stopLoader();
      setBusy(false);
      activeAssistant = undefined;
    } else if (event.type === "message_start") {
      if (event.message.role === "assistant") {
        updateAssistant(event.message);
      }
    } else if (event.type === "message_update") {
      updateAssistant(event.message);
    } else if (event.type === "message_end") {
      if (event.message.role === "assistant") {
        updateAssistant(event.message);
        activeAssistant = undefined;
      }
    } else if (event.type === "tool_execution_start") {
      stopLoader();
      if (traceMode !== "off") {
        addSystemNote(`tool ${event.toolName} …`);
      }
    } else if (event.type === "tool_execution_end") {
      if (traceMode === "off") {
        return;
      }
      if (event.isError) {
        const detail = toolFailureDetail(event.result);
        addErrorNote(
          `tool ${event.toolName} failed${detail ? ": " + detail : ""}`,
        );
      } else {
        addSystemNote(`tool ${event.toolName} ok`);
      }
    }
  }

  function attachAgent(agent: DashboardAgent | DashboardAgentError): void {
    if (agentUnsubscribe) {
      agentUnsubscribe();
      agentUnsubscribe = undefined;
    }
    currentAgent = agent;
    if (!("reason" in agent)) {
      agentUnsubscribe = agent.subscribe((event) => {
        onAgentEvent(event);
        return undefined;
      });
    }
  }

  renderBanner(currentAgent);
  attachAgent(currentAgent);

  async function runLogin(providerArg: string): Promise<void> {
    const providerId = normalizeLoginProvider(providerArg);
    if (!providerId) {
      addErrorNote(`unknown login provider: ${providerArg}`);
      return;
    }
    addSystemNote(`opening /login ${providerId} …`);

    const overlay = showLoginOverlay(tui, providerId);
    try {
      await auth.login(
        providerId,
        buildLoginCallbacks({
          onAuth: (info) => overlay.setUrl(info.url, info.instructions),
          onProgress: (msg) => overlay.setStatus(msg),
          readManualCode: () => overlay.manualCode,
        }),
      );
      overlay.close();
      tui.setFocus(editor);
      addSystemNote(`logged in to ${providerId}.`);
      const rebuilt = rebuildAgent();
      attachAgent(rebuilt);
      renderBanner(rebuilt);
    } catch (error) {
      overlay.setError(error instanceof Error ? error.message : String(error));
      // give the user a beat to read the error, then drop the overlay
      setTimeout(() => {
        overlay.close();
        tui.setFocus(editor);
      }, 1500);
      addErrorNote(
        `login failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function runLogout(providerArg: string | undefined): void {
    if (!providerArg) {
      addErrorNote("usage: /logout <provider>");
      return;
    }
    const providerId = normalizeLoginProvider(providerArg) ?? providerArg;
    if (!auth.get(providerId)) {
      addErrorNote(`no stored credentials for ${providerId}.`);
      return;
    }
    auth.remove(providerId);
    addSystemNote(`logged out of ${providerId}.`);
    const rebuilt = rebuildAgent();
    attachAgent(rebuilt);
    renderBanner(rebuilt);
  }

  function reportLoginStatus(): void {
    const stored = auth.list();
    if (stored.length === 0) {
      addSystemNote("no stored credentials. Try /login openai.");
      return;
    }
    for (const providerId of stored) {
      const status = auth.status(providerId);
      addSystemNote(
        `${providerId}: ${status.source}${status.label ? " (" + status.label + ")" : ""}`,
      );
    }
  }

  function runTrace(modeArg: string | undefined): void {
    if (!modeArg) {
      addSystemNote(
        `trace ${traceMode}. Set with /trace ${TRACE_MODES.join("|")}`,
      );
      return;
    }
    const next = parseTraceMode(modeArg);
    if (!next) {
      addErrorNote(`unknown trace '${modeArg}'. Use ${TRACE_MODES.join("|")}`);
      return;
    }
    traceMode = next;
    renderBanner(currentAgent);
    addSystemNote(`trace set to ${traceMode}.`);
  }

  async function runRuntime(providerArg: string | undefined): Promise<void> {
    try {
      const [{ providers }, health] = await Promise.all([
        api.listRuntimeProviders(),
        api.health(),
      ]);
      const selected = providerArg
        ? providers.filter((provider) => provider.id === providerArg)
        : providers;
      if (selected.length === 0) {
        addErrorNote(`unknown runtime provider: ${providerArg}`);
        return;
      }

      for (const provider of selected) {
        const runtimeHealth = health.runtimes.find(
          (candidate) => candidate.id === provider.id,
        )?.health;
        const [sessionsResult, agentsResult] = await Promise.all([
          api.listRuntimeSessions(provider.id).catch((error) => ({
            error,
            sessions: [],
          })),
          api.listRuntimeAgents(provider.id).catch((error) => ({
            error,
            agents: [],
          })),
        ]);
        addLine(
          new Markdown(
            runtimeSummaryMarkdown({
              provider,
              health: runtimeHealth,
              sessions: sessionsResult.sessions,
              agents: agentsResult.agents,
            }),
            1,
            0,
            markdownTheme,
          ),
        );
        if ("error" in sessionsResult) {
          addErrorNote(
            `runtime ${provider.id} sessions: ${formatError(sessionsResult.error)}`,
          );
        }
        if ("error" in agentsResult) {
          addErrorNote(
            `runtime ${provider.id} agents: ${formatError(agentsResult.error)}`,
          );
        }
      }
    } catch (error) {
      addErrorNote(formatError(error));
    }
  }

  function runEffort(levelArg: string | undefined): void {
    if (!levelArg) {
      if ("reason" in currentAgent) {
        addErrorNote(
          "Dashboard agent is disabled; effort will apply after credentials are configured.",
        );
      } else {
        addSystemNote(
          `effort ${effortLabel(currentAgent)}. Set with /effort ${DASHBOARD_THINKING_LEVELS.join("|")}`,
        );
      }
      return;
    }

    if (busy) {
      addErrorNote(
        "cannot change effort while the dashboard agent is responding",
      );
      return;
    }

    const level = parseDashboardThinkingLevel(levelArg);
    if (!level) {
      addErrorNote(
        `unknown effort '${levelArg}'. Use ${DASHBOARD_THINKING_LEVELS.join("|")}`,
      );
      return;
    }

    const rebuilt = rebuildAgent(level);
    attachAgent(rebuilt);
    renderBanner(rebuilt);
    if (!("reason" in rebuilt)) {
      addSystemNote(`effort set to ${effortLabel(rebuilt)}.`);
    }
  }

  async function handleSubmit(value: string): Promise<void> {
    const text = value.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      const handled = await handleSlash(text);
      if (handled) return;
    }
    if ("reason" in currentAgent) {
      addErrorNote(
        "Dashboard agent disabled — try /login openai, or /post <text> to send the message to the room.",
      );
      return;
    }
    addUserBubble(text);
    setBusy(true);
    try {
      await poller.tick();
      void api
        .agentHeartbeat(dashboardActor().id, {
          state: "working",
          status: "responding",
        })
        .catch(() => undefined);
      await currentAgent.prompt(promptWithDashboardContext(text, store.get()));
      void api
        .agentHeartbeat(dashboardActor().id, {
          state: "idle",
          status: "ready",
        })
        .catch(() => undefined);
    } catch (error) {
      stopLoader();
      setBusy(false);
      void api
        .agentHeartbeat(dashboardActor().id, {
          state: "needs-human",
          status: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      addErrorNote(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleSlash(input: string): Promise<boolean> {
    const [cmdRaw, ...rest] = input.slice(1).split(/\s+/);
    const cmd = (cmdRaw ?? "").toLowerCase();
    const remainder = input.slice(1 + (cmdRaw ?? "").length).trim();

    if (cmd === "clear") {
      transcript.clear();
      renderBanner(currentAgent);
      return true;
    }
    if (cmd === "refresh") {
      addSystemNote("refreshing…");
      await poller.tick();
      addSystemNote("refreshed.");
      return true;
    }
    if (cmd === "post") {
      if (!remainder) {
        addErrorNote("usage: /post <text>");
        return true;
      }
      try {
        const result = await api.postMessage({
          body: remainder,
          sender: dashboardActor(),
        });
        addSystemNote(
          `posted as ${dashboardActor().id} (${result.message.id})`,
        );
        void poller.tick();
      } catch (error) {
        addErrorNote(error instanceof Error ? error.message : String(error));
      }
      return true;
    }
    if (cmd === "login") {
      const provider = (rest[0] ?? "openai").toLowerCase();
      if (!rest[0]) {
        reportLoginStatus();
      }
      await runLogin(provider);
      return true;
    }
    if (cmd === "logout") {
      runLogout(rest[0]?.toLowerCase());
      return true;
    }
    if (cmd === "effort" || cmd === "thinking") {
      runEffort(rest[0]?.toLowerCase());
      return true;
    }
    if (cmd === "trace") {
      runTrace(rest[0]?.toLowerCase());
      return true;
    }
    if (cmd === "runtime" || cmd === "runtimes") {
      await runRuntime(rest[0]);
      return true;
    }
    if (onCommand(cmd)) return true;
    addErrorNote(`unknown command: /${cmd}`);
    return true;
  }

  editor.onSubmit = (value: string) => {
    if (busy) return;
    void handleSubmit(value);
  };

  return {
    id: "chat",
    label: "Chat",
    hotkey: "c",
    description: "Talk to the dashboard agent",
    root,
    onActivate: (ctx) => ctx.setFocus(editor),
    focus: () => tui.setFocus(editor),
  };
}

function normalizeLoginProvider(value: string): string | undefined {
  const v = value.toLowerCase();
  if (v === "openai" || v === "openai-codex" || v === "chatgpt") {
    return OPENAI_LOGIN_PROVIDER;
  }
  return undefined;
}

function promptWithDashboardContext(
  text: string,
  state: DashboardState,
): string {
  return `${dashboardContext(state)}\n\nUser request:\n${text}`;
}

function dashboardContext(state: DashboardState): string {
  const roomId = state.health?.roomId ?? state.config?.roomId ?? "unknown";
  const cwd = state.config?.cwd ?? "unknown";
  const defaultRuntime =
    state.config?.defaultRuntime ??
    state.providers.find((provider) => provider.default)?.id ??
    "unknown";
  const runtimeHealth = new Map(
    (state.health?.runtimes ?? []).map((runtime) => [
      runtime.id,
      runtime.health,
    ]),
  );
  const runtimes = state.providers.length
    ? state.providers
        .map((provider) => {
          const health = runtimeHealth.get(provider.id);
          const defaultMark = provider.id === defaultRuntime ? " default" : "";
          const status = health?.status ?? "unknown";
          return `${provider.id}(${provider.kind}${defaultMark}, ${status})`;
        })
        .join(", ")
    : "none";
  const visibleRuntimeAgents = state.runtimeAgents.filter(({ agent }) =>
    isDetectedRuntimeAgent(agent),
  );
  const visibleRoomAgents = state.agents.filter(isActiveRoomAgent);
  const agents = visibleRuntimeAgents.length
    ? visibleRuntimeAgents
        .slice(0, 12)
        .map(
          ({ providerId, agent }) =>
            `${providerId}:${agent.id}[${agent.state}, binding=${agent.bindingId}]`,
        )
        .join(", ")
    : "none";
  const roomAgents = visibleRoomAgents.length
    ? visibleRoomAgents
        .slice(0, 12)
        .map((agent) => {
          const runtime = agent.runtime
            ? `${agent.runtime.providerId}:${agent.runtime.bindingId}`
            : "local";
          return `${agent.id}[${agent.state}, role=${agent.role}, runtime=${runtime}]`;
        })
        .join(", ")
    : "none";
  const taskSummary = summarizeTasks(state);
  const recentMessages = state.messages
    .slice(-5)
    .map(
      (message) =>
        `${message.sender.id}: ${message.body.replace(/\s+/g, " ").slice(0, 120)}`,
    )
    .join(" | ");

  return [
    "AgentRoom dashboard context (current daemon/TUI state; not a user request):",
    `- roomId: ${roomId}`,
    `- cwd: ${cwd}`,
    `- defaultRuntime: ${defaultRuntime}`,
    `- runtimes: ${runtimes}`,
    `- roomAgents: ${roomAgents}`,
    `- runtimeAgents: ${agents}`,
    `- tasks: ${taskSummary}`,
    ...(recentMessages ? [`- recentMessages: ${recentMessages}`] : []),
    ...(state.lastError ? [`- lastError: ${state.lastError}`] : []),
    "Use this context for dashboard questions and do not ask for details already present here.",
  ].join("\n");
}

function isDetectedRuntimeAgent(agent: RuntimeAgent): boolean {
  const label = agent.metadata?.["agent"];
  return (
    (typeof label === "string" && label.length > 0) ||
    agent.id !== agent.bindingId
  );
}

function isActiveRoomAgent(agent: { state: string }): boolean {
  return agent.state !== "stopped";
}

function summarizeTasks(state: DashboardState): string {
  if (state.tasks.length === 0) return "none";
  const counts = new Map<string, number>();
  for (const task of state.tasks) {
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");
}

function effortLabel(agent: DashboardAgent): string {
  if (agent.requestedThinkingLevel === agent.thinkingLevel) {
    return agent.thinkingLevel;
  }
  return `${agent.thinkingLevel} (requested ${agent.requestedThinkingLevel})`;
}

function parseTraceMode(value: string | undefined): TraceMode | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && (TRACE_MODES as readonly string[]).includes(normalized)
    ? (normalized as TraceMode)
    : undefined;
}

function renderAssistantMessage(
  message: AgentMessage,
  traceMode: TraceMode,
): string {
  if (message.role !== "assistant") return "";
  const visible: string[] = [];
  for (const content of message.content) {
    if (content.type === "text" && content.text.length > 0) {
      visible.push(content.text);
    } else if (traceMode === "full" && content.type === "thinking") {
      if (content.redacted) {
        visible.push(palette.muted("\n\nthinking ▸ [redacted]"));
      } else if (content.thinking.trim().length > 0) {
        visible.push(palette.muted(`\n\nthinking ▸ ${content.thinking}`));
      }
    } else if (traceMode !== "off" && content.type === "toolCall") {
      visible.push(
        palette.muted(
          `\n\ntool request ▸ ${content.name} ${formatJsonInline(content.arguments)}`,
        ),
      );
    }
  }
  if (message.stopReason === "error") {
    visible.push(
      palette.bad(`\n\nError: ${message.errorMessage ?? "Unknown error"}`),
    );
  } else if (message.stopReason === "aborted") {
    visible.push(
      palette.warn(`\n\n${message.errorMessage ?? "Operation aborted"}`),
    );
  }
  return visible.join("");
}

function runtimeSummaryMarkdown(input: {
  provider: { id: string; kind: string };
  health:
    | {
        ok: boolean;
        status: string;
        message?: string;
        metadata?: Record<string, unknown>;
      }
    | undefined;
  sessions: Array<{
    id: string;
    name?: string;
    cwd?: string;
    metadata?: Record<string, unknown>;
  }>;
  agents: Array<{
    id: string;
    bindingId: string;
    state: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }>;
}): string {
  const { provider, health, sessions, agents } = input;
  const metadata = health?.metadata ?? {};
  const session = stringValue(metadata.session) ?? sessions[0]?.id;
  const socketPath = stringValue(metadata.socketPath);
  const cli = stringValue(metadata.cli);
  const workspaceLabel = stringValue(metadata.workspaceLabel);
  const workspaceIds = unique(
    agents
      .map(
        (agent) => agent.sessionId ?? stringValue(agent.metadata?.workspaceId),
      )
      .filter((value): value is string => Boolean(value)),
  );
  const status = health?.ok ? "ok" : (health?.status ?? "unknown");
  const lines = [
    `${palette.agent("runtime ▸ ")}${palette.accent(provider.id)} ${palette.muted("(" + provider.kind + ")")} ${palette.muted("status ")}${status}`,
  ];
  if (session) lines.push(`- session namespace: \`${session}\``);
  if (socketPath) lines.push(`- socket: \`${socketPath}\``);
  if (workspaceLabel)
    lines.push(`- AgentRoom workspace label: \`${workspaceLabel}\``);
  if (workspaceIds.length > 0) {
    lines.push(
      `- workspace id${workspaceIds.length === 1 ? "" : "s"}: ${workspaceIds.map((id) => `\`${id}\``).join(", ")} ${palette.muted("(not a --session value)")}`,
    );
  }
  if (provider.kind === "herdr") {
    const attach =
      cli && session
        ? `${cli} --session ${session}`
        : session
          ? `herdr --session ${session}`
          : undefined;
    if (attach) lines.push(`- join: \`${attach}\``);
  }
  lines.push(`- agents: ${agents.length}`);
  return lines.join("\n");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function formatJsonInline(value: unknown): string {
  const json = JSON.stringify(value);
  if (!json) return "";
  return json.length > 500 ? json.slice(0, 497) + "..." : json;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolFailureDetail(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.errorMessage === "string" && record.errorMessage.trim()) {
    return trimDetail(record.errorMessage);
  }

  const content = record.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const item = entry as Record<string, unknown>;
      return item.type === "text" && typeof item.text === "string"
        ? item.text
        : "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
  return text ? trimDetail(text) : undefined;
}

function trimDetail(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 500
    ? normalized.slice(0, 497) + "..."
    : normalized;
}

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}
