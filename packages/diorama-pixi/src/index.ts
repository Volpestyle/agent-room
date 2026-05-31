/**
 * `@agentroom/diorama-pixi` — the reference PixiJS (v8) renderer for the
 * inhabitable Clankton town. Binds the pure game state from
 * `@agentroom/diorama-town` + the `@agentroom/diorama-core` world snapshot and
 * paints it with placeholder art, with a documented seam for real sprite atlases.
 *
 * `pixi.js` is not installed in this round; the package is written against the
 * Pixi v8 API and compiled once the dependency lands.
 */

export {
  DioramaRenderer,
  createRenderer,
} from "./renderer.js";
export type {
  RendererOptions,
  LoadedSkinAtlas,
} from "./renderer.js";
