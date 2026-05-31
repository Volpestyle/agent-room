import { describe, expect, it } from "vitest";
import type { Message } from "./types.js";
import {
  containsWakeName,
  formatAutoReplyConversationHistory,
  resolveDashboardWakeNames,
  shouldAutoReplyToConnectorMessage,
} from "./dashboard-autoreply.js";

describe("dashboard Discord auto-reply wake matching", () => {
  it("matches the AgentRoom bot name as one word or two words", () => {
    expect(
      containsWakeName("hey AgentRoom, are you there?", ["Agent Room"]),
    ).toBe(true);
    expect(
      containsWakeName("hey agent room, are you there?", ["AgentRoom"]),
    ).toBe(true);
  });

  it("ignores unaddressed connector chatter", () => {
    expect(containsWakeName("general room status update", ["AgentRoom"])).toBe(
      false,
    );
  });

  it("only auto-replies to fresh connector chat or question messages", () => {
    const fresh = message({
      sender: { kind: "connector", id: "discord-main:u-1" },
      body: "AgentRoom hi",
      kind: "chat",
      createdAt: "2026-05-31T22:10:00.000Z",
    });
    expect(
      shouldAutoReplyToConnectorMessage(fresh, {
        wakeNames: ["AgentRoom"],
        startedAtMs: Date.parse("2026-05-31T22:09:59.000Z"),
      }),
    ).toBe(true);

    expect(
      shouldAutoReplyToConnectorMessage(
        message({
          sender: { kind: "agent", id: "dashboard" },
          body: "AgentRoom hi",
        }),
        { wakeNames: ["AgentRoom"] },
      ),
    ).toBe(false);
    expect(
      shouldAutoReplyToConnectorMessage(
        message({
          sender: { kind: "connector", id: "discord-main:u-1" },
          body: "AgentRoom hi",
          createdAt: "2026-05-31T22:09:58.000Z",
        }),
        {
          wakeNames: ["AgentRoom"],
          startedAtMs: Date.parse("2026-05-31T22:09:59.000Z"),
        },
      ),
    ).toBe(false);
  });

  it("adds configured dashboard ids and env wake names", () => {
    expect(
      resolveDashboardWakeNames({
        dashboardId: "ops-bot",
        displayName: "Ops Bot",
        env: {
          AGENTROOM_DASHBOARD_WAKE_NAMES: "roomie; agent-room",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual([
      "AgentRoom",
      "Agent Room",
      "dashboard",
      "ops-bot",
      "Ops Bot",
      "roomie",
      "agent-room",
    ]);
  });

  it("formats only the matching room channel/thread history", () => {
    const newest = message({
      id: "msg-4",
      channelId: "announcements",
      body: "AgentRoom what next?",
      createdAt: "2026-05-31T22:03:00.000Z",
    });

    expect(
      formatAutoReplyConversationHistory({
        message: newest,
        messages: [
          message({
            id: "msg-1",
            sender: {
              kind: "connector",
              id: "discord-main:u-1",
              displayName: "James",
            },
            channelId: "announcements",
            body: "AgentRoom hi",
            createdAt: "2026-05-31T22:00:00.000Z",
          }),
          message({
            id: "msg-2",
            sender: {
              kind: "agent",
              id: "dashboard",
              displayName: "Dashboard",
            },
            channelId: "announcements",
            body: "Hi James.",
            createdAt: "2026-05-31T22:01:00.000Z",
          }),
          message({
            id: "msg-3",
            channelId: "implementation",
            body: "unrelated channel",
            createdAt: "2026-05-31T22:02:00.000Z",
          }),
          newest,
        ],
      }),
    ).toBe("- James: AgentRoom hi\n- Dashboard: Hi James.");
  });
});

function message(overrides: Partial<Message>): Message {
  return {
    id: "msg-1",
    roomId: "agent-room",
    channelId: "announcements",
    sender: { kind: "connector", id: "discord-main:u-1" },
    kind: "chat",
    body: "AgentRoom hi",
    importance: "normal",
    createdAt: "2026-05-31T22:10:00.000Z",
    ...overrides,
  };
}
