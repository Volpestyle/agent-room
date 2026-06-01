# Configuration Model

AgentRoom uses one typed durable configuration model with multiple editing
surfaces.

## Source Of Truth

The nearest `.agentroom/config.yaml`, found by walking upward from the current
working directory, is the durable source of truth for room topology. If
`AGENTROOM_HOME` is explicitly set, AgentRoom uses `$AGENTROOM_HOME/config.yaml`
instead:

- room id and name
- default runtime provider and runtime adapter settings
- portable, non-secret work tracker selection
- optional Clanky home/profile defaults for rooms that launch Clanky
- dashboard operator defaults
- room-owned chat gateways and routes
- event-store location

Room behavior and policy live next to it in `.agentroom/AGENTS.md`. That file
is the editable room protocol: the place to tune how the dashboard agent and
launched workers should treat the work tracker, coordination, status updates,
and local room norms.

The file is parsed, validated, and formatted by `@agentroom/config`. Hand edits,
CLI commands, daemon APIs, and future TUI settings screens should all round-trip
through that same package.

The event log is not static configuration. `events.jsonl` next to the AgentRoom
config records runtime bindings, workspace registrations, messages, reports,
tracker events, chat ingress/egress, and audit events. It can rebuild room
views, but it should not become the place where topology is configured.

Secrets do not belong in `config.yaml`. Daemon-owned gateways may store env var
references such as `tokenEnv: AGENTROOM_DISCORD_TOKEN`, then read the secret
from the daemon environment. Work tracker auth is different: each agent
authenticates with its own MCP connector, CLI, skill, or auth store. The TUI's
model credentials live in `~/.agentroom/auth.json`; those credentials configure
the dashboard agent, not room topology.

The portable cross-product subset is intentionally non-secret:

```yaml
workTracker:
  default: linear
  providers:
    linear:
      type: linear
      teamId: team_123

clanky:
  home: .clanky-room
  profile: lead
  chatGatewayOwner: room
```

AgentRoom owns this file. Clanky may read `workTracker` and `clanky` as launch
defaults when it starts inside the project, but Clanky still owns its profile
credentials, memory, sessions, and agent-owned connector state.

## Local Files And Ownership

Setup should make file ownership explicit. The package owns schemas,
runtime/gateway adapters, defaults, and editing surfaces. Users and rooms own
the files created on their machine.

AgentRoom files:

| Path                                                      | Purpose                                                                                                             | Commit?                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `.agentroom/config.yaml` or `$AGENTROOM_HOME/config.yaml` | Room topology: runtime, work tracker defaults, Clanky launch defaults, room-owned gateway routes, and storage path. | Commit only when this is shared project topology. Keep personal rooms local. |
| `.agentroom/AGENTS.md`                                    | Room protocol and worker behavior.                                                                                  | Usually commit for shared project rooms.                                     |
| `.agentroom/events.jsonl`                                 | Generated room audit log: messages, reports, tracker events, runtime bindings, gateway ingress/egress.             | No.                                                                          |
| `.agentroom/daemon.pid`                                   | Local daemon process metadata.                                                                                      | No.                                                                          |
| `.agentroom/daemon.log`                                   | Local daemon logs.                                                                                                  | No.                                                                          |
| `.agentroom/dashboard-agent.log`                          | Local dashboard-agent prompt/tool/error JSONL logs.                                                                 | No.                                                                          |
| `~/.agentroom/auth.json`                                  | Dashboard/TUI model credentials.                                                                                    | No.                                                                          |

Clanky profile files:

