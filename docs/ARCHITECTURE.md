# Architecture

```text
Human UIs / bots / custom app
             │
             ▼
        agentroomd
             │
   ┌─────────┼─────────┐
   ▼         ▼         ▼
EventStore Runtime   Connectors
          Provider   GitHub/Linear/Figma/etc.
             │
   ┌─────────┼──────────────┐
   ▼         ▼              ▼
 Herdr     tmux         future ECS/K8s
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

The core domain does not own terminal multiplexing, cloud scheduling, durable work tracking, code hosting, design data, or notification delivery.

## Coordination Split

AgentRoom is not a Linear replacement.

Linear is the canonical work tracker for issues, assignment, priority, workflow status, and durable comments. Agents should use Linear MCP, CLI, or skills for that layer.

AgentRoom owns the local room around active execution: channel messages, direct messages, handoffs, human questions, runtime launch/input/output audit, and local task shadows that can point to Linear issues through refs.

## Ports

AgentRoom talks to the world through ports:

- `RuntimeProvider`
- `EventStore`
- `WorkTrackerProvider`
- `CodeHostProvider`
- `DesignProvider`
- `NotificationProvider`
- `ChatGatewayProvider`

`NotificationProvider` is fire-and-forget alerting (one-way, no inbound). `ChatGatewayProvider` is a bidirectional chat surface that can attach a Discord/Telegram/SMS/etc. conversation to a room channel, a directed room message, or a runtime-backed agent's input. See `docs/ADR/0003-chat-gateway-port.md`.

## Adapters

Adapters implement ports:

- `runtime-herdr`
- `runtime-tmux`
- `runtime-fake`
- `worktracker-linear`
- `codehost-github`
- `design-figma`
- `notify-telegram`
- `notify-discord`
- `chat-discord` (`ChatGatewayProvider`, bot-token and user-token modes)

## Chat gateways

Chat gateways are not the core state store; rooms and the event log remain authoritative. A gateway attaches an external conversation to room state through two pieces:

- the adapter (`ChatGatewayProvider`) — owns the socket, credential mode, inbound normalization, and outbound send.
- the router (`ChatGatewayRouter`, in core) — consumes normalized inbound messages and routes them to `room-channel | agent-dm | agent-stdin` targets via a static route table keyed by `{ providerId, conversationId, threadId? }`.

### Deployment topologies

Same adapter, two lifecycle owners:

1. **Standalone agent.** No daemon. The agent imports `@agentroom/chat-discord` as a library, runs the gateway in-process with its own token, and consumes `ChatInboundMessage` directly. Preserves the single-Clanky-with-its-own-Discord use case.
2. **Enrolled multi-agent room.** `agentroomd` owns the gateway and the token. The Discord identity is the room's connector. Inbound traffic flows through `ChatGatewayRouter`. Workers never touch Discord; the lead distributes work via AgentRoom native channels/DMs/tasks.

Lead vs worker is configuration, not agent code. Pointing the route at `agent-stdin:<id>` makes that agent the lead; the rest of the room is reached only via AgentRoom native messaging from the lead.

### Outbound dispatcher

`ChatGatewayRouter` covers inbound only. `ChatGatewayOutboundDispatcher` covers the symmetric outbound primitive (room events -> `provider.sendMessage()`). The daemon loads chat gateway config and dispatches messages posted through its HTTP API; event-log subscription for messages posted by separate CLI processes is still pending.

### Multi-agent attribution (Discord-specific)

In a multi-agent room mirrored to Discord, webhook-mode outbound sends use per-message `username` + `avatar_url` so distinct agent identities stay visible under a single bot token. Bot permissions must include `Manage Webhooks` on target channels. Other adapters implement equivalent attribution per platform constraints.

### What is built vs planned

Built: port, Discord adapter (bot + user token + webhook-mode posting), inbound router, outbound dispatcher primitive, daemon config loading and gateway instantiation.
Planned: operator CLI for route inspection, daemon event-log subscription for CLI-originated messages.

## Runtime capability negotiation

Each runtime provider declares capabilities. The CLI, daemon, mobile app, and lead agent should check capabilities before offering actions such as attach, send input, stream events, or read semantic state.

## Event-first model

Everything important becomes an event. Materialized views are rebuildable.

For local MVPs, JSONL is enough. For production local use, add SQLite. For multi-host, use Postgres and an event bus. External tracker state remains in the tracker; AgentRoom records refs and audit events rather than duplicating the tracker database.
