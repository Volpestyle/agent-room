# AgentRoom Diagram

This is the docs-UI-friendly map of the AgentRoom system boundaries.

```text
+----------------------------------------------------------+
| User-facing surfaces                                     |
| humans, lead agents, enrolled workers, chat participants |
| agent-room CLI, TUI, agentroom-mcp, mobile app, gateways |
+-----------------------------+----------------------------+
                              |
                              v
+----------------------------------------------------------+
| agentroomd / CLI command handlers                        |
| HTTP API, daemon lifecycle, gateway routing, local ops    |
+-----------------------------+----------------------------+
                              |
                              v
+----------------------------------------------------------+
| @agentroom/core                                          |
| rooms, agents, task shadows, messages, approvals,        |
| handoffs, normalized events                              |
+-----------------------------+----------------------------+
                              |
          +-------------------+-------------------+
          |                   |                   |
          v                   v                   v
+------------------+  +------------------+  +--------------------+
| EventStore       |  | RuntimeProvider  |  | Connector ports    |
| room state and   |  | audited launch,  |  | work tracker, code |
| audit history    |  | read, send, stop |  | host, design, chat |
+--------+---------+  +--------+---------+  +---------+----------+
         |                     |                      |
         v                     v                      v
+------------------+  +------------------+  +--------------------+
| .agentroom/      |  | Herdr            |  | Linear, GitHub     |
| events.jsonl     |  | tmux             |  | Figma, Discord     |
| SQLite planned   |  | fake             |  | Telegram, custom   |
+------------------+  | future runtimes  |  | adapters           |
                      +------------------+  +--------------------+
```

## Read The Boundaries

- `.agentroom/config.yaml` owns durable room topology: runtime providers, room-owned gateways and routes, dashboard operator defaults, and storage settings.
- The event log owns room state and audit history: messages, local task shadows, runtime bindings, chat ingress/egress, and terminal input/output observations.
- Runtime providers own process placement and terminal control. AgentRoom uses provider capabilities instead of assuming Herdr, tmux, Docker, SSH, or a hosted scheduler.
- Connector ports keep durable external systems external. The work tracker remains canonical for issues and workflow; AgentRoom keeps local execution context and refs.

## Primary Flow

1. A human, lead agent, MCP-capable agent, mobile client, or chat gateway sends a room action.
2. `agentroomd` or the CLI loads `.agentroom/config.yaml`, validates the request, and calls `@agentroom/core`.
3. Core appends normalized events to the `EventStore` and updates rebuildable views.
4. Runtime actions go through `RuntimeProvider` adapters so `launch`, `read`, `send`, and `stop` stay audited.
5. External tracker, code host, design, notification, and chat systems are reached through connector ports when the room explicitly configures them.

For the written model, see [Architecture](docs/ARCHITECTURE.md), [Configuration](docs/CONFIGURATION.md), [Coordination](docs/COORDINATION.md), and [Runtime Providers](docs/RUNTIMES.md).
