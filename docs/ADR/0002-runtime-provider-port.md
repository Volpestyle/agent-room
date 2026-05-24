# ADR 0002: Runtime providers are ports

Status: proposed

## Context

AgentRoom should start with Herdr but must not be locked to it.

## Decision

The core domain never imports Herdr, tmux, Docker, SSH, ECS, Kubernetes, or any runtime-specific SDK.

The core imports only the `RuntimeProvider` port:

```ts
interface RuntimeProvider {
  id: string;
  kind: RuntimeProviderKind;
  capabilities: RuntimeCapabilities;
  health(): Promise<RuntimeHealth>;
  listSessions(): Promise<RuntimeSession[]>;
  listAgents(): Promise<RuntimeAgent[]>;
  startAgent(request: StartAgentRequest): Promise<RuntimeAgent>;
  stopAgent(agentId: string): Promise<void>;
  readAgent(request: ReadAgentRequest): Promise<AgentOutput>;
  sendInput(request: SendInputRequest): Promise<void>;
}
```

Runtime-specific details live in provider packages:

```text
packages/runtime-herdr
packages/runtime-tmux
packages/runtime-fake
packages/runtime-docker      # future
packages/runtime-ecs         # future
packages/runtime-kubernetes  # future
```

## Rules

- AgentRoom stores durable `agent_id`s.
- Runtime bindings are replaceable implementation details.
- Provider capability declarations determine which UI/actions are enabled.
- Runtime event formats are normalized before becoming AgentRoom events.
- Product language uses `agent`, `runtime`, `session`, `binding`, and `output stream`, not Herdr-specific terms.

## Consequences

Herdr can be the best local runtime without becoming the architecture.
