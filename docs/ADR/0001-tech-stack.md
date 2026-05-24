# ADR 0001: Tech stack

Status: proposed

## Decision

Use TypeScript + Node.js for the first implementation of AgentRoom.

## Rationale

AgentRoom is mostly glue, orchestration, local APIs, schema validation, provider adapters, and future web/mobile-facing interfaces. TypeScript keeps the domain model, network contracts, CLI code, provider contracts, and future UI code in one language.

Use Node.js 24 LTS as the default runtime. Node's release policy says production applications should use Active LTS or Maintenance LTS releases, and the release table currently lists v24 as LTS. This gives us a modern runtime without betting on a non-LTS current release.

Use pnpm workspaces rather than a heavier build orchestrator initially. pnpm positions itself around fast installs, disk efficiency, and monorepo/workspace support. The repo can add Turborepo or Nx later if the task graph becomes painful.

Use Hono for the daemon HTTP API. Hono is lightweight, TypeScript-first, based on Web Standards, and can run on Node.js, AWS Lambda, Cloudflare Workers, Deno, Bun, and other runtimes. That matters because the daemon may eventually split into local, hosted, and edge/gateway components.

Use Vitest for tests because it is fast, TypeScript-friendly, and pairs well with Vite/tsx-style development. The first critical tests are provider contract tests, not UI tests.

Use JSONL for the earliest event store because it is inspectable, append-only, easy to backup, and good enough for local MVPs. Add SQLite after the core event model stabilizes.

Use MCP as an optional interface, not a hard dependency of the core. MCP's official TypeScript SDK is Tier 1, so it is the right first SDK when we expose AgentRoom tools to compatible harnesses.

## Consequences

Good:

- One language for the core, CLI, daemon, MCP server, web, and future custom app API contracts.
- Easy integration with Linear, GitHub, Figma, Telegram, Discord, and MCP SDKs.
- Provider interfaces are lightweight and easy to implement.
- Local MVP can run without Docker or cloud services.

Tradeoffs:

- Node is less ideal than Go or Rust for a single static binary.
- Native SQLite dependencies can complicate installs, so SQLite is intentionally deferred until the event model is proven.
- For extremely high-scale hosted execution, runtime workers may eventually be better in Go/Rust, but the core contracts can survive that split.
