# ADR 0003: Chat Gateway Port

## Status

Accepted

## Context

AgentRoom needs phone and chat surfaces without making Discord, Telegram, or any other network the product boundary. Clanky should remain a Pi agent in a room. External chat systems are communication options that a gateway can attach to a room, channel, DM, or runtime-backed agent input.

The old Clanky selfbot branch used Discord user-token sessions by patching `discord.js` for bare-token REST auth, `/gateway` discovery, desktop identify properties, and READY payload normalization. AgentRoom must preserve that capability for personal agents while keeping the core provider-neutral.

## Decision

Add a platform-neutral `ChatGatewayProvider` port in core. The port owns connector lifecycle, normalized inbound messages, and outbound sends. It does not own routing policy.

Routing from an inbound chat message to AgentRoom state or runtime input is handled by a gateway/router layer that consumes normalized messages:

- post to a room channel
- post a directed room message
- send text to a runtime-backed agent

Discord is the first adapter. Its package may support Discord-specific credential modes, including bot tokens and user tokens, but core only sees `credentialKind`.

## Consequences

- Discord, Telegram, SMS, webhooks, and future chat systems can share one AgentRoom routing model.
- Clanky does not know Discord exists; it receives AgentRoom runtime input and room context.
- User-token Discord support is isolated to the Discord adapter and can be reviewed or replaced independently of core.
- Gateway lifecycle and credential loading remain outside core.

## Addendum (2026-05-25): Topologies, attribution, outbound, embedding

This addendum clarifies how `ChatGatewayProvider` is used in practice. It does not change the port shape; it pins down deployment, ownership, attribution, and what still needs to be built.

### Two independent axes

The same `@agentroom/chat-discord` package supports two lifecycle owners. The token-ownership question collapses to "which process opens the socket." Room participation is separate from gateway ownership.

- **Agent-owned gateway.** An agent such as Clanky imports the package as a library and runs the gateway in-process with its own token. Direct Discord <-> agent. The agent can skip `ChatGatewayRouter` entirely and consume `ChatInboundMessage` directly. This preserves the legacy Clanky selfbot use case and can run whether or not the agent is also participating in AgentRoom.
- **Room-owned gateway.** `agentroomd` owns the gateway and token for a specific conversation. The Discord identity is the _room's_ connector, not any individual agent's. Inbound traffic flows through `ChatGatewayRouter`, whose route table maps `{ providerId, conversationId, threadId? } -> target`. The typical target for a chat-driven room is `agent-stdin:<lead-agent>`. Worker agents do not see that room-owned Discord conversation directly; the lead distributes work via AgentRoom native channel posts, DMs, and delegations that reference the configured tracker.

The lead/worker distinction is **not** an agent-code concern. It is an emergent property of how routes are configured and how the lead chooses to fan out work. The agent harness is identical in both roles.

One external conversation should have exactly one owner. For the Discord adapter,
that means a channel or DM should not be attached to both an agent-owned gateway
and a room-owned gateway.

### Multi-channel rooms

AgentRoom rooms already have N channels (CLI `--channel`, default `announcements`). The existing `ChatGatewayRoute` table is sufficient: one gateway can hold N routes, each pairing one Discord conversation with one room channel (or one agent). Multi-channel chat <-> multi-channel room works without further router changes.

### Outbound dispatcher

`ChatGatewayRouter` only handles inbound. The symmetric outbound primitive is `ChatGatewayOutboundDispatcher`. It can:

- consume room message events,
- look up the inverse of the route table to find the target Discord conversation,
- call `provider.sendMessage()` (or webhook send; see below) with per-message identity metadata.

The daemon loads route config and calls the dispatcher for messages posted through its HTTP API. Messages written directly to the event log by separate CLI processes are not yet streamed through the daemon.

### Multi-agent identity via Discord webhooks

When multiple agents post into a single room mirrored to Discord, they share one bot token but must remain visually distinct. Plain sends use `channel.send()`, which always appears as the bot user.

The Discord adapter supports a webhook-mode send path that uses per-message `username` + `avatar_url` overrides. With one webhook per mirrored channel, the outbound dispatcher can attribute `clanky-lead`, `clanky-impl-a`, `clanky-reviewer`, and so on to distinct visible identities without provisioning N bot accounts. Bot permissions must include `Manage Webhooks` on target channels. This is Discord-specific; other adapters can implement equivalent attribution however the platform allows (Telegram bot-as-relay, SMS per-line prefix, etc.).

### Daemon wiring

`apps/daemon/src/app.ts` loads configured `ChatGatewayProvider` instances from AgentRoom config. Tokens come from env, not the YAML file.

```yaml
chat:
  gateways:
    discord-main:
      type: discord
      tokenEnv: AGENTROOM_DISCORD_TOKEN
      credentialKind: bot-token
      webhookMode: true
      webhookName: AgentRoom
  routes:
    main-lead:
      provider: discord-main
      conversationId: "1234567890"
      conversationKind: channel
      target:
        type: agent-stdin
        agentId: clanky-lead
      outbound:
        type: agent-message
        agentId: clanky-lead
        channelId: implementation
```

Inbound messages matching the route above are sent to `clanky-lead` stdin. Outbound room messages from `clanky-lead` in `implementation` are mirrored back to the Discord conversation with webhook attribution.

### Standalone embedding contract

To support the standalone topology, `@agentroom/chat-discord` must remain importable without dragging in `agentroomd` or storage. The provider already exposes `start(handler)`, `stop()`, and `sendMessage()` as the only required surface; a standalone agent supplies its own handler and never instantiates `ChatGatewayRouter` or `AgentRoomService`. Keep this constraint in mind when adding features: anything specific to room routing belongs in core or the router, not in the adapter.

### Profile isolation (operational rule)

When multiple Clanky-style agents share a host, each instance MUST use its own `--profile` (and typically its own `--home`). A shared `~/.clanky` will corrupt memory and session state. This is an operator concern surfaced here because it directly affects how the multi-agent topology is launched.

### What is built vs planned

Built:

- `ChatGatewayProvider` port in core
- `DiscordChatGatewayProvider` with bot-token and user-token credential modes
- `ChatGatewayRouter` (inbound: gateway -> room/agent)
- `ChatGatewayOutboundDispatcher` (outbound: room messages -> gateway sends)
- webhook-mode posting in the Discord adapter for per-message identity
- daemon-level config loading and gateway instantiation

Planned (not yet implemented):

- Operator CLI surface for inspecting and modifying routes at runtime
- daemon event-log subscription for messages posted by separate CLI processes
