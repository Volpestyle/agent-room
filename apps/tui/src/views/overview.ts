import {
  Container,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { PanelBase } from "../components/panel.js";
import { palette } from "../theme.js";
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
        (state.lastError
          ? "  " + palette.bad(`error: ${state.lastError}`)
          : ""),
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
          lines.push(
            `    ${dot} ${palette.accent(provider.id)} ${palette.muted("(" + provider.kind + ")")}` +
              `  ${palette.muted(provider.health?.status ?? "unknown")}`,
          );
          for (const detail of runtimeDetailLines(
            provider,
            state.runtimeAgents,
          )) {
            lines.push("      " + detail);
          }
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
      ["room agents", state.agents.length],
      ["runtime panes", state.runtimeAgents.length],
      ["workspaces", state.workspaces.length],
      ["messages", state.messages.length],
      ["events", state.events.length],
    ] as const;
    for (const [name, count] of counts) {
      lines.push(
        `  ${palette.muted(name.padEnd(10))} ${palette.accentBold(String(count))}`,
      );
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

function runtimeDetailLines(
  provider: {
    id: string;
    kind: string;
    health?: { message?: string; metadata?: Record<string, unknown> };
  },
  runtimeAgents: Array<{
    providerId: string;
    agent: { sessionId?: string; metadata?: Record<string, unknown> };
  }>,
): string[] {
  const metadata = provider.health?.metadata ?? {};
  const lines: string[] = [];
  const session = stringValue(metadata.session);
  const socketPath = stringValue(metadata.socketPath);
  const cli = stringValue(metadata.cli);
  const workspaceLabel = stringValue(metadata.workspaceLabel);
  const workspaceIds = unique(
    runtimeAgents
      .filter((snapshot) => snapshot.providerId === provider.id)
      .map(
        (snapshot) =>
          snapshot.agent.sessionId ??
          stringValue(snapshot.agent.metadata?.workspaceId),
      )
      .filter((value): value is string => Boolean(value)),
  );

  if (session) lines.push(`session: ${palette.accent(session)}`);
  if (socketPath) lines.push(`socket: ${palette.muted(socketPath)}`);
  if (workspaceLabel) {
    lines.push(`workspace label: ${palette.accent(workspaceLabel)}`);
  }
  if (workspaceIds.length > 0) {
    lines.push(
      `workspace id${workspaceIds.length === 1 ? "" : "s"}: ${workspaceIds.map((id) => palette.accent(id)).join(", ")} ${palette.faint("(not --session)")}`,
    );
  }
  if (provider.kind === "herdr" && session) {
    lines.push(
      `join: ${palette.accent(`${cli ?? "herdr"} --session ${session}`)}`,
    );
  } else if (provider.kind === "zellij" && session) {
    lines.push(
      `join: ${palette.accent(`${cli ?? "zellij"} attach ${session}`)}`,
    );
  }
  if (lines.length === 0 && provider.health?.message) {
    const firstLine = provider.health.message.split(/\r?\n/).find(Boolean);
    if (firstLine) lines.push(palette.muted(firstLine.trim()));
  }
  return lines;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
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
