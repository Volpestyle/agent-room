# AgentRoom iOS

Expo/React Native client for the AgentRoom daemon API.

Run it locally:

```bash
pnpm install
pnpm --filter @agentroom/mobile ios
```

Connect over Tailscale:

```bash
agent-room daemon start --tailnet
agent-room mobile-connect
```

Open the Tailscale app on the iPhone or simulator host, then enter the printed base URL and API token in the AgentRoom app. The mobile client stores the token with Expo SecureStore and sends it as `Authorization: Bearer <token>` to the daemon.

The mobile app talks only to the AgentRoom API/gateway. It does not talk directly to Herdr, tmux, or cloud runtimes.
