# Agent Guidance

AgentRoom has nearby reference repositories under `/Users/jamesvolpe/web`. Use them to understand mature implementations and compatible terminology before making larger design changes here.

Reference repos:

- `/Users/jamesvolpe/web/herdr`
  - Use for Herdr runtime behavior, terminal multiplexing, panes/tabs/workspaces, agent status detection, and socket/API integration ideas.
- `/Users/jamesvolpe/web/pi`
  - Use for coding-agent harness design, tool calling, runtime state management, model provider abstractions, and TUI patterns.
- `/Users/jamesvolpe/web/hermes-agent`
  - Use for agent gateway architecture, skills, memory, cron scheduling, messaging platforms, provider configuration, and remote execution patterns.
- `/Users/jamesvolpe/web/clanky-pi`
  - Use for a TypeScript daemon/CLI/MCP implementation built around Pi sessions, profile-local storage, cron, Linear, memory, Telegram/Discord messaging, and HTTP/WebSocket APIs.

Rules for using these references:

- Read from them freely when relevant.
- Do not modify them unless the user explicitly asks for changes in that repo.
- Do not vendor or copy large sections of code into AgentRoom. Adapt only the smallest useful pattern.
- Preserve AgentRoom's runtime-provider boundary and event-first model.
- Treat Linear MCP/CLI/skills as the canonical work tracker. AgentRoom local tasks are shadows/audit context when linked to Linear issues.
- Use AgentRoom native messages for active channel/DM coordination between agents.
- Prefer local AgentRoom conventions when they conflict with a reference repo.
- Mention any reference repo paths that materially shaped your implementation.

Good lookup starting points:

- Herdr adapter/runtime work: `/Users/jamesvolpe/web/herdr/README.md`, `SOCKET_API.md`, `SKILL.md`
- Pi harness/tooling work: `/Users/jamesvolpe/web/pi/README.md`, `packages/agent`, `packages/coding-agent`
- Hermes gateway/skills/memory/cron work: `/Users/jamesvolpe/web/hermes-agent/README.md`, `providers`, `environments`, `web`, `ui-tui`
- Clanky daemon/MCP/HTTP/profile work: `/Users/jamesvolpe/web/clanky-pi/README.md`
