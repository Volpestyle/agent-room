import type { ActorRef } from "../types.js";

export function dashboardAgentId(): string {
  return (
    process.env.AGENTROOM_TUI_OPERATOR_ID?.trim() ||
    process.env.AGENTROOM_DASHBOARD_AGENT_ID?.trim() ||
    "dashboard"
  );
}

export function dashboardActor(): ActorRef {
  return {
    kind: "agent",
    id: dashboardAgentId(),
    displayName: "Dashboard",
  };
}

export function announcerAgentId(): string {
  return (
    process.env.AGENTROOM_TUI_ANNOUNCER_ID?.trim() ||
    `${dashboardAgentId()}-announcer`
  );
}

export function announcerActor(): ActorRef {
  return {
    kind: "agent",
    id: announcerAgentId(),
    displayName: "Announcer",
  };
}

export function humanActor(): ActorRef {
  return {
    kind: "human",
    id: process.env.USER ?? "human",
  };
}
