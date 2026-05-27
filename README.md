# AgentRoom

AgentRoom is a local-first, runtime-agnostic coordination plane for long-running coding agents.

The core is built around replaceable provider ports so the same room/task/message/approval system can run on Herdr, tmux, Docker, SSH, ECS, Kubernetes, or a custom runtime without changing core room behavior.

## What is in this repo

```text
apps/
  cli/             agent-room CLI
  daemon/          local HTTP API daemon
  mcp-server/      stdio MCP server for room messages, tasks, waits, and audit context
  tui/             interactive terminal dashboard
  mobile/          Expo/React Native client for daemon API access
packages/
  core/            domain model, events, service layer, provider ports
  storage-jsonl/   append-only JSONL event store for local rooms
  storage-memory/  in-memory event store for tests and demos
  runtime-fake/    fake runtime provider used by tests
  runtime-herdr/   Herdr runtime provider adapter
  runtime-tmux/    working minimal tmux runtime provider
  integrations/    connector ports and bridge adapters for GitHub/Linear/Figma/Discord/etc.
                   includes chat-discord (ChatGatewayProvider, bot or user token)
skills/
  agentroom/       enrolled-agent coordination skill
  agentroom-operator/
                   operator/lead skill for launching and managing agents
docs/
  architecture, coordination, runtime adapters, security, roadmap, ADRs
examples/
  configs and role/policy examples
```

## Documentation

These repo-relative `docs/...` links are intended to open directly in the docs UI:

- [System diagram](docs/DIAGRAM.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Setup guide](docs/SETUP.md)
- [Configuration model](docs/CONFIGURATION.md)
- [Room topology](docs/TOPOLOGY.md)
- [Coordination model](docs/COORDINATION.md)
- [Runtime providers](docs/RUNTIMES.md)
- [Security model](docs/SECURITY.md)
- [Protocol notes](docs/PROTOCOL.md)
- [Roadmap](docs/ROADMAP.md)
- [Migration notes](docs/MIGRATION.md)

## Tech stack

- TypeScript across core, CLI, daemon, TUI, MCP server, provider adapters, and the mobile client.
- Node.js 24 LTS target for the local daemon and CLI.
- pnpm workspaces for the monorepo.
- Hono for the daemon HTTP API.
- MCP SDK for the stdio AgentRoom server.
- Expo/React Native for the mobile client.
- Vitest for contract and unit tests.
- Zod for schemas at process and network boundaries.
- Work tracker, design, code host, notification, and chat integrations live behind provider ports; AgentRoom keeps local room/audit state.
- SQLite is still planned as the durable local event store; JSONL is the current event store.

See `docs/ADR/0001-tech-stack.md` for the rationale.

## Quick start

For first-time setup, follow `docs/SETUP.md`. It walks through choosing the runtime provider, work tracker, design integration, messaging surface, Discord/`discord_mcp` usage, and agent skills without assuming a specific stack.

Prerequisites:

```bash
corepack enable
corepack prepare pnpm@11 --activate
pnpm install
pnpm build
pnpm test
```

Initialize a project room:

```bash
agent-room init --room my-project --runtime RUNTIME
agent-room post "hello from the room" --channel announcements
agent-room dm api-impl "Can you take auth callback?"
agent-room task create "Implement auth callback" --assignee api-impl
agent-room events --limit 20
```

`init` writes `.agentroom/config.yaml`. That file selects the default runtime provider, runtime-specific settings, room-owned gateways/routes, and the local event log path. The TUI should act as a human-friendly editor and control plane over the same typed config model, not as a separate hidden topology store; see `docs/CONFIGURATION.md`.

For room layout choices, including one room per project versus one room coordinating agents across many repositories, see `docs/TOPOLOGY.md`.

AgentRoom does not try to replace your durable work tracker. Use the tracker you choose for issues, ownership, workflow status, and durable comments. Use AgentRoom for channel/DM coordination, review transitions, runtime audit, and local task shadows linked to external tracker refs. See `docs/COORDINATION.md`.

Agent-facing room behavior lives in `skills/agentroom/SKILL.md`. Operator and lead-agent launch behavior lives in `skills/agentroom-operator/SKILL.md`.

Run the local API daemon:

```bash
agent-room daemon
curl http://127.0.0.1:4317/health
```

For managed background use, the CLI writes `.agentroom/daemon.pid` and allows human operators plus enrolled `lead`/`gateway` agents to change daemon lifecycle state:

```bash
agent-room daemon start
agent-room daemon status
agent-room daemon stop
agent-room daemon restart
```

Daemon lifecycle commands print concise operator messages by default; pass `--json` when scripts or agents need the full health payload.

For iOS/mobile access over a private tailnet, bind the daemon to this machine's Tailscale address. This also enables bearer-token protection for `/v1/*` API routes:

```bash
agent-room daemon start --tailnet
agent-room mobile-connect
```

Enter the printed base URL and API token in the mobile app. The tailnet keeps the connection off the public internet, and the API token prevents other tailnet devices from reading or controlling the room accidentally.
For one-tap pairing, run `agent-room mobile-connect --copy` and paste the copied `agentroom://connect?...` link on the iPhone with Universal Clipboard, Messages, AirDrop, or Notes. Opening the link in AgentRoom saves the URL and token and connects automatically.

Try the fake runtime smoke test:

```bash
agent-room runtime fake-smoke
```

Pick or inspect the runtime:

