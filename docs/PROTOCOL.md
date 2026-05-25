# AgentRoom Protocol Notes

## Agent opt-in

A process is enrolled only when launched by AgentRoom or explicitly configured to join.

Expected environment variables:

```bash
AGENTROOM=1
AGENTROOM_AGENT_ID=api-impl
AGENTROOM_ROOM_ID=my-project
AGENTROOM_ROLE=implementer
AGENTROOM_TOKEN=...
AGENTROOM_DAEMON=http://127.0.0.1:4317
```

## Structured actions

Agents should prefer structured commands over free-form chat. The canonical local command is `agent-room`:

```bash
agent-room whoami --json
agent-room post "Starting task" --channel implementation --kind status
agent-room dm reviewer "Ready for review on ENG-123"
agent-room messages --channel implementation --limit 20
agent-room task claim AR-42
agent-room task link-linear AR-42 ENG-123
agent-room task comment AR-42 "Implemented callback and tests pass"
agent-room task status AR-42 ready-for-review --summary "Implemented callback and tests pass"
agent-room ask-human "Which redirect URI should staging use?" --task AR-42
agent-room block AR-42 --reason "Need staging redirect URI"
agent-room done AR-42 --summary "Implemented and tested"
```

Use Linear MCP/CLI/skills as the canonical work tracker. AgentRoom task IDs are local shadows unless explicitly linked to Linear. If Linear tools are unavailable when a tracker update is required, report `tracker_update_skipped` with the reason.

Use `skills/agentroom/SKILL.md` as the enrolled-agent behavior playbook.
