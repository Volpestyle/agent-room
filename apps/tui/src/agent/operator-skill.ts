import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAgentRoomProtocolSync } from "@agentroom/config";

const DEFAULT_MAX_SKILL_CHARS = 14_000;
const OPERATOR_SKILL_RELATIVE_PATH = join(
  "skills",
  "agentroom-operator",
  "SKILL.md",
);

export interface OperatorSkillLoadOptions {
  env?: NodeJS.ProcessEnv;
  maxChars?: number;
  moduleDir?: string;
}

export function loadDashboardOperatorSkillPrompt(
  roomCwd: string,
  options: OperatorSkillLoadOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  const sections: string[] = [];

  const protocolPrompt = loadRoomProtocolPrompt(roomCwd, options);
  if (protocolPrompt) sections.push(protocolPrompt);

  if (!isDisabled(env.AGENTROOM_TUI_OPERATOR_SKILL)) {
    const skillPath =
      explicitSkillPath(env.AGENTROOM_TUI_OPERATOR_SKILL_PATH) ??
      findOperatorSkill(roomCwd, options.moduleDir);
    if (skillPath) {
      const operatorPrompt = loadOperatorSkillPrompt(skillPath, options);
      if (operatorPrompt) sections.push(operatorPrompt);
    }
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function loadRoomProtocolPrompt(
  roomCwd: string,
  options: OperatorSkillLoadOptions,
): string | undefined {
  const env = options.env ?? process.env;
  if (isDisabled(env.AGENTROOM_TUI_ROOM_PROTOCOL)) return undefined;

  let protocol: { path: string; content: string };
  try {
    protocol = readAgentRoomProtocolSync(roomCwd);
  } catch {
    return undefined;
  }

  const body = truncateSkill(protocol.content.trim(), options.maxChars);
  if (!body) return undefined;

  return [
    "Embedded AgentRoom room protocol:",
    `Source: ${protocol.path}`,
    "This is the editable room protocol for this room. Follow it where applicable; it describes room behavior and policy, while config.yaml describes topology.",
    "",
    "<agentroom_room_protocol>",
    body,
    "</agentroom_room_protocol>",
  ].join("\n");
}

function loadOperatorSkillPrompt(
  skillPath: string,
  options: OperatorSkillLoadOptions,
): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(skillPath, "utf8");
  } catch {
    return undefined;
  }
  const body = truncateSkill(stripFrontmatter(raw).trim(), options.maxChars);
  if (!body) return undefined;
  return [
    "Embedded AgentRoom operator skill:",
    `Source: ${skillPath}`,
    "This is maintained skill guidance for this Pi dashboard agent. Follow it where applicable, but adapt CLI examples to your available AgentRoom HTTP tools. You still do not have direct shell or filesystem access; do not claim to run CLI commands unless a runtime agent did it or the operator provided the output.",
    "",
    "<agentroom_operator_skill>",
    body,
    "</agentroom_operator_skill>",
  ].join("\n");
}

function explicitSkillPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? resolve(trimmed) : undefined;
}

function findOperatorSkill(
  roomCwd: string,
  moduleDir = dirname(fileURLToPath(import.meta.url)),
): string | undefined {
  const starts = [roomCwd, moduleDir, process.cwd()];
  for (const start of starts) {
    const found = findInAncestors(start);
    if (found) return found;
  }
  return undefined;
}

function findInAncestors(start: string): string | undefined {
  let current = resolve(start);
  for (;;) {
    const candidate = join(current, OPERATOR_SKILL_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  const nextLine = content.indexOf("\n", end + 4);
  return nextLine === -1 ? "" : content.slice(nextLine + 1);
}

function truncateSkill(
  content: string,
  maxChars = DEFAULT_MAX_SKILL_CHARS,
): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars).trimEnd()}\n\n[operator skill truncated]`;
}

function isDisabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off";
}
