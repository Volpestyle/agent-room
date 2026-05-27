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
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { editorTheme, markdownTheme, palette } from "../theme.js";
import type { AuthStorage } from "../auth/storage.js";
import { buildLoginCallbacks } from "../auth/login-flow.js";
import { showLoginOverlay } from "../auth/login-overlay.js";
import { dashboardActor } from "../agent/identity.js";
import type {
  DashboardAgent,
  DashboardAgentError,
} from "../agent/index.js";
import type { ApiClient } from "../api.js";
import type { Poller } from "../poller.js";
import type { View } from "./types.js";

const SLASH_COMMANDS = [
  { name: "help", description: "Show help view" },
  { name: "clear", description: "Clear the chat transcript" },
  { name: "refresh", description: "Force a dashboard refresh" },
  { name: "post", description: "Post raw text to the room as the dashboard agent" },
  { name: "login", description: "Sign in to a provider (default: openai)" },
  { name: "logout", description: "Sign out of a provider" },
  { name: "quit", description: "Exit the dashboard" },
];

const OPENAI_LOGIN_PROVIDER = "openai-codex";

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
  auth: AuthStorage;
  agent: DashboardAgent | DashboardAgentError;
  rebuildAgent(): DashboardAgent | DashboardAgentError;
  onCommand(cmd: string): boolean;
}

interface ChatViewHandle extends View {
  focus(): void;
}

export function createChatView(options: ChatViewOptions): ChatViewHandle {
  const { tui, api, poller, auth, rebuildAgent, onCommand } = options;
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
    addLine(
      new Markdown(palette.human("you ▸ ") + text, 1, 0, markdownTheme),
    );
  }

  function addSystemNote(text: string): void {
    addLine(new TextLine(palette.muted("· " + text)));
  }

  function addErrorNote(text: string): void {
    addLine(new TextLine(palette.bad("× " + text)));
  }

  function beginAssistant(): StreamingMarkdown {
    const md = new StreamingMarkdown(palette.agent("dashboard ▸ "));
    addLine(md);
    activeAssistant = md;
    return md;
  }

  function renderBanner(agent: DashboardAgent | DashboardAgentError): void {
    if ("reason" in agent) {
      transcript.addChild(
        new Text(
          palette.warn("Dashboard agent disabled.") +
            " " +
            palette.muted(agent.reason),
          1,
          1,
        ),
      );
      transcript.addChild(
        new Text(
          palette.muted(
            "Run /login openai (ChatGPT Plus/Pro), or /post <text> to broadcast directly.",
          ),
          1,
          0,
        ),
      );
    } else {
      transcript.addChild(
        new Text(
          palette.muted("Dashboard agent: ") +
            palette.accentBold(agent.agentId) +
            palette.muted(" · model ") +
            palette.accent(
              `${agent.resolvedModel.provider}/${agent.resolvedModel.modelId}`,
            ) +
            palette.muted(` · auth ${agent.resolvedModel.source}`),
          1,
          1,
        ),
      );
      transcript.addChild(
        new Text(
          palette.muted(
            "Talk to it in plain language. /help · /clear · /refresh · /post · /login · /logout · /quit",
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
        stopLoader();
        beginAssistant();
      }
    } else if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      if (!activeAssistant) beginAssistant();
      activeAssistant!.append(event.assistantMessageEvent.delta);
      tui.requestRender();
    } else if (event.type === "tool_execution_start") {
      addSystemNote(`tool ${event.toolName} …`);
    } else if (event.type === "tool_execution_end") {
      if (event.isError) {
        const detail =
          event.result && typeof event.result === "object"
            ? (event.result as { errorMessage?: string }).errorMessage
            : undefined;
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
      overlay.setError(
        error instanceof Error ? error.message : String(error),
      );
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
      await currentAgent.prompt(text);
    } catch (error) {
      stopLoader();
      setBusy(false);
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
        addSystemNote(`posted as ${dashboardActor().id} (${result.message.id})`);
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

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}
