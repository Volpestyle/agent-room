# AgentRoom Diagrams

These diagrams are the mental model for AgentRoom. Read them from the user's
point of view first, then from the agent's point of view.

## User Control Loop

```mermaid
flowchart TB
  user["Human operator"]
  surfaces["Control surfaces<br/>TUI, CLI, iOS, MCP, chat gateway"]
  room["AgentRoom room<br/>agents, messages, reports, handoffs, audit"]
  action["Room action<br/>launch, send, read, delegate, wait, route"]
  result["Readable state<br/>overview, events, output, status"]

  user --> surfaces
  surfaces --> room
  room --> action
  action --> room
  room --> result
  result --> user
```

The operator should not need to remember which terminal pane matters. The room
collects runtime state, coordination messages, reports, agent state, and recent
audit events into one control surface.

## Agent Delegation Loop

```mermaid
flowchart TB
  lead["Lead/operator agent"]
  tracker["External tracker<br/>Linear, GitHub, Jira"]
  assignment["Directed handoff<br/>DM with tracker ref"]
  worker["Worker agent"]
  reviewer["Reviewer agent"]
  room["AgentRoom messages, reports + events"]

  lead --> tracker
  lead --> assignment
  assignment --> worker
  worker --> room
  room --> reviewer
  reviewer --> room
  room --> lead
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
  core["@agentroom/core<br/>rooms, agents, messages, approvals,<br/>reports, handoffs, normalized events"]
  store["EventStore<br/>room state and audit history"]
  runtime["RuntimeProvider<br/>audited launch, read, send, stop"]
  gateways["ChatGatewayProvider<br/>optional room-owned conversation routing"]
  external["Agent-owned tools<br/>trackers, code hosts, design systems, CLIs, MCP"]
  local[".agentroom/<br/>config.yaml<br/>AGENTS.md<br/>events.jsonl<br/>SQLite planned"]
  runtimes["Herdr<br/>tmux<br/>fake<br/>future runtimes"]
  chatAdapters["Discord<br/>future chat gateways"]

  surfaces --> daemon
  daemon --> core
  core --> store
  core --> runtime
  core --> gateways
  store --> local
  runtime --> runtimes
  gateways --> chatAdapters
  surfaces --> external
```

## Read The Boundaries

- `.agentroom/config.yaml` owns durable room topology: runtime providers,
  room-owned gateways and routes, dashboard operator defaults, work tracker
  selection, and storage settings. `AGENTROOM_HOME` can explicitly point to a
  singleton room home when discovery is not desired.
- `.agentroom/AGENTS.md` owns editable room protocol for dashboard-agent and
  worker behavior.
- The event log owns room state and audit history: messages, reports, imported
  tracker events, runtime bindings, chat ingress/egress, and terminal
  input/output observations.
- Runtime providers own process placement and terminal control. AgentRoom uses
  provider capabilities instead of assuming Herdr, tmux, Docker, SSH, or a
  hosted scheduler.
- Durable external systems stay external. The selected work tracker remains
  canonical for issues and workflow; agents use their own MCP servers,
  connectors, CLIs, and skills for tracker/code/design work while AgentRoom
  keeps local execution context and refs.

## Primary Flow

1. A human, lead agent, MCP-capable agent, mobile client, or chat gateway sends
   a room action.
2. `agentroomd` or the CLI loads AgentRoom config, validates the
   request, and calls `@agentroom/core`.
3. Core appends normalized events to the `EventStore` and updates rebuildable
   views.
4. Runtime actions go through `RuntimeProvider` adapters so `launch`, `read`,
   `send`, and `stop` stay audited.
5. Room-owned chat reaches external conversations through `ChatGatewayProvider`.
   Trackers, code hosts, design systems, and one-off notifications are handled
   by the agents that need them, then summarized back into the room.

For the written model, see [Architecture](ARCHITECTURE.md),
[Configuration](CONFIGURATION.md), [Coordination](COORDINATION.md), and
[Runtime Providers](RUNTIMES.md).
