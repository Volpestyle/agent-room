import { Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PanelBase } from "../components/panel.js";
import { actorColor, palette } from "../theme.js";
import type { DashboardStore } from "../state.js";
import type { View } from "./types.js";

class MessagesPanel extends PanelBase {
  constructor(private readonly store: DashboardStore) {
    super();
  }

  render(width: number): string[] {
    const state = this.store.get();
    const lines: string[] = [];
    lines.push("");
    lines.push(palette.label("RECENT MESSAGES"));
    if (state.messages.length === 0) {
      lines.push("  " + palette.muted("(no messages)"));
    } else {
      const sorted = [...state.messages]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-40);
      for (const message of sorted) {
        const time = new Date(message.createdAt).toLocaleTimeString();
        const sender = actorColor(message.sender.kind)(
          message.sender.displayName ?? message.sender.id,
        );
        const channel = message.channelId
          ? palette.muted("#" + message.channelId + " ")
          : "";
        const kind =
          message.kind && message.kind !== "chat"
            ? palette.faint(" [" + message.kind + "]")
            : "";
        const importance =
          message.importance && message.importance !== "normal"
            ? palette.warn(" {" + message.importance + "}")
            : "";
        const header = `  ${palette.muted(time)} ${channel}${sender}${kind}${importance}`;
        lines.push(fit(header, width));
        for (const bodyLine of wrapBody(message.body, width - 4)) {
          lines.push("    " + bodyLine);
        }
      }
    }

    return lines.map((line) => fit(line, width));
  }
}

function wrapBody(body: string, width: number): string[] {
  if (width <= 0) return [body];
  const out: string[] = [];
  for (const paragraph of body.split(/\n+/)) {
    if (paragraph.length === 0) {
      out.push("");
      continue;
    }
    let remaining = paragraph;
    while (remaining.length > width) {
      const sliceAt = lastSpaceBefore(remaining, width) || width;
      out.push(remaining.slice(0, sliceAt).trimEnd());
      remaining = remaining.slice(sliceAt).trimStart();
    }
    if (remaining) out.push(remaining);
  }
  return out;
}

function lastSpaceBefore(value: string, limit: number): number {
  const idx = value.lastIndexOf(" ", limit);
  return idx > 0 ? idx : 0;
}

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

export function createMessagesView(store: DashboardStore): View {
  const root = new Container();
  root.addChild(new MessagesPanel(store));
  return {
    id: "messages",
    label: "Messages",
    hotkey: "m",
    description: "Room messages across channels and DMs",
    root,
  };
}
