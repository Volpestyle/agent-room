# Security model

AgentRoom can read terminal output, send terminal input, route credentials-adjacent data, and trigger external tool actions. Treat it as privileged local automation.

## Principles

- Runtime provider sockets stay local.
- Remote clients talk to `agentroomd`, not directly to the runtime.
- Every enrolled agent gets a scoped token.
- Every terminal read and write can be audited.
- Third-party gateways should receive summaries by default, not full transcripts.
- Dangerous actions require approvals.
- The default install is local-only.

## Dangerous actions

Require approvals for:

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
