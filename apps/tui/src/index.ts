#!/usr/bin/env node
import { dirname, join } from "node:path";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { createApiClient } from "./api.js";
import {
  createDashboardAgent,
  type DashboardThinkingLevel,
} from "./agent/index.js";
import {
  createAnnouncerAgent,
  isAnnouncerEnabled,
} from "./agent/announcer.js";
import { DashboardAgentLogger } from "./agent/dashboard-log.js";
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
    options.baseUrl ?? process.env.AGENTROOM_DAEMON ?? "http://127.0.0.1:4317";
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
  store.set({
    health: bootHealth,
    config: bootConfig,
    connection: "online",
    lastConnectedAt: new Date().toISOString(),
  });
  const poller = new Poller(api, store, { intervalMs: refreshMs });
  const auth = AuthStorage.default();
  const dashboardLogPath = await resolveDashboardLogPath(api, bootConfig.cwd);
  const logger = await DashboardAgentLogger.create({
    path: dashboardLogPath,
    roomId: bootHealth.roomId,
    cwd: bootConfig.cwd,
  });

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
      logger,
      ...(thinkingLevelOverride !== undefined
        ? { thinkingLevel: thinkingLevelOverride }
        : {}),
    });
  };

  const agent = buildAgent();

  // The announcer is an isolated sub-agent that watches room state and posts
  // announcements without interrupting the dashboard agent. Default-on; opt out
  // with AGENTROOM_TUI_ANNOUNCER=0.
  const announcer = isAnnouncerEnabled()
    ? createAnnouncerAgent({
        api,
        poller,
        auth,
        roomId: bootHealth.roomId,
        cwd: bootConfig.cwd,
      })
    : undefined;
  if (announcer && "reason" in announcer) {
    logger.record("warn", "announcer_unavailable", announcer.reason, {
      reason: announcer.reason,
    });
  }
  const announcerDebounceRaw = process.env.AGENTROOM_TUI_ANNOUNCER_DEBOUNCE_MS;
  const announcerDebounceMs =
    announcerDebounceRaw !== undefined &&
    Number.isFinite(Number(announcerDebounceRaw))
      ? Number(announcerDebounceRaw)
      : undefined;

  const terminal = new ProcessTerminal();
  const dashboard = new Dashboard({
    terminal,
    api,
    poller,
    store,
    agent,
    auth,
    logger,
    rebuildAgent: buildAgent,
    ...(announcer !== undefined ? { announcer } : {}),
    ...(announcerDebounceMs !== undefined ? { announcerDebounceMs } : {}),
    baseUrl,
  });

  const handleSignal = () => {
    void dashboard.shutdown();
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  await dashboard.start();
}

async function resolveDashboardLogPath(
  api: ReturnType<typeof createApiClient>,
  cwd: string,
): Promise<string> {
  try {
    const response = await api.config();
    return join(dirname(response.path), "dashboard-agent.log");
  } catch {
    return join(cwd, ".agentroom", "dashboard-agent.log");
  }
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
