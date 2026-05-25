# Clanky Agent Integration

Clanky remains a standalone project in `/Users/jamesvolpe/web/clanky-pi`.
AgentRoom integrates with it as an external Pi harness command, the same way it
can launch any other runtime-backed agent.

## Boundary

- Clanky owns its persona, memory, profile state, Pi `InteractiveMode`, and bundled skills.
- AgentRoom owns rooms, runtime bindings, tasks, room-owned communication gateways, and audited send/read coordination.
- AgentRoom does not vendor or special-case Clanky source.

## Launch From Any Room

Install or expose the standalone `clanky` command, initialize any AgentRoom
room, then launch Clanky as a Pi harness:

```bash
agent-room launch clanky --harness pi --command "clanky" --cwd .
agent-room send clanky "hello"
agent-room read clanky --lines 40
```

The command is resolved by the runtime environment, not by a workspace-local
AgentRoom path. For local development, run the command from the Clanky checkout
or put its bin on `PATH`.

## Standalone Verification

The Clanky repo owns its package-level smoke tests:

```bash
cd /Users/jamesvolpe/web/clanky-pi
pnpm exec tsx agents/clanky/test/runtime-smoke.ts
```
