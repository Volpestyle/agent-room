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

Use `agent-room send/read/stop` for bound agents so runtime input and output are audited. Use raw provider commands only for manual recovery or sessions that are not AgentRoom-bound.

## Runtime Boundary

Keep product language and persisted state in AgentRoom terms: agent, runtime, session, binding, output stream. Avoid teaching worker agents provider-specific commands; that knowledge belongs in runtime adapters and adapter-specific docs.
