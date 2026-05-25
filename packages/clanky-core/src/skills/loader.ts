import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type LoadSkillsResult, loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import type { ClankyPaths } from "../paths.js";

export interface LoadClankySkillsOptions {
	paths: ClankyPaths;
	bundledSkillsDir?: string;
}

export interface CreateClankySkillInput {
	name: string;
	description?: string;
	body?: string;
}

export interface ClankySkillMutationResult {
	name: string;
	filePath: string;
}

export function defaultBundledSkillsDir(): string {
	return fileURLToPath(new URL("../../../../agents/clanky/skills", import.meta.url));
}

export function loadClankySkills(options: LoadClankySkillsOptions): LoadSkillsResult {
	const bundledDir = options.bundledSkillsDir ?? defaultBundledSkillsDir();
	const loaded = [
		loadSkillsIfPresent(bundledDir, "clanky:bundled"),
		loadSkillsIfPresent(options.paths.skillsDir, "clanky:user"),
		loadSkillsIfPresent(options.paths.profileSkillsDir, "clanky:profile"),
	];
	const skillsByName = new Map<string, Skill>();
	for (const result of loaded) {
		for (const skill of result.skills) skillsByName.set(skill.name, skill);
	}
	return {
		skills: [...skillsByName.values()],
		diagnostics: loaded.flatMap((result) => result.diagnostics),
	};
}

export async function createProfileSkill(
	paths: ClankyPaths,
	input: CreateClankySkillInput,
): Promise<ClankySkillMutationResult> {
	const name = validateSkillName(input.name);
	const skillDir = join(paths.profileSkillsDir, name);
	const filePath = join(skillDir, "SKILL.md");
	const description = input.description?.trim() || `User-defined Clanky skill ${name}.`;
	const body = input.body?.trim() || "Add instructions for when and how to use this skill.";
	const content = [
		"---",
		`name: ${yamlString(name)}`,
		`description: ${yamlString(description)}`,
		`when_to_use: ${yamlString(description)}`,
		"allowed_tools: []",
		"deps: []",
		"---",
		"",
		`# ${skillTitle(name)}`,
		"",
		body,
		"",
	].join("\n");
	await mkdir(paths.profileSkillsDir, { recursive: true, mode: 0o700 });
	await mkdir(skillDir, { recursive: false, mode: 0o700 });
	await writeFile(filePath, content, { flag: "wx", mode: 0o600 });
	return { name, filePath };
}

export async function removeProfileSkill(
	paths: ClankyPaths,
	name: string,
): Promise<ClankySkillMutationResult | undefined> {
	const validName = validateSkillName(name);
	const skillDir = join(paths.profileSkillsDir, validName);
	const filePath = join(skillDir, "SKILL.md");
	const exists = await stat(filePath)
		.then((stats) => stats.isFile())
		.catch(() => false);
	if (!exists) return undefined;
	await rm(skillDir, { recursive: true });
	return { name: validName, filePath };
}

function loadSkillsIfPresent(dir: string, source: string): LoadSkillsResult {
	if (!existsSync(dir)) return { skills: [], diagnostics: [] };
	return loadSkillsFromDir({ dir, source });
}

export function validateSkillName(name: string): string {
	const trimmed = name.trim();
	if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
		throw new Error("Skill name may only contain letters, numbers, dot, underscore, and dash");
	}
	return trimmed;
}

function skillTitle(name: string): string {
	return name
		.split(/[-_.]+/)
		.filter((part) => part.length > 0)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

function yamlString(value: string): string {
	return JSON.stringify(value.replaceAll(/\s+/g, " ").trim());
}
