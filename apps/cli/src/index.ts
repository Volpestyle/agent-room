#!/usr/bin/env node
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Command } from "commander";
import {
  AgentRoomService,
  activateAgent,
  agentStateSchema,
  agentRoleSchema,
  type ActorRef,
  type Agent,
  type AgentRole,
  type AgentState,
  type HarnessSpec,
  harnessKindSchema,
  type Importance,
  importanceSchema,
  type MessageKind,
  messageKindSchema,
  type RoomEvent,
  type RuntimeBinding,
  type RuntimeProvider,
} from "@agentroom/core";
import {
  agentRoomDir,
  agentRoomConfigPath,
  agentRoomProtocolPath,
  builtInRuntimeConfig,
  createDefaultAgentRoomConfig,
  defaultRoomIdFromEnv,
  ensureAgentRoomProtocol,
  ensureRuntimeConfig,
  maybeLoadAgentRoomConfig,
  readAgentRoomSessionIdentity,
  readAgentRoomProtocol,
  resolveStoragePath,
  writeAgentRoomSessionEnvFile,
  writeAgentRoomSessionIdentity,
  withDefaultRuntime,
  workTrackerLabel,
  writeAgentRoomConfig,
  type AgentRoomConfig,
  type ClankyChatGatewayOwner,
  type ConfiguredRuntimeKind,
  type HerdrLayoutConfig,
  type RuntimeConfig,
  type WorkTrackerConfig,
  type WorkTrackerProviderConfig,
  type WorkTrackerProviderKind,
} from "@agentroom/config";
import { JsonlEventStore } from "@agentroom/storage-jsonl";
import { FakeRuntimeProvider } from "@agentroom/runtime-fake";
import { HerdrRuntimeProvider } from "@agentroom/runtime-herdr";
import { TmuxRuntimeProvider } from "@agentroom/runtime-tmux";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;

type AgentRoomTuiModule = {
  runAgentRoomTui: (options: {
    baseUrl?: string;
    apiToken?: string;
    refreshMs?: number;
  }) => Promise<void>;
};

type DaemonMode = "foreground" | "start" | "status" | "stop" | "restart";

interface DaemonCommandOptions {
  host: string;
  port: number;
  pidFile?: string;
  logFile?: string;
  timeout: number;
  force?: boolean;
  json?: boolean;
  tailnet?: boolean;
  apiToken?: string;
  publicUrl?: string;
}

interface DaemonPidRecord {
  pid: number;
  host: string;
  port: number;
  cwd: string;
  startedAt: string;
  command: string;
  logFile?: string;
  token?: string;
  apiToken?: string;
  publicUrl?: string;
  tailnet?: boolean;
}

interface DaemonHealthCheck {
  ok: boolean;
  url: string;
  status?: number;
  body?: unknown;
  reason?: string;
}

interface TuiCommandOptions {
  daemon: string;
  apiToken?: string;
  refreshMs?: number;
  autoStart: boolean;
}

interface TuiDaemonEnsureResult {
  daemonUrl: string;
  apiToken?: string;
  ownedDaemon?: DaemonCommandOptions;
}

interface DaemonStatusPayload {
  ok: boolean;
  state: string;
  pidFile: string;
  pid?: number;
  host: string;
  port: number;
  publicUrl?: string;
  apiTokenRequired?: boolean;
  startedAt?: string;
  logFile?: string;
  command?: string;
  health?: DaemonHealthCheck;
  reason?: string;
}

interface DaemonRestartPayload {
  ok: true;
  stopped: DaemonStatusPayload;
  started: DaemonStatusPayload;
}

interface DaemonProcessInfo {
  alive: boolean;
  verified: boolean;
  command?: string;
}

interface TailnetEndpoint {
  bindHost: string;
  publicHost: string;
}

interface MobileConnectOptions {
  pidFile?: string;
  copy?: boolean;
  push?: boolean;
  json?: boolean;
}

interface MobileConnectPayload {
  baseUrl: string;
  mode: "tailnet" | "custom";
  token?: string;
  authHeader?: string;
  pairingLink: string;
  tokenRequired: boolean;
  pidFile: string;
}

interface RoomConfig {
  roomId: string;
  roomName: string;
  createdAt: string;
}

async function loadTui(): Promise<AgentRoomTuiModule> {
  try {
    return (await import("@agentroom/tui")) as AgentRoomTuiModule;
  } catch (error) {
    const sourceUrl = pathToFileURL(
      join(REPO_ROOT, "apps", "tui", "src", "index.ts"),
    ).href;
    try {
      return (await import(sourceUrl)) as AgentRoomTuiModule;
    } catch {
      throw error;
    }
  }
}

const program = new Command();

program
  .name("agent-room")
  .description(
    "Runtime-agnostic coordination plane for long-running coding agents",
  )
  .version("0.1.0")
  .addHelpText(
    "after",
    "\nShortcuts:\n  agent-room              Open the singleton AgentRoom TUI\n  agent-room --headless   Start the singleton AgentRoom daemon without the TUI",
  );

program
  .command("init")
  .description("Write AgentRoom config into .agentroom or AGENTROOM_HOME")
  .option("--room <id>", "room id; defaults to agent-room")
  .option("--name <name>", "human-readable room name")
  .option(
    "--runtime <runtime>",
    "runtime provider to write as the room default: herdr|tmux|fake",
    "herdr",
  )
  .option(
    "--runtime-session <name>",
    "Herdr session name or tmux session prefix; defaults to agent-room",
  )
  .option(
    "--runtime-cli <command>",
    "runtime CLI command to write into config, e.g. herdr-dev for Herdr dev sessions",
  )
  .option(
    "--work-tracker <tracker>",
    "portable work tracker selection: native|linear|github-issues|jira|custom",
    "native",
  )
  .option("--tracker-team <teamId>", "default tracker team id")
  .option("--clanky", "write Clanky-compatible defaults into config.yaml")
  .option(
    "--clanky-home <path>",
    "Clanky home path for this room when --clanky is set",
    ".clanky-room",
  )
  .option(
    "--clanky-profile <profile>",
    "Clanky profile for this room when --clanky is set",
    "lead",
  )
  .option(
    "--clanky-chat-owner <owner>",
    "agent|room|off; default agent-owned Clanky chat",
    "agent",
  )
  .action(
    async (options: {
      room?: string;
      name?: string;
      runtime: string;
      runtimeSession?: string;
      runtimeCli?: string;
      workTracker: string;
      trackerTeam?: string;
      clanky?: boolean;
      clankyHome: string;
      clankyProfile: string;
      clankyChatOwner: string;
    }) => {
      const dir = roomDir();
      await mkdir(dir, { recursive: true });
      const defaultRuntime = parseConfiguredRuntime(options.runtime);
      const roomId = resolveInitRoomId({
        room: options.room,
      });
      const runtimeSession = resolveInitRuntimeSession({
        runtime: defaultRuntime,
        runtimeSession: options.runtimeSession,
      });
      const appConfig = createDefaultAgentRoomConfig({
        roomId,
        ...(options.name !== undefined ? { roomName: options.name } : {}),
        defaultRuntime,
        ...(runtimeSession !== undefined ? { runtimeSession } : {}),
      });
      applyRuntimeCliOverride(appConfig, options.runtime, options.runtimeCli);
      appConfig.workTracker = createWorkTrackerConfig({
        tracker: options.workTracker,
        ...(options.trackerTeam !== undefined
          ? { teamId: options.trackerTeam }
          : {}),
      });
      if (options.clanky === true) {
        const chatGatewayOwner = parseClankyChatGatewayOwner(
          options.clankyChatOwner,
        );
        appConfig.clanky = {
          home: options.clankyHome,
          profile: options.clankyProfile,
          chatGatewayOwner,
        };
        appConfig.operator = {
          agentId: "clanky",
          displayName: "Clanky",
          kind: "clanky",
          command: `clanky --home ${options.clankyHome} --profile ${options.clankyProfile}`,
          cwd: ".",
          sessionDir: join(
            options.clankyHome,
            "profiles",
            options.clankyProfile,
            "sessions",
          ),
          env: {
            CLANKY_HOME: options.clankyHome,
            CLANKY_PROFILE: options.clankyProfile,
            CLANKY_CHAT_GATEWAY_OWNER: chatGatewayOwner,
          },
        };
      }

      await writeAgentRoomConfig(process.cwd(), appConfig);
      const protocolPath = await ensureAgentRoomProtocol(process.cwd());

      console.log(`Configured AgentRoom room '${roomId}' in ${dir}`);
      console.log(`Configured room protocol: ${protocolPath}`);
      console.log(`Configured runtime: ${appConfig.runtime.default}`);
      console.log(`Configured work tracker: ${appConfig.workTracker.default}`);
      if (appConfig.clanky !== undefined) {
        console.log(
          `Configured Clanky profile: ${appConfig.clanky.profile} (${appConfig.clanky.home})`,
        );
      }
    },
  );

program
  .command("whoami")
  .description("Print the current AgentRoom enrollment environment")
  .option("--json", "print JSON")
  .action(async (options: { json?: boolean }) => {
    const identity = await resolveCurrentIdentity();
    const info = {
      enrolled: identity !== undefined,
      agentId: identity?.agentId,
      roomId: identity?.roomId ?? process.env.AGENTROOM_ROOM_ID,
      role: identity?.role ?? process.env.AGENTROOM_ROLE,
      source: identity?.source ?? "none",
      daemon:
        process.env.AGENTROOM_DAEMON ?? `http://127.0.0.1:${DEFAULT_PORT}`,
    };
    output(info, options.json);
  });

program
  .command("daemon")
  .description("Run or manage the local AgentRoom API daemon")
  .argument("[mode]", "foreground|start|status|stop|restart", "foreground")
  .option("--host <host>", "daemon host", DEFAULT_HOST)
  .option("--port <port>", "daemon port", parseInteger, DEFAULT_PORT)
  .option(
    "--tailnet",
    "bind to this machine's Tailscale address and require an API token",
  )
  .option(
    "--api-token <token>",
    "API bearer token for remote clients; prefer AGENTROOM_API_TOKEN to avoid shell history",
  )
  .option(
    "--pid-file <path>",
    "daemon pid metadata file",
    join(roomDir(), "daemon.pid"),
  )
  .option(
    "--log-file <path>",
    "daemon log file for background starts",
    join(roomDir(), "daemon.log"),
  )
  .option(
    "--timeout <seconds>",
    "seconds to wait for start or stop",
    parseNonNegativeNumber,
    5,
  )
  .option("--force", "send SIGKILL if graceful stop times out")
  .option("--json", "print JSON")
  .action(async (mode: string, options: DaemonCommandOptions) => {
    await handleDaemonCommand(parseDaemonMode(mode), options);
  });

program
  .command("mobile-connect")
  .description("Print AgentRoom iOS/mobile connection settings")
  .option(
    "--pid-file <path>",
    "daemon pid metadata file",
    join(roomDir(), "daemon.pid"),
  )
  .option("--copy", "copy the AgentRoom iOS pairing link to the clipboard")
  .option(
    "--push",
    "send an APNs connect event to registered devices so the app connects itself",
  )
  .option("--json", "print JSON")
  .action(async (options: MobileConnectOptions) => {
    const payload = await mobileConnectPayload(options);
    if (options.copy === true) {
      await copyToClipboard(payload.pairingLink);
    }
    outputMobileConnect(payload, options);
    if (options.push === true) {
      await pushMobileConnect(options, payload);
    }
  });

const iosCommand = program
  .command("ios")
  .description("Inspect and steer AgentRoom mobile (iOS) clients");

iosCommand
  .command("logs")
  .description("Stream structured logs reported by iOS clients")
  .option("--daemon <url>", "daemon base URL")
  .option("--api-token <token>", "daemon API bearer token")
  .option("--client <id>", "filter to one client id")
  .option("--follow", "keep streaming new events")
  .option("--limit <n>", "initial number of events", parseInteger, 100)
  .option("--json", "print raw JSON events")
  .action(async (options: IosLogsOptions) => {
    await runIosLogs(options);
  });

iosCommand
  .command("state")
  .description("Show the latest reported state of each iOS client")
  .option("--daemon <url>", "daemon base URL")
  .option("--api-token <token>", "daemon API bearer token")
  .option("--json", "print JSON")
  .action(async (options: IosTargetOptions & { json?: boolean }) => {
    await runIosState(options);
  });

