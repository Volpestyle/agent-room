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
    "AgentRoom is the local-first terminal control room for seeing, launching, steering, and auditing long-running coding agents.",
  badge: "local-first",
  logo: {
    src: "branding/agent-room-icon.svg",
    width: 32,
    height: 32,
  },
  llms: {
    baseUrl: "https://volpestyle.github.io/docs/agent-room",
    title: "AgentRoom",
    blurb:
      "AgentRoom is the local-first terminal control room for seeing, launching, steering, and auditing long-running coding agents. Start with the TUI; use public skills, protocols, and CLI references when you need to understand or automate what happens behind the scenes.",
  },
  siteLinks: createAgentWorkspaceSiteLinks(),
};

export const groups: DocGroup[] = [
  "Start",
  "Setup",
  "Operations",
  "Agents",
  "Reference",
  "Architecture",
  "Planning",
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
    description:
      "AgentRoom's local-first coordination model, repository layout, tech stack, and quick start.",
    source: "README.md",
    group: "Start",
  },
  {
    slug: "tui",
    title: "Terminal TUI",
    description:
      "The human dashboard path: operator chat, views, hotkeys, and when to use the CLI instead.",
    source: "docs/TUI.md",
    group: "Start",
  },
  {
    slug: "setup",
    title: "Setup Guide",
    description:
      "Install local tooling and choose room shape, runtime provider, harness, integrations, and skill exposure without duplicating the command reference.",
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
      "Room messages, handoffs, status, agent-state signals, escalation, and the configured work tracker.",
    source: "docs/COORDINATION.md",
    group: "Operations",
  },
  {
    slug: "runtimes",
    title: "Runtime Providers",
    description:
      "Provider-neutral runtime model, bindings, Herdr/Zellij/tmux adapters, adoption, and where exact command flags live.",
    source: "docs/RUNTIMES.md",
    group: "Operations",
  },
  {
    slug: "skills-and-protocols",
    title: "Skills And Protocols",
    description:
      "How public docs, agent skills, MCP, CLI references, and product protocols fit together without duplicating procedures.",
    source: "docs/SKILLS_AND_PROTOCOLS.md",
    group: "Agents",
  },
  {
    slug: "protocol",
    title: "AgentRoom Protocol",
    description:
      "Enrollment, room-native coordination, the configured work tracker, runtime audit, and gateway ownership.",
    source: "docs/PROTOCOL.md",
    group: "Agents",
  },
  {
    slug: "cli-reference",
    title: "CLI Reference",
    description:
      "Complete AgentRoom command map for operators, scripts, and agents that need exact commands.",
    source: "docs/CLI_REFERENCE.md",
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
      "Core domain ownership, runtime and gateway ports, configuration model, and daemon surfaces.",
    source: "docs/ARCHITECTURE.md",
    group: "Architecture",
  },
  {
    slug: "diagram",
    title: "System Diagram",
    description:
      "Docs-friendly end-to-end map of UIs, daemon, core, runtime providers, gateways, and external tools.",
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
];

export const defaultDocSlug = "ecosystem";
