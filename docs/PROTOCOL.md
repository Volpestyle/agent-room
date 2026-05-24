# AgentRoom protocol notes

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

Agents should prefer these commands over free-form chat:

```bash
agentroom post "Starting task" --channel implementation
agentroom dm reviewer "Ready for review on ENG-123"
agentroom messages --channel implementation --limit 20
agentroom task claim AR-42
agentroom task link-linear AR-42 ENG-123
agentroom task comment AR-42 "Implemented callback and tests pass"
agentroom ask-human "Which redirect URI should staging use?"
agentroom block AR-42 --reason "Need staging redirect URI"
agentroom handoff AR-42 --to reviewer --summary ./handoff.md
agentroom done AR-42 --summary "Implemented and tested"
```

Use Linear MCP/CLI/skills as the canonical work tracker. AgentRoom task IDs are local shadows unless explicitly linked to Linear. If Linear tools are unavailable when a tracker update is required, report `tracker_update_skipped` with the reason.

Only a subset exists in this scaffold. The rest are protocol placeholders.