iosCommand
  .command("cmd")
  .description("Send a command to an iOS client (delivered on its next check-in)")
  .argument("<clientId>", "target client id (see `agent-room ios state`)")
  .argument("<kind>", "connect|reconnect|disconnect|dump-state|re-register-push")
  .option("--daemon <url>", "daemon base URL")
  .option("--api-token <token>", "daemon API bearer token")
  .option("--json", "print JSON")
  .action(
    async (
      clientId: string,
      kind: string,
      options: IosTargetOptions & { json?: boolean },
    ) => {
      await runIosCommand(clientId, kind, options);
    },
  );

program
  .command("tui")
  .description("Open the interactive AgentRoom terminal UI")
  .option(
    "--daemon <url>",
    "daemon base URL",
    process.env.AGENTROOM_DAEMON ?? `http://127.0.0.1:${DEFAULT_PORT}`,
  )
  .option(
    "--api-token <token>",
    "daemon API bearer token",
    process.env.AGENTROOM_API_TOKEN,
  )
  .option("--refresh-ms <ms>", "refresh interval in milliseconds", parseInteger)
  .option(
    "--no-auto-start",
    "do not auto-start a local daemon if none is reachable",
  )
  .action(
    async (options: {
      daemon: string;
      apiToken?: string;
      refreshMs?: number;
      autoStart: boolean;
    }) => {
      await runTuiCommand(options);
    },
  );

program
  .command("dev-new-user")
  .description("Create a temporary AgentRoom home for first-run TUI testing")
  .option("--run", "launch the TUI with the temporary AgentRoom home")
  .option("--json", "print JSON")
  .action(async (options: { run?: boolean; json?: boolean }) => {
    const home = await mkdtemp(join(tmpdir(), "agentroom-new-user-"));
    const bin = resolve(REPO_ROOT, "bin", "agent-room");
    const payload = {
      home,
      command: bin,
      setupCommand: "/setup",
    };
    if (options.json) {
      output(payload, true);
    } else {
      console.log("AgentRoom fresh-user setup sandbox");
      console.log(`Home: ${home}`);
      console.log("");
      console.log("Run:");
      console.log(`  AGENTROOM_HOME=${home} ${bin}`);
      console.log("");
      console.log("Inside the TUI, run /setup.");
    }
    if (options.run === true) {
      await runChild(bin, [], process.cwd(), { AGENTROOM_HOME: home });
    }
  });

program
  .command("post")
  .description("Post a message to the local room event log")
  .argument("<body>", "message body")
  .option("-c, --channel <channel>", "channel id", "announcements")
  .option(
    "-t, --to <agentIds>",
    "comma-separated agent recipients for a directed message",
  )
  .option("-k, --kind <kind>", "message kind", "chat")
  .option("--json", "print JSON")
  .action(
    async (
      body: string,
      options: { channel: string; to?: string; kind: string; json?: boolean },
    ) => {
      const service = await serviceForCwd();
      const message = await service.postMessage({
        body,
        channelId: options.channel,
        kind: parseMessageKind(options.kind),
        sender: await currentActor(),
        ...(options.to !== undefined
          ? { recipients: parseAgentRecipients(options.to) }
          : {}),
      });
      output(message, options.json);
    },
  );

program
  .command("status")
  .description("Post a structured status update to the implementation channel")
  .requiredOption("--mode <mode>", "current mode, e.g. editing or reviewing")
  .requiredOption("--goal <goal>", "current goal")
  .option("--files <files>", "comma-separated files touched")
  .option("--reuse <reuse>", "reused components, helpers, or context")
  .option("--needs <needs>", "blocked needs or review needs")
  .option(
    "--coordinate-with <agents>",
    "comma-separated agents to coordinate with",
  )
  .option("-c, --channel <channel>", "channel id", "implementation")
  .option("--json", "print JSON")
  .action(
    async (options: {
      mode: string;
      goal: string;
      files?: string;
      reuse?: string;
      needs?: string;
      coordinateWith?: string;
      channel: string;
      json?: boolean;
    }) => {
      const service = await serviceForCwd();
      const status = {
        mode: options.mode,
        goal: options.goal,
        filesTouched: parseOptionalList(options.files),
        reuse: options.reuse ?? "",
        needs: options.needs ?? "",
        coordinateWith: parseOptionalList(options.coordinateWith),
      };
      const message = await service.postMessage({
        body: JSON.stringify(status, null, 2),
        channelId: options.channel,
        kind: "status",
        sender: await currentActor(),
      });
      output(message, options.json);
    },
  );

program
  .command("dm")
  .description("Send a direct room message to one or more agents")
  .argument("<agentIds>", "comma-separated agent ids")
  .argument("<body>", "message body")
  .option("--thread <threadId>", "thread id")
  .option("--json", "print JSON")
  .action(
    async (
      agentIds: string,
      body: string,
      options: { thread?: string; json?: boolean },
    ) => {
      const service = await serviceForCwd();
      const message = await service.postMessage({
        body,
        channelId: "dm",
        sender: await currentActor(),
        recipients: parseAgentRecipients(agentIds),
        ...(options.thread !== undefined ? { threadId: options.thread } : {}),
      });
      output(message, options.json);
    },
  );

program
  .command("messages")
  .description("Show recent room messages")
  .option("-c, --channel <channel>", "channel id")
  .option("--thread <threadId>", "thread id")
  .option("--with <agentId>", "messages sent to or from an agent")
  .option("-n, --limit <number>", "number of messages", parseInteger, 20)
  .option("--json", "print JSON")
  .action(
    async (options: {
      channel?: string;
      thread?: string;
      with?: string;
      limit: number;
      json?: boolean;
    }) => {
      const service = await serviceForCwd();
      const messages = await service.listMessages({
        limit: options.limit,
        ...(options.channel !== undefined
          ? { channelId: options.channel }
          : {}),
        ...(options.thread !== undefined ? { threadId: options.thread } : {}),
        ...(options.with !== undefined
          ? { participant: { kind: "agent", id: options.with } }
          : {}),
      });
      output(messages, options.json);
    },
  );

program
  .command("wait")
  .description("Wait until a matching room event appears")
  .option("--message <pattern>", "JavaScript regex against message body")
  .option("--ignore-case", "compile --message as a case-insensitive regex")
  .option("--from <agentId>", "only match messages sent by this agent")
  .option("--channel <channel>", "only match messages in this channel")
  .option("--kind <kind>", "only match messages of this kind")
  .option(
    "--dm-to-me",
    "match any directed message where AGENTROOM_AGENT_ID is a recipient",
  )
  .option(
    "--timeout <seconds>",
    "seconds to wait before exiting non-zero",
    parseNonNegativeNumber,
    300,
  )
  .option(
    "--since <iso|now>",
    "only match events strictly after this time",
    "now",
  )
  .option("--json", "emit the matching event as JSON")
  .action(
    async (options: {
      message?: string;
      ignoreCase?: boolean;
      from?: string;
      channel?: string;
      kind?: string;
      dmToMe?: boolean;
      timeout: number;
      since: string;
      json?: boolean;
    }) => {
      const service = await serviceForCwd();
      const matchers = await waitMatchers(options);
      if (matchers.length === 0) {
        throw new Error(
          "Choose at least one wait mode: --message or --dm-to-me",
        );
      }

      const since =
        options.since === "now" ? undefined : parseSinceOption(options.since);
      let cursor = await service.eventCursor(
        since === undefined ? "end" : "start",
      );
      const deadline = Date.now() + options.timeout * 1000;

      while (true) {
        const batch = await service.listEventsFromCursor(cursor);
        cursor = batch.cursor;
        const match = batch.events.find(
          (event) =>
            (since === undefined || event.createdAt > since) &&
            matchers.some((matches) => matches(event)),
        );

        if (match) {
          if (options.json) output(match, true);
          else console.log(`${match.type} ${match.id}`);
          return;
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new WaitTimeoutError(
            `Timed out waiting for matching event after ${options.timeout}s`,
          );
        await sleep(Math.min(1000, remaining));
      }
    },
  );

program
  .command("wait-agent")
  .description("Wait until a room agent reaches the requested state")
  .argument("<agentId>", "agent id")
  .option(
    "--state <state>",
    "agent state to wait for; defaults to done",
    "done",
  )
  .option(
    "--timeout <seconds>",
    "seconds to wait before exiting with code 2",
    parseNonNegativeNumber,
    300,
  )
  .option("--json", "emit the resolved agent as JSON")
  .action(
    async (
      agentId: string,
      options: { state: string; timeout: number; json?: boolean },
    ) => {
      const service = await serviceForCwd();
      const state = parseAgentState(options.state);
      const agent = await waitForAgentState(
        service,
        agentId,
        state,
        options.timeout,
      );
      output(agent, options.json);
      process.exitCode = agentStateExitCode(agent.state);
    },
  );

program
  .command("ask-human")
  .description("Create a human escalation question")
  .argument("<question>", "question for the human")
  .option("-p, --priority <priority>", "low|normal|high|urgent", "normal")
  .option("--json", "print JSON")
  .action(
    async (question: string, options: { priority: string; json?: boolean }) => {
      const service = await serviceForCwd();
      const escalation = await service.askHuman({
        question,
        from: await currentActor(),
        priority: parseImportance(options.priority),
      });
      output(escalation, options.json);
    },
  );

program
  .command("block")
  .description("Report that this agent is blocked (agent-state signal)")
  .requiredOption("-r, --reason <reason>", "blocker reason")
  .option("--json", "print JSON")
  .action(async (options: { reason: string; json?: boolean }) => {
    const service = await serviceForCwd();
    const actor = await currentActor();
    if (actor.kind !== "agent") {
      throw new Error(
        "block reports agent state; run it as an enrolled agent",
      );
    }
    await service.markAgentBlocked({ agentId: actor.id, reason: options.reason });
    output(
      { ok: true, agentId: actor.id, state: "blocked", reason: options.reason },
      options.json,
    );
  });

program
  .command("done")
  .description("Report that this agent finished its work (agent-state signal)")
  .option("-s, --summary <summary>", "completion summary")
  .option("--json", "print JSON")
  .action(async (options: { summary?: string; json?: boolean }) => {
    const service = await serviceForCwd();
    const actor = await currentActor();
    if (actor.kind !== "agent") {
      throw new Error("done reports agent state; run it as an enrolled agent");
    }
    await service.markAgentDone({
      agentId: actor.id,
      ...(options.summary !== undefined ? { summary: options.summary } : {}),
    });
    output(
      {
        ok: true,
        agentId: actor.id,
        state: "done",
        ...(options.summary !== undefined ? { summary: options.summary } : {}),
      },
      options.json,
    );
  });

program
  .command("agents")
  .alias("presence")
  .description("Show enrolled room agents, roles, state, and last heartbeat")
  .option("--json", "print JSON")
  .action(async (options: { json?: boolean }) => {
    const service = await serviceForCwd();
    const presence = await service.listAgentPresence();
    if (options.json) {
      output(presence, true);
      return;
    }
    for (const entry of presence) {
      const heartbeat = entry.lastHeartbeatAt ?? "no-heartbeat";
      const status =
        entry.heartbeatStatus === undefined ? "" : ` ${entry.heartbeatStatus}`;
      console.log(
        `${entry.agent.id}\t${entry.agent.role}\t${entry.agent.state}\t${heartbeat}${status}`,
      );
    }
  });

const workspace = program
  .command("workspace")
  .description("Workspace registry commands");

workspace
  .command("add")
  .description("Register a cwd as an AgentRoom workspace")
  .argument("<cwd>", "working directory")
  .option("--label <label>", "human-readable workspace label")
  .option("--json", "print JSON")
  .action(async (cwd: string, options: { label?: string; json?: boolean }) => {
    const resolvedCwd = resolve(cwd);
    const service = await serviceForCwd();
    const item = await service.registerWorkspace({
      cwd: resolvedCwd,
      label: options.label ?? workspaceLabelFromCwd(resolvedCwd),
    });
    output(item, options.json);
  });

workspace
  .command("list")
  .description("List registered AgentRoom workspaces")
  .option("--json", "print JSON")
  .action(async (options: { json?: boolean }) => {
    const service = await serviceForCwd();
    output(await service.listWorkspaces(), options.json);
  });

const tracker = program
  .command("tracker")
  .description("External work tracker commands");

tracker
  .command("health")
  .description("Show configured external work tracker protocol")
  .option("--json", "print JSON")
  .action(async (options: { json?: boolean }) => {
    const config = await maybeLoadAgentRoomConfig();
    output(workTrackerHealth(config), options.json);
  });

program
  .command("protocol")
  .description("Show the active editable AgentRoom protocol")
  .option("--json", "print JSON")
  .action(async (options: { json?: boolean }) => {
    await ensureAgentRoomProtocol();
    const protocol = await readAgentRoomProtocol();
    output(protocol, options.json);
  });

program
  .command("events")
  .description("Show recent local room events")
  .option("-n, --limit <number>", "number of events", parseInteger, 20)
  .option("--follow", "keep streaming new events after the initial batch")
  .option(
    "--poll-interval <ms>",
    "milliseconds between follow polls",
    parseNonNegativeNumber,
    1000,
  )
  .option("--json", "print JSON")
  .action(
    async (options: {
      limit: number;
      follow?: boolean;
      pollInterval: number;
      json?: boolean;
    }) => {
      if (options.follow) {
        await followEvents(options);
        return;
      }

      const { store, config } = await storeForCwd();
      const events = await store.list({
        roomId: config.roomId,
        limit: options.limit,
      });
      output(events, options.json);
    },
  );

async function followEvents(options: {
  limit: number;
  pollInterval: number;
  json?: boolean;
}): Promise<void> {
  const { store, config } = await storeForCwd();
  const seenEventIds = new Set<string>();
  let cursor = await store.cursor("end");

  if (options.limit > 0) {
    const initialEvents = await store.list({
      roomId: config.roomId,
      limit: options.limit,
    });
    for (const event of initialEvents) {
      seenEventIds.add(event.id);
      outputEventLine(event, options.json);
    }
  }

  while (true) {
    const batch = await store.listFromCursor(cursor, {
      roomId: config.roomId,
    });
    cursor = batch.cursor;
    for (const event of batch.events) {
      if (seenEventIds.has(event.id)) continue;
      seenEventIds.add(event.id);
      outputEventLine(event, options.json);
    }
    await sleep(options.pollInterval);
  }
}

function outputEventLine(event: RoomEvent, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(event));
    return;
  }

  console.log(`${event.createdAt} ${event.type} ${event.id}`);
}

