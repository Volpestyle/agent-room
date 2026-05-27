# AgentRoom Protocol

This file is the editable room protocol. Keep machine topology in config.yaml;
keep agent behavior, room norms, and work-tracker policy here.

## Core Rules

- The configured external work tracker is canonical for durable project work.
- AgentRoom tasks are local execution shadows and audit context.
- Use AgentRoom messages and DMs for active coordination inside the room.
- Use the configured tracker MCP, connector, CLI, or skill for tracker actions.
- Link external tracker issues back to local task shadows with tracker refs.
- If tracker tools are unavailable, report tracker_update_skipped with the reason.
- Secrets and auth stay in each agent runtime, MCP connector, env, or auth store.

## Worker Behavior

- Post a short status before meaningful work.
- Claim or confirm the relevant task before editing.
- Use room-native waits, questions, blockers, and done updates.
- Keep comments concise: what changed, what was verified, and remaining risk.

## Operator Behavior

- Prefer AgentRoom launch/read/send/stop so runtime actions are audited.
- Verify runtime health before launching new workers.
- Do not bypass the room unless it is manual recovery.
