# AgentRoom Protocol Notes

## Agent opt-in

A process is enrolled only when launched by AgentRoom or explicitly configured to join.

Expected environment variables:

```bash
AGENTROOM=1
AGENTROOM_AGENT_ID=api-impl
AGENTROOM_ROOM_ID=my-project
AGENTROOM_ROLE=implementer
AGENTROOM_DAEMON=http://127.0.0.1:4317
AGENTROOM_API_TOKEN=... # only needed when the daemon requires API auth
```

`agent-room whoami --json` resolves identity from `AGENTROOM_AGENT_ID` first. If that is not set, it can resolve a Herdr pane that has already been adopted by the daemon or enrolled with `agent-room enroll`.

## Structured actions

Agents should prefer structured commands over free-form chat. The canonical local command is `agent-room`:

```bash
agent-room whoami --json
agent-room post "Starting task" --channel implementation --kind status
agent-room dm reviewer "Ready for review on ENG-123"
agent-room messages --channel implementation --limit 20
agent-room task show AR-42 --json
agent-room task claim AR-42
agent-room task status AR-42 ready-for-review --summary "Implemented callback and tests pass"
agent-room ask-human "Which redirect URI should staging use?" --task AR-42
agent-room block AR-42 --reason "Need staging redirect URI"
agent-room done AR-42 --summary "Implemented and tested"
```

Use the selected external tracker MCP/CLI/skill/provider as the canonical work tracker. AgentRoom task IDs are local shadows unless explicitly linked to an external tracker ref. If tracker tools are unavailable when a tracker update is required, report `tracker_update_skipped` with the reason.

Current Linear bridge commands:

```bash
agent-room task link-linear AR-42 ENG-123
agent-room task comment AR-42 "Implemented callback and tests pass"
```

Use `skills/agentroom/SKILL.md` as the enrolled-agent behavior playbook.
