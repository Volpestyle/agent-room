import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	type FileEntry,
	parseSessionEntries,
	type SessionHeader,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { ClankyPaths } from "../paths.js";

export type SessionIndexRole = "user" | "assistant" | "toolResult";

export interface SessionIndexMessageInput {
	sessionId: string;
	role: SessionIndexRole;
	text: string;
	cwd: string;
	createdAt?: string;
	sessionFile?: string;
	messageKey?: string;
}

export interface SessionSearchResult {
	sessionId: string;
	role: SessionIndexRole;
	text: string;
	snippet: string;
	cwd: string;
	createdAt: string;
	sessionFile?: string;
	messageKey?: string;
}

export interface SessionSearchOptions {
	query: string;
	limit?: number;
}

export interface CronIdempotencyRunRecord {
	key: string;
	jobId: string;
	recordedAt: string;
}

export type ClankyTaskStatus = "open" | "in_progress" | "done" | "cancelled";
export type ClankyTaskPriority = "low" | "normal" | "high";

export interface CreateClankyTaskInput {
	title: string;
	description?: string;
	status?: ClankyTaskStatus;
	priority?: ClankyTaskPriority;
	sessionId?: string;
	linearIssue?: string;
	source?: string;
}

export interface UpdateClankyTaskInput {
	id: string;
	title?: string;
	description?: string;
	status?: ClankyTaskStatus;
	priority?: ClankyTaskPriority;
	sessionId?: string;
	linearIssue?: string;
	source?: string;
}

export interface ClankyTask {
	id: string;
	title: string;
	status: ClankyTaskStatus;
	priority: ClankyTaskPriority;
	createdAt: string;
	updatedAt: string;
	description?: string;
	sessionId?: string;
	linearIssue?: string;
	source?: string;
}

export interface ListClankyTasksOptions {
	sessionId?: string;
	linearIssue?: string;
	status?: ClankyTaskStatus;
	priority?: ClankyTaskPriority;
	limit?: number;
}

type DatabaseSyncConstructor = new (path: string) => DatabaseSync;
type WarningConstructor = NonNullable<NodeJS.EmitWarningOptions["ctor"]>;
type EmitWarningFunction = (
	warning: string | Error,
	optionsOrType?: string | NodeJS.EmitWarningOptions | WarningConstructor,
	codeOrCtor?: string | WarningConstructor,
	ctor?: WarningConstructor,
) => void;

const require = createRequire(import.meta.url);
let DatabaseSyncClass: DatabaseSyncConstructor | undefined;

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;

export class SessionIndexStore {
	private readonly paths: ClankyPaths;
	private db: DatabaseSync | undefined;

	constructor(paths: ClankyPaths) {
		this.paths = paths;
	}

