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
- tasks
- messages
- threads
- approvals
- human escalations
- decisions
- handoffs
- normalized events

The core domain does not own terminal multiplexing, cloud scheduling, work tracking, code hosting, design data, or notification delivery.

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

For local MVPs, JSONL is enough. For production local use, add SQLite. For multi-host, use Postgres and an event bus.
