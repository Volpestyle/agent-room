import {
	type AgentToolResult,
	type BeforeProviderRequestEvent,
	defineTool,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionFactory,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { LinearCreateIssueInput } from "./linear/client.js";
import type { CreateLinearLinkInput } from "./linear/links.js";
import type {
	ForgetMemoryInput,
	MemoryExport,
	MemoryPacket,
	MemoryPacketInput,
	MemorySearchOptions,
	MemorySearchResult,
	MemoryWriteResult,
	RememberMemoryInput,
	SetMemoryConsentInput,
} from "./memory/store.js";
import type { CreateClankySkillInput } from "./skills/loader.js";
import { extractIndexableMessageText, type SessionIndexMessageInput } from "./state/index-db.js";

type ClankyMessageEndEvent = {
	message: Parameters<typeof extractIndexableMessageText>[0];
};

const scheduleCronSchema = Type.Object({
	schedule: Type.String(),
	prompt: Type.String(),
	deliver: Type.Optional(Type.String()),
	skill: Type.Optional(Type.String()),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	timeoutSeconds: Type.Optional(Type.Number()),
	timeout_seconds: Type.Optional(Type.Number()),
	workdir: Type.Optional(Type.String()),
	idempotencyKey: Type.Optional(Type.String()),
	idempotency_key: Type.Optional(Type.String()),
});

const linearLinkSchema = Type.Object({
	issueId: Type.Optional(Type.String()),
	issue_id: Type.Optional(Type.String()),
	sessionId: Type.Optional(Type.String()),
	session_id: Type.Optional(Type.String()),
	taskId: Type.Optional(Type.String()),
	task_id: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
});

const linearCreateIssueSchema = Type.Object({
	teamId: Type.Optional(Type.String()),
	team_id: Type.Optional(Type.String()),
	title: Type.String(),
	description: Type.Optional(Type.String()),
	assigneeId: Type.Optional(Type.String()),
	assignee_id: Type.Optional(Type.String()),
	projectId: Type.Optional(Type.String()),
	project_id: Type.Optional(Type.String()),
	stateId: Type.Optional(Type.String()),
	state_id: Type.Optional(Type.String()),
	priority: Type.Optional(Type.Number()),
	labelIds: Type.Optional(Type.Array(Type.String())),
	label_ids: Type.Optional(Type.Array(Type.String())),
});

const externalMcpCallSchema = Type.Object({
	server: Type.String(),
	tool: Type.String(),
	arguments: Type.Optional(Type.Unknown()),
});

const taskCreateSchema = Type.Object({
	title: Type.String(),
	description: Type.Optional(Type.String()),
	status: Type.Optional(
		Type.Union([Type.Literal("open"), Type.Literal("in_progress"), Type.Literal("done"), Type.Literal("cancelled")]),
	),
	priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")])),
	sessionId: Type.Optional(Type.String()),
	session_id: Type.Optional(Type.String()),
	linearIssue: Type.Optional(Type.String()),
	linear_issue: Type.Optional(Type.String()),
});

const memoryScopeSchema = Type.Union([
	Type.Literal("user"),
	Type.Literal("dm"),
	Type.Literal("guild"),
	Type.Literal("channel"),
	Type.Literal("project"),
	Type.Literal("agent"),
]);

const memoryAtomTypeSchema = Type.Union([
	Type.Literal("preference"),
	Type.Literal("fact"),
	Type.Literal("decision"),
	Type.Literal("commitment"),
	Type.Literal("lesson"),
	Type.Literal("skill_hint"),
]);

const memorySensitivitySchema = Type.Union([
	Type.Literal("public"),
	Type.Literal("personal"),
	Type.Literal("sensitive"),
	Type.Literal("secret"),
]);

const memoryRememberSchema = Type.Object({
	scope: Type.Optional(memoryScopeSchema),
	subjectId: Type.Optional(Type.String()),
	subject_id: Type.Optional(Type.String()),
	type: Type.Optional(memoryAtomTypeSchema),
	claim: Type.String(),
	sourceEventIds: Type.Optional(Type.Array(Type.String())),
	source_event_ids: Type.Optional(Type.Array(Type.String())),
	sourceText: Type.Optional(Type.String()),
	source_text: Type.Optional(Type.String()),
	confidence: Type.Optional(Type.Number()),
	sensitivity: Type.Optional(memorySensitivitySchema),
	ttlDays: Type.Optional(Type.Number()),
	ttl_days: Type.Optional(Type.Number()),
	confirmed: Type.Optional(Type.Boolean()),
});

const memorySearchSchema = Type.Object({
	query: Type.Optional(Type.String()),
	q: Type.Optional(Type.String()),
	scope: Type.Optional(memoryScopeSchema),
	subjectId: Type.Optional(Type.String()),
	subject_id: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Number()),
});

