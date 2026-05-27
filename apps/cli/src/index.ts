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
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Command } from "commander";
import {
  AgentRoomService,
  agentRoleSchema,
  type ActorRef,
  type AgentRole,
  type HarnessSpec,
  harnessKindSchema,
  type Importance,
  importanceSchema,
  type MessageKind,
  messageKindSchema,
  type Ref,
  type RoomEvent,
  type RuntimeBinding,
  type RuntimeProvider,
  type TaskStatus,
  taskStatusSchema,
} from "@agentroom/core";
import {
  agentRoomConfigPath,
  builtInRuntimeConfig,
  createDefaultAgentRoomConfig,
  ensureRuntimeConfig,
  loadAgentRoomConfig,
  maybeLoadAgentRoomConfig,
  resolveStoragePath,
  runtimeNameFor,
  withDefaultRuntime,
  writeAgentRoomConfig,
  type AgentRoomConfig,
  type HerdrLayoutConfig,
  type RuntimeConfig,
} from "@agentroom/config";
import { JsonlEventStore } from "@agentroom/storage-jsonl";
import { FakeRuntimeProvider } from "@agentroom/runtime-fake";
import { HerdrRuntimeProvider } from "@agentroom/runtime-herdr";
import { TmuxRuntimeProvider } from "@agentroom/runtime-tmux";
import { LinearWorkTrackerProvider } from "@agentroom/worktracker-linear";

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
    "\nShortcuts:\n  agent-room              Open the TUI for the current cwd\n  agent-room --headless   Start the current cwd daemon without the TUI",
  );

program
  .command("init")
  .description("Initialize AgentRoom metadata in the current project")
  .option("--room <id>", "room id", basename(process.cwd()))
  .option("--name <name>", "human-readable room name")
  .requiredOption(
    "--runtime <runtime>",
    "runtime provider to write as the room default: herdr|tmux|fake",
  )
  .option(
    "--runtime-session <name>",
    "Herdr session name or tmux session prefix; defaults to agentroom for Herdr and room id for tmux",
  )
  .action(
    async (options: {
      room: string;
      name?: string;
      runtime: string;
      runtimeSession?: string;
    }) => {
      const dir = roomDir();
      await mkdir(join(dir, "agents"), { recursive: true });
      const appConfig = createDefaultAgentRoomConfig({
        roomId: options.room,
        ...(options.name !== undefined ? { roomName: options.name } : {}),
        defaultRuntime: parseConfiguredRuntime(options.runtime),
        ...(options.runtimeSession !== undefined
          ? { runtimeSession: options.runtimeSession }
          : {}),
      });

      await writeJson(join(dir, "room.json"), {
        roomId: options.room,
        roomName: options.name ?? options.room,
        createdAt: new Date().toISOString(),
      } satisfies RoomConfig);
      await writeAgentRoomConfig(process.cwd(), appConfig);

      await writeFile(
        join(dir, "policies.yaml"),
        `approvals:\n  required:\n    - action: github.merge_pr\n      approver: human\n    - action: deploy.production\n      approver: human\n`,
        "utf8",
      );

      await writeFile(
        join(dir, "agents", "lead.yaml"),
        `# Template only. Choose the harness and command for your stack before launching.\nid: lead\nrole: lead\nharness:\n  kind: custom\n  command: "AGENT_COMMAND"\npermissions:\n  - room:read_all\n  - task:assign\n  - human:escalate\n`,
        "utf8",
      );

      console.log(`Initialized AgentRoom room '${options.room}' in ${dir}`);
      console.log(`Configured runtime: ${appConfig.runtime.default}`);
    },
  );

