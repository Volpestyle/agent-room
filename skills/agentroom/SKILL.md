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
- Use threads for task-specific discussion when available.
- Ask another agent before interrupting its active work.
- Use `agentroom ask-human` for decisions that require the user.
- Use `agentroom block` when blocked.
- Use `agentroom handoff` before passing work to a reviewer.
- Use `agentroom done` only after tests/checks, or state clearly what was not checked.
- Do not send input to another agent unless your role permits it.
- Do not read all runtime sessions unless your role permits it.
- Prefer structured commands over plain chat.

## Core commands

```bash
agentroom whoami --json
agentroom post "Starting OAuth callback implementation" --channel implementation
agentroom task claim AR-42
agentroom ask-human "Which staging redirect URI should be canonical?"
agentroom block AR-42 --reason "Need redirect URI decision"
agentroom handoff AR-42 --to reviewer --summary ./handoff.md
agentroom done AR-42 --summary "Implemented callback and unit tests pass"
```
