import type { DocGroup, DocMeta, DocsSiteInfo } from "@volpestyle/night-compiler";

export const site: DocsSiteInfo = {
  id: "agent-room-docs",
  title: "AgentRoom Docs",
  description:
    "AgentRoom is a local-first, runtime-agnostic coordination plane for long-running coding agents.",
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
      "AgentRoom is a local-first, runtime-agnostic coordination plane for long-running coding agents, with provider ports for runtimes, trackers, chat gateways, and local room state.",
    excludeGroupsFromFull: ["Maintainer"],
  },
  siteLinks: [
    {
      id: "clanky-docs",
      label: "Clanky",
      href: "https://volpestyle.github.io/clanky/",
      description:
        "Personal agent docs, setup, operations, and Clanky's AgentRoom integration.",
    },
    {
      id: "agent-room-docs",
      label: "AgentRoom",
      href: "https://volpestyle.github.io/agent-room/",
      description:
        "Coordination plane docs for rooms, runtimes, gateways, and protocols.",
    },
    {
      id: "clankvox-docs",
      label: "ClankVox",
      href: "https://volpestyle.github.io/clankvox/",
      description:
        "Rust media-plane submodule docs for Clanky's Discord voice and Go Live transport.",
      parentId: "clanky-docs",
      relationLabel: "voice/media module",
      metaLabel: "Clanky submodule",
    },
  ],
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
    slug: "overview",
    title: "Overview",
    description:
      "AgentRoom's local-first coordination model, repository layout, tech stack, and quick start.",
    source: "README.md",
    group: "Start",
  },
  {
    slug: "setup",
    title: "Setup Guide",
    description:
      "Install local tooling, choose room shape, runtime provider, agent harness, integrations, and skills.",
    source: "docs/SETUP.md",
    group: "Setup",
  },
  {
    slug: "configuration",
    title: "Configuration Model",
    description:
      "Typed topology, source-of-truth rules, env overrides, secrets, and TUI editing boundaries.",
    source: "docs/CONFIGURATION.md",
    group: "Setup",
  },
  {
    slug: "topology",
    title: "Room Topology",
    description:
      "Single-project rooms, HQ rooms, hybrids, gateway ownership, and state placement tradeoffs.",
    source: "docs/TOPOLOGY.md",
    group: "Setup",
  },
  {
    slug: "coordination",
    title: "Coordination Model",
    description:
      "Native room messages, handoffs, status, task shadows, escalation, and external tracker split.",
    source: "docs/COORDINATION.md",
    group: "Operations",
  },
  {
    slug: "runtimes",
    title: "Runtime Providers",
    description:
      "Provider-neutral launch, read, send, stop, tmux, Herdr, fake runtimes, and future adapters.",
    source: "docs/RUNTIMES.md",
    group: "Operations",
  },
  {
    slug: "protocol",
    title: "Protocol Notes",
    description:
      "Agent opt-in environment, structured commands, local task shadows, and Linear bridge commands.",
    source: "docs/PROTOCOL.md",
    group: "Reference",
  },
  {
    slug: "security",
    title: "Security Model",
    description:
      "Runtime audit boundaries, scoped tokens, dangerous actions, transcript handling, and secrets.",
    source: "docs/SECURITY.md",
    group: "Reference",
  },
  {
    slug: "architecture",
    title: "Architecture",
    description:
      "Core domain ownership, provider ports, adapters, configuration model, gateways, and daemon surfaces.",
    source: "docs/ARCHITECTURE.md",
    group: "Architecture",
  },
  {
    slug: "diagram",
    title: "System Diagram",
    description:
      "Docs-friendly end-to-end map of UIs, daemon, core, ports, adapters, and external systems.",
    source: "docs/DIAGRAM.md",
    group: "Architecture",
  },
  {
    slug: "roadmap",
    title: "Roadmap",
    description:
      "Planned runtime, storage, gateway, provider, TUI, mobile, and policy milestones.",
    source: "docs/ROADMAP.md",
    group: "Planning",
  },
  {
    slug: "milestones",
    title: "Milestones",
    description:
      "Current delivery milestones, sequencing, implementation notes, and acceptance gates.",
    source: "docs/MILESTONES.md",
    group: "Planning",
  },
  {
    slug: "migration",
    title: "Migration Notes",
    description:
      "Repo migration context, package split, command changes, and compatibility guidance.",
    source: "docs/MIGRATION.md",
    group: "Maintainer",
  },
  {
    slug: "adr-tech-stack",
    title: "ADR 0001: Tech Stack",
    description:
      "Decision record for AgentRoom's core language, packaging, daemon, MCP, and client choices.",
    source: "docs/ADR/0001-tech-stack.md",
    group: "Maintainer",
  },
  {
    slug: "adr-runtime-provider",
    title: "ADR 0002: Runtime Provider Port",
    description:
      "Decision record for the runtime provider boundary and adapter responsibilities.",
    source: "docs/ADR/0002-runtime-provider-port.md",
    group: "Maintainer",
  },
  {
    slug: "adr-chat-gateway",
    title: "ADR 0003: Chat Gateway Port",
    description:
      "Decision record for bidirectional chat gateway ownership and provider boundaries.",
    source: "docs/ADR/0003-chat-gateway-port.md",
    group: "Maintainer",
  },
];

export const defaultDocSlug = "overview";
