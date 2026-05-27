import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateLlmsFiles } from "@volpestyle/agent-docs/llms";
import { docsMeta, groups, site } from "../src/docs-manifest.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const docsAppDir = resolve(scriptDir, "..");
const repoRoot = resolve(docsAppDir, "..", "..");
const publicDir = resolve(docsAppDir, "public");

await generateLlmsFiles({
  docsMeta,
  groups,
  llms: {
    ...site.llms,
    baseUrl: (
      process.env.LLMS_BASE_URL ??
      site.llms?.baseUrl ??
      "https://volpestyle.github.io/agent-room"
    ).replace(/\/$/, ""),
    blurb: site.llms?.blurb ?? site.description,
  },
  repoRoot,
  publicDir,
});
