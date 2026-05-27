# AgentRoom Setup Guide

AgentRoom is provider-neutral. A working room is assembled from explicit choices:

- runtime provider / terminal multiplexer
- agent harness command
- work tracker
- design provider
- messaging surface
- agent skills

Use native AgentRoom messages and events as the source of truth for room coordination. Add external systems only where they are the system of record or the surface you want humans to use.

If you are new, do not configure every integration first. Get the TUI running,
launch one agent, read its output, and only then add trackers, chat gateways,
mobile pairing, or custom skills.

## 1. Install The Local Tooling

Prerequisites:

- Node.js 24 LTS or newer within the supported engine range
- Corepack
- pnpm 11
- any runtime provider CLI you choose, such as `tmux` or `herdr`
- any agent harness CLI you choose, such as Codex, Claude Code, Pi, Gemini CLI, or a custom command

From the AgentRoom checkout:

```bash
corepack enable
corepack prepare pnpm@11 --activate
pnpm install
pnpm build
pnpm test
```

## 2. Start The Singleton Room

AgentRoom defaults to one local room named `agent-room`. Its durable state lives
in `$AGENTROOM_HOME` or `~/.agentroom`; the default visible runtime is
`herdr --session agent-room`.

Start with the human surface:

```bash
agent-room
```

The dashboard opens in operator chat. Ask it what is running, which agents are
active, or what needs attention. The CLI remains available for exact automation,
but the TUI should be the first interface a human learns.

- The room is global for this workstation.
- A cwd is workspace context, not room identity.
- Herdr workspaces/tabs/panes are the visible layout under the same session.

See `docs/TOPOLOGY.md` for the tradeoffs.

`config.yaml` in AgentRoom home is the durable source of truth for room topology.
The TUI and CLI should edit the same typed config model rather than keeping
separate hidden settings. See `docs/CONFIGURATION.md` for source-of-truth, env
override, and secret-handling rules.

## 3. Choose The Runtime Provider

The default runtime is Herdr. Check or switch it explicitly when needed through
the TUI or CLI; exact command syntax lives in [CLI Reference](CLI_REFERENCE.md).

When the runtime command is not the default binary name, write it into config at
init time:

```bash
agent-room init --runtime herdr --runtime-cli herdr-dev
```

For a Clanky-first room, write the shared defaults in the same config file:

```bash
agent-room init --runtime herdr --clanky --work-tracker linear --tracker-team team_123
```

That creates a portable `workTracker` block and a `clanky` block. When Clanky
starts without explicit `--home` or `--profile` overrides,
it can adopt `.clanky-room`, profile `lead`, the configured chat ownership, and
the selected tracker defaults from AgentRoom config.

Runtime choices:

- `tmux`: local terminal multiplexer via `@agentroom/runtime-tmux`.
- `herdr`: Herdr adapter via `@agentroom/runtime-herdr`.
- `fake`: contract tests and smoke checks only; not a real agent runtime.

Runtime-specific setup belongs in AgentRoom config and
[Runtime Providers](RUNTIMES.md). Normal operators and agents use AgentRoom
runtime actions rather than raw multiplexer commands.

## 4. Choose The Agent Harness

Launching an agent requires an explicit harness kind and command. Use the TUI
for normal launches and the CLI reference for exact automation syntax.

Supported harness kinds are `claude-code`, `codex`, `pi`, `gemini-cli`, `shell`, and `custom`. `shell` allocates a bound shell; it is not an active coding agent until you start one inside it with `agent-room send`.

If you use the dashboard operator, configure it instead of relying on an implicit harness:

```yaml
operator:
  agentId: operator
  kind: HARNESS_KIND
  command: "AGENT_COMMAND"
```

## 5. Choose The Work Tracker

AgentRoom local tasks are execution shadows. Choose one durable work tracker for issues, ownership, workflow status, acceptance criteria, and long-lived comments.

Options:

- Native only: use AgentRoom local tasks without an external tracker.
- Linear, GitHub Issues, Jira, or custom: keep the tracker as the durable source and use that provider's MCP server, CLI, or skill for provider-specific issue actions.

For Linear-backed rooms, put the non-secret tracker defaults in AgentRoom
config and let the Linear MCP server, CLI, or skill own Linear-specific issue
operations.

If the selected tracker is unavailable, agents must report `tracker_update_skipped` with the reason. They should not pretend a tracker update happened.

## 6. Choose The Design Integration

Design is optional. If design data matters for the room, choose one source of truth:

- Native only: link screenshots, files, or URLs in room messages and task refs.
- Figma: use the `DesignProvider` port and `@agentroom/design-figma` scaffold where available; use Figma MCP/tools for direct Figma operations until the AgentRoom adapter workflow is complete.
- Custom: implement the `DesignProvider` port and keep provider-specific language out of core room guidance.

Workers should discuss design work through AgentRoom messages and task refs, not by assuming every room uses Figma.

## 7. Choose The Messaging Surface

Native-only rooms need no external chat setup. Agents and the TUI can use room
channels, DMs, waits, tasks, and human questions without Discord, Telegram,
Slack, SMS, or any other gateway.

If you add an external messaging surface, choose ownership per conversation:

- Room-owned gateway: `agentroomd` owns the token and route table for a channel/DM.
- Agent-owned gateway: one agent owns its own connector identity and may also participate in AgentRoom.

For room-owned gateways, configure `chat.gateways` and `chat.routes` in
AgentRoom config; keep tokens in env vars such as `AGENTROOM_DISCORD_TOKEN`.
Discord is the first concrete adapter, but the ownership model is generic. Use
provider-specific MCP/tools for provider-only actions such as reading unrelated
channels, inspecting attachments, one-off messages, or reactions. Do not make
the external service the room source of truth.

See `docs/ADR/0003-chat-gateway-port.md` for gateway topology and ownership details.

## 8. Install Or Expose Skills

AgentRoom has two local skills:

- `skills/agentroom-operator/SKILL.md`: outside-the-room operator and lead-agent playbook.
- `skills/agentroom/SKILL.md`: enrolled worker/reviewer behavior.

Expose these skills to the agent harnesses you launch using that harness's normal skill mechanism. If a harness does not support skills, include the relevant playbook text in the launch prompt and verify `agent-room whoami --json` before work begins.

See [Skills And Protocols](SKILLS_AND_PROTOCOLS.md) for the public docs policy:
publish the protocol and ownership model, keep routine command recipes in
skills or the CLI reference.

## 9. Choose Operator Clients

The daemon can be driven from several local clients:

- CLI: `agent-room ...` commands read and write the same room event log.
- TUI: `agent-room` opens the terminal dashboard. Use
  `agent-room --daemon <url>` only when connecting to a non-default daemon.
- MCP: `agentroom-mcp` exposes room context, messages, tasks, waits, and audit reads to MCP-capable agents.
- Mobile: `apps/mobile` connects to the daemon API. For iPhone access over Tailscale, start with `agent-room daemon start --tailnet`, then run `agent-room mobile-connect --copy` and open the `agentroom://connect?...` link on the phone.

When `AGENTROOM_API_TOKEN` is set, or when the daemon is started with `--tailnet`, `/v1/*` routes require `Authorization: Bearer <token>` or `x-agentroom-api-token`.

## 10. Validate The Room

After choosing the pieces, validate the room through the TUI or a short CLI
smoke check:

```bash
agent-room runtime doctor
agent-room daemon start
agent-room daemon status
agent-room launch smoke --harness HARNESS_KIND --command "AGENT_COMMAND" --cwd /path/to/workspace
agent-room read smoke --lines 40
agent-room events --limit 20
```

Stop or reconfigure anything that fails health checks before launching a real multi-agent workflow.

For the complete command surface, use [CLI Reference](CLI_REFERENCE.md).
