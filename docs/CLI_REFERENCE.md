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
| `agent-room delegate <agentId> <work>` | Assign work to an agent and return a waitable task handle.    |
| `agent-room enroll`                    | Enroll the current pane or shell into the room.               |
| `agent-room agents`                    | Show enrolled agents, roles, state, and heartbeat.            |
| `agent-room wait-agent <agentId>`      | Wait until an agent reaches a state such as `done` or `idle`. |
| `agent-room read <agentId>`            | Read recent output from a runtime-backed agent.               |
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

Use `delegate` when the lead already has a worker and wants a watchable handle:

```bash
agent-room delegate impl "Implement OAuth callback" --notify dashboard --json
agent-room wait-task task_... --state done,failed,blocked
```

`delegate` creates an assigned task shadow, records a delegation event, and DMs
the assignee. Terminal task states emit `task.completed` and
`delegation.resolved`; agent completion emits `agent.finished`.

## Messages And Waits

| Command                           | Purpose                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `agent-room post <body>`          | Post a room channel message.                             |
| `agent-room status --mode ...`    | Post a parseable status update with standard fields.     |
| `agent-room dm <agentIds> <body>` | Send a direct message to one or more agents.             |
| `agent-room messages`             | Show recent room messages.                               |
| `agent-room wait`                 | Wait until a matching room event appears.                |
| `agent-room wait-task <taskId>`   | Wait until a task reaches a terminal or requested state. |
| `agent-room events`               | Show recent local room events.                           |
| `agent-room events --follow`      | Stream new events.                                       |

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
regex errors. `wait-task` exits 0 for success states, 3 for `failed`, 4 for
`blocked`, and 5 for `canceled`.

## Tasks

AgentRoom tasks are local execution shadows. Link them to the durable tracker
when a real issue exists.

| Command                                           | Purpose                                             |
| ------------------------------------------------- | --------------------------------------------------- |
| `agent-room task create <title>`                  | Create a local task shadow.                         |
| `agent-room task list`                            | List local task shadows.                            |
| `agent-room task show <taskId>`                   | Show one task shadow.                               |
| `agent-room task claim <taskId>`                  | Claim a task.                                       |
| `agent-room task status <taskId> <status>`        | Set task status.                                    |
| `agent-room task request-review <taskId>`         | Mark ready for review and optionally DM a reviewer. |
| `agent-room task approve <taskId>`                | Approve a task review.                              |
| `agent-room task changes-requested <taskId>`      | Request changes on a task review.                   |
| `agent-room task link-tracker <taskId> <issueId>` | Link a task to an external tracker issue.           |
| `agent-room task comment <taskId> <body>`         | Post a local AgentRoom task comment.                |
| `agent-room block <taskId> --reason <reason>`     | Mark a task blocked.                                |
| `agent-room done <taskId>`                        | Mark a task done.                                   |
| `agent-room ask-human <question>`                 | Create a human escalation question.                 |

Statuses come from the AgentRoom task model, including `planned`, `assigned`,
`claimed`, `working`, `blocked`, `ready-for-review`, `changes-requested`,
`approved`, `merged`, `failed`, `done`, and `canceled`. Use `task status` for
explicit state changes and `done` / `block` for the common paths.

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
