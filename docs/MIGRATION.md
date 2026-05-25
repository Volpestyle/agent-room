# Clanky Migration

Clanky moved from `/Users/jamesvolpe/web/clanky-pi` into the AgentRoom workspace as a Pi-based personal agent.

## Moved Packages

- `agents/clanky` contains the `@clanky/agent` package, persona markdown, Pi `InteractiveMode` entrypoint, handlers, stores, and runtime smoke test.
- `packages/clanky-core` contains the surviving Clanky profile paths, memory, Linear links/outbox/client, skills loader, state store, and model-facing tool definitions.
- `agents/clanky/skills` contains the bundled Pi-native Clanky skills: `daily-digest`, `linear-bridge`, and `pi-tui-coder`.

The original `clanky-pi` checkout was left intact after copying so it can be reviewed, archived, or removed explicitly later.

## Launch

AgentRoom treats Clanky as a `pi` harness:

```bash
agent-room launch clanky --harness pi --command "clanky" --cwd .
agent-room send clanky "hello"
agent-room read clanky --lines 40
```

The CLI resolves `--harness pi --command clanky` to the workspace-local `agents/clanky/src/bin.ts` through the root `tsx` binary.

## Verification

The package-level smoke test is:

```bash
pnpm exec tsx agents/clanky/test/runtime-smoke.ts
```
