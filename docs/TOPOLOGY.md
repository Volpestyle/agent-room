# Room Topology

AgentRoom state is directory-scoped. A room lives at the directory that contains
`.agentroom/config.yaml`.

```text
/path/to/workspace/
  .agentroom/
    config.yaml
    events.jsonl
    daemon.pid
    agents/
```

The room root is the coordination root. It is not a filesystem jail. Agents
launched from that room can work in any repository by setting `--cwd`.

## Room Root

The CLI discovers the room from the current working directory:

```bash
cd /path/to/workspace
agent-room daemon status
agent-room launch impl --harness HARNESS_KIND --command "AGENT_COMMAND" --cwd .
```

`agent-room init --room ROOM_ID --runtime RUNTIME` creates
`.agentroom/config.yaml` in the current directory. That config selects the room
id, default runtime provider, runtime settings, and local event log path.

Use a dedicated room directory or a project repository root by default. A room
at the user's home directory is possible, but it makes all room state global:
messages, tasks, runtime bindings, daemon metadata, policies, and logs all mix
together unless you impose discipline manually.

## Agent Working Directories

An agent's working directory is independent from the room root:

```bash
cd /Users/jamesvolpe/web/agent-room

agent-room launch portfolio-impl \
  --harness HARNESS_KIND \
  --command "AGENT_COMMAND" \
  --cwd /Users/jamesvolpe/web/portfolio

agent-room launch browser-reviewer \
  --harness HARNESS_KIND \
  --command "AGENT_COMMAND" \
  --cwd /Users/jamesvolpe/web/agent-browser
```

Both agents share the same room messages, tasks, audit log, and operator
controls. Each agent starts in its own target repository.

Always pass `--cwd` when the agent should work somewhere other than the room
root.

## Common Topologies

### One Room Per Project

Use this when projects need separate logs, tasks, permissions, chat gateways, or
lifecycle.

```bash
cd /Users/jamesvolpe/web/project-a
agent-room init --room project-a --runtime RUNTIME
agent-room daemon start --port 4317

cd /Users/jamesvolpe/web/project-b
agent-room init --room project-b --runtime RUNTIME
agent-room daemon start --port 4318

cd /Users/jamesvolpe/web/project-c
agent-room init --room project-c --runtime RUNTIME
agent-room daemon start --port 4319
```

Connect to each daemon explicitly:

```bash
agent-room tui --daemon http://127.0.0.1:4317
agent-room tui --daemon http://127.0.0.1:4318
agent-room tui --daemon http://127.0.0.1:4319
```

This is the cleanest model for three independent swarms.

### One HQ Room Across Many Projects

Use this when one lead/operator should coordinate related work across several
repositories.

```bash
cd /Users/jamesvolpe/web/agent-room
agent-room daemon start

agent-room launch api-impl --harness HARNESS_KIND --command "AGENT_COMMAND" --cwd /Users/jamesvolpe/web/api
agent-room launch web-impl --harness HARNESS_KIND --command "AGENT_COMMAND" --cwd /Users/jamesvolpe/web/frontend
agent-room launch reviewer --harness HARNESS_KIND --command "AGENT_COMMAND" --cwd /Users/jamesvolpe/web/review-tools
```

This keeps all room messages, local tasks, handoffs, and runtime audit events in
one place. It is useful for cross-repository work, but weaker for isolation.

### Hybrid

Use a stable HQ room for cross-project planning, plus project-specific rooms for
larger execution swarms. The HQ can track high-level coordination while each
project room keeps its own runtime bindings and detailed audit log.

## Runtime Placement

Room topology and runtime placement are related but separate.

With Herdr, AgentRoom commonly uses one broad Herdr session named `agentroom`
and one workspace per room or workstream. The generated config can also use a
shared workspace with a pane grid.

For fresh work in a shared Herdr session, pass an explicit workspace label:

```bash
agent-room launch impl-a --workspace project-a --harness HARNESS_KIND --command "AGENT_COMMAND" --cwd /Users/jamesvolpe/web/project-a
agent-room launch impl-b --workspace project-a --harness HARNESS_KIND --command "AGENT_COMMAND" --cwd /Users/jamesvolpe/web/project-a
```

Use distinct daemon ports for distinct AgentRoom daemons. Use distinct Herdr
workspace labels when you want separate visual/runtime grouping inside the same
Herdr session.

## Choosing A Shape

Prefer one project room when:

- the team, logs, tasks, or chat gateway belong to one project
- work should be easy to stop, archive, or inspect independently
- the project has its own policies or reviewer flow

Prefer one HQ room when:

- one lead should coordinate multiple repositories
- all agents are working on a single cross-repository objective
- shared channel history is more valuable than isolation

Prefer multiple rooms when:

- several swarms should run at the same time without shared task state
- different external conversations or gateway routes should attach to each room
- stopping or restarting one swarm should not affect the others
