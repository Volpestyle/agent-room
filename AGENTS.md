# Agent Guidance

AgentRoom has nearby reference repositories under `/Users/jamesvolpe/dev`. Use them to understand mature implementations and compatible terminology before making larger design changes here.

Reference repos:

- `/Users/jamesvolpe/dev/herdr`
  - Use when working on the Herdr adapter or comparing terminal-multiplexer behavior. Do not let Herdr terminology leak into core AgentRoom concepts.
- `/Users/jamesvolpe/dev/external/earendil-works/pi`
  - Use for coding-agent harness design, tool calling, runtime state management, model provider abstractions, and TUI patterns.
- `/Users/jamesvolpe/dev/hermes-agent`
  - Use for agent gateway architecture, skills, memory, cron scheduling, messaging platforms, provider configuration, and remote execution patterns.
- `/Users/jamesvolpe/dev/agents/clanky-pi`
  - Use for a TypeScript daemon/CLI/MCP implementation built around Pi sessions, profile-local storage, cron, Linear, memory, Telegram/Discord messaging, and HTTP/WebSocket APIs.

Rules for using these references:

- Read from them freely when relevant.
- Do not modify them unless the user explicitly asks for changes in that repo.
- Do not vendor or copy large sections of code into AgentRoom. Adapt only the smallest useful pattern.
- Preserve AgentRoom's runtime-provider boundary and event-first model.
- Keep core AgentRoom guidance provider-neutral. Do not encode Herdr, tmux, or other runtime-specific operations in `AGENTS.md` or agent-facing skills unless the file is explicitly adapter-specific.
- Use AgentRoom runtime commands and provider ports as the normal control surface. Raw multiplexer/provider commands are for adapter implementation, adapter docs, or manual recovery only.
- The configured external work tracker (Linear, GitHub Issues, etc., reached via its MCP/CLI) is the single source of truth for issues, status, ownership, and comments. AgentRoom does not store or track tasks — there is no native task model, task events, or task API. Agents reach the tracker through their own tooling; AgentRoom only points them at it via the `workTracker` config and `AGENTROOM_WORK_TRACKER*` env. Coordinate work through messages/DMs and the agent state machine (`done`/`block`/`wait-agent`), not a local task store.
- Use AgentRoom native messages for active channel/DM coordination between agents.
- Prefer local AgentRoom conventions when they conflict with a reference repo.
- Mention any reference repo paths that materially shaped your implementation.
- Treat `.agentroom/config.yaml` as the durable source of truth for room topology. TUI/CLI config editors must round-trip through `@agentroom/config`; do not add a second hidden TUI settings store for runtimes, operators, gateways, or routes. Keep secrets in env/auth stores, not YAML.

Agent handling:

- When asked to spin up agents, verify `.agentroom/config.yaml` and `agent-room runtime doctor` first.
- Use `skills/agentroom-operator/SKILL.md` as the operator playbook for launching and managing runtime-backed agents.
- Use `skills/agentroom/SKILL.md` as the enrolled-agent playbook for worker/reviewer behavior inside a room.
- If runtime health reports a provider-specific problem, fix it through AgentRoom configuration or the relevant adapter docs instead of bypassing AgentRoom as the normal workflow.
- Treat `agent-room launch ... --harness shell --command "bash"` as shell allocation plus AgentRoom binding only. The resulting session is not an active coding agent until a coding-agent startup command or task command is sent into that shell.
- Prefer launching the intended harness command directly when known, for example `--harness <kind> --command "<agent-command>"`. If using shell sessions, immediately follow launch with `agent-room send <agentId> "<startup command>"`, then read back output before sending the first task prompt.
- Use `agent-room send/read/stop` for bound agents so runtime input and output are audited. Use raw provider commands only for manual recovery or non-AgentRoom sessions.

Good lookup starting points:

- Herdr adapter work only: `/Users/jamesvolpe/dev/herdr/README.md`, `SOCKET_API.md`, `SKILL.md`
- Pi harness/tooling work: `/Users/jamesvolpe/dev/external/earendil-works/pi/README.md`, `packages/agent`, `packages/coding-agent`
- Hermes gateway/skills/memory/cron work: `/Users/jamesvolpe/dev/hermes-agent/README.md`, `providers`, `environments`, `web`, `ui-tui`
- Clanky daemon/MCP/HTTP/profile work: `/Users/jamesvolpe/dev/agents/clanky-pi/README.md`

Operator-facing AgentRoom commands and `.agentroom/config.yaml` runtime setup are documented in `README.md` and `docs/SETUP.md`; link there instead of duplicating the workflow in this file.