program
  .command("whoami")
  .description("Print the current AgentRoom enrollment environment")
  .option("--json", "print JSON")
  .action(async (options: { json?: boolean }) => {
    const envAgentId = process.env.AGENTROOM_AGENT_ID;
    const resolvedAgentId = envAgentId ?? (await resolveAgentByPane());
    const source: "env" | "pane" | "none" = envAgentId
      ? "env"
      : resolvedAgentId
        ? "pane"
        : "none";
    const info = {
      enrolled: resolvedAgentId !== undefined,
      agentId: resolvedAgentId,
      roomId: process.env.AGENTROOM_ROOM_ID,
      role: process.env.AGENTROOM_ROLE,
      source,
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
  .option("--json", "print JSON")
  .action(async (options: MobileConnectOptions) => {
    const payload = await mobileConnectPayload(options);
    if (options.copy === true) {
      await copyToClipboard(payload.pairingLink);
    }
    outputMobileConnect(payload, options);
  });

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
  .description("Create a temporary empty room root for first-run TUI testing")
  .option("--run", "launch the TUI in the temporary room root")
  .option("--json", "print JSON")
  .action(async (options: { run?: boolean; json?: boolean }) => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-new-user-"));
    const bin = resolve(REPO_ROOT, "bin", "agent-room");
    const payload = {
      cwd,
      command: bin,
      setupCommand: "/setup",
    };
    if (options.json) {
      output(payload, true);
    } else {
      console.log("AgentRoom fresh-user setup sandbox");
      console.log(`Root: ${cwd}`);
      console.log("");
      console.log("Run:");
      console.log(`  cd ${cwd}`);
      console.log(`  ${bin}`);
      console.log("");
      console.log("Inside the TUI, run /setup.");
    }
    if (options.run === true) {
      await runChild(bin, [], cwd);
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
  .option("--message <pattern>", "regex against message body")
  .option(
    "--task-status <taskStatus>",
    "taskId:status, for example task_xxx:done",
  )
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
      taskStatus?: string;
      dmToMe?: boolean;
      timeout: number;
      since: string;
      json?: boolean;
    }) => {
      const service = await serviceForCwd();
      const matchers = await waitMatchers(options);
      if (matchers.length === 0) {
        throw new Error(
          "Choose at least one wait mode: --message, --task-status, or --dm-to-me",
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
          throw new Error(
            `Timed out waiting for matching event after ${options.timeout}s`,
          );
        await sleep(Math.min(1000, remaining));
      }
    },
  );

const task = program.command("task").description("Task commands");

task
  .command("create")
  .description(
    "Create a local task shadow, optionally linked to a Linear issue",
  )
  .argument("<title>", "task title")
  .option("-d, --description <description>", "task description")
  .option("-a, --assignee <agentId>", "agent id")
  .option(
    "--linear <issueId>",
    "existing Linear issue id or key to use as the tracker source",
  )
  .option("--linear-url <url>", "Linear issue URL")
  .option("--json", "print JSON")
  .action(
    async (
      title: string,
      options: {
        description?: string;
        assignee?: string;
        linear?: string;
        linearUrl?: string;
        json?: boolean;
      },
    ) => {
      const service = await serviceForCwd();
      const refs = options.linear
        ? [linearRef(options.linear, options.linearUrl)]
        : [];
      const created = await service.createTask({
        title,
        createdBy: await currentActor(),
        ...(options.description !== undefined
          ? { description: options.description }
          : {}),
        ...(options.assignee !== undefined
          ? { assignee: { kind: "agent" as const, id: options.assignee } }
          : {}),
        ...(refs.length > 0 ? { refs } : {}),
      });
      output(created, options.json);
    },
  );

task
  .command("list")
  .description("List local task shadows")
  .option("--json", "print JSON")
  .action(async (options: { json?: boolean }) => {
    const service = await serviceForCwd();
    const tasks = await service.listTasks();
    output(tasks, options.json);
  });

task
  .command("show")
  .description("Show one local task shadow")
  .argument("<taskId>", "task id")
  .option("--json", "print JSON")
  .action(async (taskId: string, options: { json?: boolean }) => {
    const service = await serviceForCwd();
    const task = await service.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    output(task, options.json);
  });

task
  .command("link-linear")
  .description("Link a local task shadow to a Linear issue")
  .argument("<taskId>", "local task id")
  .argument("<issueId>", "Linear issue id or key")
  .option("--url <url>", "Linear issue URL")
  .option("--json", "print JSON")
  .action(
    async (
      taskId: string,
      issueId: string,
      options: { url?: string; json?: boolean },
    ) => {
      const service = await serviceForCwd();
      const task = await service.linkTaskRef({
        taskId,
        ref: linearRef(issueId, options.url),
      });
      output(task, options.json);
    },
  );

task
  .command("comment")
  .description("Comment on the Linear issue linked to a local task")
  .argument("<taskId>", "local task id")
  .argument("<body>", "comment body")
  .option("--json", "print JSON")
  .action(async (taskId: string, body: string, options: { json?: boolean }) => {
    const service = await serviceForCwd();
    const task = await service.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const issueId = linearIssueIdForTask(task);
    if (!issueId) throw new Error(`Task has no Linear issue ref: ${taskId}`);
    const result = await commentOnLinearIssue(issueId, body, taskId, service);
    output(result, options.json);
  });

task
  .command("claim")
  .description("Claim a local task shadow")
  .argument("<taskId>", "task id")
  .option(
    "-a, --assignee <agentId>",
    "agent id; defaults to current enrolled agent or local user",
  )
  .option("--json", "print JSON")
  .action(
    async (taskId: string, options: { assignee?: string; json?: boolean }) => {
      const service = await serviceForCwd();
      const assignee = options.assignee
        ? { kind: "agent" as const, id: options.assignee }
        : await currentActor();
      const claimed = await service.claimTask({
        taskId,
        assignee,
      });
      output(claimed, options.json);
    },
  );

task
  .command("status")
  .description("Set a local task-shadow status")
  .argument("<taskId>", "task id")
  .argument("<status>", "task status")
  .option("-r, --reason <reason>", "reason for the status change")
  .option("-s, --summary <summary>", "completion or review summary")
  .option("--json", "print JSON")
  .action(
    async (
      taskId: string,
      status: string,
      options: { reason?: string; summary?: string; json?: boolean },
    ) => {
      const service = await serviceForCwd();
      const updated = await service.updateTaskStatus({
        taskId,
        status: parseTaskStatus(status),
        actor: await currentActor(),
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
        ...(options.summary !== undefined ? { summary: options.summary } : {}),
      });
      output(updated, options.json);
    },
  );

program
  .command("ask-human")
  .description("Create a human escalation question")
  .argument("<question>", "question for the human")
  .option("--task <taskId>", "related task id")
  .option("-p, --priority <priority>", "low|normal|high|urgent", "normal")
  .option("--json", "print JSON")
  .action(
    async (
      question: string,
      options: { task?: string; priority: string; json?: boolean },
    ) => {
      const service = await serviceForCwd();
      const escalation = await service.askHuman({
        question,
        from: await currentActor(),
        priority: parseImportance(options.priority),
        ...(options.task !== undefined ? { taskId: options.task } : {}),
      });
      output(escalation, options.json);
    },
  );

program
  .command("block")
  .description("Mark a local task shadow blocked and record the reason")
  .argument("<taskId>", "task id")
  .requiredOption("-r, --reason <reason>", "blocker reason")
  .option("--json", "print JSON")
  .action(
    async (taskId: string, options: { reason: string; json?: boolean }) => {
      const service = await serviceForCwd();
      const blocked = await service.blockTask({
        taskId,
        reason: options.reason,
        actor: await currentActor(),
      });
      output(blocked, options.json);
    },
  );

program
  .command("done")
  .description("Mark a local task shadow done")
  .argument("<taskId>", "task id")
  .option("-s, --summary <summary>", "completion summary")
  .option("--json", "print JSON")
  .action(
    async (taskId: string, options: { summary?: string; json?: boolean }) => {
      const service = await serviceForCwd();
      const done = await service.completeTask({
        taskId,
        actor: await currentActor(),
        ...(options.summary !== undefined ? { summary: options.summary } : {}),
      });
      output(done, options.json);
    },
  );

const tracker = program
  .command("tracker")
  .description("External work tracker commands");

tracker
  .command("health")
  .description(
    "Check the configured Linear bridge command for MCP/CLI/skill delegation",
  )
  .option("--json", "print JSON")
  .action(async (options: { json?: boolean }) => {
    const provider = new LinearWorkTrackerProvider();
    output(await provider.health(), options.json);
  });

tracker
  .command("comment")
  .description("Comment on a Linear issue through the configured bridge")
  .argument("<issueId>", "Linear issue id or key")
  .argument("<body>", "comment body")
  .option("--json", "print JSON")
  .action(
    async (issueId: string, body: string, options: { json?: boolean }) => {
      const service = await maybeServiceForCwd();
      const result = await commentOnLinearIssue(
        issueId,
        body,
        undefined,
        service,
      );
      output(result, options.json);
    },
  );

tracker
  .command("status")
  .description("Update a Linear issue status through the configured bridge")
  .argument("<issueId>", "Linear issue id or key")
  .argument("<status>", "tracker status name")
  .option("--json", "print JSON")
  .action(
    async (issueId: string, status: string, options: { json?: boolean }) => {
      const service = await maybeServiceForCwd();
      const result = await updateLinearIssueStatus(issueId, status, service);
      output(result, options.json);
    },
  );

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
  .description("Set the default runtime provider in .agentroom/config.yaml")
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
  .command("launch")
  .description("Launch an opted-in agent through a runtime provider")
  .argument("<agentId>", "agent id")
  .option(
    "--runtime <runtime>",
    "runtime provider; defaults to .agentroom/config.yaml",
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
  .option("--cwd <cwd>", "working directory", process.cwd())
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
        cwd: string;
        json?: boolean;
      },
    ) => {
      const { store, config } = await storeForCwd();
      const service = new AgentRoomService(store, { roomId: config.roomId });
      const role = parseAgentRole(options.role);
      const { provider } = await runtimeProviderForCwd(
        options.runtime,
        herdrLayoutOverride({
          ...(options.placement !== undefined
            ? { placement: options.placement }
            : {}),
          ...(options.workspace !== undefined
            ? { workspace: options.workspace }
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
        cwd: resolve(options.cwd),
      });
      await service.registerAgent({
        id: agentId,
        role,
        harness,
      });
      const agent = await provider.startAgent({
        agentId,
        roomId: config.roomId,
        role,
        harness,
        cwd: resolve(options.cwd),
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
    "runtime provider; defaults to .agentroom/config.yaml",
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

      const { store, config } = await storeForCwd();
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
        AGENTROOM: "1",
        AGENTROOM_AGENT_ID: agentId,
        AGENTROOM_ROOM_ID: config.roomId,
        AGENTROOM_ROLE: role,
      };

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
    "runtime provider; defaults to .agentroom/config.yaml",
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
    "runtime provider; defaults to .agentroom/config.yaml",
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
  .command("stop")
  .description("Stop a runtime-backed agent")
  .argument("<agentId>", "agent id")
  .option(
    "--runtime <runtime>",
    "runtime provider; defaults to bound runtime or .agentroom/config.yaml",
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
  process.exitCode = 1;
});

function normalizeRootArgv(argv: string[]): string[] {
  const [node, script, first, ...rest] = argv;
  if (node === undefined || script === undefined) return argv;
  if (first === undefined) return [node, script, "tui"];
  if (first === "--headless") return [node, script, "daemon", "start", ...rest];
  return argv;
}

async function runtimeProviderForCwd(
  runtimeName?: string,
  herdrLayout?: HerdrLayoutConfig,
): Promise<{
  name: string;
  provider: RuntimeProvider;
  config?: AgentRoomConfig;
}> {
  const config = await maybeLoadAgentRoomConfig();
  if (!config && runtimeName === undefined) {
    throw new Error(
      "No AgentRoom config found. Run 'agent-room init --runtime RUNTIME' or pass --runtime.",
    );
  }
  const name = config ? runtimeNameFor(config, runtimeName) : runtimeName;
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
      if (!daemonHealthMatchesCwd(health, process.cwd(), existing)) {
        throw new Error(daemonCwdMismatchMessage(health, process.cwd()));
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
    if (!daemonHealthMatchesCwd(occupied, process.cwd())) {
      throw new Error(daemonCwdMismatchMessage(occupied, process.cwd()));
    }
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
    if (!daemonHealthMatchesCwd(health, process.cwd(), record)) {
      throw new Error(daemonCwdMismatchMessage(health, process.cwd()));
    }
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

function daemonHealthCwd(health?: DaemonHealthCheck): string | undefined {
  if (!health?.body || typeof health.body !== "object") return undefined;
  const cwd = (health.body as { cwd?: unknown }).cwd;
  return typeof cwd === "string" ? cwd : undefined;
}

function daemonHealthMatchesCwd(
  health: DaemonHealthCheck,
  cwd: string,
  record?: DaemonPidRecord,
): boolean {
  const healthCwd = daemonHealthCwd(health);
  if (healthCwd !== undefined) return samePath(healthCwd, cwd);
  return record !== undefined && samePath(record.cwd, cwd);
}

function daemonCwdMismatchMessage(
  health: DaemonHealthCheck,
  expectedCwd: string,
): string {
  const actualCwd = daemonHealthCwd(health) ?? "an unknown cwd";
  return `AgentRoom daemon at ${health.url} belongs to ${actualCwd}, not ${expectedCwd}`;
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
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
  const cwd = process.cwd();
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
        if (!daemonHealthMatchesCwd(recordHealth, cwd, record)) {
          throw new Error(daemonCwdMismatchMessage(recordHealth, cwd));
        }
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
    if (daemonHealthMatchesCwd(health, cwd)) {
      return { daemonUrl: options.daemonUrl };
    }

    if (!options.autoStart || !isLoopbackHost(host)) {
      throw new Error(daemonCwdMismatchMessage(health, cwd));
    }

    const freePort = await findFreePort(host);
    console.error(
      `${daemonCwdMismatchMessage(health, cwd)}; starting this TUI room at ${daemonBaseUrl(host, freePort)} instead.`,
    );
    return startTuiOwnedDaemon({
      host,
      port: freePort,
      ...(options.apiToken !== undefined ? { apiToken: options.apiToken } : {}),
    });
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

async function findFreePort(host: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address() as AddressInfo;
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolvePromise(port);
      });
    });
  });
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
      `Audited runtime access requires an initialized AgentRoom. Run 'agent-room init --runtime RUNTIME' first, or pass --unaudited for manual recovery. ${reason}`,
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
  const appConfig = await maybeLoadAgentRoomConfig();
  if (appConfig) {
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

  const path = join(roomDir(), "room.json");
  try {
    return {
      room: JSON.parse(await readFile(path, "utf8")) as RoomConfig,
      eventLogPath: join(roomDir(), "events.jsonl"),
    };
  } catch (error) {
    throw new Error(
      `No AgentRoom found. Run 'agent-room init --runtime RUNTIME' first. Missing ${path}`,
    );
  }
}

async function loadAgentRoomConfigForCwd(): Promise<AgentRoomConfig> {
  try {
    return await loadAgentRoomConfig();
  } catch (error) {
    throw new Error(
      `No AgentRoom config found. Run 'agent-room init --runtime RUNTIME' first. Missing ${agentRoomConfigPath()}`,
    );
  }
}

function roomDir(): string {
  return join(process.cwd(), ".agentroom");
}

async function currentActor(): Promise<ActorRef> {
  if (process.env.AGENTROOM === "1" && process.env.AGENTROOM_AGENT_ID) {
    return { kind: "agent" as const, id: process.env.AGENTROOM_AGENT_ID };
  }
  const resolved = await resolveAgentByPane();
  if (resolved) {
    return { kind: "agent" as const, id: resolved };
  }
  return { kind: "human" as const, id: process.env.USER ?? "local" };
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
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

async function waitMatchers(options: {
  message?: string;
  taskStatus?: string;
  dmToMe?: boolean;
}): Promise<EventMatcher[]> {
  const matchers: EventMatcher[] = [];

  if (options.message !== undefined) {
    const pattern = new RegExp(options.message);
    matchers.push(
      (event) =>
        event.type === "message.posted" &&
        pattern.test(event.payload.message.body),
    );
  }

  if (options.taskStatus !== undefined) {
    const taskStatus = parseTaskStatusMatcher(options.taskStatus);
    matchers.push(
      (event) =>
        event.type === "task.status_changed" &&
        event.payload.taskId === taskStatus.taskId &&
        event.payload.status === taskStatus.status,
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
        (event.payload.message.recipients ?? []).some(
          (recipient) => recipient.kind === "agent" && recipient.id === agentId,
        ),
    );
  }

  return matchers;
}

function parseTaskStatusMatcher(value: string): {
  taskId: string;
  status: TaskStatus;
} {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(
      `Invalid --task-status '${value}'. Expected taskId:status.`,
    );
  }

  return {
    taskId: value.slice(0, separator),
    status: parseTaskStatus(value.slice(separator + 1)),
  };
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

function parseTaskStatus(value: string): TaskStatus {
  const result = taskStatusSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid task status: ${value}`);
  return result.data;
}

function parseAgentRole(value: string): AgentRole {
  const result = agentRoleSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid agent role: ${value}`);
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

function linearRef(issueId: string, url?: string): Ref {
  return {
    kind: "linear-issue",
    id: issueId,
    label: issueId,
    ...(url !== undefined ? { url } : {}),
  };
}

function linearIssueIdForTask(task: { refs?: Ref[] }): string | undefined {
  return task.refs?.find((ref) => ref.kind === "linear-issue")?.id;
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

function stopTargetFor(
  provider: RuntimeProvider,
  agentId: string,
  binding?: RuntimeBinding,
): string {
  if (provider.kind === "herdr" && binding?.providerId === provider.id)
    return binding.bindingId;
  return agentId;
}

async function commentOnLinearIssue(
  issueId: string,
  body: string,
  taskId: string | undefined,
  service: AgentRoomService | undefined,
): Promise<{
  ok: boolean;
  issueId: string;
  action: string;
  code?: string;
  reason?: string;
}> {
  const provider = new LinearWorkTrackerProvider();
  try {
    await provider.comment(issueId, body, await currentActor());
    await service?.recordLinearIssueEvent({
      issueId,
      action: "commented",
      body,
      ...(taskId !== undefined ? { taskId } : {}),
    });
    return { ok: true, issueId, action: "commented" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await service?.recordLinearIssueEvent({
      issueId,
      action: "tracker_update_skipped",
      body,
      reason,
      ...(taskId !== undefined ? { taskId } : {}),
    });
    return {
      ok: false,
      issueId,
      action: "commented",
      code: "tracker_update_skipped",
      reason,
    };
  }
}

async function updateLinearIssueStatus(
  issueId: string,
  status: string,
  service: AgentRoomService | undefined,
): Promise<{
  ok: boolean;
  issueId: string;
  action: string;
  code?: string;
  reason?: string;
}> {
  const provider = new LinearWorkTrackerProvider();
  try {
    await provider.updateIssueStatus(issueId, status);
    await service?.recordLinearIssueEvent({
      issueId,
      action: "status_updated",
      status,
    });
    return { ok: true, issueId, action: "status_updated" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await service?.recordLinearIssueEvent({
      issueId,
      action: "tracker_update_skipped",
      status,
      reason,
    });
    return {
      ok: false,
      issueId,
      action: "status_updated",
      code: "tracker_update_skipped",
      reason,
    };
  }
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

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "default";
}

function parseConfiguredRuntime(value: string): "fake" | "herdr" | "tmux" {
  if (value === "fake" || value === "herdr" || value === "tmux") return value;
  throw new Error(`Invalid runtime '${value}'. Expected fake, herdr, or tmux.`);
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
