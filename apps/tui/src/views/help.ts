import {
  Container,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { PanelBase } from "../components/panel.js";
import { palette } from "../theme.js";
import type { View } from "./types.js";

class HelpPanel extends PanelBase {
  constructor(private readonly hotkeyHint: () => string) {
    super();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push("");
    lines.push(palette.label("AGENT ROOM DASHBOARD"));
    lines.push(
      palette.muted(
        "Hybrid TUI: dashboard + the dashboard-agent who lives in the room.",
      ),
    );

    lines.push("");
    lines.push(palette.label("VIEWS"));
    lines.push("  " + this.hotkeyHint());
    lines.push(
      "  " +
        palette.muted("Ctrl+G / Ctrl+L cycle views · Esc opens the view menu"),
    );

    lines.push("");
    lines.push(palette.label("CHAT VIEW"));
    lines.push(
      "  " + palette.muted("Talk to the dashboard agent in plain language."),
    );
    lines.push(
      "  " +
        palette.muted(
          "It can post messages, manage tasks, launch/read/send to runtime agents.",
        ),
    );
    lines.push("  " + palette.muted("Built-in slash commands:"));
    lines.push(
      "    " +
        palette.accent("/help") +
        palette.muted("           this screen"),
    );
    lines.push(
      "    " +
        palette.accent("/setup") +
        palette.muted("          guided room setup and config status"),
    );
    lines.push(
      "    " +
        palette.accent("/config") +
        palette.muted("         current AgentRoom config summary"),
    );
    lines.push(
      "    " +
        palette.accent("/refresh") +
        palette.muted("        force a poll"),
    );
    lines.push(
      "    " +
        palette.accent("/clear") +
        palette.muted("          clear the chat transcript"),
    );
    lines.push(
      "    " +
        palette.accent("/copy") +
        palette.muted(
          "           copy the last dashboard reply to the clipboard",
        ),
    );
    lines.push(
      "    " +
        palette.accent("/login [provider]") +
        palette.muted(" OAuth sign-in (default: openai → ChatGPT Plus/Pro)"),
    );
    lines.push(
      "    " +
        palette.accent("/logout <provider>") +
        palette.muted(" clear stored credentials"),
    );
    lines.push(
      "    " +
        palette.accent("/effort [level]") +
        palette.muted(" show or set effort: off|minimal|low|medium|high|xhigh"),
    );
    lines.push(
      "    " +
        palette.accent("/trace [mode]") +
        palette.muted("  show or set stream trace: off|tools|full"),
    );
    lines.push(
      "    " +
        palette.accent("/logs") +
        palette.muted("          open searchable dashboard-agent logs"),
    );
    lines.push(
      "    " +
        palette.accent("/runtime [provider]") +
        palette.muted(" show runtime sessions, sockets, and workspace ids"),
    );
    lines.push(
      "    " +
        palette.accent("/post <text>") +
        palette.muted("     post raw text to the room as the dashboard agent"),
    );
    lines.push(
      "    " +
        palette.accent("/quit") +
        palette.muted("           exit the dashboard"),
    );

    lines.push("");
    lines.push(palette.label("ENVIRONMENT"));
    lines.push(
      "  " +
        palette.muted(
          "AGENTROOM_DAEMON          base URL of the daemon (default http://127.0.0.1:4317)",
        ),
    );
    lines.push(
      "  " +
        palette.muted(
          "AGENTROOM_API_TOKEN       bearer token if --tailnet daemon",
        ),
    );
    lines.push(
      "  " +
        palette.muted(
          "AGENTROOM_TUI_OPERATOR_ID id of the dashboard agent (default: dashboard)",
        ),
    );
    lines.push(
      "  " +
        palette.muted(
          "AGENTROOM_TUI_MODEL          provider/model (default: openai-codex/gpt-5.5 if signed in)",
        ),
    );
    lines.push(
      "  " +
        palette.muted(
          "AGENTROOM_TUI_THINKING_LEVEL off|minimal|low|medium|high|xhigh (default: medium)",
        ),
    );
    lines.push(
      "  " +
        palette.muted(
          "AGENTROOM_TUI_TRACE          off|tools|full (default: full)",
        ),
    );
    lines.push(
      "  " +
        palette.muted(
          "ANTHROPIC_API_KEY etc.    LLM provider creds (chat is read-only without)",
        ),
    );

    return lines.map((line) => fit(line, width));
  }
}

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

export function createHelpView(hotkeyHint: () => string): View {
  const root = new Container();
  root.addChild(new HelpPanel(hotkeyHint));
  return {
    id: "help",
    label: "Help",
    hotkey: "?",
    description: "Hotkeys, env vars, dashboard agent capabilities",
    root,
  };
}
