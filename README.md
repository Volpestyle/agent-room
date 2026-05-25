# AgentRoom

AgentRoom is a local-first, runtime-agnostic coordination plane for long-running coding agents.

The first runtime target is Herdr, but the core is intentionally built around replaceable provider ports so the same room/task/message/approval system can later run on tmux, Docker, SSH, ECS, Kubernetes, or a custom runtime.

## What is in this scaffold

```text
apps/
  cli/             agentroom CLI
  daemon/          local HTTP API daemon
  mcp-server/      MCP server placeholder
  web/             future web/mobile-control shell notes
  mobile/          future native app notes
packages/
  core/            domain model, events, service layer, provider ports
  storage-jsonl/   append-only JSONL event store for local MVP
  storage-memory/  in-memory event store for tests and demos
  runtime-fake/    fake runtime provider used by tests
  runtime-herdr/   Herdr runtime provider adapter shell
  runtime-tmux/    working minimal tmux runtime provider
  integrations/    connector ports and bridge adapters for GitHub/Linear/Figma/etc.
skills/
  agentroom/       agent-facing skill instructions
examples/
  configs and role/policy examples
```

## Tech stack

- TypeScript across core, CLI, daemon, provider adapters, SDK, web, and future mobile-facing code.
- Node.js 24 LTS target for the local daemon and CLI.
- pnpm workspaces for the monorepo.
- Hono for the daemon HTTP API.
- Vitest for contract and unit tests.
- Zod for schemas at process and network boundaries.
- Linear MCP is the preferred durable work tracker integration; AgentRoom keeps local room/audit state.
- SQLite should be added as the durable local event store after the JSONL event log MVP is validated.

See `docs/ADR/0001-tech-stack.md` for the rationale.

## Quick start

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
agent-room init --room my-project --runtime herdr
agent-room post "hello from the room" --channel announcements
agent-room dm api-impl "Can you take auth callback?"
agent-room task create "Implement auth callback" --assignee api-impl --linear ENG-123
agent-room events --limit 20
```

`init` writes `.agentroom/config.yaml`. That file selects the default runtime provider, runtime-specific settings, and the local event log path.

AgentRoom does not try to replace Linear. Use Linear MCP/CLI/skills as the canonical work tracker for issues, ownership, workflow status, and durable comments. Use AgentRoom for channel/DM coordination, active handoffs, runtime audit, and local task shadows linked to Linear issues. See `docs/COORDINATION.md`.

Run the local API daemon:

```bash
agent-room daemon
curl http://127.0.0.1:4317/health
```

Try the fake runtime smoke test:

```bash
agent-room runtime fake-smoke
```

Pick or inspect the runtime:

```bash
agent-room runtime providers
agent-room runtime use tmux
agent-room runtime doctor
```

If Herdr is the default runtime, start or attach the configured Herdr session before launching Herdr-backed agents:

```bash
herdr session attach my-project
agent-room runtime doctor
```

Launch an agent using the configured default runtime:

```bash
agent-room launch demo --harness shell --command "bash" --cwd .
agent-room send demo "echo hello from AgentRoom"
agent-room read demo --lines 40
```

Override the runtime per command when needed:

```bash
agent-room launch demo-tmux --runtime tmux --harness shell --command "bash" --cwd .
```

Herdr support lives behind `@agentroom/runtime-herdr`, and tmux support lives behind `@agentroom/runtime-tmux`. Runtime selection is config-driven, but each runtime remains an adapter so replacing the terminal multiplexer does not affect the rest of the platform.

Example `.agentroom/config.yaml`:

```yaml
room:
  id: my-project
  name: My Project

runtime:
  default: herdr

runtimes:
  herdr:
    type: herdr
    session: my-project
    cli: herdr
  tmux:
    type: tmux
    sessionPrefix: agentroom
    cli: tmux
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
6. Linear is the canonical work tracker; AgentRoom keeps local execution context and audit events.
7. Third-party chat systems are gateways, not the core state store.
8. The MVP should run locally on one machine, but the ports should survive a hosted/AWS version.

## Current maturity

This is a scaffold moving toward a local MVP. It includes runnable core pieces, a CLI, daemon API skeleton, provider interfaces, channel/DM messages, local task shadows, runtime audit events, and starter implementations. The next useful build steps are to wire the daemon to a persistent SQLite store, complete Herdr provider contract tests against a real Herdr server, and make the Linear MCP/bridge path ergonomic.
