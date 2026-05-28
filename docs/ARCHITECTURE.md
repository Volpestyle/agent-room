# Architecture

For a docs-UI-friendly end-to-end map of the surfaces, daemon, core, ports,
adapters, and external systems, see [AgentRoom Diagram](docs/DIAGRAM.md).

```text
Human UIs / bots / custom app
             │
             ▼
        agentroomd
             │
   ┌─────────┼─────────┐
   ▼         ▼         ▼
EventStore Runtime   ChatGateway
           Provider  Provider
   │          │        │
   ▼          ▼        ▼
 local     Herdr     Discord
 JSONL     tmux      future chat
           future
```

## Core domain

The core domain owns:

- rooms
- agents
- local task shadows linked to external tracker refs
- channel and direct messages
- threads
- approvals
- human escalations
- decisions
- handoffs
- normalized events

The core domain does not own terminal multiplexing, cloud scheduling, durable
work tracking, code hosting, design data, or notification delivery.

## Coordination Split

AgentRoom is not a durable work tracker replacement.

The selected external tracker is canonical for issues, assignment, priority, workflow status, and durable comments. Agents should use that tracker's MCP server, CLI, or skill for that layer.

AgentRoom owns the local room around active execution: channel messages, direct messages, handoffs, human questions, runtime launch/input/output audit, and local task shadows that can point to external tracker issues through refs.

## Ports

AgentRoom talks to the world through ports:

- `RuntimeProvider`
- `EventStore`
- `ChatGatewayProvider`

Work trackers are not an AgentRoom port. `.agentroom/config.yaml` records the chosen tracker and AgentRoom passes provider-neutral protocol environment to agents; `.agentroom/AGENTS.md` records the room policy. Tracker operations themselves happen through the configured MCP server, CLI, connector, or skill in each agent runtime.

Code hosts, design systems, and one-off notification services are not
AgentRoom ports either. Agents use those tools directly through the MCP servers,
connectors, CLIs, skills, browsers, and auth stores available in their runtime,
then link stable refs or summaries back to AgentRoom messages and task shadows.

`ChatGatewayProvider` is the exception because it lets AgentRoom orchestrate a
room-owned messaging layer: a Discord/Telegram/SMS/etc. conversation can attach
to a room channel, a directed room message, or a runtime-backed agent's input.
See `docs/ADR/0003-chat-gateway-port.md`.

## Adapters

Adapters implement ports:

- `runtime-herdr`
- `runtime-tmux`
- `runtime-fake`
- `chat-discord` (`ChatGatewayProvider`, bot-token and user-token modes)

## Configuration Model

AgentRoom's durable topology lives in the nearest `.agentroom/config.yaml`, or `$AGENTROOM_HOME/config.yaml` when `AGENTROOM_HOME` is explicitly set: runtime providers, dashboard operator defaults, room-owned gateways/routes, work tracker selection, and storage settings. The config schema and formatter live in `@agentroom/config`.

Room behavior is intentionally Markdown. `.agentroom/AGENTS.md` is the editable room protocol for dashboard and worker behavior; config stays small and machine-readable. The TUI is the intended full editor/status/control surface for topology, but it must round-trip through the same config package instead of creating a second hidden settings store. Secrets stay out of YAML; daemon-owned gateways can store env var names such as `tokenEnv`, while work tracker auth remains in each agent's MCP connector, CLI, skill, or auth store. See `docs/CONFIGURATION.md`.

## Chat gateways

Chat gateways are not the core state store; rooms and the event log remain authoritative. A gateway attaches an external conversation to room state through two pieces:

- the adapter (`ChatGatewayProvider`) — owns the socket, credential mode, inbound normalization, and outbound send.
- the router (`ChatGatewayRouter`, in core) — consumes normalized inbound messages and routes them to `room-channel | agent-dm | agent-stdin` targets via a static route table keyed by `{ providerId, conversationId, threadId? }`.

### Room Participation And Gateway Ownership

Room participation and chat gateway ownership are separate axes:

- An agent can run outside AgentRoom or participate in a room.
- Each external conversation is owned either by an agent process or by `agentroomd`.

Agent-owned gateways preserve the single-Clanky-with-its-own-communication-identity path and can coexist with AgentRoom participation. Room-owned gateways use the room connector identity, flow through `ChatGatewayRouter`, and are the right fit for shared public channels or one-connector-to-many-agents fanout. Discord is the first concrete adapter.

Lead vs worker is configuration, not agent code. Pointing a room-owned route at `agent-stdin:<id>` makes that agent the lead for that conversation; the rest of the room is reached through AgentRoom native messaging from the lead.

One external conversation should have exactly one owner. Do not attach both an agent-owned gateway and a room-owned gateway to the same conversation.

### Outbound dispatcher

`ChatGatewayRouter` covers inbound only. `ChatGatewayOutboundDispatcher` covers the symmetric outbound primitive (room events -> `provider.sendMessage()`). The daemon loads chat gateway config, exposes read-only `/v1/chat/gateways` and `/v1/chat/routes` inspection APIs, and dispatches messages posted through its HTTP API; event-log subscription for messages posted by separate CLI processes is still pending.

### Multi-agent attribution (Discord-specific)

In a multi-agent room mirrored to Discord, webhook-mode outbound sends use per-message `username` + `avatar_url` so distinct agent identities stay visible under a single bot token. Bot permissions must include `Manage Webhooks` on target channels. Other adapters implement equivalent attribution per platform constraints.

### What is built vs planned

Built: port, Discord adapter (bot + user token + webhook-mode posting), inbound router, outbound dispatcher primitive, daemon config loading and gateway instantiation, and daemon read APIs for gateways/routes.
Planned: operator CLI for route inspection/mutation and daemon event-log subscription for CLI-originated messages.

## Runtime capability negotiation

Each runtime provider declares capabilities. The CLI, daemon, mobile app, and lead agent should check capabilities before offering actions such as attach, send input, stream events, or read semantic state.

## Event-first model

Everything important becomes an event. Materialized views are rebuildable.

For local MVPs, JSONL is enough. For production local use, add SQLite. For multi-host, use Postgres and an event bus. External tracker state remains in the tracker; AgentRoom records refs and audit events rather than duplicating the tracker database.