program
  .command("doctor")
  .description("Check local prerequisites")
  .option("--json", "print JSON")
  .action(async (options: { json?: boolean }) => {
    const config = await maybeLoadAgentRoomConfig();
    const checks = {
      node: process.version,
      agentroomDir: await exists(roomDir()),
      config: config ? agentRoomConfigPath() : undefined,
      defaultRuntime: config?.runtime.default,
      herdr: await commandAvailable("herdr"),
      tmux: await commandAvailable("tmux"),
    };
    output(checks, options.json);
  });

const runtime = program
  .command("runtime")
  .description("Runtime provider commands");

runtime
  .command("providers")
  .description("List configured runtime providers")
  .option("--json", "print JSON")
  .action(async (options: { json?: boolean }) => {
    const config = await maybeLoadAgentRoomConfig();
    if (config) {
      output(
        Object.entries(config.runtimes).map(([id, runtime]) => ({
          id,
          kind: runtime.type,
          default: id === config.runtime.default,
        })),
        options.json,
      );
      return;
    }

    output(
      [
        { id: "fake", kind: "fake", default: false },
        { id: "herdr", kind: "herdr", default: false },
        { id: "tmux", kind: "tmux", default: false },
      ],
      options.json,
    );
  });

runtime
  .command("use")
  .description("Set the default runtime provider in AgentRoom config")
  .argument("<runtime>", "configured runtime name, or built-in herdr|tmux|fake")
  .option("--json", "print JSON")
  .action(async (runtimeName: string, options: { json?: boolean }) => {
    const config = await loadAgentRoomConfigForCwd();
    const updated = withDefaultRuntime(config, runtimeName);
    await writeAgentRoomConfig(process.cwd(), updated);
    output(
      {
        ok: true,
        defaultRuntime: updated.runtime.default,
        config: agentRoomConfigPath(),
      },
      options.json,
    );
  });

runtime
  .command("doctor")
  .description("Check the selected runtime provider")
  .option(
    "--runtime <runtime>",
    "runtime provider to check; defaults to configured runtime",
  )
  .option("--json", "print JSON")
  .action(async (options: { runtime?: string; json?: boolean }) => {
    const selected = await runtimeProviderForCwd(options.runtime);
    output(
      {
        runtime: selected.name,
        kind: selected.provider.kind,
        config: selected.config ? agentRoomConfigPath() : undefined,
        health: await selected.provider.health(),
      },
      options.json,
    );
  });

runtime
  .command("fake-smoke")
  .description("Run a provider contract smoke test against the fake runtime")
  .option("--json", "print JSON")
  .action(async (options: { json?: boolean }) => {
    const provider = new FakeRuntimeProvider();
    await provider.startAgent({
      agentId: "demo",
      roomId: "demo",
      role: "implementer",
      harness: { kind: "shell", command: "bash" },
    });
    await provider.sendInput({ agentId: "demo", text: "echo hello" });
    const outputText = await provider.readAgent({ agentId: "demo", lines: 10 });
    output(outputText, options.json);
  });

program
  .command("delegate")
  .description(
    "DM a work assignment to an agent (reference a tracker issue) and wake it if idle",
  )
  .argument("<agentId>", "agent id")
  .argument("<work...>", "work description; reference the tracker issue to pick up")
  .option("--json", "print JSON")
  .action(
    async (agentId: string, workParts: string[], options: { json?: boolean }) => {
      const service = await serviceForCwd();
      const actor = await currentActor();
      const work = workParts.join(" ").trim();
      if (!work) throw new Error("delegate requires a work description.");
      const message = await service.postMessage({
        body: work,
        channelId: "dm",
        sender: actor,
        recipients: [{ kind: "agent", id: agentId }],
        kind: "handoff",
      });
      output(
        {
          message,
          wait: {
            command: `agent-room wait-agent ${agentId} --state done,idle`,
            agentId,
          },
        },
        options.json,
      );
    },
  );

program
  .command("launch")
  .description("Launch an opted-in agent through a runtime provider")
  .argument("<agentId>", "agent id")
  .option(
    "--runtime <runtime>",
    "runtime provider; defaults to AgentRoom config",
  )
  .option("--placement <placement>", "Herdr placement: workspace|tab|pane")
  .option("--workspace <label>", "Herdr workspace label for tab/pane placement")
  .option(
    "--panes-per-tab <number>",
    "max panes per Herdr tab for pane placement",
    parseInteger,
  )
  .option("--split <strategy>", "Herdr pane split strategy: largest|focused")
  .option("--role <role>", "agent role", "implementer")
  .requiredOption(
    "--harness <kind>",
    "harness kind: claude-code|codex|pi|gemini-cli|shell|custom",
  )
  .requiredOption("--command <command>", "command to run")
  .option("--cwd <cwd>", "working directory; defaults to the current shell cwd")
  .option("--json", "print JSON")
  .action(
    async (
      agentId: string,
      options: {
        runtime?: string;
        placement?: string;
        workspace?: string;
        panesPerTab?: number;
        split?: string;
        role: string;
        harness: string;
        command: string;
        cwd?: string;
        json?: boolean;
      },
    ) => {
      const { store, config, appConfig } = await storeForCwd();
      const service = new AgentRoomService(store, { roomId: config.roomId });
      const role = parseAgentRole(options.role);
      const cwd = resolve(options.cwd ?? process.cwd());
      const workspace = options.workspace ?? workspaceLabelFromCwd(cwd);
      const { provider } = await runtimeProviderForCwd(
        options.runtime,
        herdrLayoutOverride({
          ...(options.placement !== undefined
            ? { placement: options.placement }
            : {}),
          ...(options.panesPerTab !== undefined
            ? { panesPerTab: options.panesPerTab }
            : {}),
          ...(options.split !== undefined ? { split: options.split } : {}),
        }),
      );
      const harness = resolveHarnessSpec({
        kind: parseHarnessKind(options.harness),
        command: options.command,
        cwd,
      });
      await service.registerAgent({
        id: agentId,
        role,
        harness,
      });
      await service.registerWorkspace({ cwd, label: workspace });
      const agent = await provider.startAgent({
        agentId,
        roomId: config.roomId,
        role,
        harness,
        cwd,
        workspace,
        env: agentRoomProtocolEnv(config, { agentId, role }, appConfig),
      });
      await service.bindRuntime({
        agentId,
        runtime: bindingFor(provider, agent.bindingId, agent.metadata),
      });
      output(agent, options.json);
    },
  );

