---
name: agentroom-operator
description: Manage AgentRoom rooms and runtime-backed agents from outside an enrolled worker process. Use when asked to initialize AgentRoom, inspect runtime health, launch agents, or send/read runtime input/output from an operator or lead-agent context.
---

# AgentRoom Operator

Use this skill to manage a room from the outside. For worker or reviewer behavior inside an enrolled process, use the `agentroom` skill instead.

## Preflight

Verify the project room and runtime before launching agents:

```bash
test -f .agentroom/config.yaml || agent-room init --room "$(basename "$PWD")"
agent-room runtime providers
agent-room runtime doctor
```

If runtime health reports a provider-specific problem, fix it through AgentRoom configuration or the relevant adapter docs. Do not bypass AgentRoom for normal launch, read, send, or stop flows.

## Launch Agents

Prefer launching the intended harness directly when known:

```bash
agent-room launch impl --harness codex --command "codex" --cwd .
agent-room read impl --lines 40
```

If allocating a shell first, treat it as a bound shell session until a coding-agent command starts:

```bash
agent-room launch impl --harness shell --command "bash" --cwd .
agent-room send impl "codex"
agent-room read impl --lines 40
agent-room send impl "Use AgentRoom, claim your assigned task, and post a short status before editing."
```

Use `agent-room send/read/stop` for bound agents so runtime input and output are audited. These commands require an AgentRoom binding by default; use `--unaudited` only for manual recovery when the session is not AgentRoom-bound.

## Herdr pane-grid launch hygiene

If the selected runtime is Herdr with `pane-grid`, stale panes from earlier work can crowd a reused workspace. When starting fresh work, prefer a new Herdr workspace label so the new agents get full-size panes:

```bash
agent-room launch impl-a --workspace squad-foo --cwd .
agent-room launch impl-b --workspace squad-foo --cwd .
```

A workspace with `panesPerTab: 2` plus two agents = one tab, two side-by-side panes in Herdr. See `docs/RUNTIMES.md` for provider-specific layout details and cleanup notes.

## Harness quirks

- **Codex** (`--harness codex --command "codex"`): a multi-line prompt sent via `agent-room send <id> "<long text>"` lands in the TUI prompt but is **not auto-submitted**. Follow with `agent-room send <id> ""` (empty submit) to dispatch. Claude Code submits multi-line text on the first send and does not need this.
- **Claude Code** (`--harness claude-code --command "claude"`): auto-loads the `agentroom` skill from `AGENTROOM_*` env vars. Codex also discovers it via its own skill mechanism if the symlinks are in place.
- Always pass `--cwd <dir>` when the agent's working directory is not the launch CWD. Verified: codex respects `--cwd` and reports it on boot (`directory: ~/...`).

## When a worker goes idle

Workers with the `agentroom` skill use `agent-room wait` to block on events instead of yielding the turn. If one goes idle anyway, read room state and send a one-line nudge.

## Reading worker output

`agent-room read <id> --lines N` returns the last N visible TUI rows from the pane (post-render). It is a snapshot of what a human would see, not an event log. For the canonical event stream use `agent-room events` or grep `.agentroom/events.jsonl`.

## Runtime Boundary

Keep product language and persisted state in AgentRoom terms: agent, runtime, session, binding, output stream. Avoid teaching worker agents provider-specific commands; that knowledge belongs in runtime adapters and adapter-specific docs.
