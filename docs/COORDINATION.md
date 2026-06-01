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

Agents should use the selected tracker through that tracker's MCP server, CLI,
or skill. AgentRoom should not reimplement an issue database or workflow
engine.

AgentRoom can record provider-neutral tracker refs on room messages, reports,
and imported tracker events, but those refs do not make AgentRoom the tracker.

## AgentRoom Is The Room

AgentRoom is the native coordination plane around active agent execution:

- channel messages
- direct messages
- handoffs
- short status updates
- human questions
- runtime launch/input/output audit events
- agent-state signals such as `blocked`, `done`, and `idle`
- user-visible reports and imported tracker events

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

## No Native Task Store

AgentRoom does not store or track tasks. There are no `agent-room task ...`
commands and no task API. Assignment inside the room is a message or DM that
points an agent at a tracker issue, branch, file, URL, or markdown checklist
item.

Common flow:

```bash
agent-room delegate impl "Pick up ENG-123: implement runtime audit" --json
agent-room wait-agent impl --state done,idle
agent-room feed --json
```

If no external tracker is configured, keep the durable checklist in the repo
such as `TASKS.md` or the PR description. AgentRoom still records the room
coordination around that work: messages, handoffs, runtime audit, agent state,
reports, and human questions.

## Tracker Update Failures

If the selected tracker MCP, CLI, skill, bridge, or credentials are unavailable, agents must report `tracker_update_skipped` with the reason. Do not silently pretend a tracker update happened.
