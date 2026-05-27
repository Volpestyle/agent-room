# AgentRoom Diagrams

These diagrams are the mental model for AgentRoom. Read them from the user's
point of view first, then from the agent's point of view.

## User Control Loop

```mermaid
flowchart TB
  user["Human operator"]
  surfaces["Control surfaces<br/>TUI, CLI, iOS, MCP, chat gateway"]
  room["AgentRoom room<br/>agents, messages, task shadows, handoffs, audit"]
  action["Room action<br/>launch, send, read, assign, wait, route"]
  result["Readable state<br/>overview, events, output, status"]

  user --> surfaces
  surfaces --> room
  room --> action
  action --> room
  room --> result
  result --> user
```

The operator should not need to remember which terminal pane matters. The room
collects runtime state, coordination messages, task shadows, and recent audit
events into one control surface.

## Agent Delegation Loop

```mermaid
flowchart TB
  lead["Lead/operator agent"]
  task["Task shadow<br/>linked to tracker ref when durable"]
  worker["Worker agent"]
  reviewer["Reviewer agent"]
  tracker["External tracker<br/>Linear, GitHub, Jira"]
  room["AgentRoom messages + events"]

  lead --> task
  task --> worker
  worker --> room
  room --> reviewer
  reviewer --> room
  room --> lead
  task --> tracker
  worker --> tracker
```

Agents should use AgentRoom for active coordination and the selected tracker for
durable work records. If a room message becomes important outside the active
execution context, summarize it into the tracker.

## System Boundaries

```mermaid
flowchart TB
  surfaces["User-facing surfaces<br/>humans, lead agents, enrolled workers, chat participants<br/>CLI, TUI, MCP, mobile app, gateways"]
  daemon["agentroomd / CLI handlers<br/>HTTP API, daemon lifecycle, gateway routing, local ops"]
  core["@agentroom/core<br/>rooms, agents, task shadows, messages, approvals,<br/>handoffs, normalized events"]
  store["EventStore<br/>room state and audit history"]
  runtime["RuntimeProvider<br/>audited launch, read, send, stop"]
  connectors["Connector ports<br/>work tracker, code host, design, chat"]
  local[".agentroom/<br/>config.yaml<br/>AGENTS.md<br/>events.jsonl<br/>SQLite planned"]
  runtimes["Herdr<br/>tmux<br/>fake<br/>future runtimes"]
  adapters["Linear, GitHub<br/>Figma, Discord<br/>Telegram, custom adapters"]

  surfaces --> daemon
  daemon --> core
  core --> store
  core --> runtime
  core --> connectors
  store --> local
  runtime --> runtimes
  connectors --> adapters
```

## Read The Boundaries

- `.agentroom/config.yaml` owns durable room topology: runtime providers,
  room-owned gateways and routes, dashboard operator defaults, work tracker
  selection, and storage settings. `AGENTROOM_HOME` can explicitly point to a
  singleton room home when discovery is not desired.
- `.agentroom/AGENTS.md` owns editable room protocol for dashboard-agent and
  worker behavior.
- The event log owns room state and audit history: messages, local task shadows,
  runtime bindings, chat ingress/egress, and terminal input/output observations.
- Runtime providers own process placement and terminal control. AgentRoom uses
  provider capabilities instead of assuming Herdr, tmux, Docker, SSH, or a
  hosted scheduler.
- Connector ports keep durable external systems external. The work tracker
  remains canonical for issues and workflow; AgentRoom keeps local execution
  context and refs.

## Primary Flow

1. A human, lead agent, MCP-capable agent, mobile client, or chat gateway sends
   a room action.
2. `agentroomd` or the CLI loads AgentRoom config, validates the
   request, and calls `@agentroom/core`.
3. Core appends normalized events to the `EventStore` and updates rebuildable
   views.
4. Runtime actions go through `RuntimeProvider` adapters so `launch`, `read`,
   `send`, and `stop` stay audited.
5. External tracker, code host, design, notification, and chat systems are
   reached through connector ports when the room explicitly configures them.

For the written model, see [Architecture](ARCHITECTURE.md),
[Configuration](CONFIGURATION.md), [Coordination](COORDINATION.md), and
[Runtime Providers](RUNTIMES.md).
