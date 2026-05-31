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
agent-room protocol --json
agent-room runtime providers
agent-room runtime doctor
```

If `.agentroom/config.yaml` is missing, choose the runtime provider first and initialize explicitly:

```bash
agent-room init --room "$(basename "$PWD")" --runtime RUNTIME
```

If runtime health reports a provider-specific problem, fix it through AgentRoom configuration or the relevant adapter docs. Do not bypass AgentRoom for normal launch, read, send, or stop flows.

`.agentroom/config.yaml` is topology. `.agentroom/AGENTS.md` is the editable room protocol for dashboard-agent and worker behavior. Change the protocol file for room norms, work tracker expectations, and agent instructions; reserve config edits for machine-readable room setup.

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
agent-room send impl "Use AgentRoom, pick up your assigned issue in the configured work tracker, and post a short status before editing."
```

Use `agent-room send/read/stop` for bound agents so runtime input and output are audited. These commands require an AgentRoom binding by default; use `--unaudited` only for manual recovery when the session is not AgentRoom-bound.

## Delegate and await

AgentRoom does not track the task itself — the work item lives in the **configured work tracker**. Assignment is a directed message that points the worker at a tracker issue, plus a wait on the worker's agent state:

```bash
agent-room agents
agent-room delegate impl "Pick up ENG-123: implement OAuth callback" --json
agent-room wait-agent impl --state done,blocked,idle --timeout 1800 --json
```

`delegate` posts a directed message to the assignee (and wakes it if idle — see "When a worker goes idle"); it is a thin convenience wrapper over `dm`. The worker tracks the issue in the configured tracker and reports completion via its agent state (`agent-room done`), which `wait-agent` observes.

Canonical lead flow:

```bash
agent-room enroll --json
agent-room whoami --json
agent-room agents
agent-room delegate WORKER "Pick up ENG-123: <clear statement>" --json
agent-room wait-agent WORKER --state done,blocked,idle --timeout 1800 --json
# Review lives in the configured tracker; move the issue there, then ping the reviewer over the room:
agent-room dm reviewer "ENG-123 ready for review"
```

For manual enrollment, `agent-room enroll` persists `.agentroom/session.json`, so later shells keep the same identity. Use `agent-room enroll --print-env-file` when a harness specifically needs a sourceable env file.

## Adopt an existing pane

For panes that already exist outside an AgentRoom `launch` flow — typically a coding agent the human opened directly — the running daemon adopts them automatically after the runtime reports an agent identity for the pane. The agent id is derived from the runtime's session and pane identifiers (e.g. `herdr:<session>:<pane>`) and CLI writes from inside the pane resolve identity via the daemon, so no shell-level configuration is required. Plain shells, log panes, and dashboard panes should not become room agents unless they are explicitly enrolled or launched.

When the daemon is not running, `agent-room enroll --json` from inside a pane performs the same adoption as a one-off and writes the binding to the local event log.

`enroll` requires a runtime that advertises `adoptAgent` in its capabilities; see `docs/RUNTIMES.md` for adapter-specific behavior.

### Activation prompt (so adopted agents follow the room)

A directly-started pane never received `AGENTROOM_*` env, so its harness cannot auto-load the `agentroom` skill on its own. To close that gap, AgentRoom injects a one-shot **activation prompt** into the pane (via the runtime's audited `sendInput`) telling the agent it is enrolled and must load the `agentroom` skill, confirm `whoami`, read the protocol, and post a status.

- **Auto:** when the daemon adopts a new pane, it sends the activation prompt automatically — first adoption only, so reconcile ticks and daemon restarts never re-prompt a working agent.
- **Enroll:** `agent-room enroll` sends it by default after binding; pass `--no-activate` to suppress.
- **Manual:** `agent-room activate <agentId>` (re)sends it to any bound agent. Over the daemon API: `POST /v1/runtime/:providerId/agents/:agentId/activate`.

Activation needs a runtime with the `sendInput` capability and a current binding. Codex panes get a trailing empty submit automatically; Claude Code submits on the first send.

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

Workers with the `agentroom` skill use `agent-room wait` to block on events instead of yielding the turn. If one goes idle anyway, you do **not** need to hand-inject raw terminal input to make a DM or delegation land: the daemon tails the event log and, for any directed `dm`/`delegate`, injects a one-shot wake nudge into an idle recipient's runtime via the audited `sendInput` path. So `agent-room dm <id> "<work>"` or `agent-room delegate <id> "<work>"` is sufficient to both record the work and rouse an idle worker — reach for raw `agent-room send` only for the cases the wake cannot cover (below).

The wake is gated on agent state so it never corrupts active work: while a worker is `working`/`reviewing`, or still booting (`starting`/`created`) on a runtime that reports readiness, the directed message is **held and re-attempted, not dropped** — it lands the moment the agent next becomes reachable (turn ends, or the harness finishes booting). Messages that queue during that window are coalesced into a single nudge. So DMing a worker you launched a moment ago, or one that is mid-task, is now safe: the wake catches up.

Two caveats remain. A runtime with no semantic state (tmux) cannot tell the daemon when its prompt is live, so its DMs are delivered best-effort and can still race a boot — prefer launching the harness with the task baked into `--command`, or read back the prompt before `agent-room send`, for tmux workers. And a held wake is bounded: if a recipient never becomes reachable it is abandoned after a couple of minutes and logged, rather than waiting forever.

## Reading worker output

`agent-room read <id> --lines N` returns the last N visible TUI rows from the pane (post-render). It is a snapshot of what a human would see, not an event log. For the canonical event stream use `agent-room events` or grep `.agentroom/events.jsonl`.

## Configuring chat gateways

Chat gateways (Discord, Telegram, etc.) attach external conversations to room state. See `docs/ADR/0003-chat-gateway-port.md` and `docs/ARCHITECTURE.md` for the model. As of this writing, the port, inbound router, outbound dispatcher primitive, Discord webhook-mode posting, and daemon config loading exist. For Discord-specific reads/actions outside the room projection, use the local `discord-mcp` package rather than adding Discord REST logic to AgentRoom.

### Ownership choice

Room participation and gateway ownership are separate choices:

1. **Agent-owned gateway.** A single agent (e.g. Clanky) embeds `@agentroom/chat-discord` and owns its own token. Use when you want that agent to keep its Discord identity. This can coexist with AgentRoom participation.
2. **Room-owned gateway.** Daemon owns the gateway and token for a specific conversation; the Discord identity is the room's connector. Use when several agents must share a public face in a single Discord channel.

One Discord channel or DM should have exactly one owner. Do not attach both an agent-owned gateway and a room-owned gateway to the same conversation.

Discord is a projection surface, not AgentRoom's source of truth. AgentRoom owns rooms, channels, routing, and the event log (task tracking lives in the configured work tracker); Discord messages are imported/mirrored through the gateway. Use AgentRoom tools for room coordination and `discord-mcp` for Discord-only operations like reading a separate channel, loading attachment pixels, sending a one-off Discord message, or adding reactions.

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

The lead receives Discord input, then uses `agent-room post`/`agent-room dm`/`agent-room delegate` to coordinate. Workers see only the room.

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