const memoryForgetSchema = Type.Object({
	id: Type.Optional(Type.String()),
	scope: Type.Optional(memoryScopeSchema),
	subjectId: Type.Optional(Type.String()),
	subject_id: Type.Optional(Type.String()),
});

export type ScheduleCronToolInput = Static<typeof scheduleCronSchema>;
export type LinearCreateIssueToolInput = Static<typeof linearCreateIssueSchema>;
export type LinearLinkToolInput = Static<typeof linearLinkSchema>;
export type ExternalMcpCallToolInput = Static<typeof externalMcpCallSchema>;
export type TaskCreateToolInput = Static<typeof taskCreateSchema>;
export type MemoryRememberToolInput = Static<typeof memoryRememberSchema>;
export type MemorySearchToolInput = Static<typeof memorySearchSchema>;
export type MemoryForgetToolInput = Static<typeof memoryForgetSchema>;

export interface ClankyBeforeProviderRequestInput {
	sessionId: string;
	payload: BeforeProviderRequestEvent["payload"];
}

export interface ClankyAgentToolHandlers {
	scheduleCron?: (input: ScheduleCronToolInput) => Promise<unknown>;
	linearCreateIssue?: (input: LinearCreateIssueInput) => Promise<unknown>;
	linearLink?: (input: CreateLinearLinkInput) => Promise<unknown>;
	externalMcpCall?: (input: ExternalMcpCallToolInput) => Promise<unknown>;
	taskCreate?: (input: TaskCreateToolInput) => Promise<unknown>;
	beforeProviderRequest?: (input: ClankyBeforeProviderRequestInput) => Promise<unknown | undefined>;
	indexMessage?: (input: SessionIndexMessageInput) => Promise<void>;
	memoryPacket?: (input: MemoryPacketInput) => Promise<MemoryPacket>;
	memoryRemember?: (input: RememberMemoryInput) => Promise<MemoryWriteResult>;
	memorySearch?: (input: MemorySearchOptions) => Promise<MemorySearchResult>;
	memoryForget?: (input: ForgetMemoryInput) => Promise<unknown>;
	memoryExport?: () => Promise<MemoryExport>;
	memoryConsent?: (input: SetMemoryConsentInput) => Promise<unknown>;
	selfMemory?: () => Promise<string>;
	listCron?: () => Promise<unknown>;
	externalMcpStatus?: () => Promise<unknown>;
	listSkills?: () => Promise<unknown>;
	createSkill?: (input: CreateClankySkillInput) => Promise<unknown>;
	profileStatus?: () => Promise<unknown>;
}

const CLANKY_MEMORY_PACKET_MESSAGE = "clanky.memory_packet";

export function createClankyExtensionFactories(handlers: ClankyAgentToolHandlers): ExtensionFactory[] {
	const indexMessage = handlers.indexMessage;
	const beforeProviderRequest = handlers.beforeProviderRequest;
	const memoryPacket = handlers.memoryPacket;
	const hasCommands =
		handlers.listCron !== undefined ||
		handlers.externalMcpStatus !== undefined ||
		handlers.listSkills !== undefined ||
		handlers.createSkill !== undefined ||
		handlers.memoryRemember !== undefined ||
		handlers.memorySearch !== undefined ||
		handlers.memoryForget !== undefined ||
		handlers.memoryExport !== undefined ||
		handlers.memoryConsent !== undefined ||
		handlers.selfMemory !== undefined ||
		handlers.profileStatus !== undefined;
	if (indexMessage === undefined && beforeProviderRequest === undefined && memoryPacket === undefined && !hasCommands) {
		return [];
	}
	return [
		(pi) => {
			registerClankyCommands(pi, handlers);
			if (indexMessage !== undefined) {
				pi.on("message_end", async (event, ctx) => {
					const input = buildMessageIndexInput(event, ctx);
					if (input === undefined) return undefined;
					try {
						await indexMessage(input);
					} catch (error) {
						if (ctx.hasUI) {
							const message = error instanceof Error ? error.message : String(error);
							ctx.ui.notify(`Clanky session index failed: ${message}`, "warning");
						}
					}
					return undefined;
				});
			}
			if (beforeProviderRequest !== undefined) {
				pi.on("before_provider_request", async (event, ctx) => {
					return await beforeProviderRequest({
						sessionId: ctx.sessionManager.getSessionId(),
						payload: event.payload,
					});
				});
			}
			if (memoryPacket !== undefined) {
				pi.on("before_agent_start", async (event, ctx) => {
					const packet = await memoryPacket({
						sessionId: ctx.sessionManager.getSessionId(),
						prompt: event.prompt,
						cwd: ctx.cwd,
					});
					return {
						systemPrompt: appendMemoryToSystemPrompt(event.systemPrompt, packet),
						message: {
							customType: CLANKY_MEMORY_PACKET_MESSAGE,
							content: packet.text,
							display: false,
							details: {
								atomIds: packet.atoms.map((atom) => atom.id),
							},
						},
					};
				});
			}
		},
	];
}

