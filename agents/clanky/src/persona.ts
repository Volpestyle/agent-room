import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Load the clanky persona markdown (persona/SELF.md) relative to the
 * @clanky/agent package root.
 */
export async function loadPersona(packageRoot: string): Promise<string> {
	const file = join(packageRoot, "persona", "SELF.md");
	const content = await readFile(file, "utf8");
	return content.trim();
}
