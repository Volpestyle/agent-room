import type { AutocompleteItem, SlashCommand } from "@earendil-works/pi-tui";

export const DASHBOARD_VIEW_COMMANDS = [
  { id: "chat", label: "Chat" },
  { id: "overview", label: "Overview" },
  { id: "workspaces", label: "Workspaces" },
  { id: "agents", label: "Agents" },
  { id: "messages", label: "Messages" },
  { id: "events", label: "Events" },
  { id: "logs", label: "Logs" },
  { id: "settings", label: "Settings" },
  { id: "help", label: "Help" },
] as const;

export type DashboardViewCommandId = (typeof DASHBOARD_VIEW_COMMANDS)[number]["id"];

export const DASHBOARD_VIEW_COMMAND_IDS = new Set<string>(
  DASHBOARD_VIEW_COMMANDS.map((view) => view.id),
);

const SETUP_SECTIONS: AutocompleteItem[] = [
  { value: "runtime", label: "runtime", description: "Set the default runtime" },
  { value: "tracker", label: "tracker", description: "Set work tracker defaults" },
  { value: "mcp", label: "mcp", description: "Add or remove MCP servers" },
  { value: "clanky", label: "clanky", description: "Set Clanky room defaults" },
  { value: "help", label: "help", description: "Show setup command help" },
];

const VIEW_ARGUMENTS: AutocompleteItem[] = DASHBOARD_VIEW_COMMANDS.map((view) => ({
  value: view.id,
  label: view.id,
  description: `Open ${view.label}`,
}));

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", description: "Show help view and slash command reference" },
  { name: "views", description: "Open arrow-key view picker" },
  {
    name: "view",
    argumentHint: "<view>",
    description: "Switch to a dashboard view",
    getArgumentCompletions: (prefix) => filterItems(VIEW_ARGUMENTS, prefix),
  },
  { name: "chat", description: "Open chat with the dashboard agent" },
  { name: "overview", description: "Open daemon and room overview" },
  { name: "workspaces", description: "Open registered workspaces" },
  { name: "agents", description: "Open room and runtime agents" },
  { name: "messages", description: "Open room messages and handoffs" },
  { name: "events", description: "Open audit events" },
  { name: "logs", description: "Open searchable dashboard-agent logs" },
  { name: "settings", description: "Open arrow-key settings editor" },
  {
    name: "setup",
    argumentHint: "[runtime|tracker|mcp|clanky|help]",
    description: "Show or edit AgentRoom setup",
    getArgumentCompletions: (prefix) => filterItems(SETUP_SECTIONS, prefix),
  },
  { name: "config", description: "Show AgentRoom configuration summary" },
  { name: "protocol", description: "Show editable room protocol" },
  { name: "clear", description: "Clear the chat transcript" },
  {
    name: "copy",
    description: "Copy the last dashboard reply to the clipboard",
  },
  { name: "refresh", description: "Force a dashboard refresh" },
  {
    name: "post",
    argumentHint: "<text>",
    description: "Post raw text to the room as the dashboard agent",
  },
  { name: "login", argumentHint: "[provider]", description: "Sign in to a provider" },
  { name: "logout", argumentHint: "<provider>", description: "Sign out of a provider" },
  { name: "effort", argumentHint: "[level]", description: "Show or set model effort level" },
  { name: "trace", argumentHint: "[mode]", description: "Show or set transcript trace mode" },
  {
    name: "runtime",
    argumentHint: "[provider]",
    description: "Show runtime session and socket status",
  },
  { name: "setup runtime", description: "Set the default runtime" },
  { name: "setup tracker", description: "Set work tracker defaults" },
  { name: "setup mcp", description: "Add or remove a dashboard MCP server" },
  { name: "setup clanky", description: "Set Clanky room defaults" },
  { name: "quit", description: "Exit the dashboard" },
  { name: "exit", description: "Exit the dashboard" },
];

function filterItems(
  items: readonly AutocompleteItem[],
  prefix: string,
): AutocompleteItem[] {
  const normalized = prefix.trim().toLowerCase();
  if (normalized.length === 0) return [...items];
  return items.filter(
    (item) =>
      item.value.toLowerCase().startsWith(normalized) ||
      item.label.toLowerCase().includes(normalized),
  );
}
