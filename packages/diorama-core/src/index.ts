/**
 * `@agentroom/diorama-core` — the Diorama World Protocol, event→world reducer,
 * framework interfaces (LayoutStrategy / SkinMap / WorldCommands / WorldSource),
 * the default deterministic layout + skin, and the SSE-backed source adapter.
 * See `docs/diorama/GAME_BRIDGE.md`.
 *
 * F2 ships the protocol types (§4.2). F3 adds the event→world reducer. F5 adds
 * the framework interfaces; their defaults and the daemon SSE source follow.
 */
export * from "./protocol.js";
export * from "./interfaces.js";
export * from "./reducer.js";
export * from "./defaults.js";
export * from "./sse-source.js";
