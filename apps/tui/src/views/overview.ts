import { Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PanelBase } from "../components/panel.js";
import { palette, statusColor } from "../theme.js";
import type { DashboardStore } from "../state.js";
import type { View } from "./types.js";

class OverviewPanel extends PanelBase {
  constructor(private readonly store: DashboardStore) {
    super();
  }

  render(width: number): string[] {
    const state = this.store.get();
    const lines: string[] = [];

    const headerLabel = palette.label("AGENT ROOM");
    const roomId = state.health?.roomId ?? state.config?.roomId ?? "unknown";
    const cwd = state.config?.cwd ?? "(unknown)";
    const refreshedAt = state.lastRefreshAt
      ? new Date(state.lastRefreshAt).toLocaleTimeString()
      : "—";

    lines.push("");
    lines.push(headerLabel + "  " + palette.accentBold(roomId));
    lines.push(palette.muted(`cwd: ${cwd}`));
    lines.push(
      palette.muted(`refreshed: ${refreshedAt}`) +
        (state.lastError ? "  " + palette.bad(`error: ${state.lastError}`) : ""),
    );

    lines.push("");
    lines.push(palette.label("DAEMON"));
    if (!state.health) {
      lines.push("  " + palette.muted("awaiting first refresh…"));
    } else {
      const status = state.health.ok
        ? palette.good("online")
        : palette.bad("offline");
      lines.push(
        `  status: ${status}   pid: ${palette.accent(String(state.health.pid))}`,
      );
      lines.push(palette.muted("  runtimes:"));
      if (state.health.runtimes.length === 0) {
        lines.push("    " + palette.muted("(none configured)"));
      } else {
        for (const provider of state.health.runtimes) {
          const ok = provider.health?.ok ?? true;
          const dot = ok ? palette.good("●") : palette.bad("●");
          const message = provider.health?.message;
          lines.push(
            `    ${dot} ${palette.accent(provider.id)} ${palette.muted("(" + provider.kind + ")")}` +
              (message ? `  ${palette.muted(message)}` : ""),
          );
        }
      }
      if (state.health.chatGateways.length > 0) {
        lines.push(palette.muted("  chat gateways:"));
        for (const gw of state.health.chatGateways) {
          const dot = gw.health.ok ? palette.good("●") : palette.bad("●");
          const note = gw.health.message ?? gw.startupError;
          lines.push(
            `    ${dot} ${palette.accent(gw.id)} ${palette.muted("(" + gw.kind + ")")}` +
              (note ? `  ${palette.muted(note)}` : ""),
          );
        }
      }
    }

    lines.push("");
    lines.push(palette.label("SUMMARY"));
    const counts = [
      ["agents", state.runtimeAgents.length],
      ["tasks", state.tasks.length],
      ["messages", state.messages.length],
      ["events", state.events.length],
    ] as const;
    for (const [name, count] of counts) {
      lines.push(
        `  ${palette.muted(name.padEnd(10))} ${palette.accentBold(String(count))}`,
      );
    }

    lines.push("");
    lines.push(palette.label("TASKS BY STATUS"));
    if (state.tasks.length === 0) {
      lines.push("  " + palette.muted("(no tasks)"));
    } else {
      const grouped = new Map<string, number>();
      for (const task of state.tasks) {
        grouped.set(task.status, (grouped.get(task.status) ?? 0) + 1);
      }
      for (const [status, count] of [...grouped.entries()].sort()) {
        lines.push(`  ${statusColor(status)(status.padEnd(20))} ${count}`);
      }
    }

    lines.push("");
    lines.push(
      palette.muted(
        "Press Esc to switch views, or use the hotkeys shown in the header.",
      ),
    );

    return lines.map((line) => fit(line, width));
  }
}

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

export function createOverviewView(store: DashboardStore): View {
  const root = new Container();
  root.addChild(new OverviewPanel(store));
  return {
    id: "overview",
    label: "Overview",
    hotkey: "o",
    description: "Room summary and daemon health",
    root,
  };
}