program
  .command("enroll")
  .description(
    "Enroll the current pane/shell into the AgentRoom room (use --shell to eval exports)",
  )
  .option(
    "--agent-id <id>",
    "agent id; defaults to the runtime-derived pane id when available",
  )
  .option("--pane-id <id>", "binding id to adopt; defaults to $HERDR_PANE_ID")
  .option(
    "--runtime <runtime>",
    "runtime provider; defaults to AgentRoom config",
  )
  .option("--role <role>", "agent role", "implementer")
  .option("--harness <kind>", "harness kind", "custom")
  .option(
    "--command <command>",
    "harness command (recorded only; adoption does not execute it)",
    "adopted-pane",
  )
  .option("--cwd <cwd>", "working directory", process.cwd())
  .option("--shell", "print shell exports for `eval` instead of JSON")
  .option(
    "--print-env-file",
    "write shell exports to .agentroom/session.env and print the path",
  )
  .option(
    "--no-activate",
    "do not send the AgentRoom activation prompt after enrolling",
  )
  .option("--json", "print JSON")
  .action(
    async (options: {
      agentId?: string;
      paneId?: string;
      runtime?: string;
      role: string;
      harness: string;
      command: string;
      cwd: string;
      shell?: boolean;
      printEnvFile?: boolean;
      activate?: boolean;
      json?: boolean;
    }) => {
      const session = process.env.HERDR_SESSION;
      const paneId = options.paneId ?? process.env.HERDR_PANE_ID;
      if (!paneId) {
        throw new Error(
          "agent-room enroll: pass --pane-id or run inside a Herdr pane (HERDR_PANE_ID).",
        );
      }
      const agentId =
        options.agentId ?? `herdr:${session ?? "default"}:${paneId}`;

      const { store, config, appConfig } = await storeForCwd();
      const service = new AgentRoomService(store, { roomId: config.roomId });
      const role = parseAgentRole(options.role);

      const existingBinding = await service.getRuntimeBinding(agentId);
      let bindingId = paneId;
      let metadata: Record<string, unknown> | undefined;

      if (existingBinding) {
        bindingId = existingBinding.bindingId;
        metadata = existingBinding.metadata;
      } else {
        const { provider } = await runtimeProviderForCwd(options.runtime);
        if (!provider.adoptAgent) {
          throw new Error(
            `Runtime '${provider.kind}' does not support adoptAgent`,
          );
        }
        const harness = resolveHarnessSpec({
          kind: parseHarnessKind(options.harness),
          command: options.command,
          cwd: resolve(options.cwd),
        });
        await service.registerAgent({ id: agentId, role, harness });
        const agent = await provider.adoptAgent({
          agentId,
          bindingId: paneId,
          roomId: config.roomId,
          role,
          harness,
        });
        await service.bindRuntime({
          agentId,
          runtime: bindingFor(provider, agent.bindingId, agent.metadata),
        });
        bindingId = agent.bindingId;
        metadata = agent.metadata;
      }

      const env: Record<string, string> = {
        ...agentRoomProtocolEnv(config, { agentId, role }, appConfig),
      };

      await writeAgentRoomSessionIdentity(process.cwd(), {
        agentId,
        roomId: config.roomId,
        role,
        bindingId,
        paneId,
        env,
        updatedAt: new Date().toISOString(),
      });

      if (options.activate !== false) {
        try {
          const { provider } = await runtimeProviderForCwd(options.runtime);
          const trackerLabel = workTrackerLabel(appConfig);
          await activateAgent(provider, service, {
            agentId,
            roomId: config.roomId,
            bindingId,
            role,
            ...(options.harness !== "custom"
              ? { agentKind: options.harness }
              : {}),
            ...(trackerLabel !== undefined
              ? { workTracker: trackerLabel }
              : {}),
            ...(appConfig !== undefined
              ? { protocolPath: agentRoomProtocolPath() }
              : {}),
          });
        } catch (error) {
          console.warn(
            `agent-room enroll: activation prompt skipped: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      if (options.printEnvFile) {
        const envFile = await writeAgentRoomSessionEnvFile(process.cwd(), env);
        output(options.json ? { envFile } : envFile, options.json);
        return;
      }

      if (options.shell) {
        printShellExports(env);
        return;
      }
      output(
        {
          enrolled: true,
          agentId,
          roomId: config.roomId,
          role,
          bindingId,
          alreadyBound: existingBinding !== undefined,
          ...(metadata !== undefined ? { metadata } : {}),
        },
        options.json,
      );
    },
  );

program
  .command("read")
  .description("Read recent output from a runtime-backed agent")
  .argument("<agentId>", "agent id")
  .option(
    "--runtime <runtime>",
    "runtime provider; defaults to AgentRoom config",
  )
  .option("--lines <number>", "line count", parseInteger, 80)
  .option(
    "--unaudited",
    "manual recovery only: allow direct runtime access without an AgentRoom binding",
  )
  .option("--json", "print JSON")
  .action(
    async (
      agentId: string,
      options: {
        runtime?: string;
        lines: number;
        unaudited?: boolean;
        json?: boolean;
      },
    ) => {
      const context = await runtimeAccessForAgent(
        agentId,
        runtimeAccessOptions(options),
      );
      const { provider, service, bindingId } = context;
      const result = await provider.readAgent({
        agentId,
        ...(bindingId !== undefined ? { bindingId } : {}),
        lines: options.lines,
      });
      if (service) {
        await service.recordRuntimeOutput({
          agentId,
          text: result.text,
          ...(result.lineCount !== undefined
            ? { lineCount: result.lineCount }
            : {}),
        });
      }
      output(result, options.json);
    },
  );

program
  .command("send")
  .description("Send input to a runtime-backed agent")
  .argument("<agentId>", "agent id")
  .argument("<text>", "text to send")
  .option(
    "--runtime <runtime>",
    "runtime provider; defaults to AgentRoom config",
  )
  .option("--no-submit", "do not press Enter after input")
  .option(
    "--unaudited",
    "manual recovery only: allow direct runtime input without an AgentRoom binding",
  )
  .option("--json", "print JSON")
  .action(
    async (
      agentId: string,
      text: string,
      options: {
        runtime?: string;
        submit?: boolean;
        unaudited?: boolean;
        json?: boolean;
      },
    ) => {
      const context = await runtimeAccessForAgent(
        agentId,
        runtimeAccessOptions(options),
      );
      const { provider, service, bindingId } = context;
      const source = await currentActor();
      await provider.sendInput({
        agentId,
        ...(bindingId !== undefined ? { bindingId } : {}),
        text,
        source,
        ...(options.submit !== undefined ? { submit: options.submit } : {}),
      });
      if (service) {
        await service.recordRuntimeInput({
          agentId,
          text,
          source,
        });
      }
      output(
        { ok: true, agentId, text, audited: context.audited },
        options.json,
      );
    },
  );

program
  .command("activate")
  .description(
    "Send the AgentRoom activation prompt into an enrolled agent's runtime so it loads the agentroom skill",
  )
  .argument("<agentId>", "agent id")
  .option(
    "--runtime <runtime>",
    "runtime provider; defaults to bound runtime or AgentRoom config",
  )
  .option(
    "--unaudited",
    "manual recovery only: allow direct runtime input without an AgentRoom binding",
  )
  .option("--json", "print JSON")
  .action(
    async (
      agentId: string,
      options: { runtime?: string; unaudited?: boolean; json?: boolean },
    ) => {
      const { config, appConfig } = await storeForCwd();
      const context = await runtimeAccessForAgent(
        agentId,
        runtimeAccessOptions(options),
      );
      const agent = context.service
        ? await context.service.getAgent(agentId)
        : undefined;
      const agentKind =
        agent?.harness?.kind ??
        (typeof context.binding?.metadata?.["agent"] === "string"
          ? (context.binding.metadata["agent"] as string)
          : undefined);
      const trackerLabel = workTrackerLabel(appConfig);
      const result = await activateAgent(context.provider, context.service, {
        agentId,
        roomId: config.roomId,
        ...(context.bindingId !== undefined
          ? { bindingId: context.bindingId }
          : {}),
        ...(agent?.role !== undefined ? { role: agent.role } : {}),
        ...(agentKind !== undefined ? { agentKind } : {}),
        ...(trackerLabel !== undefined ? { workTracker: trackerLabel } : {}),
        ...(appConfig !== undefined
          ? { protocolPath: agentRoomProtocolPath() }
          : {}),
        source: await currentActor(),
      });
      output({ ok: true, ...result, audited: context.audited }, options.json);
    },
  );

program
  .command("stop")
  .description("Stop a runtime-backed agent")
  .argument("<agentId>", "agent id")
  .option(
    "--runtime <runtime>",
    "runtime provider; defaults to bound runtime or AgentRoom config",
  )
  .option(
    "--unaudited",
    "manual recovery only: allow direct runtime stop without an AgentRoom binding",
  )
  .option("--json", "print JSON")
  .action(
    async (
      agentId: string,
      options: { runtime?: string; unaudited?: boolean; json?: boolean },
    ) => {
      const context = await runtimeAccessForAgent(
        agentId,
        runtimeAccessOptions(options),
      );
      await context.provider.stopAgent(
        stopTargetFor(context.provider, agentId, context.binding),
      );
      output(
        {
          ok: true,
          agentId,
          runtime: context.provider.id,
          audited: context.audited,
        },
        options.json,
      );
    },
  );

program.parseAsync(normalizeRootArgv(process.argv)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof WaitTimeoutError ? error.exitCode : 1;
});

function normalizeRootArgv(argv: string[]): string[] {
  const [node, script, first, ...rest] = argv;
  if (node === undefined || script === undefined) return argv;
  if (first === undefined) return [node, script, "tui"];
  if (first === "--headless") return [node, script, "daemon", "start", ...rest];
  if (isRootTuiOption(first)) return [node, script, "tui", first, ...rest];
  return argv;
}

function isRootTuiOption(value: string): boolean {
  return (
    value === "--daemon" ||
    value.startsWith("--daemon=") ||
    value === "--api-token" ||
    value.startsWith("--api-token=") ||
    value === "--refresh-ms" ||
    value.startsWith("--refresh-ms=") ||
    value === "--no-auto-start"
  );
}

async function runtimeProviderForCwd(
  runtimeName?: string,
  herdrLayout?: HerdrLayoutConfig,
): Promise<{
  name: string;
  provider: RuntimeProvider;
  config?: AgentRoomConfig;
}> {
  const config = await ensureLocalAgentRoomConfig();
  const name = config ? (runtimeName ?? config.runtime.default) : runtimeName;
  if (name === undefined) {
    throw new Error("Runtime provider is required.");
  }
  const runtime = config
    ? ensureRuntimeConfig(config, name)
    : builtInRuntimeConfig(name);
  return {
    name,
    provider: makeRuntimeProvider(name, runtime, herdrLayout),
    ...(config !== undefined ? { config } : {}),
  };
}

async function ensureLocalAgentRoomConfig(): Promise<AgentRoomConfig> {
  const existing = await maybeLoadAgentRoomConfig();
  if (existing) return existing;

  const config = createDefaultAgentRoomConfig({
    roomId: defaultRoomIdFromEnv(process.env),
    roomName: "AgentRoom",
    defaultRuntime: "herdr",
  });
  await writeAgentRoomConfig(process.cwd(), config);
  return config;
}

function makeRuntimeProvider(
  name: string,
  runtime: RuntimeConfig,
  herdrLayout?: HerdrLayoutConfig,
): RuntimeProvider {
  switch (runtime.type) {
    case "fake":
      if (herdrLayout !== undefined)
        throw new Error("Herdr layout options require a Herdr runtime");
      return new FakeRuntimeProvider({ id: name });
    case "tmux":
      if (herdrLayout !== undefined)
        throw new Error("Herdr layout options require a Herdr runtime");
      return new TmuxRuntimeProvider({
        id: name,
        ...(runtime.cli !== undefined ? { cli: runtime.cli } : {}),
        ...(runtime.sessionPrefix !== undefined
          ? { sessionPrefix: runtime.sessionPrefix }
          : {}),
      });
    case "herdr": {
      const session = runtime.session ?? process.env.HERDR_SESSION;
      const layout = herdrLayout
        ? { ...(runtime.layout ?? {}), ...herdrLayout }
        : runtime.layout;
      return new HerdrRuntimeProvider({
        id: name,
        ...(runtime.cli !== undefined ? { cli: runtime.cli } : {}),
        ...(session !== undefined ? { session } : {}),
        ...(layout !== undefined ? { layout } : {}),
      });
    }
  }
}

async function handleDaemonCommand(
  mode: DaemonMode,
  options: DaemonCommandOptions,
): Promise<void> {
  const resolvedOptions = await resolveDaemonCommandOptions(mode, options);
  if (mode !== "status") await assertDaemonLifecycleAllowed(mode);

  switch (mode) {
    case "foreground":
      await runDaemonForeground(resolvedOptions);
      return;
    case "start":
      outputDaemonResult(await startDaemon(resolvedOptions), options.json);
      return;
    case "status":
      outputDaemonResult(await daemonStatus(resolvedOptions), options.json);
      return;
    case "stop":
      outputDaemonResult(await stopDaemon(resolvedOptions), options.json);
      return;
    case "restart": {
      const stopped = await stopDaemon(resolvedOptions);
      const started = await startDaemon(resolvedOptions);
      outputDaemonResult({ ok: true, stopped, started }, resolvedOptions.json);
      return;
    }
  }
}

async function runTuiCommand(options: TuiCommandOptions): Promise<void> {
  const ensured = await ensureDaemonForTui({
    daemonUrl: options.daemon,
    autoStart: options.autoStart,
    ...(options.apiToken !== undefined ? { apiToken: options.apiToken } : {}),
  });
  const apiToken = options.apiToken ?? ensured.apiToken;

  try {
    const { runAgentRoomTui } = await loadTui();
    await runAgentRoomTui({
      baseUrl: ensured.daemonUrl,
      ...(apiToken !== undefined ? { apiToken } : {}),
      ...(options.refreshMs !== undefined
        ? { refreshMs: options.refreshMs }
        : {}),
    });
  } finally {
    if (ensured.ownedDaemon !== undefined) {
      await stopTuiOwnedDaemon(ensured.ownedDaemon);
    }
  }
}

async function stopTuiOwnedDaemon(
  options: DaemonCommandOptions,
): Promise<void> {
  try {
    await stopDaemon({ ...options, force: true });
  } catch (error) {
    console.error(
      `Failed to stop TUI-owned AgentRoom daemon: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function resolveDaemonCommandOptions(
  mode: DaemonMode,
  options: DaemonCommandOptions,
): Promise<DaemonCommandOptions> {
  const tailnet =
    options.tailnet === true &&
    (mode === "foreground" || mode === "start" || mode === "restart");
  const endpoint = tailnet ? await resolveTailnetEndpoint() : undefined;
  const apiToken =
    normalizedToken(options.apiToken) ??
    normalizedToken(process.env.AGENTROOM_API_TOKEN) ??
    (tailnet ? randomUUID() : undefined);

  return {
    ...options,
    ...(endpoint !== undefined
      ? {
          host: endpoint.bindHost,
          publicUrl: daemonBaseUrl(endpoint.publicHost, options.port),
          tailnet: true,
        }
      : {}),
    ...(apiToken !== undefined ? { apiToken } : {}),
  };
}

async function assertDaemonLifecycleAllowed(mode: DaemonMode): Promise<void> {
  const actor = await currentActor();
  if (actor.kind === "human") return;

  const role = process.env.AGENTROOM_ROLE;
  if (
    actor.kind === "agent" &&
    (role === "lead" || role === "gateway" || actor.id === "gateway")
  )
    return;

  throw new Error(
    `agent-room daemon ${mode} requires a human operator, gateway agent, or lead agent`,
  );
}

async function runDaemonForeground(
  options: DaemonCommandOptions,
): Promise<void> {
  const command = daemonBinPath();
  await access(command, constants.X_OK);

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, [], {
      cwd: process.cwd(),
      env: daemonEnv(options),
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (typeof code === "number" && code !== 0) process.exitCode = code;
      if (signal !== null) process.exitCode = 1;
      resolvePromise();
    });
  });
}

async function startDaemon(
  options: DaemonCommandOptions,
): Promise<DaemonStatusPayload> {
  await ensureLocalAgentRoomConfig();
  const pidFile = resolve(options.pidFile ?? join(roomDir(), "daemon.pid"));
  const logFile = resolve(options.logFile ?? join(roomDir(), "daemon.log"));
  const command = daemonBinPath();
  await access(command, constants.X_OK);
  await mkdir(dirname(pidFile), { recursive: true });
  await mkdir(dirname(logFile), { recursive: true });

  const existing = await readDaemonPidRecord(pidFile);
  if (existing) {
    const processInfo = await daemonProcessInfo(existing.pid);
    const health = processInfo.alive
      ? await daemonHealth(existing.host, existing.port, 500)
      : undefined;
    if (
      processInfo.alive &&
      !daemonProcessVerified(existing, processInfo, health)
    ) {
      throw new Error(
        `Refusing to overwrite ${pidFile}; pid ${existing.pid} is alive but is not an AgentRoom daemon`,
      );
    }
    if (processInfo.alive) {
      if (health === undefined || !health.ok) {
        const reason = health?.reason ?? health?.status ?? "unknown error";
        throw new Error(
          `AgentRoom daemon pid ${existing.pid} is alive but health check failed: ${reason}`,
        );
      }
      return daemonStatusPayload(
        "running",
        existing,
        pidFile,
        health,
        processInfo,
      );
    }
    await removeDaemonPidFile(pidFile);
  }

  const occupied = await daemonHealth(options.host, options.port, 500);
  if (occupied.ok) {
    const pid = daemonHealthPid(occupied) ?? 0;
    const existingRecord: DaemonPidRecord = {
      pid,
      host: options.host,
      port: options.port,
      cwd: process.cwd(),
      startedAt: "",
      command,
      logFile,
      ...(options.apiToken !== undefined ? { apiToken: options.apiToken } : {}),
      ...(options.publicUrl !== undefined
        ? { publicUrl: options.publicUrl }
        : {}),
      ...(options.tailnet === true ? { tailnet: true } : {}),
    };
    if (pid > 0) await writePrivateJson(pidFile, existingRecord);
    return daemonStatusPayload(
      "running",
      existingRecord,
      pidFile,
      occupied,
      pid > 0 ? await daemonProcessInfo(pid) : undefined,
    );
  }

  const log = await open(logFile, "a");
  let childPid: number | undefined;
  const token = randomUUID();
  try {
    const child = spawn(command, [], {
      cwd: process.cwd(),
      detached: true,
      env: daemonEnv(options, token),
      stdio: ["ignore", log.fd, log.fd],
    });
    child.unref();
    childPid = child.pid;
  } finally {
    await log.close();
  }

  if (childPid === undefined)
    throw new Error("Failed to start AgentRoom daemon: missing child pid");

  const record: DaemonPidRecord = {
    pid: childPid,
    host: options.host,
    port: options.port,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
    command,
    logFile,
    token,
    ...(options.apiToken !== undefined ? { apiToken: options.apiToken } : {}),
    ...(options.publicUrl !== undefined
      ? { publicUrl: options.publicUrl }
      : {}),
    ...(options.tailnet === true ? { tailnet: true } : {}),
  };

  await writePrivateJson(pidFile, record);

  try {
    const health = await waitForDaemonHealth(record, options.timeout * 1000);
    const daemonPid = daemonHealthPid(health) ?? record.pid;
    const verifiedRecord = { ...record, pid: daemonPid };
    if (verifiedRecord.pid !== record.pid)
      await writePrivateJson(pidFile, verifiedRecord);
    return daemonStatusPayload(
      "running",
      verifiedRecord,
      pidFile,
      health,
      await daemonProcessInfo(verifiedRecord.pid),
    );
  } catch (error) {
    if (isProcessAlive(childPid)) process.kill(childPid, "SIGTERM");
    await removeDaemonPidFile(pidFile);
    throw error;
  }
}

async function daemonStatus(
  options: DaemonCommandOptions,
): Promise<DaemonStatusPayload> {
  const pidFile = resolve(options.pidFile ?? join(roomDir(), "daemon.pid"));
  const record = await readDaemonPidRecord(pidFile);

  if (record) {
    const processInfo = await daemonProcessInfo(record.pid);
    if (!processInfo.alive) {
      await removeDaemonPidFile(pidFile);
      return daemonStatusPayload(
        "stopped",
        record,
        pidFile,
        undefined,
        processInfo,
        "removed stale pidfile",
      );
    }
    const health = await daemonHealth(record.host, record.port, 500);
    if (!daemonProcessVerified(record, processInfo, health)) {
      return daemonStatusPayload(
        "pid-conflict",
        record,
        pidFile,
        health,
        processInfo,
        "pid is alive but is not an AgentRoom daemon",
      );
    }
    return daemonStatusPayload(
      health.ok ? "running" : "degraded",
      record,
      pidFile,
      health,
      processInfo,
    );
  }

  const fallbackRecord: DaemonPidRecord = {
    pid: 0,
    host: options.host,
    port: options.port,
    cwd: process.cwd(),
    startedAt: "",
    command: daemonBinPath(),
  };
  const health = await daemonHealth(options.host, options.port, 500);
  return daemonStatusPayload(
    health.ok ? "running-unmanaged" : "stopped",
    fallbackRecord,
    pidFile,
    health,
  );
}

async function stopDaemon(
  options: DaemonCommandOptions,
): Promise<DaemonStatusPayload> {
  const pidFile = resolve(options.pidFile ?? join(roomDir(), "daemon.pid"));
  const record = await readDaemonPidRecord(pidFile);

  if (!record) {
    const health = await daemonHealth(options.host, options.port, 500);
    if (health.ok) {
      throw new Error(
        `AgentRoom daemon is responding at ${health.url}, but ${pidFile} is missing; stop it manually or provide --pid-file`,
      );
    }
    return daemonStatusPayload(
      "stopped",
      {
        pid: 0,
        host: options.host,
        port: options.port,
        cwd: process.cwd(),
        startedAt: "",
        command: daemonBinPath(),
      },
      pidFile,
      health,
    );
  }

  const processInfo = await daemonProcessInfo(record.pid);
  if (!processInfo.alive) {
    await removeDaemonPidFile(pidFile);
    return daemonStatusPayload(
      "stopped",
      record,
      pidFile,
      undefined,
      processInfo,
      "removed stale pidfile",
    );
  }
  const health = await daemonHealth(record.host, record.port, 500);
  if (!daemonProcessVerified(record, processInfo, health)) {
    throw new Error(
      `Refusing to stop pid ${record.pid}; it is not an AgentRoom daemon`,
    );
  }

  const shutdownRequested = await requestDaemonShutdown(record);
  if (!shutdownRequested) {
    try {
      process.kill(record.pid, "SIGTERM");
    } catch (error) {
      throw new Error(
        `Failed to signal AgentRoom daemon pid ${record.pid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  let stopped = await waitForProcessExit(record.pid, options.timeout * 1000);
  if (!stopped && options.force) {
    try {
      process.kill(record.pid, "SIGKILL");
    } catch (error) {
      throw new Error(
        `Failed to force-stop AgentRoom daemon pid ${record.pid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    stopped = await waitForProcessExit(record.pid, options.timeout * 1000);
  }
  if (!stopped) {
    throw new Error(
      `Timed out waiting for AgentRoom daemon pid ${record.pid} to stop`,
    );
  }

  await removeDaemonPidFile(pidFile);
  return daemonStatusPayload(
    "stopped",
    record,
    pidFile,
    undefined,
    processInfo,
  );
}

async function mobileConnectPayload(
  options: MobileConnectOptions,
): Promise<MobileConnectPayload> {
  const pidFile = resolve(options.pidFile ?? join(roomDir(), "daemon.pid"));
  const record = await readDaemonPidRecord(pidFile);
  if (!record) {
    throw new Error(
      `No AgentRoom daemon pid record found at ${pidFile}. Start the daemon first.`,
    );
  }
  const baseUrl = await mobileConnectBaseUrl(record);
  const pairingLink = mobilePairingLink({
    baseUrl,
    mode: record.tailnet === true ? "tailnet" : "custom",
    ...(record.apiToken !== undefined ? { token: record.apiToken } : {}),
  });
  return {
    baseUrl,
    mode: record.tailnet === true ? "tailnet" : "custom",
    pairingLink,
    tokenRequired: record.apiToken !== undefined,
    pidFile,
    ...(record.apiToken !== undefined ? { token: record.apiToken } : {}),
    ...(record.apiToken !== undefined
      ? { authHeader: `Authorization: Bearer ${record.apiToken}` }
      : {}),
  };
}

async function pushMobileConnect(
  options: MobileConnectOptions,
  payload: MobileConnectPayload,
): Promise<void> {
  const pidFile = resolve(options.pidFile ?? join(roomDir(), "daemon.pid"));
  const record = await readDaemonPidRecord(pidFile);
  if (!record) {
    throw new Error(`No AgentRoom daemon pid record found at ${pidFile}.`);
  }
  const url = `${daemonBaseUrl(record.host, record.port)}/v1/mobile/connect-push`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (record.apiToken !== undefined) {
    headers.authorization = `Bearer ${record.apiToken}`;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ baseUrl: payload.baseUrl, mode: payload.mode }),
  });
  const result = (await response.json().catch(() => ({}))) as {
    error?: string;
    sent?: number;
    failed?: number;
  };
  if (!response.ok) {
    throw new Error(
      result.error ?? `connect-push failed with HTTP ${response.status}.`,
    );
  }
  const failedSuffix = result.failed ? `, ${result.failed} failed` : "";
  console.log(`Sent connect push to ${result.sent ?? 0} device(s)${failedSuffix}.`);
}

async function mobileConnectBaseUrl(record: DaemonPidRecord): Promise<string> {
  if (record.tailnet === true) {
    const endpoint = await resolveTailnetEndpoint().catch(() => undefined);
    if (endpoint?.publicHost !== undefined) {
      return daemonBaseUrl(endpoint.publicHost, record.port);
    }
  }
  return record.publicUrl ?? daemonBaseUrl(record.host, record.port);
}

function outputMobileConnect(
  payload: MobileConnectPayload,
  options: Pick<MobileConnectOptions, "copy" | "json">,
): void {
  if (options.json) {
    output(payload, true);
    return;
  }

  const lines = [
    "AgentRoom iOS connection",
    `Mode: ${payload.mode}`,
    `Base URL: ${payload.baseUrl}`,
  ];
  if (payload.token !== undefined) {
    lines.push(`API token: ${payload.token}`);
  } else {
    lines.push(
      "API token: not configured; restart with --tailnet or set AGENTROOM_API_TOKEN before exposing the daemon.",
    );
  }
  lines.push(`Pairing link: ${payload.pairingLink}`);
  if (options.copy === true) {
    lines.push("Copied pairing link to clipboard.");
  } else {
    lines.push(
      "Tip: run `agent-room mobile-connect --copy` to paste the pairing link on iPhone with Universal Clipboard.",
    );
  }
  lines.push(`Source: ${payload.pidFile}`);
  console.log(lines.join("\n"));
}

function mobilePairingLink(input: {
  baseUrl: string;
  mode: MobileConnectPayload["mode"];
  token?: string;
}): string {
  const params = new URLSearchParams({
    mode: input.mode,
    baseUrl: input.baseUrl,
  });
  if (input.token !== undefined) {
    params.set("token", input.token);
  }
  return `agentroom://connect?${params.toString()}`;
}

async function copyToClipboard(value: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("--copy currently requires macOS pbcopy.");
  }
  const child = spawn("pbcopy", {
    stdio: ["pipe", "ignore", "inherit"],
  });
  child.stdin.end(value);
  const code = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", resolve);
  });
  if (code !== 0) {
    throw new Error("Failed to copy pairing link with pbcopy.");
  }
}

