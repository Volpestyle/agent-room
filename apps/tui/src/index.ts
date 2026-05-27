#!/usr/bin/env node
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { createApiClient } from "./api.js";
import {
  createDashboardAgent,
  type DashboardThinkingLevel,
} from "./agent/index.js";
import { AuthStorage } from "./auth/storage.js";
import { Dashboard } from "./dashboard.js";
import { Poller } from "./poller.js";
import { DashboardStore } from "./state.js";

export interface AgentRoomTuiOptions {
  baseUrl?: string;
  apiToken?: string;
  refreshMs?: number;
}

export async function runAgentRoomTui(
  options: AgentRoomTuiOptions = {},
): Promise<void> {
  const baseUrl =
    options.baseUrl ??
    process.env.AGENTROOM_DAEMON ??
    "http://127.0.0.1:4317";
  const apiToken = options.apiToken ?? process.env.AGENTROOM_API_TOKEN;
  const refreshMs =
    options.refreshMs ?? Number(process.env.AGENTROOM_TUI_REFRESH_MS ?? 3000);

  const api = createApiClient({
    baseUrl,
    ...(apiToken !== undefined ? { token: apiToken } : {}),
  });

  let bootHealth;
  try {
    bootHealth = await api.health();
  } catch (error) {
    throw new Error(
      `Cannot reach AgentRoom daemon at ${baseUrl}: ${
        error instanceof Error ? error.message : String(error)
      }\nStart it with: agent-room daemon start`,
    );
  }

  let bootConfig;
  try {
    bootConfig = await api.dashboardConfig();
  } catch {
    bootConfig = { roomId: bootHealth.roomId, cwd: process.cwd() };
  }

  const store = new DashboardStore();
  store.set({ health: bootHealth, config: bootConfig });
  const poller = new Poller(api, store, { intervalMs: refreshMs });
  const auth = AuthStorage.default();

  let thinkingLevelOverride: DashboardThinkingLevel | undefined;
  const buildAgent = (thinkingLevel?: DashboardThinkingLevel) => {
    if (thinkingLevel !== undefined) {
      thinkingLevelOverride = thinkingLevel;
    }
    return createDashboardAgent({
      api,
      poller,
      auth,
      roomId: bootHealth.roomId,
      cwd: bootConfig.cwd,
      ...(thinkingLevelOverride !== undefined
        ? { thinkingLevel: thinkingLevelOverride }
        : {}),
    });
  };

  const agent = buildAgent();

  const terminal = new ProcessTerminal();
  const dashboard = new Dashboard({
    terminal,
    api,
    poller,
    store,
    agent,
    auth,
    rebuildAgent: buildAgent,
    baseUrl,
  });

  const handleSignal = () => {
    void dashboard.shutdown();
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  await dashboard.start();
}

if (isDirectRun()) {
  runAgentRoomTui().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

function isDirectRun(): boolean {
  return process.argv[1] === new URL(import.meta.url).pathname;
}