| Path                                              | Purpose                                                                                   | Commit?                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `~/.clanky/.profile`                              | Active profile pointer.                                                                   | No.                                                            |
| `~/.clanky/.token`                                | Local Clanky HTTP/daemon token.                                                           | No.                                                            |
| `~/.clanky/skills/`                               | Home-level user skills.                                                                   | Only when intentionally sharing a skill; never commit secrets. |
| `~/.clanky/profiles/<profile>/auth.json`          | Profile credentials: OpenAI, agent-owned Discord, xAI, ElevenLabs, and similar providers. | No.                                                            |
| `~/.clanky/profiles/<profile>/discord-voice.json` | Non-secret Discord voice settings.                                                        | No by default.                                                 |
| `~/.clanky/profiles/<profile>/models.json`        | Profile model registry entries.                                                           | Usually no.                                                    |
| `~/.clanky/profiles/<profile>/SELF.md`            | Profile-local self memory.                                                                | No.                                                            |
| `~/.clanky/profiles/<profile>/skills/`            | Profile-local skills and skill usage metadata.                                            | Usually no.                                                    |
| `~/.clanky/profiles/<profile>/memory/`            | Remembered facts and reflections.                                                         | No.                                                            |
| `~/.clanky/profiles/<profile>/sessions/`          | Pi session transcripts and state.                                                         | No.                                                            |
| `~/.clanky/profiles/<profile>/subagents/`         | Gateway and voice subagent state and sessions.                                            | No.                                                            |
| `~/.clanky/profiles/<profile>/work-trackers/`     | Provider-neutral tracker refs and local work state.                                       | No.                                                            |
| `~/.clanky/profiles/<profile>/index.db`           | Profile search/session index.                                                             | No.                                                            |
| `~/.clanky/profiles/<profile>/cron/`              | Optional scheduled job state, runs, outputs, and locks.                                   | No.                                                            |
| `~/.clanky/profiles/<profile>/.sock`              | Profile-local daemon socket.                                                              | No.                                                            |
| `~/.clanky/profiles/<profile>/.daemon.lock`       | Profile-local daemon lock.                                                                | No.                                                            |
| `~/.clanky/profiles/<profile>/discord-*.log`      | Local Discord bridge and voice logs.                                                      | No.                                                            |

When AgentRoom config sets `clanky.home: .clanky-room`, those Clanky profile
paths move under `.clanky-room/profiles/<profile>/`. They are still
user/runtime-owned profile state and should normally be ignored even though
they live inside a project checkout.

Gateway token ownership follows the process boundary: whoever runs the gateway
owns the token. If Discord is room-owned, AgentRoom config stores only
`tokenEnv`, and the daemon environment supplies `AGENTROOM_DISCORD_TOKEN`. If
Discord is agent-owned, Clanky resolves the token from its launch environment or
profile auth store. Do not attach both owners to the same external conversation.

Recommended project ignore block for AgentRoom + Clanky rooms:

```gitignore
.agentroom/events.jsonl
.agentroom/daemon.pid
.agentroom/daemon.log
.agentroom/dashboard-agent.log
.clanky-room/
```

## Editing Surfaces

The intended product model is:

```text
.agentroom/config.yaml durable, reviewable, headless
AgentRoom TUI           human-friendly editor, status, and lifecycle controls
CLI / daemon API        scriptable operations over the same config model
```

The TUI exposes `/setup` and `/config` for first-run setup and common durable
settings. Those commands read and write the YAML through the daemon and
`@agentroom/config`; they do not create a second hidden topology store.
The TUI also exposes `/protocol`, which shows the editable
`.agentroom/AGENTS.md` room protocol.

The initial TUI setup surface covers the default runtime, portable work tracker
defaults, and Clanky room defaults. For settings that are not in the setup
surface yet, hand-edit the AgentRoom config or use the existing CLI command that
writes it.

## Environment Overrides

Environment variables are for secrets, process-local deployment choices, and
explicit overrides where a feature documents them. Examples include daemon
binding (`AGENTROOM_HOST`, `AGENTROOM_PORT`, `AGENTROOM_API_TOKEN`), dashboard
operator overrides, and gateway token env vars.

Do not add broad implicit env overrides for every config field. If a setting
supports an env override, document the precedence next to the setting and show
it in status output.

## Chat Gateway Example

Room-owned Discord is configured in YAML and supplied a token by env:

```yaml
chat:
  gateways:
    discord-main:
      type: discord
      tokenEnv: AGENTROOM_DISCORD_TOKEN
      credentialKind: bot-token
      webhookMode: true
  routes:
    main-lead:
      provider: discord-main
      conversationId: "1234567890"
      conversationKind: channel
      target:
        type: agent-stdin
        agentId: clanky-lead
      outbound:
        type: agent-message
        agentId: clanky-lead
        channelId: implementation
```

One external conversation should still have exactly one owner. If Clanky owns a
conversation through its profile credential, do not also route that same
conversation through an AgentRoom room-owned gateway.

## Rule For New Settings

Every new durable setting should answer four questions in code and docs:

1. Which file or store owns it?
2. Which parser/validator owns the schema?
3. Which TUI or CLI surface edits it?
4. Which env vars, if any, override it?

If the answer is "only the TUI remembers it," the setting is session-local, not
durable configuration.