	async recordMessage(input: SessionIndexMessageInput): Promise<void> {
		const text = input.text.trim();
		if (text.length === 0) return;
		await this.ensure();
		const db = this.database();
		const createdAt = input.createdAt ?? new Date().toISOString();
		const messageKey = input.messageKey ?? stableMessageKey(input.sessionId, input.role, createdAt, text);
		db.prepare(`
			INSERT OR IGNORE INTO sessions (session_id, cwd, session_file, updated_at)
			VALUES (?, ?, ?, ?)
		`).run(input.sessionId, input.cwd, input.sessionFile ?? null, createdAt);
		db.prepare(`
			UPDATE sessions
			SET cwd = ?, session_file = COALESCE(?, session_file), updated_at = ?
			WHERE session_id = ?
		`).run(input.cwd, input.sessionFile ?? null, createdAt, input.sessionId);
		db.prepare(`
			INSERT OR IGNORE INTO session_messages (
				message_key,
				session_id,
				role,
				text,
				session_file,
				cwd,
				created_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(messageKey, input.sessionId, input.role, text, input.sessionFile ?? null, input.cwd, createdAt);
	}

	async indexSessionFile(sessionFile: string): Promise<number> {
		const content = await readFile(sessionFile, "utf8").catch(() => undefined);
		if (content === undefined) return 0;
		const entries = parseSessionEntries(content);
		const header = entries.find(isSessionHeader);
		const sessionId = header?.id ?? extractSessionId(sessionFile);
		if (sessionId === undefined) return 0;
		const cwd = header?.cwd ?? "";
		let indexed = 0;
		for (const entry of entries) {
			if (!isSessionMessageEntry(entry)) continue;
			const extracted = extractIndexableMessageText(entry.message);
			if (extracted === undefined) continue;
			await this.recordMessage({
				sessionId,
				role: extracted.role,
				text: extracted.text,
				cwd,
				createdAt: entry.timestamp,
				sessionFile,
				messageKey: `${sessionId}:${entry.id}`,
			});
			indexed += 1;
		}
		return indexed;
	}

	async indexSessionDirectory(sessionDir: string): Promise<number> {
		const files = await readdir(sessionDir).catch(() => []);
		let indexed = 0;
		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			indexed += await this.indexSessionFile(join(sessionDir, file));
		}
		return indexed;
	}

	async search(options: SessionSearchOptions): Promise<SessionSearchResult[]> {
		const query = options.query.trim();
		if (query.length === 0) return [];
		await this.ensure();
		const db = this.database();
		const limit = normalizedLimit(options.limit);
		try {
			const rows = db
				.prepare(`
					SELECT
						session_id,
						role,
						text,
						snippet(session_messages_fts, 2, '', '', '...', 18) AS snippet,
						session_file,
						cwd,
						created_at,
						message_key
					FROM session_messages_fts
					WHERE session_messages_fts MATCH ?
					ORDER BY bm25(session_messages_fts)
					LIMIT ?
				`)
				.all(buildFtsQuery(query), limit);
			return rows.map(readSearchRow).filter((row): row is SessionSearchResult => row !== undefined);
		} catch {
			const rows = db
				.prepare(`
					SELECT
						session_id,
						role,
						text,
						text AS snippet,
						session_file,
						cwd,
						created_at,
						message_key
					FROM session_messages
					WHERE lower(text) LIKE ?
					ORDER BY created_at DESC
					LIMIT ?
				`)
				.all(`%${query.toLowerCase()}%`, limit);
			return rows.map(readSearchRow).filter((row): row is SessionSearchResult => row !== undefined);
		}
	}

	async createTask(input: CreateClankyTaskInput): Promise<ClankyTask> {
		await this.ensure();
		const title = input.title.trim();
		if (title.length === 0) throw new Error("Task title is required");
		const now = new Date().toISOString();
		const id = randomUUID();
		const description = optionalTrimmedString(input.description);
		const sessionId = optionalTrimmedString(input.sessionId);
		const linearIssue = optionalTrimmedString(input.linearIssue);
		const source = optionalTrimmedString(input.source);
		const status = input.status ?? "open";
		const priority = input.priority ?? "normal";
		this.database()
			.prepare(`
				INSERT INTO tasks (
					id,
					title,
					description,
					status,
					priority,
					session_id,
					linear_issue,
					source,
					created_at,
					updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`)
			.run(
				id,
				title,
				description ?? null,
				status,
				priority,
				sessionId ?? null,
				linearIssue ?? null,
				source ?? null,
				now,
				now,
			);
		return {
			id,
			title,
			status,
			priority,
			createdAt: now,
			updatedAt: now,
			...(description === undefined ? {} : { description }),
			...(sessionId === undefined ? {} : { sessionId }),
			...(linearIssue === undefined ? {} : { linearIssue }),
			...(source === undefined ? {} : { source }),
		};
	}

	async listTasks(options: ListClankyTasksOptions = {}): Promise<ClankyTask[]> {
		await this.ensure();
		const conditions: string[] = [];
		const params: Array<number | string> = [];
		const sessionId = optionalTrimmedString(options.sessionId);
		const linearIssue = optionalTrimmedString(options.linearIssue);
		if (sessionId !== undefined) {
			conditions.push("session_id = ?");
			params.push(sessionId);
		}
		if (linearIssue !== undefined) {
			conditions.push("linear_issue = ?");
			params.push(linearIssue);
		}
		if (options.status !== undefined) {
			conditions.push("status = ?");
			params.push(options.status);
		}
		if (options.priority !== undefined) {
			conditions.push("priority = ?");
			params.push(options.priority);
		}
		params.push(normalizedLimit(options.limit));
		const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
		const rows = this.database()
			.prepare(`
				SELECT
					id,
					title,
					description,
					status,
					priority,
					session_id,
					linear_issue,
					source,
					created_at,
					updated_at
				FROM tasks
				${where}
				ORDER BY updated_at DESC
				LIMIT ?
			`)
			.all(...params);
		return rows.map(readTaskRow).filter((row): row is ClankyTask => row !== undefined);
	}

	async updateTask(input: UpdateClankyTaskInput): Promise<ClankyTask | undefined> {
		await this.ensure();
		const id = input.id.trim();
		if (id.length === 0) throw new Error("Task id is required");
		const assignments: string[] = [];
		const params: string[] = [];
		if (input.title !== undefined) {
			const title = input.title.trim();
			if (title.length === 0) throw new Error("Task title must be a non-empty string");
			assignments.push("title = ?");
			params.push(title);
		}
		if (input.description !== undefined) {
			const description = input.description.trim();
			if (description.length === 0) throw new Error("Task description must be a non-empty string");
			assignments.push("description = ?");
			params.push(description);
		}
		if (input.status !== undefined) {
			assignments.push("status = ?");
			params.push(input.status);
		}
		if (input.priority !== undefined) {
			assignments.push("priority = ?");
			params.push(input.priority);
		}
		if (input.sessionId !== undefined) {
			const sessionId = input.sessionId.trim();
			if (sessionId.length === 0) throw new Error("Task sessionId must be a non-empty string");
			assignments.push("session_id = ?");
			params.push(sessionId);
		}
		if (input.linearIssue !== undefined) {
			const linearIssue = input.linearIssue.trim();
			if (linearIssue.length === 0) throw new Error("Task linearIssue must be a non-empty string");
			assignments.push("linear_issue = ?");
			params.push(linearIssue);
		}
		if (input.source !== undefined) {
			const source = input.source.trim();
			if (source.length === 0) throw new Error("Task source must be a non-empty string");
			assignments.push("source = ?");
			params.push(source);
		}
		if (assignments.length === 0) throw new Error("Task update requires at least one field");
		const updatedAt = new Date().toISOString();
		assignments.push("updated_at = ?");
		params.push(updatedAt, id);
		this.database()
			.prepare(`
				UPDATE tasks
				SET ${assignments.join(", ")}
				WHERE id = ?
			`)
			.run(...params);
		const row = this.database()
			.prepare(`
				SELECT
					id,
					title,
					description,
					status,
					priority,
					session_id,
					linear_issue,
					source,
					created_at,
					updated_at
				FROM tasks
				WHERE id = ?
				LIMIT 1
			`)
			.get(id);
		return row === undefined ? undefined : readTaskRow(row);
	}

	async ensure(): Promise<void> {
		await mkdir(dirname(this.paths.indexDbFile), { recursive: true, mode: 0o700 });
		const db = this.database();
		db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA foreign_keys = ON;
			CREATE TABLE IF NOT EXISTS sessions (
				session_id TEXT PRIMARY KEY,
				cwd TEXT NOT NULL,
				session_file TEXT,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				message_key TEXT NOT NULL UNIQUE,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				text TEXT NOT NULL,
				session_file TEXT,
				cwd TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_session_messages_session_id
				ON session_messages (session_id);
			CREATE INDEX IF NOT EXISTS idx_session_messages_created_at
				ON session_messages (created_at);
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				description TEXT,
				status TEXT NOT NULL,
				priority TEXT NOT NULL,
				session_id TEXT,
				linear_issue TEXT,
				source TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_tasks_session_id
				ON tasks (session_id);
			CREATE INDEX IF NOT EXISTS idx_tasks_linear_issue
				ON tasks (linear_issue);
			CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
				session_id UNINDEXED,
				role UNINDEXED,
				text,
				session_file UNINDEXED,
				cwd UNINDEXED,
				created_at UNINDEXED,
				message_key UNINDEXED,
				tokenize = 'unicode61'
			);
			CREATE TRIGGER IF NOT EXISTS session_messages_ai
			AFTER INSERT ON session_messages
			BEGIN
				INSERT INTO session_messages_fts (
					session_id,
					role,
					text,
					session_file,
					cwd,
					created_at,
					message_key
				)
				VALUES (
					new.session_id,
					new.role,
					new.text,
					new.session_file,
					new.cwd,
					new.created_at,
					new.message_key
				);
			END;
		`);
	}

	close(): void {
		if (this.db === undefined) return;
		this.db.close();
		this.db = undefined;
	}

	private database(): DatabaseSync {
		if (this.db !== undefined) return this.db;
		const Database = loadDatabaseSync();
		this.db = new Database(this.paths.indexDbFile);
		return this.db;
	}
}

export class CronRunLedger {
	private readonly paths: ClankyPaths;
	private db: DatabaseSync | undefined;