function registerClankyCommands(pi: Parameters<ExtensionFactory>[0], handlers: ClankyAgentToolHandlers): void {
	if (handlers.listCron !== undefined) {
		pi.registerCommand("cron", {
			description: "Show Clanky cron jobs",
			handler: async (_args, ctx) => {
				ctx.ui.notify(formatCommandResult("Cron", await handlers.listCron?.()));
			},
		});
	}
	if (handlers.listSkills !== undefined) {
		pi.registerCommand("skills", {
			description: "Show Clanky skills",
			handler: async (_args, ctx) => {
				ctx.ui.notify(formatCommandResult("Skills", await handlers.listSkills?.()));
			},
		});
	}
	if (handlers.listSkills !== undefined || handlers.createSkill !== undefined) {
		pi.registerCommand("skill", {
			description: "List or create Clanky skills",
			handler: async (args, ctx) => {
				const trimmed = args.trim();
				if (trimmed === "" || trimmed === "list") {
					if (handlers.listSkills === undefined) {
						ctx.ui.notify("Skill\nNo skill list handler is configured.");
						return;
					}
					ctx.ui.notify(formatCommandResult("Skill", await handlers.listSkills()));
					return;
				}
				if (trimmed.startsWith("add ")) {
					if (handlers.createSkill === undefined) {
						ctx.ui.notify("Skill\nNo skill create handler is configured.");
						return;
					}
					const [name] = trimmed.slice("add ".length).trim().split(/\s+/, 1);
					if (name === undefined || name.length === 0) {
						ctx.ui.notify("Skill\nUsage: /skill add <name>");
						return;
					}
					const skill = await handlers.createSkill({ name });
					await ctx.reload();
					ctx.ui.notify(formatCommandResult("Skill", { created: skill, invoke: `/skill:${name}` }));
					return;
				}
				ctx.ui.notify("Skill\nUsage: /skill list | /skill add <name>\nInvoke loaded skills with /skill:<name>.");
			},
		});
	}
	if (
		handlers.memorySearch !== undefined ||
		handlers.memoryRemember !== undefined ||
		handlers.memoryForget !== undefined ||
		handlers.memoryExport !== undefined ||
		handlers.memoryConsent !== undefined ||
		handlers.selfMemory !== undefined
	) {
		registerMemoryCommands(pi, handlers);
	}
	if (handlers.externalMcpStatus !== undefined) {
		pi.registerCommand("mcp", {
			description: "Show configured external Clanky MCP servers",
			handler: async (_args, ctx) => {
				ctx.ui.notify(formatCommandResult("MCP", await handlers.externalMcpStatus?.()));
			},
		});
	}
	if (handlers.profileStatus !== undefined) {
		pi.registerCommand("profile", {
			description: "Show Clanky profile paths",
			handler: async (_args, ctx) => {
				ctx.ui.notify(formatCommandResult("Profile", await handlers.profileStatus?.()));
			},
		});
	}
}

