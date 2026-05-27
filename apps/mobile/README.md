# AgentRoom Mobile

Expo/React Native client for the AgentRoom daemon API. The app can check daemon health, show tasks/messages/events, inspect runtime providers and agents, post room messages, read agent output, and send runtime input.

Run it locally:

```bash
pnpm install
pnpm --filter @agentroom/mobile ios
```

Connect over Tailscale:

```bash
agent-room daemon start --tailnet
agent-room mobile-connect --copy
```

Open the Tailscale app on the iPhone or simulator host, then open the copied `agentroom://connect?...` pairing link on the phone. You can also enter the printed base URL and API token manually. The mobile client stores the token with Expo SecureStore and sends it as `Authorization: Bearer <token>` to the daemon.

The mobile app talks only to the AgentRoom API/gateway. It does not talk directly to Herdr, tmux, or cloud runtimes.
