# Roadmap

## MVP 0: local skeleton

- Runtime provider port
- Fake runtime provider
- JSONL event store
- CLI `init`, `post`, `task create`, `events`
- Hono daemon `/health`, `/v1/events`, `/v1/messages`, `/v1/tasks`

## MVP 1: Herdr-backed local orchestration

- Complete Herdr provider contract tests
- Launch/read/send/list agents through Herdr
- Detect Herdr socket/session health
- Skill-installed opted-in agent behavior

## MVP 2: human escalation

- `ask-human`
- approvals
- phone gateway skeleton
- digest command

## MVP 3: tool integrations

- Linear issue sync
- GitHub PR sync
- Figma design refs

## MVP 4: custom app

- Web UI first
- iOS/React Native or native Swift later
- Push notification gateway

## MVP 5: remote/hosted runtime

- Single remote host
- SSH provider
- Docker provider
- ECS/Kubernetes provider prototypes
