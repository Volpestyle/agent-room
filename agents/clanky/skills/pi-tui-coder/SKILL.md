---
name: pi-tui-coder
description: Pi and Clanky coding conventions for TUI and daemon work. Use when editing TypeScript code in Pi or Clanky repositories.
when_to_use: Pi and Clanky coding conventions for TUI and daemon work. Use when editing TypeScript code in Pi or Clanky repositories.
allowed_tools: []
deps: []
---

# Pi TUI Coder

Keep TypeScript strict and erasable. Use top-level imports, avoid `any`, preserve package boundaries, and prefer existing Pi abstractions over new local protocols.

For TUI work, keep daemon state owned by the daemon and make clients attach through the existing RPC surface rather than duplicating session logic.