function registerMemoryCommands(pi: Parameters<ExtensionFactory>[0], handlers: ClankyAgentToolHandlers): void {
	if (handlers.selfMemory !== undefined) {
		pi.registerCommand("who_are_you", {
			description: "Show Clanky's self memory",
			handler: async (_args, ctx) => {
				ctx.ui.notify(`Self Memory\n${await handlers.selfMemory?.()}`);
			},
		});
		pi.registerCommand("privacy", {
			description: "Show Clanky's memory privacy policy",
			handler: async (_args, ctx) => {
				ctx.ui.notify(
					"Privacy\nClanky stores source-grounded memories only when consent or explicit confirmation allows it. Personal memories require confirmation; sensitive data and secrets are rejected.",
				);
			},
		});
		pi.registerCommand("why_did_you_say_that", {
			description: "Show the latest memory packet used for a response",
			handler: async (_args, ctx) => {
				ctx.ui.notify(latestMemoryExplanation(ctx));
			},
		});
	}
	if (handlers.memorySearch !== undefined) {
		pi.registerCommand("what_do_you_remember", {
			description: "Search Clanky memory",
			handler: async (args, ctx) => {
				ctx.ui.notify(formatCommandResult("Memory", await handlers.memorySearch?.(memoryCommandSearch(args, ctx.cwd))));
			},
		});
	}
	if (handlers.memoryForget !== undefined) {
		pi.registerCommand("forget_me", {
			description: "Forget local user-scoped memories",
			handler: async (_args, ctx) => {
				ctx.ui.notify(
					formatCommandResult("Forget Me", await handlers.memoryForget?.({ scope: "user", subjectId: "local" })),
				);
			},
		});
		pi.registerCommand("forget_this_channel", {
			description: "Forget memories for a channel subject id",
			handler: async (args, ctx) => {
				const subjectId = args.trim();
				if (subjectId.length === 0) {
					ctx.ui.notify("Forget Channel\nUsage: /forget_this_channel <channel-id>");
					return;
				}
				ctx.ui.notify(
					formatCommandResult("Forget Channel", await handlers.memoryForget?.({ scope: "channel", subjectId })),
				);
			},
		});
	}
	pi.registerCommand("memory", {
		description: "View, remember, forget, export, or configure Clanky memory",
		handler: async (args, ctx) => {
			ctx.ui.notify(await runMemoryCommand(args, ctx, handlers));
		},
	});
	if (handlers.memoryExport !== undefined) {
		pi.registerCommand("memory_export", {
			description: "Export Clanky memory",
			handler: async (_args, ctx) => {
				ctx.ui.notify(formatCommandResult("Memory Export", await handlers.memoryExport?.()));
			},
		});
	}
	if (handlers.memoryConsent !== undefined) {
		pi.registerCommand("memory_off", {
			description: "Disable local user memory",
			handler: async (_args, ctx) => {
				ctx.ui.notify(
					formatCommandResult(
						"Memory Off",
						await handlers.memoryConsent?.({ scope: "user", subjectId: "local", enabled: false }),
					),
				);
			},
		});
	}
}

async function runMemoryCommand(
	args: string,
	ctx: ExtensionCommandContext,
	handlers: ClankyAgentToolHandlers,
): Promise<string> {
	const trimmed = args.trim();
	if (trimmed === "" || trimmed === "view") {
		if (handlers.memorySearch === undefined) return "Memory\nNo memory search handler is configured.";
		return formatCommandResult("Memory", await handlers.memorySearch(memoryCommandSearch("", ctx.cwd)));
	}
	if (trimmed.startsWith("view ")) {
		if (handlers.memorySearch === undefined) return "Memory\nNo memory search handler is configured.";
		return formatCommandResult("Memory", await handlers.memorySearch(memoryCommandSearch(trimmed.slice(5), ctx.cwd)));
	}
	if (trimmed.startsWith("remember ")) {
		if (handlers.memoryRemember === undefined) return "Memory\nNo memory remember handler is configured.";
		const claim = trimmed.slice("remember ".length).trim();
		if (claim.length === 0) return "Memory\nUsage: /memory remember <claim>";
		return formatCommandResult(
			"Memory",
			await handlers.memoryRemember({
				scope: "project",
				subjectId: ctx.cwd,
				type: "fact",
				claim,
				confirmed: true,
				source: {
					scope: "project",
					subjectId: ctx.cwd,
					source: "manual",
					text: claim,
				},
			}),
		);
	}
	if (trimmed.startsWith("forget ")) {
		if (handlers.memoryForget === undefined) return "Memory\nNo memory forget handler is configured.";
		const id = trimmed.slice("forget ".length).trim();
		if (id.length === 0) return "Memory\nUsage: /memory forget <memory-id>";
		return formatCommandResult("Memory", await handlers.memoryForget({ id }));
	}
	if (trimmed === "export") {
		if (handlers.memoryExport === undefined) return "Memory\nNo memory export handler is configured.";
		return formatCommandResult("Memory Export", await handlers.memoryExport());
	}
	if (trimmed === "off") {
		if (handlers.memoryConsent === undefined) return "Memory\nNo memory consent handler is configured.";
		return formatCommandResult(
			"Memory",
			await handlers.memoryConsent({ scope: "user", subjectId: "local", enabled: false }),
		);
	}
	if (trimmed === "on") {
		if (handlers.memoryConsent === undefined) return "Memory\nNo memory consent handler is configured.";
		return formatCommandResult(
			"Memory",
			await handlers.memoryConsent({ scope: "user", subjectId: "local", enabled: true, mode: "dm" }),
		);
	}
	return "Memory\nUsage: /memory view [query] | remember <claim> | forget <id> | export | on | off";
}

