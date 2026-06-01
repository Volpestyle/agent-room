# Skills And Protocols

AgentRoom keeps protocols and skills public because they explain the system, but
they should not turn every guide into a CLI tutorial. Public docs should teach
the room model, ownership boundaries, and where a reader can find the exact
procedure when they need it.

## What Belongs Where

| Surface | Owns |
| --- | --- |
| Public docs | Product mental model, topology, protocol concepts, safety boundaries, and links to canonical references. |
| `.agentroom/AGENTS.md` | Editable per-room protocol for dashboard-agent and worker behavior. |
| Skills | Step-by-step behavior for agents and operators inside a live room. |
| CLI Reference | Complete command map for humans, scripts, and agents that need exact syntax. |
| MCP server | Tool surface for MCP-capable agents to inspect and coordinate through the room. |
| Source and tests | Runtime, daemon, storage, adapter, and schema truth. |

This split keeps the docs concise while still making the behind-the-scenes
contract visible.

## Room Protocol File

Each room may have `.agentroom/AGENTS.md` next to its `config.yaml`. Config owns
topology; this Markdown file owns room behavior and policy. It is the right
place to tune work tracker expectations, status cadence, coordination norms,
review flow, and any room-specific conventions that should be visible to humans
and agents.

`agent-room init` creates the default protocol file. Existing rooms can inspect
it with `agent-room protocol --json` or the TUI `/protocol` command. Launched
and enrolled agents receive `AGENTROOM_PROTOCOL_FILE` when AgentRoom can resolve
the room config, so generic skills can read the room protocol without hardcoding
a tracker or vendor.

## AgentRoom Skills

AgentRoom has two public local skills:

- `skills/agentroom/SKILL.md`: enrolled worker and reviewer behavior inside a
  room. This owns turn-by-turn procedure such as claiming work, posting status,
  waiting for room events, asking humans, reporting blockers, and finishing work.
- `skills/agentroom-operator/SKILL.md`: operator, lead-agent, and room-manager
  behavior. This owns launch preflight, runtime health checks, mobile pairing,
  runtime read/send/stop hygiene, pane adoption, and gateway operation.

The public docs may summarize what these skills do, but they should link to the
skills rather than restating command sequences. Custom room skills should be
documented publicly when they affect how users or other agents understand the
room.

## Protocols To Surface

Surface protocols when they change the mental model:

- AgentRoom enrollment: how a process knows it is participating in a room.
- Room-native coordination: channel messages, DMs, waits, handoffs, reports,
  human questions, blockers, and completion.
- Runtime audit: launch, input, output, binding, and stop events go through the
  room rather than raw terminal assumptions.
- Tracker refs: the durable tracker owns project work; AgentRoom messages,
  reports, and imported tracker events can point to stable tracker context.
- Gateway ownership: an external chat conversation is either agent-owned or
  room-owned, not both.
- Clanky participation: Clanky can run as a normal AgentRoom participant while
  keeping profile, memory, voice, and agent-owned connector concerns separate.

Protocol pages should describe the contract. Skills and the CLI reference should
carry the exact operational steps.

## Clanky And Cross-Product Contracts

Clanky, ClankVox, AgentRoom iOS, and supporting MCP packages should expose their
integration contracts in public docs when the contract is part of the product
picture. For AgentRoom specifically, the Clanky-side room contract lives in
[`../../clanky-pi/docs/AGENTROOM.md`](../../clanky-pi/docs/AGENTROOM.md).

Clanky's communication layer is a gateway abstraction. Discord text and Discord
voice are the current concrete adapters, not the boundary of the product.
Future Slack, Telegram, SMS, webhook, huddle, or other communication channels
should plug into the same ownership model: a conversation is agent-owned,
room-owned, or absent. Clanky's canonical local messaging remains the Pi session
thread, and AgentRoom's canonical coordination remains the room.

The same guidance applies there: publish the protocol and ownership model, keep
routine command recipes in a reference page or skill, and avoid copying the same
CLI sequence into every guide.

## When To Add A Command Example

Add a command example to a public guide only when it is one of these:

- the shortest first-run path
- a pairing or bootstrap step a human must perform
- a troubleshooting or recovery step
- an exact reference entry in `CLI_REFERENCE.md`
- a skill procedure that belongs in `skills/*/SKILL.md`

If the example is just showing ordinary agent behavior, put it in the relevant
skill and link to [AgentRoom Protocol](PROTOCOL.md) or
[CLI Reference](CLI_REFERENCE.md) instead.
