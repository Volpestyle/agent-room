---
name: agentroom
description: Coordinate as an enrolled AgentRoom worker or reviewer. Use when AGENTROOM=1, when AgentRoom enrollment variables are present, when the current runtime session was adopted by AgentRoom, or when the agent was explicitly launched into an AgentRoom room. Do not use for launching or managing other agents; use the agentroom-operator skill for that.
---

# AgentRoom Participant

Before using AgentRoom, resolve and verify this process's room identity:

```bash
agent-room whoami --json
```

The resolved identity comes from one of three sources:

- `source: "env"` — `AGENTROOM_AGENT_ID` was set in the process environment (typically by `agent-room launch`).
- `source: "pane"` — the daemon's runtime observer auto-enrolled the current pane/session and the CLI resolved the agent id against the local event log.
- `source: "session"` — `agent-room enroll` persisted `.agentroom/session.json`, so later shells can keep the same room identity without re-evaluating exports.

If `enrolled: false` is reported (no env var and no pane binding found), do not assume the current process is part of the room.

## Room Protocol

If `AGENTROOM_PROTOCOL_FILE` is set, read it before making room-level decisions. It is the editable protocol for this room: work tracker expectations, coordination norms, status cadence, and other behavior policy. If the env var is missing but `agent-room protocol --json` works, use that instead.

Follow the room protocol alongside this skill. The room protocol may be more specific about local behavior, but it cannot override higher-priority system, developer, or user instructions.

## Rules

