import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createClankyExtensionFactories,
	createClankyToolDefinitions,
	loadClankySkills,
	resolveClankyPaths,
} from "@clanky/core";
import {
	AuthStorage,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	InteractiveMode,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createClankyHandlers } from "./handlers.js";
import { loadPersona } from "./persona.js";
import { createClankyStores } from "./stores.js";

export interface RunClankyOptions {
	cwd?: string;
	homeDir?: string;
	profile?: string;
	initialMessage?: string;
}

/**
 * Resolve the @clanky/agent package root from this file's location.
 *
 * This module lives at `<package>/src/runClanky.ts`, so we pop the trailing
 * `/src` to get the package root that contains `persona/SELF.md`.
 */
function resolvePackageRoot(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return here.endsWith(`${"/"}src`) ? here.slice(0, -4) : here;
}

/**
 * Build the runtime factory clanky uses for every InteractiveMode session
 * (initial + later /new, /resume, /fork, /import).
 *
 * The factory closes over a single ClankyPaths + ClankyStores + persona
 * markdown so every recreated runtime sees the same agent identity, the same
 * sqlite/jsonl stores, and the same on-disk skills index.
 */
function buildRuntimeFactory(opts: {
	paths: ReturnType<typeof resolveClankyPaths>;
	personaMarkdown: string;
}): CreateAgentSessionRuntimeFactory {
	const { paths, personaMarkdown } = opts;
	const stores = createClankyStores(paths);
	const handlers = createClankyHandlers(paths, stores);

	return async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
		const authStorage = AuthStorage.create(paths.authFile);
		const modelRegistry = ModelRegistry.create(authStorage, paths.modelsFile);
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });

		const servicesOptions = {
			cwd: runtimeCwd,
			agentDir: paths.profileDir,
			authStorage,
			modelRegistry,
			settingsManager,
			resourceLoaderOptions: {
				extensionFactories: createClankyExtensionFactories(handlers),
				systemPromptOverride: (existing: string | undefined): string =>
					existing && existing.length > 0 ? `${existing}\n\n${personaMarkdown}` : personaMarkdown,
				skillsOverride: (current: ReturnType<typeof loadClankySkills>) => {
					const clankySkills = loadClankySkills({ paths });
					const byName = new Map<string, (typeof current.skills)[number]>();
					for (const skill of clankySkills.skills) byName.set(skill.name, skill);
					for (const skill of current.skills) byName.set(skill.name, skill);
					return {
						skills: [...byName.values()],
						diagnostics: [...current.diagnostics, ...clankySkills.diagnostics],
					};
				},
			},
		};

		const services = await createAgentSessionServices(servicesOptions);

		const fromServicesOptions: Parameters<typeof createAgentSessionFromServices>[0] = {
			services,
			sessionManager,
			customTools: createClankyToolDefinitions(handlers),
		};
		if (sessionStartEvent !== undefined) fromServicesOptions.sessionStartEvent = sessionStartEvent;

		const result = await createAgentSessionFromServices(fromServicesOptions);
		return { ...result, services, diagnostics: services.diagnostics };
	};
}

/**
 * Build (but do not start) the clanky AgentSessionRuntime. Exposed primarily
 * for smoke tests that want to assert wiring without needing a TTY.
 */
export async function createClankyRuntime(options: RunClankyOptions = {}) {
	const cwd = options.cwd ?? process.cwd();
	const pathsOptions: Parameters<typeof resolveClankyPaths>[0] = {};
	if (options.homeDir !== undefined) pathsOptions.homeDir = options.homeDir;
	if (options.profile !== undefined) pathsOptions.profile = options.profile;
	const paths = resolveClankyPaths(pathsOptions);
	const personaMarkdown = await loadPersona(resolvePackageRoot());
	const createRuntime = buildRuntimeFactory({ paths, personaMarkdown });

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: paths.profileDir,
		sessionManager: SessionManager.create(cwd, paths.sessionsDir),
	});

	return { runtime, paths };
}

/**
 * Launch clanky in interactive TUI mode.
 *
 * Wires the @clanky/core agent-tool handlers + extension factories, injects
 * the clanky persona via systemPromptOverride, merges bundled/profile skills,
 * disables compaction, and hands the runtime to `InteractiveMode`.
 */
export async function runClanky(options: RunClankyOptions = {}): Promise<void> {
	const { runtime } = await createClankyRuntime(options);

	const interactiveOptions: ConstructorParameters<typeof InteractiveMode>[1] = {};
	if (options.initialMessage !== undefined) interactiveOptions.initialMessage = options.initialMessage;

	const mode = new InteractiveMode(runtime, interactiveOptions);
	await mode.init();
	await mode.run();
}
