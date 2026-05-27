import {
  Container,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { PanelBase } from "../components/panel.js";
import { palette } from "../theme.js";
import type { DashboardStore } from "../state.js";
import type { View } from "./types.js";

class WorkspacesPanel extends PanelBase {
  constructor(private readonly store: DashboardStore) {
    super();
  }

  render(width: number): string[] {
    const state = this.store.get();
    const lines: string[] = [];

    lines.push("");
    lines.push(palette.label("WORKSPACES"));
    if (state.workspaces.length === 0) {
      lines.push("  " + palette.muted("(no workspaces registered)"));
    } else {
      for (const workspace of state.workspaces) {
        lines.push(
          `  ${palette.accent(workspace.label)} ${palette.muted("id=" + workspace.id)}`,
        );
        lines.push("    " + palette.muted(workspace.cwd));
        if (workspace.runtime) {
          lines.push(
            "    " +
              palette.muted(
                `runtime=${workspace.runtime.providerId}:${workspace.runtime.bindingId}`,
              ),
          );
        }
      }
    }

    return lines.map((line) => fit(line, width));
  }
}

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

export function createWorkspacesView(store: DashboardStore): View {
  const root = new Container();
  root.addChild(new WorkspacesPanel(store));
  return {
    id: "workspaces",
    label: "Workspaces",
    hotkey: "w",
    description: "Registered cwd workspaces",
    root,
  };
}
