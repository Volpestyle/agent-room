---
name: agentroom-operator
description: Manage AgentRoom rooms and runtime-backed agents from outside an enrolled worker process. Use when asked to initialize AgentRoom, inspect runtime health, launch agents, or send/read runtime input/output from an operator or lead-agent context.
---

# AgentRoom Operator

Use this skill to manage a room from the outside. For worker or reviewer behavior inside an enrolled process, use the `agentroom` skill instead.

## Preflight

Verify the project room and runtime before launching agents:

```bash
test -f .agentroom/config.yaml
agent-room runtime providers
agent-room runtime doctor
```

If `.agentroom/config.yaml` is missing, choose the runtime provider first and initialize explicitly:

```bash
agent-room init --room "$(basename "$PWD")" --runtime RUNTIME
```

If runtime health reports a provider-specific problem, fix it through AgentRoom configuration or the relevant adapter docs. Do not bypass AgentRoom for normal launch, read, send, or stop flows.

## Mobile pairing

For iOS/mobile access over Tailscale, start the daemon with tailnet binding and copy the pairing link:

```bash
agent-room daemon start --tailnet
agent-room mobile-connect --copy
```

The copied `agentroom://connect?...` link includes the daemon URL and bearer token. Open it on the iPhone to save the connection in AgentRoom and connect without typing the fields manually.

## Launch Agents

Prefer launching the intended harness directly when known:

```bash
agent-room launch impl --harness HARNESS_KIND --command "AGENT_COMMAND" --cwd .
agent-room read impl --lines 40
```

If allocating a shell first, treat it as a bound shell session until a coding-agent command starts:

```bash
agent-room launch impl --harness shell --command "bash" --cwd .
agent-room send impl "AGENT_COMMAND"
agent-room read impl --lines 40
agent-room send impl "Use AgentRoom, claim your assigned task, and post a short status before editing."
```

Use `agent-room send/read/stop` for bound agents so runtime input and output are audited. These commands require an AgentRoom binding by default; use `--unaudited` only for manual recovery when the session is not AgentRoom-bound.

## Adopt an existing pane

For panes that already exist outside an AgentRoom `launch` flow — typically a shell the human opened directly — the running daemon adopts them automatically by listening to its runtime adapter's pane lifecycle events. The agent id is derived from the runtime's session and pane identifiers (e.g. `herdr:<session>:<pane>`) and CLI writes from inside the pane resolve identity via the daemon, so no shell-level configuration is required.

When the daemon is not running, `agent-room enroll --json` from inside a pane performs the same adoption as a one-off and writes the binding to the local event log.

`enroll` requires a runtime that advertises `adoptAgent` in its capabilities; see `docs/RUNTIMES.md` for adapter-specific behavior.

## Herdr pane-grid launch hygiene

If the selected runtime is Herdr with `pane-grid`, stale panes from earlier work can crowd a reused workspace. When starting fresh work, prefer a new Herdr workspace label so the new agents get full-size panes:

```bash
agent-room launch impl-a --workspace squad-foo --harness HARNESS_KIND --command "AGENT_COMMAND" --cwd .
agent-room launch impl-b --workspace squad-foo --harness HARNESS_KIND --command "AGENT_COMMAND" --cwd .
```

A workspace with `panesPerTab: 2` plus two agents = one tab, two side-by-side panes in Herdr. See `docs/RUNTIMES.md` for provider-specific layout details and cleanup notes.

## Herdr session mental model

Do not confuse Herdr sessions with Herdr workspaces:

- Herdr session namespace: the server/socket namespace and the value for `herdr --session <name>`.
- Herdr workspace label: AgentRoom's human grouping label inside that session.
- Herdr workspace id: an internal id like `w652aca9fd72f08`; AgentRoom runtime agents may expose it as `sessionId` because it is where the pane lives, but it is not a Herdr `--session` value.
- Pane/binding id: the id AgentRoom uses for audited `read`, `send`, and `stop`.

When an operator asks how to join or inspect Herdr, first check structured runtime status:

```bash
agent-room runtime doctor --json
```

In the TUI, use `/runtime` or `/runtime herdr`. Answer with the configured Herdr session namespace and socket. Clearly label workspace ids as not `--session` values.

## Harness quirks

