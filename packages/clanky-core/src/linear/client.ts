export interface LinearClientOptions {
	apiKey?: string;
	accessToken?: string;
	endpoint?: string;
	fetchFn?: typeof fetch;
}

export interface LinearPostCommentInput {
	id?: string;
	issueId: string;
	body: string;
}

export interface LinearCreateIssueInput {
	teamId: string;
	title: string;
	description?: string;
	assigneeId?: string;
	projectId?: string;
	stateId?: string;
	priority?: number;
	labelIds?: string[];
}

export interface LinearPostCommentResult {
	commentId: string;
	issueId: string;
	issueIdentifier?: string;
	url?: string;
}

export interface LinearCreateIssueResult {
	issueId: string;
	identifier: string;
	title: string;
	url?: string;
	teamId?: string;
}

interface GraphQLResponse {
	data?: unknown;
	errors?: Array<{ message?: string }>;
}

const DEFAULT_LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

const COMMENT_CREATE_MUTATION = `
	mutation CommentCreate($input: CommentCreateInput!) {
		commentCreate(input: $input) {
			success
			comment {
				id
				url
				issue {
					id
					identifier
				}
			}
		}
	}
`;

const ISSUE_CREATE_MUTATION = `
	mutation IssueCreate($input: IssueCreateInput!) {
		issueCreate(input: $input) {
			success
			issue {
				id
				identifier
				title
				url
				team {
					id
				}
			}
		}
	}
`;

export class LinearClient {
	private readonly authorization: string;
	private readonly endpoint: string;
	private readonly fetchFn: typeof fetch;

	constructor(options: LinearClientOptions = {}) {
		const authorization = linearAuthorization(options);
		if (authorization === undefined) {
			throw new Error("Linear delivery requires LINEAR_API_KEY or LINEAR_ACCESS_TOKEN");
		}
		this.authorization = authorization;
		this.endpoint = options.endpoint ?? DEFAULT_LINEAR_GRAPHQL_ENDPOINT;
		this.fetchFn = options.fetchFn ?? fetch;
	}

	static fromEnv(env: NodeJS.ProcessEnv = process.env, options: LinearClientOptions = {}): LinearClient {
		const input: LinearClientOptions = {};
		const apiKey = options.apiKey ?? env.LINEAR_API_KEY;
		if (apiKey !== undefined) input.apiKey = apiKey;
		const accessToken = options.accessToken ?? env.LINEAR_ACCESS_TOKEN;
		if (accessToken !== undefined) input.accessToken = accessToken;
		const endpoint = options.endpoint ?? env.LINEAR_GRAPHQL_ENDPOINT;
		if (endpoint !== undefined) input.endpoint = endpoint;
		if (options.fetchFn !== undefined) input.fetchFn = options.fetchFn;
		return new LinearClient(input);
	}

	async createIssue(input: LinearCreateIssueInput): Promise<LinearCreateIssueResult> {
		const variablesInput = normalizeCreateIssueInput(input);
		const parsed = await this.request(ISSUE_CREATE_MUTATION, { input: variablesInput });
		return readIssueCreatePayload(parsed.data);
	}

	async postComment(input: LinearPostCommentInput): Promise<LinearPostCommentResult> {
		const variablesInput: Record<string, string> = {
			issueId: input.issueId,
			body: input.body,
		};
		if (input.id !== undefined) variablesInput.id = input.id;
		const parsed = await this.request(COMMENT_CREATE_MUTATION, { input: variablesInput });
		return readCommentCreatePayload(parsed.data);
	}

	private async request(query: string, variables: Record<string, unknown>): Promise<GraphQLResponse> {
		const response = await this.fetchFn(this.endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: this.authorization,
			},
			body: JSON.stringify({ query, variables }),
		});
		const responseText = await response.text();
		if (!response.ok) throw new Error(`Linear API returned HTTP ${response.status}: ${responseText}`);
		const parsed = parseGraphQLResponse(responseText);
		if (parsed.errors !== undefined && parsed.errors.length > 0) {
			throw new Error(`Linear API error: ${parsed.errors.map((error) => error.message ?? "unknown").join("; ")}`);
		}
		return parsed;
	}
}

export function hasLinearCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
	return nonEmpty(env.LINEAR_API_KEY) || nonEmpty(env.LINEAR_ACCESS_TOKEN);
}

function linearAuthorization(options: LinearClientOptions): string | undefined {
	if (options.accessToken !== undefined && options.accessToken.trim().length > 0) {
		return `Bearer ${options.accessToken.trim()}`;
	}
	if (options.apiKey !== undefined && options.apiKey.trim().length > 0) return options.apiKey.trim();
	return undefined;
}

