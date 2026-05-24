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
agentroom task claim AR-42
agentroom ask-human "Which redirect URI should staging use?"
agentroom block AR-42 --reason "Need staging redirect URI"
agentroom handoff AR-42 --to reviewer --summary ./handoff.md
agentroom done AR-42 --summary "Implemented and tested"
```

Only a subset exists in this scaffold. The rest are protocol placeholders.
