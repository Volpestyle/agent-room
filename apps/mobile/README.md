# AgentRoom mobile app

Placeholder for a future iOS/custom app.

Recommended options:

1. Expo/React Native for maximum shared TypeScript with the daemon API and web shell.
2. Native Swift if terminal transcript UX and push notification polish become the dominant requirement.

The mobile app should never talk directly to Herdr, tmux, or cloud runtimes. It should talk to the AgentRoom API/gateway.
