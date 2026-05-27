import type { Agent as RoomAgent, RuntimeAgent } from "./types.js";

export interface RuntimeAgentSnapshotLike {
  providerId: string;
  agent: RuntimeAgent;
}

export function runtimeAgentLabel(agent: RuntimeAgent): string | undefined {
  const metadataLabel = stringValue(agent.metadata?.["agent"]);
  if (metadataLabel) return metadataLabel;

  const displayName = stringValue(agent.displayName);
  if (
    displayName &&
    displayName !== agent.id &&
    displayName !== agent.bindingId
  ) {
    return displayName;
  }

  return undefined;
}

export function runtimeAgentForRoomAgent(
  agent: RoomAgent,
  runtimeAgents: RuntimeAgentSnapshotLike[],
): RuntimeAgentSnapshotLike | undefined {
  const binding = agent.runtime;
  if (!binding) return undefined;

  return (
    runtimeAgents.find(
      (snapshot) =>
        snapshot.providerId === binding.providerId &&
        snapshot.agent.bindingId === binding.bindingId,
    ) ??
    runtimeAgents.find(
      (snapshot) => snapshot.agent.bindingId === binding.bindingId,
    )
  );
}

export function roomAgentRuntimeLabel(
  agent: RoomAgent,
  runtimeAgents: RuntimeAgentSnapshotLike[],
): string | undefined {
  const runtimeAgent = runtimeAgentForRoomAgent(agent, runtimeAgents);
  const matchedLabel = runtimeAgent
    ? runtimeAgentLabel(runtimeAgent.agent)
    : undefined;
  if (matchedLabel) return matchedLabel;

  const bindingLabel = stringValue(agent.runtime?.metadata?.["agent"]);
  if (bindingLabel) return bindingLabel;

  const harnessAlias = harnessTypeAlias(agent.harness?.kind);
  if (harnessAlias) return harnessAlias;

  if (agent.runtime && canonicalAgentAlias(agent.displayName)) {
    return agent.displayName;
  }

  return undefined;
}

export function roomAgentRuntimeTarget(
  agent: RoomAgent,
  runtimeAgents: RuntimeAgentSnapshotLike[],
): string | undefined {
  const runtimeAgent = runtimeAgentForRoomAgent(agent, runtimeAgents);
  if (runtimeAgent) {
    return `${runtimeAgent.providerId}:${runtimeAgent.agent.id}`;
  }
  if (agent.runtime) {
    return `${agent.runtime.providerId}:${agent.runtime.bindingId}`;
  }
  return undefined;
}

export function roomAgentTypeAlias(
  agent: RoomAgent,
  runtimeAgents: RuntimeAgentSnapshotLike[],
): string | undefined {
  const label = roomAgentRuntimeLabel(agent, runtimeAgents);
  return label ? canonicalAgentAlias(label) : undefined;
}

export function summarizeAgentAliases(
  roomAgents: RoomAgent[],
  runtimeAgents: RuntimeAgentSnapshotLike[],
): string | undefined {
  const grouped = new Map<string, string[]>();

  for (const agent of roomAgents) {
    if (agent.state === "stopped") continue;
    const alias = roomAgentTypeAlias(agent, runtimeAgents);
    if (!alias) continue;

    const target = roomAgentRuntimeTarget(agent, runtimeAgents);
    const parts = [
      `roomAgent=${agent.id}`,
      ...(target ? [`runtimeTarget=${target}`] : []),
      `state=${agent.state}`,
    ];
    const entries = grouped.get(alias) ?? [];
    entries.push(parts.join(", "));
    grouped.set(alias, entries);
  }

  if (grouped.size === 0) return undefined;

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([alias, entries]) => `${alias} => ${entries.join(" | ")}`)
    .join("; ");
}

function canonicalAgentAlias(label: string): string | undefined {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return undefined;

  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("gemini")) return "gemini";
  if (normalized === "pi") return "pi";
  if (normalized === "opencode" || normalized === "open-code") {
    return "opencode";
  }

  if (isReadableCustomAgentLabel(normalized)) return normalized;
  return undefined;
}

function harnessTypeAlias(kind: string | undefined): string | undefined {
  switch (kind) {
    case "claude-code":
      return "claude";
    case "codex":
      return "codex";
    case "gemini-cli":
      return "gemini";
    case "pi":
      return "pi";
    default:
      return undefined;
  }
}

function isReadableCustomAgentLabel(value: string): boolean {
  return (
    /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value) &&
    !/^w[0-9a-f]{8,}(?:-\d+)?$/.test(value) &&
    !/^\d+$/.test(value)
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
