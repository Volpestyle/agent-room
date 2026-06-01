import type { Agent, AgentState, Id, RuntimeBinding } from "../domain.js";
import type {
  RuntimeProvider,
  RuntimeProviderKind,
} from "../ports/RuntimeProvider.js";

const DEFAULT_LINES = 200;
const MAX_LINES = 2_000;
const DEFAULT_CONTEXT_LINES = 2;
const MAX_CONTEXT_LINES = 20;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export interface RuntimeSearchOptions {
  query: string;
  providerId?: string;
  lines?: number;
  linesBefore?: number;
  linesAfter?: number;
  limit?: number;
  caseSensitive?: boolean;
}

export interface RuntimeSearchInput extends RuntimeSearchOptions {
  agents: Agent[];
  providerForBinding: (
    binding: RuntimeBinding,
  ) => RuntimeProvider | Promise<RuntimeProvider>;
}

export interface RuntimeSearchRuntimeRef {
  providerId: string;
  providerKind: RuntimeProviderKind;
  bindingId: string;
  kind: RuntimeBinding["kind"];
}

export interface RuntimeSearchMatch {
  agentId: Id;
  displayName: string;
  runtime: RuntimeSearchRuntimeRef;
  state: AgentState;
  lineNumber: number;
  matchedLine: string;
  before: string[];
  after: string[];
  observedAt: string;
}

export interface RuntimeSearchError {
  agentId: Id;
  displayName: string;
  providerId: string;
  bindingId: string;
  error: string;
}

export interface RuntimeSearchResult {
  query: string;
  searchedAgents: number;
  matchedAgents: number;
  matchCount: number;
  truncated: boolean;
  matches: RuntimeSearchMatch[];
  errors: RuntimeSearchError[];
}

export async function searchRuntimeAgents(
  input: RuntimeSearchInput,
): Promise<RuntimeSearchResult> {
  const query = input.query.trim();
  if (query.length === 0) {
    throw new Error("runtime search query is required");
  }

  const lines = boundedInteger(
    input.lines ?? DEFAULT_LINES,
    "lines",
    1,
    MAX_LINES,
  );
  const linesBefore = boundedInteger(
    input.linesBefore ?? DEFAULT_CONTEXT_LINES,
    "linesBefore",
    0,
    MAX_CONTEXT_LINES,
  );
  const linesAfter = boundedInteger(
    input.linesAfter ?? DEFAULT_CONTEXT_LINES,
    "linesAfter",
    0,
    MAX_CONTEXT_LINES,
  );
  const limit = boundedInteger(
    input.limit ?? DEFAULT_LIMIT,
    "limit",
    1,
    MAX_LIMIT,
  );
  const needle = input.caseSensitive ? query : query.toLowerCase();

  const agents = input.agents.filter(
    (agent) =>
      agent.runtime !== undefined &&
      agent.state !== "stopped" &&
      (input.providerId === undefined ||
        agent.runtime.providerId === input.providerId),
  );
  const matches: RuntimeSearchMatch[] = [];
  const errors: RuntimeSearchError[] = [];
  const matchedAgentIds = new Set<Id>();
  let matchCount = 0;

  for (const agent of agents) {
    const binding = agent.runtime;
    if (binding === undefined) continue;
    try {
      const provider = await input.providerForBinding(binding);
      if (!provider.capabilities.readOutput) {
        errors.push(
          searchError(agent, binding, "runtime provider cannot read output"),
        );
        continue;
      }

      const output = await provider.readAgent({
        agentId: agent.id,
        bindingId: binding.bindingId,
        lines,
        source: "recent",
      });
      const outputLines = splitOutputLines(output.text);
      for (const [index, line] of outputLines.entries()) {
        const haystack = input.caseSensitive ? line : line.toLowerCase();
        if (!haystack.includes(needle)) continue;

        matchCount += 1;
        matchedAgentIds.add(agent.id);
        if (matches.length >= limit) continue;

        matches.push({
          agentId: agent.id,
          displayName: agent.displayName,
          runtime: {
            providerId: binding.providerId,
            providerKind: provider.kind,
            bindingId: binding.bindingId,
            kind: binding.kind,
          },
          state: agent.state,
          lineNumber: index + 1,
          matchedLine: line,
          before: outputLines.slice(Math.max(0, index - linesBefore), index),
          after: outputLines.slice(index + 1, index + 1 + linesAfter),
          observedAt: output.observedAt,
        });
      }
    } catch (error) {
      errors.push(searchError(agent, binding, errorMessage(error)));
    }
  }

  return {
    query,
    searchedAgents: agents.length,
    matchedAgents: matchedAgentIds.size,
    matchCount,
    truncated: matchCount > matches.length,
    matches,
    errors,
  };
}

function boundedInteger(
  value: number,
  name: string,
  min: number,
  max: number,
): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function splitOutputLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function searchError(
  agent: Agent,
  binding: RuntimeBinding,
  error: string,
): RuntimeSearchError {
  return {
    agentId: agent.id,
    displayName: agent.displayName,
    providerId: binding.providerId,
    bindingId: binding.bindingId,
    error,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
