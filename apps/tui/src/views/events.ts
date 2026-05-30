import {
  Container,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { PanelBase } from "../components/panel.js";
import { palette } from "../theme.js";
import type { DashboardStore } from "../state.js";
import type { RoomEvent } from "../types.js";
import type { View } from "./types.js";

class EventsPanel extends PanelBase {
  constructor(private readonly store: DashboardStore) {
    super();
  }

  render(width: number): string[] {
    const state = this.store.get();
    const lines: string[] = [];
    lines.push("");
    lines.push(palette.label("EVENT STREAM"));
    if (state.events.length === 0) {
      lines.push("  " + palette.muted("(no events)"));
    } else {
      const sorted = [...state.events]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-200);
      for (const event of sorted) {
        const time = new Date(event.createdAt).toLocaleTimeString();
        const typeColor = colorForType(event.type);
        const header = `  ${palette.muted(time)} ${typeColor(event.type.padEnd(26))} ${palette.muted(event.id)}`;
        lines.push(fit(header, width));
        const summary = summarize(event);
        if (summary) {
          lines.push(fit("    " + palette.muted(summary), width));
        }
      }
    }
    return lines.map((line) => fit(line, width));
  }
}

function colorForType(type: string): (s: string) => string {
  if (type.startsWith("message.")) return palette.accent;
  if (type.startsWith("task.")) return palette.label;
  if (type.startsWith("agent.")) return palette.agent;
  if (type.startsWith("runtime.")) return palette.warn;
  if (type.startsWith("human_escalation.")) return palette.bad;
  if (type.startsWith("approval.")) return palette.warn;
  if (type.startsWith("chat.")) return palette.system;
  return palette.muted;
}

function summarize(event: RoomEvent): string {
  switch (event.type) {
    case "message.posted":
      return summarizeMessagePosted(event.payload.message);
    case "task.created":
      return `${event.payload.task.title}`;
    case "task.status_changed":
      return `${event.payload.taskId} → ${event.payload.status}`;
    case "task.completed":
      return `${event.payload.taskId} terminal=${event.payload.status}`;
    case "delegation.created":
      return `${event.payload.delegation.taskId} → ${event.payload.delegation.agentId}`;
    case "delegation.resolved":
      return `${event.payload.taskId} → ${event.payload.agentId} state=${event.payload.state}`;
    case "task.assigned":
      return `${event.payload.taskId} → ${event.payload.assignee.kind}:${event.payload.assignee.id}`;
    case "agent.joined":
      return `${event.payload.agent.id} (${event.payload.agent.role})`;
    case "agent.left":
      return `${event.payload.agentId}${event.payload.reason ? " · " + event.payload.reason : ""}`;
    case "agent.heartbeat":
      return `${event.payload.agentId} state=${event.payload.state}`;
    case "agent.finished":
      return `${event.payload.agentId} state=${event.payload.state}`;
    case "runtime.output_observed":
      return `${event.payload.agentId} +${event.payload.lineCount ?? 0} lines`;
    case "runtime.input_sent":
      return `${event.payload.agentId} ← ${truncateToWidth(event.payload.text, 60, "")}`;
    case "runtime.state_observed":
      return `${event.payload.agentId} state=${event.payload.state}`;
    case "runtime.bound":
      return `${event.payload.agentId} runtime=${event.payload.runtime.providerId} binding=${event.payload.runtime.bindingId}`;
    case "human_escalation.created":
      return `from=${event.payload.escalation.from.id} q="${truncateToWidth(event.payload.escalation.question, 60, "")}"`;
    case "human_escalation.answered":
      return `${event.payload.escalationId}`;
    default:
      return "";
  }
}

function summarizeMessagePosted(message: {
  channelId?: string;
  sender: { kind: string; id: string };
  body: string;
}): string {
  const flat = message.body.replace(/\s+/g, " ").trim();
  const body = flat.length > 80 ? flat.slice(0, 79) + "…" : flat;
  const channel = message.channelId ? `#${message.channelId} ` : "";
  return `${channel}${message.sender.kind}:${message.sender.id} — ${body}`;
}

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

export function createEventsView(store: DashboardStore): View {
  const root = new Container();
  root.addChild(new EventsPanel(store));
  return {
    id: "events",
    label: "Events",
    hotkey: "e",
    description: "Append-only audit stream",
    root,
  };
}
