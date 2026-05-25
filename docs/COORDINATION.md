# Coordination Model

AgentRoom has two coordination layers with different jobs.

For enrolled agents, this guidance is operationalized in `skills/agentroom/SKILL.md`.

## Linear Is The Work Tracker

Linear is the canonical source of truth for planned work:

- issues
- ownership
- priority
- workflow status
- acceptance criteria
- durable implementation notes
- review comments that should survive outside the room

Agents should use the Linear MCP server, CLI, or Linear-specific skills for creating, finding, updating, and commenting on tracked work. AgentRoom should not reimplement Linear's issue database or workflow engine.

Recommended MCP setup:

```bash
codex mcp add linear --url https://mcp.linear.app/mcp
```

If the MCP client requires remote MCP support, enable the relevant Codex remote MCP feature and authenticate with Linear. See Linear's MCP documentation at `https://linear.app/docs/mcp`.

## AgentRoom Is The Room

AgentRoom is the native coordination plane around active agent execution:

- channel messages
- direct messages
- task-specific threads
- handoffs
- short status updates
- human questions
- runtime launch/input/output audit events
- local task shadows that link active agent work to Linear issues

These messages are intentionally lighter than Linear comments. Use them for coworker-style coordination that would be noisy in the tracker.

## What To Put Where

Put it in Linear when it changes the durable work record:

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

If a room message becomes important to the durable work record, post a concise Linear comment through MCP and keep the AgentRoom message as local execution context.

## Local Task Shadows

AgentRoom can keep local task shadows so agents can attach runtime state and room messages to a piece of work. These local tasks should normally link to a `linear-issue` ref:

```bash
agent-room task create "Implement runtime audit" --linear ENG-123
agent-room task link-linear task_implement_runtime_audit_xxx ENG-123
```

New local task IDs include a creation-time title slug plus a UUID suffix, for example `task_implement_runtime_audit_<uuid>`, so logs and commands stay readable without losing uniqueness.

When a Linear ref is present, treat Linear as canonical and AgentRoom as the local room/audit layer.

## Tracker Update Failures

If Linear MCP, CLI, or credentials are unavailable, agents must report `tracker_update_skipped` with the reason. Do not silently pretend a tracker update happened.