function nonEmpty(value: string | undefined): boolean {
	return value !== undefined && value.trim().length > 0;
}

function normalizeCreateIssueInput(input: LinearCreateIssueInput): Record<string, unknown> {
	const teamId = input.teamId.trim();
	const title = input.title.trim();
	if (teamId.length === 0) throw new Error("Linear issue create teamId must be a non-empty string");
	if (title.length === 0) throw new Error("Linear issue create title must be a non-empty string");
	const normalized: Record<string, unknown> = { teamId, title };
	addTrimmedProperty(normalized, "description", input.description);
	addTrimmedProperty(normalized, "assigneeId", input.assigneeId);
	addTrimmedProperty(normalized, "projectId", input.projectId);
	addTrimmedProperty(normalized, "stateId", input.stateId);
	if (input.priority !== undefined) {
		if (!Number.isInteger(input.priority)) throw new Error("Linear issue priority must be an integer");
		normalized.priority = input.priority;
	}
	if (input.labelIds !== undefined) {
		const labelIds = input.labelIds.map((labelId) => labelId.trim()).filter((labelId) => labelId.length > 0);
		if (labelIds.length > 0) normalized.labelIds = labelIds;
	}
	return normalized;
}

function addTrimmedProperty(target: Record<string, unknown>, key: string, value: string | undefined): void {
	const trimmed = value?.trim();
	if (trimmed !== undefined && trimmed.length > 0) target[key] = trimmed;
}

function parseGraphQLResponse(text: string): GraphQLResponse {
	const parsed = JSON.parse(text) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Linear API returned an invalid GraphQL response");
	}
	const candidate = parsed as Record<string, unknown>;
	const result: GraphQLResponse = {};
	if (candidate.data !== undefined) result.data = candidate.data;
	if (Array.isArray(candidate.errors)) {
		result.errors = candidate.errors.map((error) => {
			if (typeof error !== "object" || error === null) return {};
			const message = (error as Record<string, unknown>).message;
			return typeof message === "string" ? { message } : {};
		});
	}
	return result;
}

function readIssueCreatePayload(data: unknown): LinearCreateIssueResult {
	const issueCreate = readObject(readObject(data, "issueCreate"), undefined);
	const success = issueCreate?.success;
	if (success !== true) throw new Error("Linear issueCreate did not report success");
	const issue = readObject(issueCreate, "issue");
	const issueId = readString(issue, "id");
	if (issueId === undefined) throw new Error("Linear issueCreate response did not include issue id");
	const identifier = readString(issue, "identifier");
	if (identifier === undefined) throw new Error("Linear issueCreate response did not include identifier");
	const title = readString(issue, "title");
	if (title === undefined) throw new Error("Linear issueCreate response did not include title");
	const result: LinearCreateIssueResult = { issueId, identifier, title };
	const url = readString(issue, "url");
	if (url !== undefined) result.url = url;
	const teamId = readString(readObject(issue, "team"), "id");
	if (teamId !== undefined) result.teamId = teamId;
	return result;
}

function readCommentCreatePayload(data: unknown): LinearPostCommentResult {
	const commentCreate = readObject(readObject(data, "commentCreate"), undefined);
	const success = commentCreate?.success;
	if (success !== true) throw new Error("Linear commentCreate did not report success");
	const comment = readObject(commentCreate, "comment");
	const commentId = readString(comment, "id");
	if (commentId === undefined) throw new Error("Linear commentCreate response did not include comment id");
	const issue = readObject(comment, "issue");
	const issueId = readString(issue, "id");
	if (issueId === undefined) throw new Error("Linear commentCreate response did not include issue id");
	const result: LinearPostCommentResult = { commentId, issueId };
	const issueIdentifier = readString(issue, "identifier");
	if (issueIdentifier !== undefined) result.issueIdentifier = issueIdentifier;
	const url = readString(comment, "url");
	if (url !== undefined) result.url = url;
	return result;
}

function readObject(value: unknown, key: string | undefined): Record<string, unknown> | undefined {
	const target = key === undefined ? value : readObject(value, undefined)?.[key];
	if (typeof target !== "object" || target === null || Array.isArray(target)) return undefined;
	return target as Record<string, unknown>;
}

function readString(value: Record<string, unknown> | undefined, key: string): string | undefined {
	const result = value?.[key];
	return typeof result === "string" ? result : undefined;
}
