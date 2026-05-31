import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Whether the daemon URL points at this machine. Restarting only makes sense for
 * a local daemon — a remote/tailnet daemon must be managed where it runs.
 */
export function isLocalDaemon(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

/** Locate the bundled agent-room CLI relative to this module (apps/tui/src). */
function resolveAgentRoomBin(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "../../../bin/agent-room");
  return existsSync(candidate) ? candidate : undefined;
}

export interface RestartResult {
  ok: boolean;
  message: string;
}

/**
 * Restart the local daemon via `agent-room daemon restart`. Resolves when the
 * CLI exits (it spawns the daemon detached and writes the pid file before
 * returning), so the poller's next tick will observe the daemon back online.
 */
export function restartLocalDaemon(baseUrl: string): Promise<RestartResult> {
  return new Promise<RestartResult>((resolveResult) => {
    const bin = resolveAgentRoomBin();
    if (!bin) {
      resolveResult({
        ok: false,
        message: "agent-room CLI not found; run `agent-room daemon start` manually",
      });
      return;
    }

    const url = new URL(baseUrl);
    const args = ["daemon", "restart", "--json", "--host", url.hostname];
    if (url.port) args.push("--port", url.port);

    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolveResult({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolveResult({ ok: true, message: "daemon restarted" });
        return;
      }
      const detail =
        (stderr.trim() || stdout.trim()).split("\n").pop() ?? `exit code ${code}`;
      resolveResult({ ok: false, message: detail });
    });
  });
}