function parseDaemonMode(value: string): DaemonMode {
  switch (value) {
    case "foreground":
    case "run":
      return "foreground";
    case "start":
    case "status":
    case "stop":
    case "restart":
      return value;
    default:
      throw new Error(
        `Invalid daemon mode '${value}'. Expected foreground, start, status, stop, or restart.`,
      );
  }
}

function daemonBinPath(): string {
  return join(REPO_ROOT, "bin", "agent-roomd");
}

function daemonEnv(
  options: DaemonCommandOptions,
  token?: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENTROOM_HOST: options.host,
    AGENTROOM_PORT: String(options.port),
    AGENTROOM_DAEMON: `${daemonBaseUrl(options.host, options.port)}`,
    ...(token !== undefined ? { AGENTROOM_DAEMON_TOKEN: token } : {}),
    ...(options.apiToken !== undefined
      ? { AGENTROOM_API_TOKEN: options.apiToken }
      : {}),
  };
}

async function readDaemonPidRecord(
  path: string,
): Promise<DaemonPidRecord | undefined> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    if (raw.length === 0) return undefined;

    if (/^\d+$/.test(raw)) {
      return {
        pid: Number(raw),
        host: DEFAULT_HOST,
        port: DEFAULT_PORT,
        cwd: process.cwd(),
        startedAt: "",
        command: daemonBinPath(),
      };
    }

    const parsed = JSON.parse(raw) as Partial<DaemonPidRecord>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0
    ) {
      throw new Error(`Invalid daemon pid record in ${path}`);
    }
    return {
      pid: parsed.pid,
      host: parsed.host ?? DEFAULT_HOST,
      port: parsed.port ?? DEFAULT_PORT,
      cwd: parsed.cwd ?? process.cwd(),
      startedAt: parsed.startedAt ?? "",
      command: parsed.command ?? daemonBinPath(),
      ...(parsed.logFile !== undefined ? { logFile: parsed.logFile } : {}),
      ...(parsed.token !== undefined ? { token: parsed.token } : {}),
      ...(parsed.apiToken !== undefined ? { apiToken: parsed.apiToken } : {}),
      ...(parsed.publicUrl !== undefined
        ? { publicUrl: parsed.publicUrl }
        : {}),
      ...(parsed.tailnet === true ? { tailnet: true } : {}),
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function removeDaemonPidFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

async function daemonProcessInfo(pid: number): Promise<DaemonProcessInfo> {
  if (!isProcessAlive(pid)) return { alive: false, verified: false };

  try {
    const { stdout } = await execFileAsync("ps", [
      "-p",
      String(pid),
      "-o",
      "command=",
    ]);
    const command = stdout.trim();
    return {
      alive: true,
      verified: isAgentRoomDaemonCommand(command),
      ...(command.length > 0 ? { command } : {}),
    };
  } catch {
    return { alive: true, verified: false };
  }
}

function daemonProcessVerified(
  record: DaemonPidRecord,
  processInfo: DaemonProcessInfo,
  health?: DaemonHealthCheck,
): boolean {
  if (!processInfo.alive) return false;
  if (processInfo.verified) return true;
  return daemonHealthPid(health) === record.pid;
}

function daemonHealthPid(health?: DaemonHealthCheck): number | undefined {
  if (!health?.body || typeof health.body !== "object") return undefined;
  const pid = (health.body as { pid?: unknown }).pid;
  return typeof pid === "number" ? pid : undefined;
}

function isAgentRoomDaemonCommand(command: string): boolean {
  return (
    command.includes("agent-roomd") ||
    command.includes("/apps/daemon/src/index.ts") ||
    command.includes("/apps/daemon/dist/index.js")
  );
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(100);
  }
  return !isProcessAlive(pid);
}

