# Roadmap

## MVP 0: local skeleton

- Runtime provider port
- Fake runtime provider
- JSONL event store
- Native channel/DM messages
- Local task shadows with external tracker refs
- CLI `init`, `post`, `dm`, `messages`, `task create`, `task link-linear`, `task comment`, `events`
- Hono daemon `/health`, `/v1/events`, `/v1/messages`, `/v1/tasks`

## MVP 1: Runtime-backed local orchestration

- Complete real runtime provider contract tests
- Launch/read/send/list agents through selected local runtimes
- Detect runtime health and adapter-specific setup problems
- Skill-installed opted-in agent behavior

## MVP 2: External work tracking

- Work tracker setup guidance
- Tracker comments/status updates delegated to the selected MCP/CLI/skill/provider
- Explicit `tracker_update_skipped` events when tracker tools are unavailable
- Local task projections that stay secondary to linked external issues

## MVP 3: human escalation

- `ask-human`
- approvals
- phone gateway skeleton
- digest command

## MVP 4: tool integrations

- GitHub PR sync
- Figma design refs
- notification gateways

## MVP 5: custom app

- Web UI first
- iOS/React Native or native Swift later
- Push notification gateway

## MVP 6: remote/hosted runtime

- Single remote host
- SSH provider
- Docker provider
- ECS/Kubernetes provider prototypes
