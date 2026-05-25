import {
	type ClankyAgentToolHandlers,
	createClankyToolDefinitions,
	type ExternalMcpCallToolInput,
	type LinearCreateIssueToolInput,
	type LinearLinkToolInput,
	type MemoryForgetToolInput,
	type MemoryRememberToolInput,
	type MemorySearchToolInput,
	type ScheduleCronToolInput,
	type TaskCreateToolInput,
} from "@clanky/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const calls: string[] = [];

const handlers: ClankyAgentToolHandlers = {
	scheduleCron: async (input) => {
		calls.push(`schedule:${input.schedule}:${input.prompt}`);
		return { scheduled: true, input };
	},
	linearLink: async (input) => {
		calls.push(`linear:${input.issueId}:${input.sessionId ?? input.taskId ?? "none"}`);
		return { link: input };
	},
	linearCreateIssue: async (input) => {
		calls.push(`linear-create:${input.teamId}:${input.title}`);
		return { issue: { issueId: "issue-tool", identifier: "PROJ-100", ...input } };
	},
	externalMcpCall: async (input) => {
		calls.push(`mcp-call:${input.server}:${input.tool}`);
		return { result: { ok: true, input } };
	},
	taskCreate: async (input) => {
		calls.push(`task:${input.title}:${input.sessionId ?? "none"}`);
		return { task: { id: "task-created", ...input } };
	},
	memoryRemember: async (input) => {
		calls.push(`memory-remember:${input.claim}:${input.confirmed === true}`);
		return { saved: true, atom: stubAtom(input.claim) };
	},
	memorySearch: async (input) => {
		calls.push(`memory-search:${input.query ?? "all"}:${input.subjectId ?? "none"}`);
		return { atoms: [stubAtom("baseline")] };
	},
	memoryForget: async (input) => {
		calls.push(`memory-forget:${input.id ?? `${input.scope}:${input.subjectId}`}`);
		return { forgotten: 1 };
	},
};

const tools = createClankyToolDefinitions(handlers);
const expectedNames = [
	"schedule_cron",
	"mcp_call",
	"linear_create_issue",
	"linear_link",
	"task_create",
	"memory_remember",
	"memory_search",
	"memory_forget",
];
assertToolNames(tools, expectedNames);

await executeTool(tools, "schedule_cron", {
	schedule: "every 1h",
	prompt: "Summarize",
	provider: "anthropic",
	model: "claude-opus-4-5",
	timeout_seconds: 600,
	idempotency_key: "agent-tools-cron-smoke",
} satisfies ScheduleCronToolInput);

await executeTool(tools, "linear_create_issue", {
	team_id: "team-1",
	title: "Linear smoke",
	description: "Linear create smoke description",
} satisfies LinearCreateIssueToolInput);

await executeTool(tools, "linear_link", {
	issueId: "PROJ-1",
	sessionId: "session-smoke",
} satisfies LinearLinkToolInput);

await executeTool(tools, "mcp_call", {
	server: "faux",
	tool: "echo",
} satisfies ExternalMcpCallToolInput);

await executeTool(tools, "task_create", {
	title: "Task smoke",
	priority: "high",
} satisfies TaskCreateToolInput);

await executeTool(tools, "memory_remember", {
	claim: "Project uses source-grounded memory atoms.",
	confirmed: true,
	subject_id: "smoke",
} satisfies MemoryRememberToolInput);

await executeTool(tools, "memory_search", {
	query: "memory",
	limit: 4,
} satisfies MemorySearchToolInput);

await executeTool(tools, "memory_forget", {
	id: "memory-tool",
} satisfies MemoryForgetToolInput);

const expectedCallPrefixes = [
	"schedule:",
	"linear-create:",
	"linear:",
	"mcp-call:",
	"task:",
	"memory-remember:",
	"memory-search:",
	"memory-forget:",
];
for (const prefix of expectedCallPrefixes) {
	if (!calls.some((entry) => entry.startsWith(prefix))) {
		throw new Error(`Expected handler call with prefix ${prefix}, got ${JSON.stringify(calls)}`);
	}
}

console.log(JSON.stringify({ tools: tools.length, calls: calls.length }));

function stubAtom(claim: string) {
	return {
		id: "memory-tool",
		scope: "project" as const,
		subjectId: "smoke",
		type: "fact" as const,
		claim,
		sourceEventIds: ["event-tool"],
		confidence: 0.9,
		sensitivity: "public" as const,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		lexicalIndexTerms: ["project", "memory"],
	};
}

function assertToolNames(actual: readonly ToolDefinition[], expected: readonly string[]): void {
	const names = actual.map((tool) => tool.name).sort();
	const sortedExpected = [...expected].sort();
	if (names.join(",") !== sortedExpected.join(",")) {
		throw new Error(`Tool definitions mismatch. expected=${sortedExpected.join(",")} actual=${names.join(",")}`);
	}
}

async function executeTool<T extends Record<string, unknown>>(
	tools: readonly ToolDefinition[],
	name: string,
	input: T,
): Promise<unknown> {
	const tool = tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`Tool ${name} is not registered`);
	const ctx = {
		sessionManager: { getSessionId: () => "session-smoke" },
		cwd: "/tmp/clanky-agent-tools-smoke",
	} as unknown as Parameters<typeof tool.execute>[4];
	const result = await tool.execute("call-id", input, new AbortController().signal, () => undefined, ctx);
	if (result === undefined || typeof result !== "object" || !("details" in result)) {
		throw new Error(`Tool ${name} returned malformed result: ${JSON.stringify(result)}`);
	}
	return (result as { details: unknown }).details;
}
