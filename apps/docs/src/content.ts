import { defineDocsConfig } from "@volpestyle/night-compiler";
import architecture from "../../../docs/ARCHITECTURE.md?raw";
import cliReference from "../../../docs/CLI_REFERENCE.md?raw";
import configuration from "../../../docs/CONFIGURATION.md?raw";
import coordination from "../../../docs/COORDINATION.md?raw";
import diagram from "../../../docs/DIAGRAM.md?raw";
import ecosystem from "../../../docs/ECOSYSTEM.md?raw";
import protocol from "../../../docs/PROTOCOL.md?raw";
import roadmap from "../../../docs/ROADMAP.md?raw";
import runtimes from "../../../docs/RUNTIMES.md?raw";
import security from "../../../docs/SECURITY.md?raw";
import setup from "../../../docs/SETUP.md?raw";
import skillsAndProtocols from "../../../docs/SKILLS_AND_PROTOCOLS.md?raw";
import topology from "../../../docs/TOPOLOGY.md?raw";
import tui from "../../../docs/TUI.md?raw";
import readme from "../../../README.md?raw";
import { defaultDocSlug, docsMeta, groups, site } from "./docs-manifest";

const markdownBySource = {
  "README.md": readme,
  "docs/ARCHITECTURE.md": architecture,
  "docs/CLI_REFERENCE.md": cliReference,
  "docs/CONFIGURATION.md": configuration,
  "docs/COORDINATION.md": coordination,
  "docs/DIAGRAM.md": diagram,
  "docs/ECOSYSTEM.md": ecosystem,
  "docs/PROTOCOL.md": protocol,
  "docs/ROADMAP.md": roadmap,
  "docs/RUNTIMES.md": runtimes,
  "docs/SECURITY.md": security,
  "docs/SETUP.md": setup,
  "docs/SKILLS_AND_PROTOCOLS.md": skillsAndProtocols,
  "docs/TOPOLOGY.md": topology,
  "docs/TUI.md": tui,
};

export const docsConfig = defineDocsConfig({
  site,
  groups,
  docsMeta,
  markdownBySource,
  defaultDocSlug,
});

export default docsConfig;
