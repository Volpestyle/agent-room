# Runtime Providers

AgentRoom core is runtime-agnostic. Normal operator and agent workflows should use AgentRoom commands:

```bash
agent-room runtime providers
agent-room runtime use <runtime>
agent-room runtime doctor
agent-room launch impl --harness codex --command "codex" --cwd .
agent-room send impl "message"
agent-room read impl --lines 40
agent-room stop impl
```

Provider-specific commands belong in adapter work, adapter docs, or manual recovery. Do not make worker agents depend on a specific terminal multiplexer.

## Herdr Adapter

Herdr support lives behind `@agentroom/runtime-herdr`. If Herdr is the selected runtime, start or attach the configured Herdr session before launching Herdr-backed agents:

```bash
herdr session attach agentroom
agent-room runtime doctor
```

By default, AgentRoom uses one broad Herdr session named `agentroom` and one Herdr workspace per AgentRoom room or workstream. For `agent-room init --room my-project --runtime herdr`, the Herdr session is `agentroom` and the Herdr workspace is `my-project`. Override the Herdr session with `agent-room init --runtime-session <name>` or by editing `.agentroom/config.yaml`.

The Herdr `cli` setting must be an executable name or path that `execFile` can run directly. Shell aliases such as `herdr-dev='...'` are not expanded. To use a local Herdr checkout while developing AgentRoom, point `cli` at the built binary or at a real wrapper script on `PATH`:

```yaml
runtimes:
  herdr:
    type: herdr
    session: agentroom
    cli: /Users/jamesvolpe/web/herdr/target/debug/herdr
```

Herdr layout is config-driven:

- `workspace-per-agent`: each agent gets a dedicated Herdr workspace.
- `tab-per-agent`: agents share a Herdr workspace, with one tab per agent.
- `pane-grid`: agents share a Herdr workspace, filling tabs up to `panesPerTab`. The default generated config uses two panes per tab, splits the existing agent pane to the right, and balances the tab.

For Herdr, `launch` can override placement without editing config:

```bash
agent-room launch lead --placement workspace --harness shell --command "bash"
agent-room launch impl --placement tab --workspace my-project --harness shell --command "bash"
agent-room launch reviewer --placement pane --workspace my-project --panes-per-tab 2 --harness shell --command "bash"
```

## tmux Adapter

tmux support lives behind `@agentroom/runtime-tmux`.

```bash
agent-room runtime use tmux
agent-room launch demo-tmux --runtime tmux --harness shell --command "bash" --cwd .
```
