# Runtime Providers

AgentRoom core is runtime-agnostic. Normal operator and agent workflows should use AgentRoom commands:

```bash
agent-room runtime providers
agent-room runtime use <runtime>
agent-room runtime doctor
agent-room launch impl --harness HARNESS_KIND --command "AGENT_COMMAND" --cwd /path/to/workspace
agent-room send impl "message"
agent-room read impl --lines 40
agent-room stop impl
```

Provider-specific commands belong in adapter work, adapter docs, or manual recovery. Do not make worker agents depend on a specific terminal multiplexer.

Runtime `read`, `send`, and `stop` require an AgentRoom binding by default so input/output stays audited. `--unaudited` is reserved for manual recovery against non-bound runtime sessions.

## Herdr Adapter

Herdr support lives behind `@agentroom/runtime-herdr`. The local default is the
singleton Herdr session named `agent-room`:

```bash
herdr --session agent-room
agent-room runtime doctor
```

The room id and default Herdr session are both `agent-room`. The Herdr CLI
command defaults to `herdr`. A launch cwd becomes workspace context; AgentRoom
uses a cwd-derived workspace label unless `--workspace` is supplied.

### Herdr session vs workspace

Keep these names separate:

- **Herdr session namespace**: the Herdr server/socket namespace. This is the value to pass to `herdr --session <name>` or `herdr-dev --session <name>`.
- **Herdr workspace label**: the human label AgentRoom uses to group a room or workstream inside that Herdr session.
- **Herdr workspace id**: an internal id such as `w652aca9fd72f08`. This can appear as a runtime agent `sessionId`, but it is not a Herdr `--session` value.
- **Herdr pane id**: the binding id AgentRoom uses for read/send/stop.

If the Agents view shows a value like `session=w652aca9fd72f08`, read that as “workspace id inside the configured Herdr session”, not as the command to join Herdr. To join the Herdr server for the room, use the configured session namespace:

```bash
herdr --session agent-room
# or, when using a local dev binary:
herdr-dev --session agent-room
```

To inspect the current coordinates without guessing:

```bash
agent-room runtime doctor --json
herdr session list --json
herdr --session agent-room status
```

Inside the AgentRoom TUI, use `/runtime` or `/runtime herdr`. The Overview view also shows the runtime session namespace, socket path, workspace label, workspace ids, and join command when the daemon exposes provider metadata.

The Herdr `cli` setting must be an executable name or path that `execFile` can run directly. Shell aliases such as `herdr-dev='...'` are not expanded. To use a local Herdr checkout while developing AgentRoom, set `cli` in `$AGENTROOM_HOME/config.yaml` or point it at the built binary or at a real wrapper script on `PATH`:

```bash
agent-room init --runtime herdr --runtime-cli herdr-dev
```

```yaml
runtimes:
  herdr:
    type: herdr
    session: agent-room
    cli: /path/to/herdr/target/debug/herdr
```

Herdr layout is config-driven:

- `workspace-per-agent`: each agent gets a dedicated Herdr workspace.
- `tab-per-agent`: agents share a Herdr workspace, with one tab per agent.
- `pane-grid`: agents share a Herdr workspace, filling tabs up to `panesPerTab`. The default config uses two panes per tab, splits the existing agent pane to the right, and balances the tab.

For Herdr, `launch` can override placement without editing config:

```bash
agent-room launch lead --placement workspace --harness shell --command "bash" --cwd /path/to/workspace
agent-room launch impl --placement tab --workspace my-project --harness shell --command "bash" --cwd /path/to/workspace
agent-room launch reviewer --placement pane --workspace my-project --panes-per-tab 2 --harness shell --command "bash" --cwd /path/to/workspace
```

For fresh pane-grid work, use a workspace label that is unique to the team or task:

```bash
agent-room launch impl-a --workspace squad-foo --harness HARNESS_KIND --command "AGENT_COMMAND" --cwd /path/to/workspace
agent-room launch impl-b --workspace squad-foo --harness HARNESS_KIND --command "AGENT_COMMAND" --cwd /path/to/workspace
```

This avoids crowding new agents into stale panes from an older Herdr workspace. Clean up old Herdr workspaces or panes only when you have verified they are no longer running useful work; Herdr supports `workspace close` and `pane close` for manual recovery.

### Adopting human-opened panes

The Herdr adapter implements `adoptAgent`. When the AgentRoom daemon is running with a Herdr-backed room, it opens a long-lived subscription to the configured Herdr session's socket and listens for pane creation, agent detection, and pane close events. Panes are auto-enrolled only after Herdr reports an agent identity, using `herdr:<session>:<pane>` as the agent id. Closed panes, missing bindings, and previously auto-adopted panes that no longer report an agent are marked `stopped`. Adoption does not execute a harness command; whatever shell or harness is already running in the pane stays running.

For one-off manual enrollment when the daemon is not running, use `agent-room enroll --json` from inside the pane.

## tmux Adapter

tmux support lives behind `@agentroom/runtime-tmux`.

```bash
agent-room runtime use tmux
agent-room launch demo-tmux --runtime tmux --harness shell --command "bash" --cwd .
```
