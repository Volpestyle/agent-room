---
name: agentroom
description: Coordinate with other long-running agents through AgentRoom. Use only when AGENTROOM=1.
---

# AgentRoom skill

Before using AgentRoom, check that this process is enrolled:

```bash
test "$AGENTROOM" = "1" || exit 1
agentroom whoami --json
```

If `AGENTROOM` is not set, do not assume the current process is part of the room.

## Rules

- Post a short status when starting meaningful work.
- Claim or confirm your assigned task before editing.
- Use Linear MCP/CLI/skills as the canonical tracker for issues, ownership, status, and durable comments.
- Use AgentRoom channel/DM messages for active coordination and short-lived coworker chatter.
- Use threads for task-specific discussion when available.
- Ask another agent before interrupting its active work.
- Use `agentroom ask-human` for decisions that require the user.
- Use `agentroom block` when blocked.
- Use `agentroom handoff` before passing work to a reviewer.
- Use `agentroom done` only after tests/checks, or state clearly what was not checked.
- Do not send input to another agent unless your role permits it.
- Do not read all runtime sessions unless your role permits it.
- Prefer structured commands over plain chat.
- If Linear tools are unavailable, report `tracker_update_skipped` with the reason.

## Core commands

```bash
agentroom whoami --json
agentroom post "Starting OAuth callback implementation" --channel implementation
agentroom dm reviewer "Ready for review on ENG-123"
agentroom messages --channel implementation --limit 20
agentroom task claim AR-42
agentroom task link-linear AR-42 ENG-123
agentroom task comment AR-42 "Implemented callback and unit tests pass"
agentroom ask-human "Which staging redirect URI should be canonical?"
agentroom block AR-42 --reason "Need redirect URI decision"
agentroom handoff AR-42 --to reviewer --summary ./handoff.md
agentroom done AR-42 --summary "Implemented callback and unit tests pass"
```
