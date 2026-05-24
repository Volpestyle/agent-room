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
pnpm agentroom init --room my-project
pnpm agentroom post "hello from the room" --channel announcements
pnpm agentroom dm api-impl "Can you take auth callback?"
pnpm agentroom task create "Implement auth callback" --assignee api-impl --linear ENG-123
pnpm agentroom events --limit 20
```

AgentRoom does not try to replace Linear. Use Linear MCP/CLI/skills as the canonical work tracker for issues, ownership, workflow status, and durable comments. Use AgentRoom for channel/DM coordination, active handoffs, runtime audit, and local task shadows linked to Linear issues. See `docs/COORDINATION.md`.

Run the local API daemon:

```bash
pnpm dev:daemon
curl http://127.0.0.1:4317/health
```

Try the fake runtime smoke test:

```bash
pnpm agentroom runtime fake-smoke
```

Try a tmux-backed agent, if tmux is installed:

```bash
pnpm agentroom launch demo --runtime tmux --harness shell --command "bash" --cwd .
pnpm agentroom read demo --runtime tmux --lines 40
pnpm agentroom send demo "echo hello from AgentRoom" --runtime tmux
```

Herdr support starts behind `@agentroom/runtime-herdr`. The adapter is intentionally isolated so replacing Herdr does not affect the rest of the platform.

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
