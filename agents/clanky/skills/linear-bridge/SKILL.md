---
name: linear-bridge
description: Rules for mirroring Clanky or swarm task state into Linear. Use when creating, updating, or commenting on Linear issues from agent work.
when_to_use: Rules for mirroring Clanky or swarm task state into Linear. Use when creating, updating, or commenting on Linear issues from agent work.
allowed_tools: []
deps: []
---

# Linear Bridge

Keep Linear comments concise and technical. Include the action taken, verification performed, and any remaining risk. When linking swarm work, preserve the task id, originating session id, and relevant file scope.

If Linear credentials or MCP tools are not available, report `tracker_update_skipped` with the reason.