function buildMessageIndexInput(
	event: ClankyMessageEndEvent,
	ctx: ExtensionContext,
): SessionIndexMessageInput | undefined {
	const extracted = extractIndexableMessageText(event.message);
	if (extracted === undefined) return undefined;
	const entry = ctx.sessionManager.getLeafEntry();
	const input: SessionIndexMessageInput = {
		sessionId: ctx.sessionManager.getSessionId(),
		role: extracted.role,
		text: extracted.text,
		cwd: ctx.cwd,
		createdAt: entry?.type === "message" ? entry.timestamp : messageTimestamp(event.message),
	};
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile !== undefined) input.sessionFile = sessionFile;
	if (entry?.type === "message") input.messageKey = `${input.sessionId}:${entry.id}`;
	return input;
}

function messageTimestamp(message: ClankyMessageEndEvent["message"]): string {
	if (typeof message === "object" && message !== null && "timestamp" in message) {
		const timestamp = message.timestamp;
		if (typeof timestamp === "number" && Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
	}
	return new Date().toISOString();
}

export function createClankyToolDefinitions(handlers: ClankyAgentToolHandlers): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	const scheduleCron = handlers.scheduleCron;
	if (scheduleCron !== undefined) {
		tools.push(
			defineTool({
				name: "schedule_cron",
				label: "Schedule Cron",
				description: "Create a Clanky cron job for a prompt that should run later or on a schedule.",
				promptSnippet: "schedule_cron: schedule a prompt to run later or repeatedly through the Clanky daemon.",
				promptGuidelines: [
					"Set provider/model only when the user asks for a specific model for the scheduled cron prompt.",
				],
				parameters: scheduleCronSchema,
				async execute(_toolCallId, params) {
					return toolResult(await scheduleCron(normalizeScheduleCronToolInput(params)));
				},
			}),
		);
	}
	const linearLink = handlers.linearLink;
	const linearCreateIssue = handlers.linearCreateIssue;
	const externalMcpCall = handlers.externalMcpCall;
	if (externalMcpCall !== undefined) {
		tools.push(
			defineTool({
				name: "mcp_call",
				label: "MCP Call",
				description: "Call a tool on an external MCP server configured in the Clanky daemon.",
				promptSnippet: "mcp_call: call a configured external MCP server tool by server and tool name.",
				promptGuidelines: [
					"Use mcp_call only for MCP servers listed in Clanky status or the /mcp command.",
					"Pass arguments as a JSON object matching the target tool schema.",
				],
				parameters: externalMcpCallSchema,
				async execute(_toolCallId, params) {
					return toolResult(await externalMcpCall(params));
				},
			}),
		);
	}
	if (linearCreateIssue !== undefined) {
		tools.push(
			defineTool({
				name: "linear_create_issue",
				label: "Linear Create Issue",
				description: "Create a Linear issue in a known team using configured Linear credentials.",
				promptSnippet: "linear_create_issue: create a Linear issue when new tracked work needs to be filed.",
				promptGuidelines: [
					"Use linear_link after creating an issue if the current Clanky session should stay bound to it.",
				],
				parameters: linearCreateIssueSchema,
				async execute(_toolCallId, params) {
					return toolResult(await linearCreateIssue(normalizeLinearCreateIssueToolInput(params)));
				},
			}),
		);
	}
	if (linearLink !== undefined) {
		tools.push(
			defineTool({
				name: "linear_link",
				label: "Linear Link",
				description: "Persist a link between a Linear issue and a Clanky session or task.",
				promptSnippet: "linear_link: bind a Linear issue to the current session or a task.",
				parameters: linearLinkSchema,
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					const input = normalizeLinearLinkToolInput(params, ctx.sessionManager.getSessionId());
					return toolResult(await linearLink(input));
				},
			}),
		);
	}
	const taskCreate = handlers.taskCreate;
	if (taskCreate !== undefined) {
		tools.push(
			defineTool({
				name: "task_create",
				label: "Task Create",
				description: "Create a lightweight Clanky task record tied to the current session and optional Linear issue.",
				promptSnippet: "task_create: record a local Clanky task for follow-up or lightweight work tracking.",
				parameters: taskCreateSchema,
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					const input = normalizeTaskCreateToolInput(params, ctx.sessionManager.getSessionId());
					return toolResult(await taskCreate(input));
				},
			}),
		);
	}
	const memoryRemember = handlers.memoryRemember;
	if (memoryRemember !== undefined) {
		tools.push(
			defineTool({
				name: "memory_remember",
				label: "Memory Remember",
				description: "Store a source-grounded Clanky memory atom when policy and user confirmation allow it.",
				promptSnippet:
					"memory_remember: save an explicit preference, fact, decision, commitment, lesson, or skill hint.",
				promptGuidelines: [
					"Use only when the user explicitly asks you to remember something or confirms a proposed memory.",
					"Do not store secrets, credentials, sensitive traits, relationship inferences, or unsupported guesses.",
					"Set confirmed=true only when the user explicitly asked for the memory to be saved.",
				],
				parameters: memoryRememberSchema,
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					return toolResult(await memoryRemember(normalizeMemoryRememberToolInput(params, ctx.cwd)));
				},
			}),
		);
	}
	const memorySearch = handlers.memorySearch;
	if (memorySearch !== undefined) {
		tools.push(
			defineTool({
				name: "memory_search",
				label: "Memory Search",
				description: "Search source-grounded Clanky memory atoms for the current profile.",
				promptSnippet: "memory_search: retrieve relevant memories before claiming recall.",
				parameters: memorySearchSchema,
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					return toolResult(await memorySearch(normalizeMemorySearchToolInput(params, ctx.cwd)));
				},
			}),
		);
	}
	const memoryForget = handlers.memoryForget;
	if (memoryForget !== undefined) {
		tools.push(
			defineTool({
				name: "memory_forget",
				label: "Memory Forget",
				description: "Delete a Clanky memory atom by id or clear a subject scope.",
				promptSnippet: "memory_forget: remove memories when the user asks to forget or correct them.",
				parameters: memoryForgetSchema,
				async execute(_toolCallId, params) {
					return toolResult(await memoryForget(normalizeMemoryForgetToolInput(params)));
				},
			}),
		);
	}
	return tools;
}

