import {
	type ClankyAgentToolHandlers,
	type ClankyPaths,
	hasLinearCredentials,
	LinearClient,
	loadClankySkills,
} from "@clanky/core";
import type { ClankyStores } from "./stores.js";

/**
 * Build the agent-tool handlers wired against standalone clanky stores.
 *
 * Phase 1: only the gateway-uncoupled handlers are wired up:
 *
 * - memory.* (packet, remember, search, forget, export, consent, self)
 * - profileStatus
 * - listSkills + createSkill
 * - linearCreateIssue + linearLink (gated on LINEAR_API_KEY / LINEAR_ACCESS_TOKEN)
 * - beforeProviderRequest (passthrough so the logging extension hook fires)
 *
 * Intentionally omitted (defer to a later phase):
 *
 * - scheduleCron / listCron (needs CronJobStore + scheduler)
 * - externalMcpCall / externalMcpStatus (gateway-owned external MCP launcher)
 * - taskCreate / listTasks (coupled to SessionRegistry event log)
 * - indexMessage (depends on SessionIndexStore)
 */
export function createClankyHandlers(paths: ClankyPaths, stores: ClankyStores): ClankyAgentToolHandlers {
	return {
		beforeProviderRequest: async (input) => input.payload,

		memoryPacket: (input) => stores.memory.packet(input),
		memoryRemember: (input) => stores.memory.remember(input, { scope: "project", subjectId: process.cwd() }),
		memorySearch: (input) => stores.memory.search(input),
		memoryForget: (input) => stores.memory.forget(input),
		memoryExport: () => stores.memory.export(),
		memoryConsent: (input) => stores.memory.setConsent(input),
		selfMemory: () => stores.memory.readSelfMemory(),

		listSkills: async () => loadClankySkills({ paths }),
		createSkill: async (input) => {
			const { createProfileSkill } = await import("@clanky/core");
			return await createProfileSkill(paths, input);
		},

		profileStatus: async () => ({
			profile: paths.profile,
			homeDir: paths.homeDir,
			profileDir: paths.profileDir,
			sessionsDir: paths.sessionsDir,
			skillsDir: paths.skillsDir,
			profileSkillsDir: paths.profileSkillsDir,
		}),

		linearCreateIssue: async (input) => {
			if (!hasLinearCredentials(process.env)) {
				throw new Error("Linear credentials missing: set LINEAR_API_KEY or LINEAR_ACCESS_TOKEN to create issues.");
			}
			const client = LinearClient.fromEnv(process.env);
			return await client.createIssue(input);
		},

		linearLink: async (input) => stores.linearLinks.link(input),
	};
}
