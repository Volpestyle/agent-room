#!/usr/bin/env node
import { type RunClankyOptions, runClanky } from "./runClanky.js";

const args = process.argv.slice(2);
const options: RunClankyOptions = {};
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === undefined) continue;
	const next = args[i + 1];
	if (a === "--profile" && next !== undefined) {
		options.profile = next;
		i++;
	} else if (a === "--home" && next !== undefined) {
		options.homeDir = next;
		i++;
	} else if (a === "--cwd" && next !== undefined) {
		options.cwd = next;
		i++;
	} else if (a === "--message" && next !== undefined) {
		options.initialMessage = next;
		i++;
	} else if (a === "--help" || a === "-h") {
		console.log("Usage: clanky [--profile <name>] [--home <dir>] [--cwd <dir>] [--message <text>]");
		process.exit(0);
	} else {
		console.error(`Unknown argument: ${a}`);
		process.exit(2);
	}
}

runClanky(options).catch((error: unknown) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exit(1);
});
