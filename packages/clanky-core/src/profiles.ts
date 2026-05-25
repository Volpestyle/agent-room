import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_PROFILE = "default";

export interface ProfileSummary {
	name: string;
	active: boolean;
	profileDir: string;
}

export function activeProfileFile(homeDir: string): string {
	return join(homeDir, ".profile");
}

export function validateProfileName(profile: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
		throw new Error(
			"Profile names must be 1-64 characters and contain only letters, numbers, dots, dashes, or underscores",
		);
	}
}

export function readActiveProfileName(homeDir: string): string | undefined {
	try {
		const profile = readFileSync(activeProfileFile(homeDir), "utf8").trim();
		if (!profile) return undefined;
		validateProfileName(profile);
		return profile;
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw error;
	}
}

export async function listProfiles(homeDir: string): Promise<ProfileSummary[]> {
	const profilesDir = join(homeDir, "profiles");
	const active = readActiveProfileName(homeDir) ?? DEFAULT_PROFILE;
	const entries = await readdir(profilesDir, { withFileTypes: true }).catch(() => []);
	const names = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
	names.add(DEFAULT_PROFILE);
	names.add(active);
	return [...names]
		.sort((a, b) => a.localeCompare(b))
		.map((name) => ({
			name,
			active: name === active,
			profileDir: join(profilesDir, name),
		}));
}

export async function createProfile(homeDir: string, profile: string): Promise<ProfileSummary> {
	validateProfileName(profile);
	const profileDir = join(homeDir, "profiles", profile);
	await mkdir(profileDir, { recursive: true, mode: 0o700 });
	const active = readActiveProfileName(homeDir) ?? DEFAULT_PROFILE;
	return { name: profile, active: profile === active, profileDir };
}

export async function useProfile(homeDir: string, profile: string): Promise<ProfileSummary> {
	validateProfileName(profile);
	const profileDir = join(homeDir, "profiles", profile);
	if (!existsSync(profileDir)) {
		await mkdir(profileDir, { recursive: true, mode: 0o700 });
	}
	await mkdir(homeDir, { recursive: true, mode: 0o700 });
	await writeFile(activeProfileFile(homeDir), `${profile}\n`, { mode: 0o600 });
	return { name: profile, active: true, profileDir };
}

export async function getActiveProfile(homeDir: string): Promise<string> {
	try {
		const profile = (await readFile(activeProfileFile(homeDir), "utf8")).trim();
		if (!profile) return DEFAULT_PROFILE;
		validateProfileName(profile);
		return profile;
	} catch (error) {
		if (isNotFoundError(error)) return DEFAULT_PROFILE;
		throw error;
	}
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
