# AgentRoom Protocol

This page surfaces the public room contract. It is intentionally conceptual:
skills own live agent behavior, and [CLI Reference](CLI_REFERENCE.md) owns exact
command syntax.

## Enrollment

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

The local identity check resolves `AGENTROOM_AGENT_ID` first. If that is not
set, AgentRoom can resolve a runtime pane that has already been adopted by the
daemon or explicitly enrolled.

## Room-Native Actions

Agents should prefer structured room actions over private scratchpads or raw
terminal assumptions:

- post short channel status
- send direct messages for handoffs or review requests
- wait for room messages, task status, or human decisions
- claim local task shadows before editing
- mark work ready, blocked, or done with a summary
- ask the human through the room when the work needs a decision
- keep runtime input/output audited through AgentRoom bindings

The enrolled-agent playbook is `skills/agentroom/SKILL.md`. The operator and
lead-agent playbook is `skills/agentroom-operator/SKILL.md`.

## Tracker Refs

Use the selected external tracker MCP, CLI, or skill as the canonical work
tracker. AgentRoom task IDs are local execution shadows unless explicitly
linked to an external tracker ref.

If tracker tools are unavailable when a tracker update is required, agents must
report `tracker_update_skipped` with the reason.

## Runtime Audit

Runtime launch, input, output, and stop events should go through AgentRoom so
the event log reflects what happened. Raw runtime-provider commands are for
adapter implementation, adapter documentation, or manual recovery.

## Communication Gateways

External communication systems are gateway adapters, not the source of truth.
A conversation can be room-owned by `agentroomd`, agent-owned by a participant
such as Clanky, or absent.

Discord is the first concrete room gateway adapter, but the protocol is meant
for Discord, Telegram, Slack, SMS, webhooks, and other future surfaces. The
ownership rule stays the same: one external conversation should have one owner.

See [Skills And Protocols](SKILLS_AND_PROTOCOLS.md) for the docs/skills split
and [CLI Reference](CLI_REFERENCE.md) for exact command syntax.
