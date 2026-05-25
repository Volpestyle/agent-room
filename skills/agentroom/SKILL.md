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
- Do not send input to another agent unless your role permits it.
- Do not read all runtime sessions unless your role permits it.
- Prefer structured commands over plain chat.
- If Linear tools are unavailable, report `tracker_update_skipped` with the reason.

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
