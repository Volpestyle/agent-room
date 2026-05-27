import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const agentRoomBin = fileURLToPath(
  new URL("../../../bin/agent-room", import.meta.url),
);

describe("agent-room init", () => {
  it("requires an explicit runtime provider choice", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-init-runtime-"));
    const env = testEnv("cli-init-runtime-test");

    try {
      await expectAgentRoomFailure(
        cwd,
        ["init", "--room", "cli-init-runtime-test"],
        env,
        "required option '--runtime <runtime>' not specified",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("can write portable Clanky and work tracker defaults", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-init-clanky-"));
    const env = testEnv("cli-init-clanky-test");

    try {
      await execAgentRoom(
        cwd,
        [
          "init",
          "--room",
          "cli-init-clanky-test",
          "--runtime",
          "fake",
          "--work-tracker",
          "linear",
          "--linear-team",
          "team_123",
          "--clanky",
          "--clanky-profile",
          "lead",
          "--clanky-chat-owner",
          "room",
        ],
        env,
      );

      const config = await readFile(
        join(cwd, ".agentroom", "config.yaml"),
        "utf8",
      );
      expect(config).toContain("workTracker:");
      expect(config).toContain("default: linear");
      expect(config).toContain("teamId: team_123");
      expect(config).toContain("clanky:");
      expect(config).toContain("profile: lead");
      expect(config).toContain("chatGatewayOwner: room");
      expect(config).toContain("kind: clanky");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("writes a configured runtime CLI command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-init-runtime-cli-"));
    const env = testEnv("cli-init-runtime-cli-test");

    try {
      await execAgentRoom(
        cwd,
        [
          "init",
          "--room",
          "cli-init-runtime-cli-test",
          "--runtime",
          "herdr",
          "--runtime-session",
          "agent-room",
          "--runtime-cli",
          "herdr-dev",
        ],
        env,
      );

      const config = await readFile(
        join(cwd, ".agentroom", "config.yaml"),
        "utf8",
      );
      expect(config).toContain("default: herdr");
      expect(config).toContain("session: agent-room");
      expect(config).toContain("cli: herdr-dev");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("defaults the room id to the runtime session when omitted", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-init-session-room-"));
    const env = {
      ...process.env,
      HERDR_SESSION: "dev-room",
      AGENTROOM_ROOM_ID: undefined,
    } as NodeJS.ProcessEnv;

    try {
      await execAgentRoom(
        cwd,
        ["init", "--runtime", "herdr", "--runtime-cli", "herdr-dev"],
        env,
      );

      const config = await readFile(
        join(cwd, ".agentroom", "config.yaml"),
        "utf8",
      );
      const room = await readFile(join(cwd, ".agentroom", "room.json"), "utf8");
      expect(config).toContain("id: dev-room");
      expect(config).toContain("session: dev-room");
      expect(config).toContain("cli: herdr-dev");
      expect(room).toContain('"roomId": "dev-room"');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("agent-room wait", () => {
  it("waits for a matching message event and emits JSON", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-wait-"));
    const env = {
      ...process.env,
      AGENTROOM: "1",
      AGENTROOM_AGENT_ID: "waiter",
      AGENTROOM_ROOM_ID: "cli-wait-test",
    };
    const body = `hello wait ${Date.now()}`;
    let waiting: ChildProcessWithoutNullStreams | undefined;

    try {
      await execAgentRoom(
        cwd,
        ["init", "--room", "cli-wait-test", "--runtime", "fake"],
        env,
      );

      waiting = spawn(
        agentRoomBin,
        [
          "wait",
          "--message",
          body,
          "--timeout",
          "5",
          "--since",
          "1970-01-01T00:00:00.000Z",
          "--json",
        ],
        { cwd, env },
      );

      let stdout = "";
      let stderr = "";
      waiting.stdout.setEncoding("utf8");
      waiting.stderr.setEncoding("utf8");
      waiting.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      waiting.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      const exit = waitForExit(waiting, 7000);
      await sleep(200);
      await execAgentRoom(
        cwd,
        ["post", body, "--channel", "implementation"],
        env,
      );

      await expect(exit).resolves.toMatchObject({ code: 0 });
      const event = JSON.parse(stdout) as {
        type: string;
        payload: { message: { body: string } };
      };
      expect(stderr).toBe("");
      expect(event.type).toBe("message.posted");
      expect(event.payload.message.body).toBe(body);
    } finally {
      if (waiting && waiting.exitCode === null) waiting.kill();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("agent-room events --follow", () => {
  it("streams new room events as newline-delimited JSON", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-events-follow-"));
    const env = testEnv("cli-events-follow-test");
    const body = `follow event ${Date.now()}`;
    let following: ChildProcessWithoutNullStreams | undefined;

    try {
      await execAgentRoom(
        cwd,
        ["init", "--room", "cli-events-follow-test", "--runtime", "fake"],
        env,
      );

      following = spawn(
        agentRoomBin,
        [
          "events",
          "--follow",
          "--json",
          "--limit",
          "0",
          "--poll-interval",
          "50",
        ],
        { cwd, env },
      );
      const line = waitForStdoutLine(following, 5000);

      await sleep(100);
      await execAgentRoom(
        cwd,
        ["post", body, "--channel", "implementation"],
        env,
      );

      const event = JSON.parse(await line) as {
        type: string;
        payload: { message: { body: string } };
      };
      expect(event.type).toBe("message.posted");
      expect(event.payload.message.body).toBe(body);
    } finally {
      if (following && following.exitCode === null) following.kill();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("agent-room task show", () => {
  it("shows a single local task shadow by id", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-task-show-"));
    const env = testEnv("cli-task-show-test");

    try {
      await execAgentRoom(
        cwd,
        ["init", "--room", "cli-task-show-test", "--runtime", "fake"],
        env,
      );
      const created = JSON.parse(
        (
          await execAgentRoom(
            cwd,
            ["task", "create", "Implement show", "--json"],
            env,
          )
        ).stdout,
      ) as { id: string };
      const shown = JSON.parse(
        (await execAgentRoom(cwd, ["task", "show", created.id, "--json"], env))
          .stdout,
      ) as { id: string; title: string };

      expect(shown).toMatchObject({
        id: created.id,
        title: "Implement show",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("agent-room runtime command safety", () => {
  it("requires an initialized room and runtime binding before audited reads", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-runtime-safety-"));
    const env = testEnv("cli-runtime-safety-test");

    try {
      await expectAgentRoomFailure(
        cwd,
        ["read", "impl", "--runtime", "fake"],
        env,
        "Audited runtime access requires an initialized AgentRoom",
      );
      await execAgentRoom(
        cwd,
        ["init", "--room", "cli-runtime-safety-test", "--runtime", "fake"],
        env,
      );
      await expectAgentRoomFailure(
        cwd,
        ["read", "impl", "--runtime", "fake"],
        env,
        "No runtime binding found for agent 'impl'",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects unknown launch roles and harness kinds before starting a runtime", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-launch-parse-"));
    const env = testEnv("cli-launch-parse-test");

    try {
      await execAgentRoom(
        cwd,
        ["init", "--room", "cli-launch-parse-test", "--runtime", "fake"],
        env,
      );
      await expectAgentRoomFailure(
        cwd,
        [
          "launch",
          "impl",
          "--role",
          "boss",
          "--harness",
          "shell",
          "--command",
          "bash",
          "--runtime",
          "fake",
        ],
        env,
        "Invalid agent role: boss",
      );
      await expectAgentRoomFailure(
        cwd,
        [
          "launch",
          "impl",
          "--harness",
          "unknown",
          "--command",
          "bash",
          "--runtime",
          "fake",
        ],
        env,
        "Invalid harness kind: unknown",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps pi harness commands external to AgentRoom", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-launch-pi-"));
    const env = testEnv("cli-launch-pi-test");

    try {
      await execAgentRoom(
        cwd,
        ["init", "--room", "cli-launch-pi-test", "--runtime", "fake"],
        env,
      );
      const launched = JSON.parse(
        (
          await execAgentRoom(
            cwd,
            [
              "launch",
              "clanky",
              "--harness",
              "pi",
              "--command",
              "clanky",
              "--runtime",
              "fake",
              "--json",
            ],
            env,
          )
        ).stdout,
      ) as {
        metadata?: {
          harness?: {
            command?: string;
            args?: string[];
            kind?: string;
          };
        };
      };

      expect(launched.metadata?.harness).toEqual(
        expect.objectContaining({
          kind: "pi",
          command: "clanky",
        }),
      );
      expect(launched.metadata?.harness?.args).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("agent-room enroll", () => {
  it("adopts the current pane, binds it, and is idempotent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-enroll-"));
    const env = {
      ...process.env,
      HERDR_SESSION: "agent-room",
      HERDR_PANE_ID: "p_77",
      AGENTROOM_AGENT_ID: undefined,
      AGENTROOM_ROOM_ID: undefined,
      AGENTROOM_ROLE: undefined,
      AGENTROOM: undefined,
    } as NodeJS.ProcessEnv;

    try {
      await execAgentRoom(
        cwd,
        ["init", "--room", "cli-enroll-test", "--runtime", "fake"],
        env,
      );

      const first = JSON.parse(
        (await execAgentRoom(cwd, ["enroll", "--json"], env)).stdout,
      ) as {
        enrolled: boolean;
        agentId: string;
        roomId: string;
        role: string;
        bindingId: string;
        alreadyBound: boolean;
      };

      expect(first).toMatchObject({
        enrolled: true,
        agentId: "herdr:agent-room:p_77",
        roomId: "cli-enroll-test",
        role: "implementer",
        bindingId: "p_77",
        alreadyBound: false,
      });

      const second = JSON.parse(
        (await execAgentRoom(cwd, ["enroll", "--json"], env)).stdout,
      ) as { alreadyBound: boolean; agentId: string };

      expect(second).toMatchObject({
        alreadyBound: true,
        agentId: "herdr:agent-room:p_77",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("emits eval-able shell exports under --shell", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-enroll-shell-"));
    const env = {
      ...process.env,
      HERDR_SESSION: "agent-room",
      HERDR_PANE_ID: "p_88",
      AGENTROOM_AGENT_ID: undefined,
      AGENTROOM_ROOM_ID: undefined,
      AGENTROOM_ROLE: undefined,
      AGENTROOM: undefined,
    } as NodeJS.ProcessEnv;

    try {
      await execAgentRoom(
        cwd,
        ["init", "--room", "cli-enroll-shell", "--runtime", "fake"],
        env,
      );
      const { stdout } = await execAgentRoom(cwd, ["enroll", "--shell"], env);
      expect(stdout).toContain("export AGENTROOM='1'");
      expect(stdout).toContain(
        "export AGENTROOM_AGENT_ID='herdr:agent-room:p_88'",
      );
      expect(stdout).toContain("export AGENTROOM_ROOM_ID='cli-enroll-shell'");
      expect(stdout).toContain("export AGENTROOM_ROLE='implementer'");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("whoami resolves identity by pane id after enrolling", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-whoami-pane-"));
    const enrollEnv = {
      ...process.env,
      HERDR_SESSION: "agent-room",
      HERDR_PANE_ID: "p_111",
      AGENTROOM: undefined,
      AGENTROOM_AGENT_ID: undefined,
      AGENTROOM_ROOM_ID: undefined,
      AGENTROOM_ROLE: undefined,
    } as NodeJS.ProcessEnv;

    try {
      await execAgentRoom(
        cwd,
        ["init", "--room", "cli-whoami-pane", "--runtime", "fake"],
        enrollEnv,
      );
      await execAgentRoom(cwd, ["enroll", "--json"], enrollEnv);

      const whoamiEnv = {
        ...process.env,
        HERDR_PANE_ID: "p_111",
        AGENTROOM: undefined,
        AGENTROOM_AGENT_ID: undefined,
        AGENTROOM_ROOM_ID: undefined,
        AGENTROOM_ROLE: undefined,
      } as NodeJS.ProcessEnv;

      const whoami = JSON.parse(
        (await execAgentRoom(cwd, ["whoami", "--json"], whoamiEnv)).stdout,
      ) as {
        enrolled: boolean;
        agentId: string;
        source: string;
      };

      expect(whoami).toMatchObject({
        enrolled: true,
        agentId: "herdr:agent-room:p_111",
        source: "pane",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails when no pane id is available", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-enroll-fail-"));
    const env = {
      ...process.env,
      HERDR_PANE_ID: undefined,
      HERDR_SESSION: undefined,
      AGENTROOM: undefined,
    } as NodeJS.ProcessEnv;

    try {
      await execAgentRoom(
        cwd,
        ["init", "--room", "cli-enroll-fail", "--runtime", "fake"],
        env,
      );
      await expectAgentRoomFailure(
        cwd,
        ["enroll", "--json"],
        env,
        "pass --pane-id or run inside a Herdr pane",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("agent-room daemon lifecycle", () => {
  it("starts, reports, and stops a managed background daemon", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-daemon-"));
    const port = await freePort();
    const env = {
      ...testEnv("cli-daemon-lifecycle-test"),
      AGENTROOM_ROLE: "lead",
    };

    try {
      const start = JSON.parse(
        (
          await execAgentRoom(
            cwd,
            ["daemon", "start", "--port", String(port), "--json"],
            env,
          )
        ).stdout,
      ) as { state: string; pid: number };
      expect(start.state).toBe("running");
      expect(start.pid).toEqual(expect.any(Number));

      const status = await waitForDaemonStatus(cwd, port, env, start.pid);
      expect(status).toMatchObject({
        state: "running",
        pid: start.pid,
      });

      const stop = JSON.parse(
        (
          await execAgentRoom(
            cwd,
            ["daemon", "stop", "--port", String(port), "--json"],
            env,
          )
        ).stdout,
      ) as { state: string; pid: number };
      expect(stop).toMatchObject({
        state: "stopped",
        pid: start.pid,
      });

      const stopped = JSON.parse(
        (
          await execAgentRoom(
            cwd,
            ["daemon", "status", "--port", String(port), "--json"],
            env,
          )
        ).stdout,
      ) as { state: string };
      expect(stopped.state).toBe("stopped");
    } finally {
      await execAgentRoom(
        cwd,
        ["daemon", "stop", "--port", String(port), "--json"],
        env,
      ).catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("prints concise daemon lifecycle output by default", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-daemon-human-"));
    const port = await freePort();
    const env = {
      ...testEnv("cli-daemon-human-test"),
      AGENTROOM_ROLE: "lead",
    };

    try {
      const start = await execAgentRoom(
        cwd,
        ["daemon", "start", "--port", String(port)],
        env,
      );
      expect(start.stdout).toContain(
        `AgentRoom daemon running at http://127.0.0.1:${port}`,
      );
      expect(start.stdout).toContain("Log:");
      expect(start.stdout).not.toContain('"runtimes"');

      const status = await execAgentRoom(
        cwd,
        ["daemon", "status", "--port", String(port)],
        env,
      );
      expect(status.stdout).toContain(
        `AgentRoom daemon running at http://127.0.0.1:${port}`,
      );
      expect(status.stdout).not.toContain('"capabilities"');

      const stop = await execAgentRoom(
        cwd,
        ["daemon", "stop", "--port", String(port)],
        env,
      );
      expect(stop.stdout).toContain(
        `AgentRoom daemon stopped at http://127.0.0.1:${port}`,
      );
      expect(stop.stdout).not.toContain('"health"');
    } finally {
      await execAgentRoom(
        cwd,
        ["daemon", "stop", "--port", String(port), "--json"],
        env,
      ).catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("starts the current room daemon with top-level --headless", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-headless-"));
    const port = await freePort();
    const env = {
      ...testEnv("cli-headless-test"),
      AGENTROOM_ROLE: "lead",
    };

    try {
      const expectedCwd = await realpath(cwd);
      const start = JSON.parse(
        (
          await execAgentRoom(
            cwd,
            ["--headless", "--port", String(port), "--json"],
            env,
          )
        ).stdout,
      ) as { state: string; health?: { body?: { cwd?: string } } };
      expect(start.state).toBe("running");
      expect(start.health?.body?.cwd).toBe(expectedCwd);
    } finally {
      await execAgentRoom(
        cwd,
        ["daemon", "stop", "--port", String(port), "--json"],
        env,
      ).catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not adopt a daemon that belongs to a different cwd", async () => {
    const firstCwd = await mkdtemp(join(tmpdir(), "agentroom-headless-a-"));
    const secondCwd = await mkdtemp(join(tmpdir(), "agentroom-headless-b-"));
    const port = await freePort();
    const env = {
      ...testEnv("cli-headless-cwd-test"),
      AGENTROOM_ROLE: "lead",
    };

    try {
      const expectedFirstCwd = await realpath(firstCwd);
      const expectedSecondCwd = await realpath(secondCwd);
      await execAgentRoom(
        firstCwd,
        ["--headless", "--port", String(port), "--json"],
        env,
      );

      await expectAgentRoomFailure(
        secondCwd,
        ["--headless", "--port", String(port), "--json"],
        env,
        `belongs to ${expectedFirstCwd}, not ${expectedSecondCwd}`,
      );
    } finally {
      await execAgentRoom(
        firstCwd,
        ["daemon", "stop", "--port", String(port), "--json"],
        env,
      ).catch(() => undefined);
      await rm(firstCwd, { recursive: true, force: true });
      await rm(secondCwd, { recursive: true, force: true });
    }
  });

  it("rejects daemon lifecycle mutations from ordinary enrolled agents", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentroom-daemon-auth-"));
    const env = {
      ...testEnv("cli-daemon-auth-test"),
      AGENTROOM_ROLE: "implementer",
    };

    try {
      await expectAgentRoomFailure(
        cwd,
        ["daemon", "stop"],
        env,
        "requires a human operator, gateway agent, or lead agent",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

async function execAgentRoom(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(agentRoomBin, args, {
    cwd,
    env,
    encoding: "utf8",
  });
  return { stdout, stderr };
}

async function expectAgentRoomFailure(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  expected: string,
): Promise<void> {
  try {
    await execAgentRoom(cwd, args, env);
  } catch (error) {
    const output = outputForError(error);
    expect(output).toContain(expected);
    return;
  }

  throw new Error(`Expected agent-room ${args.join(" ")} to fail`);
}

async function waitForDaemonStatus(
  cwd: string,
  port: number,
  env: NodeJS.ProcessEnv,
  expectedPid: number,
): Promise<{ state: string; pid: number }> {
  const deadline = Date.now() + 5000;
  let last: { state: string; pid: number } | undefined;

  while (Date.now() <= deadline) {
    last = JSON.parse(
      (
        await execAgentRoom(
          cwd,
          ["daemon", "status", "--port", String(port), "--json"],
          env,
        )
      ).stdout,
    ) as { state: string; pid: number };
    if (last.state === "running" && last.pid === expectedPid) return last;
    await sleep(100);
  }

  throw new Error(
    `Timed out waiting for daemon status running; last=${JSON.stringify(last)}`,
  );
}

function outputForError(error: unknown): string {
  if (error && typeof error === "object") {
    const maybeOutput = error as {
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    return [maybeOutput.stdout, maybeOutput.stderr, maybeOutput.message]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
  }
  return String(error);
}

function testEnv(roomId: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENTROOM: "1",
    AGENTROOM_AGENT_ID: "waiter",
    AGENTROOM_ROOM_ID: roomId,
  };
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(`Timed out waiting for child process after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function waitForStdoutLine(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      reject(
        new Error(`Timed out waiting for stdout line after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onStdout = (chunk: Buffer | string) => {
      stdout += String(chunk);
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        cleanup();
        resolve(line);
      }
    };
    const onStderr = (chunk: Buffer | string) => {
      stderr += String(chunk);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Process exited before stdout line: code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
        ),
      );
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a test port")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}