async function waitForDaemonHealth(
  record: DaemonPidRecord,
  timeoutMs: number,
): Promise<DaemonHealthCheck> {
  const deadline = Date.now() + timeoutMs;
  let last = await daemonHealth(record.host, record.port, 500);
  while (!last.ok && Date.now() <= deadline) {
    if (!isProcessAlive(record.pid))
      throw new Error(
        `AgentRoom daemon pid ${record.pid} exited before health check passed`,
      );
    await sleep(100);
    last = await daemonHealth(record.host, record.port, 500);
  }
  if (!last.ok)
    throw new Error(
      `Timed out waiting for AgentRoom daemon health at ${last.url}: ${last.reason ?? last.status ?? "unknown error"}`,
    );
  return last;
}

async function requestDaemonShutdown(
  record: DaemonPidRecord,
): Promise<boolean> {
  if (record.token === undefined) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(
      `${daemonBaseUrl(record.host, record.port)}/v1/admin/shutdown`,
      {
        method: "POST",
        headers: {
          "x-agentroom-daemon-token": record.token,
        },
        signal: controller.signal,
      },
    );
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function daemonHealth(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<DaemonHealthCheck> {
  const url = `${daemonBaseUrl(host, port)}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    return {
      ok: response.ok,
      url,
      status: response.status,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function daemonBaseUrl(host: string, port: number): string {
  const formattedHost =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}

interface IosTargetOptions {
  daemon?: string;
  apiToken?: string;
  pidFile?: string;
}

interface IosLogsOptions extends IosTargetOptions {
  client?: string;
  follow?: boolean;
  limit?: number;
  json?: boolean;
}

interface ClientLogEvent {
  seq: number;
  ts: string;
  clientId: string;
  level: string;
  category: string;
  message: string;
  fields?: Record<string, unknown>;
}

interface ClientStateRow {
  clientId: string;
  platform?: string;
  connection?: string;
  pushStatus?: string;
  pushTokenPrefix?: string;
  lastError?: string;
  build?: string;
  apnsEnv?: string;
  baseUrl?: string;
  updatedAt: string;
}

async function resolveIosDaemon(
  options: IosTargetOptions,
): Promise<{ baseUrl: string; apiToken?: string }> {
  if (options.daemon) {
    return {
      baseUrl: options.daemon,
      ...(options.apiToken ? { apiToken: options.apiToken } : {}),
    };
  }
  const record = await readDaemonPidRecord(
    resolve(options.pidFile ?? join(roomDir(), "daemon.pid")),
  );
  if (record) {
    return {
      baseUrl: record.publicUrl ?? daemonBaseUrl(record.host, record.port),
      ...(record.apiToken ? { apiToken: record.apiToken } : {}),
    };
  }
  const envToken = process.env.AGENTROOM_API_TOKEN;
  return {
    baseUrl: process.env.AGENTROOM_DAEMON ?? `http://127.0.0.1:${DEFAULT_PORT}`,
    ...(envToken ? { apiToken: envToken } : {}),
  };
}

function iosAuthHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function runIosLogs(options: IosLogsOptions): Promise<void> {
  const target = await resolveIosDaemon(options);
  let since = 0;
  let primed = false;
  const tick = async (): Promise<void> => {
    const url = new URL(`${target.baseUrl}/v1/clients/events`);
    if (options.client) url.searchParams.set("client", options.client);
    if (primed) url.searchParams.set("since", String(since));
    else url.searchParams.set("limit", String(options.limit ?? 100));
    const res = await fetch(url, { headers: iosAuthHeaders(target.apiToken) });
    if (!res.ok) throw new Error(`ios logs failed: HTTP ${res.status}`);
    const data = (await res.json()) as { events: ClientLogEvent[] };
    for (const event of data.events) {
      since = Math.max(since, event.seq);
      printClientEvent(event, options.json);
    }
    primed = true;
  };
  await tick();
  if (options.follow === true) {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await tick();
    }
  }
}

function printClientEvent(event: ClientLogEvent, json?: boolean): void {
  if (json === true) {
    console.log(JSON.stringify(event));
    return;
  }
  const fields =
    event.fields && Object.keys(event.fields).length > 0
      ? "  " +
        Object.entries(event.fields)
          .map(
            ([k, v]) =>
              `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`,
          )
          .join(" ")
      : "";
  const time = event.ts.replace("T", " ").replace(/\.\d+Z?$/, "");
  console.log(
    `${time}  ${event.level.toUpperCase().padEnd(5)} ${event.category.padEnd(
      10,
    )} ${event.message}${fields}`,
  );
}

async function runIosState(
  options: IosTargetOptions & { json?: boolean },
): Promise<void> {
  const target = await resolveIosDaemon(options);
  const res = await fetch(`${target.baseUrl}/v1/clients`, {
    headers: iosAuthHeaders(target.apiToken),
  });
  if (!res.ok) throw new Error(`ios state failed: HTTP ${res.status}`);
  const data = (await res.json()) as { clients: ClientStateRow[] };
  if (options.json === true) {
    output(data.clients, true);
    return;
  }
  if (data.clients.length === 0) {
    console.log("No iOS clients have reported in yet.");
    return;
  }
  for (const client of data.clients) {
    console.log(
      `${client.clientId}  [${client.connection ?? "?"}]  push=${
        client.pushStatus ?? "?"
      } token=${client.pushTokenPrefix ?? "-"} env=${client.apnsEnv ?? "-"}`,
    );
    if (client.lastError) console.log(`    last error: ${client.lastError}`);
    console.log(
      `    build=${client.build ?? "?"} baseUrl=${
        client.baseUrl ?? "?"
      } updated=${client.updatedAt}`,
    );
  }
}

async function runIosCommand(
  clientId: string,
  kind: string,
  options: IosTargetOptions & { json?: boolean },
): Promise<void> {
  const target = await resolveIosDaemon(options);
  const res = await fetch(
    `${target.baseUrl}/v1/clients/${encodeURIComponent(clientId)}/commands`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...iosAuthHeaders(target.apiToken),
      },
      body: JSON.stringify({ kind }),
    },
  );
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    command?: unknown;
  };
  if (!res.ok) throw new Error(data.error ?? `ios cmd failed: HTTP ${res.status}`);
  if (options.json === true) {
    output(data.command, true);
    return;
  }
  console.log(`Queued '${kind}' for ${clientId} (delivered on its next check-in).`);
}

function parseDaemonUrl(value: string): { host: string; port: number } {
  const url = new URL(value);
  const port = url.port ? Number.parseInt(url.port, 10) : DEFAULT_PORT;
  const host =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  return { host, port };
}

function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0"
  );
}

async function ensureDaemonForTui(options: {
  daemonUrl: string;
  autoStart: boolean;
  apiToken?: string;
}): Promise<TuiDaemonEnsureResult> {
  const { host, port } = parseDaemonUrl(options.daemonUrl);
  const pidFile = resolve(join(roomDir(), "daemon.pid"));
  const record = await readDaemonPidRecord(pidFile);
  if (record !== undefined) {
    const processInfo = await daemonProcessInfo(record.pid);
    if (!processInfo.alive) {
      await removeDaemonPidFile(pidFile);
    } else {
      const recordHealth = await daemonHealth(record.host, record.port, 500);
      if (
        daemonProcessVerified(record, processInfo, recordHealth) &&
        recordHealth.ok
      ) {
        return {
          daemonUrl:
            record.publicUrl ?? daemonBaseUrl(record.host, record.port),
          ...(record.apiToken !== undefined
            ? { apiToken: record.apiToken }
            : {}),
        };
      }
    }
  }

  const health = await daemonHealth(host, port, 500);
  if (health.ok) {
    return { daemonUrl: options.daemonUrl };
  }

  if (!options.autoStart) return { daemonUrl: options.daemonUrl };
  if (!isLoopbackHost(host)) return { daemonUrl: options.daemonUrl };

  console.error(
    `AgentRoom daemon not reachable at ${daemonBaseUrl(host, port)}; starting it…`,
  );

  return startTuiOwnedDaemon({
    host,
    port,
    ...(options.apiToken !== undefined ? { apiToken: options.apiToken } : {}),
  });
}

async function startTuiOwnedDaemon(input: {
  host: string;
  port: number;
  apiToken?: string;
}): Promise<TuiDaemonEnsureResult> {
  await assertDaemonLifecycleAllowed("start");
  const resolved = await resolveDaemonCommandOptions("start", {
    host: input.host,
    port: input.port,
    timeout: 5,
    ...(input.apiToken !== undefined ? { apiToken: input.apiToken } : {}),
  });
  const started = await startDaemon(resolved);

  const pidFile = resolve(join(roomDir(), "daemon.pid"));
  const record = await readDaemonPidRecord(pidFile);
  return {
    daemonUrl: started.publicUrl ?? daemonBaseUrl(started.host, started.port),
    ownedDaemon: resolved,
    ...(record?.apiToken !== undefined ? { apiToken: record.apiToken } : {}),
  };
}