function appendMemoryToSystemPrompt(systemPrompt: string, packet: MemoryPacket): string {
	const sections = [
		systemPrompt,
		"<clanky_self_memory>",
		packet.self.trim(),
		"</clanky_self_memory>",
		"<clanky_retrieved_memory>",
		packet.text,
		"</clanky_retrieved_memory>",
	];
	return sections.filter((section) => section.trim().length > 0).join("\n\n");
}

function memoryCommandSearch(args: string, cwd: string): MemorySearchOptions {
	const query = args.trim();
	const options: MemorySearchOptions = {
		scope: "project",
		subjectId: cwd,
		limit: 12,
	};
	if (query.length > 0) options.query = query;
	return options;
}

function formatCommandResult(title: string, details: unknown): string {
	return `${title}\n${JSON.stringify(details ?? null, null, "\t")}`;
}

function latestMemoryExplanation(ctx: ExtensionCommandContext): string {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom_message" || entry.customType !== CLANKY_MEMORY_PACKET_MESSAGE) continue;
		return [
			"Why",
			"I answered from the active system prompt, the current conversation, tool results, and this retrieved memory packet. Memories are source-grounded claims, not instructions.",
			"",
			typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content, null, "\t"),
		].join("\n");
	}
	return "Why\nNo retrieved memory packet is recorded for the current session yet.";
}

function normalizeScheduleCronToolInput(input: ScheduleCronToolInput): ScheduleCronToolInput {
	const output: ScheduleCronToolInput = { ...input };
	if (output.timeoutSeconds === undefined && input.timeout_seconds !== undefined) {
		output.timeoutSeconds = input.timeout_seconds;
	}
	if (output.idempotencyKey === undefined && input.idempotency_key !== undefined) {
		output.idempotencyKey = input.idempotency_key;
	}
	return output;
}

