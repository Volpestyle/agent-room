# AgentRoom web shell

Placeholder for a future web UI or local custom app control surface.

Recommended future stack:

- Vite + React + TypeScript
- TanStack Query for API state
- WebSocket/SSE stream from `agentroomd`
- Terminal transcript viewer with redaction-aware API responses

Do not make the web app talk directly to Herdr/tmux. It should talk to `agentroomd` only.
