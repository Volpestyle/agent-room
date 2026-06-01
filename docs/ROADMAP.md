# Roadmap

Detailed milestone evidence lives in `docs/private/MILESTONES.md` and is
intentionally omitted from the published docs. Milestone notes can include local
paths, session logs, restore points, and other evidence that is useful to
maintainers but noisy for the public product narrative.

## Built

- Runtime provider port with fake, tmux, and Herdr adapters.
- JSONL event store and in-memory test store.
- Native channel/DM messages, wait/event streaming, human escalations, agent-state signals, tracker events, and user-visible reports/feed.
- CLI for init, daemon lifecycle, mobile pairing, TUI launch, messages, waits, tracker health, reports/feed, runtime selection, launch/enroll/read/send/search/stop, and audit events.
- Hono daemon with health, dashboard config, protocol/config reads, events/feed, messages, reports, tracker event import, runtime providers/agents/input/output/search, chat gateway route inspection, and bearer-token protection for `/v1/*` when configured.
- Interactive TUI dashboard with chat, overview, workspaces, agents, messages, events, logs, settings, slash-command templates, and optional operator bootstrap.
- Expo/React Native mobile client for health, messages, events, runtime providers/agents, room posting, and runtime input.
- MCP stdio server for room context, messages, events, feed, posts, DMs, reports, directed-message reads, iOS diagnostics, and waits.
- Chat gateway port, Discord adapter, inbound router, outbound dispatcher, webhook-mode attribution, and daemon config loading.
- Herdr pane adoption for daemon-observed panes and one-off `agent-room enroll`.

## Next

- Add SQLite as the durable local event store while preserving event replay.
- Harden tmux/Herdr provider contract tests against real runtime sessions.
- Add operator CLI and TUI support for editing AgentRoom home config through `@agentroom/config`, starting with chat gateway route inspection and mutation.
- Improve configured tracker protocol ergonomics, including clearer skipped-update reporting.
- Add richer approval enforcement beyond local policy files.
- Expand mobile/TUI controls for launch forms, config editing, tracker/feed visibility, and chat gateway status.
- Prototype SSH, Docker, and hosted/cloud runtime providers.
