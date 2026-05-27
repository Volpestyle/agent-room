# Room Topology

AgentRoom is a singleton local room by default. The room id is `agent-room`,
durable state lives in the nearest `.agentroom/` directory unless
`AGENTROOM_HOME` is explicitly set, and the default visible runtime is:

```bash
herdr --session agent-room
```

A working directory is workspace context. It should not create a separate room
unless the operator explicitly starts a separate daemon/home.

## Layers

```text
AgentRoom daemon/event store   durable room state
Herdr session agent-room       visible local runtime surface
Herdr workspace                cwd/project grouping
Herdr tab                      task or subcontext grouping
Herdr pane                     visible agent/process binding
Headless agent                 room agent with no pane binding
```

Herdr workspace ids and pane ids are live runtime bindings. They can change when
the layout changes. AgentRoom stores durable facts such as room id, cwd, agent
id, task id, messages, and runtime binding history.

## Workspaces

Register a cwd when you want it to appear as a stable workspace:

```bash
agent-room workspace add /path/to/project-a --label project-a
agent-room workspace list
```

Launching with `--cwd` registers the workspace automatically and uses a
cwd-derived workspace label unless `--workspace` is supplied:

```bash
agent-room launch api-impl \
  --harness HARNESS_KIND \
  --command "AGENT_COMMAND" \
  --cwd /path/to/api

agent-room launch reviewer \
  --workspace project-a-review \
  --harness HARNESS_KIND \
  --command "AGENT_COMMAND" \
  --cwd /path/to/project-a
```

## TUI Portal

`agent-room` connects to the same local daemon from any cwd. The dashboard is
a portal into the full room: overview, workspaces, agents, tasks, messages,
runtime state, and events.

The dashboard agent should not guess a cwd when asked to create an agent. It can
use a selected workspace when the UI provides one; otherwise it should ask the
operator which cwd/workspace to use.

## Multiple Rooms

Use the singleton room for the local product path. Create separate rooms only
when you intentionally need isolation, for example a test fixture, another user
profile, or a hosted/multi-host deployment. Prefer changing `AGENTROOM_HOME` or
daemon port explicitly over accidental room discovery from an unrelated cwd.

## tmux Mapping

tmux does not have Herdr's workspace concept. The intended mapping is:

- AgentRoom workspace -> tmux window
- task/subcontext -> window name or pane grouping
- agent/process -> pane

The durable AgentRoom workspace record remains the same either way.
