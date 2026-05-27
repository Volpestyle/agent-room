# Configuration Model

AgentRoom uses one typed durable configuration model with multiple editing
surfaces.

## Source Of Truth

`.agentroom/config.yaml` is the durable source of truth for room topology:

- room id and name
- default runtime provider and runtime adapter settings
- portable, non-secret work tracker selection
- optional Clanky home/profile defaults for rooms that launch Clanky
- dashboard operator defaults
- room-owned chat gateways and routes
- event-store location

The file is parsed, validated, and formatted by `@agentroom/config`. Hand edits,
CLI commands, daemon APIs, and future TUI settings screens should all round-trip
through that same package.

The event log is not static configuration. `.agentroom/events.jsonl` records
runtime bindings, messages, task shadows, chat ingress/egress, and audit events.
It can rebuild room views, but it should not become the place where topology is
configured.

Secrets do not belong in `.agentroom/config.yaml`. Store references such as
`tokenEnv: AGENTROOM_DISCORD_TOKEN`, then supply the secret through the launch
environment or a dedicated auth store. The TUI's model credentials live in
`~/.agentroom/auth.json`; those credentials configure the dashboard agent, not
room topology.

The portable cross-product subset is intentionally non-secret:

```yaml
workTracker:
  default: linear
  providers:
    linear:
      type: linear
      tokenEnv: LINEAR_API_KEY
      commandEnv: AGENTROOM_LINEAR_COMMAND
      teamId: team_123

clanky:
  home: .clanky-room
  profile: lead
  chatGatewayOwner: room
```

AgentRoom owns this file. Clanky may read `workTracker` and `clanky` as launch
defaults when it starts inside the project, but Clanky still owns its profile
credentials, memory, sessions, and agent-owned connector state.

## Editing Surfaces

The intended product model is:

```text
.agentroom/config.yaml  durable, reviewable, headless
AgentRoom TUI           human-friendly editor, status, and lifecycle controls
CLI / daemon API        scriptable operations over the same config model
```

The TUI should be able to configure all durable AgentRoom settings over time,
but it must not create a second hidden topology store. A TUI config editor should
load the YAML through `@agentroom/config`, show the effective value and source,
write back with `writeAgentRoomConfig`, and ask the daemon to reload or restart
affected providers.

Until a TUI editor exists for a setting, hand-edit `.agentroom/config.yaml` or
use the existing CLI command that writes it.

## Environment Overrides

Environment variables are for secrets, process-local deployment choices, and
explicit overrides where a feature documents them. Examples include daemon
binding (`AGENTROOM_HOST`, `AGENTROOM_PORT`, `AGENTROOM_API_TOKEN`), dashboard
operator overrides, and gateway token env vars.

Do not add broad implicit env overrides for every config field. If a setting
supports an env override, document the precedence next to the setting and show
it in status output.

## Chat Gateway Example

Room-owned Discord is configured in YAML and supplied a token by env:

```yaml
chat:
  gateways:
    discord-main:
      type: discord
      tokenEnv: AGENTROOM_DISCORD_TOKEN
      credentialKind: bot-token
      webhookMode: true
  routes:
    main-lead:
      provider: discord-main
      conversationId: "1234567890"
      conversationKind: channel
      target:
        type: agent-stdin
        agentId: clanky-lead
      outbound:
        type: agent-message
        agentId: clanky-lead
        channelId: implementation
```

One external conversation should still have exactly one owner. If Clanky owns a
Discord DM or channel through its profile credential, do not also route that
same conversation through an AgentRoom room-owned gateway.

## Rule For New Settings

Every new durable setting should answer four questions in code and docs:

1. Which file or store owns it?
2. Which parser/validator owns the schema?
3. Which TUI or CLI surface edits it?
4. Which env vars, if any, override it?

If the answer is "only the TUI remembers it," the setting is session-local, not
durable configuration.
