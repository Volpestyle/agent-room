import {
  Container,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { PanelBase } from "../components/panel.js";
import { palette } from "../theme.js";
import { SLASH_COMMANDS } from "./slash-commands.js";
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
        palette.muted(
          "Press / from any view to jump to Chat command mode · Esc opens the arrow-key view menu",
        ),
    );

    lines.push("");
    lines.push(palette.label("CHAT VIEW"));
    lines.push(
      "  " + palette.muted("Talk to the dashboard agent in plain language."),
    );
    lines.push(
      "  " +
        palette.muted(
          "It can post messages, summarize tracker context, launch/read/send to runtime agents.",
        ),
    );
    lines.push(
      "  " +
        palette.muted(
          "Scroll transcript history with terminal scrollback (trackpad/mouse or Shift+PgUp/PgDn).",
        ),
    );
    lines.push(
      "  " +
        palette.muted(
          "Slash commands: type /, use ↑/↓ to choose, then press Enter.",
        ),
    );
    for (const command of SLASH_COMMANDS) {
      const args = command.argumentHint ? " " + command.argumentHint : "";
      const label = `/${command.name}${args}`;
      lines.push(
        "    " +
          palette.accent(label.padEnd(28)) +
          palette.muted(command.description ?? ""),
      );
    }

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
