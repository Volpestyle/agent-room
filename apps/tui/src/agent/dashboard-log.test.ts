import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import {
  DashboardAgentLogger,
  logRecordForAgentEvent,
} from "./dashboard-log.js";

const agent = {
  agentId: "dashboard",
  roomId: "room",
  cwd: "/repo",
  provider: "openai-codex" as const,
  modelId: "gpt-5.5",
  modelSource: "stored-oauth",
  requestedThinkingLevel: "medium",
  thinkingLevel: "medium",
};

describe("DashboardAgentLogger", () => {
  it("writes searchable JSONL and redacts credential-shaped fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentroom-dashboard-log-"));
    const path = join(dir, "dashboard-agent.log");
    const logger = await DashboardAgentLogger.create({
      path,
      roomId: "room",
      cwd: "/repo",
    });

    logger.recordAgentEvent(
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "call_mcp_tool",
        args: {
          server: "linear",
          token: "secret-token",
          nested: { apiKey: "secret-key", safe: "visible" },
        },
      },
      agent,
    );
    await logger.flush();

    const text = await readFile(path, "utf8");
    expect(text).toContain("tool_execution_start");
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("secret-key");
    expect(text).toContain("visible");
  });

  it("loads recent entries from an existing log file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentroom-dashboard-log-"));
    const path = join(dir, "dashboard-agent.log");
    const first = await DashboardAgentLogger.create({
      path,
      roomId: "room",
      cwd: "/repo",
    });
    first.record("error", "model_error", "provider failed", {
      error: { message: "boom" },
    });
    await first.flush();

    const second = await DashboardAgentLogger.create({
      path,
      roomId: "room",
      cwd: "/repo",
    });

    expect(
      second.recentEntries().some((entry) => entry.event === "model_error"),
    ).toBe(true);
  });
});

describe("logRecordForAgentEvent", () => {
  it("marks failed tool executions as errors with full result details", () => {
    const event = {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read_runtime_agent",
      result: { content: [{ type: "text", text: "failed" }] },
      isError: true,
    } as AgentEvent;

    const record = logRecordForAgentEvent(event);

    expect(record.level).toBe("error");
    expect(record.summary).toBe("tool read_runtime_agent failed");
    expect(JSON.stringify(record.details)).toContain("failed");
  });
});