	constructor(paths: ClankyPaths) {
		this.paths = paths;
	}

	async ensure(): Promise<void> {
		await mkdir(dirname(this.paths.indexDbFile), { recursive: true, mode: 0o700 });
		const db = this.database();
		db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS cron_runs (
				key TEXT PRIMARY KEY,
				job_id TEXT NOT NULL,
				recorded_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_cron_runs_job_id
				ON cron_runs (job_id);
		`);
	}

	async hasKey(key: string): Promise<boolean> {
		await this.ensure();
		const row = this.database().prepare("SELECT key FROM cron_runs WHERE key = ? LIMIT 1").get(cronRunKeyHash(key));
		return row !== undefined;
	}

	async recordKey(key: string, jobId: string, now = new Date()): Promise<void> {
		await this.ensure();
		const storedKey = cronRunKeyHash(key);
		this.database()
			.prepare(`
				INSERT OR IGNORE INTO cron_runs (
					key,
					job_id,
					recorded_at
				)
				VALUES (?, ?, ?)
			`)
			.run(storedKey, jobId, now.toISOString());
	}

	async list(): Promise<CronIdempotencyRunRecord[]> {
		await this.ensure();
		const rows = this.database()
			.prepare(`
				SELECT key, job_id, recorded_at
				FROM cron_runs
				ORDER BY recorded_at DESC
			`)
			.all();
		return rows.map(readCronRunRow).filter((row): row is CronIdempotencyRunRecord => row !== undefined);
	}

	close(): void {
		if (this.db === undefined) return;
		this.db.close();
		this.db = undefined;
	}

	private database(): DatabaseSync {
		if (this.db !== undefined) return this.db;
		const Database = loadDatabaseSync();
		this.db = new Database(this.paths.indexDbFile);
		return this.db;
	}
}

export function extractIndexableMessageText(message: SessionMessageEntry["message"]):
	| {
			role: SessionIndexRole;
			text: string;
	  }
	| undefined {
	if (message.role === "user") {
		const text = contentText(message.content).trim();
		return text.length === 0 ? undefined : { role: "user", text };
	}
	if (message.role === "assistant") {
		const text = contentText(message.content).trim();
		return text.length === 0 ? undefined : { role: "assistant", text };
	}
	if (message.role === "toolResult") {
		const text = contentText(message.content).trim();
		return text.length === 0 ? undefined : { role: "toolResult", text };
	}
	return undefined;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const candidate = block as Record<string, unknown>;
		if (candidate.type !== "text" || typeof candidate.text !== "string") continue;
		parts.push(candidate.text);
	}
	return parts.join("\n");
}

function loadDatabaseSync(): DatabaseSyncConstructor {
	if (DatabaseSyncClass !== undefined) return DatabaseSyncClass;
	return loadDatabaseSyncWithoutExperimentalWarning();
}

function loadDatabaseSyncWithoutExperimentalWarning(): DatabaseSyncConstructor {
	const originalEmitWarning = process.emitWarning as EmitWarningFunction;
	const filteredEmitWarning: EmitWarningFunction = (warning, optionsOrType, codeOrCtor, ctor) => {
		const message = typeof warning === "string" ? warning : warning.message;
		const type =
			typeof optionsOrType === "string"
				? optionsOrType
				: typeof optionsOrType === "object" && optionsOrType !== null
					? optionsOrType.type
					: undefined;
		if (message.includes("SQLite is an experimental feature") && type === "ExperimentalWarning") return;
		if (typeof optionsOrType === "function") {
			originalEmitWarning.call(process, warning, optionsOrType);
		} else if (typeof optionsOrType === "object") {
			originalEmitWarning.call(process, warning, optionsOrType);
		} else if (typeof codeOrCtor === "function") {
			originalEmitWarning.call(process, warning, optionsOrType, codeOrCtor);
		} else if (ctor !== undefined) {
			originalEmitWarning.call(process, warning, optionsOrType, codeOrCtor, ctor);
		} else if (codeOrCtor !== undefined) {
			originalEmitWarning.call(process, warning, optionsOrType, codeOrCtor);
		} else if (optionsOrType !== undefined) {
			originalEmitWarning.call(process, warning, optionsOrType);
		} else {
			originalEmitWarning.call(process, warning);
		}
	};
	process.emitWarning = filteredEmitWarning as typeof process.emitWarning;
	try {
		const sqlite = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };
		DatabaseSyncClass = sqlite.DatabaseSync;
		return DatabaseSyncClass;
	} finally {
		process.emitWarning = originalEmitWarning as typeof process.emitWarning;
	}
}

function buildFtsQuery(query: string): string {
	return query
		.split(/\s+/)
		.map((term) => `"${term.replaceAll('"', '""')}"`)
		.join(" AND ");
}

function normalizedLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
	if (!Number.isInteger(limit) || limit <= 0) return DEFAULT_SEARCH_LIMIT;
	return Math.min(limit, MAX_SEARCH_LIMIT);
}

function stableMessageKey(sessionId: string, role: SessionIndexRole, createdAt: string, text: string): string {
	const hash = createHash("sha256").update(text).digest("hex").slice(0, 32);
	return `${sessionId}:${role}:${createdAt}:${hash}`;
}

function cronRunKeyHash(key: string): string {
	return `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

function readSearchRow(row: Record<string, unknown>): SessionSearchResult | undefined {
	const sessionId = readString(row, "session_id");
	const role = readRole(row.role);
	const text = readString(row, "text");
	const cwd = readString(row, "cwd");
	const createdAt = readString(row, "created_at");
	if (
		sessionId === undefined ||
		role === undefined ||
		text === undefined ||
		cwd === undefined ||
		createdAt === undefined
	) {
		return undefined;
	}
	const result: SessionSearchResult = {
		sessionId,
		role,
		text,
		snippet: readString(row, "snippet") ?? text,
		cwd,
		createdAt,
	};
	const sessionFile = readString(row, "session_file");
	if (sessionFile !== undefined) result.sessionFile = sessionFile;
	const messageKey = readString(row, "message_key");
	if (messageKey !== undefined) result.messageKey = messageKey;
	return result;
}

function readCronRunRow(row: Record<string, unknown>): CronIdempotencyRunRecord | undefined {
	const key = readString(row, "key");
	const jobId = readString(row, "job_id");
	const recordedAt = readString(row, "recorded_at");
	if (key === undefined || jobId === undefined || recordedAt === undefined) return undefined;
	return { key, jobId, recordedAt };
}

function readTaskRow(row: Record<string, unknown>): ClankyTask | undefined {
	const id = readString(row, "id");
	const title = readString(row, "title");
	const status = readTaskStatus(row.status);
	const priority = readTaskPriority(row.priority);
	const createdAt = readString(row, "created_at");
	const updatedAt = readString(row, "updated_at");
	if (
		id === undefined ||
		title === undefined ||
		status === undefined ||
		priority === undefined ||
		createdAt === undefined ||
		updatedAt === undefined
	) {
		return undefined;
	}
	const task: ClankyTask = {
		id,
		title,
		status,
		priority,
		createdAt,
		updatedAt,
	};
	const description = readString(row, "description");
	if (description !== undefined) task.description = description;
	const sessionId = readString(row, "session_id");
	if (sessionId !== undefined) task.sessionId = sessionId;
	const linearIssue = readString(row, "linear_issue");
	if (linearIssue !== undefined) task.linearIssue = linearIssue;
	const source = readString(row, "source");
	if (source !== undefined) task.source = source;
	return task;
}

function readString(row: Record<string, unknown>, key: string): string | undefined {
	const value = row[key];
	return typeof value === "string" ? value : undefined;
}

function readRole(value: unknown): SessionIndexRole | undefined {
	if (value === "user" || value === "assistant" || value === "toolResult") return value;
	return undefined;
}

function readTaskStatus(value: unknown): ClankyTaskStatus | undefined {
	if (value === "open" || value === "in_progress" || value === "done" || value === "cancelled") return value;
	return undefined;
}

function readTaskPriority(value: unknown): ClankyTaskPriority | undefined {
	if (value === "low" || value === "normal" || value === "high") return value;
	return undefined;
}

function optionalTrimmedString(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function isSessionHeader(entry: FileEntry): entry is SessionHeader {
	return entry.type === "session";
}

function isSessionMessageEntry(entry: FileEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function extractSessionId(sessionFile: string): string | undefined {
	const name = sessionFile.slice(sessionFile.lastIndexOf("/") + 1);
	const withoutExtension = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
	const separator = withoutExtension.lastIndexOf("_");
	if (separator === -1) return undefined;
	return withoutExtension.slice(separator + 1);
}
