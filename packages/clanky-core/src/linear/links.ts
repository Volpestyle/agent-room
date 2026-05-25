import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { ClankyPaths } from "../paths.js";

export interface CreateLinearLinkInput {
	issueId: string;
	sessionId?: string;
	taskId?: string;
	note?: string;
}

export interface LinearLink {
	id: string;
	issueId: string;
	createdAt: string;
	updatedAt: string;
	sessionId?: string;
	taskId?: string;
	note?: string;
}

interface LinearLinksFile {
	links: LinearLink[];
}

export class LinearLinkStore {
	private readonly paths: ClankyPaths;

	constructor(paths: ClankyPaths) {
		this.paths = paths;
	}

	async list(): Promise<LinearLink[]> {
		const file = await this.readFile();
		return file.links.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async link(input: CreateLinearLinkInput, now = new Date()): Promise<LinearLink> {
		const normalized = normalizeLinearLinkInput(input);
		const file = await this.readFile();
		const existing = file.links.find(
			(link) =>
				link.issueId === normalized.issueId &&
				link.sessionId === normalized.sessionId &&
				link.taskId === normalized.taskId,
		);
		const timestamp = now.toISOString();
		if (existing !== undefined) {
			existing.updatedAt = timestamp;
			if (normalized.note !== undefined) existing.note = normalized.note;
			await this.writeFile(file);
			return existing;
		}

		const link: LinearLink = {
			id: randomUUID(),
			issueId: normalized.issueId,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		if (normalized.sessionId !== undefined) link.sessionId = normalized.sessionId;
		if (normalized.taskId !== undefined) link.taskId = normalized.taskId;
		if (normalized.note !== undefined) link.note = normalized.note;
		file.links.push(link);
		await this.writeFile(file);
		return link;
	}

	private async readFile(): Promise<LinearLinksFile> {
		await mkdir(this.paths.linearDir, { recursive: true, mode: 0o700 });
		try {
			const content = await readFile(this.paths.linearLinksFile, "utf8");
			const parsed = JSON.parse(content) as unknown;
			if (!isLinearLinksFile(parsed)) throw new Error(`Invalid Linear links file: ${this.paths.linearLinksFile}`);
			return { links: parsed.links };
		} catch (error) {
			if (isNotFoundError(error)) return { links: [] };
			throw error;
		}
	}

	private async writeFile(file: LinearLinksFile): Promise<void> {
		await mkdir(this.paths.linearDir, { recursive: true, mode: 0o700 });
		const tempFile = `${this.paths.linearLinksFile}.${process.pid}.tmp`;
		await writeFile(tempFile, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
		await rename(tempFile, this.paths.linearLinksFile);
	}
}

function normalizeLinearLinkInput(input: CreateLinearLinkInput): CreateLinearLinkInput {
	const issueId = input.issueId.trim();
	if (issueId.length === 0) throw new Error("Linear issue id must be a non-empty string");
	const sessionId = input.sessionId?.trim();
	const taskId = input.taskId?.trim();
	if (!sessionId && !taskId) throw new Error("Linear link requires a sessionId or taskId");
	const normalized: CreateLinearLinkInput = { issueId };
	if (sessionId) normalized.sessionId = sessionId;
	if (taskId) normalized.taskId = taskId;
	const note = input.note?.trim();
	if (note) normalized.note = note;
	return normalized;
}

function isLinearLinksFile(value: unknown): value is LinearLinksFile {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return Array.isArray(candidate.links) && candidate.links.every(isLinearLink);
}

function isLinearLink(value: unknown): value is LinearLink {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.issueId === "string" &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.updatedAt === "string"
	);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