```bash
agent-room runtime providers
agent-room runtime use <runtime>
agent-room runtime doctor
```

If `runtime doctor` reports adapter-specific setup requirements, see `docs/RUNTIMES.md`.

Launch an agent using the configured default runtime:

```bash
agent-room launch impl --harness HARNESS_KIND --command "AGENT_COMMAND" --cwd .
agent-room read impl --lines 40
```

`launch` creates the runtime binding and runs the configured harness command. If you allocate a shell first, the session is not an active coding agent until a coding-agent command starts:

```bash
agent-room launch impl --harness shell --command "bash" --cwd .
agent-room send impl "AGENT_COMMAND"
agent-room read impl --lines 40
agent-room send impl "Use AgentRoom, claim your assigned task, and post a short status before editing."
```

Prefer `agent-room send` over raw provider commands for bound agents so terminal input is recorded in the AgentRoom event log. `read`, `send`, and `stop` require a room binding by default; use `--unaudited` only for manual recovery or sessions that are not AgentRoom-bound.

See `skills/agentroom-operator/SKILL.md` for the full operator playbook.

When the selected runtime supports adoption, the daemon can enroll existing runtime sessions through the adapter. For one-off manual enrollment of a supported pane or shell when the daemon is not running, use `agent-room enroll --json`. Adapter-specific behavior lives in `docs/RUNTIMES.md`.

Open the dashboard:

```bash
agent-room tui
```

The TUI starts in a chat view and can launch a lead agent named `operator` when `operator.command` or `AGENTROOM_OPERATOR_COMMAND` is configured. Type normally to ask what is happening or request room actions; use `/help` for slash commands, `/effort [level]` to show or set model effort (`off|minimal|low|medium|high|xhigh`), `Esc` to browse dashboard views, and `Ctrl+G` / `Ctrl+L` to cycle through chat, overview, agents, tasks, messages, and events. Set `AGENTROOM_TUI_OPERATOR_ID` to use a different operator agent id.

Use `/runtime` or `/runtime herdr` in the TUI to show the configured runtime session namespace, socket path, workspace label, workspace ids, join command, and bound agent count. For Herdr, pass the session namespace to `herdr --session <name>`; ids like `w652aca9fd72f08` are Herdr workspace ids inside that session, not `--session` names. Use `/trace off|tools|full` to control how much of the dashboard agent stream is shown; `full` shows thinking and tool requests for debugging.

Configure the dashboard operator in `.agentroom/config.yaml` or with env overrides:

```yaml
operator:
  agentId: operator
  kind: custom # claude-code, codex, pi, clanky, shell, gemini-cli, custom
  command: "AGENT_COMMAND"
```

For Clanky-backed operation, use `kind: clanky` with either the default `clanky --profile <agentId> --home .agentroom/clanky` launch or an explicit command such as `clanky --profile operator --home .agentroom/clanky` or `clanky subagent --profile operator`. The matching env overrides are `AGENTROOM_OPERATOR_KIND`, `AGENTROOM_OPERATOR_COMMAND`, `AGENTROOM_OPERATOR_CWD`, `AGENTROOM_OPERATOR_SESSION_DIR`, and `AGENTROOM_OPERATOR_DISPLAY_NAME`.

Wait for room activity from scripts or handoffs:

```bash
agent-room wait --message "ready for review" --timeout 300 --json
agent-room wait --task-status task_xxx:done --timeout 60
agent-room wait --dm-to-me --since now
```

`wait` polls the room event log from a cursor and exits 0 on the first matching message, task status change, or DM to `AGENTROOM_AGENT_ID`; it exits non-zero on timeout. `--since now` starts at the moment `wait` begins running.

Stream the room audit log as newline-delimited JSON:

```bash
agent-room events --follow --json
```

Runtime selection is config-driven, and each runtime remains an adapter so replacing the terminal multiplexer does not affect the rest of the platform. Adapter-specific setup lives in `docs/RUNTIMES.md`.

Example `.agentroom/config.yaml` shape after choosing a runtime:

```yaml
room:
  id: my-project
  name: My Project

runtime:
  default: runtime-id

runtimes:
  runtime-id:
    type: RUNTIME
  fake:
    type: fake

storage:
  driver: jsonl
  path: .agentroom/events.jsonl
```

## Design goals

1. Herdr is an adapter, not the platform.
2. Every agent opt-in is explicit.
3. The event log is source of truth.
4. Terminal input/output is privileged and auditable.
5. Agents coordinate through structured room commands plus lightweight channel/DM messages.
6. The selected external tracker remains canonical; AgentRoom keeps local execution context and audit events.
7. Third-party chat systems are gateways, not the core state store.
8. The MVP should run locally on one machine, but the ports should survive a hosted/AWS version.

## Current maturity

This is a runnable local coordination plane. It includes core room/task/message services, the CLI, daemon HTTP API, TUI, MCP server, Expo mobile client, JSONL event storage, tmux/Herdr/fake runtime providers, audited runtime launch/read/send/stop flows, Herdr pane adoption, wait/events-follow, local task shadows, Linear bridge commands, chat gateway routing/dispatch primitives, Discord gateway config loading, read-only chat gateway route APIs, and mobile tailnet pairing.

The next useful build steps are to add a durable SQLite event store, harden real runtime provider contract tests, make external tracker bridges more ergonomic, add operator CLI support for chat route inspection/mutation, and prototype hosted or multi-host runtime adapters.
