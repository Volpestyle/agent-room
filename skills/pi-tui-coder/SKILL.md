---
name: pi-tui-coder
description: Pi/Clanky/AgentRoom coding conventions for pi-tui terminal UI and daemon work. Use when editing TypeScript that touches a pi-tui terminal UI.
when_to_use: Pi/Clanky/AgentRoom coding conventions for TUI and daemon work. Use when editing TypeScript code that touches a pi-tui terminal UI.
allowed_tools: []
deps: []
---

# Pi TUI Coder

Keep TypeScript strict and erasable. Use top-level imports, avoid `any`, preserve package boundaries, and prefer existing Pi abstractions over new local protocols.

For TUI work, keep daemon state owned by the daemon and make clients attach through the existing RPC surface rather than duplicating session logic. In this repo the operator console lives in `apps/tui` and composes pi-tui primitives (`TUI` / `Container` / `Overlay` / `SelectList` / `Input`) on top of a `pi-agent-core` Agent.

## Reference source

Inspect the published Pi packages for current APIs before guessing:

- `/Users/jamesvolpe/dev/external/earendil-works/pi` — Pi monorepo (pi-tui, pi-coding-agent, pi-agent-core). Fall back to `node_modules/@earendil-works/pi-*` if the checkout is absent.

## Notes

- This skill is mirrored across clanky (`clanky-pi/skills/pi-tui-coder`) and agent-room (`agent-room/skills/pi-tui-coder`); keep the copies in sync.
