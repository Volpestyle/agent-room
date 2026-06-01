# CLI Reference

This page is the command map for operators, scripts, and agents that need exact
AgentRoom commands. Start with [Terminal TUI](TUI.md) or
[Ecosystem Tour](ECOSYSTEM.md) if you are still learning when to use AgentRoom.

Root shortcuts:

```bash
agent-room              # open the TUI
agent-room --headless   # start the local daemon in the background
```

Most commands accept `--json` when their output is useful for scripts or agent
tools.

## First-Run And Config

| Command                   | Purpose                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `agent-room init`         | Write `.agentroom/config.yaml` and `.agentroom/AGENTS.md`.     |
| `agent-room protocol`     | Show the active editable room protocol.                        |
| `agent-room dev-new-user` | Create a temporary home for first-run TUI testing.             |
| `agent-room doctor`       | Check local prerequisites and configured runtime availability. |
| `agent-room whoami`       | Print current AgentRoom enrollment environment.                |

Common init examples:

```bash
agent-room init --runtime herdr
agent-room init --runtime herdr --runtime-cli herdr-dev
agent-room init --runtime herdr --clanky --work-tracker linear --tracker-team team_123
```

## Daemon, TUI, And Mobile

| Command                             | Purpose                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| `agent-room daemon foreground`      | Run `agentroomd` in the foreground.                          |
| `agent-room daemon start`           | Start the daemon in the background.                          |
| `agent-room daemon status`          | Show daemon pid, health, URL, and token requirement.         |
| `agent-room daemon stop`            | Stop the managed daemon.                                     |
| `agent-room daemon restart`         | Restart the managed daemon.                                  |
| `agent-room daemon start --tailnet` | Bind to the machine's Tailscale address and require a token. |
| `agent-room`                        | Open the interactive terminal dashboard.                     |
| `agent-room --daemon <url>`         | Open the dashboard against a non-default daemon URL.         |
| `agent-room mobile-connect`         | Print AgentRoom iOS/mobile connection settings.              |
| `agent-room mobile-connect --copy`  | Copy the `agentroom://connect?...` pairing link on macOS.    |

Useful options:

| Option                | Applies to             | Purpose                                                  |
| --------------------- | ---------------------- | -------------------------------------------------------- |
| `--host <host>`       | `daemon`               | Bind host. Defaults to `127.0.0.1`.                      |
| `--port <port>`       | `daemon`               | Bind port. Defaults to `4317`.                           |
| `--api-token <token>` | `daemon`, `agent-room` | Bearer token for remote clients. Prefer env for secrets. |
| `--daemon <url>`      | `agent-room`           | Connect the TUI to an existing daemon.                   |
| `--no-auto-start`     | `agent-room`           | Do not start a daemon if none is reachable.              |

## Runtime Providers

| Command                            | Purpose                               |
| ---------------------------------- | ------------------------------------- |
| `agent-room runtime providers`     | List configured runtime providers.    |
| `agent-room runtime use <runtime>` | Set the default runtime in config.    |
| `agent-room runtime doctor`        | Check the selected runtime provider.  |
| `agent-room runtime fake-smoke`    | Run the fake provider contract smoke. |

Supported runtime kinds today: `herdr`, `tmux`, and `fake`.

## Agent Runtime Control

| Command                                | Purpose                                                       |
| -------------------------------------- | ------------------------------------------------------------- |
| `agent-room launch <agentId>`          | Launch an opted-in agent through a runtime provider.          |
| `agent-room delegate <agentId> <work>` | DM a tracker-linked work assignment and wake the agent if idle. |
| `agent-room enroll`                    | Enroll the current pane or shell into the room.               |
| `agent-room agents`                    | Show enrolled agents, roles, state, and heartbeat.            |
| `agent-room wait-agent <agentId>`      | Wait until an agent reaches a state such as `done` or `idle`. |
| `agent-room read <agentId>`            | Read recent output from a runtime-backed agent.               |
| `agent-room search-runtime <query>`    | Search recent output across AgentRoom-bound runtime agents.   |
| `agent-room send <agentId> <text>`     | Send input to a runtime-backed agent.                         |
| `agent-room activate <agentId>`        | Inject the activation prompt so an enrolled agent loads the `agentroom` skill. |
| `agent-room stop <agentId>`            | Stop a runtime-backed agent.                                  |

Launch requires an explicit harness and command:

```bash
agent-room launch impl \
  --harness codex \
  --command "codex" \
  --cwd /path/to/workspace
```

Supported harness kinds: `claude-code`, `codex`, `pi`, `gemini-cli`, `shell`,
and `custom`.

Herdr placement options:

| Option                             | Purpose                                     |
| ---------------------------------- | ------------------------------------------- |
| `--placement workspace\|tab\|pane` | Override configured Herdr placement.        |
| `--workspace <label>`              | Place the agent in a named Herdr workspace. |
| `--panes-per-tab <number>`         | Cap pane-grid density.                      |
| `--split largest\|focused`         | Choose the pane split strategy.             |

