import {
  Container,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { PanelBase } from "../components/panel.js";
import {
  roomAgentRuntimeLabel,
  roomAgentRuntimeTarget,
  runtimeAgentLabel,
} from "../runtime-agent-labels.js";
import { palette, statusColor } from "../theme.js";
import type { DashboardStore } from "../state.js";
import type { View } from "./types.js";

class AgentsPanel extends PanelBase {
  constructor(private readonly store: DashboardStore) {
    super();
  }

  render(width: number): string[] {
    const state = this.store.get();
    const lines: string[] = [];

    lines.push("");
    lines.push(palette.label("RUNTIME PROVIDERS"));
    if (state.providers.length === 0) {
      lines.push(
        "  " +
          palette.muted(
            "(no providers configured — set up .agentroom/config.yaml)",
          ),
      );
    } else {
      for (const provider of state.providers) {
        const caps = [
          provider.capabilities.startAgent ? "start" : "",
          provider.capabilities.adoptAgent ? "adopt" : "",
          provider.capabilities.readOutput ? "read" : "",
          provider.capabilities.sendInput ? "send" : "",
        ]
          .filter(Boolean)
          .join(", ");
        lines.push(
          `  ${palette.accent(provider.id)} ${palette.muted("(" + provider.kind + ")")}` +
            (caps ? "  " + palette.muted(caps) : ""),
        );
      }
    }

    lines.push("");
    lines.push(palette.label("ROOM AGENTS"));
    if (state.agents.length === 0) {
      lines.push("  " + palette.muted("(no room agents registered)"));
    } else {
      for (const agent of state.agents) {
        const stateBadge = statusColor(agent.state)(agent.state.padEnd(10));
        const runtime = agent.runtime
          ? `${agent.runtime.providerId}:${agent.runtime.bindingId}`
          : "local";
        const runtimeLabel = roomAgentRuntimeLabel(agent, state.runtimeAgents);
        const runtimeTarget = roomAgentRuntimeTarget(agent, state.runtimeAgents);
        const details = [
          "id=" + agent.id,
          "role=" + agent.role,
          "runtime=" + runtime,
          ...(runtimeLabel ? ["agent=" + runtimeLabel] : []),
          ...(agent.harness ? ["harness=" + agent.harness.kind] : []),
          ...(runtimeTarget ? ["target=" + runtimeTarget] : []),
        ];
        lines.push(
          `  ${stateBadge} ${palette.accent(agent.displayName)} ${palette.muted(details.join(" "))}`,
        );
        if (agent.capabilities && agent.capabilities.length > 0) {
          lines.push(
            "    " +
              palette.muted("capabilities: " + agent.capabilities.join(", ")),
          );
        }
      }
    }

    lines.push("");
    lines.push(palette.label("RUNTIME PANES"));
    if (state.runtimeAgents.length === 0) {
      lines.push(
        "  " +
          palette.muted("(no agents — ask the dashboard agent to launch one)"),
      );
    } else {
      for (const { providerId, agent } of state.runtimeAgents) {
        const stateBadge = statusColor(agent.state)(agent.state.padEnd(10));
        const display = agent.displayName ?? agent.id;
        const label = runtimeAgentLabel(agent);
        const session = agent.sessionId
          ? palette.muted(` session=${agent.sessionId}`)
          : "";
        const labelText = label ? palette.muted(` agent=${label}`) : "";
        lines.push(
          `  ${stateBadge} ${palette.accent(display)} ${palette.muted("id=" + agent.id + " runtime=" + providerId)}${labelText}${session}`,
        );
        if (agent.bindingId) {
          lines.push("    " + palette.muted("binding: " + agent.bindingId));
        }
      }
    }

    return lines.map((line) => fit(line, width));
  }
}

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

export function createAgentsView(store: DashboardStore): View {
  const root = new Container();
  root.addChild(new AgentsPanel(store));
  return {
    id: "agents",
    label: "Agents",
    hotkey: "a",
    description: "Runtime providers and live agents",
    root,
  };
}
