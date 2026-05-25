---
name: agentroom
description: Coordinate as an enrolled AgentRoom worker or reviewer. Use when AGENTROOM=1, when AgentRoom enrollment variables are present, or when the agent was explicitly launched into an AgentRoom room. Do not use for launching or managing other agents; use the agentroom-operator skill for that.
---

# AgentRoom Participant

Before using AgentRoom, verify this process is enrolled:

```bash
test "${AGENTROOM:-}" = "1" || exit 1
agent-room whoami --json
```

If `AGENTROOM` is not set, do not assume the current process is part of the room.

## Rules

- Post a short status when starting meaningful work.
- Claim or confirm your assigned task before editing.
- Use Linear MCP/CLI/skills as the canonical tracker for issues, ownership, status, and durable comments.
- Use AgentRoom channel/DM messages for active coordination and short-lived coworker chatter.
- Use threads for task-specific discussion when available.
- Ask another agent before interrupting its active work.
- Use `agent-room ask-human` for decisions that require the user.
- Use `agent-room block` when blocked.
- Use `agent-room done` only after tests/checks, or state clearly what was not checked.
- Use `agent-room task status` for intermediate workflow states such as `working` and `ready-for-review`.
- Do not send input to another agent unless your role permits it.
- Do not read all runtime sessions unless your role permits it.
- Prefer structured commands over plain chat.
- If Linear tools are unavailable, report `tracker_update_skipped` with the reason.

## Do not idle at end-of-turn while waiting

If your next step depends on someone else posting a message, DMing you, or finishing a task, your turn must not end with "waiting". A worker that just polled once and stopped is functionally deadlocked until a human nudges it. Use `agent-room wait` inside the same turn — it blocks until the matching event lands or the timeout elapses.

```bash
# Wait for review feedback to land as a DM:
agent-room wait --dm-to-me --timeout 600 --json

# Wait for the reviewer to post the trigger phrase:
agent-room wait --message 'ready for review' --timeout 600 --json

# Wait for a specific task to flip status:
agent-room wait --task-status "$TASK:ready-for-review" --timeout 600
```

`wait` exits 0 with the matching event (JSON with `--json`) or non-zero on timeout. `--since now` (default) only matches events that arrive after the command starts. Pair it with the action you want to take next, so the worker stays in-turn until the work is real.

## Known CLI surface (don't waste turns rediscovering)

Commands that **do** exist: `init`, `whoami`, `post`, `dm`, `messages`, `wait`, `task {create,list,show,claim,status,link-linear,comment}`, `ask-human`, `block`, `done`, `tracker`, `events`, `doctor`, `runtime`, `launch`, `read`, `send`, `stop`.

`subscribe` and `watch` are not CLI commands. Use `agent-room wait` to block for one matching future event, `agent-room events --follow --json` to stream audit events, `agent-room messages` for channel/DM history, and `agent-room events` for audit snapshots. To inspect a task by id: `agent-room task show <id> --json`.

Channel ids you'll see: `announcements`, `implementation`, `dm`. To read DMs already sent to you: `agent-room messages -c dm --limit 20`. The `--with <agent>` filter matches messages where that agent is sender OR recipient. To **block until a new DM arrives**, use `agent-room wait --dm-to-me`.

For room audit or debugging context, use `agent-room events --limit 20 --json`. Runtime `read`, `send`, and `stop` require an AgentRoom binding by default; `--unaudited` is manual recovery only.

## Messaging (chat gateways)

Inside an enrolled room, room coordination goes through AgentRoom native messages: `agent-room post`, `agent-room dm`, `agent-room messages`. Do not open a room-owned Discord, Telegram, or other connector directly from a worker process.

The daemon owns room-owned chat gateway transport. If the room is attached to a Discord (or other) gateway, the outbound dispatcher can mirror room channel/DM activity to the external conversation, and the inbound router delivers external messages back into the room as either a channel post, a directed message, or input to a specific agent's runtime. From a worker's view, this is invisible: you post and read room messages, the gateway happens.

You may be the lead agent or a worker. The distinction is determined by the route table the operator configured, not by anything in your code:

- If inbound chat is routed to your agent id (`agent-stdin:<you>`), you are effectively the public face for that conversation. Respond by posting to the relevant room channel and DMing other agents to delegate; the dispatcher relays your channel activity outward.
- If you are a worker, you only see AgentRoom DMs and channel posts from the lead (or from other workers). Do not assume the user is reachable directly — route human requests through `agent-room ask-human` or by DMing the lead.

An agent may also own its own personal gateway while enrolled in a room. That agent-owned conversation is separate from room-owned connector routes. Never attach both an agent-owned gateway and a room-owned gateway to the same external conversation.

## Workflow

Start work:

```bash
agent-room post "Starting OAuth callback implementation" --channel implementation --kind status
agent-room task claim AR-42
agent-room task status AR-42 working
```

Coordinate locally:

```bash
agent-room post "Editing packages/core now" --channel implementation --kind status
agent-room dm reviewer "AR-42 is ready for review"
agent-room messages --channel implementation --limit 20
```

Update durable tracker state through Linear MCP/CLI/skills. If using the AgentRoom bridge:

```bash
agent-room task comment AR-42 "Implemented callback and unit tests pass"
agent-room tracker status ENG-123 "In Review"
```

Ask for human input or mark a blocker:

```bash
agent-room ask-human "Which staging redirect URI should be canonical?" --task AR-42
agent-room block AR-42 --reason "Need redirect URI decision"
```

Pass to review with existing commands:

```bash
agent-room task status AR-42 ready-for-review --summary "Implemented callback and unit tests pass"
agent-room dm reviewer "AR-42 is ready for review"
```

Finish:

```bash
agent-room done AR-42 --summary "Implemented callback and unit tests pass"
```
