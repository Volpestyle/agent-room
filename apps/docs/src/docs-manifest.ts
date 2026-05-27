import {
  createAgentWorkspaceSiteLinks,
  type DocGroup,
  type DocMeta,
  type DocsSiteInfo,
} from "@volpestyle/night-compiler";

export const site: DocsSiteInfo = {
  id: "agent-room-docs",
  title: "AgentRoom Docs",
  description:
    "AgentRoom is the local-first control room for launching, steering, auditing, and coordinating long-running coding agents.",
  badge: "local-first",
  logo: {
    src: "branding/agent-room-icon.svg",
    width: 32,
    height: 32,
  },
  llms: {
    baseUrl: "https://volpestyle.github.io/agent-room",
    title: "AgentRoom",
    blurb:
      "AgentRoom is the local-first control room for launching, steering, auditing, and coordinating long-running coding agents, with provider ports for runtimes, trackers, chat gateways, design, code hosts, and local room state.",
    excludeGroupsFromFull: ["Maintainer"],
  },
  siteLinks: createAgentWorkspaceSiteLinks(),
};

export const groups: DocGroup[] = [
  "Start",
  "Setup",
  "Operations",
  "Reference",
  "Architecture",
  "Planning",
  "Maintainer",
];

export const docsMeta: DocMeta[] = [
  {
    slug: "ecosystem",
    title: "Ecosystem Tour",
    description:
      "What users can do, what agents should handle, and the diagrams that explain the agent-first workspace.",
    source: "docs/ECOSYSTEM.md",
    group: "Start",
  },
  {
    slug: "overview",
    title: "Overview",
    description: "AgentRoom's local-first coordination model, repository layout, tech stack, and quick start.",
    source: "README.md",
    group: "Start",
  },
  {
    slug: "setup",
    title: "Setup Guide",
    description: "Install local tooling, choose room shape, runtime provider, agent harness, integrations, and skills.",
    source: "docs/SETUP.md",
    group: "Setup",
  },
  {
    slug: "configuration",
    title: "Configuration Model",
    description: "Typed topology, source-of-truth rules, env overrides, secrets, and TUI editing boundaries.",
    source: "docs/CONFIGURATION.md",
    group: "Setup",
  },
  {
    slug: "topology",
    title: "Room Topology",
    description: "Single-project rooms, HQ rooms, hybrids, gateway ownership, and state placement tradeoffs.",
    source: "docs/TOPOLOGY.md",
    group: "Setup",
  },
  {
    slug: "coordination",
    title: "Coordination Model",
    description: "Native room messages, handoffs, status, task shadows, escalation, and external tracker split.",
    source: "docs/COORDINATION.md",
    group: "Operations",
  },
  {
    slug: "runtimes",
    title: "Runtime Providers",
    description: "Provider-neutral launch, read, send, stop, tmux, Herdr, fake runtimes, and future adapters.",
    source: "docs/RUNTIMES.md",
    group: "Operations",
  },
  {
    slug: "protocol",
    title: "Protocol Notes",
    description: "Agent opt-in environment, structured commands, local task shadows, and Linear bridge commands.",
    source: "docs/PROTOCOL.md",
    group: "Reference",
  },
  {
    slug: "security",
    title: "Security Model",
    description: "Runtime audit boundaries, scoped tokens, dangerous actions, transcript handling, and secrets.",
    source: "docs/SECURITY.md",
    group: "Reference",
  },
  {
    slug: "architecture",
    title: "Architecture",
    description: "Core domain ownership, provider ports, adapters, configuration model, gateways, and daemon surfaces.",
    source: "docs/ARCHITECTURE.md",
    group: "Architecture",
  },
  {
    slug: "diagram",
    title: "System Diagram",
    description: "Docs-friendly end-to-end map of UIs, daemon, core, ports, adapters, and external systems.",
    source: "docs/DIAGRAM.md",
    group: "Architecture",
  },
  {
    slug: "roadmap",
    title: "Roadmap",
    description: "Planned runtime, storage, gateway, provider, TUI, mobile, and policy milestones.",
    source: "docs/ROADMAP.md",
    group: "Planning",
  },
  {
    slug: "milestones",
    title: "Milestones",
    description: "Current delivery milestones, sequencing, implementation notes, and acceptance gates.",
    source: "docs/MILESTONES.md",
    group: "Planning",
  },
  {
    slug: "adr-tech-stack",
    title: "ADR 0001: Tech Stack",
    description: "Decision record for AgentRoom's core language, packaging, daemon, MCP, and client choices.",
    source: "docs/ADR/0001-tech-stack.md",
    group: "Maintainer",
  },
  {
    slug: "adr-runtime-provider",
    title: "ADR 0002: Runtime Provider Port",
    description: "Decision record for the runtime provider boundary and adapter responsibilities.",
    source: "docs/ADR/0002-runtime-provider-port.md",
    group: "Maintainer",
  },
  {
    slug: "adr-chat-gateway",
    title: "ADR 0003: Chat Gateway Port",
    description: "Decision record for bidirectional chat gateway ownership and provider boundaries.",
    source: "docs/ADR/0003-chat-gateway-port.md",
    group: "Maintainer",
  },
];

export const defaultDocSlug = "ecosystem";