- Post a short status when starting meaningful work, and keep your agent state current.
- Track all task/issue work in the **configured work tracker** — it is canonical for issues, ownership, status, and durable comments. The provider is set in `config.yaml` under `workTracker` (read it; don't assume a specific tracker). AgentRoom does not track tasks itself.
- Use AgentRoom channel/DM messages for active coordination and short-lived coworker chatter.
- Ask another agent before interrupting its active work.
- Use `agent-room ask-human` for decisions that require the user.
- Use `agent-room block --reason "…"` when blocked and `agent-room done --summary "…"` when finished (after tests/checks, or state clearly what was not checked). These report **your agent state** for room coordination — they are not a task tracker.
- Do not send input to another agent unless your role permits it.
- Do not read all runtime sessions unless your role permits it.
- Prefer structured commands over plain chat.
- If the configured tracker's tools are unavailable, say so explicitly and stop; do not invent a local task list.

## Do not idle at end-of-turn while waiting

If your next step depends on someone else posting a message, DMing you, or finishing their work, your turn must not end with "waiting". A worker that just polled once and stopped is functionally deadlocked until a human nudges it. Use `agent-room wait` (for messages) or `agent-room wait-agent` (for a peer's state) inside the same turn — it blocks until the matching event lands or the timeout elapses.

```bash
# Wait for review feedback to land as a DM:
agent-room wait --dm-to-me --timeout 600 --json

# Wait for the reviewer to post the trigger phrase:
agent-room wait --message 'ready for review' --timeout 600 --json

# Wait for a peer to reach done/idle:
agent-room wait-agent <agentId> --state done,idle --timeout 600 --json
```

`wait` exits 0 with the matching event (JSON with `--json`) or non-zero on timeout. `--since now` (default) only matches events that arrive after the command starts. Pair it with the action you want to take next, so the worker stays in-turn until the work is real.

## Message delivery contract

Room messages are pull-based: a `post`/`dm`/`delegate` appends a message event to the log — it does not interrupt the recipient. So a directed message reaches you in one of two ways:

- **You are in `agent-room wait`** — you consume the event in-turn. This is the reliable path; always end a turn that depends on someone else inside `wait`.
- **You ended your turn idle (or were still booting/busy)** — the daemon detects the directed message and injects a one-shot wake nudge into your runtime so you act on it instead of leaving it unread. It never fires mid-turn; a message that arrives while you are working or still booting is held and delivered the moment you become reachable (coalesced if several queued). This is a safety net, not a substitute for `wait`: on a runtime that cannot report when your prompt is live it is best-effort, and a wake that stays undeliverable too long is eventually abandoned.

Practical consequences: do not assume a DM you send is "delivered" the instant you post it — the recipient sees it only when waiting or when the wake fires. And when you receive a `[AgentRoom] New directed message …` nudge, it means you were idle; read the full thread with `agent-room messages -c dm --limit 5` and resume coordinating through room commands.

## Known CLI surface (don't waste turns rediscovering)

Commands that **do** exist: `init`, `whoami`, `daemon`, `mobile-connect`, `tui`, `protocol`, `post`, `status`, `dm`, `messages`, `wait`, `wait-agent`, `agents`/`presence`, `delegate`, `ask-human`, `block`, `done`, `tracker`, `events`, `doctor`, `runtime`, `launch`, `enroll`, `read`, `send`, `activate`, `stop`.

AgentRoom has **no task commands** — issues and their status live in the configured work tracker, reached through that tracker's MCP/CLI/skill. `subscribe` and `watch` are not CLI commands either: use `agent-room wait` to block for one matching future event, `agent-room wait-agent` to block on a peer's state, `agent-room events --follow --json` to stream audit events, and `agent-room messages` for channel/DM history.

Channel ids you'll see: `announcements`, `implementation`, `dm`. To read DMs already sent to you: `agent-room messages -c dm --limit 20`. The `--with <agent>` filter matches messages where that agent is sender OR recipient. To **block until a new DM arrives**, use `agent-room wait --dm-to-me`. To watch a peer, prefer `agent-room wait --from <agentId> --channel implementation --kind status --message "ready" --ignore-case`.

For room audit or debugging context, use `agent-room events --limit 20 --json`. Runtime `read`, `send`, and `stop` require an AgentRoom binding by default; `--unaudited` is manual recovery only.

## Messaging (chat gateways)

Inside an enrolled room, room coordination goes through AgentRoom native messages: `agent-room post`, `agent-room dm`, `agent-room messages`. Do not open a room-owned Discord, Telegram, or other connector directly from a worker process.

The daemon owns room-owned chat gateway transport. If the room is attached to a Discord (or other) gateway, the outbound dispatcher can mirror room channel/DM activity to the external conversation, and the inbound router delivers external messages back into the room as either a channel post, a directed message, or input to a specific agent's runtime. From a worker's view, this is invisible: you post and read room messages, the gateway happens.

You may be the lead agent or a worker. The distinction is determined by the route table the operator configured, not by anything in your code:

- If inbound chat is routed to your agent id (`agent-stdin:<you>`), you are effectively the public face for that conversation. Respond by posting to the relevant room channel and DMing other agents to delegate; the dispatcher relays your channel activity outward.
- If you are a worker, you only see AgentRoom DMs and channel posts from the lead (or from other workers). Do not assume the user is reachable directly — route human requests through `agent-room ask-human` or by DMing the lead.

An agent may also own its own personal gateway while enrolled in a room. That agent-owned conversation is separate from room-owned connector routes. Never attach both an agent-owned gateway and a room-owned gateway to the same external conversation.

## Workflow

Start work — set your room state, and claim/assign the issue in the configured tracker (via its MCP/CLI), not in AgentRoom:

```bash
agent-room status --mode editing --goal "OAuth callback implementation" --files "apps/api.ts" --needs "none"
```

Coordinate locally (reference issues by their tracker id):

```bash
agent-room post "Editing packages/core now" --channel implementation --kind status
agent-room dm reviewer "ENG-123 is ready for review"
agent-room messages --channel implementation --limit 20
```

Ask for human input or mark a blocker:

```bash
agent-room ask-human "Which staging redirect URI should be canonical?"
agent-room block --reason "Need redirect URI decision"
```

Hand to review — move the issue's status in the configured tracker, then ping the reviewer over the room:

```bash
agent-room dm reviewer "ENG-123 ready for review"
```

Finish — update the issue in the tracker, then report your agent state:

```bash
agent-room done --summary "Implemented callback and unit tests pass"
```