By default, `read`, `send`, and `stop` require an AgentRoom runtime binding so
terminal IO stays audited. `--unaudited` is for manual recovery only.

Adopted panes (started outside `launch`) never receive `AGENTROOM_*` env, so
`agent-room activate <agentId>` injects a one-shot prompt that makes the running
agent load the `agentroom` skill, confirm `whoami`, and post a status. The daemon
fires it automatically on first adoption, and `agent-room enroll` fires it after
binding unless you pass `--no-activate`. Daemon API:
`POST /v1/runtime/:providerId/agents/:agentId/activate`.

Use `delegate` when the lead already has a worker and wants the assignment to
land as a directed room message:

```bash
agent-room delegate impl "Pick up ENG-123: implement OAuth callback" --json
agent-room wait-agent impl --state done,idle
```

`delegate` is a thin convenience wrapper over `dm`: it records a handoff message
to the assignee and returns a suggested `wait-agent` command. It does not create
or update an AgentRoom task. The assignee tracks issue state in the configured
work tracker and reports room progress through `status`, `report`, `block`, and
`done`.

## Messages And Waits

| Command                           | Purpose                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `agent-room post <body>`          | Post a room channel message.                             |
| `agent-room status --mode ...`    | Post a parseable status update with standard fields.     |
| `agent-room dm <agentIds> <body>` | Send a direct message to one or more agents.             |
| `agent-room messages`             | Show recent room messages.                               |
| `agent-room wait`                 | Wait until a matching room event appears.                |
| `agent-room events`               | Show recent local room events.                           |
| `agent-room events --follow`      | Stream new events.                                       |
| `agent-room feed`                 | Show the user-visible tracker/report feed.               |

Examples:

```bash
agent-room post "Planning is done" --channel announcements
agent-room status --mode editing --goal "Implement OAuth callback" --files "apps/api.ts" --needs "review"
agent-room dm reviewer "Ready for review"
agent-room messages --with impl-1 --limit 20
agent-room wait --dm-to-me --timeout 600 --json
agent-room wait --message "ready for review" --since now
agent-room wait --message "ready" --from impl --channel implementation --kind status --ignore-case
```

`--message` is a JavaScript regular expression. Use `--ignore-case` instead of
inline `(?i)` flags. `wait` exits 0 on match, 2 on timeout, and 1 on command or
regex errors.

## Agent State And Feed

AgentRoom has no built-in task store. Issues, ownership, workflow state, and
durable comments live in the configured work tracker. Use AgentRoom for runtime
coordination and user-visible execution summaries.

| Command                             | Purpose                                                       |
| ----------------------------------- | ------------------------------------------------------------- |
| `agent-room block --reason <reason>` | Report that the current enrolled agent is blocked.            |
| `agent-room done --summary <summary>` | Report that the current enrolled agent finished its work.     |
| `agent-room report --summary <text>` | Add a narrative agent report to the user-visible feed.        |
| `agent-room ask-human <question>`    | Create a human escalation question in the room.               |
| `agent-room feed`                    | Read tracker webhook/importer events plus narrative reports.  |

`block` and `done` update agent state for room coordination. They are not task
tracker commands. If the configured tracker is unavailable when an issue update
is required, the agent should report that the tracker update was skipped instead
of inventing local task state.

## Workspaces And Trackers

| Command                          | Purpose                                    |
| -------------------------------- | ------------------------------------------ |
| `agent-room workspace add <cwd>` | Register a cwd as an AgentRoom workspace.  |
| `agent-room workspace list`      | List registered workspaces.                |
| `agent-room tracker health`      | Show the configured work tracker protocol. |

## Environment

| Variable                  | Purpose                                                                  |
| ------------------------- | ------------------------------------------------------------------------ |
| `AGENTROOM_HOME`          | Explicit room config/state home; otherwise nearest `.agentroom` is used. |
| `AGENTROOM_DAEMON`        | Daemon base URL for clients and enrolled agents.                         |
| `AGENTROOM_API_TOKEN`     | Bearer token for tailnet or remote daemon access.                        |
| `AGENTROOM_AGENT_ID`      | Current enrolled agent id.                                               |
| `AGENTROOM_ROOM_ID`       | Current room id.                                                         |
| `AGENTROOM_ROLE`          | Current enrolled role.                                                   |
| `AGENTROOM_PROTOCOL_FILE` | Editable room protocol path for enrolled agents.                         |

When AgentRoom launches an agent, runtime providers set the enrollment variables
so the agent can identify itself and coordinate through the room.
Manual `agent-room enroll` also writes `.agentroom/session.json` (and a
pane-specific session file when possible), so later shells can resolve identity
without re-evaluating exports. `agent-room enroll --print-env-file` writes a
sourceable `.agentroom/session.env` path.
