import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Focusable } from "@earendil-works/pi-tui";
import type {
  DashboardAgentLogger,
  DashboardLogEntry,
  DashboardLogLevel,
} from "../agent/dashboard-log.js";
import { PanelBase } from "../components/panel.js";
import { palette } from "../theme.js";
import type { View, ViewActivationContext } from "./types.js";

interface LogsViewOptions {
  logger: DashboardAgentLogger;
  requestRender: () => void;
}

class LogsPanel extends PanelBase implements Focusable {
  private readonly searchInput = new Input();
  private selectedKey: string | undefined;
  private readonly expanded = new Set<string>();
  private _focused = false;

  constructor(
    private readonly logger: DashboardAgentLogger,
    private readonly requestRender: () => void,
  ) {
    super();
    logger.subscribe(() => {
      this.requestRender();
    });
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  render(width: number): string[] {
    const query = this.searchInput.getValue().trim();
    const filtered = filteredEntries(this.logger.recentEntries(), query);
    const selectedIndex = selectedIndexFor(filtered, this.selectedKey);
    const selected = filtered[selectedIndex];
    const lines: string[] = [
      "",
      palette.label("DASHBOARD AGENT LOGS"),
      "  " + palette.muted("path: ") + palette.accent(this.logger.path),
    ];
    if (this.logger.lastError) {
      lines.push(
        "  " + palette.bad("log write/read error: " + this.logger.lastError),
      );
    }
    const searchLine =
      "  " +
      palette.muted("search: ") +
      (this.searchInput.render(Math.max(1, width - 12))[0] ?? "");
    lines.push(fit(searchLine, width));
    lines.push(
      fit(
        "  " +
          palette.muted(
            "type to filter - Up/Down move - Enter expands - full JSONL stays on disk",
          ),
        width,
      ),
    );
    lines.push(
      fit(
        "  " +
          palette.muted(
            `${filtered.length}/${this.logger.recentEntries().length} entries` +
              (selected ? ` - selected ${selectedIndex + 1}` : ""),
          ),
        width,
      ),
    );
    lines.push("");

    if (filtered.length === 0) {
      lines.push(
        "  " + palette.muted("(no dashboard-agent log entries match)"),
      );
      return lines.map((line) => fit(line, width));
    }

    for (const entry of visibleWindow(filtered, selectedIndex)) {
      const key = entryKey(entry);
      const isSelected = selected !== undefined && key === entryKey(selected);
      lines.push(renderEntryLine(entry, isSelected, width));
      if (this.expanded.has(key)) {
        lines.push(...renderEntryDetails(entry, width));
      }
    }

    return lines.map((line) => fit(line, width));
  }

  handleInput(data: string): void {
    const filtered = filteredEntries(
      this.logger.recentEntries(),
      this.searchInput.getValue().trim(),
    );
    const selectedIndex = selectedIndexFor(filtered, this.selectedKey);
    if (matchesKey(data, Key.up)) {
      this.selectByIndex(filtered, Math.max(0, selectedIndex - 1));
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectByIndex(
        filtered,
        Math.min(filtered.length - 1, selectedIndex + 1),
      );
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.selectByIndex(filtered, Math.max(0, selectedIndex - 10));
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.selectByIndex(
        filtered,
        Math.min(filtered.length - 1, selectedIndex + 10),
      );
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      const selected = filtered[selectedIndex];
      if (selected) {
        const key = entryKey(selected);
        if (this.expanded.has(key)) {
          this.expanded.delete(key);
        } else {
          this.expanded.add(key);
        }
        this.requestRender();
      }
      return;
    }

    const before = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    const after = this.searchInput.getValue();
    if (after !== before) {
      this.selectedKey = undefined;
      this.requestRender();
    }
  }

  private selectByIndex(
    entries: readonly DashboardLogEntry[],
    index: number,
  ): void {
    const selected = entries[index];
    this.selectedKey = selected ? entryKey(selected) : undefined;
    this.requestRender();
  }
}

function selectedIndexFor(
  entries: readonly DashboardLogEntry[],
  selectedKey: string | undefined,
): number {
  if (entries.length === 0) return 0;
  if (selectedKey !== undefined) {
    const index = entries.findIndex((entry) => entryKey(entry) === selectedKey);
    if (index !== -1) return index;
  }
  return entries.length - 1;
}

function visibleWindow(
  entries: readonly DashboardLogEntry[],
  selectedIndex: number,
): readonly DashboardLogEntry[] {
  const radius = 14;
  const start = Math.max(0, selectedIndex - radius);
  const end = Math.min(entries.length, selectedIndex + radius + 1);
  return entries.slice(start, end);
}

function filteredEntries(
  entries: readonly DashboardLogEntry[],
  query: string,
): DashboardLogEntry[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) return [...entries];
  return entries.filter((entry) => {
    const haystack = logSearchText(entry);
    return terms.every((term) => haystack.includes(term));
  });
}

function logSearchText(entry: DashboardLogEntry): string {
  return [
    entry.timestamp,
    entry.sessionId,
    entry.level,
    entry.event,
    entry.summary,
    entry.agent?.agentId,
    entry.agent?.provider,
    entry.agent?.modelId,
    JSON.stringify(entry.details ?? ""),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function renderEntryLine(
  entry: DashboardLogEntry,
  selected: boolean,
  width: number,
): string {
  const marker = selected ? palette.accent(">") : " ";
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const level = colorForLevel(entry.level)(entry.level.padEnd(5));
  const agent = entry.agent?.agentId ? ` ${entry.agent.agentId}` : "";
  return fit(
    `${marker} ${palette.muted(time)} ${level} ${palette.accent(entry.event.padEnd(24))}${palette.muted(agent)} ${entry.summary}`,
    width,
  );
}

function renderEntryDetails(entry: DashboardLogEntry, width: number): string[] {
  const json = JSON.stringify(entry.details ?? entry, null, 2);
  const rawLines = json.split("\n");
  const visible = rawLines.slice(0, 180);
  const lines = visible.flatMap((line) =>
    wrapTextWithAnsi("    " + palette.faint(line), Math.max(1, width)),
  );
  if (visible.length < rawLines.length) {
    lines.push(
      "    " +
        palette.muted(
          `... ${rawLines.length - visible.length} more detail lines in ${entry.sessionId}`,
        ),
    );
  }
  return lines;
}

function colorForLevel(level: DashboardLogLevel): (value: string) => string {
  switch (level) {
    case "debug":
      return palette.faint;
    case "info":
      return palette.good;
    case "warn":
      return palette.warn;
    case "error":
      return palette.bad;
  }
}

function entryKey(entry: DashboardLogEntry): string {
  return `${entry.sessionId}:${entry.sequence}`;
}

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

export function createLogsView(options: LogsViewOptions): View {
  const root = new Container();
  const panel = new LogsPanel(options.logger, options.requestRender);
  root.addChild(panel);
  return {
    id: "logs",
    label: "Logs",
    hotkey: "l",
    description: "Searchable dashboard-agent session logs",
    root,
    onActivate: (ctx: ViewActivationContext) => ctx.setFocus(panel),
    onDeactivate: () => undefined,
  };
}
