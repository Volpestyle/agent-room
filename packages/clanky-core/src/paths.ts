import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_PROFILE, readActiveProfileName, validateProfileName } from "./profiles.js";

export interface ResolveClankyPathsOptions {
	homeDir?: string;
	profile?: string;
}

export interface ClankyPaths {
	homeDir: string;
	profile: string;
	profileDir: string;
	activeProfileFile: string;
	sessionsDir: string;
	skillsDir: string;
	profileSkillsDir: string;
	skillUsageFile: string;
	memoryDir: string;
	selfMemoryFile: string;
	linearDir: string;
	linearLinksFile: string;
	linearOutboxFile: string;
	indexDbFile: string;
	cronDir: string;
	cronJobsFile: string;
	cronRunsFile: string;
	cronOutputsDir: string;
	cronTickLockFile: string;
	httpTokenFile: string;
	authFile: string;
	modelsFile: string;
	socketFile: string;
	daemonLockFile: string;
}

export function resolveClankyPaths(options: ResolveClankyPathsOptions = {}): ClankyPaths {
	const homeDir = resolve(options.homeDir ?? process.env.CLANKY_HOME ?? join(homedir(), ".clanky"));
	const profile = options.profile ?? process.env.CLANKY_PROFILE ?? readActiveProfileName(homeDir) ?? DEFAULT_PROFILE;
	validateProfileName(profile);
	const profileDir = join(homeDir, "profiles", profile);

	return {
		homeDir,
		profile,
		profileDir,
		activeProfileFile: join(homeDir, ".profile"),
		sessionsDir: join(profileDir, "sessions"),
		skillsDir: join(homeDir, "skills"),
		profileSkillsDir: join(profileDir, "skills"),
		skillUsageFile: join(profileDir, "skills", ".usage.json"),
		memoryDir: join(profileDir, "memory"),
		selfMemoryFile: join(profileDir, "SELF.md"),
		linearDir: join(profileDir, "linear"),
		linearLinksFile: join(profileDir, "linear", "links.json"),
		linearOutboxFile: join(profileDir, "linear", "outbox.json"),
		indexDbFile: join(profileDir, "index.db"),
		cronDir: join(profileDir, "cron"),
		cronJobsFile: join(profileDir, "cron", "jobs.json"),
		cronRunsFile: join(profileDir, "cron", "runs.json"),
		cronOutputsDir: join(profileDir, "cron", ".outputs"),
		cronTickLockFile: join(profileDir, "cron", ".tick.lock"),
		httpTokenFile: join(homeDir, ".token"),
		authFile: join(profileDir, "auth.json"),
		modelsFile: join(profileDir, "models.json"),
		socketFile: join(profileDir, ".sock"),
		daemonLockFile: join(profileDir, ".daemon.lock"),
	};
}
