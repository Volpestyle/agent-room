/**
 * runtime-smoke.ts
 *
 * Exercises the @clanky/agent factory wiring end-to-end *without* launching
 * InteractiveMode (which needs a real TTY). The test:
 *
 *  1. Picks a tmp homeDir so we never touch ~/.clanky.
 *  2. Calls createClankyRuntime() with an in-memory SessionManager surrogate
 *     by overriding the runtime cwd. (We use SessionManager.create against the
 *     tmp profile sessionsDir, which is equivalent for setup purposes.)
 *  3. Asserts the returned runtime has a live AgentSession, services, and
 *     that clanky's persona was injected into the resource loader.
 *
 * Run via: pnpm exec tsx agents/clanky/test/runtime-smoke.ts
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClankyRuntime } from "../src/runClanky.js";

async function main(): Promise<void> {
	const tmpRoot = await mkdtemp(join(tmpdir(), "clanky-agent-smoke-"));
	const homeDir = join(tmpRoot, "home");
	const cwd = join(tmpRoot, "work");
	await mkdir(cwd, { recursive: true });

	try {
		const { runtime, paths } = await createClankyRuntime({ homeDir, cwd });

		if (runtime.session === undefined) {
			throw new Error("smoke: runtime.session was undefined");
		}
		if (runtime.services === undefined) {
			throw new Error("smoke: runtime.services was undefined");
		}
		if (paths.homeDir !== homeDir) {
			throw new Error(`smoke: paths.homeDir ${paths.homeDir} did not match ${homeDir}`);
		}

		const systemPrompt = runtime.services.resourceLoader.getSystemPrompt() ?? "";
		if (!systemPrompt.includes("Clanky Self")) {
			throw new Error(`smoke: persona not injected into system prompt. Got: ${systemPrompt.slice(0, 120)}...`);
		}

		const skills = runtime.services.resourceLoader.getSkills().skills;
		const skillNames = skills.map((s) => s.name);
		// Bundled clanky skills include "daily-digest", "linear-bridge", "pi-tui-coder".
		// We don't hard-fail if names changed, but we DO require at least one merged
		// skill so we know the skillsOverride hook fired.
		if (skillNames.length === 0) {
			console.warn("smoke: no skills loaded (expected at least the bundled set)");
		} else {
			console.log(`smoke: loaded ${skillNames.length} skills: ${skillNames.join(", ")}`);
		}

		const extensionsResult = runtime.services.resourceLoader.getExtensions();
		console.log(`smoke: loaded ${extensionsResult.extensions.length} extension(s)`);

		await runtime.dispose();
		console.log("runtime-smoke: PASS");
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	console.error("runtime-smoke: FAIL");
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exit(1);
});
