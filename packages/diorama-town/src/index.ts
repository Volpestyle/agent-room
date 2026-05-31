/**
 * `@agentroom/diorama-town` — pure, deterministic town game logic for the
 * inhabitable Clankton spike (Phase 1).
 *
 * This package has NO PixiJS and NO DOM dependencies: it is the verified core of
 * the town simulation. It turns a `@agentroom/diorama-core` {@link WorldSnapshot}
 * into a deterministic floor plan ({@link buildTownPlan}), derives a tile-resolution
 * collision grid ({@link buildCollisionGrid}) and resolves axis-separated sliding
 * movement ({@link resolveMove}), simulates the player avatar ({@link stepPlayer},
 * {@link inputFromKeys}), and drives a dead-zone follow camera ({@link followCamera}).
 *
 * Everything here is a pure function of its inputs — no randomness, no wall-clock
 * reads — so the same world always produces the same town on every client.
 */

export * from "./types.js";
export * from "./camera.js";
export * from "./collision.js";
export * from "./player.js";
export * from "./townLayout.js";
