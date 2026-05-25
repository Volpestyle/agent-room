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