async function resolveTailnetEndpoint(): Promise<TailnetEndpoint> {
  const candidates = [
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ];
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate, ["status", "--json"], {
        timeout: 5000,
      });
      const parsed = parseTailscaleStatus(stdout);
      const bindHost = preferredTailnetBindHost(parsed?.Self?.TailscaleIPs);
      if (bindHost === undefined) continue;
      return {
        bindHost,
        publicHost: parsed?.Self?.DNSName ?? bindHost,
      };
    } catch {
      continue;
    }
  }
  throw new Error(
    "Could not find a Tailscale address. Make sure Tailscale is installed and connected, then retry.",
  );
}

function parseTailscaleStatus(raw: string): {
  Self?: { DNSName?: string; TailscaleIPs?: string[] };
} | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      Self?: { DNSName?: unknown; TailscaleIPs?: unknown };
    };
    const dnsName =
      typeof parsed.Self?.DNSName === "string"
        ? parsed.Self.DNSName.replace(/\.$/, "")
        : undefined;
    const tailscaleIPs = Array.isArray(parsed.Self?.TailscaleIPs)
      ? parsed.Self.TailscaleIPs.filter(
          (value): value is string => typeof value === "string",
        )
      : undefined;
    return {
      Self: {
        ...(dnsName !== undefined ? { DNSName: dnsName } : {}),
        ...(tailscaleIPs !== undefined ? { TailscaleIPs: tailscaleIPs } : {}),
      },
    };
  } catch {
    return null;
  }
}

function preferredTailnetBindHost(
  ips: string[] | undefined,
): string | undefined {
  if (!ips || ips.length === 0) return undefined;
  return ips.find(isIpv4Address) ?? ips[0];
}

function isIpv4Address(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

function normalizedToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function daemonStatusPayload(
  state: string,
  record: DaemonPidRecord,
  pidFile: string,
  health?: DaemonHealthCheck,
  processInfo?: DaemonProcessInfo,
  reason?: string,
): DaemonStatusPayload {
  return {
    ok:
      state === "running" ||
      state === "running-unmanaged" ||
      state === "stopped",
    state,
    pidFile,
    ...(record.pid > 0 ? { pid: record.pid } : {}),
    host: record.host,
    port: record.port,
    ...(record.publicUrl !== undefined ? { publicUrl: record.publicUrl } : {}),
    apiTokenRequired: record.apiToken !== undefined,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.logFile !== undefined ? { logFile: record.logFile } : {}),
    ...(processInfo?.command !== undefined
      ? { command: processInfo.command }
      : {}),
    ...(health !== undefined ? { health } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

function outputDaemonResult(
  result: DaemonStatusPayload | DaemonRestartPayload,
  json?: boolean,
): void {
  if (json) {
    output(result, true);
    return;
  }

  if ("started" in result) {
    console.log(formatDaemonRestart(result));
    return;
  }

  console.log(formatDaemonStatus(result));
}

function formatDaemonRestart(result: DaemonRestartPayload): string {
  const url =
    result.started.publicUrl ??
    daemonBaseUrl(result.started.host, result.started.port);
  const lines = [
    `AgentRoom daemon restarted at ${url}${pidSuffix(result.started)}`,
  ];
  if (result.stopped.pid !== undefined)
    lines.push(`Stopped pid ${result.stopped.pid}`);
  if (result.started.logFile !== undefined)
    lines.push(`Log: ${result.started.logFile}`);
  if (result.started.apiTokenRequired)
    lines.push("Mobile token: run agent-room mobile-connect");
  return lines.join("\n");
}

function formatDaemonStatus(payload: DaemonStatusPayload): string {
  const url = payload.publicUrl ?? daemonBaseUrl(payload.host, payload.port);
  const pid = pidSuffix(payload);

  switch (payload.state) {
    case "running":
      return withOptionalLog(
        `AgentRoom daemon running at ${url}${pid}`,
        payload,
      );
    case "running-unmanaged":
      return `AgentRoom daemon running at ${url} (unmanaged; no pidfile)`;
    case "stopped":
      return `AgentRoom daemon stopped at ${url}${payload.reason ? `: ${payload.reason}` : ""}`;
    case "degraded":
      return `AgentRoom daemon degraded at ${url}${pid}: ${daemonHealthDetail(payload)}`;
    case "pid-conflict":
      return `AgentRoom daemon pid conflict at ${url}${pid}: ${payload.reason ?? daemonHealthDetail(payload)}`;
    default:
      return `AgentRoom daemon ${payload.state} at ${url}${pid}${payload.reason ? `: ${payload.reason}` : ""}`;
  }
}

function withOptionalLog(line: string, payload: DaemonStatusPayload): string {
  const lines = [line];
  if (payload.logFile !== undefined) lines.push(`Log: ${payload.logFile}`);
  if (payload.apiTokenRequired)
    lines.push("Mobile token: run agent-room mobile-connect");
  return lines.join("\n");
}

function pidSuffix(payload: DaemonStatusPayload): string {
  return payload.pid === undefined ? "" : ` (pid ${payload.pid})`;
}

function daemonHealthDetail(payload: DaemonStatusPayload): string {
  if (payload.health?.reason !== undefined) return payload.health.reason;
  if (payload.health?.status !== undefined)
    return `HTTP ${payload.health.status}`;
  return "health check failed";
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function serviceForCwd(): Promise<AgentRoomService> {
  const { store, config } = await storeForCwd();
  return new AgentRoomService(store, { roomId: config.roomId });
}

interface RuntimeAccessOptions {
  runtime?: string;
  unaudited?: boolean;
}

interface RuntimeAccess {
  provider: RuntimeProvider;
  service?: AgentRoomService;
  binding?: RuntimeBinding;
  bindingId?: string;
  audited: boolean;
}

function runtimeAccessOptions(options: {
  runtime?: string;
  unaudited?: boolean;
}): RuntimeAccessOptions {
  return {
    ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
    ...(options.unaudited !== undefined
      ? { unaudited: options.unaudited }
      : {}),
  };
}

async function runtimeAccessForAgent(
  agentId: string,
  options: RuntimeAccessOptions,
): Promise<RuntimeAccess> {
  if (options.unaudited) {
    const { provider } = await runtimeProviderForCwd(options.runtime);
    return {
      provider,
      audited: false,
    };
  }

  let service: AgentRoomService;
  try {
    service = await serviceForCwd();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Audited runtime access requires AgentRoom state; pass --unaudited for manual recovery. ${reason}`,
    );
  }

  const binding = await service.getRuntimeBinding(agentId);
  if (!binding) {
    throw new Error(
      `No runtime binding found for agent '${agentId}'. Use 'agent-room launch ${agentId} ...' first, or pass --unaudited for manual recovery.`,
    );
  }

  const { provider } = await runtimeProviderForCwd(
    options.runtime ?? binding.providerId,
  );
  if (provider.id !== binding.providerId) {
    throw new Error(
      `Runtime '${provider.id}' does not match bound runtime '${binding.providerId}' for agent '${agentId}'. Omit --runtime or pass --unaudited for manual recovery.`,
    );
  }

  return {
    provider,
    service,
    binding,
    bindingId: binding.bindingId,
    audited: true,
  };
}

async function maybeServiceForCwd(): Promise<AgentRoomService | undefined> {
  try {
    return await serviceForCwd();
  } catch {
    return undefined;
  }
}

async function storeForCwd(): Promise<{
  store: JsonlEventStore;
  config: RoomConfig;
  appConfig?: AgentRoomConfig;
}> {
  const project = await loadProjectConfig();
  return {
    config: project.room,
    store: new JsonlEventStore(project.eventLogPath),
    ...(project.appConfig !== undefined
      ? { appConfig: project.appConfig }
      : {}),
  };
}

async function loadProjectConfig(): Promise<{
  room: RoomConfig;
  eventLogPath: string;
  appConfig?: AgentRoomConfig;
}> {
  const appConfig = await ensureLocalAgentRoomConfig();
  return {
    room: {
      roomId: appConfig.room.id,
      roomName: appConfig.room.name ?? appConfig.room.id,
      createdAt: "",
    },
    eventLogPath: resolveStoragePath(appConfig),
    appConfig,
  };
}

async function loadAgentRoomConfigForCwd(): Promise<AgentRoomConfig> {
  return ensureLocalAgentRoomConfig();
}

function roomDir(): string {
  return agentRoomDir();
}

type IdentitySource = "env" | "pane" | "session";

interface ResolvedIdentity {
  agentId: string;
  roomId?: string;
  role?: string;
  source: IdentitySource;
}

async function currentActor(): Promise<ActorRef> {
  const identity = await resolveCurrentIdentity();
  if (identity !== undefined) {
    return { kind: "agent" as const, id: identity.agentId };
  }
  warnIfLikelyAgentShell();
  return { kind: "human" as const, id: process.env.USER ?? "local" };
}

async function resolveCurrentIdentity(): Promise<ResolvedIdentity | undefined> {
  const envAgentId = process.env.AGENTROOM_AGENT_ID?.trim();
  if (envAgentId) {
    return {
      agentId: envAgentId,
      ...(process.env.AGENTROOM_ROOM_ID !== undefined
        ? { roomId: process.env.AGENTROOM_ROOM_ID }
        : {}),
      ...(process.env.AGENTROOM_ROLE !== undefined
        ? { role: process.env.AGENTROOM_ROLE }
        : {}),
      source: "env",
    };
  }

  const paneAgentId = await resolveAgentByPane();
  if (paneAgentId !== undefined) {
    return {
      agentId: paneAgentId,
      ...(process.env.AGENTROOM_ROOM_ID !== undefined
        ? { roomId: process.env.AGENTROOM_ROOM_ID }
        : {}),
      ...(process.env.AGENTROOM_ROLE !== undefined
        ? { role: process.env.AGENTROOM_ROLE }
        : {}),
      source: "pane",
    };
  }

  const session = await readAgentRoomSessionIdentity(
    process.cwd(),
    process.env.HERDR_PANE_ID,
  );
  if (session !== undefined) {
    return {
      agentId: session.agentId,
      roomId: session.roomId,
      ...(session.role !== undefined ? { role: session.role } : {}),
      source: "session",
    };
  }

  return undefined;
}

function warnIfLikelyAgentShell(): void {
  if (process.env.AGENTROOM === "1" || process.env.HERDR_PANE_ID) {
    console.warn(
      "agent-room: warning: command is posting as a human because no AgentRoom identity was resolved. Run 'agent-room enroll --json' first.",
    );
  }
}

function agentRoomProtocolEnv(
  config: RoomConfig,
  input: { agentId: string; role: AgentRole },
  appConfig?: AgentRoomConfig,
): Record<string, string> {
  return {
    AGENTROOM: "1",
    AGENTROOM_AGENT_ID: input.agentId,
    AGENTROOM_ROOM_ID: config.roomId,
    AGENTROOM_ROLE: input.role,
    ...(appConfig !== undefined
      ? { AGENTROOM_PROTOCOL_FILE: agentRoomProtocolPath() }
      : {}),
    ...workTrackerProtocolEnv(appConfig),
  };
}

function workTrackerProtocolEnv(
  config: AgentRoomConfig | undefined,
): Record<string, string> {
  const trackerId = config?.workTracker?.default;
  if (trackerId === undefined) return {};
  const provider = config?.workTracker?.providers[trackerId];
  if (provider === undefined) return { AGENTROOM_WORK_TRACKER: trackerId };
  return {
    AGENTROOM_WORK_TRACKER: trackerId,
    AGENTROOM_WORK_TRACKER_PROVIDER_KIND: provider.type,
    ...(provider.teamId !== undefined
      ? { AGENTROOM_WORK_TRACKER_TEAM_ID: provider.teamId }
      : {}),
    ...(provider.projectId !== undefined
      ? { AGENTROOM_WORK_TRACKER_PROJECT_ID: provider.projectId }
      : {}),
    ...(provider.baseUrl !== undefined
      ? { AGENTROOM_WORK_TRACKER_BASE_URL: provider.baseUrl }
      : {}),
  };
}

async function resolveAgentByPane(): Promise<string | undefined> {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) return undefined;
  try {
    const service = await maybeServiceForCwd();
    if (!service) return undefined;
    return await service.findAgentByBinding(paneId);
  } catch {
    return undefined;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

async function runChild(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${command} exited on signal ${signal}`));
        return;
      }
      if (code && code !== 0) {
        reject(new Error(`${command} exited with code ${code}`));
        return;
      }
      resolvePromise();
    });
  });
}