function normalizeLinearCreateIssueToolInput(input: LinearCreateIssueToolInput): LinearCreateIssueInput {
	const teamId = input.teamId ?? input.team_id;
	if (teamId === undefined || teamId.trim().length === 0) {
		throw new Error("linear_create_issue requires teamId or team_id");
	}
	const output: LinearCreateIssueInput = { teamId, title: input.title };
	if (input.description !== undefined) output.description = input.description;
	const assigneeId = input.assigneeId ?? input.assignee_id;
	if (assigneeId !== undefined) output.assigneeId = assigneeId;
	const projectId = input.projectId ?? input.project_id;
	if (projectId !== undefined) output.projectId = projectId;
	const stateId = input.stateId ?? input.state_id;
	if (stateId !== undefined) output.stateId = stateId;
	if (input.priority !== undefined) output.priority = input.priority;
	const labelIds = input.labelIds ?? input.label_ids;
	if (labelIds !== undefined) output.labelIds = labelIds;
	return output;
}

function normalizeLinearLinkToolInput(input: LinearLinkToolInput, defaultSessionId: string): CreateLinearLinkInput {
	const issueId = input.issueId ?? input.issue_id;
	if (issueId === undefined || issueId.trim().length === 0) {
		throw new Error("linear_link requires issueId or issue_id");
	}
	const output: CreateLinearLinkInput = { issueId };
	const sessionId = input.sessionId ?? input.session_id;
	const taskId = input.taskId ?? input.task_id;
	if (sessionId !== undefined) output.sessionId = sessionId;
	if (taskId !== undefined) output.taskId = taskId;
	if (output.sessionId === undefined && output.taskId === undefined) output.sessionId = defaultSessionId;
	if (input.note !== undefined) output.note = input.note;
	return output;
}

function normalizeTaskCreateToolInput(input: TaskCreateToolInput, defaultSessionId: string): TaskCreateToolInput {
	const output: TaskCreateToolInput = { ...input };
	if (output.sessionId === undefined) output.sessionId = input.session_id ?? defaultSessionId;
	if (output.linearIssue === undefined && input.linear_issue !== undefined) output.linearIssue = input.linear_issue;
	return output;
}

function normalizeMemoryRememberToolInput(input: MemoryRememberToolInput, cwd: string): RememberMemoryInput {
	const subjectId = input.subjectId ?? input.subject_id ?? cwd;
	const output: RememberMemoryInput = {
		scope: input.scope ?? "project",
		subjectId,
		type: input.type ?? "fact",
		claim: input.claim,
	};
	if (input.confirmed !== undefined) output.confirmed = input.confirmed;
	const sourceEventIds = input.sourceEventIds ?? input.source_event_ids;
	if (sourceEventIds !== undefined) output.sourceEventIds = sourceEventIds;
	const sourceText = input.sourceText ?? input.source_text ?? input.claim;
	if (sourceText !== undefined) {
		output.source = {
			scope: output.scope ?? "project",
			subjectId,
			source: "agent",
			text: sourceText,
		};
	}
	if (input.confidence !== undefined) output.confidence = input.confidence;
	if (input.sensitivity !== undefined) output.sensitivity = input.sensitivity;
	const ttlDays = input.ttlDays ?? input.ttl_days;
	if (ttlDays !== undefined) output.ttlDays = ttlDays;
	return output;
}

function normalizeMemorySearchToolInput(input: MemorySearchToolInput, cwd: string): MemorySearchOptions {
	const output: MemorySearchOptions = {
		scope: input.scope ?? "project",
		subjectId: input.subjectId ?? input.subject_id ?? cwd,
	};
	const query = input.query ?? input.q;
	if (query !== undefined) output.query = query;
	if (input.limit !== undefined) output.limit = input.limit;
	return output;
}

function normalizeMemoryForgetToolInput(input: MemoryForgetToolInput): ForgetMemoryInput {
	const output: ForgetMemoryInput = {};
	if (input.id !== undefined) output.id = input.id;
	if (input.scope !== undefined) output.scope = input.scope;
	const subjectId = input.subjectId ?? input.subject_id;
	if (subjectId !== undefined) output.subjectId = subjectId;
	return output;
}

function toolResult(details: unknown): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: JSON.stringify(details ?? null, null, "\t") }],
		details,
	};
}
