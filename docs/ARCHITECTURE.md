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

## Runtime capability negotiation

Each runtime provider declares capabilities. The CLI, daemon, mobile app, and lead agent should check capabilities before offering actions such as attach, send input, stream events, or read semantic state.

## Event-first model

Everything important becomes an event. Materialized views are rebuildable.

For local MVPs, JSONL is enough. For production local use, add SQLite. For multi-host, use Postgres and an event bus. External tracker state remains in the tracker; AgentRoom records refs and audit events rather than duplicating the tracker database.
