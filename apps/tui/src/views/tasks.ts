import { Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PanelBase } from "../components/panel.js";
import { palette, statusColor } from "../theme.js";
import type { DashboardStore } from "../state.js";
import type { View } from "./types.js";

class TasksPanel extends PanelBase {
  constructor(private readonly store: DashboardStore) {
    super();
  }

  render(width: number): string[] {
    const state = this.store.get();
    const lines: string[] = [];
    lines.push("");
    lines.push(palette.label("TASKS"));
    if (state.tasks.length === 0) {
      lines.push("  " + palette.muted("(no tasks)"));
    } else {
      const sorted = [...state.tasks].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
      for (const task of sorted) {
        const status = statusColor(task.status)(task.status.padEnd(20));
        const assignee = task.assignee
          ? palette.muted(` → ${task.assignee.kind}:${task.assignee.id}`)
          : palette.muted(" (unassigned)");
        const title = palette.accent(task.title);
        lines.push(`  ${status} ${palette.muted(task.id)} ${title}${assignee}`);
        if (task.description) {
          lines.push(
            "    " + palette.muted(oneLine(task.description, width - 6)),
          );
        }
        if (task.refs && task.refs.length > 0) {
          const refs = task.refs
            .map((ref) => `${ref.kind}:${ref.id}`)
            .join("  ");
          lines.push("    " + palette.muted("refs: " + refs));
        }
      }
    }

    return lines.map((line) => fit(line, width));
  }
}

function oneLine(value: string, width: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > width ? flat.slice(0, Math.max(0, width - 1)) + "…" : flat;
}

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

export function createTasksView(store: DashboardStore): View {
  const root = new Container();
  root.addChild(new TasksPanel(store));
  return {
    id: "tasks",
    label: "Tasks",
    hotkey: "t",
    description: "Local task shadows / queue",
    root,
  };
}
