# Security model

AgentRoom can read terminal output, send terminal input, route credentials-adjacent data, and trigger external tool actions. Treat it as privileged local automation.

## Principles

- Runtime provider sockets stay local.
- Remote clients talk to `agentroomd`, not directly to the runtime.
- Every enrolled agent gets a scoped token.
- Normal `agent-room read`, `agent-room send`, and `agent-room stop` calls require an AgentRoom runtime binding so terminal input/output can be audited.
- `--unaudited` runtime access is manual recovery only and should not be used for normal operator or worker flows.
- Third-party gateways should receive summaries by default, not full transcripts.
- Dangerous actions require approvals.
- The default install is local-only.

## Dangerous actions

Require approvals, either by current local operator policy or by future daemon-enforced policy, for:

- merging PRs
- deploying
- deleting worktrees with uncommitted changes
- sending terminal input to another agent
- exposing full transcripts to Discord/Telegram
- installing dependencies
- running migrations
- spending money

## Secrets

Do not paste `.env`, API keys, OAuth tokens, SSH keys, or cloud credentials into room messages. Add redaction before exposing transcripts to mobile or bot gateways.