- **Codex** (`--harness codex --command "codex"`): a multi-line prompt sent via `agent-room send <id> "<long text>"` lands in the TUI prompt but is **not auto-submitted**. Follow with `agent-room send <id> ""` (empty submit) to dispatch. Claude Code submits multi-line text on the first send and does not need this.
- **Claude Code** (`--harness claude-code --command "claude"`): auto-loads the `agentroom` skill from `AGENTROOM_*` env vars. Codex also discovers it via its own skill mechanism if the symlinks are in place.
- Always pass `--cwd <dir>` when the agent's working directory is not the launch CWD. Verified: codex respects `--cwd` and reports it on boot (`directory: ~/...`).

## When a worker goes idle

Workers with the `agentroom` skill use `agent-room wait` to block on events instead of yielding the turn. If one goes idle anyway, read room state and send a one-line nudge.

## Reading worker output

`agent-room read <id> --lines N` returns the last N visible TUI rows from the pane (post-render). It is a snapshot of what a human would see, not an event log. For the canonical event stream use `agent-room events` or grep `.agentroom/events.jsonl`.

## Configuring chat gateways

Chat gateways (Discord, Telegram, etc.) attach external conversations to room state. See `docs/ADR/0003-chat-gateway-port.md` and `docs/ARCHITECTURE.md` for the model. As of this writing, the port, inbound router, outbound dispatcher primitive, Discord webhook-mode posting, and daemon config loading exist. For Discord-specific reads/actions outside the room projection, use the local `discord-mcp` package rather than adding Discord REST logic to AgentRoom.

### Ownership choice

Room participation and gateway ownership are separate choices:

1. **Agent-owned gateway.** A single agent (e.g. Clanky) embeds `@agentroom/chat-discord` and owns its own token. Use when you want that agent to keep its Discord identity. This can coexist with AgentRoom participation.
2. **Room-owned gateway.** Daemon owns the gateway and token for a specific conversation; the Discord identity is the room's connector. Use when several agents must share a public face in a single Discord channel.

One Discord channel or DM should have exactly one owner. Do not attach both an agent-owned gateway and a room-owned gateway to the same conversation.

Discord is a projection surface, not AgentRoom's source of truth. AgentRoom owns rooms, tasks, channels, routing, and the event log; Discord messages are imported/mirrored through the gateway. Use AgentRoom tools for room coordination and `discord-mcp` for Discord-only operations like reading a separate channel, loading attachment pixels, sending a one-off Discord message, or adding reactions.

### Lead-as-public-face pattern (multi-agent room)

When mirroring a room-owned Discord conversation into a multi-agent room, designate one agent as the lead and route inbound chat to its stdin. Workers stay invisible to that Discord conversation and are only reached via AgentRoom DMs/tasks from the lead.

Example launch for a Pi/Clanky-style room:

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

When a Discord-mirrored channel is wired through `ChatGatewayOutboundDispatcher`, multiple agents can appear under distinct webhook identities (`username` + `avatar_url`) over a single bot token. The Discord bot must have `Manage Webhooks` on each target channel.

### Configuration surface

Declare gateways and routes alongside the existing `runtimes` block. Tokens come from env, never the file. There is no operator CLI for adding routes at runtime yet.

```yaml
chat:
  gateways:
    discord-main:
      type: discord
      tokenEnv: AGENTROOM_DISCORD_TOKEN
      credentialKind: bot-token
      webhookMode: true
      webhookName: AgentRoom
  routes:
    main-lead:
      provider: discord-main
      conversationId: "1234567890"
      conversationKind: channel
      target:
        type: agent-stdin
        agentId: clanky-lead
      outbound:
        type: agent-message
        agentId: clanky-lead
        channelId: implementation
```

Messages posted through the daemon HTTP API are mirrored through outbound routes. Messages posted by separate CLI processes are recorded in the event log but are not yet streamed through the daemon dispatcher.

### Agent-owned embedding (not an operator task)

If a user wants a single agent with its own Discord identity, the agent imports `@agentroom/chat-discord` directly and runs the gateway in its own process. The operator surface here is empty for that conversation — no daemon route is needed. The same agent may still be launched into AgentRoom for coordination.

## Runtime Boundary

Keep product language and persisted state in AgentRoom terms: agent, runtime, session, binding, output stream. Avoid teaching worker agents provider-specific commands; that knowledge belongs in runtime adapters and adapter-specific docs.