function output(value: unknown, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (typeof value === "string") {
    console.log(value);
    return;
  }

  console.log(JSON.stringify(value, null, 2));
}

function printShellExports(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    const escaped = value.replace(/'/g, "'\\''");
    console.log(`export ${key}='${escaped}'`);
  }
}

type EventMatcher = (event: RoomEvent) => boolean;

class WaitTimeoutError extends Error {
  readonly exitCode = 2;
}

async function waitMatchers(options: {
  message?: string;
  ignoreCase?: boolean;
  from?: string;
  channel?: string;
  kind?: string;
  dmToMe?: boolean;
}): Promise<EventMatcher[]> {
  const matchers: EventMatcher[] = [];

  if (options.message !== undefined) {
    const pattern = compileMessagePattern(options.message, options.ignoreCase);
    matchers.push(
      (event) =>
        event.type === "message.posted" &&
        messageScopeMatches(event, options) &&
        pattern.test(event.payload.message.body),
    );
  }

  if (options.dmToMe) {
    const actor = await currentActor();
    if (actor.kind !== "agent") {
      throw new Error(
        "--dm-to-me requires an enrolled agent identity (AGENTROOM_AGENT_ID or HERDR_PANE_ID resolvable to a room agent)",
      );
    }
    const agentId = actor.id;
    matchers.push(
      (event) =>
        event.type === "message.posted" &&
        messageScopeMatches(event, options) &&
        (event.payload.message.recipients ?? []).some(
          (recipient) => recipient.kind === "agent" && recipient.id === agentId,
        ),
    );
  }

  return matchers;
}

function messageScopeMatches(
  event: RoomEvent,
  options: { from?: string; channel?: string; kind?: string },
): boolean {
  if (event.type !== "message.posted") return false;
  const message = event.payload.message;
  if (
    options.from !== undefined &&
    (message.sender.kind !== "agent" || message.sender.id !== options.from)
  ) {
    return false;
  }
  if (options.channel !== undefined && message.channelId !== options.channel) {
    return false;
  }
  if (
    options.kind !== undefined &&
    message.kind !== parseMessageKind(options.kind)
  ) {
    return false;
  }
  return true;
}

function compileMessagePattern(
  value: string,
  ignoreCase: boolean | undefined,
): RegExp {
  let source = value;
  let flags = ignoreCase ? "i" : "";
  if (source.startsWith("(?i)")) {
    source = source.slice(4);
    flags = "i";
  }
  try {
    return new RegExp(source, flags);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid --message JavaScript regex: ${reason}. Use --ignore-case instead of inline (?i) when possible.`,
    );
  }
}

async function waitForAgentState(
  service: AgentRoomService,
  agentId: string,
  state: AgentState,
  timeout: number,
): Promise<Agent> {
  const existing = await service.getAgent(agentId);
  if (!existing) throw new Error(`Agent not found: ${agentId}`);
  if (existing.state === state) return existing;

  let cursor = await service.eventCursor("end");
  const deadline = Date.now() + timeout * 1000;
  while (true) {
    const batch = await service.listEventsFromCursor(cursor);
    cursor = batch.cursor;
    const match = batch.events.find((event) => {
      if (event.type === "agent.heartbeat") {
        return (
          event.payload.agentId === agentId && event.payload.state === state
        );
      }
      if (event.type === "runtime.state_observed") {
        return (
          event.payload.agentId === agentId && event.payload.state === state
        );
      }
      if (event.type === "agent.done") {
        return event.payload.agentId === agentId && state === "done";
      }
      if (event.type === "agent.blocked") {
        return event.payload.agentId === agentId && state === "blocked";
      }
      if (event.type === "agent.left") {
        return event.payload.agentId === agentId && state === "stopped";
      }
      if (event.type === "agent.finished") {
        return (
          event.payload.agentId === agentId && event.payload.state === state
        );
      }
      return false;
    });
    if (match !== undefined) {
      const agent = await service.getAgent(agentId);
      if (!agent)
        throw new Error(`Agent not found after state change: ${agentId}`);
      return agent;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new WaitTimeoutError(
        `Timed out waiting for agent ${agentId} to reach ${state} after ${timeout}s`,
      );
    await sleep(Math.min(1000, remaining));
  }
}

function agentStateExitCode(state: AgentState): number {
  switch (state) {
    case "failed":
      return 3;
    case "blocked":
    case "needs-human":
      return 4;
    case "stopped":
      return 5;
    default:
      return 0;
  }
}

function parseSinceOption(value: string): string {
  if (value === "now") return new Date().toISOString();

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp))
    throw new Error(
      `Invalid --since '${value}'. Expected ISO timestamp or 'now'.`,
    );
  return new Date(timestamp).toISOString();
}

function parseNonNegativeNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`Invalid non-negative number: ${value}`);
  return parsed;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error(`Invalid integer: ${value}`);
  return parsed;
}

function parseAgentRole(value: string): AgentRole {
  const result = agentRoleSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid agent role: ${value}`);
  return result.data;
}

function parseAgentState(value: string): AgentState {
  const result = agentStateSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid agent state: ${value}`);
  return result.data;
}

function parseHarnessKind(value: string): HarnessSpec["kind"] {
  const result = harnessKindSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid harness kind: ${value}`);
  return result.data;
}

function resolveHarnessSpec(input: {
  kind: HarnessSpec["kind"];
  command: string;
  cwd: string;
}): HarnessSpec {
  return {
    kind: input.kind,
    command: input.command,
    cwd: input.cwd,
  };
}

function parseMessageKind(value: string): MessageKind {
  const result = messageKindSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid message kind: ${value}`);
  return result.data;
}

function parseImportance(value: string): Importance {
  const result = importanceSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid importance: ${value}`);
  return result.data;
}

function parseAgentRecipients(value: string): ActorRef[] {
  const recipients = value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => ({ kind: "agent" as const, id }));
  if (recipients.length === 0)
    throw new Error("At least one recipient agent id is required");
  return recipients;
}

function parseOptionalList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}


function workTrackerHealth(config: AgentRoomConfig | undefined): {
  ok: boolean;
  tracker: string;
  kind: string;
  message: string;
  provider?: WorkTrackerProviderConfig;
} {
  const tracker = config?.workTracker;
  if (tracker === undefined) {
    return {
      ok: true,
      tracker: "native",
      kind: "native",
      message:
        "No work tracker configured. AgentRoom has no built-in task store — track tasks in a markdown checklist (e.g. TASKS.md or the PR description).",
    };
  }

  const providerId = tracker.default;
  const providerConfig = tracker.providers[providerId];
  if (providerConfig === undefined) {
    return {
      ok: false,
      tracker: providerId,
      kind: "unknown",
      message: `tracker_update_skipped: work tracker '${providerId}' is not configured`,
    };
  }

  if (providerConfig.type === "native") {
    return {
      ok: true,
      tracker: providerId,
      kind: providerConfig.type,
      message:
        "Work tracker set to 'native' (none external). AgentRoom has no built-in task store — track tasks in a markdown checklist (e.g. TASKS.md or the PR description).",
    };
  }

  return {
    ok: true,
    tracker: providerId,
    kind: providerConfig.type,
    provider: providerConfig,
    message:
      "External tracker is selected. Agents should use the configured tracker MCP, CLI, or skill for provider-specific work and link refs with task link-tracker.",
  };
}

function herdrLayoutOverride(input: {
  placement?: string;
  workspace?: string;
  panesPerTab?: number;
  split?: string;
}): HerdrLayoutConfig | undefined {
  const mode =
    input.placement !== undefined
      ? parseHerdrPlacement(input.placement)
      : undefined;
  const split =
    input.split !== undefined ? parseHerdrSplit(input.split) : undefined;
  if (input.panesPerTab !== undefined && input.panesPerTab < 1) {
    throw new Error("--panes-per-tab must be at least 1");
  }

  if (
    mode === undefined &&
    input.workspace === undefined &&
    input.panesPerTab === undefined &&
    split === undefined
  ) {
    return undefined;
  }

  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
    ...(input.panesPerTab !== undefined
      ? { panesPerTab: input.panesPerTab }
      : {}),
    ...(split !== undefined ? { split } : {}),
  };
}

function parseHerdrPlacement(value: string): HerdrLayoutConfig["mode"] {
  switch (value) {
    case "workspace":
    case "workspace-per-agent":
      return "workspace-per-agent";
    case "tab":
    case "tab-per-agent":
      return "tab-per-agent";
    case "pane":
    case "pane-grid":
      return "pane-grid";
    default:
      throw new Error(
        `Invalid Herdr placement '${value}'. Expected workspace, tab, or pane.`,
      );
  }
}

function parseHerdrSplit(
  value: string,
): NonNullable<HerdrLayoutConfig["split"]> {
  if (value === "largest" || value === "focused") return value;
  throw new Error(
    `Invalid Herdr split strategy '${value}'. Expected largest or focused.`,
  );
}

function workspaceLabelFromCwd(cwd: string): string {
  const label = basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return label || "workspace";
}

function stopTargetFor(
  provider: RuntimeProvider,
  agentId: string,
  binding?: RuntimeBinding,
): string {
  if (provider.kind === "herdr" && binding?.providerId === provider.id)
    return binding.bindingId;
  return agentId;
}

function bindingFor(
  provider: RuntimeProvider,
  bindingId: string,
  metadata?: Record<string, unknown>,
): RuntimeBinding {
  return {
    providerId: provider.id,
    bindingId,
    kind:
      provider.kind === "tmux" || provider.kind === "herdr"
        ? "pane"
        : "process",
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function parseConfiguredRuntime(value: string): "fake" | "herdr" | "tmux" {
  if (value === "fake" || value === "herdr" || value === "tmux") return value;
  throw new Error(`Invalid runtime '${value}'. Expected fake, herdr, or tmux.`);
}

function resolveInitRoomId(options: { room: string | undefined }): string {
  return (
    normalizedConfigValue(options.room) ?? defaultRoomIdFromEnv(process.env)
  );
}

function normalizedConfigValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveInitRuntimeSession(options: {
  runtime: ConfiguredRuntimeKind;
  runtimeSession: string | undefined;
}): string | undefined {
  const explicit = normalizedConfigValue(options.runtimeSession);
  if (explicit !== undefined) return explicit;
  return undefined;
}

function applyRuntimeCliOverride(
  config: AgentRoomConfig,
  runtimeName: string,
  runtimeCli: string | undefined,
): void {
  if (runtimeCli === undefined) return;
  const runtime = ensureRuntimeConfig(config, runtimeName);
  if (runtime.type === "fake") {
    throw new Error("--runtime-cli requires a Herdr or tmux runtime");
  }
  runtime.cli = runtimeCli;
}

function createWorkTrackerConfig(options: {
  tracker: string;
  teamId?: string;
}): WorkTrackerConfig {
  const providerKind = parseWorkTrackerProviderKind(options.tracker);
  const defaultProvider =
    providerKind === "github-issues" ? "github" : providerKind;
  const provider: WorkTrackerProviderConfig = {
    type: providerKind,
    ...(options.teamId !== undefined ? { teamId: options.teamId } : {}),
  };
  return {
    default: defaultProvider,
    providers: {
      [defaultProvider]: provider,
    },
  };
}

function parseWorkTrackerProviderKind(value: string): WorkTrackerProviderKind {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "native" ||
    normalized === "linear" ||
    normalized === "github-issues" ||
    normalized === "jira" ||
    normalized === "custom"
  ) {
    return normalized;
  }
  if (normalized === "github" || normalized === "github_issues") {
    return "github-issues";
  }
  throw new Error(
    `Invalid work tracker '${value}'. Expected native, linear, github-issues, jira, or custom.`,
  );
}

function parseClankyChatGatewayOwner(value: string): ClankyChatGatewayOwner {
  const normalized = value.trim().toLowerCase();
  if (normalized === "agent" || normalized === "room" || normalized === "off") {
    return normalized;
  }
  throw new Error(
    `Invalid Clanky chat owner '${value}'. Expected agent, room, or off.`,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["--version"]);
    return true;
  } catch {
    try {
      await execFileAsync(command, ["-V"]);
      return true;
    } catch {
      return false;
    }
  }
}
