---
name: agentroom-operator
description: Manage AgentRoom rooms and runtime-backed agents from outside an enrolled worker process. Use when asked to initialize AgentRoom, inspect runtime health, launch agents, or send/read runtime input/output from an operator or lead-agent context.
---

# AgentRoom Operator

Use this skill to manage a room from the outside. For worker or reviewer behavior inside an enrolled process, use the `agentroom` skill instead.

## Preflight

Verify the project room and runtime before launching agents:

```bash
test -f .agentroom/config.yaml || agent-room init --room "$(basename "$PWD")"
agent-room runtime providers
agent-room runtime doctor
```

If runtime health reports a provider-specific problem, fix it through AgentRoom configuration or the relevant adapter docs. Do not bypass AgentRoom for normal launch, read, send, or stop flows.

## Launch Agents

Prefer launching the intended harness directly when known:

```bash
agent-room launch impl --harness codex --command "codex" --cwd .
agent-room read impl --lines 40
```

If allocating a shell first, treat it as a bound shell session until a coding-agent command starts:

```bash
agent-room launch impl --harness shell --command "bash" --cwd .
agent-room send impl "codex"
agent-room read impl --lines 40
agent-room send impl "Use AgentRoom, claim your assigned task, and post a short status before editing."
```

Use `agent-room send/read/stop` for bound agents so runtime input and output are audited. These commands require an AgentRoom binding by default; use `--unaudited` only for manual recovery when the session is not AgentRoom-bound.

## Herdr pane-grid launch hygiene

If the selected runtime is Herdr with `pane-grid`, stale panes from earlier work can crowd a reused workspace. When starting fresh work, prefer a new Herdr workspace label so the new agents get full-size panes:

```bash
agent-room launch impl-a --workspace squad-foo --cwd .
agent-room launch impl-b --workspace squad-foo --cwd .
```

A workspace with `panesPerTab: 2` plus two agents = one tab, two side-by-side panes in Herdr. See `docs/RUNTIMES.md` for provider-specific layout details and cleanup notes.

## Harness quirks

- **Codex** (`--harness codex --command "codex"`): a multi-line prompt sent via `agent-room send <id> "<long text>"` lands in the TUI prompt but is **not auto-submitted**. Follow with `agent-room send <id> ""` (empty submit) to dispatch. Claude Code submits multi-line text on the first send and does not need this.
- **Claude Code** (`--harness claude-code --command "claude"`): auto-loads the `agentroom` skill from `AGENTROOM_*` env vars. Codex also discovers it via its own skill mechanism if the symlinks are in place.
- Always pass `--cwd <dir>` when the agent's working directory is not the launch CWD. Verified: codex respects `--cwd` and reports it on boot (`directory: ~/...`).

## When a worker goes idle

Workers with the `agentroom` skill use `agent-room wait` to block on events instead of yielding the turn. If one goes idle anyway, read room state and send a one-line nudge.

## Reading worker output

`agent-room read <id> --lines N` returns the last N visible TUI rows from the pane (post-render). It is a snapshot of what a human would see, not an event log. For the canonical event stream use `agent-room events` or grep `.agentroom/events.jsonl`.

## Configuring chat gateways (partial wiring)

Chat gateways (Discord, Telegram, etc.) attach external conversations to room state. See `docs/ADR/0003-chat-gateway-port.md` and `docs/ARCHITECTURE.md` for the model. As of this writing, the port, inbound router, outbound dispatcher primitive, and Discord webhook-mode posting exist; the daemon does not yet load gateways from config. Treat daemon config examples as the target operator surface, not what ships today.

### Topology choice

Two valid topologies:

1. **Standalone agent.** No daemon involvement; a single agent (e.g. one Clanky) embeds `@agentroom/chat-discord` and owns its own token. Use when you want a personal agent with its own Discord identity and no room around it.
2. **Enrolled multi-agent room.** Daemon owns the gateway and the token; the Discord identity is the room's connector. Use when several agents must share a public face in a single Discord channel.

### Lead-as-public-face pattern (multi-agent room)

When mirroring Discord into a multi-agent room, designate one agent as the lead and route inbound chat to its stdin. Workers stay invisible to Discord and are only reached via AgentRoom DMs/tasks from the lead.

Sample launch:

```bash
agent-room launch clanky-lead     --harness pi --command "clanky --profile lead     --home ./.clanky-room" --cwd .
agent-room launch clanky-impl-a   --harness pi --command "clanky --profile impl-a   --home ./.clanky-room" --cwd .
agent-room launch clanky-reviewer --harness pi --command "clanky --profile reviewer --home ./.clanky-room" --cwd .
```

Each Clanky-style agent **must** get a distinct `--profile`. Sharing `~/.clanky` across instances corrupts memory and session state. `--home` should also be distinct (or at least segregated per profile) if you want isolated history per agent.

Then point the Discord route at the lead. Conceptually:

```text
provider:  discord-main
route:     guild=..., channel=#room-announcements  ->  agent-stdin:clanky-lead
```

The lead receives Discord input, then uses `agent-room post`/`agent-room dm`/`agent-room task` to delegate. Workers see only the room.

### Multi-agent attribution

When a Discord-mirrored channel is wired through `ChatGatewayOutboundDispatcher`, multiple agents can appear under distinct webhook identities (`username` + `avatar_url`) over a single bot token. The Discord bot must have `Manage Webhooks` on each target channel. Until daemon config/loading lands, this requires programmatic wiring.

### Configuration surface (planned)

A future `.agentroom/config.yaml` block will declare gateways and routes alongside the existing `runtimes` block. Tokens come from env, never the file. Until daemon wiring exists, gateways must be instantiated programmatically; there is no operator CLI for adding routes at runtime yet.

### Standalone embedding (not an operator task)

If a user wants a single agent with its own Discord identity, the agent imports `@agentroom/chat-discord` directly and runs the gateway in its own process. The operator surface here is empty — no daemon, no routes, no enrollment. Mention this to the user when they describe a single-agent use case so they don't pay the multi-agent room overhead unnecessarily.

## Runtime Boundary

Keep product language and persisted state in AgentRoom terms: agent, runtime, session, binding, output stream. Avoid teaching worker agents provider-specific commands; that knowledge belongs in runtime adapters and adapter-specific docs.
