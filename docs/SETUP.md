# AgentRoom Setup Guide

AgentRoom is provider-neutral. A working room is assembled from explicit choices:

- runtime provider / terminal multiplexer
- agent harness command
- work tracker
- design provider
- messaging surface
- agent skills

Use native AgentRoom messages and events as the source of truth for room coordination. Add external systems only where they are the system of record or the surface you want humans to use.

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

## 2. Choose The Room Shape

Pick a room root before initialization. The room root holds `.agentroom/config.yaml`, the event log, daemon metadata, and local task shadows.

- One room per project: best isolation for logs, tasks, policies, and gateways.
- One HQ room across many repositories: best when one lead coordinates related work in several repos.
- Hybrid: HQ for planning plus project rooms for larger execution swarms.

See `docs/TOPOLOGY.md` for the tradeoffs.

`.agentroom/config.yaml` is the durable source of truth for room topology. The TUI and CLI should edit the same typed config model rather than keeping separate hidden settings. See `docs/CONFIGURATION.md` for source-of-truth, env override, and secret-handling rules.

## 3. Choose The Runtime Provider

Initialize with an explicit runtime. Do not rely on a generated default:

```bash
agent-room init --runtime RUNTIME
agent-room runtime providers
agent-room runtime doctor
```

When the runtime command is not the default binary name, write it into config
at init time:

```bash
agent-room init --runtime herdr --runtime-session agent-room --runtime-cli herdr-dev
```

For a Clanky-first room, write the shared defaults in the same config file:

```bash
agent-room init --room my-project --runtime herdr --clanky --work-tracker linear --linear-team team_123
```

That creates a portable `workTracker` block and a `clanky` block. When Clanky
starts inside this project without explicit `--home` or `--profile` overrides,
it can adopt `.clanky-room`, profile `lead`, the configured chat ownership, and
the selected tracker defaults from `.agentroom/config.yaml`.

Runtime choices:

- `tmux`: local terminal multiplexer via `@agentroom/runtime-tmux`.
- `herdr`: Herdr adapter via `@agentroom/runtime-herdr`.
- `fake`: contract tests and smoke checks only; not a real agent runtime.

Runtime-specific setup belongs in `.agentroom/config.yaml` and `docs/RUNTIMES.md`. Normal operators and agents should use `agent-room runtime`, `launch`, `read`, `send`, and `stop` rather than raw multiplexer commands.

## 4. Choose The Agent Harness

Launching an agent requires an explicit harness kind and command:

```bash
agent-room launch lead --harness HARNESS_KIND --command "AGENT_COMMAND" --cwd .
agent-room read lead --lines 40
```

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
- Linear: use the current `@agentroom/worktracker-linear` bridge and `linear-issue` refs.
- GitHub Issues, Jira, or custom: keep the tracker as the durable source and add or implement the matching provider/refs before expecting bridge commands to update it.

For Linear-backed rooms:

```bash
agent-room init --room my-project --runtime herdr --work-tracker linear --linear-team team_123
agent-room task create "Implement auth callback" --assignee api-impl --linear ENG-123
agent-room task link-linear task_implement_auth_callback_xxx ENG-123
agent-room tracker health
```

If the selected tracker is unavailable, agents must report `tracker_update_skipped` with the reason. They should not pretend a tracker update happened.

## 6. Choose The Design Integration

Design is optional. If design data matters for the room, choose one source of truth:

- Native only: link screenshots, files, or URLs in room messages and task refs.
- Figma: use the `DesignProvider` port and `@agentroom/design-figma` scaffold where available; use Figma MCP/tools for direct Figma operations until the AgentRoom adapter workflow is complete.
- Custom: implement the `DesignProvider` port and keep provider-specific language out of core room guidance.

Workers should discuss design work through AgentRoom messages and task refs, not by assuming every room uses Figma.

## 7. Choose The Messaging Surface

Native-only rooms need no external chat setup:

```bash
agent-room post "Planning is done" --channel announcements
agent-room dm reviewer "Ready for review"
agent-room messages --channel implementation --limit 20
agent-room wait --dm-to-me --timeout 600 --json
```

If you add an external messaging surface, choose ownership per conversation:

- Room-owned gateway: `agentroomd` owns the token and route table for a channel/DM.
- Agent-owned gateway: one agent owns its own connector identity and may also participate in AgentRoom.

For Discord room-owned gateways, configure `chat.gateways` and `chat.routes` in `.agentroom/config.yaml`; keep tokens in env vars such as `AGENTROOM_DISCORD_TOKEN`. Use `discord-mcp` / `discord_mcp` for Discord-only actions such as reading unrelated channels, inspecting attachments, one-off messages, or reactions. Do not make Discord the room source of truth.

See `docs/ADR/0003-chat-gateway-port.md` for gateway topology and ownership details.

## 8. Install Or Expose Skills

AgentRoom has two local skills:

- `skills/agentroom-operator/SKILL.md`: outside-the-room operator and lead-agent playbook.
- `skills/agentroom/SKILL.md`: enrolled worker/reviewer behavior.

Expose these skills to the agent harnesses you launch using that harness's normal skill mechanism. If a harness does not support skills, include the relevant playbook text in the launch prompt and verify `agent-room whoami --json` before work begins.

## 9. Choose Operator Clients

The daemon can be driven from several local clients:

- CLI: `agent-room ...` commands read and write the same room event log.
- TUI: `agent-room tui` opens the terminal dashboard against `AGENTROOM_DAEMON` or `--daemon`.
- MCP: `agentroom-mcp` exposes room context, messages, tasks, waits, and audit reads to MCP-capable agents.
- Mobile: `apps/mobile` connects to the daemon API. For iPhone access over Tailscale, start with `agent-room daemon start --tailnet`, then run `agent-room mobile-connect --copy` and open the `agentroom://connect?...` link on the phone.

When `AGENTROOM_API_TOKEN` is set, or when the daemon is started with `--tailnet`, `/v1/*` routes require `Authorization: Bearer <token>` or `x-agentroom-api-token`.

## 10. Validate The Room

After choosing the pieces:

```bash
agent-room runtime doctor
agent-room daemon start
agent-room daemon status
agent-room mobile-connect --json
agent-room launch smoke --harness HARNESS_KIND --command "AGENT_COMMAND" --cwd .
agent-room read smoke --lines 40
agent-room post "room ready" --channel announcements
agent-room events --limit 20
```

Stop or reconfigure anything that fails health checks before launching a real multi-agent workflow.
