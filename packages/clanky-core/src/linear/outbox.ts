import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { ClankyPaths } from "../paths.js";

export type LinearOutboxStatus = "pending" | "posted" | "skipped" | "error";
export type LinearOutboxKind = "cron_output" | "comment";

export interface CreateLinearOutboxEntryInput {
	issueId: string;
	body: string;
	kind?: LinearOutboxKind;
	outputFile?: string;
	jobId?: string;
	sessionId?: string;
	taskId?: string;
	note?: string;
}

export interface LinearOutboxEntry {
	id: string;
	issueId: string;
	kind: LinearOutboxKind;
	status: LinearOutboxStatus;
	body: string;
	createdAt: string;
	updatedAt: string;
	outputFile?: string;
	jobId?: string;
	sessionId?: string;
	taskId?: string;
	note?: string;
	postedAt?: string;
	commentId?: string;
	commentUrl?: string;
	error?: string;
	errorAt?: string;
}

export interface MarkLinearOutboxPostedInput {
	commentId: string;
	commentUrl?: string;
}

interface LinearOutboxFile {
	entries: LinearOutboxEntry[];
}

export class LinearOutboxStore {
	private readonly paths: ClankyPaths;

	constructor(paths: ClankyPaths) {
		this.paths = paths;
	}

	async list(): Promise<LinearOutboxEntry[]> {
		const file = await this.readFile();
		return file.entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async pending(): Promise<LinearOutboxEntry[]> {
		const entries = await this.list();
		return entries.filter((entry) => entry.status === "pending");
	}

	async add(input: CreateLinearOutboxEntryInput, now = new Date()): Promise<LinearOutboxEntry> {
		const normalized = normalizeLinearOutboxInput(input);
		const timestamp = now.toISOString();
		const entry: LinearOutboxEntry = {
			id: randomUUID(),
			issueId: normalized.issueId,
			kind: normalized.kind ?? "comment",
			status: "pending",
			body: normalized.body,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		if (normalized.outputFile !== undefined) entry.outputFile = normalized.outputFile;
		if (normalized.jobId !== undefined) entry.jobId = normalized.jobId;
		if (normalized.sessionId !== undefined) entry.sessionId = normalized.sessionId;
		if (normalized.taskId !== undefined) entry.taskId = normalized.taskId;
		if (normalized.note !== undefined) entry.note = normalized.note;

		const file = await this.readFile();
		file.entries.push(entry);
		await this.writeFile(file);
		return entry;
	}

	async markPosted(entryId: string, input: MarkLinearOutboxPostedInput, now = new Date()): Promise<LinearOutboxEntry> {
		return await this.updateEntry(entryId, (entry) => {
			const timestamp = now.toISOString();
			entry.status = "posted";
			entry.updatedAt = timestamp;
			entry.postedAt = timestamp;
			entry.commentId = input.commentId;
			if (input.commentUrl !== undefined) entry.commentUrl = input.commentUrl;
			delete entry.error;
			delete entry.errorAt;
		});
	}

	async markError(entryId: string, error: string, now = new Date()): Promise<LinearOutboxEntry> {
		return await this.updateEntry(entryId, (entry) => {
			const timestamp = now.toISOString();
			entry.status = "error";
			entry.updatedAt = timestamp;
			entry.error = error;
			entry.errorAt = timestamp;
		});
	}

	async markPending(entryId: string, now = new Date()): Promise<LinearOutboxEntry> {
		return await this.updateEntry(entryId, (entry) => {
			entry.status = "pending";
			entry.updatedAt = now.toISOString();
			delete entry.error;
			delete entry.errorAt;
		});
	}

	private async updateEntry(entryId: string, update: (entry: LinearOutboxEntry) => void): Promise<LinearOutboxEntry> {
		const file = await this.readFile();
		const entry = file.entries.find((candidate) => candidate.id === entryId);
		if (entry === undefined) throw new Error(`Unknown Linear outbox entry: ${entryId}`);
		update(entry);
		await this.writeFile(file);
		return entry;
	}

	private async readFile(): Promise<LinearOutboxFile> {
		await mkdir(this.paths.linearDir, { recursive: true, mode: 0o700 });
		try {
			const content = await readFile(this.paths.linearOutboxFile, "utf8");
			const parsed = JSON.parse(content) as unknown;
			if (!isLinearOutboxFile(parsed)) throw new Error(`Invalid Linear outbox file: ${this.paths.linearOutboxFile}`);
			return { entries: parsed.entries };
		} catch (error) {
			if (isNotFoundError(error)) return { entries: [] };
			throw error;
		}
	}

	private async writeFile(file: LinearOutboxFile): Promise<void> {
		await mkdir(this.paths.linearDir, { recursive: true, mode: 0o700 });
		const tempFile = `${this.paths.linearOutboxFile}.${process.pid}.tmp`;
		await writeFile(tempFile, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
		await rename(tempFile, this.paths.linearOutboxFile);
	}
}

function normalizeLinearOutboxInput(input: CreateLinearOutboxEntryInput): CreateLinearOutboxEntryInput {
	const issueId = input.issueId.trim();
	if (issueId.length === 0) throw new Error("Linear issue id must be a non-empty string");
	const body = input.body.trim();
	if (body.length === 0) throw new Error("Linear outbox body must be a non-empty string");
	const normalized: CreateLinearOutboxEntryInput = { issueId, body };
	if (input.kind !== undefined) normalized.kind = input.kind;
	const outputFile = input.outputFile?.trim();
	if (outputFile) normalized.outputFile = outputFile;
	const jobId = input.jobId?.trim();
	if (jobId) normalized.jobId = jobId;
	const sessionId = input.sessionId?.trim();
	if (sessionId) normalized.sessionId = sessionId;
	const taskId = input.taskId?.trim();
	if (taskId) normalized.taskId = taskId;
	const note = input.note?.trim();
	if (note) normalized.note = note;
	return normalized;
}

function isLinearOutboxFile(value: unknown): value is LinearOutboxFile {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return Array.isArray(candidate.entries) && candidate.entries.every(isLinearOutboxEntry);
}

function isLinearOutboxEntry(value: unknown): value is LinearOutboxEntry {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.issueId === "string" &&
		typeof candidate.kind === "string" &&
		typeof candidate.status === "string" &&
		typeof candidate.body === "string" &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.updatedAt === "string"
	);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
