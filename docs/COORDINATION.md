# Coordination Model

AgentRoom has two coordination layers with different jobs.

For enrolled agents, this guidance is operationalized in `skills/agentroom/SKILL.md`.

## External Work Tracker

Choose one durable work tracker for planned work:

- issues
- ownership
- priority
- workflow status
- acceptance criteria
- durable implementation notes
- review comments that should survive outside the room

Agents should use the selected tracker through that tracker's MCP server, CLI, skill, or AgentRoom provider bridge. AgentRoom should not reimplement an issue database or workflow engine.

The current concrete bridge is Linear (`@agentroom/worktracker-linear` and `linear-issue` refs). Other trackers should be integrated through their own provider or represented as explicit refs until a bridge exists.

## AgentRoom Is The Room

AgentRoom is the native coordination plane around active agent execution:

- channel messages
- direct messages
- task-specific threads
- handoffs
- short status updates
- human questions
- runtime launch/input/output audit events
- local task shadows that can link active agent work to external tracker refs

These messages are intentionally lighter than tracker comments. Use them for coworker-style coordination that would be noisy in the durable tracker.

## What To Put Where

Put it in the selected work tracker when it changes the durable work record:

- a new task or bug exists
- ownership changes
- status changes
- acceptance criteria changes
- important implementation or review context should stay with the issue
- the human needs to see it in the normal project tracker

Put it in AgentRoom when it coordinates active execution:

- "I am editing `packages/core` now"
- "Reviewer, look at this output"
- "Tests are running in agent `qa-1`"
- "Do not interrupt `impl-2`; it is applying a patch"
- runtime input/output audit
- short-lived channel or DM chatter

If a room message becomes important to the durable work record, post a concise tracker comment through the selected tracker integration and keep the AgentRoom message as local execution context.

## Local Task Shadows

AgentRoom can keep local task shadows so agents can attach runtime state and room messages to a piece of work. These local tasks should normally link to the selected tracker when a durable issue exists.

Linear example:

```bash
agent-room task create "Implement runtime audit" --linear ENG-123
agent-room task link-linear task_implement_runtime_audit_xxx ENG-123
```

New local task IDs include a creation-time title slug plus a UUID suffix, for example `task_implement_runtime_audit_<uuid>`, so logs and commands stay readable without losing uniqueness.

When an external tracker ref is present, treat that tracker as canonical and AgentRoom as the local room/audit layer.

## Tracker Update Failures

If the selected tracker MCP, CLI, skill, bridge, or credentials are unavailable, agents must report `tracker_update_skipped` with the reason. Do not silently pretend a tracker update happened.
