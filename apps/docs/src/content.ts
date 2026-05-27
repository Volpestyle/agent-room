import { defineDocsConfig } from "@volpestyle/night-compiler";
import adrRuntimeProvider from "../../../docs/ADR/0002-runtime-provider-port.md?raw";
import adrChatGateway from "../../../docs/ADR/0003-chat-gateway-port.md?raw";
import architecture from "../../../docs/ARCHITECTURE.md?raw";
import configuration from "../../../docs/CONFIGURATION.md?raw";
import coordination from "../../../docs/COORDINATION.md?raw";
import diagram from "../../../docs/DIAGRAM.md?raw";
import migration from "../../../docs/MIGRATION.md?raw";
import milestones from "../../../docs/MILESTONES.md?raw";
import protocol from "../../../docs/PROTOCOL.md?raw";
import roadmap from "../../../docs/ROADMAP.md?raw";
import runtimes from "../../../docs/RUNTIMES.md?raw";
import security from "../../../docs/SECURITY.md?raw";
import setup from "../../../docs/SETUP.md?raw";
import topology from "../../../docs/TOPOLOGY.md?raw";
import adrTechStack from "../../../docs/ADR/0001-tech-stack.md?raw";
import readme from "../../../README.md?raw";
import { defaultDocSlug, docsMeta, groups, site } from "./docs-manifest";

const markdownBySource = {
  "README.md": readme,
  "docs/ADR/0001-tech-stack.md": adrTechStack,
  "docs/ADR/0002-runtime-provider-port.md": adrRuntimeProvider,
  "docs/ADR/0003-chat-gateway-port.md": adrChatGateway,
  "docs/ARCHITECTURE.md": architecture,
  "docs/CONFIGURATION.md": configuration,
  "docs/COORDINATION.md": coordination,
  "docs/DIAGRAM.md": diagram,
  "docs/MIGRATION.md": migration,
  "docs/MILESTONES.md": milestones,
  "docs/PROTOCOL.md": protocol,
  "docs/ROADMAP.md": roadmap,
  "docs/RUNTIMES.md": runtimes,
  "docs/SECURITY.md": security,
  "docs/SETUP.md": setup,
  "docs/TOPOLOGY.md": topology,
};

export const docsConfig = defineDocsConfig({
  site,
  groups,
  docsMeta,
  markdownBySource,
  defaultDocSlug,
});

export default docsConfig;
